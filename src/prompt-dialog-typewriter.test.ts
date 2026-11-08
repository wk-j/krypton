import { describe, expect, it } from 'vitest';

import { LIT_REACH, inkRange, lampReach } from './prompt-dialog-typewriter';

describe('lamplight reach (spec 373 amendment B)', () => {
  it('is 0 under the lamp and 1 at the edge of its ellipse', () => {
    expect(lampReach(0, 0)).toBe(0);
    expect(lampReach(520, 0)).toBeCloseTo(1);
    expect(lampReach(0, -360)).toBeCloseTo(1);
  });

  it('lights the head over the first line and leaves the foot of a 10-line sheet dark', () => {
    // First line: the lamp hangs about 40px below the head's text and about
    // 350px above the foot's (10 rows of 17px × 1.45 plus the slip's padding).
    expect(lampReach(0, -40)).toBeLessThan(LIT_REACH);
    expect(lampReach(60, 347)).toBeGreaterThan(LIT_REACH);
  });

  it('leaves the far end of the head dark while the carriage is at the margin', () => {
    // The `1/2` readout sits at the right end of a 1040px sheet.
    expect(lampReach(970, -40)).toBeGreaterThan(LIT_REACH);
  });
});

describe('ink afterimage range (spec 373 amendment D)', () => {
  it('inks a Thai mark over the consonant it sits on, not the cell after it', () => {
    expect(inkRange('กินข้', 4, 1)).toEqual([3, 5]);
    // Stacked upper vowel and tone mark; sara am carries its nikhahit up onto the consonant.
    expect(inkRange('ยั้', 2, 1)).toEqual([0, 3]);
    expect(inkRange('กำ', 1, 1)).toEqual([0, 2]);
  });

  it('keeps a consonant, a leading vowel or a Latin letter to its own cell', () => {
    expect(inkRange('กินข', 3, 1)).toEqual([3, 4]);
    expect(inkRange('เก', 0, 1)).toEqual([0, 1]);
    expect(inkRange('ab', 1, 1)).toEqual([1, 2]);
  });

  it('takes the following marks along when a consonant is typed in front of them', () => {
    expect(inkRange('ขก้า', 1, 1)).toEqual([1, 3]);
  });
});
