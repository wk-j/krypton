// Spec 302 §3.12 — `DocCardRow`.
//
// One row for the two document cards the transcript paints: the HTML artifact
// card (spec 133) and the Review Board card (spec 211). They are two
// near-identical builders today — `renderArtifactCardBody`
// (`harness-tool-render.ts:691-724`) and `renderReviewCardBody` (`:729-770`) —
// differing only in a glyph, a meta string and an action string, plus the
// wrapper logic at `harness-transcript-render.ts:384-394`.
//
// The ⚠ collision the catalog flags is resolved by `Card`: the review variant
// asks for `acp-harness__review-card`, so restyling the artifact card no longer
// silently restyles the Board card. The wrapper keeps `acp-harness__msg--artifact`
// for both — that modifier styles `.acp-harness__msg-body`, which is the box
// both cards sit in, and dropping it from the review row would change pixels.
//
// The card is hosted on `.acp-harness__msg-body`: neither builder has a wrapper
// of its own, their head/meta/action are direct children of the body.
//
// Block ownership is listed selector by selector rather than as the
// `acp-harness__artifact` stem: `acp-harness__artifact-redaction*` shares that
// stem and belongs to the tool row's redacted write card, not to this one.

import './doc-card-row.css';

import { setChildren } from '../../../ui/dom';
import { Card, type CardProps } from '../card';
import { TranscriptRow, type RowProps } from '../transcript-row';
import { formatArtifactBytes } from '../../harness-tool-render';
import type { ReviewCardPayload } from '../../harness-view-types';
import type { ComponentDef } from '../types';

/** `◫` for a rendered HTML document, `▤` for a Review Board bundle. */
const ARTIFACT_GLYPH = '\u25eb';
const REVIEW_GLYPH = '\u25a4';

/**
 * The Board's meta line. Step count sits next to the block count: on a
 * comprehension Board it is the better measure of "how much is here to read".
 * A Board with no findings and no decisions reads as `reference` — an
 * explanation, not a task.
 */
function reviewMetaText(card: ReviewCardPayload): string {
  const parts = [`${card.blocks} block${card.blocks === 1 ? '' : 's'}`];
  if (card.steps > 0) parts.push(`${card.steps} step${card.steps === 1 ? '' : 's'}`);
  if (card.findings > 0) parts.push(`${card.findings} finding${card.findings === 1 ? '' : 's'}`);
  if (card.decisions > 0) parts.push(`${card.decisions} decision${card.decisions === 1 ? '' : 's'}`);
  if (card.findings === 0 && card.decisions === 0) parts.push('reference');
  return parts.join(' \u00b7 ');
}

export class DocCardRow extends TranscriptRow {
  /** Null while the item carries no payload — the plain-text fallback the
   *  dispatcher falls through to today. Re-created, not revived, when a
   *  payload arrives, so the fresh card repaints instead of trusting deps it
   *  kept from before the body was wiped. */
  private card: Card | null = null;

  constructor(props: RowProps) {
    super(props, false);
  }

  protected wrapperModifiers(next: RowProps): readonly string[] {
    const { artifact, review } = next.item;
    const out = ['acp-harness__msg--artifact'];
    if (artifact && !artifact.available) out.push('acp-harness__msg--artifact-unavailable');
    if (artifact?.hintLabel || review?.hintLabel) out.push('acp-harness__msg--artifact-hinted');
    return out;
  }

  protected labelText(next: RowProps): string {
    return next.item.kind === 'review' ? 'review' : 'html';
  }

  protected bodyDeps(next: RowProps): readonly unknown[] {
    const { kind, text, artifact, review } = next.item;
    if (artifact) {
      return [kind, artifact.title, artifact.size, artifact.hash, artifact.available, artifact.hintLabel];
    }
    if (review) {
      return [
        kind,
        review.title,
        review.blocks,
        review.steps,
        review.findings,
        review.decisions,
        review.hintLabel,
      ];
    }
    return [kind, text];
  }

  protected paintBody(body: HTMLElement, next: RowProps): void {
    const props = this.cardProps(next);
    if (!props) {
      this.dropCard();
      setChildren(body, [next.item.text]);
      return;
    }
    const card = this.card ?? new Card({ host: body });
    this.card = card;
    card.update(props);
  }

  /** `hintLabel` is `string | null`, and both builders skip the hint span when
   *  it is empty — which is `Card`'s `undefined`, not its `''` (that one emits
   *  a hidden span, the fence card's shape). */
  private cardProps(next: RowProps): CardProps | null {
    const { artifact, review } = next.item;
    if (artifact) {
      const hash7 = artifact.hash ? artifact.hash.slice(0, 7) : '—';
      return {
        block: 'acp-harness__artifact',
        head: {
          hint: artifact.hintLabel || undefined,
          glyph: ARTIFACT_GLYPH,
          title: artifact.title,
          meta: artifact.available
            ? `${formatArtifactBytes(artifact.size)} · ${hash7}`
            : 'unavailable — file removed',
        },
        action: artifact.available
          ? artifact.hintLabel
            ? `press ${artifact.hintLabel} to open in browser`
            : 'f then label to open in browser'
          : 'reopen unavailable',
      };
    }
    if (review) {
      return {
        block: 'acp-harness__review-card',
        head: {
          hint: review.hintLabel || undefined,
          glyph: REVIEW_GLYPH,
          title: review.title,
          meta: reviewMetaText(review),
        },
        action: review.hintLabel
          ? `press ${review.hintLabel} to open the review`
          : 'f then label to open \u00b7 Leader Shift+R to reopen later',
      };
    }
    return null;
  }

  private dropCard(): void {
    this.card?.dispose();
    this.card = null;
  }

  protected onDispose(): void {
    super.onDispose();
    this.dropCard();
  }
}

export const def: ComponentDef = {
  id: 'doc-card-row',
  blocks: [
    'acp-harness__msg--artifact',
    'acp-harness__artifact-head',
    'acp-harness__artifact-hint',
    'acp-harness__artifact-glyph',
    'acp-harness__artifact-title',
    'acp-harness__artifact-meta',
    'acp-harness__artifact-action',
  ],
};
