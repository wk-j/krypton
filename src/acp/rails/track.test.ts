import { describe, expect, it } from 'vitest';

import {
  computeVerdict,
  diffFingerprint,
  latestRuleStatus,
  newRunId,
  previousCompletedRun,
  ruleStatuses,
  trackFindings,
} from './track';
import type {
  RailsCheckResult,
  RailsFinding,
  RailsRule,
  RailsRuleStatus,
  RailsRunRecord,
  RailsVerdict,
  TrackedFinding,
} from './types';

function finding(rule: string, file: string, over: Partial<RailsFinding> = {}): RailsFinding {
  return { rule, severity: 'violation', file, line: 1, note: 'ผิดกฎ', ...over };
}

function check(name: string, outcome: RailsCheckResult['outcome']): RailsCheckResult {
  return { name, outcome, exitCode: outcome === 'pass' ? 0 : 1, durationMs: 5, outputTail: '' };
}

function run(runId: string, over: Partial<RailsRunRecord> = {}): RailsRunRecord {
  return {
    version: 1,
    runId,
    startedAt: '2026-10-27T10:00:00Z',
    finishedAt: '2026-10-27T10:01:00Z',
    trigger: { kind: 'auto', laneId: null, laneName: null },
    fingerprint: 'f',
    verdict: 'clean',
    stale: false,
    checks: [],
    checksSkipped: false,
    judge: 'ran',
    judgeFailure: null,
    open: [],
    resolved: [],
    dropped: 0,
    rulesTruncated: null,
    ruleStatus: {},
    error: null,
    ...over,
  };
}

function rule(id: string, check: string | null = null): RailsRule {
  return { id, source: id.split('#')[0], appliesTo: [], check, text: id };
}

describe('newRunId', () => {
  it('formats a UTC stamp and four hex digits', () => {
    const now = new Date(Date.UTC(2026, 0, 2, 3, 4, 5));
    expect(newRunId(now, () => 0)).toBe('20260102T030405Z-0000');
    expect(newRunId(now, () => 0.999999999)).toBe('20260102T030405Z-ffff');
    expect(newRunId(now)).toMatch(/^[0-9]{8}T[0-9]{6}Z-[0-9a-f]{4}$/);
  });
});

describe('diffFingerprint', () => {
  it('is a stable SHA-256 hex that changes with any part', async () => {
    const base = { diffstat: [{ path: 'a.ts', status: 'M' as const, added: 1, removed: 0 }], diff: 'd', untracked: [] };
    const a = await diffFingerprint(base);
    expect(a).toMatch(/^[0-9a-f]{64}$/);
    expect(await diffFingerprint({ ...base })).toBe(a);
    expect(await diffFingerprint({ ...base, diff: 'e' })).not.toBe(a);
    expect(await diffFingerprint({ ...base, untracked: [{ path: 'n.ts', head: 'x' }] })).not.toBe(a);
    expect(await diffFingerprint({ ...base, diffstat: [{ ...base.diffstat[0], added: 2 }] })).not.toBe(a);
  });
});

describe('previousCompletedRun', () => {
  it('skips error runs and returns the newest completed one', () => {
    const history = [run('3', { verdict: 'error' }), run('2', { verdict: 'findings' }), run('1')];
    expect(previousCompletedRun(history)?.runId).toBe('2');
    expect(previousCompletedRun([run('1', { verdict: 'error' })])).toBeNull();
    expect(previousCompletedRun([])).toBeNull();
  });
});

