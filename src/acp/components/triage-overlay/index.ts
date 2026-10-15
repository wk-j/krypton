// Spec 302 §7.7 — `TriageOverlay`.
//
// The summon-on-demand judgement queue (spec 128). Ports
// `attention-overlay.ts:59-198` — the panel wipe (`panel.replaceChildren()` on
// every keystroke) becomes a props comparison, the four `innerHTML` sites
// become nodes, and the forked `acp-triage__caret` rule collapses into the
// shared `Caret` component (only its window-accent colour survives, as a
// context rule in caret.css).
//
// Single-detail view: only the selected item is ever on screen, so the card is
// always the active one and always renders its action row.

import { Component } from '../../../ui/component';
import { el } from '../../../ui/dom';
import type { JudgementItem, LaneTriageStats, Reversibility, ReviewDiffstatEntry } from '../../types';
import { Caret } from '../caret';
import { KeyHintBar } from '../key-hint-bar';
import { OverlayShell } from '../overlay-shell';
import type { ComponentDef } from '../types';
import './triage-overlay.css';

const REVERSIBILITY_LABEL: Record<Reversibility, string> = {
  irreversible: 'irreversible',
  costly: 'costly',
  reversible: 'reversible',
};

/** The keys the queue answers to while no redirect input is open. */
const QUEUE_HINTS = [
  { keys: ['a'], label: 'acknowledge (tells lane)' },
  { keys: ['r'], label: 'redirect' },
  { keys: ['o'], label: 'dig (open lane)' },
  { keys: ['j', 'k'], label: 'prev/next', keySeparator: '/' },
  { keys: ['Esc'], label: 'close' },
] as const;

export interface TriageOverlayProps {
  readonly open: boolean;
  /** Ranked open items (most-irreversible first; the store already sorts). */
  readonly items: readonly JudgementItem[];
  /** Index into `items` of the selected card. */
  readonly selectedIndex: number;
  /** Resolve a laneId to its display name. */
  laneName(laneId: string): string;
  /** Resolve a laneId to its audit counters, or null when not equipped. */
  laneStats(laneId: string): LaneTriageStats | null;
  /** Non-null while the redirect one-line input is open for the selected card. */
  readonly redirect: { readonly draft: string } | null;
  /** Size of the silent pile (resolved/discharged items), for the empty hint. */
  readonly silentPileCount: number;
  onAutoClose?(): void;
}

function diffstatSummary(diffstat: readonly ReviewDiffstatEntry[]): string {
  if (diffstat.length === 0) return 'no repo changes';
  const added = diffstat.reduce((sum, entry) => sum + entry.added, 0);
  const removed = diffstat.reduce((sum, entry) => sum + entry.removed, 0);
  return `${diffstat.length} file${diffstat.length === 1 ? '' : 's'} · +${added} / -${removed}`;
}

/** A stacked section: an eyebrow label above a full-width body. */
function section(label: string, body: string | HTMLElement, extraClass?: string): HTMLElement {
  const node = el('div', { class: ['acp-triage__section', extraClass] });
  node.appendChild(el('span', { class: 'acp-triage__section-label', text: label }));
  if (typeof body === 'string') {
    node.appendChild(el('div', { class: 'acp-triage__section-body', text: body }));
  } else {
    body.classList.add('acp-triage__section-body');
    node.appendChild(body);
  }
  return node;
}

interface JudgementCardProps {
  readonly item: JudgementItem;
  readonly laneLabel: string;
  readonly statBits: string;
  readonly redirect: { readonly draft: string } | null;
}

/**
 * The judgement card. A flat layout container, NOT a bordered box: the panel is
 * the only frame, and hierarchy is carried by type, not nested containers.
 */
class JudgementCard extends Component<JudgementCardProps> {
  private readonly caret = new Caret();
  private readonly hintBar = new KeyHintBar();

  constructor() {
    super(el('div'));
  }

  protected readDeps(next: JudgementCardProps): readonly unknown[] {
    return [
      next.item,
      next.item.reversibility,
      next.item.question,
      next.item.chosen,
      next.item.rationale,
      next.item.uncertainty,
      next.item.tradedOff.join('\u0000'),
      next.item.diffstat,
      next.laneLabel,
      next.statBits,
      next.redirect?.draft ?? null,
    ];
  }

  protected syncClasses(next: JudgementCardProps): void {
    this.el.className = 'acp-triage__card';
    this.el.dataset.reversibility = next.item.reversibility;
  }

