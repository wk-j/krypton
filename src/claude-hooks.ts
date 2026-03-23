// Krypton — Claude Code Hook Integration (Futuristic HUD)
// Listens for Claude Code hook events from the backend HTTP server and renders
// futuristic UI: sigil badge, neural uplink bar, decode-animated tool HUD,
// scan-line toasts, and activity trace seismograph.

import { listen } from '@tauri-apps/api/event';
import { invoke } from '@tauri-apps/api/core';

import { BackgroundAnimation, FlameAnimation } from './flame';
import { BrainwaveAnimation } from './brainwave';

/** Claude Code hook event payload (emitted by Rust hook server) */
export interface ClaudeHookEvent {
  session_id: string;
  hook_event_name: string;
  cwd?: string;
  permission_mode?: string;
  transcript_path?: string;
  source?: string;
  model?: string;
  // Tool events
  tool_name?: string;
  tool_input?: Record<string, unknown>;
  tool_response?: Record<string, unknown>;
  tool_use_id?: string;
  // Notification
  message?: string;
  title?: string;
  notification_type?: string;
  // Stop / SubagentStop
  last_assistant_message?: string;
  stop_hook_active?: boolean;
  // SubagentStart / SubagentStop
  agent_id?: string;
  agent_type?: string;
  agent_transcript_path?: string;
  // PostToolUseFailure / StopFailure
  error?: string;
  error_details?: string;
  is_interrupt?: boolean;
  // InstructionsLoaded
  file_path?: string;
  memory_type?: string;
  load_reason?: string;
  // UserPromptSubmit
  prompt?: string;
  // TaskCompleted / TeammateIdle
  task_id?: string;
  task_subject?: string;
  task_description?: string;
  teammate_name?: string;
  team_name?: string;
  // ConfigChange
  config_source?: string;
  // WorktreeCreate / WorktreeRemove
  worktree_path?: string;
  name?: string;
  // PreCompact / PostCompact
  trigger?: string;
  custom_instructions?: string;
  compact_summary?: string;
  // Elicitation / ElicitationResult
  mcp_server_name?: string;
  elicitation_id?: string;
  action?: string;
  content?: Record<string, unknown>;
  requested_schema?: Record<string, unknown>;
  // SessionEnd
  reason?: string;
}

/** Tracks active Claude Code sessions per terminal window */
interface ClaudeSession {
  sessionId: string;
  active: boolean;
  currentTool: string | null;
  lastEvent: string;
  /** Stashed shell title to restore when Claude stops */
  originalTitle: string | null;
}

/** Glitch decode character set */
const DECODE_CHARS = '░▒▓█▀▄▌▐─═╌╍┄┅';
const DECODE_FRAMES = 6;
const DECODE_INTERVAL_MS = 30;

/** Activity trace limits */
const MAX_TICKS = 20;
const TICK_FADE_MS = 30_000;

/** High-intensity tool names that speed up the uplink bar */
const FAST_TOOLS = new Set(['Bash', 'Edit', 'Write', 'NotebookEdit']);

/** Map tool names to activity trace tick categories */
function toolTickCategory(toolName: string): string {
  switch (toolName) {
    case 'Edit':
    case 'Write':
    case 'NotebookEdit':
      return 'edit';
    case 'Bash':
      return 'bash';
    case 'Read':
    case 'Glob':
    case 'Grep':
      return 'read';
    default:
      return 'edit';
  }
}

/**
 * ClaudeHookManager — singleton that listens for hook events and drives
 * the futuristic HUD elements across all terminal windows.
 */
export class ClaudeHookManager {
  private sessions: Map<string, ClaudeSession> = new Map();
  private toastContainer: HTMLElement | null = null;
  private toastsEnabled: boolean = true;
  private maxToasts: number = 20;
  private hookPort: number = 0;
  private decodeTimer: ReturnType<typeof setTimeout> | null = null;
  private toolClearTimer: ReturnType<typeof setTimeout> | null = null;
  private animations: Set<BackgroundAnimation> = new Set();
  private animationType: string = 'flame';

