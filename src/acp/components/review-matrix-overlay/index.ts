// Spec 302 §7.8 — `ReviewMatrixOverlay`.
//
// The read-only review-quality matrix (spec 146). Ports
// `acp-harness-view.ts` `renderReviewMatrixOverlayEl` + `renderReviewFindingsDetail`
// (`:5306-5480`): the `panel.replaceChildren()` per keystroke becomes a props
// comparison, the `<thead>` `innerHTML` becomes nodes, the foot becomes
// `KeyHintBar`, and the lane switcher becomes `TabStrip`.
//
// The findings detail block had NO classes at all — eleven inline styles and
// three hardcoded severity colours. They move into this directory's sheet as
// `.acp-review__findings*`, which is the one visual-parity risk in this port.

import { Component } from '../../../ui/component';
import { el, setAttr } from '../../../ui/dom';
import { formatReviewRoundTime } from '../../harness-format';
import type { ReviewFinding, ReviewOutcome } from '../../types';
import { KeyHintBar, type KeyHint, type KeyHintBarProps } from '../key-hint-bar';
import { OverlayShell } from '../overlay-shell';
import { TabStrip } from '../tab-strip';
import type { ComponentDef } from '../types';
import './review-matrix-overlay.css';

const SEVERITY_GROUPS: readonly { readonly severity: ReviewFinding['severity']; readonly label: string }[] = [
  { severity: 'blocking', label: 'blocking' },
  { severity: 'non-blocking', label: 'non-blocking' },
  { severity: 'suggestion', label: 'suggestion' },
];

const COLUMNS: readonly { readonly cls: string; readonly label: string }[] = [
  { cls: 'acp-review__col-when', label: 'round' },
  { cls: 'acp-review__col-subj', label: 'subject' },
  { cls: 'acp-review__col-num', label: 'reviewers' },
  { cls: 'acp-review__col-num acp-review__col-block', label: 'block' },
  { cls: 'acp-review__col-num acp-review__col-warn', label: 'warn' },
];

export interface ReviewMatrixLane {
  readonly id: string;
  /** Display name, falling back to the newest outcome's snapshot. */
  readonly label: string;
  /** Rounds recorded for this lane; the tab shows the count. */
  readonly roundCount: number;
}

export interface ReviewMatrixOverlayProps {
  readonly open: boolean;
  readonly lanes: readonly ReviewMatrixLane[];
  readonly selectedLaneIndex: number;
  /** The selected lane's history, newest first (the store already orders it). */
  readonly rows: readonly ReviewOutcome[];
  readonly selectedRowIndex: number;
  /** Index of the row whose findings are expanded, or null. */
  readonly expandedRowIndex: number | null;
  onAutoClose?(): void;
}

export class ReviewMatrixOverlay extends Component<ReviewMatrixOverlayProps> {
  private readonly shell: OverlayShell;
  private readonly tabs: TabStrip;
  private readonly body: HTMLElement;
  private readonly table: HTMLTableElement;
  private readonly tbody: HTMLTableSectionElement;

  constructor() {
    const shell = new OverlayShell();
    super(shell.el);
    this.shell = shell;
    this.tabs = new TabStrip();
    // The body holds the (optional) lane switcher plus the table; the shell
    // inserts it as one node, so a tab appearing never moves the head or foot.
    this.body = el('div', { class: 'acp-review__body' });
    this.table = el('table', { class: 'acp-review__table' });
    this.table.appendChild(el('thead', {}, el(
      'tr',
      {},
      ...COLUMNS.map((column) => el('th', { class: column.cls, text: column.label })),
    )));
    this.tbody = el('tbody');
    this.table.appendChild(this.tbody);
    this.body.appendChild(this.table);
  }

  get isOpen(): boolean {
    return this.shell.isOpen;
  }

  protected readDeps(next: ReviewMatrixOverlayProps): readonly unknown[] {
    return [
      next.open,
      next.lanes.map((lane) => `${lane.id}\u0001${lane.label}\u0001${lane.roundCount}`).join('\u0002'),
      next.selectedLaneIndex,
      next.rows,
      next.rows.length,
      next.selectedRowIndex,
      next.expandedRowIndex,
    ];
  }

  protected syncClasses(_next: ReviewMatrixOverlayProps): void {
    /* the root is the shell's node; the shell re-derives its classes */
  }

