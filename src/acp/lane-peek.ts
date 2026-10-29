// Krypton — ACP Harness View: lane peek derivation.
//
// Extracted verbatim from acp-harness-view.ts (spec 204). Two layers of the
// spec 109/118 peek rail: deriving lane-pair activity heat, and ranking which
// lane is worth peeking at (buildLanePeekCandidates / selectLanePeekCandidate).
// Spec 301 phase 5 moved the painting into the `peek-card`, `thought-card`,
// `heat-panel`, `review-loop-rows`, `rail-entry` and `peer-strip` components;
// what stays is the state they read and the thought-body teletype sync.

import type { HarnessLaneStatus } from './types';
import type { PendingPeerSummary } from './inter-lane';
import type { TelemetryReviewLoop } from './harness-telemetry-schema';
import { FILE_TOUCH_WINDOW_MS } from './harness-view-types';
import type {
  FileTouchRecord,
  HarnessTranscriptItem,
  LanePeekState,
  HarnessLane,
  LaneActivitySample,
  LaneHeatSide,
  LanePairHeatSummary,
  LanePeekCandidate,
  LanePeekHeatLaneInput,
  LanePeekHeatMetric,
  LanePeekHeatWindow,
  LanePeekSnapshot,
} from './harness-view-types';
import {
  basename,
  collapseThoughtBlankLines,
  formatCoarseAge,
} from './harness-format';
import { formatAwaitingPeerAge, statusLabel } from './harness-lane-chrome';
import { installThoughtVeil, renderPeekThoughtMarkdown } from './harness-markdown';
import { cleanToolTitle, extractCommandLineRaw, inferToolLabel } from './harness-tool-render';
import {
  applyThoughtTeletype,
  clearThoughtTeletype,
  sealThoughtTeletype,
} from './harness-thought-teletype';

/** spec 118 — peer peek tiers: awaiting 10, inbound 20, counterpart 30 */
export const PEER_PREEMPT_MAX_PRIORITY = 30;
const LANE_PEEK_RECENT_MS = 5 * 60_000;
const LANE_PEEK_HEAT_TAIL = 200;
const LANE_PEEK_HEAT_SESSION_TAIL = 400;
const LANE_PEEK_HEAT_PENDING_PEER_WEIGHT = 2;
const LANE_PEEK_DWELL_MS = 8_000;
/** spec 277 — an ended `#review pass` loop stays on the peek this long; the
 *  dashboard keeps it until the next loop. */
const LANE_PEEK_LOOP_ENDED_MS = LANE_PEEK_RECENT_MS;
/** spec 277 — between `lane-shell` (65) and `lane-inbox` (70). */
const LANE_PEEK_REVIEW_LOOP_PRIORITY = 68;

export function isDirectPeerPeekReasonKey(reasonKey: string): boolean {
  return reasonKey === 'awaiting-peer' || reasonKey === 'inbound-peer' || reasonKey === 'peer-counterpart';
}

export function heatWindowCutoffMs(window: LanePeekHeatWindow, now: number): number {
  if (window === '30s') return now - 30_000;
  if (window === '5m') return now - 5 * 60_000;
  return 0;
}

export function scanTranscriptHeat(
  transcript: HarnessTranscriptItem[],
  window: LanePeekHeatWindow,
  now: number,
): { tools: number; peerRows: number; permissions: number; errors: number } {
  const cutoff = heatWindowCutoffMs(window, now);
  const timed = window !== 'session';
  const maxItems = window === 'session' ? LANE_PEEK_HEAT_SESSION_TAIL : LANE_PEEK_HEAT_TAIL;
  let tools = 0;
  let peerRows = 0;
  let permissions = 0;
  let errors = 0;
  let scanned = 0;
  for (let i = transcript.length - 1; i >= 0 && scanned < maxItems; i--) {
    const item = transcript[i];
    const t = item.createdAt ?? now;
    if (timed && t < cutoff) break;
    scanned++;
    if (item.kind === 'tool') tools++;
    else if (item.kind === 'inter_lane') peerRows++;
    else if (item.kind === 'permission') permissions++;
    else if (item.kind === 'provider_error') errors++;
  }
  return { tools, peerRows, permissions, errors };
}

