import { describe, expect, it } from 'vitest';

import { resolveDismissDelay } from './notification';

// The window status rail decays back to empty (spec 40) — these cover the one
// piece of that policy that is decidable without a DOM.
describe('resolveDismissDelay', () => {
  it('takes the default TTL when a caller says nothing', () => {
    expect(resolveDismissDelay()).toBeGreaterThan(0);
    expect(resolveDismissDelay(undefined)).toBe(resolveDismissDelay());
  });

  it('honours an explicit duration', () => {
    expect(resolveDismissDelay(1500)).toBe(1500);
  });

  it('treats 0 and negatives as sticky', () => {
    expect(resolveDismissDelay(0)).toBe(0);
    expect(resolveDismissDelay(-1)).toBe(0);
  });
});
