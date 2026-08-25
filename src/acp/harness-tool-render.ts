// Krypton — ACP Harness View: tool call inspection & rendering.
//
// Extracted verbatim from acp-harness-view.ts (spec 204). Two related concerns:
// reading an ACP ToolCall / ToolCallUpdate (label, command line, exit code, raw
// output sections) and painting the resulting ToolPayload into a transcript row,
// including the rich `git diff` / `git status` renderings.

import { renderDiffPreview } from './diff-render';
import { extractModifiedPath } from './acp-harness-memory';
import { stripAnsi } from './provider-error';
import { classifyBashCommand } from '../agent/tools';
import type { ContentBlock, ToolCall, ToolCallUpdate } from './types';
import type { ArtifactCardPayload, ReviewCardPayload, ToolPayload } from './harness-view-types';
import {
  truncateInline,
} from './harness-format';

function statusGlyph(status: string): string {
  if (status === 'completed') return '✓';
  if (status === 'failed') return '✗';
  if (status === 'in_progress') return '⟳';
  return '·';
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
    content: next.content ?? previous?.content,
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

export function isMemoryTool(call: ToolCall | ToolCallUpdate): boolean {
  const rawName = extractRawToolName(call.rawInput).toLowerCase();
  const title = (call.title ?? '').toLowerCase();
  return rawName.startsWith('memory_') || title.includes('memory_');
}

export function cleanToolTitle(title: string | undefined, fallback: string): string {
  const value = title?.trim() ?? '';
  if (!value || value.toLowerCase() === 'tool' || value.toLowerCase() === fallback) return '';
  if (/^tool\s+exit\s+\d+$/i.test(value)) return '';
  return value;
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

function peelSectionExit(
  sections: Array<{ label: string; text: string }>,
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

export function rawOutputSections(rawOutput: unknown): Array<{ label: string; text: string }> {
  const grok = grokRawOutputSections(rawOutput);
  if (grok) return grok;
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
    // 'diff' items are rendered by extractToolDiffs/renderToolBody as HTML blocks.
    if (item.type === 'terminal' && item.terminalId) sections.push({ label: 'terminal', text: item.terminalId });
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

/** Grok `rawOutput.type` variants seen on the ACP wire (107 krypton sessions).
 *  Unknown types fall through to the generic key walker. */
export const GROK_RAW_OUTPUT_TYPES = [
  'ReadFile',
  'GrepSearch',
  'SearchReplace',
  'Bash',
  'MCP',
  'ListDir',
  'SearchTool',
  'Todo',
  'TaskOutput',
  'WebFetch',
  'BackgroundTaskStarted',
  'Text',
  'KillTask',
  'ImageGen',
] as const;

type ToolDumpSection = { label: string; text: string };

function asRecord(value: unknown): Record<string, unknown> | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function dumpSection(label: string, text: string): ToolDumpSection[] {
  return text.trim() ? [{ label, text }] : [];
}

function nestedContent(value: unknown): string {
  const rec = asRecord(value);
  if (rec && typeof rec.content === 'string') return rec.content;
  return stringifyToolValue(value);
}

/** Format Grok `GrepSearch.file_matches` as path-header + `line:text` rows. */
export function formatGrokFileMatches(value: unknown): string {
  if (!Array.isArray(value) || value.length === 0) return '';
  const lines: string[] = [];
  for (const file of value) {
    const rec = asRecord(file);
    if (!rec) continue;
    const path = typeof rec.path === 'string' ? rec.path : '';
    if (!path || !Array.isArray(rec.matches)) continue;
    lines.push(path);
    for (const match of rec.matches) {
      const row = asRecord(match);
      if (!row) continue;
      const n = row.line_number;
      const text = typeof row.content === 'string' ? row.content : '';
      if (typeof n === 'number') lines.push(`${n}:${text}`);
    }
  }
  return lines.join('\n');
}

function mcpDumpText(output: unknown): string {
  const rec = asRecord(output);
  if (!rec) return stringifyToolValue(output);
  if (typeof rec.OkayOutput === 'string') return rec.OkayOutput;
  if (typeof rec.Error === 'string') return rec.Error;
  return stringifyToolValue(output);
}

/**
 * Pull the human-readable dump out of Grok's typed `rawOutput`.
 * Returns `[]` when the type is known but the card should use ACP `content`
 * (e.g. SearchReplace diffs). Returns `null` for unknown shapes so the
 * generic walker still runs.
 */
export function grokRawOutputSections(rawOutput: unknown): ToolDumpSection[] | null {
  const rec = asRecord(rawOutput);
  const type = rec && typeof rec.type === 'string' ? rec.type : '';
  if (!rec || !type) return null;
  switch (type) {
    case 'ReadFile': {
      if (typeof rec.FileNotFound === 'string') return dumpSection('message', rec.FileNotFound);
      const body = nestedContent(rec.FileContent);
      if (body) return dumpSection('content', body);
      return [];
    }
    case 'GrepSearch': {
      const hits = formatGrokFileMatches(rec.file_matches);
      if (hits) return dumpSection('stdout', hits);
      const stdout = stringifyToolValue(rec.stdout);
      return dumpSection('stdout', stdout);
    }
    case 'ListDir':
    case 'WebFetch':
      return dumpSection('content', nestedContent(rec.Content));
    case 'Bash': {
      const prompt = typeof rec.output_for_prompt === 'string' ? rec.output_for_prompt : '';
      return dumpSection('output', prompt.trim() ? prompt : stringifyToolValue(rec.output));
    }
    case 'MCP': {
      const text = mcpDumpText(rec.output);
      return dumpSection(rec.is_error ? 'error' : 'output', text);
    }
    case 'SearchTool':
      return dumpSection('content', stringifyToolValue(rec.content));
    case 'Todo': {
      const todos = asRecord(rec.TodosUpdated);
      const summary = todos && typeof todos.summary_for_prompt === 'string' ? todos.summary_for_prompt : '';
      return dumpSection('output', summary);
    }
    case 'SearchReplace':
      return [];
    case 'BackgroundTaskStarted': {
      const summary = typeof rec.summary === 'string' ? rec.summary : '';
      return dumpSection('output', summary);
    }
    case 'TaskOutput': {
      const result = asRecord(rec.Result);
      return dumpSection('output', result ? stringifyToolValue(result.output) : '');
    }
    case 'Text':
      return dumpSection('output', typeof rec.text === 'string' ? rec.text : stringifyToolValue(rec.text));
    case 'KillTask': {
      const result = asRecord(rec.Result);
      const message = result && typeof result.message === 'string' ? result.message : '';
      return dumpSection('output', message);
    }
    case 'ImageGen': {
      const path = typeof rec.path === 'string' ? rec.path : '';
      return dumpSection('output', path);
    }
    default:
      return null;
  }
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

export function boundedOutputLines(value: string, maxLines: number): string {
  // Backends that captured their tool output under a PTY / forced color (e.g. `gh`
  // colorizing JSON) hand us raw ANSI SGR codes. This panel renders via
  // `pre.textContent`, so an unhandled ESC (0x1b) byte shows as a garbage glyph and
  // the trailing `[1;37m` shows as literal text. Strip ANSI + leftover C0/C1 control
  // chars here (keeping \t and \n) so every lane's output reads clean.
  const kept = stripAnsi(value)
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '')
    .replace(/\r/g, '')
    .split('\n')
    .map((line) => line.replace(/\s+$/, ''))
    .filter((line) => line.length > 0)
    .slice(0, maxLines);
  let minIndent = Infinity;
  for (const line of kept) {
    const match = line.match(/^[ \t]*/);
    const indent = match ? match[0].length : 0;
    if (indent < minIndent) minIndent = indent;
    if (minIndent === 0) break;
  }
  if (!Number.isFinite(minIndent)) minIndent = 0;
  return kept
    .map((line) => line.slice(minIndent))
    .map((line) => (line.length > 140 ? `${line.slice(0, 139).trimEnd()}…` : line))
    .join('\n');
}

export function buildToolPayload(
  call: ToolCall | ToolCallUpdate,
  status: string,
  startedAt?: number,
  endedAt?: number,
): ToolPayload {
  const kind = inferToolLabel(call);
  const path = extractModifiedPath(call);
  const command = kind === 'execute' ? extractCommandLine(call.rawInput) : '';
  const subject = command || path || cleanToolTitle(call.title, kind) || '';
  const raw = rawOutputSections(call.rawOutput);
  const peeled = peelSectionExit(
    raw.length > 0 ? raw : contentOutputSections(call.content),
    extractToolExitCode(call.rawOutput),
  );
  const exitCode = peeled.exitCode;
  const result = (exitCode !== null && exitCode !== 0)
    ? `exit ${exitCode}`
    : (status === 'failed' ? 'failed' : '');
  const sectionLineLimit = kind === 'execute' && isGitDiffCommand(command) ? 80 : kind === 'execute' ? 12 : 6;
  const trimmed = peeled.sections
    .map((s) => ({
      label: s.label,
      text: boundedOutputLines(normalizeToolDump(s.text, kind), sectionLineLimit),
    }))
    .filter((s) => s.text)
    .slice(0, 4);
  const diffs = extractToolDiffs(call.content);
  return {
    glyph: statusGlyph(status),
    status,
    kind,
    subject,
    command,
    result,
    exitCode,
    sections: trimmed,
    diffs,
    startedAt,
    endedAt,
  };
}

export function isTerminalToolStatus(status: string): boolean {
  return status === 'completed' || status === 'failed' || status === 'canceled';
}

export function formatToolElapsed(ms: number): string {
  if (ms < 0) return '';
  if (ms < 1000) return `${Math.round(ms / 100) * 100}ms`;
  if (ms < 10_000) return `${(ms / 1000).toFixed(1)}s`;
  if (ms < 60_000) return `${Math.floor(ms / 1000)}s`;
  const m = Math.floor(ms / 60_000);
  const s = Math.floor((ms % 60_000) / 1000);
  return `${m}m ${s}s`;
}

export function extractToolDiffs(content: ToolCall['content']): Array<{ path: string; oldText: string; newText: string }> {
  const out: Array<{ path: string; oldText: string; newText: string }> = [];
  for (const item of content ?? []) {
    if (item.type === 'diff' && (item.newText !== undefined || item.oldText !== undefined)) {
      out.push({
        path: item.path ?? '',
        oldText: item.oldText ?? '',
        newText: item.newText ?? '',
      });
    }
  }
  return out;
}

export function renderToolBody(body: HTMLElement, tool: ToolPayload): void {
  const head = document.createElement('div');
  head.className = 'acp-harness__tool-head';
  const glyph = document.createElement('span');
  glyph.className = `acp-harness__tool-glyph acp-harness__tool-glyph--${tool.status}`;
  glyph.textContent = tool.glyph;
  head.appendChild(glyph);
  const kind = document.createElement('span');
  kind.className = 'acp-harness__tool-kind';
  kind.dataset.kind = toolChipKind(tool.kind);
  kind.textContent = tool.kind;
  head.appendChild(kind);
  if (tool.subject) {
    const subject = document.createElement('span');
    subject.className = 'acp-harness__tool-subject';
    subject.textContent = tool.subject;
    head.appendChild(subject);
  }
  if (tool.result) {
    const result = document.createElement('span');
    result.className = `acp-harness__tool-result acp-harness__tool-result--${tool.status}`;
    result.textContent = tool.result;
    head.appendChild(result);
  }
  if (tool.startedAt !== undefined) {
    const timer = document.createElement('span');
    timer.className = `acp-harness__tool-timer acp-harness__tool-timer--${tool.status}`;
    timer.dataset.startedAt = String(tool.startedAt);
    if (tool.endedAt !== undefined) {
      timer.dataset.endedAt = String(tool.endedAt);
      timer.textContent = formatToolElapsed(tool.endedAt - tool.startedAt);
    } else {
      timer.textContent = formatToolElapsed(performance.now() - tool.startedAt);
    }
    head.appendChild(timer);
  }
  body.appendChild(head);
  if (tool.artifactRedaction) {
    body.appendChild(renderArtifactRedaction(tool.artifactRedaction));
    return;
  }
  if (tool.sections.length > 0 || shouldRenderExecuteExit(tool)) {
    body.appendChild(renderToolOutput(tool));
  }
  if (tool.diffs.length > 0) {
    const wrap = document.createElement('div');
    wrap.className = 'acp-harness__tool-diffs';
    for (const d of tool.diffs) {
      const block = document.createElement('div');
      block.className = 'acp-harness__tool-diff';
      if (d.path) {
        const path = document.createElement('div');
        path.className = 'acp-harness__tool-diff-path';
        path.textContent = d.path;
        block.appendChild(path);
      }
      const inner = document.createElement('div');
      inner.innerHTML = renderDiffPreview(d.oldText, d.newText, { cssPrefix: 'acp-harness' });
      block.appendChild(inner);
      wrap.appendChild(block);
    }
    body.appendChild(wrap);
  }
}

export function formatArtifactBytes(size: number | null): string {
  if (size === null) return '— bytes';
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`;
  return `${(size / (1024 * 1024)).toFixed(1)} MB`;
}

/** spec 133 — redacted body for an artifact-path write/edit card: never the
 * HTML, only path + bytes + hash. */
export function renderArtifactRedaction(r: NonNullable<ToolPayload['artifactRedaction']>): HTMLElement {
  const wrap = document.createElement('div');
  wrap.className = 'acp-harness__artifact-redaction';
  const note = document.createElement('div');
  note.className = 'acp-harness__artifact-redaction-note';
  note.textContent = r.pending ? 'html artifact · contents hidden' : 'html artifact edit · contents hidden';
  wrap.appendChild(note);
  const meta = document.createElement('div');
  meta.className = 'acp-harness__artifact-redaction-meta';
  const hash7 = r.hash ? r.hash.slice(0, 7) : '—';
  meta.textContent = `${r.tail} · ${formatArtifactBytes(r.size)} · ${hash7}`;
  wrap.appendChild(meta);
  return wrap;
}

/** spec 133 — hintable artifact card body. */
export function renderArtifactCardBody(body: HTMLElement, card: ArtifactCardPayload): void {
  const head = document.createElement('div');
  head.className = 'acp-harness__artifact-head';
  if (card.hintLabel) {
    const hint = document.createElement('span');
    hint.className = 'acp-harness__artifact-hint';
    hint.textContent = card.hintLabel;
    head.appendChild(hint);
  }
  const glyph = document.createElement('span');
  glyph.className = 'acp-harness__artifact-glyph';
  glyph.textContent = '◫';
  head.appendChild(glyph);
  const title = document.createElement('span');
  title.className = 'acp-harness__artifact-title';
  title.textContent = card.title;
  head.appendChild(title);
  body.appendChild(head);

  const meta = document.createElement('div');
  meta.className = 'acp-harness__artifact-meta';
  const hash7 = card.hash ? card.hash.slice(0, 7) : '—';
  meta.textContent = card.available
    ? `${formatArtifactBytes(card.size)} · ${hash7}`
    : 'unavailable — file removed';
  body.appendChild(meta);

  const action = document.createElement('div');
  action.className = 'acp-harness__artifact-action';
  action.textContent = card.available
    ? (card.hintLabel ? `press ${card.hintLabel} to open in browser` : 'f then label to open in browser')
    : 'reopen unavailable';
  body.appendChild(action);
}

/** spec 211 — hintable Review Board card body. Deliberately no `available`
 *  branch: the bundle is a durable record on disk, so the card stays openable
 *  even after the authoring lane dies. */
export function renderReviewCardBody(body: HTMLElement, card: ReviewCardPayload): void {
  const head = document.createElement('div');
  head.className = 'acp-harness__artifact-head';
  if (card.hintLabel) {
    const hint = document.createElement('span');
    hint.className = 'acp-harness__artifact-hint';
    hint.textContent = card.hintLabel;
    head.appendChild(hint);
  }
  const glyph = document.createElement('span');
  glyph.className = 'acp-harness__artifact-glyph';
  glyph.textContent = '\u25a4';
  head.appendChild(glyph);
  const title = document.createElement('span');
  title.className = 'acp-harness__artifact-title';
  title.textContent = card.title;
  head.appendChild(title);
  body.appendChild(head);

  // Step count sits next to the block count: on a comprehension Board it is the
  // better measure of "how much is here to read". A Board with no findings and no
  // decisions reads as `reference` — an explanation, not a task.
  const parts = [`${card.blocks} block${card.blocks === 1 ? '' : 's'}`];
  if (card.steps > 0) parts.push(`${card.steps} step${card.steps === 1 ? '' : 's'}`);
  if (card.findings > 0) parts.push(`${card.findings} finding${card.findings === 1 ? '' : 's'}`);
  if (card.decisions > 0) {
    parts.push(`${card.decisions} decision${card.decisions === 1 ? '' : 's'}`);
  }
  if (card.findings === 0 && card.decisions === 0) parts.push('reference');

  const meta = document.createElement('div');
  meta.className = 'acp-harness__artifact-meta';
  meta.textContent = parts.join(' \u00b7 ');
  body.appendChild(meta);

  const action = document.createElement('div');
  action.className = 'acp-harness__artifact-action';
  action.textContent = card.hintLabel
    ? `press ${card.hintLabel} to open the review`
    : 'f then label to open \u00b7 Leader Shift+R to reopen later';
  body.appendChild(action);
}

export function shouldRenderExecuteExit(tool: Pick<ToolPayload, 'kind' | 'exitCode'>): boolean {
  return tool.exitCode != null && toolChipKind(tool.kind) === 'execute';
}

export function renderToolExit(code: number): HTMLElement {
  const row = document.createElement('div');
  row.className = 'acp-harness__tool-exit';
  row.dataset.status = code === 0 ? 'ok' : 'fail';
  const label = document.createElement('span');
  label.className = 'acp-harness__tool-exit-label';
  label.textContent = 'exit';
  const badge = document.createElement('span');
  badge.className = 'acp-harness__tool-exit-code';
  badge.textContent = String(code);
  row.appendChild(label);
  row.appendChild(badge);
  return row;
}

export function renderToolOutput(tool: ToolPayload): HTMLElement {
  const output = document.createElement('div');
  output.className = 'acp-harness__tool-output';
  let exitCode = tool.exitCode ?? null;
  const painted: Array<{ label: string; text: string }> = [];
  for (const raw of tool.sections) {
    let text = normalizeToolDump(raw.text, tool.kind);
    if (/^(stdout|output)$/i.test(raw.label)) {
      const peeled = peelExitPrefix(text);
      if (peeled) {
        if (exitCode === null) exitCode = peeled.code;
        text = peeled.rest;
      }
    }
    if (text.trim()) painted.push({ label: raw.label, text });
  }
  if (exitCode !== null && toolChipKind(tool.kind) === 'execute') {
    output.appendChild(renderToolExit(exitCode));
  }
  for (const section of painted) {
    const git = tool.kind === 'execute' ? renderRichExecuteSection(tool, section) : null;
    if (git) {
      output.appendChild(git);
      continue;
    }
    const grep = isGrepLikeOutput(tool, section) ? renderGrepSection(tool, section) : null;
    output.appendChild(grep ?? renderPlainToolSection(section));
  }
  return output;
}

export function renderPlainToolSection(section: { label: string; text: string }): HTMLElement {
  const block = document.createElement('div');
  const tone = toolSectionTone(section.label);
  block.className = `acp-harness__tool-section acp-harness__tool-section--${tone}`;
  const label = document.createElement('div');
  label.className = 'acp-harness__tool-section-label';
  label.textContent = section.label;
  const pre = document.createElement('pre');
  pre.className = 'acp-harness__tool-section-text';
  pre.textContent = section.text;
  block.appendChild(label);
  block.appendChild(pre);
  return block;
}

export function renderRichExecuteSection(tool: ToolPayload, section: { label: string; text: string }): HTMLElement | null {
  const label = section.label.toLowerCase();
  if (label !== 'stdout' && label !== 'output') return null;
  if (/\bgit\s+diff\s+--stat\b/.test(tool.command)) {
    const rows = parseGitDiffStat(section.text);
    if (rows.length > 0) return renderGitDiffStat(rows, section.text);
  }
  if (isGitDiffCommand(tool.command) && section.text.includes('diff --git')) {
    return renderUnifiedGitDiff(section.text);
  }
  if (/\bgit\s+status\s+--short\b/.test(tool.command)) {
    const rows = parseGitStatusShort(section.text);
    if (rows.length > 0) return renderGitStatusShort(rows);
  }
  return null;
}

export function isGitDiffCommand(command: string): boolean {
  return /\bgit\s+diff\b/.test(command);
}

export function parseGitDiffStat(text: string): Array<{ path: string; changes: number; plus: number; minus: number }> {
  const rows: Array<{ path: string; changes: number; plus: number; minus: number }> = [];
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (!line || /\d+\s+files?\s+changed/.test(line)) continue;
    const match = line.match(/^(.+?)\s+\|\s+(\d+)\s+([+\-]+)$/);
    if (!match) continue;
    const marks = match[3] ?? '';
    rows.push({
      path: match[1]?.trim() ?? '',
      changes: Number(match[2] ?? 0),
      plus: (marks.match(/\+/g) ?? []).length,
      minus: (marks.match(/-/g) ?? []).length,
    });
  }
  return rows.slice(0, 8);
}

export function renderGitDiffStat(rows: Array<{ path: string; changes: number; plus: number; minus: number }>, source: string): HTMLElement {
  const block = document.createElement('div');
  block.className = 'acp-harness__tool-rich acp-harness__tool-rich--diffstat';
  const total = Math.max(1, ...rows.map((row) => row.changes));
  for (const row of rows) {
    const item = document.createElement('div');
    item.className = 'acp-harness__tool-stat-row';
    const path = document.createElement('span');
    path.className = 'acp-harness__tool-stat-path acp-harness__tok-path';
    path.textContent = row.path;
    const count = document.createElement('span');
    count.className = 'acp-harness__tool-stat-count';
    count.textContent = String(row.changes);
    const bar = document.createElement('span');
    bar.className = 'acp-harness__tool-stat-bar';
    bar.style.setProperty('--stat-plus-width', `${(row.plus / total) * 100}%`);
    bar.style.setProperty('--stat-minus-width', `${(row.minus / total) * 100}%`);
    item.append(path, count, bar);
    block.appendChild(item);
  }
  const omitted = source.split('\n').filter((line) => line.trim() && !/\d+\s+files?\s+changed/.test(line)).length - rows.length;
  if (omitted > 0) {
    const more = document.createElement('div');
    more.className = 'acp-harness__tool-rich-more';
    more.textContent = `${omitted} more file${omitted === 1 ? '' : 's'}`;
    block.appendChild(more);
  }
  return block;
}

export function renderUnifiedGitDiff(text: string): HTMLElement {
  const block = document.createElement('div');
  block.className = 'acp-harness__tool-rich acp-harness__tool-rich--unidiff';
  const lines = text.split('\n').filter((line) => line.length > 0);
  for (const line of lines) {
    if (line.startsWith('diff --git ')) {
      const file = document.createElement('div');
      file.className = 'acp-harness__tool-diff-file acp-harness__tok-path';
      file.textContent = gitDiffFileLabel(line);
      block.appendChild(file);
      continue;
    }
    const row = document.createElement('div');
    row.className = `acp-harness__tool-diff-line acp-harness__tool-diff-line--${gitDiffLineTone(line)}`;
    const mark = document.createElement('span');
    mark.className = 'acp-harness__tool-diff-mark';
    mark.textContent = gitDiffLineMark(line);
    const body = document.createElement('span');
    body.className = 'acp-harness__tool-diff-text';
    body.textContent = gitDiffLineText(line);
    row.append(mark, body);
    block.appendChild(row);
  }
  return block;
}

export function gitDiffFileLabel(line: string): string {
  const match = line.match(/^diff --git a\/(.+?) b\/(.+)$/);
  if (!match) return line.replace(/^diff --git\s+/, '');
  const oldPath = match[1] ?? '';
  const newPath = match[2] ?? '';
  return oldPath === newPath ? newPath : `${oldPath} -> ${newPath}`;
}

export function gitDiffLineTone(line: string): string {
  if (line.startsWith('@@')) return 'hunk';
  if (line.startsWith('+++') || line.startsWith('---') || line.startsWith('index ')) return 'meta';
  if (line.startsWith('+')) return 'add';
  if (line.startsWith('-')) return 'del';
  return 'context';
}

export function gitDiffLineMark(line: string): string {
  if (line.startsWith('@@')) return '@@';
  if (line.startsWith('+++') || line.startsWith('---') || line.startsWith('index ')) return '·';
  if (line.startsWith('+')) return '+';
  if (line.startsWith('-')) return '-';
  return '';
}

export function gitDiffLineText(line: string): string {
  if (line.startsWith('@@')) return line;
  if (line.startsWith('+++') || line.startsWith('---')) return line.slice(4);
  if (line.startsWith('+') || line.startsWith('-')) return line.slice(1);
  return line.startsWith(' ') ? line.slice(1) : line;
}

export function parseGitStatusShort(text: string): Array<{ index: string; worktree: string; path: string }> {
  const rows: Array<{ index: string; worktree: string; path: string }> = [];
  for (const raw of text.split('\n')) {
    if (!raw.trim()) continue;
    const match = raw.match(/^(.)(.)\s+(.+)$/);
    if (!match) continue;
    rows.push({
      index: match[1] ?? ' ',
      worktree: match[2] ?? ' ',
      path: match[3] ?? '',
    });
  }
  return rows.slice(0, 10);
}

export function renderGitStatusShort(rows: Array<{ index: string; worktree: string; path: string }>): HTMLElement {
  const block = document.createElement('div');
  block.className = 'acp-harness__tool-rich acp-harness__tool-rich--gitstatus';
  for (const row of rows) {
    const item = document.createElement('div');
    item.className = 'acp-harness__tool-status-row';
    const badge = document.createElement('span');
    badge.className = `acp-harness__tool-status-badge acp-harness__tool-status-badge--${gitStatusTone(row.index, row.worktree)}`;
    badge.textContent = `${row.index}${row.worktree}`.trim() || 'M';
    const path = document.createElement('span');
    path.className = 'acp-harness__tool-status-path acp-harness__tok-path';
    path.textContent = row.path;
    item.append(badge, path);
    block.appendChild(item);
  }
  return block;
}

export function gitStatusTone(index: string, worktree: string): string {
  if (index === '?' || worktree === '?') return 'new';
  if (index === 'D' || worktree === 'D') return 'deleted';
  if (index === 'A' || worktree === 'A') return 'added';
  return 'modified';
}

export function toolSectionTone(label: string): string {
  const normalized = label.toLowerCase();
  if (normalized === 'stderr' || normalized === 'error' || normalized === 'message') return 'error';
  if (
    normalized === 'stdout' ||
    normalized === 'output' ||
    normalized === 'text' ||
    normalized === 'content'
  ) {
    return 'output';
  }
  if (normalized === 'summary') return 'summary';
  if (normalized === 'diff') return 'diff';
  if (normalized === 'terminal') return 'terminal';
  return 'default';
}

/** Chip `data-kind` for spec 235 / 231 HUD accents. Local map so this file
 *  does not import the HUD module (HUD already imports us). */
export function toolChipKind(kind: string): string {
  const k = kind.trim().toLowerCase();
  if (!k) return 'other';
  if (k === 'edit' || k === 'write' || k === 'create' || k === 'modify' || k === 'patch') return 'edit';
  if (k === 'read' || k === 'open' || k === 'cat') return 'read';
  if (k === 'search' || k === 'grep' || k === 'rg' || k === 'find') return 'search';
  if (
    k === 'execute' ||
    k === 'bash' ||
    k === 'shell' ||
    k === 'run' ||
    k === 'exec' ||
    k === 'command'
  ) {
    return 'execute';
  }
  if (k === 'delete') return 'delete';
  if (k === 'move' || k === 'rename') return 'move';
  if (k === 'fetch' || k === 'http' || k === 'web') return 'fetch';
  return 'other';
}

const GREP_CMD = /\b(rg|grep|ag|ack)\b/;
const GREP_SECTION = /^(stdout|output|content|text)$/i;

export function isGrepCommand(text: string): boolean {
  return GREP_CMD.test(text);
}

export function isGrepLikeOutput(
  tool: Pick<ToolPayload, 'kind' | 'command' | 'subject'>,
  section: { label: string },
): boolean {
  if (!GREP_SECTION.test(section.label)) return false;
  if (toolChipKind(tool.kind) === 'search') return true;
  return isGrepCommand(tool.command) || isGrepCommand(tool.subject);
}

/** Quoted `-e` or first quoted arg after rg/grep/ag/ack. Empty when unquoted. */
export function extractGrepQuery(command: string): string {
  if (!command) return '';
  const eFlag = command.match(/(?:^|\s)-e\s+(?:"([^"]+)"|'([^']+)'|(\S+))/);
  if (eFlag) return (eFlag[1] ?? eFlag[2] ?? eFlag[3] ?? '').trim();
  const flags = '(?:\\s+--?[A-Za-z0-9][A-Za-z0-9-]*)*';
  const dbl = command.match(new RegExp(`\\b(?:rg|grep|ag|ack)\\b${flags}\\s+"([^"]+)"`));
  if (dbl?.[1]) return dbl[1].trim();
  const sgl = command.match(new RegExp(`\\b(?:rg|grep|ag|ack)\\b${flags}\\s+'([^']+)'`));
  if (sgl?.[1]) return sgl[1].trim();
  return '';
}

/** Literal needles from a quoted grep pattern. Splits grep `\\|` / `|` OR. */
export function grepHitNeedles(query: string): string[] {
  if (!query) return [];
  const parts = query.split(/\\\||\|/).map((part) => part.trim()).filter((part) => part.length >= 2);
  return parts;
}

export interface GrepRow {
  path: string | null;
  line: string;
  text: string;
  context: boolean;
}

function looksLikeGrepPath(value: string): boolean {
  if (!value || value.length > 240) return false;
  if (/\s/.test(value)) return false;
  if (/^(error|warning|note|fatal|info)$/i.test(value)) return false;
  return /[./\\]/.test(value);
}

export function parseGrepLine(line: string): GrepRow | null {
  let match = line.match(/^(.+?):(\d+):(\d+):(.*)$/);
  if (match && looksLikeGrepPath(match[1] ?? '')) {
    return {
      path: match[1] ?? '',
      line: `${match[2]}:${match[3]}`,
      text: match[4] ?? '',
      context: false,
    };
  }
  match = line.match(/^(.+?):(\d+):(.*)$/);
  if (match && looksLikeGrepPath(match[1] ?? '')) {
    return {
      path: match[1] ?? '',
      line: match[2] ?? '',
      text: match[3] ?? '',
      context: false,
    };
  }
  match = line.match(/^(.+?)-(\d+)-(.*)$/);
  if (match && looksLikeGrepPath(match[1] ?? '')) {
    return {
      path: match[1] ?? '',
      line: match[2] ?? '',
      text: match[3] ?? '',
      context: true,
    };
  }
  match = line.match(/^(\d+):(.*)$/);
  if (match) {
    return { path: null, line: match[1] ?? '', text: match[2] ?? '', context: false };
  }
  match = line.match(/^(\d+)-(.*)$/);
  if (match) {
    return { path: null, line: match[1] ?? '', text: match[2] ?? '', context: true };
  }
  return null;
}

const WORKSPACE_OPEN_RE = /^<workspace_result\b[^>]*>\s*/i;
const WORKSPACE_CLOSE_RE = /\s*<\/workspace_result>\s*$/i;
const GREP_FOUND_RE = /^Found(?: at least)? \d+ matching lines?$/i;
const GREP_NONE_RE = /^No matches found$/i;

/** Grok's grep/search tool wraps hits in a `<workspace_result>` envelope.
 *  Strip the open tag even when the line cap dropped the close tag, so a
 *  truncated dump does not paint XML. */
export function unwrapWorkspaceResultDump(text: string): string {
  const trimmed = text.trim();
  if (!WORKSPACE_OPEN_RE.test(trimmed)) return text;
  return trimmed.replace(WORKSPACE_OPEN_RE, '').replace(WORKSPACE_CLOSE_RE, '').trim();
}

/** Drop Grok `read_file` line-number anchors (`1→`, `10→`, …). Display only. */
export function stripGrokReadLineAnchors(text: string): string {
  return text.replace(/^\d+→/gm, '');
}

/** True when the dump starts with a Grok `read_file` line anchor (`1→`, `238→`). */
export function looksLikeGrokReadAnchors(text: string): boolean {
  const first = text.split('\n', 1)[0] ?? '';
  return /^\d+→/.test(first);
}

/** Protocol wrappers Grok puts around tool dumps, before the line cap.
 *  Shape-based: XML unwrap always; N→ strip when kind is read *or* the dump
 *  itself starts with an anchor (kind can be missing on a tool_call_update). */
export function normalizeToolDump(text: string, kind: string): string {
  let out = unwrapWorkspaceResultDump(text);
  if (toolChipKind(kind) === 'read' || looksLikeGrokReadAnchors(out)) {
    out = stripGrokReadLineAnchors(out);
  }
  return out;
}

function isGrepPathHeader(line: string): boolean {
  return looksLikeGrepPath(line) && !/:\d+/.test(line);
}

/** Majority of considered lines must parse, else null (plain `<pre>`).
 *  Host preamble (XML envelope, "Found N", path-only headers) is skipped so
 *  Grok's grouped dump (`path` then `line:text`) still qualifies. */
export function parseGrepDump(text: string): GrepRow[] | null {
  const lines = unwrapWorkspaceResultDump(text)
    .split('\n')
    .map((line) => line.replace(/\s+$/, ''))
    .filter((line) => line.length > 0);
  if (lines.length === 0) return null;
  const rows: GrepRow[] = [];
  let currentPath: string | null = null;
  let considered = 0;
  for (const line of lines) {
    if (GREP_FOUND_RE.test(line) || GREP_NONE_RE.test(line)) continue;
    if (isGrepPathHeader(line)) {
      currentPath = line;
      continue;
    }
    considered += 1;
    const row = parseGrepLine(line);
    if (!row) continue;
    if (!row.path && currentPath) row.path = currentPath;
    rows.push(row);
  }
  if (considered === 0 || rows.length * 2 <= considered) return null;
  return rows;
}

function appendHighlighted(parent: HTMLElement, text: string, needles: string[]): void {
  if (!text) return;
  if (needles.length === 0) {
    parent.appendChild(document.createTextNode(text));
    return;
  }
  let rest = text;
  while (rest.length > 0) {
    let bestAt = -1;
    let bestNeedle = '';
    for (const needle of needles) {
      const at = rest.indexOf(needle);
      if (at < 0) continue;
      if (bestAt < 0 || at < bestAt || (at === bestAt && needle.length > bestNeedle.length)) {
        bestAt = at;
        bestNeedle = needle;
      }
    }
    if (bestAt < 0) {
      parent.appendChild(document.createTextNode(rest));
      return;
    }
    if (bestAt > 0) parent.appendChild(document.createTextNode(rest.slice(0, bestAt)));
    const hit = document.createElement('span');
    hit.className = 'acp-harness__tok-hit';
    hit.textContent = bestNeedle;
    parent.appendChild(hit);
    rest = rest.slice(bestAt + bestNeedle.length);
  }
}

function tok(kind: string, value: string): HTMLElement {
  const el = document.createElement('span');
  el.className = `acp-harness__tok-${kind}`;
  el.textContent = value;
  return el;
}

export function renderGrepSection(
  tool: Pick<ToolPayload, 'command' | 'subject'>,
  section: { label: string; text: string },
): HTMLElement | null {
  const rows = parseGrepDump(section.text);
  if (!rows) return null;
  const needles = grepHitNeedles(extractGrepQuery(tool.command) || extractGrepQuery(tool.subject));
  const block = document.createElement('div');
  block.className = 'acp-harness__tool-section acp-harness__tool-section--output';
  const label = document.createElement('div');
  label.className = 'acp-harness__tool-section-label';
  label.textContent = section.label;
  block.appendChild(label);
  const rich = document.createElement('div');
  rich.className = 'acp-harness__tool-rich acp-harness__tool-rich--grep';
  for (const row of rows) {
    const line = document.createElement('div');
    const shape = row.path ? 'path' : 'lineno';
    line.className = `acp-harness__grep-row acp-harness__grep-row--${shape}${row.context ? ' acp-harness__grep-row--ctx' : ''}`;
    if (row.path) {
      line.appendChild(tok('path', row.path));
      line.appendChild(tok('sep', ':'));
    }
    line.appendChild(tok('line', row.line));
    line.appendChild(tok('sep', row.path ? ':' : row.context ? '-' : ':'));
    const text = document.createElement('span');
    text.className = row.context ? 'acp-harness__tok-text acp-harness__tok-ctx' : 'acp-harness__tok-text';
    if (row.context || needles.length === 0) {
      text.textContent = row.text;
    } else {
      appendHighlighted(text, row.text, needles);
    }
    line.appendChild(text);
    rich.appendChild(line);
  }
  block.appendChild(rich);
  return block;
}
