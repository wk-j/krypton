// Krypton — inline verb-injection autocompletion palette (spec 191).
//
// The `{{#verb}}` injection token (verb-compose.ts) is expressive but tedious to type
// by hand. This palette lets the user type a bare `#<prefix>` at ANY position of a
// free-form prompt and pick an injectable verb; accepting inserts the full
// `{{#verb-name}}` token so the user never types the double braces themselves.
//
// It is DISTINCT from the whole-draft `#command` palette (hash-commands.ts), which
// dispatches a command and offers every `#` command. This one is cursor-aware, fires
// mid-prompt, and offers ONLY injectable prompt-verbs (the same set verb-compose can
// expand). The composer gives the command palette precedence when the whole draft is a
// bare `#token`, so the two never fight.

export interface VerbPaletteContext {
  /** Index of the `#` that starts the token being typed. */
  hashIndex: number;
  /** Token characters after `#`, up to the cursor (may be empty). */
  prefix: string;
}

/** A `#<token>` ending at the cursor whose `#` sits at the start of the text or right
 *  after a non-token character — so `issue#42` / `a#b` do NOT trigger, but `foo #bar`,
 *  `line-start #bar`, and a half-typed `{{#bar` all do. */
const VERB_TOKEN_AT_CURSOR = /(?:^|[^A-Za-z0-9-])#([A-Za-z0-9-]*)$/;

/** Detect the `#`-token at the cursor, or `null` when there is none. Pure — the caller
 *  decides visibility (e.g. suppress when the whole-draft command palette owns it). */
export function verbPaletteContext(draft: string, cursor: number): VerbPaletteContext | null {
  const before = draft.slice(0, Math.max(0, cursor));
  const m = VERB_TOKEN_AT_CURSOR.exec(before);
  if (!m) return null;
  const prefix = m[1];
  const hashIndex = before.length - prefix.length - 1; // the `#` sits just before the prefix
  return { hashIndex, prefix };
}

/** Injectable verb names matching `prefix` (case-insensitive, prefix match), sorted. */
export function filteredVerbNames(names: readonly string[], prefix: string): string[] {
  const needle = prefix.toLowerCase();
  return names.filter((n) => (needle ? n.toLowerCase().startsWith(needle) : true)).sort();
}

/** Token char: what a verb-name prefix (and the suffix after the cursor) is made of. */
const TOKEN_CHAR = /[A-Za-z0-9-]/;

/** Replace the whole `#<token>` at the cursor with the injection token `{{#name}}`,
 *  leaving the cursor just past the closing braces. Consumes the token SUFFIX after the
 *  cursor too (so accepting mid-token — `#an|alyze` — never strands `alyze`), and, when
 *  completing an already-typed `{{#…}}`, absorbs the surrounding braces so the result is
 *  never `{{{{#name}}` or `{{#name}}}}`. */
export function applyVerbSelection(
  draft: string,
  cursor: number,
  verbName: string,
): { draft: string; cursor: number } {
  const ctx = verbPaletteContext(draft, cursor);
  if (!ctx) return { draft, cursor };
  const hadBraces = draft.slice(ctx.hashIndex - 2, ctx.hashIndex) === '{{';
  const start = hadBraces ? ctx.hashIndex - 2 : ctx.hashIndex;
  // Extend past the cursor to swallow the rest of the token the user had typed.
  let end = cursor;
  while (end < draft.length && TOKEN_CHAR.test(draft[end])) end++;
  // Only when completing an existing `{{#…` do we also absorb its closing `}}`.
  if (hadBraces && draft.slice(end, end + 2) === '}}') end += 2;
  const insertion = `{{#${verbName}}}`;
  const nextDraft = draft.slice(0, start) + insertion + draft.slice(end);
  return { draft: nextDraft, cursor: start + insertion.length };
}
