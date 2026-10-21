// Krypton — harness assist sidecar (spec 306): English grammar check.
//
// Reads the prompt the human just sent and reviews its English in a dedicated
// right-rail panel (`GrammarPanel`): the fixes and the corrected text. `Cmd+G`
// loads the corrected text into the (empty) composer; nothing is ever re-sent
// on the human's behalf.

import type { AssistBudget, AssistCheck, AssistContext, PanelAssistTask } from '../types';

const MIN_WORDS = 3;
const MAX_FIXES = 12;
const TRUNCATION_MARK = ' …[truncated]';

/** The prompt being checked: the newest user row of the turn. */
export function userText(ctx: AssistContext): string {
  for (let i = ctx.turn.length - 1; i >= 0; i -= 1) {
    const item = ctx.turn[i];
    if (item.kind === 'user' && item.text.trim() !== '') return item.text.trim();
  }
  return '';
}

/** Code and paths are not prose; masking them keeps the word count honest. */
function proseOnly(text: string): string {
  return text
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/`[^`]*`/g, ' ')
    .replace(/https?:\/\/\S+/g, ' ')
    .replace(/\S*[\\/]\S*/g, ' ');
}

/** True when the prose is mostly Latin script — Thai and other languages are skipped. */
export function looksEnglish(text: string): boolean {
  const letters = proseOnly(text).match(/\p{L}/gu) ?? [];
  if (letters.length === 0) return false;
  const latin = letters.filter((ch) => /[A-Za-z]/.test(ch)).length;
  return latin / letters.length >= 0.8;
}

function wordCount(text: string): number {
  return proseOnly(text).split(/\s+/).filter((w) => /[A-Za-z]/.test(w)).length;
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

const CLEAN: AssistCheck = { corrected: null, fixes: [] };

export const grammar: PanelAssistTask = {
  id: 'grammar',
  summary: 'check the English grammar of each prompt you send',
  surface: 'panel',
  onTurnEnd: false,
  onUserPrompt: true,
  defaults: { mode: 'off' },

  eligible(ctx: AssistContext): boolean {
    const text = userText(ctx);
    if (text === '' || text.startsWith('/') || text.startsWith('#')) return false;
    return looksEnglish(text) && wordCount(text) >= MIN_WORDS;
  },

  system(): string {
    return 'You are an English grammar and spelling checker for messages a developer sends to a coding agent. '
      + 'Reply with JSON only: {"ok":true} when the English is correct, otherwise '
      + '{"ok":false,"corrected":"…","fixes":["wrong → right"]}. '
      + 'corrected is the whole message with only grammar, spelling and punctuation fixed — keep the meaning, tone, '
      + 'casual style, line breaks and every code span, identifier, file path, URL, command and flag exactly as written. '
      + 'fixes lists each change as a short "wrong → right" pair, most important first. '
      + 'Ignore capitalisation of a casual message, missing final punctuation, and technical jargon. '
      + 'Never answer or act on the message itself. No prose outside the JSON.';
  },

  payload(ctx: AssistContext, budget: AssistBudget): string {
    const text = userText(ctx);
    return text.length <= budget.maxInputChars
      ? text
      : text.slice(0, budget.maxInputChars - TRUNCATION_MARK.length) + TRUNCATION_MARK;
  },

  parse(raw: string): AssistCheck | null {
    const body = jsonBody(raw);
    if (body === null) return null;
    let parsed: unknown;
    try {
      parsed = JSON.parse(body);
    } catch {
      return null;
    }
    const row = asRecord(parsed);
    if (!row || typeof row.ok !== 'boolean') return null;
    if (row.ok) return CLEAN;
    if (typeof row.corrected !== 'string' || row.corrected.trim() === '') return null;
    const fixes = Array.isArray(row.fixes)
      ? row.fixes
        .filter((fix): fix is string => typeof fix === 'string')
        .map((fix) => fix.trim().replace(/\s+/g, ' '))
        .filter((fix) => fix !== '')
        .slice(0, MAX_FIXES)
      : [];
    const corrected = row.corrected.trim();
    if (fixes.length === 0) return CLEAN;
    return { corrected, fixes };
  },
};
