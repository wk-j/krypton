import { describe, expect, it } from 'vitest';

import {
  WHEEL_ACTIVE_SCALE,
  WHEEL_ARC_END_INSET,
  WHEEL_ARC_GAP,
  WHEEL_CARD_GAP,
  WHEEL_CARD_HEIGHT,
  WHEEL_CARD_MAX_HEIGHT,
  WHEEL_CARD_MIN_HEIGHT,
  WHEEL_CARD_WIDTH,
  WHEEL_EDGE_FADE,
  WHEEL_IDLE_GAP,
  WHEEL_LABEL_GAP,
  WHEEL_LABEL_MAX_WIDTH,
  WHEEL_LIVE_SLOTS,
  WHEEL_MIN_ARC_X,
  WHEEL_MIN_MAIN_WIDTH,
  WHEEL_SILHOUETTE_ROWS,
  WHEEL_TILT,
  bumpActivity,
  computeWheelFrame,
  decayActivity,
  wheelArcPoint,
  wheelCardHeight,
  wheelEdgeFade,
  wheelFurLevel,
  wheelGeometry,
  wheelIsLiveSlot,
  wheelItemAngle,
  wheelItemKey,
  wheelItemPose,
  wheelLabel,
  wheelLabelHead,
  wheelPreviewTransform,
  wheelRailWidth,
  wheelSchematic,
  wheelTextSilhouette,
  wrapWheelIndex,
  type WheelPose,
  type WheelPaneNode,
} from './wheel-layout';

const GAP = 6;
const FOOTER = 28;

/** Corners of a posed card, in rail coordinates. */
function corners(p: WheelPose): Array<[number, number]> {
  const cos = Math.cos(p.rotate);
  const sin = Math.sin(p.rotate);
  return [[-1, -1], [1, -1], [1, 1], [-1, 1]].map(([sx, sy]) => {
    const dx = (sx * WHEEL_CARD_WIDTH * p.scale) / 2;
    const dy = (sy * WHEEL_CARD_HEIGHT * p.scale) / 2;
    return [p.x + dx * cos - dy * sin, p.y + dx * sin + dy * cos];
  });
}

/** Clearance between `upper` and the card `lower` below it, along `lower`'s own vertical axis. */
function clearance(upper: WheelPose, lower: WheelPose): number {
  const cos = Math.cos(lower.rotate);
  const sin = Math.sin(lower.rotate);
  const deepest = Math.max(...corners(upper).map(([x, y]) => -(x - lower.x) * sin + (y - lower.y) * cos));
  return -(WHEEL_CARD_HEIGHT * lower.scale) / 2 - deepest;
}

describe('wheel frame', () => {
  it('puts the rail on the left and the shared main frame to its right', () => {
    const { rail, main } = computeWheelFrame(1512, 945, GAP, FOOTER);
    expect(rail).toEqual({ x: 0, y: 0, width: 363, height: 945 - FOOTER });
    expect(main.x).toBe(363 + GAP);
    expect(main.y).toBe(GAP);
    expect(main.x + main.width).toBe(1512 - GAP);
    expect(main.y + main.height).toBe(945 - FOOTER - GAP);
  });

  it('clamps the rail width between 280 and 400 px', () => {
    expect(wheelRailWidth(1000)).toBe(280);
    expect(wheelRailWidth(1440)).toBe(346);
    expect(wheelRailWidth(2560)).toBe(400);
  });

  it('hides the rail when the main frame would be narrower than the minimum', () => {
    const narrow = computeWheelFrame(700, 800, GAP, FOOTER);
    expect(narrow.rail).toBeNull();
    expect(narrow.main).toEqual({ x: GAP, y: GAP, width: 700 - GAP * 2, height: 800 - FOOTER - GAP * 2 });

    const edge = computeWheelFrame(280 + GAP * 2 + WHEEL_MIN_MAIN_WIDTH, 800, GAP, FOOTER);
    expect(edge.rail).not.toBeNull();
    expect(edge.main.width).toBe(WHEEL_MIN_MAIN_WIDTH);
  });
});

