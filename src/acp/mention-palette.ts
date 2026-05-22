// Krypton — @mention composer palette (spec 115).

export interface MentionPaletteContext {
  atIndex: number;
  prefix: string;
}

/** Text before cursor must be only leading @mentions and the token being typed. */
const LEADING_BEFORE_CURSOR = /^(@[A-Za-z][A-Za-z0-9_-]*\s*)*@?[A-Za-z0-9_-]*$/;

export function mentionPaletteContext(draft: string, cursor: number): MentionPaletteContext | null {
  const before = draft.slice(0, Math.max(0, cursor));
  if (!before.includes('@')) return null;
  if (!LEADING_BEFORE_CURSOR.test(before)) return null;
  const atIndex = before.lastIndexOf('@');
  if (atIndex === -1) return null;
  const prefix = before.slice(atIndex + 1);
  if (prefix.includes(' ')) return null;
  return { atIndex, prefix };
}

export function mentionPaletteVisible(
  draft: string,
  cursor: number,
  dismissed: boolean,
  rosterSize: number,
): boolean {
  if (dismissed || rosterSize === 0) return false;
  return mentionPaletteContext(draft, cursor) !== null;
}

export function filteredMentionTargets(
  rosterDisplayNames: string[],
  selfDisplayName: string,
  prefix: string,
): string[] {
  const needle = prefix.toLowerCase();
  return rosterDisplayNames.filter((name) => {
    if (name === selfDisplayName) return false;
    if (!needle) return true;
    return name.toLowerCase().startsWith(needle);
  });
}

export function applyMentionSelection(
  draft: string,
  cursor: number,
  displayName: string,
): { draft: string; cursor: number } {
  const ctx = mentionPaletteContext(draft, cursor);
  if (!ctx) return { draft, cursor };
  const insertion = `@${displayName} `;
  const nextDraft = draft.slice(0, ctx.atIndex) + insertion + draft.slice(cursor);
  return { draft: nextDraft, cursor: ctx.atIndex + insertion.length };
}
