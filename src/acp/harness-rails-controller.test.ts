// @vitest-environment happy-dom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { AssistEngine } from './assist/engine';
import { HarnessRailsController, type RailsInvoke } from './harness-rails-controller';
import type { HarnessRailsHost } from './harness-view-host';
import type { HarnessLane } from './harness-view-types';
import { diffFingerprint } from './rails/track';
import type {
  RailsCheckResult,
  RailsFooterSignal,
  RailsRunRecord,
  RailsSnapshot,
  TrackedFinding,
} from './rails/types';
import type { LaneBusEvent, ReviewGitState } from './types';

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn() }));

const RULE = 'docs/adr/0001-lanes.md#1';
const DEBOUNCE_MS = 1_000;

const SNAPSHOT: RailsSnapshot = {
  present: true,
  manifestPath: '/repo/.krypton/rails.toml',
  trust: 'trusted',
  checks: [{ name: 'typecheck', argv: ['npx', 'tsc'], timeoutS: 300 }],
  rules: [{ id: RULE, source: 'docs/adr/0001-lanes.md', appliesTo: ['src/**'], check: null, text: 'No foo in src.' }],
  glossary: [],
  uncoveredSources: [],
  warnings: [],
  error: null,
};

const GIT: ReviewGitState = {
  repoRoot: '/repo',
  hasGitRepo: true,
  isUnbornHead: false,
  diffstat: [
    { path: 'src/a.ts', status: 'M', added: 1, removed: 0 },
    { path: 'src/b.ts', status: 'M', added: 1, removed: 0 },
  ],
  diff: 'diff --git a/src/a.ts b/src/a.ts\n@@ -1 +1 @@\n+const foo = 1;\n',
  untracked: [],
};

const PASS: RailsCheckResult = { name: 'typecheck', outcome: 'pass', exitCode: 0, durationMs: 1200, outputTail: '' };

interface Stat { repoRoot: string; files: number; added: number; removed: number; truncated: boolean }
const DIRTY: Stat = { repoRoot: '/repo', files: 2, added: 2, removed: 0, truncated: false };

function finding(file: string, note = 'ใช้ foo ใน src'): Record<string, unknown> {
  return { rule: RULE, severity: 'violation', file, line: 1, note };
}

function tracked(file: string, runId: string, at: string): TrackedFinding {
  return {
    rule: RULE,
    severity: 'violation',
    file,
    line: 1,
    note: 'เดิม',
    key: `${RULE}\u0000${file}`,
    status: 'new',
    firstSeenRunId: runId,
    firstSeenAt: at,
  };
}

function priorRun(overrides: Partial<RailsRunRecord> = {}): RailsRunRecord {
  return {
    version: 1,
    runId: '20261027T010000Z-0001',
    startedAt: '2026-10-27T01:00:00.000Z',
    finishedAt: '2026-10-27T01:00:05.000Z',
    trigger: { kind: 'auto', laneId: 'lane-1', laneName: 'claude-1' },
    fingerprint: 'old',
    verdict: 'findings',
    stale: false,
    checks: [PASS],
    checksSkipped: false,
    judge: 'ran',
    judgeFailure: null,
    open: [tracked('src/a.ts', '20261027T010000Z-0001', '2026-10-27T01:00:05.000Z')],
    resolved: [],
    dropped: 0,
    rulesTruncated: null,
    ruleStatus: { [RULE]: 'violated' },
    error: null,
    ...overrides,
  };
}

interface RigOptions {
  snapshot?: RailsSnapshot;
  history?: RailsRunRecord[];
  stats?: Stat[];
  /** `acp_collect_review_git_state` answers in order; the last one repeats. */
  gits?: ReviewGitState[];
  reply?: string;
  /** Replaces the judge completion (e.g. one that never settles). */
  complete?: (signal: AbortSignal) => Promise<string>;
  /** Epoch ms the judge breaker reports as its cooldown end. */
  cooldownUntil?: number;
  runCheck?: (name: string) => Promise<RailsCheckResult>;
  mode?: string;
}

