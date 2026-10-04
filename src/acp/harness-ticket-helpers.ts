// Krypton — ACP Harness View: ticket picker / dock pure helpers (specs 194, 238).
//
// Extracted from acp-harness-view.ts (spec 275) so the ticket controller and
// the view share them without an import cycle. Re-exported from the view.

import type { TicketPickerRow } from './harness-view-types';

export function controlError(code: string, message: string): Error {
  return Object.assign(new Error(message), { code, retryable: false });
}

export type TicketPickerAction =
  | 'set-ticket'
  | 'analyze-github-issue'
  | 'post-github-comment'
  | 'fix-github-issue';

export type TicketPickerTab = 'open' | 'closed';

export function ticketPickerActionForKey(
  event: Pick<KeyboardEvent, 'key' | 'metaKey' | 'ctrlKey'>,
): TicketPickerAction | null {
  if (event.key === 'Enter' && !event.metaKey && !event.ctrlKey) return 'set-ticket';
  if (!event.metaKey && !event.ctrlKey) return null;
  if (event.key === '1') return 'analyze-github-issue';
  if (event.key === '2') return 'post-github-comment';
  if (event.key === '3') return 'fix-github-issue';
  return null;
}

/** Local `done` and GitHub `closed` share the Closed tab so finished work
 *  is not mixed into the Open list. Blocked stays Open — it is still live. */
export function ticketPickerRowIsClosed(row: Pick<TicketPickerRow, 'state'>): boolean {
  return row.state === 'done' || row.state === 'closed';
}

export function ticketPickerTabCounts(rows: TicketPickerRow[]): { open: number; closed: number } {
  let open = 0;
  let closed = 0;
  for (const row of rows) {
    if (ticketPickerRowIsClosed(row)) closed += 1;
    else open += 1;
  }
  return { open, closed };
}

export function filterTicketPickerRows(
  rows: TicketPickerRow[],
  filter: string,
  tab: TicketPickerTab,
): TicketPickerRow[] {
  const wantClosed = tab === 'closed';
  const query = filter.trim().toLowerCase();
  return rows.filter((row) => {
    if (ticketPickerRowIsClosed(row) !== wantClosed) return false;
    if (!query) return true;
    return `${row.kind} ${row.ticketId ?? ''} #${row.number ?? ''} ${row.title} ${row.labels.join(' ')}`
      .toLowerCase()
      .includes(query);
  });
}

export function ticketWorkActionDisabledReason(
  lane: { displayName: string; status: string; hasClient: boolean } | null,
): string | null {
  if (!lane) return 'no active lane';
  if (!lane.hasClient || lane.status === 'stopped') return `${lane.displayName} is not live`;
  if (lane.status !== 'idle' && lane.status !== 'awaiting_peer') {
    return `${lane.displayName} is ${lane.status}`;
  }
  return null;
}

/** Serializes active-ticket pointer writes so a late save cannot resurrect a cleared id. */
export class PointerPersistGate {
  private generation = 0;
  begin(): number {
    this.generation += 1;
    return this.generation;
  }
  isCurrent(generation: number): boolean {
    return generation === this.generation;
  }
}

export function githubIssueRefRequiredMessage(
  verb: string,
  ticket: { github?: unknown } | null,
): string {
  if (ticket && !ticket.github) {
    return 'active ticket has no GitHub reference; use #ticket link <ref>';
  }
  const name = verb.replace(/^#/, '');
  return `usage: #${name} <issue url | owner/repo#123> (or set one with #ticket)`;
}

export function ticketMarkdownPath(projectDir: string | null, relativePath: string): string {
  const rel = `${relativePath.replace(/\/?$/, '/')}ticket.md`;
  if (!projectDir) return rel;
  return `${projectDir.replace(/\/+$/, '')}/${rel}`;
}

export function isSameTicketPicker(
  started: { rows: TicketPickerRow[] } | null,
  current: { rows: TicketPickerRow[] } | null,
): boolean {
  return started !== null && started === current;
}

export function formatTicketBytes(value: number): string {
  if (value < 1024) return `${value} B`;
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KiB`;
  return `${(value / (1024 * 1024)).toFixed(1)} MiB`;
}
