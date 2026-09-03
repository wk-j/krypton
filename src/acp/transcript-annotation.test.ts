import { describe, expect, it } from 'vitest';

import { LaneBus } from './lane-bus';
import {
  ANNOTATION_CAP,
  annotationPressure,
  capNote,
  capQuote,
  collectUnsent,
  composeAnnotationPrompt,
  findQuoteRange,
  TranscriptAnnotationQueue,
} from './transcript-annotation';
import type { HarnessTranscriptItem } from './harness-view-types';
import type { TranscriptAnnotation, TranscriptAnnotationEnvelope } from './types';

function comment(partial: Partial<TranscriptAnnotation> & Pick<TranscriptAnnotation, 'id'>): TranscriptAnnotation {
  return {
    itemId: 'a1',
    quote: 'the parser returns null',
    quoteIndex: 0,
    body: 'guard the empty path',
    status: 'unsent',
    createdAt: 1,
    ...partial,
  };
}

function envelope(comments: TranscriptAnnotation[], batchId = 'b1'): TranscriptAnnotationEnvelope {
  return {
    kind: 'transcript_annotation',
    batchId,
    laneId: 'lane-1',
    comments,
    sentAt: 1,
  };
}

describe('findQuoteRange', () => {
  it('finds the Nth exact occurrence', () => {
    const text = 'null then null again';
    expect(findQuoteRange(text, 'null', 0)).toEqual({ start: 0, end: 4 });
    expect(findQuoteRange(text, 'null', 1)).toEqual({ start: 10, end: 14 });
    expect(findQuoteRange(text, 'null', 2)).toBeNull();
  });

  it('falls back to whitespace-collapsed match', () => {
    const text = 'the parser\nreturns null';
    expect(findQuoteRange(text, 'the parser\nreturns null', 0)).toEqual({ start: 0, end: text.length });
    const collapsed = findQuoteRange(text, 'the parser returns null', 0);
    expect(collapsed).not.toBeNull();
    expect(text.slice(collapsed!.start, collapsed!.end).replace(/\s+/g, ' ')).toBe('the parser returns null');
  });

  it('returns null for an empty quote', () => {
    expect(findQuoteRange('abc', '', 0)).toBeNull();
  });
});

describe('composeAnnotationPrompt', () => {
  it('emits trusted framing plus raw JSON with no markdown fence', () => {
    const text = composeAnnotationPrompt([
      envelope([
        comment({ id: '1', heading: 'Error handling' }),
        comment({ id: '2', quote: 'That example is stale', body: 'update the comment', heading: undefined }),
      ]),
    ]);
    expect(text).toContain('The user annotated 2 passages');
    expect(text).toContain('USER DATA');
    expect(text).not.toContain('```');
    const jsonLine = text.split('\n\n')[1];
    expect(JSON.parse(jsonLine)).toEqual([
      { quote: 'the parser returns null', note: 'guard the empty path', heading: 'Error handling' },
      { quote: 'That example is stale', note: 'update the comment' },
    ]);
  });

  it('JSON-escapes quotes and fences inside untrusted fields', () => {
    const text = composeAnnotationPrompt([
      envelope([comment({ id: '1', quote: 'say ``` then </tag>', body: 'note with "quotes"' })]),
    ]);
    const payload = JSON.parse(text.split('\n\n')[1]) as Array<{ quote: string; note: string }>;
    expect(payload[0].quote).toBe('say ``` then </tag>');
    expect(payload[0].note).toBe('note with "quotes"');
  });
});