describe('wheel geometry', () => {
  const activeHalfW = (WHEEL_CARD_WIDTH * WHEEL_ACTIVE_SCALE) / 2;

  it('leaves the tuft margin left of the arc and fits an idle card plus label right of it', () => {
    const geo = wheelGeometry(400, 1061);
    const idleRight = geo.arcX + activeHalfW + WHEEL_ARC_GAP + WHEEL_CARD_WIDTH / 2;
    expect(idleRight + WHEEL_LABEL_GAP + WHEEL_LABEL_MAX_WIDTH).toBeCloseTo(400);
    expect(geo.arcX).toBeGreaterThan(100);
    expect(wheelGeometry(280, 700).arcX).toBe(WHEEL_MIN_ARC_X);
  });

  it('bows the arc from the apex to both inset right-hand corners of the rail', () => {
    for (const [w, h] of [[400, 1061], [363, 917], [280, 700]]) {
      const geo = wheelGeometry(w, h);
      const [tx, ty] = wheelArcPoint(-geo.arcExtent, geo.radius, geo);
      const [bx, by] = wheelArcPoint(geo.arcExtent, geo.radius, geo);
      expect(tx).toBeCloseTo(w - WHEEL_ARC_END_INSET);
      expect(ty).toBeCloseTo(0);
      expect(bx).toBeCloseTo(w - WHEEL_ARC_END_INSET);
      expect(by).toBeCloseTo(h);
      expect(wheelArcPoint(0, geo.radius, geo)).toEqual([geo.arcX, h / 2]);
    }
  });

  it('keeps every neighbouring pair of cards apart', () => {
    for (const [w, h] of [[400, 1061], [363, 917], [280, 700], [400, 600]]) {
      const geo = wheelGeometry(w, h);
      const poses = [-3, -2, -1, 0, 1, 2, 3].map((i) => wheelItemPose(i, 0, geo));
      expect(clearance(poses[2], poses[3])).toBeGreaterThanOrEqual(WHEEL_CARD_GAP - 0.5);
      expect(clearance(poses[3], poses[4])).toBeGreaterThanOrEqual(WHEEL_CARD_GAP - 0.5);
      for (const [a, b] of [[0, 1], [1, 2], [4, 5], [5, 6]]) {
        if (poses[a].hidden || poses[b].hidden) continue;
        expect(clearance(poses[a], poses[b])).toBeGreaterThan(0);
      }
    }
    const roomy = wheelGeometry(400, 1061);
    const idle = [1, 2].map((i) => wheelItemPose(i, 0, roomy));
    expect(clearance(idle[0], idle[1])).toBeGreaterThanOrEqual(WHEEL_IDLE_GAP - 1.5);
  });
});

describe('wheel poses', () => {
  const railH = 900;
  const geo = wheelGeometry(400, railH);

  it('places the item at pos at the apex, scaled up and upright', () => {
    const pose = wheelItemPose(3, 3, geo);
    expect(pose.x).toBeCloseTo(geo.arcX + (WHEEL_CARD_WIDTH * WHEEL_ACTIVE_SCALE) / 2 + WHEEL_ARC_GAP);
    expect(pose.y).toBeCloseTo(railH / 2);
    expect(pose.rotate).toBeCloseTo(0);
    expect(pose.scale).toBe(WHEEL_ACTIVE_SCALE);
    expect(pose.opacity).toBe(1);
    expect(pose.hidden).toBe(false);
  });

  it('leans neighbours by half their arc angle, spaced evenly around the active card', () => {
    const below = wheelItemPose(4, 3, geo);
    const above = wheelItemPose(2, 3, geo);
    expect(above.y).toBeLessThan(railH / 2);
    expect(below.y - railH / 2).toBeCloseTo(railH / 2 - above.y);
    expect(above.rotate).toBeCloseTo(geo.step * WHEEL_TILT);
    expect(below.rotate).toBeCloseTo(-wheelItemAngle(1, geo) * WHEEL_TILT);
    expect(below.scale).toBe(1);
    expect(below.opacity).toBeLessThan(1);
  });

  it('eases scale and spacing continuously as the wheel turns', () => {
    expect(wheelItemPose(3, 3.5, geo).scale).toBeCloseTo(1 + (WHEEL_ACTIVE_SCALE - 1) / 2);
    expect(wheelItemAngle(0, geo)).toBe(0);
    expect(wheelItemAngle(1, geo)).toBeCloseTo(geo.step);
    expect(wheelItemAngle(-2, geo)).toBeCloseTo(-(geo.step + geo.idleStep));
    expect(wheelItemAngle(1.0001, geo) - wheelItemAngle(0.9999, geo)).toBeLessThan(0.001);
  });

  it('hides cards that have left the rail', () => {
    const offRail = [...Array(20).keys()].find((i) => wheelItemPose(i, 0, geo).hidden);
    expect(offRail).toBeDefined();
    const pose = wheelItemPose(offRail ?? 0, 0, geo);
    expect(pose.opacity).toBe(0);
    const [x] = wheelArcPoint(wheelItemAngle(offRail ?? 0, geo), geo.cardRadius, geo);
    const y = pose.y;
    expect(x - WHEEL_CARD_WIDTH / 2 > 400 || Math.abs(y - railH / 2) > railH / 2 + WHEEL_CARD_HEIGHT).toBe(true);
  });
});

