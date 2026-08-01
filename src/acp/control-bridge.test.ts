// spec 178 — github.dispatch-issue routing across multiple open harnesses.
// The extension popup has no harness picker, so a dispatch carries its target as
// `targetLane` (a globally-unique lane displayName) or the `__new__` sentinel,
// never `lane`/`harnessId`. route() must resolve the owning harness from the
// displayName; this is the dispatch analogue of #8's `lane.list requires
// harnessId`.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn(() => Promise.resolve(null)) }));
vi.mock('@tauri-apps/api/event', () => ({ listen: vi.fn(() => Promise.resolve(() => {})) }));

import { route } from './control-bridge';
import {
  __resetHarnessDirectoryForTests,
  registerHarness,
  type HarnessEntry,
} from './harness-directory';
import type { LaneSummary } from './types';
import type { ControlCaller } from './control-types';

interface ControlCall {
  operation: string;
  params: Record<string, unknown>;
  caller?: ControlCaller;
}

/** A minimal harness entry that records the control ops routed to it and owns a
 *  fixed set of lane displayNames. */
function makeHarness(harnessId: string, displayNames: string[], focused = false): {
  entry: HarnessEntry;
  calls: ControlCall[];
} {
  const calls: ControlCall[] = [];
  const lanes: LaneSummary[] = displayNames.map((displayName, i) => ({
    laneId: `${harnessId}-lane-${i}`,
    status: 'idle',
    displayName,
    backendId: 'test',
    modelName: null,
    inboxDepth: 0,
    activeDirective: null,
  }));
  const entry: HarnessEntry = {
    harnessId,
    cwd: null,
    alive: true,
    isFocused: () => focused,
    listLanes: () => lanes,
    resolveLocalDisplayName: (name) => {
      const hit = lanes.find((l) => l.displayName === name);
      return hit ? { laneId: hit.laneId, displayName: hit.displayName } : null;
    },
    acceptInbound: () => ({
      result: { delivered: false, reason: 'harness_closed' },
      senderIsReplier: false,
      effectiveDone: false,
    }),
    acceptForeignCancellation: () => {},
    clearCancellationTombstone: () => {},
    onForeignHarnessClosed: () => {},
    control: (operation, params, caller) => {
      calls.push({ operation, params, caller });
      if (operation === 'lane.list') {
        return Promise.resolve(lanes.map((lane, index) => ({
          harnessId,
          cwd: null,
          ...lane,
          active: index === 0,
          queueDepth: 0,
          pendingPermissions: 0,
          permissionMode: 'normal',
        })));
      }
      return Promise.resolve({ harnessId, lane: (params.targetLane as string) ?? null });
    },
  };
  return { entry, calls };
}

const dispatchParams = (targetLane: string) => ({
  issueKey: 'o/r#1',
  issueUrl: 'https://github.com/o/r/issues/1',
  repo: 'o/r',
  number: 1,
  targetLane,
});

describe('control-bridge route: github.dispatch-issue', () => {
  beforeEach(() => __resetHarnessDirectoryForTests());
  afterEach(() => __resetHarnessDirectoryForTests());

  it('routes to the harness that owns targetLane when several are open', async () => {
    const a = makeHarness('hm-a', ['Claude-1']);
    const b = makeHarness('hm-b', ['Pi-7']);
    registerHarness(a.entry);
    registerHarness(b.entry);

    const res = await route('github.dispatch-issue', dispatchParams('Pi-7'));

    expect(b.calls).toHaveLength(1);
    expect(b.calls[0].operation).toBe('github.dispatch-issue');
    expect(a.calls).toHaveLength(0);
    expect(res).toMatchObject({ harnessId: 'hm-b' });
  });

  it('rejects an unknown targetLane', async () => {
    registerHarness(makeHarness('hm-a', ['Claude-1']).entry);
    registerHarness(makeHarness('hm-b', ['Pi-7']).entry);

    await expect(route('github.dispatch-issue', dispatchParams('Ghost-9'))).rejects.toMatchObject({
      code: 'unknown_lane',
    });
  });

  it('errors as ambiguous on __new__ with multiple harnesses (no picker)', async () => {
    registerHarness(makeHarness('hm-a', ['Claude-1']).entry);
    registerHarness(makeHarness('hm-b', ['Pi-7']).entry);

    await expect(route('github.dispatch-issue', dispatchParams('__new__'))).rejects.toMatchObject({
      code: 'ambiguous_harness',
    });
  });

  it('routes __new__ to the sole harness when only one is open', async () => {
    const a = makeHarness('hm-a', ['Claude-1']);
    registerHarness(a.entry);

    await route('github.dispatch-issue', dispatchParams('__new__'));

    expect(a.calls).toHaveLength(1);
    expect(a.calls[0].operation).toBe('github.dispatch-issue');
  });

  it('forwards trusted Telegram caller metadata without putting it in params', async () => {
    const a = makeHarness('hm-a', ['Claude-1']);
    registerHarness(a.entry);
    const caller: ControlCaller = {
      source: 'telegram',
      telegram: {
        updateId: '901',
        userId: '42',
        displayName: 'Niran',
        chatId: '42',
        chatKind: 'private',
      },
    };

    await route('lane.list', {}, caller);

    expect(a.calls[0].caller).toEqual(caller);
    expect(a.calls[0].params).toEqual({});
  });
});

describe('control-bridge route: live_assist.bootstrap', () => {
  beforeEach(() => __resetHarnessDirectoryForTests());
  afterEach(() => __resetHarnessDirectoryForTests());

  const caller: ControlCaller = { source: 'live_assist' };

  it('keeps the prior assistant lane when it is still live', async () => {
    registerHarness(makeHarness('hm-a', ['Claude-1'], true).entry);
    registerHarness(makeHarness('hm-b', ['Codex-2']).entry);

    const result = await route('live_assist.bootstrap', { lastLane: 'Codex-2' }, caller);

    expect(result).toMatchObject({ suggestedLane: 'Codex-2' });
  });

  it('falls back to the active lane of the focused harness', async () => {
    registerHarness(makeHarness('hm-a', ['Claude-1']).entry);
    registerHarness(makeHarness('hm-b', ['Codex-2'], true).entry);

    const result = await route('live_assist.bootstrap', {}, caller);

    expect(result).toMatchObject({ suggestedLane: 'Codex-2' });
  });

  it('returns an empty state without creating a Harness', async () => {
    await expect(route('live_assist.bootstrap', {}, caller)).resolves.toEqual({
      lanes: [],
      suggestedLane: null,
    });
  });

  it('rejects public control callers', async () => {
    await expect(route('live_assist.bootstrap', {}, { source: 'control_api' })).rejects.toMatchObject({
      code: 'unsupported_operation',
    });
  });
});