  setToastsEnabled(enabled: boolean): void {
    this.toastsEnabled = enabled;
    if (this.toastContainer) {
      this.toastContainer.style.display = enabled ? '' : 'none';
    }
  }

  setMaxToasts(max: number): void {
    this.maxToasts = Math.max(1, max);
    this.trimToasts();
  }

  async init(): Promise<void> {
    // Create toast container first so toasts can be shown during init
    this.toastContainer = document.createElement('div');
    this.toastContainer.className = 'krypton-claude-toasts';
    document.body.appendChild(this.toastContainer);
    console.log('[Krypton] Toast container created:', this.toastContainer);

    // Listen for hook server ready event to get the port
    await listen<number>('claude-hook-server-ready', (event) => {
      this.hookPort = event.payload;
      console.log(`[Krypton] Claude Code hook server on port ${this.hookPort}`);
    });

    // Try to get port immediately (server may have started before us)
    try {
      this.hookPort = await invoke<number>('get_hook_server_port');
      console.log(`[Krypton] Hook server port: ${this.hookPort}`);
    } catch {
      console.log('[Krypton] Hook server not started yet');
    }

    // Listen for hook events
    await listen<ClaudeHookEvent>('claude-hook', (event) => {
      console.log('[Krypton] Hook event received:', event.payload.hook_event_name, event.payload);
      this.handleHookEvent(event.payload);
    });

    console.log('[Krypton] Claude hook manager initialized');
  }

  /** Get the hook server port (0 if not running) */
  getPort(): number {
    return this.hookPort;
  }

  private handleHookEvent(event: ClaudeHookEvent): void {
    const { hook_event_name, session_id } = event;

    switch (hook_event_name) {
      case 'SessionStart':
        this.onSessionStart(event);
        break;
      case 'PreToolUse':
        this.onPreToolUse(event);
        break;
      case 'PostToolUse':
        this.onPostToolUse(event);
        break;
      case 'Notification':
        this.onNotification(event);
        break;
      case 'Stop':
        this.onStop(event);
        break;
      case 'InstructionsLoaded':
        this.onInstructionsLoaded(event);
        break;
      case 'UserPromptSubmit':
        this.onUserPromptSubmit(event);
        break;
      case 'PermissionRequest':
        this.onPermissionRequest(event);
        break;
      case 'PostToolUseFailure':
        this.onPostToolUseFailure(event);
        break;
      case 'SubagentStart':
        this.onSubagentStart(event);
        break;
      case 'SubagentStop':
        this.onSubagentStop(event);
        break;
      case 'StopFailure':
        this.onStopFailure(event);
        break;
      case 'TeammateIdle':
        this.onTeammateIdle(event);
        break;
      case 'TaskCompleted':
        this.onTaskCompleted(event);
        break;
      case 'ConfigChange':
        this.onConfigChange(event);
        break;
      case 'WorktreeCreate':
        this.onWorktreeCreate(event);
        break;
      case 'WorktreeRemove':
        this.onWorktreeRemove(event);
        break;
      case 'PreCompact':
        this.onPreCompact(event);
        break;
      case 'PostCompact':
        this.onPostCompact(event);
        break;
      case 'Elicitation':
        this.onElicitation(event);
        break;
      case 'ElicitationResult':
        this.onElicitationResult(event);
        break;
      case 'SessionEnd':
        this.onSessionEnd(event);
        break;
      default:
        console.log(`[Krypton] Claude hook: ${hook_event_name}`, event);
    }

    this.updateBadges(session_id);
    this.updateUplink();
  }

  private onSessionStart(event: ClaudeHookEvent): void {
    this.sessions.set(event.session_id, {
      sessionId: event.session_id,
      active: true,
      currentTool: null,
      lastEvent: 'SessionStart',
      originalTitle: null,
    });
    const parts: string[] = ['Session started'];
    if (event.source && event.source !== 'startup') parts.push(`(${event.source})`);
    if (event.model) parts.push(`\u2014 ${event.model}`);
    this.showToast(parts.join(' '), 'session');
    this.startFlame();
  }

