// Krypton — File Manager Tauri calls (spec 317).
//
// Every `invoke` the file manager makes, with the exact command names and
// argument shapes of the original view.

import { invoke } from '@tauri-apps/api/core';

import type { FileEntry } from './types';

/** Resolve the user's home directory from env or heuristic */
let cachedHome: string | null = null;
export async function getHome(): Promise<string> {
  if (cachedHome) return cachedHome;
  try {
    const home = await invoke<string | null>('get_env_var', { name: 'HOME' });
    if (home) {
      cachedHome = home;
      return home;
    }
  } catch { /* fall through */ }
  cachedHome = '/';
  return cachedHome;
}

export function listDirectory(path: string, showHidden: boolean): Promise<FileEntry[]> {
  return invoke<FileEntry[]>('list_directory', { path, showHidden });
}

export function readFile(path: string): Promise<string> {
  return invoke<string>('read_file', { path });
}

export function writeFile(path: string, content: string): Promise<unknown> {
  return invoke('write_file', { path, content });
}

export function searchFiles(root: string, showHidden: boolean): Promise<string[]> {
  return invoke<string[]>('search_files', { root, showHidden });
}

export function runCommand(program: string, args: string[]): Promise<string> {
  return invoke<string>('run_command', { program, args, cwd: null });
}

export const removePath = (p: string): Promise<string> => runCommand('rm', ['-rf', p]);
export const movePath = (from: string, to: string): Promise<string> => runCommand('mv', [from, to]);
export const copyPath = (from: string, to: string): Promise<string> => runCommand('cp', ['-r', from, to]);
export const makeDir = (p: string): Promise<string> => runCommand('mkdir', ['-p', p]);
