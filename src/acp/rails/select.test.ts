import { describe, expect, it } from 'vitest';

import { addedLines, selectGlossary, selectRules } from './select';
import type { RailsGlossaryEntry, RailsRule } from './types';

function rule(id: string, appliesTo: string[] = []): RailsRule {
  return { id, source: id.split('#')[0], appliesTo, check: null, text: `rule ${id}` };
}

function term(name: string, avoid: string[] = []): RailsGlossaryEntry {
  return { id: `CONTEXT.md#${name}`, term: name, definition: `${name} means something`, avoid };
}

describe('selectRules', () => {
  const rules = [
    rule('docs/adr/0001-a.md#1', ['src/ui/**']),
    rule('AGENTS.md#1'),
    rule('docs/adr/0008-b.md#2', ['src/acp/**', 'src-tauri/**']),
  ];

  it('keeps unscoped rules and rules whose globs match a changed path, in source order', () => {
    expect(selectRules(rules, ['src-tauri/src/lib.rs']).map((r) => r.id))
      .toEqual(['AGENTS.md#1', 'docs/adr/0008-b.md#2']);
    expect(selectRules(rules, ['src/acp/x.ts', 'src/ui/y.ts']).map((r) => r.id))
      .toEqual(['docs/adr/0001-a.md#1', 'AGENTS.md#1', 'docs/adr/0008-b.md#2']);
  });

  it('keeps only unscoped rules when nothing matches', () => {
    expect(selectRules(rules, ['README.md']).map((r) => r.id)).toEqual(['AGENTS.md#1']);
    expect(selectRules(rules, []).map((r) => r.id)).toEqual(['AGENTS.md#1']);
  });
});

describe('addedLines', () => {
  it('returns added lines without the + and skips file headers', () => {
    const diff = [
      'diff --git a/x.ts b/x.ts',
      'index 1..2 100644',
      '--- a/x.ts',
      '+++ b/x.ts',
      '@@ -1,2 +1,3 @@',
      ' keep',
      '-old',
      '+new line',
      '+++counter',
      '+',
      'diff --git a/y.ts b/y.ts',
      '--- /dev/null',
      '+++ b/y.ts',
      '@@ -0,0 +1 @@',
      '+other',
    ].join('\n');
    expect(addedLines(diff)).toEqual(['new line', '++counter', '', 'other']);
  });

  it('is empty for an empty diff', () => {
    expect(addedLines('')).toEqual([]);
  });
});

describe('selectGlossary', () => {
  const entries = [term('Lane', ['session']), term('Rails'), term('Harness view', ['dashboard'])];

  it('matches a term or an avoid word as a whole word, case-insensitively', () => {
    expect(selectGlossary(entries, ['open a new SESSION here']).map((e) => e.term)).toEqual(['Lane']);
    expect(selectGlossary(entries, ['const lane = 1;']).map((e) => e.term)).toEqual(['Lane']);
    expect(selectGlossary(entries, ['the harness view shows']).map((e) => e.term)).toEqual(['Harness view']);
  });

  it('ignores substrings of longer words', () => {
    expect(selectGlossary(entries, ['const lanes = sessions; railsy();'])).toEqual([]);
    expect(selectGlossary(entries, ['laneId'])).toEqual([]);
  });

  it('selects nothing without added lines', () => {
    expect(selectGlossary(entries, [])).toEqual([]);
  });
});
