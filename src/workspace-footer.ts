// Workspace status bar (spec 121) — facade. Owns the root DOM, subscriptions,
// the RAF/generation render guard, the focused-view bus state and the detail
// timer; per-zone rendering lives in the sibling `workspace-footer-*` modules.
import { Mode } from './types';
import type { Compositor } from './compositor';
import type { InputRouter } from './input-router';
import type { ViewBus } from './view-bus';
import type { SignalSource, ViewAddress } from './view-bus-types';
import {
  fillHint,
  hintFor,
  isViewSource,
  type FocusedBusState,
} from './workspace-footer-format';
import { centerSegments, leftSegments } from './workspace-footer-segments';
import { FooterGit } from './workspace-footer-git';
import { FooterAttention } from './workspace-footer-attention';
import { FooterRails } from './workspace-footer-rails';
import { FooterPriority, FooterReviews } from './workspace-footer-review-gauges';
import { FooterLink } from './workspace-footer-link';
import { FooterProgramStatus } from './workspace-footer-program-status';
import { FooterMusic, type MusicFooterSegment } from './workspace-footer-music';

export { parseHint, fillHint, type HintChip } from './workspace-footer-format';
export type { MusicFooterSegment } from './workspace-footer-music';

export type WorkspaceFooterDensity = 'compact' | 'detail';

type FooterRefreshReason = 'mode' | 'focus' | 'bus' | 'timer' | 'config' | 'music';

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
  private readonly attention = new FooterAttention();
  private readonly rails = new FooterRails();
  private readonly programStatus = new FooterProgramStatus();
  private readonly reviews = new FooterReviews();
  private readonly priority = new FooterPriority();
  private readonly link = new FooterLink();
  private readonly music = new FooterMusic();
  private readonly git: FooterGit;

  private busState: FocusedBusState = {
    state: 'normal',
    throughput: 0,
    process: null,
    progress: null,
  };
  /** Latest OSC 7 cwd per view (keyed by viewId), pushed via `view:cwd`. Used as
   *  the footer's working directory so a `cd` shows immediately without polling;
   *  views without OSC 7 fall back to the live `get_pty_cwd` query in render(). */
  private cwdByView = new Map<string, string>();
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
    this.git = new FooterGit({
      getFocusedCwd: () => this.compositor.getFocusedWorkingDirectory(),
      onChange: () => this.refresh('bus'),
    });
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

    // The backend link leads the global cluster, separate from focus-scoped
    // segments so it reads as a property of the app rather than the pane.
    this.rightEl.append(
      this.link.el,
      this.priority.el,
      this.reviews.el,
      this.attention.el,
      this.rails.el,
      this.programStatus.el,
      this.hintEl,
      this.music.el,
    );
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
      this.attention.set(sourceId, openCount, maxReversibility);
      this.attention.render();
    });

    // spec 337: global (not focus-gated) — each harness's Rails verifier state;
    // the segment shows the worst across harnesses.
    this.bus.onSignal({ kind: 'system:rails' }, (s) => {
      this.rails.set(s.value);
      this.rails.render();
    });

    // spec 284: global (not focus-gated) — a pane needing you matters wherever
    // you are. The focused pane's message also feeds the center detail line.
    this.bus.onSignal({ kind: 'view:program-status' }, (s) => {
      this.renderProgramStatus();
      if (s.value.viewId === this.compositor.getFocusedViewId()) this.refresh('bus');
    });

    // spec 146: global (not focus-gated) review-count depth indicator.
    this.bus.onSignal({ kind: 'review:quality' }, (s) => {
      const { sourceId, totalReviews } = s.value;
      this.reviews.set(sourceId, totalReviews);
      this.reviews.render();
    });

    // spec 162: global (not focus-gated) review-priority depth indicator.
    this.bus.onSignal({ kind: 'review:priority' }, (s) => {
      const { sourceId, highCount } = s.value;
      this.priority.set(sourceId, highCount);
      this.priority.render();
    });

    // spec 213: global (not focus-gated) backend link state.
    this.bus.onSignal({ kind: 'system:backend-link' }, (s) => {
      const { backendId, state, ...rest } = s.value;
      this.link.set(backendId, state, rest);
      this.link.render(this.density === 'detail');
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
    this.git.dispose();
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
    this.root.dataset.music = segment ? 'on' : 'off';
    this.music.set(segment);
    this.refresh('music');
  }

  updateMusicPosition(time: string, progressPct: number, playing: boolean): void {
    this.music.updatePosition(time, progressPct, playing);
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
    this.git.update(summary.cwd);

    this.leftEl.replaceChildren(...leftSegments(this.mode, summary));
    const status = summary.viewId ? this.compositor.programStatus.summary(summary.viewId) : null;
    this.centerEl.replaceChildren(...centerSegments(summary, this.git.text, this.busState, status));

    const hint = hintFor(this.mode, summary.role, this.music.active);
    this.hintEl.setAttribute('aria-label', hint);
    fillHint(this.hintEl, hint);
    const detail = this.density === 'detail';
    this.link.render(detail);
    this.priority.render();
    this.reviews.render();
    this.attention.render();
    this.rails.render();
    this.renderProgramStatus();
    this.music.render();
  }

  private renderProgramStatus(): void {
    this.programStatus.render(this.compositor.programStatusCounts());
  }
}
