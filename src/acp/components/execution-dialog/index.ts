// Spec 319 — `ExecutionDialog`, the Execution Inspector as a modal overlay.
//
// Spec 315 seated a movable panel inside the execution card's slot; spec 319
// moves it onto an `OverlayShell` in the Harness body. The dialog shows one
// OMP code cell in fixed sections — head, summary, a Code / Output / Activity
// tab list, one scrolling section body and a key-hint foot — and owns the
// keyboard while open, like the image viewer. It never touches the transcript
// row: the row keeps only its `ExecutionCard` summary.
//
// Rendering rules are spec 315's: highlight only when the source changes,
// append-preserving output that follows only from the bottom, rich table/JSON
// views only for unambiguous spans, no execution controls, timers or I/O.

import './execution-dialog.css';

import hljs from 'highlight.js';
import { Component } from '../../../ui/component';
import { el } from '../../../ui/dom';
import { syncOrder } from '../../../ui/list';
import { CellGridText, gridifyText } from '../../cell-grid';
import {
  EXECUTION_STATE_LABEL,
  executionOutputParts,
  executionState,
  executionTiming,
  isExecutionLive,
  type ExecutionOutputPart,
} from '../../harness-execution';
import type { ExecutionActivity, ExecutionPayload, ExecutionView } from '../../harness-view-types';
import { paintExecutionTiming } from '../execution-card';
import type { KeyHintBarProps } from '../key-hint-bar';
import { OverlayShell } from '../overlay-shell';
import { Spinner } from '../spinner';
import type { ComponentDef } from '../types';

export type ExecutionSection = 'code' | 'output' | 'activity';

export interface ExecutionDialogProps {
  readonly open: boolean;
  /** Transcript item the dialog shows; a new target resets per-target view state. */
  readonly targetId: string | null;
  readonly payload: ExecutionPayload | null;
  /** ACP tool-call status. */
  readonly status: string;
  readonly startedAt?: number;
  readonly endedAt?: number;
  readonly takeFocus: boolean;
  onClose(restoreFocus: boolean): void;
}

interface OutputNode {
  readonly el: HTMLElement;
  readonly part: ExecutionOutputPart;
  /** Specs 324/326: a text part's block, which grids itself once it is laid out by columns. */
  readonly text: CellGridText | null;
}

type TextPart = Extract<ExecutionOutputPart, { kind: 'text' }>;

interface SectionNodes {
  readonly tab: HTMLButtonElement;
  readonly count: HTMLElement;
  readonly panel: HTMLElement;
  /** The node `j`/`k`/`g`/`G` scroll. */
  readonly scroller: HTMLElement;
}

const SECTIONS: readonly ExecutionSection[] = ['code', 'output', 'activity'];
const SECTION_LABEL: Readonly<Record<ExecutionSection, string>> = { code: 'Code', output: 'Output', activity: 'Activity' };
const SCROLL_STEP = 60;
const FOOT_HINTS = [
  { keys: ['1–3'], label: 'section' },
  { keys: ['j/k'], label: 'scroll' },
  { keys: ['g/G'], label: 'top/bottom' },
  { keys: ['c'], label: 'copy code' },
] as const;
// Two constant props objects: the shell compares `hints` by reference.
const FOOT: KeyHintBarProps = {
  hints: [...FOOT_HINTS, { keys: ['Esc'], label: 'close' }], style: 'kbd', block: 'acp-execution-dialog__foot',
};
const FOOT_WITH_VIEWS: KeyHintBarProps = {
  hints: [...FOOT_HINTS, { keys: ['r'], label: 'raw/formatted' }, { keys: ['Esc'], label: 'close' }],
  style: 'kbd', block: 'acp-execution-dialog__foot',
};

let instances = 0;

function setText(node: Node, text: string): void {
  if (node.textContent !== text) node.textContent = text;
}

