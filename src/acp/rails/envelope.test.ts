import { describe, expect, it } from 'vitest';

import { RAILS_ENVELOPE_MAX, railsEnvelope, railsSendSet, type RailsEnvelopeCheck } from './envelope';
import type { RailsCheckDecl, RailsCheckResult, RailsCheckRun, RailsRunRecord, RailsSnapshot, TrackedFinding } from './types';

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
const CHECK_PATH = '/repo/.krypton/rails/checks/osv.json';

const OSV: RailsCheckDecl = { name: 'osv', argv: ['python3', 'scripts/rails-osv.py'], timeoutS: 120, manual: true };

function checkRun(name: string, outcome: RailsCheckResult['outcome'], outputTail = '', finishedAt = '2026-11-07T12:40:13.761Z'): RailsCheckRun {
  return {
    version: 1, name, startedAt: '2026-11-07T12:40:06.000Z', finishedAt, laneName: 'OMP-1',
    result: { name, outcome, exitCode: outcome === 'timeout' ? null : 1, durationMs: 7273, outputTail },
  };
}

const OSV_TAIL = [
  '  src-tauri/Cargo.lock  zvariant@4.2.0  RUSTSEC-2026-0370',
  '    `zvariant` is unmaintained  https://osv.dev/RUSTSEC-2026-0370',
  'osv: 185 known vulnerabilities in 65 packages of package-lock.json, src-tauri/Cargo.lock',
  '',
].join('\n');

function osvCheck(result = checkRun('osv', 'fail', OSV_TAIL)): RailsEnvelopeCheck {
  return { result, decl: OSV, path: CHECK_PATH };
}

