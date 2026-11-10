// Spec 380 phase 2a — tool calls, decoded once per update into a `ToolView`.
//
// The steps are the pre-spec-380 `renderTool` + `buildToolPayload` +
// `mergeToolPayloadForUpdate`, in the same order, with the backend-specific
// parts behind `LaneAdapter` hooks. The decoder owns the per-call merge state
// that `lane.toolCalls` used to hold.

import {
  cleanToolTitle,
  contentOutputSections,
  extractCommandLineRaw,
  extractRawToolName,
  extractToolDiffs,
  extractToolExitCode,
  boundedOutputLines,
  isGitDiffCommand,
  mergeToolCall,
  peelSectionExit,
  rawOutputGenericSections,
  toolSubject,
} from '../harness-tool-render';
import { parseSubagentPayload } from '../harness-subagents';
import { compactToolCallForRetention } from '../harness-tool-retention';
import { extractModifiedPath } from '../acp-harness-memory';
import { scanValueForImagePaths } from '../harness-images';
import type { ContentBlock, ToolCall, ToolCallUpdate } from '../types';
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

interface CallState {
  wire: ToolCall | ToolCallUpdate;
  view: ToolView;
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
  const textOutput = blocks
    .map((block) => (block.type === 'text' ? block.text : ''))
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

/** Output sections and exit code, as the pre-spec-380 `buildToolPayload` built them. */
function outputOf(
  adapter: LaneAdapter,
  merged: ToolCall | ToolCallUpdate,
  kind: string,
  command: string,
): { sections: ToolSection[]; exit: number | null } {
  const raw = adapter.outputSections?.(merged.rawOutput) ?? rawOutputGenericSections(merged.rawOutput);
  const content = contentOutputSections(merged.content);
  const known = extractToolExitCode(merged.rawOutput);
  const source = raw.length > 0 ? raw : content;
  const peeled = adapter.exitPrefix ? peelSectionExit(source, known) : { exitCode: known, sections: source };
  const lineLimit = kind === 'execute' && isGitDiffCommand(command) ? 80 : kind === 'execute' ? 12 : 6;
  const sections = peeled.sections
    .map((section) => ({
      label: section.label,
      text: boundedOutputLines(adapter.cleanOutput ? adapter.cleanOutput(section.text, kind) : section.text, lineLimit),
    }))
    .filter((section) => section.text)
    .slice(0, 4);
  return { sections, exit: peeled.exitCode };
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
): ToolDraft {
  const { kind, command, subject } = toolSubject(merged);
  const output = outputOf(adapter, merged, kind, command);
  const diffs = extractToolDiffs(merged.content);
  const hasContentUpdate = call.content !== undefined && call.content.length > 0;
  const hasOutputUpdate = call.rawOutput !== undefined || hasContentUpdate;
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
    const step: ToolStep = {
      call,
      merged,
      prior,
      agentNames: this.agentNames,
      permission: false,
      draft: genericDraft(this.adapter, call, merged, 'pending', prior),
    };
    const wire = (merged.status ?? 'pending') as ToolState;
    step.draft.status = this.adapter.toolStatus?.(step, wire) ?? wire;
    this.adapter.tool?.(step);
    const view: ToolView = step.draft;
    this.remember(call.toolCallId, { wire: compactToolCallForRetention(merged), view });
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
      draft: genericDraft(this.adapter, call, call, (call.status ?? 'pending') as ToolState, null),
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
