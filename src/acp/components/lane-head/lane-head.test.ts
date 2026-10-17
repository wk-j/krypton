import { describe, expect, it } from 'vitest';

import type { HarnessLane } from '../../harness-view-types';
import type { AcpLaneMetrics } from '../../../types';
import { tickAllSpinners } from '../spinner';
import { LaneHead, type LaneHeadProps } from './index';

function makeLane(over: Partial<HarnessLane> = {}): HarnessLane {
  return {
    id: 'lane-1',
    backendId: 'claude',
    displayName: 'Claude-1',
    accent: '#0cf',
    status: 'idle',
    modelName: null,
    modelApplyFailed: false,
    currentMode: null,
    permissionMode: 'normal',
    pollyBuiltinRole: null,
    saltyBuiltinRole: null,
    pendingPermissions: [],
    pendingQuestions: [],
    transcript: [],
    backgroundTasks: [],
    error: null,
    ...over,
  } as unknown as HarnessLane;
}

function props(over: Partial<LaneHeadProps> = {}): LaneHeadProps {
  return {
    lane: makeLane(),
    active: true,
    mcp: null,
    metrics: null,
    inboxDepth: 0,
    pendingPeers: [],
    isOrchestrator: false,
    ...over,
  };
}

function metrics(cpu: number, rss: number): AcpLaneMetrics {
  return {
    session: 1,
    root_pid: 4242,
    root_alive: true,
    total_cpu_percent: cpu,
    total_rss_mb: rss,
    proc_count: 3,
    processes: [],
  };
}

describe('LaneHead', () => {
  it('emits symbol, name + backend logo, status and activity in head order', () => {
    const head = new LaneHead();
    head.update(props({ lane: makeLane({ status: 'idle' }) }));

    expect(head.el.className).toBe('acp-harness__lane-head');
    const kids = [...head.el.children].map((node) => node.className);
    expect(kids).toEqual([
      'acp-harness__lane-symbol acp-harness__lane-symbol--idle',
      'acp-harness__lane-name',
      'acp-harness__lane-status',
      'acp-harness__lane-chips',
      'acp-harness__lane-activity',
    ]);
    expect(head.el.querySelector('.acp-harness__lane-name')?.textContent).toBe('Claude-1');
    expect(head.el.querySelector('.acp-harness__lane-name use')?.getAttribute('href')).toBe('#krypton-logo-claude');
    expect(head.el.querySelector('.acp-harness__lane-status')?.textContent).toBe('idle');
    expect(head.el.querySelector('.acp-harness__lane-activity')?.textContent).toBe('idle');
    head.dispose();
  });

  it('shortens the status word to `perm` on a collapsed lane awaiting permission', () => {
    const head = new LaneHead();
    const lane = makeLane({ status: 'needs_permission' });
    head.update(props({ lane, active: false }));
    expect(head.el.querySelector('.acp-harness__lane-status')?.textContent).toBe('perm');

    head.update(props({ lane, active: true }));
    expect(head.el.querySelector('.acp-harness__lane-status')?.textContent).toBe('action required');
    head.dispose();
  });

  it('builds the chip strip in renderLaneHead order', () => {
    const head = new LaneHead();
    head.update(props({
      lane: makeLane({ modelName: 'claude-sonnet-4-5', backendId: 'pi-acp', displayName: 'Pi-1' }),
      mcp: { laneLabel: 'Pi-1', initializeCount: 1, toolsListCount: 2, toolsCallCount: 14, lastMethod: 'tools/call', lastSeenAt: 0 },
      metrics: metrics(12.4, 843),
      inboxDepth: 2,
      isOrchestrator: true,
    }));

    const chips = [...(head.el.querySelector('.acp-harness__lane-chips')?.children ?? [])];
    expect(chips.map((chip) => chip.className)).toEqual([
      'acp-harness__lane-inbox',
      'acp-harness__lane-orchestrator',
      'acp-harness__lane-model',
      'acp-harness__lane-mcp acp-harness__lane-mcp--on',
      'acp-harness__lane-sandbox',
      'acp-harness__lane-metrics acp-harness__lane-metrics--idle',
    ]);
    expect(chips[0].textContent).toBe('2');
    expect(chips[1].textContent).toBe('◆ orch');
    expect(chips[3].textContent).toBe('mcp  14');
    expect(chips[4].textContent).toBe(' unsandboxed');
    expect(chips[5].outerHTML).toBe(
      '<span class="acp-harness__lane-metrics acp-harness__lane-metrics--idle" '
      + 'title="pid 4242 · adapter + 2 children · ⌘P m for breakdown">'
      + '<span class="acp-harness__lane-metrics-cpu">12%</span>'
      + '<span class="acp-harness__lane-metrics-rss">843M</span></span>',
    );
    head.dispose();
  });

  it('shows the off-state mcp chip when the adapter never called tools/list', () => {
    const head = new LaneHead();
    head.update(props({
      mcp: { laneLabel: 'Claude-1', initializeCount: 3, toolsListCount: 0, toolsCallCount: 0, lastMethod: null, lastSeenAt: 0 },
    }));
    const chip = head.el.querySelector('.acp-harness__lane-mcp--off');
    expect(chip?.textContent).toBe('mcp —');
    expect(chip?.getAttribute('title')).toBe(
      'MCP descriptor sent; adapter has not called tools/list. init=3',
    );
    head.dispose();
  });

  it('writes nothing on a metrics tick whose displayed numbers did not move', () => {
    const head = new LaneHead();
    const lane = makeLane();
    head.update(props({ lane, metrics: metrics(12.44, 843.2) }));

    const cpu = head.el.querySelector<HTMLElement>('.acp-harness__lane-metrics-cpu');
    const rss = head.el.querySelector<HTMLElement>('.acp-harness__lane-metrics-rss');
    const activity = head.el.querySelector<HTMLElement>('.acp-harness__lane-activity');
    if (!cpu || !rss || !activity) throw new Error('head did not paint');
    cpu.textContent = 'SENTINEL-CPU';
    rss.textContent = 'SENTINEL-RSS';
    activity.textContent = 'SENTINEL-ACTIVITY';

    // A fresh metrics object whose floats wobbled below the display's
    // resolution — the poll replaces the object every two seconds, so object
    // identity would never hold and the raw floats never settle.
    head.update(props({ lane, metrics: metrics(12.49, 843.4) }));

    expect(cpu.textContent).toBe('SENTINEL-CPU');
    expect(rss.textContent).toBe('SENTINEL-RSS');
    expect(activity.textContent).toBe('SENTINEL-ACTIVITY');
    head.dispose();
  });

  it('repaints only once the rendered metric text changes', () => {
    const head = new LaneHead();
    const lane = makeLane();
    head.update(props({ lane, metrics: metrics(12.44, 843.2) }));
    const chip = head.el.querySelector('.acp-harness__lane-metrics');

    head.update(props({ lane, metrics: metrics(81.0, 843.2) }));
    expect(head.el.querySelector('.acp-harness__lane-metrics-cpu')?.textContent).toBe('81%');
    expect(head.el.querySelector('.acp-harness__lane-metrics')?.className)
      .toBe('acp-harness__lane-metrics acp-harness__lane-metrics--hot');
    // The pill is updated in place, never rebuilt.
    expect(head.el.querySelector('.acp-harness__lane-metrics')).toBe(chip);
    head.dispose();
  });

  it('re-derives the status class string when the lane leaves a status', () => {
    const head = new LaneHead();
    head.update(props({ lane: makeLane({ status: 'busy' }) }));
    const symbol = head.el.querySelector('.acp-harness__lane-symbol');
    expect(symbol?.className).toBe('acp-harness__lane-symbol acp-harness__lane-symbol--busy');
    expect(symbol?.querySelector('.acp-harness__spinner')).not.toBeNull();

    head.update(props({ lane: makeLane({ status: 'idle' }) }));
    expect(symbol?.className).toBe('acp-harness__lane-symbol acp-harness__lane-symbol--idle');
    expect(symbol?.className).not.toContain('busy');
    expect(symbol?.querySelector('.acp-harness__spinner')).toBeNull();
    head.dispose();
  });

  it('keeps chip nodes across updates and removes a chip that fell away', () => {
    const head = new LaneHead();
    head.update(props({ lane: makeLane({ modelName: 'gpt-5-codex' }) }));
    const model = head.el.querySelector('.acp-harness__lane-model');
    expect(model).not.toBeNull();

    head.update(props({ lane: makeLane({ modelName: 'gpt-5-codex', status: 'busy' }) }));
    expect(head.el.querySelector('.acp-harness__lane-model')).toBe(model);

    head.update(props({ lane: makeLane({ modelName: null, status: 'busy' }) }));
    expect(head.el.querySelector('.acp-harness__lane-model')).toBeNull();
    head.dispose();
  });

  it('unregisters its spinner from the shared tick on dispose', () => {
    const head = new LaneHead();
    head.update(props({ lane: makeLane({ status: 'busy' }) }));
    const glyph = head.el.querySelector<HTMLElement>('.acp-harness__spinner');
    head.dispose();

    const parked = glyph?.textContent;
    tickAllSpinners();
    expect(glyph?.textContent).toBe(parked);
  });
});

