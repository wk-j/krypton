// Krypton — Attention Triage overlay rendering (spec 128).
//
// Pure DOM builders for the summon-on-demand judgement queue overlay and the
// static backpressure gauge. State (open/selection/redirect) lives in the
// harness view; this module only renders. The card uses a deliberate hierarchy
// (verdict block + stacked sections) rather than the review-card's flat rows —
// see renderJudgementCard for the rationale.

import type { JudgementItem, LaneTriageStats, Reversibility, ReviewDiffstatEntry } from './types';

function esc(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

const REVERSIBILITY_LABEL: Record<Reversibility, string> = {
  irreversible: 'irreversible',
  costly: 'costly',
  reversible: 'reversible',
};

/** View-model the harness view assembles each render. */
export interface TriageOverlayViewModel {
  /** Ranked open items (most-irreversible first; the store already sorts). */
  items: JudgementItem[];
  /** Index into `items` of the selected card. */
  selectedIndex: number;
  /** Resolve a laneId to its display name. */
  laneName: (laneId: string) => string;
  /** Resolve a laneId to its audit counters (or null if not equipped). */
  laneStats: (laneId: string) => LaneTriageStats | null;
  /** Non-null while the redirect one-line input is open for the selected card. */
  redirect: { draft: string } | null;
  /** Size of the silent pile (resolved/discharged items), for the empty hint. */
  silentPileCount: number;
}

function diffstatSummary(diffstat: ReviewDiffstatEntry[]): string {
  if (diffstat.length === 0) return 'no repo changes';
  const added = diffstat.reduce((s, e) => s + e.added, 0);
  const removed = diffstat.reduce((s, e) => s + e.removed, 0);
  return `${diffstat.length} file${diffstat.length === 1 ? '' : 's'} · +${added} / -${removed}`;
}

/** Build the judgement card. `traded-off` and `uncertainty` are always shown.
   Single-detail view: only the selected item is ever rendered, so the card is
   always the active one and renders the action row unconditionally. It is a
   flat layout container, NOT a bordered box — the panel is the only frame, so
   the card carries no border/tint of its own (no box-in-a-box; see feedback).

   Hierarchy is carried by type, not nested containers: the question frames the
   fork, the *decision* (chosen) is the verdict the human acknowledges — promoted
   by brightness + weight alone — and rationale / traded-off / uncertainty follow
   as stacked sections (eyebrow label above a full-width body) so each reads as
   its own beat instead of one grey wall. */
function renderJudgementCard(item: JudgementItem, vm: TriageOverlayViewModel): HTMLElement {
  const card = document.createElement('div');
  card.className = 'acp-triage__card';
  card.dataset.reversibility = item.reversibility;

  const head = document.createElement('div');
  head.className = 'acp-triage__card-head';
  const stats = vm.laneStats(item.laneId);
  const statBits = stats
    ? ` · ${stats.flaggedCount} flagged · ${stats.silentTurnCount} silent`
    : '';
  head.innerHTML =
    `<span class="acp-triage__badge acp-triage__badge--${item.reversibility}">${esc(
      REVERSIBILITY_LABEL[item.reversibility],
    )}</span>` +
    `<span class="acp-triage__lane">${esc(vm.laneName(item.laneId))}${esc(statBits)}</span>` +
    `<span class="acp-triage__diffstat">${esc(diffstatSummary(item.diffstat))}</span>`;
  card.appendChild(head);

  const question = document.createElement('div');
  question.className = 'acp-triage__question';
  question.textContent = item.question;
  card.appendChild(question);

  // Decision = the verdict the human is acknowledging. Promoted above the
  // supporting prose by type weight + brightness (flat — no tinted box) so the
  // eye lands on it first.
  const decision = document.createElement('div');
  decision.className = 'acp-triage__decision';
  const decisionLabel = document.createElement('span');
  decisionLabel.className = 'acp-triage__decision-label';
  decisionLabel.textContent = 'decision';
  const decisionText = document.createElement('div');
  decisionText.className = 'acp-triage__decision-text';
  decisionText.textContent = item.chosen;
  decision.append(decisionLabel, decisionText);
  card.appendChild(decision);

  // Rationale recedes — it is the supporting "why", not the answer.
  card.appendChild(section('because', item.rationale, 'acp-triage__section--rationale'));

  // Traded-off + uncertainty are ALWAYS rendered, never collapsed (spec 128):
  // this is what lets the human see what the agent gave up.
  const tradedBody = document.createElement('ul');
  tradedBody.className = 'acp-triage__tradeoff-list';
  for (const t of item.tradedOff) {
    const li = document.createElement('li');
    li.textContent = t;
    tradedBody.appendChild(li);
  }
  card.appendChild(section('traded off', tradedBody));

  card.appendChild(section('unsure', item.uncertainty, 'acp-triage__section--uncertainty'));

  const actions = document.createElement('div');
  actions.className = 'acp-triage__actions';
  if (vm.redirect) {
    const input = document.createElement('div');
    input.className = 'acp-triage__redirect';
    input.innerHTML =
      `<span class="acp-triage__redirect-label">redirect →</span>` +
      `<span class="acp-triage__redirect-input">${esc(vm.redirect.draft)}<span class="acp-triage__caret">▋</span></span>`;
    actions.appendChild(input);
    const hint = document.createElement('div');
    hint.className = 'acp-triage__action-hint';
    hint.textContent = 'Enter send · Esc cancel — delivered on the lane’s next idle';
    actions.appendChild(hint);
  } else {
    const hint = document.createElement('div');
    hint.className = 'acp-triage__action-hint';
    hint.innerHTML =
      `<kbd>a</kbd> acknowledge (tells lane) · <kbd>r</kbd> redirect · <kbd>o</kbd> dig (open lane) · <kbd>j</kbd>/<kbd>k</kbd> prev/next · <kbd>Esc</kbd> close`;
    actions.appendChild(hint);
  }
  card.appendChild(actions);
  return card;
}

/** A stacked section: an eyebrow label above a full-width body. `body` may be
   plain text (rationale / uncertainty) or a prebuilt element (the traded-off
   list). Stacking gives each beat its own break and lets long prose use the
   full card width instead of being squeezed into a narrow gutter column. */
function section(label: string, body: string | HTMLElement, extraClass?: string): HTMLElement {
  const el = document.createElement('div');
  el.className = 'acp-triage__section' + (extraClass ? ` ${extraClass}` : '');
  const lab = document.createElement('span');
  lab.className = 'acp-triage__section-label';
  lab.textContent = label;
  el.appendChild(lab);
  if (typeof body === 'string') {
    const val = document.createElement('div');
    val.className = 'acp-triage__section-body';
    val.textContent = body;
    el.appendChild(val);
  } else {
    body.classList.add('acp-triage__section-body');
    el.appendChild(body);
  }
  return el;
}

/** Rebuild the overlay panel from the view-model. */
export function renderTriageOverlay(panel: HTMLElement, vm: TriageOverlayViewModel): void {
  panel.replaceChildren();

  const header = document.createElement('header');
  header.className = 'acp-triage__head';
  // One detail at a time: the count shows the cursor position within the queue
  // (e.g. "2 / 5") rather than a flat open-count, since only the selected card
  // is on screen. Empty state falls through below before this matters.
  const position = vm.items.length === 0 ? '0 open' : `${vm.selectedIndex + 1} / ${vm.items.length}`;
  header.innerHTML =
    `<span class="acp-triage__title">Judgement queue</span>` +
    `<span class="acp-triage__count">${position}</span>`;
  panel.appendChild(header);

  if (vm.items.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'acp-triage__empty';
    const pile =
      vm.silentPileCount > 0
        ? ` ${vm.silentPileCount} item${vm.silentPileCount === 1 ? '' : 's'} in the silent pile.`
        : '';
    empty.textContent = `No judgement pending.${pile}`;
    panel.appendChild(empty);
    return;
  }

  // Single-detail view: render only the selected item full-width. j/k cycles
  // which item is shown (handled in the harness view). Showing one card at a
  // time gives each decision the whole panel instead of cramming every open
  // item into a scroll list where the tall traded-off / uncertainty fields get
  // clipped. The body scrolls only when a single card overflows its own height.
  const selected = vm.items[vm.selectedIndex] ?? vm.items[0];
  const list = document.createElement('div');
  list.className = 'acp-triage__list';
  list.appendChild(renderJudgementCard(selected, vm));
  panel.appendChild(list);
  list.scrollTop = 0;
}
