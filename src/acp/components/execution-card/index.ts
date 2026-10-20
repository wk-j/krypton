import './execution-card.css';

import { Component } from '../../../ui/component';
import { el, setAttr } from '../../../ui/dom';
import { executionState } from '../../harness-execution';
import { formatToolElapsed } from '../../harness-tool-render';
import type { ExecutionPayload, ExecutionState } from '../../harness-view-types';
import { Spinner } from '../spinner';
import type { ComponentDef } from '../types';

export interface ExecutionCardProps {
  readonly payload: ExecutionPayload;
  readonly status: string;
  readonly startedAt?: number;
  readonly endedAt?: number;
  readonly hintLabel: string | null;
}

const STATE_LABEL: Readonly<Record<ExecutionState, string>> = {
  pending: 'Pending', running: 'Running', complete: 'Done', error: 'Error',
  cancelled: 'Cancelled', background: 'Background · last reported',
};

function setText(node: Node, text: string): void {
  if (node.textContent !== text) node.textContent = text;
}

/** Owns the whole execution summary, not a second generic tool header. */
export class ExecutionCard extends Component<ExecutionCardProps> {
  private readonly glyph = new Spinner();
  private readonly language = el('span', { class: 'acp-execution-card__language' });
  private readonly title = el('span', { class: 'acp-execution-card__title' });
  private readonly state = el('span', { class: 'acp-execution-card__state' });
  private readonly timer = el('span', { class: 'acp-execution-card__timer acp-harness__tool-timer' });
  private readonly timingSource = el('span', { class: 'acp-execution-card__timing-source' });
  private readonly hint = el('span', { class: 'acp-execution-card__hint', attrs: { 'aria-hidden': 'true' } });
  private readonly inspector = el('button', {
    class: 'acp-execution-card__button',
    attrs: { type: 'button', 'data-execution-inspector': '', 'aria-expanded': 'false' },
  }, 'Inspector', this.hint);
  private readonly activity = el('div', { class: 'acp-execution-card__activity' });
  private readonly slot = el('div', { class: 'acp-execution-card__slot' });

  constructor() {
    super(el('div', { class: 'acp-execution-card' }));
    this.el.append(
      el('div', { class: 'acp-execution-card__head' }, this.glyph.el, this.language,
        this.title, this.state, this.timer, this.timingSource, this.inspector),
      this.activity, this.slot,
    );
    this.slot.hidden = true;
  }

  /** The view owns this node's lifetime; removing a row must not dispose it. */
  mountPanel(panel: HTMLElement | null): void {
    if (panel === null) this.slot.replaceChildren();
    else if (this.slot.firstChild !== panel || this.slot.childNodes.length !== 1) this.slot.replaceChildren(panel);
    this.slot.hidden = panel === null;
    const expanded = String(panel !== null);
    if (this.inspector.getAttribute('aria-expanded') !== expanded) this.inspector.setAttribute('aria-expanded', expanded);
  }

  setHint(label: string | null): void {
    setText(this.hint, label ?? '');
    this.hint.hidden = label === null;
  }

  protected readDeps(next: ExecutionCardProps): readonly unknown[] {
    return [next.payload, next.status, next.startedAt, next.endedAt, next.hintLabel];
  }

  protected syncClasses(next: ExecutionCardProps): void {
    this.el.dataset.state = executionState(next.payload, next.status);
  }

  protected paint(next: ExecutionCardProps): void {
    const payload = next.payload;
    const state = executionState(payload, next.status);
    const active = payload.observedLive && (state === 'pending' || state === 'running');
    this.syncClasses(next);
    this.glyph.update({ running: active, terminalGlyph: state === 'complete' ? '✓' : state === 'error' ? '✗' : '·' });
    this.glyph.el.classList.add('acp-execution-card__glyph');
    setText(this.language, payload.language === 'py' ? 'Python' : 'JavaScript');
    setText(this.title, payload.title);
    setText(this.state, `${STATE_LABEL[state]}${state === 'running' && !payload.output ? ' · no output yet' : ''}`);
    this.setHint(next.hintLabel);
    const latest = payload.activity[payload.activity.length - 1];
    setText(this.activity, latest ? (latest.text || latest.detail || latest.op) : '');
    this.activity.hidden = latest === undefined;
    this.paintTimer(next, active, state);
    if (payload.detached && state === 'background') {
      this.state.title = `Job ${payload.detached.jobId} · ${payload.detached.state}`;
    } else this.state.removeAttribute('title');
  }

  private paintTimer(next: ExecutionCardProps, active: boolean, state: ExecutionState): void {
    const { payload, startedAt, endedAt } = next;
    const reported = !active && payload.durationMs !== null;
    const observed = payload.observedLive && startedAt !== undefined && (active || endedAt !== undefined);
    this.timer.hidden = state === 'background' || (!reported && !observed);
    this.timingSource.hidden = this.timer.hidden;
    if (this.timer.hidden) {
      this.timer.removeAttribute('data-started-at');
      this.timer.setAttribute('data-ended-at', '');
      setText(this.timer, '');
      return;
    }
    const duration = reported ? payload.durationMs! : active ? performance.now() - startedAt! : endedAt! - startedAt!;
    setAttr(this.timer, 'data-started-at', active ? String(startedAt) : undefined);
    setAttr(this.timer, 'data-ended-at', active ? undefined : String(endedAt ?? ''));
    this.timer.title = reported ? 'Runtime reported duration' : 'Observed call elapsed time';
    setText(this.timingSource, reported ? 'runtime' : 'observed');
    setText(this.timer, formatToolElapsed(duration));
  }

  protected onDispose(): void {
    this.invalidateDeps();
    this.glyph.dispose();
    this.mountPanel(null);
    this.el.remove();
  }
}

export const def: ComponentDef = { id: 'execution-card', blocks: ['acp-execution-card'] };
