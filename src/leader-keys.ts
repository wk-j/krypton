// Krypton — Leader key metadata and validation helpers.

import type { LeaderKeyId, LeaderKeySpec } from './types';

const GLOBAL_LEADER_KEY_IDS = [
  'h', 'H', 'j', 'J', 'k', 'K', 'l', 'L',
  '1', '2', '3', '4', '5', '6', '7', '8', '9',
  'n', 'N', 'x', 'X', 'p', 'P', 'f', 'F', 'z', 'Z',
  'r', 'R', 's', 'S', 'm', 'M', 'v', 'V', 't', 'T', 'w', 'W',
  '[', ']', '\\', '-',
  'g', 'G', 'o', 'O', 'd', 'D', 'a', 'A', 'e', 'E', 'i', 'I',
  'y', 'Y', 'b', 'B', 'u', 'U', 'q', 'Q', 'c', 'C',
  'Alt+h', 'Alt+j', 'Alt+k', 'Alt+l', 'Alt+x',
] as const;

export const GLOBAL_LEADER_RESERVED_KEYS: ReadonlySet<LeaderKeyId> =
  new Set<LeaderKeyId>(GLOBAL_LEADER_KEY_IDS);

export function normalizeLeaderKeyEvent(e: KeyboardEvent): LeaderKeyId | null {
  if (e.key === 'Shift' || e.key === 'Control' || e.key === 'Alt' || e.key === 'Meta') {
    return null;
  }

  if (e.altKey && !e.shiftKey && !e.ctrlKey && !e.metaKey) {
    switch (e.code) {
      case 'KeyH':
        return 'Alt+h';
      case 'KeyJ':
        return 'Alt+j';
      case 'KeyK':
        return 'Alt+k';
      case 'KeyL':
        return 'Alt+l';
      case 'KeyX':
        return 'Alt+x';
      default:
        return null;
    }
  }

  if (e.altKey || e.ctrlKey || e.metaKey) {
    return null;
  }

  if (e.key.length === 1) {
    return e.key;
  }

  return null;
}

export function isSupportedLocalLeaderKey(key: LeaderKeyId): boolean {
  if (key.length === 1 && key.trim().length === 1) return true;
  return /^Alt\+[a-z]$/.test(key);
}

export interface LeaderKeyConflictGroup {
  owner: string;
  keys: readonly LeaderKeySpec[];
}

export function validateLocalLeaderKeys(groups: readonly LeaderKeyConflictGroup[]): string[] {
  const errors: string[] = [];
  const seen = new Map<LeaderKeyId, string>();

  for (const group of groups) {
    for (const spec of group.keys) {
      if (!isSupportedLocalLeaderKey(spec.key)) {
        errors.push(`${group.owner}: unsupported leader key "${spec.key}"`);
        continue;
      }

      if (GLOBAL_LEADER_RESERVED_KEYS.has(spec.key)) {
        errors.push(`${group.owner}: leader key "${spec.key}" conflicts with global leader key`);
      }

      const previousOwner = seen.get(spec.key);
      if (previousOwner) {
        errors.push(`${group.owner}: leader key "${spec.key}" conflicts with ${previousOwner}`);
      } else {
        seen.set(spec.key, group.owner);
      }
    }
  }

  return errors;
}
