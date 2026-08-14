// Krypton — window status-bar project badge (spec 219): pure derivations.
//
// A window's rail answers "which project is this?" by magnifying the head of
// the focused view's working directory name — a drop cap, so the glance target
// stays two characters wide however long the project is called. Everything that
// decides what the badge actually says — which path segment is the name, how the
// home directory is abbreviated, where the head ends and where a long tail is
// cut — lives here, side-effect free, so it is testable without a compositor or
// a DOM.

/** spec 219: what the badge renders, plus the path behind it. */
export interface ProjectBadge {
  /** Display text — the directory's own name, in its real case, truncated. */
  label: string;
  /** The magnified head of `label` — the drop cap. */
  initials: string;
  /** The remainder of `label`, rendered at the rail's own size. Empty for a
   *  name of `INITIALS_LEN` characters or fewer. */
  rest: string;
  /** Full working directory, `~`-abbreviated. Never truncated; the tooltip and
   *  the a11y label carry it, so the truncation above never loses information. */
  title: string;
}

/** Chars past which the label is ellipsized. Only the head is magnified, so this
 *  is a plain readability cap on the rail's own 11px type. */
export const PROJECT_LABEL_MAX = 18;

/** How much of the name is magnified. Two characters is what distinguishes the
 *  projects a person actually has open (`kr`ypton vs `tl`i-api-service) while
 *  costing a bounded amount of rail width — the whole reason the zoom is not
 *  applied to the entire name. */
export const INITIALS_LEN = 2;

/**
 * Derive the badge from a working directory.
 *
 * Returns `null` for an absent or blank directory so the caller can drop the
 * element entirely — a window with nothing to say says nothing, rather than
 * holding rail space for a placeholder.
 *
 * `home` is passed in rather than read here to keep this module free of Tauri
 * and the DOM; the compositor supplies it from the harness's cached `$HOME`.
 */
export function projectBadge(
  dir: string | null | undefined,
  home: string | null = null,
  max: number = PROJECT_LABEL_MAX,
): ProjectBadge | null {
  if (!dir) return null;
  // A trailing slash is not part of the name: `/a/b/` is still the project `b`.
  const path = dir.trim().replace(/\/+$/, '');
  if (!path) {
    // Either blank input, or the filesystem root — whose trailing slash *is*
    // the whole path, so it survives as itself rather than becoming empty.
    return dir.trim() ? split('/', '/') : null;
  }

  const homePath = home ? home.trim().replace(/\/+$/, '') : '';
  const underHome = homePath !== '' && (path === homePath || path.startsWith(`${homePath}/`));
  const title = underHome ? `~${path.slice(homePath.length)}` : path;

  // The home directory has no useful name of its own; `~` is the name.
  if (title === '~') return split('~', title);

  const slash = path.lastIndexOf('/');
  const name = slash === -1 ? path : path.slice(slash + 1);
  return split(truncate(name, max), title);
}

/** Cut the display text into its magnified head and its rail-sized tail.
 *  Split by code point, not by UTF-16 unit, so a name that opens with an
 *  astral character (an emoji-prefixed directory) cannot be cut mid-pair into
 *  a replacement glyph. */
function split(label: string, title: string): ProjectBadge {
  const chars = [...label];
  return {
    label,
    initials: chars.slice(0, INITIALS_LEN).join(''),
    rest: chars.slice(INITIALS_LEN).join(''),
    title,
  };
}

function truncate(value: string, max: number): string {
  if (max <= 0) return '';
  const chars = [...value];
  return chars.length <= max ? value : `${chars.slice(0, max - 1).join('')}…`;
}
