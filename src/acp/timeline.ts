export type TimelineKind = 'event' | 'requirement' | 'decision' | 'implementation' | 'note';
export type TimelineRelation = 'supersedes' | 'refines' | 'implements' | 'supports' | 'caused_by';

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
  evidenceKind?: 'user_statement' | 'observed_outcome' | 'agent_decision';
  instructionExcerpt?: string;
  suggestionId?: string;
  rationale: string;
  impact: string;
  path: string;
  superseded: boolean;
}

export interface TimelineSettings {
  automaticRecording: boolean;
}

export interface TimelineDiagnostic {
  path: string;
  error: string;
}

export interface TimelineListResponse {
  events: TimelineEvent[];
  diagnostics: TimelineDiagnostic[];
}

/** spec 266: `supersedes` chains and conflict pairs (judged by the lane agent since spec 267). */
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
  origin: 'agent' | 'manual' | 'typesafe';
  basis: string;
  suggestedAt: string;
  model?: string;
  probability?: number;
  reviews: TimelineConflictReview[];
}

export interface TimelineTraceResponse extends TimelineListResponse {
  chains: Array<{ topicId: string; eventIds: string[]; links: Array<{ from: string; to: string; kind: 'supersedes' }> }>;
  conflictPairs: TimelineConflictPair[];
  conflictCounts: { needsReview: number; confirmed: number };
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

export type TimelineCommand =
  | { kind: 'open'; topic: string }
  | { kind: 'trace'; topic: string }
  // spec 267: the lane agent checks unchecked events (optionally one topic).
  | { kind: 'conflicts'; topic: string }
  | { kind: 'auto'; state: 'status' | 'on' | 'off' }
  | { kind: 'usage' };

export const TIMELINE_USAGE =
  'วิธีใช้: #timeline [open [<topic>] | trace <topic> | conflicts [<topic>] | auto [on|off] | <topic>]';

export function parseTimelineCommand(text: string): TimelineCommand {
  const args = text.trim().split(/\s+/).slice(1);
  if (args.length === 0) return { kind: 'open', topic: '' };
  const action = args[0].toLowerCase();
  if (action === 'open') return { kind: 'open', topic: args.slice(1).join(' ') };
  if (action === 'trace') {
    const topic = args.slice(1).join(' ').trim();
    return topic ? { kind: 'trace', topic } : { kind: 'usage' };
  }
  if (action === 'conflicts') return { kind: 'conflicts', topic: args.slice(1).join(' ').trim() };
  if (action === 'auto') {
    if (args.length === 1) return { kind: 'auto', state: 'status' };
    const state = args[1].toLowerCase();
    if (args.length === 2 && (state === 'on' || state === 'off')) return { kind: 'auto', state };
    return { kind: 'usage' };
  }
  return { kind: 'open', topic: args.join(' ') };
}

