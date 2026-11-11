// Spec 380 phase 2a — tool calls, decoded once per update into a `ToolView`.
//
// The steps are the pre-spec-380 `renderTool` + `buildToolPayload` +
// `mergeToolPayloadForUpdate`, in the same order, with the backend-specific
// parts behind `LaneAdapter` hooks. The decoder owns the per-call merge state
// that `lane.toolCalls` used to hold.

import { boundedOutputLines, cleanToolTitle, isGitDiffCommand } from '../harness-tool-render';
import { truncateRetainedText } from '../harness-tool-retention';
import { scanValueForImagePaths } from '../image-paths';
import type { ContentBlock, ToolCall, ToolCallContent, ToolCallUpdate } from '../types';
import {
  contentOutputSections,
  dropExitLine,
  extractCommandLineRaw,
  extractModifiedPath,
  extractRawToolName,
  extractToolDiffs,
  extractToolExitCode,
  mergeToolCall,
  peelSectionExit,
  rawOutputGenericSections,
  terminalMetaOf,
  toolSubject,
} from './generic';
import { parseSubagentPayload } from './subagents';
import { normalizeRemoteCommand } from './remote-command';
import type {
  LaneAdapter,
  McpIdentity,
  ToolDraft,
  ToolImageUpdate,
  ToolSection,
  ToolState,
  ToolStep,
  ToolView,
} from './types';

/** Terminal calls remembered for late updates; live calls are never evicted. */
export const TOOL_STATE_TERMINAL_CAP = 512;

/** Shared by every card that paints no output, so its deps never move. */
const NO_SECTIONS: ToolSection[] = [];
Object.freeze(NO_SECTIONS);

// ─── Retention ────────────────────────────────────────────────────────────
//
// Moved from `harness-tool-retention.ts` (spec 380 phase 4): the decoder keeps
// each call's merged wire state, so it also bounds it.

/** The whole compacted call; past this only its metadata is kept. */
export const TOOL_CALL_RETENTION_CHAR_LIMIT = 64 * 1024;
const TOOL_RAW_INPUT_CHAR_LIMIT = 12 * 1024;
const TOOL_RAW_OUTPUT_CHAR_LIMIT = 16 * 1024;
const TOOL_CONTENT_BLOCK_LIMIT = 8;
const TOOL_CONTENT_TEXT_CHAR_LIMIT = 16 * 1024;
const TOOL_TITLE_CHAR_LIMIT = 512;
const TOOL_LOCATION_COUNT_LIMIT = 8;
const TOOL_PATH_CHAR_LIMIT = 1024;

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

/**
 * Terminal output kept per call. The well shows at most 80 lines of 140 cells,
 * so the head is all any surface reads.
 */
export const TERMINAL_OUTPUT_CHAR_LIMIT = 16 * 1024;

/** A call's command, as the terminal convention reported it (spec 380 phase 3). */
interface TerminalState {
  /** Output appended so far, head kept; null until any output arrived. */
  readonly output: string | null;
  /** `terminal_exit.exit_code`; null when not reported or the server knew none. */
  readonly exit: number | null;
}

interface CallState {
  wire: ToolCall | ToolCallUpdate;
  view: ToolView;
  terminal: TerminalState | null;
}

/** Fold one update's terminal meta into the call's state. `changed`: what the well shows moved. */
function foldTerminal(
  prior: TerminalState | null,
  meta: unknown,
): { state: TerminalState | null; changed: boolean } {
  const update = terminalMetaOf(meta);
  if (!update) return { state: prior, changed: false };
  let output = prior?.output ?? null;
  if (update.output !== null) {
    const head = output ?? '';
    output = head.length >= TERMINAL_OUTPUT_CHAR_LIMIT
      ? head
      : (head + update.output).slice(0, TERMINAL_OUTPUT_CHAR_LIMIT);
  }
  const exit = update.exit ? update.exit.code : prior?.exit ?? null;
  return {
    state: { output, exit },
    changed: output !== (prior?.output ?? null) || exit !== (prior?.exit ?? null),
  };
}

export interface ToolDecodeResult {
  readonly view: ToolView;
  readonly images: ToolImageUpdate;
  readonly jobsReport?: ToolStep['jobsReport'];
}

export function isTerminalState(status: string): boolean {
  return status === 'completed' || status === 'failed' || status === 'canceled';
}

/** `mcp__<server>__<tool>` exactly. Claude and Codex name MCP tools this way. */
export function mcpIdentityFromTitle(title: string | undefined): McpIdentity | null {
  const match = /^mcp__(.+?)__(.+)$/.exec(title?.trim() ?? '');
  return match ? { server: match[1], tool: match[2] } : null;
}

