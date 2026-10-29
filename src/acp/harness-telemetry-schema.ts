// Krypton — harness telemetry snapshot schema (specs 168, 169, 277).
// The wire shape the harness publishes to `/telemetry` and the loopback lane
// monitor (`src/loopback/surfaces/dashboard`) reads. Tauri-free on purpose: the
// browser bundle imports it, so it must never pull in `@tauri-apps/*`.

import type { ReviewLoopStop, ReviewerVerdict } from './review-loop';
import type { HarnessLaneStatus, Reversibility } from './types';

/** Bump on any breaking snapshot change; the dashboard drops other versions. */
export const TELEMETRY_SCHEMA_VERSION = 4;

export type LaneStatus = HarnessLaneStatus;
export type EventKind = 'status' | 'attention' | 'review' | 'priority' | 'peer' | 'lane' | 'loop';

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
  // spec 277 — the lane's `#review pass` loop (running, or the last one ended); authoring lane only.
  reviewLoop: TelemetryReviewLoop | null;
}

export interface TelemetryReviewLoopReviewer {
  name: string;
  /** This round: not asked yet (subject still collecting), waiting, or answered. */
  state: 'not_sent' | 'pending' | 'replied';
  verdict: ReviewerVerdict | null;
  blockers: number;
  repliedAt: number | null;
}

export interface TelemetryReviewLoopRound {
  round: number;
  verdict: 'pass' | 'fail' | 'partial';
  blockers: number;
  warnings: number;
}

export interface TelemetryReviewLoop {
  running: boolean;
  /** null once the loop ended. */
  phase: 'collecting' | 'reviewing' | 'fixing' | 'summarizing' | null;
  round: number;
  maxRounds: number;
  /** Diffstat headline or doc path; '' until round 1 has collected its subject. */
  subjectLabel: string;
  startedAt: number;
  phaseSince: number;
  /** The current round's reviewers (the final round's once ended). */
  reviewers: TelemetryReviewLoopReviewer[];
  /** Completed rounds, oldest first. */
  rounds: TelemetryReviewLoopRound[];
  stopReason: ReviewLoopStop | null;
  stopLabel: string | null;
  endedAt: number | null;
}

export interface TelemetryEvent {
  at: number;
  laneName: string;
  kind: EventKind;
  detail?: string;
}

export interface TelemetryAttentionItem {
  id: string;
  laneId: string;
  laneName: string;
  createdAt: number;
  question: string;
  chosen: string;
  rationale: string;
  tradedOff: string[];
  uncertainty: string;
  reversibility: Reversibility;
}

export interface TelemetryAttention {
  openCount: number;
  maxReversibility: Reversibility | null;
  items: TelemetryAttentionItem[];
}

export interface TelemetryForeignPeer {
  displayName: string;
  backendId: string;
  status: string;
  cwd: string | null;
}

export interface TelemetrySnapshot {
  schemaVersion: number;
  version: number;
  harnessId: string;
  projectDir: string | null;
  generatedAt: number;
  attention: TelemetryAttention;
  reviewTotal: number;
  highPriorityTotal: number;
  lanes: TelemetryLane[];
  foreignPeers: TelemetryForeignPeer[];
  recentEvents: TelemetryEvent[];
}
