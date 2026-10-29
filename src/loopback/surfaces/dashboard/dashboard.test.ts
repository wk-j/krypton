import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { TELEMETRY_SCHEMA_VERSION } from '../../../acp/harness-telemetry-schema';
import type { TelemetryLane, TelemetrySnapshot } from '../../../acp/harness-telemetry-schema';
import { DashboardView, readTelemetry } from './index';

const NOW = new Date('2026-10-29T10:00:00Z').getTime();

function lane(over: Partial<TelemetryLane> & Pick<TelemetryLane, 'id' | 'displayName'>): TelemetryLane {
  return {
    backendId: 'claude',
    modelName: null,
    status: 'idle',
    turnActiveSince: null,
    observedTurns: 0,
    inboxDepth: 0,
    attnOpen: 0,
    reviews: 0,
    highPriority: 0,
    cpuPercent: null,
    rssMb: null,
    procCount: 0,
    rootAlive: false,
    reviewLoop: null,
    ...over,
  };
}

function snapshot(over: Partial<TelemetrySnapshot> & Pick<TelemetrySnapshot, 'harnessId'>): TelemetrySnapshot {
  return {
    schemaVersion: TELEMETRY_SCHEMA_VERSION,
    version: 1,
    projectDir: '/work/krypton',
    generatedAt: NOW,
    attention: { openCount: 0, maxReversibility: null, items: [] },
    reviewTotal: 0,
    highPriorityTotal: 0,
    lanes: [],
    foreignPeers: [],
    recentEvents: [],
    ...over,
  };
}

const busyLane = lane({
  id: 'lane-1',
  displayName: 'Claude-1',
  modelName: 'opus',
  status: 'busy',
  turnActiveSince: NOW - 42_000,
  observedTurns: 5,
  attnOpen: 1,
  reviews: 2,
  cpuPercent: 63,
  rssMb: 1536,
  procCount: 3,
  rootAlive: true,
  reviewLoop: {
    running: true,
    phase: 'reviewing',
    round: 2,
    maxRounds: 3,
    subjectLabel: '3 files · +40 −2',
    startedAt: NOW - 600_000,
    phaseSince: NOW - 30_000,
    reviewers: [
      { name: 'Codex-2', state: 'replied', verdict: 'fail', blockers: 2, repliedAt: NOW - 10_000 },
      { name: 'OpenCode-1', state: 'pending', verdict: null, blockers: 0, repliedAt: null },
    ],
    rounds: [{ round: 1, verdict: 'fail', blockers: 3, warnings: 1 }],
    stopReason: null,
    stopLabel: null,
    endedAt: null,
  },
});

const idleLane = lane({ id: 'lane-2', displayName: 'Codex-2', backendId: 'codex', observedTurns: 2 });

const harnessA = snapshot({
  harnessId: 'hm-1',
  attention: {
    openCount: 1,
    maxReversibility: 'irreversible',
    items: [
      {
        id: 'j1',
        laneId: 'lane-1',
        laneName: 'Claude-1',
        createdAt: NOW - 60_000,
        question: 'Drop the legacy migration table?',
        chosen: 'keep it',
        rationale: 'rollback still reads it',
        tradedOff: ['disk space'],
        uncertainty: 'medium',
        reversibility: 'irreversible',
      },
    ],
  },
  lanes: [busyLane, idleLane],
  recentEvents: [{ at: NOW - 5_000, laneName: 'Claude-1', kind: 'status', detail: 'idle->busy' }],
});

const harnessB = snapshot({
  harnessId: 'hm-2',
  projectDir: null,
  lanes: [lane({ id: 'lane-9', displayName: 'Gemini-1', backendId: 'gemini', status: 'stopped' })],
});

function stubFetch(body: () => unknown): void {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => new Response(JSON.stringify(body()), { status: 200, headers: { 'content-type': 'application/json' } })),
  );
}

function text(root: ParentNode, selector: string): string {
  return root.querySelector(selector)?.textContent ?? '';
}

