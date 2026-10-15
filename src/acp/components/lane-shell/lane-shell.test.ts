import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { LaneShell, laneShellKey, type LaneShellProps } from './index';
import type { HarnessLane } from '../../harness-view-types';

// Spec 302 §4.1.
//
// `.acp-harness__lane-head` is a SIX-column grid pinned to `height: 28px` with
// `overflow: hidden`. Before this component the timeline badge and the
// review-thread action could never be present at once — `renderDashboard` and
// `renderActiveLaneChrome` each rewrote `head.innerHTML` and appended only
// their own button, wiping the other's. `LaneShell` keeps both, and a seventh
// grid item wraps to an implicit second row that the fixed height clips to a
// sliver of its own border: a thin coloured band under the lane head.
//
// happy-dom has no layout, so the invariant is asserted structurally: the head
// never exceeds its six columns, because every action shares one wrapper.

function lane(): HarnessLane {
  return {
    id: 'l1',
    displayName: 'Claude-1',
    backendId: 'claude',
    status: 'idle',
    accent: '#4dd0ff',
    transcript: [],
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
    projectDir: '/tmp/proj',
    timelinePending: 0,
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
  it('keeps the head within its grid columns when both actions are present', () => {
    const shell = mount(props({ timelinePending: 23, reviewThread: { count: 0, enabled: true } }));

    expect(head(shell).children.length).toBeLessThanOrEqual(HEAD_COLUMNS);
    const slot = head(shell).querySelector('.acp-harness__lane-actions');
    expect(slot).not.toBeNull();
    expect([...(slot as HTMLElement).children].map((child) => child.className)).toEqual([
      'acp-harness__timeline-badge',
      'acp-harness__review-thread-action',
    ]);
  });

  it('drops the action wrapper entirely when neither action applies', () => {
    const shell = mount(props({ timelinePending: 23, reviewThread: { count: 0, enabled: true } }));
    shell.update(props());

    expect(head(shell).querySelector('.acp-harness__lane-actions')).toBeNull();
    expect(head(shell).children.length).toBeLessThanOrEqual(HEAD_COLUMNS - 1);
  });

  it('carries either action alone', () => {
    const badgeOnly = mount(props({ timelinePending: 4 }));
    expect(badgeOnly.el.querySelector('.acp-harness__timeline-badge')?.textContent).toBe('timeline 4');
    expect(badgeOnly.el.querySelector('.acp-harness__review-thread-action')).toBeNull();

    const reviewOnly = mount(props({ reviewThread: { count: 2, enabled: false } }));
    const button = reviewOnly.el.querySelector<HTMLButtonElement>('.acp-harness__review-thread-action');
    expect(button?.textContent).toBe('Start Review · 2');
    expect(button?.disabled).toBe(true);
    expect(reviewOnly.el.querySelector('.acp-harness__timeline-badge')).toBeNull();
  });

  it('gives a collapsed lane neither action', () => {
    const shell = mount(props({ active: false, timelinePending: 9, reviewThread: { count: 1, enabled: true } }));

    expect(shell.el.querySelector('.acp-harness__lane-actions')).toBeNull();
    expect(shell.body).toBeNull();
  });

  it('keys an active lane apart from a collapsed one so the body is never reused', () => {
    expect(laneShellKey('l1', true)).not.toBe(laneShellKey('l1', false));
  });

  // The two actions drifted into two different widgets while they could never
  // be seen together: 4px radius vs 8px, `1px 6px` vs `2px 8px`, `0.72em` vs an
  // absolute `11px`. Shape belongs to ONE rule; only hue may differ per action.
  it('shapes both actions from a single rule, leaving only hue per action', () => {
    const css = readFileSync(join(import.meta.dirname, 'lane-shell.css'), 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '');
    const rules = [...css.matchAll(/(?<=^|[}{;])\s*([^{}@]+?)\s*\{([^{}]*)\}/g)].map((m) => ({
      selector: m[1].replace(/\s+/g, ' ').trim(),
      body: m[2],
    }));

    const shared = rules.find(
      (rule) =>
        rule.selector.includes('.acp-harness__timeline-badge,')
        && rule.selector.includes('.acp-harness__review-thread-action')
        && !rule.selector.includes(':'),
    );
    expect(shared, 'one rule must shape both actions').toBeDefined();
    for (const property of ['border-radius', 'padding', 'font-size', 'min-height']) {
      expect(shared?.body, property).toMatch(new RegExp(`(^|[;\\s])${property}\\s*:`, 'u'));
    }

    // Per-action rules may set colour and nothing that changes the shape.
    const SHAPE = /(^|[;\s])(border-radius|padding|font-size|min-height|border-style|border-width)\s*:/u;
    for (const action of ['.acp-harness__timeline-badge', '.acp-harness__review-thread-action']) {
      for (const rule of rules.filter((r) => r.selector === action)) {
        expect(rule.body, action).not.toMatch(SHAPE);
      }
    }
  });
});