// Moved from `harness-lane-chrome.test.ts`, where they were asserted against
// `renderLaneHead`'s HTML string.
describe('LaneHead lane-mail inbox chip', () => {
  it('pluralizes the queued-mail tooltip and carries the inbox icon', () => {
    const head = new LaneHead();
    head.update(props({ inboxDepth: 1 }));
    const chip = (): Element | null => head.el.querySelector('.acp-harness__lane-inbox');
    expect(chip()?.getAttribute('title')).toBe('1 pending peer message');
    expect(chip()?.querySelector('use')?.getAttribute('href')).toBe('#krypton-icon-inbox');

    head.update(props({ inboxDepth: 3 }));
    expect(chip()?.getAttribute('title')).toBe('3 pending peer messages');
    expect(chip()?.textContent).toBe('3');
    head.dispose();
  });

  it('omits the chip when nothing is queued', () => {
    const head = new LaneHead();
    head.update(props({ inboxDepth: 0 }));
    expect(head.el.querySelector('.acp-harness__lane-inbox')).toBeNull();
    head.dispose();
  });
});

describe('LaneHead has no cancel hint', () => {
  it('paints no ⌃C cancel or force-restart hint on a busy head', () => {
    const head = new LaneHead();
    for (const lane of [
      makeLane({ status: 'busy' }),
      makeLane({ status: 'busy', cancelUnacked: true } as Partial<HarnessLane>),
    ]) {
      head.update(props({ lane }));
      expect(head.el.querySelector('.acp-harness__lane-cancel-hint')).toBeNull();
      expect(head.el.textContent).not.toContain('⌃C cancel');
      expect(head.el.textContent).not.toContain('force restart');
    }
    head.dispose();
  });
});
