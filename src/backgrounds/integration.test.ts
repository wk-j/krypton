// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('@tauri-apps/api/core', async (original) => ({ ...await original<typeof import('@tauri-apps/api/core')>(), invoke: vi.fn() }));
vi.mock('./view', () => ({ BackgroundsView: class {
  readonly element = document.createElement('div');
  readonly type = 'backgrounds';
  onClose = vi.fn(); dispose = vi.fn();
} }));

import { CommandScope } from '../command-palette';
import { Compositor } from '../compositor';
import { InputRouter } from '../input-router';
import type { PaletteAction } from '../palette-types';
import { LayoutMode, Mode } from '../types';
import { WhichKey } from '../which-key';

interface BackgroundHost {
  openBackgrounds(): Promise<void>;
  backgroundsOpening: Promise<void> | null;
}
afterEach(() => document.body.replaceChildren());
describe('background entry integration', () => {
  it('focuses the actual hidden tab and split pane instead of opening a duplicate', async () => {
    const view = { type: 'backgrounds', element: document.createElement('div') };
    const pane = { id: 'background-pane', contentView: view };
    const tab = { paneTree: {}, focusedPaneId: 'terminal-pane' };
    const win = { tabs: [{ paneTree: {} }, tab], activeTabIndex: 0 };
    const focus = vi.fn();
    const host = Object.assign(Object.create(Compositor.prototype), {
      windows: new Map([['hosting-window', win]]), backgroundsOpening: null,
      collectPanes: (tree: object) => tree === tab.paneTree ? [pane] : [],
      focusWindow: focus, showActiveTab: vi.fn(), updateTabBar: vi.fn(), focusContentView: vi.fn(),
      createContentTab: vi.fn(), showNotification: vi.fn(),
    });
    await host.openBackgrounds();
    expect(focus).toHaveBeenCalledWith('hosting-window'); expect(win.activeTabIndex).toBe(1);
    expect(tab.focusedPaneId).toBe('background-pane'); expect(host.focusContentView).toHaveBeenCalledWith(view);
    expect(host.createContentTab).not.toHaveBeenCalled();
  });
  it('shares one in-flight opener and can open again after completion', async () => {
    let finish!: () => void;
    const once = vi.fn(() => new Promise<void>((resolve) => { finish = resolve; }));
    const host = Object.assign(Object.create(Compositor.prototype), { backgroundsOpening: null, openBackgroundsOnce: once, showNotification: vi.fn() }) as BackgroundHost;
    const a = host.openBackgrounds(); const b = host.openBackgrounds();
    expect(once).toHaveBeenCalledOnce(); finish(); await a; await b;
    const c = host.openBackgrounds(); expect(once).toHaveBeenCalledTimes(2); finish(); await c;
  });
  it('mounts a manager in a tab, or a content window when no window is focused', async () => {
    for (const focusedWindowId of ['win', null]) {
      const host = Object.assign(Object.create(Compositor.prototype), {
        windows: new Map(), backgroundsOpening: null, focusedWindowId, backgroundStore: {},
        createContentTab: vi.fn(async () => undefined), createContentWindow: vi.fn(async () => 'new'), showNotification: vi.fn(),
      });
      await host.openBackgrounds();
      const called = focusedWindowId ? host.createContentTab : host.createContentWindow;
      expect(called).toHaveBeenCalledWith('BACKGROUNDS // workspace', expect.objectContaining({ type: 'backgrounds' }));
    }
  });
  it('routes Leader A but leaves bare a as AI Agent, with palette/legend agreement in every layout', async () => {
    const compositor = { openBackgrounds: vi.fn(async () => undefined), openAgentView: vi.fn(async () => undefined) };
    const target = { compositor, handleFocusedLeaderKey: () => false, toNormal: vi.fn() };
    const handler = (InputRouter.prototype as unknown as { handleCompositorKey(e: KeyboardEvent): void }).handleCompositorKey;
    handler.call(target, new KeyboardEvent('keydown', { key: 'A', shiftKey: true }));
    handler.call(target, new KeyboardEvent('keydown', { key: 'a' }));
    await Promise.resolve(); expect(compositor.openBackgrounds).toHaveBeenCalledOnce(); expect(compositor.openAgentView).toHaveBeenCalledOnce();
    expect(target.toNormal).toHaveBeenCalledTimes(2);
    const scope = new CommandScope(compositor as unknown as Compositor);
    const action = (scope as unknown as { staticActions: PaletteAction[] }).staticActions.find((a) => a.id === 'backgrounds.open');
    expect(action).toMatchObject({ label: 'Open Backgrounds', icon: 'images', keybinding: 'Leader A' });
    await action!.execute(); expect(compositor.openBackgrounds).toHaveBeenCalledTimes(2);
    const whichKey = new WhichKey();
    for (const layout of Object.values(LayoutMode)) {
      whichKey.setMode(Mode.Compositor, null, [], layout);
      const row = [...document.querySelectorAll('.krypton-whichkey__entry')].find((el) => el.textContent?.includes('Backgrounds'));
      expect(row?.querySelector('.krypton-whichkey__key')?.textContent).toBe('A');
    }
  });
});
