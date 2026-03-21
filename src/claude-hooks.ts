// Krypton — Claude Code Hook Integration
// Listens for Claude Code hook events from the backend HTTP server and renders
// status indicators, notifications, and tool activity in the terminal chrome.

import { listen } from '@tauri-apps/api/event';
import { invoke } from '@tauri-apps/api/core';

/** Claude Code hook event payload (emitted by Rust hook server) */
export interface ClaudeHookEvent {
  session_id: string;
  hook_event_name: string;
  cwd?: string;
  permission_mode?: string;
  tool_name?: string;
  tool_input?: Record<string, unknown>;
  tool_response?: Record<string, unknown>;
  message?: string;
  title?: string;
  notification_type?: string;
  last_assistant_message?: string;
}

/** Tracks active Claude Code sessions per terminal window */
interface ClaudeSession {
  sessionId: string;
  active: boolean;
  currentTool: string | null;
  lastEvent: string;
}

/**
 * ClaudeHookManager — singleton that listens for hook events and drives UI.
 * Attach to window chrome elements after compositor creates them.
 */
export class ClaudeHookManager {
  private sessions: Map<string, ClaudeSession> = new Map();
  private toastContainer: HTMLElement | null = null;
  private hookPort: number = 0;

  async init(): Promise<void> {
    // Listen for hook server ready event to get the port
    await listen<number>('claude-hook-server-ready', (event) => {
      this.hookPort = event.payload;
      console.log(`[Krypton] Claude Code hook server on port ${this.hookPort}`);
    });

    // Try to get port immediately (server may have started before us)
    try {
      this.hookPort = await invoke<number>('get_hook_server_port');
    } catch {
      // Server not started yet, will get port from event
    }

    // Listen for hook events
    await listen<ClaudeHookEvent>('claude-hook', (event) => {
      this.handleHookEvent(event.payload);
    });

    // Create toast container
    this.toastContainer = document.createElement('div');
    this.toastContainer.className = 'krypton-claude-toasts';
    document.body.appendChild(this.toastContainer);
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
      default:
        console.log(`[Krypton] Claude hook: ${hook_event_name}`, event);
    }

    // Update badges on all matching windows
    this.updateBadges(session_id);
  }

  private onSessionStart(event: ClaudeHookEvent): void {
    this.sessions.set(event.session_id, {
      sessionId: event.session_id,
      active: true,
      currentTool: null,
      lastEvent: 'SessionStart',
    });
  }

  private onPreToolUse(event: ClaudeHookEvent): void {
    const session = this.getOrCreateSession(event.session_id);
    session.active = true;
    session.currentTool = event.tool_name ?? null;
    session.lastEvent = 'PreToolUse';

    // Update tool activity text in matching window titlebars
    this.updateToolActivity(event);
  }

  private onPostToolUse(event: ClaudeHookEvent): void {
    const session = this.getOrCreateSession(event.session_id);
    session.currentTool = null;
    session.lastEvent = 'PostToolUse';
  }

  private onNotification(event: ClaudeHookEvent): void {
    if (event.message) {
      this.showToast(event.message, event.notification_type);
    }
  }

  private onStop(event: ClaudeHookEvent): void {
    const session = this.sessions.get(event.session_id);
    if (session) {
      session.active = false;
      session.currentTool = null;
      session.lastEvent = 'Stop';
    }
  }

  private getOrCreateSession(sessionId: string): ClaudeSession {
    let session = this.sessions.get(sessionId);
    if (!session) {
      session = {
        sessionId,
        active: true,
        currentTool: null,
        lastEvent: '',
      };
      this.sessions.set(sessionId, session);
    }
    return session;
  }

  // ─── UI Updates ──────────────────────────────────────────────────

  /** Update all Claude badges on window titlebars */
  private updateBadges(_claudeSessionId: string): void {
    const badges = document.querySelectorAll('.krypton-claude-badge');
    const hasActive = Array.from(this.sessions.values()).some((s) => s.active);

    badges.forEach((badge) => {
      badge.classList.toggle('krypton-claude-badge--active', hasActive);
      const hasTool = Array.from(this.sessions.values()).some((s) => s.currentTool !== null);
      badge.classList.toggle('krypton-claude-badge--working', hasTool);
    });
  }

  /** Update tool activity text in titlebars */
  private updateToolActivity(event: ClaudeHookEvent): void {
    const toolTexts = document.querySelectorAll('.krypton-claude-tool');
    const toolName = event.tool_name ?? '';
    let detail = '';

    if (event.tool_input && typeof event.tool_input === 'object') {
      // Show file path for file-related tools
      const input = event.tool_input as Record<string, unknown>;
      if (input.file_path && typeof input.file_path === 'string') {
        detail = `: ${this.abbreviatePath(input.file_path)}`;
      } else if (input.command && typeof input.command === 'string') {
        const cmd = input.command as string;
        detail = `: ${cmd.length > 30 ? cmd.slice(0, 30) + '...' : cmd}`;
      } else if (input.pattern && typeof input.pattern === 'string') {
        detail = `: ${input.pattern}`;
      }
    }

    toolTexts.forEach((el) => {
      el.textContent = `${toolName}${detail}`;
      el.classList.add('krypton-claude-tool--visible');
    });

    // Clear after PostToolUse (handled via timeout as fallback)
    setTimeout(() => {
      const session = this.sessions.get(event.session_id);
      if (session && !session.currentTool) {
        toolTexts.forEach((el) => {
          el.textContent = '';
          el.classList.remove('krypton-claude-tool--visible');
        });
      }
    }, 10000);
  }

  /** Show a notification toast */
  private showToast(message: string, type?: string): void {
    if (!this.toastContainer) return;

    const toast = document.createElement('div');
    toast.className = 'krypton-claude-toast';
    if (type) {
      toast.classList.add(`krypton-claude-toast--${type}`);
    }

    const label = document.createElement('span');
    label.className = 'krypton-claude-toast__label';
    label.textContent = 'CLAUDE';

    const text = document.createElement('span');
    text.className = 'krypton-claude-toast__text';
    text.textContent = message;

    toast.appendChild(label);
    toast.appendChild(text);
    this.toastContainer.appendChild(toast);

    // Animate in
    requestAnimationFrame(() => {
      toast.classList.add('krypton-claude-toast--visible');
    });

    // Auto-dismiss
    setTimeout(() => {
      toast.classList.remove('krypton-claude-toast--visible');
      setTimeout(() => toast.remove(), 300);
    }, 3000);
  }

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
      p = '...' + p.slice(p.length - 32);
    }
    return p;
  }

  // ─── Public: DOM Element Creators ────────────────────────────────

  /**
   * Create a Claude badge element to insert into a window titlebar.
   * Call this from compositor when building window chrome.
   */
  createBadge(): HTMLElement {
    const badge = document.createElement('div');
    badge.className = 'krypton-claude-badge';
    badge.title = 'Claude Code';
    badge.textContent = '\u2726'; // sparkle character
    return badge;
  }

  /**
   * Create a tool activity text element for the titlebar.
   */
  createToolIndicator(): HTMLElement {
    const el = document.createElement('span');
    el.className = 'krypton-claude-tool';
    return el;
  }
}
