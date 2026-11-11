// Krypton — Progress Gauge (OSC 9;4)
// Renders OSC 9;4 progress in a window's header band (spec 390), the centred
// SVG ring (spec 18) and the titlebar progress lamp. `[visual] progress_display`
// hides the band or the ring by CSS class on <html>; both are always kept in
// step, so Reload Config shows the current state at once.

import {
  SessionId,
  WindowId,
  ProgressState,
  type PaneProgress,
} from './types';

/** SVG namespace for creating SVG elements */
const SVG_NS = 'http://www.w3.org/2000/svg';

/** Circumference of the gauge arc (r=40 in a 100x100 viewBox, C = 2*pi*40 ~= 251.327) */
const GAUGE_CIRCUMFERENCE = 2 * Math.PI * 40;

/** Label y (viewBox units): below the percentage text, or centered when the label is alone */
const LABEL_Y_UNDER_PCT = '60';
const LABEL_Y_CENTERED = '50';

/** Completion: the fill flashes, then fades. Error: shown, then fades. */
const FLARE_MS = 800;
const ERROR_HOLD_MS = 3000;
const FADE_MS = 1500;

const BAND = 'krypton-window__header-accent';
const BAND_FILL = 'krypton-window__header-progress';
const BAND_MODIFIERS = ['progress', 'busy', 'error', 'paused', 'flare', 'fade-out']
  .map((m) => `${BAND}--${m}`);

/** Lastly-rendered key when nothing is shown. */
const NONE = 'none';

/** Gives each gauge's glow filter a document-unique id (one gauge per window). */
let glowFilterSeq = 0;

/** Callback interface for resolving compositor state */
export interface ProgressGaugeHost {
  getWindowElement(windowId: WindowId): HTMLElement | null;
  getQuickTerminalElement(): HTMLElement | null;
  /** Session of the window's active tab's focused pane, or null when it has none. */
  getWindowDisplaySession(windowId: WindowId): SessionId | null;
}

/** The chrome parts one window's progress is drawn into. */
interface ProgressParts {
  content: Element | null;
  titlebar: Element | null;
  band: HTMLElement | null;
}

export class ProgressGauge {
  /** Per-session progress state (tracks all panes independently) */
  private sessionProgress: Map<SessionId, PaneProgress> = new Map();
  /** Quick Terminal progress state */
  private qtProgress: PaneProgress | null = null;
  /** `${state}:${progress}` last drawn per window element; skips identical redraws. */
  private lastRendered: WeakMap<HTMLElement, string> = new WeakMap();
  /** The one pending flare/fade/dismiss timer per window element. */
  private dismissTimers: WeakMap<HTMLElement, ReturnType<typeof setTimeout>> = new WeakMap();
  private host: ProgressGaugeHost;

  constructor(host: ProgressGaugeHost) {
    this.host = host;
  }

  /** The stored progress state for a session, or null when it reports none. */
  getSessionProgress(sessionId: SessionId): PaneProgress | null {
    return this.sessionProgress.get(sessionId) ?? null;
  }

  /** Clear progress state for a session (called on pty-exit) */
  clearSession(sessionId: SessionId): void {
    this.sessionProgress.delete(sessionId);
  }

  /**
   * Handle a progress update for a session. Updates internal state and
   * redraws the window's band, ring and titlebar lamp. `windowId` null means
   * the Quick Terminal.
   */
  handleProgress(
    sessionId: SessionId,
    state: number,
    progress: number,
    windowId: WindowId | null,
  ): void {
    const pState = state as ProgressState;

    if (pState === ProgressState.Hidden) {
      if (windowId === null) {
        this.qtProgress = null;
      } else {
        this.sessionProgress.delete(sessionId);
      }
    } else {
      const paneProgress: PaneProgress = { state: pState, progress };
      if (windowId === null) {
        this.qtProgress = paneProgress;
      } else {
        this.sessionProgress.set(sessionId, paneProgress);
      }
    }

    this.renderWindow(windowId);
  }

  /**
   * Redraw a window from stored state — the compositor calls this whenever
   * the window's active tab or focused pane changes (spec 390). A no-op when
   * the shown state is unchanged.
   */
  refreshWindow(windowId: WindowId): void {
    this.renderWindow(windowId);
  }

