import { describe, expect, it } from 'vitest';

import type { ToolCall } from '../types';
import { claudeAdapter } from './claude';
import { codexAdapter } from './codex';
import { genericAdapter } from './generic';
import { grokAdapter } from './grok';
import { ompAdapter } from './omp';
import { adapterFor } from './registry';
import { toolEventSource } from './test-utils';
import type { LaneAdapter } from './types';

// Spec 380 — a `'no'` in the supply matrix is a claim about Krypton's own
// code: no adapter step can fill that field for that backend. These tests keep
// the claims true. `'yes'` is only set from captured wire (the contract test).

const ADAPTERS: readonly LaneAdapter[] = [claudeAdapter, codexAdapter, grokAdapter, ompAdapter];

/** One call of each subagent shape Krypton reads (spec 282). */
const SUBAGENT_SPAWNS: ReadonlyArray<Partial<ToolCall> & { toolCallId: string }> = [
  {
    toolCallId: 'omp-task',
    kind: 'other',
    title: 'task',
    status: 'in_progress',
    rawInput: { tasks: [{ task: 'look around', name: 'scout' }] },
  },
  {
    toolCallId: 'claude-task',
    kind: 'think',
    title: 'Task',
    status: 'in_progress',
    rawInput: { description: 'scout', prompt: 'look around' },
    _meta: { claudeCode: { toolName: 'Task' } },
  },
  {
    toolCallId: 'codex-spawn',
    kind: 'other',
    title: 'spawnAgent',
    status: 'in_progress',
    rawInput: { prompt: 'look around' },
    _meta: { codex: { collaboration: { tool: 'spawnAgent', receiverThreadIds: ['thread-1'] } } },
  },
];

describe('supply matrix (spec 380)', () => {
  it('gives every backend adapter a matrix, and unknown backends the unverified one', () => {
    for (const adapter of ADAPTERS) expect(adapterFor(adapter.id).supplies).toBe(adapter.supplies);
    expect(adapterFor('opencode')).toBe(genericAdapter);
    expect(Object.values(genericAdapter.supplies).every((supply) => supply === 'unverified')).toBe(true);
  });

  it('claims no turn state only where no adapter step reads one', () => {
    for (const adapter of ADAPTERS) {
      if (adapter.supplies.turnState === 'no') expect(adapter.turnState, adapter.id).toBeUndefined();
      if (adapter.turnState) expect(adapter.supplies.turnState, adapter.id).not.toBe('no');
    }
  });

  it('claims no subagents only where no subagent shape becomes a card', () => {
    for (const adapter of ADAPTERS) {
      const source = toolEventSource(adapter.id);
      const cards = SUBAGENT_SPAWNS.map((call) => source.call(call).view.subagents).filter(Boolean);
      if (adapter.supplies.subagents === 'no') expect(cards, adapter.id).toEqual([]);
      else expect(cards.length, adapter.id).toBeGreaterThan(0);
    }
  });
});
