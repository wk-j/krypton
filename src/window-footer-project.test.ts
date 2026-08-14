import { describe, expect, it } from 'vitest';

import { INITIALS_LEN, PROJECT_LABEL_MAX, projectBadge } from './window-footer-project';

const HOME = '/Users/wk';

describe('projectBadge', () => {
  it('returns null when there is no directory to name', () => {
    expect(projectBadge(null)).toBeNull();
    expect(projectBadge(undefined)).toBeNull();
    expect(projectBadge('')).toBeNull();
    expect(projectBadge('   ')).toBeNull();
  });

  it('names the last segment and abbreviates the home prefix', () => {
    expect(projectBadge('/Users/wk/Source/krypton', HOME)).toEqual({
      label: 'krypton',
      initials: 'kr',
      rest: 'ypton',
      title: '~/Source/krypton',
    });
  });

  it('leaves paths outside home alone', () => {
    expect(projectBadge('/opt/homebrew/etc', HOME)).toMatchObject({
      label: 'etc',
      initials: 'et',
      rest: 'c',
      title: '/opt/homebrew/etc',
    });
  });

  it('does not treat a same-prefix sibling as being under home', () => {
    expect(projectBadge('/Users/wknight/app', HOME)?.title).toBe('/Users/wknight/app');
  });

  it('ignores trailing slashes', () => {
    expect(projectBadge('/Users/wk/Source/krypton///', HOME)).toMatchObject({
      label: 'krypton',
      title: '~/Source/krypton',
    });
  });

  it('names the filesystem root and the home directory after themselves', () => {
    expect(projectBadge('/', HOME)).toEqual({ label: '/', initials: '/', rest: '', title: '/' });
    expect(projectBadge('/Users/wk', HOME)).toEqual({ label: '~', initials: '~', rest: '', title: '~' });
    expect(projectBadge('/Users/wk/', HOME)?.label).toBe('~');
  });

  it('works with no home known — the title just stays absolute', () => {
    expect(projectBadge('/Users/wk/Source/krypton')?.title).toBe('/Users/wk/Source/krypton');
  });

  it('magnifies exactly the first two characters', () => {
    const badge = projectBadge('/x/tli-api-service', HOME);
    expect(badge?.initials).toBe('tl');
    expect(badge?.rest).toBe('i-api-service');
    expect(`${badge?.initials}${badge?.rest}`).toBe(badge?.label);
    expect([...(badge?.initials ?? '')].length).toBe(INITIALS_LEN);
  });

  it('leaves an empty tail for a name no longer than the head', () => {
    expect(projectBadge('/x/ab')).toMatchObject({ initials: 'ab', rest: '' });
    expect(projectBadge('/x/a')).toMatchObject({ label: 'a', initials: 'a', rest: '' });
  });

  it('splits by code point, so an astral first character is not cut in half', () => {
    const badge = projectBadge('/x/🚀app');
    expect(badge?.initials).toBe('🚀a');
    expect(badge?.rest).toBe('pp');
  });

  it('truncates a long name but never the title', () => {
    const badge = projectBadge('/Users/wk/Project/tli-api-specification', HOME);
    expect(badge?.label).toBe('tli-api-specifica…');
    expect(badge?.label.length).toBe(PROJECT_LABEL_MAX);
    expect(badge?.rest).toBe('i-api-specifica…');
    expect(badge?.title).toBe('~/Project/tli-api-specification');
  });

  it('honours an explicit max', () => {
    expect(projectBadge('/a/krypton', null, 4)?.label).toBe('kry…');
    expect(projectBadge('/a/krypton', null, 7)?.label).toBe('krypton');
  });

  it('accepts a bare name with no separator', () => {
    expect(projectBadge('krypton')).toMatchObject({ label: 'krypton', title: 'krypton' });
  });
});
