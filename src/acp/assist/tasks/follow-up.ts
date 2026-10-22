// Krypton — harness assist sidecar (spec 323): follow-up actions.
//
// Reads the reply that ended the turn and offers up to three things the human
// can run or open next — `make install`, `npm test`, `http://localhost:5173`.
// They paint as buttons under that reply (`FollowUpRail`) and nothing runs
// until the human clicks one or types its `f` hint label.
//
// The model never writes a command. `followUpCandidates` pulls every shell
// fence, inline code span and http(s) URL out of the reply's markdown; the
// model only picks candidate numbers and labels them, and `parse` copies the
// target from the candidate. A reply with no candidate makes no call.

import type { HarnessTranscriptItem } from '../../harness-view-types';
import type {
  AssistBudget,
  AssistContext,
  AssistTaskConfig,
  FollowUpAction,
  TranscriptAssistTask,
} from '../types';

const MAX_ACTIONS = 3;
const MAX_CANDIDATES = 20;
const LABEL_MAX = 40;
const FENCE_MAX_LINES = 6;
const FENCE_MAX_CHARS = 400;
const SPAN_MIN = 2;
const SPAN_MAX = 200;
/** The candidate list's share of `max_input_chars`; the oldest drop first. */
const CANDIDATE_SHARE = 0.35;
/** Tail-kept: the next steps live at the end of a reply. */
const REPLY_SHARE = 0.55;
const TRUNCATION_MARK = '…[truncated] ';

