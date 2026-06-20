import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const invokeMock = vi.hoisted(() =>
  vi.fn((_command: string, _args?: Record<string, unknown>): Promise<null> => Promise.resolve(null)),
);

vi.mock('@tauri-apps/api/core', () => ({
  invoke: invokeMock,
}));

import {
  HarnessTelemetryPublisher,
  type LaneResourceSample,
  type TelemetryEvent,
  type TelemetrySnapshot,
} from './harness-telemetry';
import { LaneBus } from './lane-bus';
import type { HarnessLaneStatus, JudgementItem, LaneSummary, LaneTriageStats, ReviewOutcome } from './types';

interface TestHarness {
  bus: LaneBus;
  lanes: Array<{ id: string; activeTurnStartedAt: number | null }>;
  summaries: LaneSummary[];
  openItems: JudgementItem[];
  stats: Map<string, LaneTriageStats>;
  reviews: Map<string, ReviewOutcome[]>;
  priorities: Map<string, number>;
  metrics: Map<string, LaneResourceSample>;
}

function laneSummary(
  laneId: string,
  displayName: string,
  status: HarnessLaneStatus,
  overrides: Partial<LaneSummary> = {},
): LaneSummary {
  return {
    laneId,
    displayName,
    backendId: 'claude',
    status,
    modelName: 'opus',
    inboxDepth: 0,
    activeDirective: null,
    ...overrides,
  };
}

function judgement(laneId: string, reversibility: JudgementItem['reversibility'] = 'reversible'): JudgementItem {
  return {
    id: `j-${laneId}`,
    laneId,
    packetId: null,
    diffstat: [],
    createdAt: 1,
    status: 'open',
    question: 'q',
    chosen: 'c',
    rationale: 'r',
    tradedOff: ['x'],
    uncertainty: 'u',
    reversibility,
  };
}

function review(laneId: string): ReviewOutcome {
  return {
    authoringLaneId: laneId,
    authoringLaneName: laneId,
    subjectLabel: 'diff',
    reviewerCount: 2,
    blockers: 0,
    warnings: 1,
    at: 1,
  };
}

function makeHarness(): TestHarness {
  return {
    bus: new LaneBus(),
    lanes: [{ id: 'lane-1', activeTurnStartedAt: null }],
    summaries: [laneSummary('lane-1', 'Claude-1', 'idle')],
    openItems: [],
    stats: new Map(),
    reviews: new Map(),
    priorities: new Map(),
    metrics: new Map(),
  };
}

function makePublisher(harness: TestHarness): HarnessTelemetryPublisher {
  return new HarnessTelemetryPublisher({
    harnessId: 'hm-test',
    projectDir: '/repo',
    laneBus: harness.bus,
    coordinator: { listLanes: () => harness.summaries },
    lanes: () => harness.lanes,
    triageStore: {
      openCount: () => harness.openItems.length,
      openItems: () => harness.openItems,
      statsFor: (laneId) => harness.stats.get(laneId) ?? null,
    },
    reviewQualityStore: {
      totalReviews: () => [...harness.reviews.values()].reduce((sum, rows) => sum + rows.length, 0),
      historyFor: (laneId) => harness.reviews.get(laneId) ?? [],
    },
    reviewPriorityStore: {
      highCount: () => [...harness.priorities.values()].reduce((sum, count) => sum + count, 0),
      highCountFor: (laneId) => harness.priorities.get(laneId) ?? 0,
    },
    metricsFor: (laneId) => harness.metrics.get(laneId) ?? null,
  });
}

async function flushPublish(): Promise<void> {
  await vi.advanceTimersByTimeAsync(300);
}

function snapshots(): TelemetrySnapshot[] {
  return invokeMock.mock.calls.map((call) => call[1]?.snapshot as TelemetrySnapshot);
}

function lastSnapshot(): TelemetrySnapshot {
  const all = snapshots();
  const last = all[all.length - 1];
  if (!last) throw new Error('expected at least one snapshot');
  return last;
}

