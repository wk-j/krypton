import { describe, expect, it } from 'vitest';
import {
  DEBBY_HEAD_BACKENDS,
  DEBBY_ROLE_PROMPTS,
  parseDebbyTask,
  isDebbyHeadBackend,
  debbyHeadBackendsFor,
  debbyRequestPrompt,
  type DebbyRoster,
} from './debby';

const roster: DebbyRoster = {
  orchestrator: { displayName: 'Grok-1', laneId: 'grok-0', backendId: 'grok' },
  heads: [
    { displayName: 'Claude-1', laneId: 'claude-1', backendId: 'claude' },
    { displayName: 'Codex-1', laneId: 'codex-1', backendId: 'codex' },
  ],
  spawned: ['claude', 'codex'],
  missing: [],
  errored: [],
};

// Orchestrator runs on a head backend (claude): Debby still ensures a SEPARATE
// claude head lane distinct from the orchestrator (duplicate-backend lane).
const claudeOrchestratorRoster: DebbyRoster = {
  orchestrator: { displayName: 'Claude-1', laneId: 'claude-0', backendId: 'claude' },
  heads: [
    { displayName: 'Claude-2', laneId: 'claude-2', backendId: 'claude' },
    { displayName: 'Codex-1', laneId: 'codex-1', backendId: 'codex' },
  ],
  spawned: ['claude', 'codex'],
  missing: [],
  errored: [],
};

describe('DEBBY_ROLE_PROMPTS', () => {
  it('orchestrator fans to both heads and never answers from a single model', () => {
    const p = DEBBY_ROLE_PROMPTS.orchestrator;
    expect(p).toMatch(/never answer from a single model/i);
    expect(p).toContain('claude + codex');
    expect(p).toContain('peer_send');
    // brainstorming-only — no file edits / commits (Codex warning fix).
    expect(p).toMatch(/do not edit files or write code/i);
    expect(p).toMatch(/never commit/i);
    expect(p).not.toMatch(/edit docs\/?markdown/i);
  });

  it('head is a plain responder: peer_send, no done:true, no coding unless asked', () => {
    const p = DEBBY_ROLE_PROMPTS.head;
    expect(p).toMatch(/NOT a coding agent/i);
    expect(p).toContain('peer_send');
    expect(p).toMatch(/do NOT set `done: true`/i);
    expect(p).toMatch(/unless the question explicitly asks/i);
    // ANSWER / CRITIQUE modes are load-bearing for the debate procedure.
    expect(p).toContain('ANSWER');
    expect(p).toContain('CRITIQUE');
  });
});

describe('parseDebbyTask', () => {
  it('returns text after #debby', () => {
    expect(parseDebbyTask('#debby should we use SQLite or Postgres?')).toBe(
      'should we use SQLite or Postgres?',
    );
  });

  it('returns empty for bare #debby', () => {
    expect(parseDebbyTask('#debby')).toBe('');
  });

  it('rejects #debbyx and other non-command prefixes', () => {
    expect(parseDebbyTask('#debbyx fix auth')).toBe('');
  });
});

describe('isDebbyHeadBackend', () => {
  it('accepts claude and codex', () => {
    expect(isDebbyHeadBackend('claude')).toBe(true);
    expect(isDebbyHeadBackend('codex')).toBe(true);
  });

  it('rejects cursor, grok and others', () => {
    expect(isDebbyHeadBackend('cursor')).toBe(false);
    expect(isDebbyHeadBackend('grok')).toBe(false);
  });
});

describe('debbyHeadBackendsFor', () => {
  it('always returns both heads', () => {
    expect(debbyHeadBackendsFor()).toEqual(['claude', 'codex']);
  });

  it('returns a fresh array (not the frozen constant)', () => {
    expect(debbyHeadBackendsFor()).not.toBe(DEBBY_HEAD_BACKENDS);
    expect(debbyHeadBackendsFor()).toEqual([...DEBBY_HEAD_BACKENDS]);
  });
});

describe('debbyRequestPrompt', () => {
  it('lists heads and orchestrator with side-by-side layout', () => {
    const prompt = debbyRequestPrompt({
      task: 'Should we ship feature flags now?',
      roster,
      intent: 'Debby brainstorm',
    });
    expect(prompt).toContain('Grok-1');
    expect(prompt).toContain('Claude-1');
    expect(prompt).toContain('Codex-1');
    expect(prompt).toContain('Should we ship feature flags now?');
    expect(prompt).toContain('peer_send');
    // Fan-out + side-by-side presentation, not a single answer.
    expect(prompt).toContain('Fan out');
    expect(prompt).toContain('🟠 Claude');
    expect(prompt).toContain('🔵 Codex');
    expect(prompt).toContain('Where they agree / differ');
    // Debate procedure travels inline (default 1 round).
    expect(prompt).toContain('Debate');
    expect(prompt).toContain('default 1 round');
    expect(prompt).toContain('Synthesis');
    // Handoff-only (spec 165): track head status in working context, not handoff_set.
    expect(prompt).toContain('working context');
  });

  it('handles a duplicate-backend head when the orchestrator is claude', () => {
    const prompt = debbyRequestPrompt({
      task: 'Should we ship feature flags now?',
      roster: claudeOrchestratorRoster,
      intent: 'Debby brainstorm',
    });
    expect(prompt).toContain('Claude-2');
    expect(prompt).toContain('Codex-1');
    expect(prompt).toContain('peer_send all 2');
  });

  it('falls back when no intent recorded', () => {
    const prompt = debbyRequestPrompt({ task: 'pricing strategy', roster, intent: '' });
    expect(prompt).toContain('none recorded');
  });

  it('covers fixed head backends constant', () => {
    expect(DEBBY_HEAD_BACKENDS).toEqual(['claude', 'codex']);
  });
});
