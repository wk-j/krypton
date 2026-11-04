// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AssistantInstanceStore, type AssistantInventoryState } from './assistant-instance-store';
import type { AcpInstanceSnapshot } from './acp/types';
import type { AcpLaneMetrics } from './types';

interface Deferred<T> {
  promise: Promise<T>;
  resolve(value: T): void;
  reject(error: Error): void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

function snapshot(session: number, overrides: Partial<AcpInstanceSnapshot> = {}): AcpInstanceSnapshot {
  return {
    session, backend_id: 'claude',
    owner: { role: 'harness_lane', label: `Lane ${session}`, harness_id: `h-${session}`, lane_id: `l-${session}` },
    cwd: `/project-${session}`, acp_session_id: `conversation-${session}`,
    execution: { kind: 'local', runtime_id: null, host: null },
    pid: 100 + session, lifecycle: 'ready', activity: 'idle', liveness: 'alive', has_error: false,
    requested_model_id: 'alias', confirmed_model_id: null, model_uncertain: true,
    started_at_ms: 5, last_activity_at_ms: 10, ...overrides,
  };
}

function sample(session: number, overrides: Partial<AcpLaneMetrics> = {}): AcpLaneMetrics {
  return {
    session, root_pid: 100 + session, root_alive: true,
    cpu_ready: false,
    total_cpu_percent: 0, total_rss_mb: 48, proc_count: 12,
    processes: [{ pid: 100 + session, parent_pid: null, name: 'adapter', cmd: ['adapter', '--secret=private'], exe: '/adapter', cpu_percent: 0, rss_mb: 48 }],
    ...overrides,
  };
}

const subscriptions: Array<() => void> = [];

function observe(store: AssistantInstanceStore) {
  const states: AssistantInventoryState[] = [];
  subscriptions.push(store.subscribeInventory((state) => states.push(state)));
  return { states, latest: () => states[states.length - 1] };
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(1000);
});

afterEach(() => {
  for (const unsubscribe of subscriptions.splice(0)) unsubscribe();
  vi.useRealTimers();
});

