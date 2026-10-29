// Krypton — ACP Harness View: ticket picker / dock pure helpers (specs 194, 238).
//
// Extracted from acp-harness-view.ts (spec 275) so the ticket controller and
// the view share them without an import cycle. Re-exported from the view.

import type { IssueBinding, LocalTicketDetail, TicketPickerRow } from './harness-view-types';

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

/** Spec 342: the Ticket Panel's issue actions, in paint order. `icon` is the
 *  `krypton-icon-*` suffix in `harness-icons.ts`; Fix reuses the lane bar's wrench. */
export const TICKET_DOCK_ACTIONS = [
  { verb: 'analyze-github-issue', label: 'Analyze', icon: 'issue-analyze' },
  { verb: 'fix-github-issue', label: 'Fix here', icon: 'tool' },
  { verb: 'handle-github-issue', label: 'Handle', icon: 'issue-handle' },
  { verb: 'post-github-comment', label: 'Comment', icon: 'issue-comment' },
  { verb: 'tag-github-issue', label: 'Label', icon: 'issue-label' },
  { verb: 'attach-issue-artifact', label: 'Attach', icon: 'issue-attach' },
] as const;

export type TicketDockAction = (typeof TICKET_DOCK_ACTIONS)[number]['verb'];

export function ticketDockActionFromData(value: string | undefined): TicketDockAction | null {
  return TICKET_DOCK_ACTIONS.find((action) => action.verb === value)?.verb ?? null;
}

/** Spec 342: what one action button shows. `done` stays clickable; the colour warns. */
export type TicketActionState =
  | { readonly kind: 'idle' }
  | { readonly kind: 'running'; readonly lane: string }
  | { readonly kind: 'done'; readonly badge: string; readonly detail: string };

function pad2(value: number): string {
  return String(value).padStart(2, '0');
}

/** `HH:MM` for a time on `now`'s local day, `MM-DD` otherwise. Absolute, so the
 *  dock needs no timer: "today" is judged at paint. */
export function formatActionTime(at: number, now: number): string {
  const when = new Date(at);
  const today = new Date(now);
  const sameDay = when.getFullYear() === today.getFullYear()
    && when.getMonth() === today.getMonth()
    && when.getDate() === today.getDate();
  return sameDay
    ? `${pad2(when.getHours())}:${pad2(when.getMinutes())}`
    : `${pad2(when.getMonth() + 1)}-${pad2(when.getDate())}`;
}

function fullActionTime(at: number): string {
  const when = new Date(at);
  return `${when.getFullYear()}-${pad2(when.getMonth() + 1)}-${pad2(when.getDate())} `
    + `${pad2(when.getHours())}:${pad2(when.getMinutes())}`;
}

/** Handle runs Analyze → Fix → Comment, so its completion marks those three too. */
const HANDLE_COVERS: Partial<Record<TicketDockAction, true>> = {
  'analyze-github-issue': true,
  'fix-github-issue': true,
  'post-github-comment': true,
};

/**
 * Spec 342 state rules. `running` wins; then the first piece of evidence: the
 * issue's own state for Fix, the action log, a finished Handle, and for Analyze
 * an existing analysis bundle. "Done" means the turn finished, not that GitHub
 * accepted a write.
 */
export function ticketActionStates(input: {
  readonly ticket: Pick<LocalTicketDetail, 'actions' | 'analysis' | 'github'>;
  readonly binding: Pick<IssueBinding, 'phase' | 'prUrl'> | null;
  readonly running: ReadonlyMap<TicketDockAction, string>;
  readonly now: number;
}): Record<TicketDockAction, TicketActionState> {
  const { ticket, binding, running, now } = input;
  const log = ticket.actions ?? {};
  const fromLog = (verb: TicketDockAction, label: string): TicketActionState | null => {
    const run = log[verb];
    if (!run) return null;
    return {
      kind: 'done',
      badge: `✓ ${formatActionTime(run.at, now)}`,
      detail: `${label} ran ${fullActionTime(run.at)} in ${run.laneDisplayName}`,
    };
  };
  const states = {} as Record<TicketDockAction, TicketActionState>;
  for (const { verb, label } of TICKET_DOCK_ACTIONS) {
    const lane = running.get(verb);
    if (lane !== undefined) {
      states[verb] = { kind: 'running', lane };
      continue;
    }
    let state: TicketActionState | null = null;
    if (verb === 'fix-github-issue') {
      if (ticket.github?.state === 'closed') {
        state = { kind: 'done', badge: '✓ closed', detail: 'The issue is closed on GitHub' };
      } else if (binding?.phase === 'pr_opened') {
        state = { kind: 'done', badge: '✓ PR', detail: binding.prUrl ? `PR opened: ${binding.prUrl}` : 'PR opened' };
      } else if (binding?.phase === 'done') {
        state = { kind: 'done', badge: '✓ done', detail: 'The lane reported the fix done' };
      }
    }
    state ??= fromLog(verb, label);
    if (!state && HANDLE_COVERS[verb]) state = fromLog('handle-github-issue', 'Handle');
    if (!state && verb === 'analyze-github-issue' && ticket.analysis && ticket.analysis.markdownCount > 0) {
      state = {
        kind: 'done',
        badge: `✓ ${formatActionTime(ticket.analysis.updatedAt, now)}`,
        detail: `Analysis bundle updated ${fullActionTime(ticket.analysis.updatedAt)}`,
      };
    }
    states[verb] = state ?? { kind: 'idle' };
  }
  return states;
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
