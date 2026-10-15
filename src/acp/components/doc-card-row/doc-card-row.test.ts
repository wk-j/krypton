import { describe, expect, it } from 'vitest';

import { DocCardRow } from './index';
import type { RowProps } from '../transcript-row';
import type { ArtifactCardPayload, HarnessTranscriptItem, ReviewCardPayload } from '../../harness-view-types';

function props(item: HarnessTranscriptItem, isNew = false): RowProps {
  return { item, isNew, streaming: false, lane: null, projectDir: null, resolveLocalImages: false };
}

function artifact(over: Partial<ArtifactCardPayload> = {}): HarnessTranscriptItem {
  return {
    id: 'a1',
    kind: 'artifact',
    text: '[artifact] Report',
    artifact: {
      id: 'art-1',
      title: 'Report',
      laneLabel: 'claude-1',
      path: '/tmp/report.html',
      size: 2048,
      hash: 'abcdef1234567',
      available: true,
      hintLabel: null,
      ...over,
    },
  };
}

function review(over: Partial<ReviewCardPayload> = {}): HarnessTranscriptItem {
  return {
    id: 'r1',
    kind: 'review',
    text: '[review] Reconciler audit',
    review: {
      id: 'rev-1',
      slug: 'reconciler-audit',
      dir: '/tmp/reviews/reconciler-audit',
      title: 'Reconciler audit',
      laneLabel: 'codex-1',
      blocks: 4,
      steps: 2,
      findings: 1,
      decisions: 0,
      hintLabel: null,
      ...over,
    },
  };
}

describe('DocCardRow — artifact', () => {
  it('emits the artifact card markup the builder emits today', () => {
    const row = new DocCardRow(props(artifact()));
    row.update(props(artifact()));

    expect(row.el.className).toBe('acp-harness__msg acp-harness__msg--artifact');
    expect(row.el.querySelector('.acp-harness__msg-label')?.textContent).toBe('html');
    expect(row.el.querySelector('.acp-harness__msg-body')?.innerHTML).toBe(
      '<div class="acp-harness__artifact-head">' +
        '<span class="acp-harness__artifact-glyph">◫</span>' +
        '<span class="acp-harness__artifact-title">Report</span>' +
        '</div>' +
        '<div class="acp-harness__artifact-meta">2.0 KB · abcdef1</div>' +
        '<div class="acp-harness__artifact-action">f then label to open in browser</div>',
    );
  });

  it('reports the removed file and re-derives the wrapper when it comes back', () => {
    const row = new DocCardRow(props(artifact()));
    row.update(props(artifact({ available: false })));
    expect(row.el.className).toBe(
      'acp-harness__msg acp-harness__msg--artifact acp-harness__msg--artifact-unavailable',
    );
    expect(row.el.querySelector('.acp-harness__artifact-meta')?.textContent).toBe('unavailable — file removed');
    expect(row.el.querySelector('.acp-harness__artifact-action')?.textContent).toBe('reopen unavailable');

    row.update(props(artifact({ available: true })));
    expect(row.el.className).toBe('acp-harness__msg acp-harness__msg--artifact');
  });

  it('adds the hint span and the hinted modifier, and drops both when the hint is withdrawn', () => {
    const row = new DocCardRow(props(artifact()));
    row.update(props(artifact({ hintLabel: 'q' })));
    expect(row.el.className).toBe(
      'acp-harness__msg acp-harness__msg--artifact acp-harness__msg--artifact-hinted',
    );
    expect(row.el.querySelector('.acp-harness__artifact-hint')?.textContent).toBe('q');
    expect(row.el.querySelector('.acp-harness__artifact-action')?.textContent).toBe(
      'press q to open in browser',
    );

    row.update(props(artifact({ hintLabel: null })));
    expect(row.el.className).toBe('acp-harness__msg acp-harness__msg--artifact');
    expect(row.el.querySelector('.acp-harness__artifact-hint')).toBeNull();
  });
});

describe('DocCardRow — review', () => {
  it('emits its own block, never the artifact one', () => {
    const row = new DocCardRow(props(review()));
    row.update(props(review()));

    expect(row.el.className).toBe(
      'acp-harness__msg acp-harness__msg--review acp-harness__msg--artifact',
    );
    expect(row.el.querySelector('.acp-harness__msg-label')?.textContent).toBe('review');
    expect(row.el.querySelector('.acp-harness__msg-body')?.innerHTML).toBe(
      '<div class="acp-harness__review-card-head">' +
        '<span class="acp-harness__review-card-glyph">▤</span>' +
        '<span class="acp-harness__review-card-title">Reconciler audit</span>' +
        '</div>' +
        '<div class="acp-harness__review-card-meta">4 blocks · 2 steps · 1 finding</div>' +
        '<div class="acp-harness__review-card-action">' +
        'f then label to open · Leader Shift+R to reopen later</div>',
    );
    expect(row.el.querySelector('[class*="acp-harness__artifact"]')).toBeNull();
  });

  it('reads as a reference when the Board has no findings and no decisions', () => {
    const row = new DocCardRow(props(review({ findings: 0, decisions: 0, steps: 0, blocks: 1 })));
    row.update(props(review({ findings: 0, decisions: 0, steps: 0, blocks: 1 })));
    expect(row.el.querySelector('.acp-harness__review-card-meta')?.textContent).toBe('1 block · reference');
  });
});

describe('DocCardRow — lifecycle', () => {
  it('writes nothing when the payload has not moved', () => {
    const row = new DocCardRow(props(artifact()));
    row.update(props(artifact()));
    const title = row.el.querySelector('.acp-harness__artifact-title');
    const text = title?.firstChild;

    row.update(props(artifact()));
    expect(row.el.querySelector('.acp-harness__artifact-title')).toBe(title);
    expect(title?.firstChild).toBe(text);
  });

  it('keeps the head node across a repaint rather than rebuilding the card', () => {
    const row = new DocCardRow(props(artifact()));
    row.update(props(artifact()));
    const head = row.el.querySelector('.acp-harness__artifact-head');

    row.update(props(artifact({ title: 'Report v2' })));
    expect(row.el.querySelector('.acp-harness__artifact-head')).toBe(head);
    expect(row.el.querySelector('.acp-harness__artifact-title')?.textContent).toBe('Report v2');
  });

  it('stops listening for the entrance animation once disposed', () => {
    const row = new DocCardRow(props(artifact(), true));
    row.update(props(artifact(), true));
    expect(row.el.className).toContain('acp-harness__msg--enter');

    row.dispose();
    const event = new Event('animationend');
    Object.defineProperty(event, 'animationName', { value: 'acp-harness-msg-enter' });
    row.el.dispatchEvent(event);
    expect(row.el.className).toContain('acp-harness__msg--enter');
  });
});