describe('wheel live previews', () => {
  const rail = { x: 0, y: 0, width: 400, height: 1061 };
  const main = { x: 406, y: 6, width: 1316, height: 1077 };

  it('gives cards the main frame aspect, within bounds', () => {
    expect(wheelCardHeight(main)).toBe(Math.round((WHEEL_CARD_WIDTH * 1077) / 1316));
    expect(wheelCardHeight({ x: 0, y: 0, width: 2000, height: 400 })).toBe(WHEEL_CARD_MIN_HEIGHT);
    expect(wheelCardHeight({ x: 0, y: 0, width: 600, height: 1000 })).toBe(WHEEL_CARD_MAX_HEIGHT);
    const geo = wheelGeometry(400, 1061, wheelCardHeight(main));
    expect(geo.cardHeight).toBe(92);
    expect(geo.step).toBeGreaterThan(wheelGeometry(400, 1061).step);
  });

  it('carries the window from the main frame (dock 0) onto its card (dock 1)', () => {
    const geo = wheelGeometry(400, 1061, wheelCardHeight(main));
    const pose = wheelItemPose(1, 0, geo);
    expect(wheelPreviewTransform(pose, rail, main, 0)).toBe('translate(0.00px, 0.00px) rotate(0.0000rad) scale(1.0000)');
    const docked = wheelPreviewTransform(pose, rail, main, 1);
    const [dx, dy, rot, scale] = (docked.match(/-?\d+\.\d+/g) ?? []).map(Number);
    // Centre of the scaled window lands on the card centre.
    expect(main.x + main.width / 2 + dx).toBeCloseTo(rail.x + pose.x, 1);
    expect(main.y + main.height / 2 + dy).toBeCloseTo(rail.y + pose.y, 1);
    expect(rot).toBeCloseTo(pose.rotate, 3);
    expect(scale * main.width).toBeCloseTo(WHEEL_CARD_WIDTH * pose.scale, 0);
    expect(scale * main.height).toBeCloseTo(geo.cardHeight * pose.scale, 0);
  });

  it('fades a preview out before its card reaches a rail edge', () => {
    const geo = wheelGeometry(400, 1061, 92);
    expect(wheelEdgeFade(wheelItemPose(0, 0, geo), geo)).toBe(1);
    const apex = wheelItemPose(0, 0, geo);
    const near = { ...apex, x: 400 - (WHEEL_CARD_WIDTH / 2) * apex.scale - WHEEL_EDGE_FADE / 2 };
    expect(wheelEdgeFade(near, geo)).toBeCloseTo(0.5);
    const past = { ...near, x: 400 };
    expect(wheelEdgeFade(past, geo)).toBe(0);
    const top = { ...wheelItemPose(0, 0, geo), y: 10 };
    expect(wheelEdgeFade(top, geo)).toBe(0);
  });

  it('keeps only the slots around the active card live', () => {
    expect(wheelIsLiveSlot(5, 5)).toBe(false);
    expect(wheelIsLiveSlot(5 + WHEEL_LIVE_SLOTS, 5)).toBe(true);
    expect(wheelIsLiveSlot(5 - WHEEL_LIVE_SLOTS, 5)).toBe(true);
    expect(wheelIsLiveSlot(5 + WHEEL_LIVE_SLOTS + 1, 5)).toBe(false);
  });
});

describe('wheel fur', () => {
  it('is deterministic, bounded, and clusters every sixth tuft', () => {
    for (let k = -30; k < 30; k++) {
      expect(wheelFurLevel(k)).toBe(wheelFurLevel(k));
      expect(wheelFurLevel(k)).toBeGreaterThan(0);
      expect(wheelFurLevel(k)).toBeLessThanOrEqual(1);
    }
    expect(wheelFurLevel(2)).toBeGreaterThanOrEqual(0.45);
    expect(wheelFurLevel(-4)).toBeGreaterThanOrEqual(0.45);
  });
});