  private onPreToolUse(event: ClaudeHookEvent): void {
    const session = this.getOrCreateSession(event.session_id);
    session.active = true;
    session.currentTool = event.tool_name ?? null;
    session.lastEvent = 'PreToolUse';

    // Cancel any pending tool-clear so new tool text stays visible
    if (this.toolClearTimer) {
      clearTimeout(this.toolClearTimer);
      this.toolClearTimer = null;
    }

    this.updateToolActivity(event);
    this.addActivityTick(event.tool_name ?? 'unknown');

    const toolName = event.tool_name ?? 'unknown';
    const detail = this.formatToolDetail(event);
    this.showToast(detail ? `${toolName} \u2190 ${detail}` : toolName, 'tool');
  }

  private onPostToolUse(event: ClaudeHookEvent): void {
    const session = this.getOrCreateSession(event.session_id);
    session.currentTool = null;
    session.lastEvent = 'PostToolUse';

    // Check if tool had an error
    const hasError = event.tool_response
      && ((event.tool_response as Record<string, unknown>).is_error
        || (event.tool_response as Record<string, unknown>).error);

    if (hasError) {
      this.flashUplinkError();
      this.addActivityTick('error');
      const toolName = event.tool_name ?? 'unknown';
      this.showToast(`${toolName} failed`, 'error');
    } else {
      const toolName = event.tool_name ?? 'unknown';
      this.showToast(`${toolName} done`, 'tool_done');
    }

    // Hold tool text for 1.5s, then glitch-out — unless a new PreToolUse arrives
    if (this.toolClearTimer) clearTimeout(this.toolClearTimer);
    this.toolClearTimer = setTimeout(() => {
      // Only clear if no tool is currently active
      const anyActive = Array.from(this.sessions.values()).some((s) => s.currentTool !== null);
      if (!anyActive) {
        const toolEls = document.querySelectorAll('.krypton-claude-tool');
        this.clearToolHud(toolEls);
      }
      this.toolClearTimer = null;
    }, 1500);
  }

  private onNotification(event: ClaudeHookEvent): void {
    if (event.message) {
      this.showToast(event.message, event.notification_type);
    }
  }

  private onStop(event: ClaudeHookEvent): void {
    const session = this.sessions.get(event.session_id);
    if (session) {
      // Session is still alive — just waiting for next prompt
      session.currentTool = null;
      session.lastEvent = 'Stop';
    }
    this.showToast('Response complete', 'tool_done');
    // Stop animation — Claude is idle, waiting for next prompt.
    // Animation restarts on next UserPromptSubmit.
    this.stopFlame();
  }

  private onInstructionsLoaded(event: ClaudeHookEvent): void {
    const file = event.file_path ? this.abbreviatePath(event.file_path) : 'config';
    const type = event.memory_type ? ` [${event.memory_type}]` : '';
    const reason = event.load_reason ? ` (${event.load_reason})` : '';
    this.showToast(`${file}${type}${reason}`, 'instructions');
  }

  private onUserPromptSubmit(event: ClaudeHookEvent): void {
    const session = this.getOrCreateSession(event.session_id);
    session.active = true;
    session.lastEvent = 'UserPromptSubmit';
    const preview = event.prompt
      ? (event.prompt.length > 40 ? event.prompt.slice(0, 40) + '\u2026' : event.prompt)
      : 'Prompt submitted';
    this.showToast(preview, 'prompt');
    this.startFlame();
  }

  private onPermissionRequest(event: ClaudeHookEvent): void {
    const toolName = event.tool_name ?? 'unknown';
    const detail = this.formatToolDetail(event);
    this.showToast(detail ? `${toolName} \u2190 ${detail}` : toolName, 'permission_prompt');
  }

