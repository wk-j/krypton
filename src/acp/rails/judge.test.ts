import { describe, expect, it } from 'vitest';

import type { AssistTaskConfig } from '../assist/types';
import { judgePayload, railsJudge } from './judge';
import type { RailsCheckResult, RailsFindingSet, RailsGlossaryEntry, RailsJudgeContext, RailsRule } from './types';

function rule(id: string, text = `rule text for ${id}`, extra: Partial<RailsRule> = {}): RailsRule {
  return { id, source: id.split('#')[0], appliesTo: [], check: null, text, ...extra };
}

function ctx(over: Partial<RailsJudgeContext> = {}): RailsJudgeContext {
  return {
    rules: [rule('docs/adr/0008-x.md#1'), rule('AGENTS.md#2')],
    glossary: [{ id: 'CONTEXT.md#Lane', term: 'Lane', definition: 'one agent session', avoid: ['session'] }],
    diffstat: [
      { path: 'src/acp/a.ts', status: 'M', added: 3, removed: 1 },
      { path: 'src/new.ts', status: '?', added: 0, removed: 0 },
    ],
    diff: 'diff --git a/src/acp/a.ts b/src/acp/a.ts\n@@ -1 +1 @@\n-old\n+new\n',
    untracked: [{ path: 'src/new.ts', head: 'export const x = 1;' }],
    failedChecks: [],
    ...over,
  };
}

function cfg(maxInputChars = 32_000): AssistTaskConfig {
  return { mode: 'auto', backendId: 'claude', modelId: 'haiku', timeoutMs: 60_000, maxInputChars, options: {} };
}

function failed(name: string, outputTail: string): RailsCheckResult {
  return { name, outcome: 'fail', exitCode: 2, durationMs: 10, outputTail };
}

