// spec 229 — Grok ask_user_question key state. Parsing the wire questions is
// the lane decoder's job (`adapters/generic.ts`, spec 380).
// spec 279 — the same card answers ACP form elicitations (`elicitation.ts`).
// Pure functions so the card can be tested without the harness view.

import type { KeyHint } from '../ui/kbd';

export interface AskUserOption {
  label: string;
  description: string;
  preview?: string;
}

export interface AskUserQuestion {
  question: string;
  options: AskUserOption[];
  multiSelect?: boolean;
  /** Extra context under the subject (multi-line message / field description). */
  detail?: string;
  /** `false` hides `z Other`: the answer must be one of `options`. Default true. */
  allowOther?: boolean;
  /** Free-text field with no options; the card opens with the draft focused. */
  textOnly?: boolean;
  /** Free-text must parse as this kind before Enter commits it. */
  textKind?: 'text' | 'number' | 'integer';
  /** Initial free-text draft (text fields). */
  defaultText?: string;
  /** Initial focused option index. */
  defaultOption?: number;
  /** An empty answer may be committed (Enter on an empty draft). */
  optional?: boolean;
}

/** Which wire protocol the card replies on. */
export type QuestionWire = 'grok' | 'elicitation';

export interface AskUserAnswer {
  question: string;
  selected_labels: string[];
}

// Grok 1.0.5 `AskUserQuestionExtResponse` is internally tagged on `outcome`,
// not serde's default `type`. Sending `type` fails with
// `missing field 'outcome'`.
export type AskUserDecision =
  | { outcome: 'accepted'; answers: AskUserAnswer[]; partial_answers: null }
  | { outcome: 'skip_interview' };

export interface AskUserCardState {
  questionIndex: number;
  optionIndex: number;
  selected: string[][];
  otherDraft: string;
  otherFocused: boolean;
}

export type AskUserKeyAction =
  | { type: 'none' }
  | { type: 'redraw' }
  | { type: 'submit'; decision: AskUserDecision }
  | { type: 'skip' };

/** Wire-neutral human answer; `AcpClient.respondQuestion` maps it per wire. */
export type AskUserReply =
  | { kind: 'accept'; decision: AskUserDecision }
  | { kind: 'decline' }
  | { kind: 'cancel' };

const OPTION_HOTKEYS = ['1', '2', '3', '4', '5', '6', '7', '8', '9', 'a', 'b', 'c', 'd', 'e', 'f'];

export function optionIndexFromKey(key: string): number | null {
  const i = OPTION_HOTKEYS.indexOf(key.toLowerCase());
  return i >= 0 ? i : null;
}

export function optionHotkey(index: number): string {
  return OPTION_HOTKEYS[index] ?? String(index + 1);
}

function questionEntry(
  question: AskUserQuestion | undefined,
): Pick<AskUserCardState, 'optionIndex' | 'otherDraft' | 'otherFocused'> {
  if (question?.textOnly) {
    return { optionIndex: 0, otherDraft: question.defaultText ?? '', otherFocused: true };
  }
  const last = Math.max(0, (question?.options.length ?? 1) - 1);
  const optionIndex = Math.min(Math.max(question?.defaultOption ?? 0, 0), last);
  return { optionIndex, otherDraft: '', otherFocused: false };
}

export function createAskUserCardState(questions: AskUserQuestion[]): AskUserCardState {
  return {
    questionIndex: 0,
    selected: questions.map(() => []),
    ...questionEntry(questions[0]),
  };
}

export function skipInterviewDecision(): AskUserDecision {
  return { outcome: 'skip_interview' };
}

export function acceptedDecision(
  questions: AskUserQuestion[],
  selected: string[][],
): AskUserDecision {
  return {
    outcome: 'accepted',
    answers: questions.map((question, i) => ({
      question: question.question,
      selected_labels: selected[i] ?? [],
    })),
    partial_answers: null,
  };
}

/** Permission modes never auto-answer a question. */
export function shouldAutoAnswerAskUser(): boolean {
  return false;
}

function maxOptionIndex(question: AskUserQuestion): number {
  return question.allowOther === false
    ? Math.max(0, question.options.length - 1)
    : question.options.length;
}

