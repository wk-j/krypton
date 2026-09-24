export const TIMELINE_RELATIONS = ['supersedes', 'refines', 'implements', 'supports', 'caused_by'] as const;

export type TimelineKind = 'event' | 'requirement' | 'decision' | 'implementation' | 'note';
export type TimelineRelation = typeof TIMELINE_RELATIONS[number];

export interface TimelineEvent {
  schema: number;
  id: string;
  topicId: string;
  topicTitle: string;
  kind: TimelineKind;
  summary: string;
  occurredAt: string;
  madeBy: string;
  recordedAt: string;
  recordedBy: string;
  recorderLane: string;
  sourceRef?: string;
  relation?: TimelineRelation;
  relatedEvent?: string;
  suggestedByLane?: string;
  evidenceExcerpt?: string;
  instructionExcerpt?: string;
  suggestionId?: string;
  rationale: string;
  impact: string;
  path: string;
  superseded: boolean;
}

export interface TimelineSuggestion {
  schema: number;
  id: string;
  topicTitle: string;
  summary: string;
  madeBy: string;
  occurredAt: string;
  evidenceExcerpt: string;
  rationale: string;
  impact: string;
  sourceRef?: string;
  suggestedAt: string;
  suggestedByLane: string;
  path: string;
}

export interface TimelineSuggestionListResponse {
  suggestions: TimelineSuggestion[];
  diagnostics: TimelineDiagnostic[];
}

export interface TimelineSuggestionSettings {
  automaticSuggestions: boolean;
}

export interface TimelineDiagnostic {
  path: string;
  error: string;
}

export interface TimelineListResponse {
  events: TimelineEvent[];
  diagnostics: TimelineDiagnostic[];
}

/** spec 266: `supersedes` chains and human-reviewed conflict pairs. */
export type TimelineConflictState =
  | 'unreviewed' | 'confirmed' | 'dismissed' | 'insufficient_evidence' | 'resolved' | 'historical';
export type TimelineConflictVerdict = 'confirmed' | 'dismissed' | 'insufficient_evidence' | 'resolved';

export interface TimelineConflictReview {
  id: string;
  verdict: TimelineConflictVerdict;
  rationale: string;
  sourceRef?: string;
  resolutionEventId?: string;
  reviewedBy: string;
  reviewedAt: string;
}

export interface TimelineConflictPair {
  pairId: string;
  eventA: string;
  eventB: string;
  state: TimelineConflictState;
  origin: 'manual' | 'typesafe';
  basis: string;
  suggestedAt: string;
  model?: string;
  probability?: number;
  reviews: TimelineConflictReview[];
}

export interface TimelineScanSummary {
  enabled: boolean;
  state: 'never_run' | 'completed' | 'partial';
  lastCompletedAt?: string;
  checkedPairs: number;
  skippedPairs: number;
  inconclusivePairs: number;
  reason?: string;
}

export interface TimelineTraceResponse extends TimelineListResponse {
  chains: Array<{ topicId: string; eventIds: string[]; links: Array<{ from: string; to: string; kind: 'supersedes' }> }>;
  conflictPairs: TimelineConflictPair[];
  conflictCounts: { needsReview: number; confirmed: number };
  scan: TimelineScanSummary;
}

export interface TimelineConflictScan {
  state: 'completed' | 'partial';
  checkedPairs: number;
  skippedPairs: number;
  proposedPairs: number;
  inconclusivePairs: number;
  reason?: string;
  path?: string;
}

/** Pairs whose time cell is marked: still to review, or confirmed and open. */
export function isHighlightedConflict(state: TimelineConflictState): boolean {
  return state === 'unreviewed' || state === 'insufficient_evidence' || state === 'confirmed';
}

export function conflictStateLabel(state: TimelineConflictState): string {
  switch (state) {
    case 'unreviewed': return 'ยังไม่ตรวจ';
    case 'confirmed': return 'ยืนยันว่าขัดกัน';
    case 'dismissed': return 'ไม่ขัดกัน';
    case 'insufficient_evidence': return 'หลักฐานไม่พอ';
    case 'resolved': return 'แก้แล้ว';
    case 'historical': return 'เป็นประวัติแล้ว';
  }
}

export interface TimelineRecordRequest {
  topicId: string;
  topicTitle: string;
  summary: string;
  occurredAt: string;
  madeBy: string;
  rationale: string;
  impact: string;
  sourceRef?: string;
  relation?: TimelineRelation;
  relatedEvent?: string;
  recorderLane: string;
}

export interface TimelineTopicCandidate {
  topicId: string;
  title: string;
  occurredAt: string;
  recentSummaries: string[];
  lexicalScore: number;
}

export interface TimelineTopicSemanticRequest {
  requestId: string;
  draft: { title: string; summary: string };
  candidates: TimelineTopicCandidate[];
}

