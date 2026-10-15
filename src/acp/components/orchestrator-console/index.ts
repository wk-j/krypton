// Spec 302 §7.10 — `OrchestratorConsole`.
//
// The acting fleet console (spec 180/181/182/184,
// `acp-harness-view.ts:5750-5999`). Today `renderOrchestratorConsoleEl` writes
// `this.orchestratorPanelEl.innerHTML` — the ENTIRE console, seat grid included
// — on every keystroke of the dispatch or seat-prompt draft, and then has to
// restore the input's scrollTop by hand because the node it was typing into no
// longer exists.
//
// Here the seat grid is a keyed list of card components and the dispatch line
// is its own component, so a keystroke writes the draft span and nothing else:
// the cards are not re-created, not re-ordered and not even touched.

import { Component } from '../../../ui/component';
import { el, setAttr } from '../../../ui/dom';
import { disposeList, reconcile } from '../../../ui/list';
import { OverlayShell } from '../overlay-shell';
import type { ComponentDef } from '../types';
import './orchestrator-console.css';

/** A card tag. `badge` is the seat marker; the rest are the lane's counters. */
export type OrchestratorTagKind = 'badge' | 'tag' | 'attn' | 'perm';

export interface OrchestratorTag {
  readonly kind: OrchestratorTagKind;
  readonly text: string;
}

export interface OrchestratorSeatCard {
  readonly id: string;
  readonly displayName: string;
  /** Raw status, for the `--${status}` status class. */
  readonly status: string;
  readonly statusLabel: string;
  /** `backend · model`, already assembled by the caller. */
  readonly meta: string;
  readonly isSeat: boolean;
  readonly isSelected: boolean;
  readonly tags: readonly OrchestratorTag[];
}

export interface OrchestratorPermRow {
  readonly laneId: string;
  readonly laneName: string;
  readonly label: string;
  /** Per-lane backlog behind the head request. */
  readonly more: number;
  readonly highRisk: boolean;
  readonly focus: boolean;
  /** The FULL untruncated command; only high-risk rows carry one. */
  readonly command: string;
}

export interface OrchestratorFeedRow {
  /** `→ codex-1` / `← codex-1` / `system`. */
  readonly who: string;
  readonly text: string;
}

/** The dispatch line and the seat-prompt line share this shape. */
export interface OrchestratorInputLine {
  /** `dispatch → codex-1`. */
  readonly label: string;
  readonly active: boolean;
  readonly draft: string;
  readonly placeholder: string;
  /** Shown instead of the hint when the line cannot be used. */
  readonly disabledReason: string | null;
  /** `press d to dispatch to codex-1`. */
  readonly hint: string;
  /** Dispatch only: the purpose chips. */
  readonly purposes?: readonly string[];
  readonly activePurpose?: string;
}

export interface OrchestratorConsoleProps {
  readonly open: boolean;
  readonly seatName: string | null;
  /** `4 lanes · 1 busy · 0 awaiting · 2 flags`. */
  readonly summary: string;
  readonly cards: readonly OrchestratorSeatCard[];
  readonly permissions: readonly OrchestratorPermRow[];
  /** `· Tab next` when more than one lane is queued. */
  readonly permStepHint: string;
  readonly feed: readonly OrchestratorFeedRow[];
  /** Replaces the feed rows when there is nothing to show. */
  readonly feedEmpty: string | null;
  readonly dispatch: OrchestratorInputLine;
  readonly seatPrompt: OrchestratorInputLine;
  readonly keyLegend: string;
  onAutoClose?(): void;
}

const TAG_CLASS: Record<OrchestratorTagKind, string> = {
  badge: 'acp-orchestrator__badge',
  tag: 'acp-orchestrator__tag',
  attn: 'acp-orchestrator__tag acp-orchestrator__tag--attn',
  perm: 'acp-orchestrator__tag acp-orchestrator__tag--perm',
};

class SeatCard extends Component<OrchestratorSeatCard> {
  private readonly name: HTMLElement;
  private readonly status: HTMLElement;
  private readonly meta: HTMLElement;
  private tags: HTMLElement | null = null;

  constructor() {
    super(el('div'));
    this.name = el('span', { class: 'acp-orchestrator__card-name' });
    this.status = el('span');
    this.meta = el('div', { class: 'acp-orchestrator__card-meta' });
    this.el.append(
      el('div', { class: 'acp-orchestrator__card-head' }, this.name, this.status),
      this.meta,
    );
  }

