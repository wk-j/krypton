import { describe, expect, it } from 'vitest';

import { Caret, type CaretProps } from './index';

const paint = (props: CaretProps): Caret => {
  const caret = new Caret();
  caret.update(props);
  return caret;
};

describe('Caret', () => {
  it('emits the composer caret markup by default', () => {
    expect(paint({}).el.outerHTML).toBe('<span class="acp-harness__caret">█</span>');
  });

  it('renders the half block the triage redirect line asks for', () => {
    expect(paint({ glyph: '▋' }).el.outerHTML).toBe('<span class="acp-harness__caret">▋</span>');
  });

  it('is found by the composer bloom query and ends the text walk', () => {
    // harness-composer-bloom.ts:156,176 — querySelector plus a childNodes walk
    // that stops at the caret, so everything before it must stay a sibling.
    const input = document.createElement('span');
    input.className = 'acp-harness__input';
    input.append('hello ');
    const caret = paint({});
    input.appendChild(caret.el);
    input.append('world');

    expect(input.querySelector('.acp-harness__caret')).toBe(caret.el);
    const before = Array.from(input.childNodes).slice(0, Array.from(input.childNodes).indexOf(caret.el));
    expect(before.map((node) => node.textContent).join('')).toBe('hello ');
  });

  it('drops the blink animation through a modifier, and restores it', () => {
    const caret = paint({ blink: false });
    expect(caret.el.className).toBe('acp-harness__caret acp-harness__caret--static');

    caret.update({ blink: true });
    expect(caret.el.className).toBe('acp-harness__caret');
  });

  it('treats an omitted blink as blinking, so the existing call sites are unchanged', () => {
    const caret = paint({ blink: false });
    caret.update({});
    expect(caret.el.className).toBe('acp-harness__caret');
  });

  it('swaps the glyph in place instead of rebuilding the node', () => {
    const caret = paint({});
    const node = caret.el;

    caret.update({ glyph: '▋' });

    expect(caret.el).toBe(node);
    expect(node.textContent).toBe('▋');
  });

  it('skips the repaint while its dependency tuple holds', () => {
    const caret = paint({ glyph: '█' });
    const text = caret.el.firstChild;

    caret.update({ glyph: '█', blink: true });

    expect(caret.el.firstChild).toBe(text);
  });
});
