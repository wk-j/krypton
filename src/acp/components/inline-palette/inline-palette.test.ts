import { describe, expect, it, vi } from 'vitest';

import {
  InlinePalette,
  clampPaletteCursor,
  nextPaletteCursor,
  prevPaletteCursor,
  type InlinePaletteProps,
  type InlinePaletteRow,
} from './index';

const SELECT_INSERT = '↑↓ / ⌃n⌃p select · Enter/Tab insert · Esc dismiss';
const SELECT_COMPLETE = '↑↓ / ⌃n⌃p select · Tab complete · Esc dismiss';
const INJECT_VERB = 'inject verb · ↑↓ / ⌃n⌃p select · Tab insert · Esc dismiss';

const ROW = '.acp-harness__slash-palette-row';
const SELECTED = 'acp-harness__slash-palette-row acp-harness__slash-palette-row--selected';

interface Command {
  readonly name: string;
  readonly inputHint?: string;
  readonly description?: string;
}

const slashProps = (
  matches: readonly Command[],
  cursor: number,
  commit?: (item: Command, index: number) => void,
): InlinePaletteProps<Command> => ({
  variant: 'slash',
  matches,
  cursor,
  hint: SELECT_INSERT,
  row: (cmd: Command): InlinePaletteRow => ({
    name: `/${cmd.name}`,
    hint: cmd.inputHint || undefined,
    desc: cmd.description || undefined,
  }),
  commit,
});

const SLASH_COMMANDS: readonly Command[] = [
  { name: 'resume', inputHint: '<session>', description: 'resume a previous session' },
  { name: 'compact', description: 'compact the context window' },
];

const paint = <T,>(props: InlinePaletteProps<T>): InlinePalette<T> => {
  const palette = new InlinePalette<T>();
  palette.update(props);
  return palette;
};

describe('InlinePalette markup', () => {
  it('reproduces the slash renderer, plus the data-palette discriminator', () => {
    const palette = paint(slashProps(SLASH_COMMANDS, 0));

    expect(palette.el.outerHTML).toBe(
      '<div class="acp-harness__slash-palette" data-count="2" data-palette="slash">' +
        `<div class="acp-harness__slash-palette-meta">${SELECT_INSERT}</div>` +
        `<div class="${SELECTED}">` +
        '<span class="acp-harness__slash-palette-name">/resume</span>' +
        '<span class="acp-harness__slash-palette-hint">&lt;session&gt;</span>' +
        '<span class="acp-harness__slash-palette-desc">resume a previous session</span>' +
        '</div>' +
        '<div class="acp-harness__slash-palette-row">' +
        '<span class="acp-harness__slash-palette-name">/compact</span>' +
        '<span class="acp-harness__slash-palette-desc">compact the context window</span>' +
        '</div>' +
        '</div>',
    );
  });

  it('reproduces the mention renderer — name only, no hint or desc span', () => {
    const palette = paint({
      variant: 'mention',
      matches: ['scout', 'reviewer'],
      cursor: 1,
      hint: SELECT_INSERT,
      row: (name: string): InlinePaletteRow => ({ name: `@${name}` }),
    });

    expect(palette.el.outerHTML).toBe(
      '<div class="acp-harness__slash-palette" data-count="2" data-palette="mention">' +
        `<div class="acp-harness__slash-palette-meta">${SELECT_INSERT}</div>` +
        '<div class="acp-harness__slash-palette-row">' +
        '<span class="acp-harness__slash-palette-name">@scout</span>' +
        '</div>' +
        `<div class="${SELECTED}">` +
        '<span class="acp-harness__slash-palette-name">@reviewer</span>' +
        '</div>' +
        '</div>',
    );
  });

  it('reproduces the hash renderer, whose desc span is emitted even when empty', () => {
    const palette = paint({
      variant: 'hash',
      matches: [
        { name: 'cancel', args: '', description: 'cancel the current turn' },
        { name: 'model', args: '<name>', description: '' },
      ],
      cursor: 0,
      hint: SELECT_COMPLETE,
      row: (cmd: { name: string; args: string; description: string }): InlinePaletteRow => ({
        name: `#${cmd.name}`,
        hint: cmd.args || undefined,
        desc: cmd.description,
      }),
    });

    expect(palette.el.outerHTML).toBe(
      '<div class="acp-harness__slash-palette" data-count="2" data-palette="hash">' +
        `<div class="acp-harness__slash-palette-meta">${SELECT_COMPLETE}</div>` +
        `<div class="${SELECTED}">` +
        '<span class="acp-harness__slash-palette-name">#cancel</span>' +
        '<span class="acp-harness__slash-palette-desc">cancel the current turn</span>' +
        '</div>' +
        '<div class="acp-harness__slash-palette-row">' +
        '<span class="acp-harness__slash-palette-name">#model</span>' +
        '<span class="acp-harness__slash-palette-hint">&lt;name&gt;</span>' +
        '<span class="acp-harness__slash-palette-desc"></span>' +
        '</div>' +
        '</div>',
    );
  });

  it('reproduces the inline verb renderer, braces and all', () => {
    const palette = paint({
      variant: 'verb',
      matches: [{ name: 'review', description: 'fan the diff out to reviewer lanes' }],
      cursor: 0,
      hint: INJECT_VERB,
      row: (entry: { name: string; description: string }): InlinePaletteRow => ({
        name: `{{#${entry.name}}}`,
        desc: entry.description || undefined,
      }),
    });

    expect(palette.el.outerHTML).toBe(
      '<div class="acp-harness__slash-palette" data-count="1" data-palette="verb">' +
        `<div class="acp-harness__slash-palette-meta">${INJECT_VERB}</div>` +
        `<div class="${SELECTED}">` +
        '<span class="acp-harness__slash-palette-name">{{#review}}</span>' +
        '<span class="acp-harness__slash-palette-desc">fan the diff out to reviewer lanes</span>' +
        '</div>' +
        '</div>',
    );
  });
});

