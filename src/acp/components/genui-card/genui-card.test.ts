import { describe, expect, it } from 'vitest';

import type { HarnessTranscriptItem } from '../../harness-view-types';
import { clearLiveUiFences, decorateUiFences, patchUiHints, syncUiPanel, updateLiveUiFences } from './index';

const spec = [
  '$seats = 10',
  'Card("Estimate", [',
  '  Slider($seats, 1, 50, label: "Seats"),',
  '  Chart("bar", ["a", "b"], [1, 2]),',
  '  Table(["x"], [["y"]]),',
  '  Metric("Total", "$" + ($seats * 29))',
  '])',
].join('\n');

function item(): HarnessTranscriptItem { return { id: 'a1', kind: 'assistant', text: '' }; }

function body(sources: readonly string[]): HTMLElement {
  const node = document.createElement('div');
  for (const source of sources) {
    const pre = document.createElement('pre');
    const code = document.createElement('code');
    code.className = 'language-krypton-ui';
    code.textContent = source;
    pre.appendChild(code);
    node.appendChild(pre);
  }
  return node;
}

describe('GenUiCard decoration', () => {
  it('makes at most two valid fences into static cards and patches their hints', () => {
    const transcriptItem = item();
    const node = body([spec, spec, spec]);
    decorateUiFences(node, transcriptItem);
    expect(node.querySelectorAll('.acp-genui-card')).toHaveLength(2);
    expect(node.querySelectorAll('pre')).toHaveLength(1);
    transcriptItem.uiFences![1].hintLabel = 'b';
    patchUiHints(node, transcriptItem);
    expect(node.querySelector('[data-genui-index="1"] .acp-genui-card__hint')?.textContent).toBe('b');
  });

  it('derives the title from the outermost Card and the summary from the catalog', () => {
    const transcriptItem = item();
    const node = body([spec]);
    decorateUiFences(node, transcriptItem);
    expect(node.querySelector('.acp-genui-card__title')?.textContent).toBe('Estimate');
    expect(node.querySelector('.acp-genui-card__summary')?.textContent).toBe('chart · table · 1 input');
    expect(transcriptItem.uiFences![0].title).toBe('Estimate');
    expect(transcriptItem.uiFences![0].summary).toBe('chart · table · 1 input');
  });

  it('names the first root when it is not a Card', () => {
    const transcriptItem = item();
    const node = body(['Chart("bar", ["a"], [1])']);
    decorateUiFences(node, transcriptItem);
    expect(node.querySelector('.acp-genui-card__title')?.textContent).toBe('Chart');
  });

  it('reuses the prior entry when index and source are unchanged', () => {
    const transcriptItem = item();
    decorateUiFences(body([spec]), transcriptItem);
    const first = transcriptItem.uiFences![0];
    first.hintLabel = 'f';
    decorateUiFences(body([spec]), transcriptItem);
    expect(transcriptItem.uiFences![0]).toBe(first);
    expect(transcriptItem.uiFences![0].hintLabel).toBe('f');
  });

  it('keeps an uncompilable spec inspectable and shows the first diagnostic', () => {
    const transcriptItem = item();
    const broken = 'Card("Estimate", [';
    const node = body([broken]);
    decorateUiFences(node, transcriptItem);
    expect(node.querySelector('.acp-genui-card')).toBeNull();
    expect(transcriptItem.uiFences).toBeUndefined();
    expect(node.querySelector('pre')?.textContent).toBe(broken);
    expect(node.querySelector('.acp-genui-card__error')?.textContent).toMatch(/UI unavailable: line 1: .+\. Source is shown below\./);
  });

  it('refuses a v1 JSON fence as source, not as a card', () => {
    const transcriptItem = item();
    const node = body(['{"version":1,"title":"Old"}']);
    decorateUiFences(node, transcriptItem);
    expect(node.querySelector('.acp-genui-card')).toBeNull();
    expect(node.querySelector('.acp-genui-card__error')?.textContent).toContain('line 1:');
  });
});

