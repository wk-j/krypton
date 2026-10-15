import { describe, expect, it } from 'vitest';

import { KeyHintBar, type KeyHintBarProps } from './index';

const REVIEW_FOOT: KeyHintBarProps = {
  block: 'acp-review__foot',
  style: 'kbd',
  hints: [
    { keys: ['h', 'l'], label: 'switch lane' },
    { keys: ['j', 'k'], label: 'select round' },
    { keys: ['enter', 'space'], label: 'expand findings' },
    { keys: ['esc'], label: 'close' },
  ],
  note: 'read-only — observation, not a score',
  noteClass: 'acp-review__foot-note',
};

const PICKER_HEAD: KeyHintBarProps = {
  block: '',
  style: 'plain',
  hints: [
    { keys: ['j/k'], label: 'move' },
    { keys: ['enter'], label: 'spawn' },
    { keys: ['esc'], label: 'cancel' },
  ],
};

describe('KeyHintBar · kbd', () => {
  it('emits the review foot exactly as the overlay builds it today', () => {
    const bar = new KeyHintBar();
    bar.update(REVIEW_FOOT);

    expect(bar.el.outerHTML).toBe(
      '<div class="acp-review__foot">' +
        '<span><kbd>h</kbd> <kbd>l</kbd> switch lane</span>' +
        '<span><kbd>j</kbd> <kbd>k</kbd> select round</span>' +
        '<span><kbd>enter</kbd> <kbd>space</kbd> expand findings</span>' +
        '<span><kbd>esc</kbd> close</span>' +
        '<span class="acp-review__foot-note">read-only — observation, not a score</span>' +
        '</div>',
    );
  });

  it('writes the triage hint straight into the container, joined by the dot', () => {
    const bar = new KeyHintBar();
    bar.update({
      block: 'acp-triage__action-hint',
      style: 'kbd',
      layout: 'bare',
      hints: [
        { keys: ['a'], label: 'acknowledge (tells lane)' },
        { keys: ['r'], label: 'redirect' },
        { keys: ['o'], label: 'dig (open lane)' },
        { keys: ['j', 'k'], label: 'prev/next', keySeparator: '/' },
        { keys: ['Esc'], label: 'close' },
      ],
    });

    expect(bar.el.outerHTML).toBe(
      '<div class="acp-triage__action-hint">' +
        '<kbd>a</kbd> acknowledge (tells lane) · ' +
        '<kbd>r</kbd> redirect · ' +
        '<kbd>o</kbd> dig (open lane) · ' +
        '<kbd>j</kbd>/<kbd>k</kbd> prev/next · ' +
        '<kbd>Esc</kbd> close' +
        '</div>',
    );
  });

  it('renders a key-less hint as bare text — the annotate pill', () => {
    const bar = new KeyHintBar();
    bar.update({
      block: 'acp-harness__anno-pill',
      style: 'kbd',
      layout: 'bare',
      hints: [
        { keys: ['c'], label: 'annotate' },
        { keys: [], label: 'Esc dismiss' },
      ],
    });

    expect(bar.el.innerHTML).toBe('<kbd>c</kbd> annotate · Esc dismiss');
  });
});

