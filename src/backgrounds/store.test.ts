// @vitest-environment happy-dom
import { describe, expect, it, vi, beforeEach } from 'vitest';

const mocks = vi.hoisted(() => ({ invoke: vi.fn(), preload: vi.fn() }));
vi.mock('@tauri-apps/api/core', () => ({ invoke: mocks.invoke }));
vi.mock('./renderer', () => ({ preloadChoice: mocks.preload }));

import { emptyState, PRESETS } from './model';
import { BackgroundStore } from './store';

beforeEach(() => { mocks.invoke.mockReset(); mocks.preload.mockReset(); mocks.preload.mockResolvedValue(undefined); });
async function loaded(): Promise<BackgroundStore> {
  const store = new BackgroundStore();
  mocks.invoke.mockResolvedValueOnce({ ...emptyState(), revision: 'one' });
  await store.refresh(); return store;
}
describe('shared background store', () => {
  it('preloads before committing, serializes mutations and uses the latest committed revision', async () => {
    const store = await loaded();
    let release!: () => void;
    mocks.preload.mockReturnValueOnce(new Promise<void>((resolve) => { release = resolve; }));
    mocks.invoke.mockResolvedValueOnce({ ...store.state, revision: 'two', active: PRESETS[1].choice })
      .mockResolvedValueOnce({ ...store.state, revision: 'three', active: PRESETS[1].choice, permissionRule: { enabled: true, target: PRESETS[2].choice } });
    const first = store.apply(PRESETS[1].choice);
    const second = store.saveRule({ enabled: true, target: PRESETS[2].choice });
    await Promise.resolve();
    expect(mocks.invoke).toHaveBeenCalledTimes(1);
    release(); await first; await second;
    expect(mocks.invoke).toHaveBeenNthCalledWith(2, 'background_apply', { choice: PRESETS[1].choice, expectedRevision: 'one' });
    expect(mocks.invoke).toHaveBeenNthCalledWith(3, 'background_rule_save', { rule: { enabled: true, target: PRESETS[2].choice }, expectedRevision: 'two' });
    expect(store.busy).toBe(false);
  });
  it('keeps applied state and the queue usable on preload/commit failures and conflicts', async () => {
    const store = await loaded(); const original = store.state;
    mocks.preload.mockRejectedValueOnce(new Error('missing image'));
    await expect(store.apply(PRESETS[1].choice)).rejects.toThrow('missing image');
    expect(store.state).toBe(original);
    mocks.invoke.mockRejectedValueOnce('Background library changed; Refresh and retry');
    await expect(store.apply(PRESETS[1].choice)).rejects.toContain('Refresh');
    expect(store.state).toBe(original);
    mocks.invoke.mockResolvedValueOnce({ ...original, revision: 'reset' });
    await store.reset(); expect(store.state.revision).toBe('reset');
  });
  it('does not overwrite malformed manifests or block startup fallback', async () => {
    const store = new BackgroundStore(); mocks.invoke.mockRejectedValueOnce('Repair library.json');
    await expect(store.refresh()).rejects.toBe('Repair library.json');
    expect(store.state.active.source.kind).toBe('desktop'); expect(store.loaded).toBe(false);
    await expect(store.reset()).rejects.toThrow('Repair library.json');
    expect(mocks.invoke).toHaveBeenCalledTimes(1);
  });
  it('imports file bytes asynchronously, treats MIME as a hint and rejects oversized files before IPC', async () => {
    const store = await loaded();
    mocks.invoke.mockResolvedValueOnce({ state: store.state, assetId: 'a'.repeat(64) });
    await store.import(new File(['source bytes'], 'spoof.svg', { type: 'image/svg+xml' }));
    expect(mocks.invoke).toHaveBeenLastCalledWith('background_import', { name: 'spoof.svg', dataBase64: btoa('source bytes'), expectedRevision: 'one' });
    await expect(store.import({ size: 10 * 1024 * 1024 + 1, name: 'large.png' } as File)).rejects.toThrow('10 MiB');
    expect(mocks.invoke).toHaveBeenCalledTimes(2);
    expect(store.state.active.source.kind).toBe('desktop');
  });
  it('publishes only to live subscribers and does not mutate runtime state on reads', async () => {
    const store = await loaded(); const cb = vi.fn(); const unsub = store.subscribe(cb); unsub();
    mocks.invoke.mockResolvedValueOnce(store.state); await store.refresh(); expect(cb).not.toHaveBeenCalled();
    expect(mocks.invoke.mock.calls.map((c: unknown[]) => c[0])).toEqual(['background_list', 'background_list']);
  });
});
