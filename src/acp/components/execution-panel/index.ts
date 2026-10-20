import './execution-panel.css';

import hljs from 'highlight.js';
import { Component } from '../../../ui/component';
import { el } from '../../../ui/dom';
import { syncOrder } from '../../../ui/list';
import { executionOutputParts, executionState, type ExecutionOutputPart } from '../../harness-execution';
import type { ExecutionActivity, ExecutionPayload, ExecutionView } from '../../harness-view-types';
import type { ComponentDef } from '../types';

export interface ExecutionPanelProps {
  readonly open: boolean;
  readonly payload: ExecutionPayload | null;
  readonly status: string;
  readonly takeFocus: boolean;
  onClose(restoreFocus: boolean): void;
}

interface OutputNode {
  readonly el: HTMLElement;
  readonly part: ExecutionOutputPart;
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

/** One view-owned, movable node. No execution controls, timers, or external I/O. */
export class ExecutionPanel extends Component<ExecutionPanelProps> {
  private readonly codeButton = el('button', {
    class: 'acp-execution-panel__button', text: 'Code',
    attrs: { type: 'button', 'aria-expanded': 'true' },
  });
  private readonly copyButton = el('button', {
    class: 'acp-execution-panel__button', text: 'Copy code', attrs: { type: 'button' },
  });
  private readonly rawButton = el('button', {
    class: 'acp-execution-panel__button', text: 'Raw', attrs: { type: 'button', 'aria-pressed': 'false' },
  });
  private readonly formattedButton = el('button', {
    class: 'acp-execution-panel__button', text: 'Formatted', attrs: { type: 'button', 'aria-pressed': 'true' },
  });
  private readonly outputControls = el('div', { class: 'acp-execution-panel__controls', attrs: { 'aria-label': 'Output view' } }, this.formattedButton, this.rawButton);
  private readonly closeButton = el('button', {
    class: 'acp-execution-panel__button', text: 'Close', attrs: { type: 'button', 'aria-label': 'Close execution inspector' },
  });
  private readonly code = el('code', { class: 'acp-execution-panel__code' });
  private readonly lineNumbers = el('pre', { class: 'acp-execution-panel__numbers', attrs: { 'aria-hidden': 'true' } });
  private readonly source = el('div', { class: 'acp-execution-panel__source' }, this.lineNumbers,
    el('pre', { class: 'acp-execution-panel__pre' }, this.code));
  private readonly codeNotice = el('div', { class: 'acp-execution-panel__notice' });
  private readonly output = el('div', { class: 'acp-execution-panel__output', attrs: { role: 'region', 'aria-label': 'Execution output', tabindex: '0' } });
  private readonly outputNotice = el('div', { class: 'acp-execution-panel__notice' });
  private readonly activityList = el('ol', { class: 'acp-execution-panel__events' });
  private readonly activityNotice = el('div', { class: 'acp-execution-panel__notice' });
  private readonly activity = el('section', { class: 'acp-execution-panel__activity', attrs: { 'aria-label': 'Execution activity' } },
    el('div', { class: 'acp-execution-panel__label', text: 'Activity' }), this.activityList, this.activityNotice);
  private readonly feedback = el('div', { class: 'acp-execution-panel__feedback', attrs: { role: 'status' } });
  private props: ExecutionPanelProps | null = null;
  private openState = false;
  private raw = false;
  private sourceCode: string | null = null;
  private sourceLanguage: string | null = null;
  private outputValue: string | null | undefined;
  private outputViews: readonly ExecutionView[] | null = null;
  private outputNodes: OutputNode[] = [];
  private activities: readonly ExecutionActivity[] | null = null;
  private visibilityObserver: MutationObserver | null = null;
  private copyRequest = 0;

