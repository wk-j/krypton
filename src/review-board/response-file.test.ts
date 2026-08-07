import { describe, expect, it } from 'vitest';

import {
  isResponseEmpty,
  parseResponseFile,
  renderResponseBody,
  serializeResponseFile,
} from './response-file';
import type { ReviewResponse } from '../acp/types';

// spec 211 — `response.md` is one file with two halves: the frontmatter is the
// source of truth, the body is a generated rendering. What must hold: a
// round-trip restores exactly what was answered, a hand-edit never blocks the
// review (unknown keys ignored, malformed entries skipped and counted), and a
// totally corrupt frontmatter is reported so the caller backs it up instead of
// silently overwriting it.

const RESPONDED_AT = Date.parse('2026-08-07T14:22:10.000Z');

const label = (blockId: string): string => `block ${blockId}`;

const response = (over: Partial<ReviewResponse> = {}): ReviewResponse => ({
  reviewId: '2026-08-07-peering-guard-rewrite',
  comments: [],
  findings: [],
  decisions: [],
  ...over,
});

const full = response({
  note: 'ship 1 plus the regression test, park the rest',
  findings: [
    { blockId: 'b7-9f2a1c', state: 'accepted' },
    { blockId: 'b11-31de00', state: 'dismissed' },
  ],
  decisions: [{ blockId: 'b9-4c11ab', chosen: 2 }],
  comments: [
    { blockId: 'b8-77aa02', quote: 'await this.deliver(envelope);', body: 'add a regression test' },
  ],
});

/** Serialize then parse, the way a close-and-reopen actually behaves. */
function roundTrip(input: ReviewResponse): ReviewResponse {
  return parseResponseFile(serializeResponseFile(input, RESPONDED_AT, label), input.reviewId).response;
}

describe('round-trip', () => {
  it('restores every answer', () => {
    expect(roundTrip(full)).toEqual(full);
  });

  it('restores an empty response as empty', () => {
    const restored = roundTrip(response());
    expect(isResponseEmpty(restored)).toBe(true);
    expect(restored.reviewId).toBe('2026-08-07-peering-guard-rewrite');
  });

  it('distinguishes answered-but-not-sent from delivered', () => {
    expect(roundTrip(full).sentAt).toBeUndefined();
    const sentAt = Date.parse('2026-08-07T15:00:00.000Z');
    expect(roundTrip({ ...full, sentAt }).sentAt).toBe(sentAt);
  });

  it('survives a note containing the frontmatter delimiter and a colon', () => {
    const tricky = response({ note: 'careful:\n---\nnot a new block\nkey: value' });
    expect(roundTrip(tricky).note).toBe(tricky.note);
  });

  it('survives a quote containing quotes, braces, and newlines', () => {
    const tricky = response({
      comments: [{ blockId: 'b1-aaaaaaaa', quote: 'if (a) { "x": \'y\' }\nnext line', body: 'fix "this"' }],
    });
    expect(roundTrip(tricky).comments[0]).toEqual(tricky.comments[0]);
  });

  it('produces identical text for the same response', () => {
    expect(serializeResponseFile(full, RESPONDED_AT, label)).toBe(
      serializeResponseFile(full, RESPONDED_AT, label),
    );
  });

  it('caps a runaway field instead of writing it whole', () => {
    const huge = response({ note: 'x'.repeat(20000) });
    const text = serializeResponseFile(huge, RESPONDED_AT, label);
    expect(text.length).toBeLessThan(10000);
    expect(parseResponseFile(text, huge.reviewId).response.note?.length).toBe(4000);
  });
});

describe('the generated body', () => {
  it('states the answers in plain language and says where the truth lives', () => {
    const text = serializeResponseFile(full, RESPONDED_AT, label);
    expect(text).toContain('edit answers in the Review Board, not here');
    expect(text).toContain('**accepted** · block b7-9f2a1c');
    expect(text).toContain('**dismissed** · block b11-31de00');
    expect(text).toContain('**decision** · block b9-4c11ab → *2*');
    expect(text).toContain('add a regression test');
    expect(text).toContain('ship 1 plus the regression test');
    expect(text).toContain('Answered but not yet sent');
  });

  it('reports the send timestamp once delivered', () => {
    const sentAt = Date.parse('2026-08-07T15:00:00.000Z');
    expect(renderResponseBody({ ...full, sentAt }, label)).toContain('Sent to the lane at 2026-08-07T15:00:00.000Z');
  });

  it('says so plainly when nothing has been answered', () => {
    expect(renderResponseBody(response(), label)).toContain('Nothing answered yet');
    expect(renderResponseBody(response({ note: 'just a note' }), label)).toContain('a note was sent');
  });

  it('collapses a multi-line quote so it cannot break the list markup', () => {
    const body = renderResponseBody(
      response({ comments: [{ blockId: 'b1-aaaaaaaa', quote: 'line one\nline two', body: 'note\nhere' }] }),
      label,
    );
    expect(body).toContain('> line one line two');
    expect(body).toContain('  note here');
  });
});

