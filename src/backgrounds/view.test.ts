// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ invoke: vi.fn(), previews: [] as Array<{ state: unknown; active: boolean }>, preload: vi.fn(async () => undefined) }));
vi.mock('@tauri-apps/api/core', () => ({ invoke: mocks.invoke, convertFileSrc: (p: string) => `asset://${p}` }));
vi.mock('./renderer', () => ({
  preloadChoice: mocks.preload,
  WorkspaceBackground: class {
    element = document.createElement('div');
    constructor(parent: HTMLElement, before: HTMLElement | null) { parent.insertBefore(this.element, before); }
    async update(state: unknown, active: boolean): Promise<void> { mocks.previews.push({ state, active }); }
    dispose(): void { this.element.remove(); }
  },
}));

import { choice, emptyState, PRESETS } from './model';
import { BackgroundStore } from './store';
import type { BackgroundState } from './types';
import { BackgroundsView } from './view';

let store: BackgroundStore;
let view: BackgroundsView;
let saved: BackgroundState;
const button = (action: string): HTMLButtonElement => view.element.querySelector<HTMLButtonElement>(`[data-action="${action}"]`)!;
const pick = (id: string): void => view.element.querySelector<HTMLButtonElement>(`[data-item="${id}"]`)!.click();
const pickRule = (id: string): void => {
  button('rule-picker').click();
  view.element.querySelector<HTMLButtonElement>(`[data-rule-item="${id}"]`)!.click();
};
const key = (value: string, modifiers: KeyboardEventInit = {}): boolean => view.onKeyDown(new KeyboardEvent('keydown', { key: value, ...modifiers }));
beforeEach(async () => {
  mocks.invoke.mockReset(); mocks.previews.length = 0;
  saved = { ...emptyState(), revision: 'one' };
  mocks.invoke.mockImplementation(async (command: string, args: { choice?: BackgroundState['active']; rule?: BackgroundState['permissionRule'] }) => {
    if (command === 'background_apply') saved = { ...saved, active: args.choice!, revision: saved.revision + 'x' };
    if (command === 'background_rule_save') saved = { ...saved, permissionRule: args.rule!, revision: saved.revision + 'x' };
    if (command === 'background_reset') saved = { ...saved, active: emptyState().active, permissionRule: { ...saved.permissionRule, enabled: false }, revision: saved.revision + 'x' };
    return structuredClone(saved);
  });
  store = new BackgroundStore(); await store.refresh();
  view = new BackgroundsView(store); document.body.append(view.element); view.focusView();
});
afterEach(() => { view.dispose(); document.body.replaceChildren(); });

