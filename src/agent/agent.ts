// Krypton — AI Agent Controller
// Wraps @mariozechner/pi-agent-core Agent with lazy initialization,
// CWD-aware system prompt, Krypton-specific tool registration,
// and pi-compatible JSONL session persistence.

import { invoke } from '../profiler/ipc';
import { collector } from '../profiler/metrics';
import { createKryptonTools } from './tools';
import {
  createSession,
  continueRecentSession,
  appendMessage,
  loadEntries,
  extractMessages,
  type SessionHandle,
} from './session';
import {
  discoverSkills,
  forceMatchSkill,
  buildSkillPrompt,
  type SkillMeta,
  type SkillMatch,
} from './skills';
import {
  createAfterToolCallHook,
  createTransformContext,
  DEFAULT_SETTINGS as COMPACTION_DEFAULTS,
} from './compaction';

/** Token usage snapshot */
export interface TokenUsage {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  totalTokens: number;
  cost: number;           // total cost in dollars
  contextWindow: number;  // model's max context size
  contextPercent: number; // usage.input / contextWindow (0-100)
}

/** Normalized events emitted to AgentView for rendering */
export type AgentEventType =
  | { type: 'agent_start' }
  | { type: 'agent_end'; usage?: TokenUsage }
  | { type: 'message_update'; delta: string }
  | { type: 'tool_start'; name: string; args: string }
  | { type: 'tool_end'; name: string; isError: boolean; result?: string; diff?: string; filePath?: string }
  | { type: 'usage_update'; usage: TokenUsage }
  | { type: 'message_usage'; outputTokens: number }
  | { type: 'error'; message: string };

export type AgentEventCallback = (e: AgentEventType) => void;