/** Info strings whose fence is a command to run. Empty = an unlabelled fence. */
const SHELL_INFO = new Set(['', 'sh', 'bash', 'zsh', 'fish', 'shell', 'console', 'terminal', 'shellsession']);
const FENCE_OPEN = /^ {0,3}(`{3,}|~{3,})\s*([^\s`]*)/;
const FENCE_CLOSE = /^ {0,3}(`{3,}|~{3,})\s*$/;
/** A one-line code span, or a bare http(s) URL — in order of appearance. */
const PROSE_TOKEN = /`([^`\n]+)`|https?:\/\/[^\s<>()`"']+/gi;
const URL_ONLY = /^https?:\/\/\S+$/i;
const PROMPT_LINE = /^\s*[$%] /;

export interface FollowUpCandidate {
  readonly kind: 'run' | 'open';
  readonly target: string;
}

/** The reply the actions belong to: the turn's last non-empty assistant item. */
export function followUpReply(ctx: AssistContext): HarnessTranscriptItem | null {
  for (let i = ctx.turn.length - 1; i >= 0; i -= 1) {
    const item = ctx.turn[i];
    if (item.kind === 'assistant' && item.text.trim() !== '') return item;
  }
  return null;
}

/** How many actions this run may return. */
export function actionCount(cfg: AssistTaskConfig): number {
  const raw = cfg.options.count;
  const n = typeof raw === 'number' ? Math.trunc(raw) : Number.NaN;
  if (!Number.isFinite(n)) return MAX_ACTIONS;
  return Math.min(MAX_ACTIONS, Math.max(1, n));
}

/** A shell fence's command: its `$ `/`% ` lines when it has any, else every line. */
function fenceCommand(body: readonly string[]): string | null {
  const prompted = body.filter((line) => PROMPT_LINE.test(line));
  const kept = prompted.length > 0 ? prompted.map((line) => line.replace(PROMPT_LINE, '')) : body;
  const command = kept.map((line) => line.replace(/\s+$/, '')).join('\n').trim();
  if (command === '' || command.length > FENCE_MAX_CHARS) return null;
  if (command.split('\n').length > FENCE_MAX_LINES) return null;
  return command;
}

function scanProse(text: string, found: FollowUpCandidate[]): void {
  for (const match of text.matchAll(PROSE_TOKEN)) {
    const span = match[1];
    if (span === undefined) {
      const url = match[0].replace(/[.,;:!?\]]+$/, '');
      if (URL_ONLY.test(url)) found.push({ kind: 'open', target: url });
      continue;
    }
    const target = span.trim();
    if (target.length < SPAN_MIN || target.length > SPAN_MAX) continue;
    found.push({ kind: URL_ONLY.test(target) ? 'open' : 'run', target });
  }
}

/**
 * Every candidate in `text` (raw markdown), in order of last appearance, the
 * newest 20 kept. Pure: the payload and the parse both call it, so the numbers
 * the model sees are the numbers `parse` resolves.
 */
export function followUpCandidates(text: string): FollowUpCandidate[] {
  const found: FollowUpCandidate[] = [];
  const lines = text.split('\n');
  let prose: string[] = [];
  for (let i = 0; i < lines.length; i += 1) {
    const open = FENCE_OPEN.exec(lines[i]);
    if (!open) {
      prose.push(lines[i]);
      continue;
    }
    scanProse(prose.join('\n'), found);
    prose = [];
    const fence = open[1];
    const body: string[] = [];
    let j = i + 1;
    for (; j < lines.length; j += 1) {
      const close = FENCE_CLOSE.exec(lines[j]);
      if (close && close[1][0] === fence[0] && close[1].length >= fence.length) break;
      body.push(lines[j]);
    }
    i = j;
    // A non-shell fence is code, not instructions: nothing inside it counts.
    if (!SHELL_INFO.has(open[2].toLowerCase())) continue;
    const command = fenceCommand(body);
    if (command !== null) found.push({ kind: 'run', target: command });
  }
  scanProse(prose.join('\n'), found);

  const seen = new Set<string>();
  const newestFirst: FollowUpCandidate[] = [];
  for (let i = found.length - 1; i >= 0 && newestFirst.length < MAX_CANDIDATES; i -= 1) {
    const key = `${found[i].kind}\u0000${found[i].target}`;
    if (seen.has(key)) continue;
    seen.add(key);
    newestFirst.push(found[i]);
  }
  return newestFirst.reverse();
}

function candidateLine(n: number, candidate: FollowUpCandidate): string {
  return `${n}. ${candidate.kind}: ${candidate.target.replace(/\n/g, '\n   ')}`;
}

/** The candidates this run offers the model: the newest that fit their share of the budget. */
function offeredCandidates(ctx: AssistContext, maxInputChars: number): FollowUpCandidate[] {
  const reply = followUpReply(ctx);
  if (!reply) return [];
  const all = followUpCandidates(reply.text);
  const cap = Math.floor(maxInputChars * CANDIDATE_SHARE);
  let used = 0;
  let first = all.length;
  while (first > 0) {
    const cost = candidateLine(MAX_CANDIDATES, all[first - 1]).length + 1;
    if (used + cost > cap) break;
    used += cost;
    first -= 1;
  }
  return all.slice(first);
}

function basename(dir: string): string {
  const parts = dir.split(/[\\/]/).filter((p) => p !== '');
  return parts.length > 0 ? parts[parts.length - 1] : dir;
}

function jsonBody(raw: string): string | null {
  let text = raw.trim();
  if (text.startsWith('```')) {
    const firstBreak = text.indexOf('\n');
    text = firstBreak === -1 ? '' : text.slice(firstBreak + 1);
    const fenceEnd = text.lastIndexOf('```');
    if (fenceEnd !== -1) text = text.slice(0, fenceEnd);
  }
  const open = text.indexOf('{');
  const close = text.lastIndexOf('}');
  if (open === -1 || close <= open) return null;
  return text.slice(open, close + 1);
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

/** `2` or `"2"` — models quote numbers often enough to accept it. */
function candidateId(value: unknown): number | null {
  const n = typeof value === 'string' && /^\d+$/.test(value.trim()) ? Number(value.trim()) : value;
  return typeof n === 'number' && Number.isInteger(n) ? n : null;
}

/**
 * Models overshoot the 40-character label limit often enough (observed with
 * haiku: 41) that dropping the entry would lose the action the reply cared
 * about most. The label is display text, so it is cut at a word instead.
 */
function shortLabel(raw: string): string {
  const label = raw.trim().replace(/\s+/g, ' ');
  if (label.length <= LABEL_MAX) return label;
  const cut = label.slice(0, LABEL_MAX - 1);
  const space = cut.lastIndexOf(' ');
  return `${(space >= LABEL_MAX / 2 ? cut.slice(0, space) : cut).trimEnd()}…`;
}

export const followUp: TranscriptAssistTask = {
  id: 'follow-up',
  summary: 'offer to run or open what the reply tells you to',
  surface: 'transcript',
  onTurnEnd: true,
  defaults: { mode: 'off', options: { count: MAX_ACTIONS } },

  /** No command and no URL in the reply ⇒ nothing to pick, so no call. */
  eligible(ctx: AssistContext, cfg: AssistTaskConfig): boolean {
    return offeredCandidates(ctx, cfg.maxInputChars).length > 0;
  },

  system(cfg: AssistTaskConfig): string {
    const n = actionCount(cfg);
    return 'You read the final reply of a coding agent and a numbered list of candidates copied from it. '
      + 'Pick the candidates the human should run or open next. '
      + 'Reply with JSON only: {"actions":[{"id":N,"label":"…"}]}. '
      + `At most ${n} entries, most useful first. `
      + 'Pick a candidate only if the reply tells the human to run or open it, '
      + 'or if it installs, builds, tests, starts or shows what the turn just made. '
      + 'Never pick a file path, a symbol, an example, a command the reply says already ran, '
      + 'or a command the reply warns against. '
      + `label is at most ${LABEL_MAX} characters, lower case, no trailing period, and says what the action does. `
      + 'If nothing qualifies, reply {"actions":[]}. No prose outside the JSON.';
  },

  /** Candidates first: the engine's head-slice backstop can then only cut reply text. */
  payload(ctx: AssistContext, budget: AssistBudget): string {
    const lines: string[] = [];
    if (ctx.projectDir) lines.push(`project: ${basename(ctx.projectDir)}`);
    const model = ctx.modelName ? ` · ${ctx.modelName}` : '';
    lines.push(`lane: ${ctx.laneName} (${ctx.backendId}${model})`);
    lines.push('--- candidates ---');
    offeredCandidates(ctx, budget.maxInputChars).forEach((candidate, i) => {
      lines.push(candidateLine(i + 1, candidate));
    });
    lines.push('--- agent replied ---');
    const reply = followUpReply(ctx)?.text.trim() ?? '';
    const limit = Math.floor(budget.maxInputChars * REPLY_SHARE);
    lines.push(reply.length <= limit ? reply : TRUNCATION_MARK + reply.slice(reply.length - limit));
    return lines.join('\n');
  },

  parse(raw: string, cfg: AssistTaskConfig, ctx: AssistContext): FollowUpAction[] | null {
    const body = jsonBody(raw);
    if (body === null) return null;
    let parsed: unknown;
    try {
      parsed = JSON.parse(body);
    } catch {
      return null;
    }
    const entries = asRecord(parsed)?.actions;
    if (!Array.isArray(entries)) return null;
    // An empty list is an answer: the reply asked the human to do nothing.
    if (entries.length === 0) return [];

    const candidates = offeredCandidates(ctx, cfg.maxInputChars);
    const limit = actionCount(cfg);
    const picked = new Set<number>();
    const actions: FollowUpAction[] = [];
    for (const entry of entries) {
      if (actions.length >= limit) break;
      const row = asRecord(entry);
      if (!row || typeof row.label !== 'string') continue;
      const id = candidateId(row.id);
      if (id === null || id < 1 || id > candidates.length || picked.has(id)) continue;
      const label = shortLabel(row.label);
      if (label === '') continue;
      picked.add(id);
      const candidate = candidates[id - 1];
      actions.push({ followUpKind: candidate.kind, label, target: candidate.target, hintLabel: null });
    }
    return actions.length > 0 ? actions : null;
  },
};
