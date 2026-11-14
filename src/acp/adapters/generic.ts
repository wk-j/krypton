// Spec 380 — the generic adapter: the ACP spec plus the tolerant readers every
// backend gets. Backend adapters (`claude.ts`, `codex.ts`, …) only refine it.

import { classifyBashCommand } from '../../agent/bash-risk';
import type { AskUserOption, AskUserQuestion } from '../ask-user-question';
import { cleanToolTitle } from '../harness-tool-render';
import {
  TOOL_DIFF_DISPLAY_CHAR_LIMIT,
  TOOL_DIFF_DISPLAY_COUNT_LIMIT,
  TOOL_DIFF_TEXT_CHAR_LIMIT,
  boundToolDiffText,
} from '../harness-tool-retention';
import { truncateInline } from '../text-truncate';
import type {
  AcpAgentMode,
  AcpAvailableCommand,
  AcpSessionCapabilities,
  AcpSessionInfo,
  AcpSessionListResult,
  ContentBlock,
  EffortOption,
  LaneEffort,
  ModelInfo,
  SteerOutcome,
  StopReason,
  ToolCall,
  ToolCallUpdate,
  UsageInfo,
} from '../types';
import type { LaneAdapter, LaneEvent, LaneInit, LaneSession, PromptResult, SupplyMatrix } from './types';

/** Nothing checked against captured wire yet: every backend starts here. */
export const UNVERIFIED_SUPPLIES: SupplyMatrix = {
  exit: 'unverified',
  subagents: 'unverified',
  turnState: 'unverified',
  usageCost: 'unverified',
  models: 'unverified',
  modes: 'unverified',
  images: 'unverified',
};

/** An unknown backend gets the generic adapter, and its matrix stays unverified. */
export const genericAdapter: LaneAdapter = { id: 'generic', supplies: UNVERIFIED_SUPPLIES };

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

// ─── Content ──────────────────────────────────────────────────────────────

export function extractText(content: unknown): string {
  const c = asRecord(content);
  return c && c.type === 'text' && typeof c.text === 'string' ? c.text : '';
}

/** One ACP content block, typed. Malformed or future blocks degrade to empty text. */
export function normalizeContentBlock(content: unknown): ContentBlock {
  const value = asRecord(content);
  if (!value) return { type: 'text', text: '' };
  if (value.type === 'text') {
    return { type: 'text', text: typeof value.text === 'string' ? value.text : '' };
  }
  if (value.type === 'resource_link' && typeof value.uri === 'string') {
    return {
      type: 'resource_link',
      uri: value.uri,
      name: typeof value.name === 'string' ? value.name : undefined,
      title: typeof value.title === 'string' ? value.title : undefined,
      description: typeof value.description === 'string' ? value.description : undefined,
      mimeType: typeof value.mimeType === 'string' ? value.mimeType : undefined,
      size: typeof value.size === 'number' && Number.isFinite(value.size) && value.size >= 0
        ? value.size
        : undefined,
    };
  }
  if (value.type === 'resource') {
    const resource = asRecord(value.resource);
    if (resource && typeof resource.uri === 'string') {
      return {
        type: 'resource',
        resource: {
          uri: resource.uri,
          mimeType: typeof resource.mimeType === 'string' ? resource.mimeType : undefined,
          text: typeof resource.text === 'string' ? resource.text : undefined,
          blob: typeof resource.blob === 'string' ? resource.blob : undefined,
        },
      };
    }
  }
  // Image/audio blocks are forwarded when complete.
  if (value.type === 'image' && typeof value.data === 'string' && typeof value.mimeType === 'string') {
    return {
      type: 'image',
      data: value.data,
      mimeType: value.mimeType,
      uri: typeof value.uri === 'string' ? value.uri : undefined,
    };
  }
  if (value.type === 'audio' && typeof value.data === 'string' && typeof value.mimeType === 'string') {
    return { type: 'audio', data: value.data, mimeType: value.mimeType };
  }
  return { type: 'text', text: '' };
}

