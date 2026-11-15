// @vitest-environment happy-dom

import { describe, expect, it } from 'vitest';

import { SessionInfo, sessionContext, sessionInfoProps, type SessionInfoProps } from './index';
import type { HarnessLane } from '../../harness-view-types';
import type { HarnessMcpLaneStats } from '../../types';

const sample: SessionInfoProps = {
  laneName: 'Codex-1',
  sessionId: 'session-123',
  backendName: 'Codex',
  modelName: 'gpt-6.1-sol',
  effortName: 'High',
  status: 'busy',
  contextUsed: 74_600,
  contextSize: 1_000_000,
  mcpEndpointAvailable: true,
  mcpInitializeCount: 1,
  mcpToolsListCount: 1,
  mcpToolsCallCount: 3,
  mcpLastMethod: 'tools/call',
  mcpLastSeenAt: Date.UTC(2026, 10, 15, 6, 0),
  projectName: 'krypton',
  cacheHit: '99%',
  cacheRead: 71_200,
  cacheWrite: 0,
  turnInput: 700,
  inputTokens: 140_300,
  outputTokens: 40_400,
  costAmount: null,
  costCurrency: null,
  toolCalls: 190,
  transcriptRows: 287,
  pendingPermissions: 0,
  pendingQuestions: 0,
  turnFlags: '',
  error: null,
};

