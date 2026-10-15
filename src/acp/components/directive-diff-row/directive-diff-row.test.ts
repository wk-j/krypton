import { describe, expect, it } from 'vitest';

import { DirectiveDiffRow } from './index';
import type { RowProps } from '../transcript-row';
import type { HarnessTranscriptItem } from '../../harness-view-types';

const UNIFIED = ['@@ -1,3 +1,3 @@', ' keep this line', '-old directive', '+new directive'].join('\n');

function item(unified: string = UNIFIED, text = 'approve directive upsert?'): HarnessTranscriptItem {
  return { id: 'd1', kind: 'system', text, diff: { title: 'policy.md', unified } };
}

function props(next: HarnessTranscriptItem, isNew = false): RowProps {
  return { item: next, isNew, streaming: false, lane: null, projectDir: null, resolveLocalImages: false };
}

function mount(next: HarnessTranscriptItem = item()): DirectiveDiffRow {
  const row = new DirectiveDiffRow(props(next));
  row.update(props(next));
  return row;
}

describe('DirectiveDiffRow', () => {
  it('emits the prompt text and the raw diff pre, in that order', () => {
    const row = mount();

    expect(row.el.className).toBe('acp-harness__msg acp-harness__msg--system');
    expect(row.el.querySelector('.acp-harness__msg-label')?.textContent).toBe('sys');
    expect(row.el.querySelector('.acp-harness__msg-body')?.innerHTML).toBe(
      '<div class="acp-harness__msg-text">approve directive upsert?</div>' +
        '<pre class="acp-harness__directive-diff">' +
        '<div class="acp-harness__directive-diff-ctx">@@ -1,3 +1,3 @@</div>' +
        '<div class="acp-harness__directive-diff-ctx"> keep this line</div>' +
        '<div class="acp-harness__directive-diff-del">-old directive</div>' +
        '<div class="acp-harness__directive-diff-add">+new directive</div>' +
        '</pre>',
    );
  });

  it('keeps the sign in the row text and emits a row for a blank line', () => {
    const row = mount(item('+a\n\n-b'));
    const rows = [...row.el.querySelectorAll('.acp-harness__directive-diff > div')];

    expect(rows.map((r) => [r.className, r.textContent])).toEqual([
      ['acp-harness__directive-diff-add', '+a'],
      ['acp-harness__directive-diff-ctx', ''],
      ['acp-harness__directive-diff-del', '-b'],
    ]);
  });

  it('repaints the diff when the unified text changes, keeping the pre node', () => {
    const row = mount();
    const pre = row.el.querySelector('.acp-harness__directive-diff');
    const prompt = row.el.querySelector('.acp-harness__msg-text');

    row.update(props(item('+only this')));
    expect(row.el.querySelector('.acp-harness__directive-diff')).toBe(pre);
    expect(row.el.querySelector('.acp-harness__msg-text')).toBe(prompt);
    expect(pre?.children.length).toBe(1);
    expect(pre?.firstElementChild?.className).toBe('acp-harness__directive-diff-add');
  });

  it('writes nothing when neither the prompt nor the diff moved', () => {
    const row = mount();
    const first = row.el.querySelector('.acp-harness__directive-diff')?.firstElementChild;
    const prompt = row.el.querySelector('.acp-harness__msg-text')?.firstChild;

    row.update(props(item()));
    expect(row.el.querySelector('.acp-harness__directive-diff')?.firstElementChild).toBe(first);
    expect(row.el.querySelector('.acp-harness__msg-text')?.firstChild).toBe(prompt);
  });

  it('re-derives the wrapper class when the row enters and the animation ends', () => {
    const row = mount();
    const entering = new DirectiveDiffRow(props(item(), true));
    entering.update(props(item(), true));
    expect(entering.el.className).toBe(
      'acp-harness__msg acp-harness__msg--system acp-harness__msg--enter',
    );

    const event = new Event('animationend');
    Object.defineProperty(event, 'animationName', { value: 'acp-harness-msg-enter' });
    entering.el.dispatchEvent(event);
    expect(entering.el.className).toBe(row.el.className);
  });

  it('stops listening for the entrance animation once disposed', () => {
    const row = new DirectiveDiffRow(props(item(), true));
    row.update(props(item(), true));
    row.dispose();

    const event = new Event('animationend');
    Object.defineProperty(event, 'animationName', { value: 'acp-harness-msg-enter' });
    row.el.dispatchEvent(event);
    expect(row.el.className).toContain('acp-harness__msg--enter');
  });
});
