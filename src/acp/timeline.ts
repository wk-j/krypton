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

export type TimelineCommand =
  | { kind: 'open'; topic: string }
  | { kind: 'add'; topic: string }
  | { kind: 'trace'; topic: string }
  | { kind: 'review' }
  | { kind: 'auto'; state: 'status' | 'on' | 'off' }
  | { kind: 'usage' };

export const TIMELINE_USAGE =
  'วิธีใช้: #timeline [open [<topic>] | add [<topic>] | review | auto [on|off] | trace <topic> | <topic>]';

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
  if (action === 'auto') {
    if (args.length === 1) return { kind: 'auto', state: 'status' };
    const state = args[1].toLowerCase();
    if (args.length === 2 && (state === 'on' || state === 'off')) return { kind: 'auto', state };
    return { kind: 'usage' };
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
