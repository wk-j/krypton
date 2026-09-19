import { describe, expect, it } from 'vitest';

import {
  TIMELINE_USAGE,
  TIMELINE_CAPTURE_FIELDS,
  findExistingTopic,
  latestTimelineTopics,
  parseTimelineCommand,
  similarTimelineTopics,
  topicIdForTitle,
  uniqueTopicIdForTitle,
  topicMatchScore,
  validateTimelineRecord,
  type TimelineEvent,
  type TimelineRecordRequest,
} from './timeline';

function event(overrides: Partial<TimelineEvent> = {}): TimelineEvent {
  return {
    schema: 1,
    id: 'tl-1',
    topicId: 'topic-upload',
    topicTitle: 'Upload validation',
    kind: 'requirement',
    summary: 'Require metadata transfer',
    occurredAt: '2026-09-18T08:00:00Z',
    madeBy: 'Product owner',
    recordedAt: '2026-09-18T08:01:00Z',
    recordedBy: 'Local user',
    recorderLane: 'Codex-1',
    rationale: '',
    impact: '',
    path: '.krypton/timeline/events/tl-1.md',
    superseded: false,
    ...overrides,
  };
}

describe('parseTimelineCommand', () => {
  it('shows Thai usage while preserving command tokens', () => {
    expect(TIMELINE_USAGE).toContain('วิธีใช้: #timeline');
    expect(TIMELINE_USAGE).toContain('trace <topic>');
  });

  it('opens the complete timeline for the bare command', () => {
    expect(parseTimelineCommand('#timeline')).toEqual({ kind: 'open', topic: '' });
  });

  it('supports open and topic shorthand', () => {
    expect(parseTimelineCommand('#timeline open upload validation')).toEqual({ kind: 'open', topic: 'upload validation' });
    expect(parseTimelineCommand('#timeline upload validation')).toEqual({ kind: 'open', topic: 'upload validation' });
  });

  it('treats everything after add as the topic without classification', () => {
    expect(parseTimelineCommand('#timeline add decision prompt animation')).toEqual({
      kind: 'add',
      topic: 'decision prompt animation',
    });
    expect(parseTimelineCommand('#timeline add prompt animation')).toEqual({
      kind: 'add',
      topic: 'prompt animation',
    });
  });

  it('requires a trace topic', () => {
    expect(parseTimelineCommand('#timeline trace auth')).toEqual({ kind: 'trace', topic: 'auth' });
    expect(parseTimelineCommand('#timeline trace')).toEqual({ kind: 'usage' });
  });

  it('parses pending review and automatic suggestion controls', () => {
    expect(parseTimelineCommand('#timeline review')).toEqual({ kind: 'review' });
    expect(parseTimelineCommand('#timeline auto')).toEqual({ kind: 'auto', state: 'status' });
    expect(parseTimelineCommand('#timeline auto on')).toEqual({ kind: 'auto', state: 'on' });
    expect(parseTimelineCommand('#timeline auto off')).toEqual({ kind: 'auto', state: 'off' });
    expect(parseTimelineCommand('#timeline auto maybe')).toEqual({ kind: 'usage' });
    expect(parseTimelineCommand('#timeline review extra')).toEqual({ kind: 'usage' });
  });
});

describe('timeline topics', () => {
  it('creates deterministic ASCII and Unicode topic ids', () => {
    expect(topicIdForTitle('Prompt Input Animation')).toBe('topic-prompt-input-animation');
    expect(topicIdForTitle('การอัปโหลด')).toMatch(/^topic-[0-9a-f]{8}$/);
  });

  it('keeps a confirmed near-duplicate on a distinct topic id', () => {
    expect(uniqueTopicIdForTitle('Upload-validation', [event({ topicId: 'topic-upload-validation' })])).toMatch(
      /^topic-upload-validation-[0-9a-f]+$/,
    );
  });

  it('uses the newest event title while keeping the stable topic id', () => {
    const topics = latestTimelineTopics([
      event(),
      event({ id: 'tl-2', topicTitle: 'Upload completion validation', occurredAt: '2026-09-19T08:00:00Z' }),
    ]);
    expect(topics).toEqual([{ id: 'topic-upload', title: 'Upload completion validation', occurredAt: '2026-09-19T08:00:00Z' }]);
  });

  it('finds exact and similar topics without inventing authority', () => {
    const events = [event()];
    expect(findExistingTopic(' upload validation ', events)).toEqual({ id: 'topic-upload', title: 'Upload validation' });
    expect(similarTimelineTopics('upload', events)).toEqual([{ id: 'topic-upload', title: 'Upload validation' }]);
    expect(topicMatchScore('metadata checksum', event())).toBe(0);
    expect(topicMatchScore('metadata', event())).toBe(20);
  });
});

describe('timeline capture contract', () => {
  const valid: TimelineRecordRequest = {
    topicId: 'topic-upload',
    topicTitle: 'Upload validation',
    summary: 'Require metadata transfer',
    occurredAt: '2026-09-18T08:00:00Z',
    madeBy: 'Product owner',
    rationale: '',
    impact: '',
    recorderLane: 'Codex-1',
  };

  it('keeps the specified keyboard focus order', () => {
    expect(TIMELINE_CAPTURE_FIELDS).toEqual([
      'topic', 'summary', 'madeBy', 'occurredAt', 'sourceRef',
      'relation', 'relatedEvent', 'rationale', 'impact',
    ]);
  });

  it('requires authority and paired relations', () => {
    expect(validateTimelineRecord({ ...valid, madeBy: '' })).toBe('กรุณาระบุผู้ขอหรือผู้อนุมัติ');
    expect(validateTimelineRecord({ ...valid, relation: 'supersedes' })).toBe(
      'กรุณาเลือกความสัมพันธ์และเหตุการณ์ที่เกี่ยวข้องพร้อมกัน',
    );
    expect(validateTimelineRecord(valid)).toBeNull();
  });
});
