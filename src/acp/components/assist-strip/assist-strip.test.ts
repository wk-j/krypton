import { describe, expect, it } from 'vitest';

import type { AssistAction, AssistState } from '../../assist/types';
import { AssistStrip } from './index';

const ACTIONS: readonly AssistAction[] = [
  { label: 'run the failing test', prompt: 'Run the failing composer test and show the output.' },
  { label: 'check the fs_write_review path', prompt: 'Check what fs_write_review does on a rejected write.' },
  { label: 'ask why the breaker fires twice', prompt: 'Why does the assist breaker open after two failures?' },
];

const READY: AssistState = { kind: 'ready', taskId: 'next-prompt', actions: ACTIONS };

const ROWS =
  '<div class="acp-harness__assist-row">' +
  '<span class="acp-harness__assist-index">1 ▸</span>' +
  '<span class="acp-harness__assist-label">run the failing test</span></div>' +
  '<div class="acp-harness__assist-row">' +
  '<span class="acp-harness__assist-index">2 ▸</span>' +
  '<span class="acp-harness__assist-label">check the fs_write_review path</span></div>' +
  '<div class="acp-harness__assist-row">' +
  '<span class="acp-harness__assist-index">3 ▸</span>' +
  '<span class="acp-harness__assist-label">ask why the breaker fires twice</span></div>';

const HINT =
  '<div class="acp-harness__assist-hint">cmd+1-3 use · cmd+0 dismiss · cmd+/ again</div>';

/** DOM writes a run produced — 0 proves the dependency tuple held. */
function writes(node: HTMLElement, run: () => void): number {
  const observer = new MutationObserver(() => {});
  observer.observe(node, { subtree: true, childList: true, attributes: true, characterData: true });
  run();
  const records = observer.takeRecords();
  observer.disconnect();
  return records.length;
}

describe('AssistStrip', () => {
  it('hides itself and paints nothing while idle', () => {
    const strip = new AssistStrip();
    strip.update({ state: { kind: 'idle' } });

    expect(strip.el.hidden).toBe(true);
    expect(strip.el.childNodes).toHaveLength(0);
    expect(strip.el.className).toBe('acp-harness__assist');
  });

  it('says nothing about a failure — the view flashes it instead', () => {
    const strip = new AssistStrip();
    strip.update({ state: READY });
    expect(strip.el.childNodes.length).toBeGreaterThan(0);

    strip.update({ state: { kind: 'failed', taskId: 'next-prompt', reason: 'timeout' } });

    expect(strip.el.hidden).toBe(true);
    expect(strip.el.childNodes).toHaveLength(0);
  });

  it('numbers every suggestion and ends with the key legend', () => {
    const strip = new AssistStrip();
    strip.update({ state: READY });

    expect(strip.el.hidden).toBe(false);
    expect(strip.el.outerHTML).toBe(
      `<div class="acp-harness__assist" role="status">${ROWS}${HINT}</div>`,
    );
  });

  it('caps the rows at the three keys that can take them', () => {
    const strip = new AssistStrip();
    strip.update({
      state: {
        kind: 'ready',
        taskId: 'next-prompt',
        actions: [...ACTIONS, { label: 'a fourth idea', prompt: 'Nobody can press alt+4.' }],
      },
    });

    expect(strip.el.querySelectorAll('.acp-harness__assist-row')).toHaveLength(3);
    expect(strip.el.textContent).not.toContain('a fourth idea');
  });

  it('shows one dim row and no legend while the model is thinking', () => {
    const strip = new AssistStrip();
    strip.update({ state: { kind: 'pending', taskId: 'next-prompt' } });

    expect(strip.el.hidden).toBe(false);
    expect(strip.el.outerHTML).toBe(
      '<div class="acp-harness__assist" role="status">' +
        '<div class="acp-harness__assist-row acp-harness__assist-row--pending">assist · thinking…</div>' +
        '</div>',
    );
  });

  it('keeps every node when the same suggestions arrive in a new object', () => {
    const strip = new AssistStrip();
    strip.update({ state: READY });
    const before = [...strip.el.querySelectorAll('*')];

    const count = writes(strip.el, () => {
      strip.update({
        state: { kind: 'ready', taskId: 'next-prompt', actions: ACTIONS.map((action) => ({ ...action })) },
      });
    });

    expect(count).toBe(0);
    expect([...strip.el.querySelectorAll('*')]).toEqual(before);
    expect([...strip.el.querySelectorAll('*')].every((node, i) => node === before[i])).toBe(true);
  });
});