describe('lenient parsing', () => {
  it('ignores unknown keys instead of failing', () => {
    const text = [
      '---',
      'review: "r1"',
      'responded_at: "2026-08-07T14:22:10.000Z"',
      'verdict: shipped',
      'future_field:',
      '  - block: "bX"',
      '    weight: 3',
      'findings:',
      '  - block: "b7-9f2a1c"',
      '    state: accepted',
      '---',
      '',
      'body',
    ].join('\n');
    const parsed = parseResponseFile(text, 'r1');
    expect(parsed.unparseable).toBe(false);
    expect(parsed.response.findings).toEqual([{ blockId: 'b7-9f2a1c', state: 'accepted' }]);
  });

  it('accepts bare (hand-edited) scalars alongside quoted ones', () => {
    const text = ['---', 'review: r1', 'note: park the rest', 'findings:', '  - block: b7', '    state: dismissed', '---'].join('\n');
    const parsed = parseResponseFile(text, 'r1');
    expect(parsed.response.note).toBe('park the rest');
    expect(parsed.response.findings).toEqual([{ blockId: 'b7', state: 'dismissed' }]);
  });

  it('skips malformed entries with a count and keeps the rest', () => {
    const text = [
      '---',
      'review: r1',
      'findings:',
      '  - block: b7',
      '    state: accepted',
      '  - state: accepted', // no block
      '  - block: b9',
      '    state: maybe', // not a state
      'decisions:',
      '  - block: b10',
      '    chosen: 2',
      '  - block: b11',
      '    chosen: zero', // not a number
      'comments:',
      '  - block: b12',
      '    body: fine',
      '  - block: b13', // no body
      '---',
    ].join('\n');
    const parsed = parseResponseFile(text, 'r1');
    expect(parsed.skipped).toBe(4);
    expect(parsed.response.findings).toEqual([{ blockId: 'b7', state: 'accepted' }]);
    expect(parsed.response.decisions).toEqual([{ blockId: 'b10', chosen: 2 }]);
    expect(parsed.response.comments).toEqual([{ blockId: 'b12', quote: '', body: 'fine' }]);
  });

  it('reads an empty response file as an empty response, not as corrupt', () => {
    const parsed = parseResponseFile('', 'r1');
    expect(parsed.unparseable).toBe(false);
    expect(isResponseEmpty(parsed.response)).toBe(true);
  });

  it('flags a file with no frontmatter at all as unparseable', () => {
    const parsed = parseResponseFile('just some prose the human typed\n', 'r1');
    expect(parsed.unparseable).toBe(true);
    expect(isResponseEmpty(parsed.response)).toBe(true);
  });

  it('flags a frontmatter with nothing recognizable as unparseable', () => {
    const parsed = parseResponseFile('---\n!!! broken !!!\n???\n---\n', 'r1');
    expect(parsed.unparseable).toBe(true);
  });

  it('trusts the bundle directory over a hand-edited review: key', () => {
    const parsed = parseResponseFile('---\nreview: someone-renamed-this\n---\n', 'the-real-slug');
    expect(parsed.response.reviewId).toBe('the-real-slug');
  });

  it('ignores a body the human hand-edited', () => {
    const text = `${serializeResponseFile(full, RESPONDED_AT, label)}\n\nI typed this by hand and it means nothing.\n`;
    expect(parseResponseFile(text, full.reviewId).response).toEqual(full);
  });
});

describe('isResponseEmpty', () => {
  it('treats a whitespace-only note as empty', () => {
    expect(isResponseEmpty(response({ note: '   \n ' }))).toBe(true);
    expect(isResponseEmpty(response({ note: 'x' }))).toBe(false);
  });

  it('is false as soon as anything is answered', () => {
    expect(isResponseEmpty(response({ findings: [{ blockId: 'b', state: 'accepted' }] }))).toBe(false);
    expect(isResponseEmpty(response({ decisions: [{ blockId: 'b', chosen: 1 }] }))).toBe(false);
    expect(isResponseEmpty(response({ comments: [{ blockId: 'b', quote: '', body: 'x' }] }))).toBe(false);
  });
});
