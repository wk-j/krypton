import { describe, expect, it } from 'vitest';

import type { AskUserQuestion, QuestionPayload } from '../../ask-user-question';
import type { HarnessTranscriptItem } from '../../harness-view-types';
import type { RowProps } from '../transcript-row';
import { QuestionRow, moveQuestionCursor, questionOptionRowCount } from './index';

const RECONCILER: AskUserQuestion = {
  question: 'Which reconciler should phase 3 use?',
  options: [
    { label: 'keyed reconcile', description: 'node identity preserved' },
    { label: 'morph', description: 'diff against a fresh tree' },
  ],
};

function payload(over: Partial<QuestionPayload> = {}): QuestionPayload {
  return {
    requestId: 3,
    questions: [RECONCILER],
    questionIndex: 0,
    optionIndex: 0,
    selected: [[]],
    otherDraft: '',
    otherFocused: false,
    decision: 'pending',
    wire: 'grok',
    ...over,
  };
}

function props(question: QuestionPayload | undefined): RowProps {
  const item: HarnessTranscriptItem = { id: 'q1', kind: 'question', text: 'ask', question };
  return { item, isNew: false, streaming: false, lane: null, projectDir: null, resolveLocalImages: false };
}

function watch(node: HTMLElement): MutationObserver {
  const observer = new MutationObserver(() => {});
  observer.observe(node, { childList: true, subtree: true, attributes: true, characterData: true });
  return observer;
}

function mount(state: QuestionPayload): { row: QuestionRow; body: HTMLElement; list: HTMLElement } {
  const row = new QuestionRow(props(state));
  row.update(props(state));
  const body = row.el.querySelector<HTMLElement>('.acp-harness__msg-body');
  const list = row.el.querySelector<HTMLElement>('.acp-harness__question-options');
  if (!body || !list) throw new Error('question row did not paint');
  return { row, body, list };
}

