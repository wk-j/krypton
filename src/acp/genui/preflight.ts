// Spec 312: validate a complete #ui reply before any assistant text is published.
// This checks the reply envelope; compile() remains the language authority.

import { compile } from './compile';

export const UI_REPLY_MAX_CHARS = 64_000;
export const UI_REPLY_MAX_SEGMENTS = 128;

export type UiPreflight =
  | { kind: 'prose' }
  | { kind: 'valid'; source: string }
  | { kind: 'invalid'; diagnostics: readonly string[] };

const FENCE_LINE = /^ {0,3}(\x60{3,}|~{3,})([^\r\n]*)$/;
const FENCE_LIKE = /\x60{3,}|~{3,}/;

export function preflightUiReply(text: string): UiPreflight {
  if (text.length > UI_REPLY_MAX_CHARS) {
    return { kind: 'invalid', diagnostics: [`reply exceeds ${UI_REPLY_MAX_CHARS} characters`] };
  }
  const lines = text.split(/\r?\n/);
  let start = -1;
  let opening = -1;
  let end = -1;
  let marker = '';
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    const fence = FENCE_LINE.exec(line);
    if (start === -1) {
      if (fence === null) {
        if (FENCE_LIKE.test(line)) {
          return { kind: 'invalid', diagnostics: [`line ${i + 1}: malformed code fence`] };
        }
        continue;
      }
      if (end !== -1) return { kind: 'invalid', diagnostics: ['reply contains more than one code fence'] };
      if (fence[1] !== '\x60\x60\x60' || fence[2].trim() !== 'krypton-ui') {
        return { kind: 'invalid', diagnostics: [`line ${i + 1}: expected a krypton-ui code fence`] };
      }
      start = i;
      opening = i;
      marker = fence[1];
      continue;
    }
    if (fence !== null && fence[1] === marker && fence[2].trim() === '') {
      end = i;
      start = -1;
    }
  }
  if (start !== -1) return { kind: 'invalid', diagnostics: ['krypton-ui code fence is not closed'] };
  if (end === -1) {
    if (lines.some((line) => /^\s*(?:version\s+2\b|\$[A-Za-z_]\w*\s*=|[A-Z][A-Za-z]+\s*\()/.test(line))) {
      return { kind: 'invalid', diagnostics: ['UI source must be inside a krypton-ui code fence'] };
    }
    return text.trim() ? { kind: 'prose' } : { kind: 'invalid', diagnostics: ['reply is empty'] };
  }
  const source = lines.slice(opening + 1, end).join('\n');
  if (!source.trim()) return { kind: 'invalid', diagnostics: ['krypton-ui code fence is empty'] };
  const { program, diagnostics } = compile(source);
  if (program === null) {
    const errors = diagnostics.filter((diagnostic) => diagnostic.severity === 'error')
      .map((diagnostic) => `line ${diagnostic.line}, column ${diagnostic.column}: ${diagnostic.message}`);
    return { kind: 'invalid', diagnostics: errors.length ? errors : ['krypton-ui did not compile'] };
  }
  return { kind: 'valid', source };
}

export function formatUiFailure(text: string, diagnostic: string): string {
  let longest = 3;
  for (const match of text.matchAll(/\x60+/g)) longest = Math.max(longest, match[0].length + 1);
  const fence = '\x60'.repeat(longest);
  return `UI unavailable after validation: ${diagnostic}\n\n${fence}text\n${text}\n${fence}`;
}
