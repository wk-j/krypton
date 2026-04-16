// Krypton — Progress Gauge (OSC 9;4)
// Renders SVG arc gauges and titlebar scanline sweep for progress tracking.

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

/** Callback interface for resolving compositor state */
export interface ProgressGaugeHost {
  getWindowElement(windowId: WindowId): HTMLElement | null;
  getQuickTerminalElement(): HTMLElement | null;
  getWindowDisplayProgress(windowId: WindowId): PaneProgress | null;
}

export class ProgressGauge {
  /** Per-session progress state (tracks all panes independently) */
  private sessionProgress: Map<SessionId, PaneProgress> = new Map();
  /** Quick Terminal progress state */
  private qtProgress: PaneProgress | null = null;
  private host: ProgressGaugeHost;

  constructor(host: ProgressGaugeHost) {
    this.host = host;
  }

  /** Get the progress state for a session (used by host for display resolution) */
  getSessionProgress(sessionId: SessionId): PaneProgress | null {
    return this.sessionProgress.get(sessionId) ?? null;
  }

  /** Clear progress state for a session (called on pty-exit) */
  clearSession(sessionId: SessionId): void {
    this.sessionProgress.delete(sessionId);
  }

  /**
   * Handle a progress update for a session. Updates internal state and
   * drives the status dot arc gauge + titlebar scanline sweep.
   */
  handleProgress(
    sessionId: SessionId,
    state: number,
    progress: number,
    windowId: WindowId | null,
  ): void {
    const pState = state as ProgressState;

    if (pState === ProgressState.Hidden) {
      // Clear progress state
      if (windowId === null) {
        this.qtProgress = null;
      } else {
        this.sessionProgress.delete(sessionId);
      }
    } else {
      // Store progress state
      const paneProgress: PaneProgress = { state: pState, progress };
      if (windowId === null) {
        this.qtProgress = paneProgress;
      } else {
        this.sessionProgress.set(sessionId, paneProgress);
      }
    }

    // Determine which window element to update
    let winEl: HTMLElement | null = null;
    if (windowId === null) {
      winEl = this.host.getQuickTerminalElement();
    } else {
      winEl = this.host.getWindowElement(windowId);
    }
    if (!winEl) return;

    // Resolve which progress to display — active tab's focused pane for regular windows
    let displayProgress: PaneProgress | null = null;
    if (windowId === null) {
      displayProgress = this.qtProgress;
    } else {
      displayProgress = this.host.getWindowDisplayProgress(windowId);
    }

    this.updateProgressGauge(winEl, displayProgress);
  }

  /**
   * Create or update the large centered background gauge in a window's
   * content area, and toggle the titlebar scanline sweep.
   */
  private updateProgressGauge(
    winEl: HTMLElement,
    displayProgress: PaneProgress | null,
  ): void {
    const contentEl = winEl.querySelector('.krypton-window__content') ?? winEl.querySelector('.krypton-window__body');
    const titlebar = winEl.querySelector('.krypton-window__titlebar');
    if (!contentEl || !titlebar) return;

    if (!displayProgress || displayProgress.state === ProgressState.Hidden) {
      this.removeProgressGauge(contentEl, titlebar);
      return;
    }

    const { state, progress } = displayProgress;

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

    // Activate titlebar scanline sweep
    titlebar.classList.add('krypton-window__titlebar--progress');

    const C = GAUGE_CIRCUMFERENCE;

    switch (state) {
      case ProgressState.Normal: {
        const filled = (progress / 100) * C;
        fill.setAttribute('stroke-dasharray', `${filled} ${C - filled}`);
        pctText.textContent = `${progress}%`;
        labelText.textContent = 'loading';

        // Completion flash at 100%
        if (progress >= 100) {
          pctText.textContent = '100%';
          labelText.textContent = 'complete';
          gauge.classList.add('krypton-progress-gauge--flare');
          const gaugeRef = gauge;
          const contentRef = contentEl;
          const titlebarRef = titlebar;
          setTimeout(() => {
            gaugeRef.classList.remove('krypton-progress-gauge--flare');
            gaugeRef.classList.add('krypton-progress-gauge--fade-out');
            setTimeout(() => {
              this.removeProgressGauge(contentRef, titlebarRef);
            }, 1500);
          }, 800);
        }
        break;
      }

      case ProgressState.Error: {
        fill.setAttribute('stroke-dasharray', `${C} 0`);
        gauge.classList.add('krypton-progress-gauge--error');
        titlebar.classList.add('krypton-window__titlebar--progress-error');
        pctText.textContent = progress > 0 ? `${progress}%` : 'ERR';
        labelText.textContent = 'error';
        const gaugeRef = gauge;
        const contentRef = contentEl;
        const titlebarRef = titlebar;
        setTimeout(() => {
          gaugeRef.classList.add('krypton-progress-gauge--fade-out');
          setTimeout(() => {
            this.removeProgressGauge(contentRef, titlebarRef);
          }, 1500);
        }, 3000);
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

    // Progress fill arc
    const fill = document.createElementNS(ns, 'circle');
    fill.setAttribute('cx', '50');
    fill.setAttribute('cy', '50');
    fill.setAttribute('r', '40');
    fill.setAttribute('class', 'krypton-progress-gauge__fill');
    fill.setAttribute('stroke-dasharray', `0 ${GAUGE_CIRCUMFERENCE}`);
    fill.setAttribute('transform', 'rotate(-90 50 50)');

    // Large percentage text
    const pct = document.createElementNS(ns, 'text');
    pct.setAttribute('x', '50');
    pct.setAttribute('y', '47');
    pct.setAttribute('class', 'krypton-progress-gauge__pct');
    pct.textContent = '';

    // Status label text
    const label = document.createElementNS(ns, 'text');
    label.setAttribute('x', '50');
    label.setAttribute('y', '60');
    label.setAttribute('class', 'krypton-progress-gauge__label');
    label.textContent = '';

    svg.appendChild(track);
    svg.appendChild(fill);
    svg.appendChild(pct);
    svg.appendChild(label);
    gauge.appendChild(svg);
    return gauge;
  }

  /**
   * Remove the background gauge and titlebar sweep from a window.
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
