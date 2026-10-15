import { describe, expect, it } from 'vitest';

import type { LanePeekCandidate, LanePeekSnapshot } from '../../harness-view-types';
import { PeekCard, type PeekCardProps } from './index';

const NOW = 1_700_000_000_000;

function candidate(over: Partial<LanePeekCandidate> = {}): LanePeekCandidate {
  return {
    laneId: 'lane-1',
    displayName: 'codex-1',
    priority: 40,
    direct: false,
    reasonKey: 'recent-activity',
    reasonLabel: 'working',
    summary: { status: 'busy', headline: 'busy', detail: null, payload: null },
    at: NOW - 30_000,
    visualIndex: 0,
    ...over,
  };
}

function snapshot(over: Partial<LanePeekSnapshot> = {}): LanePeekSnapshot {
  return {
    laneId: 'lane-1',
    displayName: 'codex-1',
    status: 'busy',
    active: false,
    stopped: false,
    visualIndex: 0,
    inboxDepth: 0,
    pendingPeers: [],
    latestInterLane: null,
    latestPermission: null,
    latestMeaningful: null,
    error: null,
    ...over,
  };
}

function props(over: Partial<PeekCardProps> = {}): PeekCardProps {
  return { candidate: candidate(), snapshot: snapshot(), locked: false, now: NOW, heat: null, ...over };
}

const rowTexts = (card: PeekCard): string[] =>
  [...card.el.children].map((child) => child.className);