/** Decode one assistant content block without discarding non-text ACP data. */
export function assistantMessageEvent(
  content: unknown,
  messageId: unknown,
  parentToolId?: string | null,
): Extract<LaneEvent, { type: 'message_chunk' }> {
  const block = normalizeContentBlock(content);
  return {
    type: 'message_chunk',
    text: block.type === 'text' ? block.text : '',
    content: block,
    messageId: typeof messageId === 'string' && messageId.length > 0 ? messageId : undefined,
    ...(parentToolId ? { parentToolId } : {}),
  };
}

// ─── Tool calls ───────────────────────────────────────────────────────────
//
// The readers of the wire `ToolCall` every backend gets, moved from
// `harness-tool-render.ts` and `acp-harness-memory.ts` (spec 380 phase 4).
// `tool.ts` calls them; backend adapters refine what they return.

function keepNonEmptyList<T>(next: T[] | undefined, previous: T[] | undefined): T[] | undefined {
  if (next === undefined) return previous;
  if (next.length === 0 && previous && previous.length > 0) return previous;
  return next;
}

export function mergeToolCall(
  previous: ToolCall | ToolCallUpdate | undefined,
  next: ToolCall | ToolCallUpdate,
): ToolCall | ToolCallUpdate {
  return {
    ...previous,
    ...next,
    title: next.title ?? previous?.title,
    kind: next.kind ?? previous?.kind,
    content: keepNonEmptyList(next.content, previous?.content),
    locations: next.locations ?? previous?.locations,
    rawInput: next.rawInput ?? previous?.rawInput,
    rawOutput: next.rawOutput ?? previous?.rawOutput,
  };
}

export function inferToolLabel(call: ToolCall | ToolCallUpdate): string {
  const kind = call.kind;
  if (kind && kind !== 'other') return kind;
  if (extractCommandLine(call.rawInput)) return 'execute';
  const rawName = extractRawToolName(call.rawInput);
  if (rawName) return looksLikeShellCommand(rawName) ? 'execute' : rawName;
  const title = cleanToolTitle(call.title, 'tool').toLowerCase();
  if (/^(bash|shell|terminal|run|exec|execute|command)\b/.test(title)) return 'execute';
  if (/^(edit|write|create|modify|patch)\b/.test(title)) return 'edit';
  if (/^(read|open|cat)\b/.test(title)) return 'read';
  if (/^(search|grep|rg|find)\b/.test(title)) return 'search';
  if (/^(fetch|web|http)\b/.test(title)) return 'fetch';
  if (looksLikeShellCommand(title)) return 'execute';
  return title || 'tool';
}

/** A leading shell/exec verb. Shared by the rawName and title checks so the
 *  policy gate can't drift between the two surfaces (Codex-1 nit, spec 143). */
const SHELL_LIKE_PREFIX = /^(bash|shell|terminal|run|exec|execute|command|sh|zsh|fish|cmd|powershell|pwsh)\b/;

/** Title or raw name is a shell line, not an ACP kind / MCP tool id.
 *  `cd …; actionlint …` is the common Grok title shape — no `kind: execute`
 *  and no `rawInput.command` until a later update. */
const SHELL_HEAD =
  /^(cd|ls|pwd|git|npm|npx|pnpm|yarn|bun|cargo|python3?|node|make|docker|curl|wget|cat|echo|mkdir|rm|cp|mv|chmod|chown|ssh|scp|rsync|go|uv|pip|brew|just|kubectl|actionlint|run_command|shell_command|execute_command)\b/;

export function looksLikeShellCommand(text: string): boolean {
  const trimmed = text.replace(/\s+/g, ' ').trim();
  if (!trimmed) return false;
  const lower = trimmed.toLowerCase();
  if (SHELL_LIKE_PREFIX.test(lower)) return true;
  if (/;|&&|\|\||\|/.test(trimmed)) return true;
  return SHELL_HEAD.test(lower);
}

export function extractRawToolName(rawInput: unknown): string {
  if (typeof rawInput !== 'object' || !rawInput) return '';
  const record = rawInput as Record<string, unknown>;
  for (const key of ['toolName', 'tool_name', 'name', 'tool', 'type']) {
    const value = record[key];
    if (typeof value === 'string' && value.trim()) return truncateInline(value, 40);
  }
  return '';
}

