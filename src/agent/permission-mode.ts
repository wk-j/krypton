// Per-lane persistent permission mode for the single-agent Agent view (spec 147).
//
// The mode survives turn boundaries (NOT reset on agent_start) and is cycled with
// Shift+Tab. It is layered ON TOP of the spec-140 conservative classifier and the
// spec-99/100 per-turn approval flags — the classifier is intentionally untouched;
// `bypass` simply skips the gate. All decision logic lives here as pure functions so
// it is unit-testable without a DOM (matching `classifyBashCommand` in tools.ts).

export type PermissionMode = 'normal' | 'acceptEdits' | 'bypass';

export type ApprovalDecision = 'reject' | 'accept' | 'prompt';

/** Shift+Tab cycle order: normal → acceptEdits → bypass → normal. */
export function nextPermissionMode(mode: PermissionMode): PermissionMode {
  switch (mode) {
    case 'normal':
      return 'acceptEdits';
    case 'acceptEdits':
      return 'bypass';
    case 'bypass':
      return 'normal';
  }
}

/**
 * write_file gate decision. Precedence (spec 147 §Data Flow):
 *   1. per-turn reject-all wins over everything (Codex blocker 4)
 *   2. acceptEdits / bypass auto-accept
 *   3. per-turn accept-all
 *   4. otherwise prompt
 */
export function decideWriteApproval(p: {
  rejectAllForTurn: boolean;
  mode: PermissionMode;
  acceptAllForTurn: boolean;
}): ApprovalDecision {
  if (p.rejectAllForTurn) return 'reject';
  if (p.mode === 'acceptEdits' || p.mode === 'bypass') return 'accept';
  if (p.acceptAllForTurn) return 'accept';
  return 'prompt';
}

/**
 * bash gate decision. Precedence (spec 147 §Data Flow):
 *   1. per-turn reject-all wins over everything
 *   2. bypass auto-accepts ANY risk, including high-risk (the explicit no-safety state)
 *   3. per-turn accept-all only when NOT high-risk (spec 140 floor stays)
 *   4. otherwise prompt
 * acceptEdits does NOT auto-accept commands — they still gate.
 */
export function decideCommandApproval(p: {
  rejectAllForTurn: boolean;
  mode: PermissionMode;
  acceptAllForTurn: boolean;
  highRisk: boolean;
}): ApprovalDecision {
  if (p.rejectAllForTurn) return 'reject';
  if (p.mode === 'bypass') return 'accept';
  if (p.acceptAllForTurn && !p.highRisk) return 'accept';
  return 'prompt';
}

/** Human-readable description for the transient system message on cycle. */
export function permissionModeDescription(mode: PermissionMode): string {
  switch (mode) {
    case 'normal':
      return 'normal — every action prompts';
    case 'acceptEdits':
      return 'auto-edit — file writes auto-accepted; commands still prompt';
    case 'bypass':
      return 'BYPASS — everything auto-accepted, including high-risk';
  }
}
