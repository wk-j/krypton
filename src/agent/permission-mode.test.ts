import { describe, expect, it } from 'vitest';

import {
  type PermissionMode,
  decideCommandApproval,
  decideWriteApproval,
  nextPermissionMode,
  permissionModeDescription,
} from './permission-mode';

describe('nextPermissionMode', () => {
  it('cycles normal → acceptEdits → bypass → normal', () => {
    expect(nextPermissionMode('normal')).toBe('acceptEdits');
    expect(nextPermissionMode('acceptEdits')).toBe('bypass');
    expect(nextPermissionMode('bypass')).toBe('normal');
  });

  it('returns to start after three cycles', () => {
    let mode: PermissionMode = 'normal';
    for (let i = 0; i < 3; i++) mode = nextPermissionMode(mode);
    expect(mode).toBe('normal');
  });
});

describe('decideWriteApproval', () => {
  it('prompts in normal mode with no per-turn flags', () => {
    expect(
      decideWriteApproval({ rejectAllForTurn: false, mode: 'normal', acceptAllForTurn: false }),
    ).toBe('prompt');
  });

  it('auto-accepts in acceptEdits mode', () => {
    expect(
      decideWriteApproval({ rejectAllForTurn: false, mode: 'acceptEdits', acceptAllForTurn: false }),
    ).toBe('accept');
  });

  it('auto-accepts in bypass mode', () => {
    expect(
      decideWriteApproval({ rejectAllForTurn: false, mode: 'bypass', acceptAllForTurn: false }),
    ).toBe('accept');
  });

  it('honours per-turn accept-all in normal mode', () => {
    expect(
      decideWriteApproval({ rejectAllForTurn: false, mode: 'normal', acceptAllForTurn: true }),
    ).toBe('accept');
  });

  it('per-turn reject-all wins over an accept-mode (Codex blocker 4)', () => {
    expect(
      decideWriteApproval({ rejectAllForTurn: true, mode: 'acceptEdits', acceptAllForTurn: false }),
    ).toBe('reject');
    expect(
      decideWriteApproval({ rejectAllForTurn: true, mode: 'bypass', acceptAllForTurn: false }),
    ).toBe('reject');
  });
});

describe('decideCommandApproval', () => {
  it('prompts in normal mode', () => {
    expect(
      decideCommandApproval({
        rejectAllForTurn: false,
        mode: 'normal',
        acceptAllForTurn: false,
        highRisk: false,
      }),
    ).toBe('prompt');
  });

  it('acceptEdits does NOT auto-accept commands — they still gate', () => {
    expect(
      decideCommandApproval({
        rejectAllForTurn: false,
        mode: 'acceptEdits',
        acceptAllForTurn: false,
        highRisk: false,
      }),
    ).toBe('prompt');
  });

  it('bypass auto-accepts low-risk commands', () => {
    expect(
      decideCommandApproval({
        rejectAllForTurn: false,
        mode: 'bypass',
        acceptAllForTurn: false,
        highRisk: false,
      }),
    ).toBe('accept');
  });

  it('bypass auto-accepts HIGH-RISK commands (the explicit no-safety contract)', () => {
    expect(
      decideCommandApproval({
        rejectAllForTurn: false,
        mode: 'bypass',
        acceptAllForTurn: false,
        highRisk: true,
      }),
    ).toBe('accept');
  });

  it('per-turn accept-all never covers high-risk (spec 140 floor preserved)', () => {
    expect(
      decideCommandApproval({
        rejectAllForTurn: false,
        mode: 'normal',
        acceptAllForTurn: true,
        highRisk: true,
      }),
    ).toBe('prompt');
    expect(
      decideCommandApproval({
        rejectAllForTurn: false,
        mode: 'normal',
        acceptAllForTurn: true,
        highRisk: false,
      }),
    ).toBe('accept');
  });

  it('per-turn reject-all wins over bypass, even for high-risk', () => {
    expect(
      decideCommandApproval({
        rejectAllForTurn: true,
        mode: 'bypass',
        acceptAllForTurn: false,
        highRisk: true,
      }),
    ).toBe('reject');
  });
});

describe('permissionModeDescription', () => {
  it('describes every mode', () => {
    expect(permissionModeDescription('normal')).toMatch(/normal/);
    expect(permissionModeDescription('acceptEdits')).toMatch(/auto-edit/);
    expect(permissionModeDescription('bypass')).toMatch(/BYPASS/);
  });
});
