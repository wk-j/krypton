import { describe, expect, it } from 'vitest';

import {
  acceptedDecision,
  applyAskUserKey,
  createAskUserCardState,
  optionIndexFromKey,
  parseAskUserQuestions,
  shouldAutoAnswerAskUser,
  skipInterviewDecision,
  type AskUserQuestion,
} from './ask-user-question';

const sample: AskUserQuestion[] = [
  {
    question: 'Where should it live?',
    options: [
      { label: 'OS browser', description: 'loopback page' },
      { label: 'Prototype', description: 'html first' },
    ],
  },
];

const two: AskUserQuestion[] = [
  ...sample,
  {
    question: 'Ship now?',
    options: [
      { label: 'Yes', description: '' },
      { label: 'No', description: '' },
    ],
  },
];

describe('parseAskUserQuestions', () => {
  it('reads camelCase questions and options', () => {
    const parsed = parseAskUserQuestions({
      questions: [{
        question: 'Pick one',
        options: [{ label: 'A', description: 'first', preview: 'aa' }],
        multiSelect: true,
      }],
    });
    expect(parsed).toEqual([{
      question: 'Pick one',
      options: [{ label: 'A', description: 'first', preview: 'aa' }],
      multiSelect: true,
    }]);
  });

  it('accepts multi_select and nested params', () => {
    const parsed = parseAskUserQuestions({
      params: {
        questions: [{ question: 'Q', options: [{ label: 'One' }], multi_select: true }],
      },
    });
    expect(parsed[0]?.multiSelect).toBe(true);
    expect(parsed[0]?.options[0]?.description).toBe('');
  });

  it('returns [] for missing or empty input', () => {
    expect(parseAskUserQuestions(null)).toEqual([]);
    expect(parseAskUserQuestions({})).toEqual([]);
    expect(parseAskUserQuestions({ questions: [] })).toEqual([]);
  });
});

describe('applyAskUserKey', () => {
  it('maps 1-9 / a-f to option indexes', () => {
    expect(optionIndexFromKey('1')).toBe(0);
    expect(optionIndexFromKey('a')).toBe(9);
    expect(optionIndexFromKey('f')).toBe(14);
    expect(optionIndexFromKey('g')).toBeNull();
  });

  it('clamps j/k on the option list including Other', () => {
    const start = createAskUserCardState(sample);
    const down = applyAskUserKey(sample, start, 'j');
    expect(down.state.optionIndex).toBe(1);
    const other = applyAskUserKey(sample, down.state, 'j');
    expect(other.state.optionIndex).toBe(2);
    const clamped = applyAskUserKey(sample, other.state, 'j');
    expect(clamped.state.optionIndex).toBe(2);
    const up = applyAskUserKey(sample, start, 'k');
    expect(up.state.optionIndex).toBe(0);
  });

  it('submits a single-question pick on 1', () => {
    const result = applyAskUserKey(sample, createAskUserCardState(sample), '1');
    expect(result.action).toEqual({
      type: 'submit',
      decision: acceptedDecision(sample, [['OS browser']]),
    });
    expect(acceptedDecision(sample, [['OS browser']])).toEqual({
      outcome: 'accepted',
      answers: [{ question: 'Where should it live?', selected_labels: ['OS browser'] }],
      partial_answers: null,
    });
  });

  it('advances to the next question on Enter, then submits', () => {
    const first = applyAskUserKey(two, createAskUserCardState(two), 'Enter');
    expect(first.action.type).toBe('redraw');
    expect(first.state.questionIndex).toBe(1);
    const second = applyAskUserKey(two, first.state, 'Enter');
    expect(second.action).toEqual({
      type: 'submit',
      decision: acceptedDecision(two, [['OS browser'], ['Yes']]),
    });
  });

  it('skips the whole interview on x', () => {
    const result = applyAskUserKey(sample, createAskUserCardState(sample), 'x');
    expect(result.action).toEqual({ type: 'skip' });
    expect(skipInterviewDecision()).toEqual({ outcome: 'skip_interview' });
  });

  it('accepts Other free-text after z', () => {
    let cur = createAskUserCardState(sample);
    cur = applyAskUserKey(sample, cur, 'z').state;
    expect(cur.otherFocused).toBe(true);
    cur = applyAskUserKey(sample, cur, 'h').state;
    cur = applyAskUserKey(sample, cur, 'i').state;
    const done = applyAskUserKey(sample, cur, 'Enter');
    expect(done.action).toEqual({
      type: 'submit',
      decision: acceptedDecision(sample, [['hi']]),
    });
  });

  it('Esc from Other returns to the options without skipping', () => {
    let cur = createAskUserCardState(sample);
    cur = applyAskUserKey(sample, cur, 'z').state;
    const parked = applyAskUserKey(sample, cur, 'Escape');
    expect(parked.state.otherFocused).toBe(false);
    expect(parked.action).toEqual({ type: 'redraw' });
  });

  it('Esc on options parks and does not skip', () => {
    const result = applyAskUserKey(sample, createAskUserCardState(sample), 'Escape');
    expect(result.action).toEqual({ type: 'none' });
  });

  it('never auto-answers under permission modes', () => {
    expect(shouldAutoAnswerAskUser()).toBe(false);
  });
});
