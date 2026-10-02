import { describe, expect, it } from 'vitest';

import {
  WHEEL_EYE_BLINK_MS,
  WHEEL_EYE_REACH,
  WHEEL_EYE_TEXT_MAX,
  WHEEL_EYE_WAKE,
  wheelEyeGaze,
  wheelEyeGrid,
  wheelEyeKey,
  wheelEyeLid,
  wheelEyePupil,
  wheelEyeRows,
  wheelEyeShape,
  wheelEyeText,
  wheelEyeWatch,
  type WheelEyeState,
} from './wheel-eye';
import { wheelItemKey } from './wheel-layout';

const eye = (patch: Partial<WheelEyeState> = {}): WheelEyeState => ({
  cols: 45, rows: 11, px: 0, py: 0, dil: 1, lid: 0, offset: 0, alert: false, ...patch,
});

describe('wheel eye shape', () => {
  it('is an almond: full height at the centre, pinched toward the corners', () => {
    expect(wheelEyeShape(0, 0)).toBe(true);
    expect(wheelEyeShape(0, 1)).toBe(true);
    expect(wheelEyeShape(0.99, 0)).toBe(true);
    expect(wheelEyeShape(1, 0)).toBe(false);
    expect(wheelEyeShape(0.9, 0.5)).toBe(false);
    expect(wheelEyeShape(0, 1.01)).toBe(false);
  });
});

describe('wheel eye pupil', () => {
  it('sits in the centre cell and grows with dilation', () => {
    expect(wheelEyePupil(eye())).toEqual({ col: 22, row: 5, hw: 2, hh: 1 });
    const wide = wheelEyePupil(eye({ dil: 1.9 }));
    expect(wide.hw).toBe(4);
    expect(wide.hh).toBe(1);
  });

  it('follows the gaze offset in whole cells', () => {
    expect(wheelEyePupil(eye({ px: 10.4, py: -2.6 }))).toMatchObject({ col: 32, row: 2 });
  });
});

describe('wheel eye rows', () => {
  it('classes the pupil box, the iris around it, and the white', () => {
    const rows = wheelEyeRows(eye(), 'abcdefghij');
    const at = (r: number, c: number): string | undefined =>
      rows[r].find((run) => c >= run.col && c < run.col + run.text.length)?.cls;
    expect(at(5, 22)).toBe('p');
    expect(at(5, 24)).toBe('p');
    expect(at(5, 26)).toBe('i');
    expect(at(5, 40)).toBe('o');
    // Corners fall outside the almond.
    expect(at(0, 0)).toBeUndefined();
  });

  it('fills cells from the text at the scroll offset', () => {
    const s = eye({ offset: 3 });
    const rows = wheelEyeRows(s, 'abcdefghij');
    const run = rows[5][0];
    expect(run.text[0]).toBe('abcdefghij'[(3 + 5 * 45 + run.col) % 10]);
  });

  it('closes row by row from the top and bottom, leaving the centre seam', () => {
    const open = (lid: number): number[] =>
      wheelEyeRows(eye({ lid }), 'x').flatMap((row, r) => (row.length > 0 ? [r] : []));
    expect(open(0)).toHaveLength(11);
    expect(open(0.5).length).toBeLessThan(11);
    expect(open(0.5).length).toBeGreaterThan(1);
    expect(open(1)).toEqual([5]);
  });
});

describe('wheel eye key', () => {
  it('ignores sub-cell gaze motion but tracks every visible change', () => {
    const key = wheelEyeKey(eye(), 10);
    expect(wheelEyeKey(eye({ px: 0.2 }), 10)).toBe(key);
    expect(wheelEyeKey(eye({ px: 1 }), 10)).not.toBe(key);
    expect(wheelEyeKey(eye({ lid: 0.5 }), 10)).not.toBe(key);
    expect(wheelEyeKey(eye({ offset: 1 }), 10)).not.toBe(key);
    expect(wheelEyeKey(eye({ offset: 10 }), 10)).toBe(key);
    expect(wheelEyeKey(eye({ alert: true }), 10)).not.toBe(key);
  });
});

