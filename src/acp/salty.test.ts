import { describe, expect, it } from 'vitest';
import {
  SALTY_ROLE_PROMPTS,
  parseSaltyCommand,
  resolveSaltyModel,
  saltyExecutorPlan,
  saltyRequestPrompt,
  type SaltyRoster,
  type SaltyRosterExecutor,
} from './salty';

import type { ModelInfo } from './types';

const executor = (over: Partial<SaltyRosterExecutor>): SaltyRosterExecutor => ({
  displayName: 'Claude-2',
  laneId: 'claude-2',
  backendId: 'claude',
  role: 'mechanical',
  modelApply: { requested: 'sonnet', effective: 'claude-sonnet-5', applied: true },
  ...over,
});

const roster: SaltyRoster = {
  orchestrator: { displayName: 'Claude-1', laneId: 'claude-1', backendId: 'claude' },
  executors: [
    executor({ displayName: 'Claude-2', laneId: 'claude-2', role: 'mechanical' }),
    executor({
      displayName: 'Claude-3',
      laneId: 'claude-3',
      role: 'thinker',
      modelApply: { requested: 'opus', effective: 'claude-opus-4-8', applied: true },
    }),
    executor({
      displayName: 'Codex-1',
      laneId: 'codex-1',
      backendId: 'codex',
      role: 'codexPeer',
      modelApply: { effective: 'gpt-5.6-sol', applied: true },
    }),
  ],
  spawned: ['thinker'],
  missing: [],
  errored: [],
};

describe('parseSaltyCommand', () => {
  it('returns the task after #salty', () => {
    expect(parseSaltyCommand('#salty fix auth')).toEqual({
      kind: 'run',
      task: 'fix auth',
      includeFellow: false,
    });
  });

  it('parses +fellow before the task', () => {
    expect(parseSaltyCommand('#salty +fellow decide the storage layer')).toEqual({
      kind: 'run',
      task: 'decide the storage layer',
      includeFellow: true,
    });
  });

  it('parses clear', () => {
    expect(parseSaltyCommand('#salty clear')).toEqual({ kind: 'clear' });
  });

  it('returns empty task for bare #salty and bare +fellow', () => {
    expect(parseSaltyCommand('#salty')).toEqual({ kind: 'run', task: '', includeFellow: false });
    expect(parseSaltyCommand('#salty +fellow')).toEqual({
      kind: 'run',
      task: '',
      includeFellow: true,
    });
  });

  it('rejects #saltyx and other non-command prefixes', () => {
    expect(parseSaltyCommand('#saltyx fix auth')).toEqual({
      kind: 'run',
      task: '',
      includeFellow: false,
    });
  });
});

describe('saltyExecutorPlan', () => {
  it('defaults to mechanical + thinker + codex-peer', () => {
    expect(saltyExecutorPlan(false).map((s) => s.role)).toEqual([
      'mechanical',
      'thinker',
      'codexPeer',
    ]);
  });

  it('appends fellow when requested', () => {
    expect(saltyExecutorPlan(true).map((s) => s.role)).toEqual([
      'mechanical',
      'thinker',
      'codexPeer',
      'fellow',
    ]);
  });

  it('bypasses only the implementer tiers', () => {
    const byRole = Object.fromEntries(saltyExecutorPlan(true).map((s) => [s.role, s.bypass]));
    expect(byRole).toEqual({ mechanical: true, codexPeer: true, thinker: false, fellow: false });
  });

  it('never hard-codes a codex model (inherits lane_models.codex.active)', () => {
    const codex = saltyExecutorPlan(false).find((s) => s.role === 'codexPeer');
    expect(codex?.modelAlias).toBeUndefined();
  });
});

describe('resolveSaltyModel', () => {
  const models: ModelInfo[] = [
    { model_id: 'claude-sonnet-5', name: 'Claude Sonnet 5' },
    { model_id: 'claude-opus-4-8', name: 'Claude Opus 4.8' },
    { model_id: 'claude-fable-5', name: 'Claude Fable 5' },
  ];

  it('matches an exact model_id', () => {
    expect(resolveSaltyModel('claude-opus-4-8', models)?.model_id).toBe('claude-opus-4-8');
  });

  it('matches a unique case-insensitive substring over id/name', () => {
    expect(resolveSaltyModel('opus', models)?.model_id).toBe('claude-opus-4-8');
    expect(resolveSaltyModel('Fable', models)?.model_id).toBe('claude-fable-5');
  });

  it('returns null for no match, ambiguous match, or empty inputs', () => {
    expect(resolveSaltyModel('gemini', models)).toBeNull();
    expect(resolveSaltyModel('claude', models)).toBeNull(); // ambiguous — never guess
    expect(resolveSaltyModel('', models)).toBeNull();
    expect(resolveSaltyModel('opus', [])).toBeNull();
  });
});

