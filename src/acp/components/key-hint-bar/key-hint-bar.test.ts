import { describe, expect, it } from 'vitest';

import { KeyHintBar, type KeyHintBarProps } from './index';

const REVIEW_FOOT: KeyHintBarProps = {
  block: 'acp-review__foot',
  layout: 'spans',
  hints: [
    { keys: ['h', 'l'], label: 'switch lane' },
    { keys: ['j', 'k'], label: 'select round' },
    { keys: ['Enter', 'Space'], label: 'expand findings' },
    { keys: ['Esc'], label: 'close' },
  ],
  note: 'read-only — observation, not a score',
  noteClass: 'acp-review__foot-note',
};

const PICKER_HEAD: KeyHintBarProps = {
  block: '',
  hints: [
    { keys: ['j', 'k'], label: 'move', keySeparator: '/' },
    { keys: ['Enter'], label: 'spawn' },
    { keys: ['Esc'], label: 'cancel' },
  ],
};

describe('KeyHintBar · layouts', () => {
  it('emits one span per hint for an overlay foot, then the note', () => {
    const bar = new KeyHintBar();
    bar.update(REVIEW_FOOT);

    expect(bar.el.outerHTML).toBe(
      '<div class="acp-review__foot">' +
        '<span class="krypton-key-hint"><kbd>h</kbd> <kbd>l</kbd> switch lane</span>' +
        '<span class="krypton-key-hint"><kbd>j</kbd> <kbd>k</kbd> select round</span>' +
        '<span class="krypton-key-hint"><kbd>Enter</kbd> <kbd>Space</kbd> expand findings</span>' +
        '<span class="krypton-key-hint"><kbd>Esc</kbd> close</span>' +
        '<span class="acp-review__foot-note">read-only — observation, not a score</span>' +
        '</div>',
    );
  });

  it('writes a bare run straight into the container, joined by the dot', () => {
    const bar = new KeyHintBar('span');
    bar.update(PICKER_HEAD);

    expect(bar.el.outerHTML).toBe(
      '<span>' +
        '<span class="krypton-key-hint"><kbd>j</kbd>/<kbd>k</kbd> move</span> · ' +
        '<span class="krypton-key-hint"><kbd>Enter</kbd> spawn</span> · ' +
        '<span class="krypton-key-hint"><kbd>Esc</kbd> cancel</span>' +
        '</span>',
    );
  });

  it('keeps a key-less hint as bare text so a long legend can still wrap', () => {
    const bar = new KeyHintBar();
    bar.update({
      block: 'acp-triage__action-hint',
      hints: [
        { keys: ['c'], label: 'annotate' },
        { keys: [], label: 'selection armed' },
      ],
    });

    expect(bar.el.innerHTML).toBe('<span class="krypton-key-hint"><kbd>c</kbd> annotate</span> · selection armed');
  });

  it('wraps the whole run in one span and the note in a second — the ticket footer', () => {
    const bar = new KeyHintBar('footer');
    bar.update({
      block: 'acp-ticket__foot',
      layout: 'run',
      hints: [
        { keys: ['Tab'], label: 'open/closed' },
        { keys: ['Esc'], label: 'dismiss' },
      ],
      note: 'shared with all 3 lanes · work runs in claude-1',
    });

    expect(bar.el.outerHTML).toBe(
      '<footer class="acp-ticket__foot">' +
        '<span><span class="krypton-key-hint"><kbd>Tab</kbd> open/closed</span> · ' +
        '<span class="krypton-key-hint"><kbd>Esc</kbd> dismiss</span></span>' +
        '<span>shared with all 3 lanes · work runs in claude-1</span>' +
        '</footer>',
    );
  });

  it('joins the note into the run when the caller asks for it', () => {
    const bar = new KeyHintBar();
    bar.update({
      block: 'acp-triage__action-hint',
      hints: [
        { keys: ['Enter'], label: 'send' },
        { keys: ['Esc'], label: 'cancel' },
      ],
      note: 'delivered on the lane’s next idle',
      noteJoin: ' — ',
    });

    // Two hint spans and no note span: the note continues the text run.
    expect(bar.el.querySelectorAll(':scope > span')).toHaveLength(2);
    expect(bar.el.querySelectorAll('kbd')).toHaveLength(2);
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

  it('writes text through the DOM, so markup in a key or label stays text', () => {
    const bar = new KeyHintBar('span');
    bar.update({ block: '', hints: [{ keys: ['<i>'], label: '<b>bold</b>' }] });

    expect(bar.el.querySelector('b')).toBeNull();
    expect(bar.el.querySelector('i')).toBeNull();
    expect(bar.el.textContent).toBe('<i> <b>bold</b>');
  });
});