  private onPostToolUseFailure(event: ClaudeHookEvent): void {
    const session = this.getOrCreateSession(event.session_id);
    session.currentTool = null;
    session.lastEvent = 'PostToolUseFailure';
    this.flashUplinkError();
    this.addActivityTick('error');
    const toolName = event.tool_name ?? 'unknown';
    const detail = this.formatToolDetail(event);
    const errMsg = event.error ? ` \u2014 ${event.error}` : '';
    const target = detail ? ` \u2190 ${detail}` : '';
    this.showToast(`${toolName}${target}${errMsg}`, 'error');
  }

  private onSubagentStart(event: ClaudeHookEvent): void {
    const agentType = event.agent_type ?? 'subagent';
    const agentId = event.agent_id ? ` (${event.agent_id.slice(0, 8)})` : '';
    this.showToast(`Spawned ${agentType}${agentId}`, 'subagent');
    this.addActivityTick('edit');
  }

  private onSubagentStop(event: ClaudeHookEvent): void {
    const agentType = event.agent_type ?? 'subagent';
    const agentId = event.agent_id ? ` (${event.agent_id.slice(0, 8)})` : '';
    this.showToast(`${agentType}${agentId} finished`, 'subagent_done');
  }

  private onStopFailure(event: ClaudeHookEvent): void {
    const errType = event.error ?? 'unknown';
    const detail = event.error_details ? ` \u2014 ${event.error_details}` : '';
    this.flashUplinkError();
    this.showToast(`${errType}${detail}`, 'error');
  }

  private onTeammateIdle(event: ClaudeHookEvent): void {
    const name = event.teammate_name ?? 'Teammate';
    const team = event.team_name ? ` [${event.team_name}]` : '';
    this.showToast(`${name} idle${team}`, 'teammate');
  }

  private onTaskCompleted(event: ClaudeHookEvent): void {
    const subject = event.task_subject ?? 'Task';
    const owner = event.teammate_name ? ` (${event.teammate_name})` : '';
    this.showToast(`\u2713 ${subject}${owner}`, 'task');
  }

  private onConfigChange(event: ClaudeHookEvent): void {
    const source = event.config_source ?? event.source ?? 'config';
    const file = event.file_path ? ` \u2190 ${this.abbreviatePath(event.file_path)}` : '';
    this.showToast(`${source}${file}`, 'config');
  }

  private onWorktreeCreate(event: ClaudeHookEvent): void {
    const label = event.name ?? (event.worktree_path ? this.abbreviatePath(event.worktree_path) : 'worktree');
    this.showToast(`Created ${label}`, 'worktree');
  }

  private onWorktreeRemove(event: ClaudeHookEvent): void {
    const path = event.worktree_path ? this.abbreviatePath(event.worktree_path) : 'worktree';
    this.showToast(`Removed ${path}`, 'worktree');
  }

  private onPreCompact(event: ClaudeHookEvent): void {
    const trigger = event.trigger ? ` (${event.trigger})` : '';
    this.showToast(`Compacting context\u2026${trigger}`, 'compact');
  }

  private onPostCompact(event: ClaudeHookEvent): void {
    const summary = event.compact_summary
      ? (event.compact_summary.length > 50 ? event.compact_summary.slice(0, 50) + '\u2026' : event.compact_summary)
      : 'Context compacted';
    this.showToast(summary, 'compact');
  }

  private onElicitation(event: ClaudeHookEvent): void {
    const server = event.mcp_server_name ?? 'MCP';
    const msg = event.message
      ? (event.message.length > 40 ? event.message.slice(0, 40) + '\u2026' : event.message)
      : 'input requested';
    this.showToast(`${server}: ${msg}`, 'elicitation');
  }

  private onElicitationResult(event: ClaudeHookEvent): void {
    const server = event.mcp_server_name ?? 'MCP';
    const action = event.action ?? 'responded';
    this.showToast(`${server}: ${action}`, 'elicitation');
  }