describe('PeekCard', () => {
  it('emits the card chrome the lane peek has today', () => {
    const card = new PeekCard();
    card.update(props({
      candidate: candidate({ reasonKey: 'lane-inbox', reasonLabel: 'inbox' }),
      snapshot: snapshot({
        activeTool: { name: 'Edit', subject: 'lane-peek.ts', startedAt: NOW - 1_000 },
        plan: { done: 4, total: 9, activeText: 'wire composer meta segments' },
        inboxDepth: 2,
        modelName: 'sonnet-4-6',
        activeTurnStartedAt: NOW - 4_000,
      }),
      locked: true,
    }));

    expect(card.el.tagName).toBe('ASIDE');
    expect(card.el.className).toBe('acp-harness__lane-peek');
    expect(card.el.dataset.laneId).toBe('lane-1');
    expect(card.el.dataset.reason).toBe('lane-inbox');
    expect(card.el.dataset.priority).toBe('warn');
    expect(rowTexts(card)).toEqual([
      'acp-harness__lane-peek-head',
      'acp-harness__lane-peek-event',
      'acp-harness__lane-peek-row',
      'acp-harness__lane-peek-row',
      'acp-harness__lane-peek-row',
      'acp-harness__lane-peek-heat-root',
      'acp-harness__lane-peek-foot',
    ]);
    expect(card.el.querySelector('.acp-harness__lane-peek-status')?.textContent)
      .toBe('busy · locked');
    expect(card.el.querySelector('[data-peek-row="tool"]')?.textContent)
      .toBe('toolEdit · lane-peek.ts');
    expect(card.el.querySelector('.acp-harness__lane-peek-plan-count')?.textContent).toBe('4/9');
    expect(card.el.querySelector('.acp-harness__lane-peek-foot')?.textContent).toBe('sonnet-4-6');
  });

  it('keeps every other row node when a tool tick changes the tool row', () => {
    const card = new PeekCard();
    const before = props({
      snapshot: snapshot({
        plan: { done: 1, total: 3, activeText: 'port the peek' },
        inboxDepth: 1,
        activeTool: { name: 'Edit', subject: 'a.ts', startedAt: NOW },
        modelName: 'sonnet-4-6',
      }),
    });
    card.update(before);
    const nodes = [...card.el.children];
    const toolRow = card.el.querySelector('[data-peek-row="tool"]');

    card.update(props({
      snapshot: snapshot({
        plan: { done: 1, total: 3, activeText: 'port the peek' },
        inboxDepth: 1,
        activeTool: { name: 'Bash', subject: 'npm run check', startedAt: NOW },
        modelName: 'sonnet-4-6',
      }),
    }));

    expect([...card.el.children]).toEqual(nodes);
    expect(card.el.querySelector('[data-peek-row="tool"]')).toBe(toolRow);
    expect(toolRow?.textContent).toBe('toolBash · npm run check');
  });

  it('drops the event row once it says the same thing as the tool row', () => {
    const card = new PeekCard();
    const withTool = snapshot({ activeTool: { name: 'Edit', subject: null, startedAt: NOW } });
    card.update(props({ snapshot: snapshot() }));
    expect(card.el.querySelector('.acp-harness__lane-peek-event')).not.toBeNull();

    card.update(props({ snapshot: withTool }));
    expect(card.el.querySelector('.acp-harness__lane-peek-event')).toBeNull();
    expect(card.el.querySelector('[data-peek-row="tool"]')).not.toBeNull();
  });

  it('re-derives data-priority when the peek stops being an error', () => {
    const card = new PeekCard();
    const failing = candidate({
      reasonKey: 'lane-error',
      summary: {
        status: 'error',
        headline: 'error',
        detail: null,
        payload: { kind: 'error', message: 'rate_limited · 429' },
      },
    });
    card.update(props({ candidate: failing, snapshot: snapshot({ status: 'error' }) }));
    expect(card.el.dataset.priority).toBe('high');

    card.update(props({
      candidate: candidate({
        reasonKey: 'recent-activity',
        summary: { status: 'idle', headline: 'idle', detail: null, payload: null },
      }),
      snapshot: snapshot({ status: 'idle' }),
    }));
    expect(card.el.dataset.priority).toBe('info');
  });

  it('swaps the tool row for the `last` row when the turn stops being busy', () => {
    const card = new PeekCard();
    card.update(props({
      snapshot: snapshot({ activeTool: { name: 'Edit', subject: 'x.ts', startedAt: NOW } }),
    }));
    expect(card.el.querySelector('[data-peek-row="tool"]')).not.toBeNull();

    card.update(props({
      candidate: candidate({ summary: { status: 'idle', headline: 'idle', detail: null, payload: null } }),
      snapshot: snapshot({
        status: 'idle',
        latestMeaningful: { kind: 'assistant', label: 'ported the peek card', at: NOW - 2_000 },
      }),
    }));
    expect(card.el.querySelector('[data-peek-row="tool"]')).toBeNull();
    expect(card.el.querySelector('.acp-harness__lane-peek-row')?.textContent)
      .toBe('lastported the peek card');
  });

  it('writes nothing when the same props object comes back', () => {
    const card = new PeekCard();
    const same = props({ snapshot: snapshot({ modelName: 'gpt-5-codex' }) });
    card.update(same);

    let mutations = 0;
    const observer = new MutationObserver((records) => {
      mutations += records.length;
    });
    observer.observe(card.el, { subtree: true, childList: true, attributes: true, characterData: true });
    card.update(same);
    mutations += observer.takeRecords().length;
    observer.disconnect();

    expect(mutations).toBe(0);
  });

  it('renders no footer when the snapshot carries no stats at all', () => {
    const card = new PeekCard();
    card.update(props());
    expect(card.el.querySelector('.acp-harness__lane-peek-foot')).toBeNull();
  });

  it('marks a hot process chip and escapes nothing by hand', () => {
    const card = new PeekCard();
    card.update(props({
      snapshot: snapshot({
        modelName: '<script>alert(1)</script>',
        usage: { used: 128_400, size: 200_000 },
        metrics: { total_cpu_percent: 92.4, total_rss_mb: 1536, proc_count: 3 },
        mcp: { toolsCallCount: 14 },
      } as Partial<LanePeekSnapshot>),
    }));

    const chips = [...card.el.querySelectorAll('.acp-harness__lane-peek-chip')];
    expect(chips.map((chip) => chip.textContent)).toEqual([
      '<script>alert(1)</script>',
      '128.4k/200.0k',
      '92% 1.5G',
      'mcp 14',
    ]);
    expect(card.el.querySelector('script')).toBeNull();
    expect(chips[2].className).toBe('acp-harness__lane-peek-chip acp-harness__lane-peek-chip--hot');
    expect(chips[1].querySelector('b')?.textContent).toBe('128.4k');
  });

  it('tears its children down on dispose', () => {
    const card = new PeekCard();
    card.update(props({ snapshot: snapshot({ modelName: 'sonnet-4-6' }) }));
    expect(card.el.children.length).toBeGreaterThan(0);

    card.dispose();
    expect(card.el.children.length).toBe(0);
  });
});
