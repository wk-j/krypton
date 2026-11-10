// Spec 380 — test support: drive a real lane decoder with wire tool calls so a
// test feeds the view exactly the canonical events production does.

import type { PermissionOption, ToolCall } from '../types';
import { createLaneDecoder } from './decoder';
import type { LaneEvent, RawAcpEvent } from './types';

export type ToolEvent = Extract<LaneEvent, { type: 'tool' }>;

type WireTool = Partial<ToolCall> & { toolCallId: string };

export function rawToolUpdate(kind: 'tool_call' | 'tool_call_update', call: Partial<ToolCall>): RawAcpEvent {
  return { type: 'session_update', kind, update: { sessionUpdate: kind, ...call } as RawAcpEvent['update'] };
}

export interface ToolEventSource {
  /** The canonical event for a `tool_call`. */
  call(call: WireTool): ToolEvent;
  /** The canonical event for a `tool_call_update`; throws for a call never seen. */
  update(update: WireTool): ToolEvent;
}

export function toolEventSource(backend = 'claude'): ToolEventSource {
  const decoder = createLaneDecoder(backend);
  const decode = (kind: 'tool_call' | 'tool_call_update', call: WireTool): ToolEvent => {
    const [event] = decoder.event(rawToolUpdate(kind, call));
    if (event?.type !== 'tool') throw new Error(`no tool event for ${kind} ${call.toolCallId}`);
    return event;
  };
  return {
    call: (call) => decode('tool_call', call),
    update: (update) => decode('tool_call_update', update),
  };
}

export type PermissionEvent = Extract<LaneEvent, { type: 'permission_request' }>;

/** The canonical event for a `session/request_permission` on a lane of `backend`. */
export function permissionEvent(
  backend: string,
  toolCall: Partial<ToolCall> & { toolCallId: string },
  options: PermissionOption[] = [],
  requestId = 1,
): PermissionEvent {
  const [event] = createLaneDecoder(backend).event({
    type: 'permission_request',
    requestId,
    params: { toolCall: toolCall as ToolCall, options },
  });
  if (event?.type !== 'permission_request') throw new Error('no permission event');
  return event;
}