function rig(options: RigOptions = {}) {
  const calls: { cmd: string; args: Record<string, unknown> }[] = [];
  const records: RailsRunRecord[] = [];
  let history = [...(options.history ?? [])];
  const stats = [...(options.stats ?? [])];
  const gits = [...(options.gits ?? [])];
  const invoke = (async (cmd: string, args: Record<string, unknown>): Promise<unknown> => {
    calls.push({ cmd, args });
    switch (cmd) {
      case 'working_diff_stat':
        return stats.length > 1 ? stats.shift() : (stats[0] ?? DIRTY);
      case 'rails_load':
        return options.snapshot ?? SNAPSHOT;
      case 'rails_trust':
        return { ...(options.snapshot ?? SNAPSHOT), trust: 'trusted' };
      case 'rails_history':
        return history;
      case 'acp_collect_review_git_state':
        return gits.length > 1 ? gits.shift() : (gits[0] ?? GIT);
      case 'rails_run_check':
        return options.runCheck ? options.runCheck(String(args.name)) : PASS;
      case 'rails_record_run': {
        const run = args.run as RailsRunRecord;
        records.push(run);
        history = [run, ...history];
        return `/repo/.krypton/rails/runs/${run.runId}.json`;
      }
      case 'rails_cancel':
        return undefined;
      default:
        throw new Error(`unexpected ${cmd}`);
    }
  }) as RailsInvoke;

  const prompts: string[] = [];
  const engine = new AssistEngine(async (call) => {
    prompts.push(call.user);
    if (options.complete) return options.complete(call.signal);
    return options.reply ?? JSON.stringify({ findings: [] });
  });
  if (options.cooldownUntil !== undefined) vi.spyOn(engine, 'cooldownUntil').mockReturnValue(options.cooldownUntil);

  const lanes = [
    { id: 'lane-1', displayName: 'claude-1', status: 'idle' },
    { id: 'lane-2', displayName: 'codex-1', status: 'idle' },
  ] as unknown as HarnessLane[];
  let bus: ((event: LaneBusEvent) => void) | null = null;
  const flashes: string[] = [];
  const signals: Omit<RailsFooterSignal, 'sourceId'>[] = [];
  const envelopes: { laneId: string; message: string }[] = [];
  const systemPrompts: { laneId: string; text: string; label: string | undefined }[] = [];
  const host: HarnessRailsHost = {
    element: document.createElement('div'),
    lanes,
    activeLaneId: 'lane-1',
    projectDir: '/repo',
    flashChip: (text) => { flashes.push(text); },
    subscribeLaneBus: (handler) => {
      bus = handler;
      return () => { bus = null; };
    },
    isPanelHidden: () => false,
    setDockTabAvailable: () => undefined,
    dockTabShown: () => true,
    setRailsBadge: () => undefined,
    showRailsDock: () => undefined,
    focusComposer: () => undefined,
    injectEnvelope: (laneId, message) => { envelopes.push({ laneId, message }); },
    publishRailsSignal: (signal) => { signals.push(signal); },
    enqueueSystemPrompt: async (lane, text, _drain, label) => {
      systemPrompts.push({ laneId: lane.id, text, label });
      return true;
    },
  };
  const ctl = new HarnessRailsController(host, {
    invoke,
    engine,
    loadConfig: async () => ({
      acp_harness: { rails: { debounce_ms: DEBOUNCE_MS, ...(options.mode ? { mode: options.mode } : {}) } },
    }),
  });

  const transition = (laneId: string, prev: string, next: string): void => {
    bus?.({ type: 'lane:status', payload: { laneId, prev, next, at: 0 } } as LaneBusEvent);
  };
  const quietPoint = async (laneId = 'lane-1'): Promise<void> => {
    transition(laneId, 'busy', 'idle');
    await vi.advanceTimersByTimeAsync(DEBOUNCE_MS);
    await ctl.whenIdle();
  };
  const commands = (): string[] => calls.map((call) => call.cmd);
  return { ctl, host, lanes, calls, commands, records, prompts, systemPrompts, flashes, signals, envelopes, transition, quietPoint };
}

