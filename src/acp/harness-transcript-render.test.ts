import { describe, expect, it } from 'vitest';

import { pretextRowMatchesLines } from './harness-transcript-render';

describe('pretextRowMatchesLines', () => {
  it('matches when class and text already equal the layout cache', () => {
    const row = {
      children: [
        { className: 'acp-harness__pretext-line', textContent: 'one' },
        { className: 'acp-harness__pretext-line', textContent: 'two' },
      ],
    };
    expect(pretextRowMatchesLines(row, ['one', 'two'])).toBe(true);
  });

  it('misses when a line changed or the row is still a plain text node', () => {
    expect(pretextRowMatchesLines(
      { children: [{ className: 'acp-harness__pretext-line', textContent: 'one' }] },
      ['one', 'two'],
    )).toBe(false);
    expect(pretextRowMatchesLines(
      { children: [{ className: 'acp-harness__pretext-line', textContent: 'old' }] },
      ['one'],
    )).toBe(false);
    expect(pretextRowMatchesLines({ children: [] }, ['one'])).toBe(false);
  });
});