export function isValidTextAnswer(text: string, kind: AskUserQuestion['textKind']): boolean {
  if (kind !== 'number' && kind !== 'integer') return true;
  const value = Number(text);
  if (text.trim() === '' || !Number.isFinite(value)) return false;
  return kind === 'number' || Number.isInteger(value);
}

function setSelected(
  state: AskUserCardState,
  questionIndex: number,
  labels: string[],
): AskUserCardState {
  const selected = state.selected.map((row, i) => (i === questionIndex ? labels : row));
  return { ...state, selected };
}

function toggleLabel(labels: string[], label: string): string[] {
  return labels.includes(label)
    ? labels.filter((item) => item !== label)
    : [...labels, label];
}

function commitCurrent(
  questions: AskUserQuestion[],
  state: AskUserCardState,
  labels: string[],
): { state: AskUserCardState; action: AskUserKeyAction } {
  const next = setSelected(state, state.questionIndex, labels);
  const isEmpty = (i: number): boolean => (next.selected[i] ?? []).length === 0;
  // Linear flow: the next still-unanswered question after this one. h/l can
  // skip around, so already-answered later questions are not revisited, and a
  // required one (`optional === false`, elicitation only) left empty anywhere
  // pulls focus back instead of submitting. Grok leaves `optional` unset.
  let target = questions.findIndex((_, i) => i > state.questionIndex && isEmpty(i));
  if (target < 0) target = questions.findIndex((q, i) => q.optional === false && isEmpty(i));
  if (target >= 0) {
    return {
      state: { ...next, questionIndex: target, ...questionEntry(questions[target]) },
      action: { type: 'redraw' },
    };
  }
  return {
    state: { ...next, otherFocused: false },
    action: { type: 'submit', decision: acceptedDecision(questions, next.selected) },
  };
}

export function applyAskUserKey(
  questions: AskUserQuestion[],
  state: AskUserCardState,
  key: string,
): { state: AskUserCardState; action: AskUserKeyAction } {
  const question = questions[state.questionIndex];
  if (!question) return { state, action: { type: 'none' } };

  if (state.otherFocused) {
    if (key === 'Escape') {
      return { state: { ...state, otherFocused: false }, action: { type: 'redraw' } };
    }
    if (key === 'Enter') {
      const typed = question.textKind === 'text' ? state.otherDraft : state.otherDraft.trim();
      if (!typed.trim()) {
        return question.optional
          ? commitCurrent(questions, state, [])
          : { state, action: { type: 'redraw' } };
      }
      if (!isValidTextAnswer(typed, question.textKind)) return { state, action: { type: 'redraw' } };
      return commitCurrent(questions, state, [typed]);
    }
    if (key === 'Backspace') {
      return {
        state: { ...state, otherDraft: state.otherDraft.slice(0, -1) },
        action: { type: 'redraw' },
      };
    }
    if (key.length === 1 && key !== '\n') {
      return {
        state: { ...state, otherDraft: state.otherDraft + key },
        action: { type: 'redraw' },
      };
    }
    return { state, action: { type: 'none' } };
  }

  if (key === 'x' || key === 'X') return { state, action: { type: 'skip' } };

  if (key === 'z' || key === 'Z') {
    if (question.allowOther === false) return { state, action: { type: 'none' } };
    return {
      state: { ...state, otherFocused: true, optionIndex: maxOptionIndex(question) },
      action: { type: 'redraw' },
    };
  }

  if (key === 'j' || key === 'ArrowDown') {
    return {
      state: { ...state, optionIndex: Math.min(state.optionIndex + 1, maxOptionIndex(question)) },
      action: { type: 'redraw' },
    };
  }
  if (key === 'k' || key === 'ArrowUp') {
    return {
      state: { ...state, optionIndex: Math.max(state.optionIndex - 1, 0) },
      action: { type: 'redraw' },
    };
  }
  if ((key === 'h' || key === 'ArrowLeft') && questions.length > 1) {
    const questionIndex = Math.max(0, state.questionIndex - 1);
    return {
      state: { ...state, questionIndex, ...questionEntry(questions[questionIndex]) },
      action: { type: 'redraw' },
    };
  }
  if ((key === 'l' || key === 'ArrowRight') && questions.length > 1) {
    const questionIndex = Math.min(questions.length - 1, state.questionIndex + 1);
    return {
      state: { ...state, questionIndex, ...questionEntry(questions[questionIndex]) },
      action: { type: 'redraw' },
    };
  }

  if (key === ' ') {
    if (!question.multiSelect) return { state, action: { type: 'none' } };
    const option = question.options[state.optionIndex];
    if (!option) return { state, action: { type: 'none' } };
    return {
      state: setSelected(
        { ...state, optionIndex: state.optionIndex },
        state.questionIndex,
        toggleLabel(state.selected[state.questionIndex] ?? [], option.label),
      ),
      action: { type: 'redraw' },
    };
  }

  const hot = optionIndexFromKey(key);
  if (hot !== null && hot < question.options.length) {
    const label = question.options[hot].label;
    if (question.multiSelect) {
      return {
        state: setSelected(
          { ...state, optionIndex: hot },
          state.questionIndex,
          toggleLabel(state.selected[state.questionIndex] ?? [], label),
        ),
        action: { type: 'redraw' },
      };
    }
    return commitCurrent(questions, { ...state, optionIndex: hot }, [label]);
  }

  if (key === 'Enter') {
    if (state.optionIndex >= question.options.length) {
      return { state: { ...state, otherFocused: true }, action: { type: 'redraw' } };
    }
    const option = question.options[state.optionIndex];
    if (!option) return { state, action: { type: 'none' } };
    if (question.multiSelect) {
      const labels = state.selected[state.questionIndex] ?? [];
      const chosen = labels.length > 0 ? labels : [option.label];
      return commitCurrent(questions, state, chosen);
    }
    return commitCurrent(questions, state, [option.label]);
  }

  if (key === 'Escape') return { state, action: { type: 'none' } };
  return { state, action: { type: 'none' } };
}

