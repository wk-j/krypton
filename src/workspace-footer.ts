import { invoke } from './profiler/ipc';

import { Mode, ProgressState, type PaneContentType } from './types';
import type { Compositor } from './compositor';
import type { InputRouter } from './input-router';
import type { ViewBus } from './view-bus';
import type { AttentionTier, SignalSource, SignalState, ViewAddress } from './view-bus-types';

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
  process: { name: string; pid: number | null } | null;
  progress: { state: ProgressState; pct: number | null } | null;
}

type FooterRefreshReason = 'mode' | 'focus' | 'bus' | 'timer' | 'config' | 'music';

const GIT_CACHE_TTL_MS = 10_000;
const GIT_DEBOUNCE_MS = 100;

// spec 138: attention gauge — tier ordering for picking the heaviest open item
// across harness sources, and the count cap shown as a pip strip (`6+` beyond).
const ATTENTION_TIER_WEIGHT: Record<AttentionTier, number> = {
  reversible: 0,
  costly: 1,
  irreversible: 2,
};
const ATTENTION_PIP_MAX = 6;

// spec 132: Krypton app mark — "K" = solid cursor stem-bar + monoline command-prompt
// chevron ("stem-bar" candidate). Singleton in the footer, so the SVG is inlined
// directly (no <symbol>/<use> indirection). Strokes/fills use currentColor so it
// recolors with the theme via the footer's accent color.
const KRYPTON_LOGO_SVG =
  '<svg viewBox="0 0 32 32" aria-hidden="true">' +
  '<rect x="8" y="6" width="3.4" height="20" rx="0.4" fill="currentColor"/>' +
  '<g stroke="currentColor" stroke-width="2" fill="none" stroke-linecap="round" stroke-linejoin="round">' +
  '<path d="M12 16 L23 6"/><path d="M12 16 L23 26"/>' +
  '</g></svg>';

// Footer telemetry icons — monoline SVGs in the brand mark's style, sized to the
// text cell in CSS (currentColor + em → theme-aware, scales with the chrome font,
// no glyph-font dependency so they never fall back to tofu). Each is parsed once
// into a cached node (see `icon()`) and cloned per segment, so the render hot path
// never re-parses markup. viewBox is 0 0 16 16; the base class is baked in.
const FOOTER_ICON_SVG: Record<string, string> = {
  // git branch: three nodes, the right one merging into the trunk
  branch:
    '<svg class="krypton-workspace-footer__icon" viewBox="0 0 16 16" aria-hidden="true">' +
    '<circle cx="4.5" cy="3.6" r="1.5"/><circle cx="4.5" cy="12.4" r="1.5"/><circle cx="11.5" cy="3.6" r="1.5"/>' +
    '<path d="M4.5 5.1 V12.4"/><path d="M11.5 5.1 V6.6 c0 2.2 -1.8 4 -4 4 H4.5"/></svg>',
  // window/layout: a framed pane with a title bar and a vertical split
  layout:
    '<svg class="krypton-workspace-footer__icon" viewBox="0 0 16 16" aria-hidden="true">' +
    '<rect x="2.5" y="3.5" width="11" height="9" rx="1"/><path d="M2.5 6.3 H13.5"/><path d="M8 6.3 V12.5"/></svg>',
  // process: a terminal prompt chevron + caret line
  prompt:
    '<svg class="krypton-workspace-footer__icon" viewBox="0 0 16 16" aria-hidden="true">' +
    '<path d="M4 5 L7.5 8 L4 11"/><path d="M9 11 H12.5"/></svg>',
  // throughput: paired up/down transfer arrows
  io:
    '<svg class="krypton-workspace-footer__icon" viewBox="0 0 16 16" aria-hidden="true">' +
    '<path d="M5 11.5 V4.5 M3 6.5 L5 4.5 L7 6.5"/><path d="M11 4.5 V11.5 M9 9.5 L11 11.5 L13 9.5"/></svg>',
  // filled status dot — used for the focused-view state and the git dirty marker
  dot:
    '<svg class="krypton-workspace-footer__icon" viewBox="0 0 16 16" aria-hidden="true">' +
    '<circle cx="8" cy="8" r="3.4"/></svg>',
};

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

/** True when a title token is the shell's rendering of `cwd` — exact, or an
 *  abbreviated form like `~/S/krypton` for `~/Source/krypton` (each leading
 *  path segment a prefix of the real one, last segment equal). Matching against
 *  the actual cwd means we drop only the duplicated working directory, never an
 *  unrelated path argument such as the `/tmp/a` in a "vim /tmp/a" title. */
