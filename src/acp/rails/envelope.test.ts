import { describe, expect, it } from 'vitest';

import { RAILS_ENVELOPE_MAX, railsEnvelope } from './envelope';
import type { RailsRunRecord, TrackedFinding } from './types';

function tracked(rule: string, file: string, line: number | null, note: string): TrackedFinding {
  return {
    rule, severity: 'violation', file, line, note, key: `${rule}\u0000${file}`,
    status: 'new', firstSeenRunId: 'r', firstSeenAt: 't',
  };
}

function run(over: Partial<RailsRunRecord> = {}): RailsRunRecord {
  return {
    version: 1, runId: '20261027T100000Z-ab12', startedAt: 's', finishedAt: 'f',
    trigger: { kind: 'auto', laneId: 'l1', laneName: 'OMP-1' }, fingerprint: 'x', verdict: 'check_failed',
    stale: false,
    checks: [
      { name: 'typecheck', outcome: 'fail', exitCode: 2, durationMs: 1, outputTail: '' },
      { name: 'tests', outcome: 'timeout', exitCode: null, durationMs: 1, outputTail: '' },
      { name: 'lint', outcome: 'pass', exitCode: 0, durationMs: 1, outputTail: '' },
    ],
    checksSkipped: false, judge: 'ran', judgeFailure: null,
    open: [
      tracked('docs/adr/0008-x.md#2', 'src/a.ts', 42, 'ใช้ backdrop-filter'),
      tracked('AGENTS.md#3', 'src/b.ts', null, 'ไม่มี test'),
    ],
    resolved: [], dropped: 0, rulesTruncated: null, ruleStatus: {}, error: null,
    ...over,
  };
}

const PATH = '/repo/.krypton/rails/runs/20261027T100000Z-ab12.json';

describe('railsEnvelope', () => {
  it('lists the header, failed checks, every open finding, the run file and the instruction', () => {
    const text = railsEnvelope(run(), PATH);
    const lines = text.split('\n');
    expect(lines[0]).toBe('[rails] run 20261027T100000Z-ab12 — verdict check_failed');
    expect(text).toContain('typecheck (exit 2)');
    expect(text).toContain('tests (timeout)');
    expect(text).not.toContain('lint');
    expect(text).toContain('violation 0008#2 src/a.ts:42 — ใช้ backdrop-filter');
    expect(text).toContain('violation AGENTS#3 src/b.ts — ไม่มี test');
    expect(text).toContain(PATH);
    expect(text).toMatch(/never weaken/i);
  });

  it('sends only the given finding', () => {
    const only = run().open[1];
    const text = railsEnvelope(run(), PATH, only);
    expect(text).toContain('AGENTS#3 src/b.ts');
    expect(text).not.toContain('0008#2');
  });

  it('caps at 4000 chars and keeps the run file and instruction', () => {
    const open = Array.from({ length: 60 }, (_, i) => tracked(`AGENTS.md#${i}`, `src/f${i}.ts`, i + 1, 'ก'.repeat(200)));
    const text = railsEnvelope(run({ open }), PATH);
    expect(text.length).toBeLessThanOrEqual(RAILS_ENVELOPE_MAX);
    expect(text).toContain(PATH);
    expect(text).toMatch(/never weaken/i);
    expect(text).toMatch(/… \d+ more in the run file/);
    expect(text).toContain('AGENTS#0 src/f0.ts:1');
  });
});
