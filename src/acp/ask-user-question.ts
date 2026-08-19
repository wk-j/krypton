// spec 229 — Grok ask_user_question parse + key state.
// Pure functions so the card can be tested without the harness view.

export interface AskUserOption {
  label: string;
  description: string;
  preview?: string;
}

export interface AskUserQuestion {
  question: string;
  options: AskUserOption[];
  multiSelect?: boolean;
}

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

const OPTION_HOTKEYS = ['1', '2', '3', '4', '5', '6', '7', '8', '9', 'a', 'b', 'c', 'd', 'e', 'f'];

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

export function parseAskUserQuestions(input: unknown): AskUserQuestion[] {
  const root = asRecord(input);
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

export function optionIndexFromKey(key: string): number | null {
  const i = OPTION_HOTKEYS.indexOf(key.toLowerCase());
  return i >= 0 ? i : null;
}

export function optionHotkey(index: number): string {
  return OPTION_HOTKEYS[index] ?? String(index + 1);
}

export function createAskUserCardState(questions: AskUserQuestion[]): AskUserCardState {
  return {
    questionIndex: 0,
    optionIndex: 0,
    selected: questions.map(() => []),
    otherDraft: '',
    otherFocused: false,
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
  return question.options.length;
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
  if (state.questionIndex + 1 < questions.length) {
    return {
      state: {
        ...next,
        questionIndex: state.questionIndex + 1,
        optionIndex: 0,
        otherDraft: '',
        otherFocused: false,
      },
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
      const typed = state.otherDraft.trim();
      if (!typed) return { state, action: { type: 'redraw' } };
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
      state: {
        ...state,
        questionIndex,
        optionIndex: 0,
        otherDraft: '',
        otherFocused: false,
      },
      action: { type: 'redraw' },
    };
  }
  if ((key === 'l' || key === 'ArrowRight') && questions.length > 1) {
    const questionIndex = Math.min(questions.length - 1, state.questionIndex + 1);
    return {
      state: {
        ...state,
        questionIndex,
        optionIndex: 0,
        otherDraft: '',
        otherFocused: false,
      },
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
}

export function payloadFromCard(
  requestId: number,
  questions: AskUserQuestion[],
  state: AskUserCardState,
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
  };
}
