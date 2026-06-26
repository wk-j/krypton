// Krypton — Review Priority roll-up overlay rendering (spec 162).
//
// Pure DOM builder for the summon-on-demand reading-priority roll-up. State
// (open / selected lane) lives in the harness view; this module only renders.
// Mirrors attention-overlay.ts / the review-matrix overlay: read-only, neutral,
// `j`/`k` switches lane. It is an *awareness roll-up* of what each lane marked
// `high`/`routine` over its working diff — acting on a range still happens in
// that lane's Diff Window (`p`), so this surface has no jump/Enter affordance.

import type { ReviewPriorityRange, ReviewPriorityReport } from './types';

function esc(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/** View-model the harness view assembles each render. */
export interface ReviewPriorityOverlayViewModel {
  /** Lanes with at least one reported range, stable order. */
  lanes: string[];
  /** Index into `lanes` of the selected lane. */
  selectedIndex: number;
  /** Resolve a laneId to its display name. */
  laneName: (laneId: string) => string;
  /** `high`-range count for any lane — every tab shows its own number, since
   *  that count is what helps the human pick which lane to inspect. */
  highCountFor: (laneId: string) => number;
  /** The selected lane's latest report, or null. */
  report: ReviewPriorityReport | null;
}

function rangeRow(r: ReviewPriorityRange): HTMLElement {
  const row = document.createElement('div');
  row.className = `acp-priority__row acp-priority__row--${r.level}`;
  const tag = document.createElement('span');
  tag.className = `acp-priority__tag acp-priority__tag--${r.level}`;
  tag.textContent = r.level;
  const content = document.createElement('span');
  content.className = 'acp-priority__row-content';
  const loc = document.createElement('span');
  loc.className = 'acp-priority__loc';
  // A single-line range shows just the line; a span shows start–end.
  const lines = r.lineStart === r.lineEnd ? `${r.lineStart}` : `${r.lineStart}–${r.lineEnd}`;
  loc.innerHTML = `<span class="acp-priority__file">${esc(r.file)}</span><span class="acp-priority__lines">:${lines}</span>`;
  content.appendChild(loc);
  if (r.reason) {
    const reason = document.createElement('span');
    reason.className = 'acp-priority__reason';
    reason.textContent = r.reason;
    content.appendChild(reason);
  }
  row.append(tag, content);
  return row;
}

function group(label: string, ranges: ReviewPriorityRange[]): HTMLElement | null {
  if (ranges.length === 0) return null;
  const sec = document.createElement('div');
  sec.className = 'acp-priority__group';
  const head = document.createElement('div');
  head.className = 'acp-priority__group-label';
  head.textContent = `${label} · ${ranges.length}`;
  sec.appendChild(head);
  for (const r of ranges) sec.appendChild(rangeRow(r));
  return sec;
}

/** Rebuild the overlay panel from the view-model. */
export function renderReviewPriorityOverlay(
  panel: HTMLElement,
  vm: ReviewPriorityOverlayViewModel,
): void {
  panel.replaceChildren();

  const header = document.createElement('header');
  header.className = 'acp-priority__head';
  const title = document.createElement('span');
  title.className = 'acp-priority__title';
  title.textContent = 'Review priority';
  const sub = document.createElement('span');
  sub.className = 'acp-priority__sub';
  sub.textContent = 'reading order — advisory · open the lane’s diff to act';
  header.append(title, sub);
  panel.appendChild(header);

  if (vm.lanes.length === 0 || !vm.report) {
    const empty = document.createElement('div');
    empty.className = 'acp-priority__empty';
    empty.textContent = 'No reading priority reported.';
    panel.appendChild(empty);
    return;
  }

  // Lane switcher (only meaningful with >1 lane reporting).
  if (vm.lanes.length > 1) {
    const tabs = document.createElement('div');
    tabs.className = 'acp-priority__lanes';
    vm.lanes.forEach((laneId, i) => {
      const tab = document.createElement('span');
      tab.className = 'acp-priority__lane' + (i === vm.selectedIndex ? ' is-active' : '');
      tab.textContent = `${vm.laneName(laneId)} · ${vm.highCountFor(laneId)}`;
      tabs.appendChild(tab);
    });
    panel.appendChild(tabs);
  }

  const high = vm.report.ranges.filter((r) => r.level === 'high');
  const routine = vm.report.ranges.filter((r) => r.level === 'routine');

  const body = document.createElement('div');
  body.className = 'acp-priority__body';
  const highGroup = group('read first', high);
  const routineGroup = group('routine', routine);
  if (highGroup) body.appendChild(highGroup);
  if (routineGroup) body.appendChild(routineGroup);
  panel.appendChild(body);

  const foot = document.createElement('div');
  foot.className = 'acp-priority__foot';
  foot.innerHTML =
    (vm.lanes.length > 1 ? '<span><kbd>j</kbd> <kbd>k</kbd> switch lane</span>' : '') +
    '<span><kbd>esc</kbd> close</span>' +
    '<span class="acp-priority__foot-note">read-only — advisory reading hint</span>';
  panel.appendChild(foot);
}
