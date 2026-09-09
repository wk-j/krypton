import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import {
  capLaneMarks,
  laneDropCap,
  laneStripKey,
  laneStripLabel,
  LANE_STRIP_MAX,
  type HarnessLaneMark,
} from './window-footer-lanes';

function lane(id: string, over: Partial<HarnessLaneMark> = {}): HarnessLaneMark {
  return {
    id,
    displayName: id,
    backendId: 'claude',
    accent: '#0cf',
    active: false,
    ...over,
  };
}

describe('capLaneMarks', () => {
  it('keeps harness lane order and reports no overflow under the cap', () => {
    const lanes = [lane('Claude-1', { active: true }), lane('Grok-1', { backendId: 'grok' })];
    const { marks, overflow } = capLaneMarks(lanes);
    expect(marks.map((m) => m.id)).toEqual(['Claude-1', 'Grok-1']);
    expect(overflow).toBe(0);
  });

  it('caps at the icon budget and reports the dropped count', () => {
    const lanes = Array.from({ length: LANE_STRIP_MAX + 3 }, (_, i) => lane(`L${i}`));
    const { marks, overflow } = capLaneMarks(lanes);
    expect(marks).toHaveLength(LANE_STRIP_MAX);
    expect(overflow).toBe(3);
  });

  it('honours an explicit cap and tolerates a zero one', () => {
    const lanes = [lane('a'), lane('b'), lane('c')];
    expect(capLaneMarks(lanes, 2)).toEqual({ marks: [lanes[0], lanes[1]], overflow: 1 });
    expect(capLaneMarks(lanes, 0)).toEqual({ marks: [], overflow: 3 });
  });

  it('returns an empty strip for an empty roster', () => {
    expect(capLaneMarks([])).toEqual({ marks: [], overflow: 0 });
  });
});

describe('laneStripKey', () => {
  it('is stable across equal rosters', () => {
    const a = [lane('Claude-1', { active: true }), lane('Grok-1')];
    const b = [lane('Claude-1', { active: true }), lane('Grok-1')];
    expect(laneStripKey(a, 0)).toBe(laneStripKey(b, 0));
  });

  it('changes when the active lane moves', () => {
    const before = [lane('Claude-1', { active: true }), lane('Grok-1')];
    const after = [lane('Claude-1'), lane('Grok-1', { active: true })];
    expect(laneStripKey(before, 0)).not.toBe(laneStripKey(after, 0));
  });

  it('changes when a lane is renamed, re-backed, recoloured, or overflows', () => {
    const base = [lane('Claude-1')];
    expect(laneStripKey([lane('Claude-1', { displayName: 'Renamed' })], 0)).not.toBe(
      laneStripKey(base, 0),
    );
    expect(laneStripKey([lane('Claude-1', { backendId: 'codex' })], 0)).not.toBe(
      laneStripKey(base, 0),
    );
    expect(laneStripKey([lane('Claude-1', { accent: '#f0c' })], 0)).not.toBe(
      laneStripKey(base, 0),
    );
    expect(laneStripKey(base, 1)).not.toBe(laneStripKey(base, 0));
  });
});

describe('laneStripLabel', () => {
  it('names every lane and marks the active one', () => {
    const marks = [lane('Claude-1', { active: true }), lane('Grok-1')];
    expect(laneStripLabel(marks, 0)).toBe('harness lanes: Claude-1 (active), Grok-1');
  });

  it('appends the overflow tail', () => {
    expect(laneStripLabel([lane('Claude-1')], 2)).toBe('harness lanes: Claude-1, 2 more');
  });

  it('reports an empty roster', () => {
    expect(laneStripLabel([], 0)).toBe('no harness lanes');
  });
});

describe('laneDropCap', () => {
  it('splits a display name into a two-letter head and the rail-sized tail', () => {
    expect(laneDropCap('Grok-1')).toEqual({ initials: 'Gr', rest: 'ok-1' });
    expect(laneDropCap('OpenCode-1')).toEqual({ initials: 'Op', rest: 'enCode-1' });
    expect(laneDropCap('Claude-1')).toEqual({ initials: 'Cl', rest: 'aude-1' });
  });

  it('leaves an empty tail for a name no longer than the head', () => {
    expect(laneDropCap('AB')).toEqual({ initials: 'AB', rest: '' });
    expect(laneDropCap('A')).toEqual({ initials: 'A', rest: '' });
  });

  it('splits by code point, so an astral first character is not cut in half', () => {
    expect(laneDropCap('🚀-1')).toEqual({ initials: '🚀-', rest: '1' });
  });
});

describe('window footer lane drop-cap chrome', () => {
  const here = dirname(fileURLToPath(import.meta.url));
  const compositor = readFileSync(join(here, 'compositor.ts'), 'utf8');
  const css = readFileSync(join(here, 'styles/window.css'), 'utf8');

  it('renders initials and the active tail, never a footer logo', () => {
    expect(compositor).toContain("head.className = 'krypton-window__lane-initials'");
    expect(compositor).toContain("tail.className = 'krypton-window__lane-rest'");
    expect(compositor).toContain('laneDropCap(mark.displayName)');
    expect(compositor).not.toContain('krypton-window__lane-logo');
    expect(compositor).not.toContain('ensureHarnessSymbolDefs');
  });

  it('magnifies only the active lane\'s two-letter head via font-size', () => {
    const head = css.match(/\.krypton-window__lane-initials\s*\{([^}]*)\}/)?.[1] ?? '';
    const activeHead = css.match(
      /\.krypton-window__lane--active \.krypton-window__lane-initials\s*\{([^}]*)\}/,
    );
    expect(head).toMatch(/text-transform:\s*uppercase/);
    expect(activeHead?.[1]).toContain('--krypton-lane-zoom');
    expect(css).not.toContain('.krypton-window__lane-logo');
    expect(css).not.toContain('krypton-lane-dock-pop');
  });

  it('pins the strip to the same type line as the project badge and diff stat', () => {
    const strip = css.match(/\.krypton-window__lane-strip\s*\{([^}]*)\}/)?.[1] ?? '';
    expect(strip).toMatch(/align-items:\s*baseline/);
    expect(strip).toMatch(/align-self:\s*flex-end/);
    expect(strip).toContain('--krypton-lane-chip-height');
  });
});
