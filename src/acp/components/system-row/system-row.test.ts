import { describe, expect, it } from 'vitest';

import { HIDDEN_INDICATOR_ID, SystemRow, hiddenRowsIndicatorItem, systemRowVariant } from './index';
import type { RowProps } from '../transcript-row';
import type { HarnessTranscriptItem } from '../../harness-view-types';

function props(item: HarnessTranscriptItem, isNew = false): RowProps {
  return { item, isNew, streaming: false, lane: null, projectDir: null, resolveLocalImages: false };
}

function sys(text: string, id = 's1'): HarnessTranscriptItem {
  return { id, kind: 'system', text };
}

function mount(item: HarnessTranscriptItem, isNew = false): SystemRow {
  const row = new SystemRow(props(item, isNew));
  row.update(props(item, isNew));
  return row;
}

describe('SystemRow — plain', () => {
  it('emits the system chrome and the raw text', () => {
    const row = mount(sys('lane restarted — session 4f2a9c'));

    expect(row.el.className).toBe('acp-harness__msg acp-harness__msg--system');
    expect(row.el.dataset.msgId).toBe('s1');
    expect(row.el.querySelector('.acp-harness__msg-label')?.textContent).toBe('sys');
    const body = row.el.querySelector('.acp-harness__msg-body');
    expect(body?.className).toBe('acp-harness__msg-body');
    expect(body?.textContent).toBe('lane restarted — session 4f2a9c');
  });

  it('plays the entrance animation and releases it on animationend', () => {
    const row = mount(sys('lane restarted'), true);
    expect(row.el.className).toBe('acp-harness__msg acp-harness__msg--system acp-harness__msg--enter');

    const event = new Event('animationend');
    Object.defineProperty(event, 'animationName', { value: 'acp-harness-msg-enter' });
    row.el.dispatchEvent(event);
    expect(row.el.className).toBe('acp-harness__msg acp-harness__msg--system');
  });

  it('stops listening for the entrance animation once disposed', () => {
    const row = mount(sys('lane restarted'), true);
    row.dispose();

    const event = new Event('animationend');
    Object.defineProperty(event, 'animationName', { value: 'acp-harness-msg-enter' });
    row.el.dispatchEvent(event);
    expect(row.el.className).toContain('acp-harness__msg--enter');
  });
});

describe('SystemRow — hidden rows indicator', () => {
  it('builds the synthetic item the tail window prepends', () => {
    expect(hiddenRowsIndicatorItem(142, 60)).toEqual({
      id: HIDDEN_INDICATOR_ID,
      kind: 'system',
      text: '↑ 142 earlier rows hidden — Ctrl+H show 60 more',
    });
    expect(hiddenRowsIndicatorItem(1, 60).text).toBe('↑ 1 earlier row hidden — Ctrl+H show 60 more');
  });

  it('carries its modifier and never the entrance class, even when the caller says it is new', () => {
    const row = mount(hiddenRowsIndicatorItem(142, 60), true);

    expect(row.el.className).toBe(
      'acp-harness__msg acp-harness__msg--system acp-harness__msg--hidden-indicator',
    );
    expect(row.el.querySelector('.acp-harness__msg-body')?.textContent).toBe(
      '↑ 142 earlier rows hidden — Ctrl+H show 60 more',
    );
  });

  it('keeps the modifier across a text update, since the hidden count moves with the window', () => {
    const row = mount(hiddenRowsIndicatorItem(142, 60), true);
    const body = row.el.querySelector('.acp-harness__msg-body');

    row.update(props(hiddenRowsIndicatorItem(82, 60), true));
    expect(row.el.className).toBe(
      'acp-harness__msg acp-harness__msg--system acp-harness__msg--hidden-indicator',
    );
    expect(row.el.querySelector('.acp-harness__msg-body')).toBe(body);
    expect(body?.textContent).toBe('↑ 82 earlier rows hidden — Ctrl+H show 60 more');
  });
});

describe('SystemRow — inter-lane harness event', () => {
  it('relabels the row and strips the prefix from the body', () => {
    const row = mount(sys('[inter-lane] reviewer-1 finished round 2'));

    expect(row.el.className).toBe(
      'acp-harness__msg acp-harness__msg--system acp-harness__msg--harness-event',
    );
    expect(row.el.querySelector('.acp-harness__msg-label')?.textContent).toBe('event');
    const body = row.el.querySelector('.acp-harness__msg-body');
    expect(body?.className).toBe('acp-harness__msg-body acp-harness__harness-event-body');
    expect(body?.textContent).toBe('reviewer-1 finished round 2');
  });

  it('re-derives the wrapper, the label and the body class when the text stops being an event', () => {
    const row = mount(sys('[inter-lane] reviewer-1 finished round 2'));

    row.update(props(sys('lane restarted')));
    expect(row.el.className).toBe('acp-harness__msg acp-harness__msg--system');
    expect(row.el.querySelector('.acp-harness__msg-label')?.textContent).toBe('sys');
    expect(row.el.querySelector('.acp-harness__msg-body')?.className).toBe('acp-harness__msg-body');
  });

  it('classifies a system item for the dispatcher', () => {
    expect(systemRowVariant(sys('[inter-lane] x'))).toBe('event');
    expect(systemRowVariant(sys('plain'))).toBe('plain');
    expect(systemRowVariant({ ...sys('[inter-lane] x'), diff: { title: 't', unified: '+a' } })).toBe('event');
  });
});

describe('SystemRow — lifecycle', () => {
  it('writes nothing when the text has not moved', () => {
    const row = mount(sys('lane restarted'));
    const node = row.el.querySelector('.acp-harness__msg-body')?.firstChild;

    row.update(props(sys('lane restarted')));
    expect(row.el.querySelector('.acp-harness__msg-body')?.firstChild).toBe(node);
  });

  it('keeps the label and body nodes across a repaint', () => {
    const row = mount(sys('lane restarted'));
    const label = row.el.querySelector('.acp-harness__msg-label');
    const body = row.el.querySelector('.acp-harness__msg-body');

    row.update(props(sys('[inter-lane] peer replied')));
    expect(row.el.querySelector('.acp-harness__msg-label')).toBe(label);
    expect(row.el.querySelector('.acp-harness__msg-body')).toBe(body);
  });
});