describe('GenUiCard panel seat', () => {
  it('seats the panel in the card it belongs to and clears the others', () => {
    const transcriptItem = item();
    const node = body([spec, spec]);
    decorateUiFences(node, transcriptItem);
    const panel = document.createElement('div');

    expect(syncUiPanel(node, { index: 1, panel })).toBe(true);
    const cards = [...node.querySelectorAll('.acp-genui-card')];
    expect(panel.parentElement).toBe(node.querySelector('[data-genui-slot="1"]'));
    expect(cards[1].classList.contains('acp-genui-card--open')).toBe(true);
    expect(cards[0].classList.contains('acp-genui-card--open')).toBe(false);
    expect(node.querySelector('[data-genui-index="1"]')?.getAttribute('aria-expanded')).toBe('true');
    expect(node.querySelector('[data-genui-index="0"]')?.getAttribute('aria-expanded')).toBe('false');

    expect(syncUiPanel(node, null)).toBe(false);
    expect(cards[1].classList.contains('acp-genui-card--open')).toBe(false);
    expect(node.querySelector('[data-genui-index="1"]')?.getAttribute('aria-expanded')).toBe('false');
  });

  it('reports a missing seat so the view can collapse', () => {
    const transcriptItem = item();
    const node = body([spec]);
    decorateUiFences(node, transcriptItem);
    expect(syncUiPanel(node, { index: 3, panel: document.createElement('div') })).toBe(false);
  });

  it('re-seats the same node after the row re-decorates', () => {
    const transcriptItem = item();
    const first = body([spec]);
    decorateUiFences(first, transcriptItem);
    const panel = document.createElement('div');
    syncUiPanel(first, { index: 0, panel });

    // What `paintSealed` does: pure markdown back in, cards rebuilt empty.
    const second = body([spec]);
    decorateUiFences(second, transcriptItem);
    expect(second.querySelector('[data-genui-slot="0"]')?.children).toHaveLength(0);
    expect(syncUiPanel(second, { index: 0, panel })).toBe(true);
    expect(panel.parentElement).toBe(second.querySelector('[data-genui-slot="0"]'));
  });
});

// Spec 309 revision — the fence is a program, not prose: while it streams the
// source is collapsed to one strip, so a 40-line spec does not scroll the
// reply it belongs to off screen before the card exists.
describe('GenUiCard streaming collapse', () => {
  /** smd names the code element after the whole info string, not `language-*`. */
  function liveBody(sources: readonly string[]): HTMLElement {
    const node = body(sources);
    for (const code of node.querySelectorAll('code')) code.className = 'krypton-ui';
    return node;
  }

  it('stands one strip in front of each streaming fence and counts its lines', () => {
    const node = liveBody([spec]);
    const pre = node.querySelector('pre')!;
    const code = pre.firstElementChild!;

    updateLiveUiFences(node);
    const strip = node.querySelector('.acp-genui-card--live');
    expect(strip?.previousElementSibling).toBeNull();
    expect(strip?.nextElementSibling).toBe(pre);
    expect(strip?.querySelector('.acp-genui-card__title')?.textContent).toBe('interactive UI');
    expect(strip?.querySelector('.acp-genui-card__summary')?.textContent).toBe('receiving spec · 7 lines');

    // The parser keeps appending into the <pre> it owns; the strip is reused.
    code.textContent += '\nText("more")\n';
    updateLiveUiFences(node);
    expect(node.querySelectorAll('.acp-genui-card--live')).toHaveLength(1);
    expect(node.querySelector('.acp-genui-card--live')).toBe(strip);
    expect(strip?.querySelector('.acp-genui-card__summary')?.textContent).toBe('receiving spec · 8 lines');
    expect(pre.parentElement).toBe(node);
  });

  it('collapses only the fences decoration will claim', () => {
    const node = liveBody([spec, spec, spec]);
    updateLiveUiFences(node);
    expect(node.querySelectorAll('.acp-genui-card--live')).toHaveLength(2);
  });

  it('hands the seal a body with no strip left in it', () => {
    const transcriptItem = item();
    const node = liveBody([spec]);
    updateLiveUiFences(node);

    clearLiveUiFences(node);
    expect(node.querySelector('.acp-genui-card--live')).toBeNull();

    decorateUiFences(node, transcriptItem);
    expect(node.querySelectorAll('.acp-genui-card')).toHaveLength(1);
    expect(node.querySelector('pre')).toBeNull();
  });
});