  constructor() {
    super(el('div', { class: 'acp-execution-panel', attrs: { role: 'group', 'aria-label': 'Execution inspector' } }));
    this.el.hidden = true;
    this.el.append(
      el('div', { class: 'acp-execution-panel__head' },
        el('span', { class: 'acp-execution-panel__legend', text: 'Read-only · Tab moves between controls · Esc closes' }), this.closeButton),
      el('div', { class: 'acp-execution-panel__panes' },
        el('section', { class: 'acp-execution-panel__pane', attrs: { 'aria-label': 'Execution code' } },
          el('div', { class: 'acp-execution-panel__bar' }, this.codeButton, this.copyButton), this.codeNotice, this.source),
        el('section', { class: 'acp-execution-panel__pane' },
          el('div', { class: 'acp-execution-panel__bar' }, el('span', { class: 'acp-execution-panel__label', text: 'Output' }), this.outputControls), this.outputNotice, this.output)),
      this.activity, this.feedback,
    );
    this.bag.listen(this.codeButton, 'click', () => {
      this.source.hidden = !this.source.hidden;
      this.codeButton.setAttribute('aria-expanded', String(!this.source.hidden));
    });
    this.bag.listen(this.copyButton, 'click', () => { this.copy(); });
    this.bag.listen(this.closeButton, 'click', () => { this.close(); });
    this.bag.listen(this.rawButton, 'click', () => { this.setOutputMode(true); });
    this.bag.listen(this.formattedButton, 'click', () => { this.setOutputMode(false); });
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
  get hasFocus(): boolean { return this.el.contains(document.activeElement); }

  update(next: ExecutionPanelProps): void {
    const focus = next.takeFocus && (!this.openState || this.props?.takeFocus !== true);
    this.props = next.open ? next : null;
    super.update(next);
    if (focus && this.isOpen) this.codeButton.focus({ preventScroll: true });
  }

  close(restoreFocus = true): void {
    const props = this.props;
    if (!this.isOpen || props === null) return;
    this.update({ ...props, open: false, payload: null, takeFocus: false });
    props.onClose(restoreFocus);
  }

  handleKey(event: KeyboardEvent): boolean {
    if (!this.isOpen || !this.hasFocus) return false;
    if (event.key === 'Escape') {
      event.preventDefault();
      this.close();
      return true;
    }
    if (event.key !== 'Tab') return false;
    const controls = [...this.el.querySelectorAll<HTMLElement>('button, [tabindex]')]
      .filter((node) => !node.closest('[hidden]'));
    const current = controls.indexOf(document.activeElement as HTMLElement);
    const index = (current + (event.shiftKey ? -1 : 1) + controls.length) % controls.length;
    event.preventDefault();
    controls[index]?.focus({ preventScroll: true });
    return true;
  }

  protected readDeps(next: ExecutionPanelProps): readonly unknown[] {
    return [next.open, next.open ? next.payload : null, next.status];
  }

  protected syncClasses(next: ExecutionPanelProps): void {
    if (next.payload) this.el.dataset.state = executionState(next.payload, next.status);
    else delete this.el.dataset.state;
  }

  protected paint(next: ExecutionPanelProps): void {
    if (!next.open || next.payload === null) {
      this.openState = false;
      this.el.hidden = true;
      this.release();
      return;
    }
    const opening = !this.openState;
    this.openState = true;
    this.el.hidden = false;
    this.syncClasses(next);
    this.el.setAttribute('aria-label', `Execution inspector: ${next.payload.title}`);
    this.paintSource(next.payload);
    this.paintOutput(next.payload);
    this.paintActivity(next.payload);
    if (opening) this.watchVisibility();
  }

  private paintSource(payload: ExecutionPayload): void {
    const truncated = payload.truncated.includes('code');
    const copyLabel = truncated ? 'Copy shown code' : 'Copy code';
    if (this.copyButton.textContent !== copyLabel) this.copyButton.textContent = copyLabel;
    this.codeNotice.textContent = truncated ? 'Source is truncated; only shown code can be copied.' : '';
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
      node.className = [...node.classList].map((name) => `acp-execution-panel__syntax-${name.replace(/^hljs-/, '')}`).join(' ');
    }
    this.code.replaceChildren(template.content);
    this.lineNumbers.textContent = payload.code.split('\n').map((_line: string, index: number) => String(index + 1)).join('\n');
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
    this.outputNotice.textContent = payload.truncated.includes('output') || payload.truncated.includes('views')
      ? 'Retained output or formatted data is truncated.' : '';
    if (this.outputValue === payload.output && this.outputViews === payload.views) return;
    const atBottom = this.output.scrollHeight - this.output.scrollTop - this.output.clientHeight <= 2;
    const parts: readonly ExecutionOutputPart[] = this.raw ? [{ kind: 'text', text: payload.output ?? '' }] : executionOutputParts(payload);
    const visibleParts: readonly ExecutionOutputPart[] = payload.output === null || payload.output === ''
      ? [{ kind: 'text', text: payload.output === null ? 'No output yet.' : 'No text output.' }] : parts;
    const nodes: OutputNode[] = [];
    for (let index = 0; index < visibleParts.length; index++) {
      const part = visibleParts[index];
      const previous = this.outputNodes[index];
      if (part.kind === 'text' && previous?.part.kind === 'text') {
        const text = previous.el.firstChild;
        if (text instanceof Text && part.text.startsWith(previous.part.text)) {
          if (part.text.length !== previous.part.text.length) text.appendData(part.text.slice(previous.part.text.length));
        } else if (part.text !== previous.part.text) previous.el.textContent = part.text;
        nodes.push({ el: previous.el, part });
      } else if (part.kind === 'view' && previous?.part.kind === 'view' && sameView(previous.part.view, part.view)) {
        nodes.push({ el: previous.el, part });
      } else nodes.push({ el: part.kind === 'text'
        ? el('pre', { class: 'acp-execution-panel__text', text: part.text }) : this.viewNode(part.view), part });
    }
    syncOrder(this.output, nodes.map((node) => node.el));
    this.outputNodes = nodes;
    this.outputValue = payload.output;
    this.outputViews = payload.views;
    if (atBottom) this.output.scrollTop = this.output.scrollHeight;
  }

