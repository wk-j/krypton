import { beforeEach, describe, expect, it, vi } from 'vitest';
import { invoke } from '@tauri-apps/api/core';

import type { E2eCaseInfo, E2eRunInfo, E2eStatus } from './e2e-command';
import { HarnessE2eController } from './harness-e2e-controller';
import type { HarnessE2eHost } from './harness-view-host';
import type { HarnessLane, HarnessTranscriptItem } from './harness-view-types';

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn() }));

const lane = { status: 'idle' } as HarnessLane;

function setup() {
  const rows: HarnessTranscriptItem[] = [];
  const host = {
    projectDir: '/repo',
    flashChip: vi.fn(),
    enqueueSystemPrompt: vi.fn(async () => true),
    appendShellRow: vi.fn((_lane: HarnessLane, text: string) => {
      const item = { id: String(rows.length), kind: 'shell', text, status: 'pending' } as HarnessTranscriptItem;
      rows.push(item);
      return item;
    }),
    finishShellRow: vi.fn((item: HarnessTranscriptItem, text: string, status: string) => {
      item.text = text;
      item.status = status;
    }),
  } as unknown as HarnessE2eHost;
  return { host, rows, controller: new HarnessE2eController(host) };
}

const caseInfo = (id: string, issue: number | null = null): E2eCaseInfo => ({
  id, title: id, code: null, issue, params: {}, fresh: {}, files: [], caseHash: null, uncommitted: false,
});

function status(overrides: Partial<E2eStatus> = {}): E2eStatus {
  return {
    initialized: true,
    manifest: {
      name: 'x', history: false, issueLabel: 'e2e',
      createPrompt: 'write case for {issue_url}',
      reportPrompt: 'post {run_id} ({result_path}) on {issue_url}',
    },
    errors: [], cases: [caseInfo('a'), caseInfo('b'), caseInfo('c')], runs: [],
    issues: null, issuesError: null, activeLaunch: null,
    ...overrides,
  };
}

const run = (caseId: string, verdict: E2eRunInfo['verdict']): E2eRunInfo => ({
  caseId, code: null, runId: `${caseId}-r`, origin: 'krypton', launchId: `${caseId}-L`, verdict,
  startedAt: null, finishedAt: null, counts: { pass: 0, fail: 0, skip: 0, blocked: 0, info: 0 },
  failed: [], versions: {}, params: {}, git: null, caseHash: null, exitCode: 0,
  resultPath: null, logPath: null, message: null, argv: null,
});

/** The `caseId` an `e2e_run` invoke carried; fails the test on any other shape. */
function caseIdOf(args: unknown): string {
  if (args && typeof args === 'object' && 'caseId' in args && typeof args.caseId === 'string') return args.caseId;
  throw new Error(`e2e_run without caseId: ${JSON.stringify(args)}`);
}

function invokeRuns(verdicts: Record<string, E2eRunInfo['verdict']>, onRun?: (caseId: string) => void) {
  vi.mocked(invoke).mockImplementation(async (cmd: string, args?: unknown) => {
    if (cmd === 'e2e_status') return status();
    if (cmd === 'e2e_cancel') return true;
    if (cmd === 'e2e_run') {
      const caseId = caseIdOf(args);
      onRun?.(caseId);
      return run(caseId, verdicts[caseId]);
    }
    throw new Error(`unexpected ${cmd}`);
  });
}

const ranCases = () =>
  vi.mocked(invoke).mock.calls.filter(([cmd]) => cmd === 'e2e_run').map(([, args]) => caseIdOf(args));

beforeEach(() => { vi.resetAllMocks(); });

describe('#e2e run all', () => {
  it('keeps going past FAIL and BLOCKED but stops at a cancelled case', async () => {
    invokeRuns({ a: 'FAIL', b: 'CANCELLED', c: 'PASS' });
    const { controller, rows } = setup();
    await controller.runCommand(lane, '#e2e run all --fresh');
    expect(ranCases()).toEqual(['a', 'b']);
    expect(rows.map((row) => row.status)).toEqual(['failed', 'failed']);
    expect(vi.mocked(invoke).mock.calls.find(([cmd]) => cmd === 'e2e_run')?.[1]).toMatchObject({ fresh: true, params: {} });
  });

  it('does not start the next case once #e2e cancel was issued mid-queue', async () => {
    const { controller } = setup();
    invokeRuns({ a: 'PASS', b: 'PASS', c: 'PASS' }, (caseId) => {
      if (caseId === 'a') void controller.runCommand(lane, '#e2e cancel');
    });
    await controller.runCommand(lane, '#e2e run all');
    expect(ranCases()).toEqual(['a']);
  });
});

