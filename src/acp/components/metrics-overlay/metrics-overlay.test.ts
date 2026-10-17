import { afterEach, describe, expect, it } from 'vitest';

import type { AcpLaneMetrics, AcpLaneProcMetric } from '../../../types';
import { MetricsOverlay, type MetricsLane, type MetricsOverlayProps } from './index';

const overlays: MetricsOverlay[] = [];

const proc = (over: Partial<AcpLaneProcMetric> & { pid: number }): AcpLaneProcMetric => ({
  parent_pid: null,
  name: 'node',
  cmd: ['node', '/tmp/server.js'],
  exe: null,
  cpu_percent: 12,
  rss_mb: 256,
  ...over,
});

const metrics = (over: Partial<AcpLaneMetrics> = {}): AcpLaneMetrics => ({
  session: 1,
  root_pid: 100,
  root_alive: true,
  total_cpu_percent: 18,
  total_rss_mb: 512,
  proc_count: 2,
  processes: [
    proc({ pid: 100 }),
    proc({ pid: 101, parent_pid: 100, name: 'rg', cmd: ['rg', 'needle'], cpu_percent: 6, rss_mb: 32 }),
  ],
  ...over,
});

/** spec 305: a lane slot with no background tasks — the default for these tests. */
const lane = (over: Partial<MetricsLane> = {}): MetricsLane => ({
  id: 'lane-1',
  displayName: 'claude-1',
  metrics: metrics(),
  tasks: [],
  now: 1_000,
  ...over,
});

const props = (over: Partial<MetricsOverlayProps> = {}): MetricsOverlayProps => ({
  open: true,
  lanes: [lane()],
  pollMs: 2000,
  ...over,
});

const mount = (over: Partial<MetricsOverlayProps> = {}): MetricsOverlay => {
  const overlay = new MetricsOverlay();
  overlays.push(overlay);
  overlay.update(props(over));
  return overlay;
};

afterEach(() => {
  for (const overlay of overlays.splice(0)) overlay.dispose();
});

describe('MetricsOverlay', () => {
  it('emits the head, one lane section and its totals', () => {
    const overlay = mount();
    expect(overlay.el.className).toBe('acp-harness__metrics-overlay');
    expect(overlay.el.querySelector('.acp-harness__metrics__title')?.textContent)
      .toBe('Lane Resource Usage');
    expect(overlay.el.querySelector('.acp-harness__metrics__sub')?.textContent)
      .toBe('Esc to close · refreshes every 2s');
    expect(overlay.el.querySelector('.acp-harness__metrics-lane-name')?.textContent).toBe('claude-1');
    expect([...overlay.el.querySelectorAll('.acp-harness__metrics-total')].map((t) => t.textContent))
      .toEqual(['CPU 18%', 'MEM 512M', '2 procs']);
  });

  it('renders the process tree with its branch prefixes, adapter role and meters', () => {
    const overlay = mount();
    expect([...overlay.el.querySelectorAll('.acp-harness__metrics-row--header span')]
      .map((s) => s.textContent)).toEqual(['Process', 'PID', 'CPU', 'Mem']);
    const rows = [...overlay.el.querySelectorAll('.acp-harness__metrics-rows > .acp-harness__metrics-row')];
    expect(rows).toHaveLength(2);
    expect(rows[0].className).toBe('acp-harness__metrics-row acp-harness__metrics-row--root');
    expect(rows[0].querySelector('.acp-harness__metrics-role')?.textContent).toBe('adapter');
    expect(rows[0].querySelector('.acp-harness__metrics-detail')?.textContent).toBe('server.js');
    expect(rows[1].querySelector('.acp-harness__metrics-tree')?.textContent).toBe('└─ ');
    expect(rows[1].querySelector('.acp-harness__metrics-role')).toBeNull();
    expect(rows[1].querySelector('.acp-harness__metrics-pid')?.textContent).toBe('101');
    const meters = rows[1].querySelectorAll('.acp-harness__metrics-meter');
    expect(meters[0].className).toBe('acp-harness__metrics-meter acp-harness__metrics-meter--cpu');
    expect(meters[0].querySelector('.acp-harness__metrics-meter-fill')?.getAttribute('style'))
      .toBe('width:6%');
    expect(meters[1].querySelector('.acp-harness__metrics-meter-value')?.textContent).toBe('32M');
  });

  it('shows the dim total and no tree when the root process is gone', () => {
    const overlay = mount({
      lanes: [lane({ metrics: metrics({ root_alive: false, proc_count: 0, processes: [] }) })],
    });
    expect(overlay.el.querySelector('.acp-harness__metrics-total--dim')?.textContent)
      .toBe('no live process');
    expect(overlay.el.querySelector('.acp-harness__metrics-tree-block')).toBeNull();
  });

  it('keeps every process row node when only the samples move', () => {
    const overlay = mount();
    const rows = [...overlay.el.querySelectorAll('.acp-harness__metrics-rows > .acp-harness__metrics-row')];
    overlay.update(props({
      lanes: [
        lane({
          metrics: metrics({
            total_cpu_percent: 44,
            processes: [
              proc({ pid: 100, cpu_percent: 38 }),
              proc({ pid: 101, parent_pid: 100, name: 'rg', cmd: ['rg', 'needle'], cpu_percent: 6, rss_mb: 32 }),
            ],
          }),
        }),
      ],
    }));
    const after = [...overlay.el.querySelectorAll('.acp-harness__metrics-rows > .acp-harness__metrics-row')];
    expect(after).toEqual(rows);
    expect(after[0].querySelector('.acp-harness__metrics-meter--cpu .acp-harness__metrics-meter-fill')
      ?.getAttribute('style')).toBe('width:38%');
  });

  it('drops a lane section when its lane closes', () => {
    const overlay = mount({
      lanes: [
        lane(),
        lane({ id: 'lane-2', displayName: 'codex-1' }),
      ],
    });
    expect(overlay.el.querySelectorAll('.acp-harness__metrics-lane')).toHaveLength(2);
    overlay.update(props({ lanes: [lane({ id: 'lane-2', displayName: 'codex-1' })] }));
    const remaining = [...overlay.el.querySelectorAll('.acp-harness__metrics-lane-name')];
    expect(remaining.map((n) => n.textContent)).toEqual(['codex-1']);
  });

  it('hides while closed', () => {
    const overlay = mount({ open: false });
    expect(overlay.el.hidden).toBe(true);
  });

  it('writes nothing when the samples have not moved', () => {
    const lanes = [lane()];
    const overlay = mount({ lanes });
    const observer = new MutationObserver(() => undefined);
    observer.observe(overlay.el, { childList: true, subtree: true, attributes: true, characterData: true });
    overlay.update(props({ lanes }));
    const records = observer.takeRecords();
    observer.disconnect();
    expect(records).toEqual([]);
  });
});
