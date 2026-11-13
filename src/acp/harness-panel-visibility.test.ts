import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  harnessTitlebarToggles,
  nextHidden,
  panelFlash,
  parsePanelsCommand,
  readHiddenPanels,
  readSideHidden,
  writeHiddenPanels,
  writeSideHidden,
  type HarnessPanelId,
} from './harness-panel-visibility';

describe('parsePanelsCommand (specs 320, 347)', () => {
  it('addresses a side panel, bare or with an action first', () => {
    expect(parsePanelsCommand(['left'])).toEqual({ kind: 'side', side: 'left', action: 'toggle' });
    expect(parsePanelsCommand(['hide', 'Right'])).toEqual({ kind: 'side', side: 'right', action: 'hide' });
    expect(parsePanelsCommand(['SHOW', 'left'])).toEqual({ kind: 'side', side: 'left', action: 'show' });
  });

  it('addresses one panel, bare or with an action first', () => {
    expect(parsePanelsCommand(['grammar'])).toEqual({ kind: 'panel', panel: 'grammar', action: 'toggle' });
    expect(parsePanelsCommand(['hide', 'Ticket'])).toEqual({ kind: 'panel', panel: 'ticket', action: 'hide' });
    expect(parsePanelsCommand(['show', 'peek'])).toEqual({ kind: 'panel', panel: 'peek', action: 'show' });
    expect(parsePanelsCommand(['show', 'assistants'])).toEqual({ kind: 'panel', panel: 'assistants', action: 'show' });
  });

  it('treats the removed all-panels forms as usage', () => {
    for (const args of [[], ['hide'], ['show'], ['toggle']]) {
      expect(parsePanelsCommand(args)).toEqual({ kind: 'usage' });
    }
  });

  it('rejects unknown words, reversed order and extra words', () => {
    for (const args of [['maybe'], ['hide', 'now'], ['grammar', 'hide'], ['left', 'hide'], ['hide', 'plan', 'now'], ['hide', 'hide']]) {
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
  it('lists eight panels, then the left and right panels behind one divider', () => {
    const toggles = harnessTitlebarToggles(new Set<HarnessPanelId>(['thought']), { left: true, right: false });

    expect(toggles.map((toggle) => toggle.id)).toEqual(['plan', 'peek', 'thought', 'grammar', 'queue', 'ticket', 'rails', 'git', 'left', 'right']);
    expect(toggles.map((toggle) => toggle.pressed)).toEqual([true, true, false, true, true, true, true, true, false, true]);
    expect(toggles.filter((toggle) => toggle.separatorBefore).map((toggle) => toggle.id)).toEqual(['left']);
  });

  it('never disables a toggle or presses another one from a side flag', () => {
    const toggles = harnessTitlebarToggles(new Set<HarnessPanelId>(['grammar']), { left: true, right: true });

    expect(toggles.some((toggle) => toggle.disabledReason !== undefined)).toBe(false);
    // Dock tabs show their own flag, not the right panel's.
    expect(toggles.slice(0, 8).map((toggle) => toggle.pressed)).toEqual([true, true, true, false, true, true, true, true]);
  });
});

describe('panelFlash', () => {
  it('mentions the hidden right panel for every dock tab', () => {
    expect(panelFlash('ticket', false, true)).toBe('ticket shown · right panel hidden');
    expect(panelFlash('rails', true, true)).toBe('rails hidden · #panels show rails · right panel hidden');
    expect(panelFlash('assistants', false, true)).toBe('assistants shown · right panel hidden');
    expect(panelFlash('git', false, true)).toBe('git shown · right panel hidden');
    expect(panelFlash('plan', false, true)).toBe('plan shown');
    expect(panelFlash('ticket', false, false)).toBe('ticket shown');
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

  it('round-trips v2 per project and preserves an explicitly empty hidden list', () => {
    writeHiddenPanels('/repo/a', new Set<HarnessPanelId>(['ticket', 'grammar']));
    writeHiddenPanels('/repo/b', new Set<HarnessPanelId>(['plan']));

    expect([...readHiddenPanels('/repo/a')].sort()).toEqual(['grammar', 'ticket']);
    expect([...readHiddenPanels('/repo/b')]).toEqual(['plan']);

    writeHiddenPanels('/repo/a', new Set());
    expect(readHiddenPanels('/repo/a').size).toBe(0);
    expect(JSON.parse(store.get('krypton:acp-harness:hidden-panels:/repo/a')!)).toEqual({ version: 2, hidden: [] });
  });

  it('stores each side per project and removes the key when shown', () => {
    writeSideHidden('/repo/a', 'left', true);
    writeSideHidden('/repo/a', 'right', true);
    writeSideHidden('/repo/b', 'right', true);

    expect([readSideHidden('/repo/a', 'left'), readSideHidden('/repo/a', 'right')]).toEqual([true, true]);
    expect([readSideHidden('/repo/b', 'left'), readSideHidden('/repo/b', 'right')]).toEqual([false, true]);

    writeSideHidden('/repo/a', 'left', false);
    writeSideHidden('/repo/a', 'right', false);
    expect([...store.keys()]).toEqual(['krypton:acp-harness:right-panel-hidden:/repo/b']);
  });

  it('keeps old panels visible and Assistants and Git hidden for missing or invalid storage', () => {
    store.set('krypton:acp-harness:hidden-panels:/repo', '{not json');
    expect([...readHiddenPanels('/repo')]).toEqual(['assistants', 'git']);
    expect(store.has('krypton:acp-harness:git-panel-migrated:/repo')).toBe(false);

    store.set('krypton:acp-harness:hidden-panels:/repo', JSON.stringify({ plan: true }));
    expect([...readHiddenPanels('/repo')]).toEqual(['assistants', 'git']);

    store.delete('krypton:acp-harness:hidden-panels:/repo');
    expect([...readHiddenPanels('/repo')]).toEqual(['assistants', 'git']);
    expect(store.size).toBe(0);
  });

  it('migrates legacy flags into one v2 envelope, adding the opt-in panels', () => {
    const key = 'krypton:acp-harness:hidden-panels:/repo';
    store.set(key, JSON.stringify(['plan', 'ticket', 'rails', 'zen', 7, 'constructor']));
    expect([...readHiddenPanels('/repo')]).toEqual(['plan', 'ticket', 'rails', 'assistants', 'git']);
    expect(JSON.parse(store.get(key)!)).toEqual({ version: 2, hidden: ['plan', 'ticket', 'rails', 'assistants', 'git'] });
    expect(store.get('krypton:acp-harness:git-panel-migrated:/repo')).toBe('1');
    expect([...readHiddenPanels('/repo')]).toEqual(['plan', 'ticket', 'rails', 'assistants', 'git']);
    writeHiddenPanels('/repo', new Set(['plan']));
    expect([...readHiddenPanels('/repo')]).toEqual(['plan']);
  });

  it('hides Git once on an existing v2 blob, then keeps an explicit show', () => {
    const key = 'krypton:acp-harness:hidden-panels:/repo';
    store.set(key, JSON.stringify({ version: 2, hidden: ['plan'] }));
    expect([...readHiddenPanels('/repo')].sort()).toEqual(['git', 'plan']);
    expect(store.get('krypton:acp-harness:git-panel-migrated:/repo')).toBe('1');
    writeHiddenPanels('/repo', new Set(['plan']));
    expect([...readHiddenPanels('/repo')]).toEqual(['plan']);
  });

  it('keeps Assistants and Git opt-in when storage throws without hiding older panels', () => {
    vi.stubGlobal('localStorage', {
      getItem: (): string | null => { throw new Error('denied'); },
      setItem: (): void => { throw new Error('denied'); },
      removeItem: (): void => { throw new Error('denied'); },
    });

    writeHiddenPanels('/repo', new Set<HarnessPanelId>(['plan']));
    writeSideHidden('/repo', 'right', true);
    expect([...readHiddenPanels('/repo')]).toEqual(['assistants', 'git']);
    expect(readSideHidden('/repo', 'right')).toBe(false);
  });
});
