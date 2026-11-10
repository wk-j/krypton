// Spec 378 — Codex Guardian assessment as a flat, read-only transcript row.

import './guardian-review-row.css';

import { el } from '../../../ui/dom';
import { isTerminalToolStatus } from '../../harness-tool-render';
import { TranscriptRow, type RowProps } from '../transcript-row';
import type { GuardianReviewPayload } from '../../harness-view-types';
import type { ComponentDef } from '../types';

const OUTCOME_LABEL: Record<GuardianReviewPayload['outcome'], string> = {
  reviewing: 'reviewing',
  approved: 'approved',
  denied: 'denied',
  timed_out: 'timed out',
  aborted: 'aborted',
  failed: 'failed',
  unavailable: 'review outcome unavailable',
};

function setText(node: HTMLElement, value: string): void {
  if (node.textContent !== value) node.textContent = value;
}

export class GuardianReviewRow extends TranscriptRow {
  private readonly head = el('div', { class: 'acp-harness__guardian-head' });
  private readonly outcomeText = el('span', { class: 'acp-harness__guardian-outcome-text' });
  private readonly outcome = el('span', { class: 'acp-harness__guardian-outcome' }, this.outcomeText);
  private readonly action = el('span', { class: 'acp-harness__guardian-action' });
  private readonly meta = el('div', { class: 'acp-harness__guardian-meta' });
  private readonly rationale = el('div', { class: 'acp-harness__guardian-rationale' });

  constructor(props: RowProps) {
    super(props, props.item.tool ? !isTerminalToolStatus(props.item.tool.status) : false);
    this.head.append(this.outcome, this.action);
  }

  update(next: RowProps): void {
    // A mounted terminal row paints once; later partial ACP reports must not
    // rewrite a sealed transcript row.
    if (!this.isLive && this.painted) return;
    super.update(next);
    if (next.item.tool && isTerminalToolStatus(next.item.tool.status)) this.seal(next);
  }

  protected labelText(): string {
    return 'guard';
  }

  protected wrapperModifiers(): readonly string[] {
    return ['acp-harness__msg--guardian-review'];
  }

  protected bodyClasses(): readonly string[] {
    return ['acp-harness__guardian'];
  }

  protected bodyDeps(next: RowProps): readonly unknown[] {
    const review = next.item.tool?.guardianReview;
    return [
      review?.outcome,
      review?.action,
      review?.risk,
      review?.authorization,
      review?.rationale,
      review?.rationaleTruncated,
    ];
  }

  protected paintBody(body: HTMLElement, next: RowProps): void {
    const review = next.item.tool?.guardianReview;
    if (!review) return;
    if (this.head.parentElement !== body) body.append(this.head, this.meta, this.rationale);

    this.outcome.className = `acp-harness__guardian-outcome acp-harness__guardian-outcome--${review.outcome}`;
    setText(this.outcomeText, OUTCOME_LABEL[review.outcome]);
    setText(this.action, review.action);

    const meta = [
      review.risk ? `risk ${review.risk}` : '',
      review.authorization ? `authorization ${review.authorization}` : '',
    ].filter(Boolean).join(' · ');
    this.meta.hidden = !meta;
    setText(this.meta, meta);

    const rationale = review.rationale
      ? `${review.rationale}${review.rationaleTruncated ? ' … truncated' : ''}`
      : '';
    this.rationale.hidden = !rationale;
    setText(this.rationale, rationale);
  }
}

export const def: ComponentDef = {
  id: 'guardian-review-row',
  blocks: ['acp-harness__guardian'],
};
