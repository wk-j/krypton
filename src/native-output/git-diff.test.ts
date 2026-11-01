import { describe, expect, it } from 'vitest';

import { isGitDiffCmdline, looksLikeUnifiedDiff, parseNativeDiff, wordMarks, NATIVE_DIFF_MAX_LINES } from './git-diff';

const MODIFIED = [
  'diff --git a/src/a.ts b/src/a.ts',
  'index 1111111..2222222 100644',
  '--- a/src/a.ts',
  '+++ b/src/a.ts',
  '@@ -10,3 +10,3 @@',
  ' keep();',
  "-console.error('failed', error);",
  "+this.notify('failed', error);",
  '@@ -40,2 +40,3 @@ export class A',
  ' x();',
  '--- a dashed line',
  '+added one',
  '+added two',
  '',
].join('\n');

describe('looksLikeUnifiedDiff', () => {
  it('accepts git diff and diff -u output, after leading blank lines', () => {
    expect(looksLikeUnifiedDiff(['', 'diff --git a/x b/x'])).toBe(true);
    expect(looksLikeUnifiedDiff(['--- a.txt\t2026-01-01', '+++ b.txt\t2026-01-02', '@@ -1 +1 @@'])).toBe(true);
  });

  it('rejects delta-decorated text, stat output, a lone --- line and blank output', () => {
    expect(looksLikeUnifiedDiff(['src/a.ts', '───────', '10 │ keep();'])).toBe(false);
    expect(looksLikeUnifiedDiff([' src/a.ts | 2 +-', ' 1 file changed'])).toBe(false);
    expect(looksLikeUnifiedDiff(['--- not a diff', 'plain'])).toBe(false);
    expect(looksLikeUnifiedDiff(['', '  '])).toBe(false);
  });
});

describe('parseNativeDiff', () => {
  it('numbers rows old-for-deletions/new-otherwise and separates hunks with a gap row', () => {
    const [file] = parseNativeDiff(MODIFIED) ?? [];
    expect(file.status).toBe('modified');
    expect(file.path).toBe('src/a.ts');
    expect(file.language).toBe('typescript');
    expect([file.added, file.deleted]).toEqual([3, 2]);
    expect(file.rows.map((r) => [r.kind, r.line, r.text])).toEqual([
      ['ctx', 10, 'keep();'],
      ['del', 11, "console.error('failed', error);"],
      ['add', 11, "this.notify('failed', error);"],
      ['gap', null, 'export class A'],
      ['ctx', 40, 'x();'],
      ['del', 41, '-- a dashed line'],
      ['add', 41, 'added one'],
      ['add', 42, 'added two'],
    ]);
  });

  it('marks words only on 1:1 replacement pairs', () => {
    const [file] = parseNativeDiff(MODIFIED) ?? [];
    const del = file.rows[1];
    const add = file.rows[2];
    expect(del.marks.map(([a, b]) => del.text.slice(a, b))).toEqual(['console', 'error']);
    expect(add.marks.map(([a, b]) => add.text.slice(a, b))).toEqual(['this', 'notify']);
    // One deletion replaced by two insertions: no pairing, no marks.
    expect(file.rows.slice(5).every((r) => r.marks.length === 0)).toBe(true);
  });

  it('keeps line numbers when terminal rows trimmed an empty context line to nothing', () => {
    // What the buffer gives back for ` one`, ` `, `-two`, `+TWO`, ` three`.
    const text = ['diff --git a/a.ts b/a.ts', '--- a/a.ts', '+++ b/a.ts', '@@ -1,4 +1,4 @@', ' one', '', '-two', '+TWO', ' three', '', ''].join('\n');
    const [file] = parseNativeDiff(text) ?? [];
    expect(file.rows.map((r) => [r.kind, r.line, r.text])).toEqual([
      ['ctx', 1, 'one'],
      ['ctx', 2, ''],
      ['del', 3, 'two'],
      ['add', 3, 'TWO'],
      ['ctx', 4, 'three'],
    ]);
  });

  it('classifies added, deleted, renamed and binary files', () => {
    const text = [
      'diff --git a/new.rs b/new.rs',
      'new file mode 100644',
      '--- /dev/null',
      '+++ b/new.rs',
      '@@ -0,0 +1 @@',
      '+fn main() {}',
      'diff --git a/gone.md b/gone.md',
      'deleted file mode 100644',
      '--- a/gone.md',
      '+++ /dev/null',
      '@@ -1 +0,0 @@',
      '-bye',
      'diff --git a/old.ts b/moved.ts',
      'similarity index 100%',
      'rename from old.ts',
      'rename to moved.ts',
      'diff --git a/logo.png b/logo.png',
      'Binary files a/logo.png and b/logo.png differ',
    ].join('\n');
    const files = parseNativeDiff(text) ?? [];
    expect(files.map((f) => [f.status, f.path, f.oldPath, f.rows.length])).toEqual([
      ['added', 'new.rs', null, 1],
      ['deleted', 'gone.md', null, 1],
      ['renamed', 'moved.ts', 'old.ts', 0],
      ['binary', 'logo.png', null, 0],
    ]);
    expect(files[1].language).toBe('markdown');
  });

  it('returns null for empty output, combined merge diffs and oversized diffs', () => {
    expect(parseNativeDiff('')).toBeNull();
    expect(parseNativeDiff('diff --cc a.ts\nindex 1,2..3\n--- a/a.ts\n+++ b/a.ts\n@@@ -1,1 -1,1 +1,1 @@@\n- a\n -b\n++c\n')).toBeNull();
    const big = `${MODIFIED}${'+x\n'.repeat(NATIVE_DIFF_MAX_LINES)}`;
    expect(parseNativeDiff(big)).toBeNull();
  });
});

describe('wordMarks', () => {
  it('skips pairs with too little in common', () => {
    expect(wordMarks('alpha beta gamma', 'one two three four')).toBeNull();
  });
});

describe('isGitDiffCmdline', () => {
  it('matches git diff with or without --no-pager, nothing else', () => {
    expect(isGitDiffCmdline('git diff')).toBe(true);
    expect(isGitDiffCmdline('git --no-pager diff --staged')).toBe(true);
    expect(isGitDiffCmdline('git difftool')).toBe(false);
    expect(isGitDiffCmdline('git show')).toBe(false);
    expect(isGitDiffCmdline('echo git diff')).toBe(false);
  });
});