/** Full command string from a tool's rawInput, UNTRUNCATED. Used by policy
 *  (spec 143 high-risk gating) — must never be the 96-char display form, or a
 *  destructive tail past the cutoff (`echo …<96> && rm -rf x`) would be hidden. */
export function extractCommandLineRaw(rawInput: unknown): string {
  if (typeof rawInput === 'object' && rawInput) {
    const record = rawInput as Record<string, unknown>;
    for (const key of ['command', 'cmd']) {
      if (typeof record[key] === 'string') return record[key];
    }
    if (Array.isArray(record.argv)) {
      const argv = record.argv.filter((part): part is string => typeof part === 'string');
      if (argv.length > 0) return argv.join(' ');
    }
  }
  return '';
}

/** Display form — truncated for transcript/label rendering. */
export function extractCommandLine(rawInput: unknown): string {
  const raw = extractCommandLineRaw(rawInput);
  return raw ? truncateInline(raw, 96) : '';
}

/** Is this tool call an execute/shell surface (even when its command string is
 *  not extractable)? Conservative: kind, a present command, or a shell-ish raw
 *  name / title all count. */
export function isExecuteLikeToolCall(call: Pick<ToolCall, 'rawInput' | 'kind' | 'title'>): boolean {
  if (call.kind === 'execute') return true;
  if (extractCommandLineRaw(call.rawInput)) return true;
  if (SHELL_LIKE_PREFIX.test(extractRawToolName(call.rawInput).toLowerCase())) return true;
  return SHELL_LIKE_PREFIX.test((call.title ?? '').trim().toLowerCase());
}

/** spec 143 policy: should this permission still prompt the human under peer
 *  auto-accept? A parseable command is classified via the spec 140 highRisk set;
 *  an execute-like surface whose command cannot be read is treated as high-risk
 *  (unknown ⇒ high-risk); any other surface (edit/read/write/fetch) is not gated
 *  here (writes are diff-shown + VCS-recoverable). */
export function permissionCommandIsHighRisk(
  call: Pick<ToolCall, 'rawInput' | 'kind' | 'title'>,
): boolean {
  const command = extractCommandLineRaw(call.rawInput);
  if (command) return classifyBashCommand(command).highRisk;
  return isExecuteLikeToolCall(call);
}

export function extractToolExitCode(rawOutput: unknown): number | null {
  if (typeof rawOutput !== 'object' || !rawOutput) return null;
  const record = rawOutput as Record<string, unknown>;
  for (const key of ['exitCode', 'exit_code', 'code']) {
    const value = record[key];
    if (typeof value === 'number' && Number.isFinite(value)) return value;
  }
  return null;
}

export function extractToolExit(rawOutput: unknown): string {
  const code = extractToolExitCode(rawOutput);
  if (code === null || code === 0) return '';
  return `exit ${code}`;
}

const EXIT_PREFIX_RE = /^exit:\s*(-?\d+)[ \t]*(?:\r?\n|$)/i;

/** Grok Bash `output_for_prompt` (and siblings) prefix the dump with `exit: N`. */
export function peelExitPrefix(text: string): { code: number; rest: string } | null {
  const match = text.match(EXIT_PREFIX_RE);
  if (!match) return null;
  const code = Number(match[1]);
  if (!Number.isFinite(code)) return null;
  return { code, rest: text.slice(match[0].length) };
}

/**
 * Sections without a first line that restates `exit`, the code the row
 * already shows (`LaneAdapter.exitLine`). A line naming another code, or any
 * line when the exit is unknown, stays: it is then the only place the code is.
 */
export function dropExitLine(
  sections: ReadonlyArray<{ label: string; text: string }>,
  exit: number | null,
  pattern: RegExp,
): Array<{ label: string; text: string }> {
  return sections.map((section) => {
    const match = exit === null ? null : pattern.exec(section.text);
    return match && Number(match[1]) === exit
      ? { label: section.label, text: section.text.slice(match[0].length) }
      : section;
  });
}

