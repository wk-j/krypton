// Krypton — Claude Code Hook Integration (Futuristic HUD)
// Listens for Claude Code hook events from the backend HTTP server and renders
// futuristic UI: sigil badge, neural uplink bar, decode-animated tool HUD, and
// activity trace seismograph. Event text is not surfaced — it goes to the console.

import { listen } from '@tauri-apps/api/event';
import { invoke } from './profiler/ipc';

import { BackgroundAnimation, FlameAnimation } from './flame';
import { BrainwaveAnimation } from './brainwave';
import { MatrixAnimation } from './matrix';
import { OffscreenAnimationProxy, supportsOffscreenCanvas } from './offscreen-animation';

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

/** Safety net: auto-stop background animation if no hook event arrives for this
 *  long. Prevents orphaned animations when Stop/SessionEnd hooks are dropped
 *  (session crash, abrupt exit, HTTP failure). See docs/0064-matrix-animation-cpu-burn.md. */
const ANIMATION_IDLE_TIMEOUT_MS = 60_000;

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
  private hookPort: number = 0;
  private decodeTimer: ReturnType<typeof setTimeout> | null = null;
  private toolClearTimer: ReturnType<typeof setTimeout> | null = null;
  private animations: Set<BackgroundAnimation> = new Set();
  private animationType: string = 'flame';
  private animationIdleTimer: ReturnType<typeof setTimeout> | null = null;

  async init(): Promise<void> {
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

    // Any hook event while the animation is running resets the idle safety timer.
    // Prevents a stale PreToolUse → …silence… from leaving the animation orphaned.
    if (this.isAnyAnimationRunning()) this.armAnimationIdleTimer();

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
      case 'Stop':
        this.onStop(event);
        break;
      case 'UserPromptSubmit':
        this.onUserPromptSubmit(event);
        break;
      case 'PostToolUseFailure':
        this.onPostToolUseFailure(event);
        break;
      case 'SubagentStart':
        this.onSubagentStart();
        break;
      case 'StopFailure':
        this.onStopFailure();
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
    this.startFlame();
  }

  private onPreToolUse(event: ClaudeHookEvent): void {
    const session = this.getOrCreateSession(event.session_id);
    session.active = true;
    session.currentTool = event.tool_name ?? null;
    session.lastEvent = 'PreToolUse';

    // Ensure animation is running — Stop may have paused it between agentic turns
    this.startFlame();

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
    const hasError = event.tool_response
      && ((event.tool_response as Record<string, unknown>).is_error
        || (event.tool_response as Record<string, unknown>).error);

    if (hasError) {
      this.flashUplinkError();
      this.addActivityTick('error');
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

  private onStop(event: ClaudeHookEvent): void {
    const session = this.sessions.get(event.session_id);
    if (session) {
      // Session is still alive — just waiting for next prompt
      session.currentTool = null;
      session.lastEvent = 'Stop';
    }
    // Stop animation — Claude is idle, waiting for next prompt.
    // Animation restarts on next UserPromptSubmit.
    this.stopFlame();
  }

  private onUserPromptSubmit(event: ClaudeHookEvent): void {
    const session = this.getOrCreateSession(event.session_id);
    session.active = true;
    session.lastEvent = 'UserPromptSubmit';
    this.startFlame();
  }

  private onPostToolUseFailure(event: ClaudeHookEvent): void {
    const session = this.getOrCreateSession(event.session_id);
    session.currentTool = null;
    session.lastEvent = 'PostToolUseFailure';
    this.flashUplinkError();
    this.addActivityTick('error');
  }

  private onSubagentStart(): void {
    this.addActivityTick('edit');
  }

  private onStopFailure(): void {
    this.flashUplinkError();
  }

  private onSessionEnd(event: ClaudeHookEvent): void {
    const session = this.sessions.get(event.session_id);
    if (session) {
      session.active = false;
      session.currentTool = null;
      session.lastEvent = 'SessionEnd';
    }
    this.flashSigilComplete();
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
    const normalized = type === 'brainwave' || type === 'matrix' || type === 'none' ? type : 'flame';
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
    this.armAnimationIdleTimer();
  }

  /** Stop all background animations. */
  private stopFlame(): void {
    for (const anim of this.animations) {
      anim.stop();
    }
    this.clearAnimationIdleTimer();
  }

  private isAnyAnimationRunning(): boolean {
    for (const anim of this.animations) if (anim.isRunning()) return true;
    return false;
  }

  private armAnimationIdleTimer(): void {
    this.clearAnimationIdleTimer();
    this.animationIdleTimer = setTimeout(() => {
      this.animationIdleTimer = null;
      if (!this.isAnyAnimationRunning()) return;
      console.warn(
        `[Krypton] Animation idle timeout (${ANIMATION_IDLE_TIMEOUT_MS / 1000}s) — force stopping to prevent orphaned CPU burn`,
      );
      this.stopFlame();
    }, ANIMATION_IDLE_TIMEOUT_MS);
  }

  private clearAnimationIdleTimer(): void {
    if (this.animationIdleTimer) {
      clearTimeout(this.animationIdleTimer);
      this.animationIdleTimer = null;
    }
  }

  private createAnimationInstance(type: string): BackgroundAnimation {
    // Use OffscreenCanvas worker to avoid main-thread jank during heavy PTY output
    if (supportsOffscreenCanvas()) {
      const anim = type === 'brainwave' ? 'brainwave'
        : type === 'matrix' ? 'matrix'
        : 'flame';
      return new OffscreenAnimationProxy(anim);
    }
    // Fallback to main-thread rendering
    if (type === 'brainwave') return new BrainwaveAnimation();
    if (type === 'matrix') return new MatrixAnimation();
    return new FlameAnimation();
  }
}
