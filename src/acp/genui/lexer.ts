// Krypton — generative UI lexer (spec 309).
// One pass over a fence body. Newlines matter only at bracket depth 0, and only
// where the line before can end a statement and the line after cannot continue
// one, so a wrapped argument list never needs a continuation marker.
// Nothing here throws: a malformed literal reports a diagnostic and recovers.

import { PRECEDENCE } from './ast';
import { tableHas } from './catalog';
import type { Diagnostic } from './types';

export type TokenType =
  | 'ident'
  | 'state'
  | 'number'
  | 'string'
  | 'punct'
  /** Statement separator at bracket depth 0. */
  | 'newline'
  /** Opening backtick. */
  | 'tpl-start'
  /** Literal text inside a template; never empty. */
  | 'tpl-chunk'
  /** `${` */
  | 'tpl-expr'
  /** The `}` closing an interpolation. */
  | 'tpl-expr-end'
  /** Closing backtick. */
  | 'tpl-end'
  /** A character the language has no use for; always a parse error where it lands. */
  | 'unknown'
  | 'eof';

export interface Token {
  readonly type: TokenType;
  /** Lexeme for identifiers and punctuation; the cooked value for strings and template text. */
  readonly text: string;
  /** `number` tokens only. */
  readonly num?: number;
  readonly line: number;
  readonly column: number;
}

/** Longest match first: `**` before `*`, `=>` before `=`, `//` is handled before `/`. */
const PUNCTUATION: readonly string[] = [
  '===', '!==', '==', '!=', '<=', '>=', '&&', '||', '??', '**', '=>',
  '(', ')', '[', ']', '{', '}', ',', ':', ';', '.', '?', '=',
  '+', '-', '*', '/', '%', '<', '>', '!',
];

/** Punctuation that cannot end a statement, besides every binary operator. */
const INCOMPLETE_AFTER: Readonly<Record<string, true>> = {
  '=': true, '=>': true, ',': true, ':': true, '?': true, '.': true,
  '(': true, '[': true, '{': true,
};

const IDENT_START = /[A-Za-z_]/;
const IDENT_PART = /[A-Za-z0-9_]/;
const DIGIT = /[0-9]/;
const HEX = /[0-9A-Fa-f]/;

interface TemplateMode {
  readonly kind: 'template';
  readonly line: number;
  readonly column: number;
}

interface InterpMode {
  readonly kind: 'interp';
  /** Bracket depth the `${` opened at; the `}` that returns to it closes the interpolation. */
  readonly depth: number;
}

type Mode = TemplateMode | InterpMode;