/** Grok's `exit: N` first line on `stdout`/`output` sections → the exit code. */
export function peelSectionExit(
  sections: ReadonlyArray<{ label: string; text: string }>,
  known: number | null,
): { exitCode: number | null; sections: Array<{ label: string; text: string }> } {
  let exitCode = known;
  const out: Array<{ label: string; text: string }> = [];
  for (const section of sections) {
    if (!/^(stdout|output)$/i.test(section.label)) {
      out.push(section);
      continue;
    }
    const peeled = peelExitPrefix(section.text);
    if (!peeled) {
      out.push(section);
      continue;
    }
    if (exitCode === null) exitCode = peeled.code;
    out.push({ label: section.label, text: peeled.rest });
  }
  return { exitCode, sections: out };
}

/** `rawOutput` walked by its generic keys (spec 380: every backend; Grok's typed
 *  shapes are read by the Grok adapter first). */
export function rawOutputGenericSections(rawOutput: unknown): Array<{ label: string; text: string }> {
  const decodedRoot = decodeByteArray(rawOutput);
  if (decodedRoot !== null) return decodedRoot ? [{ label: 'output', text: decodedRoot }] : [];
  if (typeof rawOutput === 'object' && rawOutput) {
    const record = rawOutput as Record<string, unknown>;
    const sections: Array<{ label: string; text: string }> = [];
    for (const key of ['summary', 'stdout', 'stderr', 'output', 'content', 'text', 'message']) {
      const text = stringifyToolValue(record[key]);
      if (text) sections.push({ label: key, text });
    }
    return sections;
  }
  const text = stringifyToolValue(rawOutput);
  return text ? [{ label: 'output', text }] : [];
}

export function contentOutputSections(content: ToolCall['content']): Array<{ label: string; text: string }> {
  const sections: Array<{ label: string; text: string }> = [];
  for (const item of content ?? []) {
    // 'diff' items go through extractToolDiffs and are painted by DiffBlock.
    // ACP terminalId is an opaque handle, not command output. Krypton runs no
    // client terminals; the output arrives as `_meta.terminal_output`, which the
    // lane adapter collects (spec 380 phase 3).
    if (item.type === 'content' && item.content) {
      const text = contentBlockText(item.content);
      if (text) sections.push({ label: 'content', text });
    }
  }
  return sections;
}

export function contentBlockText(block: ContentBlock): string {
  if (block.type === 'text') return block.text;
  if (block.type === 'resource' && block.resource.text) return block.resource.text;
  if (block.type === 'resource_link') return block.uri;
  return '';
}

const byteArrayDecoder = new TextDecoder();

/**
 * Some ACP backends (Grok's `grok agent stdio`) serialize terminal/command output as a
 * raw byte array (a JSON `number[]` of 0–255 values) instead of a decoded UTF-8 string.
 * Detect that shape and decode it back to text; otherwise the generic array branch below
 * would stringify each byte and join them, rendering "79 110 32 …" decimal dumps in the
 * tool-output panel. Returns null when `value` is not a byte array (so callers fall back
 * to their normal handling).
 */
export function decodeByteArray(value: unknown): string | null {
  if (!Array.isArray(value) || value.length === 0) return null;
  for (const n of value) {
    if (typeof n !== 'number' || !Number.isInteger(n) || n < 0 || n > 255) return null;
  }
  const decoded = byteArrayDecoder.decode(Uint8Array.from(value as number[]));
  // Validate it's actually text, not a semantic number array (RGB tuples, flag
  // vectors, line counts) that happens to sit in 0–255. Real command output is
  // near-printable; a semantic array decodes to mostly control / replacement
  // chars. Reject when >30% of chars are non-text (tab/newline/CR stay allowed).
  let bad = 0;
  for (const ch of decoded) {
    const code = ch.codePointAt(0) ?? 0;
    const printable = code === 9 || code === 10 || code === 13 || (code >= 32 && code !== 127 && code !== 0xfffd);
    if (!printable) bad += 1;
  }
  if (bad / decoded.length > 0.3) return null;
  return decoded;
}

export function stringifyToolValue(value: unknown): string {
  if (value === null || value === undefined) return '';
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (Array.isArray(value)) {
    const decoded = decodeByteArray(value);
    if (decoded !== null) return decoded;
    return value.map((item) => stringifyToolValue(item)).filter(Boolean).join(' ');
  }
  if (typeof value === 'object') {
    const record = value as Record<string, unknown>;
    for (const key of ['summary', 'stdout', 'stderr', 'output', 'content', 'text', 'message']) {
      const nested = stringifyToolValue(record[key]);
      if (nested) return nested;
    }
  }
  return '';
}

