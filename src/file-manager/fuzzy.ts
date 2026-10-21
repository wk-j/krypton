// Krypton — File Manager `f` fuzzy search (spec 317). Pure.

/** Fuzzy score: higher is better, 0 means no match */
export function fuzzyScore(target: string, query: string): number {
  const qLen = query.length;
  const tLen = target.length;
  if (qLen > tLen) return 0;

  let qi = 0;
  let score = 0;
  let consecutive = 0;
  let prevMatchIdx = -2;
  let qChar = query.charCodeAt(0);

  for (let ti = 0; ti < tLen; ti++) {
    // Early exit: remaining target chars can't cover remaining query chars.
    if (tLen - ti < qLen - qi) return 0;

    if (target.charCodeAt(ti) === qChar) {
      score += 1;

      if (ti === prevMatchIdx + 1) {
        consecutive++;
        score += consecutive * 2;
      } else {
        consecutive = 0;
      }

      // Word boundary bonus: after / . _ -
      if (ti === 0) {
        score += 5;
      } else {
        const prev = target.charCodeAt(ti - 1);
        // / . _ -  →  47 46 95 45
        if (prev === 47 || prev === 46 || prev === 95 || prev === 45) {
          score += 5;
        }
      }

      prevMatchIdx = ti;
      qi++;
      if (qi >= qLen) break;
      qChar = query.charCodeAt(qi);
    }
  }

  if (qi < qLen) return 0;

  // Basename match bonus: if all query chars matched within the filename portion
  const lastSlash = target.lastIndexOf('/');
  const basenameStart = lastSlash >= 0 ? lastSlash + 1 : 0;
  let bi = 0;
  for (let ci = basenameStart; ci < tLen && bi < qLen; ci++) {
    if (target.charCodeAt(ci) === query.charCodeAt(bi)) bi++;
  }
  if (bi === qLen) {
    score += 10;
    // Exact basename prefix bonus
    if (tLen - basenameStart >= qLen) {
      let prefix = true;
      for (let k = 0; k < qLen; k++) {
        if (target.charCodeAt(basenameStart + k) !== query.charCodeAt(k)) {
          prefix = false;
          break;
        }
      }
      if (prefix) score += 15;
    }
  }

  return score;
}

/**
 * Rank `pool` against `query`: empty query → the first `limit` paths; otherwise
 * every path with score > 0, by score desc then length asc, capped at `limit`.
 */
export function rankSearch(
  pool: readonly string[],
  poolLower: readonly string[],
  query: string,
  limit = 500,
): string[] {
  if (!query) return pool.slice(0, limit);

  const q = query.toLowerCase();
  const scored: { path: string; score: number }[] = [];
  for (let i = 0; i < pool.length; i++) {
    const score = fuzzyScore(poolLower[i], q);
    if (score > 0) {
      scored.push({ path: pool[i], score });
    }
  }

  scored.sort((a, b) => b.score - a.score || a.path.length - b.path.length);
  return scored.slice(0, limit).map((s) => s.path);
}

export interface MatchRun {
  text: string;
  matched: boolean;
}

/**
 * Split `text` into matched / unmatched runs for highlighting, greedily matching
 * `queryLower` left to right. Empty runs are dropped. Callers only use this with
 * a non-empty query and text (the row shows plain text otherwise).
 */
export function matchRuns(text: string, queryLower: string): MatchRun[] {
  const runs: MatchRun[] = [];
  const push = (t: string, matched: boolean): void => {
    if (t) runs.push({ text: t, matched });
  };
  if (text.length === 0) return runs;

  const lower = text.toLowerCase();
  let qi = 0;
  let runStart = 0;
  let runMatching = qi < queryLower.length && lower[0] === queryLower[0];
  if (runMatching) qi++;

  for (let ci = 1; ci < text.length; ci++) {
    const isMatch = qi < queryLower.length && lower[ci] === queryLower[qi];
    if (isMatch !== runMatching) {
      push(text.slice(runStart, ci), runMatching);
      runStart = ci;
      runMatching = isMatch;
    }
    if (isMatch) qi++;
  }
  push(text.slice(runStart), runMatching);
  return runs;
}