describe('Session Info (spec 401)', () => {
  it('calculates context occupancy from valid levels only', () => {
    expect(sessionContext(74_600, 1_000_000)).toEqual({ used: 74_600, size: 1_000_000, percent: 7 });
    expect(sessionContext(0, 100)).toEqual({ used: 0, size: 100, percent: 0 });
    expect(sessionContext(120, 100)).toEqual({ used: 120, size: 100, percent: 100 });
    expect(sessionContext(10, null)).toEqual({ used: 10, size: null, percent: null });
    expect(sessionContext(-1, 100)).toEqual({ used: null, size: 100, percent: null });
    expect(sessionContext(Number.NaN, 100)).toEqual({ used: null, size: 100, percent: null });
    expect(sessionContext(10, 0)).toEqual({ used: 10, size: null, percent: null });
  });

  it('updates the same pane on compaction and lane changes without keeping old values', () => {
    const panel = new SessionInfo();
    panel.update(sample);
    const meter = panel.el.querySelector<HTMLElement>('.acp-session-info__meter')!;
    const fill = panel.el.querySelector<HTMLElement>('.acp-session-info__meter-fill')!;
    const readout = panel.el.querySelector<HTMLElement>('.acp-session-info__readout')!;
    expect(readout.textContent).toContain('7% used');
    expect(fill.style.width).toBe('7%');
    expect(meter.getAttribute('aria-valuetext')).toBe('74,600 of 1,000,000 tokens');
    expect(panel.el.querySelector('.acp-session-info__status')?.textContent).toBe('BUSY');
    expect(panel.el.textContent).toContain('krypton');
    expect(panel.el.textContent).toContain('99%');
    expect(panel.el.textContent).toContain('140.3k');
    expect(panel.el.textContent).toContain('40.4k');
    expect(panel.el.textContent).toContain('190');
    expect(panel.el.textContent).toContain('287');
    expect(panel.el.textContent).toContain('Tools listed on this lane');

    panel.update({ ...sample, contextUsed: 30_000 });
    expect(panel.el.querySelector('.acp-session-info__readout')).toBe(readout);
    expect(readout.textContent).toContain('3% used');
    expect(meter.getAttribute('aria-valuenow')).toBe('30000');

    panel.update({
      ...sample, laneName: 'Claude-2', sessionId: null, modelName: null,
      effortName: null, status: 'starting', contextUsed: null, contextSize: null,
      projectName: null, cacheHit: null, cacheRead: null, cacheWrite: null,
      turnInput: null, inputTokens: null, outputTokens: null, toolCalls: 0,
      transcriptRows: 0, mcpInitializeCount: 0, mcpToolsListCount: 0,
      mcpToolsCallCount: 0, mcpLastMethod: null, mcpLastSeenAt: null,
    });
    expect(panel.el.textContent).toContain('Claude-2');
    expect(panel.el.textContent).toContain('Pending');
    expect(panel.el.textContent).toContain('Context unavailable');
    expect(panel.el.textContent).not.toContain('session-123');
    const facts = Object.fromEntries(
      Array.from(panel.el.querySelectorAll<HTMLElement>('.acp-session-info__fact'), (field) => {
        expect(field.hidden).toBe(false);
        return [field.querySelector('dt')!.textContent, field.querySelector('dd')!.textContent];
      }),
    );
    expect(facts).toEqual({
      Project: '—', Backend: 'Codex', Model: 'Unknown', Effort: 'Unknown',
      'Session ID': 'Pending', Server: 'krypton-harness-memory', Contact: 'No contact observed',
      Initialize: '0', 'Tools/list': '0', 'Tools/call': '0', 'Last method': '—', 'Last contact': '—',
      'Cache hit': '—', 'Turn input': '—', 'Cache read': '—', 'Cache write': '—',
      Input: '—', Output: '—', Cost: '—', 'Tool calls': '0', 'Transcript rows': '0',
      Permissions: '0', Questions: '0', 'Turn flags': '—', Error: '—',
    });
    expect(panel.el.textContent).not.toContain('140.3k');
    expect(panel.el.textContent).toContain('No contact observed');
    expect(panel.el.textContent).not.toContain('tools/call');
    expect(meter.hidden).toBe(true);
  });

  it('shows a partial reading without inventing a percentage', () => {
    const panel = new SessionInfo();
    panel.update({ ...sample, contextSize: null });
    expect(panel.el.querySelector('.acp-session-info__count')?.textContent).toContain('74.6k tokens');
    expect(panel.el.querySelector<HTMLElement>('.acp-session-info__meter')?.hidden).toBe(true);
  });

  it('carries every former lane-stat value into a primitive snapshot', () => {
    const lane = {
      displayName: 'Codex-1', sessionId: 'session-123', backendId: 'codex',
      modelName: 'gpt-6.1-sol', effort: null, status: 'busy',
      usage: {
        used: 71_200, size: 258_400, inputTokens: 140_300, outputTokens: 40_400,
        cost: { amount: 0.4412, currency: 'USD' },
      },
      lastTurnTokens: { input: 700, cachedRead: 69_300, cachedWrite: 100 },
      toolViews: new Map([['one', {}]]), transcript: [{}, {}],
      pendingPermissions: [{}], pendingQuestions: [{}], acceptAllForTurn: true,
      rejectAllForTurn: false, peerAutoAcceptForTurn: false,
      pollyBuiltinRole: null, permissionMode: 'normal', error: 'adapter error',
    } as unknown as HarnessLane;
    const snapshot = sessionInfoProps(lane, '/tmp/krypton', 'Codex', null, true);
    const panel = new SessionInfo();
    panel.update(snapshot);
    expect(snapshot.projectName).toBe('krypton');
    expect(snapshot.cacheHit).not.toBeNull();
    expect(snapshot.cacheRead).toBe(69_300);
    expect(snapshot.cacheWrite).toBe(100);
    expect(snapshot.turnInput).toBe(700);
    expect(panel.el.textContent).toContain('140.3k');
    expect(panel.el.textContent).toContain('40.4k');
    expect(panel.el.textContent).toContain('$0.4412 USD');
    expect(panel.el.textContent).toContain('accept-all');
    expect(panel.el.textContent).toContain('adapter error');
    expect(panel.el.textContent).toContain('Permissions1');
    expect(panel.el.textContent).toContain('Questions1');
  });

  it('describes MCP request evidence without claiming a live connection', () => {
    const panel = new SessionInfo();
    const mcp = (): HTMLElement => panel.el.querySelector<HTMLElement>('section[aria-label="MCP connection"]')!;
    panel.update({ ...sample, mcpInitializeCount: 0, mcpToolsListCount: 0,
      mcpToolsCallCount: 0, mcpLastMethod: null, mcpLastSeenAt: null });
    expect(mcp().textContent).toContain('No contact observed');
    expect(mcp().textContent).toContain('Last contact—');

    panel.update({ ...sample, mcpInitializeCount: 1, mcpToolsListCount: 0,
      mcpToolsCallCount: 0, mcpLastMethod: 'initialize' });
    expect(mcp().textContent).toContain('Initialized; tools not listed');

    panel.update({ ...sample, mcpInitializeCount: 0, mcpToolsListCount: 0,
      mcpToolsCallCount: 0, mcpLastMethod: 'notifications/initialized' });
    expect(mcp().textContent).toContain('Contact observed; tools not listed');

    panel.update(sample);
    expect(mcp().textContent).toContain('Tools listed on this lane');
    expect(mcp().textContent).toContain('tools/call');
    expect(mcp().textContent).toContain(new Date(sample.mcpLastSeenAt!).toLocaleString());
    expect(mcp().textContent).toContain('not a live connection check');

    panel.update({ ...sample, mcpEndpointAvailable: false });
    expect(mcp().textContent).toContain('Not supplied');
    expect(mcp().textContent).toContain('tools/call');
  });

  it('snapshots mutable MCP counters before the next lane update', () => {
    const lane = {
      displayName: 'Codex-1', sessionId: null, backendId: 'codex', modelName: null,
      effort: null, status: 'idle', usage: null, lastTurnTokens: null,
      toolViews: new Map(), transcript: [], pendingPermissions: [], pendingQuestions: [],
      acceptAllForTurn: false, rejectAllForTurn: false, peerAutoAcceptForTurn: false,
      permissionMode: 'normal', error: null,
    } as unknown as HarnessLane;
    const stats: HarnessMcpLaneStats = {
      laneLabel: 'Codex-1', initializeCount: 1, toolsListCount: 0,
      toolsCallCount: 0, lastMethod: 'initialize', lastSeenAt: Date.UTC(2026, 10, 15, 6, 0),
    };
    const first = sessionInfoProps(lane, null, 'Codex', stats, true);
    const panel = new SessionInfo();
    panel.update(first);
    stats.toolsListCount = 1;
    stats.lastMethod = 'tools/list';
    panel.update(sessionInfoProps(lane, null, 'Codex', stats, true));
    expect(first.mcpToolsListCount).toBe(0);
    expect(panel.el.querySelector('section[aria-label="MCP connection"]')?.textContent)
      .toContain('Tools listed on this lane');
  });
});