  protected paint(next: JudgementCardProps): void {
    this.syncClasses(next);
    const item = next.item;

    const head = el('div', { class: 'acp-triage__card-head' }, ...[
      el('span', {
        class: `acp-triage__badge acp-triage__badge--${item.reversibility}`,
        text: REVERSIBILITY_LABEL[item.reversibility],
      }),
      el('span', { class: 'acp-triage__lane', text: `${next.laneLabel}${next.statBits}` }),
      el('span', { class: 'acp-triage__diffstat', text: diffstatSummary(item.diffstat) }),
    ]);

    const decision = el('div', { class: 'acp-triage__decision' }, ...[
      el('span', { class: 'acp-triage__decision-label', text: 'decision' }),
      el('div', { class: 'acp-triage__decision-text', text: item.chosen }),
    ]);

    const tradedBody = el('ul', { class: 'acp-triage__tradeoff-list' });
    for (const traded of item.tradedOff) tradedBody.appendChild(el('li', { text: traded }));

    this.el.replaceChildren(
      head,
      el('div', { class: 'acp-triage__question', text: item.question }),
      decision,
      section('because', item.rationale, 'acp-triage__section--rationale'),
      section('traded off', tradedBody),
      section('unsure', item.uncertainty, 'acp-triage__section--uncertainty'),
      this.actions(next),
    );
  }

  /** The redirect input when it is open, the key legend otherwise. */
  private actions(next: JudgementCardProps): HTMLElement {
    const actions = el('div', { class: 'acp-triage__actions' });
    if (next.redirect) {
      this.caret.update({});
      const input = el('div', { class: 'acp-triage__redirect' }, ...[
        el('span', { class: 'acp-triage__redirect-label', text: 'redirect →' }),
        el('span', { class: 'acp-triage__redirect-input' }, next.redirect.draft, this.caret.el),
      ]);
      this.hintBar.update({
        hints: [{ keys: [], label: 'Enter send · Esc cancel' }],
        note: 'delivered on the lane’s next idle',
        noteJoin: ' — ',
        style: 'plain',
        block: 'acp-triage__action-hint',
      });
      actions.append(input, this.hintBar.el);
      return actions;
    }
    this.hintBar.update({
      hints: [...QUEUE_HINTS],
      style: 'kbd',
      block: 'acp-triage__action-hint',
      layout: 'bare',
    });
    actions.appendChild(this.hintBar.el);
    return actions;
  }

  protected onDispose(): void {
    this.caret.dispose();
    this.hintBar.dispose();
  }
}

export class TriageOverlay extends Component<TriageOverlayProps> {
  private readonly shell: OverlayShell;
  private readonly card: JudgementCard;
  private readonly list: HTMLElement;

  constructor() {
    // The component's root IS the shell's `<aside>`: the overlay needs no
    // wrapper, and the shell keeps ownership of the class and `hidden`.
    const shell = new OverlayShell();
    super(shell.el);
    this.shell = shell;
    this.card = new JudgementCard();
    this.list = el('div', { class: 'acp-triage__list' });
    this.list.appendChild(this.card.el);
  }

  get isOpen(): boolean {
    return this.shell.isOpen;
  }

  private selected(next: TriageOverlayProps): JudgementItem | null {
    return next.items[next.selectedIndex] ?? next.items[0] ?? null;
  }

  protected readDeps(next: TriageOverlayProps): readonly unknown[] {
    const item = this.selected(next);
    return [
      next.open,
      next.items,
      next.items.length,
      next.selectedIndex,
      next.silentPileCount,
      next.redirect?.draft ?? null,
      item,
      item ? next.laneName(item.laneId) : null,
      item ? this.statBits(next, item) : null,
    ];
  }

  /** The root is the shell's node: every class on it is re-derived by the
   *  shell's own `syncClasses()` from the props this component hands it. */
  protected syncClasses(_next: TriageOverlayProps): void {
    /* no classes of its own */
  }

  protected paint(next: TriageOverlayProps): void {
    this.syncClasses(next);
    const item = this.selected(next);
    if (item !== null) {
      this.card.update({
        item,
        laneLabel: next.laneName(item.laneId),
        statBits: this.statBits(next, item),
        redirect: next.redirect,
      });
    }
    const pile = next.silentPileCount > 0
      ? ` ${next.silentPileCount} item${next.silentPileCount === 1 ? '' : 's'} in the silent pile.`
      : '';
    this.shell.update({
      open: next.open,
      name: 'triage',
      block: 'acp-triage',
      title: 'Judgement queue',
      // One detail at a time: the count shows the cursor position in the queue.
      sub: next.items.length === 0 ? '0 open' : `${next.selectedIndex + 1} / ${next.items.length}`,
      body: this.list,
      empty: next.items.length === 0 ? `No judgement pending.${pile}` : undefined,
      onAutoClose: next.onAutoClose,
    });
    if (item !== null) this.list.scrollTop = 0;
  }

  private statBits(next: TriageOverlayProps, item: JudgementItem): string {
    const stats = next.laneStats(item.laneId);
    return stats ? ` · ${stats.flaggedCount} flagged · ${stats.silentTurnCount} silent` : '';
  }

  protected onDispose(): void {
    this.card.dispose();
    this.shell.dispose();
  }
}

export const def: ComponentDef = {
  id: 'triage-overlay',
  blocks: ['acp-harness__triage-overlay', 'acp-triage'],
};
