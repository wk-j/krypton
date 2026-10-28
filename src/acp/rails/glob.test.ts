import { describe, expect, it } from 'vitest';

import { globToRegExp, matchesAnyGlob } from './glob';

function matches(glob: string, path: string): boolean {
  return globToRegExp(glob).test(path);
}

describe('globToRegExp', () => {
  it('lets ** span any depth, including zero directories', () => {
    expect(matches('src/acp/**', 'src/acp/x.ts')).toBe(true);
    expect(matches('src/acp/**', 'src/acp/a/b/c.ts')).toBe(true);
    expect(matches('src/**/x.ts', 'src/x.ts')).toBe(true);
    expect(matches('src/**/x.ts', 'src/a/b/x.ts')).toBe(true);
    expect(matches('**/*.css', 'top.css')).toBe(true);
    expect(matches('**/*.css', 'src/ui/deep/a.css')).toBe(true);
    expect(matches('src/acp/**', 'src/acpx/y.ts')).toBe(false);
    expect(matches('src/**/x.ts', 'src/a/bx.ts')).toBe(false);
  });

  it('keeps * and ? inside one segment', () => {
    expect(matches('src/*.ts', 'src/a.ts')).toBe(true);
    expect(matches('src/*.ts', 'src/a/b.ts')).toBe(false);
    expect(matches('src/?.ts', 'src/a.ts')).toBe(true);
    expect(matches('src/?.ts', 'src/ab.ts')).toBe(false);
    expect(matches('src/?.ts', 'src//.ts')).toBe(false);
    expect(matches('src/a**b.ts', 'src/a/b.ts')).toBe(false);
    expect(matches('src/a**b.ts', 'src/axyb.ts')).toBe(true);
  });

  it('treats dots and other regex characters literally', () => {
    expect(matches('src/*.ts', 'src/axts')).toBe(false);
    expect(matches('a+b(c).md', 'a+b(c).md')).toBe(true);
    expect(matches('a+b(c).md', 'aab(c)xmd')).toBe(false);
    expect(matches('*.md', '.hidden.md')).toBe(true);
  });

  it('is anchored at both ends', () => {
    expect(matches('src/*.ts', 'x/src/a.ts')).toBe(false);
    expect(matches('src/*.ts', 'src/a.tsx')).toBe(false);
    expect(matches('AGENTS.md', 'docs/AGENTS.md')).toBe(false);
  });

  it('ignores a leading ./', () => {
    expect(matches('./src/*.ts', 'src/a.ts')).toBe(true);
  });
});

describe('matchesAnyGlob', () => {
  it('matches when any glob does', () => {
    expect(matchesAnyGlob(['src/ui/**', 'src/acp/**'], 'src/acp/x.ts')).toBe(true);
    expect(matchesAnyGlob(['src/ui/**', 'src/acp/**'], 'docs/x.md')).toBe(false);
    expect(matchesAnyGlob([], 'src/x.ts')).toBe(false);
  });
});
