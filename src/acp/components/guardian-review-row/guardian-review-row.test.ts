import { describe, expect, it } from 'vitest';

import { GuardianReviewRow } from './index';
import { rowKindFor } from '../transcript/rows';
import type { RowProps } from '../transcript-row';
import type { GuardianReviewPayload, HarnessTranscriptItem, ToolPayload } from '../../harness-view-types';

function payload(review: GuardianReviewPayload, status: string): ToolPayload {
  return {
    glyph: '✓', status, kind: 'think', subject: 'Guardian Review', command: '', result: '',
    sections: [], diffs: [], guardianReview: review,
  };
}

function props(review: GuardianReviewPayload, status = 'in_progress'): RowProps {
  const item: HarnessTranscriptItem = {
    id: 'guardian-1', kind: 'tool', text: 'Guardian review', status,
    tool: payload(review, status),
  };
  return { item, isNew: false, streaming: false, lane: null, projectDir: null, resolveLocalImages: false };
}

const reviewing: GuardianReviewPayload = {
  outcome: 'reviewing', action: 'MCP lesson_record', risk: null,
  authorization: null, rationale: null, rationaleTruncated: false,
};

describe('GuardianReviewRow', () => {
  it('routes to its own row and updates the same nodes through completion', () => {
    const row = new GuardianReviewRow(props(reviewing));
    row.update(props(reviewing));
    expect(rowKindFor(props(reviewing).item)).toBe('guardianReview');
    expect(row.el.querySelector('.acp-harness__msg-label')?.textContent).toBe('guard');
    expect(row.el.querySelector('.acp-harness__tool-output')).toBeNull();
    expect(row.el.querySelector('.acp-harness__guardian-outcome')?.textContent).toBe('reviewing');
    expect(row.isLive).toBe(true);

    const action = row.el.querySelector('.acp-harness__guardian-action');
    const outcome = row.el.querySelector('.acp-harness__guardian-outcome');
    const approved: GuardianReviewPayload = {
      outcome: 'approved', action: 'MCP lesson_record on krypton-harness-memory',
      risk: 'medium', authorization: 'high', rationale: 'The user authorized this update.',
      rationaleTruncated: false,
    };
    const done = props(approved, 'completed');
    row.update(done);
    expect(row.el.querySelector('.acp-harness__guardian-action')).toBe(action);
    expect(row.el.querySelector('.acp-harness__guardian-outcome')).toBe(outcome);
    expect(outcome?.textContent).toBe('approved');
    expect(row.el.querySelector('.acp-harness__guardian-meta')?.textContent).toBe('risk medium · authorization high');
    expect(row.el.querySelector('.acp-harness__guardian-rationale')?.textContent).toBe('The user authorized this update.');
    expect(row.isLive).toBe(false);

    const observer = new MutationObserver(() => undefined);
    observer.observe(row.el, { subtree: true, childList: true, attributes: true, characterData: true });
    row.update(done);
    row.update(props({ ...approved, rationale: 'Late report after seal.' }, 'completed'));
    expect(observer.takeRecords()).toEqual([]);
    observer.disconnect();
    row.dispose();
  });

  it('marks a denial as a fault without adding a permission control', () => {
    const denied = props({
      outcome: 'denied', action: 'exec outside workspace', risk: 'high',
      authorization: 'unknown', rationale: 'Path not authorized.', rationaleTruncated: false,
    }, 'completed');
    const row = new GuardianReviewRow(denied);
    row.update(denied);
    expect(row.el.querySelector('.acp-harness__guardian-outcome--denied')?.textContent).toBe('denied');
    expect(row.el.querySelector('button')).toBeNull();
    expect(row.isLive).toBe(false);
    row.dispose();
  });

  it('hides absent metadata and shows truncation explicitly', () => {
    const long = props({ ...reviewing, outcome: 'unavailable', rationale: 'reason', rationaleTruncated: true }, 'completed');
    const row = new GuardianReviewRow(long);
    row.update(long);
    expect(row.el.querySelector('.acp-harness__guardian-meta')?.hasAttribute('hidden')).toBe(true);
    expect(row.el.querySelector('.acp-harness__guardian-rationale')?.textContent).toBe('reason … truncated');
    expect(row.el.querySelector('.acp-harness__guardian-outcome')?.textContent).toBe('review outcome unavailable');
    row.dispose();
  });
});
