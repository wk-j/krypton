// Krypton — the injectable-verb lookup for composition (spec 191, ADR-0012).
//
// Maps a prompt-verb name to its rendered prompt, called with NO args so a token
// resolves to the "the issue you are working on" variant (the composing verb names
// the concrete issue once in its own prose). Control-op verbs — e.g. the
// `#dispatch-github-issue` dispatch, which performs an operation rather than
// carrying prompt text — are intentionally ABSENT: they cannot be tokens.

import {
  analyzeGithubIssuePrompt,
  fixGithubIssuePrompt,
  postGithubCommentPrompt,
  tagGithubIssuePrompt,
} from './harness-prompts';

/** Verb name → builder (rendered with no ref). Extend here to make a prompt-verb
 *  embeddable as a `{{#name}}` token. */
const INJECTABLE_VERBS: Record<string, () => string> = {
  'analyze-github-issue': () => analyzeGithubIssuePrompt(),
  'fix-github-issue': () => fixGithubIssuePrompt(),
  'tag-github-issue': () => tagGithubIssuePrompt(),
  'post-github-comment': () => postGithubCommentPrompt(),
};

/** The `lookup` passed to `resolveVerbTokens`. Returns a verb's rendered prompt, or
 *  `undefined` for an unknown / non-injectable name. */
export function injectableVerbPrompt(name: string): string | undefined {
  const build = INJECTABLE_VERBS[name];
  return build ? build() : undefined;
}

/** The names of every injectable verb — the roster the inline `#` verb palette offers
 *  for autocompletion (verb-palette.ts). Sorted for a stable palette order. */
export function injectableVerbNames(): string[] {
  return Object.keys(INJECTABLE_VERBS).sort();
}