describe('InlinePalette cursor', () => {
  it('moves the selected modifier without rebuilding a single row node', () => {
    const palette = paint(slashProps(SLASH_COMMANDS, 0));
    const rows = [...palette.el.querySelectorAll(ROW)];

    palette.update(slashProps(SLASH_COMMANDS, 1));

    expect([...palette.el.querySelectorAll(ROW)]).toEqual(rows);
    expect(rows[0].className).toBe('acp-harness__slash-palette-row');
    expect(rows[1].className).toBe(SELECTED);
  });

  it('re-derives the row class when the cursor comes back', () => {
    const palette = paint(slashProps(SLASH_COMMANDS, 1));
    palette.update(slashProps(SLASH_COMMANDS, 0));

    const rows = [...palette.el.querySelectorAll(ROW)];
    expect(rows[0].className).toBe(SELECTED);
    expect(rows[1].className).toBe('acp-harness__slash-palette-row');
  });

  it('clamps an out-of-range cursor onto the last row, as every renderer does', () => {
    const palette = paint(slashProps(SLASH_COMMANDS, 7));

    expect(palette.selectedIndex).toBe(1);
    expect(palette.el.querySelector('.acp-harness__slash-palette-row--selected')?.textContent).toBe(
      '/compactcompact the context window',
    );
  });

  it('wraps in both directions and survives an empty list', () => {
    expect(nextPaletteCursor(2, 3)).toBe(0);
    expect(prevPaletteCursor(0, 3)).toBe(2);
    expect(nextPaletteCursor(0, 0)).toBe(0);
    expect(prevPaletteCursor(0, 0)).toBe(0);
    expect(clampPaletteCursor(9, 3)).toBe(2);
    expect(clampPaletteCursor(1, 0)).toBe(0);
  });

  // Replaces the source-text assertion at hash-commands.test.ts:90, which
  // grepped `acp-harness-view.ts` for the `scrollIntoView` call that moved
  // into this component.
  it('keeps the newly selected row in view after a cursor move', () => {
    const scrollIntoView = vi.fn();
    const original = Element.prototype.scrollIntoView;
    Element.prototype.scrollIntoView = scrollIntoView;
    try {
      const palette = paint(slashProps(SLASH_COMMANDS, 0));
      scrollIntoView.mockClear();

      palette.update(slashProps(SLASH_COMMANDS, 1));

      expect(scrollIntoView).toHaveBeenCalledWith({ block: 'nearest' });
      expect(scrollIntoView.mock.contexts[0]).toBe(palette.el.querySelectorAll(ROW)[1]);
    } finally {
      Element.prototype.scrollIntoView = original;
    }
  });
});