/** ` · N lines` for a tab label, or nothing when the text is empty. */
function linesLabel(text: string | null): string {
  if (text === null || text === '') return '';
  const lines = text.split('\n').length;
  return ` · ${lines} ${lines === 1 ? 'line' : 'lines'}`;
}

function sameView(left: ExecutionView, right: ExecutionView): boolean {
  if (left === right) return true;
  if (left.kind !== right.kind || left.text !== right.text) return false;
  if (left.kind === 'json' && right.kind === 'json') return left.json === right.json;
  if (left.kind !== 'table' || right.kind !== 'table') return false;
  return left.columns.length === right.columns.length && left.rows.length === right.rows.length
    && left.columns.every((column, index) => column.head === right.columns[index].head && column.numeric === right.columns[index].numeric)
    && left.rows.every((row, index) => row.length === right.rows[index].length && row.every((cell, col) => cell === right.rows[index][col]));
}

function textOutput(part: TextPart): OutputNode {
  const pre = el('pre', { class: 'acp-execution-dialog__text' });
  return { el: pre, part, text: new CellGridText(pre, part.text) };
}

/** A `pre` holding one JSON view or activity detail, on the cell grid when laid out by columns (spec 326). */
function textBlock(text: string): HTMLElement {
  const pre = el('pre', { class: 'acp-execution-dialog__text', text });
  gridifyText(pre);
  return pre;
}

function fact(label: string, ...value: HTMLElement[]): HTMLElement {
  return el('div', { class: 'acp-execution-dialog__fact' },
    el('dt', { class: 'acp-execution-dialog__fact-label', text: label }),
    el('dd', { class: 'acp-execution-dialog__fact-value' }, ...value));
}

/** One view-owned modal. No execution controls, timers, or external I/O. */
export class ExecutionDialog extends Component<ExecutionDialogProps> {
  private readonly shell: OverlayShell;
  private readonly ids = `acp-execution-dialog-${++instances}`;
  private readonly glyph = new Spinner();
  private readonly language = el('span', { class: 'acp-execution-dialog__language' });
  private readonly title = el('h2', { class: 'acp-execution-dialog__title', attrs: { id: `${this.ids}-title` } });
  private readonly closeButton = el('button', {
    class: 'acp-execution-dialog__button', text: 'Close · Esc', attrs: { type: 'button', 'aria-label': 'Close execution inspector' },
  });
  private readonly status = el('span', { class: 'acp-execution-dialog__status' });
  private readonly timer = el('span', { class: 'acp-execution-dialog__timer acp-harness__tool-timer' });
  private readonly timingSource = el('span', { class: 'acp-execution-dialog__timing-source' });
  private readonly exitCode = el('span');
  private readonly job = el('span');
  private readonly runtimeFact = fact('Time', this.timer, this.timingSource);
  private readonly exitFact = fact('Exit code', this.exitCode);
  private readonly jobFact = fact('Job', this.job);
  private readonly copyButton = el('button', {
    class: 'acp-execution-dialog__button', text: 'Copy code', attrs: { type: 'button' },
  });
  private readonly formattedButton = el('button', {
    class: 'acp-execution-dialog__button', text: 'Formatted', attrs: { type: 'button', 'aria-pressed': 'true' },
  });
  private readonly rawButton = el('button', {
    class: 'acp-execution-dialog__button', text: 'Raw', attrs: { type: 'button', 'aria-pressed': 'false' },
  });
  /** The Output section's whole bar: hidden, it takes no row, when no views exist. */
  private readonly outputControls = el('div', {
    class: 'acp-execution-dialog__bar', attrs: { role: 'group', 'aria-label': 'Output view' },
  }, this.formattedButton, this.rawButton);
  private readonly code = el('code', { class: 'acp-execution-dialog__code' });
  private readonly lineNumbers = el('pre', { class: 'acp-execution-dialog__numbers', attrs: { 'aria-hidden': 'true' } });
  private readonly source = el('div', {
    class: 'acp-execution-dialog__scroll acp-execution-dialog__source', attrs: { role: 'region', 'aria-label': 'Execution source', tabindex: '0' },
  }, this.lineNumbers, el('pre', { class: 'acp-execution-dialog__pre' }, this.code));
  private readonly codeNotice = el('div', { class: 'acp-execution-dialog__notice' });
  private readonly output = el('div', {
    class: 'acp-execution-dialog__scroll acp-execution-dialog__output', attrs: { role: 'region', 'aria-label': 'Execution output', tabindex: '0' },
  });
  private readonly outputNotice = el('div', { class: 'acp-execution-dialog__notice' });
  private readonly activityList = el('ol', { class: 'acp-execution-dialog__events' });
  private readonly activityScroll = el('div', {
    class: 'acp-execution-dialog__scroll', attrs: { role: 'region', 'aria-label': 'Execution activity', tabindex: '0' },
  }, this.activityList);
  private readonly activityNotice = el('div', { class: 'acp-execution-dialog__notice' });
  private readonly feedback = el('div', { class: 'acp-execution-dialog__feedback', attrs: { role: 'status' } });
  private readonly sections: Readonly<Record<ExecutionSection, SectionNodes>>;
  private readonly body: HTMLElement;
  private props: ExecutionDialogProps | null = null;
  private openState = false;
  /** Kept across close/reopen for the dialog's lifetime (spec 319). */
  private section: ExecutionSection = 'output';
  private raw = false;
  private sourceCode: string | null = null;
  private sourceLanguage: string | null = null;
  private outputValue: string | null | undefined;
  private outputViews: readonly ExecutionView[] | null = null;
  private outputNodes: OutputNode[] = [];
  private activities: readonly ExecutionActivity[] | null = null;
  private visibilityObserver: MutationObserver | null = null;
  private copyRequest = 0;
  private readonly autoClosed = (): void => { this.close(false); };

