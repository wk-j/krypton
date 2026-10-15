import { describe, expect, it } from 'vitest';

import type { HarnessTranscriptItem } from '../../harness-view-types';
import type { ProviderErrorPayload } from '../../types';
import type { RowProps } from '../transcript-row';
import { ProviderErrorRow } from './index';

function error(over: Partial<ProviderErrorPayload> = {}): ProviderErrorPayload {
  return {
    category: 'rate_limit',
    code: '429',
    headline: 'rate limited — retry in 32s',
    retryable: true,
    raw: '{"error":{"type":"rate_limit_error"}}',
    ...over,
  };
}

function props(providerError: ProviderErrorPayload | undefined): RowProps {
  const item: HarnessTranscriptItem = { id: 'e1', kind: 'provider_error', text: 'failed', providerError };
  return { item, isNew: false, streaming: false, lane: null, projectDir: null, resolveLocalImages: false };
}

function watch(node: HTMLElement): MutationObserver {
  const observer = new MutationObserver(() => {});
  observer.observe(node, { childList: true, subtree: true, attributes: true, characterData: true });
  return observer;
}

function mount(payload: ProviderErrorPayload | undefined): { row: ProviderErrorRow; body: HTMLElement } {
  const row = new ProviderErrorRow(props(payload));
  row.update(props(payload));
  const body = row.el.querySelector<HTMLElement>('.acp-harness__msg-body');
  if (!body) throw new Error('provider error row did not paint');
  return { row, body };
}

describe('ProviderErrorRow', () => {
  it('emits kicker, headline, chips and the raw details block', () => {
    const { row, body } = mount(error());

    expect(row.el.className).toBe('acp-harness__msg acp-harness__msg--provider_error');
    expect(row.el.querySelector('.acp-harness__msg-label')?.textContent).toBe('agent');
    expect(body.className)
      .toBe('acp-harness__msg-body acp-harness__provider-error acp-harness__provider-error--rate_limit');
    expect(body.innerHTML).toBe(
      '<div class="acp-harness__provider-error-kicker">agent limit hit</div>' +
      '<div class="acp-harness__provider-error-headline">rate limited — retry in 32s</div>' +
      '<div class="acp-harness__provider-error-meta">' +
        '<span class="acp-harness__provider-error-chip">429</span>' +
        '<span class="acp-harness__provider-error-chip acp-harness__provider-error-chip--retry">retryable</span>' +
      '</div>' +
      '<details class="acp-harness__provider-error-details">' +
        '<summary>details</summary>' +
        '<pre>{"error":{"type":"rate_limit_error"}}</pre>' +
      '</details>',
    );
    row.dispose();
  });

  it('names every category in the kicker', () => {
    const kickers: Record<ProviderErrorPayload['category'], string> = {
      rate_limit: 'agent limit hit',
      quota: 'agent quota hit',
      auth: 'agent auth failed',
      context: 'agent context limit',
      network: 'agent network failed',
      provider: 'agent provider failed',
      unknown: 'agent request failed',
    };
    for (const [category, text] of Object.entries(kickers)) {
      const { row, body } = mount(error({ category: category as ProviderErrorPayload['category'] }));
      expect(body.querySelector('.acp-harness__provider-error-kicker')?.textContent).toBe(text);
      expect(body.className).toContain(`acp-harness__provider-error--${category}`);
      row.dispose();
    }
  });

  it('adds the hint line only when the payload carries one', () => {
    const payload = error({ hint: 'switch to a smaller model' });
    const { row, body } = mount(payload);
    expect(body.children[2].outerHTML)
      .toBe('<div class="acp-harness__provider-error-hint">switch to a smaller model</div>');

    payload.hint = undefined;
    row.update(props(payload));
    expect(body.querySelector('.acp-harness__provider-error-hint')).toBeNull();
    row.dispose();
  });

  it('drops the retry modifier when the error stops being retryable', () => {
    const payload = error();
    const { row, body } = mount(payload);

    payload.retryable = false;
    payload.code = undefined;
    row.update(props(payload));

    const chips = [...body.querySelectorAll('.acp-harness__provider-error-chip')];
    expect(chips).toHaveLength(1);
    expect(chips[0].className).toBe('acp-harness__provider-error-chip');
    expect(chips[0].textContent).toBe('not retryable');
    row.dispose();
  });

  it('re-derives the category modifier instead of stacking a second one', () => {
    const payload = error();
    const { row, body } = mount(payload);

    payload.category = 'auth';
    row.update(props(payload));

    expect(body.className)
      .toBe('acp-harness__msg-body acp-harness__provider-error acp-harness__provider-error--auth');
    row.dispose();
  });

  it('writes nothing when nothing moved', () => {
    const payload = error();
    const { row } = mount(payload);
    const observer = watch(row.el);
    row.update(props(payload));
    expect(observer.takeRecords()).toHaveLength(0);
    observer.disconnect();
    row.dispose();
  });

  it('falls back to the item text when the payload is missing', () => {
    const { row, body } = mount(undefined);
    expect(body.className).toBe('acp-harness__msg-body');
    expect(body.textContent).toBe('failed');
    row.dispose();
  });
});
