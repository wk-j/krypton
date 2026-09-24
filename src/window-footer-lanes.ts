// Krypton — window status-bar lane strip (spec 218): pure derivations.
//
// Each window renders the lane roster of the ACP Harness in its own focused
// pane, in its own `.krypton-window__footer`. Everything that decides what the
// strip actually shows — the mark cap and its `+N` tail, the drop-cap split, the
// repaint key, the
// a11y label — lives here, side-effect free, so it is testable without a
// compositor or a DOM.

import { INITIALS_LEN } from './window-footer-project';

/** spec 218: one lane's presentation identity in a window's status-bar strip.
 *  Presentation-only — no status, no counts (those have their own indicators),
 *  so a busy→idle churn never repaints the rail. */
export interface HarnessLaneMark {
  /** Stable lane id — the strip's DOM key. */
  id: string;
  /** e.g. "Claude-1". The active mark shows two initials and the trailing
   *  number; the full name remains available to assistive technology. */
  displayName: string;
  /** Backend id — tooltip / identity only. The strip no longer paints a logo. */
  backendId: string;
  /** Lane accent CSS value (`lane.accent`, picked at random per lane by
   *  `pickLaneAccent`), applied inline as `--krypton-lane-accent`. */
  accent: string;
  /** The lane this window's harness is currently driving. At most one. */
  active: boolean;
}

/** Icon budget for the strip. Past this the tail becomes `+N`. Eight marks sit
 *  in the 28px window rail without crowding the AI-credit quotas beside them. */
export const LANE_STRIP_MAX = 8;

/**
 * Cap the roster to the icon budget, reporting how many were dropped for the
 * `+N` tail. Order is the harness's own lane order (`⌃1..9` order), so a mark's
 * position in the strip matches the key that switches to it.
 */
export function capLaneMarks(
  lanes: readonly HarnessLaneMark[],
  max: number = LANE_STRIP_MAX,
): { marks: HarnessLaneMark[]; overflow: number } {
  const cap = Math.max(0, max);
  return { marks: lanes.slice(0, cap), overflow: Math.max(0, lanes.length - cap) };
}

/** Identity of the rendered strip. The window rebuilds its nodes only when this
 *  changes, so a re-sync that shifts nothing repaints nothing. */
export function laneStripKey(marks: readonly HarnessLaneMark[], overflow: number): string {
  const parts = marks.map((m) =>
    [m.id, m.backendId, m.displayName, m.accent, m.active ? '1' : '0'].join(':'),
  );
  return `${parts.join('|')}#${overflow}`;
}

/** Cut a lane display name into its two-letter mark and remaining name.
 * The footer renders the mark; the full name stays in the tooltip and a11y label.
 * Split by code point. */
export function laneDropCap(displayName: string): { initials: string; rest: string } {
  const chars = [...displayName];
  return {
    initials: chars.slice(0, INITIALS_LEN).join(''),
    rest: chars.slice(INITIALS_LEN).join(''),
  };
}

/** Lane number shown beside the active mark when the display name ends in -N. */
export function laneNumber(displayName: string): string | null {
  return /-(\d+)$/.exec(displayName)?.[1] ?? null;
}

/** Screen-reader label for the strip — inactive marks show only two letters, so
 *  the roster is spelled out here. */
export function laneStripLabel(marks: readonly HarnessLaneMark[], overflow: number): string {
  if (marks.length === 0) return 'no harness lanes';
  const names = marks.map((m) => (m.active ? `${m.displayName} (active)` : m.displayName));
  const tail = overflow > 0 ? `, ${overflow} more` : '';
  return `harness lanes: ${names.join(', ')}${tail}`;
}
