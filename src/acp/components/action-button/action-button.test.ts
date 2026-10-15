import { describe, expect, it } from 'vitest';

import { ActionButton } from './index';

describe('ActionButton', () => {
  it('emits the key hint span and a single spaced label — the ticket picker action', () => {
    const button = new ActionButton();
    button.update({
      block: 'acp-ticket__action',
      label: 'Set ticket',
      keyHint: 'Enter',
      data: { 'ticket-action': 'set-ticket' },
    });

    expect(button.el.getAttribute('type')).toBe('button');
    expect(button.el.className).toBe('acp-ticket__action');
    expect(button.el.getAttribute('data-ticket-action')).toBe('set-ticket');
    expect(button.el.innerHTML).toBe('<span class="acp-ticket__action-key">Enter</span> Set ticket');
  });

  it('appends the modifier as a second class and drops it again', () => {
    const button = new ActionButton();
    button.update({ block: 'acp-ticket__action', label: 'Fix here', modifier: 'acp-ticket__action--fix' });
    expect(button.el.className).toBe('acp-ticket__action acp-ticket__action--fix');

    button.update({ block: 'acp-ticket__action', label: 'Fix here' });
    expect(button.el.className).toBe('acp-ticket__action');
  });

  it('omits the key span entirely when there is no hint — the SVG card toolbar', () => {
    const button = new ActionButton();
    button.update({
      block: 'acp-harness__svg-card-btn',
      modifier: 'acp-harness__svg-card-btn--toggle',
      label: 'Source',
      tabIndex: -1,
      data: { 'svg-toggle': '', 'svg-index': '2' },
    });

    expect(button.el.querySelector('span')).toBeNull();
    expect(button.el.textContent).toBe('Source');
    expect(button.el.outerHTML).toBe(
      '<button type="button" class="acp-harness__svg-card-btn acp-harness__svg-card-btn--toggle"' +
        ' tabindex="-1" data-svg-toggle="" data-svg-index="2">Source</button>',
    );
  });

  it('drops tabindex when the button rejoins the tab order', () => {
    const button = new ActionButton();
    button.update({ block: 'b', label: 'Copy', tabIndex: -1 });
    expect(button.el.getAttribute('tabindex')).toBe('-1');

    button.update({ block: 'b', label: 'Copy' });
    expect(button.el.hasAttribute('tabindex')).toBe(false);
  });

  it('writes no class attribute when the caller owns no block', () => {
    const button = new ActionButton();
    button.update({ block: '', label: 'Cancel · Esc' });

    expect(button.el.hasAttribute('class')).toBe(false);
    expect(button.el.outerHTML).toBe('<button type="button">Cancel · Esc</button>');
  });

  it('renders the real disabled attribute with its reason, and removes both on re-enable', () => {
    const button = new ActionButton();
    button.update({
      block: 'acp-ticket__action',
      label: 'Analyze',
      keyHint: '⌘1',
      disabled: true,
      disabledReason: 'lane claude-1 is busy',
    });

    expect(button.el.hasAttribute('disabled')).toBe(true);
    expect((button.el as HTMLButtonElement).disabled).toBe(true);
    expect(button.el.getAttribute('title')).toBe('lane claude-1 is busy');

    button.update({
      block: 'acp-ticket__action',
      label: 'Analyze',
      keyHint: '⌘1',
      disabled: false,
      disabledReason: 'lane claude-1 is busy',
    });

    expect(button.el.hasAttribute('disabled')).toBe(false);
    expect(button.el.hasAttribute('title')).toBe(false);
  });

  it('keeps data-selected as a plain data attribute — that button stays clickable', () => {
    const button = new ActionButton();
    let clicks = 0;
    button.update({
      block: '',
      label: 'ใช้หัวข้อนี้',
      data: { selected: 'false' },
      onClick: () => {
        clicks += 1;
      },
    });

    expect(button.el.hasAttribute('disabled')).toBe(false);
    button.el.click();
    expect(clicks).toBe(1);

    button.update({ block: '', label: 'ใช้หัวข้อนี้', data: { selected: 'true' }, onClick: () => undefined });
    expect(button.el.getAttribute('data-selected')).toBe('true');
  });

  it('removes a data attribute whose key is no longer supplied', () => {
    const button = new ActionButton();
    button.update({ block: 'b', label: 'del', data: { 'anno-del': 'a1' } });
    expect(button.el.getAttribute('data-anno-del')).toBe('a1');

    button.update({ block: 'b', label: 'del' });
    expect(button.el.hasAttribute('data-anno-del')).toBe(false);
  });

  it('fires the latest handler once per click, across many updates and label swaps', () => {
    const button = new ActionButton();
    const seen: string[] = [];
    for (const label of ['send 2', 'send 2', 'send 3']) {
      button.update({
        block: 'acp-harness__anno-send',
        label,
        data: { 'anno-send': '1' },
        onClick: () => seen.push(label),
      });
    }
    const node = button.el;

    node.click();
    node.click();

    expect(seen).toEqual(['send 3', 'send 3']);
    expect(button.el).toBe(node);
    expect(node.textContent).toBe('send 3');
  });

  it('detaches its click listener on dispose', () => {
    const button = new ActionButton();
    let clicks = 0;
    button.update({
      block: 'b',
      label: 'Copy',
      onClick: () => {
        clicks += 1;
      },
    });
    button.el.click();

    button.dispose();
    button.el.click();

    expect(clicks).toBe(1);
  });

  it('skips the repaint while its dependency tuple holds, closure identity aside', () => {
    const button = new ActionButton();
    button.update({ block: 'b', label: 'Copy', keyHint: '⌘c', onClick: () => undefined });
    const key = button.el.firstChild;

    button.update({ block: 'b', label: 'Copy', keyHint: '⌘c', onClick: () => undefined });

    expect(button.el.firstChild).toBe(key);
  });

  it('carries type=submit for the form footer and restores type=button', () => {
    const button = new ActionButton();
    button.update({ block: 'acp-timeline__save', label: 'บันทึก · Cmd/Ctrl+Enter', type: 'submit' });
    expect(button.el.getAttribute('type')).toBe('submit');

    button.update({ block: 'acp-timeline__save', label: 'บันทึก · Cmd/Ctrl+Enter' });
    expect(button.el.getAttribute('type')).toBe('button');
  });
});
