import { describe, expect, it } from 'vitest';

import {
  formatActionTime,
  ticketActionStates,
  type TicketActionState,
  type TicketDockAction,
} from './harness-ticket-helpers';
import type { GithubTicketReference, LocalTicketDetail } from './harness-view-types';

// Spec 342 state rules for the Ticket Panel's issue actions.

const NOW = new Date(2026, 9, 29, 16, 30).getTime();
const TODAY_1402 = new Date(2026, 9, 29, 14, 2).getTime();
const OCT_27 = new Date(2026, 9, 27, 9, 5).getTime();

const GITHUB: GithubTicketReference = {
  issueKey: 'wk/krypton#342',
  issueUrl: 'https://github.com/wk/krypton/issues/342',
  repo: 'wk/krypton',
  number: 342,
  title: 'Ticket actions',
  state: 'open',
  fetchedAt: 0,
};

type TicketInput = Pick<LocalTicketDetail, 'actions' | 'analysis' | 'github'>;

function states(
  ticket: TicketInput,
  options: {
    binding?: { phase?: 'pr_opened' | 'done' | 'fixing'; prUrl?: string } | null;
    running?: [TicketDockAction, string][];
  } = {},
): Record<TicketDockAction, TicketActionState> {
  return ticketActionStates({
    ticket,
    binding: options.binding ?? null,
    running: new Map(options.running ?? []),
    now: NOW,
  });
}

describe('formatActionTime', () => {
  it('prints HH:MM for a time today and MM-DD for any other day', () => {
    expect(formatActionTime(TODAY_1402, NOW)).toBe('14:02');
    expect(formatActionTime(OCT_27, NOW)).toBe('10-27');
  });
});

describe('ticketActionStates', () => {
  it('is all idle for a ticket nothing has run on', () => {
    const result = states({ github: GITHUB });
    expect(Object.values(result).every((state) => state.kind === 'idle')).toBe(true);
  });

  it('shows a logged run as done with its time and lane', () => {
    const result = states({
      github: GITHUB,
      actions: { 'post-github-comment': { at: TODAY_1402, laneDisplayName: 'codex-1' } },
    });
    expect(result['post-github-comment']).toEqual({
      kind: 'done',
      badge: '✓ 14:02',
      detail: 'Comment ran 2026-10-29 14:02 in codex-1',
    });
    expect(result['tag-github-issue'].kind).toBe('idle');
  });

  it('puts running ahead of a done record', () => {
    const result = states(
      { github: GITHUB, actions: { 'fix-github-issue': { at: OCT_27, laneDisplayName: 'codex-1' } } },
      { running: [['fix-github-issue', 'claude-1']] },
    );
    expect(result['fix-github-issue']).toEqual({ kind: 'running', lane: 'claude-1' });
  });

  it('marks Fix from the issue itself: closed, then a reported PR, then the log', () => {
    const log = { 'fix-github-issue': { at: OCT_27, laneDisplayName: 'codex-1' } };
    const pr = { phase: 'pr_opened' as const, prUrl: 'https://github.com/wk/krypton/pull/9' };

    const closed = states({ github: { ...GITHUB, state: 'closed' }, actions: log }, { binding: pr });
    expect(closed['fix-github-issue']).toMatchObject({ kind: 'done', badge: '✓ closed' });

    const opened = states({ github: GITHUB, actions: log }, { binding: pr });
    expect(opened['fix-github-issue']).toEqual({
      kind: 'done',
      badge: '✓ PR',
      detail: 'PR opened: https://github.com/wk/krypton/pull/9',
    });

    const reportedDone = states({ github: GITHUB }, { binding: { phase: 'done' } });
    expect(reportedDone['fix-github-issue']).toMatchObject({ kind: 'done', badge: '✓ done' });

    const stillFixing = states({ github: GITHUB, actions: log }, { binding: { phase: 'fixing' } });
    expect(stillFixing['fix-github-issue']).toMatchObject({ kind: 'done', badge: '✓ 10-27' });
  });

  it('lets a finished Handle cover Analyze, Fix and Comment but not Label or Attach', () => {
    const result = states({
      github: GITHUB,
      actions: { 'handle-github-issue': { at: TODAY_1402, laneDisplayName: 'codex-1' } },
    });
    for (const verb of ['handle-github-issue', 'analyze-github-issue', 'fix-github-issue', 'post-github-comment'] as const) {
      expect(result[verb]).toMatchObject({ kind: 'done', badge: '✓ 14:02', detail: expect.stringContaining('ran') });
    }
    expect(result['analyze-github-issue']).toMatchObject({ detail: 'Handle ran 2026-10-29 14:02 in codex-1' });
    expect(result['tag-github-issue'].kind).toBe('idle');
    expect(result['attach-issue-artifact'].kind).toBe('idle');
  });

  it('counts an existing analysis bundle as Analyze done, but not an empty one', () => {
    const analysis = { relativePath: 'analysis', markdownCount: 2, attachmentCount: 0, updatedAt: OCT_27 };
    expect(states({ github: GITHUB, analysis })['analyze-github-issue'])
      .toMatchObject({ kind: 'done', badge: '✓ 10-27' });
    expect(states({ github: GITHUB, analysis: { ...analysis, markdownCount: 0 } })['analyze-github-issue'].kind)
      .toBe('idle');
  });
});
