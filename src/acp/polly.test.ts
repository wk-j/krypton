import { describe, expect, it } from 'vitest';
import {
  POLLY_ROLE_PROMPTS,
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
    // Omnigent parity: dispatches are structured by task title + purpose, and
    // synthesis reads worker reports/gates rather than trusting git status alone.
    expect(prompt).toContain('Title:');
    expect(prompt).toContain('Purpose:');
    expect(prompt).toContain('Scope:');
    expect(prompt).toContain('Acceptance:');
    expect(prompt).toContain('Files/areas:');
    expect(prompt).toContain('Tests/Gates:');
    expect(prompt).toContain('Report:');
    expect(prompt).toContain('implement');
    expect(prompt).toContain('explore');
    expect(prompt).toContain('search');
    expect(prompt).toContain('Use only the workers listed above');
    expect(prompt).toContain('unavailable for the rest of the run');
    expect(prompt).toContain('do not infer success from git status alone');
    expect(prompt).toContain('same implementer thread');
    expect(prompt).toContain('never auto-commit or auto-merge');
    expect(prompt).toContain('Blocking issues');
    expect(prompt).toContain('Non-blocking issues');
    expect(prompt).toContain('Suggestions');
    expect(prompt).toContain('diff + contract only');
    expect(prompt).toContain('Do not give reviewers the implementer transcript');
    // Handoff-only (spec 165): the orchestrator tracks task/worker status in its own
    // working context, NOT in handoff_set as a scratchpad task board.
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

describe('POLLY_ROLE_PROMPTS', () => {
  it('keeps orchestrator as delegating lead with gate verification', () => {
    const prompt = POLLY_ROLE_PROMPTS.orchestrator;
    expect(prompt).toContain('not the coder, investigator, or reviewer');
    expect(prompt).toContain('delegate coding work');
    expect(prompt).toContain('real investigation');
    expect(prompt).toContain('run deterministic gates');
    expect(prompt).toContain('never commit or merge');
  });

  it('keeps implementer review contract structured and read-only', () => {
    const prompt = POLLY_ROLE_PROMPTS.implementer;
    expect(prompt).toContain('Do not review your own work');
    expect(prompt).toContain('diff + contract');
    expect(prompt).toContain('Blocking issues');
    expect(prompt).toContain('Non-blocking issues');
    expect(prompt).toContain('Suggestions');
    expect(prompt).toContain('no edits');
  });
});
