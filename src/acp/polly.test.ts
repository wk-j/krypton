import { describe, expect, it } from 'vitest';
import {
  POLLY_WORKER_BACKENDS,
  parsePollyTask,
  pollyRequestPrompt,
  type PollyRoster,
} from './polly';

const roster: PollyRoster = {
  orchestrator: { displayName: 'Grok-1', laneId: 'grok-0', backendId: 'grok' },
  workers: [
    { displayName: 'Cursor-1', laneId: 'cursor-1', backendId: 'cursor' },
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
});

describe('pollyRequestPrompt', () => {
  it('lists all three workers and orchestrator', () => {
    const prompt = pollyRequestPrompt({ task: 'Add JWT refresh', roster, intent: 'Polly research' });
    expect(prompt).toContain('Grok-1');
    expect(prompt).toContain('Cursor-1');
    expect(prompt).toContain('Claude-1');
    expect(prompt).toContain('Codex-1');
    expect(prompt).toContain('Add JWT refresh');
    expect(prompt).toContain('peer_send');
    expect(prompt).toContain('Cross-review');
    expect(prompt).toContain('memory_set');
  });

  it('covers fixed worker backends constant', () => {
    expect(POLLY_WORKER_BACKENDS).toEqual(['cursor', 'claude', 'codex']);
  });
});
