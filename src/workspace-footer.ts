import { invoke } from './profiler/ipc';

import { Mode, ProgressState, type PaneContentType } from './types';
import type { Compositor } from './compositor';
import type { InputRouter } from './input-router';
import type { ViewBus } from './view-bus';
import type { SignalSource, SignalState, ViewAddress } from './view-bus-types';

export type WorkspaceFooterDensity = 'compact' | 'detail';

export interface MusicFooterSegment {
  statusIcon: string;
  track: string;
  info: string;
  flags: string;
  time: string;
  progressPct: number;
  playing: boolean;
  visualizer?: HTMLCanvasElement;
}

interface FocusSummary {
  viewId: string | null;
  role: PaneContentType | 'quick_terminal' | null;
  title: string;
  cwd: string | null;
  windows: number;
  tabs: number;
  panes: number;
}

interface GitSummary {
  text: string | null;
  expiresAt: number;
}

interface FocusedBusState {
  state: SignalState;
  throughput: number;
  process: string | null;
  progress: { state: ProgressState; pct: number | null } | null;
}

type FooterRefreshReason = 'mode' | 'focus' | 'bus' | 'timer' | 'config' | 'music';

const GIT_CACHE_TTL_MS = 10_000;
const GIT_DEBOUNCE_MS = 100;

function isViewSource(source: SignalSource): source is ViewAddress {
  return 'viewId' in source;
}

function abbreviatePath(path: string | null): string | null {
  if (!path) return null;
  const home = getHomePath();
  if (home && path === home) return '~';
  if (home && path.startsWith(`${home}/`)) return `~/${path.slice(home.length + 1)}`;
  const userHomeMatch = path.match(/^\/Users\/[^/]+(\/.*)?$/);
  if (userHomeMatch) return `~${userHomeMatch[1] ?? ''}`;
  return path;
}

function getHomePath(): string | null {
  const envHome = (globalThis as unknown as { process?: { env?: { HOME?: string } } }).process?.env?.HOME;
  return envHome ?? null;
}

function formatBytesPerSec(value: number): string {
  if (value < 1000) return `${value}B/s`;
  if (value < 1_000_000) return `${(value / 1000).toFixed(1)}K/s`;
  return `${(value / 1_000_000).toFixed(1)}M/s`;
}

function modeLabel(mode: Mode): string {
  return mode.replace(/([a-z])([A-Z])/g, '$1_$2').toUpperCase();
}

function roleLabel(role: FocusSummary['role']): string {
  if (!role) return 'no focus';
  if (role === 'quick_terminal') return 'quick terminal';
  return role;
}

function progressText(progress: FocusedBusState['progress']): string | null {
  if (!progress || progress.state === ProgressState.Hidden) return null;
  if (progress.pct !== null) return `progress ${Math.round(progress.pct)}%`;
  if (progress.state === ProgressState.Indeterminate) return 'progress ...';
  return 'progress';
}

export class WorkspaceFooter {
  private readonly workspace: HTMLElement;
  private readonly compositor: Compositor;
  private readonly bus: ViewBus;
  private readonly visibleCallbacks: Array<(visible: boolean) => void> = [];

  private mode: Mode = Mode.Normal;
  private density: WorkspaceFooterDensity = 'compact';
  private visible = true;
  private root: HTMLElement;
  private leftEl: HTMLElement;
  private centerEl: HTMLElement;
  private rightEl: HTMLElement;
  private hintEl: HTMLElement;
  private musicEl: HTMLElement;
  private musicProgressFillEl: HTMLElement;
  private musicIconEl: HTMLElement | null = null;
  private musicTimeEl: HTMLElement | null = null;
  private renderedMusicKey: string | null = null;
  private musicSegment: MusicFooterSegment | null = null;
  private musicVisualizer: HTMLCanvasElement | null = null;

