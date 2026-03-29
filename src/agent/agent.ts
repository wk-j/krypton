// Krypton — AI Agent Controller
// Wraps @mariozechner/pi-agent-core Agent with lazy initialization,
// CWD-aware system prompt, Krypton-specific tool registration,
// and pi-compatible JSONL session persistence.

import { invoke } from '@tauri-apps/api/core';
import { createKryptonTools } from './tools';
import {
  createSession,
  continueRecentSession,
  appendMessage,
  loadEntries,
  extractMessages,
  type SessionHandle,
} from './session';

/** Normalized events emitted to AgentView for rendering */
export type AgentEventType =
  | { type: 'agent_start' }
  | { type: 'agent_end' }
  | { type: 'message_update'; delta: string }
  | { type: 'tool_start'; name: string; args: string }
  | { type: 'tool_end'; name: string; isError: boolean; result?: string }
  | { type: 'error'; message: string };

export type AgentEventCallback = (e: AgentEventType) => void;

const BASE_SYSTEM_PROMPT = `You are an AI coding assistant embedded in Krypton, a keyboard-driven terminal emulator. You have tools to read files, write files, and run shell commands.

Be concise and direct. Prefer small targeted edits over full rewrites. When writing files, write the complete file content.`;

export class AgentController {
  // Lazy-initialized pi-agent-core Agent instance
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private agent: any = null;
  private projectDir: string | null = null;
  private running = false;
  private unsubscribe: (() => void) | null = null;

  // Session persistence
  private session: SessionHandle | null = null;
  private lastEntryId: string | null = null;

  get isRunning(): boolean {
    return this.running;
  }

  setProjectDir(dir: string | null): void {
    this.projectDir = dir;
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private async buildAgent(apiKey: string): Promise<any> {
    const [{ Agent }, { getModel }] = await Promise.all([
      import('@mariozechner/pi-agent-core'),
      import('@mariozechner/pi-ai'),
    ]);

    const systemPrompt = this.projectDir
      ? `${BASE_SYSTEM_PROMPT}\n\nWorking directory: ${this.projectDir}`
      : BASE_SYSTEM_PROMPT;

    return new Agent({
      initialState: {
        systemPrompt,
        model: { ...getModel('zai', 'glm-4.7'), baseUrl: 'https://api.z.ai/api/coding/paas/v4' },
        tools: createKryptonTools(this.projectDir),
      },
      getApiKey: (provider: string) => (provider === 'zai' ? apiKey : undefined),
      toolExecution: 'sequential',
    });
  }

  /** Initialize or continue a session for the current project directory. */
  async initSession(): Promise<void> {
    if (!this.projectDir || this.session) return;
    try {
      const existing = await continueRecentSession(this.projectDir);
      if (existing) {
        this.session = existing;
      } else {
        this.session = await createSession(this.projectDir);
      }
    } catch (e) {
      console.warn('[agent] session init failed:', e);
    }
  }

  /** Restore agent messages from the current session file. Returns restored message entries for UI rendering. */
  async restoreFromSession(): Promise<Array<{ role: string; message: Record<string, unknown> }>> {
    if (!this.session) return [];
    try {
      const entries = await loadEntries(this.session.filePath);
      const messageEntries = extractMessages(entries);
      if (messageEntries.length === 0) return [];

      // Track the last entry ID for parentId chaining
      this.lastEntryId = messageEntries[messageEntries.length - 1].id;

      // Restore into agent if it's already initialized
      if (this.agent) {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const messages = messageEntries.map((e) => e.message as any);
        this.agent.replaceMessages(messages);
      }

      return messageEntries.map((e) => ({
        role: (e.message.role as string) ?? 'unknown',
        message: e.message,
      }));
    } catch (e) {
      console.warn('[agent] restore failed:', e);
      return [];
    }
  }

  /** Persist a message to the session file. */
  private async persistMessage(message: Record<string, unknown>): Promise<void> {
    if (!this.session) return;
    try {
      this.lastEntryId = await appendMessage(
        this.session.filePath,
        this.lastEntryId,
        message,
      );
    } catch (e) {
      console.warn('[agent] persist failed:', e);
    }
  }

  async prompt(text: string, onEvent: AgentEventCallback): Promise<void> {
    if (this.running) return;

    // Lazy init — read API key from the shell environment
    if (!this.agent) {
      let apiKey: string | null;
      try {
        apiKey = await invoke<string | null>('get_env_var', { name: 'ZAI_API_KEY' });
      } catch (e) {
        onEvent({ type: 'error', message: `Failed to read ZAI_API_KEY: ${e}` });
        return;
      }
      if (!apiKey) {
        onEvent({
          type: 'error',
          message: 'ZAI_API_KEY not set.\nGet a key at bigmodel.cn and add it to your shell environment, then restart Krypton.',
        });
        return;
      }

      try {
        this.agent = await this.buildAgent(apiKey);
        console.log('[agent] initialized, projectDir:', this.projectDir);

        // Restore messages from session into the agent
        await this.restoreFromSession();
      } catch (e) {
        console.error('[agent] buildAgent failed:', e);
        onEvent({ type: 'error', message: `Failed to initialize agent: ${e}` });
        return;
      }
    }

    // Initialize session if not already
    await this.initSession();

    // Persist the user message
    const userMessage = { role: 'user', content: text, timestamp: Date.now() };
    await this.persistMessage(userMessage);

    // Subscribe to events and map to our simplified AgentEventType
    this.unsubscribe = this.agent.subscribe((raw: unknown) => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const e = raw as any;
      console.log('[agent] event:', e.type, e);
      switch (e.type) {
        case 'agent_start':
          this.running = true;
          onEvent({ type: 'agent_start' });
          break;

        case 'agent_end': {
          this.running = false;
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const lastMsg = e.messages?.[e.messages.length - 1] as any;
          const errMsg = lastMsg?.errorMessage as string | undefined;
          console.log('[agent] agent_end, lastMsg:', lastMsg, 'errMsg:', errMsg);
          if (errMsg) {
            onEvent({ type: 'error', message: `Agent error: ${errMsg}` });
          }

          // Persist assistant and tool result messages from this turn
          if (e.messages) {
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            for (const msg of e.messages as any[]) {
              if (msg.role === 'assistant' || msg.role === 'toolResult') {
                this.persistMessage(msg);
              }
            }
          }

          onEvent({ type: 'agent_end' });
          break;
        }

        case 'message_update': {
          // AssistantMessageEvent is a discriminated union; we only care about text_delta
          const ev = e.assistantMessageEvent;
          if (ev?.type === 'text_delta' && typeof ev.delta === 'string') {
            onEvent({ type: 'message_update', delta: ev.delta });
          }
          break;
        }

        case 'tool_execution_start':
          onEvent({
            type: 'tool_start',
            name: String(e.toolName ?? ''),
            args: typeof e.args === 'object' ? JSON.stringify(e.args) : String(e.args ?? ''),
          });
          break;

        case 'tool_execution_end': {
          // result is AgentToolResult<T>; details holds the display string
          const res = e.result as { details?: unknown; content?: Array<{ type: string; text?: string }> } | undefined;
          const result =
            typeof res?.details === 'string'
              ? res.details
              : res?.content?.find((c) => c.type === 'text')?.text;
          onEvent({
            type: 'tool_end',
            name: String(e.toolName ?? ''),
            isError: Boolean(e.isError),
            result,
          });
          break;
        }
      }
    });

    try {
      console.log('[agent] calling agent.prompt()');
      await this.agent.prompt(text);
      console.log('[agent] agent.prompt() resolved');
    } catch (e) {
      console.error('[agent] agent.prompt() threw:', e);
      this.running = false;
      onEvent({ type: 'error', message: `Agent error: ${e}` });
    } finally {
      this.unsubscribe?.();
      this.unsubscribe = null;
    }
  }