describe('AssistantInstanceStore inventory boundaries', () => {
  it('starts nothing and polls nothing without consumers', async () => {
    const listInstances = vi.fn(async () => []);
    const getMetrics = vi.fn(async () => []);
    new AssistantInstanceStore({ listInstances, getMetrics });
    await vi.advanceTimersByTimeAsync(6000);
    expect(listInstances).not.toHaveBeenCalled();
    expect(getMetrics).not.toHaveBeenCalled();
  });

  it('merges every transport epoch across projects, helpers, probes and embedded owners without counting descendants', async () => {
    let snapshots = [
      snapshot(1),
      snapshot(2, { owner: { role: 'assist', label: 'Assist', harness_id: 'other', lane_id: null } }),
      snapshot(3, { owner: { role: 'rails_judge', label: 'Rails', harness_id: 'other', lane_id: null } }),
      snapshot(4, { owner: { role: 'session_probe', label: 'Browse', harness_id: 'other', lane_id: null }, lifecycle: 'initializing' }),
      snapshot(5, { owner: { role: 'inline_ai', label: 'Inline AI', harness_id: null, lane_id: null } }),
      snapshot(6, { execution: { kind: 'remote', runtime_id: 'ssh-1', host: 'example' }, pid: null, liveness: 'unknown', lifecycle: 'disconnected' }),
      snapshot(7, { liveness: 'exited', has_error: true }),
    ];
    const store = new AssistantInstanceStore({ listInstances: async () => snapshots, getMetrics: async () => [sample(1)] });
    const embedded = store.registerEmbedded({ role: 'agent_view', label: 'Agent', cwd: '/embedded', model_id: 'provider/model' });
    const view = observe(store);
    await vi.advanceTimersByTimeAsync(0);
    const first = view.latest();
    expect(first.instances).toHaveLength(8);
    expect(first.instances.filter((instance) => instance.kind === 'acp')).toHaveLength(7);
    expect(first.instances.find((instance) => instance.id === 'acp:6')).toMatchObject({ liveness: 'unknown', metrics: null, cpu_ready: false });
    expect(first.instances.find((instance) => instance.id === 'acp:7')).toMatchObject({ liveness: 'exited', has_error: true });
    expect(first.instances.find((instance) => instance.id === embedded.id)).toMatchObject({ kind: 'embedded', pid: null, metrics: null });
    expect(first.instances[0].metrics?.proc_count).toBe(12);
    expect(first.instances[0].metrics?.processes).toEqual([]);
    expect(JSON.stringify(first)).not.toContain('--secret');
    expect(first.instances[0]).toMatchObject({ requested_model_id: 'alias', confirmed_model_id: null, model_uncertain: true });

    snapshots = snapshots.map((row) => row.session === 4
      ? { ...row, acp_session_id: 'new-conversation', owner: { role: 'harness_lane', label: 'Promoted', harness_id: 'other', lane_id: 'new-lane' } }
      : row);
    await vi.advanceTimersByTimeAsync(2000);
    expect(view.latest().instances).toHaveLength(8);
    expect(view.latest().instances.find((instance) => instance.id === 'acp:4')).toMatchObject({ owner: { role: 'harness_lane', label: 'Promoted' }, acp_session_id: 'new-conversation' });
  });

  it('leaves unsampled, remote, exited and mismatched PID rows unavailable and warms the first local CPU delta', async () => {
    const snapshots = [
      snapshot(1), snapshot(2), snapshot(3, { execution: { kind: 'remote', runtime_id: 'r', host: 'host' }, pid: null }),
      snapshot(4), snapshot(5, { liveness: 'exited' }), snapshot(6),
    ];
    let metrics = [sample(1), sample(3), sample(4, { root_pid: 999 }), sample(5), sample(6, { root_alive: false })];
    const store = new AssistantInstanceStore({ listInstances: async () => snapshots, getMetrics: async () => metrics });
    const view = observe(store);
    await vi.advanceTimersByTimeAsync(0);
    expect(view.latest().instances[0]).toMatchObject({ cpu_ready: false, metrics: { total_rss_mb: 48 } });
    expect(view.latest().instances.slice(1).every((row) => row.metrics === null && !row.cpu_ready)).toBe(true);
    await vi.advanceTimersByTimeAsync(2000);
    expect(view.latest().instances[0].cpu_ready).toBe(false);
    metrics = [sample(1, { cpu_ready: true })];
    await vi.advanceTimersByTimeAsync(2000);
    expect(view.latest().instances[0]).toMatchObject({ cpu_ready: true, metrics: { total_cpu_percent: 0 } });
    metrics = [];
    await vi.advanceTimersByTimeAsync(2000);
    expect(view.latest().instances[0].metrics).toBeNull();
    metrics = [sample(1)];
    await vi.advanceTimersByTimeAsync(2000);
    expect(view.latest().instances[0].cpu_ready).toBe(false);
  });

  it('keeps embedded registration alive while hidden and never reuses or resurrects a retired identity', async () => {
    const store = new AssistantInstanceStore({ listInstances: async () => [], getMetrics: async () => [] });
    const old = store.registerEmbedded({ role: 'file_manager_ai', label: 'Files', cwd: '/old', model_id: 'a/one' });
    old.update({ activity: 'running', cwd: '/new', model_id: 'b/two', has_error: true });
    const view = observe(store);
    await vi.advanceTimersByTimeAsync(0);
    expect(view.latest().instances).toMatchObject([{ id: old.id, cwd: '/new', activity: 'running', has_error: true, confirmed_model_id: 'b/two', pid: null, metrics: null, execution: { kind: 'embedded' } }]);
    old.retire();
    old.update({ activity: 'running' });
    const replacement = store.registerEmbedded({ role: 'markdown_ai', label: 'Markdown', cwd: null, model_id: null });
    expect(replacement.id).not.toBe(old.id);
    expect(view.latest().instances).toHaveLength(1);
    expect(view.latest().instances[0].id).toBe(replacement.id);
  });
});

