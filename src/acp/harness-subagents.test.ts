import { describe, expect, it } from 'vitest';

import {
  absorbChildToolCall,
  appendChildOutput,
  applyOmpJobs,
  claudeParentToolUseId,
  jobsSummary,
  markLastReported,
  parseOmpJobs,
  parseSubagentPayload,
  subagentSummary,
  type OmpJob,
} from './harness-subagents';
import type { SubagentPayload } from './harness-view-types';
import type { ToolCall } from './types';

const NO_NAMES = new Map<string, string>();

function ompProgress(status: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return { id: 'ReviewSortCode', index: 0, agent: 'reviewer', status, recentTools: ['grep', 'read'], toolCount: 4, tokens: 38_000, ...extra };
}

describe('parseSubagentPayload — OMP task', () => {
  const start: ToolCall = {
    toolCallId: 't1',
    title: 'Spawning two parallel reviewers',
    kind: 'other',
    rawInput: { tasks: [{ name: 'ReviewSortCode', task: 'review sort' }, { name: 'ReviewRepo', task: 'review repo' }] },
  };

  it('starts every task pending, then follows per-agent progress', () => {
    const pending = parseSubagentPayload(start, 'pending', undefined, NO_NAMES);
    expect(pending?.agents.map((a) => [a.id, a.status])).toEqual([['ReviewSortCode', 'pending'], ['ReviewRepo', 'pending']]);

    const running = parseSubagentPayload(
      { ...start, rawOutput: { details: { progress: [ompProgress('running', { lastIntent: 'reading SortService.java' })] } } },
      'in_progress',
      pending,
      NO_NAMES,
    );
    expect(running?.source).toBe('omp');
    expect(running?.agents[0]).toMatchObject({
      id: 'ReviewSortCode', agent: 'reviewer', status: 'running', activity: 'reading SortService.java',
      recentTools: ['grep', 'read'], toolCount: 4, tokens: 38_000,
    });
    expect(running?.agents[1].status).toBe('pending');
  });

  it('keeps the previous card on a status-only update instead of resetting to pending', () => {
    const running = parseSubagentPayload(
      { ...start, rawOutput: { details: { progress: [ompProgress('running')] } } },
      'in_progress',
      undefined,
      NO_NAMES,
    );
    const statusOnly = parseSubagentPayload({ toolCallId: 't1', rawInput: start.rawInput }, 'in_progress', running, NO_NAMES);
    expect(statusOnly?.agents[0].status).toBe('running');
  });

  it('merges final results and marks failures', () => {
    const running = parseSubagentPayload(
      { ...start, rawOutput: { details: { progress: [ompProgress('running'), { ...ompProgress('running'), id: 'ReviewRepo', index: 1 }] } } },
      'in_progress',
      undefined,
      NO_NAMES,
    );
    const done = parseSubagentPayload(
      { toolCallId: 't1', rawOutput: { details: { results: [{ id: 'ReviewSortCode', exitCode: 0, output: 'LGTM' }, { id: 'ReviewRepo', error: 'boom' }] } } },
      'completed',
      running,
      NO_NAMES,
    );
    expect(done?.agents.map((a) => [a.id, a.status, a.output])).toEqual([
      ['ReviewSortCode', 'completed', 'LGTM'],
      ['ReviewRepo', 'failed', 'boom'],
    ]);
  });

  it('keeps background agents live after the task tool itself completed', () => {
    const bg = parseSubagentPayload(
      { ...start, rawOutput: { details: { progress: [ompProgress('running')], async: { state: 'running', jobId: 'j1' } } } },
      'completed',
      undefined,
      NO_NAMES,
    );
    expect(bg?.background).toBe(true);
    expect(bg?.agents[0].status).toBe('running');
  });

  it('drops the card when the spawn is rejected before any agent starts', () => {
    const pending = parseSubagentPayload(start, 'pending', undefined, NO_NAMES);
    expect(parseSubagentPayload(start, 'failed', pending, NO_NAMES)).toBeUndefined();
  });

  it('settles agents that never started as cancelled, not failed', () => {
    const running = parseSubagentPayload(
      { ...start, rawOutput: { details: { progress: [ompProgress('running')] } } },
      'in_progress',
      undefined,
      NO_NAMES,
    );
    const failed = parseSubagentPayload({ toolCallId: 't1', rawInput: start.rawInput }, 'failed', running, NO_NAMES);
    expect(failed?.agents.map((a) => [a.id, a.status])).toEqual([['ReviewSortCode', 'failed'], ['ReviewRepo', 'cancelled']]);
  });

  it('ignores ordinary tools', () => {
    expect(parseSubagentPayload({ toolCallId: 'x', rawInput: { command: 'ls' } }, 'completed', undefined, NO_NAMES)).toBeUndefined();
  });
});