describe('judgePayload', () => {
  it('orders rules, failed checks, diffstat, diff, then glossary', () => {
    const c = ctx({
      rules: [rule('docs/adr/0008-x.md#1', 'no blur', { appliesTo: ['src/**'], check: 'arch' })],
      failedChecks: [failed('typecheck', 'error TS2322 here')],
    });
    const { text, rulesKept } = judgePayload(c, cfg());

    expect(rulesKept).toBe(1);
    expect(text).toContain('[docs/adr/0008-x.md#1] no blur');
    expect(text).toContain('applies to: src/**');
    expect(text).toContain('enforced by check:arch');
    const order = ['[docs/adr/0008-x.md#1]', 'error TS2322', 'M +3 -1 src/acp/a.ts', '+new', 'export const x = 1;', '[CONTEXT.md#Lane]']
      .map((needle) => text.indexOf(needle));
    expect(order.every((at) => at >= 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
  });

  it('keeps the first rules whole in source order and says how many were kept', () => {
    const rules = Array.from({ length: 60 }, (_, i) => rule(`docs/adr/00${i}-x.md#1`, 'r'.repeat(200)));
    const { text, rulesKept } = judgePayload(ctx({ rules }), cfg(4_000));

    expect(rulesKept).toBeGreaterThan(0);
    expect(rulesKept).toBeLessThan(60);
    expect(text).toContain(`rules truncated (${rulesKept} of 60)`);
    expect(text).toContain(`[docs/adr/00${rulesKept - 1}-x.md#1]`);
    expect(text).not.toContain(`[docs/adr/00${rulesKept}-x.md#1]`);
    // Rules never squeeze the diff out entirely.
    expect(text).toContain('+new');
  });

  it('caps each failed-check tail at 2000 chars, keeping the end', () => {
    const long = `${'x'.repeat(5_000)}THE-END`;
    const { text } = judgePayload(ctx({ failedChecks: [failed('tests', long)] }), cfg());
    expect(text).toContain('THE-END');
    expect(text).not.toContain('x'.repeat(2_000));
    expect(text).toContain('x'.repeat(1_990));
  });

  it('truncates the diff with a marker and never exceeds maxInputChars', () => {
    const diff = `diff --git a/src/acp/a.ts b/src/acp/a.ts\n@@ -1 +1 @@\n${'+line of code\n'.repeat(6_000)}`;
    const c = ctx({ diff, failedChecks: [failed('tests', 'y'.repeat(3_000))] });
    for (const max of [4_000, 9_999, 32_000]) {
      const { text } = judgePayload(c, cfg(max));
      expect(text.length).toBeLessThanOrEqual(max);
      expect(text).toContain('[diff truncated]');
      expect(text).toContain('[docs/adr/0008-x.md#1]');
    }
  });

  it('reports the ids actually sent: kept rules plus glossary entries that fit', () => {
    const rules = Array.from({ length: 60 }, (_, i) => rule(`docs/adr/00${i}-x.md#1`, 'r'.repeat(200)));
    const glossary: RailsGlossaryEntry[] = Array.from({ length: 10 }, (_, i) => ({
      id: `CONTEXT.md#T${i}`, term: `T${i}`, definition: 'd'.repeat(100), avoid: [],
    }));
    const { text, rulesKept, sentIds } = judgePayload(ctx({ rules, glossary }), cfg(4_000));
    const ruleIds = rules.slice(0, rulesKept).map((r) => r.id);
    const glossaryIds = glossary.map((g) => g.id).filter((id) => text.includes(`[${id}]`));
    expect(glossaryIds.length).toBeGreaterThan(0);
    expect(glossaryIds.length).toBeLessThan(10);
    expect([...sentIds]).toEqual([...ruleIds, ...glossaryIds]);
  });

  it('caps the glossary at 4000 chars with whole entries', () => {
    const glossary: RailsGlossaryEntry[] = Array.from({ length: 40 }, (_, i) => ({
      id: `CONTEXT.md#T${i}`, term: `T${i}`, definition: 'd'.repeat(300), avoid: [],
    }));
    const { text } = judgePayload(ctx({ glossary }), cfg(80_000));
    const section = text.slice(text.indexOf('## Glossary'));
    expect(section.length).toBeLessThanOrEqual(4_000);
    expect(section).toContain('[CONTEXT.md#T0]');
    expect(section).not.toContain('[CONTEXT.md#T39]');
  });
});

describe('railsJudge.parse', () => {
  const c = ctx();
  const parse = (raw: string): RailsFindingSet | null => railsJudge.parse(raw, cfg(), c);

  it('keeps valid findings and counts every invalid entry as dropped', () => {
    const reply = `Sure: ${JSON.stringify({
      findings: [
        { rule: 'docs/adr/0008-x.md#1', severity: 'violation', file: 'src/acp/a.ts', line: 3, note: 'ใช้ blur ใน stylesheet' },
        { rule: 'CONTEXT.md#Lane', severity: 'suspect', file: 'src/new.ts', note: '  ใช้คำว่า   session  ' },
        { rule: 'docs/adr/9999-nope.md#1', severity: 'violation', file: 'src/acp/a.ts', note: 'unknown rule' },
        { rule: 'AGENTS.md#2', severity: 'warning', file: 'src/acp/a.ts', note: 'bad severity' },
        { rule: 'AGENTS.md#2', severity: 'suspect', file: 'src/other.ts', note: 'outside diffstat' },
        { rule: 'AGENTS.md#2', severity: 'suspect', file: 'src/acp/a.ts', line: 0, note: 'line zero' },
        { rule: 'AGENTS.md#2', severity: 'suspect', file: 'src/acp/a.ts', line: 1.5, note: 'fractional' },
        { rule: 'AGENTS.md#2', severity: 'suspect', file: 'src/acp/a.ts', note: '' },
        { rule: 'AGENTS.md#2', severity: 'suspect', file: 'src/acp/a.ts', note: 'n'.repeat(241) },
        'not an object',
      ],
    })} done`;

    expect(parse(reply)).toEqual({
      findings: [
        { rule: 'docs/adr/0008-x.md#1', severity: 'violation', file: 'src/acp/a.ts', line: 3, note: 'ใช้ blur ใน stylesheet' },
        { rule: 'CONTEXT.md#Lane', severity: 'suspect', file: 'src/new.ts', line: null, note: 'ใช้คำว่า session' },
      ],
      dropped: 8,
    });
  });

  it('accepts an empty findings array as clean', () => {
    expect(parse('{"findings":[]}')).toEqual({ findings: [], dropped: 0 });
  });

  it('returns null without an object or a findings array', () => {
    expect(parse('no json here')).toBeNull();
    expect(parse('{"findings": "none"}')).toBeNull();
    expect(parse('{"result": []}')).toBeNull();
    expect(parse('{not json}')).toBeNull();
  });

  it('keeps at most 20 findings', () => {
    const findings = Array.from({ length: 25 }, (_, i) =>
      ({ rule: 'AGENTS.md#2', severity: 'suspect', file: 'src/acp/a.ts', line: i + 1, note: `n${i}` }));
    const set = parse(JSON.stringify({ findings }));
    expect(set?.findings).toHaveLength(20);
    expect(set?.findings[19].line).toBe(20);
  });

  it('drops findings citing a rule that was cut from the payload', () => {
    const rules = Array.from({ length: 60 }, (_, i) => rule(`docs/adr/00${i}-x.md#1`, 'r'.repeat(200)));
    const big = ctx({ rules });
    const { rulesKept } = judgePayload(big, cfg(4_000));
    const reply = JSON.stringify({
      findings: [
        { rule: `docs/adr/00${rulesKept - 1}-x.md#1`, severity: 'suspect', file: 'src/acp/a.ts', note: 'kept' },
        { rule: `docs/adr/00${rulesKept}-x.md#1`, severity: 'suspect', file: 'src/acp/a.ts', note: 'not sent' },
      ],
    });
    const set = railsJudge.parse(reply, cfg(4_000), big);
    expect(set?.findings.map((f) => f.note)).toEqual(['kept']);
    expect(set?.dropped).toBe(1);
  });
});
