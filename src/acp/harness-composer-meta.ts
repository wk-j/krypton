// Krypton — ACP Harness composer status line (spec 221): segment model.
//
// The status line used to be one concatenated string, which meant no part of it
// could be ellipsized independently — the whole rigid run pushed past the
// composer's right edge on a narrow window. Splitting it into segments lets the
// live-activity text act as the row's single spring (it shrinks, everything else
// keeps its width) and moves the `·` dividers into CSS, so a segment that is not
// rendered takes its divider with it and no `· ·` can appear.
//
// Pure and view-free: the caller formats the elapsed clock and the activity
// label, this module only decides which segments exist and how they escape.

import { esc } from './harness-format';

/** `text` is the whole-chip form: every non-busy state (idle memory readout,
 *  command mode, peer waits, flash overrides) is a single message with no
 *  internal structure worth splitting. */
export type MetaSegId = 'verb' | 'elapsed' | 'queued' | 'text';

export interface MetaSegment {
  id: MetaSegId;
  text: string;
}

export interface BusyStatusInput {
  /** A custom command's own verb (`reviewing`, `saving to wiki`), or null for an
   *  ordinary turn — "running" is not a readout, it is the busy state itself,
   *  which the spinner, the accented chip and the ticking clock all already show. */
  verb: string | null;
  /** Pre-formatted `m:ss`; null before the turn's start stamp is known. */
  elapsed: string | null;
  /** Queued prompt count; 0 renders no segment. */
  queued: number;
}

/**
 * Busy-lane segments.
 *
 * spec 221: the lane name and the `Ctrl+C cancel` hint that used to bracket this
 * run are deliberately absent — the lane head prints both for the active lane in
 * every layout (including Zen Mode), the input line one row below repeats the
 * name again, and the window footer's lane strip a third time. The generic
 * `running` verb is gone for the same reason: only a *named* operation is a
 * readout. The live action moved to the rail HUD (spec 231). The fallback
 * below exists so a turn whose clock is still unknown does not paint an empty
 * chip.
 */
export function buildBusySegments(input: BusyStatusInput): MetaSegment[] {
  const segments: MetaSegment[] = [];
  if (input.verb) segments.push({ id: 'verb', text: input.verb });
  if (input.elapsed) segments.push({ id: 'elapsed', text: input.elapsed });
  if (input.queued > 0) segments.push({ id: 'queued', text: `${input.queued} queued` });
  if (segments.length === 0) segments.push({ id: 'verb', text: 'running' });
  return segments;
}

/** Wrap a whole-chip message as the single `text` segment. */
export function textSegments(text: string): MetaSegment[] {
  return [{ id: 'text', text }];
}

/** Segments → chip HTML. Dividers are CSS (`.acp-harness__meta-seg + …::before`),
 *  never characters, so hiding a segment cannot leave an orphan `·`. */
export function renderStatusSegments(segments: MetaSegment[]): string {
  return segments
    .map((seg) => `<span class="acp-harness__meta-seg" data-seg="${seg.id}">${esc(seg.text)}</span>`)
    .join('');
}
