// Krypton — AI Agent Controller
// Wraps @mariozechner/pi-agent-core Agent with lazy initialization,
// CWD-aware system prompt, and Krypton-specific tool registration.

import { invoke } from '@tauri-apps/api/core';
import { kryptonTools } from './tools';

/** Normalized events emitted to AgentView for rendering */
export type AgentEventType =
  | { type: 'agent_start' }
  | { type: 'agent_end' }
  | { type: 'message_update'; delta: string }
  | { type: 'tool_start'; name: string; args: string }
  | { type: 'tool_end'; name: string; isError: boolean }
  | { type: 'error'; message: string };

export type AgentEventCallback = (e: AgentEventType) => void;

const BASE_SYSTEM_PROMPT = `You are an AI coding assistant embedded in Krypton, a keyboard-driven terminal emulator. You have tools to read files, write files, and run shell commands.

Be concise and direct. Prefer small targeted edits over full rewrites. When writing files, write the complete file content.`;

export class AgentController {
  // Lazy-initialized pi-agent-core Agent instance
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private agent: any = null;
  private lastCwd: string | null = null;
  private running = false;
  private unsubscribe: (() => void) | null = null;

  get isRunning(): boolean {
    return this.running;
  }

  setLastCwd(cwd: string): void {
    this.lastCwd = cwd;
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private async buildAgent(apiKey: string): Promise<any> {
    const [{ Agent }, { getModel }] = await Promise.all([
      import('@mariozechner/pi-agent-core'),
      import('@mariozechner/pi-ai'),
    ]);

    const systemPrompt = this.lastCwd
      ? `${BASE_SYSTEM_PROMPT}\n\nWorking directory: ${this.lastCwd}`
      : BASE_SYSTEM_PROMPT;

    return new Agent({
      initialState: {
        systemPrompt,
        // 'claude-sonnet-4-6' is the latest Claude Sonnet available in pi-ai
        model: getModel('anthropic', 'claude-sonnet-4-6'),
        tools: kryptonTools,
      },
      getApiKey: (provider: string) => (provider === 'anthropic' ? apiKey : undefined),
      toolExecution: 'sequential',
    });
  }

  async prompt(text: string, onEvent: AgentEventCallback): Promise<void> {
    if (this.running) return;

    // Lazy init — read API key from the shell environment
    if (!this.agent) {
      const apiKey = await invoke<string | null>('get_env_var', { name: 'ANTHROPIC_API_KEY' });
      if (!apiKey) {
        onEvent({
          type: 'error',
          message: 'ANTHROPIC_API_KEY not set.\nAdd it to your shell environment and restart Krypton.',
        });
        return;
      }

      try {
        this.agent = await this.buildAgent(apiKey);
      } catch (e) {
        onEvent({ type: 'error', message: `Failed to initialize agent: ${e}` });
        return;
      }
    }

    // Subscribe to events and map to our simplified AgentEventType
    this.unsubscribe = this.agent.subscribe((raw: unknown) => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const e = raw as any;
      switch (e.type) {
        case 'agent_start':
          this.running = true;
          onEvent({ type: 'agent_start' });
          break;

        case 'agent_end':
          this.running = false;
          onEvent({ type: 'agent_end' });
          break;

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

        case 'tool_execution_end':
          onEvent({
            type: 'tool_end',
            name: String(e.toolName ?? ''),
            isError: Boolean(e.isError),
          });
          break;
      }
    });

    try {
      await this.agent.prompt(text);
    } catch (e) {
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

  reset(): void {
    this.abort();
    this.agent?.clearMessages?.();
    this.agent = null; // force re-init on next prompt (picks up new CWD)
  }
}
