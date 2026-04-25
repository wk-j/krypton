// Krypton — ACP client.
// Thin frontend wrapper around the Rust `acp_*` Tauri commands and
// `acp-event-<session>` notifications. One AcpClient per AcpView.

import { invoke } from '@tauri-apps/api/core';
import { listen, type UnlistenFn } from '@tauri-apps/api/event';
import type {
  AcpBackendDescriptor,
  AcpEvent,
  AgentInfo,
  ContentBlock,
  PermissionOption,
  PlanEntry,
  StopReason,
  ToolCall,
  ToolCallUpdate,
} from './types';

interface RawAcpEvent {
  type: 'session_update' | 'permission_request' | 'stop' | 'error';
  // session_update:
  kind?: string;
  update?: {
    sessionUpdate: string;
    content?: ContentBlock | { type: 'text'; text: string };
    [k: string]: unknown;
  };
  // permission_request:
  requestId?: number;
  params?: {
    toolCall?: ToolCall;
    options?: PermissionOption[];
    [k: string]: unknown;
  };
  // stop:
  stopReason?: StopReason;
  // error:
  message?: string;
}

export class AcpClient {
  private session: number;
  private unlisten: UnlistenFn | null = null;
  private listeners: Array<(e: AcpEvent) => void> = [];
  private disposed = false;

  private constructor(session: number) {
    this.session = session;
  }

  static async listBackends(): Promise<AcpBackendDescriptor[]> {
    return invoke<AcpBackendDescriptor[]>('acp_list_backends');
  }

  static async spawn(backendId: string, cwd: string | null): Promise<AcpClient> {
    const session = await invoke<number>('acp_spawn', { backendId, cwd });
    const client = new AcpClient(session);
    client.unlisten = await listen<RawAcpEvent>(`acp-event-${session}`, (ev) => {
      client.handleRaw(ev.payload);
    });
    return client;
  }

  async initialize(): Promise<AgentInfo> {
    return invoke<AgentInfo>('acp_initialize', { session: this.session });
  }

  onEvent(cb: (e: AcpEvent) => void): () => void {
    this.listeners.push(cb);
    return () => {
      const i = this.listeners.indexOf(cb);
      if (i >= 0) this.listeners.splice(i, 1);
    };
  }

  async prompt(blocks: ContentBlock[]): Promise<StopReason> {
    const result = await invoke<{ stopReason: StopReason }>('acp_prompt', {
      session: this.session,
      blocks,
    });
    const stopReason: StopReason = result.stopReason ?? 'end_turn';
    // Per the ACP spec, the `session/prompt` JSON-RPC *response* is the turn-end signal;
    // it is not delivered as a `session/update` notification. Surface it through the
    // event stream so the view can clear `turnActive`.
    for (const cb of this.listeners.slice()) cb({ type: 'stop', stopReason });
    return stopReason;
  }

  async cancel(): Promise<void> {
    await invoke('acp_cancel', { session: this.session });
  }

  async respondPermission(requestId: number, optionId: string | null): Promise<void> {
    await invoke('acp_permission_response', {
      session: this.session,
      requestId,
      optionId,
    });
  }

  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    if (this.unlisten) {
      this.unlisten();
      this.unlisten = null;
    }
    try {
      await invoke('acp_dispose', { session: this.session });
    } catch (e) {
      console.warn('[AcpClient] dispose failed:', e);
    }
  }

  private handleRaw(raw: RawAcpEvent): void {
    let event: AcpEvent | null = null;
    switch (raw.type) {
      case 'session_update': {
        const update = (raw.update ?? {}) as {
          sessionUpdate?: string;
          content?: unknown;
          entries?: PlanEntry[];
          [k: string]: unknown;
        };
        switch (raw.kind) {
          case 'agent_message_chunk':
            event = { type: 'message_chunk', text: extractText(update.content) };
            break;
          case 'agent_thought_chunk':
            event = { type: 'thought_chunk', text: extractText(update.content) };
            break;
          case 'tool_call':
            event = { type: 'tool_call', call: update as unknown as ToolCall };
            break;
          case 'tool_call_update':
            event = { type: 'tool_call_update', update: update as unknown as ToolCallUpdate };
            break;
          case 'plan': {
            const entries = update.entries ?? [];
            event = { type: 'plan', entries };
            break;
          }
        }
        break;
      }
      case 'permission_request': {
        const params = raw.params ?? {};
        event = {
          type: 'permission_request',
          requestId: raw.requestId ?? 0,
          toolCall: params.toolCall ?? ({} as ToolCall),
          options: params.options ?? [],
        };
        break;
      }
      case 'stop':
        event = { type: 'stop', stopReason: (raw.stopReason ?? 'end_turn') as StopReason };
        break;
      case 'error':
        event = { type: 'error', message: raw.message ?? 'unknown error' };
        break;
    }
    if (event) {
      for (const cb of this.listeners.slice()) cb(event);
    }
  }
}

function extractText(content: unknown): string {
  if (!content || typeof content !== 'object') return '';
  const c = content as { type?: string; text?: string };
  if (c.type === 'text' && typeof c.text === 'string') return c.text;
  return '';
}