/** String values under path-like input keys, to depth 4 (spec 133). */
export function inputPathValues(value: unknown, depth = 0, out: string[] = []): string[] {
  if (depth > 4 || !value || typeof value !== 'object') return out;
  if (Array.isArray(value)) {
    for (const item of value) inputPathValues(item, depth + 1, out);
    return out;
  }
  for (const [key, val] of Object.entries(value as Record<string, unknown>)) {
    if (typeof val === 'string') {
      if (/path|file|target|dest|location/i.test(key) && val) out.push(val);
    } else if (val && typeof val === 'object') {
      inputPathValues(val, depth + 1, out);
    }
  }
  return out;
}

function contentBlocks(call: ToolCall | ToolCallUpdate): ContentBlock[] {
  return (call.content ?? [])
    .filter((entry) => entry.type === 'content' && entry.content)
    .map((entry) => entry.content as ContentBlock);
}

/** What this update contributes to the row's images: the caller resolves paths. */
function imageUpdate(call: ToolCall | ToolCallUpdate, merged: ToolCall | ToolCallUpdate): ToolImageUpdate {
  const blocks = contentBlocks(call);
  // Command output that travels as terminal meta is scanned like the console
  // block it replaces.
  const terminalChunk = terminalMetaOf(call._meta)?.output ?? '';
  const textOutput = [...blocks.map((block) => (block.type === 'text' ? block.text : '')), terminalChunk]
    .filter((text) => text.length > 0);
  const scans = [
    scanValueForImagePaths(call.rawInput),
    scanValueForImagePaths(call.rawOutput),
    scanValueForImagePaths(textOutput),
  ];
  return {
    blocks,
    locations: (call.locations ?? []).map((location) => location.path).filter((path) => !!path),
    pairPath: merged.locations?.[0]?.path ?? null,
    scanned: scans.flatMap((scan) => scan.paths),
    overflow: scans.reduce((sum, scan) => sum + scan.overflow, 0),
  };
}

/**
 * Output sections and exit code, as the pre-spec-380 `buildToolPayload` built
 * them. Terminal output, once any arrived, is the whole well: a server that
 * uses the terminal sends the output nowhere else, so `rawOutput` / `content`
 * text beside it is at most a display copy of the input. A `terminal_exit`
 * code wins over `rawOutput`.
 */
function outputOf(
  adapter: LaneAdapter,
  merged: ToolCall | ToolCallUpdate,
  kind: string,
  command: string,
  terminal: TerminalState | null,
): { sections: ToolSection[]; exit: number | null } {
  const known = extractToolExitCode(merged.rawOutput);
  let source: Array<{ label: string; text: string }>;
  if (terminal?.output != null) {
    source = [{ label: 'output', text: terminal.output }];
  } else {
    const raw = adapter.outputSections?.(merged.rawOutput) ?? rawOutputGenericSections(merged.rawOutput);
    source = raw.length > 0 ? raw : contentOutputSections(merged.content);
  }
  const peeled = adapter.exitPrefix ? peelSectionExit(source, known) : { exitCode: known, sections: source };
  const exit = terminal?.exit ?? peeled.exitCode;
  // Before the line cap, so a dropped restatement does not cost a line of output.
  const shown = adapter.exitLine ? dropExitLine(peeled.sections, exit, adapter.exitLine) : peeled.sections;
  const lineLimit = kind === 'execute' && isGitDiffCommand(command) ? 80 : kind === 'execute' ? 12 : 6;
  const sections = shown
    .map((section) => ({
      label: section.label,
      text: boundedOutputLines(adapter.cleanOutput ? adapter.cleanOutput(section.text, kind) : section.text, lineLimit),
    }))
    .filter((section) => section.text)
    .slice(0, 4);
  return { sections, exit };
}

/**
 * The generic view of one update. Output arrays come from this update only
 * when it carried output; otherwise the prior references are kept, so a
 * status-only update never repaints the row's output.
 */