/** A tool call's label kind, its command line (execute only), and its
 *  subject: the command, the path it touches, or its cleaned title. */
export function toolSubject(call: ToolCall | ToolCallUpdate): { kind: string; command: string; subject: string } {
  const kind = inferToolLabel(call);
  const command = kind === 'execute' ? extractCommandLine(call.rawInput) : '';
  const subject = command || extractModifiedPath(call) || cleanToolTitle(call.title, kind) || '';
  return { kind, command, subject };
}

export function extractToolDiffs(content: ToolCall['content']): Array<{ path: string; oldText: string; newText: string }> {
  const out: Array<{ path: string; oldText: string; newText: string }> = [];
  let remaining = TOOL_DIFF_DISPLAY_CHAR_LIMIT;
  for (const item of content ?? []) {
    if (out.length >= TOOL_DIFF_DISPLAY_COUNT_LIMIT || remaining <= 0) break;
    if (item.type === 'diff' && (item.newText !== undefined || item.oldText !== undefined)) {
      const oldText = boundToolDiffText(
        item.oldText ?? '',
        Math.min(remaining, TOOL_DIFF_TEXT_CHAR_LIMIT),
      );
      remaining -= oldText.length;
      const newText = boundToolDiffText(
        item.newText ?? '',
        Math.min(remaining, TOOL_DIFF_TEXT_CHAR_LIMIT),
      );
      remaining -= newText.length;
      out.push({
        path: item.path ?? '',
        oldText,
        newText,
      });
    }
  }
  return out;
}

export function extractModifiedPath(call: ToolCall | ToolCallUpdate): string | null {
  for (const content of call.content ?? []) {
    if (content.type === 'diff' && typeof content.path === 'string' && content.path) return content.path;
  }
  const location = call.locations?.find((loc) => loc.path);
  if (location) return location.path;
  const title = call.title ?? '';
  if (/^(edit|write|create|modify|patch)\b/i.test(title)) {
    const match = title.match(/((?:\.{0,2}\/)?[\w@./-]+\.[\w-]+)/);
    if (match) return match[1];
  }
  return null;
}

// ─── Terminal convention (spec 380 phase 3) ───────────────────────────────

/**
 * What one tool update's `_meta` says about its command under the Zed
 * terminal convention, which Krypton declares as `_meta.terminal_output`.
 * claude-agent-acp sends a command's whole output once; codex-acp streams it
 * in chunks. Both are appended, as Zed does. `terminal_info` only names the
 * terminal (its id is the tool call id), so nothing reads it.
 * `terminal_output_delta` is never declared and is not read (spec 380 Out of Scope).
 */
export interface TerminalMetaUpdate {
  /** Output to append to the call's terminal; null when this update carried none. */
  readonly output: string | null;
  /** `terminal_exit` arrived; `code` is its `exit_code`, null when the server knows none. */
  readonly exit: { readonly code: number | null } | null;
}

export function terminalMetaOf(meta: unknown): TerminalMetaUpdate | null {
  const record = asRecord(meta);
  if (!record) return null;
  const chunk = asRecord(record.terminal_output);
  const exit = asRecord(record.terminal_exit);
  const output = chunk && typeof chunk.data === 'string' ? chunk.data : null;
  if (output === null && !exit) return null;
  const code = exit?.exit_code;
  return {
    output,
    exit: exit ? { code: typeof code === 'number' && Number.isFinite(code) ? code : null } : null,
  };
}

// ─── Session updates ──────────────────────────────────────────────────────

export function usageFromUpdate(update: Readonly<Record<string, unknown>>): UsageInfo {
  const cost = asRecord(update.cost);
  return {
    used: typeof update.used === 'number' ? update.used : undefined,
    size: typeof update.size === 'number' ? update.size : undefined,
    cost: cost && typeof cost.amount === 'number'
      ? { amount: cost.amount, currency: typeof cost.currency === 'string' ? cost.currency : 'USD' }
      : undefined,
  };
}