describe('railsEnvelope', () => {
  it('lists the header, failed checks, every open finding, the run file and the instruction', () => {
    const text = railsEnvelope({ record: run(), path: PATH }, []);
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

  // Spec 368 amendment B: a run with a failed check and no open finding is sent too.
  it('sends a run with failed checks and no open finding as its failed checks and its run file', () => {
    const text = railsEnvelope({ record: run({ open: [] }), path: PATH }, []);
    const lines = text.split('\n');
    expect(lines[0]).toBe('[rails] run 20261027T100000Z-ab12 — verdict check_failed');
    expect(lines[1]).toBe('Failed checks: typecheck (exit 2), tests (timeout)');
    expect(text).not.toContain('Open findings');
    expect(text).toContain(`Run file: ${PATH}`);
    expect(text).toMatch(/each failed check/);
  });

  it('sends only the given finding', () => {
    const only = run().open[1];
    const text = railsEnvelope({ record: run(), path: PATH, only }, []);
    expect(text).toContain('AGENTS#3 src/b.ts');
    expect(text).not.toContain('0008#2');
  });

  it('caps at 4000 chars and keeps the run file, the check file and the instruction', () => {
    const open = Array.from({ length: 60 }, (_, i) => tracked(`AGENTS.md#${i}`, `src/f${i}.ts`, i + 1, 'ก'.repeat(200)));
    const text = railsEnvelope({ record: run({ open }), path: PATH }, [osvCheck()]);
    expect(text.length).toBeLessThanOrEqual(RAILS_ENVELOPE_MAX);
    expect(text).toContain(PATH);
    expect(text).toContain(`Check file osv: ${CHECK_PATH}`);
    expect(text).toMatch(/never weaken/i);
    expect(text).toMatch(/… \d+ more in the run file/);
    expect(text).toContain('AGENTS#0 src/f0.ts:1');
  });

  // Spec 368 amendment A: a failed manual result is a pointer, never its output.
  it('points a failed manual result at its last line, its file and its rerun command', () => {
    const text = railsEnvelope(null, [osvCheck()]);
    const lines = text.split('\n');
    expect(lines[0]).toBe('[rails] manual checks');
    expect(lines[1]).toBe('Failed manual checks (1):');
    expect(lines[2]).toMatch(
      /^- osv \(exit 1\) at \d{4}-\d{2}-\d{2} \d{2}:\d{2} — last line: osv: 185 known vulnerabilities in 65 packages of package-lock\.json, src-tauri\/Cargo\.lock$/,
    );
    expect(text).toContain(`Check file osv: ${CHECK_PATH} (last 80 lines of output) · rerun for the full output: python3 scripts/rails-osv.py`);
    expect(text).not.toContain('zvariant');
    expect(text).not.toContain('Run file');
    expect(text).toMatch(/never weaken/i);
  });

  it('sits manual results between the failed checks and the findings, and quotes argv a shell would split', () => {
    const decl: RailsCheckDecl = { name: 'suite', argv: ['sh', '-c', "npm test -- --grep 'slow'"], timeoutS: 900, manual: true };
    const timeout: RailsEnvelopeCheck = { result: checkRun('suite', 'timeout', `${'x'.repeat(300)}\n\n  \n`), decl, path: '/repo/.krypton/rails/checks/suite.json' };
    const lines = railsEnvelope({ record: run(), path: PATH }, [timeout]).split('\n');
    const at = (prefix: string): number => lines.findIndex((line) => line.startsWith(prefix));
    expect(at('Failed checks:')).toBeLessThan(at('Failed manual checks (1):'));
    expect(at('Failed manual checks (1):')).toBeLessThan(at('Open findings (2):'));
    const manual = lines[at('- suite')];
    expect(manual).toMatch(/^- suite \(timeout\) at .* — last line: x+…$/);
    expect(manual.slice(manual.indexOf('last line: ') + 'last line: '.length)).toHaveLength(200);
    expect(lines.find((line) => line.startsWith('Check file suite:')))
      .toContain(`rerun for the full output: sh -c 'npm test -- --grep '\\''slow'\\'''`);
  });
});

describe('railsSendSet (spec 368 amendments A and B)', () => {
  const snapshot = {
    checks: [
      { name: 'typecheck', argv: ['npx', 'tsc'], timeoutS: 300, manual: false },
      OSV,
      { name: 'suite', argv: ['npm', 'test'], timeoutS: 900, manual: true },
      { name: 'audit', argv: ['npm', 'audit'], timeoutS: 60, manual: true },
    ],
  } as unknown as RailsSnapshot;
  const checkRuns = new Map<string, RailsCheckRun>([
    // A record for a check the manifest does not declare manual is never read.
    ['typecheck', checkRun('typecheck', 'fail')],
    ['suite', checkRun('suite', 'timeout', '', '2026-11-07T13:00:00.000Z')],
    ['osv', checkRun('osv', 'fail')],
    ['audit', checkRun('audit', 'error')],
  ]);
  const cleanRun = (): RailsRunRecord => run({
    verdict: 'clean',
    checks: [{ name: 'lint', outcome: 'pass', exitCode: 0, durationMs: 1, outputTail: '' }],
    open: [],
  });

  it('takes the newest run with its findings and failed checks, and failed manual results in manifest order', () => {
    const set = railsSendSet({ snapshot, history: [run(), run({ runId: 'older' })], checkRuns, checkInFlight: null });
    expect(set.run?.runId).toBe('20261027T100000Z-ab12');
    expect(set.manual.map((result) => result.name)).toEqual(['osv', 'suite']);
    expect(set.keys).toEqual([
      'run:20261027T100000Z-ab12',
      'check:osv@2026-11-07T12:40:13.761Z',
      'check:suite@2026-11-07T13:00:00.000Z',
    ]);
    expect(set.label).toBe('2 open findings and failed typecheck, tests, osv, suite');

    const clean = railsSendSet({ snapshot, history: [cleanRun()], checkRuns, checkInFlight: null });
    expect(clean.run).toBeNull();
    expect(clean.label).toBe('failed osv, suite');
  });

  it('takes a run whose only fault is a failed check, but not one whose check could not start', () => {
    const set = railsSendSet({ snapshot, history: [run({ open: [] })], checkRuns: new Map(), checkInFlight: null });
    expect(set.run?.runId).toBe('20261027T100000Z-ab12');
    expect(set.keys).toEqual(['run:20261027T100000Z-ab12']);
    expect(set.label).toBe('failed typecheck, tests');

    const withManual = railsSendSet({ snapshot, history: [run({ open: [] })], checkRuns, checkInFlight: null });
    expect(withManual.keys[0]).toBe('run:20261027T100000Z-ab12');
    expect(withManual.label).toBe('failed typecheck, tests, osv, suite');

    const error = run({
      verdict: 'error',
      checks: [{ name: 'typecheck', outcome: 'error', exitCode: null, durationMs: 1, outputTail: '' }],
      open: [],
    });
    expect(railsSendSet({ snapshot, history: [error], checkRuns: new Map(), checkInFlight: null }))
      .toEqual({ run: null, manual: [], keys: [], label: '' });
  });

  it('names a check once when the run and its manual result both failed it', () => {
    const before = run({
      open: [],
      checks: [{ name: 'osv', outcome: 'fail', exitCode: 1, durationMs: 1, outputTail: '' }],
    });
    const set = railsSendSet({ snapshot, history: [before], checkRuns: new Map([['osv', checkRun('osv', 'fail')]]), checkInFlight: null });
    expect(set.keys).toEqual(['run:20261027T100000Z-ab12', 'check:osv@2026-11-07T12:40:13.761Z']);
    expect(set.label).toBe('failed osv');
  });

  it('leaves out the manual check running now, and is empty with nothing failed', () => {
    const running = railsSendSet({ snapshot, history: [], checkRuns, checkInFlight: 'osv' });
    expect(running.manual.map((result) => result.name)).toEqual(['suite']);

    const passed = new Map([['osv', checkRun('osv', 'pass')]]);
    expect(railsSendSet({ snapshot, history: [cleanRun()], checkRuns: passed, checkInFlight: null }))
      .toEqual({ run: null, manual: [], keys: [], label: '' });
  });
});