function genericDraft(
  adapter: LaneAdapter,
  call: ToolCall | ToolCallUpdate,
  merged: ToolCall | ToolCallUpdate,
  status: ToolState,
  prior: ToolView | null,
  terminal: { state: TerminalState | null; changed: boolean },
): ToolDraft {
  const { kind, command, subject } = toolSubject(merged);
  const output = outputOf(adapter, merged, kind, command, terminal.state);
  const diffs = extractToolDiffs(merged.content);
  const hasContentUpdate = call.content !== undefined && call.content.length > 0;
  const hasOutputUpdate = call.rawOutput !== undefined || hasContentUpdate || terminal.changed;
  const title = cleanToolTitle(merged.title, merged.kind ?? 'tool') || merged.title?.trim() || '';
  const toolName = extractRawToolName(merged.rawInput) || null;
  const commandLine = extractCommandLineRaw(merged.rawInput) || null;
  const titleIdentity = call.title !== undefined ? mcpIdentityFromTitle(merged.title) : undefined;
  return {
    id: merged.toolCallId ?? '',
    parentId: prior?.parentId ?? null,
    status,
    kind: prior && kind === 'tool' ? prior.kind : kind,
    declaredKind: merged.kind ?? null,
    title,
    toolName,
    subject: subject || prior?.subject || '',
    command: command || prior?.command || '',
    commandLine,
    modifiedPath: extractModifiedPath(merged),
    locations: (merged.locations ?? []).map((location) => location.path).filter((path) => !!path),
    inputPaths: inputPathValues(merged.rawInput),
    sections: !prior || hasOutputUpdate ? output.sections : prior.sections,
    exit: !prior || hasOutputUpdate ? output.exit : prior.exit,
    diffs: !prior || hasContentUpdate ? diffs : prior.diffs,
    mcp: titleIdentity === undefined ? prior?.mcp ?? null : titleIdentity,
    background: prior?.background ?? null,
    guardianReview: prior?.guardianReview,
  };
}

/** The output well of a row whose card paints the result instead (Guardian, jobs). */
export function clearSections(draft: ToolDraft): void {
  draft.sections = NO_SECTIONS;
}

/**
 * spec 282: a call that spawned subagents becomes an `agents` card. The OMP,
 * Claude and Codex adapters opt in; each shape belongs to one of them.
 */
export function applySubagentCard(step: ToolStep): boolean {
  const { draft, merged, prior } = step;
  const subagents = parseSubagentPayload(merged, draft.status, prior?.subagents, step.agentNames);
  if (!subagents) return false;
  draft.subagents = subagents;
  draft.kind = 'agents';
  draft.subject = cleanToolTitle(merged.title, 'agents') || draft.subject;
  return true;
}

/** Per-decoder tool state. One instance per `AcpClient`. */
export class ToolCallDecoder {
  private readonly calls = new Map<string, CallState>();
  private readonly agentNames = new Map<string, string>();

  constructor(private readonly adapter: LaneAdapter) {}

  reset(): void {
    this.calls.clear();
    this.agentNames.clear();
  }

  /** Null for an update whose call was never seen (ACP field updates need a prior `tool_call`). */
  decode(call: ToolCall | ToolCallUpdate, updateOnly: boolean): ToolDecodeResult | null {
    if (!call.toolCallId) return null;
    const previous = this.calls.get(call.toolCallId);
    if (updateOnly && !previous) return null;
    const merged = mergeToolCall(previous?.wire, call);
    const prior = previous?.view ?? null;
    const terminal = foldTerminal(previous?.terminal ?? null, call._meta);
    const step: ToolStep = {
      call,
      merged,
      prior,
      agentNames: this.agentNames,
      permission: false,
      terminalOutput: terminal.state?.output ?? null,
      draft: genericDraft(this.adapter, call, merged, 'pending', prior, terminal),
    };
    const wire = (merged.status ?? 'pending') as ToolState;
    step.draft.status = this.adapter.toolStatus?.(step, wire) ?? wire;
    this.adapter.tool?.(step);
    normalizeRemoteCommand(step);
    const view: ToolView = step.draft;
    this.remember(call.toolCallId, {
      wire: compactToolCallForRetention(merged),
      view,
      terminal: terminal.state,
    });
    return {
      view,
      images: imageUpdate(call, merged),
      ...(step.jobsReport ? { jobsReport: step.jobsReport } : {}),
    };
  }

  /**
   * The view of a permission request's own tool call. Like today's permission
   * card it is not merged with the call's earlier updates, and decoding it
   * leaves the call state untouched.
   */
  view(call: ToolCall | ToolCallUpdate): ToolView {
    const step: ToolStep = {
      call,
      merged: call,
      prior: null,
      agentNames: this.agentNames,
      permission: true,
      terminalOutput: null,
      draft: genericDraft(
        this.adapter,
        call,
        call,
        (call.status ?? 'pending') as ToolState,
        null,
        { state: null, changed: false },
      ),
    };
    this.adapter.tool?.(step);
    return step.draft;
  }

  private remember(id: string, state: CallState): void {
    this.calls.delete(id);
    this.calls.set(id, state);
    if (this.calls.size <= TOOL_STATE_TERMINAL_CAP) return;
    for (const [key, entry] of this.calls) {
      if (this.calls.size <= TOOL_STATE_TERMINAL_CAP) break;
      if (isTerminalState(entry.view.status)) this.calls.delete(key);
    }
  }
}