  abort(): void {
    if (this.agent && this.running) {
      this.agent.abort();
      this.running = false;
    }
  }

  /** Start a new session (old session file is preserved). */
  async reset(): Promise<void> {
    this.abort();
    this.agent?.clearMessages?.();
    this.agent = null; // force re-init on next prompt (picks up new projectDir)
    this.session = null;
    this.lastEntryId = null;
  }

  /** Return a snapshot of the agent's internal context for inspection */
  getContext(): AgentContextSnapshot | null {
    if (!this.agent) return null;
    const state = this.agent.state;
    if (!state) return null;

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const messages: ContextMessage[] = (state.messages ?? []).map((m: any, i: number) => {
      const role = m.role ?? 'unknown';
      const contentBlocks = Array.isArray(m.content) ? m.content : [];
      let textLen = 0;
      let types: string[] = [];
      for (const block of contentBlocks) {
        if (typeof block === 'string') {
          textLen += block.length;
          types.push('string');
        } else if (block?.type === 'text') {
          textLen += (block.text ?? '').length;
          types.push('text');
        } else if (block?.type === 'toolCall') {
          textLen += JSON.stringify(block.args ?? {}).length;
          types.push(`toolCall:${block.toolName ?? '?'}`);
        } else if (block?.type === 'toolResult') {
          textLen += JSON.stringify(block).length;
          types.push('toolResult');
        } else if (block?.type === 'thinking') {
          textLen += (block.text ?? '').length;
          types.push('thinking');
        } else if (block?.type === 'image') {
          types.push('image');
        } else {
          types.push(block?.type ?? 'unknown');
        }
      }

      // For simple string content (UserMessage shorthand)
      if (typeof m.content === 'string') {
        textLen = m.content.length;
        types = ['string'];
      }

      return {
        index: i,
        role,
        contentTypes: types,
        textLength: textLen,
        stopReason: m.stopReason,
        errorMessage: m.errorMessage,
        isError: m.isError,
        toolName: m.toolName,
        toolCallId: m.toolCallId,
        raw: m,
      };
    });

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const tools: ContextTool[] = (state.tools ?? []).map((t: any) => ({
      name: t.name ?? '?',
      label: t.label ?? '',
      description: t.description ?? '',
    }));

    return {
      systemPrompt: state.systemPrompt ?? '',
      model: state.model?.name ?? state.model?.id ?? 'unknown',
      thinkingLevel: state.thinkingLevel ?? 'off',
      messageCount: messages.length,
      messages,
      tools,
      isStreaming: state.isStreaming ?? false,
    };
  }
}

export interface ContextMessage {
  index: number;
  role: string;
  contentTypes: string[];
  textLength: number;
  stopReason?: string;
  errorMessage?: string;
  isError?: boolean;
  toolName?: string;
  toolCallId?: string;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  raw: any;
}

export interface ContextTool {
  name: string;
  label: string;
  description: string;
}

export interface AgentContextSnapshot {
  systemPrompt: string;
  model: string;
  thinkingLevel: string;
  messageCount: number;
  messages: ContextMessage[];
  tools: ContextTool[];
  isStreaming: boolean;
}
