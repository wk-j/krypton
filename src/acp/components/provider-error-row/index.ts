// Spec 302 §3.10 — `ProviderErrorRow`.
//
// The provider/API failure card (spec 123): kicker, headline, optional hint,
// a code + retryability chip pair, and the raw payload behind a `<details>`.
// Static — the payload is built once when the request fails.
//
// Ported from `harness-transcript-render.ts:909-950`
// (`renderProviderErrorBody` + `providerErrorKicker`) plus its dispatcher
// branch at `:366-369`. Markup is unchanged.

import { el } from '../../../ui/dom';
import type { ProviderErrorPayload } from '../../types';
import { TranscriptRow, type RowProps } from '../transcript-row';
import type { ComponentDef } from '../types';
import './provider-error-row.css';

/** The uppercase kicker above the headline — one per failure category. */
const KICKER: Readonly<Record<ProviderErrorPayload['category'], string>> = {
  rate_limit: 'agent limit hit',
  quota: 'agent quota hit',
  auth: 'agent auth failed',
  context: 'agent context limit',
  network: 'agent network failed',
  provider: 'agent provider failed',
  unknown: 'agent request failed',
};

export class ProviderErrorRow extends TranscriptRow {
  constructor(props: RowProps) {
    super(props, false);
  }

  protected bodyClasses(next: RowProps): readonly string[] {
    const payload = next.item.providerError;
    if (!payload) return [];
    return ['acp-harness__provider-error', `acp-harness__provider-error--${payload.category}`];
  }

  protected bodyDeps(next: RowProps): readonly unknown[] {
    const payload = next.item.providerError;
    if (!payload) return [undefined, undefined, undefined, undefined, undefined, next.item.text];
    return [
      payload.category,
      payload.code,
      payload.headline,
      payload.hint,
      payload.retryable,
      payload.raw,
    ];
  }

  protected paintBody(body: HTMLElement, next: RowProps): void {
    const payload = next.item.providerError;
    if (!payload) {
      body.textContent = next.item.text;
      return;
    }
    const meta = el('div', { class: 'acp-harness__provider-error-meta' });
    if (payload.code) {
      meta.appendChild(el('span', { class: 'acp-harness__provider-error-chip', text: payload.code }));
    }
    meta.appendChild(
      el('span', {
        class: payload.retryable
          ? 'acp-harness__provider-error-chip acp-harness__provider-error-chip--retry'
          : 'acp-harness__provider-error-chip',
        text: payload.retryable ? 'retryable' : 'not retryable',
      }),
    );
    body.replaceChildren(
      el('div', { class: 'acp-harness__provider-error-kicker', text: KICKER[payload.category] }),
      el('div', { class: 'acp-harness__provider-error-headline', text: payload.headline }),
      ...(payload.hint
        ? [el('div', { class: 'acp-harness__provider-error-hint', text: payload.hint })]
        : []),
      meta,
      el(
        'details',
        { class: 'acp-harness__provider-error-details' },
        el('summary', { text: 'details' }),
        el('pre', { text: payload.raw }),
      ),
    );
  }
}

export const def: ComponentDef = {
  id: 'provider-error-row',
  blocks: ['acp-harness__provider-error'],
};
