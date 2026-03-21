// Krypton — Claude Code Hook Integration (Futuristic HUD)
// Listens for Claude Code hook events from the backend HTTP server and renders
// futuristic UI: sigil badge, neural uplink bar, decode-animated tool HUD,
// scan-line toasts, and activity trace seismograph.

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
  private hookPort: number = 0;
  private decodeTimer: ReturnType<typeof setTimeout> | null = null;
  private toolClearTimer: ReturnType<typeof setTimeout> | null = null;

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
    // Window label is driven by xterm.js onTitleChange (OSC 0/2 from Claude Code)
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
  }

  private onPostToolUse(event: ClaudeHookEvent): void {
    const session = this.getOrCreateSession(event.session_id);
    session.currentTool = null;
    session.lastEvent = 'PostToolUse';

    // Check if tool had an error
    if (event.tool_response) {
      const resp = event.tool_response as Record<string, unknown>;
      if (resp.is_error || resp.error) {
        this.flashUplinkError();
        this.addActivityTick('error');
      }
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
      session.active = false;
      session.currentTool = null;
      session.lastEvent = 'Stop';
    }
    // Flash sigil bright then fade to dormant
    this.flashSigilComplete();
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

  // ─── UI: Intercept Toasts (scan-line wipe) ─────────────────────

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

    // Enforce max 3 visible toasts — remove oldest
    const existing = this.toastContainer.querySelectorAll('.krypton-claude-toast');
    if (existing.length >= 3) {
      existing[0].remove();
    }

    this.toastContainer.appendChild(toast);

    // Animate in (triggers scan-line wipe via CSS ::after)
    requestAnimationFrame(() => {
      toast.classList.add('krypton-claude-toast--visible');
    });

    // Auto-dismiss (errors stay until clicked)
    const isError = type === 'error';
    if (isError) {
      toast.style.cursor = 'pointer';
      toast.addEventListener('click', () => {
        toast.classList.remove('krypton-claude-toast--visible');
        setTimeout(() => toast.remove(), 300);
      });
    } else {
      setTimeout(() => {
        toast.classList.remove('krypton-claude-toast--visible');
        setTimeout(() => toast.remove(), 300);
      }, 4000);
    }
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
}
