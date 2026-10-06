import { describe, expect, it } from 'vitest';

import { projectLabel, reviewPickerNavigationDelta, scopeToFocusedProject } from './picker';

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

describe('Review Board picker project scope', () => {
  const krypton = { harnessId: 'hm-1', cwd: '/Users/wk/Source/krypton' };
  const tli = { harnessId: 'hm-2', cwd: '/Users/wk/Project/tli-migration' };
  const kryptonAgain = { harnessId: 'hm-3', cwd: '/Users/wk/Source/krypton/' };

  it('keeps only the harnesses of the project the focus sits in', () => {
    const scoped = scopeToFocusedProject([krypton, tli, kryptonAgain], '/Users/wk/Source/krypton');
    expect(scoped.root).toBe('/Users/wk/Source/krypton');
    expect(scoped.entries.map((e) => e.harnessId)).toEqual(['hm-1', 'hm-3']);
  });

  it('scopes a cwd below a project root to that project, preferring the deepest root', () => {
    const nested = { harnessId: 'hm-4', cwd: '/Users/wk/Source/krypton/raycast' };
    expect(scopeToFocusedProject([krypton, tli], '/Users/wk/Source/krypton/src').root)
      .toBe('/Users/wk/Source/krypton');
    expect(scopeToFocusedProject([krypton, nested], '/Users/wk/Source/krypton/raycast/src').root)
      .toBe('/Users/wk/Source/krypton/raycast');
  });

  it('does not treat a sibling sharing a name prefix as inside the project', () => {
    const scoped = scopeToFocusedProject([krypton, tli], '/Users/wk/Source/krypton-old');
    expect(scoped.root).toBeNull();
    expect(scoped.entries).toHaveLength(2);
  });

  it('falls back to every project when the focused cwd is unknown', () => {
    const scoped = scopeToFocusedProject([krypton, tli], null);
    expect(scoped.root).toBeNull();
    expect(scoped.entries.map((e) => e.harnessId)).toEqual(['hm-1', 'hm-2']);
  });

  it('labels a project by its last path segment without changing case', () => {
    expect(projectLabel('/Users/wk/Project/tli-migration')).toBe('tli-migration');
    expect(projectLabel('/Users/wk/Source/Krypton/')).toBe('Krypton');
  });
});
