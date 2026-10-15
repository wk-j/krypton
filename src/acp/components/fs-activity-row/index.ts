// Spec 302 §3.8 — `FsActivityRow`.
//
// The one-line `fs read … / fs wrote …` chip (spec 88). A static row: the
// payload is written once when the agent's filesystem call settles.
//
// Ported from `harness-transcript-render.ts:827-852` (`renderFsActivityBody`)
// plus its dispatcher branch at `:358-361`. Markup is unchanged.
//
// Owns the block `acp-harness__fs-activity`, whose rules sat inside the
// byte-identical span `acp-harness.css` declares TWICE — see the header of
// `fs-activity-row.css` for the two ranges to delete.

import { el } from '../../../ui/dom';
import { TranscriptRow, type RowProps } from '../transcript-row';
import type { ComponentDef } from '../types';
import './fs-activity-row.css';

export class FsActivityRow extends TranscriptRow {
  private readonly icon = el('span', { class: 'acp-harness__fs-activity-icon' });
  private readonly verb = el('span', { class: 'acp-harness__fs-activity-verb' });
  private readonly path = el('span', { class: 'acp-harness__fs-activity-path' });
  private error: HTMLElement | null = null;

  constructor(props: RowProps) {
    super(props, false);
  }

  protected bodyClasses(next: RowProps): readonly string[] {
    const payload = next.item.fsActivity;
    if (!payload) return [];
    if (payload.ok) return ['acp-harness__fs-activity'];
    return ['acp-harness__fs-activity', 'acp-harness__fs-activity--err'];
  }

  protected bodyDeps(next: RowProps): readonly unknown[] {
    const payload = next.item.fsActivity;
    if (!payload) return [undefined, undefined, undefined, next.item.text];
    return [payload.method, payload.path, payload.ok, payload.error];
  }

  protected paintBody(body: HTMLElement, next: RowProps): void {
    const payload = next.item.fsActivity;
    if (!payload) {
      body.textContent = next.item.text;
      return;
    }
    this.icon.textContent = payload.ok ? (payload.method === 'read' ? '📖' : '✏️') : '✗';
    this.verb.textContent = payload.ok
      ? (payload.method === 'read' ? 'read' : 'wrote')
      : `${payload.method} failed`;
    // An empty path still needs a cell, or the row collapses to two glyphs.
    this.path.textContent = payload.path || '«empty»';
    this.path.title = payload.path;
    const nodes: Node[] = [this.icon, this.verb, this.path];
    if (payload.error) {
      if (!this.error) this.error = el('span', { class: 'acp-harness__fs-activity-error' });
      this.error.textContent = payload.error;
      nodes.push(this.error);
    } else {
      this.error = null;
    }
    body.replaceChildren(...nodes);
  }
}

export const def: ComponentDef = { id: 'fs-activity-row', blocks: ['acp-harness__fs-activity'] };