function tokenIsCwd(token: string, cwd: string | null): boolean {
  if (!cwd) return false;
  const segs = (p: string): string[] => p.replace(/\/+$/, '').split('/');
  const tok = segs(token);
  if (tok.length === 0) return false;
  for (const cand of [cwd, abbreviatePath(cwd) ?? cwd]) {
    const ref = segs(cand);
    if (ref.length !== tok.length) continue;
    const matches = tok.every((t, i) => {
      const a = t.toLowerCase();
      const b = ref[i].toLowerCase();
      return i === tok.length - 1 ? a === b : b.startsWith(a);
    });
    if (matches) return true;
  }
  return false;
}

/** Drop the shell-embedded cwd from a terminal title so it isn't duplicated with
 *  the center CWD segment, keeping everything else (command names, real path
 *  arguments, decorative separators like the `//` in "MD // foo"). */
function stripCwdToken(title: string, cwd: string | null): string {
  return title
    .split(/\s+/)
    .filter((token) => token.length > 0 && !tokenIsCwd(token, cwd))
    .join(' ')
    .trim();
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

/** Compose the left "role + title" label, dropping the role prefix when the
 *  title already names the same kind of view — otherwise content views whose
 *  title IS the view name double up (e.g. role `acp_harness` + title
 *  "ACP Harness" → "acp_harness ACP Harness"). The shell-embedded cwd is
 *  stripped from the title first so it isn't duplicated with the CWD segment. */
function composeRoleTitle(role: FocusSummary['role'], rawTitle: string, cwd: string | null): string {
  const roleText = roleLabel(role);
  const title = stripCwdToken(rawTitle, cwd);
  if (!title) return roleText;
  const norm = (s: string): string => s.toLowerCase().replace(/[_\s]+/g, ' ').trim();
  const nRole = norm(roleText);
  const nTitle = norm(title);
  // Title equals or extends the role name → it already conveys the kind.
  if (nTitle === nRole || nTitle.startsWith(`${nRole} `)) return title;
  return `${roleText} ${title}`.trim();
}

function progressText(progress: FocusedBusState['progress']): string | null {
  if (!progress || progress.state === ProgressState.Hidden) return null;
  if (progress.pct !== null) return `${Math.round(progress.pct)}%`;
  if (progress.state === ProgressState.Indeterminate) return '…';
  return null;
}

function plural(n: number, noun: string): string {
  return `${n} ${noun}${n === 1 ? '' : 's'}`;
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
  private brandEl: HTMLElement;
  private leftEl: HTMLElement;
  private centerEl: HTMLElement;
  private rightEl: HTMLElement;
  private hintEl: HTMLElement;
  private attentionEl: HTMLElement;
  /** spec 128/138: open attention count + heaviest reversibility tier per
   * publishing harness instance. Counts are summed and tiers max'd for display
   * so every lane's attention collects in this one place. */
  private attentionBySource = new Map<string, { count: number; tier: AttentionTier | null }>();
  private reviewsEl: HTMLElement;
  /** spec 146: recorded #review rounds per publishing harness instance, summed
   * for the neutral depth indicator (distinct from the attention gauge). */
  private reviewsBySource = new Map<string, number>();
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
  /** Latest OSC 7 cwd per view (keyed by viewId), pushed via `view:cwd`. Used as
   *  the footer's working directory so a `cd` shows immediately without polling;
   *  views without OSC 7 fall back to the live `get_pty_cwd` query in render(). */
  private cwdByView = new Map<string, string>();
  private gitText: string | null = null;
  private gitCwd: string | null = null;
  private pendingGitCwd: string | null = null;
  private pendingGitTimer: ReturnType<typeof setTimeout> | null = null;
  private renderScheduled = false;
  private renderGeneration = 0;
  private focusedViewKey: string | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;
  /** Parsed-once SVG icon nodes, cloned per segment so renders never re-parse. */
  private iconTemplates = new Map<string, SVGElement>();

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
    // spec 128: global attention-triage badge — open count published by the ACP
    // harness via `system:attention`, shown regardless of focused view.
    this.attentionEl = document.createElement('span');
    this.attentionEl.className =
      'krypton-workspace-footer__segment krypton-workspace-footer__segment--attention';
    this.attentionEl.hidden = true;
    // spec 146: neutral review-count depth indicator (review quality matrix),
    // published by the ACP harness via `review:quality`. Distinct from the
    // attention gauge: it means "N rounds recorded — press to inspect", never
    // "act on me", and is never coloured by badness (ADR-0004).
    this.reviewsEl = document.createElement('span');
    this.reviewsEl.className =
      'krypton-workspace-footer__segment krypton-workspace-footer__segment--reviews';
    this.reviewsEl.hidden = true;
    this.musicEl = document.createElement('div');
    this.musicEl.className = 'krypton-workspace-footer__music';
    this.musicEl.setAttribute('aria-label', 'music mini player');
    this.musicEl.setAttribute('aria-hidden', 'true');
    this.musicProgressFillEl = document.createElement('div');
    this.musicProgressFillEl.className = 'krypton-workspace-footer__music-progress-fill';

    // spec 132: persistent Krypton brand anchor at the leading edge — created once,
    // never re-rendered (renderLeft/Center/Right only touch their own cells), so it
    // stays off the refresh hot path. Like the Apple mark at the left of the menu bar.
    this.brandEl = document.createElement('span');
    this.brandEl.className = 'krypton-workspace-footer__brand';
    this.brandEl.setAttribute('aria-label', 'Krypton');
    this.brandEl.innerHTML = KRYPTON_LOGO_SVG;

    this.rightEl.append(this.reviewsEl, this.attentionEl, this.hintEl, this.musicEl);
    this.root.append(this.brandEl, this.leftEl, this.centerEl, this.rightEl);

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
    // A process change for the focused view repaints the footer; render() reads
    // the authoritative process from the compositor, so this only needs to trigger
    // a refresh (no value is plumbed through the signal here).
    this.bus.onSignal({ kind: 'view:metrics' }, (s) => {
      if (this.isFocusedSource(s.source)) this.refresh('bus');
    });
    this.bus.onSignal({ kind: 'view:progress' }, (s) => {
      if (!this.isFocusedSource(s.source)) return;
      this.busState.progress = s.value;
      this.refresh('bus');
    });
    this.bus.onSignal({ kind: 'view:cwd' }, (s) => {
      if (!isViewSource(s.source)) return;
      this.cwdByView.set(s.source.viewId, s.value.cwd);
      if (this.isFocusedSource(s.source)) this.refresh('bus');
    });
    this.bus.onSignal({ kind: 'view:exit' }, (s) => {
      if (isViewSource(s.source)) this.cwdByView.delete(s.source.viewId);
      if (!this.isFocusedSource(s.source)) return;
      this.busState = { state: 'normal', throughput: 0, process: null, progress: null };
      this.refresh('bus');
    });
    // spec 128: global (not focus-gated) — the ACP harness owns the count and it
    // matters wherever the user is, so it survives focus changes.
    this.bus.onSignal({ kind: 'system:attention' }, (s) => {
      const { sourceId, openCount, maxReversibility } = s.value;
      if (openCount > 0) this.attentionBySource.set(sourceId, { count: openCount, tier: maxReversibility });
      else this.attentionBySource.delete(sourceId);
      this.renderAttention();
    });

    // spec 146: global (not focus-gated) review-count depth indicator.
    this.bus.onSignal({ kind: 'review:quality' }, (s) => {
      const { sourceId, totalReviews } = s.value;
      if (totalReviews > 0) this.reviewsBySource.set(sourceId, totalReviews);
      else this.reviewsBySource.delete(sourceId);
      this.renderReviews();
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
    requestAnimationFrame(() => {
      this.renderScheduled = false;
      // Read the generation at frame time, not at schedule time: a second
      // refresh() in the same tick (tab switch fires both the direct
      // focus-change callback and the bus `system:focus-change` signal) bumps
      // the generation after scheduling, and a stale capture would make
      // render() abort at its own guard — dropping the repaint entirely.
      void this.render(this.renderGeneration);
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
    // Prefer the event-driven OSC 7 cwd (instant on `cd`); fall back to a live
    // backend query for views/shells that don't report it.
    const pushedCwd = summary.viewId ? this.cwdByView.get(summary.viewId) ?? null : null;
    summary.cwd = pushedCwd ?? (await this.compositor.getFocusedWorkingDirectory());
    // Read the focused pane's process from the compositor's authoritative
    // per-session map rather than the event-driven bus. `process-changed` (and
    // thus `view:metrics`) fires only when a process *changes*, so a steady-state
    // tab's one-shot event may have fired before the footer subscribed — leaving
    // the bus with nothing to replay on a tab switch. The compositor subscribes
    // in its constructor and never resets, so this always reflects the focus.
    const proc = this.compositor.getFocusedProcess();
    this.busState.process = proc ? { name: proc.name, pid: proc.pid } : null;
    if (generation !== this.renderGeneration) return;
    this.updateGit(summary.cwd);

    this.renderLeft(summary);
    this.renderCenter(summary);
    this.renderRight(summary);
  }

  private renderLeft(summary: FocusSummary): void {
    this.leftEl.replaceChildren(
      this.segment(modeLabel(this.mode), 'mode'),
      this.segment(composeRoleTitle(summary.role, summary.title, summary.cwd), 'p0 role'),
    );
  }

  private renderCenter(summary: FocusSummary): void {
    // Compose the center zone from independent per-datum segment builders. Each
    // returns null when its datum is absent, so the order here IS the layout and
    // nothing is entangled in a chain of ifs.
    const segments = [
      this.workingDirSegment(summary.cwd),
      this.gitSegment(this.gitText),
      this.countsSegment(summary),
      this.processSegment(),
      this.throughputSegment(),
      this.progressSegment(),
      this.stateSegment(),
    ].filter((el): el is HTMLElement => el !== null);
    this.centerEl.replaceChildren(...segments);
  }

  private renderRight(summary: FocusSummary): void {
    this.hintEl.textContent = this.hintFor(summary);
    this.renderReviews();
    this.renderAttention();
    this.renderMusic();
  }

  /** spec 146: render the neutral review-count depth indicator — total recorded
   * #review rounds summed across sources. Deliberately NOT a gauge: a single
   * glyph + count, never coloured by badness, never pulses (ADR-0004). Hidden at
   * zero. Distinct from the attention gauge — depth ("inspect"), not demand. */
  private renderReviews(): void {
    let n = 0;
    for (const total of this.reviewsBySource.values()) n += total;
    if (n <= 0) {
      this.reviewsEl.hidden = true;
      this.reviewsEl.replaceChildren();
      this.reviewsEl.removeAttribute('title');
      return;
    }
    this.reviewsEl.hidden = false;
    const glyph = document.createElement('span');
    glyph.className = 'krypton-workspace-footer__reviews-glyph';
    glyph.textContent = '◷';
    const label = document.createElement('span');
    label.textContent = `${n} review${n === 1 ? '' : 's'}`;
    this.reviewsEl.replaceChildren(glyph, label);
    this.reviewsEl.title = `${n} recorded review round${n === 1 ? '' : 's'} — press ⌘P ' to inspect the review quality matrix`;
  }

  /** spec 128/138: render the open attention-triage gauge — count summed across
   * sources, coloured by the heaviest open reversibility tier, with the count
   * encoded as a pip strip (`6+` past the cap). Static (no motion). Hidden at
   * zero so the footer stays quiet when nothing needs the human. */
  private renderAttention(): void {
    let n = 0;
    let tierWeight = -1;
    let tier: AttentionTier = 'costly'; // fallback colour if a source reports a null tier
    for (const { count, tier: t } of this.attentionBySource.values()) {
      n += count;
      if (t && ATTENTION_TIER_WEIGHT[t] > tierWeight) {
        tierWeight = ATTENTION_TIER_WEIGHT[t];
        tier = t;
      }
    }
    if (n <= 0) {
      this.attentionEl.hidden = true;
      this.attentionEl.replaceChildren();
      this.attentionEl.removeAttribute('title');
      return;
    }
    this.attentionEl.hidden = false;
    this.attentionEl.className =
      'krypton-workspace-footer__segment krypton-workspace-footer__segment--attention ' +
      `krypton-workspace-footer__segment--rev-${tier}`;

    const label = document.createElement('span');
    label.textContent = `${n > ATTENTION_PIP_MAX ? `${ATTENTION_PIP_MAX}+` : n} attention`;
    const pips = document.createElement('span');
    pips.className = 'krypton-workspace-footer__attention-pips';
    const lit = Math.min(n, ATTENTION_PIP_MAX);
    for (let i = 0; i < ATTENTION_PIP_MAX; i++) {
      const pip = document.createElement('i');
      if (i >= lit) pip.className = 'is-off';
      pips.appendChild(pip);
    }
    this.attentionEl.replaceChildren(label, pips);
    this.attentionEl.title =
      `${n} open attention item${n === 1 ? '' : 's'} awaiting your judgement — heaviest: ${tier}`;
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

  /** Clone a cached telemetry icon. `variants` are short tokens mapped to
   * `__icon--<token>` BEM modifiers (e.g. 'fill dot'). Parses each SVG once. */
  private icon(name: string, variants = ''): SVGElement {
    let tpl = this.iconTemplates.get(name);
    if (!tpl) {
      const holder = document.createElement('div');
      holder.innerHTML = FOOTER_ICON_SVG[name];
      tpl = holder.firstElementChild as SVGElement;
      this.iconTemplates.set(name, tpl);
    }
    const node = tpl.cloneNode(true) as SVGElement;
    for (const v of variants.split(/\s+/).filter(Boolean)) {
      node.classList.add(`krypton-workspace-footer__icon--${v}`);
    }
    return node;
  }

  /** spec: git readout — a branch glyph + ref at accent-bright; the dirty state
   * becomes a warning-tier dot (not a `*` glued to the name) so "uncommitted"
   * reads as a signal. One consistent git voice with the composer-meta chip. */
  /** Build the single canonical working-directory segment for the workspace
   *  footer. This is the ONE place the workspace renders the focused pane's cwd
   *  (the left title strips path tokens so it never duplicates this). Returns
   *  null when there is no cwd to show. */
  private workingDirSegment(cwd: string | null): HTMLElement | null {
    const abbreviated = abbreviatePath(cwd);
    if (!abbreviated) return null;
    const el = this.segment(abbreviated, 'p1 project');
    const label = `working directory ${cwd}`;
    el.title = label;
    el.setAttribute('aria-label', label);
    return el;
  }

  /** Git ref + dirty marker for the focused pane's cwd. Null when not a repo. */
  private gitSegment(text: string | null): HTMLElement | null {
    if (!text) return null;
    const dirty = text.endsWith(' *');
    const ref = dirty ? text.slice(0, -2) : text;
    const el = this.segment(ref, 'p1 git');
    el.prepend(this.icon('branch'));
    if (dirty) {
      const dot = this.icon('dot', 'fill dot');
      dot.classList.add('krypton-workspace-footer__git-dirty');
      el.append(dot);
    }
    const label = dirty ? `branch ${ref} — uncommitted changes` : `branch ${ref}`;
    el.title = label;
    el.setAttribute('aria-label', label);
    return el;
  }

  /** Compact window/tab/pane triplet with a layout icon. Null unless something
   *  is split (any count > 1) — a lone pane needs no counter. */
  private countsSegment(summary: FocusSummary): HTMLElement | null {
    if (summary.windows <= 1 && summary.tabs <= 1 && summary.panes <= 1) return null;
    const el = this.segment(`${summary.windows}/${summary.tabs}/${summary.panes}`, 'p2 counts');
    el.prepend(this.icon('layout'));
    const label = `${plural(summary.windows, 'window')} · ${plural(summary.tabs, 'tab')} · ${plural(summary.panes, 'pane')}`;
    el.title = label;
    el.setAttribute('aria-label', label);
    return el;
  }

  /** Foreground process name (+ pid) of the focused session. Null when unknown. */
  private processSegment(): HTMLElement | null {
    if (!this.busState.process) return null;
    const { name, pid } = this.busState.process;
    const el = this.segment(name, 'p2 process');
    el.prepend(this.icon('prompt'));
    if (pid !== null) {
      const pidEl = document.createElement('span');
      pidEl.className = 'krypton-workspace-footer__pid';
      pidEl.textContent = ` ${pid}`;
      el.append(pidEl);
    }
    const label = pid !== null ? `process ${name} · pid ${pid}` : `process ${name}`;
    el.title = label;
    el.setAttribute('aria-label', label);
    return el;
  }

  /** PTY throughput rate. Null when idle (0 B/s). */
  private throughputSegment(): HTMLElement | null {
    if (this.busState.throughput <= 0) return null;
    const rate = formatBytesPerSec(this.busState.throughput);
    const el = this.segment(rate, 'p3');
    el.prepend(this.icon('io'));
    el.title = `throughput ${rate}`;
    el.setAttribute('aria-label', el.title);
    return el;
  }

  /** OSC progress percentage / indeterminate marker. Null when no progress. */
  private progressSegment(): HTMLElement | null {
    const progress = progressText(this.busState.progress);
    if (!progress) return null;
    const el = this.segment(progress, 'p3 detail');
    el.title = `progress ${progress}`;
    el.setAttribute('aria-label', el.title);
    return el;
  }

  /** Signal state (busy/warn/err/…) as a coloured dot + word. Null when normal.
   *  Tagged via data-state so CSS colours it by meaning, not the flat p3 tier. */
  private stateSegment(): HTMLElement | null {
    if (this.busState.state === 'normal') return null;
    const el = this.segment(this.busState.state, 'p3 detail state');
    el.dataset.state = this.busState.state;
    el.prepend(this.icon('dot', 'fill dot'));
    el.title = `state: ${this.busState.state}`;
    el.setAttribute('aria-label', el.title);
    return el;
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