describe('QuestionRow', () => {
  it('emits the pending card: head, options, z-other row and the actions hint', () => {
    const { row, body } = mount(payload());

    expect(row.el.className).toBe('acp-harness__msg acp-harness__msg--question');
    expect(body.className).toBe('acp-harness__msg-body acp-harness__question');
    expect(body.dataset.decision).toBe('pending');
    expect(body.innerHTML).toBe(
      '<div class="acp-harness__question-row">' +
        '<span class="acp-harness__question-subject" title="Which reconciler should phase 3 use?">' +
          'Which reconciler should phase 3 use?' +
        '</span>' +
      '</div>' +
      '<div class="acp-harness__question-options">' +
        '<div class="acp-harness__question-option acp-harness__question-option--focus">' +
          '<span class="acp-harness__question-key">1</span>' +
          '<span class="acp-harness__question-label">keyed reconcile</span>' +
          '<span class="acp-harness__question-desc">node identity preserved</span>' +
        '</div>' +
        '<div class="acp-harness__question-option">' +
          '<span class="acp-harness__question-key">2</span>' +
          '<span class="acp-harness__question-label">morph</span>' +
          '<span class="acp-harness__question-desc">diff against a fresh tree</span>' +
        '</div>' +
        '<div class="acp-harness__question-option">' +
          '<span class="acp-harness__question-key">z</span>' +
          '<span class="acp-harness__question-label">Other</span>' +
        '</div>' +
      '</div>' +
      '<div class="acp-harness__question-actions">1–9 pick · Enter · x skip · z other</div>',
    );
    row.dispose();
  });

  it('moves --focus with the cursor and leaves every other option node untouched', () => {
    const state = payload();
    const { row, list } = mount(state);
    const nodes = [...list.children] as HTMLElement[];
    const other = watch(nodes[2]);

    state.optionIndex = 1;
    row.update(props(state));

    expect([...list.children]).toEqual(nodes);
    expect(nodes[0].className).toBe('acp-harness__question-option');
    expect(nodes[1].className).toBe('acp-harness__question-option acp-harness__question-option--focus');
    expect(other.takeRecords()).toHaveLength(0);
    other.disconnect();
    row.dispose();
  });

  it('writes nothing when no cursor field moved', () => {
    const state = payload({ optionIndex: 1 });
    const { row } = mount(state);
    const observer = watch(row.el);

    row.update(props(state));

    expect(observer.takeRecords()).toHaveLength(0);
    observer.disconnect();
    row.dispose();
  });

  it('marks a multi-select pick with --on and clears it when the label is deselected', () => {
    const multi: AskUserQuestion = { ...RECONCILER, multiSelect: true };
    const state = payload({ questions: [multi], selected: [['morph']] });
    const { row, list } = mount(state);
    expect(list.children[1].className)
      .toBe('acp-harness__question-option acp-harness__question-option--on');
    expect(row.el.querySelector('.acp-harness__question-actions')?.textContent)
      .toBe('1–9 toggle · Enter commit · x skip · z other');

    state.selected = [[]];
    row.update(props(state));
    expect(list.children[1].className).toBe('acp-harness__question-option');
    row.dispose();
  });

  it('shows the draft on the focused z row and drops focus from the options', () => {
    const state = payload({ otherFocused: true, otherDraft: 'a third way', optionIndex: 2 });
    const { row, list } = mount(state);
    const other = list.children[2];
    expect(other.className).toBe('acp-harness__question-option acp-harness__question-option--focus');
    expect(other.textContent).toBe('za third way');
    expect(list.children[0].className).toBe('acp-harness__question-option');
    expect(row.el.querySelector('.acp-harness__question-actions')?.textContent)
      .toBe('type · Enter submit · Esc back');

    state.otherDraft = '';
    row.update(props(state));
    expect(list.children[2].textContent).toBe('z…');
    row.dispose();
  });

  it('omits the z row when the question forbids a free-text answer', () => {
    const closed: AskUserQuestion = { ...RECONCILER, allowOther: false };
    const { row, list } = mount(payload({ questions: [closed] }));
    expect(list.children).toHaveLength(2);
    expect(row.el.querySelector('.acp-harness__question-actions')?.textContent)
      .toBe('1–9 pick · Enter · x skip');
    row.dispose();
  });

  it('shows the position counter and the detail block on a multi-question card', () => {
    const second: AskUserQuestion = {
      question: 'And the window size?',
      detail: 'the tail window the transcript keeps mounted',
      options: [{ label: '200', description: '' }],
    };
    const { row, body } = mount(payload({ questions: [RECONCILER, second], questionIndex: 1 }));
    expect(row.el.querySelector('.acp-harness__question-pos')?.textContent).toBe('2/2');
    expect(row.el.querySelector('.acp-harness__question-detail')?.textContent)
      .toBe('the tail window the transcript keeps mounted');
    expect(body.firstElementChild?.className).toBe('acp-harness__question-row');
    expect(body.children[1].className).toBe('acp-harness__question-detail');
    row.dispose();
  });

  it('collapses to the first question and its decision chip once answered', () => {
    const state = payload({ questions: [RECONCILER, RECONCILER], questionIndex: 1 });
    const { row, body } = mount(state);

    state.decision = 'accepted';
    state.decisionLabel = 'keyed reconcile';
    row.update(props(state));

    expect(body.dataset.decision).toBe('accepted');
    expect(body.innerHTML).toBe(
      '<div class="acp-harness__question-row">' +
        '<span class="acp-harness__question-glyph acp-harness__question-glyph--accepted">✓</span>' +
        '<span class="acp-harness__question-decision">keyed reconcile</span>' +
        '<span class="acp-harness__question-subject" title="Which reconciler should phase 3 use?">' +
          'Which reconciler should phase 3 use?' +
        '</span>' +
      '</div>',
    );
    row.dispose();
  });

  it('re-derives the body class when the payload disappears', () => {
    const row = new QuestionRow(props(undefined));
    row.update(props(undefined));
    const body = row.el.querySelector<HTMLElement>('.acp-harness__msg-body');
    expect(body?.className).toBe('acp-harness__msg-body');
    expect(body?.textContent).toBe('ask');
    row.dispose();
  });

  it('counts the z row as a cursor stop and clamps instead of wrapping', () => {
    expect(questionOptionRowCount(RECONCILER)).toBe(3);
    expect(questionOptionRowCount({ ...RECONCILER, allowOther: false })).toBe(2);
    expect(questionOptionRowCount({ question: 'free text', options: [] })).toBe(1);

    expect(moveQuestionCursor(RECONCILER, 0, 1)).toBe(1);
    expect(moveQuestionCursor(RECONCILER, 2, 1)).toBe(2);
    expect(moveQuestionCursor(RECONCILER, 0, -1)).toBe(0);
  });
});
