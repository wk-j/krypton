import { describe, expect, it } from 'vitest';

import { reviewPickerNavigationDelta } from './picker';

describe('Review Board picker navigation', () => {
  it('keeps vim and arrow navigation keys out of the filter query', () => {
    expect(reviewPickerNavigationDelta('j')).toBe(1);
    expect(reviewPickerNavigationDelta('ArrowDown')).toBe(1);
    expect(reviewPickerNavigationDelta('k')).toBe(-1);
    expect(reviewPickerNavigationDelta('ArrowUp')).toBe(-1);
  });

  it('leaves other printable keys available to the filter input', () => {
    expect(reviewPickerNavigationDelta('r')).toBe(0);
    expect(reviewPickerNavigationDelta('/')).toBe(0);
    expect(reviewPickerNavigationDelta('Enter')).toBe(0);
  });
});
