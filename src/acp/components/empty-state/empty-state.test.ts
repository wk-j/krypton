import { describe, expect, it } from 'vitest';

import { EmptyState } from './index';

describe('EmptyState', () => {
  it('emits the caller block on a div — the transcript placeholder', () => {
    const empty = new EmptyState();
    empty.update({ block: 'acp-harness__transcript-empty', text: 'lane transcript will appear here' });

    expect(empty.el.outerHTML).toBe(
      '<div class="acp-harness__transcript-empty">lane transcript will appear here</div>',
    );
  });

  it('renders the li and p tags the ticket dock needs', () => {
    const item = new EmptyState('li');
    item.update({ block: 'acp-ticket-dock__empty', text: 'No managed resources' });
    expect(item.el.outerHTML).toBe('<li class="acp-ticket-dock__empty">No managed resources</li>');

    const para = new EmptyState('p');
    para.update({ block: 'acp-ticket-dock__empty', text: 'No progress summary yet' });
    expect(para.el.outerHTML).toBe('<p class="acp-ticket-dock__empty">No progress summary yet</p>');
  });

  it('swaps the text in place — the session picker goes loading -> error on the same node', () => {
    const empty = new EmptyState();
    empty.update({ block: 'acp-harness__session-empty', text: 'loading sessions' });
    const node = empty.el;

    empty.update({ block: 'acp-harness__session-empty', text: 'session list unavailable' });

    expect(empty.el).toBe(node);
    expect(node.textContent).toBe('session list unavailable');
  });

  it('re-derives the class when the block changes back', () => {
    const empty = new EmptyState();
    empty.update({ block: 'acp-triage__empty', text: 'No judgement pending.' });
    empty.update({ block: 'acp-priority__empty', text: 'No judgement pending.' });
    expect(empty.el.className).toBe('acp-priority__empty');

    empty.update({ block: 'acp-triage__empty', text: 'No judgement pending.' });
    expect(empty.el.className).toBe('acp-triage__empty');
  });

  it('writes nothing while its dependency tuple holds', () => {
    const empty = new EmptyState();
    empty.update({ block: 'acp-harness__empty', text: 'no ACP lanes' });
    const text = empty.el.firstChild;

    empty.update({ block: 'acp-harness__empty', text: 'no ACP lanes' });

    expect(empty.el.firstChild).toBe(text);
  });

  it('keeps the dashboard placeholder multi-line text verbatim', () => {
    const empty = new EmptyState();
    empty.update({ block: 'acp-harness__empty', text: 'system row one\nsystem row two' });

    expect(empty.el.textContent).toBe('system row one\nsystem row two');
    expect(empty.el.childNodes.length).toBe(1);
  });

  it('renders text as text — the picker error line is never parsed as markup', () => {
    const empty = new EmptyState();
    empty.update({ block: 'acp-harness__session-empty', text: '<img src=x onerror="boom()">' });

    expect(empty.el.querySelector('img')).toBeNull();
    expect(empty.el.textContent).toBe('<img src=x onerror="boom()">');
  });
});