describe('HarnessRailsController (spec 337)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('arms only on busy → idle, re-arms on a later one, and fires after debounce_ms', async () => {
    const r = rig();
    await r.ctl.mount();
    r.calls.length = 0;

    r.transition('lane-1', 'needs_permission', 'idle');
    r.transition('lane-1', 'idle', 'busy');
    await vi.advanceTimersByTimeAsync(DEBOUNCE_MS * 2);
    expect(r.commands()).toEqual([]);

    r.transition('lane-1', 'busy', 'idle');
    await vi.advanceTimersByTimeAsync(DEBOUNCE_MS - 100);
    r.transition('lane-2', 'busy', 'idle');
    await vi.advanceTimersByTimeAsync(DEBOUNCE_MS - 100);
    expect(r.commands()).toEqual([]);

    await vi.advanceTimersByTimeAsync(100);
    await r.ctl.whenIdle();
    expect(r.commands()[0]).toBe('working_diff_stat');
    expect(r.records).toHaveLength(1);
    expect(r.records[0].trigger).toEqual({ kind: 'auto', laneId: 'lane-2', laneName: 'codex-1' });
  });

  it('waits for the next transition while any lane is busy or needs permission', async () => {
    const r = rig();
    await r.ctl.mount();
    r.calls.length = 0;
    r.lanes[1].status = 'needs_permission';

    await r.quietPoint();
    expect(r.commands()).toEqual([]);

    r.lanes[1].status = 'idle';
    await r.quietPoint('lane-2');
    expect(r.records).toHaveLength(1);
  });

  it('never arms in manual or off mode', async () => {
    const r = rig({ mode: 'manual' });
    await r.ctl.mount();
    r.calls.length = 0;

    await r.quietPoint();
    r.ctl.setMode('off');
    await r.quietPoint();
    expect(r.commands()).toEqual([]);
  });

  it('stops at a clean tree before reading the manifest', async () => {
    const r = rig({ stats: [{ ...DIRTY, files: 0 }] });
    await r.ctl.mount();
    r.calls.length = 0;

    await r.quietPoint();
    expect(r.commands()).toEqual(['working_diff_stat']);
    expect(r.records).toEqual([]);
  });

  it('pauses an automatic run without trust, but a manual run judges without checks', async () => {
    const r = rig({ snapshot: { ...SNAPSHOT, trust: 'changed' } });
    await r.ctl.mount();
    r.calls.length = 0;

    await r.quietPoint();
    expect(r.commands()).toEqual(['working_diff_stat', 'rails_load']);
    expect(r.signals[r.signals.length - 1]?.state).toBe('paused');

    r.calls.length = 0;
    await r.ctl.runCommand(r.lanes[0], ['now'], '#rails now');
    await r.ctl.whenIdle();
    expect(r.commands()).not.toContain('rails_run_check');
    expect(r.prompts).toHaveLength(1);
    expect(r.records).toHaveLength(1);
    expect(r.records[0]).toMatchObject({ checks: [], checksSkipped: true, judge: 'ran', verdict: 'clean' });
    expect(r.records[0].trigger).toEqual({ kind: 'manual', laneId: 'lane-1', laneName: 'claude-1' });
  });

  it('refuses #rails now while the mode is off', async () => {
    const r = rig({ mode: 'off' });
    await r.ctl.mount();
    r.calls.length = 0;

    await r.ctl.runCommand(r.lanes[0], ['now'], '#rails now');
    expect(r.commands()).toEqual([]);
    expect(r.flashes).toEqual(['rails: off — #rails manual']);
  });

  it('skips an automatic run whose tree matches the last completed run, but not a manual one', async () => {
    const fingerprint = await diffFingerprint(GIT);
    const r = rig({
      history: [priorRun({ runId: '20261027T020000Z-0002', verdict: 'error', fingerprint: 'x' }), priorRun({ fingerprint })],
    });
    await r.ctl.mount();
    r.calls.length = 0;

    await r.quietPoint();
    expect(r.commands()).toEqual(['working_diff_stat', 'rails_load', 'acp_collect_review_git_state']);
    expect(r.records).toEqual([]);

    await r.ctl.runCommand(r.lanes[0], ['now'], '#rails now');
    await r.ctl.whenIdle();
    expect(r.records).toHaveLength(1);
  });

  it('runs checks in order, then judges, and records tracking against the previous completed run', async () => {
    const r = rig({
      snapshot: { ...SNAPSHOT, checks: [SNAPSHOT.checks[0], { name: 'arch', argv: ['npm', 'test'], timeoutS: 60 }] },
      history: [priorRun({ runId: '20261027T020000Z-0002', verdict: 'error', open: [] }), priorRun()],
      reply: `note ${JSON.stringify({ findings: [finding('src/a.ts'), finding('src/b.ts'), finding('elsewhere.ts')] })}`,
      runCheck: async (name) => ({ ...PASS, name }),
    });
    await r.ctl.mount();
    r.calls.length = 0;

    await r.quietPoint();
    expect(r.calls.filter((call) => call.cmd === 'rails_run_check').map((call) => call.args.name))
      .toEqual(['typecheck', 'arch']);
    expect(r.records).toHaveLength(1);
    const run = r.records[0];
    expect(run.runId).toMatch(/^[0-9]{8}T[0-9]{6}Z-[0-9a-f]{4}$/);
    expect(run.verdict).toBe('findings');
    expect(run.dropped).toBe(1);
    expect(run.stale).toBe(false);
    expect(run.open.map((open) => [open.file, open.status, open.firstSeenRunId])).toEqual([
      ['src/a.ts', 'open', '20261027T010000Z-0001'],
      ['src/b.ts', 'new', run.runId],
    ]);
    expect(run.ruleStatus).toEqual({ [RULE]: 'violated' });
    // The dock's history is the refreshed ledger, new run first.
    expect(r.calls[r.calls.length - 1]).toEqual({ cmd: 'rails_history', args: { root: '/repo', limit: 20 } });
    expect(r.signals[r.signals.length - 1]).toEqual({ state: 'findings', findings: 2, failedCheck: null });
  });

  it('resolves a finding the judge no longer reports for an in-scope rule', async () => {
    const r = rig({ history: [priorRun()] });
    await r.ctl.mount();

    await r.quietPoint();
    expect(r.records[0].open).toEqual([]);
    expect(r.records[0].resolved.map((item) => item.file)).toEqual(['src/a.ts']);
    expect(r.records[0].verdict).toBe('clean');
  });

  it('skips the judge when no rule or glossary entry applies', async () => {
    const r = rig({ snapshot: { ...SNAPSHOT, rules: [{ ...SNAPSHOT.rules[0], appliesTo: ['docs/**'] }] } });
    await r.ctl.mount();

    await r.quietPoint();
    expect(r.prompts).toEqual([]);
    expect(r.records[0]).toMatchObject({ judge: 'skipped', verdict: 'clean' });
    expect(r.records[0].ruleStatus).toEqual({ [RULE]: 'out-of-scope' });
  });

  it('reports a failed check as check_failed, whatever the judge says', async () => {
    const r = rig({ runCheck: async () => ({ ...PASS, outcome: 'fail', exitCode: 2 }) });
    await r.ctl.mount();

    await r.quietPoint();
    expect(r.records[0].verdict).toBe('check_failed');
    expect(r.signals[r.signals.length - 1]).toEqual({ state: 'check_failed', findings: 0, failedCheck: 'typecheck' });
  });

  it('marks a run stale when the tree moved under it, and re-arms', async () => {
    const moved = { ...DIRTY, added: 9 };
    // mount, then the run's two probes; every later probe sees `moved`, and
    // the moved tree has a new diff, so the fingerprint does not stop the re-run.
    const r = rig({
      stats: [DIRTY, DIRTY, moved, moved],
      gits: [GIT, { ...GIT, diff: `${GIT.diff}+const bar = 2;\n` }],
    });
    await r.ctl.mount();

    await r.quietPoint();
    expect(r.records[0].stale).toBe(true);

    await vi.advanceTimersByTimeAsync(DEBOUNCE_MS);
    await r.ctl.whenIdle();
    expect(r.records).toHaveLength(2);
    expect(r.records[1].stale).toBe(false);
  });

  it('stops on a busy check lock without recording', async () => {
    const r = rig({ runCheck: async () => { throw 'busy'; } });
    await r.ctl.mount();

    await r.quietPoint();
    expect(r.records).toEqual([]);
    expect(r.commands()).not.toContain('rails_record_run');
  });

  it('cancels a run in flight on #rails off: rails_cancel, no record', async () => {
    let release: (result: RailsCheckResult) => void = () => undefined;
    let started: () => void = () => undefined;
    const checkStarted = new Promise<void>((resolve) => { started = resolve; });
    const r = rig({
      runCheck: () => {
        started();
        return new Promise((resolve) => { release = resolve; });
      },
    });
    await r.ctl.mount();

    r.transition('lane-1', 'busy', 'idle');
    await vi.advanceTimersByTimeAsync(DEBOUNCE_MS);
    // The fingerprint goes through crypto.subtle, which no fake timer flushes.
    await checkStarted;

    await r.ctl.runCommand(r.lanes[0], ['off'], '#rails off');
    expect(r.calls.filter((call) => call.cmd === 'rails_cancel')).toEqual([{ cmd: 'rails_cancel', args: { root: '/repo' } }]);
    release({ ...PASS, outcome: 'fail' });
    await r.ctl.whenIdle();

    expect(r.records).toEqual([]);
    expect(r.prompts).toEqual([]);
  });

  it('writes no record when the check was killed from outside', async () => {
    const r = rig({ runCheck: async () => { throw 'cancelled'; } });
    await r.ctl.mount();

    await r.quietPoint();
    expect(r.records).toEqual([]);
    expect(r.prompts).toEqual([]);
  });

  it('cancels on dispose and publishes none', async () => {
    let release: (result: RailsCheckResult) => void = () => undefined;
    let started: () => void = () => undefined;
    const checkStarted = new Promise<void>((resolve) => { started = resolve; });
    const r = rig({
      runCheck: () => {
        started();
        return new Promise((resolve) => { release = resolve; });
      },
    });
    await r.ctl.mount();
    r.transition('lane-1', 'busy', 'idle');
    await vi.advanceTimersByTimeAsync(DEBOUNCE_MS);
    await checkStarted;

    r.ctl.dispose();
    release(PASS);
    await r.ctl.whenIdle();

    expect(r.commands()).toContain('rails_cancel');
    expect(r.records).toEqual([]);
    expect(r.signals[r.signals.length - 1]).toEqual({ state: 'none', findings: 0, failedCheck: null });
  });

  it('sends the open findings of the newest run to the lane #rails send was typed in', async () => {
    const r = rig({ history: [priorRun()] });
    await r.ctl.mount();

    await r.ctl.runCommand(r.lanes[1], ['send'], '#rails send');
    expect(r.envelopes).toHaveLength(1);
    expect(r.envelopes[0].laneId).toBe('lane-2');
    expect(r.envelopes[0].message).toContain('[rails]');
    expect(r.envelopes[0].message).toContain('/repo/.krypton/rails/runs/20261027T010000Z-0001.json');
  });

  it('#rails update sends the typed lane a freshly loaded rails state and the request (spec 338)', async () => {
    const options: RigOptions = { history: [priorRun()] };
    const r = rig(options);
    await r.ctl.mount();
    // The manifest changed after mount: the prompt must carry the new load, not the mounted snapshot.
    options.snapshot = {
      ...SNAPSHOT,
      trust: 'changed',
      checks: [...SNAPSHOT.checks, { name: 'arch', argv: ['sh', 'arch.sh'], timeoutS: 60 }],
    };
    r.calls.length = 0;

    await r.ctl.runCommand(r.lanes[1], ['update', 'typecheck', 'times', 'out'], '#rails update typecheck times out');
    expect(r.commands()).toEqual(['rails_load']);
    expect(r.flashes).toEqual([]);
    expect(r.systemPrompts).toHaveLength(1);
    const sent = r.systemPrompts[0];
    expect(sent).toMatchObject({ laneId: 'lane-2', label: 'rails update' });
    expect(sent.text).toContain('trust changed');
    expect(sent.text).toContain('- arch · timeout_s 60 · argv ["sh","arch.sh"] · not run');
    expect(sent.text).toContain('/repo/.krypton/rails/runs/20261027T010000Z-0001.json');
    expect(sent.text).toContain(`${RULE} · judge-only · violated`);
    expect(sent.text).toContain('"typecheck times out"');

    // Bare: no request line, so the lane only proposes.
    await r.ctl.runCommand(r.lanes[1], ['update'], '#rails update');
    expect(r.systemPrompts).toHaveLength(2);
    expect(r.systemPrompts[1].text).not.toContain('My request');
  });

  it('#rails update refuses a busy lane and a project without a manifest, queuing nothing', async () => {
    const busy = rig();
    await busy.ctl.mount();
    busy.calls.length = 0;
    busy.lanes[0].status = 'busy';
    await busy.ctl.runCommand(busy.lanes[0], ['update', 'x'], '#rails update x');
    expect(busy.flashes).toEqual(['lane busy - #cancel first']);
    expect(busy.commands()).toEqual([]);
    expect(busy.systemPrompts).toEqual([]);

    const none = rig({ snapshot: { ...SNAPSHOT, present: false } });
    await none.ctl.mount();
    await none.ctl.runCommand(none.lanes[0], ['update'], '#rails update');
    expect(none.flashes).toEqual(['rails: no .krypton/rails.toml — #rails init']);
    expect(none.systemPrompts).toEqual([]);
  });

  it('moves over the dock rows with j/k, jumps sections and sends the selected finding with s', async () => {
    const r = rig({ history: [priorRun()] });
    await r.ctl.mount();
    const press = (key: string): boolean => r.ctl.handleDockKey(new KeyboardEvent('keydown', { key, cancelable: true }));

    expect(press('3')).toBe(true);
    expect(r.ctl.dockEl.querySelector('.acp-rails-dock__row--selected')?.getAttribute('aria-selected')).toBe('true');
    expect(press('s')).toBe(true);
    expect(r.envelopes).toHaveLength(1);
    expect(r.envelopes[0].laneId).toBe('lane-1');

    expect(press('1')).toBe(true);
    expect(press('j')).toBe(true);
    expect(press('k')).toBe(true);
    expect(press('x')).toBe(false);
  });

  it('collects every untracked file for the subject', async () => {
    const r = rig();
    await r.ctl.mount();

    await r.quietPoint();
    expect(r.calls.find((call) => call.cmd === 'acp_collect_review_git_state')?.args)
      .toEqual({ cwd: '/repo', untrackedAll: true });
  });

  it('re-arms a stale manual run as an automatic one', async () => {
    const moved = { ...DIRTY, added: 9 };
    const r = rig({
      stats: [DIRTY, DIRTY, moved, moved],
      gits: [GIT, { ...GIT, diff: `${GIT.diff}+const bar = 2;\n` }],
    });
    await r.ctl.mount();

    await r.ctl.runCommand(r.lanes[1], ['now'], '#rails now');
    await r.ctl.whenIdle();
    expect(r.records[0]).toMatchObject({ stale: true, trigger: { kind: 'manual', laneId: 'lane-2' } });

    await vi.advanceTimersByTimeAsync(DEBOUNCE_MS);
    await r.ctl.whenIdle();
    expect(r.records).toHaveLength(2);
    expect(r.records[1].trigger).toEqual({ kind: 'auto', laneId: 'lane-2', laneName: 'codex-1' });
  });

  it('still runs the checks while the judge breaker cools, skipping only the judge', async () => {
    const r = rig({ cooldownUntil: Date.now() + 60_000 });
    await r.ctl.mount();

    await r.quietPoint();
    expect(r.commands()).toContain('rails_run_check');
    expect(r.prompts).toEqual([]);
    expect(r.records[0]).toMatchObject({ checks: [PASS], judge: 'failed', error: 'judge cooling down' });
  });

  it('does not take the fingerprint stop when the last run skipped checks and the manifest is now trusted', async () => {
    const fingerprint = await diffFingerprint(GIT);
    const r = rig({ history: [priorRun({ fingerprint, checksSkipped: true, checks: [] })] });
    await r.ctl.mount();

    await r.quietPoint();
    expect(r.commands()).toContain('rails_run_check');
    expect(r.records).toHaveLength(1);
    expect(r.records[0].checksSkipped).toBe(false);
  });

  it('cancels a judging run without killing the root check lock', async () => {
    // Settles only when aborted, like the real transport's abort race.
    // (Executor form: tsconfig's ES2021 lib has no `Promise.withResolvers`.)
    const r = rig({
      complete: (signal) => new Promise<string>((_resolve, reject) => {
        signal.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')), { once: true });
      }),
    });
    await r.ctl.mount();

    r.transition('lane-1', 'busy', 'idle');
    await vi.advanceTimersByTimeAsync(DEBOUNCE_MS);
    // The fingerprint digest settles outside the fake timer queue.
    await vi.waitFor(() => expect(r.prompts).toHaveLength(1));

    r.ctl.setMode('off');
    await r.ctl.whenIdle();
    expect(r.commands()).not.toContain('rails_cancel');
    expect(r.records).toEqual([]);
  });
});