describe('Backgrounds manager', () => {
  it('follows the reference: narrow library beside preview, appearance and one rule; no editing modes', () => {
    const [sidebar, main] = view.element.querySelector('.krypton-backgrounds__columns')!.children;
    expect(sidebar.tagName).toBe('ASIDE');
    expect(sidebar.querySelector('h2')!.textContent).toBe('01 / Library');
    expect(sidebar.querySelector('[role="listbox"]')).not.toBeNull();
    expect([...main.children].slice(0, 3).map((section) => section.getAttribute('aria-label'))).toEqual([
      'Workspace preview', 'Background appearance', 'Event rules',
    ]);
    expect(main.querySelectorAll('[role="row"]')).toHaveLength(2);
    expect(view.element.querySelector('[aria-label="Editing target"]')).toBeNull();
    expect(view.element.querySelector('[data-action="permission"]')).toBeNull();
    expect(view.element.querySelector('[data-action="base"]')).toBeNull();
    expect(sidebar.textContent).toContain('Images stay local');
  });
  it('keeps Apply, Return to base and Restore Desktop at the bottom, with a separate explicit rule save', () => {
    const editor = view.element.querySelector<HTMLElement>('[aria-label="Background editor"]')!;
    expect(editor.getAttribute('role')).toBe('region');
    expect(editor.tabIndex).toBe(0);
    const actions = view.element.querySelector('.krypton-backgrounds__commit-actions')!;
    expect(actions.parentElement).toBe(view.element);
    expect([...actions.querySelectorAll('button')].slice(0, 3).map((b) => b.dataset.action)).toEqual(['apply', 'return', 'reset']);
    expect(editor.contains(button('apply'))).toBe(false);
    expect(view.element.querySelector('.krypton-backgrounds__rules')!.contains(button('save-rule'))).toBe(true);
    expect(button('apply').hidden).toBe(false);
    expect(button('save-rule').disabled).toBe(true);
    const hints = view.element.querySelector<HTMLElement>('[aria-label="Background keyboard shortcuts"]')!;
    expect(hints.tabIndex).toBe(0);
    hints.focus(); expect(key('ArrowDown')).toBe(false);
    editor.focus(); expect(key('PageDown')).toBe(false);
  });
  it('shows image controls only for images and keeps directional anchors accessible at the configured text size', async () => {
    const fieldsets = [...view.element.querySelectorAll('fieldset')];
    expect(fieldsets).toHaveLength(2);
    expect(fieldsets.every((fieldset) => fieldset.hidden && fieldset.disabled)).toBe(true);
    expect(view.element.textContent).toContain('Desktop is transparent. Select Custom colour');
    pick('graphite');
    expect(fieldsets.every((fieldset) => fieldset.hidden)).toBe(true);
    const id = 'a'.repeat(64);
    saved = { ...saved, revision: 'two', assets: [{ id, name: 'Lake.png', imagePath: '/owned/a.png', thumbnailPath: '/owned/thumb.png', width: 10, height: 10, bytes: 100 }] };
    await store.refresh(); pick(id);
    expect(fieldsets.every((fieldset) => !fieldset.hidden && !fieldset.disabled)).toBe(true);
    const anchors = view.element.querySelectorAll<HTMLButtonElement>('[data-action="anchor"]');
    expect(anchors).toHaveLength(9);
    const disclosure = view.element.querySelector<HTMLDetailsElement>('.krypton-backgrounds__anchor-disclosure')!;
    expect(disclosure.open).toBe(false); disclosure.open = true;
    const topLeft = anchors[0];
    expect(topLeft.textContent).toBe('↖');
    expect(topLeft.getAttribute('aria-label')).toBe('Image anchor: top left');
    expect(topLeft.title).toBe('Image anchor: top left');
    topLeft.click();
    expect(topLeft.getAttribute('aria-pressed')).toBe('true');
    expect(disclosure.open).toBe(false);
    expect(mocks.previews[mocks.previews.length - 1]?.state).toMatchObject({ active: { anchor: 'top-left' } });
    pick('desktop');
    expect(fieldsets.every((fieldset) => fieldset.hidden && fieldset.disabled)).toBe(true);
  });
  it('preserves row identity and independently marks selected and Applied, with preview-only drafts', async () => {
    const desktop = view.element.querySelector('[data-item="desktop"]');
    pick('graphite');
    expect(view.element.querySelector('[data-item="desktop"]')).toBe(desktop);
    expect(desktop!.querySelector<HTMLElement>('.krypton-backgrounds__applied')!.hidden).toBe(false);
    expect(view.element.querySelector('[data-item="graphite"]')!.getAttribute('aria-selected')).toBe('true');
    expect(store.state.active.source.kind).toBe('desktop'); expect(mocks.invoke).toHaveBeenCalledTimes(1);
    button('apply').click();
    await vi.waitFor(() => expect(store.state.active).toEqual(PRESETS[1].choice));
    expect(view.element.textContent).toContain('Base saved');
  });
  it('retains a failed draft and editor identity, rejects invalid colours, and preserves native typing/global keys', async () => {
    pick('custom'); const color = view.element.querySelector<HTMLInputElement>('input[name="color"]')!;
    color.focus(); color.value = '#123456'; color.dispatchEvent(new Event('input'));
    expect(key('q')).toBe(false); expect(key('i')).toBe(false); expect(key('p', { metaKey: true })).toBe(false);
    mocks.invoke.mockRejectedValueOnce('Disk full'); key('Enter', { metaKey: true });
    await vi.waitFor(() => expect(view.element.textContent).toContain('Disk full'));
    expect(view.element.querySelector('input[name="color"]')).toBe(color); expect(color.value).toBe('#123456');
    expect(saved.active.source.kind).toBe('desktop');
    color.value = 'bad'; color.dispatchEvent(new Event('input'));
    expect(button('apply').disabled).toBe(true);
    expect(key('Escape')).toBe(true); expect(document.activeElement?.getAttribute('role')).toBe('listbox');
  });
  it('edits one independent rule without switching the library into a different mode or enabling by selection', async () => {
    expect(button('try').disabled).toBe(true);
    pick('ocean');
    expect(button('try').disabled).toBe(true);
    pickRule('preview');
    expect(store.state.permissionRule.enabled).toBe(false);
    expect(view.element.querySelector<HTMLInputElement>('input[name="permissionEnabled"]')!.checked).toBe(false);
    expect(view.element.querySelector('[data-item="ocean"]')!.getAttribute('aria-selected')).toBe('true');
    button('try').click(); expect(mocks.previews[mocks.previews.length - 1]?.active).toBe(true); expect(mocks.invoke).toHaveBeenCalledTimes(1);
    expect(mocks.previews[mocks.previews.length - 1]?.state).toMatchObject({ active: { source: { kind: 'desktop' } } });
    expect(key('Escape')).toBe(true); expect(mocks.previews[mocks.previews.length - 1]?.active).toBe(false);
    const enabled = view.element.querySelector<HTMLInputElement>('input[name="permissionEnabled"]')!; enabled.click();
    button('save-rule').click();
    await vi.waitFor(() => expect(store.state.permissionRule.enabled).toBe(true));
    expect(store.state.permissionRule.target).toEqual(PRESETS[6].choice);
    expect(store.state.active.source.kind).toBe('desktop');
    pick('graphite'); button('apply').click();
    await vi.waitFor(() => expect(store.state.active).toEqual(PRESETS[1].choice));
    expect(store.state.permissionRule.target).toEqual(PRESETS[6].choice);
  });
  it('keeps rule colour/appearance snapshots independent and retains an unsaved rule through a base save', async () => {
    pick('custom');
    const color = view.element.querySelector<HTMLInputElement>('input[name="color"]')!;
    color.value = '#123456'; color.dispatchEvent(new Event('input'));
    const opacity = view.element.querySelector<HTMLInputElement>('input[type="number"][name="opacity"]')!;
    opacity.value = '55'; opacity.dispatchEvent(new Event('input'));
    pickRule('preview');
    pick('paper'); button('apply').click();
    await vi.waitFor(() => expect(store.state.active).toEqual(PRESETS[3].choice));
    expect(store.state.permissionRule.target).toBeNull();
    expect(button('save-rule').disabled).toBe(false);
    button('save-rule').click();
    await vi.waitFor(() => expect(store.state.permissionRule.target).toMatchObject({ source: { kind: 'solid', color: '#123456' }, opacity: 0.55 }));
    expect(store.state.permissionRule.enabled).toBe(false);
    expect(store.state.active).toEqual(PRESETS[3].choice);
    expect(button('save-rule').disabled).toBe(true);
  });
  it('uses a keyboard-operable rule picker with local Escape, outside dismissal and no global library shortcuts', () => {
    pick('graphite'); button('rule-picker').click();
    expect(button('rule-picker').getAttribute('aria-expanded')).toBe('true');
    expect(document.activeElement?.getAttribute('role')).toBe('option');
    const initial = document.activeElement;
    expect(key('ArrowDown')).toBe(true); expect(document.activeElement).not.toBe(initial);
    expect(key('End')).toBe(true); expect(document.activeElement?.textContent).toContain('Ocean');
    expect(key('j')).toBe(false);
    expect(key('Escape')).toBe(true);
    expect(document.activeElement).toBe(button('rule-picker'));
    expect(button('rule-picker').getAttribute('aria-expanded')).toBe('false');
    expect(view.element.querySelectorAll('[data-rule-item]')).toHaveLength(0);
    button('rule-picker').click(); button('apply').focus();
    expect(button('rule-picker').getAttribute('aria-expanded')).toBe('false');
    expect(view.element.querySelector('[data-item="graphite"]')!.getAttribute('aria-selected')).toBe('true');
  });
  it('does not discard an invalid colour being typed when an independent rule is saved', async () => {
    pickRule('dusk'); pick('custom');
    const color = view.element.querySelector<HTMLInputElement>('input[name="color"]')!;
    color.value = 'bad'; color.dispatchEvent(new Event('input'));
    button('save-rule').click();
    await vi.waitFor(() => expect(store.state.permissionRule.target).toEqual(PRESETS[5].choice));
    expect(color.value).toBe('bad'); expect(button('apply').disabled).toBe(true);
    expect(store.state.active.source.kind).toBe('desktop');
  });
  it('retains a failed rule draft, while Refresh explicitly discards both drafts', async () => {
    pick('ocean'); pickRule('preview');
    mocks.invoke.mockRejectedValueOnce('Disk full'); button('save-rule').click();
    await vi.waitFor(() => expect(view.element.textContent).toContain('Disk full'));
    expect(button('rule-picker').textContent).toContain('Ocean');
    expect(button('save-rule').disabled).toBe(false);
    expect(store.state.permissionRule.target).toBeNull();
    button('refresh').click();
    await vi.waitFor(() => expect(view.element.textContent).toContain('Library refreshed'));
    expect(button('rule-picker').textContent).toContain('Select background');
    expect(view.element.querySelector('[data-item="desktop"]')!.getAttribute('aria-selected')).toBe('true');
    expect(button('save-rule').disabled).toBe(true);
  });
  it('disposes an open rule picker and its delegated/document listeners without late UI work', () => {
    button('rule-picker').click();
    const target = button('rule-picker'); const count = mocks.previews.length;
    view.dispose();
    expect(view.element.querySelectorAll('[data-rule-item]')).toHaveLength(0);
    target.click(); document.body.dispatchEvent(new Event('pointerdown', { bubbles: true }));
    expect(view.element.querySelectorAll('[data-rule-item]')).toHaveLength(0);
    expect(mocks.previews).toHaveLength(count);
  });
  it('returns to the saved base without discarding independent unsaved rule edits', () => {
    pick('ocean'); pickRule('preview'); pick('graphite');
    button('return').click();
    expect(view.element.querySelector('[data-item="desktop"]')!.getAttribute('aria-selected')).toBe('true');
    expect(button('save-rule').disabled).toBe(false);
    expect(button('rule-picker').textContent).toContain('Ocean');
  });
  it('restores Desktop and disables the saved rule atomically, retaining its target', async () => {
    saved = { ...saved, active: PRESETS[1].choice, permissionRule: { enabled: true, target: PRESETS[5].choice } };
    await store.refresh(); button('reset').click();
    await vi.waitFor(() => expect(store.state.permissionRule.enabled).toBe(false));
    expect(store.state.permissionRule.target).toEqual(PRESETS[5].choice);
    expect(store.state.active.source.kind).toBe('desktop');
    expect(mocks.invoke.mock.calls[mocks.invoke.mock.calls.length - 1]?.[0]).toBe('background_reset');
  });
  it('supports library navigation, search Escape, and close without swallowing control Enter', () => {
    const close = vi.fn(); view.onClose(close);
    key('j'); expect(view.element.querySelector('[data-item="graphite"]')!.getAttribute('aria-selected')).toBe('true');
    const picker = view.element.querySelector('[role="listbox"]')!;
    expect(picker.getAttribute('aria-activedescendant')).toBe(view.element.querySelector('[data-item="graphite"]')!.id);
    key('/'); expect(document.activeElement).toBe(view.element.querySelector('input[type="search"]'));
    key('Escape'); expect(close).not.toHaveBeenCalled();
    button('apply').focus(); expect(key('Enter')).toBe(false);
    key('q'); expect(close).toHaveBeenCalledOnce();
  });
  it('disables mutations after a failed Refresh without overwriting applied state or the draft', async () => {
    pick('graphite');
    mocks.invoke.mockRejectedValueOnce('Repair library.json');
    button('refresh').click();
    await vi.waitFor(() => expect(store.loaded).toBe(false));
    expect(button('apply').disabled).toBe(true); expect(button('import').disabled).toBe(true); expect(button('reset').disabled).toBe(true);
    expect(view.element.textContent).toContain('Repair library.json');
    expect(store.state.active.source.kind).toBe('desktop');
    expect(view.element.querySelector('[data-item="graphite"]')!.getAttribute('aria-selected')).toBe('true');
  });
  it('commits confirmed removal by asset ID, repairs references and reports cleanup warnings', async () => {
    const id = 'a'.repeat(64); const image = choice({ kind: 'image', assetId: id });
    saved = { ...saved, revision: 'two', active: image, permissionRule: { enabled: true, target: image }, assets: [{ id, name: 'Lake.png', imagePath: '/owned/a.png', thumbnailPath: '/owned/thumb.png', width: 10, height: 10, bytes: 100 }] };
    await store.refresh(); pick(id); button('remove').click();
    const after = { ...emptyState(), revision: 'three' };
    mocks.invoke.mockResolvedValueOnce({ state: after, cleanupWarning: 'Thumbnail cleanup needs attention' });
    button('confirm-remove').click();
    await vi.waitFor(() => expect(store.state.assets).toHaveLength(0));
    expect(mocks.invoke).toHaveBeenLastCalledWith('background_remove', { assetId: id, expectedRevision: 'two' });
    expect(store.state.permissionRule).toEqual({ enabled: false, target: null });
    await vi.waitFor(() => expect(view.element.textContent).toContain('Thumbnail cleanup needs attention'));
  });
  it('does nothing on cancelled import and ignores late import completion after disposal', async () => {
    const input = view.element.querySelector<HTMLInputElement>('input[type="file"]')!;
    input.dispatchEvent(new Event('change')); expect(mocks.invoke).toHaveBeenCalledTimes(1);
    let finish!: (value: { state: BackgroundState; assetId: string }) => void;
    vi.spyOn(store, 'import').mockReturnValueOnce(new Promise((resolve) => { finish = resolve; }));
    Object.defineProperty(input, 'files', { value: [new File(['png'], 'one.png')] });
    input.dispatchEvent(new Event('change'));
    view.dispose(); const count = mocks.previews.length;
    finish({ state: saved, assetId: 'a'.repeat(64) }); await Promise.resolve(); await Promise.resolve();
    expect(mocks.previews).toHaveLength(count); expect(view.element.isConnected).toBe(false);
  });
  it('uses lazy thumbnails and confirms removal consequences without accepting frontend paths', async () => {
    const id = 'a'.repeat(64);
    saved = { ...saved, revision: 'two', assets: [{ id, name: 'Lake.png', imagePath: '/owned/a.png', thumbnailPath: '/owned/thumb.png', width: 10, height: 10, bytes: 100 }], active: choice({ kind: 'image', assetId: id }), permissionRule: { enabled: true, target: choice({ kind: 'image', assetId: id }) } };
    await store.refresh(); pick(id);
    expect(view.element.querySelector('img')!.getAttribute('loading')).toBe('lazy');
    button('remove').click(); expect(view.element.textContent).toContain('The permission rule will be cleared and disabled');
    expect(view.element.textContent).toContain('The base will return to Desktop');
    key('Escape'); expect(view.element.querySelector<HTMLElement>('.krypton-backgrounds__confirm')!.hidden).toBe(true);
    expect(mocks.invoke.mock.calls.every((c: unknown[]) => c[0] !== 'background_remove')).toBe(true);
  });
});