  /** The stored entry the window shows: the active tab's focused pane, or the QT's own. */
  private displayFor(windowId: WindowId | null): PaneProgress | null {
    if (windowId === null) return this.qtProgress;
    const sid = this.host.getWindowDisplaySession(windowId);
    return sid === null ? null : this.sessionProgress.get(sid) ?? null;
  }

  private renderWindow(windowId: WindowId | null): void {
    const winEl = windowId === null
      ? this.host.getQuickTerminalElement()
      : this.host.getWindowElement(windowId);
    if (!winEl) return;
    this.render(winEl, windowId, this.displayFor(windowId));
  }

  private partsOf(winEl: HTMLElement): ProgressParts {
    return {
      content: winEl.querySelector('.krypton-window__content') ?? winEl.querySelector('.krypton-window__body'),
      titlebar: winEl.querySelector('.krypton-window__titlebar'),
      band: winEl.querySelector<HTMLElement>(`.krypton-window__chrome > .${BAND}`),
    };
  }

  /** Draw `display` into one window: band, ring and titlebar lamp. */
  private render(
    winEl: HTMLElement,
    windowId: WindowId | null,
    display: PaneProgress | null,
  ): void {
    const shown = display && display.state !== ProgressState.Hidden ? display : null;
    const key = shown ? `${shown.state}:${shown.progress}` : NONE;
    if (this.lastRendered.get(winEl) === key) return;
    this.lastRendered.set(winEl, key);
    this.cancelTimer(winEl);

    const parts = this.partsOf(winEl);
    if (!shown) {
      this.clearParts(parts);
      return;
    }

    if (parts.band) this.drawBand(parts.band, shown);
    if (parts.content && parts.titlebar) this.drawRing(parts.content, parts.titlebar, shown);

    const { state, progress } = shown;
    if (state === ProgressState.Normal && progress >= 100) {
      this.schedule(winEl, FLARE_MS, () => {
        this.beginFade(parts);
        this.schedule(winEl, FADE_MS, () => this.dismiss(winEl, windowId, shown));
      });
    } else if (state === ProgressState.Error) {
      this.schedule(winEl, ERROR_HOLD_MS, () => {
        this.beginFade(parts);
        this.schedule(winEl, FADE_MS, () => this.dismiss(winEl, windowId, shown));
      });
    }
  }

  private schedule(winEl: HTMLElement, ms: number, fn: () => void): void {
    this.dismissTimers.set(winEl, setTimeout(() => {
      this.dismissTimers.delete(winEl);
      fn();
    }, ms));
  }

  private cancelTimer(winEl: HTMLElement): void {
    const timer = this.dismissTimers.get(winEl);
    if (timer === undefined) return;
    clearTimeout(timer);
    this.dismissTimers.delete(winEl);
  }

  /**
   * A completion or error has been shown and faded: forget it so a later
   * refresh (tab switch back) does not replay it, then redraw whatever the
   * window should show now. Only drops the entry if the program has not
   * reported anything since (`source` is still the stored object).
   */
  private dismiss(winEl: HTMLElement, windowId: WindowId | null, source: PaneProgress): void {
    if (windowId === null) {
      if (this.qtProgress === source) this.qtProgress = null;
    } else {
      for (const [sid, entry] of this.sessionProgress) {
        if (entry === source) {
          this.sessionProgress.delete(sid);
          break;
        }
      }
    }
    this.clearParts(this.partsOf(winEl));
    this.lastRendered.set(winEl, NONE);
    if (winEl.isConnected) this.renderWindow(windowId);
  }

  private beginFade(parts: ProgressParts): void {
    if (parts.band) {
      parts.band.classList.remove(`${BAND}--flare`);
      parts.band.classList.add(`${BAND}--fade-out`);
    }
    const gauge = parts.content?.querySelector('.krypton-progress-gauge');
    if (gauge) {
      gauge.classList.remove('krypton-progress-gauge--flare');
      gauge.classList.add('krypton-progress-gauge--fade-out');
    }
  }

  private clearParts(parts: ProgressParts): void {
    if (parts.band) this.clearBand(parts.band);
    if (parts.content && parts.titlebar) this.removeProgressGauge(parts.content, parts.titlebar);
  }