export function questionDecisionLabel(decision: QuestionPayload['decision'], labels?: string[]): string {
  if (decision === 'skipped') return 'skipped';
  if (decision === 'failed') return 'failed';
  if (decision === 'accepted') return labels && labels.length > 0 ? labels.join(', ') : 'answered';
  return 'pending';
}

export interface QuestionPayload {
  requestId: number;
  questions: AskUserQuestion[];
  questionIndex: number;
  optionIndex: number;
  selected: string[][];
  otherDraft: string;
  otherFocused: boolean;
  decision: 'pending' | 'accepted' | 'skipped' | 'failed';
  decisionLabel?: string;
  wire: QuestionWire;
}

export function payloadFromCard(
  requestId: number,
  questions: AskUserQuestion[],
  state: AskUserCardState,
  wire: QuestionWire,
  decision: QuestionPayload['decision'] = 'pending',
  decisionLabel?: string,
): QuestionPayload {
  return {
    requestId,
    questions,
    questionIndex: state.questionIndex,
    optionIndex: state.optionIndex,
    selected: state.selected,
    otherDraft: state.otherDraft,
    otherFocused: state.otherFocused,
    decision,
    decisionLabel,
    wire,
  };
}

/** Footer hint for a pending question card, as key caps (spec 369). */
export function questionActionsHint(
  question: AskUserQuestion | undefined,
  wire: QuestionWire,
  otherFocused: boolean,
): readonly KeyHint[] {
  const skipLabel = wire === 'elicitation' ? 'decline' : 'skip';
  const skip: KeyHint = { keys: ['x'], label: skipLabel };
  if (otherFocused) {
    const typing: KeyHint[] = [{ keys: [], label: 'type' }, { keys: ['Enter'], label: 'submit' }];
    // A text-only card parks the draft on Esc; `x` after it skips (a sequence).
    return question?.textOnly
      ? [...typing, { keys: ['Esc'], label: 'park' }, { keys: ['Esc', 'x'], label: skipLabel }]
      : [...typing, { keys: ['Esc'], label: 'back' }];
  }
  if (question?.textOnly) return [{ keys: ['z'], label: 'type' }, skip];
  const pick: KeyHint[] = question?.multiSelect
    ? [{ keys: ['1–9'], label: 'toggle' }, { keys: ['Enter'], label: 'commit' }]
    : [{ keys: ['1–9'], label: 'pick' }, { keys: ['Enter'], label: '' }];
  return question?.allowOther === false ? [...pick, skip] : [...pick, skip, { keys: ['z'], label: 'other' }];
}
