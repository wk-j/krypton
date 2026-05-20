import { describe, expect, it } from 'vitest';
import {
  appendReviewValidationSuffix,
  composeReviewerPrompt,
  malformedFindingCount,
  reviewSummaryOrFallback,
  topLevelValidationErrorCount,
  validateReply,
} from './review';

describe('review reply validation', () => {
  it('accepts valid findings without a summary', () => {
    const validated = validateReply(
      {
        packet_id: 'pkt-1',
        findings: [
          {
            file: 'docs/spec.md',
            line: 12,
            severity: 'nit',
            concern: 'Clarify the deferred verification step.',
          },
        ],
      },
      'pkt-1',
      '/repo',
    );

    expect(validated.ok).toBe(true);
    expect(validated.cleanedFindings).toHaveLength(1);
    expect(malformedFindingCount(validated)).toBe(0);
    expect(reviewSummaryOrFallback(validated)).toBe('Reviewer returned structured findings without a summary.');
  });

  it('keeps usable findings when sibling findings are malformed', () => {
    const validated = validateReply(
      {
        packet_id: 'pkt-1',
        summary: 'Two issues found.',
        findings: [
          {
            file: 'src/app.ts',
            line: 20,
            severity: 'warn',
            concern: 'This branch can swallow a recoverable error.',
          },
          {
            file: 'src/app.ts',
            severity: 'nit',
            concern: 'Missing line should be omitted.',
          },
        ],
      },
      'pkt-1',
      '/repo',
    );

    expect(validated.ok).toBe(false);
    expect(validated.errors).toHaveLength(1);
    expect(validated.cleanedFindings).toHaveLength(1);
    expect(malformedFindingCount(validated)).toBe(1);
    expect(reviewSummaryOrFallback(validated)).toBe('Two issues found.');
  });

  it('counts malformed findings independently from top-level validation errors', () => {
    const validated = validateReply(
      {
        packet_id: 'pkt-1',
        findings: [
          {
            file: 'src/app.ts',
            severity: 'nit',
            concern: 'Missing line should be omitted.',
          },
        ],
      },
      'pkt-1',
      '/repo',
    );

    expect(malformedFindingCount(validated)).toBe(1);
    expect(topLevelValidationErrorCount(validated)).toBe(0);
  });

  it('truncates review summaries without chopping validation notes', () => {
    const suffix = ' (1 malformed finding omitted.)';
    const summary = 'x'.repeat(600);

    const delivered = appendReviewValidationSuffix(summary, suffix);

    expect(delivered).toHaveLength(600);
    expect(delivered.endsWith(suffix)).toBe(true);
  });

  it('treats empty or omitted findings as a clean review', () => {
    const validated = validateReply(
      {
        packet_id: 'pkt-1',
        summary: '',
        findings: [],
      },
      'pkt-1',
      '/repo',
    );

    expect(validated.ok).toBe(true);
    expect(validated.cleanedFindings).toHaveLength(0);
    expect(reviewSummaryOrFallback(validated)).toBe('(clean review - no findings)');

    const omitted = validateReply(
      {
        packet_id: 'pkt-1',
        summary: 'No issues found.',
      },
      'pkt-1',
      '/repo',
    );

    expect(omitted.ok).toBe(true);
    expect(omitted.cleanedFindings).toHaveLength(0);
    expect(reviewSummaryOrFallback(omitted)).toBe('No issues found.');
  });

  it('prompts for a best-effort review reply without protocol rejection language', () => {
    const prompt = composeReviewerPrompt(
      {
        packetId: 'pkt-1',
        fromLaneId: 'codex-1',
        toLaneId: 'claude-1',
        intent: '',
        repoRoot: '/repo',
        patchBase: 'head',
        hasStagedChanges: false,
        hasUnstagedChanges: true,
        partialStagingDetected: false,
        worktreeFingerprint: 'fp',
        diffstat: [],
        patchHunks: [],
        untrackedExcerpts: [{ path: 'src/app.ts', head: 'const x = 1;' }],
        commands: [],
        toolSummary: [],
        sentAt: 1,
      },
      'Codex-1',
    );

    expect(prompt).toContain('Send the result with review_reply');
    expect(prompt).toContain('Malformed findings are omitted instead of blocking the reply.');
    expect(prompt).not.toContain('Reply ONLY');
    expect(prompt).not.toContain('Prose-only replies are rejected');
  });
});
