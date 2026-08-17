import { describe, expect, it } from 'vitest';

import { nextTitleLabel, splitTitleLabel } from './window-title-label';

describe('splitTitleLabel', () => {
  it('pulls the session identity off session_NN', () => {
    expect(splitTitleLabel('session_01')).toEqual({ rest: 'session_', tail: '01' });
    expect(splitTitleLabel('session_12')).toEqual({ rest: 'session_', tail: '12' });
  });

  it('does not invent a tail from a path or a name', () => {
    expect(splitTitleLabel('~/S/KRYPTON')).toEqual({ rest: '~/S/KRYPTON', tail: '' });
    expect(splitTitleLabel('ACP HARNESS')).toEqual({ rest: 'ACP HARNESS', tail: '' });
    expect(splitTitleLabel('QUICK_TERMINAL')).toEqual({ rest: 'QUICK_TERMINAL', tail: '' });
    expect(splitTitleLabel('ab')).toEqual({ rest: 'ab', tail: '' });
    expect(splitTitleLabel('')).toEqual({ rest: '', tail: '' });
  });
});

describe('nextTitleLabel', () => {
  it('keeps the session mark when OSC replaces the title with a path', () => {
    expect(nextTitleLabel('~/S/KRYPTON', '01')).toEqual({
      rest: '~/S/KRYPTON',
      tail: '01',
    });
  });

  it('replaces the mark when the title is a new session_NN', () => {
    expect(nextTitleLabel('session_03', '01')).toEqual({
      rest: 'session_',
      tail: '03',
    });
  });

  it('stays tailless when the window never had a session mark', () => {
    expect(nextTitleLabel('ACP HARNESS', '')).toEqual({
      rest: 'ACP HARNESS',
      tail: '',
    });
  });

  it('drops a leftover last-two-character tail such as ON', () => {
    expect(nextTitleLabel('~/S/KRYPTON', 'ON')).toEqual({
      rest: '~/S/KRYPTON',
      tail: '',
    });
  });
});
