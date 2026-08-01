import { invoke } from '@tauri-apps/api/core';
import { listen, type UnlistenFn } from '@tauri-apps/api/event';

import type {
  LiveAssistBootstrap,
  LiveAssistControlErrorShape,
  LiveAssistControlReply,
  LiveAssistLaneStatus,
  LiveAssistPermission,
  LiveAssistSnapshot,
  LiveAssistStreamEvent,
  LiveAssistTranscriptItem,
} from './live-assist-types';

const STREAM_ITEM_CAP = 120;

export class LiveAssistControlError extends Error {
  readonly code: string;
  readonly retryable: boolean;

  constructor(shape: LiveAssistControlErrorShape) {
    super(shape.message);
    this.name = 'LiveAssistControlError';
    this.code = shape.code;
    this.retryable = shape.retryable;
  }
}

export interface LiveAssistStreamDelivery {
  event: LiveAssistStreamEvent;
  gap: boolean;
}

export class LiveAssistClient {
  private operationSequence = 0;
  private lastStreamSequence: number | null = null;
  private unlisten: UnlistenFn[] = [];

  async start(
    onStream: (delivery: LiveAssistStreamDelivery) => void,
    onShown: () => void,
  ): Promise<void> {
    const [streamUnlisten, shownUnlisten] = await Promise.all([
      listen<LiveAssistStreamEvent>('live-assist-stream', (event) => {
        const payload = event.payload;
        const gap = this.lastStreamSequence !== null && payload.seq !== this.lastStreamSequence + 1;
        this.lastStreamSequence = payload.seq;
        onStream({ event: payload, gap });
      }),
      listen('live-assist-shown', () => {
        this.lastStreamSequence = null;
        onShown();
      }),
    ]);
    this.unlisten.push(streamUnlisten, shownUnlisten);
  }

  dispose(): void {
    for (const unlisten of this.unlisten.splice(0)) unlisten();
  }

  bootstrap(lastLane: string | null): Promise<LiveAssistBootstrap> {
    return this.dispatch('live_assist.bootstrap', { lastLane });
  }

  async snapshot(lane: LiveAssistSnapshot['lane']): Promise<LiveAssistSnapshot> {
    const [statuses, transcript, permissions] = await Promise.all([
      this.dispatch<LiveAssistLaneStatus[]>('lane.status', { lane: lane.displayName }),
      this.dispatch<LiveAssistTranscriptItem[]>('lane.transcript', { lane: lane.displayName }),
      this.dispatch<LiveAssistPermission[]>('permission.list', { lane: lane.displayName }),
    ]);
    const status = statuses.find((candidate) => candidate.displayName === lane.displayName);
    if (!status) {
      throw new LiveAssistControlError({
        code: 'unknown_lane',
        message: `${lane.displayName} is no longer live`,
        retryable: true,
      });
    }
    return {
      lane,
      status,
      transcript: transcript.slice(-STREAM_ITEM_CAP),
      permissions,
    };
  }

  send(lane: string, text: string): Promise<{ status: string; queueDepth?: number }> {
    return this.dispatch('lane.send', { lane, text });
  }

  cancel(lane: string): Promise<{ cancelled: boolean }> {
    return this.dispatch('lane.cancel', { lane });
  }

  resolvePermission(
    lane: string,
    requestId: number,
    action: 'accept' | 'reject',
  ): Promise<{ resolved: boolean }> {
    return this.dispatch('permission.resolve', { lane, requestId, action });
  }

  hide(): Promise<void> {
    return invoke('live_assist_hide');
  }

  private async dispatch<T>(operation: string, params: Record<string, unknown>): Promise<T> {
    this.operationSequence += 1;
    const reply = await invoke<LiveAssistControlReply<T>>('live_assist_dispatch', {
      operationId: `live-assist-${Date.now()}-${this.operationSequence}`,
      operation,
      params,
    });
    if (reply.error) throw new LiveAssistControlError(reply.error);
    if (!('result' in reply)) {
      throw new LiveAssistControlError({
        code: 'empty_reply',
        message: `No result returned for ${operation}`,
        retryable: true,
      });
    }
    return reply.result as T;
  }
}

export function streamText(event: LiveAssistStreamEvent): string | null {
  if (event.kind !== 'message_chunk' && event.kind !== 'user_message_chunk') return null;
  if (!event.payload || typeof event.payload !== 'object') return null;
  const text = (event.payload as { text?: unknown }).text;
  return typeof text === 'string' ? text : null;
}

export function streamNeedsSnapshot(kind: string): boolean {
  return kind === 'stop'
    || kind === 'error'
    || kind === 'status'
    || kind === 'permission_request'
    || kind === 'permission_resolved'
    || kind === 'lane_opened'
    || kind === 'lane_closed'
    || kind === 'lane_session_changed'
    || kind === 'harness_closed';
}

export function streamChangesRoster(kind: string): boolean {
  return kind === 'lane_opened' || kind === 'lane_closed' || kind === 'harness_closed';
}