export type TimelineTopicSemanticResult =
  | {
      kind: 'suggestion';
      requestId: string;
      topicId: string;
      title: string;
      confidence: number;
      probability: number;
      model: string;
      latencyMs: number;
    }
  | {
      kind: 'fallback';
      requestId: string;
      reason: 'create_new' | 'low_confidence' | 'disabled' | 'shadow' | 'missing_key'
        | 'cooldown' | 'cancelled' | 'timeout' | 'unavailable' | 'invalid_response';
      latencyMs: number;
    };

export type TimelineCommand =
  | { kind: 'open'; topic: string }
  | { kind: 'add'; topic: string }
  | { kind: 'trace'; topic: string }
  | { kind: 'review' }
  // spec 266: in-app conflict review sheet (propose / review / scan).
  | { kind: 'conflicts' }
  | { kind: 'auto'; state: 'status' | 'on' | 'off' }
  // spec 263: human-only repair for topics that were split before spec 262.
  | { kind: 'merge'; from: string; into: string }
  | { kind: 'mergeUndo' }
  | { kind: 'usage' };

/** spec 263: result of `#timeline merge <from> into <into>`. */
export interface TimelineMergeResult {
  mergeId: string;
  fromTopicId: string;
  fromTopicTitle: string;
  intoTopicId: string;
  intoTopicTitle: string;
  movedEvents: number;
  backupPath: string;
}

export interface TimelineMergeUndoResult {
  mergeId: string;
  fromTopicId: string;
  intoTopicId: string;
  restoredEvents: number;
}

export const TIMELINE_USAGE =
  'วิธีใช้: #timeline [open [<topic>] | add [<topic>] | review | conflicts | auto [on|off] '
  + '| merge <topic> into <topic> | merge undo | trace <topic> | <topic>]';

export function parseTimelineCommand(text: string): TimelineCommand {
  const args = text.trim().split(/\s+/).slice(1);
  if (args.length === 0) return { kind: 'open', topic: '' };
  const action = args[0].toLowerCase();
  if (action === 'open') return { kind: 'open', topic: args.slice(1).join(' ') };
  if (action === 'trace') {
    const topic = args.slice(1).join(' ').trim();
    return topic ? { kind: 'trace', topic } : { kind: 'usage' };
  }
  if (action === 'review') return args.length === 1 ? { kind: 'review' } : { kind: 'usage' };
  if (action === 'conflicts') return args.length === 1 ? { kind: 'conflicts' } : { kind: 'usage' };
  if (action === 'auto') {
    if (args.length === 1) return { kind: 'auto', state: 'status' };
    const state = args[1].toLowerCase();
    if (args.length === 2 && (state === 'on' || state === 'off')) return { kind: 'auto', state };
    return { kind: 'usage' };
  }
  if (action === 'merge') {
    const rest = args.slice(1).join(' ').trim();
    if (!rest) return { kind: 'usage' };
    if (rest.toLowerCase() === 'undo') return { kind: 'mergeUndo' };
    // greedy left side: the LAST ` into ` separates, so a source title that
    // itself contains the word still resolves.
    const parts = /^(.*\S)\s+into\s+(\S.*)$/i.exec(rest);
    if (!parts) return { kind: 'usage' };
    return { kind: 'merge', from: parts[1].trim(), into: parts[2].trim() };
  }
  if (action === 'add') {
    return {
      kind: 'add',
      topic: args.slice(1).join(' '),
    };
  }
  return { kind: 'open', topic: args.join(' ') };
}

export function topicIdForTitle(title: string): string {
  const normalized = title.normalize('NFKD').toLowerCase();
  const slug = normalized
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 56)
    .replace(/-+$/g, '');
  if (slug) return `topic-${slug}`;
  let hash = 0x811c9dc5;
  for (const char of title) {
    hash ^= char.codePointAt(0) ?? 0;
    hash = Math.imul(hash, 0x01000193);
  }
  return `topic-${(hash >>> 0).toString(16).padStart(8, '0')}`;
}

export function uniqueTopicIdForTitle(title: string, events: TimelineEvent[]): string {
  const base = topicIdForTitle(title);
  if (!events.some((event) => event.topicId === base)) return base;
  let hash = 0x811c9dc5;
  for (const char of title) {
    hash ^= char.codePointAt(0) ?? 0;
    hash = Math.imul(hash, 0x01000193);
  }
  return `${base}-${(hash >>> 0).toString(16).slice(0, 6)}`;
}

export function topicMatchScore(query: string, event: Pick<TimelineEvent, 'topicTitle' | 'summary' | 'madeBy' | 'sourceRef'>): number {
  const needle = query.trim().toLocaleLowerCase();
  if (!needle) return 1;
  const title = event.topicTitle.toLocaleLowerCase();
  if (title === needle) return 100;
  if (title.startsWith(needle)) return 80;
  if (title.includes(needle)) return 60;
  const haystack = [event.summary, event.madeBy, event.sourceRef ?? ''].join(' ').toLocaleLowerCase();
  const words = needle.split(/\s+/).filter(Boolean);
  return words.every((word) => haystack.includes(word)) ? 20 : 0;
}

