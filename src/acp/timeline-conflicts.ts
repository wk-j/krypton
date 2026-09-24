import {
  conflictStateLabel,
  type TimelineConflictPair,
  type TimelineConflictScan,
  type TimelineConflictState,
  type TimelineConflictVerdict,
  type TimelineEvent,
  type TimelineTraceResponse,
} from './timeline';

/**
 * spec 266: `#timeline conflicts` — keyboard-first sheet to compare two
 * timeline events, propose a pair by hand, record a human verdict, and start a
 * TypeSafe screening scan. The sheet never decides; it only records what the
 * human chose, with a mandatory rationale.
 */
export interface TimelineConflictsOptions {
  mount: HTMLElement;
  load: () => Promise<TimelineTraceResponse>;
  propose: (eventA: string, eventB: string, rationale: string) => Promise<TimelineConflictPair>;
  review: (
    pairId: string,
    verdict: TimelineConflictVerdict,
    rationale: string,
    sourceRef: string | null,
    resolutionEventId: string | null,
  ) => Promise<TimelineConflictPair>;
  scan: () => Promise<TimelineConflictScan>;
  close: () => void;
  /** `record` = also keep the message in the lane transcript (saved writes). */
  notify: (message: string, record?: boolean) => void;
}

type Mode = 'pairs' | 'review' | 'propose';

const VERDICT_KEYS: Record<string, TimelineConflictVerdict> = {
  '1': 'confirmed',
  '2': 'dismissed',
  '3': 'insufficient_evidence',
  '4': 'resolved',
};

const STATE_ORDER: Record<TimelineConflictState, number> = {
  unreviewed: 0,
  insufficient_evidence: 1,
  confirmed: 2,
  resolved: 3,
  dismissed: 4,
  historical: 5,
};

const MAX_PROPOSE_RESULTS = 30;
const MAX_RESOLUTION_OPTIONS = 200;

function verdictLabel(verdict: TimelineConflictVerdict): string {
  return conflictStateLabel(verdict);
}

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className: string,
  text?: string,
): HTMLElementTagNameMap[K] {
  const element = document.createElement(tag);
  if (className) element.className = className;
  if (text !== undefined) element.textContent = text;
  return element;
}

function shortDate(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value.slice(0, 16);
  return date.toLocaleString('th-TH', {
    year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false,
  });
}

function isTextField(target: EventTarget | null): boolean {
  return target instanceof HTMLInputElement
    || target instanceof HTMLTextAreaElement
    || target instanceof HTMLSelectElement;
}

export class TimelineConflicts {
  readonly element: HTMLElement;
  private readonly options: TimelineConflictsOptions;
  private readonly panel: HTMLElement;
  private readonly statusEl: HTMLElement;
  private readonly bodyEl: HTMLElement;
  private readonly hintEl: HTMLElement;
  private trace: TimelineTraceResponse | null = null;
  private events = new Map<string, TimelineEvent>();
  private pairs: TimelineConflictPair[] = [];
  private selected = 0;
  private mode: Mode = 'pairs';
  private verdict: TimelineConflictVerdict | null = null;
  private busy = false;
  private disposed = false;
  // Review form fields (mode === 'review').
  private rationaleInput: HTMLTextAreaElement | null = null;
  private sourceInput: HTMLInputElement | null = null;
  private resolutionSelect: HTMLSelectElement | null = null;
  // Propose form state (mode === 'propose').
  private proposeQuery = '';
  private proposeCursor = 0;
  private proposeA: string | null = null;
  private proposeB: string | null = null;
  private proposeResults: TimelineEvent[] = [];
  private proposeSearch: HTMLInputElement | null = null;
  private proposeList: HTMLElement | null = null;
  private errorEl: HTMLElement | null = null;

