import { describe, expect, it } from 'vitest';

import { dictationPreviewParts } from '../../harness-dictation';
import { DraftLine, type DraftLineProps } from './index';

const BASE: DraftLineProps = {
  laneName: 'claude-1',
  running: true,
  draft: 'convert the UI into reusable components',
  cursor: 33,
  ghost: null,
  dictation: null,
};

const writes = (el: HTMLElement, run: () => void): number => {
  const observer = new MutationObserver(() => {});
  observer.observe(el, { subtree: true, childList: true, attributes: true, characterData: true });
  run();
  const records = observer.takeRecords();
  observer.disconnect();
  return records.length;
};

const mount = (props: DraftLineProps = BASE): DraftLine => {
  const line = new DraftLine();
  line.update(props);
  return line;
};

describe('DraftLine', () => {
  it('emits the lane tag, the running prompt and the draft split at the caret', () => {
    const line = mount();

    expect(line.el.outerHTML).toBe(
      '<div class="acp-harness__input-line">' +
        '<span class="acp-harness__lane-tag">claude-1</span>' +
        '<span class="acp-harness__prompt"><span class="acp-harness__spinner">⠋</span></span>' +
        '<span class="acp-harness__input">convert the UI into reusable comp' +
        '<span class="acp-harness__caret">█</span>onents</span>' +
        '</div>',
    );
  });

  it('drops the spinner class when the lane stops, keeping the glyph node', () => {
    const line = mount();
    const glyph = line.el.querySelector<HTMLElement>('.acp-harness__spinner');

    line.update({ ...BASE, running: false });

    expect(line.el.querySelector('.acp-harness__spinner')).toBeNull();
    expect(glyph?.textContent).toBe('⠋');
    expect(line.el.querySelector('.acp-harness__prompt')?.firstChild).toBe(glyph);
  });

  it('moves the caret on a keystroke without rebuilding the tag or the glyph', () => {
    const line = mount();
    const tag = line.el.querySelector('.acp-harness__lane-tag');
    const glyph = line.el.querySelector('.acp-harness__spinner');
    const caret = line.el.querySelector('.acp-harness__caret');
    const input = line.el.querySelector('.acp-harness__input');

    line.update({ ...BASE, draft: 'convert the UI into reusable compX onents', cursor: 34 });

    expect(line.el.querySelector('.acp-harness__lane-tag')).toBe(tag);
    expect(line.el.querySelector('.acp-harness__spinner')).toBe(glyph);
    expect(line.el.querySelector('.acp-harness__caret')).toBe(caret);
    expect(line.el.querySelector('.acp-harness__input')).toBe(input);
    expect(input?.firstChild?.textContent).toBe('convert the UI into reusable compX');
    expect(input?.lastChild?.textContent).toBe(' onents');
  });

  it('keeps the composer-bloom contract: caret found, text before it in sibling text nodes', () => {
    const line = mount();
    const input = line.el.querySelector<HTMLElement>('.acp-harness__input');
    const caret = input?.querySelector('.acp-harness__caret');

    expect(caret).not.toBeNull();
    let length = 0;
    for (const child of Array.from(input?.childNodes ?? [])) {
      if (child === caret) break;
      expect(child.nodeType).toBe(Node.TEXT_NODE);
      length += (child as Text).data.length;
    }
    expect(length).toBe(BASE.cursor);
  });

  it('never wipes the input, so the bloom particle layer survives a keystroke', () => {
    const line = mount();
    const input = line.el.querySelector<HTMLElement>('.acp-harness__input');
    const layer = document.createElement('div');
    layer.className = 'acp-harness__composer-blooms';
    input?.appendChild(layer);

    line.update({ ...BASE, draft: `${BASE.draft}!`, cursor: BASE.cursor + 1 });

    expect(layer.parentElement).toBe(input);
  });

  it('puts the ghost between the caret and the rest of the draft, then removes it', () => {
    const line = mount({ ...BASE, draft: 'convert the comp', cursor: 16, ghost: 'onent' });
    const input = line.el.querySelector<HTMLElement>('.acp-harness__input');

    expect(input?.innerHTML).toBe(
      'convert the comp<span class="acp-harness__caret">█</span>' +
        '<span class="acp-harness__ghost" aria-hidden="true">onent</span>',
    );

    line.update({ ...BASE, draft: 'convert the comp', cursor: 16, ghost: null });
    expect(input?.querySelector('.acp-harness__ghost')).toBeNull();
  });

  it('swaps the input for the dictation preview and back', () => {
    const line = mount();
    const typed = line.el.querySelector('.acp-harness__input');
    const parts = dictationPreviewParts('convert the', 11, 'UI into', 'reusable');

    line.update({ ...BASE, dictation: parts });

    const preview = line.el.querySelector('.acp-harness__input');
    expect(preview).not.toBe(typed);
    expect(typed?.parentElement).toBeNull();
    expect(line.el.querySelectorAll('.acp-harness__input')).toHaveLength(1);
    expect(preview?.querySelector('[data-dictation-final]')?.textContent).toBe('UI into ');
    expect(preview?.querySelector('[data-dictation-interim]')?.textContent).toBe('reusable');
    expect(preview?.querySelector('.acp-harness__caret')).not.toBeNull();

    line.update(BASE);
    expect(line.el.querySelector('.acp-harness__input')).toBe(typed);
  });

  it('writes nothing when nothing in the draft moved', () => {
    const line = mount();
    const count = writes(line.el, () => {
      line.update({ ...BASE });
    });
    expect(count).toBe(0);
  });

  it('clamps a cursor past the end of the draft', () => {
    const line = mount({ ...BASE, draft: 'hi', cursor: 99 });
    const input = line.el.querySelector<HTMLElement>('.acp-harness__input');
    expect(input?.firstChild?.textContent).toBe('hi');
    expect(input?.lastChild?.textContent).toBe('');
  });

  it('releases the spinner on dispose so a later tick cannot reach it', () => {
    const line = mount();
    line.dispose();
    expect(() => line.dispose()).not.toThrow();
  });
});
