// Krypton — Attention Triage store (spec 128).
//
// A per-lane opt-in router for self-reported judgement items. An equipped lane
// calls the `attention_flag` MCP tool at end-of-turn to surface a decision that
// genuinely needs human judgement. Items accumulate in a *demand queue* ranked
// by reversibility/blast-radius; the human discharges them (approve / redirect /
// dig) in a summon-on-demand overlay. Nothing is auto-approved or deleted —
// triage is a router, not a gatekeeper (see docs/adr/0001).
//
// This store owns no DOM and no transport. It holds the queue + the silent-turn
// audit counters, and emits a single `triage:changed` LaneBusEvent so the view
// can refresh the static backpressure gauge.

import type {
  JudgementItem,
  JudgementStatus,
  LaneTriageStats,
  Reversibility,
} from './types';
import type { LaneBus } from './lane-bus';

/** Reversibility weight — higher means it costs more to undo, so it ranks first. */
const REVERSIBILITY_WEIGHT: Record<Reversibility, number> = {
  irreversible: 2,
  costly: 1,
  reversible: 0,
};

/** A status the human (or a closed lane) has discharged — terminal, queue-exiting. */
function isTerminal(status: JudgementStatus): boolean {
  return status !== 'open';
}

/**
 * Demand-queue ordering: most-irreversible first, ties broken by oldest-first
 * (an old unreviewed fork compounds downstream rework). `lane peek heat` is
 * deliberately NOT consulted — it measures activity, not judgement weight
 * (ADR-0001).
 */
export function compareJudgement(a: JudgementItem, b: JudgementItem): number {
  const byReversibility = REVERSIBILITY_WEIGHT[b.reversibility] - REVERSIBILITY_WEIGHT[a.reversibility];
  if (byReversibility !== 0) return byReversibility;
  return a.createdAt - b.createdAt; // oldest first
}

export class AttentionTriageStore {
  /** All items ever flagged, keyed by id. Resolved items stay here (silent pile). */
  private items = new Map<string, JudgementItem>();
  /** Per-equipped-lane audit counters. Presence = lane is triage-equipped. */
  private stats = new Map<string, LaneTriageStats>();

  constructor(private readonly bus?: LaneBus) {}

  // ── Equip lifecycle ────────────────────────────────────────────────

  /** Mark a lane triage-equipped. Idempotent; seeds zeroed audit counters. */
  equip(laneId: string): void {
    if (!this.stats.has(laneId)) {
      this.stats.set(laneId, {
        laneId,
        flaggedCount: 0,
        silentTurnCount: 0,
        lastSilentTurnAt: null,
      });
    }
  }

  /**
   * Unequip a lane. Drops its audit counters but KEEPS its already-flagged items
   * in the queue/pile — a flagged decision still needs the human even if the
   * lane was later unequipped.
   */
  unequip(laneId: string): void {
    this.stats.delete(laneId);
  }

  isEquipped(laneId: string): boolean {
    return this.stats.has(laneId);
  }

  equippedLaneIds(): string[] {
    return [...this.stats.keys()];
  }

  hasEquippedLanes(): boolean {
    return this.stats.size > 0;
  }

  // ── Item lifecycle ─────────────────────────────────────────────────

  /** Insert a freshly-flagged item (status `open`) and bump the lane's flagged count. */
  insert(item: JudgementItem): void {
    this.items.set(item.id, item);
    const stat = this.stats.get(item.laneId);
    if (stat) stat.flaggedCount += 1;
    this.emitChanged();
  }

  /**
   * Late-bind an item's blast-radius (diffstat) after the flag was inserted.
   * Used so the bus reply can return immediately while git collection runs
   * asynchronously (avoids the reply racing the bus timeout). No-op if gone.
   */
  setDiffstat(itemId: string, diffstat: JudgementItem['diffstat'], packetId: string | null): void {
    const item = this.items.get(itemId);
    if (!item) return;
    item.diffstat = diffstat;
    item.packetId = packetId;
    this.emitChanged();
  }

  /** Human approves: pure bookkeeping, no lane effect. Open items only. */
  accept(itemId: string): boolean {
    return this.transition(itemId, 'accepted');
  }

  /** Human redirected the lane; dequeue. Open items only. */
  redirect(itemId: string): boolean {
    return this.transition(itemId, 'redirected');
  }

  /**
   * Lane self-resolves via `attention_resolve`: demote to the silent pile, never
   * delete. A no-op if the item is already terminal (human approve/redirect wins).
   *
   * Ownership: when `requesterLaneId` is given, only the lane that flagged the
   * item may resolve it — a foreign lane that learned the id is rejected.
   */
  selfResolve(
    itemId: string,
    requesterLaneId?: string,
  ): { ok: boolean; reason?: 'unknown_item' | 'not_owner'; dropped: boolean } {
    const item = this.items.get(itemId);
    if (!item) return { ok: false, reason: 'unknown_item', dropped: true };
    if (requesterLaneId !== undefined && item.laneId !== requesterLaneId) {
      return { ok: false, reason: 'not_owner', dropped: false };
    }
    if (isTerminal(item.status)) return { ok: true, dropped: true }; // terminal status wins
    item.status = 'self_resolved';
    this.emitChanged();
    return { ok: true, dropped: false };
  }

  /** Return an open item to the queue (e.g. a redirect that failed to deliver). */
  reopen(itemId: string): void {
    const item = this.items.get(itemId);
    if (!item) return;
    item.status = 'open';
    this.emitChanged();
  }

  private transition(itemId: string, next: JudgementStatus): boolean {
    const item = this.items.get(itemId);
    if (!item || item.status !== 'open') return false;
    item.status = next;
    this.emitChanged();
    return true;
  }

  // ── Queries ────────────────────────────────────────────────────────

  get(itemId: string): JudgementItem | null {
    return this.items.get(itemId) ?? null;
  }

  /** Open items, ranked for review. */
  openItems(): JudgementItem[] {
    return [...this.items.values()].filter((i) => i.status === 'open').sort(compareJudgement);
  }

  openCount(): number {
    let n = 0;
    for (const item of this.items.values()) if (item.status === 'open') n += 1;
    return n;
  }

  /** Resolved/discharged items — the silent pile (never deleted). */
  silentPile(): JudgementItem[] {
    return [...this.items.values()]
      .filter((i) => isTerminal(i.status))
      .sort((a, b) => b.createdAt - a.createdAt);
  }

  statsFor(laneId: string): LaneTriageStats | null {
    return this.stats.get(laneId) ?? null;
  }

  allStats(): LaneTriageStats[] {
    return [...this.stats.values()];
  }

  // ── Silent-turn audit ──────────────────────────────────────────────

  /**
   * Record the end of an equipped lane's turn (busy→idle). `flagged` is true if
   * the turn produced ≥1 judgement item — in which case the flagged count was
   * already bumped by `insert()`, so we only count the silent case here.
   */
  recordTurnEnd(laneId: string, flagged: boolean): void {
    const stat = this.stats.get(laneId);
    if (!stat || flagged) return;
    stat.silentTurnCount += 1;
    stat.lastSilentTurnAt = Date.now();
  }

  /** Drop everything for a closed lane: its items leave the queue and its audit row. */
  onLaneClosed(laneId: string): void {
    this.stats.delete(laneId);
    let changed = false;
    for (const [id, item] of this.items) {
      if (item.laneId === laneId) {
        this.items.delete(id);
        if (item.status === 'open') changed = true;
      }
    }
    if (changed) this.emitChanged();
  }

  private emitChanged(): void {
    this.bus?.emit({ type: 'triage:changed', payload: { openCount: this.openCount() } });
  }
}
