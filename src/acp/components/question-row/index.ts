// Spec 302 §3.7 — `QuestionRow`.
//
// The inline ask-user card (spec 229/279). Today every keystroke rebuilds the
// whole row — head, detail, every option `<div>` and the actions line — because
// `transcriptRenderSignature` folds the cursor into a string. Here each option
// is a keyed child: moving the cursor repaints exactly the two rows whose
// `--focus` changed and touches nothing else, which is what makes the list's
// own `scrollTop` survive (spec 279's `position: relative` trick stops being a
// workaround for a wipe).
//
// `QuestionState` is mutated in place, so `bodyDeps()` spells out the cursor
// fields rather than the payload reference.
//
// The cursor arithmetic itself is NOT duplicated here: `clampCursor` from
// `list-picker` is the one copy. `questionOptionRowCount()` is the only part
// that is question-specific — the `z Other` row is focusable but is not in
// `question.options` — and it is exported so the handler at
// `ask-user-question.ts:259-268` can drop its own `Math.min`/`Math.max` pair.
//
// Ported from `harness-transcript-render.ts:1020-1137` (`renderQuestionBody`)
// plus its dispatcher branch at `:355-357`. Markup is unchanged.

import { Component } from '../../../ui/component';
import { classes, el } from '../../../ui/dom';
import { disposeList, reconcile, syncOrder } from '../../../ui/list';
import {
  optionHotkey,
  questionActionsHint,
  type AskUserQuestion,
  type QuestionPayload,
} from '../../ask-user-question';
import { clampCursor } from '../list-picker';
import { TranscriptRow, type RowProps } from '../transcript-row';
import type { ComponentDef } from '../types';
import './question-row.css';

/**
 * How many rows the option cursor may land on.
 *
 * `z Other` is a focusable row that is not an entry of `question.options`, and
 * a question with no options still has that one row — which is why this is not
 * simply `options.length`. `maxOptionIndex()` in `ask-user-question.ts` is this
 * minus one.
 */
export function questionOptionRowCount(question: AskUserQuestion): number {
  if (question.allowOther === false) return Math.max(1, question.options.length);
  return question.options.length + 1;
}

/**
 * The replacement for the `j` / `k` arms of `applyAskUserKey`
 * (`ask-user-question.ts:259-268`), which carry their own
 * `Math.min(i + 1, max)` / `Math.max(i - 1, 0)` pair.
 *
 * This cursor CLAMPS; it does not wrap. That is the ask card's behaviour today
 * and the reason `nextCursor` / `prevCursor` are not used here — they wrap.
 */
export function moveQuestionCursor(
  question: AskUserQuestion,
  optionIndex: number,
  delta: number,
): number {
  return clampCursor(optionIndex + delta, questionOptionRowCount(question));
}

interface OptionProps {
  readonly hotkey: string;
  readonly label: string;
  /** `''` emits no `-desc` span, which is what the `z Other` row does. */
  readonly desc: string;
  readonly focus: boolean;
  readonly on: boolean;
}

/** One `.acp-harness__question-option`. Its class is re-derived; its nodes are not. */
class QuestionOption extends Component<OptionProps> {
  private readonly keyEl = el('span', { class: 'acp-harness__question-key' });
  private readonly labelEl = el('span', { class: 'acp-harness__question-label' });
  private descEl: HTMLElement | null = null;

  constructor() {
    super(el('div'));
    this.el.append(this.keyEl, this.labelEl);
  }

  protected readDeps(next: OptionProps): readonly unknown[] {
    return [next.hotkey, next.label, next.desc, next.focus, next.on];
  }

  protected syncClasses(next: OptionProps): void {
    this.el.className = classes(
      'acp-harness__question-option',
      next.focus && 'acp-harness__question-option--focus',
      next.on && 'acp-harness__question-option--on',
    );
  }

  protected paint(next: OptionProps): void {
    this.syncClasses(next);
    this.keyEl.textContent = next.hotkey;
    this.labelEl.textContent = next.label;
    if (next.desc === '') {
      this.descEl?.remove();
      this.descEl = null;
      return;
    }
    if (!this.descEl) {
      this.descEl = el('span', { class: 'acp-harness__question-desc' });
      this.el.appendChild(this.descEl);
    }
    this.descEl.textContent = next.desc;
  }
}

/** The head line: glyph + decision chip (resolved only), subject, position. */
class QuestionHead extends Component<QuestionPayload> {
  private readonly subject = el('span', { class: 'acp-harness__question-subject' });

  constructor() {
    super(el('div', { class: 'acp-harness__question-row' }));
  }

  protected readDeps(next: QuestionPayload): readonly unknown[] {
    return [
      next.decision,
      next.decisionLabel,
      next.questionIndex,
      next.questions.length,
      next.questions[next.questionIndex],
      next.questions[0],
    ];
  }

  protected syncClasses(_next: QuestionPayload): void {
    this.el.className = 'acp-harness__question-row';
  }

