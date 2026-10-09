import { describe, expect, it } from 'vitest';

import {
  absorbChildToolCall,
  appendChildOutput,
  claudeParentToolUseId,
  parseSubagentPayload,
} from './harness-subagents';
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
