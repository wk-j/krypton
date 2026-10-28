import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  harnessTitlebarToggles,
  nextHidden,
  parsePanelsCommand,
  readHiddenPanels,
  writeHiddenPanels,
  type HarnessPanelId,
} from './harness-panel-visibility';

describe('parsePanelsCommand (spec 320)', () => {
  it('keeps the spec 251 all-panels forms', () => {
    expect(parsePanelsCommand([])).toEqual({ kind: 'all', action: 'toggle' });
    expect(parsePanelsCommand(['hide'])).toEqual({ kind: 'all', action: 'hide' });
    expect(parsePanelsCommand(['SHOW'])).toEqual({ kind: 'all', action: 'show' });
    expect(parsePanelsCommand(['toggle'])).toEqual({ kind: 'all', action: 'toggle' });
  });

  it('addresses one panel, bare or with an action first', () => {
    expect(parsePanelsCommand(['grammar'])).toEqual({ kind: 'panel', panel: 'grammar', action: 'toggle' });
    expect(parsePanelsCommand(['hide', 'Ticket'])).toEqual({ kind: 'panel', panel: 'ticket', action: 'hide' });
    expect(parsePanelsCommand(['show', 'peek'])).toEqual({ kind: 'panel', panel: 'peek', action: 'show' });
  });

  it('rejects unknown words, reversed order and extra words', () => {
    for (const args of [['maybe'], ['hide', 'now'], ['grammar', 'hide'], ['hide', 'plan', 'now'], ['hide', 'hide']]) {
      expect(parsePanelsCommand(args)).toEqual({ kind: 'usage' });
    }
  });
});

describe('nextHidden', () => {
  it('resolves hide, show and toggle against the current flag', () => {
    expect([nextHidden('hide', false), nextHidden('hide', true)]).toEqual([true, true]);
    expect([nextHidden('show', false), nextHidden('show', true)]).toEqual([false, false]);
    expect([nextHidden('toggle', false), nextHidden('toggle', true)]).toEqual([true, false]);
  });
});

describe('harnessTitlebarToggles', () => {
  it('lists seven panels then the master toggle behind a divider', () => {
    const toggles = harnessTitlebarToggles(new Set<HarnessPanelId>(['thought']), false);

    expect(toggles.map((toggle) => toggle.id)).toEqual(['plan', 'peek', 'thought', 'grammar', 'queue', 'ticket', 'rails', 'all']);
    expect(toggles.map((toggle) => toggle.pressed)).toEqual([true, true, false, true, true, true, true, true]);
    expect(toggles.filter((toggle) => toggle.separatorBefore).map((toggle) => toggle.id)).toEqual(['all']);
    expect(toggles.some((toggle) => toggle.disabledReason)).toBe(false);
  });

  it('disables the per-panel toggles, not the master, while every panel is hidden', () => {
    const toggles = harnessTitlebarToggles(new Set<HarnessPanelId>(['grammar']), true);
    const master = toggles[toggles.length - 1];

    expect(toggles.slice(0, 7).every((toggle) => typeof toggle.disabledReason === 'string')).toBe(true);
    // The per-panel preference still shows underneath the master switch.
    expect(toggles.find((toggle) => toggle.id === 'grammar')?.pressed).toBe(false);
    expect(master).toMatchObject({ id: 'all', pressed: false });
    expect(master?.disabledReason).toBeUndefined();
  });
});

describe('hidden panel persistence', () => {
  let store: Map<string, string>;

  beforeEach(() => {
    store = new Map();
    vi.stubGlobal('localStorage', {
      getItem: (key: string): string | null => store.get(key) ?? null,
      setItem: (key: string, value: string): void => { store.set(key, value); },
      removeItem: (key: string): void => { store.delete(key); },
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('round-trips per project and removes the key when nothing is hidden', () => {
    writeHiddenPanels('/repo/a', new Set<HarnessPanelId>(['ticket', 'grammar']));
    writeHiddenPanels('/repo/b', new Set<HarnessPanelId>(['plan']));

    expect([...readHiddenPanels('/repo/a')].sort()).toEqual(['grammar', 'ticket']);
    expect([...readHiddenPanels('/repo/b')]).toEqual(['plan']);

    writeHiddenPanels('/repo/a', new Set());
    expect(readHiddenPanels('/repo/a').size).toBe(0);
    expect([...store.keys()]).toEqual(['krypton:acp-harness:hidden-panels:/repo/b']);
  });

  it('reads corrupt or foreign values as visible', () => {
    store.set('krypton:acp-harness:hidden-panels:/repo', '{not json');
    expect(readHiddenPanels('/repo').size).toBe(0);

    store.set('krypton:acp-harness:hidden-panels:/repo', JSON.stringify({ plan: true }));
    expect(readHiddenPanels('/repo').size).toBe(0);

    store.set('krypton:acp-harness:hidden-panels:/repo', JSON.stringify(['plan', 'zen', 7, 'constructor']));
    expect([...readHiddenPanels('/repo')]).toEqual(['plan']);
  });

  it('degrades to visible when storage throws', () => {
    vi.stubGlobal('localStorage', {
      getItem: (): string | null => { throw new Error('denied'); },
      setItem: (): void => { throw new Error('denied'); },
      removeItem: (): void => { throw new Error('denied'); },
    });

    writeHiddenPanels('/repo', new Set<HarnessPanelId>(['plan']));
    expect(readHiddenPanels('/repo').size).toBe(0);
  });
});
