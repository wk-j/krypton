// Krypton — File Manager sorting (spec 317). Pure.

import type { FileEntry, SortField, SortOrder } from './types';

/**
 * Directories first, then by `field` in `order`. Returns a new array; the sort
 * is stable, so ties keep the input order exactly as the old in-place sort did.
 */
export function sortEntries(entries: readonly FileEntry[], field: SortField, order: SortOrder): FileEntry[] {
  const dir = order === 'asc' ? 1 : -1;
  return [...entries].sort((a, b) => {
    // Directories always first
    if (a.is_dir !== b.is_dir) return a.is_dir ? -1 : 1;

    switch (field) {
      case 'name':
        return dir * a.name.toLowerCase().localeCompare(b.name.toLowerCase());
      case 'size':
        return dir * (a.size - b.size);
      case 'modified':
        return dir * (a.modified - b.modified);
      default:
        return 0;
    }
  });
}
