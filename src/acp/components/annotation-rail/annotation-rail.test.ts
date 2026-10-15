import { describe, expect, it } from 'vitest';

import type { TranscriptAnnotation } from '../../types';
import { AnnotationRail } from './index';

function note(
  id: string,
  body: string,
  status: TranscriptAnnotation['status'] = 'unsent',
  drifted?: boolean,
): TranscriptAnnotation {
  return {
    id,
    itemId: 'msg-1',
    quote: body.slice(0, 8),
    quoteIndex: 0,
    body,
    status,
    createdAt: 0,
    ...(drifted === undefined ? {} : { drifted }),
  };
}

const items = (rail: AnnotationRail): HTMLElement[] =>
  [...rail.el.querySelectorAll<HTMLElement>('.acp-harness__anno-item')];

const sendButton = (rail: AnnotationRail): HTMLButtonElement | null =>
  rail.el.querySelector<HTMLButtonElement>('.acp-harness__anno-send');

describe('AnnotationRail', () => {
  it('emits the rail head, the send button and one row per note', () => {
    const rail = new AnnotationRail();
    rail.update({
      annotations: [
        note('a', 'deps tuple needs the lane arg'),
        note('b', 'already drained', 'drained'),
        note('c', 'second unsent note'),
      ],
    });

    expect(rail.el.tagName).toBe('SECTION');
    expect(rail.el.className).toBe('acp-harness__anno-rail');
    expect(rail.el.getAttribute('aria-label')).toBe('Annotations');
    expect(rail.el.querySelector('.acp-harness__anno-rail-head')?.firstElementChild?.textContent)
      .toBe('ANNOTATED  3 · 2 unsent');
    expect(sendButton(rail)?.textContent).toBe('send 2');
    expect(sendButton(rail)?.disabled).toBe(false);
    expect(sendButton(rail)?.dataset.annoSend).toBe('1');
    expect(rail.el.querySelector('.acp-harness__anno-list')?.tagName).toBe('OL');
    expect(items(rail).map((item) => item.className)).toEqual([
      'acp-harness__anno-item acp-harness__anno-item--unsent',
      'acp-harness__anno-item acp-harness__anno-item--drained',
      'acp-harness__anno-item acp-harness__anno-item--unsent',
    ]);
    expect(items(rail).map((item) => item.querySelector('.acp-harness__anno-del')?.textContent))
      .toEqual(['del', undefined, 'del']);
    expect(items(rail)[0].querySelector<HTMLElement>('.acp-harness__anno-del')?.dataset.annoDel)
      .toBe('a');
  });

  it('disables the send button and says `sent` with nothing left to send', () => {
    const rail = new AnnotationRail();
    rail.update({ annotations: [note('a', 'x', 'sent'), note('b', 'y', 'drained')] });

    expect(rail.el.querySelector('.acp-harness__anno-rail-head')?.firstElementChild?.textContent)
      .toBe('ANNOTATED  2');
    expect(sendButton(rail)?.textContent).toBe('sent');
    expect(sendButton(rail)?.disabled).toBe(true);
  });

  it('re-derives the item class and drops the del button when a note is sent', () => {
    const rail = new AnnotationRail();
    rail.update({ annotations: [note('a', 'x'), note('b', 'y')] });
    const nodes = items(rail);

    rail.update({ annotations: [note('a', 'x', 'sent'), note('b', 'y')] });

    expect(items(rail)).toEqual(nodes);
    expect(nodes[0].className).toBe('acp-harness__anno-item acp-harness__anno-item--sent');
    expect(nodes[0].querySelector('.acp-harness__anno-del')).toBeNull();
    expect(nodes[1].querySelector('.acp-harness__anno-del')).not.toBeNull();
    expect(sendButton(rail)?.textContent).toBe('send 1');
  });

  it('marks and unmarks a drifted note without touching its siblings', () => {
    const rail = new AnnotationRail();
    rail.update({ annotations: [note('a', 'x'), note('b', 'y')] });
    const nodes = items(rail);

    rail.update({ annotations: [note('a', 'x'), note('b', 'y', 'unsent', true)] });
    expect(nodes[1].className)
      .toBe('acp-harness__anno-item acp-harness__anno-item--unsent acp-harness__anno-item--drifted');

    rail.update({ annotations: [note('a', 'x'), note('b', 'y', 'unsent', false)] });
    expect(items(rail)).toEqual(nodes);
    expect(nodes[1].className).toBe('acp-harness__anno-item acp-harness__anno-item--unsent');
  });

  it('keeps the surviving rows when one note is deleted', () => {
    const rail = new AnnotationRail();
    rail.update({ annotations: [note('a', 'x'), note('b', 'y'), note('c', 'z')] });
    const kept = [items(rail)[0], items(rail)[2]];

    rail.update({ annotations: [note('a', 'x'), note('c', 'z')] });

    expect(items(rail)).toEqual(kept);
    expect(sendButton(rail)?.textContent).toBe('send 2');
  });

  it('writes nothing while the annotation array holds', () => {
    const rail = new AnnotationRail();
    const same = { annotations: [note('a', 'x')] };
    rail.update(same);

    let mutations = 0;
    const observer = new MutationObserver((records) => {
      mutations += records.length;
    });
    observer.observe(rail.el, { subtree: true, childList: true, attributes: true, characterData: true });
    rail.update(same);
    mutations += observer.takeRecords().length;
    observer.disconnect();

    expect(mutations).toBe(0);
  });

  it('escapes nothing by hand — note bodies go through the DOM', () => {
    const rail = new AnnotationRail();
    rail.update({ annotations: [note('a', '<script>alert(1)</script>')] });
    expect(rail.el.querySelector('script')).toBeNull();
    expect(rail.el.querySelector('.acp-harness__anno-note')?.textContent)
      .toBe('<script>alert(1)</script>');
  });

  it('tears its rows down on dispose', () => {
    const rail = new AnnotationRail();
    rail.update({ annotations: [note('a', 'x')] });
    rail.dispose();
    expect(items(rail).length).toBe(0);
  });
});
