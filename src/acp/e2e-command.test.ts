import { describe, expect, it } from 'vitest';

import {
  type E2eCaseInfo,
  type E2eIssueInfo,
  type E2eRunInfo,
  type E2eStatus,
  e2eCaseMarks,
  formatE2eRunSummary,
  formatE2eStatus,
  githubRepoUrl,
  parseE2eCommand,
  renderE2ePrompt,
} from './e2e-command';

function caseInfo(overrides: Partial<E2eCaseInfo> = {}): E2eCaseInfo {
  return {
    id: '1331',
    title: 'CORE005 life cycle',
    code: 'CORE005-CR12-8',
    issue: 1331,
    params: {},
    fresh: {},
    files: ['e2e/cases/1331'],
    caseHash: 'hash-now',
    uncommitted: false,
    ...overrides,
  };
}

function run(overrides: Partial<E2eRunInfo> = {}): E2eRunInfo {
  return {
    caseId: '1331',
    code: null,
    runId: 'r1',
    origin: 'krypton',
    launchId: 'L1',
    verdict: 'PASS',
    startedAt: '2026-10-23T08:17:18Z',
    finishedAt: '2026-10-23T08:20:13Z',
    counts: { pass: 291, fail: 0, skip: 0, blocked: 0, info: 15 },
    failed: [],
    versions: {},
    params: {},
    git: { sha: '7c88246d0000', branch: 'wk-j', dirty: false },
    caseHash: 'hash-now',
    exitCode: 0,
    resultPath: '.krypton/e2e/runs/L1/result.json',
    logPath: '.krypton/e2e/runs/L1/log',
    message: null,
    argv: null,
    ...overrides,
  };
}

const issue = (reportedRunIds: string[], number = 1331): E2eIssueInfo => ({
  number,
  title: 'issue',
  url: `https://github.com/o/r/issues/${number}`,
  state: 'OPEN',
  reportedRunIds,
});

describe('parseE2eCommand', () => {
  it('treats a bare #e2e as status and accepts one case for status', () => {
    expect(parseE2eCommand('#e2e')).toEqual({ kind: 'status', caseId: null });
    expect(parseE2eCommand('#e2e status 1331')).toEqual({ kind: 'status', caseId: '1331' });
    expect(parseE2eCommand('#e2e status 1 2').kind).toBe('usage');
  });

  it('parses run params, keeps "=" inside values and reads --fresh anywhere after the case', () => {
    expect(parseE2eCommand('#e2e run 1328 --fresh tempRpNo=new url=a=b')).toEqual({
      kind: 'run',
      caseId: '1328',
      params: { tempRpNo: 'new', url: 'a=b' },
      fresh: true,
    });
    expect(parseE2eCommand('#e2e run 1328 empty=')).toEqual({
      kind: 'run', caseId: '1328', params: { empty: '' }, fresh: false,
    });
  });

  it('rejects ambiguous run forms instead of guessing', () => {
    for (const text of [
      '#e2e run',
      '#e2e run --fresh',
      '#e2e run 1328 tempRpNo',
      '#e2e run 1328 =x',
      '#e2e run 1328 a=1 a=2',
      '#e2e run 1328 bad/key=1',
      '#e2e run all pages=2',
    ]) {
      expect(parseE2eCommand(text).kind, text).toBe('usage');
    }
  });

  it('separates run all from a case named like a flag', () => {
    expect(parseE2eCommand('#e2e run all --fresh')).toEqual({ kind: 'run-all', fresh: true });
    expect(parseE2eCommand('#e2e run all')).toEqual({ kind: 'run-all', fresh: false });
  });

  it('keeps the init hint verbatim and accepts #-prefixed issue numbers', () => {
    expect(parseE2eCommand('#e2e init  use   the dev server ')).toEqual({ kind: 'init', hint: 'use   the dev server' });
    expect(parseE2eCommand('#e2e init')).toEqual({ kind: 'init', hint: '' });
    expect(parseE2eCommand('#e2e case #1340')).toEqual({ kind: 'case', issue: 1340 });
    expect(parseE2eCommand('#e2e case 0').kind).toBe('usage');
    expect(parseE2eCommand('#e2e case abc').kind).toBe('usage');
    expect(parseE2eCommand('#e2e report 20261023T081718Z')).toEqual({ kind: 'report', target: '20261023T081718Z' });
  });

  it('opens the explorer with at most one case', () => {
    expect(parseE2eCommand('#e2e open')).toEqual({ kind: 'open', caseId: null });
    expect(parseE2eCommand('#e2e open loopback-api-authorization')).toEqual({
      kind: 'open', caseId: 'loopback-api-authorization',
    });
    expect(parseE2eCommand('#e2e open a b').kind).toBe('usage');
  });

  it('rejects extra arguments on argument-less subcommands and unknown subcommands', () => {
    expect(parseE2eCommand('#e2e rerun now').kind).toBe('usage');
    expect(parseE2eCommand('#e2e cancel all').kind).toBe('usage');
    expect(parseE2eCommand('#e2e launch 1').kind).toBe('usage');
  });
});