  private onSessionEnd(event: ClaudeHookEvent): void {
    const session = this.sessions.get(event.session_id);
    if (session) {
      session.active = false;
      session.currentTool = null;
      session.lastEvent = 'SessionEnd';
    }
    this.flashSigilComplete();
    const reason = event.reason ? ` (${event.reason})` : '';
    this.showToast(`Session ended${reason}`, 'stop');
    this.stopFlame();
  }

  private getOrCreateSession(sessionId: string): ClaudeSession {
    let session = this.sessions.get(sessionId);
    if (!session) {
      session = {
        sessionId,
        active: true,
        currentTool: null,
        lastEvent: '',
        originalTitle: null,
      };
      this.sessions.set(sessionId, session);
    }
    return session;
  }

  // ─── UI: Sigil Badge ────────────────────────────────────────────

  private updateBadges(_claudeSessionId: string): void {
    const badges = document.querySelectorAll('.krypton-claude-badge');
    const hasActive = Array.from(this.sessions.values()).some((s) => s.active);
    const hasTool = Array.from(this.sessions.values()).some((s) => s.currentTool !== null);

    badges.forEach((badge) => {
      badge.classList.toggle('krypton-claude-badge--active', hasActive);
      badge.classList.toggle('krypton-claude-badge--working', hasTool);
    });
  }

  /** Brief bright flash on Stop, then fade to dormant */
  private flashSigilComplete(): void {
    const badges = document.querySelectorAll('.krypton-claude-badge');
    badges.forEach((badge) => {
      badge.classList.add('krypton-claude-badge--active');
      badge.classList.remove('krypton-claude-badge--working');
      setTimeout(() => {
        const hasActive = Array.from(this.sessions.values()).some((s) => s.active);
        if (!hasActive) {
          badge.classList.remove('krypton-claude-badge--active');
        }
      }, 2000);
    });
  }

  // ─── UI: Neural Uplink Bar ──────────────────────────────────────

  private updateUplink(): void {
    const bars = document.querySelectorAll('.krypton-uplink');
    const hasActive = Array.from(this.sessions.values()).some((s) => s.active);
    const hasTool = Array.from(this.sessions.values()).some((s) => s.currentTool !== null);
    const isFast = Array.from(this.sessions.values()).some(
      (s) => s.currentTool !== null && FAST_TOOLS.has(s.currentTool)
    );

    bars.forEach((bar) => {
      bar.classList.remove('krypton-uplink--active', 'krypton-uplink--working', 'krypton-uplink--fast', 'krypton-uplink--error');
      if (hasTool) {
        bar.classList.add('krypton-uplink--working');
        if (isFast) bar.classList.add('krypton-uplink--fast');
      } else if (hasActive) {
        bar.classList.add('krypton-uplink--active');
      }
    });
  }

  private flashUplinkError(): void {
    const bars = document.querySelectorAll('.krypton-uplink');
    bars.forEach((bar) => {
      bar.classList.remove('krypton-uplink--active', 'krypton-uplink--working', 'krypton-uplink--fast');
      bar.classList.add('krypton-uplink--error');
      setTimeout(() => {
        bar.classList.remove('krypton-uplink--error');
        this.updateUplink();
      }, 600);
    });
  }

  // ─── UI: Tool Execution HUD (decode animation) ─────────────────

  private updateToolActivity(event: ClaudeHookEvent): void {
    const toolEls = document.querySelectorAll('.krypton-claude-tool');
    const toolName = event.tool_name ?? '';
    let detail = '';

    if (event.tool_input && typeof event.tool_input === 'object') {
      const input = event.tool_input as Record<string, unknown>;
      if (input.file_path && typeof input.file_path === 'string') {
        detail = this.abbreviatePath(input.file_path);
      } else if (input.command && typeof input.command === 'string') {
        const cmd = input.command as string;
        detail = cmd.length > 30 ? cmd.slice(0, 30) + '\u2026' : cmd;
      } else if (input.pattern && typeof input.pattern === 'string') {
        detail = input.pattern as string;
      }
    }

    const finalText = detail ? `\u25B8 ${toolName} \u2190 ${detail}` : `\u25B8 ${toolName}`;
    this.runDecodeAnimation(toolEls, finalText);

    // Fallback clear after 10s if PostToolUse never arrives
    setTimeout(() => {
      const session = this.sessions.get(event.session_id);
      if (session && !session.currentTool) {
        this.clearToolHud(toolEls);
      }
    }, 10000);
  }