export function tokenDeltaFromHistory(history: LaneActivitySample[], window: LanePeekHeatWindow, now: number): number | null {
  if (history.length === 0) return null;
  const last = history[history.length - 1];
  if (last.usageUsed === null || !Number.isFinite(last.usageUsed)) return null;
  const cutoff = heatWindowCutoffMs(window, now);
  let oldest: LaneActivitySample | null = null;
  for (let i = history.length - 1; i >= 0; i--) {
    const s = history[i];
    if (window !== 'session' && s.at < cutoff) break;
    oldest = s;
  }
  if (!oldest || oldest.usageUsed === null || !Number.isFinite(oldest.usageUsed)) return null;
  const d = last.usageUsed - oldest.usageUsed;
  return d > 0 ? d : null;
}

export function cpuPeakFromHistory(history: LaneActivitySample[], window: LanePeekHeatWindow, now: number): number | null {
  const cutoff = heatWindowCutoffMs(window, now);
  let peak: number | null = null;
  for (const s of history) {
    if (window !== 'session' && s.at < cutoff) continue;
    if (s.cpuPercent === null || !Number.isFinite(s.cpuPercent)) continue;
    peak = peak === null ? s.cpuPercent : Math.max(peak, s.cpuPercent);
  }
  return peak;
}

export function heatAlertBoost(lane: LanePeekHeatLaneInput): number {
  if (lane.status === 'error') return 100;
  if (lane.status === 'needs_permission') return 70;
  if (lane.pendingShell) return 55;
  if (lane.status === 'awaiting_peer') return 65;
  return 0;
}

export function heatToolScore100(toolDelta: number): number {
  return Math.min(100, Math.max(0, (toolDelta / 8) * 100));
}

export function heatTokenScore100(tokenDelta: number | null): number {
  if (tokenDelta === null || tokenDelta <= 0) return 0;
  const v = Math.log10(tokenDelta + 1) / 4;
  return Math.min(100, Math.max(0, v * 100));
}

export function heatPeerScore100(peerRows: number, pendingPeerCount: number): number {
  const w = pendingPeerCount * LANE_PEEK_HEAT_PENDING_PEER_WEIGHT;
  const frac = (peerRows + w) / 6;
  return Math.min(100, Math.max(0, frac * 100));
}

export function heatProcessScore100(cpuPeak: number | null): number {
  if (cpuPeak === null || !Number.isFinite(cpuPeak)) return 0;
  return Math.min(100, Math.max(0, cpuPeak));
}

export type HeatConcreteMetric = Exclude<LanePeekHeatMetric, 'auto'>;

export function scoreForConcreteMetric(
  m: HeatConcreteMetric,
  toolS: number,
  tokenS: number,
  peerS: number,
  procS: number,
  alertS: number,
): number {
  switch (m) {
    case 'tools':
      return toolS;
    case 'tokens':
      return tokenS;
    case 'peer':
      return peerS;
    case 'process':
      return procS;
    case 'alerts':
      return alertS;
  }
}

export function heatSideLabel(lane: LanePeekHeatLaneInput): string {
  return statusLabel(lane.status);
}

export function buildHeatDeltaLine(
  metric: HeatConcreteMetric,
  a: LaneHeatSide,
  b: LaneHeatSide,
  tokensMissing: boolean,
): string {
  if (metric === 'tools') {
    return `tools ${a.toolDelta} vs ${b.toolDelta}`;
  }
  if (metric === 'tokens') {
    if (tokensMissing) return 'tokens --';
    const fa = a.tokenDelta === null ? '--' : `+${formatHeatTokenSuffix(a.tokenDelta)}`;
    const fb = b.tokenDelta === null ? '--' : `+${formatHeatTokenSuffix(b.tokenDelta)}`;
    return `tokens ${fa} vs ${fb}`;
  }
  if (metric === 'peer') {
    return `peer ${a.peerDelta} vs ${b.peerDelta}`;
  }
  if (metric === 'process') {
    const ca = a.cpuPeak === null ? '--' : `${Math.round(a.cpuPeak)}%`;
    const cb = b.cpuPeak === null ? '--' : `${Math.round(b.cpuPeak)}%`;
    return `cpu ${ca} vs ${cb}`;
  }
  return `alerts ${a.label} vs ${b.label}`;
}

