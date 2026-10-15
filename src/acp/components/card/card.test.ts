import { describe, expect, it, vi } from 'vitest';

import { Card, type CardProps } from './index';

const ARTIFACT: CardProps = {
  block: 'acp-harness__artifact',
  head: {
    hint: 'f',
    glyph: '◫',
    title: 'Render path comparison',
    meta: '184.2 KB · a91f3c2',
  },
  action: 'press f to open in browser',
};

const REVIEW: CardProps = {
  block: 'acp-harness__review-card',
  head: {
    hint: 'g',
    glyph: '\u25a4',
    title: 'Review Board — spec 301',
    meta: '4 blocks · 2 steps · reference',
  },
  action: 'press g to open the review',
};

const fence = (): CardProps => ({
  block: 'acp-harness__svg-card',
  variant: 'bar',
  head: {
    title: 'svg',
    hint: '',
    toolbar: [
      {
        block: 'acp-harness__svg-card-btn',
        modifier: 'acp-harness__svg-card-btn--toggle',
        label: 'Source',
        tabIndex: -1,
        data: { 'svg-toggle': '', 'svg-index': '3' },
      },
      {
        block: 'acp-harness__svg-card-btn',
        modifier: 'acp-harness__svg-card-btn--copy',
        label: 'Copy',
        tabIndex: -1,
        data: { 'svg-copy': '', 'svg-index': '3' },
      },
    ],
  },
});

describe('Card artifact variant', () => {
  it('paints the hint/glyph/title head, the meta row and the action row into its host', () => {
    const host = document.createElement('div');
    host.className = 'acp-harness__msg-body';
    const card = new Card({ host });
    card.update(ARTIFACT);

    expect(host.innerHTML).toBe(
      '<div class="acp-harness__artifact-head">' +
        '<span class="acp-harness__artifact-hint">f</span>' +
        '<span class="acp-harness__artifact-glyph">◫</span>' +
        '<span class="acp-harness__artifact-title">Render path comparison</span>' +
        '</div>' +
        '<div class="acp-harness__artifact-meta">184.2 KB · a91f3c2</div>' +
        '<div class="acp-harness__artifact-action">press f to open in browser</div>',
    );
  });

  it('leaves the host node its own class — the artifact card has no wrapper today', () => {
    const host = document.createElement('div');
    host.className = 'acp-harness__msg-body';
    const card = new Card({ host });
    card.update(ARTIFACT);
    expect(host.className).toBe('acp-harness__msg-body');

    card.update({ ...ARTIFACT, modifiers: ['acp-harness__msg-body--wide'] });
    expect(host.className).toBe('acp-harness__msg-body acp-harness__msg-body--wide');

    card.update({ ...ARTIFACT });
    expect(host.className).toBe('acp-harness__msg-body');
  });

  it('classes the root it owns with the block, and re-derives it when a modifier goes', () => {
    const card = new Card();
    card.update({ ...ARTIFACT, modifiers: ['acp-harness__artifact--unavailable'] });
    expect(card.el.className).toBe('acp-harness__artifact acp-harness__artifact--unavailable');

    card.update(ARTIFACT);
    expect(card.el.className).toBe('acp-harness__artifact');
  });

  it('drops the hint span when the artifact loses its hint label', () => {
    const card = new Card();
    card.update(ARTIFACT);
    expect(card.el.querySelector('.acp-harness__artifact-hint')?.textContent).toBe('f');

    card.update({ ...ARTIFACT, head: { ...ARTIFACT.head, hint: undefined } });
    expect(card.el.querySelector('.acp-harness__artifact-hint')).toBeNull();
    expect(card.el.firstElementChild?.firstElementChild?.getAttribute('class')).toBe(
      'acp-harness__artifact-glyph',
    );
  });

  it('removes the meta and action rows instead of leaving stale text behind', () => {
    const card = new Card();
    card.update(ARTIFACT);
    card.update({ block: ARTIFACT.block, head: { title: ARTIFACT.head.title } });

    expect(card.el.querySelector('.acp-harness__artifact-meta')).toBeNull();
    expect(card.el.querySelector('.acp-harness__artifact-action')).toBeNull();
    expect(card.el.children.length).toBe(1);
  });
});

describe('Card review variant', () => {
  it('emits its own block and nothing from the artifact family', () => {
    const card = new Card();
    card.update(REVIEW);

    expect(card.el.innerHTML).toBe(
      '<div class="acp-harness__review-card-head">' +
        '<span class="acp-harness__review-card-hint">g</span>' +
        '<span class="acp-harness__review-card-glyph">\u25a4</span>' +
        '<span class="acp-harness__review-card-title">Review Board — spec 301</span>' +
        '</div>' +
        '<div class="acp-harness__review-card-meta">4 blocks · 2 steps · reference</div>' +
        '<div class="acp-harness__review-card-action">press g to open the review</div>',
    );
    expect(card.el.querySelectorAll('[class*="acp-harness__artifact"]').length).toBe(0);
  });
});

