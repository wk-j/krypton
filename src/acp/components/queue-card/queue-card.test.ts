import { describe, expect, it } from 'vitest';

import type { QueuedPrompt } from '../../harness-view-types';
import { QueueCard, type QueueCardProps } from './index';

function prompt(text: string, over: Partial<QueuedPrompt> = {}): QueuedPrompt {
  return { text, images: [], mentionTargets: [], ...over };
}

function props(over: Partial<QueueCardProps> = {}): QueueCardProps {
  return {
    queue: [prompt('rerun the type check'), prompt('open the model picker')],
    status: 'busy',
    accent: '#0cf',
    ...over,
  };
}

const rows = (card: QueueCard): HTMLElement[] =>
  [...card.el.querySelectorAll<HTMLElement>('.acp-harness__lane-queue-row')];

describe('QueueCard', () => {
  it('emits head, numbered rows and hint, with the lane accent on the root', () => {
    const card = new QueueCard();
    card.update(props({
      queue: [
        prompt('rerun the type check', { mentionTargets: ['codex-2', 'grok-1'], images: [{}, {}] as QueuedPrompt['images'] }),
        prompt('open the model picker'),
      ],
    }));

    expect(card.el.className).toBe('acp-harness__lane-queue');
    expect(card.el.style.getPropertyValue('--acp-lane-accent')).toBe('#0cf');
    expect(card.el.querySelector('.acp-harness__lane-queue-head')?.textContent)
      .toBe('⏎ queue (2)');
    expect(card.el.querySelector('.acp-harness__lane-queue-list')?.tagName).toBe('OL');
    expect(rows(card).map((row) => row.textContent)).toEqual([
      '▸1rerun the type check→codex-2 +1img×2',
      '2open the model picker',
    ]);
    expect(rows(card)[0].className)
      .toBe('acp-harness__lane-queue-row acp-harness__lane-queue-row--next');
    expect(card.el.querySelector('.acp-harness__lane-queue-hint')?.textContent)
      .toBe('#unqueue · #queue clear');
  });

  it('dims the queue and drops the head marker while it is held behind lane mail', () => {
    const card = new QueueCard();
    card.update(props({ status: 'awaiting_peer' }));

    expect(card.el.className).toBe('acp-harness__lane-queue acp-harness__lane-queue--held');
    expect(card.el.querySelector('.acp-harness__lane-queue-head')?.textContent)
      .toBe('⏎ queue (2) · held behind lane mail');
    expect(rows(card)[0].className).toBe('acp-harness__lane-queue-row');
    expect(rows(card)[0].textContent).toBe('1rerun the type check');
  });

  it('says paused when the lane errored', () => {
    const card = new QueueCard();
    card.update(props({ status: 'error' }));
    expect(card.el.querySelector('.acp-harness__lane-queue-head')?.textContent)
      .toBe('⏎ queue (2) · paused');
  });

  it('re-derives the held modifier when the lane goes busy again', () => {
    const card = new QueueCard();
    card.update(props({ status: 'awaiting_peer' }));
    expect(card.el.className).toBe('acp-harness__lane-queue acp-harness__lane-queue--held');

    card.update(props({ status: 'busy' }));
    expect(card.el.className).toBe('acp-harness__lane-queue');
    expect(rows(card)[0].className)
      .toBe('acp-harness__lane-queue-row acp-harness__lane-queue-row--next');
  });

  it('keeps the other rows when one prompt is edited', () => {
    const card = new QueueCard();
    card.update(props({
      queue: [prompt('a'), prompt('b'), prompt('c')],
    }));
    const nodes = rows(card);

    card.update(props({ queue: [prompt('a'), prompt('b — edited'), prompt('c')] }));

    expect(rows(card)).toEqual(nodes);
    expect(nodes[1].textContent).toBe('2b — edited');
    expect(nodes[0].textContent).toBe('▸1a');
  });

  it('drops the row of a drained prompt', () => {
    const card = new QueueCard();
    card.update(props({ queue: [prompt('a'), prompt('b')] }));
    card.update(props({ queue: [prompt('b')] }));

    expect(rows(card).map((row) => row.textContent)).toEqual(['▸1b']);
  });

  it('writes nothing while the queue array holds', () => {
    const card = new QueueCard();
    const same = props();
    card.update(same);

    let mutations = 0;
    const observer = new MutationObserver((records) => {
      mutations += records.length;
    });
    observer.observe(card.el, { subtree: true, childList: true, attributes: true, characterData: true });
    card.update(same);
    mutations += observer.takeRecords().length;
    observer.disconnect();

    expect(mutations).toBe(0);
  });

  it('escapes nothing by hand — prompt text goes through the DOM', () => {
    const card = new QueueCard();
    card.update(props({ queue: [prompt('<img src=x onerror=1>')] }));
    expect(card.el.querySelector('img')).toBeNull();
    expect(card.el.querySelector('.acp-harness__lane-queue-body')?.textContent)
      .toBe('<img src=x onerror=1>');
  });

  it('tears its rows down on dispose', () => {
    const card = new QueueCard();
    card.update(props());
    card.dispose();
    expect(card.el.querySelectorAll('.acp-harness__lane-queue-row').length).toBe(0);
  });
});