  /** Animate text decoding: random glitch chars → real text */
  private runDecodeAnimation(elements: NodeListOf<Element>, finalText: string): void {
    // Cancel any in-progress decode
    if (this.decodeTimer) {
      clearTimeout(this.decodeTimer);
      this.decodeTimer = null;
    }

    let frame = 0;
    elements.forEach((el) => {
      el.classList.add('krypton-claude-tool--decoding');
      el.classList.add('krypton-claude-tool--visible');
    });

    const step = (): void => {
      frame++;
      if (frame >= DECODE_FRAMES) {
        // Final: show real text
        elements.forEach((el) => {
          el.textContent = finalText;
          el.classList.remove('krypton-claude-tool--decoding');
        });
        this.decodeTimer = null;
        return;
      }

      // Generate garbled text same length as final
      const garbled = Array.from(finalText)
        .map((ch) => {
          if (ch === ' ') return ' ';
          // Increase chance of correct char as frames progress
          if (Math.random() < frame / DECODE_FRAMES) return ch;
          return DECODE_CHARS[Math.floor(Math.random() * DECODE_CHARS.length)];
        })
        .join('');

      elements.forEach((el) => {
        el.textContent = garbled;
      });

      this.decodeTimer = setTimeout(step, DECODE_INTERVAL_MS);
    };

    step();
  }

  /** Clear tool HUD with a quick glitch-out */
  private clearToolHud(elements: NodeListOf<Element>): void {
    // Quick reverse garble (2 frames) then hide
    const currentText = (elements[0] as HTMLElement)?.textContent ?? '';
    if (!currentText) return;

    let frame = 0;
    const garbleOut = (): void => {
      frame++;
      if (frame > 2) {
        elements.forEach((el) => {
          el.textContent = '';
          el.classList.remove('krypton-claude-tool--visible', 'krypton-claude-tool--decoding');
        });
        return;
      }
      const garbled = Array.from(currentText)
        .map((ch) => {
          if (ch === ' ') return ' ';
          if (Math.random() < 0.4) return DECODE_CHARS[Math.floor(Math.random() * DECODE_CHARS.length)];
          return ch;
        })
        .join('');
      elements.forEach((el) => {
        el.textContent = garbled;
        el.classList.add('krypton-claude-tool--decoding');
      });
      setTimeout(garbleOut, DECODE_INTERVAL_MS);
    };
    garbleOut();
  }

  // ─── UI: Intercept Toasts (persistent stack, click to dismiss) ─

  /** Label text per event type */
  private static TOAST_LABELS: Record<string, string> = {
    session: 'SESSION',
    tool: 'TOOL',
    tool_done: 'DONE',
    notification: 'CLAUDE',
    permission_prompt: '⚡ PERMIT',
    error: 'ERROR',
    success: 'OK',
    stop: 'STOP',
    instructions: 'LOAD',
    prompt: 'PROMPT',
    subagent: 'AGENT',
    subagent_done: 'AGENT',
    teammate: 'TEAM',
    task: 'TASK',
    config: 'CONFIG',
    worktree: 'TREE',
    compact: 'COMPACT',
    elicitation: 'INPUT',
  };

  /** Show a toast programmatically (for testing or startup messages) */
  public toast(message: string, type?: string): void {
    this.showToast(message, type);
  }

