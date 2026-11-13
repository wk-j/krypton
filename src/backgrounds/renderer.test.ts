// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@tauri-apps/api/core', () => ({ convertFileSrc: (path: string) => `asset://${path}` }));

import { choice, emptyState, PRESETS } from './model';
import { WorkspaceBackground } from './renderer';
import type { BackgroundState } from './types';

let renderer: WorkspaceBackground;
let motion: MediaQueryList;
let hidden = false;
let decode = vi.fn<() => Promise<void>>();
const animations: Array<{ cancel: ReturnType<typeof vi.fn>; finish: () => void; frames: Keyframe[] }> = [];
const state = (): BackgroundState => ({ ...emptyState(), revision: 'one', active: PRESETS[1].choice, permissionRule: { enabled: true, target: PRESETS[5].choice } });
const flush = async (): Promise<void> => { for (let i = 0; i < 8; i++) await Promise.resolve(); };
beforeEach(() => {
  hidden = false; animations.length = 0; decode = vi.fn(async () => undefined);
  motion = Object.assign(new EventTarget(), { matches: false }) as MediaQueryList;
  vi.spyOn(window, 'matchMedia').mockReturnValue(motion);
  vi.spyOn(document, 'hidden', 'get').mockImplementation(() => hidden);
  vi.stubGlobal('Image', class { src = ''; decode = (): Promise<void> => decode(); });
  vi.spyOn(HTMLElement.prototype, 'animate').mockImplementation(function (frames) {
    let finish!: () => void; let reject!: (error: Error) => void;
    const finished = new Promise<void>((resolve, fail) => { finish = resolve; reject = fail; });
    const animation = { cancel: vi.fn(() => reject(new Error('AbortError'))), finish, frames: frames as Keyframe[] };
    animations.push(animation);
    return { ...animation, finished } as unknown as Animation;
  });
  renderer = new WorkspaceBackground(document.body);
});
afterEach(() => { renderer.dispose(); vi.restoreAllMocks(); vi.unstubAllGlobals(); document.body.replaceChildren(); });

