// Krypton — File Manager `/` filter (spec 317). Pure.
//
// In-order subsequence match on names (quirk P5: a different algorithm from the
// scored `f` search in fuzzy.ts).

import type { FileEntry } from './types';

/** Always returns a new array (`[...entries]` when `text` is empty). */
export function filterEntries(entries: readonly FileEntry[], text: string): FileEntry[] {
  if (!text) return [...entries];
  const lower = text.toLowerCase();
  return entries.filter((e) => {
    // Fuzzy match: all chars must appear in order
    let fi = 0;
    const name = e.name.toLowerCase();
    for (let ni = 0; ni < name.length && fi < lower.length; ni++) {
      if (name[ni] === lower[fi]) fi++;
    }
    return fi === lower.length;
  });
}
