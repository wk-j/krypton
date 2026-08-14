// Krypton — window status-bar diff stat (spec 220): pure derivations.
//
// A window's rail answers "how much has changed here?" with the repo's
// uncommitted line volume beside the project name. Everything that decides what
// the readout actually says — when there is nothing to say, how a five-digit
// count is abbreviated so a magnified pair keeps a fixed worst-case width, what
// the tooltip admits about counts it could not take — lives here, side-effect
// free, so it is testable without a compositor, a DOM, or a git repo.

/** spec 220: the backend's `WorkingDiffStat` — totals only, never diff text. */
export interface WorkingDiffStat {
  repoRoot: string;
  /** Files changed vs `HEAD`, including untracked and binary ones. */
  files: number;
  added: number;
  removed: number;
  /** Some file's lines could not be counted (binary / too large / unreadable)
   *  or the untracked walk hit its cap, so the counts are a lower bound. */
  truncated: boolean;
}

/** spec 220: what the rail renders. */
export interface DiffStatBadge {
  /** `"+214"`, `"+1.2k"`, `"+12k"`. */
  added: string;
  removed: string;
  /** Tooltip and a11y label — carries the file count and the lower-bound
   *  caveat the two tokens have no room for. */
  title: string;
}

/**
 * Counts at or above which the number is abbreviated.
 *
 * Deliberately low: the pair is magnified to the lane logo's size, where every
 * extra digit costs real rail width. Capping each token at five characters
 * (`+9.9k`, `-12k`) gives the magnified pair a fixed worst case, so a busy
 * worktree can never push the quotas off the rail.
 */
export const DIFF_STAT_COMPACT_FROM = 1_000;

/**
 * Derive the readout from a backend stat.
 *
 * Returns `null` for a missing stat or a clean tree, so the caller can drop the
 * element entirely — the rail's standing rule is that a readout with nothing to
 * report says nothing rather than holding space for a zero. (Starship's
 * `git_metrics` makes the same call with `only_nonzero_diffs`.)
 *
 * A tree with changes always renders *both* tokens even when one is zero: a
 * lone `-37` beside a project name reads as a stray number, while `+0 -37`
 * reads as a diff.
 */
export function diffStatBadge(stat: WorkingDiffStat | null | undefined): DiffStatBadge | null {
  if (!stat || stat.files <= 0) return null;
  const added = Math.max(0, Math.trunc(stat.added));
  const removed = Math.max(0, Math.trunc(stat.removed));
  const files = Math.max(0, Math.trunc(stat.files));

  const detail = `working tree vs HEAD: +${added} -${removed} across ${files} file${files === 1 ? '' : 's'}`;
  const caveat = stat.truncated ? ' (partial — large or binary files skipped)' : '';
  return {
    added: `+${compact(added)}`,
    removed: `-${compact(removed)}`,
    title: `${detail}${caveat}`,
  };
}

/** `999` → `999`, `1234` → `1.2k`, `12345` → `12k`. One decimal only below 10k,
 *  where it still carries information; past that the tenth of a thousand is
 *  noise and the character is worth more than the precision. */
function compact(value: number): string {
  if (value < DIFF_STAT_COMPACT_FROM) return String(value);
  const thousands = value / 1000;
  if (thousands < 10) {
    // Truncate rather than round: a lower bound must never overstate, and
    // `1.9k` rounding up to `2k` would cross the format boundary as well.
    return `${(Math.floor(thousands * 10) / 10).toFixed(1)}k`;
  }
  return `${Math.floor(thousands)}k`;
}