  /**
   * The header band as a gauge (spec 390): a fill element scaled from the
   * left to the percentage. Transform only, so the transition runs on the
   * compositor and the chrome plate is not repainted.
   */
  private drawBand(band: HTMLElement, shown: PaneProgress): void {
    const { state, progress } = shown;
    let fill = band.querySelector<HTMLElement>(`:scope > .${BAND_FILL}`);
    if (!fill) {
      fill = document.createElement('div');
      fill.className = BAND_FILL;
      band.appendChild(fill);
    }

    band.classList.remove(...BAND_MODIFIERS);
    band.classList.add(`${BAND}--progress`);

    let ratio = clampPct(progress) / 100;
    switch (state) {
      case ProgressState.Normal:
        if (progress >= 100) band.classList.add(`${BAND}--flare`);
        break;
      case ProgressState.Error:
        band.classList.add(`${BAND}--error`);
        if (progress <= 0) ratio = 1;
        break;
      case ProgressState.Indeterminate:
        band.classList.add(`${BAND}--busy`);
        ratio = 1;
        break;
      case ProgressState.Paused:
        band.classList.add(`${BAND}--paused`);
        break;
    }
    fill.style.transform = `scaleX(${ratio})`;
  }

  private clearBand(band: HTMLElement): void {
    band.classList.remove(...BAND_MODIFIERS);
    band.querySelector(`:scope > .${BAND_FILL}`)?.remove();
  }

  /**
   * Create or update the large centered background gauge in a window's
   * content area, and toggle the titlebar progress lamp.
   */
  private drawRing(
    contentEl: Element,
    titlebar: Element,
    shown: PaneProgress,
  ): void {
    const { state, progress } = shown;

    // Ensure gauge container exists
    let gauge = contentEl.querySelector('.krypton-progress-gauge') as HTMLElement | null;
    if (!gauge) {
      gauge = this.createGaugeElement();
      // Insert as first child so it renders behind terminal content
      contentEl.insertBefore(gauge, contentEl.firstChild);
      // Trigger reflow then make visible for opacity transition
      void gauge.offsetHeight;
      gauge.classList.add('krypton-progress-gauge--visible');
    }

    const svg = gauge.querySelector('.krypton-progress-gauge__svg') as SVGElement;
    const fill = gauge.querySelector('.krypton-progress-gauge__fill') as SVGCircleElement;
    const pctText = gauge.querySelector('.krypton-progress-gauge__pct') as SVGTextElement;
    const labelText = gauge.querySelector('.krypton-progress-gauge__label') as SVGTextElement;
    if (!svg || !fill || !pctText || !labelText) return;

    // Clear state modifiers
    gauge.classList.remove(
      'krypton-progress-gauge--error',
      'krypton-progress-gauge--paused',
      'krypton-progress-gauge--indeterminate',
      'krypton-progress-gauge--flare',
      'krypton-progress-gauge--fade-out',
    );
    titlebar.classList.remove(
      'krypton-window__titlebar--progress-error',
      'krypton-window__titlebar--progress-paused',
    );

    // Light the titlebar progress lamp
    titlebar.classList.add('krypton-window__titlebar--progress');

    const C = GAUGE_CIRCUMFERENCE;

    switch (state) {
      case ProgressState.Normal: {
        const filled = (progress / 100) * C;
        fill.setAttribute('stroke-dasharray', `${filled} ${C - filled}`);
        pctText.textContent = `${progress}%`;
        labelText.textContent = 'loading';

        // Completion flash at 100%; render() schedules the fade-out.
        if (progress >= 100) {
          pctText.textContent = '100%';
          labelText.textContent = 'complete';
          gauge.classList.add('krypton-progress-gauge--flare');
        }
        break;
      }

      case ProgressState.Error: {
        fill.setAttribute('stroke-dasharray', `${C} 0`);
        gauge.classList.add('krypton-progress-gauge--error');
        titlebar.classList.add('krypton-window__titlebar--progress-error');
        pctText.textContent = progress > 0 ? `${progress}%` : 'ERR';
        labelText.textContent = 'error';
        break;
      }

      case ProgressState.Indeterminate: {
        const segment = C * 0.25;
        fill.setAttribute('stroke-dasharray', `${segment} ${C - segment}`);
        gauge.classList.add('krypton-progress-gauge--indeterminate');
        pctText.textContent = '';
        labelText.textContent = 'working';
        break;
      }

      case ProgressState.Paused: {
        const filled = (progress / 100) * C;
        fill.setAttribute('stroke-dasharray', `${filled} ${C - filled}`);
        gauge.classList.add('krypton-progress-gauge--paused');
        titlebar.classList.add('krypton-window__titlebar--progress-paused');
        pctText.textContent = `${progress}%`;
        labelText.textContent = 'paused';
        break;
      }
    }

    // Indeterminate has no percentage — center the label in the ring instead
    // of leaving it parked below an empty line.
    labelText.setAttribute('y', pctText.textContent ? LABEL_Y_UNDER_PCT : LABEL_Y_CENTERED);
  }

