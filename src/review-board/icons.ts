// Krypton — Review Board icons.
//
// Monoline marks in a `0 0 16 16` box with no colour or stroke of their own:
// `.krypton-review__icon` strokes them in currentColor, so an icon wears the
// colour of the label it sits in (severity tone, accent, active map row, the
// dimmed label of a dismissed finding). Each is parsed once and cloned per use,
// so a body render never re-parses markup (the workspace footer's pattern).

export type ReviewIconName =
  | 'overview'
  | 'open'
  | 'document'
  | 'walkthrough'
  | 'blocking'
  | 'non-blocking'
  | 'suggestion'
  | 'decision'
  | 'metrics'
  | 'chart'
  | 'diff';

const ICON_BODY: Record<ReviewIconName, string> = {
  // four tiles: the whole Board at a glance
  overview:
    '<rect x="2.5" y="2.5" width="4.5" height="4.5" rx="1"/><rect x="9" y="2.5" width="4.5" height="4.5" rx="1"/>' +
    '<rect x="2.5" y="9" width="4.5" height="4.5" rx="1"/><rect x="9" y="9" width="4.5" height="4.5" rx="1"/>',
  // an inbox tray: work still waiting for an answer
  open:
    '<path d="M2.5 9.5 L4.2 3.5 H11.8 L13.5 9.5 V12.5 A1 1 0 0 1 12.5 13.5 H3.5 A1 1 0 0 1 2.5 12.5 Z"/>' +
    '<path d="M2.5 9.5 H5.6 L6.6 11 H9.4 L10.4 9.5 H13.5"/>',
  // a page with a folded corner and two text lines
  document:
    '<path d="M4 2.5 H9.5 L12.5 5.5 V13.5 H4 Z"/><path d="M9.5 2.5 V5.5 H12.5"/><path d="M6 8.5 H10.5 M6 11 H10.5"/>',
  // a route from a start node to an end node: read in this order
  walkthrough:
    '<circle cx="4" cy="3.8" r="1.5"/><circle cx="12" cy="12.2" r="1.5"/>' +
    '<path d="M5.5 3.8 H10 A2.1 2.1 0 0 1 10 8 H6 A2.1 2.1 0 0 0 6 12.2 H10.5"/>',
  // a stop octagon holding an exclamation mark
  blocking:
    '<path d="M5.5 2 H10.5 L14 5.5 V10.5 L10.5 14 H5.5 L2 10.5 V5.5 Z"/><path d="M8 5 V8.6"/><path d="M8 11 V11.1"/>',
  // a warning triangle holding an exclamation mark
  'non-blocking':
    '<path d="M8 2.6 L14.4 13.2 H1.6 Z"/><path d="M8 6.6 V9.3"/><path d="M8 11.3 V11.4"/>',
  // a light bulb: an idea, not a defect
  suggestion:
    '<path d="M6 11 C6 9.6 4 8.6 4 6.2 A4 4 0 0 1 12 6.2 C12 8.6 10 9.6 10 11 Z"/><path d="M6.4 13.5 H9.6"/>',
  // one path splitting into two: pick a way
  decision:
    '<path d="M8 14 V9 L3.8 4.8 M8 9 L12.2 4.8"/><path d="M3.5 7.6 V4.5 H6.6"/><path d="M12.5 7.6 V4.5 H9.4"/>',
  // label / value rows, the block's own layout (counts, never a gauge: ADR-0004)
  metrics: '<path d="M2.5 4.5 H6.5 M9.5 4.5 H13.5 M2.5 8 H6.5 M9.5 8 H12 M2.5 11.5 H6.5 M9.5 11.5 H13"/>',
  // horizontal bars off an axis, like the chart the block draws
  chart: '<path d="M2.5 2.5 V13.5"/><path d="M5 5 H10.5 M5 8 H13 M5 11 H8.5"/>',
  // added over removed
  diff: '<path d="M8 2.5 V7.5 M5.5 5 H10.5"/><path d="M5.5 11.5 H10.5"/>',
};

/** Parsed-once icon nodes; every use is a clone. */
const templates = new Map<ReviewIconName, SVGElement>();

/** A fresh `<svg class="krypton-review__icon">` for `name`, hidden from AT: the
 *  label beside it already says what it is. */
export function reviewIcon(name: ReviewIconName): SVGElement {
  let tpl = templates.get(name);
  if (!tpl) {
    const holder = document.createElement('div');
    holder.innerHTML = `<svg class="krypton-review__icon" viewBox="0 0 16 16" aria-hidden="true">${ICON_BODY[name]}</svg>`;
    tpl = holder.firstElementChild as SVGElement;
    templates.set(name, tpl);
  }
  return tpl.cloneNode(true) as SVGElement;
}