  private showToast(message: string, type?: string): void {
    if (!this.toastContainer || !this.toastsEnabled) return;

    const toastType = type ?? 'notification';

    const toast = document.createElement('div');
    toast.className = 'krypton-claude-toast';
    toast.classList.add(`krypton-claude-toast--${toastType}`);

    const label = document.createElement('span');
    label.className = 'krypton-claude-toast__label';
    label.textContent = ClaudeHookManager.TOAST_LABELS[toastType] ?? 'CLAUDE';

    const text = document.createElement('span');
    text.className = 'krypton-claude-toast__text';
    text.textContent = message;

    toast.appendChild(label);
    toast.appendChild(text);

    // Prepend so newest toast is at the bottom (closest to the corner)
    this.toastContainer.prepend(toast);

    // Animate in
    requestAnimationFrame(() => {
      toast.classList.add('krypton-claude-toast--visible');
    });

    // Click anywhere to dismiss
    toast.addEventListener('click', () => {
      toast.classList.remove('krypton-claude-toast--visible');
      setTimeout(() => toast.remove(), 300);
    });

    // Enforce max visible toasts
    this.trimToasts();
  }

  /** Remove oldest toasts that exceed maxToasts limit */
  private trimToasts(): void {
    if (!this.toastContainer) return;
    const toasts = this.toastContainer.querySelectorAll('.krypton-claude-toast');
    // Container is prepend-ordered (newest first), so oldest are at the end
    for (let i = this.maxToasts; i < toasts.length; i++) {
      const old = toasts[i] as HTMLElement;
      old.classList.remove('krypton-claude-toast--visible');
      setTimeout(() => old.remove(), 300);
    }
  }

  /** Format tool detail string from event input */
  private formatToolDetail(event: ClaudeHookEvent): string {
    if (!event.tool_input || typeof event.tool_input !== 'object') return '';
    const input = event.tool_input as Record<string, unknown>;
    if (input.file_path && typeof input.file_path === 'string') {
      return this.abbreviatePath(input.file_path);
    }
    if (input.command && typeof input.command === 'string') {
      const cmd = input.command as string;
      return cmd.length > 30 ? cmd.slice(0, 30) + '\u2026' : cmd;
    }
    if (input.pattern && typeof input.pattern === 'string') {
      return input.pattern as string;
    }
    return '';
  }

  // ─── UI: Activity Trace (seismograph) ──────────────────────────

  private addActivityTick(toolOrCategory: string): void {
    const traces = document.querySelectorAll('.krypton-activity-trace');
    const category = toolOrCategory === 'error' ? 'error' : toolTickCategory(toolOrCategory);

    traces.forEach((trace) => {
      // Enforce max ticks
      const ticks = trace.querySelectorAll('.krypton-activity-trace__tick');
      if (ticks.length >= MAX_TICKS) {
        ticks[ticks.length - 1].remove(); // oldest is at end in column-reverse
      }

      const tick = document.createElement('div');
      tick.className = `krypton-activity-trace__tick krypton-activity-trace__tick--${category}`;
      trace.appendChild(tick);

      // Fade out over TICK_FADE_MS then remove
      requestAnimationFrame(() => {
        tick.style.transition = `opacity ${TICK_FADE_MS}ms linear`;
        tick.style.opacity = '0';
      });
      setTimeout(() => tick.remove(), TICK_FADE_MS + 100);
    });
  }

  // ─── Helpers ───────────────────────────────────────────────────

  private abbreviatePath(fullPath: string): string {
    let p = fullPath;
    const homeMatch = p.match(/^(\/Users\/[^/]+|\/home\/[^/]+)/);
    if (homeMatch) {
      p = '~' + p.slice(homeMatch[1].length);
    }
    const parts = p.split('/').filter(Boolean);
    if (parts.length > 3) {
      const prefix = p.startsWith('~') ? '' : '/';
      p = `${prefix}${parts[0]}/.../` + parts.slice(-2).join('/');
    }
    if (p.length > 35) {
      p = '\u2026' + p.slice(p.length - 32);
    }
    return p;
  }

  // ─── Public: DOM Element Creators ──────────────────────────────