export function availableCommands(value: unknown): AcpAvailableCommand[] {
  if (!Array.isArray(value)) return [];
  const out: AcpAvailableCommand[] = [];
  for (const item of value) {
    const c = asRecord(item);
    if (!c || typeof c.name !== 'string' || c.name.length === 0) continue;
    const input = asRecord(c.input);
    out.push({
      name: c.name,
      description: typeof c.description === 'string' ? c.description : undefined,
      inputHint: typeof input?.hint === 'string' ? input.hint : undefined,
    });
  }
  return out;
}

/** spec 278: a `_session/steering` outcome; unknown or missing → 'failed'. */
export function steerOutcome(value: unknown): SteerOutcome {
  return value === 'injected' || value === 'startedNewTurn' || value === 'promptRequired'
    ? value
    : 'failed';
}

// ─── Questions (spec 229) ─────────────────────────────────────────────────

/** `ask_user_question` questions from `{ questions }`, `{ params: { questions } }`, or a bare array. */
export function parseAskUserQuestions(input: unknown): AskUserQuestion[] {
  const root = Array.isArray(input) ? { questions: input } : asRecord(input);
  const nested = asRecord(root?.params);
  const raw = root?.questions ?? nested?.questions;
  if (!Array.isArray(raw)) return [];
  const out: AskUserQuestion[] = [];
  for (const item of raw) {
    const rec = asRecord(item);
    if (!rec) continue;
    const question = typeof rec.question === 'string' ? rec.question : '';
    const optionsRaw = Array.isArray(rec.options) ? rec.options : [];
    const options: AskUserOption[] = [];
    for (const opt of optionsRaw) {
      const o = asRecord(opt);
      if (!o) continue;
      const label = typeof o.label === 'string' ? o.label : '';
      if (!label) continue;
      options.push({
        label,
        description: typeof o.description === 'string' ? o.description : '',
        preview: typeof o.preview === 'string' ? o.preview : undefined,
      });
    }
    if (!question.trim() && options.length === 0) continue;
    const multi = rec.multiSelect === true || rec.multi_select === true;
    out.push({
      question,
      options,
      multiSelect: multi || undefined,
    });
  }
  return out;
}

// ─── initialize ───────────────────────────────────────────────────────────

const MODEL_KEYS = [
  'model', 'modelId', 'model_id', 'selectedModel', 'selected_model',
  'activeModel', 'active_model', 'defaultModel', 'default_model',
] as const;

/** A model name an agent put anywhere in its capabilities (depth-limited walk). */
export function findModelName(value: unknown, depth = 0): string | null {
  if (depth > 8 || !value || typeof value !== 'object') return null;
  if (Array.isArray(value)) {
    for (const item of value) {
      const match = findModelName(item, depth + 1);
      if (match) return match;
    }
    return null;
  }
  const record = value as Record<string, unknown>;
  for (const key of MODEL_KEYS) {
    const candidate = record[key];
    if (typeof candidate === 'string' && candidate.trim()) return candidate.trim();
  }
  for (const item of Object.values(record)) {
    const match = findModelName(item, depth + 1);
    if (match) return match;
  }
  return null;
}

export function sessionCapabilitiesFromAgent(caps: unknown): AcpSessionCapabilities {
  const record = asRecord(caps);
  const sessionCaps = asRecord(record?.sessionCapabilities);
  return {
    canList: Boolean(sessionCaps?.list),
    canResume: Boolean(sessionCaps?.resume),
    canLoad: record?.loadSession === true,
  };
}

/** ACP `SessionMode[]` (or the off-spec capability list of the same shape). */
export function parseModes(value: unknown): AcpAgentMode[] {
  if (!Array.isArray(value)) return [];
  const out: AcpAgentMode[] = [];
  for (const item of value) {
    const mode = asRecord(item);
    if (!mode || typeof mode.id !== 'string') continue;
    out.push({
      id: mode.id,
      name: typeof mode.name === 'string' ? mode.name : mode.id,
      description: typeof mode.description === 'string' ? mode.description : undefined,
    });
  }
  return out;
}

