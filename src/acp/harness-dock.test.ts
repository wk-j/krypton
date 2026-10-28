// @vitest-environment happy-dom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { DOCK_ACTIVE_CLASS, HarnessDock } from './harness-dock';
import { readDockTab, type HarnessDockTab } from './harness-panel-visibility';

function column(projectDir = '/repo'): {
  dock: HarnessDock;
  root: HTMLElement;
  ticket: HTMLElement;
  rails: HTMLElement;
  shown: (HarnessDockTab | null)[];
} {
  const root = document.createElement('div');
  const shown: (HarnessDockTab | null)[] = [];
  const dock = new HarnessDock(root, () => projectDir, (tab) => shown.push(tab));
  const ticket = document.createElement('aside');
  const rails = document.createElement('aside');
  dock.setPane('ticket', ticket);
  dock.setPane('rails', rails);
  return { dock, root, ticket, rails, shown };
}

function tabs(dock: HarnessDock): { strip: HTMLElement; labels: string[]; active: string | null } {
  const strip = dock.el.firstElementChild as HTMLElement;
  return {
    strip,
    labels: [...strip.querySelectorAll('[data-tab-id]')].map((node) => node.textContent ?? ''),
    active: strip.querySelector('.acp-dock__tab--active')?.getAttribute('data-tab-id') ?? null,
  };
}

function key(name: string, init: KeyboardEventInit = {}): KeyboardEvent {
  return new KeyboardEvent('keydown', { key: name, cancelable: true, ...init });
}

describe('HarnessDock (spec 337)', () => {
  beforeEach(() => {
    const store = new Map<string, string>();
    vi.stubGlobal('localStorage', {
      getItem: (key: string): string | null => store.get(key) ?? null,
      setItem: (key: string, value: string): void => { store.set(key, value); },
      removeItem: (key: string): void => { store.delete(key); },
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('reserves nothing and shows no strip until a tab is available', () => {
    const { dock, root, ticket, rails } = column();

    expect(dock.shown()).toBeNull();
    expect(dock.el.hidden).toBe(true);
    expect(root.classList.contains(DOCK_ACTIVE_CLASS)).toBe(false);
    expect([ticket.hidden, rails.hidden]).toEqual([true, true]);
  });

  it('looks like the ticket-only dock when only the ticket is available', () => {
    const { dock, root, ticket, rails, shown } = column();

    dock.setAvailable('ticket', true);

    expect(dock.shown()).toBe('ticket');
    expect([ticket.hidden, rails.hidden]).toEqual([false, true]);
    expect(root.classList.contains(DOCK_ACTIVE_CLASS)).toBe(true);
    expect(tabs(dock).strip.hidden).toBe(true);
    expect(shown).toEqual(['ticket']);
  });

  it('shows the strip only with both tabs, keeping the stored choice', () => {
    const { dock } = column();

    dock.setAvailable('ticket', true);
    dock.setAvailable('rails', true);

    const strip = tabs(dock);
    expect(strip.strip.hidden).toBe(false);
    expect(strip.strip.getAttribute('role')).toBe('tablist');
    expect(strip.labels).toEqual(['TICKET', 'RAILS']);
    expect(strip.active).toBe('ticket');
    expect(dock.shown()).toBe('ticket');
  });

  it('falls back to the other tab without rewriting the selection, and returns to it', () => {
    const { dock, ticket, rails, shown } = column();
    dock.setAvailable('ticket', true);
    dock.setAvailable('rails', true);
    dock.select('rails');
    expect(dock.shown()).toBe('rails');

    // Manifest removed / rails hidden: the column shows the ticket.
    dock.setAvailable('rails', false);
    expect(dock.shown()).toBe('ticket');
    expect(dock.selectedTab()).toBe('rails');
    expect(readDockTab('/repo')).toBe('rails');
    expect([ticket.hidden, rails.hidden]).toEqual([false, true]);

    dock.setAvailable('rails', true);
    expect(dock.shown()).toBe('rails');
    expect(shown).toEqual(['ticket', 'rails', 'ticket', 'rails']);
  });

  it('persists the selection per project, read back by the next column', () => {
    const a = column('/repo/a');
    a.dock.select('rails');
    column('/repo/b').dock.select('ticket');

    expect(readDockTab('/repo/a')).toBe('rails');
    expect(readDockTab('/repo/b')).toBe('ticket');

    const again = column('/repo/a');
    again.dock.setAvailable('ticket', true);
    again.dock.setAvailable('rails', true);
    expect(again.dock.shown()).toBe('rails');
  });

  it('switches with [ and ] only while both tabs are available', () => {
    const { dock } = column();
    dock.setAvailable('rails', true);

    const lone = key(']');
    expect(dock.handleKey(lone)).toBe(false);
    expect(lone.defaultPrevented).toBe(false);

    dock.setAvailable('ticket', true);
    expect(dock.shown()).toBe('ticket');
    const next = key(']');
    expect(dock.handleKey(next)).toBe(true);
    expect(next.defaultPrevented).toBe(true);
    expect(dock.shown()).toBe('rails');
    expect(dock.handleKey(key('['))).toBe(true);
    expect(dock.shown()).toBe('ticket');
    expect(dock.handleKey(key(']', { metaKey: true }))).toBe(false);
    expect(dock.handleKey(key('j'))).toBe(false);
    expect(readDockTab('/repo')).toBe('ticket');
  });

  it('moves focus into the newly shown pane, never leaving it on a hidden one', () => {
    const { dock, root, ticket, rails } = column();
    document.body.append(root, dock.el);
    ticket.tabIndex = -1;
    rails.tabIndex = -1;
    dock.el.querySelector('[data-layout-slot]')?.append(ticket, rails);
    root.tabIndex = 0;
    dock.setAvailable('ticket', true);
    dock.setAvailable('rails', true);
    dock.select('rails');
    rails.focus();

    expect(dock.handleKey(key('['))).toBe(true);
    expect(document.activeElement).toBe(ticket);

    // Nothing left to show: the keyboard goes back to the harness root.
    dock.setAvailable('rails', false);
    dock.setAvailable('ticket', false);
    expect(document.activeElement).toBe(root);
    root.remove();
    dock.el.remove();
  });

  it('selects a tab from a click on the strip', () => {
    const { dock } = column();
    dock.setAvailable('ticket', true);
    dock.setAvailable('rails', true);

    tabs(dock).strip.querySelector<HTMLElement>('[data-tab-id="rails"]')?.click();

    expect(dock.shown()).toBe('rails');
    expect(tabs(dock).active).toBe('rails');
  });

  it('badges the Rails tab with the open count, or ✗ after a failed check', () => {
    const { dock } = column();
    dock.setAvailable('ticket', true);
    dock.setAvailable('rails', true);
    expect(tabs(dock).labels[1]).toBe('RAILS');

    dock.setRailsBadge({ failedCheck: null, open: 3 });
    expect(tabs(dock).labels[1]).toBe('RAILS 3');
    expect(tabs(dock).strip.querySelector('.acp-dock__tab-count')?.textContent).toBe('3');

    dock.setRailsBadge({ failedCheck: 'typecheck', open: 3 });
    expect(tabs(dock).labels[1]).toBe('RAILS ✗');

    // A finished run never switches tabs.
    expect(dock.shown()).toBe('ticket');
  });
});