export function latestTimelineTopics(events: TimelineEvent[]): Array<{ id: string; title: string; occurredAt: string }> {
  const topics = new Map<string, { id: string; title: string; occurredAt: string }>();
  for (const event of events) {
    const current = topics.get(event.topicId);
    if (!current || event.occurredAt >= current.occurredAt) {
      topics.set(event.topicId, { id: event.topicId, title: event.topicTitle, occurredAt: event.occurredAt });
    }
  }
  return [...topics.values()].sort((left, right) => right.occurredAt.localeCompare(left.occurredAt));
}

export function findExistingTopic(
  title: string,
  events: TimelineEvent[],
): { id: string; title: string } | null {
  const normalized = title.trim().toLocaleLowerCase();
  const exact = latestTimelineTopics(events).find((topic) => topic.title.trim().toLocaleLowerCase() === normalized);
  return exact ? { id: exact.id, title: exact.title } : null;
}

export function similarTimelineTopics(title: string, events: TimelineEvent[]): Array<{ id: string; title: string }> {
  const normalized = title.trim().toLocaleLowerCase();
  if (normalized.length < 3) return [];
  return latestTimelineTopics(events)
    .filter((topic) => {
      const candidate = topic.title.toLocaleLowerCase();
      return candidate.includes(normalized) || normalized.includes(candidate);
    })
    .map(({ id, title: topicTitle }) => ({ id, title: topicTitle }));
}

function truncateScalars(value: string, max: number): string {
  return Array.from(value).slice(0, max).join('');
}

/** Build the only Timeline data allowed to leave the app for semantic matching. */
export function buildTimelineTopicCandidates(
  draft: { title: string; summary: string },
  events: TimelineEvent[],
  requestedMaxCandidates: number,
): TimelineTopicCandidate[] {
  const title = draft.title.trim();
  const summary = draft.summary.trim();
  if (!title && !summary) return [];
  const maxCandidates = Math.max(2, Math.min(20, Math.floor(requestedMaxCandidates)));
  const grouped = new Map<string, TimelineEvent[]>();
  for (const event of [...events].sort((left, right) => right.occurredAt.localeCompare(left.occurredAt))) {
    const topicEvents = grouped.get(event.topicId) ?? [];
    topicEvents.push(event);
    grouped.set(event.topicId, topicEvents);
  }
  const candidates = [...grouped.entries()].map(([topicId, topicEvents]) => {
    const latest = topicEvents[0];
    const recentSummaries = [...new Set(topicEvents.map((event) => event.summary.trim()).filter(Boolean))]
      .slice(0, 2)
      .map((value) => truncateScalars(value, 240));
    const lexicalScore = topicEvents.reduce((best, event) => {
      const titleScore = title ? topicMatchScore(title, event) : 0;
      const summaryScore = summary ? topicMatchScore(summary, event) : 0;
      return Math.max(best, titleScore, summaryScore);
    }, 0);
    return {
      topicId,
      title: latest.topicTitle,
      occurredAt: latest.occurredAt,
      recentSummaries,
      lexicalScore,
    };
  });
  const ranked = candidates.sort((left, right) => (
    right.lexicalScore - left.lexicalScore || right.occurredAt.localeCompare(left.occurredAt)
  ));
  if (ranked.length <= maxCandidates) return ranked;
  const positive = ranked.filter((candidate) => candidate.lexicalScore > 0);
  if (positive.length === 0) return [];
  const selected = positive.slice(0, Math.min(8, maxCandidates));
  const selectedIds = new Set(selected.map((candidate) => candidate.topicId));
  const recent = [...candidates]
    .sort((left, right) => right.occurredAt.localeCompare(left.occurredAt))
    .filter((candidate) => !selectedIds.has(candidate.topicId));
  return [...selected, ...recent.slice(0, maxCandidates - selected.length)];
}

export const TIMELINE_CAPTURE_FIELDS = [
  'topic',
  'summary',
  'madeBy',
  'occurredAt',
  'sourceRef',
  'relation',
  'relatedEvent',
  'rationale',
  'impact',
] as const;

export function validateTimelineRecord(request: TimelineRecordRequest): string | null {
  if (!request.topicTitle.trim()) return 'กรุณาระบุหัวข้อ';
  if (!request.summary.trim()) return 'กรุณาระบุสรุป';
  if (!request.madeBy.trim()) return 'กรุณาระบุผู้ขอหรือผู้อนุมัติ';
  if (!request.occurredAt || Number.isNaN(Date.parse(request.occurredAt))) return 'วันเวลาที่เกิดเหตุการณ์ไม่ถูกต้อง';
  if (!!request.relation !== !!request.relatedEvent) return 'กรุณาเลือกความสัมพันธ์และเหตุการณ์ที่เกี่ยวข้องพร้อมกัน';
  return null;
}
