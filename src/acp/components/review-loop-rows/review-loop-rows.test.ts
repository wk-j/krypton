import { describe, expect, it } from 'vitest';

import type { TelemetryReviewLoop } from '../../harness-telemetry';
import { ReviewLoopRows } from './index';

function loop(over: Partial<TelemetryReviewLoop> = {}): TelemetryReviewLoop {
  return {
    running: true,
    phase: 'reviewing',
    round: 2,
    maxRounds: 4,
    subjectLabel: 'src/acp/lane-peek.ts',
    startedAt: 0,
    phaseSince: 0,
    reviewers: [
      { name: 'codex', state: 'replied', verdict: 'pass', blockers: 0, repliedAt: 10 },
      { name: 'salty', state: 'pending', verdict: null, blockers: 0, repliedAt: null },
    ],
    rounds: [
      { round: 1, verdict: 'fail', blockers: 3, warnings: 1 },
      { round: 2, verdict: 'pass', blockers: 0, warnings: 0 },
    ],
    stopReason: null,
    stopLabel: null,
    endedAt: null,
    ...over,
  };
}

const rowText = (rows: ReviewLoopRows, prefix: string): string | undefined =>
  [...rows.el.children]
    .find((row) => row.firstElementChild?.textContent === prefix)
    ?.lastElementChild?.textContent ?? undefined;

describe('ReviewLoopRows', () => {
  it('emits the three spec-277 rows inside a display:contents wrapper', () => {
    const rows = new ReviewLoopRows();
    rows.update({ loop: loop() });

    expect(rows.el.className).toBe('acp-harness__lane-peek-loop');
    expect(rows.el.dataset.peekRow).toBe('review-loop');
    expect(rows.el.children.length).toBe(3);
    expect(rowText(rows, 'review')).toBe('pass 2/4 · reviewing');
    expect(rowText(rows, 'replies')).toBe('codex PASS · salty pending');
    expect(rowText(rows, 'rounds')).toBe('3 → 0');
  });

  it('colours each verdict through data-verdict, not a class per state', () => {
    const rows = new ReviewLoopRows();
    rows.update({
      loop: loop({
        reviewers: [
          { name: 'codex', state: 'replied', verdict: 'fail', blockers: 2, repliedAt: 9 },
          { name: 'salty', state: 'replied', verdict: 'missing', blockers: 0, repliedAt: 9 },
        ],
      }),
    });

    const verdicts = [...rows.el.querySelectorAll('.acp-harness__lane-peek-verdict')];
    expect(verdicts.map((node) => `${node.getAttribute('data-verdict')}:${node.textContent}`))
      .toEqual(['fail:FAIL 2', 'partial:no verdict', 'fail:3', 'pass:0']);
  });

  it('calls a withdrawn reviewer `no reply` once the round stops reviewing', () => {
    const rows = new ReviewLoopRows();
    rows.update({ loop: loop({ phase: 'fixing' }) });
    expect(rowText(rows, 'replies')).toBe('codex PASS · salty no reply');
  });

  it('shows the stop label when the loop ended', () => {
    const rows = new ReviewLoopRows();
    rows.update({
      loop: loop({ running: false, phase: null, stopLabel: 'max rounds reached', endedAt: 1 }),
    });
    expect(rowText(rows, 'review')).toBe('pass 2/4 · ended · max rounds reached');
  });

  it('drops the replies and rounds rows when the loop has neither', () => {
    const rows = new ReviewLoopRows();
    rows.update({ loop: loop() });
    expect(rows.el.children.length).toBe(3);

    rows.update({ loop: loop({ reviewers: [], rounds: [] }) });
    expect(rows.el.children.length).toBe(1);
    expect(rowText(rows, 'review')).toBe('pass 2/4 · reviewing');
  });

  it('keeps the review row node when only a reviewer replied', () => {
    const rows = new ReviewLoopRows();
    rows.update({ loop: loop() });
    const review = rows.el.firstElementChild;
    const replies = rows.el.children[1];

    rows.update({
      loop: loop({
        reviewers: [
          { name: 'codex', state: 'replied', verdict: 'pass', blockers: 0, repliedAt: 10 },
          { name: 'salty', state: 'replied', verdict: 'fail', blockers: 1, repliedAt: 20 },
        ],
      }),
    });

    expect(rows.el.firstElementChild).toBe(review);
    expect(rows.el.children[1]).toBe(replies);
    expect(rowText(rows, 'replies')).toBe('codex PASS · salty FAIL 1');
  });

  it('writes nothing while the loop tuple holds', () => {
    const rows = new ReviewLoopRows();
    const same = loop();
    rows.update({ loop: same });

    let mutations = 0;
    const observer = new MutationObserver((records) => {
      mutations += records.length;
    });
    observer.observe(rows.el, { subtree: true, childList: true, attributes: true, characterData: true });
    rows.update({ loop: same });
    mutations += observer.takeRecords().length;
    observer.disconnect();

    expect(mutations).toBe(0);
  });

  it('tears its rows down on dispose', () => {
    const rows = new ReviewLoopRows();
    rows.update({ loop: loop() });
    rows.dispose();
    expect(rows.el.children.length).toBe(0);
  });
});