  private busState: FocusedBusState = {
    state: 'normal',
    throughput: 0,
    process: null,
    progress: null,
  };
  private gitByCwd = new Map<string, GitSummary>();
  private gitText: string | null = null;
  private gitCwd: string | null = null;
  private pendingGitCwd: string | null = null;
  private pendingGitTimer: ReturnType<typeof setTimeout> | null = null;
  private renderScheduled = false;
  private renderGeneration = 0;
  private focusedViewKey: string | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(deps: {
    workspace: HTMLElement;
    compositor: Compositor;
    inputRouter: InputRouter;
    bus: ViewBus;
  }) {
    this.workspace = deps.workspace;
    this.compositor = deps.compositor;
    this.bus = deps.bus;
    this.root = document.createElement('footer');
    this.root.className = 'krypton-workspace-footer';
    this.root.dataset.density = this.density;
    this.root.dataset.music = 'off';
    this.root.setAttribute('role', 'status');
    this.root.setAttribute('aria-live', 'polite');

    this.leftEl = document.createElement('div');
    this.leftEl.className = 'krypton-workspace-footer__left';
    this.centerEl = document.createElement('div');
    this.centerEl.className = 'krypton-workspace-footer__center';
    this.rightEl = document.createElement('div');
    this.rightEl.className = 'krypton-workspace-footer__right';
    this.hintEl = document.createElement('span');
    this.hintEl.className = 'krypton-workspace-footer__segment krypton-workspace-footer__hint';
    this.musicEl = document.createElement('div');
    this.musicEl.className = 'krypton-workspace-footer__music';
    this.musicEl.setAttribute('aria-label', 'music mini player');
    this.musicEl.setAttribute('aria-hidden', 'true');
    this.musicProgressFillEl = document.createElement('div');
    this.musicProgressFillEl.className = 'krypton-workspace-footer__music-progress-fill';

    this.rightEl.append(this.hintEl, this.musicEl);
    this.root.append(this.leftEl, this.centerEl, this.rightEl);

    deps.inputRouter.onModeChange((mode) => {
      this.mode = mode;
      this.refresh('mode');
    });
  }

  start(): void {
    this.workspace.appendChild(this.root);
    this.compositor.onFocusChange(() => this.handleFocusChange());
    this.compositor.onRelayout(() => this.refresh('focus'));

    this.bus.onSignal({ kind: 'system:focus-change' }, () => this.handleFocusChange());
    this.bus.onSignal({ kind: 'view:state' }, (s) => {
      if (!this.isFocusedSource(s.source)) return;
      this.busState.state = s.value;
      this.refresh('bus');
    });
    this.bus.onSignal({ kind: 'view:throughput' }, (s) => {
      if (!this.isFocusedSource(s.source)) return;
      this.busState.throughput = s.value;
      this.refresh('bus');
    });
    this.bus.onSignal({ kind: 'view:metrics' }, (s) => {
      if (!this.isFocusedSource(s.source)) return;
      const name = s.value.name;
      const pid = s.value.pid;
      this.busState.process = typeof name === 'string'
        ? `${name}${typeof pid === 'number' ? ` pid ${pid}` : ''}`
        : null;
      this.refresh('bus');
    });
    this.bus.onSignal({ kind: 'view:progress' }, (s) => {
      if (!this.isFocusedSource(s.source)) return;
      this.busState.progress = s.value;
      this.refresh('bus');
    });
    this.bus.onSignal({ kind: 'view:exit' }, (s) => {
      if (!this.isFocusedSource(s.source)) return;
      this.busState = { state: 'normal', throughput: 0, process: null, progress: null };
      this.refresh('bus');
    });

    this.timer = setInterval(() => {
      if (this.density === 'detail') this.refresh('timer');
    }, 1000);
    this.refresh('focus');
  }

  stop(): void {
    if (this.timer !== null) {
      clearInterval(this.timer);
      this.timer = null;
    }
    if (this.pendingGitTimer !== null) {
      clearTimeout(this.pendingGitTimer);
      this.pendingGitTimer = null;
    }
    this.root.remove();
  }

  onVisibleChange(cb: (visible: boolean) => void): void {
    this.visibleCallbacks.push(cb);
  }

  setVisible(visible: boolean): void {
    if (this.visible === visible) return;
    this.visible = visible;
    this.root.hidden = !visible;
    for (const cb of this.visibleCallbacks) cb(visible);
  }

  get isVisible(): boolean {
    return this.visible;
  }

  toggleVisible(): void {
    this.setVisible(!this.visible);
  }

  toggleDensity(): void {
    this.density = this.density === 'compact' ? 'detail' : 'compact';
    this.root.dataset.density = this.density;
    this.refresh('config');
  }

