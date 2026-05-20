// Review Lane Mode (spec 112) — packet build, prompt composer, reply validator.
//
// V0.5 scope: structured git packet + reviewer prompt + best-effort
// per-finding cleanup for review replies.

import type {
  ReviewCommandSummary,
  ReviewFinding,
  ReviewGitState,
  ReviewPacket,
  ReviewReply,
  ReviewToolSummary,
} from './types';

export const TOTAL_PATCH_CAP = 40_960;
export const PER_FILE_HUNK_CAP = 8_192;
export const UNTRACKED_HEAD_LINES = 40;
export const UNTRACKED_HEAD_BYTES = 4_096;
export const INTENT_CAP = 2_000;
export const COMMAND_RESULT_TAIL = 400;
export const SUMMARY_CAP = 600;
export const CONCERN_CAP = 200;

export interface TranscriptSignal {
  intent: string;
  commands: ReviewCommandSummary[];
  toolSummary: ReviewToolSummary[];
}

export interface BuildPacketInput {
  packetId: string;
  fromLaneId: string;
  toLaneId: string;
  note: string | undefined;
  signals: TranscriptSignal;
  git: ReviewGitState;
  sentAt: number;
  harnessId: string | undefined;
}

export function buildPacket(input: BuildPacketInput): ReviewPacket {
  return {
    packetId: input.packetId,
    fromLaneId: input.fromLaneId,
    toLaneId: input.toLaneId,
    intent: input.signals.intent.slice(0, INTENT_CAP),
    repoRoot: input.git.repoRoot,
    patchBase: 'head',
    hasStagedChanges: input.git.hasStagedChanges,
    hasUnstagedChanges: input.git.hasUnstagedChanges,
    partialStagingDetected: input.git.partialStagingDetected,
    worktreeFingerprint: input.git.worktreeFingerprint,
    diffstat: input.git.diffstat,
    patchHunks: input.git.patchHunks,
    untrackedExcerpts: input.git.untrackedExcerpts,
    commands: input.signals.commands,
    toolSummary: input.signals.toolSummary,
    note: input.note?.trim() || undefined,
    sentAt: input.sentAt,
    harnessId: input.harnessId,
  };
}

/** Compose the reviewer-facing prompt as a single user-turn message. */
export function composeReviewerPrompt(packet: ReviewPacket, fromDisplayName: string): string {
  const lines: string[] = [];
  lines.push(`[review request] From ${fromDisplayName} (packet: ${packet.packetId}):`);
  lines.push('');
  if (packet.note) {
    lines.push(`Note: ${packet.note}`);
    lines.push('');
  }
  lines.push('## Working-tree state');
  lines.push(`- repo root: ${packet.repoRoot}`);
  lines.push(
    `- staging: staged=${packet.hasStagedChanges ? 'yes' : 'no'} · unstaged=${
      packet.hasUnstagedChanges ? 'yes' : 'no'
    } · partial=${packet.partialStagingDetected ? 'yes' : 'no'}`,
  );
  if (packet.partialStagingDetected) {
    lines.push(
      '  WARNING — some paths differ in both index and worktree; the patch below reflects worktree state and may not match what would be committed.',
    );
  }
  lines.push('');

  if (packet.intent.trim().length > 0) {
    lines.push('## Intent');
    lines.push(packet.intent.trim());
    lines.push('');
  }

  lines.push('## Patch (vs HEAD)');
  if (packet.diffstat.length === 0) {
    lines.push('(no tracked changes)');
  } else {
    const added = packet.diffstat.reduce((s, e) => s + e.added, 0);
    const removed = packet.diffstat.reduce((s, e) => s + e.removed, 0);
    lines.push(`Diffstat: ${packet.diffstat.length} files changed, +${added} / -${removed}`);
    for (const e of packet.diffstat) {
      lines.push(`  ${e.status}  ${e.path}    (+${e.added} / -${e.removed})`);
    }
  }
  lines.push('');

  if (packet.patchHunks.length > 0) {
    lines.push('```diff');
    for (const h of packet.patchHunks) {
      lines.push(`--- ${h.path} (${h.status}${h.truncated ? ', truncated' : ''}) ---`);
      lines.push(h.hunk);
    }
    lines.push('```');
    lines.push('');
  }

  if (packet.untrackedExcerpts.length > 0) {
    lines.push('Untracked excerpts:');
    for (const u of packet.untrackedExcerpts) {
      lines.push(`  ${u.path} (head):`);
      for (const ln of u.head.split('\n')) lines.push(`    ${ln}`);
    }
    lines.push('');
  }

  if (packet.commands.length > 0) {
    lines.push('## Commands run (best-effort)');
    for (const c of packet.commands) {
      const exit = c.exitCode === null ? 'exit ?' : `exit ${c.exitCode}`;
      lines.push(`- \`${c.command}\` → ${exit}`);
    }
    lines.push('');
  }

  if (packet.toolSummary.length > 0) {
    lines.push('## Tool summary');
    for (const t of packet.toolSummary) {
      lines.push(`- ${t.kind}: ${t.subject} (×${t.count})`);
    }
    lines.push('');
  }

  lines.push(
    '[review request] Send the result with review_reply({ packet_id: "' +
      packet.packetId +
      '", summary, findings }).',
  );
  lines.push(
    'Use findings: [] for a clean review. For actionable findings, include file, line, severity (block | warn | nit), concern, and optional suggested_check. Malformed findings are omitted instead of blocking the reply.',
  );
  return lines.join('\n');
}

export interface FindingValidationError {
  index: number;
  message: string;
}

