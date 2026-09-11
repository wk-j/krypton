// Krypton — bounded ACP Harness tool-call retention.

import type { HarnessTranscriptItem, ToolPayload } from './harness-view-types';
import type { ContentBlock, ToolCall, ToolCallContent, ToolCallUpdate } from './types';

export const HARNESS_TRANSCRIPT_CAP = 300;
export const TOOL_CALL_RETENTION_CHAR_LIMIT = 64 * 1024;
export const TOOL_DIFF_DISPLAY_CHAR_LIMIT = 64 * 1024;
export const TOOL_DIFF_DISPLAY_COUNT_LIMIT = 8;
export const TOOL_DIFF_TEXT_CHAR_LIMIT = 16 * 1024;

const TOOL_RAW_INPUT_CHAR_LIMIT = 12 * 1024;
const TOOL_RAW_OUTPUT_CHAR_LIMIT = 16 * 1024;
const TOOL_CONTENT_BLOCK_LIMIT = 8;
const TOOL_CONTENT_TEXT_CHAR_LIMIT = 16 * 1024;
const TOOL_TITLE_CHAR_LIMIT = 512;
const TOOL_LOCATION_COUNT_LIMIT = 8;
const TOOL_PATH_CHAR_LIMIT = 1024;
const TRUNCATED_SUFFIX = '\n… truncated by Krypton …';

export interface ToolRetentionState {
  transcript: HarnessTranscriptItem[];
  toolCalls: Map<string, ToolCall | ToolCallUpdate>;
  toolTranscriptIds: Map<string, string>;
  seenTranscriptIds: Set<string>;
  activeToolCount: number;
}

function truncateRetainedText(value: string, limit: number): string {
  if (value.length <= limit) return value;
  if (limit <= TRUNCATED_SUFFIX.length) return TRUNCATED_SUFFIX.slice(0, limit);
  const kept = Math.max(0, limit - TRUNCATED_SUFFIX.length);
  return `${value.slice(0, kept)}${TRUNCATED_SUFFIX}`;
}

function boundedUnknown(value: unknown, limit: number): unknown {
  if (value === undefined) return undefined;
  if (typeof value === 'string') return truncateRetainedText(value, limit);
  try {
    const serialized = JSON.stringify(value);
    if (serialized === undefined || serialized.length <= limit) return value;
    return truncateRetainedText(serialized, limit);
  } catch {
    return '[unserializable tool payload omitted]';
  }
}

function compactContentBlock(block: ContentBlock): ContentBlock {
  switch (block.type) {
    case 'text':
      return { ...block, text: truncateRetainedText(block.text, TOOL_CONTENT_TEXT_CHAR_LIMIT) };
    case 'image':
      return { ...block, data: '' };
    case 'audio':
      return { ...block, data: '' };
    case 'resource_link':
      return {
        ...block,
        uri: truncateRetainedText(block.uri, TOOL_PATH_CHAR_LIMIT),
        description: block.description === undefined
          ? undefined
          : truncateRetainedText(block.description, TOOL_TITLE_CHAR_LIMIT),
      };
    case 'resource':
      return {
        ...block,
        resource: {
          ...block.resource,
          uri: truncateRetainedText(block.resource.uri, TOOL_PATH_CHAR_LIMIT),
          text: block.resource.text === undefined
            ? undefined
            : truncateRetainedText(block.resource.text, TOOL_CONTENT_TEXT_CHAR_LIMIT),
          blob: block.resource.blob === undefined ? undefined : '',
        },
      };
  }
}

