// Krypton — Rails verifier (spec 337): the judge step.
//
// One headless model call through the assist engine. The prompt is fixed; the
// payload carries the selected rules, the failed-check tails, the change and
// the selected glossary, each inside its own share of `maxInputChars`. The
// parser keeps only findings that cite an id that was actually sent and a file
// in the diffstat — the model may not invent rules.

import type { AssistBudget, AssistCall, AssistTaskConfig } from '../assist/types';
import type {
  RailsCheckResult,
  RailsFinding,
  RailsFindingSet,
  RailsGlossaryEntry,
  RailsJudgeContext,
  RailsRule,
  RailsSeverity,
} from './types';

export const RAILS_JUDGE_ID = 'rails-judge';
export const RAILS_MAX_FINDINGS = 20;
export const RAILS_NOTE_MAX = 240;

const CHECK_TAIL_MAX = 2_000;
const GLOSSARY_MAX = 4_000;
const SEVERITIES: readonly RailsSeverity[] = ['violation', 'suspect'];

const PREAMBLE = 'Review this working-tree change against the rules below.\n\n';
const RULES_HEADER = '## Rules\n';
const CHECKS_HEADER = '## Failed checks\n';
const DIFFSTAT_HEADER = '## Changed files\n';
const DIFF_HEADER = '## Diff\n';
const GLOSSARY_HEADER = '## Glossary\n';
const DIFF_TRUNCATED = '\n…[diff truncated]\n';

const SYSTEM_PROMPT = [
  'You are an architecture-rules judge for a code change in a software project.',
  'The user message lists the project rules that apply to this change (each with an id in square brackets),',
  'the tails of any checks that failed, the changed files, the diff, and glossary entries (also with ids).',
  'Report only places where the change breaks one of the listed rules or misuses a listed glossary term.',
  'Cite ONLY a rule id or glossary id given in the message, exactly as written. Never invent or guess an id.',
  'Cite ONLY files listed under "Changed files".',
  'severity is "violation" when the change clearly breaks the cited rule, "suspect" when it may break it.',
  'line is the 1-based line number in the new file when you know it; omit it otherwise.',
  'note is 1 to 240 characters of natural Thai explaining the problem; keep technical terms, identifiers and',
  'file paths in English.',
  'Do not report style nits, naming taste, formatting, or anything no listed rule covers.',
  'Report at most 20 findings, most serious first.',
  'Reply with ONE JSON object and nothing else, no prose and no code fence:',
  '{"findings":[{"rule":"<id>","severity":"violation","file":"src/x.ts","line":42,"note":"…"}]}',
  'When nothing breaks a listed rule, reply {"findings":[]}.',
].join(' ');

/** What `judgePayload` builds. */
export interface RailsJudgePayload {
  readonly text: string;
  readonly rulesKept: number;
  /** Rule and glossary ids present in `text`: the only ids a finding may cite. */
  readonly sentIds: ReadonlySet<string>;
}

function ruleBlock(rule: RailsRule): string {
  let block = `[${rule.id}] ${rule.text}\n`;
  if (rule.appliesTo.length > 0) block += `  applies to: ${rule.appliesTo.join(', ')}\n`;
  if (rule.check !== null) block += `  enforced by check:${rule.check}\n`;
  return block;
}

function glossaryBlock(entry: RailsGlossaryEntry): string {
  const avoid = entry.avoid.length > 0 ? ` Avoid: ${entry.avoid.join(', ')}.` : '';
  return `[${entry.id}] ${entry.term}: ${entry.definition}${avoid}\n`;
}

/** The last `max` chars of `text`, marked with `…` when cut. */
function tail(text: string, max: number): string {
  if (text.length <= max) return text;
  if (max <= 1) return text.slice(text.length - max);
  return `…${text.slice(text.length - (max - 1))}`;
}

