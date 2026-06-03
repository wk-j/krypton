// Krypton — Harness Directory (cross-harness peering, spec 141).
//
// A module-level singleton with two jobs:
//
//   (a) Name allocator. `nextLaneNumber(labelPrefix)` vends globally-unique,
//       never-recycled lane numbers per rendered display-label prefix, so a
//       lane `displayName` (`Claude-1`, `Codex-7`) uniquely and permanently
//       identifies one lane across every harness view in the process. This is
//       what lets cross-view addressing stay the bare `displayName` — no
//       qualified handle, no generation token.
//
//   (b) Router. Every `AcpHarnessView` registers a `HarnessEntry` on start and
//       removes it on dispose. Because all harness views share one JS runtime,
//       the directory sees every lane across every view and can route a
//       `displayName` to its owning view's coordinator. Entries carry the
//       view's `cwd` so peers know which project a lane belongs to.
//
// The directory holds STRONG references to each live view through the entry's
// closures, so liveness is guaranteed only by paired register/unregister.

import type { InterLaneEnvelope, LaneSummary } from './types';
import type { AcceptInboundResult } from './inter-lane';

// ──────────────────────────────────────────────────────────────────────────
// (a) Name allocator — monotonic per rendered display-label prefix, never
// recycled, process-wide. Keyed by the prefix that actually appears in the
// displayName (backendLabel(backendId)), NOT the raw backendId, so two backend
// ids that capitalize to the same prefix can never mint the same displayName
// (spec 141, Codex-1 re-review High 1).

const laneCounters = new Map<string, number>();

/** Vend the next never-recycled lane number for a rendered display-label prefix. */
export function nextLaneNumber(labelPrefix: string): number {
  const next = (laneCounters.get(labelPrefix) ?? 0) + 1;
  laneCounters.set(labelPrefix, next);
  return next;
}

// ──────────────────────────────────────────────────────────────────────────
// (b) Router

export interface HarnessEntrySnapshot {
  harnessId: string;
  cwd: string | null;
  /** Foreign lanes that may have pending sends toward them — captured before
   *  unregister, since the metadata is gone afterward. */
  displayNames: string[];
}

export interface HarnessEntry {
  harnessId: string; // 'hm-42' — identity only, not part of any address
  cwd: string | null; // the view's working directory, exposed on registration
  alive: boolean; // flipped false at the start of dispose(), before teardown
  listLanes(): LaneSummary[]; // delegates to the view's coordinator
  resolveLocalDisplayName(name: string): { laneId: string; displayName: string } | null;
  acceptInbound(env: InterLaneEnvelope): AcceptInboundResult; // rejects if !alive
  // cross-view #cancel: the canceller's coordinator routes a cancellation onto
  // the target view that owns the foreign pending peer, so the foreign lane gets
  // the same notice + tombstone + termination prompt as a local cancel.
  acceptForeignCancellation(targetLaneId: string, cancellerDisplayName: string): void; // no-op if !alive
  // cross-view #cancel ack: the foreign peer drained its cancellation notice, so
  // the canceller's coordinator clears the tombstone keyed (cancellerLaneId,
  // peerDisplayName) — the cross-coordinator analogue of the local suffix-clear.
  clearCancellationTombstone(cancellerLaneId: string, peerDisplayName: string): void;
  // Close notification: the directory calls this on every OTHER registered
  // harness when some harness disposes, handing it a snapshot taken before removal.
  onForeignHarnessClosed(closed: HarnessEntrySnapshot): void;
}

const harnesses = new Map<string, HarnessEntry>();

export function registerHarness(entry: HarnessEntry): void {
  harnesses.set(entry.harnessId, entry);
}

/** Idempotent — safe to call twice (e.g. from a failed start()'s finally). On
 *  removal, fan a close snapshot out to every other live harness so any lane
 *  with pending sends toward the closing harness gets a "peer closed" notice. */
export function unregisterHarness(harnessId: string): void {
  const closing = harnesses.get(harnessId);
  if (!closing) return;
  const snapshot: HarnessEntrySnapshot = {
    harnessId: closing.harnessId,
    cwd: closing.cwd,
    displayNames: closing.listLanes().map((l) => l.displayName),
  };
  harnesses.delete(harnessId);
  for (const other of harnesses.values()) {
    if (!other.alive) continue;
    try {
      other.onForeignHarnessClosed(snapshot);
    } catch (e) {
      console.warn('[harness-directory] onForeignHarnessClosed failed', e);
    }
  }
}

/** spec 141: an individual lane in `harnessId` stopped while its harness stays
 *  alive. Fan a single-name close snapshot out to every OTHER live harness so a
 *  cross-view initiator waiting on that lane gets the same "peer closed" notice a
 *  same-view close produces (otherwise it would hang in awaiting_peer). The
 *  closing harness itself handles its own waiters via the local lane:closed path.
 */
export function notifyForeignLaneClosed(
  harnessId: string,
  displayName: string,
  cwd: string | null,
): void {
  const snapshot: HarnessEntrySnapshot = { harnessId, cwd, displayNames: [displayName] };
  for (const other of harnesses.values()) {
    if (other.harnessId === harnessId || !other.alive) continue;
    try {
      other.onForeignHarnessClosed(snapshot);
    } catch (e) {
      console.warn('[harness-directory] onForeignHarnessClosed (lane close) failed', e);
    }
  }
}

/** Every lane in every OTHER live harness (any project), tagged local:false and
 *  carrying its owning view's cwd + harnessId. */
export function peersFor(harnessId: string): LaneSummary[] {
  const out: LaneSummary[] = [];
  for (const entry of harnesses.values()) {
    if (entry.harnessId === harnessId || !entry.alive) continue;
    for (const lane of entry.listLanes()) {
      out.push({ ...lane, local: false, harnessId: entry.harnessId, cwd: entry.cwd });
    }
  }
  return out;
}

/** Resolve a globally-unique displayName to its owning LIVE harness. Returns
 *  null when no live harness owns the name (closed lane, or never existed). */
export function resolveDisplayName(
  name: string,
): { harnessId: string; laneId: string; displayName: string; cwd: string | null } | null {
  for (const entry of harnesses.values()) {
    if (!entry.alive) continue;
    const hit = entry.resolveLocalDisplayName(name);
    if (hit) {
      return { harnessId: entry.harnessId, laneId: hit.laneId, displayName: hit.displayName, cwd: entry.cwd };
    }
  }
  return null;
}

/** Look up a live entry by harnessId (for routing onto a resolved target). */
export function harnessEntry(harnessId: string): HarnessEntry | null {
  const entry = harnesses.get(harnessId);
  return entry && entry.alive ? entry : null;
}

// Test-only escape hatch — resets both the router and the name counters.
export function __resetHarnessDirectoryForTests(): void {
  harnesses.clear();
  laneCounters.clear();
}
