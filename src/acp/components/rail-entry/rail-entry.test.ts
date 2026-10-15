import { describe, expect, it } from 'vitest';

import type { HarnessDirective } from '../../../config';
import type { HarnessLane } from '../../harness-view-types';
import type { RailPeerHint } from '../../lane-peek';
import { RailEntry, type RailEntryProps } from './index';

function makeLane(over: Partial<HarnessLane> = {}): HarnessLane {
  return {
    id: 'lane-1',
    backendId: 'claude',
    displayName: 'Claude-1',
    accent: '#0cf',
    status: 'idle',
    usage: null,
    toolCalls: new Map(),
    pendingPermissions: [],
    pendingQuestions: [],
    ...over,
  } as unknown as HarnessLane;
}

const NO_PEERS: RailPeerHint = {
  awaitingSuffix: '',
  inboxSuffix: '',
  trafficSuffix: '',
  title: '',
  kind: 'none',
};

function props(over: Partial<RailEntryProps> = {}): RailEntryProps {
  return {
    lane: makeLane(),
    active: false,
    peerHint: NO_PEERS,
    directive: null,
    reviewCount: 0,
    ...over,
  };
}

function directive(over: Partial<HarnessDirective> = {}): HarnessDirective {
  return {
    id: '0301-impl',
    title: 'Claude harness UI refactor',
    icon: '*',
    description: '',
    task: 'implementation',
    system_prompt: '',
    enabled: true,
    triage_equipped: false,
    ...over,
  };
}