describe('e2eCaseMarks', () => {
  it('marks edited only against the newest Krypton PASS, never an ext run', () => {
    const c = caseInfo({ caseHash: 'hash-now' });
    expect(e2eCaseMarks(c, [run({ caseHash: 'hash-old' })], undefined, false)).toEqual(['edited']);
    expect(e2eCaseMarks(c, [run({ origin: 'ext', caseHash: null })], undefined, false)).toEqual([]);
    // A newer FAIL does not hide that the case changed since its last PASS.
    expect(e2eCaseMarks(c, [run({ verdict: 'FAIL', caseHash: 'hash-now' }), run({ caseHash: 'hash-old' })], undefined, false))
      .toEqual(['edited']);
  });

  it('judges unreported by the newest PASS/FAIL, skipping BLOCKED and ERROR runs', () => {
    const c = caseInfo();
    const runs = [run({ runId: 'blocked', verdict: 'BLOCKED' }), run({ runId: 'r1' })];
    expect(e2eCaseMarks(c, runs, issue(['r1']), true)).toEqual([]);
    expect(e2eCaseMarks(c, runs, issue(['older']), true)).toEqual(['unreported']);
    // Issues not fetched: never claim unreported.
    expect(e2eCaseMarks(c, runs, undefined, false)).toEqual([]);
    // No judged run yet: nothing to report.
    expect(e2eCaseMarks(c, [run({ verdict: 'BLOCKED' })], issue([]), true)).toEqual([]);
  });

  it('reports uncommitted case files', () => {
    expect(e2eCaseMarks(caseInfo({ uncommitted: true }), [], undefined, false)).toEqual(['uncommitted']);
  });
});

function status(overrides: Partial<E2eStatus> = {}): E2eStatus {
  return {
    initialized: true,
    manifest: { name: 'dev-tli e2e', history: true, issueLabel: 'type: Automate E2E', createPrompt: null, reportPrompt: null },
    errors: [],
    cases: [caseInfo()],
    runs: [],
    issues: null,
    issuesError: null,
    activeLaunch: null,
    ...overrides,
  };
}

