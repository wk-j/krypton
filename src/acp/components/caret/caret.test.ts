import { describe, expect, it } from 'vitest';

import { Caret, type CaretProps } from './index';

const paint = (props: CaretProps): Caret => {
  const caret = new Caret();
  caret.update(props);
  return caret;
};

describe('Caret', () => {
  it('emits an empty span the stylesheet paints, so no font glyph is involved', () => {
    expect(paint({}).el.outerHTML).toBe('<span class="acp-harness__caret"></span>');
  });

  it('adds no text to the line it sits in', () => {
    const line = document.createElement('span');
    line.append('redirect ', paint({}).el);

    expect(line.textContent).toBe('redirect ');
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

  it('drops the blink animation through a modifier in place, and restores it', () => {
    const caret = paint({ blink: false });
    const node = caret.el;
    expect(node.className).toBe('acp-harness__caret acp-harness__caret--static');

    caret.update({ blink: true });
    expect(caret.el).toBe(node);
    expect(node.className).toBe('acp-harness__caret');
  });

  it('treats an omitted blink as blinking, so the existing call sites are unchanged', () => {
    const caret = paint({ blink: false });
    caret.update({});
    expect(caret.el.className).toBe('acp-harness__caret');
  });
});
