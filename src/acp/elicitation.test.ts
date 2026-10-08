import { describe, expect, it } from 'vitest';

import {
  acceptedDecision,
  applyAskUserKey,
  createAskUserCardState,
  type AskUserCardState,
  type AskUserKeyAction,
  type AskUserQuestion,
} from './ask-user-question';
import { elicitationResponse, parseElicitationForm } from './elicitation';

// Verbatim shape sent by `omp acp` 18.7.0 for `/review` (probe 2026-10-07).
const REVIEW_SCHEMA = {
  type: 'object',
  properties: {
    value: {
      type: 'string',
      enum: [
        '1. Review against a base branch (PR Style)',
        '2. Review uncommitted changes',
        '3. Review a specific commit',
      ],
    },
  },
  required: ['value'],
};

function press(questions: AskUserQuestion[], keys: string[]): { state: AskUserCardState; action: AskUserKeyAction } {
  let state = createAskUserCardState(questions);
  let last = applyAskUserKey(questions, state, '');
  for (const key of keys) {
    last = applyAskUserKey(questions, state, key);
    state = last.state;
  }
  return last;
}

describe('parseElicitationForm', () => {
  it('turns OMP single-select into a closed picker titled by the message', () => {
    const form = parseElicitationForm('Review Mode', REVIEW_SCHEMA);
    expect(form?.questions).toHaveLength(1);
    expect(form?.questions[0].question).toBe('Review Mode');
    expect(form?.questions[0].allowOther).toBe(false);
    expect(form?.questions[0].options.map((o) => o.label)).toEqual(REVIEW_SCHEMA.properties.value.enum);
  });

  it('puts a multi-line message after its first line into detail', () => {
    const form = parseElicitationForm('Approve plan?\n\n- step 1\n- step 2', { properties: { value: { type: 'boolean' } } });
    expect(form?.questions[0].question).toBe('Approve plan?');
    expect(form?.questions[0].detail).toBe('- step 1\n- step 2');
  });

  it('declines (null) on unsupported or empty schemas', () => {
    expect(parseElicitationForm('x', { properties: {} })).toBeNull();
    expect(parseElicitationForm('x', { properties: { v: { type: 'object' } } })).toBeNull();
    expect(parseElicitationForm('x', { properties: { v: { type: 'string', enum: [] } } })).toBeNull();
    expect(parseElicitationForm('x', null)).toBeNull();
  });
});