export function formatHeatTokenSuffix(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return '0';
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}m`;
  if (n >= 1000) return `${(n / 1000).toFixed(1)}k`;
  return String(Math.round(n));
}

export function buildLaneHeatSide(
  lane: LanePeekHeatLaneInput,
  window: LanePeekHeatWindow,
  now: number,
  metric: HeatConcreteMetric,
): LaneHeatSide {
  const scan = scanTranscriptHeat(lane.transcript, window, now);
  const tokenDelta = tokenDeltaFromHistory(lane.metricHistory, window, now);
  const cpuPeak = cpuPeakFromHistory(lane.metricHistory, window, now);
  const alertS = heatAlertBoost(lane);
  const toolS = heatToolScore100(scan.tools);
  const tokenS = heatTokenScore100(tokenDelta);
  const peerS = heatPeerScore100(scan.peerRows, lane.pendingPeerCount);
  const procS = heatProcessScore100(cpuPeak);
  const score = Math.round(scoreForConcreteMetric(metric, toolS, tokenS, peerS, procS, alertS));
  return {
    laneId: lane.id,
    displayName: lane.displayName,
    score,
    toolDelta: scan.tools,
    tokenDelta,
    peerDelta: scan.peerRows,
    permissionDelta: scan.permissions,
    errorDelta: scan.errors,
    cpuPeak,
    label: heatSideLabel(lane),
  };
}

/**
 * Derives lane-pair heat for the active lane + peeked lane (slice 109).
 * Pure: callers supply coordinator-derived counts on each `LanePeekHeatLaneInput`.
 */
export function deriveLanePairHeat(
  active: LanePeekHeatLaneInput,
  peeked: LanePeekHeatLaneInput,
  now: number,
  window: LanePeekHeatWindow,
  metric: LanePeekHeatMetric,
): LanePairHeatSummary {
  const scanA = scanTranscriptHeat(active.transcript, window, now);
  const scanP = scanTranscriptHeat(peeked.transcript, window, now);
  const tokA = tokenDeltaFromHistory(active.metricHistory, window, now);
  const tokP = tokenDeltaFromHistory(peeked.metricHistory, window, now);
  const cpuA = cpuPeakFromHistory(active.metricHistory, window, now);
  const cpuP = cpuPeakFromHistory(peeked.metricHistory, window, now);
  const alertA = heatAlertBoost(active);
  const alertP = heatAlertBoost(peeked);
  const subA = {
    toolS: heatToolScore100(scanA.tools),
    tokenS: heatTokenScore100(tokA),
    peerS: heatPeerScore100(scanA.peerRows, active.pendingPeerCount),
    procS: heatProcessScore100(cpuA),
    alertS: alertA,
  };
  const subP = {
    toolS: heatToolScore100(scanP.tools),
    tokenS: heatTokenScore100(tokP),
    peerS: heatPeerScore100(scanP.peerRows, peeked.pendingPeerCount),
    procS: heatProcessScore100(cpuP),
    alertS: alertP,
  };

  let resolved: HeatConcreteMetric;
  if (metric !== 'auto') {
    resolved = metric;
  } else {
    const cand: HeatConcreteMetric[] = ['tools', 'tokens', 'peer', 'process', 'alerts'];
    resolved = 'alerts';
    let best = -1;
    for (const m of cand) {
      const va = scoreForConcreteMetric(m, subA.toolS, subA.tokenS, subA.peerS, subA.procS, subA.alertS);
      const vb = scoreForConcreteMetric(m, subP.toolS, subP.tokenS, subP.peerS, subP.procS, subP.alertS);
      const vmax = Math.max(va, vb);
      if (vmax > best) {
        best = vmax;
        resolved = m;
      }
    }
  }

  const sideA = buildLaneHeatSide(active, window, now, resolved);
  const sideP = buildLaneHeatSide(peeked, window, now, resolved);
  const pairScore = Math.max(sideA.score, sideP.score);
  let dominant: 'active' | 'peeked' | 'balanced' = 'balanced';
  if (sideA.score > sideP.score + 5) dominant = 'active';
  else if (sideP.score > sideA.score + 5) dominant = 'peeked';

  const tokensMissing =
    resolved === 'tokens' && sideA.tokenDelta === null && sideP.tokenDelta === null;
  const unavailableReason =
    resolved === 'tokens' && tokA === null && tokP === null ? 'no usage counters on either lane' : null;

  const deltaLine = buildHeatDeltaLine(resolved, sideA, sideP, tokensMissing);

  return {
    metric: resolved,
    window,
    active: sideA,
    peeked: sideP,
    pairScore,
    dominantSide: dominant,
    unavailableReason,
    deltaLine,
  };
}

export function lanePeekPriorityClass(candidate: LanePeekCandidate): 'high' | 'warn' | 'info' {
  const kind = candidate.summary.payload?.kind;
  if (kind === 'permission' || kind === 'error') return 'high';
  if (candidate.summary.status === 'busy' || candidate.summary.status === 'awaiting_peer') return 'warn';
  if (candidate.reasonKey === 'lane-shell') return 'warn';
  return 'info';
}

/** Peek shows a flat `tool` row when the peeked lane has a live tool. */
export function peekShowsActiveTool(snapshot: LanePeekSnapshot | null | undefined): boolean {
  return snapshot != null && snapshot.status === 'busy' && snapshot.activeTool != null;
}

/**
 * The activity event row (`▸ execute Terminal`) is the same signal as the
 * peek `tool` row. Peer / permission / error / inbox rows are different
 * signals and stay.
 */
export function peekEventRowDuplicatesTool(
  candidate: LanePeekCandidate,
  snapshot: LanePeekSnapshot | null | undefined,
): boolean {
  if (!peekShowsActiveTool(snapshot)) return false;
  return candidate.reasonKey === 'recent-activity' || candidate.reasonKey === 'lane-shell';
}

/** spec 277: the peeked lane's `#review pass` loop — running, or ended within
 *  the last few minutes — else null. Only the authoring lane carries a loop. */
