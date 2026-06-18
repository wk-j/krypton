import { describe, expect, it } from 'vitest';
import {
  POLLY_WORKER_BACKENDS,
  parsePollyTask,
  pollyWorkerBackendsFor,
  pollyRequestPrompt,
  type PollyRoster,
} from './polly';

const roster: PollyRoster = {
  orchestrator: { displayName: 'Grok-1', laneId: 'grok-0', backendId: 'grok' },
  workers: [
    { displayName: 'Cursor-1', laneId: 'cursor-1', backendId: 'cursor' },
    { displayName: 'Claude-1', laneId: 'claude-1', backendId: 'claude' },
  ],
  spawned: ['claude'],
  missing: [],
  errored: [],
};

const cursorOrchestratorRoster: PollyRoster = {
  orchestrator: { displayName: 'Cursor-1', laneId: 'cursor-0', backendId: 'cursor' },
  workers: [
    { displayName: 'Claude-1', laneId: 'claude-1', backendId: 'claude' },
    { displayName: 'Codex-1', laneId: 'codex-1', backendId: 'codex' },
  ],
  spawned: ['codex'],
  missing: [],
  errored: [],
};

describe('parsePollyTask', () => {
  it('returns text after #polly', () => {
    expect(parsePollyTask('#polly fix auth')).toBe('fix auth');
  });

  it('returns empty for bare #polly', () => {
    expect(parsePollyTask('#polly')).toBe('');
  });

  it('rejects #pollyx and other non-command prefixes', () => {
    expect(parsePollyTask('#pollyx fix auth')).toBe('');
  });
});

describe('pollyWorkerBackendsFor', () => {
  it('excludes cursor when cursor orchestrates', () => {
    expect(pollyWorkerBackendsFor('cursor')).toEqual(['claude', 'codex']);
  });

  it('excludes claude when claude orchestrates', () => {
    expect(pollyWorkerBackendsFor('claude')).toEqual(['cursor', 'codex']);
  });

  it('uses cursor and claude when the orchestrator is outside the worker pool', () => {
    expect(pollyWorkerBackendsFor('grok')).toEqual(['cursor', 'claude']);
  });
});

describe('pollyRequestPrompt', () => {
  it('lists workers and orchestrator', () => {
    const prompt = pollyRequestPrompt({ task: 'Add JWT refresh', roster, intent: 'Polly research' });
    expect(prompt).toContain('Grok-1');
    expect(prompt).toContain('Cursor-1');
    expect(prompt).toContain('Claude-1');
    expect(prompt).toContain('Add JWT refresh');
    expect(prompt).toContain('peer_send');
    expect(prompt).toContain('Cross-review');
    // Handoff-only (spec 165): the orchestrator tracks task/worker status in its own
    // working context, NOT in memory_set as a scratchpad task board.
    expect(prompt).toContain('working context');
    // spec 166: orchestrator emits a live plan/todo list (one entry per slice) so the
    // human can observe progress in the harness Plan panel.
    expect(prompt).toContain('Plan panel');
    expect(prompt).toContain('entry per slice');
  });

  it('lists a two-worker roster when cursor orchestrates', () => {
    const prompt = pollyRequestPrompt({
      task: 'Add JWT refresh',
      roster: cursorOrchestratorRoster,
      intent: 'Polly research',
    });
    expect(prompt).toContain('Cursor-1');
    expect(prompt).toContain('Claude-1');
    expect(prompt).toContain('Codex-1');
    expect(prompt).toContain('Track 2 workers');
    expect(prompt).not.toContain('these three');
  });

  it('covers fixed worker backends constant', () => {
    expect(POLLY_WORKER_BACKENDS).toEqual(['cursor', 'claude', 'codex']);
  });
});
