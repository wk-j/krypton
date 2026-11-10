// Krypton — bounded ACP Harness tool-call retention.

import type { ToolView } from './adapters/types';
import type { HarnessTranscriptItem, ToolPayload } from './harness-view-types';

export const HARNESS_TRANSCRIPT_CAP = 300;
export const TOOL_DIFF_DISPLAY_CHAR_LIMIT = 64 * 1024;
export const TOOL_DIFF_DISPLAY_COUNT_LIMIT = 8;
export const TOOL_DIFF_TEXT_CHAR_LIMIT = 16 * 1024;

const TRUNCATED_SUFFIX = '\n… truncated by Krypton …';

export interface ToolRetentionState {
  transcript: HarnessTranscriptItem[];
  toolViews: Map<string, ToolView>;
  toolTranscriptIds: Map<string, string>;
  seenTranscriptIds: Set<string>;
  activeToolCount: number;
}

/** Cut `value` to `limit` characters, the cut marked. Shared with the lane decoder
 * (spec 380), which bounds the merge state it keeps per tool call. */
export function truncateRetainedText(value: string, limit: number): string {
  if (value.length <= limit) return value;
  if (limit <= TRUNCATED_SUFFIX.length) return TRUNCATED_SUFFIX.slice(0, limit);
  const kept = Math.max(0, limit - TRUNCATED_SUFFIX.length);
  return `${value.slice(0, kept)}${TRUNCATED_SUFFIX}`;
}

/** A compacted prior wire payload can omit bulk fields. Preserve the already
 * bounded display data when a later ACP update only changes status/metadata. */
export function boundToolDiffText(value: string, remaining: number): string {
  return truncateRetainedText(value, Math.max(0, remaining));
}

/** ACP field updates require an earlier tool_call. An active row evicted under
 * transcript pressure still has merge state; a completed row does not. */
export function isOrphanToolCallUpdate(
  lane: Pick<ToolRetentionState, 'toolViews' | 'toolTranscriptIds'>,
  callId: string,
): boolean {
  return !lane.toolViews.has(callId) && !lane.toolTranscriptIds.has(callId);
}

/** Push one transcript row and release the backing wire payload when a
 * completed tool row falls outside the hard transcript cap. Active tools keep
 * their bounded merge state so their eventual terminal update still lands. */
export function appendBoundedTranscriptItem(
  lane: ToolRetentionState,
  item: HarnessTranscriptItem,
): HarnessTranscriptItem | undefined {
  lane.transcript.push(item);
  if (lane.transcript.length <= HARNESS_TRANSCRIPT_CAP) return undefined;
  const dropped = lane.transcript.shift();
  if (!dropped) return undefined;
  lane.seenTranscriptIds.delete(dropped.id);
  if (dropped.kind !== 'tool') return dropped;

  const wasActive = dropped.toolStartedAt !== undefined && dropped.toolEndedAt === undefined;
  if (wasActive && lane.activeToolCount > 0) lane.activeToolCount -= 1;
  for (const [callId, transcriptId] of lane.toolTranscriptIds) {
    if (transcriptId !== dropped.id) continue;
    lane.toolTranscriptIds.delete(callId);
    if (!wasActive) {
      lane.toolViews.delete(callId);
    }
    break;
  }
  return dropped;
}

export function clearToolTranscriptRetention(lane: ToolRetentionState): void {
  lane.transcript.length = 0;
  lane.toolViews.clear();
  lane.toolTranscriptIds.clear();
  lane.seenTranscriptIds.clear();
  lane.activeToolCount = 0;
}