describe('RailEntry', () => {
  it('emits dot · logo · head · meta in order', () => {
    const entry = new RailEntry();
    entry.update(props());

    expect(entry.el.className).toBe('acp-harness__rail-entry acp-harness__rail-entry--idle');
    expect(entry.el.style.getPropertyValue('--acp-lane-accent')).toBe('#0cf');
    expect([...entry.el.children].map((node) => node.className)).toEqual([
      'acp-harness__rail-dot',
      'acp-harness__rail-logo acp-harness__rail-logo--claude',
      'acp-harness__rail-head',
      'acp-harness__rail-meta',
    ]);
    const logo = entry.el.querySelector('.acp-harness__rail-logo');
    expect(logo?.getAttribute('aria-hidden')).toBe('true');
    expect(logo?.querySelector('svg')?.hasAttribute('class')).toBe(false);
    expect(logo?.querySelector('use')?.getAttribute('href')).toBe('#krypton-logo-claude');
    expect(entry.el.querySelector('.acp-harness__rail-name')?.textContent).toBe('Claude-1');
    expect(entry.el.querySelector('.acp-harness__rail-meta__hint')?.textContent).toBe('idle');
    expect(entry.el.title).toBe('idle');
    entry.dispose();
  });

  it('maps pi-acp onto the --pi logo tint and an unknown backend onto --omp', () => {
    const pi = new RailEntry();
    pi.update(props({ lane: makeLane({ backendId: 'pi-acp' }) }));
    expect(pi.el.querySelector('.acp-harness__rail-logo')?.className)
      .toBe('acp-harness__rail-logo acp-harness__rail-logo--pi');

    const unknown = new RailEntry();
    unknown.update(props({ lane: makeLane({ backendId: 'made-up' }) }));
    expect(unknown.el.querySelector('.acp-harness__rail-logo')?.className)
      .toBe('acp-harness__rail-logo acp-harness__rail-logo--omp');
    pi.dispose();
    unknown.dispose();
  });

  it('renders the tool and context metrics with their titles', () => {
    const entry = new RailEntry();
    entry.update(props({
      lane: makeLane({
        toolCalls: new Map([['a', {}], ['b', {}]]) as unknown as HarnessLane['toolCalls'],
        usage: { used: 128_400, size: 200_000 },
      }),
    }));

    const head = entry.el.querySelector('.acp-harness__rail-head');
    expect([...(head?.children ?? [])].map((node) => node.className)).toEqual([
      'acp-harness__rail-name',
      'acp-harness__rail-metric acp-harness__rail-metric--tools',
      'acp-harness__rail-metric acp-harness__rail-metric--ctx',
    ]);
    expect(head?.querySelector('.acp-harness__rail-metric--tools')?.textContent).toBe('2');
    expect(head?.querySelector('.acp-harness__rail-metric--tools')?.getAttribute('title')).toBe('2 tool calls');
    expect(head?.querySelector('.acp-harness__rail-metric--ctx')?.textContent).toBe('128.4k');
    expect(head?.querySelector('.acp-harness__rail-metric--ctx')?.getAttribute('title'))
      .toBe('context 128400/200000 tokens');
    entry.dispose();
  });

  it('wraps the peer glyphs and folds the hint into the entry title', () => {
    const entry = new RailEntry();
    entry.update(props({
      peerHint: {
        awaitingSuffix: '⇆',
        inboxSuffix: '▼2',
        trafficSuffix: '',
        title: 'awaiting Codex-1 · 5m+ · 2 peer messages queued',
        kind: 'awaiting',
      },
    }));

    expect(entry.el.className).toContain('acp-harness__rail-entry--peer-awaiting');
    const peers = entry.el.querySelector('.acp-harness__rail-peers');
    expect([...(peers?.children ?? [])].map((node) => `${node.className}:${node.textContent}`)).toEqual([
      'acp-harness__rail-peer acp-harness__rail-peer--awaiting:⇆',
      'acp-harness__rail-peer acp-harness__rail-peer--inbox:▼2',
    ]);
    expect(entry.el.title).toBe('awaiting Codex-1 · 5m+ · 2 peer messages queued · idle');

    entry.update(props());
    expect(entry.el.querySelector('.acp-harness__rail-peers')).toBeNull();
    expect(entry.el.className).toBe('acp-harness__rail-entry acp-harness__rail-entry--idle');
    entry.dispose();
  });

  it('paints the role tag, the backend-trimmed title and the pending hint', () => {
    const entry = new RailEntry();
    entry.update(props({ directive: { directive: directive(), pending: 'none' } }));

    const meta = entry.el.querySelector('.acp-harness__rail-meta');
    expect([...(meta?.children ?? [])].map((node) => node.className)).toEqual([
      'acp-harness__rail-tag acp-harness__rail-tag--impl',
      'acp-harness__rail-meta__title',
    ]);
    expect(meta?.querySelector('.acp-harness__rail-tag')?.textContent).toBe('impl');
    expect(meta?.querySelector('.acp-harness__rail-meta__title')?.textContent).toBe('harness UI refactor');
    expect(entry.el.className).toContain('acp-harness__rail-entry--directive');
    expect(entry.el.title).toBe('idle · directive 0301-impl');

    entry.update(props({ directive: { directive: directive(), pending: 'swap' } }));
    expect(entry.el.className).toContain('acp-harness__rail-entry--pending');
    expect(entry.el.querySelector('.acp-harness__rail-meta__hint')?.textContent).toBe('· next send');
    expect(entry.el.title).toBe('idle · directive 0301-impl (next send)');

    entry.update(props({ directive: { directive: directive(), pending: 'clear' } }));
    expect(entry.el.querySelector('.acp-harness__rail-tag')?.className)
      .toBe('acp-harness__rail-tag acp-harness__rail-tag--impl acp-harness__rail-tag--clearing');
    expect(entry.el.querySelector('.acp-harness__rail-meta__hint')?.textContent).toBe('· clear next send');
    entry.dispose();
  });

  it('falls back through the directive id when the title trims to nothing', () => {
    const entry = new RailEntry();
    entry.update(props({ directive: { directive: directive({ title: '   ' }), pending: 'none' } }));
    expect(entry.el.querySelector('.acp-harness__rail-meta__title')?.textContent).toBe('0301-impl');
    entry.dispose();
  });

  it('shows the compact permission meta instead of the status word', () => {
    const entry = new RailEntry();
    entry.update(props({
      lane: makeLane({
        status: 'needs_permission',
        pendingQuestions: [{ wire: 'elicitation' }] as unknown as HarnessLane['pendingQuestions'],
      }),
    }));
    expect(entry.el.querySelector('.acp-harness__rail-meta__hint')?.textContent)
      .toBe('ask · 1–9/Enter · x decline');
    expect(entry.el.className).toContain('acp-harness__rail-entry--needs_permission');
    entry.dispose();
  });

  it('appends and removes the review-count badge', () => {
    const entry = new RailEntry();
    entry.update(props({ reviewCount: 3 }));
    const badge = entry.el.lastElementChild;
    expect(badge?.className).toBe('acp-harness__rail-review-count');
    expect(badge?.textContent).toBe('3 reviews');

    entry.update(props({ reviewCount: 0 }));
    expect(entry.el.querySelector('.acp-harness__rail-review-count')).toBeNull();
    entry.dispose();
  });

  it('moves --active between lanes without rebuilding either entry', () => {
    const a = new RailEntry();
    const b = new RailEntry();
    const laneA = makeLane({ id: 'a', displayName: 'Claude-1' });
    const laneB = makeLane({ id: 'b', displayName: 'Codex-1', backendId: 'codex', accent: '#f80' });
    a.update(props({ lane: laneA, active: true }));
    b.update(props({ lane: laneB, active: false }));

    const nodesA = [...a.el.children];
    const nodesB = [...b.el.children];
    const nameA = a.el.querySelector('.acp-harness__rail-name');
    const nameB = b.el.querySelector('.acp-harness__rail-name');

    a.update(props({ lane: laneA, active: false }));
    b.update(props({ lane: laneB, active: true }));

    expect(a.el.className).toBe('acp-harness__rail-entry acp-harness__rail-entry--idle');
    expect(b.el.className).toBe('acp-harness__rail-entry acp-harness__rail-entry--idle acp-harness__rail-entry--active');
    expect([...a.el.children]).toEqual(nodesA);
    expect([...b.el.children]).toEqual(nodesB);
    expect(a.el.querySelector('.acp-harness__rail-name')).toBe(nameA);
    expect(b.el.querySelector('.acp-harness__rail-name')).toBe(nameB);
    a.dispose();
    b.dispose();
  });

  it('writes nothing while its dependency tuple holds', () => {
    const entry = new RailEntry();
    const lane = makeLane({ status: 'busy' });
    entry.update(props({ lane }));
    const hint = entry.el.querySelector<HTMLElement>('.acp-harness__rail-meta__hint');
    if (!hint) throw new Error('entry did not paint');
    hint.textContent = 'SENTINEL';

    entry.update(props({ lane }));
    expect(hint.textContent).toBe('SENTINEL');
    entry.dispose();
  });
});
