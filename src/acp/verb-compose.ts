// Krypton — verb composition (spec 191, ADR-0012).
//
// A verb name is a TOKEN: `{{#verb-name}}` embedded inline in another verb's prompt.
// `resolveVerbTokens` substitutes each token with the referenced verb's rendered
// prompt text, recursing so a composed verb may embed another, and yields ONE
// combined prompt. This is inline template substitution resolved once — NOT a
// multi-turn runner, queue, or serial pipeline. Only prompt-verbs are injectable
// (a token resolves to prompt text); control-op verbs (e.g. dispatch) have no text
// to substitute and are absent from the lookup.

/** Matches `{{#verb-name}}` where the name is lowercase kebab-case, mirroring the
 *  `#` palette token grammar. */
const VERB_TOKEN = /\{\{#([a-z0-9][a-z0-9-]*)\}\}/g;

export interface ResolveOptions {
  /** Max nesting depth before bailing out (guards runaway/deep composition). */
  maxDepth?: number;
}

/** Thrown for an unknown/non-injectable verb, a cycle, or excessive nesting. The
 *  caller (runHashCommand) catches this and flashes the message instead of sending
 *  a broken prompt. */
export class VerbCompositionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'VerbCompositionError';
  }
}

/** Replace every `{{#verb}}` token in `text` with `lookup(verb)`, recursively.
 *  @param lookup returns a verb's rendered prompt, or `undefined` if the name is
 *         unknown or the verb is not injectable (control-op). */
export function resolveVerbTokens(
  text: string,
  lookup: (name: string) => string | undefined,
  opts: ResolveOptions = {},
): string {
  const maxDepth = opts.maxDepth ?? 4;
  const expand = (src: string, depth: number, seen: readonly string[]): string => {
    if (depth > maxDepth) {
      throw new VerbCompositionError(`verb composition too deep (> ${maxDepth}): ${seen.join(' → ')}`);
    }
    // `replace` with a global regex resets lastIndex each call, so nested expands
    // over fresh substrings are safe.
    return src.replace(VERB_TOKEN, (_match, name: string) => {
      if (seen.includes(name)) {
        throw new VerbCompositionError(`cyclic verb composition: ${[...seen, name].join(' → ')}`);
      }
      const resolved = lookup(name);
      if (resolved === undefined) {
        throw new VerbCompositionError(`unknown or non-injectable verb: #${name}`);
      }
      return expand(resolved, depth + 1, [...seen, name]);
    });
  };
  return expand(text, 0, []);
}

/** True when `text` contains at least one verb token. */
export function hasVerbTokens(text: string): boolean {
  return /\{\{#[a-z0-9][a-z0-9-]*\}\}/.test(text);
}