  protected readDeps(next: OrchestratorSeatCard): readonly unknown[] {
    return [
      next.id,
      next.displayName,
      next.status,
      next.statusLabel,
      next.meta,
      next.isSeat,
      next.isSelected,
      next.tags.map((tag) => `${tag.kind}\u0001${tag.text}`).join('\u0002'),
    ];
  }

  protected syncClasses(next: OrchestratorSeatCard): void {
    this.el.className = 'acp-orchestrator__card'
      + (next.isSelected ? ' acp-orchestrator__card--selected' : '')
      + (next.isSeat ? ' acp-orchestrator__card--seat' : '');
    this.status.className = `acp-orchestrator__card-status acp-orchestrator__card-status--${next.status}`;
  }

  protected paint(next: OrchestratorSeatCard): void {
    this.syncClasses(next);
    this.el.dataset.orchLane = next.id;
    this.name.textContent = next.displayName;
    this.status.textContent = next.statusLabel;
    this.meta.textContent = next.meta;
    if (next.tags.length === 0) {
      this.tags?.remove();
      this.tags = null;
      return;
    }
    const tags = this.tags ?? el('div', { class: 'acp-orchestrator__tags' });
    this.tags = tags;
    tags.replaceChildren(...next.tags.map((tag) => el('span', { class: TAG_CLASS[tag.kind], text: tag.text })));
    if (tags.parentNode !== this.el) this.el.appendChild(tags);
  }
}

class PermRow extends Component<OrchestratorPermRow> {
  private readonly lane: HTMLElement;
  private readonly label: HTMLElement;

  constructor() {
    super(el('div'));
    this.lane = el('span', { class: 'acp-orchestrator__perm-lane' });
    this.label = el('span', { class: 'acp-orchestrator__perm-label' });
  }

  protected readDeps(next: OrchestratorPermRow): readonly unknown[] {
    return [next.laneId, next.laneName, next.label, next.more, next.highRisk, next.focus, next.command];
  }

  protected syncClasses(next: OrchestratorPermRow): void {
    this.el.className = 'acp-orchestrator__perm'
      + (next.focus ? ' acp-orchestrator__perm--focus' : '')
      + (next.highRisk ? ' acp-orchestrator__perm--highrisk' : '');
  }

  protected paint(next: OrchestratorPermRow): void {
    this.syncClasses(next);
    this.lane.textContent = next.laneName;
    this.label.textContent = next.label;
    const children: HTMLElement[] = [this.lane, this.label];
    if (next.more > 0) {
      children.push(el('span', { class: 'acp-orchestrator__perm-more', text: `(+${next.more} more)` }));
    }
    if (next.command) {
      children.push(el('span', { class: 'acp-orchestrator__perm-command', text: next.command }));
    }
    const hint = permHint(next);
    if (hint !== null) children.push(hint);
    this.el.replaceChildren(...children);
  }
}

/** The focused row owns the a/r legend; an unfocused high-risk row still warns. */
function permHint(next: OrchestratorPermRow): HTMLElement | null {
  const answer = 'a accept · A all · r reject · R all';
  if (next.focus) {
    return el('span', {
      class: next.highRisk
        ? 'acp-orchestrator__perm-hint acp-orchestrator__perm-hint--highrisk'
        : 'acp-orchestrator__perm-hint',
      text: next.highRisk ? `⚠ high-risk · ${answer}` : answer,
    });
  }
  if (next.highRisk) {
    return el('span', {
      class: 'acp-orchestrator__perm-hint acp-orchestrator__perm-hint--highrisk',
      text: '⚠ high-risk',
    });
  }
  return null;
}

interface InputLineProps extends OrchestratorInputLine {
  /** `dispatch` | `seat-prompt`. */
  readonly region: string;
}

/**
 * One dispatch / seat-prompt line. This is the component the per-keystroke
 * `innerHTML` rebuild existed for: the draft is written into a span that
 * outlives every keystroke, so the input keeps its scroll position instead of
 * having it restored by hand afterwards.
 */
