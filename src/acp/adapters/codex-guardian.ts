// Spec 378 — Codex Guardian review is a tool-call-shaped presentation event,
// not a permission request. Decode it before generic tool output is
// line-limited. Moved from `harness-guardian-review.ts` (spec 380 phase 4).

import type { GuardianReviewPayload } from '../harness-view-types';
import type { ToolCall, ToolCallUpdate } from '../types';

const GUARDIAN_ID_PREFIX = 'guardian_assessment:';
const ACTION_LIMIT = 240;
const RATIONALE_LIMIT = 4096;

type ReviewFields = {
  status?: string;
  action?: string;
  risk?: string;
  authorization?: string;
  rationale?: string;
};

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function nonempty(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function structuredFields(value: unknown): ReviewFields {
  const review = record(record(value)?.review);
  if (!review) return {};
  return {
    status: nonempty(review.status),
    risk: nonempty(review.riskLevel),
    authorization: nonempty(review.userAuthorization),
    rationale: nonempty(review.rationale),
  };
}

function contentFields(content: ToolCall['content']): ReviewFields {
  const text = content?.find((item) => item.type === 'content' && item.content?.type === 'text')?.content;
  if (text?.type !== 'text') return {};
  const fields: ReviewFields = {};
  let inRationale = false;
  for (const line of text.text.split(/\r?\n/)) {
    const label = line.match(/^(Status|Action|Risk|Authorization|Rationale):\s*(.*)$/i);
    if (label) {
      const key = label[1].toLowerCase() as keyof ReviewFields;
      fields[key] = label[2].trim();
      inRationale = key === 'rationale';
    } else if (inRationale) {
      fields.rationale = `${fields.rationale ?? ''}\n${line}`;
    }
  }
  return fields;
}

function outcome(value: string | undefined): GuardianReviewPayload['outcome'] | null {
  switch (value?.toLowerCase().replace(/[\s_-]/g, '')) {
    case 'inprogress': return 'reviewing';
    case 'approved': return 'approved';
    case 'denied': return 'denied';
    case 'timedout': return 'timed_out';
    case 'aborted': return 'aborted';
    case 'failed': return 'failed';
    default: return null;
  }
}

function enumValue(value: string | undefined, allowed: readonly string[]): string | null {
  const normalized = value?.toLowerCase();
  return normalized && allowed.includes(normalized) ? normalized : null;
}

function bounded(value: string, limit: number): { text: string; truncated: boolean } {
  if (value.length <= limit) return { text: value, truncated: false };
  const end = /[\uD800-\uDBFF]/.test(value[limit - 1]) ? limit - 1 : limit;
  return { text: value.slice(0, end).trimEnd(), truncated: true };
}

export function isCodexGuardianReview(
  backendId: string,
  call: ToolCall | ToolCallUpdate,
): boolean {
  return backendId === 'codex'
    && call.toolCallId.startsWith(GUARDIAN_ID_PREFIX)
    && call.toolCallId.length > GUARDIAN_ID_PREFIX.length
    && call.kind === 'think'
    && call.title === 'Guardian Review';
}

export function parseGuardianReview(
  call: ToolCall | ToolCallUpdate,
  previous: GuardianReviewPayload | undefined,
  acpStatus: string,
): GuardianReviewPayload {
  const output = structuredFields(call.rawOutput);
  const content = contentFields(call.content);
  const input = structuredFields(call.rawInput);
  let state = outcome(output.status) ?? outcome(content.status) ?? outcome(input.status) ?? previous?.outcome ?? 'reviewing';
  const terminal = acpStatus === 'completed' || acpStatus === 'failed' || acpStatus === 'canceled';
  if (terminal && state === 'reviewing') state = acpStatus === 'failed' ? 'failed' : 'unavailable';

  const action = bounded(content.action || previous?.action || 'Action unavailable', ACTION_LIMIT).text;
  const risk = enumValue(output.risk ?? content.risk ?? input.risk, ['low', 'medium', 'high', 'critical'])
    ?? previous?.risk ?? null;
  const authorization = enumValue(
    output.authorization ?? content.authorization ?? input.authorization,
    ['unknown', 'low', 'medium', 'high'],
  ) ?? previous?.authorization ?? null;
  const rationaleSource = output.rationale ?? content.rationale ?? input.rationale;
  const rationale = rationaleSource ? bounded(rationaleSource, RATIONALE_LIMIT) : null;

  return {
    outcome: state,
    action,
    risk,
    authorization,
    rationale: rationale?.text ?? previous?.rationale ?? null,
    rationaleTruncated: rationale?.truncated ?? previous?.rationaleTruncated ?? false,
  };
}