describe('trackFindings across runs', () => {
  const A = 'docs/adr/0008-x.md#1';
  const B = 'AGENTS.md#2';
  const KNOWN: ReadonlySet<string> = new Set([A, B]);

  it('moves findings new → open → resolved, and carries unjudged ones as not-rechecked', () => {
    // Run 1: two new findings.
    const r1 = trackFindings({
      previous: null,
      findings: [finding(A, 'a.ts'), finding(B, 'b.ts')],
      selectedRuleIds: new Set([A, B]), knownIds: KNOWN,
      judged: true,
      runId: 'r1',
      finishedAt: 't1',
    });
    expect(r1.open.map((f) => [f.rule, f.status, f.firstSeenRunId])).toEqual([[A, 'new', 'r1'], [B, 'new', 'r1']]);
    expect(r1.resolved).toEqual([]);
    const run1 = run('r1', { open: r1.open, verdict: 'findings' });

    // Run 2: A again on another line; B's rule out of scope.
    const r2 = trackFindings({
      previous: run1,
      findings: [finding(A, 'a.ts', { line: 9, note: 'ย้ายบรรทัด' })],
      selectedRuleIds: new Set([A]), knownIds: KNOWN,
      judged: true,
      runId: 'r2',
      finishedAt: 't2',
    });
    expect(r2.open).toEqual<TrackedFinding[]>([
      { ...finding(A, 'a.ts', { line: 9, note: 'ย้ายบรรทัด' }), key: `${A}\u0000a.ts`, status: 'open', firstSeenRunId: 'r1', firstSeenAt: 't1' },
      { ...finding(B, 'b.ts'), key: `${B}\u0000b.ts`, status: 'not-rechecked', firstSeenRunId: 'r1', firstSeenAt: 't1' },
    ]);
    expect(r2.resolved).toEqual([]);
    const run2 = run('r2', { open: r2.open, verdict: 'findings' });

    // Run 3: both rules judged, A gone, B still there.
    const r3 = trackFindings({
      previous: run2,
      findings: [finding(B, 'b.ts')],
      selectedRuleIds: new Set([A, B]), knownIds: KNOWN,
      judged: true,
      runId: 'r3',
      finishedAt: 't3',
    });
    expect(r3.open.map((f) => [f.rule, f.status, f.firstSeenRunId])).toEqual([[B, 'open', 'r1']]);
    expect(r3.resolved).toEqual([finding(A, 'a.ts', { line: 9, note: 'ย้ายบรรทัด' })]);
  });

  it('never resolves when the judge did not run', () => {
    const prev = trackFindings({
      previous: null, findings: [finding(A, 'a.ts')], selectedRuleIds: new Set([A]), knownIds: KNOWN, judged: true, runId: 'r1', finishedAt: 't1',
    });
    const next = trackFindings({
      previous: run('r1', { open: prev.open }), findings: [], selectedRuleIds: new Set([A]), knownIds: KNOWN, judged: false, runId: 'r2', finishedAt: 't2',
    });
    expect(next.open.map((f) => f.status)).toEqual(['not-rechecked']);
    expect(next.resolved).toEqual([]);
  });

  it('drops a previous finding whose rule is no longer in the snapshot', () => {
    const prev = trackFindings({
      previous: null, findings: [finding(A, 'a.ts'), finding(B, 'b.ts')], selectedRuleIds: new Set([A, B]), knownIds: KNOWN,
      judged: true, runId: 'r1', finishedAt: 't1',
    });
    for (const judged of [true, false]) {
      const next = trackFindings({
        previous: run('r1', { open: prev.open }), findings: [], selectedRuleIds: new Set([B]), knownIds: new Set([B]),
        judged, runId: 'r2', finishedAt: 't2',
      });
      expect(next.open.map((f) => [f.rule, f.status])).toEqual(judged ? [] : [[B, 'not-rechecked']]);
      expect(next.resolved.map((f) => f.rule)).toEqual(judged ? [B] : []);
    }
  });

  it('keeps the first of duplicate identities', () => {
    const out = trackFindings({
      previous: null,
      findings: [finding(A, 'a.ts', { line: 1 }), finding(A, 'a.ts', { line: 2 })],
      selectedRuleIds: new Set([A]), knownIds: KNOWN,
      judged: true,
      runId: 'r1',
      finishedAt: 't1',
    });
    expect(out.open.map((f) => f.line)).toEqual([1]);
  });
});

