import './remote-command-card.css';

import { Component } from '../../../ui/component';
import { el, setAttr } from '../../../ui/dom';
import { keyCap } from '../../../ui/kbd';
import { syncOrder } from '../../../ui/list';
import { CellGridText } from '../../cell-grid';
import { remoteCommandLimitNotes, remoteCommandPreview, remoteCommandState, remoteCommandStatus } from '../../harness-remote-command';
import { formatToolElapsed } from '../../harness-tool-render';
import type { RemoteCommandPayload } from '../../harness-view-types';
import type { ComponentDef } from '../types';

export interface RemoteCommandCardProps {
  readonly payload: RemoteCommandPayload;
  readonly status: string;
  readonly startedAt?: number;
  readonly endedAt?: number;
  readonly hintLabel: string | null;
  readonly diagnostics?: readonly { readonly label: string; readonly text: string }[];
}

function text(node: Node, value: string): void {
  if (node.textContent !== value) node.textContent = value;
}

/** Uses the existing view ticker; the provenance is never remote runtime. */
export function paintRemoteCommandTiming(timer: HTMLElement, label: HTMLElement, props: Pick<RemoteCommandCardProps, 'payload' | 'status' | 'startedAt' | 'endedAt'>): void {
  const state = remoteCommandState(props.payload, props.status).state;
  const live = state === 'pending' || state === 'running';
  const visible = props.startedAt !== undefined && (props.endedAt !== undefined || live);
  timer.hidden = label.hidden = !visible;
  setAttr(timer, 'data-started-at', visible ? String(props.startedAt) : undefined);
  setAttr(timer, 'data-ended-at', visible && !live ? String(props.endedAt ?? '') : props.endedAt === undefined ? undefined : String(props.endedAt));
  if (visible) text(timer, formatToolElapsed((props.endedAt ?? performance.now()) - props.startedAt!));
}

/** The specialized summary replaces, rather than wraps, the generic tool body. */
export class RemoteCommandCard extends Component<RemoteCommandCardProps> {
  private readonly computer = el('span', { class: 'acp-remote-command-card__computer' });
  private readonly command = el('span', { class: 'acp-remote-command-card__command' });
  private readonly state = el('span', { class: 'acp-remote-command-card__state' });
  private readonly timer = el('span', { class: 'acp-remote-command-card__timer acp-harness__tool-timer', attrs: { title: 'Observed call elapsed time' } });
  private readonly timingLabel = el('span', { class: 'acp-remote-command-card__timing-label', text: 'Call elapsed' });
  private readonly hint = el('span', { class: 'acp-remote-command-card__hint', attrs: { 'aria-hidden': 'true' } });
  private readonly details = el('button', {
    class: 'acp-remote-command-card__button', attrs: { type: 'button', 'data-remote-command-details': '', 'aria-label': 'Remote command details' },
  }, 'Details', this.hint);
  private readonly output = el('div', { class: 'acp-remote-command-card__output' });
  private readonly note = el('div', { class: 'acp-remote-command-card__note' });
  private readonly streams = new Map<string, { el: HTMLElement; text: CellGridText }>();
  private status: string | null = null;

  constructor() {
    super(el('div', { class: 'acp-remote-command-card' }));
    this.el.append(el('div', { class: 'acp-remote-command-card__head' },
      el('span', { class: 'acp-remote-command-card__kind', text: 'REMOTE' }),
      this.computer, this.command,
      el('span', { class: 'acp-remote-command-card__meta' }, this.state, this.timingLabel, this.timer, this.details)),
    this.output, this.note);
  }

  update(next: RemoteCommandCardProps): void {
    this.status = remoteCommandStatus(this.status, next.status);
    super.update(this.status === next.status ? next : { ...next, status: this.status });
  }

  setHint(label: string | null): void {
    if (this.hint.dataset.label !== (label ?? '')) {
      this.hint.replaceChildren(...(label === null ? [] : [keyCap(label)]));
      this.hint.dataset.label = label ?? '';
    }
    this.hint.hidden = label === null;
  }

  protected readDeps(next: RemoteCommandCardProps): readonly unknown[] {
    return [next.payload, next.status, next.startedAt, next.endedAt, next.hintLabel, next.diagnostics];
  }

  protected syncClasses(next: RemoteCommandCardProps): void {
    this.el.dataset.state = remoteCommandState(next.payload, next.status).state;
  }

  protected paint(next: RemoteCommandCardProps): void {
    const state = remoteCommandState(next.payload, next.status);
    this.el.dataset.state = state.state;
    text(this.computer, next.payload.computerId);
    this.computer.title = next.payload.computerId;
    text(this.command, next.payload.command.replace(/[\r\n]/g, ' '));
    this.command.title = next.payload.command;
    text(this.state, state.label);
    this.state.title = state.label;
    this.setHint(next.hintLabel);
    paintRemoteCommandTiming(this.timer, this.timingLabel, next);
    const preview = remoteCommandPreview(next.payload, next.status);
    const parts: { stream: string; text: string }[] = [...preview.streams];
    let remaining = 4 - parts.reduce((count, part) => count + part.text.split('\n').length, 0);
    let more = preview.more;
    for (const diagnostic of next.diagnostics ?? []) {
      if (!diagnostic.text) continue;
      const lines = diagnostic.text.split('\n');
      if (lines.length > remaining) more = true;
      if (remaining > 0) parts.push({ stream: `Diagnostic (${diagnostic.label})`, text: lines.slice(0, remaining).join('\n') });
      remaining = Math.max(0, remaining - lines.length);
    }
    const nodes: HTMLElement[] = [];
    for (const part of parts) {
      let stream = this.streams.get(part.stream);
      if (!stream) {
        const pre = el('pre', { class: 'acp-remote-command-card__text' });
        stream = { el: el('div', { class: 'acp-remote-command-card__stream', data: { stream: part.stream } },
          el('span', { class: 'acp-remote-command-card__stream-label', text: part.stream }), pre), text: new CellGridText(pre, '') };
        this.streams.set(part.stream, stream);
      }
      stream.text.set(part.text);
      nodes.push(stream.el);
    }
    syncOrder(this.output, nodes);
    this.output.hidden = nodes.length === 0;
    const notes = remoteCommandLimitNotes(next.payload);
    text(this.note, [more ? 'More output in Details.' : '', notes, next.payload.error ? 'Error reported; see Details.' : ''].filter(Boolean).join(' '));
    this.note.hidden = !this.note.textContent;
  }

  protected onDispose(): void {
    this.streams.clear();
    this.timer.removeAttribute('data-started-at');
    this.el.remove();
  }
}

export const def: ComponentDef = { id: 'remote-command-card', blocks: ['acp-remote-command-card'] };
