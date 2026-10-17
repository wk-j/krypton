// Krypton — generative UI front end (spec 309).
// Source → tokens → AST → catalog check, plus the wire format around the
// language itself: the source cap, the optional `version 2` header and the
// retired v1 JSON fence. Block-level fail-closed: one error-severity
// diagnostic and there is no program.

import type { Program } from './ast';
import { LIMITS } from './limits';
import { parse } from './parser';
import type { Diagnostic } from './types';
import { validate } from './validate';

export function compile(source: string): { program: Program | null; diagnostics: readonly Diagnostic[] } {
  if (source.length > LIMITS.sourceChars) {
    const message = `a krypton-ui spec may be at most ${LIMITS.sourceChars} characters, got ${source.length}`;
    return { program: null, diagnostics: [{ severity: 'error', line: 1, column: 1, message }] };
  }
  // The header is optional. Only its own text is sliced away — the newlines around it
  // stay, so every diagnostic still points at the line the user sees in the fence.
  const header = /^((?:[ \t]*\r?\n)*)[ \t]*version[ \t]+2[ \t]*(?=\r?\n|$)/.exec(source);
  if (header === null && source.trimStart().startsWith('{')) {
    return {
      program: null,
      diagnostics: [{ severity: 'error', line: 1, column: 1, message: 'krypton-ui v1 JSON is no longer accepted' }],
    };
  }
  const parsed = parse(header === null ? source : header[1] + source.slice(header[0].length));
  const diagnostics: Diagnostic[] = [...parsed.diagnostics];
  if (parsed.program !== null && !diagnostics.some((diagnostic) => diagnostic.severity === 'error')) {
    diagnostics.push(...validate(parsed.program));
  }
  const failed = diagnostics.some((diagnostic) => diagnostic.severity === 'error');
  return { program: failed ? null : parsed.program, diagnostics };
}

/** FNV-1a over the source: the identity half of the `(lane, item, index, sourceHash)` panel-state key. */
export function uiSourceHash(source: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < source.length; i++) hash = Math.imul(hash ^ source.charCodeAt(i), 0x01000193);
  return (hash >>> 0).toString(16);
}