describe('DashboardView', () => {
  let view: DashboardView | null = null;

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    vi.setSystemTime(NOW);
  });
  afterEach(() => {
    view?.dispose();
    view = null;
    document.body.replaceChildren();
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it('renders each harness with lane cards, pills, the flag and the review loop', async () => {
    stubFetch(() => ({ harnesses: [harnessA, harnessB] }));
    view = new DashboardView();
    document.body.append(view.el);
    await view.refresh();
    const root = view.el;

    const sections = root.querySelectorAll<HTMLElement>('.lb-dashboard__harness');
    expect([...sections].map((s) => s.dataset.harnessId)).toEqual(['hm-1', 'hm-2']);
    expect(root.querySelector('.lb-dashboard__head .lb-dot--live')).not.toBeNull();
    expect(text(root, '.lb-dashboard__session')).toBe('live');
    expect(text(root, '.lb-banner')).toBe('live telemetry');
    const stats = [...root.querySelectorAll('.lb-stat')].map((s) => s.textContent);
    expect(stats).toEqual(['00:00:00uptime', '2harnesses', '3lanes', '7observed turns']);

    const [a, b] = sections;
    expect(text(a, '.lb-dashboard__triage')).toBe('1 busy · 1 flags');
    expect(text(b, '.lb-dashboard__triage')).toBe('all clear');
    expect(text(b, '.lb-dashboard__meta')).toBe('no project');
    expect(text(a, '.lb-dashboard__gauge-value')).toBe('1');

    const busy = a.querySelector<HTMLElement>('[data-lane-id="lane-1"]');
    expect(busy?.classList.contains('lb-card')).toBe(true);
    expect(text(busy!, '.lb-dashboard__lane-agent')).toBe('claude · opus');
    const busyPill = busy?.querySelector('.lb-pill');
    expect(busyPill?.textContent).toBe('busy');
    expect(busyPill?.classList.contains('lb-pill--add')).toBe(true);
    expect(text(busy!, '.lb-dashboard__turn')).toBe('turn active 42s');
    expect(text(busy!, '.lb-dashboard__value--accent')).toBe('63%');
    expect(text(busy!, '.lb-dashboard__mem .lb-dashboard__value')).toBe('1.5 GB');
    expect([...busy!.querySelectorAll('.lb-chip')].map((c) => c.textContent)).toEqual(['attn 1', 'rev 2', 'pri 0', 'peer 0']);
    expect(busy?.querySelector('.lb-chip--alert')?.textContent).toBe('attn 1');

    const loop = busy?.querySelector<HTMLElement>('.lb-dashboard__loop');
    expect(loop?.hidden).toBe(false);
    expect(text(loop!, '.lb-dashboard__loop-state')).toBe('2/3');
    expect(text(loop!, '.lb-dashboard__loop-phase')).toBe('reviewing · 30s');
    const cells = loop!.querySelectorAll('.lb-dashboard__round');
    expect(cells).toHaveLength(3);
    expect(cells[0].className).toContain('lb-dashboard__round--fail');
    expect(cells[0].textContent).toBe('3');
    expect(cells[1].className).toContain('lb-dashboard__round--current');
    const reviewers = [...loop!.querySelectorAll('.lb-dashboard__reviewer')].map((r) => r.textContent);
    expect(reviewers).toEqual(['Codex-2replied 10s agoFAIL 2', 'OpenCode-1pending 30s']);
    expect(text(loop!, '.lb-dashboard__loop-note')).toBe('3 files · +40 −2');

    const idle = a.querySelector<HTMLElement>('[data-lane-id="lane-2"]');
    expect(idle?.querySelector('.lb-pill')?.textContent).toBe('idle');
    expect(idle?.querySelector('.lb-pill')?.classList.contains('lb-pill--muted')).toBe(true);
    expect(text(idle!, '.lb-dashboard__turn')).toBe('');
    expect(text(idle!, '.lb-dashboard__value')).toBe('—');
    expect(idle?.querySelector<HTMLElement>('.lb-dashboard__loop')?.hidden).toBe(true);

    expect(b.querySelector('[data-lane-id="lane-9"] .lb-pill')?.textContent).toBe('stopped');

    const flag = a.querySelector('.lb-dashboard__flag');
    expect(text(flag!, '.lb-dashboard__flag-lane')).toBe('Claude-1');
    expect(text(flag!, '.lb-dashboard__flag-question')).toBe('Drop the legacy migration table?');
    expect(text(flag!, '.lb-dashboard__flag-tier')).toBe('irreversible · 1m ago');
    expect(flag?.querySelector('.lb-dashboard__flag-tier--irreversible')).not.toBeNull();
    const meta = [...flag!.querySelectorAll('.lb-dashboard__flag-meta > span')].map((s) => s.textContent);
    expect(meta).toEqual(['because rollback still reads it', 'chosen keep it', 'uncertainty medium', 'tradeoff disk space']);
    expect(text(b, '.lb-dashboard__flags')).toBe('no open attention flags');

    expect(text(a, '.lb-dashboard__event-text')).toBe('status → busy');
    expect(text(b, '.lb-dashboard__event-text')).toBe('waiting for events');
  });

  it('repaints in place, drops a closed lane and a gone harness', async () => {
    let body: unknown = { harnesses: [harnessA, harnessB] };
    stubFetch(() => body);
    view = new DashboardView();
    document.body.append(view.el);
    await view.refresh();
    const card = view.el.querySelector('[data-lane-id="lane-1"]');

    body = {
      harnesses: [{ ...harnessA, version: 2, lanes: [{ ...busyLane, status: 'needs_permission', reviewLoop: null }] }],
    };
    await vi.advanceTimersByTimeAsync(1000);

    expect(view.el.querySelector('[data-lane-id="lane-1"]')).toBe(card);
    expect(text(card!, '.lb-pill')).toBe('needs permission');
    expect(card?.querySelector('.lb-pill--accent')).not.toBeNull();
    expect(card?.querySelector<HTMLElement>('.lb-dashboard__loop')?.hidden).toBe(true);
    expect(view.el.querySelector('[data-lane-id="lane-2"]')).toBeNull();
    expect(view.el.querySelectorAll('.lb-dashboard__harness')).toHaveLength(1);
  });

  it('drops a snapshot on another schema version and asks for a refresh', async () => {
    stubFetch(() => ({ harnesses: [{ ...harnessA, schemaVersion: TELEMETRY_SCHEMA_VERSION + 1 }] }));
    view = new DashboardView();
    document.body.append(view.el);
    await view.refresh();

    expect(view.el.querySelectorAll('.lb-dashboard__harness')).toHaveLength(0);
    expect(text(view.el, '.lb-banner')).toBe('refresh the dashboard (schema mismatch)');
    expect(text(view.el, '.lb-dashboard__session')).toBe('schema mismatch');
    expect(view.el.querySelector('.lb-dashboard__head .lb-dot--live')).toBeNull();
  });

  it('says connecting before the first answer and reconnecting after one', async () => {
    let fail = true;
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => (fail ? new Response('down', { status: 503 }) : new Response(JSON.stringify({ harnesses: [] })))),
    );
    view = new DashboardView();
    document.body.append(view.el);
    await view.refresh();
    expect(text(view.el, '.lb-banner')).toBe('connecting...');

    fail = false;
    await vi.advanceTimersByTimeAsync(1000);
    expect(text(view.el, '.lb-banner')).toBe('no active harness yet');

    fail = true;
    await vi.advanceTimersByTimeAsync(1000);
    expect(text(view.el, '.lb-banner')).toBe('reconnecting...');
  });
});

describe('readTelemetry', () => {
  it('keeps only snapshots on the current schema', () => {
    const stale = { ...harnessB, schemaVersion: TELEMETRY_SCHEMA_VERSION - 1 };
    expect(readTelemetry({ harnesses: [harnessA, stale] })).toEqual({ snapshots: [harnessA], mismatch: false });
    expect(readTelemetry({ harnesses: [stale] })).toEqual({ snapshots: [], mismatch: true });
    expect(readTelemetry({ harnesses: [] })).toEqual({ snapshots: [], mismatch: false });
    expect(readTelemetry(null)).toEqual({ snapshots: [], mismatch: false });
  });
});