  protected paint(next: QuestionPayload): void {
    this.syncClasses(next);
    const pending = next.decision === 'pending';
    const nodes: Node[] = [];
    if (!pending) {
      nodes.push(
        el('span', {
          class: `acp-harness__question-glyph acp-harness__question-glyph--${next.decision}`,
          text: next.decision === 'accepted' ? '✓' : '✗',
        }),
        el('span', {
          class: 'acp-harness__question-decision',
          text: next.decisionLabel ?? next.decision,
        }),
      );
    }
    // A resolved card drops back to the first question's text: the cursor it
    // was answering no longer exists.
    const current = next.questions[next.questionIndex];
    const title = pending
      ? (current?.question || next.questions[0]?.question || 'question')
      : (next.questions[0]?.question || 'question');
    this.subject.textContent = title;
    this.subject.title = title;
    nodes.push(this.subject);
    if (pending && next.questions.length > 1) {
      nodes.push(
        el('span', {
          class: 'acp-harness__question-pos',
          text: `${next.questionIndex + 1}/${next.questions.length}`,
        }),
      );
    }
    this.el.replaceChildren(...nodes);
  }
}

export class QuestionRow extends TranscriptRow {
  private readonly head = new QuestionHead();
  private readonly list = el('div', { class: 'acp-harness__question-options' });
  private readonly actions = el('div', { class: 'acp-harness__question-actions' });
  private detail: HTMLElement | null = null;
  private followFrame: number | null = null;

  constructor(props: RowProps) {
    super(props, false);
  }

  protected bodyClasses(next: RowProps): readonly string[] {
    return next.item.question ? ['acp-harness__question'] : [];
  }

  protected bodyDeps(next: RowProps): readonly unknown[] {
    const payload = next.item.question;
    if (!payload) return [undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, next.item.text];
    return [
      payload.decision,
      payload.decisionLabel,
      payload.questionIndex,
      payload.questions.length,
      // Identity covers question text, detail, options, allowOther, textOnly
      // and multiSelect: the parser builds these once and never mutates them.
      payload.questions[payload.questionIndex],
      payload.questions[0],
      payload.optionIndex,
      payload.otherFocused,
      payload.otherDraft,
      (payload.selected[payload.questionIndex] ?? []).join('\u001f'),
      payload.wire,
    ];
  }

  protected paintBody(body: HTMLElement, next: RowProps): void {
    const payload = next.item.question;
    if (!payload) {
      body.removeAttribute('data-decision');
      body.textContent = next.item.text;
      return;
    }
    body.dataset.decision = payload.decision;
    this.head.update(payload);

    const current = payload.questions[payload.questionIndex];
    if (payload.decision !== 'pending' || !current) {
      syncOrder(body, [this.head.el]);
      return;
    }

    const nodes: HTMLElement[] = [this.head.el];
    if (current.detail) {
      if (!this.detail) this.detail = el('div', { class: 'acp-harness__question-detail' });
      this.detail.textContent = current.detail;
      nodes.push(this.detail);
    } else {
      this.detail = null;
    }

    const selected = payload.selected[payload.questionIndex] ?? [];
    const rows: (OptionProps & { readonly key: string })[] = current.options.map((option, index) => ({
      key: `o${index}`,
      hotkey: optionHotkey(index),
      label: option.label,
      desc: option.description,
      focus: index === payload.optionIndex && !payload.otherFocused,
      on: selected.includes(option.label),
    }));
    if (current.allowOther !== false) {
      rows.push({
        key: 'other',
        hotkey: 'z',
        label: payload.otherFocused
          ? (payload.otherDraft || '…')
          : (current.textOnly ? 'type answer' : 'Other'),
        desc: '',
        focus: payload.otherFocused || payload.optionIndex >= current.options.length,
        on: false,
      });
    }
    reconcile(this.list, rows, {
      key: (row) => row.key,
      create: (row) => {
        const option = new QuestionOption();
        option.update(row);
        return option;
      },
      update: (option, row) => option.update(row),
    });
    nodes.push(this.list);

    this.actions.textContent = questionActionsHint(current, payload.wire, payload.otherFocused);
    nodes.push(this.actions);
    syncOrder(body, nodes);
    this.followCursor();
  }

  /** Long pickers (branches, commits) scroll inside the list; keep the focused
   *  row visible without moving the transcript itself. */
  private followCursor(): void {
    const focused = this.list.querySelector<HTMLElement>('.acp-harness__question-option--focus');
    if (!focused) return;
    if (this.followFrame !== null) cancelAnimationFrame(this.followFrame);
    this.followFrame = requestAnimationFrame(() => {
      this.followFrame = null;
      if (this.list.scrollHeight <= this.list.clientHeight) return;
      const top = focused.offsetTop;
      const bottom = top + focused.offsetHeight;
      if (top < this.list.scrollTop) this.list.scrollTop = top;
      else if (bottom > this.list.scrollTop + this.list.clientHeight) {
        this.list.scrollTop = bottom - this.list.clientHeight;
      }
    });
  }

  protected onDispose(): void {
    if (this.followFrame !== null) cancelAnimationFrame(this.followFrame);
    this.followFrame = null;
    disposeList(this.list);
    this.head.dispose();
    super.onDispose();
  }
}

export const def: ComponentDef = { id: 'question-row', blocks: ['acp-harness__question'] };