/** Whole entries in order while they fit `cap`, header included. */
function glossarySection(entries: readonly RailsGlossaryEntry[], cap: number): { text: string; ids: string[] } {
  let body = '';
  const ids: string[] = [];
  for (const entry of entries) {
    const block = glossaryBlock(entry);
    if (GLOSSARY_HEADER.length + body.length + block.length + 1 > cap) break;
    body += block;
    ids.push(entry.id);
  }
  return ids.length === 0 ? { text: '', ids } : { text: `${GLOSSARY_HEADER}${body}\n`, ids };
}

function checkHead(check: RailsCheckResult): string {
  const exit = check.exitCode === null ? '' : ` (exit ${check.exitCode})`;
  return `### ${check.name}: ${check.outcome}${exit}\n`;
}

/** Each tail ≤ `CHECK_TAIL_MAX`; the section as a whole ≤ `cap`. */
function checksSection(checks: readonly RailsCheckResult[], cap: number): string {
  if (checks.length === 0) return '';
  let body = '';
  for (const check of checks) {
    const head = checkHead(check);
    const room = cap - CHECKS_HEADER.length - body.length - head.length - 2;
    if (room <= 0) break;
    body += `${head}${tail(check.outputTail.trimEnd(), Math.min(CHECK_TAIL_MAX, room))}\n`;
  }
  return body === '' ? '' : `${CHECKS_HEADER}${body}\n`;
}

function diffstatSection(ctx: RailsJudgeContext, cap: number): string {
  if (ctx.diffstat.length === 0) return '';
  const rows = ctx.diffstat.map((row) => `${row.status} +${row.added} -${row.removed} ${row.path}\n`);
  let body = '';
  for (let i = 0; i < rows.length; i += 1) {
    const more = rows.length - i - 1;
    const marker = more > 0 ? `… ${more} more files\n`.length : 0;
    if (DIFFSTAT_HEADER.length + body.length + rows[i].length + marker + 1 > cap) {
      body += `… ${rows.length - i} more files\n`;
      break;
    }
    body += rows[i];
  }
  return `${DIFFSTAT_HEADER}${body}\n`;
}

function diffBody(ctx: RailsJudgeContext): string {
  let body = ctx.diff.trimEnd();
  for (const file of ctx.untracked) {
    body += `${body === '' ? '' : '\n'}### untracked ${file.path}\n${file.head.trimEnd()}`;
  }
  return body;
}

function diffSection(body: string, room: number): string {
  if (body === '') return '';
  const whole = `${DIFF_HEADER}${body}\n\n`;
  if (whole.length <= room) return whole;
  const keep = room - DIFF_HEADER.length - DIFF_TRUNCATED.length - 1;
  if (keep <= 0) return '';
  return `${DIFF_HEADER}${body.slice(0, keep)}${DIFF_TRUNCATED}\n`;
}

function rulesSection(rules: readonly RailsRule[], room: number): { text: string; kept: RailsRule[] } {
  if (rules.length === 0) return { text: '', kept: [] };
  const blocks = rules.map(ruleBlock);
  const whole = `${RULES_HEADER}${blocks.join('')}\n`;
  if (whole.length <= room) return { text: whole, kept: [...rules] };
  const markerFor = (k: number): string => `rules truncated (${k} of ${rules.length})\n`;
  const reserve = markerFor(rules.length).length + 1;
  let body = '';
  const kept: RailsRule[] = [];
  for (let i = 0; i < blocks.length; i += 1) {
    if (RULES_HEADER.length + body.length + blocks[i].length + reserve > room) break;
    body += blocks[i];
    kept.push(rules[i]);
  }
  const text = `${RULES_HEADER}${body}${markerFor(kept.length)}\n`;
  return text.length <= room ? { text, kept } : { text: '', kept: [] };
}

/**
 * The judge's user message. `rulesKept < ctx.rules.length` means rules were
 * truncated; `sentIds` (kept rule ids + glossary ids that fit) is the only set
 * a finding may cite — `railsJudge.parse` validates against it.
 */