const BASE_SYSTEM_PROMPT = `You are an AI coding assistant embedded in Krypton, a keyboard-driven terminal emulator. You have tools to read files, write files, and run shell commands.

CRITICAL RULE: NEVER use tools unless the user explicitly asks you to do something that requires them. If the user says "hi", "hello", or anything conversational, just respond with text. Do NOT run git commands, read files, check status, or take any action on your own initiative. Wait for the user to give you a specific task.

Be concise and direct. When writing files, prefer small targeted edits over full rewrites. Write the complete file content.`;

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
  private forceNewSession = false;

  // Cumulative token usage across all turns
  private cumulativeUsage: TokenUsage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: 0, contextWindow: 0, contextPercent: 0 };
  private modelContextWindow = 128000;

  // Skills
  private skillIndex: SkillMeta[] = [];
  private skillsDiscovered = false;
  private forcedSkill: string | null = null;
  private lastActiveSkills: string[] = [];


  // Change listeners for real-time context window updates
  private changeListeners: Set<() => void> = new Set();

  get isRunning(): boolean {
    return this.running;
  }

  /** Subscribe to state changes (used by ContextView for live updates). Returns unsubscribe function. */
  onChange(cb: () => void): () => void {
    this.changeListeners.add(cb);
    return () => this.changeListeners.delete(cb);
  }

  private notifyChange(): void {
    for (const cb of this.changeListeners) cb();
  }

  setProjectDir(dir: string | null): void {
    this.projectDir = dir;
  }

  // Optional override for the system prompt (used by inline AI overlay)
  private inlineSystemPrompt: string | null = null;

  /** Override the system prompt for the next prompt call (e.g. for inline AI mode). */
  setInlineSystemPrompt(prompt: string | null): void {
    this.inlineSystemPrompt = prompt;
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private async buildAgent(apiKey: string): Promise<any> {
    const [{ Agent }, { getModel }] = await Promise.all([
      import('@mariozechner/pi-agent-core'),
      import('@mariozechner/pi-ai'),
    ]);

    const model = { ...getModel('zai', 'glm-4.7'), baseUrl: 'https://api.z.ai/api/coding/paas/v4' };
    this.modelContextWindow = model.contextWindow ?? 128000;

    const getApiKey = (provider: string): string | undefined =>
      provider === 'zai' ? apiKey : undefined;

    return new Agent({
      initialState: {
        systemPrompt: this.buildBasePrompt(),
        model,
        tools: createKryptonTools(this.projectDir, this.skillIndex),
      },
      getApiKey,
      toolExecution: 'sequential',
      afterToolCall: createAfterToolCallHook(COMPACTION_DEFAULTS),
      transformContext: createTransformContext(
        model,
        this.modelContextWindow,
        getApiKey,
        COMPACTION_DEFAULTS,
      ),
    });
  }

  // ─── Skills ────────────────────────────────────────────────────────

  /** Discover skills from project skill directories. Called once at init. */
  private async ensureSkillsDiscovered(): Promise<void> {
    if (this.skillsDiscovered || !this.projectDir) return;
    this.skillsDiscovered = true;
    try {
      this.skillIndex = await discoverSkills(this.projectDir);
      if (this.skillIndex.length > 0) {
        console.log('[agent] discovered skills:', this.skillIndex.map((s) => s.name).join(', '));
      }
    } catch (e) {
      console.warn('[agent] skill discovery failed:', e);
    }
  }

  /**
   * Match user input against skills and inject into system prompt. Returns active skill names.
   * When commandArgs is provided, the forced skill is a command and $ARGUMENTS is replaced.
   */
  private async applySkills(_input: string, commandArgs?: string): Promise<string[]> {
    if (!this.agent || this.skillIndex.length === 0) return [];

    let matches: SkillMatch[];
    if (this.forcedSkill) {
      const forced = forceMatchSkill(this.forcedSkill, this.skillIndex);
      matches = forced ? [forced] : [];
      this.forcedSkill = null;
    } else {
      // Skills only activate via explicit /skill or /command invocation — no auto-matching
      matches = [];
    }

    if (matches.length === 0) {
      // Revert to base prompt if no skills match
      this.revertSystemPrompt();
      return [];
    }

    const skillSection = await buildSkillPrompt(matches, commandArgs);
    if (!skillSection) {
      this.revertSystemPrompt();
      return [];
    }

    const basePrompt = this.buildBasePrompt();
    this.agent.setSystemPrompt(basePrompt + skillSection);

    const names = matches.map((m) => m.skill.name);
    console.log('[agent] active skills:', names.join(', '));
    return names;
  }

  /** Revert system prompt to base (no skills). Clear inline override if set. */
  private revertSystemPrompt(): void {
    this.inlineSystemPrompt = null;
    if (this.agent) {
      this.agent.setSystemPrompt(this.buildBasePrompt());
    }
  }

  /** Build the base system prompt, including skill catalog if skills are discovered. */
  private buildBasePrompt(): string {
    // Use inline override if set (for inline AI overlay)
    let prompt = this.inlineSystemPrompt ?? BASE_SYSTEM_PROMPT;
    if (this.projectDir) {
      prompt += `\n\nWorking directory: ${this.projectDir}`;
    }

    // Include skill catalog so the model knows what's available
    if (this.skillIndex.length > 0) {
      const catalog = this.skillIndex.map((s) => {
        const tag = s.isCommand ? ' [command]' : '';
        return `- ${s.name}${tag}: ${s.description}`;
      }).join('\n');
      prompt += `\n\n# Available Skills\n\nThe following skills provide specialized workflows. When a user's request matches a skill, use the activate_skill tool to load its full instructions before proceeding.\n\n${catalog}`;
    }

    return prompt;
  }

  /** Force-activate a skill by name for the next prompt. */
  setForcedSkill(name: string): boolean {
    const found = this.skillIndex.find((s) => s.name === name);
    if (!found) return false;
    this.forcedSkill = name;
    return true;
  }

  /** Get discovered skill metadata for display. */
  getSkills(): SkillMeta[] {
    return this.skillIndex;
  }

  /** Get skill names that were active on the last prompt. */
  getLastActiveSkills(): string[] {
    return this.lastActiveSkills;
  }

  /** Get cumulative token usage for the session. */
  getUsage(): TokenUsage {
    return { ...this.cumulativeUsage };
  }

  /** Get command-type skills (from .claude/commands/) for slash command registration. */
  getCommands(): SkillMeta[] {
    return this.skillIndex.filter((s) => s.isCommand);
  }

  /** Find a command skill by name. */
  findCommand(name: string): SkillMeta | undefined {
    return this.skillIndex.find((s) => s.isCommand && s.name === name);
  }

  // ─── Session ──────────────────────────────────────────────────────

  /** Initialize or continue a session for the current project directory. */
  async initSession(): Promise<void> {
    if (!this.projectDir) return;

    // Discover skills early so /skills works before first prompt
    await this.ensureSkillsDiscovered();

    if (this.session) return;
    try {
      const existing = this.forceNewSession ? null : await continueRecentSession(this.projectDir);
      this.forceNewSession = false;
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

      // Do NOT restore messages into agent LLM context — they are for UI display only.
      // Loading full history would consume thousands of tokens on every prompt.

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

  async prompt(text: string, onEvent: AgentEventCallback, commandArgs?: string): Promise<void> {
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
        // Skip skill discovery and session restore for inline mode (lightweight, disposable)
        if (!this.inlineSystemPrompt) {
          await this.ensureSkillsDiscovered();
        }

        this.agent = await this.buildAgent(apiKey);
        console.log('[agent] initialized, projectDir:', this.projectDir);

        if (!this.inlineSystemPrompt) {
          await this.restoreFromSession();
        }
      } catch (e) {
        console.error('[agent] buildAgent failed:', e);
        onEvent({ type: 'error', message: `Failed to initialize agent: ${e}` });
        return;
      }
    }

    // Skip session and skill matching for inline mode
    if (!this.inlineSystemPrompt) {
      await this.initSession();
      this.lastActiveSkills = await this.applySkills(text, commandArgs);
    } else {
      this.lastActiveSkills = [];
    }

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
          this.notifyChange();
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

          collector.agentPromptEnd(this.cumulativeUsage.output);
          onEvent({ type: 'agent_end', usage: { ...this.cumulativeUsage } });
          this.notifyChange();
          break;
        }

        case 'message_end': {
          // Extract usage from completed assistant message
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const msg = e.message as any;
          if (msg?.usage) {
            const u = msg.usage;
            this.cumulativeUsage.input += u.input ?? 0;
            this.cumulativeUsage.output += u.output ?? 0;
            this.cumulativeUsage.cacheRead += u.cacheRead ?? 0;
            this.cumulativeUsage.cacheWrite += u.cacheWrite ?? 0;
            this.cumulativeUsage.totalTokens += u.totalTokens ?? 0;
            this.cumulativeUsage.cost += u.cost?.total ?? 0;
            // usage.input from the latest response = current context size
            this.cumulativeUsage.contextWindow = this.modelContextWindow;
            this.cumulativeUsage.contextPercent = this.modelContextWindow > 0
              ? Math.round(((u.input ?? 0) / this.modelContextWindow) * 100)
              : 0;
            onEvent({ type: 'usage_update', usage: { ...this.cumulativeUsage } });
            onEvent({ type: 'message_usage', outputTokens: u.output ?? 0 });
          }
          break;
        }

        case 'message_update': {
          // AssistantMessageEvent is a discriminated union; we only care about text_delta
          const ev = e.assistantMessageEvent;
          if (ev?.type === 'text_delta' && typeof ev.delta === 'string') {
            collector.agentFirstToken();
            onEvent({ type: 'message_update', delta: ev.delta });
            this.notifyChange();
          }
          break;
        }

        case 'tool_execution_start':
          onEvent({
            type: 'tool_start',
            name: String(e.toolName ?? ''),
            args: typeof e.args === 'object' ? JSON.stringify(e.args) : String(e.args ?? ''),
          });
          this.notifyChange();
          break;

        case 'tool_execution_end': {
          // result is AgentToolResult<T>; details holds the display string
          const res = e.result as { details?: unknown; diff?: string; filePath?: string; content?: Array<{ type: string; text?: string }> } | undefined;
          const result =
            typeof res?.details === 'string'
              ? res.details
              : res?.content?.find((c) => c.type === 'text')?.text;
          onEvent({
            type: 'tool_end',
            name: String(e.toolName ?? ''),
            isError: Boolean(e.isError),
            result,
            diff: res?.diff,
            filePath: res?.filePath,
          });
          this.notifyChange();
          break;
        }
      }
    });

    try {
      console.log('[agent] calling agent.prompt()');
      collector.agentPromptStart(text);
      await this.agent.prompt(text);
      console.log('[agent] agent.prompt() resolved');
    } catch (e) {
      console.error('[agent] agent.prompt() threw:', e);
      this.running = false;
      onEvent({ type: 'error', message: `Agent error: ${e}` });
    } finally {
      this.unsubscribe?.();
      this.unsubscribe = null;
      // Revert to base prompt after turn (skills are per-turn)
      this.revertSystemPrompt();
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
    this.forceNewSession = true;
    this.skillsDiscovered = false;
    this.skillIndex = [];
    this.forcedSkill = null;
    this.lastActiveSkills = [];
    this.cumulativeUsage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: 0, contextWindow: 0, contextPercent: 0 };

    // Eagerly create the new session file so it exists immediately
    if (this.projectDir) {
      try {
        this.session = await createSession(this.projectDir);
        this.forceNewSession = false;
      } catch (e) {
        console.warn('[agent] reset: failed to create new session, will retry on next prompt:', e);
      }
    }
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
