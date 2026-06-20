// Krypton — ACP harness telemetry publisher (spec 168).
// Builds the read-only browser dashboard snapshot from existing in-memory
// harness state and pushes it to the loopback artifact server.

import { invoke } from '@tauri-apps/api/core';

import { peersFor } from './harness-directory';
import type { LaneBus } from './lane-bus';
import type {
  HarnessLaneStatus,
  JudgementItem,
  LaneBusEvent,
  LaneSummary,
  LaneTriageStats,
  Reversibility,
  ReviewOutcome,
} from './types';

const TELEMETRY_SCHEMA_VERSION = 2;
const TELEMETRY_DEBOUNCE_MS = 300;
const RECENT_EVENT_CAP = 14;

export type LaneStatus = HarnessLaneStatus;
export type EventKind = 'status' | 'attention' | 'review' | 'priority' | 'peer' | 'lane';

export interface TelemetryLane {
  id: string;
  displayName: string;
  backendId: string;
  modelName: string | null;
  status: LaneStatus;
  turnActiveSince: number | null;
  observedTurns: number;
  inboxDepth: number;
  attnOpen: number;
  reviews: number;
  highPriority: number;
  // spec 169 — resource status (current sample; history is accumulated client-side).
  cpuPercent: number | null; // total_cpu_percent, summed over the process tree (can exceed 100)
  rssMb: number | null; // total_rss_mb
  procCount: number; // proc_count (0 when no live process)
  rootAlive: boolean; // false → dashboard renders "—" + flat baseline, never "0%"
}

export interface TelemetryEvent {
  at: number;
  laneName: string;
  kind: EventKind;
  detail?: string;
}

export interface TelemetrySnapshot {
  schemaVersion: number;
  version: number;
  harnessId: string;
  projectDir: string | null;
  generatedAt: number;
  attention: {
    openCount: number;
    maxReversibility: Reversibility | null;
  };
  reviewTotal: number;
  highPriorityTotal: number;
  lanes: TelemetryLane[];
  foreignPeers: TelemetryForeignPeer[];
  recentEvents: TelemetryEvent[];
}

export interface TelemetryForeignPeer {
  displayName: string;
  backendId: string;
  status: string;
  cwd: string | null;
}

export interface TelemetryHarnessLane {
  id: string;
  activeTurnStartedAt: number | null;
}

interface TelemetryTriageStore {
  openCount(): number;
  openItems(): JudgementItem[];
  statsFor(laneId: string): LaneTriageStats | null;
}

interface TelemetryReviewQualityStore {
  totalReviews(): number;
  historyFor(laneId: string): ReviewOutcome[];
}

interface TelemetryReviewPriorityStore {
  highCount(): number;
  highCountFor(laneId: string): number;
}

export interface HarnessTelemetryPublisherOptions {
  harnessId: string;
  projectDir: string | null;
  laneBus: LaneBus;
  coordinator: { listLanes(): LaneSummary[] };
  lanes: () => readonly TelemetryHarnessLane[];
  triageStore: TelemetryTriageStore;
  reviewQualityStore: TelemetryReviewQualityStore;
  reviewPriorityStore: TelemetryReviewPriorityStore;
  // spec 169 — current resource sample for a lane, or null when it has no live
  // client session yet. Maps lane.id → lane.client.sessionId → metricsBySession
  // inside AcpHarnessView (the publisher never sees the numeric-session dual key).
  metricsFor: (laneId: string) => LaneResourceSample | null;
}

export interface LaneResourceSample {
  cpuPercent: number;
  rssMb: number;
  procCount: number;
  rootAlive: boolean;
}

export class HarnessTelemetryPublisher {
  private version = 0;
  private timer: number | null = null;
  private disposed = false;
  private previousSnapshot: TelemetrySnapshot | null = null;
  private recentEvents: TelemetryEvent[] = [];
  private readonly unsubscribe: () => void;

  constructor(private readonly options: HarnessTelemetryPublisherOptions) {
    this.unsubscribe = options.laneBus.subscribe((event) => this.onLaneBusEvent(event));
    this.schedule();
  }

  schedule(): void {
    if (this.disposed) return;
    if (this.timer !== null) window.clearTimeout(this.timer);
    this.timer = window.setTimeout(() => {
      this.timer = null;
      void this.rebuildAndPublish();
    }, TELEMETRY_DEBOUNCE_MS);
  }

  dispose(): void {
    this.disposed = true;
    this.unsubscribe();
    if (this.timer !== null) {
      window.clearTimeout(this.timer);
      this.timer = null;
    }
  }

  private onLaneBusEvent(_event: LaneBusEvent): void {
    this.schedule();
  }