describe('elicitation round trip', () => {
  it('answers OMP /review with the picked enum value', () => {
    const form = parseElicitationForm('Review Mode', REVIEW_SCHEMA)!;
    const result = press(form.questions, ['2']);
    expect(result.action.type).toBe('submit');
    if (result.action.type !== 'submit') return;
    expect(elicitationResponse(form.fields, { kind: 'accept', decision: result.action.decision })).toEqual({
      action: 'accept',
      content: { value: '2. Review uncommitted changes' },
    });
  });

  it('shows oneOf titles but replies with const values', () => {
    const form = parseElicitationForm('Env', {
      properties: { env: { type: 'string', oneOf: [{ const: 'prod', title: 'Production' }, { const: 'stg', title: 'Staging' }] } },
      required: ['env'],
    })!;
    expect(form.questions[0].options.map((o) => o.label)).toEqual(['Production', 'Staging']);
    const result = press(form.questions, ['j', 'Enter']);
    if (result.action.type !== 'submit') throw new Error('expected submit');
    expect(elicitationResponse(form.fields, { kind: 'accept', decision: result.action.decision }))
      .toEqual({ action: 'accept', content: { env: 'stg' } });
  });

  it('maps booleans to Yes/No and honours default false', () => {
    const form = parseElicitationForm('Switch plan?', { properties: { value: { type: 'boolean', default: false } } })!;
    const result = press(form.questions, ['Enter']);
    if (result.action.type !== 'submit') throw new Error('expected submit');
    expect(elicitationResponse(form.fields, { kind: 'accept', decision: result.action.decision }))
      .toEqual({ action: 'accept', content: { value: false } });
  });

  it('opens text fields focused with the default prefilled (OMP editor)', () => {
    const form = parseElicitationForm('Custom review', {
      properties: { value: { type: 'string', default: 'Review the following:' } },
      required: ['value'],
    })!;
    const result = press(form.questions, ['!', 'Enter']);
    if (result.action.type !== 'submit') throw new Error('expected submit');
    expect(elicitationResponse(form.fields, { kind: 'accept', decision: result.action.decision }))
      .toEqual({ action: 'accept', content: { value: 'Review the following:!' } });
  });

  it('keeps an invalid integer in the draft instead of submitting', () => {
    const form = parseElicitationForm('Count', { properties: { n: { type: 'integer' } }, required: ['n'] })!;
    const bad = press(form.questions, ['1', '.', '5', 'Enter']);
    expect(bad.action.type).toBe('redraw');
    expect(bad.state.otherDraft).toBe('1.5');
    const good = press(form.questions, ['4', '2', 'Enter']);
    if (good.action.type !== 'submit') throw new Error('expected submit');
    expect(elicitationResponse(form.fields, { kind: 'accept', decision: good.action.decision }))
      .toEqual({ action: 'accept', content: { n: 42 } });
  });

  it('omits an optional field left empty and fills multi-select arrays', () => {
    const form = parseElicitationForm('Setup', {
      properties: {
        note: { type: 'string', title: 'Note' },
        tags: { type: 'array', items: { enum: ['a', 'b', 'c'] } },
      },
      required: ['tags'],
    })!;
    expect(form.questions[0].detail).toBe('Setup');
    const result = press(form.questions, ['Enter', '1', '3', 'Enter']);
    if (result.action.type !== 'submit') throw new Error('expected submit');
    expect(elicitationResponse(form.fields, { kind: 'accept', decision: result.action.decision }))
      .toEqual({ action: 'accept', content: { tags: ['a', 'c'] } });
  });

  it('maps x to decline, lane abort to cancel, and a foreign label to cancel', () => {
    const form = parseElicitationForm('Review Mode', REVIEW_SCHEMA)!;
    expect(press(form.questions, ['x']).action).toEqual({ type: 'skip' });
    expect(elicitationResponse(form.fields, { kind: 'decline' })).toEqual({ action: 'decline' });
    expect(elicitationResponse(form.fields, { kind: 'cancel' })).toEqual({ action: 'cancel' });
    const forged = acceptedDecision(form.questions, [['not an option']]);
    expect(elicitationResponse(form.fields, { kind: 'accept', decision: forged })).toEqual({ action: 'cancel' });
  });

  it('does not submit while a required field skipped with l is still empty', () => {
    const form = parseElicitationForm('Setup', {
      properties: { env: { type: 'string', enum: ['prod', 'stg'] }, note: { type: 'string' } },
      required: ['env', 'note'],
    })!;
    const back = press(form.questions, ['l', 'h', 'l', 'o', 'k', 'Enter']);
    expect(back.action.type).toBe('redraw');
    expect(back.state.questionIndex).toBe(0);
    const done = press(form.questions, ['l', 'o', 'k', 'Enter', '2']);
    if (done.action.type !== 'submit') throw new Error('expected submit');
    expect(elicitationResponse(form.fields, { kind: 'accept', decision: done.action.decision }))
      .toEqual({ action: 'accept', content: { env: 'stg', note: 'ok' } });
    // Defense in depth: a decision that still lacks a required field cancels.
    const partial = acceptedDecision(form.questions, [[], ['ok']]);
    expect(elicitationResponse(form.fields, { kind: 'accept', decision: partial })).toEqual({ action: 'cancel' });
  });

  it('keeps duplicate oneOf titles distinct so the picked row maps to its own value', () => {
    const form = parseElicitationForm('Branch', {
      properties: { value: { type: 'string', oneOf: [{ const: 'a1', title: 'main' }, { const: 'b2', title: 'main' }] } },
      required: ['value'],
    })!;
    expect(form.questions[0].options.map((o) => o.label)).toEqual(['main (a1)', 'main (b2)']);
    const result = press(form.questions, ['2']);
    if (result.action.type !== 'submit') throw new Error('expected submit');
    expect(elicitationResponse(form.fields, { kind: 'accept', decision: result.action.decision }))
      .toEqual({ action: 'accept', content: { value: 'b2' } });
  });
});

describe('closed pickers', () => {
  it('hide Other: z is a no-op and j clamps at the last option', () => {
    const form = parseElicitationForm('Review Mode', REVIEW_SCHEMA)!;
    expect(press(form.questions, ['z']).state.otherFocused).toBe(false);
    expect(press(form.questions, ['j', 'j', 'j', 'j']).state.optionIndex).toBe(2);
  });
});
