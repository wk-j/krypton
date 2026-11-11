import { describe, expect, it } from 'vitest';

import { HIDDEN_INDICATOR_ID, SystemRow, hiddenRowsIndicatorItem, systemRowVariant } from './index';
import { rowKindFor } from '../transcript/rows';
import { noticeText, type HarnessNotice } from '../../harness-notice';
import type { RowProps } from '../transcript-row';
import type { HarnessTranscriptItem } from '../../harness-view-types';

function props(item: HarnessTranscriptItem, isNew = false): RowProps {
  return { item, isNew, streaming: false, lane: null, projectDir: null, resolveLocalImages: false };
}

function sys(text: string, id = 's1'): HarnessTranscriptItem {
  return { id, kind: 'system', text };
}

/** A notice row as `appendNotice` builds it. */
function notice(n: HarnessNotice, id = 's1'): HarnessTranscriptItem {
  return { id, kind: 'system', text: noticeText(n), notice: n };
}

function mount(item: HarnessTranscriptItem, isNew = false): SystemRow {
  const row = new SystemRow(props(item, isNew));
  row.update(props(item, isNew));
  return row;
}

describe('SystemRow — plain', () => {
  it('gives an older untyped system message a readable fallback notice', () => {
    const row = mount(sys('lane restarted — session 4f2a9c'));

    expect(row.el.className).toBe('acp-harness__msg acp-harness__msg--system');
    expect(row.el.dataset.msgId).toBe('s1');
    expect(row.el.querySelector('.acp-harness__msg-label')?.textContent).toBe('system');
    const body = row.el.querySelector('.acp-harness__msg-body');
    expect(body?.className).toBe('acp-harness__msg-body');
    expect(body?.querySelector('.acp-harness__notice-action')?.textContent).toBe('status');
    expect(body?.querySelector('.acp-harness__notice-subject')?.textContent)
      .toBe('lane restarted — session 4f2a9c');
  });

  it('keeps the actual source label for shell, memory, and restart fallback rows', () => {
    for (const [kind, label] of [
      ['shell', 'sh'], ['memory', 'mem'], ['restart', 'restart'],
    ] as const) {
      const row = mount({ id: kind, kind, text: 'details' });
      expect(row.el.querySelector('.acp-harness__msg-label')?.textContent).toBe(label);
      expect(row.el.querySelector('.acp-harness__msg-body')?.textContent).toBe('details');
    }
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
      text: '↑ 142 earlier rows hidden — ⌃H show 60 more',
    });
    expect(hiddenRowsIndicatorItem(1, 60).text).toBe('↑ 1 earlier row hidden — ⌃H show 60 more');
  });

  it('carries its modifier and never the entrance class, even when the caller says it is new', () => {
    const row = mount(hiddenRowsIndicatorItem(142, 60), true);

    expect(row.el.className).toBe(
      'acp-harness__msg acp-harness__msg--system acp-harness__msg--hidden-indicator',
    );
    expect(row.el.querySelector('.acp-harness__msg-body')?.innerHTML).toBe(
      '↑ 142 earlier rows hidden — <kbd>⌃H</kbd> show 60 more',
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
    expect(body?.textContent).toBe('↑ 82 earlier rows hidden — ⌃H show 60 more');
  });
});

