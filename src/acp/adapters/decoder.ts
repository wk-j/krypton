// Spec 380 — one decoder per `AcpClient`: raw `acp-event-<session>` payloads
// and command results in, canonical lane data out. The generic step runs
// first; the backend adapter's hooks refine it.

import type { PlanEntry, StopReason, ToolCall } from '../types';
import {
  assistantMessageEvent,
  availableCommands,
  decodeInit,
  decodePromptResult,
  decodeSession,
  decodeSessionList,
  extractText,
  normalizeContentBlock,
  parseAskUserQuestions,
  steerOutcome,
  usageFromUpdate,
} from './generic';
import { decodePermission } from './permission';
import { adapterFor } from './registry';
import { OmpBackgroundDecoder } from './omp-background';
import { ToolCallDecoder } from './tool';
import type { LaneAdapter, LaneDecoder, LaneEvent, RawAcpEvent } from './types';

function toolEvent(tools: ToolCallDecoder, call: ToolCall, phase: 'call' | 'update'): LaneEvent | null {
  const decoded = tools.decode(call, phase === 'update');
  return decoded ? { type: 'tool', phase, ...decoded } : null;
}

function sessionUpdateEvent(
  adapter: LaneAdapter,
  tools: ToolCallDecoder,
  kind: string | undefined,
  update: Readonly<Record<string, unknown>>,
): LaneEvent | null {
  switch (kind) {
    case 'user_message_chunk': {
      const content = normalizeContentBlock(update.content);
      return { type: 'user_message_chunk', text: content.type === 'text' ? content.text : '', content };
    }
    case 'agent_message_chunk':
      return assistantMessageEvent(update.content, update.messageId, adapter.chunkParent?.(update._meta));
    case 'agent_thought_chunk': {
      const parentToolId = adapter.chunkParent?.(update._meta);
      return { type: 'thought_chunk', text: extractText(update.content), ...(parentToolId ? { parentToolId } : {}) };
    }
    case 'tool_call':
      return toolEvent(tools, update as unknown as ToolCall, 'call');
    case 'tool_call_update':
      return toolEvent(tools, update as unknown as ToolCall, 'update');
    case 'plan':
      return { type: 'plan', entries: Array.isArray(update.entries) ? update.entries as PlanEntry[] : [] };
    case 'usage_update':
      return { type: 'usage', usage: usageFromUpdate(update) };
    case 'available_commands_update':
      return { type: 'available_commands', commands: availableCommands(update.availableCommands) };
    case 'current_mode_update':
      return { type: 'mode_update', modeId: typeof update.currentModeId === 'string' ? update.currentModeId : '' };
    case 'session_info_update': {
      const state = adapter.turnState?.(update) ?? null;
      return state ? { type: 'turn_state', state } : null;
    }
    default:
      return null;
  }
}

function rawEvent(adapter: LaneAdapter, tools: ToolCallDecoder, raw: RawAcpEvent): LaneEvent | null {
  switch (raw.type) {
    case 'session_update':
      return sessionUpdateEvent(adapter, tools, raw.kind, raw.update ?? {});
    case 'fs_activity':
      return {
        type: 'fs_activity',
        method: raw.method === 'write' ? 'write' : 'read',
        path: typeof raw.path === 'string' ? raw.path : '',
        ok: Boolean(raw.ok),
        error: typeof raw.error === 'string' ? raw.error : undefined,
      };
    case 'fs_write_pending':
      return {
        type: 'fs_write_pending',
        requestId: raw.requestId ?? 0,
        path: typeof raw.path === 'string' ? raw.path : '',
        oldText: typeof raw.oldText === 'string' ? raw.oldText : '',
        newText: typeof raw.newText === 'string' ? raw.newText : '',
      };
    case 'provider_error':
      return raw.payload ? { type: 'provider_error', payload: raw.payload } : null;
    case 'permission_request': {
      const params = raw.params ?? {};
      return {
        type: 'permission_request',
        ...decodePermission(tools, raw.requestId ?? 0, params.toolCall ?? ({} as ToolCall), params.options ?? []),
      };
    }
    case 'ask_user_question':
      return {
        type: 'ask_user_question',
        requestId: raw.requestId ?? 0,
        questions: parseAskUserQuestions(raw.questions),
        toolCallId: typeof raw.toolCallId === 'string' ? raw.toolCallId : undefined,
      };
    case 'elicitation_request':
      return {
        type: 'elicitation_request',
        requestId: raw.requestId ?? 0,
        message: typeof raw.message === 'string' ? raw.message : '',
        requestedSchema: raw.requestedSchema,
        toolCallId: typeof raw.toolCallId === 'string' ? raw.toolCallId : undefined,
      };
    case 'turn_marker':
      if (typeof raw.requestId === 'number' && (raw.kind === 'prompt' || raw.kind === 'steer')) {
        return {
          type: 'turn_marker',
          kind: raw.kind,
          requestId: raw.requestId,
          outcome: raw.kind === 'steer' ? steerOutcome(raw.outcome) : null,
        };
      }
      return null;
    case 'stop':
      return {
        type: 'stop',
        stopReason: (raw.stopReason ?? 'end_turn') as StopReason,
        reason: typeof raw.reason === 'string' ? raw.reason : undefined,
      };
    case 'error':
      return { type: 'error', message: raw.message ?? 'unknown error' };
    default:
      return null;
  }
}

export function createLaneDecoder(backendId: string): LaneDecoder {
  const adapter = adapterFor(backendId);
  const tools = new ToolCallDecoder(adapter);
  const background = backendId === 'omp' ? new OmpBackgroundDecoder() : null;
  return {
    event(raw: RawAcpEvent): LaneEvent[] {
      const event = rawEvent(adapter, tools, raw);
      const events = event ? [event] : [];
      if (background && raw.type === 'session_update' &&
          (raw.kind === 'tool_call' || raw.kind === 'tool_call_update')) {
        const activity = background.event((raw.update ?? {}) as unknown as ToolCall, event);
        if (activity) events.push({ type: 'background_task', activity });
      }
      return events;
    },
    init: decodeInit,
    session: decodeSession,
    sessionList: decodeSessionList,
    promptResult: decodePromptResult,
    backgroundSnapshot(raw, requested) {
      if (!background) throw new Error('This backend does not support OMP background snapshots');
      return background.snapshot(raw, requested);
    },
    reset(): void {
      tools.reset();
      background?.reset();
    },
  };
}
