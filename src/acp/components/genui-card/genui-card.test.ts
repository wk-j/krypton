import { describe, expect, it } from 'vitest';

import type { HarnessTranscriptItem } from '../../harness-view-types';
import { decorateUiFences, patchUiHints } from './index';

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