  /**
   * Transform terminal titles (OSC 0/2) into cyberpunk HUD labels.
   * Claude Code sets titles like "NEW CODING SESSION", "Thinking...",
   * "Task completed" — restyle them for the Krypton aesthetic.
   * Normal shell titles pass through unchanged.
   */
  formatTerminalTitle(title: string): string {
    const upper = title.toUpperCase().trim();

    const rewrites: Record<string, string> = {
      'NEW CODING SESSION': '\u25C8 neural_link // online',
      'THINKING...': '\u25C8 inference // active',
      'TASK COMPLETED': '\u25C8 signal_end // done',
      'WAITING FOR INPUT': '\u25C8 awaiting_input',
      'CLAUDE CODE': '\u25C8 neural_uplink',
    };

    if (rewrites[upper]) return rewrites[upper];

    if (upper.includes('CLAUDE')) {
      return `\u25C8 ${title.toLowerCase().replace(/\s+/g, '_')}`;
    }

    return title;
  }

  /** Create a sigil badge (◈) element for a window titlebar. */
  createBadge(): HTMLElement {
    const badge = document.createElement('div');
    badge.className = 'krypton-claude-badge';
    badge.title = 'Claude Code';
    badge.textContent = '\u25C8'; // ◈ diamond sigil
    return badge;
  }

  /** Create a tool activity HUD element for the titlebar. */
  createToolIndicator(): HTMLElement {
    const el = document.createElement('span');
    el.className = 'krypton-claude-tool';
    return el;
  }

  /** Create a neural uplink bar element for inside a window content area. */
  createUplinkBar(): HTMLElement {
    const bar = document.createElement('div');
    bar.className = 'krypton-uplink';
    return bar;
  }

  /** Create an activity trace element for inside a window content area. */
  createActivityTrace(): HTMLElement {
    const trace = document.createElement('div');
    trace.className = 'krypton-activity-trace';
    return trace;
  }

  /** Set the animation type ("flame", "brainwave", or "none"). */
  setAnimationType(type: string): void {
    const normalized = type === 'brainwave' || type === 'none' ? type : 'flame';
    if (normalized === this.animationType) return;

    const wasActive = Array.from(this.animations).some((a) => a.isRunning());

    // Collect parent elements before disposing
    const parents: HTMLElement[] = [];
    for (const anim of this.animations) {
      const parent = anim.getElement().parentElement;
      if (parent) parents.push(parent);
      anim.dispose();
    }
    this.animations.clear();

    // Re-create with new type
    if (normalized !== 'none') {
      for (const parent of parents) {
        const replacement = this.createAnimationInstance(normalized);
        parent.insertBefore(replacement.getElement(), parent.firstChild);
        this.animations.add(replacement);
        if (wasActive) replacement.start();
      }
    }

    this.animationType = normalized;
  }

  /** Create a background animation canvas for a window content area. */
  createAnimationCanvas(): HTMLCanvasElement | null {
    if (this.animationType === 'none') return null;
    const anim = this.createAnimationInstance(this.animationType);
    this.animations.add(anim);
    return anim.getElement();
  }

  /** Remove an animation instance when its window is destroyed. */
  disposeAnimation(canvas: HTMLCanvasElement): void {
    for (const anim of this.animations) {
      if (anim.getElement() === canvas) {
        anim.dispose();
        this.animations.delete(anim);
        return;
      }
    }
  }

  /** Resize all animation canvases (call after window relayout). */
  resizeAnimations(): void {
    for (const anim of this.animations) {
      if (anim.isRunning()) {
        anim.resize();
      }
    }
  }

  /** Start all background animations. */
  private startFlame(): void {
    for (const anim of this.animations) {
      anim.start();
    }
  }

  /** Stop all background animations. */
  private stopFlame(): void {
    for (const anim of this.animations) {
      anim.stop();
    }
  }

  private createAnimationInstance(type: string): BackgroundAnimation {
    return type === 'brainwave' ? new BrainwaveAnimation() : new FlameAnimation();
  }
}