function compactToolContent(content: ToolCallContent[] | undefined): ToolCallContent[] | undefined {
  if (content === undefined) return undefined;
  return content.slice(0, TOOL_CONTENT_BLOCK_LIMIT).map((item) => {
    if (item.type === 'diff') {
      return {
        ...item,
        path: item.path === undefined ? undefined : truncateRetainedText(item.path, TOOL_PATH_CHAR_LIMIT),
        oldText: item.oldText == null
          ? item.oldText
          : truncateRetainedText(item.oldText, TOOL_CONTENT_TEXT_CHAR_LIMIT),
        newText: item.newText === undefined
          ? undefined
          : truncateRetainedText(item.newText, TOOL_CONTENT_TEXT_CHAR_LIMIT),
      };
    }
    if (item.type === 'content' && item.content) {
      return { ...item, content: compactContentBlock(item.content) };
    }
    if (item.type === 'terminal' && item.terminalId) {
      return { ...item, terminalId: truncateRetainedText(item.terminalId, TOOL_TITLE_CHAR_LIMIT) };
    }
    return item;
  });
}

/** Keep only bounded merge state after each render. The full wire payload has
 * already been converted into the bounded transcript ToolPayload at this point. */
export function compactToolCallForRetention(
  call: ToolCall | ToolCallUpdate,
): ToolCall | ToolCallUpdate {
  const compact: ToolCall | ToolCallUpdate = {
    toolCallId: call.toolCallId,
    title: call.title === undefined ? undefined : truncateRetainedText(call.title, TOOL_TITLE_CHAR_LIMIT),
    kind: call.kind,
    status: call.status,
    content: compactToolContent(call.content),
    locations: call.locations
      ?.slice(0, TOOL_LOCATION_COUNT_LIMIT)
      .map((location) => ({
        ...location,
        path: truncateRetainedText(location.path, TOOL_PATH_CHAR_LIMIT),
      })),
    rawInput: boundedUnknown(call.rawInput, TOOL_RAW_INPUT_CHAR_LIMIT),
    rawOutput: boundedUnknown(call.rawOutput, TOOL_RAW_OUTPUT_CHAR_LIMIT),
  };
  try {
    if (JSON.stringify(compact).length <= TOOL_CALL_RETENTION_CHAR_LIMIT) return compact;
  } catch {
    // Fall through to metadata-only retention.
  }
  return {
    toolCallId: compact.toolCallId,
    title: compact.title,
    kind: compact.kind,
    status: compact.status,
    locations: compact.locations,
  };
}

/** A compacted prior wire payload can omit bulk fields. Preserve the already
 * bounded display data when a later ACP update only changes status/metadata. */
export function mergeToolPayloadForUpdate(
  previous: ToolPayload | undefined,
  next: ToolPayload,
  update: ToolCall | ToolCallUpdate,
): ToolPayload {
  if (!previous) return next;
  const hasContentUpdate = update.content !== undefined && update.content.length > 0;
  const hasOutputUpdate = update.rawOutput !== undefined || hasContentUpdate;
  return {
    ...next,
    kind: next.kind === 'tool' ? previous.kind : next.kind,
    subject: next.subject || previous.subject,
    command: next.command || previous.command,
    result: next.result || previous.result,
    exitCode: hasOutputUpdate ? next.exitCode : previous.exitCode,
    sections: hasOutputUpdate ? next.sections : previous.sections,
    diffs: hasContentUpdate ? next.diffs : previous.diffs,
    artifactRedaction: previous.artifactRedaction,
  };
}

export function boundToolDiffText(value: string, remaining: number): string {
  return truncateRetainedText(value, Math.max(0, remaining));
}

/** ACP field updates require an earlier tool_call. An active row evicted under
 * transcript pressure still has merge state; a completed row does not. */
export function isOrphanToolCallUpdate(
  lane: Pick<ToolRetentionState, 'toolCalls' | 'toolTranscriptIds'>,
  callId: string,
): boolean {
  return !lane.toolCalls.has(callId) && !lane.toolTranscriptIds.has(callId);
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
      lane.toolCalls.delete(callId);
    }
    break;
  }
  return dropped;
}

export function clearToolTranscriptRetention(lane: ToolRetentionState): void {
  lane.transcript.length = 0;
  lane.toolCalls.clear();
  lane.toolTranscriptIds.clear();
  lane.seenTranscriptIds.clear();
  lane.activeToolCount = 0;
}
