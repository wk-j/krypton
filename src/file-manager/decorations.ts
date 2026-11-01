// Krypton — File Manager row decorations (spec 317, extension point C). Pure.
//
// Add a decoration: if it is a pure function of the entry, write a
// `RowClassDecorator` and append it to `ROW_CLASS_DECORATORS`, then add the
// `.krypton-file-manager__item--<x>` rule to src/styles/file-manager.css. If it
// needs outside data, add a field to `FileRowProps`, include it in
// `FileRow.readDeps`, and compute it in `selectFileList`.

import { fileTypeClass } from './file-type';
import type { FileEntry } from './types';

/** Pure on the entry: FileRow's deps include the entry, so a decorator may read nothing else. */
export type RowClassDecorator = (entry: FileEntry) => string | null;

export const ROW_CLASS_DECORATORS: readonly RowClassDecorator[] = [
  (e) => fileTypeClass(e) || null, // krypton-file-manager__item--ft-*
];

/** `__size--mega` (≥ 1 MiB) | `__size--large` (≥ 100 KiB) | null; dirs → null. */
export function sizeClass(entry: FileEntry): string | null {
  if (entry.is_dir) return null;
  if (entry.size >= 1024 * 1024) return 'krypton-file-manager__size--mega';
  if (entry.size >= 100 * 1024) return 'krypton-file-manager__size--large';
  return null;
}

const recencyCache = new WeakMap<readonly FileEntry[], ReadonlyMap<string, number>>();

/**
 * Rank by `modified` (> 0 only) → 0..1 (oldest → newest); a single entry → 0.5.
 * Memoised on the array identity so cursor moves stay O(window).
 */
export function recencyByPath(entries: readonly FileEntry[]): ReadonlyMap<string, number> {
  const cached = recencyCache.get(entries);
  if (cached) return cached;
  const out = new Map<string, number>();
  const withMod = entries.filter((e) => e.modified > 0);
  const sorted = [...withMod].sort((a, b) => a.modified - b.modified);
  const n = sorted.length;
  for (let idx = 0; idx < n; idx++) {
    out.set(sorted[idx].path, n > 1 ? idx / (n - 1) : 0.5);
  }
  recencyCache.set(entries, out);
  return out;
}

/**
 * The age-bar fill: newest → full width and opacity, oldest → 15% at 0.4.
 * The colour is the theme accent from CSS, so recency reads as one meter
 * rather than a heat ramp (spec 0060: single colour).
 */
export function ageFillStyle(recency: number): { width: string; opacity: string } {
  return {
    width: `${15 + recency * 85}%`,
    opacity: `${0.4 + recency * 0.6}`,
  };
}