describe('formatE2eStatus', () => {
  it('points an uninitialized project at #e2e init', () => {
    expect(formatE2eStatus('#e2e', status({ initialized: false, manifest: null, cases: [] })))
      .toBe('#e2e\nnot initialized — #e2e init');
  });

  it('shows newest verdict, ext vs commit, the verdict strip and labelled issues without a case', () => {
    const text = formatE2eStatus(
      '#e2e status',
      status({
        cases: [caseInfo(), caseInfo({ id: '1328', issue: 1328, code: 'UW-A1' })],
        runs: [
          run({ caseId: '1328', runId: 'a', origin: 'ext', git: null, verdict: 'PASS' }),
          run({ caseId: '1331', runId: 'b', verdict: 'FAIL', git: { sha: 'abcdef1234', branch: 'x', dirty: true } }),
          run({ caseId: '1328', runId: 'c', origin: 'ext', git: null, verdict: 'BLOCKED' }),
          run({ caseId: '1328', runId: 'd', origin: 'ext', git: null, verdict: 'ERROR' }),
        ],
        issues: [issue([], 1331), issue(['a'], 1328), issue([], 1340)],
      }),
    );
    const lines = text.split('\n');
    const row1331 = lines.find((line) => line.startsWith('1331'));
    const row1328 = lines.find((line) => line.startsWith('1328'));
    expect(row1331).toMatch(/FAIL .*abcdef12\* .*F .*unreported$/);
    expect(row1328).toMatch(/PASS .*ext .*PBE$/);
    expect(lines.some((line) => line.includes('#1340') && line.endsWith('no case'))).toBe(true);
  });

  it('aligns every table row to the same column starts', () => {
    const text = formatE2eStatus('#e2e', status({ cases: [caseInfo(), caseInfo({ id: '7', issue: null })] }));
    const rows = text.split('\n').slice(2);
    const issueColumn = rows.map((row) => row.indexOf(row.split(/\s{2,}/)[1]));
    expect(new Set(issueColumn).size).toBe(1);
  });

  it('surfaces gh failure only when the manifest asks for issues, and every gather error', () => {
    const text = formatE2eStatus('#e2e', status({ issuesError: 'gh: not logged in', errors: ['list timed out after 60s'] }));
    expect(text).toContain('issues unavailable: gh: not logged in');
    expect(text).toContain('! list timed out after 60s');
    const noLabel = formatE2eStatus('#e2e', status({
      manifest: { name: 'x', history: false, issueLabel: null, createPrompt: null, reportPrompt: null },
      issuesError: 'gh: not logged in',
    }));
    expect(noLabel).not.toContain('issues unavailable');
  });
});

describe('formatE2eRunSummary', () => {
  it('caps failed checks at ten and counts the rest', () => {
    const failed = Array.from({ length: 13 }, (_, i) => ({
      group: 'g', label: `check ${i}`, status: 'fail' as const, detail: null,
    }));
    const text = formatE2eRunSummary('#e2e run 1331', run({ verdict: 'FAIL', failed, counts: { pass: 1, fail: 13, skip: 0, blocked: 0, info: 0 } }));
    const lines = text.split('\n');
    expect(lines.filter((line) => line.startsWith('✗ g › check'))).toHaveLength(10);
    expect(lines).toContain('… 3 more');
  });

  it('carries the provenance a reader needs to trust the verdict', () => {
    // A single `#e2e run` has no case list at hand: the code comes from the run itself.
    const text = formatE2eRunSummary(
      '#e2e run 1331',
      run({ code: 'CORE005-CR12-8', versions: { 'tli-api': 'v3.7.3' }, git: { sha: '7c88246d9999', branch: 'wk-j', dirty: true } }),
    );
    const [, head, provenance] = text.split('\n');
    expect(head).toBe('PASS  1331  CORE005-CR12-8  291✓ 0✗  2m55s');
    expect(provenance).toBe('commit 7c88246d* wk-j · tli-api v3.7.3');
  });
});

describe('renderE2ePrompt', () => {
  it('fills known placeholders and leaves unknown braces untouched', () => {
    expect(renderE2ePrompt('post {run_id} at {result_path} on {issue_url} (#{issue}) {other}', {
      issue: 7, issueUrl: 'u', runId: 'r', resultPath: 'p',
    })).toBe('post r at p on u (#7) {other}');
    expect(renderE2ePrompt('{issue_url}', {})).toBe('{issue_url}');
  });
});

describe('githubRepoUrl', () => {
  it('normalizes ssh and https remotes and rejects other hosts', () => {
    expect(githubRepoUrl('git@github.com:bcircle/tli-api-service.git')).toBe('https://github.com/bcircle/tli-api-service');
    expect(githubRepoUrl('https://github.com/bcircle/tli-api-service\n')).toBe('https://github.com/bcircle/tli-api-service');
    expect(githubRepoUrl('https://gitlab.com/a/b.git')).toBeNull();
  });
});