describe('AssistantInstanceStore shared polling', () => {
  it('shares immediate loading and one 2s cycle across two monitors and Harness consumers, and stops metadata without monitors', async () => {
    const listInstances = vi.fn(async () => [snapshot(1)]);
    const getMetrics = vi.fn(async () => [sample(1)]);
    const store = new AssistantInstanceStore({ listInstances, getMetrics });
    const first = observe(store);
    const second = observe(store);
    const harnessA = vi.fn();
    const harnessB = vi.fn();
    const stopA = store.subscribeMetrics(harnessA);
    const stopB = store.subscribeMetrics(harnessB);
    subscriptions.push(stopA, stopB);
    expect(first.latest().loading).toBe(true);
    expect(second.latest().loading).toBe(true);
    await vi.advanceTimersByTimeAsync(0);
    expect(listInstances).toHaveBeenCalledTimes(1);
    expect(getMetrics).toHaveBeenCalledTimes(1);
    expect(first.latest().loading).toBe(false);
    expect(harnessA).toHaveBeenCalledTimes(1);
    expect(harnessB).toHaveBeenCalledTimes(1);
    expect(harnessA.mock.calls[0][0][0].processes[0].cmd).toContain('--secret=private');
    await vi.advanceTimersByTimeAsync(2000);
    expect(getMetrics).toHaveBeenCalledTimes(2);
    subscriptions[0]();
    subscriptions[1]();
    await vi.advanceTimersByTimeAsync(2000);
    expect(listInstances).toHaveBeenCalledTimes(2);
    expect(getMetrics).toHaveBeenCalledTimes(3);
    stopA();
    stopB();
    expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(6000);
    expect(getMetrics).toHaveBeenCalledTimes(3);
  });

  it('does not overlap cycles, rejects a stopped generation, and immediately reloads a resubscription after settlement', async () => {
    const oldInventory = deferred<AcpInstanceSnapshot[]>();
    const oldMetrics = deferred<AcpLaneMetrics[]>();
    const listInstances = vi.fn().mockReturnValueOnce(oldInventory.promise).mockResolvedValue([snapshot(2)]);
    const getMetrics = vi.fn().mockReturnValueOnce(oldMetrics.promise).mockResolvedValue([sample(2)]);
    const store = new AssistantInstanceStore({ listInstances, getMetrics });
    const old = observe(store);
    await vi.advanceTimersByTimeAsync(10000);
    expect(listInstances).toHaveBeenCalledTimes(1);
    expect(getMetrics).toHaveBeenCalledTimes(1);
    subscriptions[0]();
    const current = observe(store);
    oldInventory.resolve([snapshot(1)]);
    await vi.advanceTimersByTimeAsync(0);
    expect(listInstances).toHaveBeenCalledTimes(1);
    oldMetrics.resolve([sample(1)]);
    await vi.advanceTimersByTimeAsync(0);
    expect(listInstances).toHaveBeenCalledTimes(2);
    expect(old.states).toHaveLength(1);
    expect(current.states.every((state) => !state.instances.some((instance) => instance.id === 'acp:1'))).toBe(true);
    expect(current.latest()).toMatchObject({ loading: false, instances: [{ id: 'acp:2', cpu_ready: false }] });
  });

  it('does not publish an old metadata response after inventory listeners leave while Harness demand stays', async () => {
    const inventory = deferred<AcpInstanceSnapshot[]>();
    const listInstances = vi.fn().mockReturnValueOnce(inventory.promise).mockResolvedValue([snapshot(2)]);
    const store = new AssistantInstanceStore({ listInstances, getMetrics: async () => [] });
    observe(store);
    subscriptions.push(store.subscribeMetrics(() => {}));
    subscriptions[0]();
    const current = observe(store);
    inventory.resolve([snapshot(1)]);
    await vi.advanceTimersByTimeAsync(0);
    expect(current.states.every((state) => !state.instances.some((row) => row.id === 'acp:1'))).toBe(true);
    expect(current.latest().instances[0].id).toBe('acp:2');
  });

  it('retains good inventory, resource values and freshness on failure, then reloads before claiming a reopened view fresh', async () => {
    const listInstances = vi.fn().mockResolvedValueOnce([snapshot(1)]).mockRejectedValueOnce(new Error('inventory offline'));
    const getMetrics = vi.fn().mockResolvedValueOnce([sample(1)]).mockRejectedValueOnce(new Error('metrics offline'));
    const store = new AssistantInstanceStore({ listInstances, getMetrics });
    const first = observe(store);
    await vi.advanceTimersByTimeAsync(0);
    const good = first.latest();
    await vi.advanceTimersByTimeAsync(2000);
    expect(first.latest()).toMatchObject({ instances: good.instances, refreshed_at_ms: good.refreshed_at_ms, sampled_at_ms: good.sampled_at_ms, loading: false, error: 'Error: inventory offline' });
    subscriptions[0]();
    const nextInventory = deferred<AcpInstanceSnapshot[]>();
    listInstances.mockReturnValueOnce(nextInventory.promise);
    getMetrics.mockResolvedValueOnce([sample(1)]);
    const reopened = observe(store);
    expect(reopened.latest()).toMatchObject({ loading: true, refreshed_at_ms: good.refreshed_at_ms });
    nextInventory.resolve([snapshot(1)]);
    await vi.advanceTimersByTimeAsync(0);
    expect(reopened.latest()).toMatchObject({ loading: false, error: null, refreshed_at_ms: 3000, instances: [{ cpu_ready: false }] });
  });
});
