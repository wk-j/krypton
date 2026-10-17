// Krypton — harness assist sidecar (spec 306): the one task v1 ships.
//
// Reads the turn that just ended and proposes up to three next prompts. The
// engine supplies the transport, the deadline and the breaker; everything
// feature-specific — prompt, payload shape, parser — lives here.

import type {
  AssistAction,
  AssistBudget,
  AssistContext,
  AssistTaskConfig,
  RegisteredAssistTask,
} from '../types';
import type { HarnessTranscriptItem } from '../../harness-view-types';

const MAX_SUGGESTIONS = 3;
const MAX_PLAN_ENTRIES = 5;
const LABEL_MAX = 48;
const PROMPT_MIN = 8;
const PROMPT_MAX = 240;
/** Head-kept: intent lives at the start of a prompt. */
const USER_SHARE = 0.25;
/** Tail-kept: conclusions live at the end of a reply. */
const ASSISTANT_SHARE = 0.6;
const TRUNCATION_MARK = ' …[truncated]';

/** How many suggestions this run may return. */
export function suggestionCount(cfg: AssistTaskConfig): number {
  const raw = cfg.options.count;
  const n = typeof raw === 'number' ? Math.trunc(raw) : Number.NaN;
  if (!Number.isFinite(n)) return MAX_SUGGESTIONS;
  return Math.min(MAX_SUGGESTIONS, Math.max(1, n));
}

function headTruncate(text: string, limit: number): string {
  return text.length <= limit ? text : text.slice(0, limit) + TRUNCATION_MARK;
}

function tailTruncate(text: string, limit: number): string {
  return text.length <= limit ? text : text.slice(text.length - limit) + TRUNCATION_MARK;
}

function lastOfKind(turn: readonly HarnessTranscriptItem[], kind: HarnessTranscriptItem['kind']): string {
  for (let i = turn.length - 1; i >= 0; i--) {
    const item = turn[i];
    if (item.kind === kind && item.text.trim() !== '') return item.text.trim();
  }
  return '';
}

/** Tool names with counts — never arguments, never output. */
function toolSummary(turn: readonly HarnessTranscriptItem[]): string {
  const counts = new Map<string, number>();
  for (const item of turn) {
    if (item.kind !== 'tool') continue;
    const name = item.tool?.kind?.trim() || 'tool';
    counts.set(name, (counts.get(name) ?? 0) + 1);
  }
  return [...counts].map(([name, n]) => `${name}×${n}`).join(', ');
}

function basename(dir: string): string {
  const parts = dir.split(/[\\/]/).filter((p) => p !== '');
  return parts.length > 0 ? parts[parts.length - 1] : dir;
}

/** The outermost `{…}`, with a leading ```json fence stripped. */
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

export const nextPrompt: RegisteredAssistTask = {
  id: 'next-prompt',
  summary: 'suggest the next prompt',
  surface: 'strip',
  onTurnEnd: true,
  defaults: { mode: 'off', options: { count: MAX_SUGGESTIONS } },

  /** A queued prompt means the human already knows what comes next. */
  eligible(ctx: AssistContext): boolean {
    return ctx.queuedPrompts === 0;
  },

  system(cfg: AssistTaskConfig): string {
    const n = suggestionCount(cfg);
    return 'You read the last turn of a coding agent and propose what the human should ask next. '
      + 'Reply with JSON only: {"suggestions":[{"label":"…","prompt":"…"}]}. '
      + `At most ${n} entries, ordered by usefulness. `
      + 'label is at most 48 characters, lower case, no trailing period. '
      + 'prompt is one or two sentences the human could send verbatim, phrased as a direction or a question. '
      + 'Propose concrete next work — verify, extend, fix, or ask about something the turn left open. '
      + 'Never propose work the turn already finished. No prose outside the JSON.';
  },

  payload(ctx: AssistContext, budget: AssistBudget): string {
    const lines: string[] = [];
    if (ctx.projectDir) lines.push(`project: ${basename(ctx.projectDir)}`);
    const model = ctx.modelName ? ` · ${ctx.modelName}` : '';
    lines.push(`lane: ${ctx.laneName} (${ctx.backendId}${model})`);
    lines.push(`stop: ${ctx.stopReason}`);

    const tools = toolSummary(ctx.turn);
    if (tools) lines.push(`tools: ${tools}`);

    const plan = (ctx.plan ?? [])
      .slice(0, MAX_PLAN_ENTRIES)
      .map((entry) => `[${entry.status}] ${entry.content}`)
      .join(' / ');
    if (plan) lines.push(`plan: ${plan}`);

    lines.push('--- user asked ---');
    lines.push(headTruncate(lastOfKind(ctx.turn, 'user'), Math.floor(budget.maxInputChars * USER_SHARE)));
    lines.push('--- agent replied ---');
    lines.push(tailTruncate(lastOfKind(ctx.turn, 'assistant'), Math.floor(budget.maxInputChars * ASSISTANT_SHARE)));

    return lines.join('\n');
  },

  parse(raw: string, cfg: AssistTaskConfig): readonly AssistAction[] | null {
    const body = jsonBody(raw);
    if (body === null) return null;

    let parsed: unknown;
    try {
      parsed = JSON.parse(body);
    } catch {
      return null;
    }

    const suggestions = asRecord(parsed)?.suggestions;
    if (!Array.isArray(suggestions)) return null;

    const actions: AssistAction[] = [];
    const limit = suggestionCount(cfg);
    for (const entry of suggestions) {
      if (actions.length >= limit) break;
      const row = asRecord(entry);
      if (!row || typeof row.label !== 'string' || typeof row.prompt !== 'string') continue;
      const label = row.label.trim().replace(/\s+/g, ' ');
      if (label === '' || label.length > LABEL_MAX) continue;
      const prompt = row.prompt.trim();
      if (prompt.length < PROMPT_MIN) continue;
      actions.push({ label, prompt: prompt.slice(0, PROMPT_MAX) });
    }

    return actions.length > 0 ? actions : null;
  },
};