  constructor() {
    const shell = new OverlayShell();
    super(shell.el);
    this.shell = shell;

    const tabList = el('div', {
      class: 'acp-execution-dialog__tabs', attrs: { role: 'tablist', 'aria-label': 'Execution sections' },
    });
    const bars: Readonly<Record<ExecutionSection, readonly HTMLElement[]>> = {
      code: [el('div', { class: 'acp-execution-dialog__bar' }, this.copyButton), this.codeNotice, this.source],
      output: [this.outputControls, this.outputNotice, this.output],
      activity: [this.activityNotice, this.activityScroll],
    };
    const scrollers: Readonly<Record<ExecutionSection, HTMLElement>> = {
      code: this.source, output: this.output, activity: this.activityScroll,
    };
    const built = {} as Record<ExecutionSection, SectionNodes>;
    SECTIONS.forEach((section, index) => {
      const count = el('span', { class: 'acp-execution-dialog__tab-count' });
      const tab = el('button', {
        class: 'acp-execution-dialog__tab',
        attrs: { type: 'button', role: 'tab', id: `${this.ids}-tab-${section}`, 'aria-controls': `${this.ids}-panel-${section}` },
      }, el('span', { class: 'acp-execution-dialog__tab-key', text: String(index + 1) }), ` ${SECTION_LABEL[section]}`, count);
      const panel = el('section', {
        class: 'acp-execution-dialog__section',
        attrs: { role: 'tabpanel', id: `${this.ids}-panel-${section}`, 'aria-labelledby': tab.id },
      }, ...bars[section]);
      tabList.append(tab);
      this.bag.listen(tab, 'click', () => { this.select(section, true); });
      built[section] = { tab, count, panel, scroller: scrollers[section] };
    });
    this.sections = built;

    this.body = el('div', { class: 'acp-execution-dialog__body' },
      el('div', { class: 'acp-execution-dialog__head' }, this.glyph.el, this.language, this.title, this.closeButton),
      el('dl', { class: 'acp-execution-dialog__summary' },
        fact('Status', this.status), this.runtimeFact, this.exitFact, this.jobFact),
      tabList,
      ...SECTIONS.map((section) => built[section].panel),
      this.feedback,
    );
    this.paintSection();

    this.bag.listen(this.closeButton, 'click', () => { this.close(); });
    this.bag.listen(this.copyButton, 'click', () => { this.copy(); });
    this.bag.listen(this.rawButton, 'click', () => { this.setOutputMode(true); });
    this.bag.listen(this.formattedButton, 'click', () => { this.setOutputMode(false); });
    // Mouse is secondary: a click on the scrim (outside the panel) closes.
    this.bag.listen(this.el, 'click', (event: Event) => {
      if (event.target === this.el) this.close();
    });
    // WKWebView follows macOS and does not focus buttons on pointer press.
    this.bag.listen(this.el, 'pointerdown', (event: Event) => {
      const control = event.target instanceof Element ? event.target.closest<HTMLElement>('button, [tabindex]') : null;
      if (control && this.el.contains(control)) {
        // Cancel WebKit's default mouse focus reset, not output text selection.
        if (control instanceof HTMLButtonElement) event.preventDefault();
        control.focus({ preventScroll: true });
      }
    });
  }