describe('parseSubagentPayload — Claude Task', () => {
  it('builds one agent from the Task meta and keeps absorbed child activity across updates', () => {
    const call: ToolCall = {
      toolCallId: 'toolu_1',
      title: 'Task',
      rawInput: { description: 'Find callers', subagent_type: 'Explore', prompt: 'find all callers' },
      _meta: { claudeCode: { toolName: 'Task' } },
    };
    const card = parseSubagentPayload(call, 'in_progress', undefined, NO_NAMES);
    expect(card?.agents[0]).toMatchObject({ id: 'Find callers', agent: 'Explore', status: 'running', task: 'find all callers' });
    if (!card) throw new Error('card');
    absorbChildToolCall(card, 'Read client.ts', true);
    absorbChildToolCall(card, 'Read client.ts', false);
    appendChildOutput(card, 'found 3');
    const next = parseSubagentPayload({ toolCallId: 'toolu_1' }, 'in_progress', card, NO_NAMES);
    expect(next?.agents[0]).toMatchObject({ toolCount: 1, recentTools: ['Read client.ts'], output: 'found 3' });
  });

  it('reads the parent Task id stamped on subagent output', () => {
    expect(claudeParentToolUseId({ claudeCode: { parentToolUseId: 'toolu_1' } })).toBe('toolu_1');
    expect(claudeParentToolUseId({ claudeCode: {} })).toBeNull();
  });
});

describe('parseSubagentPayload — Codex spawnAgent', () => {
  it('lists receivers with names learned from subagent activity', () => {
    const payload = parseSubagentPayload(
      {
        toolCallId: 'c1',
        rawInput: { prompt: 'split work', agentsStates: { thread_aaaaaa: { status: 'running' }, thread_bbbbbb: { status: 'errored', message: 'quota' } } },
        _meta: { codex: { collaboration: { tool: 'spawnAgent', receiverThreadIds: ['thread_aaaaaa', 'thread_bbbbbb'] } } },
      },
      'in_progress',
      undefined,
      new Map([['thread_aaaaaa', 'explorer']]),
    );
    expect(payload?.agents.map((a) => [a.id, a.status])).toEqual([['explorer', 'running'], ['agent-bbbbbb', 'failed']]);
  });
});