export function judgePayload(ctx: RailsJudgeContext, budget: AssistBudget): RailsJudgePayload {
  const total = Math.max(0, budget.maxInputChars);
  const eighth = Math.floor(total / 8);
  const quarter = Math.floor(total / 4);

  const glossary = glossarySection(ctx.glossary, Math.min(GLOSSARY_MAX, eighth));
  const checks = checksSection(ctx.failedChecks, quarter);
  const diffstat = diffstatSection(ctx, eighth);
  const body = diffBody(ctx);
  // The diff keeps at least this much: rules never squeeze the change out.
  const diffFloor = body === '' ? 0 : Math.min(DIFF_HEADER.length + body.length + 2, quarter);

  const fixed = PREAMBLE.length + glossary.text.length + checks.length + diffstat.length;
  const rules = rulesSection(ctx.rules, total - fixed - diffFloor);
  const diff = diffSection(body, total - fixed - rules.text.length);

  let text = `${PREAMBLE}${rules.text}${checks}${diffstat}${diff}${glossary.text}`.trimEnd();
  let ids = [...rules.kept.map((rule) => rule.id), ...glossary.ids];
  if (text.length > total) {
    // Backstop cut: only ids whose block survived count as sent.
    text = text.slice(0, total);
    ids = ids.filter((id) => text.includes(`[${id}]`));
  }
  return { text, rulesKept: rules.kept.length, sentIds: new Set(ids) };
}

function jsonBody(raw: string): string | null {
  const open = raw.indexOf('{');
  const close = raw.lastIndexOf('}');
  if (open === -1 || close <= open) return null;
  return raw.slice(open, close + 1);
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function isSeverity(value: unknown): value is RailsSeverity {
  return typeof value === 'string' && (SEVERITIES as readonly string[]).includes(value);
}

function readFinding(
  value: unknown,
  sentIds: ReadonlySet<string>,
  files: ReadonlySet<string>,
): RailsFinding | null {
  const row = asRecord(value);
  if (!row) return null;
  const { rule, severity, file, line } = row;
  if (typeof rule !== 'string' || !sentIds.has(rule)) return null;
  if (!isSeverity(severity)) return null;
  if (typeof file !== 'string' || !files.has(file)) return null;
  let lineNo: number | null = null;
  if (line !== undefined && line !== null) {
    if (typeof line !== 'number' || !Number.isInteger(line) || line < 1) return null;
    lineNo = line;
  }
  if (typeof row.note !== 'string') return null;
  const note = row.note.replace(/\s+/g, ' ').trim();
  if (note.length < 1 || note.length > RAILS_NOTE_MAX) return null;
  return { rule, severity, file, line: lineNo, note };
}

/** Strict parse (spec 337 §Judge contract). `null` ⇒ the engine counts `invalid`. */
export function parseJudgeReply(raw: string, ctx: RailsJudgeContext, budget: AssistBudget): RailsFindingSet | null {
  const body = jsonBody(raw);
  if (body === null) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return null;
  }
  const entries = asRecord(parsed)?.findings;
  if (!Array.isArray(entries)) return null;
  const { sentIds } = judgePayload(ctx, budget);
  const files = new Set(ctx.diffstat.map((row) => row.path));
  const findings: RailsFinding[] = [];
  let dropped = 0;
  for (const entry of entries) {
    const finding = readFinding(entry, sentIds, files);
    if (finding === null) dropped += 1;
    else if (findings.length < RAILS_MAX_FINDINGS) findings.push(finding);
  }
  return { findings, dropped };
}

export const railsJudge: AssistCall<RailsFindingSet, RailsJudgeContext> = {
  id: RAILS_JUDGE_ID,
  system(): string {
    return SYSTEM_PROMPT;
  },
  payload(ctx: RailsJudgeContext, budget: AssistBudget): string {
    return judgePayload(ctx, budget).text;
  },
  parse(raw: string, cfg: AssistTaskConfig, ctx: RailsJudgeContext): RailsFindingSet | null {
    // The engine built the payload from the same budget, so the ids match.
    return parseJudgeReply(raw, ctx, cfg);
  },
};