  get isOpen(): boolean { return this.openState; }

  update(next: ExecutionDialogProps): void {
    const retarget = next.open && this.openState && next.targetId !== this.props?.targetId;
    const focus = next.open && next.takeFocus && (!this.openState || retarget || this.props?.takeFocus !== true);
    if (retarget) {
      this.release();
      this.invalidateDeps();
    }
    this.props = next.open ? next : null;
    super.update(next);
    if (focus && this.isOpen) this.sections[this.section].tab.focus({ preventScroll: true });
  }

  close(restoreFocus = true): void {
    const props = this.props;
    if (!this.isOpen || props === null) return;
    this.update({ ...props, open: false, payload: null, takeFocus: false });
    props.onClose(restoreFocus);
  }

  /**
   * Owns every key while open, like the image viewer. Cmd/Ctrl chords, and the
   * keys a focused native control or scroller handles itself, return `false`
   * so the browser default runs (copy a selection, press a button, scroll).
   */
  handleKey(event: KeyboardEvent): boolean {
    if (!this.isOpen) return false;
    if (event.metaKey || event.ctrlKey) return false;
    const key = event.key;
    const focusedTab = SECTIONS.findIndex((section) => this.sections[section].tab === document.activeElement);
    if (key === 'Escape') {
      event.preventDefault();
      this.close();
      return true;
    }
    if (key === 'Tab') {
      event.preventDefault();
      this.cycleFocus(event.shiftKey);
      return true;
    }
    if (focusedTab >= 0 && (key === 'ArrowLeft' || key === 'ArrowRight')) {
      event.preventDefault();
      const step = key === 'ArrowLeft' ? -1 : 1;
      this.select(SECTIONS[(focusedTab + step + SECTIONS.length) % SECTIONS.length], true);
      return true;
    }
    if (key === 'Enter' || key === ' ' || key.startsWith('Arrow') || key === 'PageUp' || key === 'PageDown' || key === 'Home' || key === 'End') {
      return false;
    }
    event.preventDefault();
    if (event.altKey) return true;
    const scroller = this.sections[this.section].scroller;
    if (key === '1' || key === '2' || key === '3') this.select(SECTIONS[Number(key) - 1], true);
    else if (key === 'j') scroller.scrollTop += SCROLL_STEP;
    else if (key === 'k') scroller.scrollTop -= SCROLL_STEP;
    else if (key === 'g') scroller.scrollTop = 0;
    else if (key === 'G') scroller.scrollTop = scroller.scrollHeight;
    else if (key === 'c') this.copy();
    else if (key === 'r' && (this.props?.payload?.views.length ?? 0) > 0) this.setOutputMode(!this.raw);
    return true;
  }

