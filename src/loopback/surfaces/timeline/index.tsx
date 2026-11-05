// Spec 253 / 266 / 341 — the read-only project timeline: topic rail on the
// left, the event list on the right. Collapsed rows show time, the wrapping
// summary and who decided; Space / i open the context or audit body of the
// selected row only. The page only ever reads `/timeline.json`.
//
// Spec 361: a React page. Every transition reads the latest state from a ref
// and runs the old view's steps in the same order (a filter/topic/order/history
// change "re-renders": it closes the open detail and re-clamps the selection;
// moving the selection does not). Server text is rendered as text only.

import { memo, useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { FocusEvent, JSX, MouseEvent, ReactNode } from 'react';

import { Chip, EmptyState, fetchJson, HttpError, KbdHints, poll, SearchFilter, useKeymap, useLatest } from '../../kit';

import './timeline.css';

export interface TimelineEvent {
  readonly id: string;
  readonly topicId: string;
  readonly topicTitle: string;
  readonly occurredAt: string;
  readonly summary: string;
  readonly madeBy: string;
  readonly recordedBy: string;
  readonly recorderLane: string;
  readonly evidenceKind?: string | null;
  readonly evidenceExcerpt?: string | null;
  readonly instructionExcerpt?: string | null;
  readonly rationale?: string | null;
  readonly impact?: string | null;
  readonly relation?: string | null;
  readonly relatedEvent?: string | null;
  readonly sourceRef?: string | null;
  readonly suggestedByLane?: string | null;
  readonly superseded?: boolean;
}

export interface ConflictReview {
  readonly rationale: string;
  readonly reviewedBy: string;
  readonly reviewedAt: string;
}

export interface ConflictPair {
  readonly pairId: string;
  readonly eventA: string;
  readonly eventB: string;
  readonly state: string;
  readonly basis: string;
  readonly reviews?: readonly ConflictReview[];
}

export interface TimelinePayload {
  readonly events: readonly TimelineEvent[];
  readonly diagnostics: readonly { readonly path: string; readonly error: string }[];
  readonly conflictPairs?: readonly ConflictPair[];
}

interface Topic {
  readonly id: string;
  readonly title: string;
  readonly occurredAt: string;
  count: number;
}

type DetailMode = '' | 'context' | 'audit';

/** One payload with its lookups; built once per applied load, never mutated. */
interface Indexed {
  readonly payload: TimelinePayload;
  readonly pairsByEvent: ReadonlyMap<string, readonly ConflictPair[]>;
  readonly supersededBy: ReadonlyMap<string, readonly TimelineEvent[]>;
  readonly eventsById: ReadonlyMap<string, TimelineEvent>;
}

interface ViewState {
  /** `null` until the first load applied. */
  readonly data: Indexed | null;
  readonly query: string;
  readonly selectedTopic: string;
  readonly selectedEvent: number;
  readonly newestFirst: boolean;
  readonly showSuperseded: boolean;
  readonly detailMode: DetailMode;
  /** A refresh failed since the last re-render (count suffix). */
  readonly stale: boolean;
  /** The first load failed: shown in place of the list. */
  readonly loadError: string;
}

export const CONFLICT_SR_TEXT = 'มีบันทึกอีกข้อที่ให้คำสั่งต่างกัน';

const STALE_SUFFIX = ' · โหลดข้อมูลล่าสุดไม่สำเร็จ';

const RELATION_LABELS: Readonly<Record<string, string>> = {
  supersedes: 'แทนที่',
  refines: 'ปรับรายละเอียดของ',
  implements: 'นำไปใช้จาก',
  supports: 'สนับสนุน',
  caused_by: 'เกิดจาก',
};

const STATE_LABELS: Readonly<Record<string, string>> = {
  unreviewed: 'ยังไม่ตรวจ',
  confirmed: 'ยืนยันว่าขัดกัน',
  dismissed: 'ไม่ขัดกัน',
  insufficient_evidence: 'หลักฐานไม่พอ',
  resolved: 'แก้แล้ว',
  historical: 'เป็นประวัติแล้ว',
};

const HINTS: readonly (readonly [string, string])[] = [
  ['j / k', 'เลื่อน'],
  ['Space', 'รายละเอียด'],
  ['i', 'ข้อมูลการบันทึก'],
  ['p', 'ไปอีกรายการของคู่'],
  ['h', 'แสดง/ซ่อนรายการที่ถูกแทนที่'],
  ['Enter', 'เปิดแหล่งอ้างอิง'],
  ['r', 'สลับลำดับ'],
  ['/', 'ค้นหา'],
  ['[ ]', 'เปลี่ยนหัวข้อ'],
  ['Esc', 'ล้างตัวกรอง'],
];

const HINTS_NOTE =
  'เวลาที่มีพื้นสี = มีบันทึกอีกข้อให้คำสั่งต่างกัน ยังไม่ได้ตัดสินว่าข้อใดถูก · lane agent ตรวจให้เองหลังบันทึก หรือสั่งด้วย #timeline conflicts [<topic>]';

function lower(value: string | null | undefined): string {
  return String(value ?? '').toLocaleLowerCase('th-TH');
}

function evidenceKindLabel(kind: string | null | undefined): string {
  switch (kind) {
    case 'user_statement':
      return 'คำกล่าวของผู้ใช้';
    case 'observed_outcome':
      return 'ผลที่ตรวจพบ';
    case 'agent_decision':
      return 'การตัดสินใจของ LLM';
    default:
      return kind ?? '';
  }
}

function latestTopics(events: readonly TimelineEvent[]): Topic[] {
  const map = new Map<string, Topic>();
  for (const event of events) {
    const prior = map.get(event.topicId);
    if (!prior || event.occurredAt >= prior.occurredAt) {
      map.set(event.topicId, { id: event.topicId, title: event.topicTitle, occurredAt: event.occurredAt, count: 0 });
    }
  }
  for (const event of events) {
    const topic = map.get(event.topicId);
    if (topic) topic.count += 1;
  }
  return [...map.values()].sort((a, b) => b.occurredAt.localeCompare(a.occurredAt));
}

function eventMatches(event: TimelineEvent, query: string): boolean {
  if (!query) return true;
  return lower(
    [
      event.topicTitle,
      event.summary,
      event.madeBy,
      event.recordedBy,
      event.evidenceKind ?? '',
      evidenceKindLabel(event.evidenceKind),
      event.evidenceExcerpt ?? '',
      event.instructionExcerpt ?? '',
      event.rationale ?? '',
      event.impact ?? '',
      event.sourceRef ?? '',
    ].join(' '),
  ).includes(query);
}

function isHighlighted(pair: ConflictPair): boolean {
  return pair.state === 'unreviewed' || pair.state === 'insufficient_evidence' || pair.state === 'confirmed';
}

function partnerId(pair: ConflictPair, id: string): string {
  return pair.eventA === id ? pair.eventB : pair.eventA;
}

function timeLabel(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value.slice(11, 16);
  return date.toLocaleTimeString('th-TH', { hour: '2-digit', minute: '2-digit', hour12: false });
}

function dayLabel(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value.slice(0, 10);
  return date.toLocaleDateString('th-TH', { weekday: 'short', year: 'numeric', month: 'short', day: 'numeric' });
}

function sourceHref(harness: string, source: string | null | undefined): string {
  if (!source) return '';
  if (/^https?:\/\//i.test(source)) return source;
  if (/\.md(?:#.*)?$/i.test(source) && !source.startsWith('/')) {
    const [path, anchor] = source.split('#');
    return `/doc?harness=${encodeURIComponent(harness)}&path=${encodeURIComponent(path)}${anchor ? `#${encodeURIComponent(anchor)}` : ''}`;
  }
  return '';
}

function indexPayload(data: TimelinePayload): Indexed {
  const payload: TimelinePayload = { ...data, conflictPairs: data.conflictPairs ?? [] };
  const pairsByEvent = new Map<string, ConflictPair[]>();
  const supersededBy = new Map<string, TimelineEvent[]>();
  const eventsById = new Map<string, TimelineEvent>();
  for (const event of payload.events) {
    eventsById.set(event.id, event);
    if (event.relation === 'supersedes' && event.relatedEvent) {
      const list = supersededBy.get(event.relatedEvent) ?? [];
      list.push(event);
      supersededBy.set(event.relatedEvent, list);
    }
  }
  for (const pair of payload.conflictPairs ?? []) {
    for (const id of [pair.eventA, pair.eventB]) {
      const list = pairsByEvent.get(id) ?? [];
      list.push(pair);
      pairsByEvent.set(id, list);
    }
  }
  return { payload, pairsByEvent, supersededBy, eventsById };
}

function openPairs(data: Indexed, event: TimelineEvent): ConflictPair[] {
  return (data.pairsByEvent.get(event.id) ?? []).filter(isHighlighted);
}

function hasContext(data: Indexed, event: TimelineEvent): boolean {
  return Boolean(
    event.rationale ||
      event.impact ||
      (event.relation && event.relatedEvent) ||
      event.sourceRef ||
      data.supersededBy.has(event.id) ||
      data.pairsByEvent.has(event.id),
  );
}

function displayEvents(state: ViewState): readonly TimelineEvent[] {
  const events = state.data?.payload.events ?? [];
  return state.showSuperseded ? events : events.filter((event) => !event.superseded);
}

function visibleEvents(state: ViewState): TimelineEvent[] {
  const query = lower(state.query.trim());
  const events = displayEvents(state).filter(
    (event) => (!state.selectedTopic || event.topicId === state.selectedTopic) && eventMatches(event, query),
  );
  return state.newestFirst ? events.reverse() : events;
}

/** The old full re-render: close the detail, drop a vanished topic, clamp the selection. */
function settle(state: ViewState): ViewState {
  if (!state.data) return state;
  const topics = latestTopics(displayEvents(state));
  const selectedTopic =
    state.selectedTopic && !topics.some((topic) => topic.id === state.selectedTopic) ? '' : state.selectedTopic;
  const next: ViewState = { ...state, selectedTopic, detailMode: '', stale: false };
  const count = visibleEvents(next).length;
  return next.selectedEvent >= count ? { ...next, selectedEvent: Math.max(0, count - 1) } : next;
}

/** Move the selection; a different row closes the open detail. */
function selectIndex(state: ViewState, index: number): ViewState {
  const count = visibleEvents(state).length;
  if (count === 0) return state;
  const next = Math.max(0, Math.min(count - 1, index));
  return next === state.selectedEvent ? state : { ...state, selectedEvent: next, detailMode: '' };
}

function initialState(query: string): ViewState {
  return {
    data: null,
    query,
    selectedTopic: '',
    selectedEvent: 0,
    newestFirst: false,
    showSuperseded: false,
    detailMode: '',
    stale: false,
    loadError: '',
  };
}

function CopyBlock({ label, text }: { readonly label: string; readonly text: string }): JSX.Element {
  return (
    <div className="lb-timeline__copy">
      <span className="lb-timeline__label">{`${label} · `}</span>
      {text}
    </div>
  );
}

interface JumpProps {
  readonly text: string;
  readonly id: string;
  readonly onJump: (id: string) => void;
}

function Jump({ text, id, onJump }: JumpProps): JSX.Element {
  return (
    <button
      className="lb-timeline__jump"
      type="button"
      onClick={(event: MouseEvent<HTMLButtonElement>): void => {
        event.stopPropagation();
        onJump(id);
      }}
    >
      {text}
    </button>
  );
}

interface DetailProps {
  readonly data: Indexed;
  readonly event: TimelineEvent;
  readonly mode: 'context' | 'audit';
  readonly harness: string;
  readonly onJump: (id: string) => void;
}

/** Opt-in context/audit body for the selected row only. */
function Detail({ data, event, mode, harness, onJump }: DetailProps): JSX.Element {
  const children: ReactNode[] = [];
  if (event.rationale) children.push(<CopyBlock key="rationale" label="เหตุผล" text={event.rationale} />);
  if (event.impact) children.push(<CopyBlock key="impact" label="ผลกระทบ" text={event.impact} />);
  if (event.relation && event.relatedEvent) {
    const related = data.eventsById.get(event.relatedEvent);
    children.push(
      <div key="relation" className="lb-timeline__relation">
        {`${RELATION_LABELS[event.relation] ?? event.relation} · `}
        {related ? <Jump text={related.summary} id={related.id} onJump={onJump} /> : event.relatedEvent}
      </div>,
    );
  }
  (data.supersededBy.get(event.id) ?? []).forEach((newer, i) => {
    children.push(
      <div key={`newer:${i}`} className="lb-timeline__relation">
        {'ถูกแทนที่โดย · '}
        <Jump text={newer.summary} id={newer.id} onJump={onJump} />
      </div>,
    );
  });
  (data.pairsByEvent.get(event.id) ?? []).forEach((pair, i) => {
    const partner = data.eventsById.get(partnerId(pair, event.id));
    const latest = pair.reviews && pair.reviews.length ? pair.reviews[pair.reviews.length - 1] : null;
    children.push(
      <div key={`pair:${i}`} className="lb-timeline__conflict-note">
        <div>
          <span className="lb-timeline__label">{`${STATE_LABELS[pair.state] ?? pair.state} · อีกรายการ · `}</span>
          {partner ? <Jump text={`${partner.summary} (${partner.madeBy})`} id={partner.id} onJump={onJump} /> : null}
        </div>
        <div className="lb-timeline__label">
          {latest
            ? `ผลตรวจ · ${latest.rationale} · ${latest.reviewedBy} · ${latest.reviewedAt.slice(0, 10)}`
            : `เหตุที่นำมาดู · ${pair.basis}`}
        </div>
      </div>,
    );
  });
  const href = sourceHref(harness, event.sourceRef);
  if (href) {
    children.push(
      <a
        key="source"
        className="lb-timeline__source"
        title={event.sourceRef ?? undefined}
        href={href}
        target="_blank"
        rel="noopener noreferrer"
      >
        เปิดแหล่งอ้างอิง ↗
      </a>,
    );
  }
  if (mode === 'audit') {
    const rows: [string, string][] = [
      ['บันทึกโดย', `${event.recordedBy} · ${event.recorderLane}`],
      ['หัวข้อ', `${event.topicTitle} · ${event.topicId}`],
      ['เหตุการณ์', event.id],
    ];
    if (event.evidenceKind) rows.push(['ประเภทหลักฐาน', evidenceKindLabel(event.evidenceKind)]);
    if (event.suggestedByLane) rows.push(['เสนอโดย', event.suggestedByLane]);
    if (event.relatedEvent) rows.push(['เหตุการณ์ที่เกี่ยวข้อง', event.relatedEvent]);
    children.push(
      <dl key="audit" className="lb-timeline__audit">
        {rows.flatMap(([k, v], i) => [<dt key={`dt:${i}`}>{k}</dt>, <dd key={`dd:${i}`}>{v}</dd>])}
      </dl>,
    );
    if (event.evidenceExcerpt) children.push(<CopyBlock key="evidence" label="หลักฐาน" text={event.evidenceExcerpt} />);
    if (event.instructionExcerpt) {
      children.push(<CopyBlock key="instruction" label="คำสั่งที่อนุญาตให้บันทึก" text={event.instructionExcerpt} />);
    }
    if (event.sourceRef) {
      children.push(
        <div key="source-ref" className="lb-timeline__source-ref">
          {event.sourceRef}
        </div>,
      );
    }
  }
  return (
    <div className={`lb-timeline__detail lb-timeline__detail--${mode}`} id={`timeline-detail-${event.id}`}>
      {children}
    </div>
  );
}

interface RowProps {
  readonly data: Indexed;
  readonly event: TimelineEvent;
  readonly index: number;
  readonly selected: boolean;
  /** The open detail; only ever set on the selected row. */
  readonly mode: DetailMode;
  readonly showTopic: boolean;
  readonly harness: string;
  readonly onJump: (id: string) => void;
}

/** Collapsed row: time, full wrapping summary, who decided, topic pill. */
const TimelineRow = memo(function TimelineRow({
  data,
  event,
  index,
  selected,
  mode,
  showTopic,
  harness,
  onJump,
}: RowProps): JSX.Element {
  const conflicted = openPairs(data, event).length > 0;
  const context = hasContext(data, event);
  let className = 'lb-timeline__event';
  if (event.superseded) className += ' lb-timeline__event--superseded';
  if (conflicted) className += ' lb-timeline__event--conflict';
  if (selected) className += ' lb-timeline__event--selected';
  return (
    <article
      className={className}
      data-event-index={index}
      data-event-id={event.id}
      tabIndex={0}
      aria-label={conflicted ? `${event.summary} — ${CONFLICT_SR_TEXT}` : event.summary}
    >
      <div className="lb-timeline__head">
        <span className={conflicted ? 'lb-timeline__time conflict' : 'lb-timeline__time'}>
          {timeLabel(event.occurredAt)}
          {conflicted ? <span className="lb-sr">{CONFLICT_SR_TEXT}</span> : null}
        </span>
        <span className="lb-timeline__text" title={event.summary}>
          {event.summary}
        </span>
        <div className="lb-timeline__meta">
          <span className="lb-timeline__who" title={event.madeBy}>
            {event.madeBy}
          </span>
          {showTopic ? <span className="lb-timeline__topic-pill">{event.topicTitle}</span> : null}
          <button
            className="lb-timeline__toggle"
            data-detail-mode={context ? 'context' : 'audit'}
            type="button"
            aria-expanded={selected && Boolean(mode) ? 'true' : 'false'}
            aria-controls={`timeline-detail-${event.id}`}
          >
            {context ? 'รายละเอียด' : 'ข้อมูลบันทึก'}
          </button>
        </div>
      </div>
      {selected && mode ? <Detail data={data} event={event} mode={mode} harness={harness} onJump={onJump} /> : null}
    </article>
  );
});

/** Load once, then again on focus / visibility (at most once a second). No interval. */
export function TimelinePage(): JSX.Element {
  const [params] = useState(() => new URLSearchParams(location.search));
  const harness = params.get('harness') ?? '';
  const initialQuery = params.get('topic') ?? '';
  const initialEvent = params.get('event') ?? '';

  const [state, setState] = useState<ViewState>(() => initialState(initialQuery));
  // The latest state, ahead of React's commit, so back-to-back steps compose.
  const current = useRef(state);
  const committed = useRef(state);
  const focusPending = useRef(false);
  const eventsRef = useRef<HTMLDivElement | null>(null);

  const update = (next: ViewState): void => {
    if (next === current.current) return;
    current.current = next;
    setState(next);
  };

  const focusRow = (): void => {
    const card = eventsRef.current?.querySelector<HTMLElement>(
      `.lb-timeline__event[data-event-index="${current.current.selectedEvent}"]`,
    );
    if (!card) return;
    card.focus({ preventScroll: true });
    card.scrollIntoView?.({ block: 'nearest' });
  };

  /** Focus and reveal the selected row once the DOM shows it. */
  const revealSelected = (): void => {
    if (current.current === committed.current) focusRow();
    else focusPending.current = true;
  };

  useLayoutEffect(() => {
    committed.current = state;
    if (!focusPending.current) return;
    focusPending.current = false;
    focusRow();
  });

  /** Move selection without opening provenance or re-rendering the list. */
  const select = (index: number, scroll: boolean): void => {
    if (visibleEvents(current.current).length === 0) return;
    update(selectIndex(current.current, index));
    if (scroll) revealSelected();
  };

  /** Select an event by ID, widening the filter if it is hidden, and keep the URL shareable. */
  const jumpTo = (id: string): void => {
    let next = current.current;
    const target = next.data?.eventsById.get(id);
    if (!target) return;
    if (target.superseded && !next.showSuperseded) {
      next = settle({ ...next, showSuperseded: true });
      update(next);
    }
    let index = visibleEvents(next).findIndex((event) => event.id === id);
    if (index < 0) {
      const selectedTopic =
        next.selectedTopic && next.selectedTopic !== target.topicId ? target.topicId : next.selectedTopic;
      next = settle({ ...next, query: '', selectedTopic });
      update(next);
      index = visibleEvents(next).findIndex((event) => event.id === id);
    }
    if (index < 0) return;
    select(index, true);
    const query = new URLSearchParams(location.search);
    if (current.current.selectedTopic) query.set('topic', current.current.selectedTopic);
    else query.delete('topic');
    query.set('event', id);
    history.replaceState(null, '', `${location.pathname}?${query.toString()}`);
  };

  const toggleDetail = (mode: 'context' | 'audit'): void => {
    const now = current.current;
    if (!visibleEvents(now)[now.selectedEvent]) return;
    update({ ...now, detailMode: now.detailMode === mode ? '' : mode });
  };

  const switchTopic = (delta: number): void => {
    const now = current.current;
    const ids = ['', ...latestTopics(displayEvents(now)).map((topic) => topic.id)];
    const index = Math.max(0, ids.indexOf(now.selectedTopic));
    update(settle({ ...now, selectedTopic: ids[(index + delta + ids.length) % ids.length], selectedEvent: 0 }));
  };

  const toggleSuperseded = (): void => {
    const now = current.current;
    const selected = visibleEvents(now)[now.selectedEvent];
    const next = settle({ ...now, showSuperseded: !now.showSuperseded });
    update(next);
    const target = selected && (next.showSuperseded || !selected.superseded) ? selected : visibleEvents(next)[next.selectedEvent];
    if (target) jumpTo(target.id);
  };

  const applyPayload = (payload: TimelinePayload, selectedId: string | null): void => {
    const now = current.current;
    const refresh = now.data !== null;
    let next: ViewState = { ...now, data: indexPayload(payload) };
    if (!refresh && initialQuery) {
      const query = lower(initialQuery);
      const match = latestTopics(payload.events).find(
        (topic) => lower(topic.title) === query || lower(topic.id) === query,
      );
      if (match) next = { ...next, selectedTopic: match.id, query: '' };
    }
    update(settle(next));
    if (refresh && selectedId) jumpTo(selectedId);
    else if (!refresh && initialEvent) jumpTo(initialEvent);
  };

  const onFailure = (error: unknown): void => {
    const now = current.current;
    if (!now.data) {
      const message =
        error instanceof HttpError ? `โหลด timeline ไม่สำเร็จ (${error.status})` : String((error as Error | undefined)?.message ?? error);
      update({ ...now, loadError: message });
    } else if (!now.stale) {
      update({ ...now, stale: true });
    }
  };

  const handlers = useLatest({ applyPayload, onFailure, jumpTo });
  const onJump = useCallback((id: string): void => handlers.current.jumpTo(id), [handlers]);

  useEffect(() => {
    if (!harness) return undefined;
    let selectedId: string | null = null;
    const poller = poll<TimelinePayload>({
      load: (signal) => {
        const now = current.current;
        selectedId = now.data ? (visibleEvents(now)[now.selectedEvent]?.id ?? null) : null;
        return fetchJson<TimelinePayload>(`/timeline.json?harness=${encodeURIComponent(harness)}`, { signal });
      },
      apply: (data) => handlers.current.applyPayload(data, selectedId),
      onStatus: (status, error) => {
        if (status === 'reconnecting') handlers.current.onFailure(error);
      },
      refreshOnFocus: true,
      minGapMs: 1000,
    });
    return () => poller.dispose();
  }, [harness, handlers]);

  const onRow = (event: KeyboardEvent): boolean =>
    event.target instanceof Element && event.target.closest('button, a') !== null;
  const selectedNow = (): TimelineEvent | undefined => visibleEvents(current.current)[current.current.selectedEvent];

  useKeymap([
    {
      key: 'Escape',
      label: 'ล้างตัวกรอง',
      run: () => update(settle({ ...current.current, query: '', selectedEvent: 0 })),
    },
    { key: 'h', label: 'แสดง/ซ่อนรายการที่ถูกแทนที่', run: () => toggleSuperseded() },
    { key: '[', label: 'หัวข้อก่อนหน้า', run: () => switchTopic(-1) },
    { key: ']', label: 'หัวข้อถัดไป', run: () => switchTopic(1) },
    {
      key: 'r',
      label: 'สลับลำดับ',
      run: () => update(settle({ ...current.current, newestFirst: !current.current.newestFirst, selectedEvent: 0 })),
    },
    {
      key: ['j', 'k'],
      display: 'j / k',
      label: 'เลื่อน',
      run: (event) => {
        if (onRow(event)) return false;
        select(current.current.selectedEvent + (event.key === 'j' ? 1 : -1), true);
      },
    },
    {
      key: ' ',
      label: 'รายละเอียด',
      run: (event) => {
        const selected = selectedNow();
        const data = current.current.data;
        if (onRow(event) || !selected || !data) return false;
        toggleDetail(hasContext(data, selected) ? 'context' : 'audit');
      },
    },
    {
      key: 'i',
      label: 'ข้อมูลการบันทึก',
      run: (event) => {
        if (onRow(event) || !selectedNow()) return false;
        toggleDetail('audit');
      },
    },
    {
      key: 'p',
      label: 'ไปอีกรายการของคู่',
      run: (event) => {
        const selected = selectedNow();
        const data = current.current.data;
        if (onRow(event) || !selected || !data) return false;
        const open = openPairs(data, selected);
        const all = open.length ? open : (data.pairsByEvent.get(selected.id) ?? []);
        if (!all.length) return false;
        jumpTo(partnerId(all[0], selected.id));
      },
    },
    {
      key: 'Enter',
      label: 'เปิดแหล่งอ้างอิง',
      run: (event) => {
        const selected = selectedNow();
        if (onRow(event) || !selected) return false;
        const href = sourceHref(harness, selected.sourceRef);
        if (!href) return false;
        window.open(href, '_blank', 'noopener');
      },
    },
  ]);

  const rowIndex = (target: EventTarget): number | null => {
    const row = target instanceof Element ? target.closest<HTMLElement>('.lb-timeline__event') : null;
    return row ? Number(row.dataset.eventIndex) : null;
  };

  const onEventsClick = (event: MouseEvent<HTMLDivElement>): void => {
    const index = rowIndex(event.target);
    if (index === null || !(event.target instanceof Element)) return;
    select(index, false);
    const toggle = event.target.closest<HTMLElement>('.lb-timeline__toggle');
    if (toggle) toggleDetail(toggle.dataset.detailMode === 'audit' ? 'audit' : 'context');
  };

  const onEventsFocus = (event: FocusEvent<HTMLDivElement>): void => {
    const index = rowIndex(event.target);
    if (index !== null) select(index, false);
  };

  const { data } = state;
  const query = lower(state.query.trim());
  const shown = displayEvents(state);
  const topics = data ? latestTopics(shown) : [];
  const events = data ? visibleEvents(state) : [];
  const supersededCount = data ? data.payload.events.filter((event) => event.superseded).length : 0;
  const activeTopic = topics.find((topic) => topic.id === state.selectedTopic);
  const pending = new Set<string>();
  if (data) for (const event of events) for (const pair of openPairs(data, event)) pending.add(pair.pairId);

  const topicButton = (id: string, title: string, count: number, tooltip?: string): JSX.Element => (
    <button
      key={id ? `topic:${id}` : 'all'}
      className={state.selectedTopic === id ? 'lb-timeline__topic lb-timeline__topic--active' : 'lb-timeline__topic'}
      title={tooltip}
      type="button"
      onClick={(): void => update(settle({ ...current.current, selectedTopic: id, selectedEvent: 0 }))}
    >
      <strong>{title}</strong>
      <span>{String(count)}</span>
    </button>
  );

  let list: ReactNode = null;
  if (!harness) list = <EmptyState text="ไม่พบ harness id" />;
  else if (!data) list = state.loadError ? <EmptyState text={state.loadError} /> : null;
  else {
    const children: ReactNode[] = [];
    if (events.length === 0) children.push(<EmptyState key="empty" text="ไม่พบเหตุการณ์ที่ตรงกับตัวกรอง" />);
    let day = '';
    events.forEach((event, index) => {
      const key = String(event.occurredAt).slice(0, 10);
      if (key !== day) {
        day = key;
        children.push(
          <div key={`day:${index}`} className="lb-timeline__day">
            {dayLabel(event.occurredAt)}
          </div>,
        );
      }
      const selected = index === state.selectedEvent;
      children.push(
        <TimelineRow
          key={event.id}
          data={data}
          event={event}
          index={index}
          selected={selected}
          mode={selected ? state.detailMode : ''}
          showTopic={!state.selectedTopic}
          harness={harness}
          onJump={onJump}
        />,
      );
    });
    list = children;
  }

  return (
    <div className="lb-page lb-page--wide lb-timeline">
      <div className="lb-timeline__toolbar">
        <Chip text="เฉพาะเครื่องนี้" />
        <SearchFilter
          placeholder="ค้นหาสรุป ผู้เกี่ยวข้อง และแหล่งอ้างอิง · /"
          value={state.query}
          escape="clear-and-leave"
          count={data ? `${events.length}` : undefined}
          onChange={(value): void => update(settle({ ...current.current, query: value, selectedEvent: 0 }))}
        />
      </div>
      <div className="lb-split lb-timeline__layout">
        <aside className="lb-timeline__rail">
          <div className="lb-timeline__rail-title">หัวข้อ · [ ] เปลี่ยน</div>
          <div className="lb-timeline__topics">
            {data
              ? [
                  topicButton('', 'ทุกรายการ', shown.length),
                  ...topics
                    .filter((topic) => !query || lower(topic.title).includes(query))
                    .map((topic) =>
                      topicButton(topic.id, topic.title, topic.count, `${topic.title} · ${topic.occurredAt.slice(0, 10)}`),
                    ),
                ]
              : null}
          </div>
        </aside>
        <section className="lb-timeline__main">
          <div className="lb-timeline__summary">
            <h1 className="lb-timeline__title">{activeTopic ? activeTopic.title : 'ลำดับเหตุการณ์'}</h1>
            <span className="lb-timeline__count">
              {data
                ? `${events.length} รายการ${pending.size ? ` · ${pending.size} คู่ให้คำสั่งต่างกัน` : ''} · ${state.newestFirst ? 'ใหม่ไปเก่า' : 'เก่าไปใหม่'}${state.stale ? STALE_SUFFIX : ''}`
                : null}
            </span>
            <button
              className="lb-timeline__history"
              type="button"
              aria-pressed={state.showSuperseded && data ? 'true' : 'false'}
              hidden={supersededCount === 0}
              onClick={(): void => toggleSuperseded()}
            >
              {data
                ? state.showSuperseded
                  ? 'ซ่อนรายการที่ถูกแทนที่'
                  : `แสดงรายการที่ถูกแทนที่ (${supersededCount})`
                : null}
            </button>
          </div>
          <div className="lb-timeline__events" ref={eventsRef} onClick={onEventsClick} onFocus={onEventsFocus}>
            {list}
          </div>
          <section className="lb-timeline__diagnostics" hidden={!data || data.payload.diagnostics.length === 0}>
            <h2>ข้อมูลผิดพลาด</h2>
            <ul>
              {(data?.payload.diagnostics ?? []).map((item, i) => (
                <li key={i}>{`${item.path} · ${item.error}`}</li>
              ))}
            </ul>
          </section>
          <KbdHints entries={HINTS} note={HINTS_NOTE} />
        </section>
      </div>
    </div>
  );
}