  setMusicSegment(segment: MusicFooterSegment | null): void {
    this.musicSegment = segment;
    this.root.dataset.music = segment ? 'on' : 'off';
    this.musicEl.setAttribute('aria-hidden', segment ? 'false' : 'true');
    if (!segment) {
      this.renderedMusicKey = null;
      this.musicIconEl = null;
      this.musicTimeEl = null;
      this.musicProgressFillEl.style.width = '0%';
    }
    this.refresh('music');
  }

  updateMusicPosition(time: string, progressPct: number, playing: boolean): void {
    if (!this.musicSegment) return;
    this.musicSegment.time = time;
    this.musicSegment.progressPct = progressPct;
    this.musicSegment.playing = playing;
    if (this.musicTimeEl) this.musicTimeEl.textContent = time;
    this.musicProgressFillEl.style.width = `${Math.max(0, Math.min(100, progressPct))}%`;
  }

  refresh(_reason: FooterRefreshReason): void {
    this.renderGeneration++;
    if (this.renderScheduled) return;
    this.renderScheduled = true;
    const generation = this.renderGeneration;
    requestAnimationFrame(() => {
      this.renderScheduled = false;
      void this.render(generation);
    });
  }

  private isFocusedSource(source: SignalSource): source is ViewAddress {
    return isViewSource(source) && source.viewId === this.compositor.getFocusedViewId();
  }

  private handleFocusChange(): void {
    const nextKey = this.compositor.getFocusedViewId() ?? 'quick-terminal-or-none';
    if (nextKey !== this.focusedViewKey) {
      this.focusedViewKey = nextKey;
      this.busState = this.defaultBusState();
    }
    this.refresh('focus');
  }

  private defaultBusState(): FocusedBusState {
    return { state: 'normal', throughput: 0, process: null, progress: null };
  }

  private async render(generation: number): Promise<void> {
    const summary = this.compositor.getFocusedWorkspaceSummary();
    const viewKey = summary.viewId ?? (summary.role === 'quick_terminal' ? 'quick-terminal' : 'none');
    if (viewKey !== this.focusedViewKey) {
      this.focusedViewKey = viewKey;
      this.busState = this.defaultBusState();
    }
    summary.cwd = await this.compositor.getFocusedWorkingDirectory();
    if (generation !== this.renderGeneration) return;
    this.updateGit(summary.cwd);

    this.renderLeft(summary);
    this.renderCenter(summary);
    this.renderRight(summary);
  }

  private renderLeft(summary: FocusSummary): void {
    this.leftEl.replaceChildren(
      this.segment(modeLabel(this.mode), 'mode'),
      this.segment(`${roleLabel(summary.role)} ${summary.title}`.trim(), 'p0 role'),
    );
  }

  private renderCenter(summary: FocusSummary): void {
    const cwd = abbreviatePath(summary.cwd);
    const progress = progressText(this.busState.progress);
    const children: HTMLElement[] = [];
    if (cwd) children.push(this.segment(cwd, 'p1 project'));
    if (this.gitText) children.push(this.segment(this.gitText, 'p1 git'));
    if (summary.windows > 1 || summary.tabs > 1 || summary.panes > 1) {
      children.push(this.segment(`win ${summary.windows} tab ${summary.tabs} pane ${summary.panes}`, 'p2 counts'));
    }
    if (this.busState.process) children.push(this.segment(this.busState.process, 'p2 process'));
    if (this.busState.throughput > 0) {
      children.push(this.segment(`io ${formatBytesPerSec(this.busState.throughput)}`, 'p3'));
    }
    if (progress) children.push(this.segment(progress, 'p3 detail'));
    if (this.busState.state !== 'normal') children.push(this.segment(this.busState.state, 'p3 detail'));
    this.centerEl.replaceChildren(...children);
  }

  private renderRight(summary: FocusSummary): void {
    this.hintEl.textContent = this.hintFor(summary);
    this.renderMusic();
  }

