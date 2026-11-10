// Spec 381 — every gallery entry, in rail order.

import { FILE_ENTRIES } from './files';
import { MESSAGE_ENTRIES } from './messages';
import { REQUEST_ENTRIES } from './requests';
import { TOOL_ENTRIES } from './tools';
import { TURN_ENTRIES } from './turn';
import type { GalleryEntry, GalleryGroup } from './types';

export const GROUP_ORDER: readonly GalleryGroup[] = ['messages', 'tools', 'requests', 'files', 'turn'];

export const GROUP_TITLES: Readonly<Record<GalleryGroup, string>> = {
  messages: 'Messages',
  tools: 'Tools',
  requests: 'Requests',
  files: 'Files',
  turn: 'Turn',
};

export const ENTRIES: readonly GalleryEntry[] = [
  ...MESSAGE_ENTRIES,
  ...TOOL_ENTRIES,
  ...REQUEST_ENTRIES,
  ...FILE_ENTRIES,
  ...TURN_ENTRIES,
];

export type { GalleryEntry, GalleryGroup, GalleryInput, GalleryState } from './types';