export function peekReviewLoop(
  snapshot: LanePeekSnapshot | null | undefined,
  now: number,
): TelemetryReviewLoop | null {
  const loop = snapshot?.reviewLoop ?? null;
  if (!loop) return null;
  if (loop.running) return loop;
  return loop.endedAt !== null && now - loop.endedAt <= LANE_PEEK_LOOP_ENDED_MS ? loop : null;
}

export interface RailPeerHint {
  awaitingSuffix: string;
  inboxSuffix: string;
  trafficSuffix: string;
  title: string;
  kind: 'none' | 'awaiting' | 'inbox' | 'traffic';
}

export interface DeriveRailPeerHintInput {
  pendingPeers: PendingPeerSummary[];
  inboxDepth: number;
  latestInterLane: LanePeekSnapshot['latestInterLane'];
}

export function deriveRailPeerHint(
  input: DeriveRailPeerHintInput,
  getLaneStatus: (laneId: string) => HarnessLaneStatus | null,
  now: number,
): RailPeerHint {
  const { pendingPeers, inboxDepth, latestInterLane } = input;
  const titleParts: string[] = [];
  let awaitingSuffix = '';
  let inboxSuffix = '';
  let trafficSuffix = '';
  if (pendingPeers.length > 0) {
    awaitingSuffix = '⇆';
    const oldest = pendingPeers.reduce((min, peer) => (peer.sentAt < min.sentAt ? peer : min), pendingPeers[0]);
    const age = formatAwaitingPeerAge(now - oldest.sentAt);
    if (pendingPeers.length === 1) titleParts.push(`awaiting ${oldest.toDisplayName} · ${age}`);
    else titleParts.push(`awaiting ${pendingPeers.length} peers · ${age}`);
  }
  if (inboxDepth > 0) {
    inboxSuffix = `▼${inboxDepth}`;
    titleParts.push(`${inboxDepth} peer message${inboxDepth === 1 ? '' : 's'} queued`);
  }
  let kind: RailPeerHint['kind'] = 'none';
  if (pendingPeers.length > 0) kind = 'awaiting';
  else if (inboxDepth > 0) kind = 'inbox';
  const hasAwaitingOrInbox = pendingPeers.length > 0 || inboxDepth > 0;
  if (!hasAwaitingOrInbox && latestInterLane && latestInterLane.peerId !== '__harness__') {
    const ageMs = now - latestInterLane.at;
    if (ageMs <= LANE_PEEK_RECENT_MS) {
      if (latestInterLane.direction === 'in') {
        trafficSuffix = '←';
        titleParts.push(`message from ${latestInterLane.peerDisplayName}`);
        kind = 'traffic';
      } else {
        const counterpart = getLaneStatus(latestInterLane.peerId);
        if (counterpart === 'busy' || counterpart === 'awaiting_peer') {
          trafficSuffix = '→';
          titleParts.push(`sent to ${latestInterLane.peerDisplayName}`);
          kind = 'traffic';
        }
      }
    }
  }
  return { awaitingSuffix, inboxSuffix, trafficSuffix, title: titleParts.join(' · '), kind };
}

