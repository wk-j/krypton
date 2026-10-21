import './execution-card.css';

import { Component } from '../../../ui/component';
import { el, setAttr } from '../../../ui/dom';
import { EXECUTION_STATE_LABEL, executionState, executionTiming, isExecutionLive, type ExecutionTiming } from '../../harness-execution';
import { formatToolElapsed } from '../../harness-tool-render';
import type { ExecutionPayload } from '../../harness-view-types';
import { Spinner } from '../spinner';
import type { ComponentDef } from '../types';

export interface ExecutionCardProps {
  readonly payload: ExecutionPayload;
  readonly status: string;
  readonly startedAt?: number;
  readonly endedAt?: number;
  readonly hintLabel: string | null;
}

function setText(node: Node, text: string): void {
  if (node.textContent !== text) node.textContent = text;
}

/**
 * Write one execution timing into a `.acp-harness__tool-timer` node and its
 * provenance label. A live node carries `data-started-at` and no
 * `data-ended-at`, so the view's shared ticker advances it; every other node is
 * frozen. Shared by the card and the Inspector dialog (spec 319) so the two
 * never disagree about which time they show.
 */
export function paintExecutionTiming(timer: HTMLElement, source: HTMLElement, timing: ExecutionTiming, startedAt?: number, endedAt?: number): void {
  timer.hidden = !timing.visible;
  source.hidden = !timing.visible;
  if (!timing.visible) {
    timer.removeAttribute('data-started-at');
    timer.setAttribute('data-ended-at', '');
    setText(timer, '');
    return;
  }
  setAttr(timer, 'data-started-at', timing.live ? String(startedAt) : undefined);
  setAttr(timer, 'data-ended-at', timing.live ? undefined : String(endedAt ?? ''));
  timer.title = timing.source === 'runtime' ? 'Runtime reported duration' : 'Observed call elapsed time';
  setText(source, timing.source);
  setText(timer, formatToolElapsed(timing.durationMs));
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
    attrs: { type: 'button', 'data-execution-inspector': '', 'aria-haspopup': 'dialog' },
  }, 'Inspector', this.hint);
  private readonly activity = el('div', { class: 'acp-execution-card__activity' });

  constructor() {
    super(el('div', { class: 'acp-execution-card' }));
    this.el.append(
      el('div', { class: 'acp-execution-card__head' }, this.glyph.el, this.language,
        this.title, this.state, this.timer, this.timingSource, this.inspector),
      this.activity,
    );
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
    this.syncClasses(next);
    this.glyph.update({ running: isExecutionLive(payload, state), terminalGlyph: state === 'complete' ? '✓' : state === 'error' ? '✗' : '·' });
    this.glyph.el.classList.add('acp-execution-card__glyph');
    setText(this.language, payload.language === 'py' ? 'Python' : 'JavaScript');
    setText(this.title, payload.title);
    setText(this.state, `${EXECUTION_STATE_LABEL[state]}${state === 'running' && !payload.output ? ' · no output yet' : ''}`);
    this.setHint(next.hintLabel);
    const latest = payload.activity[payload.activity.length - 1];
    setText(this.activity, latest ? (latest.text || latest.detail || latest.op) : '');
    this.activity.hidden = latest === undefined;
    paintExecutionTiming(this.timer, this.timingSource, executionTiming(payload, next.status, next.startedAt, next.endedAt), next.startedAt, next.endedAt);
    if (payload.detached && state === 'background') {
      this.state.title = `Job ${payload.detached.jobId} · ${payload.detached.state}`;
    } else this.state.removeAttribute('title');
  }

  protected onDispose(): void {
    this.invalidateDeps();
    this.glyph.dispose();
    this.el.remove();
  }
}

export const def: ComponentDef = { id: 'execution-card', blocks: ['acp-execution-card'] };
