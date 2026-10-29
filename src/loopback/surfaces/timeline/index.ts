// Spec 253 / 266 / 341 — the read-only project timeline: topic rail on the
// left, the event list on the right. Collapsed rows show time, the wrapping
// summary and who decided; Space / i open the context or audit body of the
// selected row only. The page only ever reads `/timeline.json`.

import { DisposableBag } from '../../../ui/component';
import { el } from '../../../ui/dom';
import { chip, emptyState, fetchJson, HttpError, kbdHints, keymap, poll, SearchFilter } from '../../kit';
import type { Poller } from '../../kit';

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

export const CONFLICT_SR_TEXT = 'มีบันทึกอีกข้อที่ให้คำสั่งต่างกัน';

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

function copyBlock(label: string, text: string): HTMLElement {
  return el('div', { class: 'lb-timeline__copy' }, el('span', { class: 'lb-timeline__label', text: `${label} · ` }), text);
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

export class TimelineView {
  readonly el: HTMLElement;
  private readonly filter: SearchFilter;
  private readonly topicsEl = el('div', { class: 'lb-timeline__topics' });
  private readonly titleEl = el('h1', { class: 'lb-timeline__title', text: 'ลำดับเหตุการณ์' });
  private readonly countEl = el('span', { class: 'lb-timeline__count' });
  private readonly historyToggle = el('button', {
    class: 'lb-timeline__history',
    attrs: { type: 'button', 'aria-pressed': 'false', hidden: true },
  });
  private readonly eventsEl = el('div', { class: 'lb-timeline__events' });
  private readonly diagnosticsList = el('ul');
  private readonly diagnosticsEl = el(
    'section',
    { class: 'lb-timeline__diagnostics', attrs: { hidden: true } },
    el('h2', { text: 'ข้อมูลผิดพลาด' }),
    this.diagnosticsList,
  );
  private readonly bag = new DisposableBag();
  private poller: Poller | null = null;

  private payload: TimelinePayload = { events: [], diagnostics: [], conflictPairs: [] };
  private pairsByEvent = new Map<string, ConflictPair[]>();
  private supersededBy = new Map<string, TimelineEvent[]>();
  private eventsById = new Map<string, TimelineEvent>();
  private selectedTopic = '';
  private selectedEvent = 0;
  private newestFirst = false;
  private showSuperseded = false;
  private detailMode: DetailMode = '';
  private rows: HTMLElement[] = [];
  private loaded = false;
  private readonly initialQuery: string;
  private readonly initialEvent: string;

  constructor(private readonly harness: string, params: URLSearchParams) {
    this.initialQuery = params.get('topic') ?? '';
    this.initialEvent = params.get('event') ?? '';
    this.filter = new SearchFilter({
      placeholder: 'ค้นหาสรุป ผู้เกี่ยวข้อง และแหล่งอ้างอิง · /',
      initial: this.initialQuery,
      escape: 'clear-and-leave',
      onInput: () => {
        this.selectedEvent = 0;
        this.render();
      },
    });
    this.el = el(
      'div',
      { class: 'lb-page lb-page--wide lb-timeline' },
      el('div', { class: 'lb-timeline__toolbar' }, chip('เฉพาะเครื่องนี้'), this.filter.el),
      el(
        'div',
        { class: 'lb-split lb-timeline__layout' },
        el(
          'aside',
          { class: 'lb-timeline__rail' },
          el('div', { class: 'lb-timeline__rail-title', text: 'หัวข้อ · [ ] เปลี่ยน' }),
          this.topicsEl,
        ),
        el(
          'section',
          { class: 'lb-timeline__main' },
          el('div', { class: 'lb-timeline__summary' }, this.titleEl, this.countEl, this.historyToggle),
          this.eventsEl,
          this.diagnosticsEl,
          kbdHints(
            [
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
            ],
            'เวลาที่มีพื้นสี = มีบันทึกอีกข้อให้คำสั่งต่างกัน ยังไม่ได้ตัดสินว่าข้อใดถูก · lane agent ตรวจให้เองหลังบันทึก หรือสั่งด้วย #timeline conflicts [<topic>]',
          ),
        ),
      ),
    );
    this.bag.listen(this.historyToggle, 'click', () => this.toggleSuperseded());
    this.bag.listen(this.eventsEl, 'click', (event) => this.onClick(event));
    this.bag.listen(this.eventsEl, 'focusin', (event) => {
      const row = event.target instanceof Element ? event.target.closest<HTMLElement>('.lb-timeline__event') : null;
      if (row) this.select(Number(row.dataset.eventIndex), false);
    });
    this.bindKeys();
  }

  /** Load once, then again on focus / visibility (at most once a second). No interval. */
  start(): void {
    if (!this.harness) {
      this.eventsEl.replaceChildren(emptyState('ไม่พบ harness id'));
      return;
    }
    let selectedId: string | null = null;
    this.poller = poll<TimelinePayload>({
      load: (signal) => {
        selectedId = this.loaded ? (this.visibleEvents()[this.selectedEvent]?.id ?? null) : null;
        return fetchJson<TimelinePayload>(`/timeline.json?harness=${encodeURIComponent(this.harness)}`, { signal });
      },
      apply: (data) => this.applyPayload(data, selectedId),
      onStatus: (status, error) => {
        if (status !== 'reconnecting') return;
        if (!this.loaded) {
          const code = error instanceof HttpError ? error.status : 0;
          const message = error instanceof HttpError ? `โหลด timeline ไม่สำเร็จ (${code})` : String((error as Error)?.message ?? error);
          this.eventsEl.replaceChildren(emptyState(message));
        } else if (!this.countEl.textContent?.includes('โหลดข้อมูลล่าสุดไม่สำเร็จ')) {
          this.countEl.textContent += ' · โหลดข้อมูลล่าสุดไม่สำเร็จ';
        }
      },
      refreshOnFocus: true,
      minGapMs: 1000,
    });
  }

  dispose(): void {
    this.poller?.dispose();
    this.filter.dispose();
    this.bag.dispose();
  }

  private applyPayload(data: TimelinePayload, selectedId: string | null): void {
    const refresh = this.loaded;
    this.payload = { ...data, conflictPairs: data.conflictPairs ?? [] };
    this.indexPayload();
    if (!refresh && this.initialQuery) {
      const query = lower(this.initialQuery);
      const match = latestTopics(this.payload.events).find(
        (topic) => lower(topic.title) === query || lower(topic.id) === query,
      );
      if (match) {
        this.selectedTopic = match.id;
        this.filter.input.value = '';
      }
    }
    this.loaded = true;
    this.render();
    if (refresh && selectedId) this.jumpTo(selectedId);
    else if (!refresh && this.initialEvent) this.jumpTo(this.initialEvent);
  }

  private bindKeys(): void {
    const onRow = (event: KeyboardEvent): boolean =>
      event.target instanceof Element && event.target.closest('button, a') !== null;
    const current = (): TimelineEvent | undefined => this.visibleEvents()[this.selectedEvent];
    this.bag.add(
      keymap().bindAll([
        {
          key: 'Escape',
          label: 'ล้างตัวกรอง',
          run: () => {
            this.filter.input.value = '';
            this.selectedEvent = 0;
            this.render();
          },
        },
        { key: 'h', label: 'แสดง/ซ่อนรายการที่ถูกแทนที่', run: () => this.toggleSuperseded() },
        { key: '[', label: 'หัวข้อก่อนหน้า', run: () => this.switchTopic(-1) },
        { key: ']', label: 'หัวข้อถัดไป', run: () => this.switchTopic(1) },
        {
          key: 'r',
          label: 'สลับลำดับ',
          run: () => {
            this.newestFirst = !this.newestFirst;
            this.selectedEvent = 0;
            this.render();
          },
        },
        {
          key: ['j', 'k'],
          display: 'j / k',
          label: 'เลื่อน',
          run: (event) => {
            if (onRow(event)) return false;
            this.select(this.selectedEvent + (event.key === 'j' ? 1 : -1), true);
          },
        },
        {
          key: ' ',
          label: 'รายละเอียด',
          run: (event) => {
            const selected = current();
            if (onRow(event) || !selected) return false;
            this.toggleDetail(this.hasContext(selected) ? 'context' : 'audit');
          },
        },
        {
          key: 'i',
          label: 'ข้อมูลการบันทึก',
          run: (event) => {
            if (onRow(event) || !current()) return false;
            this.toggleDetail('audit');
          },
        },
        {
          key: 'p',
          label: 'ไปอีกรายการของคู่',
          run: (event) => {
            const selected = current();
            if (onRow(event) || !selected) return false;
            const open = this.openPairs(selected);
            const all = open.length ? open : (this.pairsByEvent.get(selected.id) ?? []);
            if (!all.length) return false;
            this.jumpTo(partnerId(all[0], selected.id));
          },
        },
        {
          key: 'Enter',
          label: 'เปิดแหล่งอ้างอิง',
          run: (event) => {
            const selected = current();
            if (onRow(event) || !selected) return false;
            const href = this.sourceHref(selected.sourceRef);
            if (!href) return false;
            window.open(href, '_blank', 'noopener');
          },
        },
      ]),
    );
  }

  private sourceHref(source: string | null | undefined): string {
    if (!source) return '';
    if (/^https?:\/\//i.test(source)) return source;
    if (/\.md(?:#.*)?$/i.test(source) && !source.startsWith('/')) {
      const [path, anchor] = source.split('#');
      return `/doc?harness=${encodeURIComponent(this.harness)}&path=${encodeURIComponent(path)}${anchor ? `#${encodeURIComponent(anchor)}` : ''}`;
    }
    return '';
  }

  private indexPayload(): void {
    this.pairsByEvent = new Map();
    this.supersededBy = new Map();
    this.eventsById = new Map();
    for (const event of this.payload.events) {
      this.eventsById.set(event.id, event);
      if (event.relation === 'supersedes' && event.relatedEvent) {
        const list = this.supersededBy.get(event.relatedEvent) ?? [];
        list.push(event);
        this.supersededBy.set(event.relatedEvent, list);
      }
    }
    for (const pair of this.payload.conflictPairs ?? []) {
      for (const id of [pair.eventA, pair.eventB]) {
        const list = this.pairsByEvent.get(id) ?? [];
        list.push(pair);
        this.pairsByEvent.set(id, list);
      }
    }
  }

  private openPairs(event: TimelineEvent): ConflictPair[] {
    return (this.pairsByEvent.get(event.id) ?? []).filter(isHighlighted);
  }

  private hasContext(event: TimelineEvent): boolean {
    return Boolean(
      event.rationale ||
        event.impact ||
        (event.relation && event.relatedEvent) ||
        event.sourceRef ||
        this.supersededBy.has(event.id) ||
        this.pairsByEvent.has(event.id),
    );
  }

  private displayEvents(): readonly TimelineEvent[] {
    return this.showSuperseded ? this.payload.events : this.payload.events.filter((event) => !event.superseded);
  }

  private visibleEvents(): TimelineEvent[] {
    const query = lower(this.filter.input.value.trim());
    const events = this.displayEvents().filter(
      (event) => (!this.selectedTopic || event.topicId === this.selectedTopic) && eventMatches(event, query),
    );
    return this.newestFirst ? events.reverse() : events;
  }

  private renderTopics(topics: readonly Topic[], query: string): void {
    const topicButton = (id: string, title: string, count: number, tooltip?: string): HTMLButtonElement => {
      const button = el(
        'button',
        {
          class: ['lb-timeline__topic', this.selectedTopic === id && 'lb-timeline__topic--active'],
          title: tooltip,
          attrs: { type: 'button' },
        },
        el('strong', { text: title }),
        el('span', { text: String(count) }),
      );
      button.addEventListener('click', () => {
        this.selectedTopic = id;
        this.selectedEvent = 0;
        this.render();
      });
      return button;
    };
    this.topicsEl.replaceChildren(
      topicButton('', 'ทุกรายการ', this.displayEvents().length),
      ...topics
        .filter((topic) => !query || lower(topic.title).includes(query))
        .map((topic) => topicButton(topic.id, topic.title, topic.count, `${topic.title} · ${topic.occurredAt.slice(0, 10)}`)),
    );
  }

  /** Collapsed row: time, full wrapping summary, who decided, topic pill. */
  private renderRow(event: TimelineEvent, index: number): HTMLElement {
    const conflicted = this.openPairs(event).length > 0;
    const context = this.hasContext(event);
    return el(
      'article',
      {
        class: [
          'lb-timeline__event',
          event.superseded && 'lb-timeline__event--superseded',
          conflicted && 'lb-timeline__event--conflict',
        ],
        data: { 'event-index': index, 'event-id': event.id },
        attrs: {
          tabindex: 0,
          'aria-label': conflicted ? `${event.summary} — ${CONFLICT_SR_TEXT}` : event.summary,
        },
      },
      el(
        'div',
        { class: 'lb-timeline__head' },
        el(
          'span',
          { class: ['lb-timeline__time', conflicted && 'conflict'] },
          timeLabel(event.occurredAt),
          conflicted ? el('span', { class: 'lb-sr', text: CONFLICT_SR_TEXT }) : null,
        ),
        el('span', { class: 'lb-timeline__text', text: event.summary, title: event.summary }),
        el(
          'div',
          { class: 'lb-timeline__meta' },
          el('span', { class: 'lb-timeline__who', text: event.madeBy, title: event.madeBy }),
          this.selectedTopic ? null : el('span', { class: 'lb-timeline__topic-pill', text: event.topicTitle }),
          el('button', {
            class: 'lb-timeline__toggle',
            text: context ? 'รายละเอียด' : 'ข้อมูลบันทึก',
            data: { 'detail-mode': context ? 'context' : 'audit' },
            attrs: { type: 'button', 'aria-expanded': 'false', 'aria-controls': `timeline-detail-${event.id}` },
          }),
        ),
      ),
    );
  }

  private jump(text: string, id: string): HTMLButtonElement {
    const button = el('button', { class: 'lb-timeline__jump', text, attrs: { type: 'button' } });
    button.addEventListener('click', (event) => {
      event.stopPropagation();
      this.jumpTo(id);
    });
    return button;
  }

  /** Opt-in context/audit body for the selected row only. */
  private renderDetail(event: TimelineEvent, mode: 'context' | 'audit'): HTMLElement {
    const detail = el('div', {
      class: ['lb-timeline__detail', `lb-timeline__detail--${mode}`],
      attrs: { id: `timeline-detail-${event.id}` },
    });
    if (event.rationale) detail.append(copyBlock('เหตุผล', event.rationale));
    if (event.impact) detail.append(copyBlock('ผลกระทบ', event.impact));
    if (event.relation && event.relatedEvent) {
      const related = this.eventsById.get(event.relatedEvent);
      detail.append(
        el(
          'div',
          { class: 'lb-timeline__relation' },
          `${RELATION_LABELS[event.relation] ?? event.relation} · `,
          related ? this.jump(related.summary, related.id) : event.relatedEvent,
        ),
      );
    }
    for (const newer of this.supersededBy.get(event.id) ?? []) {
      detail.append(el('div', { class: 'lb-timeline__relation' }, 'ถูกแทนที่โดย · ', this.jump(newer.summary, newer.id)));
    }
    for (const pair of this.pairsByEvent.get(event.id) ?? []) {
      const partner = this.eventsById.get(partnerId(pair, event.id));
      const latest = pair.reviews && pair.reviews.length ? pair.reviews[pair.reviews.length - 1] : null;
      detail.append(
        el(
          'div',
          { class: 'lb-timeline__conflict-note' },
          el(
            'div',
            {},
            el('span', { class: 'lb-timeline__label', text: `${STATE_LABELS[pair.state] ?? pair.state} · อีกรายการ · ` }),
            partner ? this.jump(`${partner.summary} (${partner.madeBy})`, partner.id) : null,
          ),
          el('div', {
            class: 'lb-timeline__label',
            text: latest
              ? `ผลตรวจ · ${latest.rationale} · ${latest.reviewedBy} · ${latest.reviewedAt.slice(0, 10)}`
              : `เหตุที่นำมาดู · ${pair.basis}`,
          }),
        ),
      );
    }
    const href = this.sourceHref(event.sourceRef);
    if (href) {
      detail.append(
        el('a', {
          class: 'lb-timeline__source',
          text: 'เปิดแหล่งอ้างอิง ↗',
          title: event.sourceRef ?? undefined,
          attrs: { href, target: '_blank', rel: 'noopener noreferrer' },
        }),
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
      detail.append(
        el('dl', { class: 'lb-timeline__audit' }, ...rows.flatMap(([k, v]) => [el('dt', { text: k }), el('dd', { text: v })])),
      );
      if (event.evidenceExcerpt) detail.append(copyBlock('หลักฐาน', event.evidenceExcerpt));
      if (event.instructionExcerpt) detail.append(copyBlock('คำสั่งที่อนุญาตให้บันทึก', event.instructionExcerpt));
      if (event.sourceRef) detail.append(el('div', { class: 'lb-timeline__source-ref', text: event.sourceRef }));
    }
    return detail;
  }

  /** Select an event by ID, widening the filter if it is hidden, and keep the URL shareable. */
  private jumpTo(id: string): void {
    const target = this.eventsById.get(id);
    if (!target) return;
    if (target.superseded && !this.showSuperseded) {
      this.showSuperseded = true;
      this.render();
    }
    let index = this.visibleEvents().findIndex((event) => event.id === id);
    if (index < 0) {
      this.filter.input.value = '';
      if (this.selectedTopic && this.selectedTopic !== target.topicId) this.selectedTopic = target.topicId;
      this.render();
      index = this.visibleEvents().findIndex((event) => event.id === id);
    }
    if (index < 0) return;
    this.select(index, true);
    const query = new URLSearchParams(location.search);
    if (this.selectedTopic) query.set('topic', this.selectedTopic);
    else query.delete('topic');
    query.set('event', id);
    history.replaceState(null, '', `${location.pathname}?${query.toString()}`);
  }

  private updateRow(index: number, selected: boolean, event: TimelineEvent | undefined): void {
    const row = this.rows[index];
    if (!row || !event) return;
    row.classList.toggle('lb-timeline__event--selected', selected);
    row.querySelector('.lb-timeline__toggle')?.setAttribute('aria-expanded', String(selected && Boolean(this.detailMode)));
    row.querySelector('.lb-timeline__detail')?.remove();
    if (selected && this.detailMode) row.append(this.renderDetail(event, this.detailMode));
  }

  /** Move selection without opening provenance or rebuilding the list. */
  private select(index: number, scroll: boolean): void {
    const events = this.visibleEvents();
    if (events.length === 0) return;
    const previous = this.selectedEvent;
    const next = Math.max(0, Math.min(events.length - 1, index));
    if (previous !== next) {
      this.updateRow(previous, false, events[previous]);
      this.selectedEvent = next;
      this.detailMode = '';
    }
    this.updateRow(this.selectedEvent, true, events[this.selectedEvent]);
    const card = this.rows[this.selectedEvent];
    if (card && scroll) {
      card.focus({ preventScroll: true });
      card.scrollIntoView?.({ block: 'nearest' });
    }
  }

  private toggleDetail(mode: 'context' | 'audit'): void {
    const events = this.visibleEvents();
    if (!events[this.selectedEvent]) return;
    this.detailMode = this.detailMode === mode ? '' : mode;
    this.updateRow(this.selectedEvent, true, events[this.selectedEvent]);
  }

  private onClick(event: Event): void {
    const target = event.target instanceof Element ? event.target : null;
    const row = target?.closest<HTMLElement>('.lb-timeline__event');
    if (!target || !row) return;
    this.select(Number(row.dataset.eventIndex), false);
    const toggle = target.closest<HTMLElement>('.lb-timeline__toggle');
    if (toggle) this.toggleDetail(toggle.dataset.detailMode === 'audit' ? 'audit' : 'context');
  }

  private switchTopic(delta: number): void {
    const ids = ['', ...latestTopics(this.displayEvents()).map((topic) => topic.id)];
    const index = Math.max(0, ids.indexOf(this.selectedTopic));
    this.selectedTopic = ids[(index + delta + ids.length) % ids.length];
    this.selectedEvent = 0;
    this.render();
  }

  private toggleSuperseded(): void {
    const selected = this.visibleEvents()[this.selectedEvent];
    this.showSuperseded = !this.showSuperseded;
    this.render();
    const next = selected && (this.showSuperseded || !selected.superseded) ? selected : this.visibleEvents()[this.selectedEvent];
    if (next) this.jumpTo(next.id);
  }

  private render(): void {
    if (!this.loaded) return;
    this.detailMode = '';
    const topics = latestTopics(this.displayEvents());
    if (this.selectedTopic && !topics.some((topic) => topic.id === this.selectedTopic)) this.selectedTopic = '';
    const query = lower(this.filter.input.value.trim());
    this.renderTopics(topics, query);
    const supersededCount = this.payload.events.filter((event) => event.superseded).length;
    this.historyToggle.hidden = supersededCount === 0;
    this.historyToggle.textContent = this.showSuperseded
      ? 'ซ่อนรายการที่ถูกแทนที่'
      : `แสดงรายการที่ถูกแทนที่ (${supersededCount})`;
    this.historyToggle.setAttribute('aria-pressed', String(this.showSuperseded));
    const events = this.visibleEvents();
    if (this.selectedEvent >= events.length) this.selectedEvent = Math.max(0, events.length - 1);
    this.rows = [];
    const children: HTMLElement[] = [];
    if (events.length === 0) children.push(emptyState('ไม่พบเหตุการณ์ที่ตรงกับตัวกรอง'));
    let day = '';
    events.forEach((event, index) => {
      const key = String(event.occurredAt).slice(0, 10);
      if (key !== day) {
        day = key;
        children.push(el('div', { class: 'lb-timeline__day', text: dayLabel(event.occurredAt) }));
      }
      const row = this.renderRow(event, index);
      this.rows.push(row);
      children.push(row);
    });
    this.eventsEl.replaceChildren(...children);
    const selected = topics.find((topic) => topic.id === this.selectedTopic);
    this.titleEl.textContent = selected ? selected.title : 'ลำดับเหตุการณ์';
    const pending = new Set<string>();
    for (const event of events) for (const pair of this.openPairs(event)) pending.add(pair.pairId);
    this.countEl.textContent = `${events.length} รายการ${pending.size ? ` · ${pending.size} คู่ให้คำสั่งต่างกัน` : ''} · ${this.newestFirst ? 'ใหม่ไปเก่า' : 'เก่าไปใหม่'}`;
    this.filter.setCount(`${events.length}`);
    if (events.length > 0) this.select(this.selectedEvent, false);
    this.diagnosticsEl.hidden = this.payload.diagnostics.length === 0;
    this.diagnosticsList.replaceChildren(
      ...this.payload.diagnostics.map((item) => el('li', { text: `${item.path} · ${item.error}` })),
    );
  }
}