/**
 * spec 118: a direct peer event (priority ≤30 = awaiting / inbound / counterpart)
 * preempts a prior `Esc` dismissal — but ONLY when that peer event happened
 * *after* the dismissal. Re-opening the same dismissed candidate on every render
 * would make Esc useless whenever a peer candidate is sitting in the snapshot.
 */
export function shouldPreemptPeekDismissal(
  candidates: LanePeekCandidate[],
  dismissedAt: number | null,
): boolean {
  if (dismissedAt === null) return false;
  const top = candidates[0];
  return !!(
    top &&
    top.priority <= PEER_PREEMPT_MAX_PRIORITY &&
    top.summary.payload?.kind === 'peer' &&
    top.at > dismissedAt
  );
}

export function buildLanePeekCandidates(snapshots: LanePeekSnapshot[], now: number): LanePeekCandidate[] {
  const active = snapshots.find((lane) => lane.active);
  if (!active) return [];
  const byId = new Map(snapshots.map((lane) => [lane.laneId, lane]));
  const candidates = new Map<string, LanePeekCandidate>();
  const add = (candidate: LanePeekCandidate): void => {
    const prev = candidates.get(candidate.laneId);
    if (!prev || compareLanePeekCandidates(candidate, prev) < 0) candidates.set(candidate.laneId, candidate);
  };
  const oldestPendingPeer = active.pendingPeers.reduce<PendingPeerSummary | null>(
    (oldest, peer) => !oldest || peer.sentAt < oldest.sentAt ? peer : oldest,
    null,
  );
  if (oldestPendingPeer) {
    const lane = byId.get(oldestPendingPeer.toLaneId);
    if (lane && laneCanPeek(lane)) {
      add(makePeerCandidate(lane, 10, true, 'awaiting-peer', 'awaiting reply', 'awaiting', active.displayName, oldestPendingPeer.sentAt, now));
    }
  }
  if (active.latestInterLane?.direction === 'in') {
    const lane = byId.get(active.latestInterLane.peerId);
    if (lane && laneCanPeek(lane)) {
      add(makePeerCandidate(lane, 20, true, 'inbound-peer', 'peer message', 'in', active.displayName, active.latestInterLane.at, now));
    }
  }
  if (active.latestInterLane?.direction === 'out') {
    const lane = byId.get(active.latestInterLane.peerId);
    if (lane && laneCanPeek(lane) && (lane.status === 'busy' || lane.status === 'awaiting_peer' || now - active.latestInterLane.at <= LANE_PEEK_RECENT_MS)) {
      add(makePeerCandidate(lane, 30, true, 'peer-counterpart', 'peer counterpart', 'out', active.displayName, active.latestInterLane.at, now));
    }
  }
  const activeText = `${active.latestMeaningful?.label ?? ''} ${active.latestInterLane?.message ?? ''}`.toLowerCase();
  for (const lane of snapshots) {
    if (!laneCanPeek(lane)) continue;
    if (lane.latestPermission && lane.status === 'needs_permission' && pathMatchesText(lane.latestPermission.subject, activeText)) {
      add(makePermissionCandidate(lane, 40, true, 'related-permission', 'related permission', lane.latestPermission));
    }
    if (lane.status === 'error') add(makeErrorCandidate(lane, 50, false, 'lane-error', 'lane error', now));
    if (lane.status === 'needs_permission' && lane.latestPermission) {
      add(makePermissionCandidate(lane, 60, false, 'lane-permission', 'permission required', lane.latestPermission));
    }
    if (lane.pendingShell) {
      add(makeActivityCandidate(lane, 65, false, 'lane-shell', 'shell running', 'shell command running', now, now));
    }
    if (lane.reviewLoop?.running) {
      const loop = lane.reviewLoop;
      add(makeActivityCandidate(
        lane,
        LANE_PEEK_REVIEW_LOOP_PRIORITY,
        false,
        'lane-review-pass',
        'review pass',
        `review pass ${loop.round}/${loop.maxRounds}`,
        loop.phaseSince,
        now,
      ));
    }
    if (lane.inboxDepth > 0) add(makeActivityCandidate(lane, 70, false, 'lane-inbox', 'inbox pending', `inbox ${lane.inboxDepth}`, now, now));
    if (lane.latestMeaningful && now - lane.latestMeaningful.at <= LANE_PEEK_RECENT_MS) {
      add(makeActivityCandidate(lane, 80, false, 'recent-activity', 'recent activity', lane.latestMeaningful.label, lane.latestMeaningful.at, now));
    }
  }
  return Array.from(candidates.values()).sort(compareLanePeekCandidates);
}