describe('two-slot background renderer', () => {
  it('mounts behind the workspace and maps content, opacity and dimming independently', async () => {
    renderer.dispose();
    const workspace = document.createElement('main'); document.body.append(workspace);
    renderer = new WorkspaceBackground(document.body, workspace);
    await renderer.update(state(), false);
    expect(workspace.previousSibling).toBe(renderer.element);
    expect(renderer.element.querySelectorAll('.krypton-workspace-background__slot')).toHaveLength(2);
    expect(renderer.element.getAttribute('aria-hidden')).toBe('true');
    expect(animations).toHaveLength(0);
    expect(renderer.element.querySelector<HTMLElement>('.krypton-workspace-background__content')!.style.backgroundColor).toBe('#101218');
  });
  it('reverses from the current presentation, cancels only its two effects, and no-ops repeated positives', async () => {
    const s = state(); await renderer.update(s, false); await renderer.update(s, true);
    expect(animations).toHaveLength(2);
    const original = window.getComputedStyle.bind(window);
    const target = renderer.element.children[1];
    vi.spyOn(window, 'getComputedStyle').mockImplementation((el) => el === target ? { opacity: '0.4' } as CSSStyleDeclaration : original(el));
    await renderer.update(s, false);
    expect(animations[0].cancel).toHaveBeenCalledOnce();
    expect(animations[3].frames).toEqual([{ opacity: 0.4 }, { opacity: 0 }]);
    expect(renderer.element.children).toHaveLength(2);
    await renderer.update(s, true);
    const count = animations.length; await renderer.update(s, true);
    expect(animations).toHaveLength(count);
  });
  it('cannot activate a permission cleared while its image is decoding', async () => {
    const s = state(); const id = 'a'.repeat(64);
    s.assets = [{ id, name: 'A', imagePath: '/a.png', thumbnailPath: '/thumb.png', width: 10, height: 10, bytes: 100 }];
    s.permissionRule.target = choice({ kind: 'image', assetId: id });
    let release!: () => void;
    decode.mockReturnValue(new Promise<void>((resolve) => { release = resolve; }));
    const enter = renderer.update(s, true); const exit = renderer.update(s, false);
    release(); await enter; await exit;
    expect((renderer.element.children[1] as HTMLElement).style.opacity).toBe('0');
    expect(animations).toHaveLength(0);
  });
  it('updates base/target while active without exposing the base, and reset is instantly transparent', async () => {
    const s = state(); await renderer.update(s, false); await renderer.update(s, true);
    for (const a of animations) a.finish(); await flush();
    const next = { ...s, revision: 'two', active: PRESETS[2].choice, permissionRule: { enabled: true, target: PRESETS[6].choice } };
    await renderer.update(next, true);
    expect((renderer.element.children[1] as HTMLElement).style.opacity).toBe('1');
    expect(animations).toHaveLength(2);
    await renderer.update({ ...emptyState(), revision: 'reset' }, true, true);
    expect(renderer.element.hidden).toBe(true);
    expect((renderer.element.children[1] as HTMLElement).style.opacity).toBe('0');
  });
  it('settles hidden/reduced-motion transitions and ignores late completion after disposal', async () => {
    const s = state(); await renderer.update(s, false); await renderer.update(s, true);
    hidden = true; document.dispatchEvent(new Event('visibilitychange'));
    expect(animations[0].cancel).toHaveBeenCalled();
    expect((renderer.element.children[1] as HTMLElement).style.opacity).toBe('1');
    hidden = false; Object.assign(motion, { matches: true });
    await renderer.update(s, false); expect(animations).toHaveLength(2);
    renderer.dispose(); for (const a of animations) a.finish(); await flush();
    expect(renderer.element.isConnected).toBe(false);
  });
  it('hides an empty Desktop override only after its fade, then reveals the base on return', async () => {
    const s = state(); s.permissionRule.target = emptyState().active;
    await renderer.update(s, false); await renderer.update(s, true);
    expect(renderer.element.hidden).toBe(false);
    for (const a of animations) a.finish(); await flush();
    expect(renderer.element.hidden).toBe(true);
    await renderer.update(s, false); expect(renderer.element.hidden).toBe(false);
  });
  it('settles identical choices without dimming them through an unnecessary crossfade', async () => {
    const s = state(); s.permissionRule.target = s.active;
    await renderer.update(s, false); await renderer.update(s, true);
    expect(animations).toHaveLength(0);
    expect((renderer.element.children[0] as HTMLElement).style.opacity).toBe('1');
    expect((renderer.element.children[1] as HTMLElement).style.opacity).toBe('0');
  });
  it('cancels obsolete preview decodes and releases a pending load on disposal', async () => {
    const s = state(); const id = 'a'.repeat(64);
    s.assets = [{ id, name: 'A', imagePath: '/a.png', thumbnailPath: '/thumb.png', width: 10, height: 10, bytes: 100 }];
    s.active = choice({ kind: 'image', assetId: id });
    decode.mockReturnValue(new Promise<void>(() => undefined));
    const old = renderer.update(s, false);
    await renderer.update(state(), false);
    await old; // cancellation must settle without waiting for decode completion
    const pending = renderer.update(s, false); renderer.dispose(); await pending;
    expect(renderer.element.isConnected).toBe(false);
  });
  it('reports missing assets once per state, falls back without persistence, and retries on Refresh', async () => {
    renderer.dispose(); const report = vi.fn(); renderer = new WorkspaceBackground(document.body, null, report);
    const s = state(); const id = 'a'.repeat(64);
    s.permissionRule.target = choice({ kind: 'image', assetId: id });
    s.assets = [{ id, name: 'Missing', imagePath: '/gone.png', thumbnailPath: '/thumb.png', width: 1, height: 1, bytes: 1 }];
    decode.mockRejectedValue(new Error('missing'));
    await renderer.update(s, false); await renderer.update(s, true); await renderer.update(s, false);
    expect(report).toHaveBeenCalledTimes(1); expect(decode).toHaveBeenCalledTimes(1);
    expect(s.permissionRule.enabled).toBe(true);
    decode.mockResolvedValue(undefined);
    await renderer.update({ ...s }, true);
    expect(decode).toHaveBeenCalledTimes(2);
  });
});