describe('SystemRow — notice (spec 371)', () => {
  it('labels a lesson write and separates its action from the subject', () => {
    const row = mount(notice({
      source: 'lesson', action: 'updated', tone: 'info',
      subject: 'thai-tech-docs-no-kateeka — ตอบเป็นภาษาไทย (30/30)',
    }));

    expect(row.el.querySelector('.acp-harness__msg-label')?.textContent).toBe('lesson');
    expect(row.el.querySelector('.acp-harness__notice-action')?.textContent).toBe('updated');
    expect(row.el.querySelector('.acp-harness__notice-subject')?.textContent)
      .toBe('thai-tech-docs-no-kateeka — ตอบเป็นภาษาไทย (30/30)');
  });

  it('labels the row with its source and draws the action legend before the subject', () => {
    const row = mount(notice({ source: 'triage', action: 'flagged', tone: 'attention', subject: 'Green or amber?' }));

    expect(row.el.className).toBe('acp-harness__msg acp-harness__msg--system');
    expect(row.el.querySelector('.acp-harness__msg-label')?.textContent).toBe('triage');
    const body = row.el.querySelector('.acp-harness__msg-body');
    expect(body?.className).toBe('acp-harness__msg-body');
    expect(body?.innerHTML).toBe(
      '<span class="acp-harness__notice-action acp-harness__notice-action--attention">flagged</span>'
        + '<span class="acp-harness__notice-subject">Green or amber?</span>',
    );
  });

  it('carries the tone on the legend so only attention and fault light an LED', () => {
    const fault = mount(notice({ source: 'xenon', action: 'push failed', tone: 'fault', subject: 'offline' }));
    const info = mount(notice({ source: 'xenon', action: 'status', tone: 'info', subject: 'enabled: true' }));

    expect(fault.el.querySelector('.acp-harness__notice-action')?.className)
      .toBe('acp-harness__notice-action acp-harness__notice-action--fault');
    expect(info.el.querySelector('.acp-harness__notice-action')?.className)
      .toBe('acp-harness__notice-action acp-harness__notice-action--info');
  });

  it('draws the subject alone when the notice has no action', () => {
    const row = mount(notice({ source: 'usage', tone: 'info', subject: 'No turns recorded for 2026-11-08.' }));

    expect(row.el.querySelector('.acp-harness__msg-label')?.textContent).toBe('usage');
    expect(row.el.querySelector('.acp-harness__notice-action')).toBeNull();
    expect(row.el.querySelector('.acp-harness__msg-body')?.textContent).toBe('No turns recorded for 2026-11-08.');
  });

  it('never parses a bracket tag out of plain text', () => {
    const row = mount(sys('[triage] flagged: Green or amber?'));

    expect(row.el.querySelector('.acp-harness__msg-label')?.textContent).toBe('system');
    expect(row.el.querySelector('.acp-harness__notice-subject')?.textContent)
      .toBe('[triage] flagged: Green or amber?');
  });

  it('writes the portable line other readers get from item.text', () => {
    expect(noticeText({ source: 'triage', action: 'flagged', tone: 'attention', subject: 'Q?' })).toBe('[triage] flagged: Q?');
    expect(noticeText({ source: 'inter-lane', tone: 'info', subject: 'peer OMP-2 closed' })).toBe('[inter-lane] peer OMP-2 closed');
  });
});

describe('SystemRow — inter-lane event', () => {
  const event = (subject: string): HarnessTranscriptItem => notice({ source: 'inter-lane', tone: 'info', subject });

  it('keeps the event label and the quieter event body', () => {
    const row = mount(event('peer OMP-2 cancelled'));

    expect(row.el.className).toBe(
      'acp-harness__msg acp-harness__msg--system acp-harness__msg--harness-event',
    );
    expect(row.el.querySelector('.acp-harness__msg-label')?.textContent).toBe('event');
    const body = row.el.querySelector('.acp-harness__msg-body');
    expect(body?.className).toBe('acp-harness__msg-body acp-harness__harness-event-body');
    expect(body?.textContent).toBe('peer OMP-2 cancelled');
  });

  it('re-derives the wrapper, the label and the body class when the item stops being an event', () => {
    const row = mount(event('peer OMP-2 cancelled'));

    row.update(props(sys('lane restarted')));
    expect(row.el.className).toBe('acp-harness__msg acp-harness__msg--system');
    expect(row.el.querySelector('.acp-harness__msg-label')?.textContent).toBe('system');
    expect(row.el.querySelector('.acp-harness__msg-body')?.className).toBe('acp-harness__msg-body');
  });

  it('classifies a system item for the dispatcher', () => {
    expect(systemRowVariant(event('x'))).toBe('event');
    expect(systemRowVariant(notice({ source: 'review', action: 'recorded', tone: 'info', subject: 'x' }))).toBe('notice');
    expect(systemRowVariant(sys('plain'))).toBe('plain');
    expect(rowKindFor(event('x'))).toBe('notice');
    expect(rowKindFor(sys('plain'))).toBe('text');
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

    row.update(props(notice({ source: 'inter-lane', tone: 'info', subject: 'peer replied' })));
    expect(row.el.querySelector('.acp-harness__msg-label')).toBe(label);
    expect(row.el.querySelector('.acp-harness__msg-body')).toBe(body);
  });
});
