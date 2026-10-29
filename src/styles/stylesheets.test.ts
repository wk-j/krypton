import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';

import { describe, expect, it } from 'vitest';

// Every sheet must close every block it opens. A build concatenates sheets
// before minifying (the loopback app emits one `app.css`), so one unclosed
// `@layer lb.kit {` swallows every later sheet: their `@layer krypton.*`
// blocks become `lb.kit.krypton.*`, ranked by first appearance, and the GenUI
// gallery's preview reset (`krypton.reset`, padding 0) ended up above every
// component rule. esbuild only warns, so nothing else fails on it.

const SRC = join(import.meta.dirname, '..');

function sheets(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return sheets(path);
    return entry.name.endsWith('.css') ? [path] : [];
  });
}

/** `null` when balanced, else where the first unmatched brace sits. */
function unbalanced(css: string): string | null {
  const open: number[] = [];
  let line = 1;
  for (let i = 0; i < css.length; i++) {
    const c = css[i];
    if (c === '\n') {
      line++;
    } else if (c === '/' && css[i + 1] === '*') {
      const end = css.indexOf('*/', i + 2);
      const stop = end < 0 ? css.length : end + 2;
      line += css.slice(i, stop).split('\n').length - 1;
      i = stop - 1;
    } else if (c === '"' || c === "'") {
      let j = i + 1;
      while (j < css.length && css[j] !== c && css[j] !== '\n') j += css[j] === '\\' ? 2 : 1;
      i = j;
    } else if (c === '{') {
      open.push(line);
    } else if (c === '}') {
      if (open.pop() === undefined) return `stray "}" at line ${line}`;
    }
  }
  return open.length === 0 ? null : `"{" at line ${open[open.length - 1]} is never closed`;
}

describe('stylesheets', () => {
  it('close every block they open', () => {
    const offenders = sheets(SRC).flatMap((path) => {
      const problem = unbalanced(readFileSync(path, 'utf8'));
      return problem === null ? [] : [`${relative(SRC, path)}: ${problem}`];
    });
    expect(offenders).toEqual([]);
  });
});