describe('saltyRequestPrompt', () => {
  it('lists the roster with tiers and scripts the full loop', () => {
    const prompt = saltyRequestPrompt({ task: 'Add JWT refresh', roster, intent: 'notes' });
    expect(prompt).toContain('Claude-1');
    expect(prompt).toContain('Claude-2');
    expect(prompt).toContain('Claude-3');
    expect(prompt).toContain('Codex-1');
    expect(prompt).toContain('Add JWT refresh');
    expect(prompt).toContain('peer_send');
    // The gist's loop order: plan → pushback → tiered dispatch → verify → synthesize.
    expect(prompt).toContain('Pushback gate');
    expect(prompt).toContain('Dispatch by tier');
    expect(prompt).toContain('no fan-out for ordinary slices');
    expect(prompt).toContain('cross-review');
    expect(prompt).toContain('never infer success from git status alone');
    expect(prompt).toContain('never auto-commit or auto-merge');
    // Structured dispatch headings (Polly parity).
    expect(prompt).toContain('Title:');
    expect(prompt).toContain('Purpose:');
    expect(prompt).toContain('Scope:');
    expect(prompt).toContain('Acceptance:');
    expect(prompt).toContain('Files/areas:');
    expect(prompt).toContain('Tests/Gates:');
    expect(prompt).toContain('Report:');
    // Shared-worktree adaptation of the gist's worktree merge step.
    expect(prompt).toContain('shared worktree');
    expect(prompt).toContain('single unstaged change-set');
    expect(prompt).toContain('no per-executor worktrees to merge');
    // Best-effort framing (ADR-0012) + state discipline (spec 165) + live plan (spec 166).
    expect(prompt).toContain('the harness does not enforce them');
    expect(prompt).toContain('working context');
    expect(prompt).toContain('Plan panel');
    // Default roster has no fellow — the prompt says how to opt in.
    expect(prompt).toContain('#salty +fellow');
  });

  it('surfaces degraded tiers to the orchestrator', () => {
    const degraded: SaltyRoster = {
      ...roster,
      executors: [
        executor({
          displayName: 'Claude-2',
          role: 'mechanical',
          modelApply: { requested: 'sonnet', effective: 'claude-opus-4-8', applied: false },
        }),
        ...roster.executors.slice(1),
      ],
    };
    const prompt = saltyRequestPrompt({ task: 't', roster: degraded, intent: '' });
    expect(prompt).toContain('Degraded tiers this run');
    expect(prompt).toContain('DEGRADED — requested sonnet');
  });

  it('routes cross-review to thinker when only one implementer is live', () => {
    const oneImplementer: SaltyRoster = {
      ...roster,
      executors: roster.executors.filter((e) => e.role !== 'codexPeer'),
    };
    const prompt = saltyRequestPrompt({ task: 't', roster: oneImplementer, intent: '' });
    expect(prompt).toContain('Only one implementer');
    expect(prompt).toContain('route its cross-review');
  });

  it('drops the fellow opt-in note when a fellow is present', () => {
    const withFellow: SaltyRoster = {
      ...roster,
      executors: [
        ...roster.executors,
        executor({
          displayName: 'Claude-4',
          laneId: 'claude-4',
          role: 'fellow',
          modelApply: { requested: 'fable', effective: 'claude-fable-5', applied: true },
        }),
      ],
    };
    const prompt = saltyRequestPrompt({ task: 't', roster: withFellow, intent: '' });
    expect(prompt).not.toContain('#salty +fellow');
    expect(prompt).toContain('Claude-4');
  });
});

describe('SALTY_ROLE_PROMPTS', () => {
  it('keeps the orchestrator planning-only with the gist contract', () => {
    const prompt = SALTY_ROLE_PROMPTS.orchestrator;
    expect(prompt).toContain('architectural decisions ONLY');
    expect(prompt).toContain('Never write source code yourself unless');
    expect(prompt).toContain('Never assume the user');
    expect(prompt).toContain('pushback');
    expect(prompt).toContain('caution over speed');
    expect(prompt).toContain('file:line');
    expect(prompt).toContain('Never commit or merge');
    expect(prompt).toContain('not in handoff_set');
  });

  it('keeps responder tiers read-only and lifecycle-safe', () => {
    for (const role of ['thinker', 'fellow'] as const) {
      expect(SALTY_ROLE_PROMPTS[role]).toContain('Do not edit files');
      expect(SALTY_ROLE_PROMPTS[role]).toContain('done: true');
    }
    expect(SALTY_ROLE_PROMPTS.mechanical).toContain('do not review your own work');
    expect(SALTY_ROLE_PROMPTS.codexPeer).toContain('Do not review your own implementation work');
  });
});