describe('wheel text silhouette', () => {
  it('buckets rows into bars spanning the widest text in each bucket', () => {
    const rows = ['$ ls', '', '    src/  docs/', ...Array(33).fill('')];
    const bars = wheelTextSilhouette(rows, 40);
    expect(bars).toHaveLength(WHEEL_SILHOUETTE_ROWS);
    // Rows 0–1 share the first bucket, row 2 opens the second.
    expect(bars[0]).toEqual([0, 4 / 40]);
    expect(bars[1]).toEqual([4 / 40, 15 / 40]);
    expect(bars[2]).toEqual([0, 0]);
  });

  it('keeps one bar per row for short terminals and caps overlong lines', () => {
    const bars = wheelTextSilhouette(['x'.repeat(90), ' y'], 80);
    expect(bars).toEqual([[0, 1], [1 / 80, 2 / 80]]);
  });

  it('feeds the card key so new output repaints the card', () => {
    const leaf = (lines: Array<[number, number]>): WheelPaneNode => ({ type: 'leaf', id: 'a', contentType: 'terminal', lines });
    const a = wheelSchematic(leaf([[0, 0.2]]), 'a');
    const b = wheelSchematic(leaf([[0, 0.6]]), 'a');
    expect(a[0].lines).toEqual([[0, 0.2]]);
    expect(wheelItemKey('krypton/', a, 1)).not.toBe(wheelItemKey('krypton/', b, 1));
  });
});

describe('wheel stepping', () => {
  it('wraps in both directions', () => {
    expect(wrapWheelIndex(5, 5)).toBe(0);
    expect(wrapWheelIndex(-1, 5)).toBe(4);
    expect(wrapWheelIndex(2, 5)).toBe(2);
    expect(wrapWheelIndex(3, 0)).toBe(0);
  });
});

describe('wheel activity', () => {
  it('bumps by throughput with a floor for tiny chunks, capped at 1', () => {
    expect(bumpActivity(0, 8192)).toBe(1);
    expect(bumpActivity(0, 4)).toBeCloseTo(0.04);
    expect(bumpActivity(0.99, 8192)).toBe(1);
    expect(bumpActivity(0.3, 0)).toBe(0.3);
  });

  it('halves every 1.5 s and snaps to zero once negligible', () => {
    expect(decayActivity(0.8, 1500)).toBeCloseTo(0.4);
    expect(decayActivity(0.01, 3000)).toBe(0);
    expect(decayActivity(0, 16)).toBe(0);
  });
});

describe('wheel schematic', () => {
  it('lays out vertical splits side by side and horizontal splits stacked', () => {
    const tree: WheelPaneNode = {
      type: 'split',
      direction: 'vertical',
      ratio: 0.6,
      first: { type: 'leaf', id: 'a', contentType: 'terminal' },
      second: {
        type: 'split',
        direction: 'horizontal',
        ratio: 0.5,
        first: { type: 'leaf', id: 'b', contentType: 'markdown' },
        second: { type: 'leaf', id: 'c', contentType: 'acp_harness' },
      },
    };
    const rects = wheelSchematic(tree, 'c');
    expect(rects).toHaveLength(3);
    expect(rects[0]).toMatchObject({ x: 0, y: 0, glyph: '>_', focused: false });
    expect(rects[0].w).toBeCloseTo(0.6);
    expect(rects[1]).toMatchObject({ y: 0, glyph: '¶' });
    expect(rects[1].x).toBeCloseTo(0.6);
    expect(rects[1].h).toBeCloseTo(0.5);
    expect(rects[2]).toMatchObject({ glyph: '◈', focused: true });
    expect(rects[2].y).toBeCloseTo(0.5);
  });

  it('keys change only when label, tabs or panes change', () => {
    const rects = wheelSchematic({ type: 'leaf', id: 'a', contentType: 'terminal' }, 'a');
    const key = wheelItemKey('krypton/', rects, 1);
    expect(wheelItemKey('krypton/', rects, 1)).toBe(key);
    expect(wheelItemKey('krypton/', rects, 2)).not.toBe(key);
    expect(wheelItemKey('xenon/', rects, 1)).not.toBe(key);
  });

  it('formats project names as directories without uppercasing', () => {
    expect(wheelLabel('krypton', 'session_1')).toBe('krypton/');
    expect(wheelLabel('~', 'x')).toBe('~');
    expect(wheelLabel('/', 'x')).toBe('/');
    expect(wheelLabel('obsidian-clippe…', 'x')).toBe('obsidian-clippe…');
    expect(wheelLabel(null, ' DIFF // 3 files ')).toBe('DIFF // 3 files');
  });

  it('shows only the first two characters of a label, case kept', () => {
    expect(wheelLabelHead('krypton/')).toBe('kr');
    expect(wheelLabelHead('DIFF // 3 files')).toBe('DI');
    expect(wheelLabelHead('~')).toBe('~');
    expect(wheelLabelHead('')).toBe('');
    expect(wheelLabelHead('🦊fox/')).toBe('🦊f');
  });
});