describe('OMP background jobs (spec 370)', () => {
  const start: ToolCall = {
    toolCallId: 't1',
    title: 'Spawning two parallel reviewers',
    kind: 'other',
    rawInput: { tasks: [{ name: 'ReviewSortCode', task: 'review sort' }, { name: 'ReviewRepo', task: 'review repo' }] },
  };
  const running = { state: 'running', jobId: 'ReviewSortCode', type: 'task' };

  function backgroundCard(): SubagentPayload {
    const card = parseSubagentPayload(
      {
        ...start,
        rawOutput: {
          details: {
            progress: [ompProgress('running'), { ...ompProgress('running'), id: 'ReviewRepo', index: 1 }],
            async: running,
          },
        },
      },
      'completed',
      undefined,
      NO_NAMES,
    );
    if (!card) throw new Error('card');
    return card;
  }

  function job(over: Partial<OmpJob>): OmpJob {
    return {
      id: 'ReviewSortCode', type: 'task', status: 'running', label: '', durationMs: 0, exitCode: null,
      agentId: 'ReviewSortCode', output: '', ...over,
    };
  }

  it('never moves an agent back when the spawn returns its spawn-time snapshot', () => {
    // Captured order: running frames, then the spawn's own `completed` frame
    // repeating `pending` with zero counters, then late frames with durationMs 0.
    const live = parseSubagentPayload(
      { ...start, rawOutput: { details: { progress: [ompProgress('running', { durationMs: 9000 })], async: running } } },
      'in_progress',
      undefined,
      NO_NAMES,
    );
    const returned = parseSubagentPayload(
      {
        ...start,
        rawOutput: {
          details: { progress: [ompProgress('pending', { recentTools: [], toolCount: 0, tokens: 0, durationMs: 0 })], async: running },
        },
      },
      'completed',
      live,
      NO_NAMES,
    );
    expect(returned?.agents[0]).toMatchObject({
      status: 'running', toolCount: 4, tokens: 38_000, durationMs: 9000, recentTools: ['grep', 'read'],
    });
    expect(returned?.background).toBe(true);
  });

  it('closes the background once every agent settled, whatever a late async frame says', () => {
    const card = backgroundCard();
    const late = parseSubagentPayload(
      {
        toolCallId: 't1',
        rawOutput: {
          details: {
            progress: [ompProgress('completed'), { ...ompProgress('completed'), id: 'ReviewRepo', index: 1 }],
            async: running,
          },
        },
      },
      'completed',
      card,
      NO_NAMES,
    );
    expect(late?.background).toBe(false);
    expect(late && subagentSummary(late)).toBe('2/2 done');
  });

  it('reads the jobs snapshot of a wait and leaves other wait shapes alone', () => {
    const snapshot = {
      content: [
        { type: 'text', text: '## Still Running (1)\n\n- `ReviewSortCode` [task] — 2m44s · 36 req' },
        { type: 'text', text: '<system-notice>\nWaiting is not progress.\n</system-notice>' },
      ],
      details: {
        op: 'wait',
        meta: { source: { type: 'report', value: 'background jobs snapshot' } },
        jobs: [
          { id: 'ReviewSortCode', type: 'task', status: 'running', label: 'ReviewSortCode', durationMs: 164900, requests: 36, agentUrlId: 'ReviewSortCode' },
          { id: 'build', type: 'bash', status: 'failed', label: 'npm run build', durationMs: 3200, exitCode: 2 },
        ],
      },
    };
    expect(parseOmpJobs(snapshot)?.jobs).toEqual([
      job({ label: 'ReviewSortCode', durationMs: 164900 }),
      { id: 'build', type: 'bash', status: 'failed', label: 'npm run build', durationMs: 3200, exitCode: 2, agentId: 'build', output: '' },
    ]);
    expect(parseOmpJobs({ details: { op: 'wait', jobs: [], interrupted: true } })).toEqual({ jobs: [], interrupted: true });
    // IRC peer wait: no jobs. vibe_wait: `op: "wait"` with another element shape.
    expect(parseOmpJobs({ details: { op: 'wait', from: 'OMP-2', waited: [{ text: 'hi' }] } })).toBeNull();
    expect(parseOmpJobs({ details: { op: 'wait', jobs: [{ name: 'vibe', state: 'done' }] } })).toBeNull();
    expect(parseOmpJobs({ details: { op: 'cancel', jobs: [] } })).toBeNull();
  });

  it('folds a settled job into its card by agent id, with the task-result body as output', () => {
    const card = backgroundCard();
    const resultText = '<task-result id="ReviewSortCode" agent="reviewer" status="completed" duration="2m">\n'
      + '<meta lines="2" size="1KB" />\n<preview full-output="agent://ReviewSortCode">\nLGTM\nall good\n</preview>\n'
      + '</task-result>\n\nReviewSortCode is now idle — message it via `write agent://ReviewSortCode`';
    const [settled] = parseOmpJobs({
      details: {
        op: 'wait',
        jobs: [{ id: 'ReviewSortCode-2', type: 'task', status: 'completed', label: 'x', durationMs: 120_000, resultText, agentUrlId: 'ReviewSortCode' }],
      },
    })?.jobs ?? [];
    const first = applyOmpJobs(card, [settled]);
    expect(first?.agents.map((a) => [a.id, a.status, a.output, a.durationMs])).toEqual([
      ['ReviewSortCode', 'completed', 'LGTM\nall good', 120_000],
      ['ReviewRepo', 'running', '', null],
    ]);
    // ReviewRepo is absent from the snapshot: absence settles nothing.
    expect(first?.background).toBe(true);

    const errorText = '<task-result id="ReviewRepo" agent="reviewer" status="failed (exit 1)" duration="1m">\n<error>boom</error>\n</task-result>';
    const failed = parseOmpJobs({
      details: { op: 'wait', jobs: [{ id: 'ReviewRepo', type: 'task', status: 'failed', durationMs: 60_000, errorText }] },
    })?.jobs ?? [];
    const second = first && applyOmpJobs(first, failed);
    expect(second?.agents[1]).toMatchObject({ status: 'failed', output: 'boom' });
    expect(second?.background).toBe(false);
    // A late running report cannot reopen a settled agent; nothing moved, no new payload.
    expect(second && applyOmpJobs(second, [job({ status: 'running', durationMs: 1 })])).toBeNull();
    expect(applyOmpJobs(card, [job({ agentId: 'SomeoneElse' })])).toBeNull();
  });

  it('marks a still-running card last reported until fresh data arrives', () => {
    const card = backgroundCard();
    const stale = markLastReported(card);
    expect(stale?.lastReported).toBe(true);
    expect(stale && subagentSummary(stale)).toBe('0/2 done · background · last reported');
    expect(stale && markLastReported(stale)).toBeNull();
    expect(markLastReported({ ...card, background: false })).toBeNull();
    // The same report again is still news: the card is live data, not a snapshot.
    const fresh = stale && applyOmpJobs(stale, [job({ durationMs: 0 })]);
    expect(fresh?.lastReported).toBe(false);
  });

  it('summarises a wait head by status', () => {
    const line = { label: '', exitCode: null, durationMs: 0, type: 'task' as const };
    expect(jobsSummary({
      jobs: [
        { ...line, id: 'a', status: 'completed' },
        { ...line, id: 'b', status: 'running' },
        { ...line, id: 'c', status: 'completed' },
      ],
      overflow: 0,
      interrupted: false,
    })).toBe('1 running · 2 done');
    expect(jobsSummary({ jobs: [], overflow: 0, interrupted: false })).toBe('no jobs');
    expect(jobsSummary({ jobs: [], overflow: 0, interrupted: true })).toBe('interrupted');
  });
});