describe('#e2e run', () => {
  it('turns a busy launch into an actionable row instead of a raw error', async () => {
    vi.mocked(invoke).mockRejectedValue('busy');
    const { controller, rows } = setup();
    await controller.runCommand(lane, '#e2e run a k=v');
    expect(rows).toHaveLength(1);
    expect(rows[0].status).toBe('failed');
    expect(rows[0].text).toContain('#e2e cancel');
    expect(invoke).toHaveBeenCalledWith('e2e_run', { root: '/repo', caseId: 'a', params: { k: 'v' }, fresh: false });
  });
});

describe('#e2e prompt verbs', () => {
  it('reports the resolved run with its result file and the labelled issue URL', async () => {
    vi.mocked(invoke).mockImplementation(async (cmd: string) => {
      if (cmd === 'e2e_status') {
        return status({ issues: [{ number: 7, title: 't', url: 'https://github.com/o/r/issues/7', state: 'OPEN', reportedRunIds: [] }] });
      }
      if (cmd === 'e2e_find_run') return { caseId: 'a', runId: 'R9', issue: 7, resultPath: '.krypton/e2e/runs/L/result.json' };
      throw new Error(`unexpected ${cmd}`);
    });
    const { controller, host } = setup();
    await controller.runCommand(lane, '#e2e report a');
    expect(host.enqueueSystemPrompt).toHaveBeenCalledWith(
      lane,
      'post R9 (.krypton/e2e/runs/L/result.json) on https://github.com/o/r/issues/7',
      undefined,
      expect.any(String),
    );
  });

  it('refuses to report a run whose case has no issue', async () => {
    vi.mocked(invoke).mockImplementation(async (cmd: string) => {
      if (cmd === 'e2e_status') return status();
      if (cmd === 'e2e_find_run') return { caseId: 'a', runId: 'R9', issue: null, resultPath: 'x' };
      throw new Error(`unexpected ${cmd}`);
    });
    const { controller, host } = setup();
    await controller.runCommand(lane, '#e2e report a');
    expect(host.enqueueSystemPrompt).not.toHaveBeenCalled();
    expect(host.flashChip).toHaveBeenCalledWith(expect.stringContaining('no linked issue'));
  });

  it('writes nothing and starts no turn when the lane is busy', async () => {
    const { controller, host } = setup();
    await controller.runCommand({ status: 'busy' } as HarnessLane, '#e2e init');
    expect(invoke).not.toHaveBeenCalled();
    expect(host.enqueueSystemPrompt).not.toHaveBeenCalled();
  });
});

describe('#e2e open', () => {
  it('opens the project explorer selected on the requested case', async () => {
    vi.mocked(invoke).mockImplementation(async (cmd: string) => {
      if (cmd === 'get_e2e_web_url') return 'http://127.0.0.1:8765/e2e/abc';
      if (cmd === 'open_url') return undefined;
      throw new Error(`unexpected ${cmd}`);
    });
    const { controller } = setup();
    await controller.runCommand(lane, '#e2e open issue 7');
    expect(invoke).not.toHaveBeenCalled();
    await controller.runCommand(lane, '#e2e open issue-7&x');
    expect(invoke).toHaveBeenCalledWith('get_e2e_web_url', { root: '/repo' });
    expect(invoke).toHaveBeenCalledWith('open_url', { url: 'http://127.0.0.1:8765/e2e/abc#case=issue-7%26x' });
  });

  it('opens nothing when the loopback server cannot issue a URL', async () => {
    vi.mocked(invoke).mockRejectedValue('Hook server is not running');
    const { controller, host } = setup();
    await controller.runCommand(lane, '#e2e open');
    expect(invoke).not.toHaveBeenCalledWith('open_url', expect.anything());
    expect(host.flashChip).toHaveBeenCalledWith('e2e open failed: Hook server is not running');
  });
});