describe('InlinePalette empty list', () => {
  it('renders the zero state as the meta line when one is supplied', () => {
    const palette = paint({
      variant: 'mention',
      matches: [] as readonly string[],
      cursor: 0,
      hint: SELECT_INSERT,
      row: (name: string): InlinePaletteRow => ({ name }),
      zeroState: 'no matching lanes · Esc dismiss',
    });

    expect(palette.el.hidden).toBe(false);
    expect(palette.el.outerHTML).toBe(
      '<div class="acp-harness__slash-palette" data-count="0" data-palette="mention">' +
        '<div class="acp-harness__slash-palette-meta">no matching lanes · Esc dismiss</div>' +
        '</div>',
    );
  });

  it('renders nothing when no zero state is supplied', () => {
    const palette = paint(slashProps([], 0));

    expect(palette.el.hidden).toBe(true);
    expect(palette.el.childNodes.length).toBe(0);
  });

  it('drops the rows when the matches go away and brings them back', () => {
    const palette = paint(slashProps(SLASH_COMMANDS, 0));
    palette.update(slashProps([], 0));
    expect(palette.el.hidden).toBe(true);
    expect(palette.el.childNodes.length).toBe(0);

    palette.update(slashProps(SLASH_COMMANDS, 0));
    expect(palette.el.hidden).toBe(false);
    expect(palette.el.querySelectorAll(ROW).length).toBe(2);
    expect(palette.el.getAttribute('data-count')).toBe('2');
  });
});

describe('InlinePalette updates', () => {
  it('writes nothing to the DOM while its dependency tuple holds', () => {
    const palette = paint(slashProps(SLASH_COMMANDS, 0));
    const nameText = palette.el.querySelector('.acp-harness__slash-palette-name')?.firstChild;

    palette.update(slashProps(SLASH_COMMANDS, 0));

    expect(palette.el.querySelector('.acp-harness__slash-palette-name')?.firstChild).toBe(nameText);
  });

  it('repaints when a row text changes even though the match count did not', () => {
    const palette = paint(slashProps(SLASH_COMMANDS, 0));
    palette.update(slashProps([SLASH_COMMANDS[0], { name: 'clear' }], 0));

    const rows = [...palette.el.querySelectorAll(ROW)];
    expect(rows[1].textContent).toBe('/clear');
    expect(rows[1].querySelector('.acp-harness__slash-palette-desc')).toBeNull();
  });

  it('drops a desc span that is no longer supplied instead of leaving a stale one', () => {
    const palette = paint(slashProps([{ name: 'resume', description: 'resume it' }], 0));
    palette.update(slashProps([{ name: 'resume' }], 0));

    expect(palette.el.querySelector('.acp-harness__slash-palette-desc')).toBeNull();
    expect(palette.el.querySelector(ROW)?.textContent).toBe('/resume');
  });
});

describe('InlinePalette commit', () => {
  it('commits the clamped selection, which is what the key table calls', () => {
    const picked: Command[] = [];
    const palette = paint(slashProps(SLASH_COMMANDS, 5, (cmd: Command): number => picked.push(cmd)));

    expect(palette.commitSelected()).toBe(true);
    expect(picked).toEqual([SLASH_COMMANDS[1]]);
  });

  it('reports nothing to commit on an empty palette', () => {
    const palette = paint(slashProps([], 0, (): void => {}));
    expect(palette.commitSelected()).toBe(false);
  });

  it('commits the row the pointer pressed, and keeps composer focus', () => {
    const picked: number[] = [];
    const palette = paint(
      slashProps(SLASH_COMMANDS, 0, (_cmd: Command, index: number): number => picked.push(index)),
    );
    const row = palette.el.querySelectorAll(ROW)[1];
    const event = new MouseEvent('mousedown', { bubbles: true, cancelable: true });

    row.querySelector('.acp-harness__slash-palette-name')?.dispatchEvent(event);

    expect(picked).toEqual([1]);
    expect(event.defaultPrevented).toBe(true);
  });

  it('detaches its pointer listener on dispose', () => {
    const picked: number[] = [];
    const palette = paint(
      slashProps(SLASH_COMMANDS, 0, (_cmd: Command, index: number): number => picked.push(index)),
    );
    const row = palette.el.querySelectorAll(ROW)[1];

    palette.dispose();
    expect(palette.el.childNodes.length).toBe(0);

    palette.el.appendChild(row);
    row.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true }));

    expect(picked).toEqual([]);
  });
});