export function decodeInit(raw: unknown): LaneInit {
  const init = asRecord(raw);
  const caps = asRecord(init?.agent_capabilities);
  const prompt = asRecord(caps?.promptCapabilities);
  const mcp = asRecord(caps?.mcpCapabilities);
  return {
    promptImage: Boolean(prompt?.image),
    promptEmbeddedContext: Boolean(prompt?.embeddedContext),
    sessions: sessionCapabilitiesFromAgent(caps),
    mcp: { http: Boolean(mcp?.http), sse: Boolean(mcp?.sse) },
    steering: init?.steering_supported === true,
    ompBackgroundJobs: init?.omp_background_jobs_supported === true,
    authMethods: Array.isArray(init?.auth_methods) ? init.auth_methods : [],
    reportedModel: findModelName(caps),
    modes: parseModes(caps?.availableModes),
  };
}

// ─── session/new | resume | load | list ──────────────────────────────────

function parseModels(value: unknown): ModelInfo[] {
  if (!Array.isArray(value)) return [];
  const out: ModelInfo[] = [];
  for (const item of value) {
    const model = asRecord(item);
    if (!model || typeof model.model_id !== 'string') continue;
    out.push({
      model_id: model.model_id,
      name: typeof model.name === 'string' ? model.name : model.model_id,
      description: typeof model.description === 'string' ? model.description : null,
    });
  }
  return out;
}

/** spec 388: Rust's `EffortState` (`{config_id, options, current}`) as lane
 *  data. Null for anything that is not one — the lane then has no effort strip.
 *  The config id stays in Rust, which sends the switch. */
export function decodeEffort(raw: unknown): LaneEffort | null {
  const effort = asRecord(raw);
  if (!effort || !Array.isArray(effort.options)) return null;
  const options: EffortOption[] = [];
  for (const item of effort.options) {
    const option = asRecord(item);
    if (!option || typeof option.value !== 'string') continue;
    options.push({ value: option.value, name: typeof option.name === 'string' ? option.name : option.value });
  }
  return { options, current: typeof effort.current === 'string' ? effort.current : null };
}

export function decodeSession(raw: unknown): LaneSession {
  const session = asRecord(raw);
  const modes = asRecord(session?.modes);
  const currentModeId = modes?.currentModeId;
  return {
    sessionId: typeof session?.session_id === 'string' ? session.session_id : '',
    models: parseModels(session?.available_models),
    currentModelId: typeof session?.current_model_id === 'string' ? session.current_model_id : null,
    requestedModelId: typeof session?.requested_model_id === 'string' && session.requested_model_id.length > 0
      ? session.requested_model_id
      : null,
    effort: decodeEffort(session?.effort),
    modes: parseModes(modes?.availableModes),
    currentModeId: typeof currentModeId === 'string' && currentModeId.length > 0 ? currentModeId : null,
    modelApplyFailed: session?.model_apply_failed === true,
  };
}

export function decodeSessionList(raw: unknown): AcpSessionListResult {
  const list = asRecord(raw);
  const sessions: AcpSessionInfo[] = [];
  for (const item of Array.isArray(list?.sessions) ? list.sessions : []) {
    const entry = asRecord(item);
    if (!entry || typeof entry.sessionId !== 'string') continue;
    sessions.push({
      sessionId: entry.sessionId,
      cwd: typeof entry.cwd === 'string' ? entry.cwd : '',
      title: typeof entry.title === 'string' ? entry.title : null,
      updatedAt: typeof entry.updatedAt === 'string' ? entry.updatedAt : null,
    });
  }
  const nextCursor = list?.nextCursor;
  return { sessions, nextCursor: typeof nextCursor === 'string' ? nextCursor : null };
}

// ─── session/prompt result ────────────────────────────────────────────────

/**
 * The turn-end reply. Usage is off-spec: claude-agent-acp puts it at the top
 * level and codex-acp under `_meta`. Both are read for every backend so one
 * that copies either convention still reports it.
 */
export function decodePromptResult(raw: unknown): PromptResult {
  const result = asRecord(raw);
  const reason = result?.stopReason;
  // Passed through unvalidated, as before: a newer reason still reaches the UI.
  const stopReason = typeof reason === 'string' ? reason as StopReason : 'end_turn';
  const usage = asRecord(result?.usage) ?? asRecord(asRecord(result?._meta)?.usage);
  return {
    stopReason,
    usage: usage && Object.keys(usage).length > 0 ? usage as UsageInfo : null,
  };
}