export function selectLanePeekCandidate(
  candidates: LanePeekCandidate[],
  state: Pick<LanePeekState, 'currentLaneId' | 'lockedLaneId' | 'selectedAt' | 'dismissedAt' | 'dismissedPriority'>,
  now: number,
): LanePeekCandidate | null {
  if (candidates.length === 0) return null;
  if (state.lockedLaneId) {
    const locked = candidates.find((candidate) => candidate.laneId === state.lockedLaneId);
    if (locked) return locked;
  }
  const best = candidates[0];
  const current = candidates.find((candidate) => candidate.laneId === state.currentLaneId) ?? null;
  if (state.dismissedAt !== null && state.dismissedPriority !== null && best.priority >= state.dismissedPriority) return null;
  if (!current || current.laneId === best.laneId) return best;
  const dwellMet = now - state.selectedAt >= LANE_PEEK_DWELL_MS;
  const strongPreempt = best.priority <= current.priority - 20;
  return dwellMet || strongPreempt ? best : current;
}

export function laneCanPeek(lane: LanePeekSnapshot): boolean {
  return !lane.active && !lane.stopped;
}

export function compareLanePeekCandidates(a: LanePeekCandidate, b: LanePeekCandidate): number {
  if (a.priority !== b.priority) return a.priority - b.priority;
  if (a.direct !== b.direct) return a.direct ? -1 : 1;
  if (a.at !== b.at) return b.at - a.at;
  if (a.visualIndex !== b.visualIndex) return a.visualIndex - b.visualIndex;
  return a.laneId.localeCompare(b.laneId);
}

export function makePeerCandidate(
  lane: LanePeekSnapshot,
  priority: number,
  direct: boolean,
  reasonKey: string,
  reasonLabel: string,
  direction: 'in' | 'out' | 'awaiting',
  peerDisplayName: string,
  at: number,
  now: number,
): LanePeekCandidate {
  return {
    laneId: lane.laneId,
    displayName: lane.displayName,
    priority,
    direct,
    reasonKey,
    reasonLabel,
    at,
    visualIndex: lane.visualIndex,
    summary: {
      status: lane.status,
      headline: statusLabel(lane.status),
      detail: null,
      payload: { kind: 'peer', direction, peerDisplayName, ageLabel: formatCoarseAge(now - at) },
    },
  };
}

export function makePermissionCandidate(
  lane: LanePeekSnapshot,
  priority: number,
  direct: boolean,
  reasonKey: string,
  reasonLabel: string,
  permission: NonNullable<LanePeekSnapshot['latestPermission']>,
): LanePeekCandidate {
  return {
    laneId: lane.laneId,
    displayName: lane.displayName,
    priority,
    direct,
    reasonKey,
    reasonLabel,
    at: permission.at,
    visualIndex: lane.visualIndex,
    summary: {
      status: lane.status,
      headline: 'permission required',
      detail: permission.subject,
      payload: { kind: 'permission', toolName: permission.toolName, subject: permission.subject, decision: permission.decision },
    },
  };
}

export function makeErrorCandidate(lane: LanePeekSnapshot, priority: number, direct: boolean, reasonKey: string, reasonLabel: string, now: number): LanePeekCandidate {
  return {
    laneId: lane.laneId,
    displayName: lane.displayName,
    priority,
    direct,
    reasonKey,
    reasonLabel,
    at: now,
    visualIndex: lane.visualIndex,
    summary: {
      status: lane.status,
      headline: 'error',
      detail: lane.error,
      payload: { kind: 'error', message: lane.error ?? 'failed' },
    },
  };
}

export function makeActivityCandidate(
  lane: LanePeekSnapshot,
  priority: number,
  direct: boolean,
  reasonKey: string,
  reasonLabel: string,
  label: string,
  at: number,
  now: number,
): LanePeekCandidate {
  return {
    laneId: lane.laneId,
    displayName: lane.displayName,
    priority,
    direct,
    reasonKey,
    reasonLabel,
    at,
    visualIndex: lane.visualIndex,
    summary: {
      status: lane.status,
      headline: statusLabel(lane.status),
      detail: label,
      payload: { kind: 'activity', label, ageLabel: formatCoarseAge(now - at) },
    },
  };
}

export function pathMatchesText(path: string, text: string): boolean {
  if (!path || !text) return false;
  const normalized = path.toLowerCase();
  const base = basename(path).toLowerCase();
  return text.includes(normalized) || (base.length > 2 && text.includes(base));
}

