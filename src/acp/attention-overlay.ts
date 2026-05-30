// Krypton — Attention Triage overlay rendering (spec 128).
//
// Pure DOM builders for the summon-on-demand judgement queue overlay and the
// static backpressure gauge. State (open/selection/redirect) lives in the
// harness view; this module only renders. Card layout mirrors the review-card
// renderer (`renderReviewCardBody`) so the two surfaces read consistently.

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

/** Build one judgement card. `traded-off` and `uncertainty` are always shown. */
function renderJudgementCard(item: JudgementItem, vm: TriageOverlayViewModel, selected: boolean): HTMLElement {
  const card = document.createElement('div');
  card.className = 'acp-triage__card';
  if (selected) card.classList.add('acp-triage__card--selected');
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

  card.appendChild(field('chose', item.chosen));
  card.appendChild(field('because', item.rationale));

  // Traded-off + uncertainty are ALWAYS rendered, never collapsed (spec 128):
  // this is what lets the human see what the agent gave up.
  const traded = document.createElement('div');
  traded.className = 'acp-triage__field acp-triage__field--tradedoff';
  const tradedLabel = document.createElement('span');
  tradedLabel.className = 'acp-triage__field-label';
  tradedLabel.textContent = 'traded off';
  traded.appendChild(tradedLabel);
  const tradedList = document.createElement('ul');
  tradedList.className = 'acp-triage__tradeoff-list';
  for (const t of item.tradedOff) {
    const li = document.createElement('li');
    li.textContent = t;
    tradedList.appendChild(li);
  }
  traded.appendChild(tradedList);
  card.appendChild(traded);

  card.appendChild(field('unsure', item.uncertainty, 'acp-triage__field--uncertainty'));

  if (selected) {
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
        `<kbd>a</kbd> acknowledge · <kbd>r</kbd> redirect · <kbd>o</kbd> dig (open lane) · <kbd>j</kbd>/<kbd>k</kbd> move · <kbd>Esc</kbd> close`;
      actions.appendChild(hint);
    }
    card.appendChild(actions);
  }
  return card;
}

function field(label: string, value: string, extraClass?: string): HTMLElement {
  const el = document.createElement('div');
  el.className = 'acp-triage__field' + (extraClass ? ` ${extraClass}` : '');
  const lab = document.createElement('span');
  lab.className = 'acp-triage__field-label';
  lab.textContent = label;
  const val = document.createElement('span');
  val.className = 'acp-triage__field-value';
  val.textContent = value;
  el.append(lab, val);
  return el;
}

/** Rebuild the overlay panel from the view-model. */
export function renderTriageOverlay(panel: HTMLElement, vm: TriageOverlayViewModel): void {
  panel.replaceChildren();

  const header = document.createElement('header');
  header.className = 'acp-triage__head';
  header.innerHTML =
    `<span class="acp-triage__title">Judgement queue</span>` +
    `<span class="acp-triage__count">${vm.items.length} open</span>`;
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

  const list = document.createElement('div');
  list.className = 'acp-triage__list';
  vm.items.forEach((item, i) => {
    list.appendChild(renderJudgementCard(item, vm, i === vm.selectedIndex));
  });
  panel.appendChild(list);
}
