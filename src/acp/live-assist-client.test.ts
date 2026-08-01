import { describe, expect, it } from 'vitest';

import { streamChangesRoster, streamNeedsSnapshot, streamText } from './live-assist-client';
import type { LiveAssistStreamEvent } from './live-assist-types';

function event(kind: string, payload: unknown = {}): LiveAssistStreamEvent {
  return { harnessId: 'hm-1', lane: 'Codex-1', kind, seq: 7, payload };
}

describe('Live Assist stream policy', () => {
  it('extracts only user and assistant text chunks', () => {
    expect(streamText(event('message_chunk', { text: 'hello' }))).toBe('hello');
    expect(streamText(event('user_message_chunk', { text: 'ask' }))).toBe('ask');
    expect(streamText(event('thought_chunk', { text: 'hidden' }))).toBeNull();
    expect(streamText(event('message_chunk', { text: 3 }))).toBeNull();
  });

  it('resnapshots at authoritative state boundaries', () => {
    expect(streamNeedsSnapshot('status')).toBe(true);
    expect(streamNeedsSnapshot('permission_request')).toBe(true);
    expect(streamNeedsSnapshot('stop')).toBe(true);
    expect(streamNeedsSnapshot('message_chunk')).toBe(false);
  });

  it('rebootstraps only when the lane roster can change', () => {
    expect(streamChangesRoster('lane_opened')).toBe(true);
    expect(streamChangesRoster('lane_closed')).toBe(true);
    expect(streamChangesRoster('harness_closed')).toBe(true);
    expect(streamChangesRoster('status')).toBe(false);
  });
});
