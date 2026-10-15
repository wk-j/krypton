import { describe, expect, it, vi } from 'vitest';

import type { LaneHeatSide, LanePairHeatSummary } from '../../harness-view-types';
import { HeatPanel, type HeatPanelProps } from './index';

function side(over: Partial<LaneHeatSide> = {}): LaneHeatSide {
  return {
    laneId: 'lane-1',
    displayName: 'claude-1',
    score: 62,
    toolDelta: 5,
    tokenDelta: 2_400,
    peerDelta: 1,
    permissionDelta: 0,
    errorDelta: 0,
    cpuPeak: 41.6,
    label: 'busy',
    ...over,
  };
}

function summary(over: Partial<LanePairHeatSummary> = {}): LanePairHeatSummary {
  return {
    metric: 'tools',
    window: '5m',
    active: side(),
    peeked: side({ laneId: 'lane-2', displayName: 'codex-1', score: 24, toolDelta: 2, tokenDelta: null, peerDelta: 0, cpuPeak: null }),
    pairScore: 43,
    dominantSide: 'active',
    unavailableReason: null,
    deltaLine: 'claude-1 leads · +5 tools',
    ...over,
  };
}

function props(over: Partial<HeatPanelProps> = {}): HeatPanelProps {
  return {
    summary: summary(),
    metric: 'tools',
    window: '5m',
    activeName: 'claude-1',
    peekName: 'codex-1',
    activeAccent: '#0cf',
    peekAccent: '#c77dff',
    expanded: false,
    ...over,
  };
}

const text = (panel: HeatPanel, selector: string): string | undefined =>
  panel.el.querySelector(selector)?.textContent ?? undefined;

describe('HeatPanel', () => {
  it('emits the compact strip the peek rail has today', () => {
    const panel = new HeatPanel();
    panel.update(props());

    expect(panel.el.className).toBe('acp-harness__lane-peek-heat-root');
    expect(panel.el.style.getPropertyValue('--acp-peek-heat-active')).toBe('#0cf');
    expect(panel.el.style.getPropertyValue('--acp-peek-heat-peek')).toBe('#c77dff');
    expect(text(panel, '.acp-harness__lane-peek-heat-prefix')).toBe('heat');
    expect(text(panel, '.acp-harness__lane-peek-heat-compact')).toBe(
      'heat' + 'tools' + '·' + '5m' + 'active' + '62' + 'peek' + '24' + 'claude-1 leads · +5 tools',
    );
    const fills = [...panel.el.querySelectorAll<HTMLElement>('.acp-harness__lane-peek-heat-fill')];
    expect(fills.map((fill) => fill.style.width)).toEqual(['62%', '24%']);
    expect(panel.el.querySelector<HTMLElement>('.acp-harness__lane-peek-heat-expanded')?.hidden)
      .toBe(true);
  });

  it('fills the detail table and clamps missing samples to an em dash', () => {
    const panel = new HeatPanel();
    panel.update(props({ expanded: true }));

    const rows = [...panel.el.querySelectorAll('.acp-harness__lane-peek-heat-table tr')]
      .map((row) => [...row.children].map((cell) => cell.textContent));
    expect(rows).toEqual([
      ['', 'active', 'peek'],
      ['tools', '5', '2'],
      ['tokens', '+2.4k', '—'],
      ['peer', '1', '0'],
      ['cpu', '42%', '—'],
    ]);
    expect(panel.el.querySelector<HTMLElement>('.acp-harness__lane-peek-heat-expanded')?.hidden)
      .toBe(false);
  });

  it('attaches its listeners once — 50 updates, one click, one call', () => {
    const onCycleMetric = vi.fn();
    const onCycleWindow = vi.fn();
    const onToggleDetail = vi.fn();
    const panel = new HeatPanel();
    for (let i = 0; i < 50; i++) {
      // A fresh summary object per pass, exactly as the view derives one.
      panel.update(props({
        summary: summary({ active: side({ score: i }) }),
        onCycleMetric,
        onCycleWindow,
        onToggleDetail,
      }));
    }

    const buttons = [...panel.el.querySelectorAll<HTMLElement>('.acp-harness__lane-peek-heat-cmd')];
    buttons[0].dispatchEvent(new MouseEvent('click', { bubbles: true }));
    expect(onCycleMetric).toHaveBeenCalledTimes(1);
    expect(onToggleDetail).not.toHaveBeenCalled();

    buttons[1].dispatchEvent(new MouseEvent('click', { bubbles: true }));
    expect(onCycleWindow).toHaveBeenCalledTimes(1);
    expect(onToggleDetail).not.toHaveBeenCalled();

    panel.el
      .querySelector<HTMLElement>('.acp-harness__lane-peek-heat-compact')
      ?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    expect(onToggleDetail).toHaveBeenCalledTimes(1);
  });

  it('retargets the single listener instead of depending on the callback', () => {
    const first = vi.fn();
    const second = vi.fn();
    const panel = new HeatPanel();
    const same = summary();
    panel.update(props({ summary: same, onCycleMetric: first }));
    panel.update(props({ summary: same, onCycleMetric: second }));

    panel.el
      .querySelector<HTMLElement>('.acp-harness__lane-peek-heat-cmd')
      ?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    expect(first).not.toHaveBeenCalled();
    expect(second).toHaveBeenCalledTimes(1);
  });

  it('detaches on dispose', () => {
    const onCycleMetric = vi.fn();
    const panel = new HeatPanel();
    panel.update(props({ onCycleMetric }));
    const button = panel.el.querySelector<HTMLElement>('.acp-harness__lane-peek-heat-cmd');

    panel.dispose();
    button?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    expect(onCycleMetric).not.toHaveBeenCalled();
  });

  it('empties the mount point when the pair has no heat, and refills it', () => {
    const panel = new HeatPanel();
    panel.update(props());
    expect(panel.el.children.length).toBe(1);

    panel.update(null);
    expect(panel.el.children.length).toBe(0);
    expect(panel.el.style.getPropertyValue('--acp-peek-heat-active')).toBe('');

    panel.update(props());
    expect(panel.el.children.length).toBe(1);
    expect(text(panel, '.acp-harness__lane-peek-heat-delta')).toBe('claude-1 leads · +5 tools');
  });

  it('carries the unavailable reason as a title and drops it when heat returns', () => {
    const panel = new HeatPanel();
    panel.update(props({ summary: summary({ unavailableReason: 'no token samples yet' }) }));
    expect(panel.el.querySelector('.acp-harness__lane-peek-heat')?.getAttribute('title'))
      .toBe('no token samples yet');

    panel.update(props());
    expect(panel.el.querySelector('.acp-harness__lane-peek-heat')?.hasAttribute('title'))
      .toBe(false);
  });

  it('writes nothing while the derived values hold', () => {
    const panel = new HeatPanel();
    const same = summary();
    panel.update(props({ summary: same }));

    let mutations = 0;
    const observer = new MutationObserver((records) => {
      mutations += records.length;
    });
    observer.observe(panel.el, { subtree: true, childList: true, attributes: true, characterData: true });
    // A FRESH props object with the same numbers: the tuple is value-level.
    panel.update(props({ summary: summary() }));
    mutations += observer.takeRecords().length;
    observer.disconnect();

    expect(mutations).toBe(0);
  });
});
