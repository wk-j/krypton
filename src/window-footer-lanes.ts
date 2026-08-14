// Krypton — window status-bar lane strip (spec 218): pure derivations.
//
// Each window renders the lane roster of the ACP Harness in its own focused
// pane, in its own `.krypton-window__footer`. Everything that decides what the
// strip actually shows — the icon cap and its `+N` tail, the repaint key, the
// a11y label — lives here, side-effect free, so it is testable without a
// compositor or a DOM.

/** spec 218: one lane's presentation identity in a window's status-bar strip.
 *  Presentation-only — no status, no counts (those have their own indicators),
 *  so a busy→idle churn never repaints the rail. */
export interface HarnessLaneMark {
  /** Stable lane id — the strip's DOM key. */
  id: string;
  /** e.g. "Claude-1". Rendered as text for the active lane only. */
  displayName: string;
  /** Backend id → `backendLogoId()` → the `#krypton-logo-*` symbol to `<use>`. */
  backendId: string;
  /** Lane accent CSS value (`laneAccent(index)`), applied inline as
   *  `--krypton-lane-accent`. Lane 1's `var(--krypton-window-accent, #0cf)`
   *  resolves against the window's own accent here — the footer is inside the
   *  window's cascade, so lane 1 agrees with the window chrome. */
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

/** Screen-reader label for the strip — the marks carry no text of their own
 *  except on the active lane, so the roster is spelled out here. */
export function laneStripLabel(marks: readonly HarnessLaneMark[], overflow: number): string {
  if (marks.length === 0) return 'no harness lanes';
  const names = marks.map((m) => (m.active ? `${m.displayName} (active)` : m.displayName));
  const tail = overflow > 0 ? `, ${overflow} more` : '';
  return `harness lanes: ${names.join(', ')}${tail}`;
}
