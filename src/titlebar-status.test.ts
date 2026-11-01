// @vitest-environment happy-dom
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { syncTitlebarStatus } from './titlebar-status';
import { syncTitlebarToggles } from './titlebar-toggles';
import type { TitlebarStatus, TitlebarToggle } from './types';

const OK: TitlebarStatus = {
  icon: 'krypton-icon-remote',
  text: 'wks-mac-mini',
  tone: 'ok',
  title: 'SSH wk@wks-mac-mini:22 · /src · connected',
};
const OFFLINE: TitlebarStatus = {
  icon: 'krypton-icon-remote',
  text: 'wks-mac-mini · offline · reconnect',
  tone: 'error',
  title: 'SSH wk@wks-mac-mini:22 · /src · disconnected',
  actionable: true,
};
const TOGGLES: readonly TitlebarToggle[] = [
  { id: 'plan', icon: 'krypton-icon-panel-plan', label: 'Plan panel', pressed: true },
];

function makeEnd(): HTMLElement {
  const end = document.createElement('div');
  end.className = 'krypton-window__titlebar-end';
  const pty = document.createElement('span');
  pty.className = 'krypton-window__pty-status';
  end.appendChild(pty);
  document.body.appendChild(end);
  return end;
}

function badge(end: HTMLElement): HTMLButtonElement {
  const found = end.querySelector<HTMLButtonElement>('.krypton-window__view-status');
  if (!found) throw new Error('no badge');
  return found;
}

describe('syncTitlebarStatus', () => {
  let end: HTMLElement;

  beforeEach(() => {
    document.body.replaceChildren();
    end = makeEnd();
  });

  it('sits right after the toggle cluster whichever sync runs first', () => {
    syncTitlebarStatus(end, OK, () => {});
    expect(Array.from(end.children, (child) => child.classList[0])).toEqual([
      'krypton-window__view-status',
      'krypton-window__pty-status',
    ]);

    syncTitlebarToggles(end, TOGGLES, () => {});
    syncTitlebarStatus(end, OK, () => {});
    syncTitlebarToggles(end, TOGGLES, () => {});
    expect(Array.from(end.children, (child) => child.classList[0])).toEqual([
      'krypton-window__view-toggles',
      'krypton-window__view-status',
      'krypton-window__pty-status',
    ]);
  });

  it('keeps the node and writes nothing when the status is unchanged', () => {
    syncTitlebarStatus(end, OK, () => {});
    const before = badge(end);
    const text = before.querySelector('.krypton-window__view-status-text');
    if (!text) throw new Error('no text');
    text.textContent = 'sentinel';
    syncTitlebarStatus(end, { ...OK }, () => {});
    expect(badge(end)).toBe(before);
    expect(text.textContent).toBe('sentinel');
  });

  it('repaints tone, text and tooltip in place when the state changes', () => {
    syncTitlebarStatus(end, OK, () => {});
    const node = badge(end);
    syncTitlebarStatus(end, OFFLINE, () => {});
    expect(badge(end)).toBe(node);
    expect(node.dataset.tone).toBe('error');
    expect(node.textContent).toBe(OFFLINE.text);
    expect(node.title).toBe(OFFLINE.title);
    expect(node.querySelector('use')?.getAttribute('href')).toBe('#krypton-icon-remote');
  });

  it('activates only while actionable, through the latest callback', () => {
    const first = vi.fn();
    const latest = vi.fn();
    syncTitlebarStatus(end, OK, first);
    badge(end).click();
    expect(first).not.toHaveBeenCalled();

    syncTitlebarStatus(end, OFFLINE, first);
    syncTitlebarStatus(end, OFFLINE, latest);
    badge(end).click();
    expect(first).not.toHaveBeenCalled();
    expect(latest).toHaveBeenCalledTimes(1);
  });

  it('removes the badge when the view reports none', () => {
    syncTitlebarStatus(end, OK, () => {});
    syncTitlebarStatus(end, null, () => {});
    expect(end.querySelector('.krypton-window__view-status')).toBeNull();
  });
});