describe('wheel eye gaze', () => {
  it('points the pupil toward the target and saturates far away', () => {
    const near = wheelEyeGaze(WHEEL_EYE_REACH / 4, 0, 45, 11);
    const far = wheelEyeGaze(WHEEL_EYE_REACH * 10, 0, 45, 11);
    expect(near.x).toBeGreaterThan(0);
    expect(near.x).toBeLessThan(far.x);
    expect(far.x).toBeCloseTo(45 * 0.3, 3);
    expect(far.y).toBeCloseTo(0);
    expect(far.near).toBe(0);
    const up = wheelEyeGaze(0, -WHEEL_EYE_REACH * 10, 45, 11);
    expect(up.y).toBeCloseTo(-11 * 0.27, 3);
  });

  it('rests centred and fully near on its own centre', () => {
    const g = wheelEyeGaze(0, 0, 45, 11);
    expect(g.x).toBe(0);
    expect(g.y).toBe(0);
    expect(g.near).toBeGreaterThan(0.99);
  });
});

describe('wheel eye grid', () => {
  it('spans most of the card width with an odd row count', () => {
    expect(wheelEyeGrid(2.16, 92)).toEqual({ cols: 45, rows: 11 });
    const short = wheelEyeGrid(2.16, 56);
    expect(short.rows).toBe(9);
    for (const h of [56, 70, 85, 100]) expect(wheelEyeGrid(1.8, h).rows % 2).toBe(1);
  });

  it('falls back to a 0.6em cell when the font cannot be measured', () => {
    expect(wheelEyeGrid(0, 92)).toEqual(wheelEyeGrid(2.16, 92));
  });
});

describe('wheel eye lid', () => {
  it('closes over one blink half and opens over the next', () => {
    expect(wheelEyeLid(0)).toBe(0);
    expect(wheelEyeLid(WHEEL_EYE_BLINK_MS / 2)).toBeCloseTo(0.5);
    expect(wheelEyeLid(WHEEL_EYE_BLINK_MS)).toBe(1);
    expect(wheelEyeLid(WHEEL_EYE_BLINK_MS * 1.5)).toBeCloseTo(0.5);
    expect(wheelEyeLid(WHEEL_EYE_BLINK_MS * 2)).toBe(0);
    expect(wheelEyeLid(-5)).toBe(0);
    expect(wheelEyeLid(Infinity)).toBe(0);
  });
});

describe('wheel eye text', () => {
  it('joins label and title, collapsing whitespace and dropping repeats', () => {
    expect(wheelEyeText('krypton/', 'nvim  src/x.ts')).toBe('krypton/ nvim src/x.ts');
    expect(wheelEyeText('zsh', 'zsh')).toBe('zsh');
    expect(wheelEyeText('', 'cargo build')).toBe('cargo build');
    expect(wheelEyeText(' ', '')).toBe('krypton');
    expect(wheelEyeText('a', 'b'.repeat(500))).toHaveLength(WHEEL_EYE_TEXT_MAX);
  });

  it('feeds the card key so a title change reaches the eye', () => {
    expect(wheelItemKey('krypton/', [], 1, 'krypton/ vim')).not.toBe(wheelItemKey('krypton/', [], 1, 'krypton/ zsh'));
  });
});

describe('wheel eye watch', () => {
  it('watches the busiest window, the focused one winning ties', () => {
    expect(wheelEyeWatch([0.1, 0.6, 0.3], 0)).toEqual({ index: 1, level: 0.6 });
    expect(wheelEyeWatch([0.5, 0.5, 0], 0)).toEqual({ index: 0, level: 0.5 });
    expect(wheelEyeWatch([0.2, 0.9], 1)).toEqual({ index: 1, level: 0.9 });
  });

  it('ignores activity below the wake level', () => {
    expect(wheelEyeWatch([WHEEL_EYE_WAKE / 2, WHEEL_EYE_WAKE / 3], 0)).toBeNull();
    expect(wheelEyeWatch([], 0)).toBeNull();
  });
});