  private async rebuildAndPublish(): Promise<void> {
    if (this.disposed) return;
    const snapshot = this.buildSnapshot();
    if (this.disposed) return;
    try {
      await invoke('acp_publish_telemetry', {
        harnessId: this.options.harnessId,
        version: snapshot.version,
        snapshot,
      });
    } catch (e) {
      console.warn('[harness-telemetry] publish failed:', e);
    }
  }

  private buildSnapshot(): TelemetrySnapshot {
    const lanes = this.buildLanes();
    const previous = this.previousSnapshot;
    this.appendLaneDiffEvents(previous, lanes);
    const version = this.version + 1;
    this.version = version;
    const snapshot: TelemetrySnapshot = {
      schemaVersion: TELEMETRY_SCHEMA_VERSION,
      version,
      harnessId: this.options.harnessId,
      projectDir: this.options.projectDir,
      generatedAt: Date.now(),
      attention: {
        openCount: this.options.triageStore.openCount(),
        maxReversibility: this.options.triageStore.openItems()[0]?.reversibility ?? null,
      },
      reviewTotal: this.options.reviewQualityStore.totalReviews(),
      highPriorityTotal: this.options.reviewPriorityStore.highCount(),
      lanes,
      foreignPeers: peersFor(this.options.harnessId).map((peer) => ({
        displayName: peer.displayName,
        backendId: peer.backendId,
        status: peer.status,
        cwd: peer.cwd ?? null,
      })),
      recentEvents: [...this.recentEvents],
    };
    this.previousSnapshot = snapshot;
    return snapshot;
  }

  private buildLanes(): TelemetryLane[] {
    const activeById = new Map(this.options.lanes().map((lane) => [lane.id, lane.activeTurnStartedAt]));
    const openItems = this.options.triageStore.openItems();
    return this.options.coordinator.listLanes().map((lane) => {
      const stats = this.options.triageStore.statsFor(lane.laneId);
      const metrics = this.options.metricsFor(lane.laneId);
      return {
        id: lane.laneId,
        displayName: lane.displayName,
        backendId: lane.backendId,
        modelName: lane.modelName,
        status: lane.status,
        turnActiveSince: activeById.get(lane.laneId) ?? null,
        observedTurns: stats ? stats.flaggedCount + stats.silentTurnCount : 0,
        inboxDepth: lane.inboxDepth,
        attnOpen: openItems.filter((item) => item.laneId === lane.laneId).length,
        reviews: this.options.reviewQualityStore.historyFor(lane.laneId).length,
        highPriority: this.options.reviewPriorityStore.highCountFor(lane.laneId),
        cpuPercent: metrics ? metrics.cpuPercent : null,
        rssMb: metrics ? metrics.rssMb : null,
        procCount: metrics ? metrics.procCount : 0,
        rootAlive: metrics ? metrics.rootAlive : false,
      };
    });
  }

  private appendLaneDiffEvents(previous: TelemetrySnapshot | null, nextLanes: TelemetryLane[]): void {
    if (!previous) return;
    const previousById = new Map(previous.lanes.map((lane) => [lane.id, lane]));
    const nextById = new Map(nextLanes.map((lane) => [lane.id, lane]));
    const now = Date.now();

    for (const lane of nextLanes) {
      const prev = previousById.get(lane.id);
      if (!prev) {
        this.appendEvent({ at: now, laneName: lane.displayName, kind: 'lane', detail: 'spawned' });
        continue;
      }
      if (prev.status !== lane.status) {
        this.appendEvent({ at: now, laneName: lane.displayName, kind: 'status', detail: `${prev.status}->${lane.status}` });
      }
      if (prev.inboxDepth !== lane.inboxDepth) {
        this.appendEvent({ at: now, laneName: lane.displayName, kind: 'peer', detail: `${prev.inboxDepth}->${lane.inboxDepth}` });
      }
      if (prev.attnOpen !== lane.attnOpen) {
        this.appendEvent({ at: now, laneName: lane.displayName, kind: 'attention', detail: `${prev.attnOpen}->${lane.attnOpen}` });
      }
      if (prev.reviews !== lane.reviews) {
        this.appendEvent({ at: now, laneName: lane.displayName, kind: 'review', detail: `${prev.reviews}->${lane.reviews}` });
      }
      if (prev.highPriority !== lane.highPriority) {
        this.appendEvent({ at: now, laneName: lane.displayName, kind: 'priority', detail: `${prev.highPriority}->${lane.highPriority}` });
      }
    }

    for (const prev of previous.lanes) {
      if (!nextById.has(prev.id)) {
        this.appendEvent({ at: now, laneName: prev.displayName, kind: 'lane', detail: 'closed' });
      }
    }
  }

  private appendEvent(event: TelemetryEvent): void {
    this.recentEvents.push(event);
    if (this.recentEvents.length > RECENT_EVENT_CAP) {
      this.recentEvents = this.recentEvents.slice(-RECENT_EVENT_CAP);
    }
  }
}
