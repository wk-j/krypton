import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import {
  TIMELINE_USAGE,
  TIMELINE_CAPTURE_FIELDS,
  buildTimelineTopicCandidates,
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

  // spec 263: topic repair. The separator is the LAST ` into `, so a source
  // title containing the word still resolves.
  it('parses topic merge and its undo', () => {
    expect(parseTimelineCommand('#timeline merge topic-old into topic-new')).toEqual({
      kind: 'merge',
      from: 'topic-old',
      into: 'topic-new',
    });
    expect(parseTimelineCommand('#timeline merge looking into uploads into upload validation')).toEqual({
      kind: 'merge',
      from: 'looking into uploads',
      into: 'upload validation',
    });
    expect(parseTimelineCommand('#timeline merge undo')).toEqual({ kind: 'mergeUndo' });
    expect(parseTimelineCommand('#timeline merge UNDO')).toEqual({ kind: 'mergeUndo' });
    expect(parseTimelineCommand('#timeline merge')).toEqual({ kind: 'usage' });
    expect(parseTimelineCommand('#timeline merge topic-old')).toEqual({ kind: 'usage' });
    expect(parseTimelineCommand('#timeline merge into topic-new')).toEqual({ kind: 'usage' });
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

  it('builds a bounded semantic shortlist without provenance fields', () => {
    const events = [
      event(),
      event({
        id: 'tl-2',
        topicId: 'topic-review',
        topicTitle: 'Review workflow',
        summary: 'Review the proposed design',
        occurredAt: '2026-09-19T08:00:00Z',
      }),
    ];
    expect(buildTimelineTopicCandidates({ title: 'metadata', summary: '' }, events, 12)).toEqual([
      {
        topicId: 'topic-upload',
        title: 'Upload validation',
        occurredAt: '2026-09-18T08:00:00Z',
        recentSummaries: ['Require metadata transfer'],
        lexicalScore: 20,
      },
      {
        topicId: 'topic-review',
        title: 'Review workflow',
        occurredAt: '2026-09-19T08:00:00Z',
        recentSummaries: ['Review the proposed design'],
        lexicalScore: 0,
      },
    ]);
  });

  it('declines an arbitrary partial corpus without a lexical signal', () => {
    const events = Array.from({ length: 13 }, (_, index) => event({
      id: `tl-${index}`,
      topicId: `topic-${index}`,
      topicTitle: `Topic ${index}`,
      summary: `Summary ${index}`,
      occurredAt: `2026-09-${String(index + 1).padStart(2, '0')}T08:00:00Z`,
    }));
    expect(buildTimelineTopicCandidates({ title: 'ไม่เกี่ยวข้อง', summary: '' }, events, 12)).toEqual([]);
  });

  it('caps large candidate sets and keeps lexical matches first', () => {
    const events = Array.from({ length: 15 }, (_, index) => event({
      id: `tl-${index}`,
      topicId: `topic-${index}`,
      topicTitle: index === 0 ? 'Upload metadata' : `Topic ${index}`,
      summary: `Summary ${index}`,
      occurredAt: `2026-09-${String(index + 1).padStart(2, '0')}T08:00:00Z`,
    }));
    const candidates = buildTimelineTopicCandidates({ title: 'upload', summary: '' }, events, 12);
    expect(candidates).toHaveLength(12);
    expect(candidates[0].topicId).toBe('topic-0');
  });

  it('keeps every expected existing topic in the checked-in evaluation shortlist', () => {
    const fixturePath = fileURLToPath(new URL('./fixtures/timeline-topic-semantic.json', import.meta.url));
    const cases = JSON.parse(readFileSync(fixturePath, 'utf8')) as Array<{
      case: string;
      draft: { title: string; summary: string };
      topics: Array<{ topicId: string; title: string; summaries: string[] }>;
      expected: string;
    }>;
    for (const fixture of cases) {
      const events = fixture.topics.flatMap((topic, topicIndex) => (
        (topic.summaries.length > 0 ? topic.summaries : ['']).map((summary, summaryIndex) => event({
          id: `${fixture.case}-${topicIndex}-${summaryIndex}`,
          topicId: topic.topicId,
          topicTitle: topic.title,
          summary,
          occurredAt: `2026-09-${String(topicIndex + 1).padStart(2, '0')}T08:00:00Z`,
        }))
      ));
      if (fixture.expected === 'exact_bypass') {
        expect(findExistingTopic(fixture.draft.title, events)?.id, fixture.case)
          .toBe('topic-upload-validation');
        continue;
      }
      const candidateIds = buildTimelineTopicCandidates(fixture.draft, events, 12)
        .map((candidate) => candidate.topicId);
      if (fixture.expected.startsWith('topic-')) {
        expect(candidateIds, fixture.case).toContain(fixture.expected);
      } else {
        expect(candidateIds.length, fixture.case).toBeGreaterThanOrEqual(2);
      }
    }
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
