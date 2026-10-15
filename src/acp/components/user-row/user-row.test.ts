import { describe, expect, it } from 'vitest';

import type { HarnessTranscriptItem } from '../../harness-view-types';
import type { RowProps } from '../transcript-row';
import { UserRow } from './index';

function user(over: Partial<HarnessTranscriptItem> = {}): HarnessTranscriptItem {
  return { id: 'u1', kind: 'user', text: 'refactor the harness view', ...over };
}

function props(item: HarnessTranscriptItem, streaming: boolean, isNew = false): RowProps {
  return { item, isNew, streaming, lane: null, projectDir: null, resolveLocalImages: false };
}

function mount(item: HarnessTranscriptItem, streaming: boolean): { row: UserRow; next: RowProps } {
  const next = props(item, streaming);
  const row = new UserRow(next);
  row.update(next);
  return { row, next };
}

describe('UserRow', () => {
  it('emits the default user label and one body text node', () => {
    const { row } = mount(user(), false);

    expect(row.el.className).toBe('acp-harness__msg acp-harness__msg--user');
    const label = row.el.querySelector('.acp-harness__msg-label');
    expect(label?.className).toBe('acp-harness__msg-label');
    expect(label?.textContent).toBe('user');
    const body = row.el.querySelector('.acp-harness__msg-body');
    expect(body?.className).toBe('acp-harness__msg-body');
    expect(body?.childNodes).toHaveLength(1);
    expect(body?.textContent).toBe('refactor the harness view');
  });

  it('reads `steer…` while the steer is pending and `steer` once it is taken', () => {
    const item = user({ steer: 'pending' });
    const { row, next } = mount(item, false);
    const label = row.el.querySelector('.acp-harness__msg-label');

    expect(label?.textContent).toBe('steer…');
    expect(label?.className).toBe(
      'acp-harness__msg-label acp-harness__msg-label--steer acp-harness__msg-label--steer-pending',
    );

    item.steer = 'injected';
    row.update(next);

    expect(label?.textContent).toBe('steer');
    expect(label?.className).toBe('acp-harness__msg-label acp-harness__msg-label--steer');
  });

  it('appends the voice marker to whichever label the row carries', () => {
    const { row } = mount(user({ voice: true }), false);
    const steered = mount(user({ steer: 'injected', voice: true }), false);

    expect(row.el.querySelector('.acp-harness__msg-label')?.textContent).toBe('user · voice');
    expect(row.el.querySelector('.acp-harness__msg-label')?.className).toBe(
      'acp-harness__msg-label acp-harness__msg-label--voice',
    );
    expect(steered.row.el.querySelector('.acp-harness__msg-label')?.textContent).toBe('steer · voice');
  });

  it('grows one text node across chunks while live', () => {
    const item = user({ text: 'open ' });
    const { row, next } = mount(item, true);
    const body = row.el.querySelector('.acp-harness__msg-body');
    const node = body?.firstChild;
    expect(body?.className).toBe('acp-harness__msg-body acp-harness__msg-body--stream-plain');

    item.text = 'open the model ';
    row.update(next);
    item.text = 'open the model picker';
    row.update(next);

    expect(body?.childNodes).toHaveLength(1);
    expect(body?.firstChild).toBe(node);
    expect(body?.textContent).toBe('open the model picker');
    expect(item.streamPlainLength).toBe('open the model picker'.length);
  });

  it('rewrites the node when the stream backtracks', () => {
    const item = user({ text: 'abcdef' });
    const { row, next } = mount(item, true);
    const node = row.el.querySelector('.acp-harness__msg-body')?.firstChild;

    item.text = 'abc';
    row.update(next);

    expect(row.el.querySelector('.acp-harness__msg-body')?.firstChild).toBe(node);
    expect(row.el.textContent).toContain('abc');
    expect(item.streamPlainLength).toBe(3);
  });

  it('seals into the same node, drops --streaming, and then writes nothing', () => {
    const item = user({ text: 'ship it' });
    const { row, next } = mount(item, true);
    const node = row.el.querySelector('.acp-harness__msg-body')?.firstChild;

    row.seal(next);

    expect(row.el.className).toBe('acp-harness__msg acp-harness__msg--user');
    expect(row.el.querySelector('.acp-harness__msg-body')?.className).toBe('acp-harness__msg-body');
    expect(row.el.querySelector('.acp-harness__msg-body')?.firstChild).toBe(node);
    expect(item.streamPlainLength).toBeUndefined();

    const observer = new MutationObserver(() => undefined);
    observer.observe(row.el, { childList: true, subtree: true, attributes: true, characterData: true });
    row.update(next);
    expect(observer.takeRecords()).toHaveLength(0);
    observer.disconnect();
  });

  it('drops the entrance listener on dispose', () => {
    const next = props(user(), false, true);
    const row = new UserRow(next);
    row.update(next);
    expect(row.el.classList.contains('acp-harness__msg--enter')).toBe(true);

    row.dispose();
    row.el.dispatchEvent(new AnimationEvent('animationend', { animationName: 'acp-harness-msg-enter' }));

    expect(row.el.classList.contains('acp-harness__msg--enter')).toBe(true);
  });
});
