// Spec 387 — snapshot presentations for #mcp, #bg and bare #assist.
import './system-command-row.css';

import { el } from '../../../ui/dom';
import { formatTaskBytes } from '../../harness-background-tasks';
import { formatElapsed } from '../../harness-format';
import type { SystemCommandPayload } from '../../harness-view-types';
import { TranscriptRow, type RowProps } from '../transcript-row';
import type { ComponentDef } from '../types';

const block = 'acp-harness__system-command';

function table(headers: readonly string[], rows: readonly (readonly string[])[]): HTMLElement {
  return el('div', { class: `${block}-scroll` },
    el('table', { class: `${block}-table` },
      el('thead', {}, el('tr', {}, ...headers.map((header) => el('th', { attrs: { scope: 'col' }, text: header })))),
      el('tbody', {}, ...rows.map((cells) => el('tr', {}, ...cells.map((cell) => el('td', { text: cell }))))),
    ),
  );
}

function shortTime(at: number): string {
  return new Date(at).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
}

function content(payload: SystemCommandPayload, createdAt: number | undefined): HTMLElement[] {
  switch (payload.command) {
    case 'mcp': {
      if (payload.endpoint === null) {
        return [
          el('div', { class: `${block}-warning`, text: `mcp: harness memory unavailable${payload.warning ? ` - ${payload.warning}` : ''}` }),
          el('div', { class: `${block}-note`, text: 'lanes continue without the krypton-harness-memory MCP server' }),
        ];
      }
      return [
        el('div', { class: `${block}-endpoint`, children: ['Endpoint: ', el('span', { text: payload.endpoint })] }),
        ...(payload.warning ? [el('div', { class: `${block}-warning`, text: payload.warning })] : []),
        table(['Lane', 'Init', 'List', 'Call', 'Last'], payload.lanes.map((lane) => [
          `${lane.listed > 0 ? '✓' : '—'} ${lane.name}`, String(lane.initialized), String(lane.listed), String(lane.called),
          lane.lastSeenAt === null ? '—' : shortTime(lane.lastSeenAt),
        ])),
        el('div', { class: `${block}-note`, text: '✓ = adapter listed tools at least once. — = adapter never queried this lane.' }),
      ];
    }
    case 'bg':
      if (payload.tasks.length === 0) return [el('div', { class: `${block}-note`, text: 'bg: no background tasks on this lane.' })];
      return [table(['Task', 'State', 'Elapsed', 'Output', 'Command', 'Output file'], payload.tasks.map((task) => [
        task.id, task.state, formatElapsed((task.endedAt ?? payload.capturedAt) - task.startedAt),
        formatTaskBytes(task.bytes), task.command, task.outputPath ?? '—',
      ]))];
    case 'assist': {
      const { task } = payload;
      return [
        el('div', { class: `${block}-assist`, children: [
          el('span', { class: `${block}-task-id`, text: task.id }),
          el('span', { class: `${block}-mode`, text: task.mode }),
          el('span', { class: `${block}-summary`, text: task.summary }),
        ] }),
        ...(task.pausedUntil === null ? [] : [el('div', { class: `${block}-note`, text: createdAt === undefined ? `Paused until ${shortTime(task.pausedUntil)}` : `Paused for ${formatElapsed(task.pausedUntil - createdAt)}` })]),
      ];
    }
  }
}

export class SystemCommandRow extends TranscriptRow {

  protected bodyClasses(): readonly string[] {
    return [block];
  }

  protected bodyDeps(next: RowProps): readonly unknown[] {
    return [next.item.systemCommand, next.item.createdAt];
  }

  protected paintBody(body: HTMLElement, next: RowProps): void {
    const payload = next.item.systemCommand;
    if (!payload) return;
    const nodes = content(payload, next.item.createdAt);
    const kind = el('span', { class: `${block}-kind`, children: [
      el('span', { class: `${block}-glyph`, attrs: { 'aria-hidden': 'true' } }),
      payload.command,
    ] });
    if (payload.command === 'assist') {
      nodes[0].prepend(kind);
      body.replaceChildren(...nodes);
    } else {
      body.replaceChildren(
        el('div', { class: `${block}-head` }, kind),
        el('div', { class: `${block}-well` }, ...nodes),
      );
    }
  }
}

export const def: ComponentDef = { id: 'system-command-row', blocks: [block] };
