// Spec 168 — the lane monitor's text: status words, the triage summary, the
// event-feed sentences and the second-resolution counters that tick per frame.

import { pad2 } from '../../kit';
import type { TelemetryEvent, TelemetryLane, TelemetrySnapshot } from '../../../acp/harness-telemetry-schema';

const STATUS_LABEL: Readonly<Record<string, string>> = {
  starting: 'starting',
  idle: 'idle',
  busy: 'busy',
  needs_permission: 'needs permission',
  awaiting_peer: 'awaiting peer',
  error: 'error',
  stopped: 'stopped',
  unknown: 'unknown',
};

const ACTIVE: Readonly<Record<string, true>> = { busy: true, needs_permission: true, awaiting_peer: true };

export const PHASE_LABEL: Readonly<Record<string, string>> = {
  collecting: 'collecting',
  reviewing: 'reviewing',
  fixing: 'fixing',
  summarizing: 'writing summary',
};

/** A known lane status, else `unknown` (an older or newer harness may send others). */
export function statusKey(status: string | null | undefined): string {
  return status && Object.prototype.hasOwnProperty.call(STATUS_LABEL, status) ? status : 'unknown';
}

export function statusLabel(status: string | null | undefined): string {
  return STATUS_LABEL[statusKey(status)];
}

/** Busy, asking permission or waiting on a peer: the activity beat moves. */
export function isActiveStatus(status: string | null | undefined): boolean {
  return ACTIVE[statusKey(status)] === true;
}

/** Whole-second elapsed counter: `<1s`, `42s`, `3m 5s`, `1h 2m`. */
export function formatElapsed(ms: number): string {
  if (ms < 1000) return '<1s';
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${s % 60}s`;
  return `${Math.floor(m / 60)}h ${m % 60}m`;
}

/** Page uptime as `HH:MM:SS`. */
export function formatUptime(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  return `${pad2(Math.floor(s / 3600))}:${pad2(Math.floor(s / 60) % 60)}:${pad2(s % 60)}`;
}

/** `1 busy · 2 awaiting · 3 flags`, or `all clear`. */
export function formatTriage(snap: TelemetrySnapshot): string {
  let busy = 0;
  let awaiting = 0;
  for (const lane of snap.lanes ?? []) {
    if (lane.status === 'busy' || lane.status === 'needs_permission') busy++;
    if (lane.status === 'awaiting_peer') awaiting++;
  }
  const flags = snap.attention?.openCount ?? 0;
  const bits: string[] = [];
  if (busy) bits.push(`${busy} busy`);
  if (awaiting) bits.push(`${awaiting} awaiting`);
  if (flags) bits.push(`${flags} flags`);
  return bits.length ? bits.join(' · ') : 'all clear';
}

export function agentLine(lane: TelemetryLane): string {
  return lane.modelName ? `${lane.backendId || '?'} · ${lane.modelName}` : lane.backendId || '?';
}

export function turnLine(turnActiveSince: number | null | undefined, now: number): string {
  return turnActiveSince ? `turn active ${formatElapsed(now - turnActiveSince)}` : '';
}

function formatDelta(label: string, detail: string): string {
  const parts = detail.split('->');
  if (parts.length === 2) return `${label} ${parts[0]}→${parts[1]}`;
  return detail ? `${label} ${detail}` : label;
}

/** One event-feed sentence. */
export function formatEvent(ev: TelemetryEvent): string {
  const d = ev.detail ?? '';
  switch (ev.kind) {
    case 'status': {
      const parts = d.split('->');
      return parts.length === 2 ? `status → ${statusLabel(parts[1].trim())}` : 'status changed';
    }
    case 'attention':
      return formatDelta('attention queue', d);
    case 'review':
      return formatDelta('reviews', d);
    case 'priority':
      return formatDelta('high-priority hunks', d);
    case 'peer':
      return formatDelta('peer inbox', d);
    case 'lane':
      return d === 'spawned' ? 'lane spawned' : d === 'closed' ? 'lane closed' : `lane ${d}`;
    case 'loop':
      return `review pass ${d}`;
    default:
      return d || String(ev.kind || 'event');
  }
}

/** `512 MB` / `1.5 GB`. */
export function formatRss(mb: number): string {
  return mb >= 1024 ? `${(mb / 1024).toFixed(1)} GB` : `${Math.round(mb)} MB`;
}
