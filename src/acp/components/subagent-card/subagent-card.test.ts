import { describe, expect, it } from 'vitest';

import { SubagentCard, subagentStats } from './index';
import type { SubagentEntry, SubagentPayload } from '../../harness-view-types';

function entry(over: Partial<SubagentEntry> = {}): SubagentEntry {
  return {
    id: 'scout-1',
    agent: 'explore',
    status: 'running',
    activity: 'reading src/acp/lane-peek.ts',
    recentTools: [],
    toolCount: null,
    tokens: null,
    durationMs: null,
    task: '',
    output: '',
    hintLabel: null,
    ...over,
  };
}

function payload(agents: SubagentEntry[], over: Partial<SubagentPayload> = {}): SubagentPayload {
  return { source: 'omp', background: false, agents, overflow: 0, ...over };
}

function mount(card: SubagentCard): HTMLElement {
  const host = document.createElement('div');
  host.appendChild(card.el);
  return host;
}

function records(target: Node, run: () => void): MutationRecord[] {
  const observer = new MutationObserver(() => undefined);
  observer.observe(target, { subtree: true, childList: true, attributes: true, characterData: true });
  run();
  const seen = observer.takeRecords();
  observer.disconnect();
  return seen;
}

describe('SubagentCard', () => {
  it('emits the card, one row per agent, and the overflow tail', () => {
    const card = new SubagentCard();
    card.update({
      payload: payload(
        [
          entry({ toolCount: 14, tokens: 8000, durationMs: 42_000 }),
          entry({ id: 'scout-2', agent: 'review', status: 'completed', activity: 'done', toolCount: 9 }),
        ],
        { background: true, overflow: 2 },
      ),
      expanded: [],
    });

    expect(card.el.className).toBe('acp-harness__subagents');
    expect(card.el.getAttribute('data-background')).toBe('1');

    const rows = Array.from(card.el.children);
    expect(rows.map((row) => row.getAttribute('class'))).toEqual([
      'acp-harness__subagent acp-harness__subagent--running',
      'acp-harness__subagent acp-harness__subagent--completed',
      'acp-harness__subagent-more',
    ]);
    expect(rows[0].getAttribute('data-subagent-id')).toBe('scout-1');
    expect(rows[2].textContent).toBe('+2 more');

    const line = rows[0].firstElementChild;
    expect(line?.getAttribute('class')).toBe('acp-harness__subagent-line');
    expect(Array.from(line?.children ?? []).map((node) => [node.className, node.textContent])).toEqual([
      ['acp-harness__subagent-glyph', '\u25cf'],
      ['acp-harness__subagent-name', 'scout-1'],
      ['acp-harness__subagent-agent', 'explore'],
      ['acp-harness__subagent-activity', 'reading src/acp/lane-peek.ts'],
      ['acp-harness__subagent-stats', '14 tools \u00b7 8k tok \u00b7 42s'],
    ]);
  });

  it('paints one glyph per status and the hint cell only when labelled', () => {
    const card = new SubagentCard();
    card.update({
      payload: payload([
        entry({ id: 'a', status: 'pending' }),
        entry({ id: 'b', status: 'running' }),
        entry({ id: 'c', status: 'completed' }),
        entry({ id: 'd', status: 'failed' }),
        entry({ id: 'e', status: 'cancelled', hintLabel: 'q' }),
      ]),
      expanded: [],
    });

    const glyphs = Array.from(card.el.querySelectorAll('.acp-harness__subagent-glyph'));
    expect(glyphs.map((node) => node.textContent)).toEqual(['\u25cb', '\u25cf', '\u2713', '\u2717', '\u2013']);
    expect(card.el.children[4].className).toBe(
      'acp-harness__subagent acp-harness__subagent--cancelled acp-harness__subagent--hinted',
    );
    expect(card.el.children[4].firstElementChild?.firstElementChild?.className).toBe(
      'acp-harness__subagent-hint',
    );
  });

  it('shows the recent-tool trail only while the agent can still add to it', () => {
    const card = new SubagentCard();
    const running = entry({ recentTools: ['Grep', 'Read', 'Read'] });
    card.update({ payload: payload([running]), expanded: [] });
    expect(card.el.querySelector('.acp-harness__subagent-tools')?.textContent).toBe(
      '\u21b3 Grep \u00b7 Read \u00b7 Read',
    );

    card.update({
      payload: payload([entry({ recentTools: ['Grep', 'Read', 'Read'], status: 'completed' })]),
      expanded: [],
    });
    expect(card.el.querySelector('.acp-harness__subagent-tools')).toBeNull();
  });

  it('opens the detail for an expanded id and keeps the empty case honest', () => {
    const card = new SubagentCard();
    const agents = [entry({ task: 'map the kernel', output: 'done' }), entry({ id: 'scout-2' })];
    card.update({ payload: payload(agents), expanded: ['scout-1'] });

    const detail = card.el.children[0].querySelector('.acp-harness__subagent-detail');
    expect(Array.from(detail?.children ?? []).map((node) => [node.className, node.textContent])).toEqual([
      ['acp-harness__subagent-detail-label', 'TASK'],
      ['acp-harness__subagent-detail-text', 'map the kernel'],
      ['acp-harness__subagent-detail-label', 'OUTPUT'],
      ['acp-harness__subagent-detail-text', 'done'],
    ]);
    expect(card.el.children[1].querySelector('.acp-harness__subagent-detail')).toBeNull();

    card.update({ payload: payload(agents), expanded: ['scout-1', 'scout-2'] });
    expect(card.el.children[1].querySelector('.acp-harness__subagent-detail')?.textContent).toBe(
      'no task or output yet',
    );
  });

  it('updates one agent without touching its siblings', () => {
    const card = new SubagentCard();
    const host = mount(card);
    const a = entry({ id: 'scout-1' });
    const b = entry({ id: 'scout-2', activity: 'reviewing' });
    card.update({ payload: payload([a, b]), expanded: [] });

    const rowA = card.el.children[0];
    const rowB = card.el.children[1];
    a.activity = 'reading src/ui/list.ts';

    const seen = records(host, () => card.update({ payload: payload([a, b]), expanded: [] }));

    expect(card.el.children[0]).toBe(rowA);
    expect(card.el.children[1]).toBe(rowB);
    expect(seen.length).toBeGreaterThan(0);
    for (const record of seen) expect(rowA.contains(record.target)).toBe(true);
    expect(rowA.querySelector('.acp-harness__subagent-activity')?.textContent).toBe(
      'reading src/ui/list.ts',
    );
  });

  it('writes nothing when no agent moved', () => {
    const card = new SubagentCard();
    const host = mount(card);
    const agents = [entry(), entry({ id: 'scout-2' })];
    const props = { payload: payload(agents), expanded: [] as readonly string[] };
    card.update(props);

    expect(records(host, () => card.update({ payload: props.payload, expanded: [] })).length).toBe(0);
  });

  it('takes in-place payload mutations through appendChunk while live', () => {
    const card = new SubagentCard();
    const host = mount(card);
    // The Claude card mutates its entries in place (`absorbChildToolCall`), so
    // the payload reference never changes and only the live pass can see it.
    const agent = entry({ id: 'agent', activity: 'spawning' });
    const live = payload([agent]);
    card.update({ payload: live, expanded: [] });

    agent.activity = 'reading src/ui/component.ts';
    agent.toolCount = 3;
    card.update({ payload: live, expanded: [] });

    expect(card.el.querySelector('.acp-harness__subagent-activity')?.textContent).toBe(
      'reading src/ui/component.ts',
    );
    expect(card.el.querySelector('.acp-harness__subagent-stats')?.textContent).toBe('3 tools');

    agent.status = 'completed';
    agent.durationMs = 31_000;
    card.seal({ payload: live, expanded: [] });

    expect(card.isLive).toBe(false);
    expect(card.el.children[0].className).toBe('acp-harness__subagent acp-harness__subagent--completed');
    expect(card.el.querySelector('.acp-harness__subagent-stats')?.textContent).toBe('3 tools \u00b7 31s');

    agent.activity = 'ignored after seal';
    expect(records(host, () => card.update({ payload: live, expanded: [] })).length).toBe(0);
  });

  it('drops a row that fell out of the payload', () => {
    const card = new SubagentCard();
    const agents = [entry(), entry({ id: 'scout-2' })];
    card.update({ payload: payload(agents), expanded: [] });
    card.update({ payload: payload([agents[1]]), expanded: [] });

    expect(Array.from(card.el.children).map((row) => row.getAttribute('data-subagent-id'))).toEqual([
      'scout-2',
    ]);
  });
});

describe('subagentStats', () => {
  it('keeps the thousands rounding and drops empty parts', () => {
    expect(subagentStats(entry({ toolCount: 0, tokens: 999, durationMs: 0 }))).toBe('0 tools \u00b7 999 tok');
    expect(subagentStats(entry({ toolCount: null, tokens: 1500, durationMs: null }))).toBe('2k tok');
    expect(subagentStats(entry())).toBe('');
  });
});
