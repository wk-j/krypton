// Spec 381 — Files: the agent's own file reads and writes through Krypton's
// ACP fs capability, and the write review a human answers.

import { item } from './fixtures';
import type { GalleryEntry } from './types';

const OLD = "export const BACKGROUND_TASK_MAX = 20;\n";
const NEW = "/** Per-lane cap. Exited rows are dropped oldest-first; a running one never is. */\nexport const BACKGROUND_TASK_MAX = 20;\n";

export const FILE_ENTRIES: readonly GalleryEntry[] = [
  {
    id: 'file-activity',
    title: 'File activity',
    group: 'files',
    summary: 'A file the agent read or wrote through Krypton.',
    components: ['fs-activity-row'],
    scenario: null,
    states: [
      { label: 'read', inputs: [item({ kind: 'fs_activity', text: '', fsActivity: { method: 'read', path: '/Users/me/krypton/docs/0381-harness-component-gallery.md', ok: true } })] },
      { label: 'write', inputs: [item({ kind: 'fs_activity', text: '', fsActivity: { method: 'write', path: '/Users/me/krypton/src/acp/text-truncate.ts', ok: true } })] },
      {
        label: 'failed',
        inputs: [item({
          kind: 'fs_activity',
          text: '',
          fsActivity: { method: 'write', path: '/etc/hosts', ok: false, error: 'outside the lane working directory' },
        })],
      },
    ],
  },
  {
    id: 'file-write-review',
    title: 'Write review',
    group: 'files',
    summary: 'A write the agent proposed, held for the human as a diff.',
    components: ['fs-write-review-row'],
    scenario: null,
    states: [
      {
        label: 'pending',
        inputs: [item({ kind: 'fs_write_review', text: '', fsReview: { requestId: 30, path: 'src/acp/harness-background-tasks.ts', oldText: OLD, newText: NEW } })],
      },
      {
        label: 'accepted',
        inputs: [item({
          kind: 'fs_write_review',
          text: '',
          fsReview: { requestId: 31, path: 'src/acp/harness-background-tasks.ts', oldText: OLD, newText: NEW, resolved: 'accepted' },
        })],
      },
      {
        label: 'rejected',
        inputs: [item({
          kind: 'fs_write_review',
          text: '',
          fsReview: { requestId: 32, path: 'src/acp/harness-background-tasks.ts', oldText: OLD, newText: NEW, resolved: 'rejected' },
        })],
      },
    ],
  },
];
