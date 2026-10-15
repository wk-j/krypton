import { describe, expect, it } from 'vitest';

import type { HarnessTranscriptItem, InterLanePayload } from '../../harness-view-types';
import type { RowProps } from '../transcript-row';
import { InterLaneRow, formatLaneMailMetaLine } from './index';

function mail(over: Partial<InterLanePayload> = {}): InterLanePayload {
  return { direction: 'in', peerId: 'codex-1', peerDisplayName: 'Codex-1', done: false, ...over };
}

function props(interLane: InterLanePayload | undefined, text = 'please check the deps tuple'): RowProps {
  const item: HarnessTranscriptItem = { id: 'm1', kind: 'inter_lane', text, interLane };
  return { item, isNew: false, streaming: false, lane: null, projectDir: null, resolveLocalImages: false };
}

function watch(node: HTMLElement): MutationObserver {
  const observer = new MutationObserver(() => {});
  observer.observe(node, { childList: true, subtree: true, attributes: true, characterData: true });
  return observer;
}

function mount(payload: InterLanePayload | undefined, text?: string): { row: InterLaneRow; body: HTMLElement } {
  const row = new InterLaneRow(props(payload, text));
  row.update(props(payload, text));
  const body = row.el.querySelector<HTMLElement>('.acp-harness__msg-body');
  if (!body) throw new Error('inter lane row did not paint');
  return { row, body };
}

describe('InterLaneRow', () => {
  it('emits the mail label, the meta line and the markdown body', () => {
    const { row, body } = mount(mail());

    expect(row.el.querySelector('.acp-harness__msg-label')?.textContent).toBe('mail');
    expect(body.className).toBe('acp-harness__msg-body acp-harness__msg-body--markdown');
    expect(body.firstElementChild?.outerHTML).toBe(
      '<span class="acp-harness__lane-mail-meta">← from codex-1 · lane mail</span>',
    );
    expect(body.querySelector('p')?.textContent).toBe('please check the deps tuple');
    row.dispose();
  });

  it('emits the current wrapper classes for every direction / done combination', () => {
    const cases: readonly [InterLanePayload, string][] = [
      [mail({ direction: 'in' }), 'acp-harness__msg acp-harness__msg--inter_lane acp-harness__msg--mail-in'],
      [mail({ direction: 'out' }), 'acp-harness__msg acp-harness__msg--inter_lane acp-harness__msg--mail-out'],
      [
        mail({ direction: 'in', done: true }),
        'acp-harness__msg acp-harness__msg--inter_lane acp-harness__msg--mail-in acp-harness__msg--mail-done',
      ],
      [
        mail({ direction: 'out', done: true }),
        'acp-harness__msg acp-harness__msg--inter_lane acp-harness__msg--mail-out acp-harness__msg--mail-done',
      ],
    ];
    for (const [payload, className] of cases) {
      const { row } = mount(payload);
      expect(row.el.className).toBe(className);
      row.dispose();
    }
  });

  it('re-derives the wrapper when the envelope closes, without stacking modifiers', () => {
    const payload = mail({ direction: 'out' });
    const { row, body } = mount(payload);
    const meta = body.firstElementChild;

    payload.done = true;
    row.update(props(payload));

    expect(row.el.className)
      .toBe('acp-harness__msg acp-harness__msg--inter_lane acp-harness__msg--mail-out acp-harness__msg--mail-done');
    expect(body.firstElementChild).toBe(meta);
    expect(meta?.textContent).toBe('→ to codex-1 · lane mail · closed');
    row.dispose();
  });

  it('leads the meta line with the peer backend logo', () => {
    const { row, body } = mount(mail({ peerBackendId: 'codex' }));
    const logo = body.querySelector('.acp-harness__lane-mail-logo');
    expect(logo?.className).toBe('acp-harness__lane-mail-logo acp-harness__lane-mail-logo--codex');
    const svg = logo?.firstElementChild;
    expect(svg?.tagName).toBe('svg');
    expect(svg?.hasAttribute('class')).toBe(false);
    expect(svg?.getAttribute('aria-hidden')).toBe('true');
    expect(svg?.firstElementChild?.getAttribute('href')).toBe('#krypton-logo-codex');
    row.dispose();
  });

  it('writes nothing when neither the envelope nor the text moved', () => {
    const payload = mail();
    const { row } = mount(payload);
    const observer = watch(row.el);
    row.update(props(payload));
    expect(observer.takeRecords()).toHaveLength(0);
    observer.disconnect();
    row.dispose();
  });

  it('reparses only when the message text changes', () => {
    const payload = mail();
    const row = new InterLaneRow(props(payload, 'first'));
    row.update(props(payload, 'first'));
    const body = row.el.querySelector<HTMLElement>('.acp-harness__msg-body');
    expect(body?.querySelector('p')?.textContent).toBe('first');

    row.update(props(payload, 'second'));
    expect(body?.querySelector('p')?.textContent).toBe('second');
    expect(body?.firstElementChild?.className).toBe('acp-harness__lane-mail-meta');
    row.dispose();
  });

  it('spells the meta line the way spec 120 does', () => {
    expect(formatLaneMailMetaLine(mail({ direction: 'in', peerDisplayName: 'Codex-1' })))
      .toBe('← from codex-1 · lane mail');
    expect(formatLaneMailMetaLine(mail({ direction: 'out', peerDisplayName: 'Claude-1', done: true, channel: 'mention' })))
      .toBe('→ to claude-1 · lane mail · mention · closed');
  });

  it('falls back to the item text when the payload is missing', () => {
    const { row, body } = mount(undefined, 'orphan mail');
    expect(row.el.className).toBe('acp-harness__msg acp-harness__msg--inter_lane');
    expect(body.className).toBe('acp-harness__msg-body');
    expect(body.textContent).toBe('orphan mail');
    row.dispose();
  });
});
