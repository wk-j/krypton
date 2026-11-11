// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ProgressGauge } from './progress-gauge';
import { ProgressState, type SessionId, type WindowId } from './types';

const BAND = 'krypton-window__header-accent';

/** The chrome ProgressGauge draws into: titlebar + header band + content. */
function makeWindow(): HTMLElement {
  const win = document.createElement('div');
  win.className = 'krypton-window';
  const chrome = document.createElement('div');
  chrome.className = 'krypton-window__chrome';
  const titlebar = document.createElement('div');
  titlebar.className = 'krypton-window__titlebar';
  const band = document.createElement('div');
  band.className = BAND;
  chrome.append(titlebar, band);
  const content = document.createElement('div');
  content.className = 'krypton-window__content';
  win.append(chrome, content);
  document.body.appendChild(win);
  return win;
}

interface Rig {
  gauge: ProgressGauge;
  win: HTMLElement;
  qt: HTMLElement;
  /** Which session the window shows (its active tab's focused pane). */
  focus(sid: SessionId | null): void;
}

const WIN = 'w1' as WindowId;

function rig(): Rig {
  const win = makeWindow();
  const qt = makeWindow();
  let focused: SessionId | null = 1;
  const gauge = new ProgressGauge({
    getWindowElement: (id) => (id === WIN ? win : null),
    getQuickTerminalElement: () => qt,
    getWindowDisplaySession: (id) => (id === WIN ? focused : null),
  });
  return { gauge, win, qt, focus: (sid) => { focused = sid; } };
}

function band(win: HTMLElement): HTMLElement {
  return win.querySelector<HTMLElement>(`.${BAND}`)!;
}

function fill(win: HTMLElement): HTMLElement | null {
  return win.querySelector<HTMLElement>('.krypton-window__header-progress');
}

function mods(win: HTMLElement): string[] {
  return [...band(win).classList].filter((c) => c !== BAND).map((c) => c.replace(`${BAND}--`, ''));
}

describe('ProgressGauge header band (spec 390)', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('fills the band to the reported percentage and lights the titlebar lamp', () => {
    const { gauge, win } = rig();
    gauge.handleProgress(1, ProgressState.Normal, 40, WIN);

    expect(mods(win)).toEqual(['progress']);
    expect(fill(win)?.style.transform).toBe('scaleX(0.4)');
    expect(win.querySelector('.krypton-window__titlebar')?.classList.contains('krypton-window__titlebar--progress')).toBe(true);
    expect(win.querySelector('.krypton-progress-gauge')).not.toBeNull();
  });

  it('draws busy, error and paused with their own modifier and width', () => {
    const { gauge, win } = rig();

    gauge.handleProgress(1, ProgressState.Indeterminate, 0, WIN);
    expect(mods(win)).toEqual(['progress', 'busy']);
    expect(fill(win)?.style.transform).toBe('scaleX(1)');

    gauge.handleProgress(1, ProgressState.Paused, 55, WIN);
    expect(mods(win)).toEqual(['progress', 'paused']);
    expect(fill(win)?.style.transform).toBe('scaleX(0.55)');

    gauge.handleProgress(1, ProgressState.Error, 30, WIN);
    expect(mods(win)).toEqual(['progress', 'error']);
    expect(fill(win)?.style.transform).toBe('scaleX(0.3)');

    gauge.handleProgress(1, ProgressState.Error, 0, WIN);
    expect(fill(win)?.style.transform).toBe('scaleX(1)');
  });

  it('returns the band to idle when the program clears progress', () => {
    const { gauge, win } = rig();
    gauge.handleProgress(1, ProgressState.Normal, 40, WIN);
    gauge.handleProgress(1, ProgressState.Hidden, 0, WIN);

    expect(mods(win)).toEqual([]);
    expect(fill(win)).toBeNull();
    expect(win.querySelector('.krypton-progress-gauge')).toBeNull();
    expect(win.querySelector('.krypton-window__titlebar')?.className).toBe('krypton-window__titlebar');
  });

  it('skips the DOM write when the shown state is unchanged', () => {
    const { gauge, win } = rig();
    gauge.handleProgress(1, ProgressState.Normal, 40, WIN);
    fill(win)!.style.transform = 'marker';
    gauge.handleProgress(1, ProgressState.Normal, 40, WIN);
    gauge.refreshWindow(WIN);

    expect(fill(win)?.style.transform).toBe('marker');
  });

  it('follows the focused pane on refresh', () => {
    const { gauge, win, focus } = rig();
    gauge.handleProgress(1, ProgressState.Normal, 40, WIN);
    // Session 2 lives in a background tab: stored, not shown.
    gauge.handleProgress(2, ProgressState.Paused, 70, WIN);
    expect(fill(win)?.style.transform).toBe('scaleX(0.4)');

    focus(2);
    gauge.refreshWindow(WIN);
    expect(mods(win)).toEqual(['progress', 'paused']);
    expect(fill(win)?.style.transform).toBe('scaleX(0.7)');

    focus(3);
    gauge.refreshWindow(WIN);
    expect(mods(win)).toEqual([]);
    expect(fill(win)).toBeNull();
  });

  it('flashes, fades and forgets a completed run so a refresh does not replay it', () => {
    const { gauge, win } = rig();
    gauge.handleProgress(1, ProgressState.Normal, 100, WIN);
    expect(mods(win)).toEqual(['progress', 'flare']);

    vi.advanceTimersByTime(800);
    expect(mods(win)).toEqual(['progress', 'fade-out']);

    vi.advanceTimersByTime(1500);
    expect(mods(win)).toEqual([]);
    expect(fill(win)).toBeNull();
    expect(gauge.getSessionProgress(1)).toBeNull();

    gauge.refreshWindow(WIN);
    expect(mods(win)).toEqual([]);
  });

  it('cancels a pending fade when a new run starts', () => {
    const { gauge, win } = rig();
    gauge.handleProgress(1, ProgressState.Normal, 100, WIN);
    vi.advanceTimersByTime(900);
    gauge.handleProgress(1, ProgressState.Normal, 10, WIN);

    vi.advanceTimersByTime(5000);
    expect(mods(win)).toEqual(['progress']);
    expect(fill(win)?.style.transform).toBe('scaleX(0.1)');
    expect(gauge.getSessionProgress(1)).toEqual({ state: ProgressState.Normal, progress: 10 });
  });

  it('does not let a background pane cancel the shown pane fade', () => {
    const { gauge, win } = rig();
    gauge.handleProgress(1, ProgressState.Normal, 100, WIN);
    gauge.handleProgress(2, ProgressState.Normal, 20, WIN);

    vi.advanceTimersByTime(2300);
    expect(mods(win)).toEqual([]);
    expect(gauge.getSessionProgress(1)).toBeNull();
    expect(gauge.getSessionProgress(2)).toEqual({ state: ProgressState.Normal, progress: 20 });
  });

  it('dismisses an error after its hold and fade', () => {
    const { gauge, win } = rig();
    gauge.handleProgress(1, ProgressState.Error, 0, WIN);

    vi.advanceTimersByTime(3000);
    expect(mods(win)).toEqual(['progress', 'error', 'fade-out']);
    vi.advanceTimersByTime(1500);
    expect(mods(win)).toEqual([]);
    expect(gauge.getSessionProgress(1)).toBeNull();
  });

  it('draws the Quick Terminal from its own state', () => {
    const { gauge, win, qt } = rig();
    gauge.handleProgress(9, ProgressState.Normal, 25, null);

    expect(fill(qt)?.style.transform).toBe('scaleX(0.25)');
    expect(fill(win)).toBeNull();
  });
});
