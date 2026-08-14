import { describe, expect, it } from 'vitest';

import { liveAssistUsesMarkdown } from './live-assist-markdown';
import {
  groupLiveAssistTranscript,
  liveAssistActivitySummary,
  liveAssistAdoptedText,
  liveAssistBlockKey,
  liveAssistPermissionFocusTarget,
  liveAssistStreamDisposition,
  sameLaneRoster,
} from './live-assist-view';
import type { LiveAssistTranscriptItem } from './live-assist-types';

function item(id: string, kind: string): LiveAssistTranscriptItem {
  return { id, kind, text: id, createdAt: null, status: null };
}

function said(id: string, kind: string, text: string): LiveAssistTranscriptItem {
  return { id, kind, text, createdAt: null, status: null };
}

describe('Live Assist conversation markdown', () => {
  it('formats assistant replies and leaves user/activity rows as plain text', () => {
    expect(liveAssistUsesMarkdown('assistant')).toBe(true);
    expect(liveAssistUsesMarkdown('user')).toBe(false);
    expect(liveAssistUsesMarkdown('thought')).toBe(false);
    expect(liveAssistUsesMarkdown('tool')).toBe(false);
  });
});

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

describe('Live Assist transcript reconciliation', () => {
  it('keys messages and activity groups in separate namespaces', () => {
    const shared = item('x-1', 'assistant');
    expect(liveAssistBlockKey({ kind: 'message', item: shared })).toBe('m:x-1');
    expect(liveAssistBlockKey({ kind: 'activity', id: 'x-1', items: [shared] })).toBe('a:x-1');
  });

  it('rebuilds the lane strip only when the roster itself changes', () => {
    expect(sameLaneRoster(['Claude-5'], ['Claude-5'])).toBe(true);
    expect(sameLaneRoster(['Claude-5'], ['Claude-5', 'Codex-1'])).toBe(false);
    expect(sameLaneRoster(['Claude-5', 'Codex-1'], ['Codex-1', 'Claude-5'])).toBe(false);
  });
});

describe('Live Assist streaming row settlement', () => {
  const streamed = 'partial answer';

  it('adopts the snapshot row while the same speaker is still streaming', () => {
    const blocks = groupLiveAssistTranscript([
      said('user-1', 'user', 'go'),
      said('assistant-1', 'assistant', 'partial'),
    ]);
    expect(liveAssistStreamDisposition(blocks, 'assistant', streamed, true)).toBe('adopt');
  });

  it('keeps the streamed row when the snapshot has not caught up at all', () => {
    const blocks = groupLiveAssistTranscript([
      said('user-1', 'user', 'go'),
      item('tool-1', 'tool'),
    ]);
    expect(liveAssistStreamDisposition(blocks, 'assistant', streamed, true)).toBe('keep');
  });

  it('drops the streamed row once a sealed message already contains its text', () => {
    const blocks = groupLiveAssistTranscript([
      said('assistant-1', 'assistant', `prefix ${streamed} suffix`),
      item('tool-1', 'tool'),
    ]);
    expect(liveAssistStreamDisposition(blocks, 'assistant', streamed, true)).toBe('drop');
  });

  it('drops the streamed row when the turn is over so no caret is left blinking', () => {
    const blocks = groupLiveAssistTranscript([said('assistant-1', 'assistant', 'partial')]);
    expect(liveAssistStreamDisposition(blocks, 'assistant', streamed, false)).toBe('drop');
  });

  it('does not search past the recent tail for coverage', () => {
    const older = said('assistant-0', 'assistant', streamed);
    const filler = Array.from({ length: 10 }, (_, index) => item(`tool-${index}`, 'shell'));
    const blocks = groupLiveAssistTranscript([older, ...filler]);
    expect(liveAssistStreamDisposition(blocks, 'assistant', streamed, true)).toBe('keep');
  });

  it('keeps text streamed ahead of a snapshot when leaving a synthetic row', () => {
    expect(liveAssistAdoptedText(true, 'full answer so far', 'full answer')).toBe(
      'full answer so far',
    );
  });

  it('takes the snapshot when it is further along than the popup', () => {
    expect(liveAssistAdoptedText(true, 'answer', 'the whole answer')).toBe('the whole answer');
  });

  it('trusts the snapshot across a message boundary the popup could not see', () => {
    // The harness sealed "first" and began "second"; chunks for both landed in
    // the one adopted row, so the accumulated text must not win here.
    expect(liveAssistAdoptedText(false, 'firstsecond', 'second')).toBe('second');
  });
});