  protected readDeps(next: ExecutionDialogProps): readonly unknown[] {
    return [next.open, next.open ? next.payload : null, next.status, next.startedAt, next.endedAt, next.targetId];
  }

  protected syncClasses(next: ExecutionDialogProps): void {
    if (next.open && next.payload) this.el.dataset.state = executionState(next.payload, next.status);
    else delete this.el.dataset.state;
  }

  protected paint(next: ExecutionDialogProps): void {
    const payload = next.open ? next.payload : null;
    this.syncClasses(next);
    this.shell.update({
      open: payload !== null,
      name: 'execution',
      block: 'acp-execution-dialog',
      title: '',
      body: this.body,
      hints: payload !== null && payload.views.length > 0 ? FOOT_WITH_VIEWS : FOOT,
      parts: { head: 'acp-execution-dialog__shell-head' },
      panelAttrs: { role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': this.title.id },
      onAutoClose: this.autoClosed,
    });
    if (payload === null) {
      this.openState = false;
      this.release();
      return;
    }
    const opening = !this.openState;
    this.openState = true;
    this.paintHead(next, payload);
    this.paintSource(payload);
    this.paintOutput(payload);
    this.paintActivity(payload);
    if (opening) this.watchVisibility();
  }

  private paintHead(next: ExecutionDialogProps, payload: ExecutionPayload): void {
    const state = executionState(payload, next.status);
    this.glyph.update({ running: isExecutionLive(payload, state), terminalGlyph: state === 'complete' ? '✓' : state === 'error' ? '✗' : '·' });
    // Spinner re-derives its own class on every paint; ours goes back on after.
    this.glyph.el.classList.add('acp-execution-dialog__glyph');
    setText(this.language, payload.language === 'py' ? 'Python' : 'JavaScript');
    setText(this.title, payload.title);
    setText(this.status, EXECUTION_STATE_LABEL[state]);
    const timing = executionTiming(payload, next.status, next.startedAt, next.endedAt);
    paintExecutionTiming(this.timer, this.timingSource, timing, next.startedAt, next.endedAt);
    this.runtimeFact.hidden = !timing.visible;
    this.exitFact.hidden = payload.exitCode === null;
    setText(this.exitCode, payload.exitCode === null ? '' : String(payload.exitCode));
    this.jobFact.hidden = payload.detached === null;
    setText(this.job, payload.detached ? `${payload.detached.jobId} · ${payload.detached.state}` : '');
  }

  private select(section: ExecutionSection, focus: boolean): void {
    if (this.section !== section) {
      this.section = section;
      this.paintSection();
    }
    if (focus) this.sections[section].tab.focus({ preventScroll: true });
  }

  private paintSection(): void {
    for (const section of SECTIONS) {
      const nodes = this.sections[section];
      const selected = section === this.section;
      nodes.tab.setAttribute('aria-selected', String(selected));
      nodes.tab.tabIndex = selected ? 0 : -1;
      nodes.panel.hidden = !selected;
    }
  }

  private cycleFocus(backwards: boolean): void {
    const controls = [...this.el.querySelectorAll<HTMLElement>('button, [tabindex]')]
      .filter((node) => node.tabIndex >= 0 && !node.closest('[hidden]'));
    if (controls.length === 0) return;
    const current = controls.indexOf(document.activeElement as HTMLElement);
    const index = current < 0 ? (backwards ? controls.length - 1 : 0)
      : (current + (backwards ? -1 : 1) + controls.length) % controls.length;
    controls[index].focus({ preventScroll: true });
  }

  private paintSource(payload: ExecutionPayload): void {
    const truncated = payload.truncated.includes('code');
    setText(this.copyButton, truncated ? 'Copy shown code' : 'Copy code');
    setText(this.codeNotice, truncated ? 'Source is truncated; only shown code can be copied.' : '');
    if (this.sourceCode === payload.code && this.sourceLanguage === payload.language) return;
    this.copyRequest++;
    this.feedback.textContent = '';
    this.sourceCode = payload.code;
    this.sourceLanguage = payload.language;
    // Only highlight the bounded source, and only when it actually changes.
    // highlight.js escapes source; no backend HTML is inserted into the DOM.
    const template = document.createElement('template');
    template.innerHTML = hljs.highlight(payload.code, { language: payload.language === 'py' ? 'python' : 'javascript' }).value;
    for (const node of template.content.querySelectorAll<HTMLElement>('[class]')) {
      node.className = [...node.classList].map((name) => `acp-execution-dialog__syntax-${name.replace(/^hljs-/, '')}`).join(' ');
    }
    this.code.replaceChildren(template.content);
    const lines = payload.code.split('\n').length;
    this.lineNumbers.textContent = Array.from({ length: lines }, (_unused, index) => String(index + 1)).join('\n');
    setText(this.sections.code.count, linesLabel(payload.code));
  }

  private setOutputMode(raw: boolean): void {
    if (this.raw === raw) return;
    this.raw = raw;
    this.rawButton.setAttribute('aria-pressed', String(raw));
    this.formattedButton.setAttribute('aria-pressed', String(!raw));
    this.outputValue = undefined;
    if (this.props?.payload) this.paintOutput(this.props.payload);
  }

  private paintOutput(payload: ExecutionPayload): void {
    this.outputControls.hidden = payload.views.length === 0;
    setText(this.outputNotice, payload.truncated.includes('output') || payload.truncated.includes('views')
      ? 'Retained output or formatted data is truncated.' : '');
    setText(this.sections.output.count, linesLabel(payload.output));
    if (this.outputValue === payload.output && this.outputViews === payload.views) return;
    const atBottom = this.output.scrollHeight - this.output.scrollTop - this.output.clientHeight <= 2;
    const parts: readonly ExecutionOutputPart[] = this.raw ? [{ kind: 'text', text: payload.output ?? '' }] : executionOutputParts(payload);
    const visibleParts: readonly ExecutionOutputPart[] = payload.output === null || payload.output === ''
      ? [{ kind: 'text', text: payload.output === null ? 'No output yet.' : 'No text output.' }] : parts;
    const nodes: OutputNode[] = [];
    for (let index = 0; index < visibleParts.length; index++) {
      const part = visibleParts[index];
      const previous = this.outputNodes[index];
      if (part.kind === 'text' && previous?.part.kind === 'text' && previous.text) {
        // Append-preserving (spec 315): only a new tail is written.
        previous.text.set(part.text);
        nodes.push({ ...previous, part });
      } else if (part.kind === 'view' && previous?.part.kind === 'view' && sameView(previous.part.view, part.view)) {
        nodes.push({ el: previous.el, part, text: null });
      } else nodes.push(part.kind === 'text' ? textOutput(part) : { el: this.viewNode(part.view), part, text: null });
    }
    syncOrder(this.output, nodes.map((node) => node.el));
    this.outputNodes = nodes;
    this.outputValue = payload.output;
    this.outputViews = payload.views;
    if (atBottom) this.output.scrollTop = this.output.scrollHeight;
  }

  private viewNode(view: ExecutionView): HTMLElement {
    if (view.kind === 'json') return textBlock(view.json);
    const table = el('table', { class: 'acp-execution-dialog__table' });
    table.append(el('thead', {}, el('tr', {}, ...view.columns.map((column) => el('th', {
      class: 'acp-execution-dialog__cell', text: column.head, attrs: { scope: 'col' }, data: { numeric: column.numeric === true },
    })))));
    const body = el('tbody');
    for (const row of view.rows) body.append(el('tr', {}, ...row.map((value: string, index: number) => el('td', {
      class: 'acp-execution-dialog__cell', text: value, data: { numeric: view.columns[index]?.numeric === true },
    }))));
    table.append(body);
    return table;
  }

  private paintActivity(payload: ExecutionPayload): void {
    const truncated = payload.truncated.includes('activity');
    setText(this.activityNotice, truncated ? 'Earlier activity is not retained.'
      : payload.activity.length === 0 ? 'No activity reported.' : '');
    setText(this.sections.activity.count, ` · ${payload.activity.length}`);
    if (this.activities === payload.activity) return;
    const nodes: HTMLElement[] = [];
    let current = -1;
    for (let index = 0; index < payload.activity.length; index++) {
      const entry = payload.activity[index];
      if (entry.op === 'phase') current = index;
      const previous = this.activities?.[index];
      const existing = this.activityList.children[index];
      if (existing instanceof HTMLElement && previous?.op === entry.op && previous.text === entry.text && previous.detail === entry.detail) nodes.push(existing);
      else nodes.push(el('li', { class: 'acp-execution-dialog__event' },
        el('span', { class: 'acp-execution-dialog__event-op', text: entry.op }),
        el('span', { text: entry.text }), entry.detail ? textBlock(entry.detail) : null));
    }
    // Only a backend-reported phase is emphasized; no checkmarks or progress.
    nodes.forEach((node, index) => node.classList.toggle('acp-execution-dialog__event--current', index === current));
    syncOrder(this.activityList, nodes);
    this.activities = payload.activity;
  }

  private copy(): void {
    const payload = this.props?.payload;
    if (!this.isOpen || !payload) return;
    const clipboard = navigator.clipboard as Clipboard | undefined;
    if (clipboard === undefined) {
      this.feedback.textContent = 'Clipboard unavailable';
      return;
    }
    const request = ++this.copyRequest;
    void clipboard.writeText(payload.code).then(
      () => { if (request === this.copyRequest && this.isOpen) this.feedback.textContent = payload.truncated.includes('code') ? 'Shown code copied; source is incomplete.' : 'Code copied'; },
      () => { if (request === this.copyRequest && this.isOpen) this.feedback.textContent = 'Copy failed'; },
    );
  }

  private watchVisibility(): void {
    this.visibilityObserver?.disconnect();
    const tab = this.el.closest<HTMLElement>('.krypton-tab-wrapper');
    const windowEl = this.el.closest<HTMLElement>('.krypton-window');
    if (!tab && !windowEl) return;
    this.visibilityObserver = new MutationObserver(() => {
      if (tab?.classList.contains('krypton-tab-wrapper--hidden') || windowEl?.style.display === 'none') this.close(false);
    });
    if (tab) this.visibilityObserver.observe(tab, { attributes: true, attributeFilter: ['class'] });
    if (windowEl) this.visibilityObserver.observe(windowEl, { attributes: true, attributeFilter: ['style'] });
  }

  /** Drop per-target state; the selected section survives on purpose. */
  private release(): void {
    this.visibilityObserver?.disconnect();
    this.visibilityObserver = null;
    this.copyRequest++;
    this.sourceCode = null;
    this.sourceLanguage = null;
    this.outputValue = undefined;
    this.outputViews = null;
    this.outputNodes = [];
    this.activities = null;
    this.code.replaceChildren();
    this.lineNumbers.textContent = '';
    this.output.replaceChildren();
    this.activityList.replaceChildren();
    this.feedback.textContent = '';
    this.raw = false;
    this.rawButton.setAttribute('aria-pressed', 'false');
    this.formattedButton.setAttribute('aria-pressed', 'true');
    for (const section of SECTIONS) this.sections[section].scroller.scrollTop = 0;
    // A closed dialog's timer must not stay in the shared ticker's live set.
    this.timer.removeAttribute('data-started-at');
    this.timer.setAttribute('data-ended-at', '');
  }

  protected onDispose(): void {
    this.invalidateDeps();
    this.openState = false;
    this.release();
    this.props = null;
    this.glyph.dispose();
    this.shell.dispose();
    this.el.remove();
  }
}

export const def: ComponentDef = {
  id: 'execution-dialog',
  blocks: ['acp-harness__execution-overlay', 'acp-execution-dialog'],
};