export function latestInterLaneForPeek(lane: HarnessLane): LanePeekSnapshot['latestInterLane'] {
  for (let i = lane.transcript.length - 1; i >= 0; i--) {
    const item = lane.transcript[i];
    if (item.kind !== 'inter_lane' || !item.interLane) continue;
    return {
      direction: item.interLane.direction,
      peerId: item.interLane.peerId,
      peerDisplayName: item.interLane.peerDisplayName,
      at: item.createdAt ?? Date.now(),
      message: item.text,
    };
  }
  return null;
}

export function latestPermissionForPeek(lane: HarnessLane): LanePeekSnapshot['latestPermission'] {
  const permission = lane.pendingPermissions[0]?.transcriptItem?.permission;
  if (permission) {
    return {
      toolName: permission.toolName,
      subject: permission.subject,
      decision: permission.decision,
      at: Date.now(),
    };
  }
  for (let i = lane.transcript.length - 1; i >= 0; i--) {
    const item = lane.transcript[i];
    if (item.kind === 'permission' && item.permission) {
      return {
        toolName: item.permission.toolName,
        subject: item.permission.subject,
        decision: item.permission.decision,
        at: item.createdAt ?? Date.now(),
      };
    }
  }
  return null;
}

export function latestMeaningfulForPeek(lane: HarnessLane): LanePeekSnapshot['latestMeaningful'] {
  for (let i = lane.transcript.length - 1; i >= 0; i--) {
    const item = lane.transcript[i];
    if (!['tool', 'permission', 'inter_lane', 'shell', 'fs_activity', 'fs_write_review'].includes(item.kind)) continue;
    return {
      kind: item.kind,
      label: item.text.replace(/\s+/g, ' ').trim(),
      at: item.createdAt ?? Date.now(),
    };
  }
  return null;
}

export function derivePlanForPeek(lane: HarnessLane): LanePeekSnapshot['plan'] {
  if (!lane.plan || lane.plan.length === 0) return null;
  const total = lane.plan.length;
  const done = lane.plan.filter((entry) => entry.status === 'completed').length;
  const active = lane.plan.find((entry) => entry.status === 'in_progress');
  const next = lane.plan.find((entry) => entry.status === 'pending');
  const activeText = active?.content ?? next?.content ?? null;
  return { done, total, activeText: activeText ? activeText.replace(/\s+/g, ' ').trim() : null };
}

export type LanePeekThought = NonNullable<LanePeekSnapshot['thought']>;

/** Empty live thought stays in the rail veil. Painting a transcript row
 *  for it means the next tool_call drops that row and the list jumps. */
export function shouldPaintThoughtTranscriptRow(
  existingThought: boolean,
  incomingText: string,
): boolean {
  return existingThought || incomingText.length > 0;
}

export function deriveThoughtForPeek(lane: HarnessLane, _now?: number): LanePeekThought | null {
  if (lane.currentThoughtId) {
    const live = lane.transcript.find((entry) => entry.id === lane.currentThoughtId);
    if (live && live.kind === 'thought') {
      return {
        phase: live.text.length === 0 ? 'veil' : 'delta',
        text: live.text,
      };
    }
    // Live thinking with no transcript row yet (empty deltas reserved a
    // veil id). Keep the rail veil; do not fall through to a sealed row.
    return { phase: 'veil', text: '' };
  }
  for (let i = lane.transcript.length - 1; i >= 0; i--) {
    const item = lane.transcript[i];
    if (item.kind !== 'thought' || item.text.length === 0) continue;
    return { phase: 'seal', text: item.text };
  }
  return null;
}

export function isLivePeekThought(thought: LanePeekThought | null | undefined): boolean {
  return thought != null && (thought.phase === 'delta' || thought.phase === 'veil');
}

export function laneThoughtHasContent(thought: LanePeekThought | null | undefined): boolean {
  if (!thought) return false;
  if (thought.phase === 'veil') return true;
  return thought.text.length > 0;
}

/** Peeked lane if that snapshot has thought; otherwise the active lane. */
export function resolveLaneThoughtSnapshot(
  snapshots: LanePeekSnapshot[],
  peekedLaneId: string | null,
): LanePeekSnapshot | null {
  if (peekedLaneId) {
    const peeked = snapshots.find((lane) => lane.laneId === peekedLaneId) ?? null;
    if (peeked && laneThoughtHasContent(peeked.thought)) return peeked;
  }
  const active = snapshots.find((lane) => lane.active) ?? null;
  if (active && laneThoughtHasContent(active.thought)) return active;
  return null;
}