  constructor(options: TimelineConflictsOptions) {
    this.options = options;
    this.element = el('aside', 'acp-harness__timeline-overlay');
    this.panel = el('section', 'acp-timeline__panel acp-conflicts');
    this.panel.setAttribute('role', 'dialog');
    this.panel.setAttribute('aria-modal', 'true');
    this.panel.setAttribute('aria-labelledby', 'timeline-conflicts-title');
    this.panel.tabIndex = -1;
    const title = el('h2', '', 'ตรวจคำตัดสินที่อาจขัดกัน');
    title.id = 'timeline-conflicts-title';
    this.statusEl = el('p', 'acp-timeline__subtitle', 'กำลังโหลด…');
    this.statusEl.setAttribute('aria-live', 'polite');
    this.bodyEl = el('div', 'acp-conflicts__body');
    this.hintEl = el('p', 'acp-conflicts__hint');
    this.panel.append(title, this.statusEl, this.bodyEl, this.hintEl);
    this.element.appendChild(this.panel);
    options.mount.appendChild(this.element);
    this.panel.focus();
    void this.reload(null);
  }

  dispose(): void {
    this.disposed = true;
    this.element.remove();
  }

  handleKeyDown(event: KeyboardEvent): boolean {
    if (event.key === 'Escape') {
      event.preventDefault();
      if (this.busy) return true;
      if (this.mode !== 'pairs') this.setMode('pairs');
      else this.options.close();
      return true;
    }
    if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
      event.preventDefault();
      if (this.mode === 'review') void this.submitReview();
      if (this.mode === 'propose') void this.submitProposal();
      return true;
    }
    if (this.mode === 'propose' && event.target === this.proposeSearch) {
      return this.handleProposeSearchKey(event);
    }
    if (isTextField(event.target) || event.metaKey || event.ctrlKey || event.altKey) return false;
    if (this.mode !== 'pairs' || this.busy) return false;
    const key = event.key;
    if (key === 'j' || key === 'ArrowDown' || key === 'k' || key === 'ArrowUp') {
      event.preventDefault();
      const delta = key === 'j' || key === 'ArrowDown' ? 1 : -1;
      this.selected = Math.max(0, Math.min(this.pairs.length - 1, this.selected + delta));
      this.render();
      return true;
    }
    if (VERDICT_KEYS[key] && this.pairs[this.selected]) {
      event.preventDefault();
      this.verdict = VERDICT_KEYS[key];
      this.setMode('review');
      return true;
    }
    if (key === 'n') {
      event.preventDefault();
      this.proposeQuery = '';
      this.proposeCursor = 0;
      this.proposeA = null;
      this.proposeB = null;
      this.setMode('propose');
      return true;
    }
    if (key === 's') {
      event.preventDefault();
      void this.runScan();
      return true;
    }
    return false;
  }

  private setMode(mode: Mode): void {
    this.mode = mode;
    this.render();
    if (mode === 'review') this.rationaleInput?.focus();
    else if (mode === 'propose') this.proposeSearch?.focus();
    else this.panel.focus();
  }

  private async reload(keepPairId: string | null): Promise<void> {
    try {
      const trace = await this.options.load();
      if (this.disposed) return;
      this.trace = trace;
      this.events = new Map(trace.events.map((event) => [event.id, event]));
      this.pairs = [...trace.conflictPairs].sort((left, right) => (
        STATE_ORDER[left.state] - STATE_ORDER[right.state]
        || right.suggestedAt.localeCompare(left.suggestedAt)
        || left.pairId.localeCompare(right.pairId)
      ));
      const keep = keepPairId ? this.pairs.findIndex((pair) => pair.pairId === keepPairId) : -1;
      this.selected = keep >= 0 ? keep : Math.min(this.selected, Math.max(0, this.pairs.length - 1));
      this.render();
    } catch (e) {
      if (this.disposed) return;
      this.statusEl.textContent = `โหลดข้อมูลไม่สำเร็จ: ${String(e)}`;
    }
  }

  private statusText(): string {
    const trace = this.trace;
    if (!trace) return 'กำลังโหลด…';
    const parts = [
      `ต้องตรวจ ${trace.conflictCounts.needsReview}`,
      `ยังขัดกัน ${trace.conflictCounts.confirmed}`,
    ];
    const scan = trace.scan;
    if (!scan.enabled) parts.push('สแกน TypeSafe ปิดอยู่ · เลือกคู่เองได้ด้วย n');
    else if (scan.state === 'never_run') parts.push('ยังไม่เคยสแกน');
    else if (scan.state === 'partial') {
      parts.push(`สแกนไม่ครบ · ยังไม่ได้ตรวจ ${scan.skippedPairs} คู่${scan.reason ? ` (${scan.reason})` : ''}`);
    } else parts.push(`สแกนล่าสุด ${shortDate(scan.lastCompletedAt ?? '')}`);
    if (trace.diagnostics.length > 0) parts.push(`ข้อมูลผิดพลาด ${trace.diagnostics.length}`);
    return parts.join(' · ');
  }

  private render(): void {
    if (this.disposed) return;
    this.statusEl.textContent = this.statusText();
    this.bodyEl.replaceChildren();
    this.rationaleInput = null;
    this.sourceInput = null;
    this.resolutionSelect = null;
    this.proposeSearch = null;
    this.proposeList = null;
    this.errorEl = null;
    if (this.mode === 'propose') {
      this.renderPropose();
      this.hintEl.textContent = '↑/↓ เลือก · Enter ใส่เป็นรายการ A แล้ว B · ⌘Enter บันทึกคู่ · Esc กลับ';
      return;
    }
    this.renderPairs();
    this.hintEl.textContent = this.mode === 'review'
      ? '⌘Enter บันทึกผลตรวจ · Esc ยกเลิก'
      : 'j/k เลือกคู่ · 1 ยืนยันว่าขัดกัน · 2 ไม่ขัดกัน · 3 หลักฐานไม่พอ · 4 แก้แล้ว · n เลือกคู่เอง · s สแกน · Esc ปิด';
  }

  private renderPairs(): void {
    const list = el('ol', 'acp-conflicts__list');
    list.setAttribute('role', 'listbox');
    list.setAttribute('aria-label', 'คู่บันทึกที่อาจขัดกัน');
    if (this.pairs.length === 0) {
      const empty = el('li', 'acp-conflicts__empty', this.emptyText());
      list.appendChild(empty);
    }
    this.pairs.forEach((pair, index) => {
      const row = el('li', 'acp-conflicts__pair');
      row.setAttribute('role', 'option');
      row.setAttribute('aria-selected', String(index === this.selected));
      row.dataset.state = pair.state;
      row.appendChild(el('span', 'acp-conflicts__state', conflictStateLabel(pair.state)));
      const a = this.events.get(pair.eventA);
      const b = this.events.get(pair.eventB);
      row.appendChild(el('span', 'acp-conflicts__pair-text', `${a?.summary ?? pair.eventA} ⇄ ${b?.summary ?? pair.eventB}`));
      row.addEventListener('click', () => {
        this.selected = index;
        this.render();
      });
      list.appendChild(row);
    });
    this.bodyEl.appendChild(list);
    list.querySelector('[aria-selected="true"]')?.scrollIntoView({ block: 'nearest' });
    const pair = this.pairs[this.selected];
    if (!pair) return;
    const compare = el('section', 'acp-conflicts__compare');
    const sides = el('div', 'acp-conflicts__sides');
    for (const id of [pair.eventA, pair.eventB]) sides.appendChild(this.renderSide(id));
    compare.appendChild(sides);
    const origin = pair.origin === 'typesafe'
      ? `TypeSafe${pair.model ? ` ${pair.model}` : ''}${pair.probability !== undefined ? ` · p=${pair.probability.toFixed(2)}` : ''}`
      : 'เลือกเอง';
    compare.appendChild(el('p', 'acp-conflicts__basis', `เหตุที่นำมาดู (${origin}) · ${pair.basis}`));
    if (pair.reviews.length > 0) {
      const history = el('ol', 'acp-conflicts__history');
      for (const review of [...pair.reviews].reverse()) {
        const item = el('li', '');
        item.appendChild(el('strong', '', verdictLabel(review.verdict)));
        item.appendChild(document.createTextNode(` · ${review.rationale}`));
        const meta = [review.reviewedBy, shortDate(review.reviewedAt)];
        if (review.sourceRef) meta.push(review.sourceRef);
        if (review.resolutionEventId) meta.push(`แก้โดย ${review.resolutionEventId}`);
        item.appendChild(el('span', 'acp-conflicts__meta', meta.join(' · ')));
        history.appendChild(item);
      }
      compare.appendChild(history);
    }
    if (this.mode === 'review' && this.verdict) compare.appendChild(this.renderReviewForm(this.verdict));
    this.bodyEl.appendChild(compare);
  }

  private emptyText(): string {
    const scan = this.trace?.scan;
    if (!scan?.enabled || scan.state === 'never_run') return 'ยังไม่มีคู่ให้ตรวจ · กด n เพื่อเลือกสองรายการมาเทียบเอง';
    if (scan.state === 'partial') return 'ยังไม่มีคู่ให้ตรวจ แต่การสแกนล่าสุดไม่ครบ จึงยังสรุปไม่ได้';
    return 'ไม่พบคู่ที่ควรตรวจในรายการที่คัดมาสแกน · คู่ข้ามหัวข้อที่ไม่มีคำหรือแหล่งอ้างอิงร่วมกันไม่ได้ถูกตรวจ';
  }

  private renderSide(id: string): HTMLElement {
    const side = el('article', 'acp-conflicts__side');
    const event = this.events.get(id);
    if (!event) {
      side.appendChild(el('p', 'acp-conflicts__meta', `ไม่พบบันทึก ${id}`));
      return side;
    }
    side.appendChild(el('span', 'acp-conflicts__meta', event.topicTitle));
    side.appendChild(el('h3', '', event.summary));
    side.appendChild(el('span', 'acp-conflicts__meta', `${event.madeBy} · ${shortDate(event.occurredAt)}`));
    if (event.rationale) side.appendChild(el('p', '', event.rationale));
    side.appendChild(el('span', 'acp-conflicts__meta', event.sourceRef ? `อ้างอิง ${event.sourceRef}` : 'ไม่มีแหล่งอ้างอิง'));
    side.appendChild(el('span', 'acp-conflicts__meta', `บันทึกโดย ${event.recordedBy} · ${event.id}`));
    return side;
  }

  private renderReviewForm(verdict: TimelineConflictVerdict): HTMLElement {
    const form = el('div', 'acp-conflicts__form');
    form.appendChild(el('h3', '', `ผลตรวจ: ${verdictLabel(verdict)}`));
    const rationaleLabel = el('label', 'acp-timeline__field');
    rationaleLabel.appendChild(el('span', '', 'เหตุผล (จำเป็น)'));
    this.rationaleInput = el('textarea', '');
    this.rationaleInput.maxLength = 1000;
    this.rationaleInput.rows = 3;
    rationaleLabel.appendChild(this.rationaleInput);
    form.appendChild(rationaleLabel);
    const sourceLabel = el('label', 'acp-timeline__field');
    sourceLabel.appendChild(el('span', '', verdict === 'resolved' ? 'แหล่งอ้างอิง (หรือเลือกรายการที่แก้)' : 'แหล่งอ้างอิง (ไม่บังคับ)'));
    this.sourceInput = el('input', '');
    this.sourceInput.type = 'text';
    this.sourceInput.maxLength = 2048;
    sourceLabel.appendChild(this.sourceInput);
    form.appendChild(sourceLabel);
    if (verdict === 'resolved') {
      const resolutionLabel = el('label', 'acp-timeline__field');
      resolutionLabel.appendChild(el('span', '', 'บันทึกที่ทำให้ข้อขัดกันจบ'));
      this.resolutionSelect = el('select', '');
      const none = el('option', '', '—');
      none.value = '';
      this.resolutionSelect.appendChild(none);
      const newest = [...this.events.values()]
        .sort((left, right) => right.occurredAt.localeCompare(left.occurredAt))
        .slice(0, MAX_RESOLUTION_OPTIONS);
      for (const event of newest) {
        const option = el('option', '', `${event.occurredAt.slice(0, 10)} · ${event.summary}`);
        option.value = event.id;
        this.resolutionSelect.appendChild(option);
      }
      resolutionLabel.appendChild(this.resolutionSelect);
      form.appendChild(resolutionLabel);
    }
    this.errorEl = el('p', 'acp-timeline__error');
    form.appendChild(this.errorEl);
    return form;
  }

  private async submitReview(): Promise<void> {
    const pair = this.pairs[this.selected];
    if (!pair || !this.verdict || !this.rationaleInput || this.busy) return;
    const rationale = this.rationaleInput.value.trim();
    const sourceRef = this.sourceInput?.value.trim() || null;
    const resolutionEventId = this.resolutionSelect?.value || null;
    if (!rationale) return this.showError('กรุณาใส่เหตุผล');
    if (this.verdict === 'resolved' && !sourceRef && !resolutionEventId) {
      return this.showError('“แก้แล้ว” ต้องอ้างบันทึกที่แก้ หรือใส่แหล่งอ้างอิง');
    }
    this.busy = true;
    try {
      const saved = await this.options.review(pair.pairId, this.verdict, rationale, sourceRef, resolutionEventId);
      this.options.notify(`บันทึกผลตรวจแล้ว · ${verdictLabel(this.verdict)} · ${saved.pairId}`, true);
      this.mode = 'pairs';
      this.verdict = null;
      await this.reload(saved.pairId);
      this.panel.focus();
    } catch (e) {
      this.showError(`บันทึกไม่สำเร็จ: ${String(e)}`);
    } finally {
      this.busy = false;
    }
  }

  private showError(message: string): void {
    if (this.errorEl) this.errorEl.textContent = message;
    else this.options.notify(message);
  }

  private renderPropose(): void {
    const wrap = el('section', 'acp-conflicts__propose');
    const searchLabel = el('label', 'acp-timeline__field');
    searchLabel.appendChild(el('span', '', 'ค้นหาบันทึกทุกหัวข้อ'));
    this.proposeSearch = el('input', '');
    this.proposeSearch.type = 'search';
    this.proposeSearch.value = this.proposeQuery;
    this.proposeSearch.addEventListener('input', () => {
      this.proposeQuery = this.proposeSearch?.value ?? '';
      this.proposeCursor = 0;
      this.renderProposeResults();
    });
    searchLabel.appendChild(this.proposeSearch);
    wrap.appendChild(searchLabel);
    const chosen = el('p', 'acp-conflicts__chosen');
    const label = (id: string | null): string => (id ? this.events.get(id)?.summary ?? id : '—');
    chosen.textContent = `A: ${label(this.proposeA)}  ⇄  B: ${label(this.proposeB)}`;
    wrap.appendChild(chosen);
    this.proposeList = el('ol', 'acp-conflicts__list acp-conflicts__results');
    this.proposeList.setAttribute('role', 'listbox');
    wrap.appendChild(this.proposeList);
    const rationaleLabel = el('label', 'acp-timeline__field');
    rationaleLabel.appendChild(el('span', '', 'ทำไมคู่นี้อาจขัดกัน (จำเป็น)'));
    this.rationaleInput = el('textarea', '');
    this.rationaleInput.maxLength = 1000;
    this.rationaleInput.rows = 2;
    rationaleLabel.appendChild(this.rationaleInput);
    wrap.appendChild(rationaleLabel);
    this.errorEl = el('p', 'acp-timeline__error');
    wrap.appendChild(this.errorEl);
    this.bodyEl.appendChild(wrap);
    this.renderProposeResults();
  }

  private renderProposeResults(): void {
    if (!this.proposeList) return;
    const needle = this.proposeQuery.trim().toLocaleLowerCase('th-TH');
    this.proposeResults = [...this.events.values()]
      .filter((event) => !needle || [event.topicTitle, event.summary, event.madeBy, event.sourceRef ?? '']
        .join(' ').toLocaleLowerCase('th-TH').includes(needle))
      .sort((left, right) => right.occurredAt.localeCompare(left.occurredAt))
      .slice(0, MAX_PROPOSE_RESULTS);
    this.proposeCursor = Math.min(this.proposeCursor, Math.max(0, this.proposeResults.length - 1));
    this.proposeList.replaceChildren();
    this.proposeResults.forEach((event, index) => {
      const row = el('li', 'acp-conflicts__pair');
      row.setAttribute('role', 'option');
      row.setAttribute('aria-selected', String(index === this.proposeCursor));
      const mark = event.id === this.proposeA ? 'A' : event.id === this.proposeB ? 'B' : '';
      row.appendChild(el('span', 'acp-conflicts__state', mark || event.occurredAt.slice(0, 10)));
      row.appendChild(el('span', 'acp-conflicts__pair-text', `${event.summary} · ${event.topicTitle}`));
      this.proposeList?.appendChild(row);
    });
    this.proposeList.querySelector('[aria-selected="true"]')?.scrollIntoView({ block: 'nearest' });
  }

  private handleProposeSearchKey(event: KeyboardEvent): boolean {
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      const delta = event.key === 'ArrowDown' ? 1 : -1;
      this.proposeCursor = Math.max(0, Math.min(this.proposeResults.length - 1, this.proposeCursor + delta));
      this.renderProposeResults();
      return true;
    }
    if (event.key === 'Enter') {
      event.preventDefault();
      const picked = this.proposeResults[this.proposeCursor];
      if (!picked) return true;
      if (!this.proposeA || (this.proposeA && this.proposeB)) {
        this.proposeA = picked.id;
        this.proposeB = null;
      } else if (picked.id !== this.proposeA) {
        this.proposeB = picked.id;
      }
      this.render();
      if (this.proposeA && this.proposeB) this.rationaleInput?.focus();
      else this.proposeSearch?.focus();
      return true;
    }
    return false;
  }

  private async submitProposal(): Promise<void> {
    if (this.busy || !this.rationaleInput) return;
    if (!this.proposeA || !this.proposeB) return this.showError('เลือกบันทึกให้ครบสองรายการก่อน');
    const rationale = this.rationaleInput.value.trim();
    if (!rationale) return this.showError('กรุณาใส่เหตุผลว่าทำไมคู่นี้ควรตรวจ');
    this.busy = true;
    try {
      const pair = await this.options.propose(this.proposeA, this.proposeB, rationale);
      this.options.notify(`เพิ่มคู่ให้ตรวจแล้ว · ${pair.pairId}`, true);
      this.mode = 'pairs';
      await this.reload(pair.pairId);
      this.panel.focus();
    } catch (e) {
      this.showError(`บันทึกคู่ไม่สำเร็จ: ${String(e)}`);
    } finally {
      this.busy = false;
    }
  }

  private async runScan(): Promise<void> {
    if (!this.trace?.scan.enabled) {
      this.options.notify('สแกนปิดอยู่: ตั้ง [typesafe] enabled = true และ [typesafe.timeline_conflicts] mode = "suggest"');
      return;
    }
    this.busy = true;
    this.statusEl.textContent = 'กำลังสแกนด้วย TypeSafe…';
    try {
      const result = await this.options.scan();
      const parts = [
        `สแกนแล้ว ${result.checkedPairs} คู่`,
        `เสนอใหม่ ${result.proposedPairs}`,
        `ยังสรุปไม่ได้ ${result.inconclusivePairs}`,
      ];
      if (result.state === 'partial') {
        parts.push(`ยังไม่ได้ตรวจ ${result.skippedPairs} คู่${result.reason ? ` (${result.reason})` : ''}`);
      }
      this.options.notify(parts.join(' · '), true);
      await this.reload(null);
    } catch (e) {
      this.options.notify(`สแกนไม่สำเร็จ: ${String(e)}`);
      this.render();
    } finally {
      this.busy = false;
    }
  }
}
