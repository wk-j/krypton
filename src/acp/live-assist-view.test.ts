import { describe, expect, it } from 'vitest';

import {
  groupLiveAssistTranscript,
  liveAssistActivitySummary,
  liveAssistPermissionFocusTarget,
} from './live-assist-view';
import type { LiveAssistTranscriptItem } from './live-assist-types';

function item(id: string, kind: string): LiveAssistTranscriptItem {
  return { id, kind, text: id, createdAt: null, status: null };
}

describe('Live Assist compact activity', () => {
  it('groups consecutive internal activity and preserves message boundaries', () => {
    const blocks = groupLiveAssistTranscript([
      item('user-1', 'user'),
      item('thought-1', 'thought'),
      item('tool-1', 'tool'),
      item('read-1', 'fs_activity'),
      item('review-1', 'fs_write_review'),
      item('assistant-1', 'assistant'),
      item('tool-2', 'tool'),
      item('error-1', 'provider_error'),
    ]);

    expect(blocks.map((block) => block.kind)).toEqual([
      'message',
      'activity',
      'message',
      'activity',
      'message',
    ]);
    expect(blocks[1]).toMatchObject({
      kind: 'activity',
      id: 'thought-1',
      items: [
        { id: 'thought-1' },
        { id: 'tool-1' },
        { id: 'read-1' },
        { id: 'review-1' },
      ],
    });
  });

  it('keeps shell, artifact, permission, and lane mail rows visible', () => {
    const kinds = ['shell', 'artifact', 'permission', 'inter_lane'];
    const blocks = groupLiveAssistTranscript(kinds.map((kind) => item(kind, kind)));

    expect(blocks).toEqual(kinds.map((kind) => ({
      kind: 'message',
      item: item(kind, kind),
    })));
  });

  it('uses singular count semantics and a stable first-item identity', () => {
    const first = groupLiveAssistTranscript([item('tool-1', 'tool')]);
    const appended = groupLiveAssistTranscript([
      item('tool-1', 'tool'),
      item('write-1', 'fs_write_review'),
    ]);

    expect(first[0]).toMatchObject({ kind: 'activity', id: 'tool-1', items: [{ id: 'tool-1' }] });
    expect(appended[0]).toMatchObject({
      kind: 'activity',
      id: 'tool-1',
      items: [{ id: 'tool-1' }, { id: 'write-1' }],
    });
    expect(liveAssistActivitySummary(1)).toBe('ACTIVITY · 1 step');
    expect(liveAssistActivitySummary(2)).toBe('ACTIVITY · 2 steps');
  });
});

describe('Live Assist permission focus', () => {
  it('moves an empty composer to a newly arrived permission', () => {
    expect(liveAssistPermissionFocusTarget(null, 7, false, true, true)).toBe('permission');
  });

  it('preserves an in-progress draft when a permission arrives', () => {
    expect(liveAssistPermissionFocusTarget(null, 7, false, true, false)).toBeNull();
  });

  it('keeps keyboard focus on the next queued permission', () => {
    expect(liveAssistPermissionFocusTarget(7, 8, true, false, true)).toBe('permission');
  });

  it('returns focus to the composer after the permission queue clears', () => {
    expect(liveAssistPermissionFocusTarget(7, null, true, false, true)).toBe('composer');
  });
});