describe('HarnessTelemetryPublisher', () => {
  beforeEach(() => {
    invokeMock.mockClear();
    vi.useFakeTimers();
    vi.stubGlobal('window', {
      setTimeout: globalThis.setTimeout,
      clearTimeout: globalThis.clearTimeout,
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it('publishes an initial snapshot without diff events', async () => {
    const harness = makeHarness();
    makePublisher(harness);
    await flushPublish();

    const [snapshot] = snapshots();
    expect(snapshot.version).toBe(1);
    expect(snapshot.recentEvents).toEqual([]);
  });

  it('maps lane diffs to the expected EventKind values', async () => {
    const harness = makeHarness();
    makePublisher(harness);
    await flushPublish();

    harness.summaries[0] = laneSummary('lane-1', 'Claude-1', 'busy', { inboxDepth: 2 });
    harness.openItems = [judgement('lane-1')];
    harness.reviews.set('lane-1', [review('lane-1')]);
    harness.priorities.set('lane-1', 3);
    harness.summaries.push(laneSummary('lane-2', 'Codex-1', 'idle'));
    harness.lanes.push({ id: 'lane-2', activeTurnStartedAt: null });
    harness.bus.emit({ type: 'lane:status', payload: { laneId: 'lane-1', prev: 'idle', next: 'busy', at: 2 } });
    await flushPublish();

    harness.summaries = [laneSummary('lane-2', 'Codex-1', 'idle')];
    harness.lanes = [{ id: 'lane-2', activeTurnStartedAt: null }];
    harness.bus.emit({ type: 'lane:closed', payload: { laneId: 'lane-1', displayName: 'Claude-1' } });
    await flushPublish();

    const kinds = lastSnapshot().recentEvents.map((event: TelemetryEvent) => event.kind);
    expect(kinds).toEqual(expect.arrayContaining(['status', 'peer', 'attention', 'review', 'priority', 'lane']));
    expect(lastSnapshot().recentEvents.some((event: TelemetryEvent) => event.kind === 'lane' && event.detail === 'closed')).toBe(true);
  });

  it('folds the per-lane resource sample into the snapshot, null when absent', async () => {
    const harness = makeHarness();
    harness.metrics.set('lane-1', { cpuPercent: 142.5, rssMb: 612, procCount: 4, rootAlive: true });
    makePublisher(harness);
    await flushPublish();

    const lane = lastSnapshot().lanes[0];
    expect(lane.cpuPercent).toBe(142.5);
    expect(lane.rssMb).toBe(612);
    expect(lane.procCount).toBe(4);
    expect(lane.rootAlive).toBe(true);

    harness.metrics.delete('lane-1');
    harness.bus.emit({ type: 'lane:status', payload: { laneId: 'lane-1', prev: 'idle', next: 'busy', at: 9 } });
    await flushPublish();

    const after = lastSnapshot().lanes[0];
    expect(after.cpuPercent).toBeNull();
    expect(after.rssMb).toBeNull();
    expect(after.procCount).toBe(0);
    expect(after.rootAlive).toBe(false);
  });

  it('trims the event ring to fourteen rows', async () => {
    const harness = makeHarness();
    makePublisher(harness);
    await flushPublish();

    for (let i = 0; i < 16; i++) {
      const next: HarnessLaneStatus = i % 2 === 0 ? 'busy' : 'idle';
      const prev: HarnessLaneStatus = next === 'busy' ? 'idle' : 'busy';
      harness.summaries[0] = laneSummary('lane-1', 'Claude-1', next);
      harness.bus.emit({ type: 'lane:status', payload: { laneId: 'lane-1', prev, next, at: i } });
      await flushPublish();
    }

    const last = lastSnapshot();
    expect(last.recentEvents).toHaveLength(14);
    expect(last.recentEvents[0].detail).toBe('idle->busy');
  });

  it('increments version strictly across publishes', async () => {
    const harness = makeHarness();
    makePublisher(harness);
    await flushPublish();
    harness.summaries[0] = laneSummary('lane-1', 'Claude-1', 'busy');
    harness.bus.emit({ type: 'lane:status', payload: { laneId: 'lane-1', prev: 'idle', next: 'busy', at: 1 } });
    await flushPublish();

    expect(snapshots().map((snapshot) => snapshot.version)).toEqual([1, 2]);
  });

  it('defaults missing per-lane counters to zero', async () => {
    const harness = makeHarness();
    makePublisher(harness);
    await flushPublish();

    const lane = snapshots()[0].lanes[0];
    expect(lane.observedTurns).toBe(0);
    expect(lane.reviews).toBe(0);
    expect(lane.highPriority).toBe(0);
  });

  it('skips invoke when disposed after snapshot construction', async () => {
    const harness = makeHarness();
    let publisher: HarnessTelemetryPublisher | null = null;
    publisher = new HarnessTelemetryPublisher({
      harnessId: 'hm-test',
      projectDir: '/repo',
      laneBus: harness.bus,
      coordinator: { listLanes: () => harness.summaries },
      lanes: () => {
        publisher?.dispose();
        return harness.lanes;
      },
      triageStore: {
        openCount: () => 0,
        openItems: () => [],
        statsFor: () => null,
      },
      reviewQualityStore: {
        totalReviews: () => 0,
        historyFor: () => [],
      },
      reviewPriorityStore: {
        highCount: () => 0,
        highCountFor: () => 0,
      },
      metricsFor: () => null,
    });

    await flushPublish();
    expect(invokeMock).not.toHaveBeenCalled();
  });
});
