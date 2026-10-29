import { describe, expect, it } from 'vitest';

import { RAILS_DOCK_RECENT_RUNS, railsDockRows, shortRuleId } from './rows';
import type { RailsDockModel, RailsDockRow, RailsRunRecord, RailsSnapshot, TrackedFinding } from './types';

function tracked(rule: string, file: string): TrackedFinding {
  return {
    rule, severity: 'suspect', file, line: null, note: 'อาจผิด', key: `${rule}\u0000${file}`,
    status: 'new', firstSeenRunId: 'r2', firstSeenAt: 't',
  };
}

function run(runId: string, over: Partial<RailsRunRecord> = {}): RailsRunRecord {
  return {
    version: 1, runId, startedAt: 's', finishedAt: 'f', trigger: { kind: 'manual', laneId: null, laneName: null },
    fingerprint: 'x', verdict: 'clean', stale: false, checks: [], checksSkipped: false, judge: 'ran',
    judgeFailure: null, open: [], resolved: [], dropped: 0, rulesTruncated: null, ruleStatus: {}, error: null,
    ...over,
  };
}

const snapshot: RailsSnapshot = {
  present: true,
  manifestPath: '/repo/.krypton/rails.toml',
  trust: 'trusted',
  checks: [{ name: 'typecheck', argv: ['tsc'], timeoutS: 300 }, { name: 'arch', argv: ['vitest'], timeoutS: 300 }],
  rules: [
    { id: 'docs/adr/0008-x.md#1', source: 'docs/adr/0008-x.md', appliesTo: [], check: 'arch', text: 'a' },
    { id: 'AGENTS.md#1', source: 'AGENTS.md', appliesTo: [], check: null, text: 'b' },
    { id: 'AGENTS.md#2', source: 'AGENTS.md', appliesTo: [], check: null, text: 'c' },
  ],
  glossary: [],
  uncoveredSources: ['docs/adr/0003-y.md'],
  warnings: [],
  error: null,
};

function model(over: Partial<RailsDockModel> = {}): RailsDockModel {
  return {
    snapshot,
    mode: 'auto',
    progress: { kind: 'idle' },
    history: [],
    selectedKey: null,
    expanded: new Set(),
    ...over,
  };
}

describe('shortRuleId', () => {
  it('shortens to the leading number or the file stem', () => {
    expect(shortRuleId('docs/adr/0008-x.md#2')).toBe('0008#2');
    expect(shortRuleId('AGENTS.md#3')).toBe('AGENTS#3');
    expect(shortRuleId('CONTEXT.md#Lane')).toBe('CONTEXT#Lane');
    expect(shortRuleId('docs/0337-rails-verifier.md#1')).toBe('0337#1');
  });
});

describe('railsDockRows', () => {
  it('orders head, checks, findings, resolved, rules, uncovered, runs', () => {
    const latest = run('r2', {
      checks: [{ name: 'arch', outcome: 'fail', exitCode: 1, durationMs: 9, outputTail: '' }],
      open: [tracked('AGENTS.md#1', 'a.ts'), tracked('AGENTS.md#2', 'b.ts')],
      resolved: [{ rule: 'AGENTS.md#1', severity: 'violation', file: 'c.ts', line: 2, note: 'x' }],
    });
    const rows = railsDockRows(model({ history: [latest, run('r1')] }));

    expect(rows.map((row) => [row.key, row.section])).toEqual([
      ['head', 1],
      ['check:typecheck', 2],
      ['check:arch', 2],
      ['finding:AGENTS.md#1\u0000a.ts', 3],
      ['finding:AGENTS.md#2\u0000b.ts', 3],
      ['resolved', 3],
      ['rules', 4],
      ['uncovered', 4],
      ['run:r2', 5],
      ['run:r1', 5],
    ]);
    const checks = rows.filter((row) => row.kind === 'check');
    expect(checks.map((row) => row.kind === 'check' && row.result?.outcome)).toEqual([undefined, 'fail']);
    expect(rows.find((row) => row.kind === 'rules')).toMatchObject({ total: 3, enforced: 1 });
  });

  it('lists each rule with its latest in-scope status only while rules is expanded', () => {
    const history = [
      run('r2', { ruleStatus: { 'AGENTS.md#1': 'out-of-scope', 'docs/adr/0008-x.md#1': 'pass' } }),
      run('r1', { ruleStatus: { 'AGENTS.md#1': 'violated' } }),
    ];
    const collapsed = railsDockRows(model({ history }));
    expect(collapsed.some((row) => row.kind === 'rule')).toBe(false);

    const rules = railsDockRows(model({ history, expanded: new Set(['rules']) })).filter((row) => row.kind === 'rule');
    expect(rules.map((row) => row.kind === 'rule' && [row.key, row.status])).toEqual([
      ['rule:docs/adr/0008-x.md#1', 'pass'],
      ['rule:AGENTS.md#1', 'violated'],
      ['rule:AGENTS.md#2', null],
    ]);
  });

  it('omits resolved and uncovered when empty, and checks before the first run have no result', () => {
    const rows = railsDockRows(model({ snapshot: { ...snapshot, uncoveredSources: [] } }));
    expect(rows.map((row) => row.key)).toEqual(['head', 'check:typecheck', 'check:arch', 'rules']);
    expect(rows.every((row) => row.kind !== 'check' || row.result === null)).toBe(true);
  });

  it('still has a head and a rules row before the snapshot loads', () => {
    const rows = railsDockRows(model({ snapshot: null }));
    expect(rows.map((row) => row.key)).toEqual(['head', 'rules']);
  });

  it('lists the newest runs, folds the rest under older, and lists them below it when expanded', () => {
    const history = Array.from({ length: RAILS_DOCK_RECENT_RUNS + 3 }, (_unused, i) => run(`r${i}`));
    const runKeys = (rows: readonly RailsDockRow[]): string[] =>
      rows.filter((row) => row.section === 5).map((row) => row.key);

    const folded = railsDockRows(model({ history }));
    expect(runKeys(folded)).toEqual(['run:r0', 'run:r1', 'run:r2', 'run:r3', 'run:r4', 'older']);
    expect(folded.find((row) => row.kind === 'older')).toMatchObject({ count: 3 });

    const open = railsDockRows(model({ history, expanded: new Set(['older']) }));
    expect(runKeys(open)).toEqual(['run:r0', 'run:r1', 'run:r2', 'run:r3', 'run:r4', 'older', 'run:r5', 'run:r6', 'run:r7']);

    // Exactly the cap: no older row.
    expect(runKeys(railsDockRows(model({ history: history.slice(0, RAILS_DOCK_RECENT_RUNS) })))).not.toContain('older');
  });
});
