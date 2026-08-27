import { describe, it, expect } from 'vitest';

import {
  collapsedCover,
  dirChain,
  fileAncestorDirs,
  revealDir,
  revealFile,
} from './hurl-tree';

describe('fileAncestorDirs', () => {
  it('returns each parent prefix of a nested file', () => {
    expect(fileAncestorDirs('hurl/temp/02-upload.hurl')).toEqual([
      'hurl',
      'hurl/temp',
    ]);
  });

  it('returns empty for a root-level file', () => {
    expect(fileAncestorDirs('health.hurl')).toEqual([]);
  });

  it('ignores empty segments', () => {
    expect(fileAncestorDirs('/hurl/temp/foo.hurl')).toEqual([
      'hurl',
      'hurl/temp',
    ]);
  });
});

describe('dirChain', () => {
  it('includes the dir itself and every ancestor', () => {
    expect(dirChain('hurl/temp')).toEqual(['hurl', 'hurl/temp']);
  });

  it('is a single entry for a root folder', () => {
    expect(dirChain('hurl')).toEqual(['hurl']);
  });
});

describe('revealFile / revealDir', () => {
  it('opens ancestors so a nested expand is visible after reload', () => {
    const expanded = new Set<string>(['hurl/temp']);
    revealFile(expanded, 'hurl/temp/02-upload.hurl');
    expect([...expanded].sort()).toEqual(['hurl', 'hurl/temp']);
  });

  it('does not add a root file to the expanded set', () => {
    const expanded = new Set<string>();
    revealFile(expanded, 'health.hurl');
    expect(expanded.size).toBe(0);
  });

  it('opening a nested dir also opens its parents', () => {
    const expanded = new Set<string>();
    revealDir(expanded, 'hurl/anysite-ui/new');
    expect([...expanded].sort()).toEqual([
      'hurl',
      'hurl/anysite-ui',
      'hurl/anysite-ui/new',
    ]);
  });
});

describe('collapsedCover', () => {
  it('is null when every ancestor of the file is open', () => {
    const expanded = new Set([
      'hurl',
      'hurl/test-cases',
      'hurl/test-cases/cr009-update-core-metadata-cl',
    ]);
    expect(
      collapsedCover(
        expanded,
        'hurl/test-cases/cr009-update-core-metadata-cl/03-reindex.hurl',
      ),
    ).toBeNull();
  });

  it('returns the collapsed folder that hides the selected file', () => {
    const expanded = new Set(['hurl', 'hurl/test-cases']);
    expect(
      collapsedCover(
        expanded,
        'hurl/test-cases/cr009-update-core-metadata-cl/03-reindex.hurl',
      ),
    ).toBe('hurl/test-cases/cr009-update-core-metadata-cl');
  });

  it('does not reopen a collapsed parent just because a descendant flag remains', () => {
    const expanded = new Set([
      'hurl',
      'hurl/test-cases/cr009-update-core-metadata-cl',
    ]);
    expect(
      collapsedCover(expanded, 'hurl/test-cases/cr009-update-core-metadata-cl/03-reindex.hurl'),
    ).toBe('hurl/test-cases');
  });

  it('returns null for a root-level file', () => {
    expect(collapsedCover(new Set(), 'health.hurl')).toBeNull();
  });
});
