// Krypton — daily-note capture (spec 223).
//
// The harness already routes every event worth recording. This module is the
// single place that tees them to `.krypton/journal/<date>.jsonl`, so capture
// stays one call at each site instead of a policy spread across the view.
//
// Capture must never cost a turn: `journalAppend` swallows every failure. A
// day with a gap in it is a worse note; a turn that died writing a note is a
// worse editor.

import { invoke } from '@tauri-apps/api/core';

/** Mirrors `journal::JournalKind` in Rust.
 *  `goal` has no writer since the lane-goal feature (spec 148) was removed;
 *  it stays in the union so journal files written before the removal still
 *  parse and render. */
export type JournalKind =
  | 'session'
  | 'goal'
  | 'handoff'
  | 'attention'
  | 'review'
  | 'artifact'
  | 'ticket'
  | 'note';

/** Mirrors `journal::JournalEvent` in Rust. */
export interface JournalEvent {
  v: number;
  at: number;
  kind: JournalKind;
  harnessId: string;
  lane: string;
  backend: string;
  model: string | null;
  /** One line, already human-readable. The renderer never reformats it. */
  summary: string;
  /** Kind-specific extras (issueKey, blockers, artifactId, itemId …). */
  meta: Record<string, unknown>;
}

export interface JournalLaneRef {
  harnessId: string;
  lane: string;
  backend: string;
  model?: string | null;
}

/**
 * Minutes to ADD to UTC to reach local time.
 *
 * The negation of `getTimezoneOffset()`, which reports the opposite sign.
 * Rust cannot work this out for itself — the process has no reliable zone —
 * so every journal call carries it.
 */
export function tzOffsetMinutes(): number {
  return -new Date().getTimezoneOffset();
}

/** `YYYY-MM-DD` for an instant in the local zone. Defaults to now. */
export function localDayStamp(at: number = Date.now()): string {
  const local = new Date(at - new Date(at).getTimezoneOffset() * 60_000);
  return local.toISOString().slice(0, 10);
}

/**
 * Append one event. Fire-and-forget by design — callers do not await it and it
 * never rejects.
 */
export async function journalAppend(
  cwd: string,
  laneRef: JournalLaneRef,
  kind: JournalKind,
  summary: string,
  meta: Record<string, unknown> = {},
): Promise<void> {
  if (!cwd || !summary.trim()) return;
  const event: JournalEvent = {
    v: 1,
    at: Date.now(),
    kind,
    harnessId: laneRef.harnessId,
    lane: laneRef.lane,
    backend: laneRef.backend,
    model: laneRef.model ?? null,
    summary,
    meta,
  };
  try {
    await invoke('journal_append', { cwd, event, tzOffsetMinutes: tzOffsetMinutes() });
  } catch (err) {
    // Capture is best-effort. A missing row costs one line of a note; a thrown
    // error here would cost the turn that was trying to do real work.
    console.warn('[journal] append failed', err);
  }
}
