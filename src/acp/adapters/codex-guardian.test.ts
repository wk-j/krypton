import { describe, expect, it } from 'vitest';

import type { ToolCall, ToolCallUpdate } from '../types';
import { isCodexGuardianReview, parseGuardianReview } from './codex-guardian';
import { mergeToolCall } from './generic';

const id = 'guardian_assessment:review-1';

function content(text: string): NonNullable<ToolCall['content']> {
  return [{ type: 'content', content: { type: 'text', text } }];
}

function start(): ToolCall {
  return {
    toolCallId: id,
    kind: 'think',
    title: 'Guardian Review',
    status: 'in_progress',
    content: content('Status: In progress\nAction: MCP lesson_record on krypton-harness-memory'),
    rawInput: { review: { status: 'inProgress' }, action: { type: 'mcpToolCall' } },
  };
}

describe('Codex Guardian review', () => {
  it('recognizes only the exact adapter identity in a Codex lane', () => {
    expect(isCodexGuardianReview('codex', start())).toBe(true);
    expect(isCodexGuardianReview('claude', start())).toBe(false);
    expect(isCodexGuardianReview('codex', { ...start(), toolCallId: 'other:review-1' })).toBe(false);
    expect(isCodexGuardianReview('codex', { ...start(), kind: 'other' })).toBe(false);
    expect(isCodexGuardianReview('codex', { ...start(), title: 'Guardian Review copy' })).toBe(false);
  });

  it('updates one review from an in-progress start to an approved report', () => {
    const begun = start();
    const live = parseGuardianReview(begun, undefined, 'in_progress');
    expect(live).toMatchObject({
      outcome: 'reviewing',
      action: 'MCP lesson_record on krypton-harness-memory',
      risk: null,
      authorization: null,
      rationale: null,
    });

    const report: ToolCallUpdate = {
      toolCallId: id,
      status: 'completed',
      content: content('Status: Approved\nAction: MCP lesson_record on krypton-harness-memory\nRisk: medium\nAuthorization: high\nRationale: The user correction and lane instructions authorize this update.\nThe change is bounded.'),
      rawOutput: {
        review: {
          status: 'approved',
          riskLevel: 'medium',
          userAuthorization: 'high',
          rationale: 'The user correction and lane instructions authorize this update.\nThe change is bounded.',
        },
      },
    };
    const merged = mergeToolCall(begun, report);
    expect(isCodexGuardianReview('codex', merged)).toBe(true);
    expect(parseGuardianReview(merged, live, 'completed')).toEqual({
      outcome: 'approved',
      action: 'MCP lesson_record on krypton-harness-memory',
      risk: 'medium',
      authorization: 'high',
      rationale: 'The user correction and lane instructions authorize this update.\nThe change is bounded.',
      rationaleTruncated: false,
    });
  });

  it('shows a denial even when the ACP tool call completed successfully', () => {
    const review = parseGuardianReview(mergeToolCall(start(), {
      toolCallId: id,
      status: 'completed',
      content: content('Status: Denied\nAction: exec outside workspace\nRisk: high\nAuthorization: unknown\nRationale: Path not authorized.'),
    }), undefined, 'completed');
    expect(review).toMatchObject({
      outcome: 'denied',
      action: 'exec outside workspace',
      risk: 'high',
      authorization: 'unknown',
      rationale: 'Path not authorized.',
    });
  });

  it('never leaves a terminal review looking in progress after a status-only update', () => {
    const begun = start();
    const live = parseGuardianReview(begun, undefined, 'in_progress');
    const completed = mergeToolCall(begun, { toolCallId: id, status: 'completed' });
    const failed = mergeToolCall(begun, { toolCallId: id, status: 'failed' });
    expect(parseGuardianReview(completed, live, 'completed')).toMatchObject({
      outcome: 'unavailable', action: live.action,
    });
    expect(parseGuardianReview(failed, live, 'failed').outcome).toBe('failed');
  });

  it('retains a completed rationale on a later partial update', () => {
    const previous = parseGuardianReview({
      ...start(), status: 'completed',
      content: content('Status: Approved\nAction: MCP lesson_record\nRisk: low\nAuthorization: high\nRationale: Approved for the requested update.'),
    }, undefined, 'completed');
    const next = parseGuardianReview({ toolCallId: id }, previous, 'completed');
    expect(next).toEqual(previous);
  });

  it('distinguishes timeout and abort and bounds long rationale', () => {
    const timed = parseGuardianReview({
      ...start(), status: 'completed',
      rawOutput: { review: { status: 'timedOut', rationale: 'x'.repeat(5000) } },
    }, undefined, 'completed');
    expect(timed.outcome).toBe('timed_out');
    expect(timed.rationale?.length).toBe(4096);
    expect(timed.rationaleTruncated).toBe(true);
    expect(parseGuardianReview({ ...start(), status: 'completed', rawOutput: { review: { status: 'aborted' } } }, undefined, 'completed').outcome).toBe('aborted');
  });

  it('handles malformed fields without inventing an approval', () => {
    const review = parseGuardianReview({
      ...start(), status: 'completed', rawInput: { review: { status: 99 } },
      content: content('Unexpected output'),
    }, undefined, 'completed');
    expect(review).toMatchObject({
      outcome: 'unavailable',
      action: 'Action unavailable',
      rationale: null,
    });
  });
});