class InputLine extends Component<InputLineProps> {
  private readonly label: HTMLElement;
  private readonly input: HTMLElement;
  /** NOT the shared `Caret`: the console's caret is an EMPTY styled block with
   *  its own blink keyframes, not a glyph, so it has no `glyph` to parameterise. */
  private readonly caret = el('span', { class: 'acp-orchestrator__caret' });
  private readonly draft: Text;
  private readonly placeholder: HTMLElement;
  private purposes: HTMLElement | null = null;

  constructor() {
    super(el('section'));
    this.label = el('span', { class: 'acp-orchestrator__dispatch-label' });
    this.draft = document.createTextNode('');
    this.placeholder = el('span', { class: 'acp-orchestrator__dispatch-placeholder' });
    this.input = el('span', { class: 'acp-orchestrator__dispatch-input' });
  }

  protected readDeps(next: InputLineProps): readonly unknown[] {
    return [
      next.region,
      next.label,
      next.active,
      next.draft,
      next.placeholder,
      next.disabledReason,
      next.hint,
      next.purposes?.join('\u0001') ?? null,
      next.activePurpose ?? null,
    ];
  }

  protected syncClasses(next: InputLineProps): void {
    this.el.className = 'acp-orchestrator__dispatch'
      + (next.active ? ' acp-orchestrator__dispatch--active' : '');
  }

  protected paint(next: InputLineProps): void {
    this.syncClasses(next);
    setAttr(this.el, 'data-region', next.region);
    this.label.textContent = next.label;

    if (!next.active) {
      this.el.replaceChildren(this.label, el('span', {
        class: next.disabledReason !== null
          ? 'acp-orchestrator__dispatch-disabled'
          : 'acp-orchestrator__dispatch-hint',
        text: next.disabledReason ?? next.hint,
      }));
      return;
    }

    // The caret sits after the draft, or before the placeholder when empty.
    this.draft.data = next.draft;
    this.placeholder.textContent = next.placeholder;
    this.input.replaceChildren(...(next.draft
      ? [this.draft, this.caret]
      : [this.caret, this.placeholder]));

    const children: Node[] = [this.label];
    const purposes = this.syncPurposes(next);
    if (purposes) children.push(purposes);
    children.push(this.input);
    this.el.replaceChildren(...children);
    // A draft taller than the input scrolls internally; keep the caret visible.
    this.input.scrollTop = this.input.scrollHeight;
  }

  private syncPurposes(next: InputLineProps): HTMLElement | null {
    if (!next.purposes || next.purposes.length === 0) {
      this.purposes?.remove();
      this.purposes = null;
      return null;
    }
    const node = this.purposes ?? el('span', {
      class: 'acp-orchestrator__purposes',
      title: 'Tab cycles purpose',
    });
    this.purposes = node;
    node.replaceChildren(...next.purposes.map((purpose) => el('span', {
      class: purpose === next.activePurpose
        ? 'acp-orchestrator__purpose acp-orchestrator__purpose--active'
        : 'acp-orchestrator__purpose',
      text: purpose,
    })));
    return node;
  }
}

export class OrchestratorConsole extends Component<OrchestratorConsoleProps> {
  private readonly shell: OverlayShell;
  private readonly body: HTMLElement;
  private readonly grid: HTMLElement;
  private readonly feed: HTMLElement;
  private readonly permq: HTMLElement;
  private readonly permRows: HTMLElement;
  private readonly permTitle: HTMLElement;
  private readonly dispatch = new InputLine();
  private readonly seatPrompt = new InputLine();
  private readonly keys: HTMLElement;
  private readonly seatEl = el('span', { class: 'acp-orchestrator__seat' });

  constructor() {
    const shell = new OverlayShell();
    super(shell.el);
    this.shell = shell;

    this.grid = el('div', { class: 'acp-orchestrator__grid' });
    this.feed = el('section', {
      class: 'acp-orchestrator__region',
      data: { region: 'feed' },
    }, el('h3', { class: 'acp-orchestrator__region-title', text: 'Feed' }));

    const lanes = el('section', {
      class: 'acp-orchestrator__region',
      data: { region: 'lanes' },
    }, el('h3', { class: 'acp-orchestrator__region-title', text: 'Lanes' }), this.grid);
    const reserved = el('section', {
      class: 'acp-orchestrator__region acp-orchestrator__region--reserved',
      data: { region: 'reserved' },
    }, el('div', {
      class: 'acp-orchestrator__reserved-note',
      text: 'reserved — task list · delegation graph (future)',
    }));

    this.permTitle = el('h3', { class: 'acp-orchestrator__region-title' });
    this.permRows = el('div', { class: 'acp-orchestrator__permq-rows' });
    this.permq = el('section', {
      class: 'acp-orchestrator__permq',
      data: { region: 'permissions' },
    }, this.permTitle, this.permRows);

    this.keys = el('footer', { class: 'acp-orchestrator__keys' });
    this.body = el('div', { class: 'acp-orchestrator__main' }, ...[
      el('div', { class: 'acp-orchestrator__body' }, lanes, this.feed, reserved),
      this.dispatch.el,
      this.seatPrompt.el,
      this.keys,
    ]);
  }