/** Pin the peek thought window to the latest line (spec 216). */
export function pinPeekThoughtToLatest(body: HTMLElement): void {
  body.scrollTop = body.scrollHeight;
}

/** Pin now and again after layout — scrollHeight is 0 while detached / pre-layout. */
export function schedulePeekThoughtPin(body: HTMLElement): void {
  pinPeekThoughtToLatest(body);
  requestAnimationFrame(() => pinPeekThoughtToLatest(body));
}

export function thoughtBodyRenderKind(
  thought: LanePeekThought | null,
): 'empty' | 'veil' | 'teletype' | 'markdown' {
  if (!thought || (thought.phase === 'seal' && thought.text.length === 0)) return 'empty';
  if (thought.phase === 'veil' || thought.text.length === 0) return 'veil';
  if (thought.phase === 'delta') return 'teletype';
  return 'markdown';
}

export function syncPeekThoughtBody(
  body: HTMLElement,
  thought: LanePeekThought | null,
  projectDir: string | null = null,
): boolean {
  const kind = thoughtBodyRenderKind(thought);
  if (kind === 'empty') {
    clearThoughtTeletype(body);
    body.replaceChildren();
    body.hidden = false;
    body.classList.remove(
      'acp-harness__msg-body--thought-veil',
      'acp-harness__msg-body--stream-plain',
      'acp-harness__msg-body--markdown',
    );
    delete body.dataset.peekLen;
    delete body.dataset.peekSrc;
    delete body.dataset.peekRender;
    return false;
  }
  body.hidden = false;
  if (kind === 'veil') {
    clearThoughtTeletype(body);
    body.classList.remove('acp-harness__msg-body--markdown', 'acp-harness__msg-body--stream-plain');
    installThoughtVeil(body);
    delete body.dataset.peekLen;
    delete body.dataset.peekSrc;
    delete body.dataset.peekRender;
    return false;
  }
  if (kind === 'teletype' && thought) {
    const pending = applyThoughtTeletype(body, collapseThoughtBlankLines(thought.text));
    schedulePeekThoughtPin(body);
    return pending;
  }
  const sealedText = collapseThoughtBlankLines(thought?.text ?? '');
  if (
    body.dataset.peekRender === 'sealed-plain'
    && body.dataset.peekSrc === sealedText
  ) {
    schedulePeekThoughtPin(body);
    return false;
  }
  if (sealThoughtTeletype(body, sealedText)) {
    body.classList.remove('acp-harness__msg-body--markdown');
    body.dataset.peekRender = 'sealed-plain';
    body.dataset.peekSrc = sealedText;
    schedulePeekThoughtPin(body);
    return false;
  }
  if (body.dataset.peekRender === 'sealed-plain') {
    delete body.dataset.peekRender;
    delete body.dataset.peekSrc;
  }
  clearThoughtTeletype(body);
  renderPeekThoughtMarkdown(body, thought?.text ?? '', projectDir);
  schedulePeekThoughtPin(body);
  return false;
}

export function deriveActiveToolForPeek(lane: HarnessLane, now: number): LanePeekSnapshot['activeTool'] {
  // Pick the oldest still-pending/in_progress tool — the likely blocking call. Map iteration
  // is insertion order so the first match is also the oldest.
  for (const call of lane.toolCalls.values()) {
    if (call.status !== 'in_progress' && call.status !== 'pending') continue;
    const name = inferToolLabel(call);
    const loc = call.locations?.[0]?.path ?? null;
    const command = extractCommandLineRaw(call.rawInput).replace(/\s+/g, ' ').trim();
    const leftover = cleanToolTitle(call.title, 'tool');
    const subject = loc ? basename(loc) : command || leftover || null;
    return {
      name,
      subject,
      startedAt: lane.activeTurnStartedAt ?? now,
    };
  }
  return null;
}

export function deriveRecentFilesForPeek(laneId: string, touchMap: Map<string, FileTouchRecord>, now: number): string[] {
  const mine: FileTouchRecord[] = [];
  for (const rec of touchMap.values()) {
    if (rec.laneId !== laneId) continue;
    if (now - rec.at > FILE_TOUCH_WINDOW_MS) continue;
    mine.push(rec);
  }
  mine.sort((a, b) => b.at - a.at);
  return mine.slice(0, 2).map((r) => r.path);
}