describe('Card fence variant', () => {
  it('emits bar > kind + hint + buttons and a preview that holds the body', () => {
    const img = document.createElement('img');
    img.alt = 'SVG preview';
    const card = new Card({ tag: 'figure' });
    card.update({ ...fence(), body: img, modifiers: ['acp-harness__svg-card--mermaid'] });

    expect(card.el.tagName).toBe('FIGURE');
    expect(card.el.className).toBe('acp-harness__svg-card acp-harness__svg-card--mermaid');

    const bar = card.el.firstElementChild;
    expect(bar?.getAttribute('class')).toBe('acp-harness__svg-card-bar');
    expect(Array.from(bar?.children ?? []).map((child) => child.tagName)).toEqual([
      'SPAN',
      'SPAN',
      'BUTTON',
      'BUTTON',
    ]);
    expect(bar?.children[0].outerHTML).toBe('<span class="acp-harness__svg-card-kind">svg</span>');
    expect(bar?.children[1].outerHTML).toBe('<span class="acp-harness__svg-card-hint" hidden=""></span>');
    expect(bar?.children[2].getAttribute('class')).toBe(
      'acp-harness__svg-card-btn acp-harness__svg-card-btn--toggle',
    );
    expect(bar?.children[2].textContent).toBe('Source');
    expect(bar?.children[3].getAttribute('data-svg-copy')).toBe('');
    // Keyboard-first: the fence buttons are clickable but never tab stops.
    expect(Array.from(bar?.querySelectorAll('button') ?? []).map((b) => b.getAttribute('tabindex'))).toEqual([
      '-1',
      '-1',
    ]);

    const preview = card.el.children[1];
    expect(preview.getAttribute('class')).toBe('acp-harness__svg-card-preview');
    expect(preview.firstElementChild).toBe(img);
  });

  it('shows the hint once the fence gets a label, without rebuilding the span', () => {
    const card = new Card({ tag: 'figure' });
    card.update(fence());
    const hint = card.el.querySelector('.acp-harness__svg-card-hint');
    expect(hint?.hasAttribute('hidden')).toBe(true);

    card.update({ ...fence(), head: { ...fence().head, hint: 's' } });
    expect(card.el.querySelector('.acp-harness__svg-card-hint')).toBe(hint);
    expect(hint?.hasAttribute('hidden')).toBe(false);
    expect(hint?.textContent).toBe('s');
  });

  it('builds the live fence card — kind only, no hint, no buttons', () => {
    const card = new Card({ tag: 'figure' });
    card.update({
      block: 'acp-harness__svg-card',
      variant: 'bar',
      modifiers: ['acp-harness__svg-card--live'],
      head: { title: 'svg' },
      body: document.createElement('img'),
    });

    const bar = card.el.firstElementChild;
    expect(bar?.children.length).toBe(1);
    expect(bar?.children[0].getAttribute('class')).toBe('acp-harness__svg-card-kind');
  });
});

describe('Card body and deps', () => {
  it('swaps the body without rebuilding the head', () => {
    const first = document.createElement('section');
    const second = document.createElement('section');
    const card = new Card();
    card.update({ ...ARTIFACT, body: first });

    const head = card.el.firstElementChild;
    const title = card.el.querySelector('.acp-harness__artifact-title');
    expect(card.el.children[2]).toBe(first);

    card.update({ ...ARTIFACT, body: second });
    expect(card.el.firstElementChild).toBe(head);
    expect(card.el.querySelector('.acp-harness__artifact-title')).toBe(title);
    expect(card.el.children[2]).toBe(second);
    expect(first.isConnected).toBe(false);
  });

  it('writes nothing while its dependency tuple holds', () => {
    const card = new Card();
    card.update(ARTIFACT);
    const title = card.el.querySelector<HTMLElement>('.acp-harness__artifact-title');
    if (title) title.textContent = 'tampered';

    card.update({ ...ARTIFACT, head: { ...ARTIFACT.head } });
    expect(title?.textContent).toBe('tampered');

    card.update({ ...ARTIFACT, head: { ...ARTIFACT.head, title: 'Other artifact' } });
    expect(title?.textContent).toBe('Other artifact');
  });
});

describe('Card toolbar', () => {
  it('keeps one button component per slot and detaches the listeners it drops', () => {
    const onFirst = vi.fn();
    const onSecond = vi.fn();
    const props = (buttons: number): CardProps => ({
      block: 'acp-harness__svg-card',
      variant: 'bar',
      head: {
        title: 'svg',
        toolbar: [
          { block: 'acp-harness__svg-card-btn', label: 'Source', onClick: onFirst },
          { block: 'acp-harness__svg-card-btn', label: 'Copy', onClick: onSecond },
        ].slice(0, buttons),
      },
    });

    const card = new Card({ tag: 'figure' });
    card.update(props(2));
    const bar = card.el.firstElementChild;
    const source = bar?.children[1] as HTMLButtonElement;
    const copy = bar?.children[2] as HTMLButtonElement;

    copy.dispatchEvent(new MouseEvent('click'));
    expect(onSecond).toHaveBeenCalledTimes(1);

    card.update(props(1));
    expect(bar?.children.length).toBe(2);
    expect(bar?.children[1]).toBe(source);
    copy.dispatchEvent(new MouseEvent('click'));
    expect(onSecond).toHaveBeenCalledTimes(1);

    source.dispatchEvent(new MouseEvent('click'));
    expect(onFirst).toHaveBeenCalledTimes(1);
    card.dispose();
    source.dispatchEvent(new MouseEvent('click'));
    expect(onFirst).toHaveBeenCalledTimes(1);
  });
});