describe('TranscriptAnnotationQueue', () => {
  it('holds while busy and drains one composed turn on idle', () => {
    const bus = new LaneBus();
    let status: 'busy' | 'idle' = 'busy';
    const injected: Array<{ text: string; ids: string[] }> = [];
    const queue = new TranscriptAnnotationQueue(bus, {
      getLaneStatus: () => status,
      injectAnnotationTurn: (_laneId, text, ids) => injected.push({ text, ids }),
    });

    expect(queue.accept('lane-1', envelope([comment({ id: 'c1' })], 'b1'))).toBe('accepted');
    expect(injected).toHaveLength(0);

    status = 'idle';
    bus.emit({
      type: 'lane:status',
      payload: { laneId: 'lane-1', prev: 'busy', next: 'idle', at: 2 },
    });
    expect(injected).toHaveLength(1);
    expect(injected[0].ids).toEqual(['c1']);
    expect(injected[0].text).toContain('the parser returns null');

    expect(queue.accept('lane-1', envelope([comment({ id: 'c1' })], 'b1-retry'))).toBe('duplicate');
    expect(injected).toHaveLength(1);
    queue.dispose();
  });

  it('batches two accepts that land before idle into one turn', () => {
    const bus = new LaneBus();
    let status: 'busy' | 'idle' = 'busy';
    const injected: string[] = [];
    const queue = new TranscriptAnnotationQueue(bus, {
      getLaneStatus: () => status,
      injectAnnotationTurn: (_laneId, text) => injected.push(text),
    });
    queue.accept('lane-1', envelope([comment({ id: 'c1' })], 'b1'));
    queue.accept('lane-1', envelope([comment({ id: 'c2', body: 'stale example' })], 'b2'));
    status = 'idle';
    bus.emit({
      type: 'lane:status',
      payload: { laneId: 'lane-1', prev: 'busy', next: 'idle', at: 3 },
    });
    expect(injected).toHaveLength(1);
    expect(injected[0]).toContain('2 passages');
    expect(injected[0]).toContain('stale example');
    queue.dispose();
  });

  it('dropLane forgets undrained comments so a later accept delivers them', () => {
    const bus = new LaneBus();
    let status: 'busy' | 'idle' = 'busy';
    const injected: string[] = [];
    const queue = new TranscriptAnnotationQueue(bus, {
      getLaneStatus: () => status,
      injectAnnotationTurn: (_laneId, text) => injected.push(text),
    });
    queue.accept('lane-1', envelope([comment({ id: 'c1' })], 'b1'));
    queue.dropLane('lane-1');
    status = 'idle';
    bus.emit({
      type: 'lane:status',
      payload: { laneId: 'lane-1', prev: 'busy', next: 'idle', at: 4 },
    });
    expect(injected).toHaveLength(0);
    expect(queue.accept('lane-1', envelope([comment({ id: 'c1' })], 'b1'))).toBe('accepted');
    expect(injected).toHaveLength(1);
    queue.dispose();
  });

  it('defers when a sibling already flipped the lane busy', () => {
    const bus = new LaneBus();
    let status: 'idle' | 'busy' = 'busy';
    const injected: string[] = [];
    const queue = new TranscriptAnnotationQueue(bus, {
      getLaneStatus: () => status,
      injectAnnotationTurn: (_laneId, text) => injected.push(text),
    });
    queue.accept('lane-1', envelope([comment({ id: 'c1' })], 'b1'));
    expect(injected).toHaveLength(0);
    // Idle event fires, but a sibling drainer already claimed the lane.
    status = 'busy';
    bus.emit({
      type: 'lane:status',
      payload: { laneId: 'lane-1', prev: 'busy', next: 'idle', at: 5 },
    });
    expect(injected).toHaveLength(0);
    queue.dispose();
  });
});

describe('annotation helpers', () => {
  it('counts unsent+sent toward the cap and collects unsent', () => {
    const items: HarnessTranscriptItem[] = [
      {
        id: 'a1',
        kind: 'assistant',
        text: 'hello',
        annotations: [
          comment({ id: '1', status: 'unsent' }),
          comment({ id: '2', status: 'sent' }),
          comment({ id: '3', status: 'drained' }),
        ],
      },
    ];
    expect(annotationPressure(items)).toBe(2);
    expect(collectUnsent(items).map((a) => a.id)).toEqual(['1']);
    expect(ANNOTATION_CAP).toBe(20);
    expect(capQuote('x'.repeat(3000)).length).toBe(2048);
    expect(capNote('y'.repeat(5000)).length).toBe(4096);
  });
});
