// Spec 386 — display-only recognition, never execution or approval evidence.
import { boundedOutputLines } from '../harness-tool-render';
import type { RemoteCommandPayload } from '../harness-view-types';
import { terminalMetaOf } from './generic';
import type { ToolStep } from './types';

const SERVERS: Record<string, true> = { 'krypton-harness-bus': true, krypton_harness_bus: true, 'krypton-harness-memory': true, krypton_harness_memory: true };
const UNKNOWN_RESULT = 'Remote command outcome unknown after timeout, lane cancellation, or disconnect: ';
const UNKNOWN_INPUT = 'Remote command outcome unknown while sending input or connection closed';
const CLI_ERROR = 'kryptonctl: computer_exec_failed: ';
type Field = RemoteCommandPayload['displayTruncated'][number];
type Request = Pick<RemoteCommandPayload, 'source' | 'computerId' | 'command' | 'cwd'>;
type Result = NonNullable<RemoteCommandPayload['result']> & { computerId: string };

// Keep full ID identity after wire compaction without retaining unbounded IDs.
const REQUEST_IDS = new WeakMap<RemoteCommandPayload, string>();
// Assemble CLI terminal chunks before the generic 16 KiB terminal preview cap.
// 4M UTF-16 units cover the backend's two 256 KiB streams, even JSON-escaped.
interface TerminalCapture { readonly text: string; readonly overflow: boolean }
const TERMINAL_CAPTURES = new WeakMap<RemoteCommandPayload, TerminalCapture>();
const TERMINAL_RESULT_CHAR_LIMIT = 4 * 1024 * 1024;

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

