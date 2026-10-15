import { afterEach, describe, expect, it } from 'vitest';

import type { JudgementItem } from '../../types';
import { TriageOverlay, type TriageOverlayProps } from './index';

const overlays: TriageOverlay[] = [];

const item = (over: Partial<JudgementItem> = {}): JudgementItem => ({
  id: 'j1',
  laneId: 'lane-1',
  packetId: 'p1',
  question: 'Drop the signature cache?',
  chosen: 'Delete it and compare deps per component',
  rationale: 'the signature is a second source of truth',
  tradedOff: ['keep the cache', 'add a dirty flag'],
  uncertainty: 'row identity under a sliding window',
  reversibility: 'costly',
  diffstat: [{ path: 'src/ui/list.ts', status: 'M', added: 18, removed: 4 }],
  createdAt: 0,
  status: 'open',
  ...over,
});

const props = (over: Partial<TriageOverlayProps> = {}): TriageOverlayProps => ({
  open: true,
  items: [item()],
  selectedIndex: 0,
  laneName: (id) => (id === 'lane-1' ? 'claude-1' : id),
  laneStats: () => null,
  redirect: null,
  silentPileCount: 0,
  ...over,
});

const mount = (over: Partial<TriageOverlayProps> = {}): TriageOverlay => {
  const overlay = new TriageOverlay();
  overlays.push(overlay);
  overlay.update(props(over));
  return overlay;
};

afterEach(() => {
  for (const overlay of overlays.splice(0)) overlay.dispose();
});

describe('TriageOverlay', () => {
  it('emits the queue head, the list and the judgement card', () => {
    const overlay = mount();
    expect(overlay.el.className).toBe('acp-harness__triage-overlay');
    expect(overlay.el.hidden).toBe(false);
    expect(overlay.el.querySelector('.acp-triage__title')?.textContent).toBe('Judgement queue');
    expect(overlay.el.querySelector('.acp-triage__sub')?.textContent).toBe('1 / 1');
    const card = overlay.el.querySelector<HTMLElement>('.acp-triage__card');
    expect(card?.dataset.reversibility).toBe('costly');
    expect(overlay.el.querySelector('.acp-triage__badge--costly')?.textContent).toBe('costly');
    expect(overlay.el.querySelector('.acp-triage__lane')?.textContent).toBe('claude-1');
    expect(overlay.el.querySelector('.acp-triage__diffstat')?.textContent).toBe('1 file · +18 / -4');
    expect(overlay.el.querySelector('.acp-triage__decision-text')?.textContent).toBe(
      'Delete it and compare deps per component',
    );
    expect([...overlay.el.querySelectorAll('.acp-triage__tradeoff-list li')].map((li) => li.textContent))
      .toEqual(['keep the cache', 'add a dirty flag']);
    expect([...overlay.el.querySelectorAll('.acp-triage__section-label')].map((s) => s.textContent))
      .toEqual(['because', 'traded off', 'unsure']);
  });

  it('appends the lane audit counters to the lane label when the lane is equipped', () => {
    const overlay = mount({
      laneStats: () => ({ laneId: 'lane-1', flaggedCount: 3, silentTurnCount: 12, lastSilentTurnAt: null }),
    });
    expect(overlay.el.querySelector('.acp-triage__lane')?.textContent)
      .toBe('claude-1 · 3 flagged · 12 silent');
  });

  it('renders the key legend as kbd runs while no redirect is open', () => {
    const overlay = mount();
    const hint = overlay.el.querySelector<HTMLElement>('.acp-triage__action-hint');
    expect([...(hint?.querySelectorAll('kbd') ?? [])].map((k) => k.textContent))
      .toEqual(['a', 'r', 'o', 'j', 'k', 'Esc']);
    expect(hint?.textContent).toContain('j/k prev/next');
  });

  it('swaps the legend for the redirect input, with the shared caret', () => {
    const overlay = mount({ redirect: { draft: 're-check the deps tuple' } });
    const input = overlay.el.querySelector<HTMLElement>('.acp-triage__redirect-input');
    expect(input?.textContent).toBe('re-check the deps tuple▋');
    expect(input?.querySelector('.acp-harness__caret')?.textContent).toBe('▋');
    expect(overlay.el.querySelector('.acp-triage__caret')).toBeNull();
    expect(overlay.el.querySelector('.acp-triage__action-hint')?.textContent)
      .toBe('Enter send · Esc cancel — delivered on the lane’s next idle');
  });

  it('shows the empty state with the silent pile count and drops the card', () => {
    const overlay = mount({ items: [], silentPileCount: 3 });
    expect(overlay.el.querySelector('.acp-triage__empty')?.textContent)
      .toBe('No judgement pending. 3 items in the silent pile.');
    expect(overlay.el.querySelector('.acp-triage__card')).toBeNull();
    expect(overlay.el.querySelector('.acp-triage__sub')?.textContent).toBe('0 open');
  });

  it('hides itself while closed and reveals itself again when reopened', () => {
    const overlay = mount({ open: false });
    expect(overlay.el.hidden).toBe(true);
    overlay.update(props({ open: true }));
    expect(overlay.el.hidden).toBe(false);
  });

  it('keeps the card node across a selection change', () => {
    const second = item({ id: 'j2', question: 'Second', reversibility: 'irreversible' });
    const overlay = mount({ items: [item(), second] });
    const card = overlay.el.querySelector('.acp-triage__card');
    overlay.update(props({ items: [item(), second], selectedIndex: 1 }));
    expect(overlay.el.querySelector('.acp-triage__card')).toBe(card);
    expect(overlay.el.querySelector('.acp-triage__question')?.textContent).toBe('Second');
    expect(overlay.el.querySelector<HTMLElement>('.acp-triage__card')?.dataset.reversibility)
      .toBe('irreversible');
  });

  it('writes nothing when the dependency tuple holds', () => {
    const items = [item()];
    const overlay = mount({ items });
    const before = overlay.el.innerHTML;
    const observer = new MutationObserver(() => undefined);
    observer.observe(overlay.el, { childList: true, subtree: true, attributes: true, characterData: true });
    overlay.update(props({ items }));
    const records = observer.takeRecords();
    observer.disconnect();
    expect(records).toEqual([]);
    expect(overlay.el.innerHTML).toBe(before);
  });
});
