import { describe, expect, it } from 'vitest';

import type { HarnessTranscriptItem } from '../../harness-view-types';
import type { RowProps } from '../transcript-row';
import { ThoughtRow } from './index';

function thought(text: string): HarnessTranscriptItem {
  return { id: 't1', kind: 'thought', text };
}

function props(item: HarnessTranscriptItem, streaming: boolean, isNew = false): RowProps {
  return { item, isNew, streaming, lane: null, projectDir: null, resolveLocalImages: false };
}

function live(item: HarnessTranscriptItem): { row: ThoughtRow; next: RowProps } {
  const next = props(item, true);
  const row = new ThoughtRow(next);
  row.update(next);
  return { row, next };
}

describe('ThoughtRow', () => {
  it('emits the thought label with no meter while the text is empty, and veils the body', () => {
    const { row } = live(thought(''));

    expect(row.el.className).toBe('acp-harness__msg acp-harness__msg--thought acp-harness__msg--streaming');
    expect(row.el.dataset.msgId).toBe('t1');
    const label = row.el.querySelector('.acp-harness__msg-label');
    expect(label?.className).toBe('acp-harness__msg-label acp-harness__msg-label--thought');
    expect(label?.textContent).toBe('thought');
    expect(label?.querySelector('.acp-harness__thought-effort')).toBeNull();
    const body = row.el.querySelector('.acp-harness__msg-body');
    expect(body?.className).toBe('acp-harness__msg-body acp-harness__msg-body--thought-veil');
    expect(body?.querySelector('.acp-harness__thought-veil-word')?.textContent).toBe('thinking');
    expect(body?.querySelectorAll('.acp-harness__thought-veil-dot')).toHaveLength(3);
  });

  it('swaps the veil for one text node and grows that node across chunks', () => {
    const item = thought('');
    const { row, next } = live(item);

    item.text = 'weighing the ';
    row.update(next);
    const first = row.el.querySelector('.acp-harness__msg-body')?.firstChild;

    item.text = 'weighing the tail window';
    row.update(next);
    const body = row.el.querySelector('.acp-harness__msg-body');

    expect(body?.querySelector('.acp-harness__thought-veil')).toBeNull();
    expect(body?.className).toBe('acp-harness__msg-body acp-harness__msg-body--stream-plain');
    expect(body?.childNodes).toHaveLength(1);
    expect(body?.firstChild).toBe(first);
    expect(body?.textContent).toBe('weighing the tail window');
  });

  it('collapses blank lines out of the streamed thought', () => {
    const item = thought('first\n\n\nsecond');
    const { row } = live(item);

    expect(row.el.querySelector('.acp-harness__msg-body')?.textContent).toBe('first\nsecond');
  });

  it('seals without replacing the live text node and shows the effort meter', () => {
    const item = thought('');
    const { row, next } = live(item);
    item.text = 'a'.repeat(300);
    row.update(next);
    const node = row.el.querySelector('.acp-harness__msg-body')?.firstChild;

    row.seal(next);

    const body = row.el.querySelector('.acp-harness__msg-body');
    expect(body?.firstChild).toBe(node);
    expect(body?.className).toBe('acp-harness__msg-body');
    expect(row.el.className).toBe('acp-harness__msg acp-harness__msg--thought');
    expect(item.streamPlainLength).toBeUndefined();
    const meter = row.el.querySelector('.acp-harness__thought-effort');
    expect(meter?.querySelector('.acp-harness__thought-effort-glyph')?.textContent).toBe('▰▰▱▱▱');
    expect(meter?.querySelector('.acp-harness__thought-effort-tier')?.textContent).toBe('considered');
  });

  it('writes nothing on the update that follows seal', () => {
    const item = thought('done thinking');
    const { row, next } = live(item);
    row.seal(next);
    const observer = new MutationObserver(() => undefined);
    observer.observe(row.el, { childList: true, subtree: true, attributes: true, characterData: true });

    row.update(next);

    expect(observer.takeRecords()).toHaveLength(0);
    observer.disconnect();
  });

  it('keeps the sealed row static when the caller still claims it is streaming', () => {
    const item = thought('x');
    const { row, next } = live(item);

    row.seal(next);

    expect(row.el.classList.contains('acp-harness__msg--streaming')).toBe(false);
    expect(row.isLive).toBe(false);
  });

  it('paints a never-streamed thought as one collapsed text node', () => {
    const next = props(thought('line\n\nline'), false);
    const row = new ThoughtRow(next);
    row.update(next);

    const body = row.el.querySelector('.acp-harness__msg-body');
    expect(body?.className).toBe('acp-harness__msg-body');
    expect(body?.childNodes).toHaveLength(1);
    expect(body?.textContent).toBe('line\nline');
  });

  it('drops the entrance listener on dispose', () => {
    const next = props(thought('hi'), false, true);
    const row = new ThoughtRow(next);
    row.update(next);
    expect(row.el.classList.contains('acp-harness__msg--enter')).toBe(true);

    row.dispose();
    row.el.dispatchEvent(new AnimationEvent('animationend', { animationName: 'acp-harness-msg-enter' }));

    expect(row.el.classList.contains('acp-harness__msg--enter')).toBe(true);
  });
});