  private renderMusic(): void {
    const segment = this.musicSegment;
    if (!segment) {
      this.musicEl.replaceChildren();
      this.musicVisualizer = null;
      this.renderedMusicKey = null;
      return;
    }

    const key = [
      segment.statusIcon,
      segment.track,
      segment.info,
      segment.flags,
      segment.visualizer ? 'viz' : 'no-viz',
    ].join('\u001f');

    if (key === this.renderedMusicKey) {
      this.updateMusicPosition(segment.time, segment.progressPct, segment.playing);
      return;
    }

    this.renderedMusicKey = key;
    this.musicEl.replaceChildren();
    this.musicVisualizer = null;

    const icon = this.segment(segment.statusIcon, 'music-icon');
    this.musicIconEl = icon;
    const track = this.segment(segment.track, 'music-track');
    const info = this.segment(segment.info, 'music-info');
    const flags = this.segment(segment.flags, 'music-flags');
    const time = this.segment(segment.time, 'music-time');
    this.musicTimeEl = time;
    const progress = document.createElement('div');
    progress.className = 'krypton-workspace-footer__music-progress';
    this.musicProgressFillEl.style.width = `${Math.max(0, Math.min(100, segment.progressPct))}%`;
    progress.appendChild(this.musicProgressFillEl);

    this.musicEl.appendChild(icon);
    if (segment.visualizer) {
      this.musicVisualizer = segment.visualizer;
      this.musicEl.appendChild(segment.visualizer);
    }
    this.musicEl.append(track, info, flags, time, progress);
  }

  private hintFor(summary: FocusSummary): string {
    if (this.mode === Mode.Compositor) return 'n new · h/j/k/l focus · ? details';
    if (this.mode === Mode.Resize || this.mode === Mode.Move || this.mode === Mode.Swap) return 'arrows adjust · Esc cancel';
    if (this.mode === Mode.CommandPalette || this.mode === Mode.Dashboard || this.mode === Mode.PromptDialog || this.mode === Mode.QuickFileSearch) return 'Esc close';
    if (summary.role === 'acp_harness') return 'Cmd+P lanes · #cancel running';
    if (this.musicSegment) return 'Cmd+Shift+M music';
    return 'Leader v select · Cmd+O files · Cmd+Shift+G git';
  }

  private segment(text: string, modifiers: string): HTMLElement {
    const el = document.createElement('span');
    el.className = `krypton-workspace-footer__segment ${modifiers
      .split(/\s+/)
      .filter(Boolean)
      .map((m) => `krypton-workspace-footer__segment--${m}`)
      .join(' ')}`;
    el.textContent = text;
    return el;
  }

  private updateGit(cwd: string | null): void {
    if (cwd !== this.gitCwd) {
      this.gitCwd = cwd;
      this.gitText = null;
      if (this.pendingGitTimer !== null) {
        clearTimeout(this.pendingGitTimer);
        this.pendingGitTimer = null;
      }
      this.pendingGitCwd = null;
    }
    if (!cwd) {
      this.gitText = null;
      return;
    }
    const cached = this.gitByCwd.get(cwd);
    const now = Date.now();
    if (cached && cached.expiresAt > now) {
      this.gitText = cached.text;
      return;
    }
    if (this.pendingGitTimer !== null && this.pendingGitCwd === cwd) return;
    if (this.pendingGitTimer !== null) {
      clearTimeout(this.pendingGitTimer);
      this.pendingGitTimer = null;
    }
    this.pendingGitCwd = cwd;
    this.pendingGitTimer = setTimeout(() => {
      this.pendingGitTimer = null;
      this.pendingGitCwd = null;
      void this.refreshGit(cwd);
    }, GIT_DEBOUNCE_MS);
  }

  private async refreshGit(cwd: string): Promise<void> {
    let text: string | null = null;
    try {
      const branch = (await invoke<string>('run_command', {
        program: 'git',
        args: ['branch', '--show-current'],
        cwd,
      })).trim();
      const ref = branch || (await invoke<string>('run_command', {
        program: 'git',
        args: ['rev-parse', '--short', 'HEAD'],
        cwd,
      })).trim();
      const porcelain = (await invoke<string>('run_command', {
        program: 'git',
        args: ['status', '--porcelain=v1'],
        cwd,
      })).trim();
      text = ref ? `${branch ? ref : `HEAD ${ref}`}${porcelain ? ' *' : ''}` : null;
    } catch {
      text = null;
    }
    this.gitByCwd.set(cwd, { text, expiresAt: Date.now() + GIT_CACHE_TTL_MS });
    if ((await this.compositor.getFocusedWorkingDirectory()) === cwd) {
      this.gitText = text;
      this.refresh('bus');
    }
  }

}
