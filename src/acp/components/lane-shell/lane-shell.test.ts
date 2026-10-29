import { describe, expect, it } from 'vitest';

import { LaneShell, laneShellKey, type LaneShellProps } from './index';
import type { HarnessLane } from '../../harness-view-types';

// Assert the runtime DOM and Start Review behavior, not removed form markup.

function lane(): HarnessLane {
  return {
    id: 'l1',
    displayName: 'Claude-1',
    backendId: 'claude',
    status: 'idle',
    accent: '#4dd0ff',
    transcript: [],
    backgroundTasks: [],
    toolCalls: new Map(),
    queuedPrompts: [],
    pendingPermissions: [],
    pendingQuestions: [],
    seenTranscriptIds: new Set(),
    draft: '',
    cursor: 0,
    availableCommands: [],
    stagedImages: [],
    sessionId: 'd83acd09',
    permissionMode: 'normal',
    transcriptWindow: 60,
  } as unknown as HarnessLane;
}

function props(over: Partial<LaneShellProps> = {}): LaneShellProps {
  return {
    lane: lane(),
    active: true,
    mcp: null,
    metrics: null,
    inboxDepth: 0,
    pendingPeers: [],
    isOrchestrator: false,
    runs: [],
    projectDir: '/tmp/proj',
    reviewThread: null,
    onStartReview: () => {},
    ...over,
  };
}

function mount(next: LaneShellProps): LaneShell {
  const shell = new LaneShell(next, null);
  shell.update(next);
  return shell;
}

const head = (shell: LaneShell): HTMLElement =>
  shell.el.querySelector<HTMLElement>('.acp-harness__lane-head') as HTMLElement;

/** The grid's track count. A seventh child is the bug this file exists for. */
const HEAD_COLUMNS = 6;

describe('LaneShell head actions', () => {
  it('keeps Start Review in its reserved head column without Timeline approval UI', () => {
    const shell = mount(props({ reviewThread: { count: 0, enabled: true } }));

    expect(head(shell).children.length).toBeLessThanOrEqual(HEAD_COLUMNS);
    const slot = head(shell).querySelector('.acp-harness__lane-actions');
    expect(slot).not.toBeNull();
    expect([...(slot as HTMLElement).children].map((child) => child.className)).toEqual([
      'acp-harness__review-thread-action',
    ]);
    expect(shell.el.querySelector('[data-timeline-review]')).toBeNull();
    expect(shell.el.querySelector('.acp-harness__timeline-overlay')).toBeNull();
  });

  it('drops the action wrapper entirely when neither action applies', () => {
    const shell = mount(props({ reviewThread: { count: 0, enabled: true } }));
    shell.update(props());

    expect(head(shell).querySelector('.acp-harness__lane-actions')).toBeNull();
    expect(head(shell).children.length).toBeLessThanOrEqual(HEAD_COLUMNS - 1);
  });

  it('preserves Start Review disabled state and count', () => {
    const reviewOnly = mount(props({ reviewThread: { count: 2, enabled: false } }));
    const button = reviewOnly.el.querySelector<HTMLButtonElement>('.acp-harness__review-thread-action');
    expect(button?.textContent).toBe('Start Review · 2');
    expect(button?.disabled).toBe(true);
    expect(reviewOnly.el.querySelector('.acp-harness__timeline-badge')).toBeNull();
  });

  it('gives a collapsed lane neither action', () => {
    const shell = mount(props({ active: false, reviewThread: { count: 1, enabled: true } }));

    expect(shell.el.querySelector('.acp-harness__lane-actions')).toBeNull();
    expect(shell.body).toBeNull();
  });

  it('keys an active lane apart from a collapsed one so the body is never reused', () => {
    expect(laneShellKey('l1', true)).not.toBe(laneShellKey('l1', false));
  });

  it('invokes the current Start Review handler without rebuilding the action', () => {
    let first = 0;
    let second = 0;
    const shell = mount(props({ reviewThread: { count: 0, enabled: true }, onStartReview: () => first++ }));
    const button = shell.el.querySelector<HTMLButtonElement>('.acp-harness__review-thread-action')!;
    button.click();
    shell.update(props({ reviewThread: { count: 1, enabled: true }, onStartReview: () => second++ }));
    expect(shell.el.querySelector('.acp-harness__review-thread-action')).toBe(button);
    button.click();
    expect([first, second]).toEqual([1, 1]);
  });
});
