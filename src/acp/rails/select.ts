// Krypton — Rails verifier (spec 337): which rails a change touches.
//
// A rule applies when it has no `Applies to:` or one of its globs matches a
// changed path. A glossary entry applies when the added lines use its term or
// one of its `_Avoid_` words.

import { matchesAnyGlob } from './glob';
import type { RailsGlossaryEntry, RailsRule } from './types';

export function selectRules(rules: readonly RailsRule[], changedPaths: readonly string[]): RailsRule[] {
  return rules.filter((rule) =>
    rule.appliesTo.length === 0 || changedPaths.some((path) => matchesAnyGlob(rule.appliesTo, path)));
}

/** The `+` lines of a unified diff without their leading `+`; `+++` file headers are skipped. */
export function addedLines(diff: string): string[] {
  const added: string[] = [];
  let inHunk = false;
  for (const line of diff.split('\n')) {
    if (line.startsWith('diff ')) {
      inHunk = false;
      continue;
    }
    if (line.startsWith('@@')) {
      inHunk = true;
      continue;
    }
    if (!line.startsWith('+')) continue;
    // Outside a hunk `+++ b/path` is a header; inside one it is content.
    if (!inHunk && line.startsWith('+++')) continue;
    added.push(line.slice(1));
  }
  return added;
}

function escapeRegExp(text: string): string {
  return text.replace(/[\\^$.*+?()[\]{}|/]/g, '\\$&');
}

function wholeWord(word: string): RegExp {
  return new RegExp(`(?<![\\p{L}\\p{N}_])${escapeRegExp(word)}(?![\\p{L}\\p{N}_])`, 'iu');
}

export function selectGlossary(
  entries: readonly RailsGlossaryEntry[],
  added: readonly string[],
): RailsGlossaryEntry[] {
  if (added.length === 0) return [];
  const text = added.join('\n');
  return entries.filter((entry) =>
    [entry.term, ...entry.avoid]
      .map((word) => word.trim())
      .some((word) => word !== '' && wholeWord(word).test(text)));
}