/** POSIX words only. No expansions, shell syntax, comments, or globbing. */
function words(script: string): string[] | null {
  const out: string[] = [];
  let i = 0;
  while (i < script.length) {
    while (script[i] === ' ' || script[i] === '\t') i++;
    if (i === script.length) break;
    if (out.length === 0 && script.slice(i, i + 18) === '"$KRYPTONCTL_PATH"' && /[ \t]|^$/.test(script[i + 18] ?? '')) {
      out.push('kryptonctl'); i += 18; continue;
    }
    const start = i;
    let word = '';
    let quote = '';
    while (i < script.length) {
      const c = script[i++];
      if (quote === "'") {
        if (c === "'") quote = ''; else word += c;
      } else if (c === '\\') {
        if (i === script.length || script[i] === '\n' || script[i] === '\r') return null;
        const next = script[i++];
        word += quote === '"' && !['$', '`', '"', '\\'].includes(next) ? `\\${next}` : next;
      } else if (quote === '"') {
        if (c === '"') quote = '';
        else if (c === '$' || c === '`') return null;
        else word += c;
      } else if (c === "'" || c === '"') quote = c;
      else if (c === ' ' || c === '\t') break;
      else if (/[\n\r;&|<>()$`*?\[\]{}~#]/.test(c)) return null;
      else word += c;
    }
    if (quote) return null;
    // The executable itself must have one of the two exact spellings.
    if (out.length === 0 && script.slice(start, i).trim() !== 'kryptonctl') return null;
    out.push(word);
  }
  return out;
}

function cliRequest(script: string): Request | null {
  const argv = words(script);
  if (!argv || argv.shift() !== 'kryptonctl') return null;
  for (const flag of ['--json', '--yes']) {
    const index = argv.indexOf(flag);
    if (index >= 0) argv.splice(index, 1);
  }
  if (argv[0] !== 'computer' || argv[1] !== 'exec' || argv.length < 5) return null;
  const computerId = argv[2];
  let cwd: string | null = null;
  let i = 3;
  while (i < argv.length && argv[i] !== '--') {
    const option = argv[i++];
    const value = argv[i++];
    if (value === undefined) return null;
    if (option === '--cwd') cwd = value;
    else if (option !== '--timeout' || !/^\+?\d+$/.test(value) || BigInt(value) > 18446744073709551615n) return null;
  }
  if (argv[i] !== '--' || i + 1 >= argv.length) return null;
  return { source: 'cli', computerId, cwd, command: argv.slice(i + 1).join(' ') };
}

function request(step: ToolStep): Request | null {
  const { draft, merged } = step;
  if (draft.execution || draft.subagents || draft.jobs || draft.guardianReview || draft.parentId ||
    draft.inputPaths.some((path) => /(?:^|\/)\.krypton\/artifacts\//.test(path)) ||
    draft.locations.some((path) => /(?:^|\/)\.krypton\/artifacts\//.test(path))) return null;
  if (draft.mcp) {
    if (draft.mcp.tool !== 'computer_exec' || SERVERS[draft.mcp.server] !== true) return null;
    const input = record(merged.rawInput);
    if (!input || typeof input.computerId !== 'string' || typeof input.command !== 'string' ||
      (input.cwd !== undefined && input.cwd !== null && typeof input.cwd !== 'string')) return null;
    return { source: 'mcp', computerId: input.computerId, command: input.command, cwd: input.cwd as string | null | undefined ?? null };
  }
  // A rejected MCP identity must not be reinterpreted from its remote command.
  if (merged.title?.trim().startsWith('mcp__')) return null;
  if (draft.kind !== 'execute') return null;
  const input = record(merged.rawInput);
  const script = input?.command ?? input?.cmd;
  return typeof script === 'string' ? cliRequest(script) : null;
}

function bound(value: string, bytes: number): string {
  // Counting code points avoids allocating an encoded copy of large output.
  let used = 0;
  let end = 0;
  for (const c of value) {
    const code = c.codePointAt(0)!;
    const size = code <= 0x7f ? 1 : code <= 0x7ff ? 2 : code <= 0xffff ? 3 : 4;
    if (used + size > bytes) break;
    used += size; end += c.length;
  }
  return end === value.length ? value : value.slice(0, end);
}

function parse(value: unknown): unknown {
  if (typeof value !== 'string') return value;
  try { return JSON.parse(value); } catch { return null; }
}

function result(value: unknown): Result | null {
  const r = record(parse(value));
  if (!r || typeof r.computerId !== 'string' ||
    !(r.exitCode === null || (typeof r.exitCode === 'number' && Number.isInteger(r.exitCode) && r.exitCode >= -2147483648 && r.exitCode <= 2147483647)) ||
    typeof r.stdout !== 'string' || typeof r.stderr !== 'string' || typeof r.truncated !== 'boolean' ||
    (r.outcome !== 'completed' && r.outcome !== 'unknown')) return null;
  return r as unknown as Result;
}

/** Only known top-level envelopes; never recursively mine arbitrary JSON. */
function outputs(step: ToolStep, source: Request['source'], prior: RemoteCommandPayload | undefined): {
  values: unknown[]; error: boolean; extra: boolean;
  terminal: boolean; capture?: TerminalCapture;
} {
  const values: unknown[] = [];
  let error = false;
  let extra = false;
  const capture = prior ? TERMINAL_CAPTURES.get(prior) : undefined;
  const terminal = source === 'cli' ? terminalMetaOf(step.call._meta) : null;
  const settled = step.draft.status === 'completed' || step.draft.status === 'failed' || step.draft.status === 'canceled';
  if (terminal?.output != null || terminal?.exit || (capture && settled)) {
    const chunk = terminal?.output ?? '';
    const overflow = capture?.overflow === true || (capture?.text.length ?? 0) + chunk.length > TERMINAL_RESULT_CHAR_LIMIT;
    const text = overflow ? '' : (capture?.text ?? '') + chunk;
    // Partial JSON is not a command failure. Plain diagnostics settle on exit.
    const ready = settled || !!terminal?.exit || text.trimEnd().endsWith('}') ||
      text.trimEnd() === UNKNOWN_INPUT || text.trimEnd() === CLI_ERROR + UNKNOWN_INPUT;
    return { values: ready && text ? [text] : [], error: false, extra: overflow,
      terminal: true, capture: { text, overflow } };
  }
  const addContent = (content: unknown) => {
    if (!Array.isArray(content)) return;
    for (const block of content) {
      const b = record(block);
      if (b?.type === 'text' && typeof b.text === 'string') values.push(b.text);
      else extra = true;
    }
  };
  const raw = step.call.rawOutput;
  if (raw !== undefined) {
    const r = record(raw);
    if (!r) values.push(raw);
    else if ('computerId' in r) values.push(r);
    else if (Array.isArray(r.content)) { addContent(r.content); error = r.isError === true; }
    else {
      for (const key of ['stdout', 'stderr', 'output', 'output_for_prompt']) {
        if (typeof r[key] === 'string' && r[key] !== '') values.push(r[key]);
      }
      if (values.length === 0) values.push(raw);
    }
  }
  if (step.call.content?.length) {
    for (const item of step.call.content) {
      if (item.type === 'content') addContent([item.content]);
      else if (item.type !== 'terminal') extra = true;
    }
  }
  return { values, error, extra, terminal: false, capture };
}

function equal(a: RemoteCommandPayload, b: RemoteCommandPayload): boolean {
  return a.source === b.source && a.computerId === b.computerId && a.cwd === b.cwd && a.command === b.command &&
    a.error === b.error && a.outcomeUnknown === b.outcomeUnknown &&
    a.displayTruncated.join() === b.displayTruncated.join() &&
    (a.result === b.result || (!!a.result && !!b.result && a.result.exitCode === b.result.exitCode &&
      a.result.outcome === b.result.outcome && a.result.stdout === b.result.stdout && a.result.stderr === b.result.stderr &&
      a.result.truncated === b.result.truncated));
}

/** Called after adapter identity refinement and before merged wire retention. */
export function normalizeRemoteCommand(step: ToolStep): void {
  const prior = step.prior?.remoteCommand;
  if (prior && ['completed', 'failed', 'canceled'].includes(step.prior!.status) &&
    ['pending', 'in_progress'].includes(step.draft.status)) step.draft.status = step.prior!.status;
  if (step.prior && !prior && step.call.rawInput === undefined && step.call.rawOutput === undefined && !step.call.content?.length) return;
  // Omitted requests must not be re-parsed from the compacted wire preview.
  const omitted = step.call.rawInput === undefined && !!prior;
  if (step.draft.execution || step.draft.subagents || step.draft.jobs || step.draft.guardianReview || step.draft.parentId ||
    step.draft.inputPaths.some((path) => /(?:^|\/)\.krypton\/artifacts\//.test(path)) ||
    step.draft.locations.some((path) => /(?:^|\/)\.krypton\/artifacts\//.test(path))) return;
  if (prior?.source === 'mcp' && (!step.draft.mcp || step.draft.mcp.tool !== 'computer_exec' || SERVERS[step.draft.mcp.server] !== true)) return;
  if (prior?.source === 'cli' && (step.draft.mcp || step.merged.title?.trim().startsWith('mcp__'))) return;
  const recognized = omitted ? prior : request(step);
  if (!recognized) return;
  if (omitted && prior.source === 'cli' && step.draft.kind !== 'execute') return;
  const req: Request = omitted ? prior : recognized;
  const computerKey = omitted ? REQUEST_IDS.get(prior) ?? prior.computerId : req.computerId;
  // Oversized identities stay generic; never compare clipped display IDs.
  if (bound(computerKey, 16384) !== computerKey) return;
  const changedRequest = prior && (req.source !== prior.source || bound(req.command, 16384) !== prior.command || (req.cwd === null ? null : bound(req.cwd, 1024)) !== prior.cwd || computerKey !== (REQUEST_IDS.get(prior) ?? prior.computerId));
  const base = changedRequest ? undefined : prior;
  const truncated: Field[] = omitted ? [...prior.displayTruncated.filter((key) => ['computerId', 'cwd', 'command'].includes(key))] : [];
  const keep = (field: Field, text: string, cap: number) => {
    const kept = bound(text, cap);
    if (kept !== text && !truncated.includes(field)) truncated.push(field);
    return kept;
  };
  const out = outputs(step, req.source, base);
  let remoteResult = base?.result ?? null;
  let error = base?.error ?? null;
  let outcomeUnknown = base?.outcomeUnknown ?? false;
  let complete = !out.extra;
  if (out.values.length > 0) {
    const decoded: Result[] = [];
    const diagnostics: string[] = [];
    let unknown = false;
    for (const value of out.values) {
      let text = typeof value === 'string' ? value.trimEnd() : null;
      if (req.source === 'cli' && text?.startsWith(CLI_ERROR)) text = text.slice(CLI_ERROR.length);
      const unknownResult = text?.startsWith(UNKNOWN_RESULT) ?? false;
      const unknownInput = text === UNKNOWN_INPUT;
      const r = result(unknownResult ? text!.slice(UNKNOWN_RESULT.length) : value);
      if (r) {
        // Check unbounded IDs before retaining bounded display values.
        if (r.computerId !== computerKey) return;
        if (!decoded.some((other) => other.exitCode === r.exitCode && other.outcome === r.outcome &&
          other.stdout === r.stdout && other.stderr === r.stderr && other.truncated === r.truncated)) decoded.push(r);
        if (unknownResult) diagnostics.push(text!);
        unknown ||= unknownResult || r.outcome === 'unknown';
      } else {
        if (text === null) {
          try { text = JSON.stringify(value) ?? null; } catch { text = null; }
        }
        if (text !== null && text !== '') {
          diagnostics.push(text);
          unknown ||= unknownResult || unknownInput;
          if (typeof value !== 'string' || text.trimStart().startsWith('{') || text.trimStart().startsWith('[') || unknownResult) complete = false;
        } else complete = false;
      }
    }
    if (decoded.length > 1 || (decoded.length === 1 && diagnostics.length > 0 && !unknown)) complete = false;
    if (decoded.length === 1 && complete) {
      const r = decoded[0];
      remoteResult = Object.freeze({ exitCode: r.exitCode, outcome: r.outcome, stdout: keep('stdout', r.stdout, 16384), stderr: keep('stderr', r.stderr, 16384), truncated: r.truncated });
      error = diagnostics.length ? keep('error', diagnostics.join('\n'), 4096) : null;
      outcomeUnknown = unknown;
    } else if (diagnostics.length && (complete || out.error || unknown)) {
      error = keep('error', diagnostics.join('\n'), 4096);
      outcomeUnknown ||= unknown;
    }
    if (out.error && !error) { error = 'Remote command tool reported an error'; complete = false; }
    if (!complete && diagnostics.length) {
      const text = boundedOutputLines(bound(diagnostics.join('\n'), 4096), 6);
      if (text && !step.draft.sections.some((section) => section.text.includes(text))) {
        step.draft.sections = [...step.draft.sections, { label: 'diagnostic', text }];
      }
    }
  }
  // Retain stream/error truncation markers when this update did not replace them.
  for (const field of base?.displayTruncated ?? []) {
    if ((field === 'stdout' || field === 'stderr') && remoteResult === base?.result || field === 'error' && error === base?.error) {
      if (!truncated.includes(field)) truncated.push(field);
    }
  }
  const payload: RemoteCommandPayload = {
    source: req.source, computerId: keep('computerId', req.computerId, 1024),
    command: keep('command', req.command, 16384), cwd: req.cwd === null ? null : keep('cwd', req.cwd, 1024),
    result: remoteResult, error, outcomeUnknown,
    displayTruncated: Object.freeze((['computerId', 'cwd', 'command', 'stdout', 'stderr', 'error'] as Field[]).filter((field) => truncated.includes(field))),
  };
  step.draft.remoteCommand = prior && equal(prior, payload) ? prior : Object.freeze(payload);
  REQUEST_IDS.set(step.draft.remoteCommand, computerKey);
  if (prior) TERMINAL_CAPTURES.delete(prior);
  if (out.capture && (!complete || (!remoteResult && !error))) {
    TERMINAL_CAPTURES.set(step.draft.remoteCommand, out.capture);
  }
  // Malformed/partial envelopes retain their ordinary diagnostic sections.
  if (complete && (((out.values.length > 0 || out.terminal) && (remoteResult || error)) || (!prior && out.values.length === 0))) step.draft.sections = EMPTY_SECTIONS;
}

const EMPTY_SECTIONS: ToolStep['draft']['sections'] = [];
Object.freeze(EMPTY_SECTIONS);