export function tokenize(source: string): { tokens: Token[]; diagnostics: Diagnostic[] } {
  const tokens: Token[] = [];
  const diagnostics: Diagnostic[] = [];
  const modes: Mode[] = [];
  let i = 0;
  let line = 1;
  let lineStart = 0;
  let depth = 0;
  let pending: { line: number; column: number } | null = null;

  const column = (): number => i - lineStart + 1;

  const error = (message: string, atLine: number, atColumn: number): void => {
    diagnostics.push({ severity: 'error', line: atLine, column: atColumn, message });
  };

  const add = (type: TokenType, text: string, atLine: number, atColumn: number, num?: number): void => {
    if (pending !== null) {
      const prev = tokens[tokens.length - 1];
      const openEnd = prev !== undefined && prev.type === 'punct'
        && (tableHas(PRECEDENCE, prev.text) || tableHas(INCOMPLETE_AFTER, prev.text));
      const openStart = type === 'punct' && tableHas(PRECEDENCE, text);
      if (prev !== undefined && !openEnd && !openStart) {
        tokens.push({ type: 'newline', text: '\n', line: pending.line, column: pending.column });
      }
      pending = null;
    }
    tokens.push({ type, text, num, line: atLine, column: atColumn });
  };

  /** Consumes a backslash escape. Returns '' when the literal ends on it; the caller reports that. */
  const readEscape = (): string => {
    const escLine = line;
    const escColumn = column();
    i += 1;
    const ch = i < source.length ? source[i] : '';
    if (ch === '' || ch === '\n') return '';
    i += 1;
    switch (ch) {
      case 'n': return '\n';
      case 't': return '\t';
      case 'r': return '\r';
      case '\\': case '"': case "'": case '`': case '$': return ch;
      case 'u': {
        if (source[i] !== '{') {
          error("expected '{' after '\\u'", escLine, escColumn);
          return '';
        }
        let j = i + 1;
        let hex = '';
        while (j < source.length && HEX.test(source[j])) {
          hex += source[j];
          j += 1;
        }
        const code = hex === '' ? Number.NaN : Number.parseInt(hex, 16);
        if (hex === '' || source[j] !== '}' || code > 0x10ffff) {
          error(`invalid unicode escape '\\u{${hex}}'`, escLine, escColumn);
          return '';
        }
        i = j + 1;
        return String.fromCodePoint(code);
      }
      default:
        error(`unknown escape '\\${ch}'`, escLine, escColumn);
        return ch;
    }
  };

  const scanString = (): void => {
    const quote = source[i];
    const startLine = line;
    const startColumn = column();
    i += 1;
    let text = '';
    for (;;) {
      if (i >= source.length || source[i] === '\n') {
        error('unterminated string', startLine, startColumn);
        break;
      }
      const ch = source[i];
      if (ch === quote) {
        i += 1;
        break;
      }
      if (ch === '\\') {
        text += readEscape();
        continue;
      }
      text += ch;
      i += 1;
    }
    add('string', text, startLine, startColumn);
  };

  /** Text up to the next `${`, closing backtick, or end of input. */
  const scanTemplateChunk = (mode: TemplateMode): void => {
    const startLine = line;
    const startColumn = column();
    let text = '';
    const flush = (): void => {
      if (text !== '') add('tpl-chunk', text, startLine, startColumn);
    };
    for (;;) {
      if (i >= source.length) {
        error('unterminated template literal', mode.line, mode.column);
        flush();
        add('tpl-end', '`', line, column());
        modes.pop();
        return;
      }
      const ch = source[i];
      if (ch === '`') {
        flush();
        add('tpl-end', '`', line, column());
        i += 1;
        modes.pop();
        return;
      }
      if (ch === '$' && source[i + 1] === '{') {
        flush();
        add('tpl-expr', '${', line, column());
        i += 2;
        depth += 1;
        modes.push({ kind: 'interp', depth });
        return;
      }
      if (ch === '\\') {
        text += readEscape();
        continue;
      }
      if (ch === '\n') {
        text += '\n';
        i += 1;
        line += 1;
        lineStart = i;
        continue;
      }
      text += ch;
      i += 1;
    }
  };

  while (i < source.length) {
    const mode = modes[modes.length - 1];
    if (mode !== undefined && mode.kind === 'template') {
      scanTemplateChunk(mode);
      continue;
    }
    const ch = source[i];
    if (ch === '\n') {
      if (depth === 0 && pending === null) pending = { line, column: column() };
      i += 1;
      line += 1;
      lineStart = i;
      continue;
    }
    if (ch === ' ' || ch === '\t' || ch === '\r' || ch === '\f' || ch === '\v') {
      i += 1;
      continue;
    }
    if (ch === '/' && source[i + 1] === '/') {
      while (i < source.length && source[i] !== '\n') i += 1;
      continue;
    }
    if (ch === '"' || ch === "'") {
      scanString();
      continue;
    }
    if (ch === '`') {
      add('tpl-start', '`', line, column());
      modes.push({ kind: 'template', line, column: column() });
      i += 1;
      continue;
    }
    if (ch === '$' && source[i + 1] !== undefined && IDENT_START.test(source[i + 1])) {
      const startColumn = column();
      let j = i + 1;
      while (j < source.length && IDENT_PART.test(source[j])) j += 1;
      add('state', source.slice(i + 1, j), line, startColumn);
      i = j;
      continue;
    }
    if (IDENT_START.test(ch)) {
      const startColumn = column();
      let j = i;
      while (j < source.length && IDENT_PART.test(source[j])) j += 1;
      add('ident', source.slice(i, j), line, startColumn);
      i = j;
      continue;
    }
    if (DIGIT.test(ch)) {
      const startColumn = column();
      let j = i;
      while (j < source.length && DIGIT.test(source[j])) j += 1;
      if (source[j] === '.' && source[j + 1] !== undefined && DIGIT.test(source[j + 1])) {
        j += 1;
        while (j < source.length && DIGIT.test(source[j])) j += 1;
      }
      if (source[j] === 'e' || source[j] === 'E') {
        let k = j + 1;
        if (source[k] === '+' || source[k] === '-') k += 1;
        if (source[k] !== undefined && DIGIT.test(source[k])) {
          k += 1;
          while (k < source.length && DIGIT.test(source[k])) k += 1;
          j = k;
        }
      }
      const text = source.slice(i, j);
      add('number', text, line, startColumn, Number(text));
      i = j;
      continue;
    }
    const punct = PUNCTUATION.find((candidate) => source.startsWith(candidate, i));
    if (punct !== undefined) {
      const startColumn = column();
      if (punct === '}' && mode !== undefined && mode.kind === 'interp' && mode.depth === depth) {
        add('tpl-expr-end', '}', line, startColumn);
        depth -= 1;
        modes.pop();
        i += 1;
        continue;
      }
      if (punct === '(' || punct === '[' || punct === '{') depth += 1;
      if (punct === ')' || punct === ']' || punct === '}') depth = Math.max(0, depth - 1);
      add('punct', punct, line, startColumn);
      i += punct.length;
      continue;
    }
    // Not a diagnostic of its own: the parser names it where it actually breaks the
    // statement, so a stray character costs one error instead of two.
    const point = source.codePointAt(i);
    const text = point === undefined ? ch : String.fromCodePoint(point);
    add('unknown', text, line, column());
    i += text.length;
  }

  // Close whatever a truncated source left open so the parser sees one well-formed
  // template and reports nothing on top of the diagnostic below.
  for (let m = modes.length - 1; m >= 0; m -= 1) {
    const open = modes[m];
    if (open.kind === 'interp') {
      add('tpl-expr-end', '}', line, column());
      continue;
    }
    error('unterminated template literal', open.line, open.column);
    add('tpl-end', '`', line, column());
  }
  add('eof', '', line, column());
  return { tokens, diagnostics };
}