  protected paint(next: ReviewMatrixOverlayProps): void {
    this.paintTabs(next);
    this.paintRows(next);
    this.shell.update({
      open: next.open,
      name: 'review',
      block: 'acp-review',
      title: 'Review quality matrix',
      sub: 'this session · in-memory · not persisted',
      body: this.body,
      hints: this.hints(next),
      empty: next.lanes.length === 0 ? 'No reviews recorded.' : undefined,
      onAutoClose: next.onAutoClose,
    });
  }

  /** The switcher is only meaningful with more than one lane in history. */
  private paintTabs(next: ReviewMatrixOverlayProps): void {
    if (next.lanes.length <= 1) {
      this.tabs.el.remove();
      return;
    }
    const active = next.lanes[next.selectedLaneIndex] ?? next.lanes[0];
    this.tabs.update({
      tabs: next.lanes.map((lane) => ({ id: lane.id, label: lane.label, count: lane.roundCount })),
      activeId: active.id,
      block: 'acp-review',
      item: 'lane',
      activeClass: 'is-active',
      count: 'suffix',
    });
    if (this.tabs.el.parentNode !== this.body) this.body.insertBefore(this.tabs.el, this.table);
  }

  private paintRows(next: ReviewMatrixOverlayProps): void {
    const rows: HTMLElement[] = [];
    next.rows.forEach((row, index) => {
      const hasFindings = (row.findings?.length ?? 0) > 0;
      const expanded = hasFindings && next.expandedRowIndex === index;
      const tr = el('tr', { class: index === next.selectedRowIndex ? 'acp-review__row--selected' : null });
      tr.append(
        el('td', { class: 'acp-review__when', text: formatReviewRoundTime(row.at) }),
        el('td', {
          class: 'acp-review__subj',
          text: hasFindings ? `${expanded ? '▾' : '▸'} ${row.subjectLabel}` : row.subjectLabel,
        }),
        el('td', { class: 'acp-review__num acp-review__rev', text: String(row.reviewerCount) }),
        el('td', {
          class: ['acp-review__num acp-review__block', row.blockers === 0 && 'is-zero'],
          text: String(row.blockers),
        }),
        el('td', {
          class: ['acp-review__num acp-review__warn', row.warnings === 0 && 'is-zero'],
          text: String(row.warnings),
        }),
      );
      rows.push(tr);
      if (expanded && row.findings) {
        const cell = el('td', { class: 'acp-review__detail-cell' }, findingsDetail(row.findings));
        setAttr(cell, 'colspan', 5);
        rows.push(el('tr', {}, cell));
      }
    });
    this.tbody.replaceChildren(...rows);
  }

  private hints(next: ReviewMatrixOverlayProps): KeyHintBarProps {
    const hints: KeyHint[] = [];
    if (next.lanes.length > 1) hints.push({ keys: ['h', 'l'], label: 'switch lane' });
    if (next.rows.length > 0) {
      hints.push({ keys: ['j', 'k'], label: 'select round' });
      if (next.rows.some((row) => (row.findings?.length ?? 0) > 0)) {
        hints.push({ keys: ['enter', 'space'], label: 'expand findings' });
      }
    }
    hints.push({ keys: ['esc'], label: 'close' });
    return {
      hints,
      note: 'read-only — observation, not a score',
      noteClass: 'acp-review__foot-note',
      style: 'kbd',
      block: 'acp-review__foot',
    };
  }

  protected onDispose(): void {
    this.tabs.dispose();
    this.shell.dispose();
  }
}

/** Flat detail block grouped by severity; content font, no nested panels. */
function findingsDetail(findings: readonly ReviewFinding[]): HTMLElement {
  const wrap = el('div', { class: 'acp-review__findings' });
  for (const group of SEVERITY_GROUPS) {
    const items = findings.filter((finding) => finding.severity === group.severity);
    if (items.length === 0) continue;
    wrap.appendChild(el('div', {
      class: `acp-review__findings-group acp-review__findings-group--${group.severity}`,
      text: group.label,
    }));
    for (const finding of items) {
      const loc = finding.line !== undefined ? `${finding.file}:${finding.line}` : finding.file;
      wrap.appendChild(el('div', {
        class: 'acp-review__finding',
        text: `${loc} — ${finding.severity} — ${finding.note}`,
      }));
    }
  }
  return wrap;
}

export const def: ComponentDef = {
  id: 'review-matrix-overlay',
  blocks: ['acp-harness__review-overlay', 'acp-review'],
};