export interface ValidatedReply {
  ok: boolean;
  errors: FindingValidationError[];
  cleanedFindings: ReviewFinding[];
  summary: string;
}

/**
 * Per-finding validator. Returns ok:false if any finding is invalid OR summary is missing.
 * Partial validity is reported via errors[]; the caller decides whether to accept partial or retry.
 */
export function validateReply(
  raw: unknown,
  expectedPacketId: string,
  repoRoot: string,
): ValidatedReply {
  const errors: FindingValidationError[] = [];
  const cleaned: ReviewFinding[] = [];

  if (typeof raw !== 'object' || raw === null) {
    return { ok: false, errors: [{ index: -1, message: 'reply payload is not an object' }], cleanedFindings: [], summary: '' };
  }
  const obj = raw as Record<string, unknown>;
  if (obj.packet_id !== expectedPacketId) {
    return {
      ok: false,
      errors: [{ index: -1, message: `packet_id mismatch (expected ${expectedPacketId})` }],
      cleanedFindings: [],
      summary: '',
    };
  }
  const summary = typeof obj.summary === 'string' ? obj.summary.slice(0, SUMMARY_CAP) : '';
  const findingsValue = obj.findings;
  const findingsRaw = findingsValue === undefined ? [] : Array.isArray(findingsValue) ? findingsValue : null;
  if (findingsRaw === null) {
    return {
      ok: false,
      errors: [{ index: -1, message: 'findings must be an array when provided' }],
      cleanedFindings: [],
      summary,
    };
  }

  findingsRaw.forEach((f, idx) => {
    if (typeof f !== 'object' || f === null) {
      errors.push({ index: idx, message: 'finding is not an object' });
      return;
    }
    const fo = f as Record<string, unknown>;
    const file = typeof fo.file === 'string' ? fo.file.trim() : '';
    const line = typeof fo.line === 'number' && Number.isInteger(fo.line) ? fo.line : null;
    const severity = fo.severity;
    const concern = typeof fo.concern === 'string' ? fo.concern.trim() : '';
    const suggestedCheck =
      typeof fo.suggested_check === 'string'
        ? fo.suggested_check.trim()
        : typeof fo.suggestedCheck === 'string'
          ? (fo.suggestedCheck as string).trim()
          : '';

    if (file.length === 0) {
      errors.push({ index: idx, message: 'file is required' });
      return;
    }
    if (line === null || line < 1) {
      errors.push({ index: idx, message: 'line is required (1-based positive integer)' });
      return;
    }
    if (severity !== 'block' && severity !== 'warn' && severity !== 'nit') {
      errors.push({ index: idx, message: 'severity must be one of block | warn | nit' });
      return;
    }
    if (concern.length === 0) {
      errors.push({ index: idx, message: 'concern is required' });
      return;
    }
    if (concern.length > CONCERN_CAP) {
      errors.push({ index: idx, message: `concern exceeds ${CONCERN_CAP} chars` });
      return;
    }
    if (severity === 'block' && suggestedCheck.length === 0) {
      errors.push({ index: idx, message: 'severity=block requires suggested_check' });
      return;
    }
    // Reject paths that escape repoRoot. ".." segments are rejected outright;
    // absolute paths must sit under repoRoot with a trailing separator (so
    // /repo-rooted-other is not accepted when repoRoot is /repo).
    const segments = file.split('/');
    if (segments.some((s) => s === '..')) {
      errors.push({ index: idx, message: 'file path may not contain ".." segments' });
      return;
    }
    const repoRootWithSep = repoRoot.endsWith('/') ? repoRoot : `${repoRoot}/`;
    let normalized = file;
    if (file.startsWith('/')) {
      if (file === repoRoot || file.startsWith(repoRootWithSep)) {
        normalized = file.slice(repoRootWithSep.length);
      } else {
        errors.push({ index: idx, message: 'absolute file path is outside repoRoot' });
        return;
      }
    }
    normalized = normalized.replace(/^\/+/, '');
    cleaned.push({
      file: normalized,
      line,
      severity,
      concern,
      suggestedCheck: suggestedCheck.length > 0 ? suggestedCheck : undefined,
    });
  });

  return { ok: errors.length === 0, errors, cleanedFindings: cleaned, summary };
}

export function malformedFindingCount(validated: ValidatedReply): number {
  return validated.errors.filter((e) => e.index >= 0).length;
}

export function topLevelValidationErrorCount(validated: ValidatedReply): number {
  return validated.errors.filter((e) => e.index < 0).length;
}

export function reviewSummaryOrFallback(validated: ValidatedReply, fallback: string = ''): string {
  const summary = validated.summary.trim() || fallback.trim();
  if (summary.length > 0) return summary.slice(0, SUMMARY_CAP);
  if (validated.cleanedFindings.length > 0) {
    return 'Reviewer returned structured findings without a summary.';
  }
  return '(clean review - no findings)';
}

export function appendReviewValidationSuffix(summary: string, validationSuffix: string): string {
  if (validationSuffix.length === 0) return summary.slice(0, SUMMARY_CAP);
  const summaryCap = Math.max(0, SUMMARY_CAP - validationSuffix.length);
  return `${summary.slice(0, summaryCap)}${validationSuffix}`;
}

export function buildReply(input: {
  packetId: string;
  fromLaneId: string;
  toLaneId: string;
  findings: ReviewFinding[];
  summary: string;
  interruptedReason?: string;
  sentAt: number;
  harnessId?: string;
}): ReviewReply {
  return { ...input };
}
