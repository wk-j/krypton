// Krypton — window titlebar session mark (spec 226).
//
// The magnified right-edge mark is the session identity (`01` from
// `session_01`), not the last two characters of whatever the title
// currently is. OSC cwd titles (`~/S/KRYPTON`) stay whole on the left;
// slicing them produced a meaningless `ON` on every tile.

/** Session identity is always two digits, matching `session_NN`. */
export const TITLE_TAIL_LEN = 2;

export interface TitleLabelParts {
  /** Title text on the left. The full string when there is no session mark. */
  rest: string;
  /** Magnified right-edge mark. Empty when the window has no session identity. */
  tail: string;
}

const SESSION_TITLE = /^(session_)(\d{2})$/i;

/** Pull `01` off `session_01`. Any other string is the full left-hand title. */
export function splitTitleLabel(text: string): TitleLabelParts {
  const match = SESSION_TITLE.exec(text);
  if (!match) return { rest: text, tail: '' };
  return { rest: match[1], tail: match[2] };
}

const SESSION_MARK = /^\d{2}$/;

/** Apply a new title without erasing a session mark already on the tile.
 *  `session_NN` replaces the mark; a cwd/OSC title keeps a two-digit mark
 *  and drops leftovers like `ON` from the old last-two-character split. */
export function nextTitleLabel(text: string, currentTail: string): TitleLabelParts {
  const parts = splitTitleLabel(text);
  if (parts.tail) return parts;
  const keep = SESSION_MARK.test(currentTail) ? currentTail : '';
  return { rest: parts.rest, tail: keep };
}