  get isOpen(): boolean {
    return this.shell.isOpen;
  }

  protected readDeps(next: OrchestratorConsoleProps): readonly unknown[] {
    return [
      next.open,
      next.seatName,
      next.summary,
      next.cards,
      next.cards.length,
      next.permissions,
      next.permissions.length,
      next.permStepHint,
      next.feed,
      next.feedEmpty,
      next.dispatch,
      next.seatPrompt,
      next.keyLegend,
    ];
  }

  protected syncClasses(_next: OrchestratorConsoleProps): void {
    /* the root is the shell's node; the shell re-derives its classes */
  }

  protected paint(next: OrchestratorConsoleProps): void {
    this.paintCards(next.cards);
    this.paintPermissions(next);
    this.paintFeed(next);
    this.dispatch.update({ ...next.dispatch, region: 'dispatch' });
    this.seatPrompt.update({ ...next.seatPrompt, region: 'seat-prompt' });
    this.keys.textContent = next.keyLegend;
    this.seatEl.textContent = next.seatName ?? 'no seat';
    this.shell.update({
      open: next.open,
      name: 'orchestrator',
      block: 'acp-orchestrator',
      title: 'Orchestrator console',
      // The seat keeps its own pill — folding it into `sub` turned the cyan
      // chip into dim subtitle text, which spec 301 does not permit.
      headExtra: this.seatEl,
      sub: next.summary,
      body: this.body,
      onAutoClose: next.onAutoClose,
    });
  }

  private paintCards(cards: readonly OrchestratorSeatCard[]): void {
    if (cards.length === 0) {
      disposeList(this.grid);
      this.grid.replaceChildren(el('div', { class: 'acp-orchestrator__empty', text: 'no lanes' }));
      return;
    }
    reconcile<OrchestratorSeatCard, SeatCard>(this.grid, cards, {
      key: (card) => card.id,
      create: (card) => {
        const node = new SeatCard();
        node.update(card);
        return node;
      },
      update: (node, card) => node.update(card),
    });
  }

  private paintPermissions(next: OrchestratorConsoleProps): void {
    if (next.permissions.length === 0) {
      disposeList(this.permRows);
      this.permq.remove();
      return;
    }
    this.permTitle.textContent = `Pending permissions${next.permStepHint}`;
    reconcile<OrchestratorPermRow, PermRow>(this.permRows, next.permissions, {
      key: (row) => row.laneId,
      create: (row) => {
        const node = new PermRow();
        node.update(row);
        return node;
      },
      update: (node, row) => node.update(row),
    });
    // spec 184: the queue is a fleet-wide band ABOVE the body.
    if (this.permq.parentNode !== this.body) this.body.insertBefore(this.permq, this.body.firstChild);
  }

  private paintFeed(next: OrchestratorConsoleProps): void {
    const title = this.feed.firstElementChild;
    const content = next.feedEmpty !== null
      ? el('div', { class: 'acp-orchestrator__empty', text: next.feedEmpty })
      : el('div', { class: 'acp-orchestrator__feed' }, ...next.feed.map((row) => el(
        'div',
        { class: 'acp-orchestrator__feed-row' },
        el('span', { class: 'acp-orchestrator__feed-who', text: row.who }),
        el('span', { class: 'acp-orchestrator__feed-text', text: row.text }),
      )));
    this.feed.replaceChildren(...(title ? [title, content] : [content]));
  }

  protected onDispose(): void {
    disposeList(this.grid);
    disposeList(this.permRows);
    this.dispatch.dispose();
    this.seatPrompt.dispose();
    this.shell.dispose();
  }
}

export const def: ComponentDef = {
  id: 'orchestrator-console',
  blocks: ['acp-harness__orchestrator', 'acp-orchestrator'],
};
