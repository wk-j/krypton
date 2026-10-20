import { describe, expect, it } from 'vitest';

import { isHighlightedConflict, parseTimelineCommand } from './timeline';

describe('parseTimelineCommand', () => {
  it('opens history for the bare command, explicit open and subject shorthand', () => {
    expect(parseTimelineCommand('#timeline')).toEqual({ kind: 'open', topic: '' });
    expect(parseTimelineCommand('#timeline open upload validation')).toEqual({ kind: 'open', topic: 'upload validation' });
    expect(parseTimelineCommand('#timeline upload validation')).toEqual({ kind: 'open', topic: 'upload validation' });
  });

  it('requires a topic for read-only trace', () => {
    expect(parseTimelineCommand('#timeline trace auth')).toEqual({ kind: 'trace', topic: 'auth' });
    expect(parseTimelineCommand('#timeline trace')).toEqual({ kind: 'usage' });
  });

  it('supports conflict work and automatic recording controls', () => {
    expect(parseTimelineCommand('#timeline conflicts')).toEqual({ kind: 'conflicts', topic: '' });
    expect(parseTimelineCommand('#timeline conflicts backup db')).toEqual({ kind: 'conflicts', topic: 'backup db' });
    expect(parseTimelineCommand('#timeline auto')).toEqual({ kind: 'auto', state: 'status' });
    expect(parseTimelineCommand('#timeline auto on')).toEqual({ kind: 'auto', state: 'on' });
    expect(parseTimelineCommand('#timeline auto off')).toEqual({ kind: 'auto', state: 'off' });
    expect(parseTimelineCommand('#timeline auto maybe')).toEqual({ kind: 'usage' });
  });
});

describe('timeline conflict highlight', () => {
  it('marks only pairs still to review or confirmed and open', () => {
    expect(isHighlightedConflict('unreviewed')).toBe(true);
    expect(isHighlightedConflict('insufficient_evidence')).toBe(true);
    expect(isHighlightedConflict('confirmed')).toBe(true);
    expect(isHighlightedConflict('dismissed')).toBe(false);
    expect(isHighlightedConflict('resolved')).toBe(false);
    expect(isHighlightedConflict('historical')).toBe(false);
  });
});