describe('ruleStatuses', () => {
  const rules = [rule('E#1', 'arch'), rule('E#2', 'tests'), rule('E#3', 'missing'), rule('J#1'), rule('J#2'), rule('J#3'), rule('J#4')];

  it('takes enforced rules from their check and falls back to the judge', () => {
    const statuses = ruleStatuses({
      rules,
      selectedRuleIds: new Set(['E#3', 'J#1', 'J#2', 'J#3']),
      findings: [
        finding('J#1', 'a.ts', { severity: 'suspect' }),
        finding('J#1', 'b.ts', { severity: 'violation' }),
        finding('J#2', 'a.ts', { severity: 'suspect' }),
        finding('E#1', 'a.ts'),
      ],
      checks: [check('arch', 'pass'), check('tests', 'timeout')],
      judged: true,
    });
    expect(statuses).toEqual<Record<string, RailsRuleStatus>>({
      'E#1': 'pass',
      'E#2': 'fail',
      'E#3': 'clean',
      'J#1': 'violated',
      'J#2': 'suspect',
      'J#3': 'clean',
      'J#4': 'out-of-scope',
    });
  });

  it('falls back to the judge when the check could not start, and is out of scope unjudged', () => {
    const statuses = ruleStatuses({
      rules: [rule('E#1', 'arch'), rule('J#1')],
      selectedRuleIds: new Set(['E#1', 'J#1']),
      findings: [],
      checks: [check('arch', 'error')],
      judged: false,
    });
    expect(statuses).toEqual({ 'E#1': 'out-of-scope', 'J#1': 'out-of-scope' });
  });

  it('marks a failing check as fail', () => {
    expect(ruleStatuses({
      rules: [rule('E#1', 'arch')], selectedRuleIds: new Set(), findings: [], checks: [check('arch', 'fail')], judged: true,
    })).toEqual({ 'E#1': 'fail' });
  });
});

describe('computeVerdict', () => {
  const f = [finding('A#1', 'a.ts')];
  const cases: Array<[string, Parameters<typeof computeVerdict>[0], RailsVerdict]> = [
    ['a failing check wins over findings and errors', { checks: [check('t', 'fail'), check('u', 'error')], findings: f, judge: 'failed', error: 'x' }, 'check_failed'],
    ['a timeout is a failed check', { checks: [check('t', 'timeout')], findings: [], judge: 'ran', error: null }, 'check_failed'],
    ['a check that could not start is an error, not check_failed', { checks: [check('t', 'error')], findings: [], judge: 'ran', error: null }, 'error'],
    ['a run error', { checks: [], findings: f, judge: 'ran', error: 'manifest' }, 'error'],
    ['a judge failure with no findings', { checks: [check('t', 'pass')], findings: [], judge: 'failed', error: null }, 'error'],
    ['findings', { checks: [check('t', 'pass')], findings: f, judge: 'ran', error: null }, 'findings'],
    ['clean when the judge was skipped', { checks: [check('t', 'pass')], findings: [], judge: 'skipped', error: null }, 'clean'],
    ['clean', { checks: [], findings: [], judge: 'ran', error: null }, 'clean'],
  ];
  for (const [name, input, verdict] of cases) {
    it(name, () => expect(computeVerdict(input)).toBe(verdict));
  }
});

describe('latestRuleStatus', () => {
  it('returns the newest in-scope status', () => {
    const history = [
      run('3', { ruleStatus: { 'A#1': 'out-of-scope' } }),
      run('2', { ruleStatus: { 'A#1': 'violated' } }),
      run('1', { ruleStatus: { 'A#1': 'clean' } }),
    ];
    expect(latestRuleStatus(history, 'A#1')).toBe('violated');
    expect(latestRuleStatus(history, 'B#1')).toBeNull();
    expect(latestRuleStatus([run('1', { ruleStatus: { 'A#1': 'out-of-scope' } })], 'A#1')).toBeNull();
  });
});
