// Shared test helpers for the file manager package (spec 317). Not shipped:
// only *.test.ts files import it.

import type { FileEntry } from './types';

export function entry(name: string, over: Partial<FileEntry> = {}): FileEntry {
  return {
    name,
    path: `/r/${name}`,
    is_dir: false,
    is_symlink: false,
    size: 10,
    modified: 1,
    permissions: 'rw-r--r--',
    symlink_target: null,
    ...over,
  };
}

export const dir = (name: string, over: Partial<FileEntry> = {}): FileEntry =>
  entry(name, { is_dir: true, size: 0, permissions: 'rwxr-xr-x', ...over });

export const key = (k: string, mods: { ctrl?: boolean; shift?: boolean; meta?: boolean } = {}): KeyboardEvent =>
  new KeyboardEvent('keydown', { key: k, ctrlKey: !!mods.ctrl, shiftKey: !!mods.shift, metaKey: !!mods.meta });