  /**
   * Create the large centered background gauge DOM element.
   * Returns a container div with an SVG inside.
   */
  private createGaugeElement(): HTMLElement {
    const ns = SVG_NS;

    // Wrapper div
    const gauge = document.createElement('div');
    gauge.className = 'krypton-progress-gauge';

    // SVG — 100x100 viewBox with arc at center
    const svg = document.createElementNS(ns, 'svg');
    svg.setAttribute('class', 'krypton-progress-gauge__svg');
    svg.setAttribute('viewBox', '0 0 100 100');

    // Background track circle
    const track = document.createElementNS(ns, 'circle');
    track.setAttribute('cx', '50');
    track.setAttribute('cy', '50');
    track.setAttribute('r', '40');
    track.setAttribute('class', 'krypton-progress-gauge__track');

    // Glow: the arc's own colour blurred under it, so it follows the state
    // colour. A per-gauge id, because every window can show a gauge at once.
    const glowId = `krypton-progress-gauge-glow-${++glowFilterSeq}`;
    const defs = document.createElementNS(ns, 'defs');
    const glow = document.createElementNS(ns, 'filter');
    glow.setAttribute('id', glowId);
    // The arc and its halo stay inside the 100x100 viewBox: r 40 + stroke + 3 sigma.
    glow.setAttribute('filterUnits', 'userSpaceOnUse');
    glow.setAttribute('x', '0');
    glow.setAttribute('y', '0');
    glow.setAttribute('width', '100');
    glow.setAttribute('height', '100');
    glow.setAttribute('color-interpolation-filters', 'sRGB');
    const blur = document.createElementNS(ns, 'feGaussianBlur');
    blur.setAttribute('in', 'SourceGraphic');
    blur.setAttribute('stdDeviation', '2');
    blur.setAttribute('result', 'halo');
    const merge = document.createElementNS(ns, 'feMerge');
    for (const input of ['halo', 'halo', 'SourceGraphic']) {
      const node = document.createElementNS(ns, 'feMergeNode');
      node.setAttribute('in', input);
      merge.appendChild(node);
    }
    glow.append(blur, merge);
    defs.appendChild(glow);

    // Progress fill arc
    const fill = document.createElementNS(ns, 'circle');
    fill.setAttribute('cx', '50');
    fill.setAttribute('cy', '50');
    fill.setAttribute('r', '40');
    fill.setAttribute('class', 'krypton-progress-gauge__fill');
    fill.setAttribute('stroke-dasharray', `0 ${GAUGE_CIRCUMFERENCE}`);
    fill.setAttribute('transform', 'rotate(-90 50 50)');
    fill.setAttribute('filter', `url(#${glowId})`);

    // Large percentage text
    const pct = document.createElementNS(ns, 'text');
    pct.setAttribute('x', '50');
    pct.setAttribute('y', '47');
    pct.setAttribute('class', 'krypton-progress-gauge__pct');
    pct.textContent = '';

    // Status label text
    const label = document.createElementNS(ns, 'text');
    label.setAttribute('x', '50');
    label.setAttribute('y', LABEL_Y_UNDER_PCT);
    label.setAttribute('class', 'krypton-progress-gauge__label');
    label.textContent = '';

    svg.appendChild(defs);
    svg.appendChild(track);
    svg.appendChild(fill);
    svg.appendChild(pct);
    svg.appendChild(label);
    gauge.appendChild(svg);
    return gauge;
  }

  /**
   * Remove the background gauge and turn off the titlebar progress lamp.
   */
  private removeProgressGauge(
    contentEl: Element,
    titlebar: Element,
  ): void {
    const gauge = contentEl.querySelector('.krypton-progress-gauge');
    if (gauge) gauge.remove();

    titlebar.classList.remove(
      'krypton-window__titlebar--progress',
      'krypton-window__titlebar--progress-error',
      'krypton-window__titlebar--progress-paused',
    );
  }
}

/** OSC 9;4 values are 0-100; the parser already clamps, this guards the scale. */
function clampPct(progress: number): number {
  if (!Number.isFinite(progress)) return 0;
  return Math.max(0, Math.min(100, progress));
}