describe('KeyHintBar · plain', () => {
  it('emits one unclassed span of dot-joined text for a picker header', () => {
    const bar = new KeyHintBar('span');
    bar.update(PICKER_HEAD);

    expect(bar.el.outerHTML).toBe('<span>j/k move · enter spawn · esc cancel</span>');
    expect(bar.el.childNodes).toHaveLength(1);
  });

  it('keeps multi-token keys in one hint — the slash palette meta line', () => {
    const bar = new KeyHintBar();
    bar.update({
      block: 'acp-harness__slash-palette-meta',
      style: 'plain',
      hints: [
        { keys: ['↑↓', '/', '⌃n⌃p'], label: 'select' },
        { keys: ['Enter/Tab'], label: 'insert' },
        { keys: ['Esc'], label: 'dismiss' },
      ],
    });

    expect(bar.el.outerHTML).toBe(
      '<div class="acp-harness__slash-palette-meta">↑↓ / ⌃n⌃p select · Enter/Tab insert · Esc dismiss</div>',
    );
  });

  it('wraps the whole run in one span and the note in a second — the ticket footer', () => {
    const bar = new KeyHintBar('footer');
    bar.update({
      block: 'acp-ticket__foot',
      style: 'plain',
      layout: 'run',
      hints: [
        { keys: ['Tab'], label: 'open/closed' },
        { keys: ['↑↓', '/', '⌃n⌃p'], label: 'select' },
        { keys: ['Esc'], label: 'dismiss' },
      ],
      note: 'shared with all 3 lanes · work runs in claude-1',
    });

    expect(bar.el.outerHTML).toBe(
      '<footer class="acp-ticket__foot">' +
        '<span>Tab open/closed · ↑↓ / ⌃n⌃p select · Esc dismiss</span>' +
        '<span>shared with all 3 lanes · work runs in claude-1</span>' +
        '</footer>',
    );
  });

  it('joins the note into the text run when the caller asks for it', () => {
    const bar = new KeyHintBar();
    bar.update({
      block: 'acp-triage__action-hint',
      style: 'plain',
      hints: [
        { keys: ['Enter'], label: 'send' },
        { keys: ['Esc'], label: 'cancel' },
      ],
      note: 'delivered on the lane’s next idle',
      noteJoin: ' — ',
    });

    expect(bar.el.childNodes).toHaveLength(1);
    expect(bar.el.textContent).toBe('Enter send · Esc cancel — delivered on the lane’s next idle');
  });
});

describe('KeyHintBar · state', () => {
  it('emits no node for an absent note', () => {
    const bar = new KeyHintBar();
    bar.update({ ...REVIEW_FOOT, note: undefined, noteClass: undefined });

    expect(bar.el.children).toHaveLength(4);
    expect(bar.el.querySelector('.acp-review__foot-note')).toBeNull();
  });

  it('drops the note node when the note goes away', () => {
    const bar = new KeyHintBar();
    bar.update(REVIEW_FOOT);
    expect(bar.el.children).toHaveLength(5);

    bar.update({ ...REVIEW_FOOT, note: undefined });
    expect(bar.el.children).toHaveLength(4);
    expect(bar.el.textContent).not.toContain('observation');
  });

  it('re-derives the root class from state rather than toggling it', () => {
    const bar = new KeyHintBar('span');
    bar.update({ ...PICKER_HEAD, block: 'acp-harness__picker-hint' });
    expect(bar.el.className).toBe('acp-harness__picker-hint');

    bar.update(PICKER_HEAD);
    expect(bar.el.hasAttribute('class')).toBe(false);
  });

  it('repaints when a hint label changes and skips when nothing moved', () => {
    const bar = new KeyHintBar();
    bar.update(REVIEW_FOOT);
    const first = bar.el.firstChild;

    bar.update({ ...REVIEW_FOOT, hints: REVIEW_FOOT.hints.map((hint) => ({ ...hint })) });
    expect(bar.el.firstChild).toBe(first);

    bar.update({
      ...REVIEW_FOOT,
      hints: [{ keys: ['h', 'l'], label: 'switch pane' }, ...REVIEW_FOOT.hints.slice(1)],
    });
    expect(bar.el.firstChild).not.toBe(first);
    expect(bar.el.firstElementChild?.textContent).toBe('h l switch pane');
  });

  it('writes text through the DOM, so markup in a label stays a label', () => {
    const bar = new KeyHintBar('span');
    bar.update({ block: '', style: 'plain', hints: [{ keys: ['x'], label: '<b>bold</b>' }] });

    expect(bar.el.querySelector('b')).toBeNull();
    expect(bar.el.textContent).toBe('x <b>bold</b>');
  });
});