  private viewNode(view: ExecutionView): HTMLElement {
    if (view.kind === 'json') return el('pre', { class: 'acp-execution-panel__text', text: view.json });
    const table = el('table', { class: 'acp-execution-panel__table' });
    table.append(el('thead', {}, el('tr', {}, ...view.columns.map((column) => el('th', {
      class: 'acp-execution-panel__cell', text: column.head, attrs: { scope: 'col' }, data: { numeric: column.numeric === true },
    })))));
    const body = el('tbody');
    for (const row of view.rows) body.append(el('tr', {}, ...row.map((value: string, index: number) => el('td', {
      class: 'acp-execution-panel__cell', text: value, data: { numeric: view.columns[index]?.numeric === true },
    }))));
    table.append(body);
    return table;
  }

  private paintActivity(payload: ExecutionPayload): void {
    this.activity.hidden = payload.activity.length === 0 && !payload.truncated.includes('activity');
    this.activityNotice.textContent = payload.truncated.includes('activity') ? 'Earlier activity is not retained.' : '';
    if (this.activities === payload.activity) return;
    const nodes: HTMLElement[] = [];
    for (let index = 0; index < payload.activity.length; index++) {
      const entry = payload.activity[index];
      const previous = this.activities?.[index];
      const existing = this.activityList.children[index];
      if (existing instanceof HTMLElement && previous?.op === entry.op && previous.text === entry.text && previous.detail === entry.detail) nodes.push(existing);
      else nodes.push(el('li', { class: 'acp-execution-panel__event' },
        el('span', { class: 'acp-execution-panel__event-op', text: entry.op }),
        el('span', { text: entry.text }), entry.detail ? el('pre', { class: 'acp-execution-panel__text', text: entry.detail }) : null));
    }
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
    this.source.hidden = false;
    this.codeButton.setAttribute('aria-expanded', 'true');
  }

  protected onDispose(): void {
    this.invalidateDeps();
    this.openState = false;
    this.release();
    this.props = null;
    this.el.remove();
  }
}

export const def: ComponentDef = { id: 'execution-panel', blocks: ['acp-execution-panel'] };
