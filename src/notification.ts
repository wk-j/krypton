// Krypton — Futuristic Notification Overlay
// Bottom-right text animation overlay with glitch-decode reveal and OSC detection.
// Captures OSC 9/777/99 from terminal apps and provides a programmatic API.

import type { Terminal } from '@xterm/xterm';

/** Notification severity / visual style */
export type NotificationLevel = 'info' | 'success' | 'warning' | 'error' | 'system';

/** Options for creating a notification */
export interface NotificationOptions {
  message: string;
  level?: NotificationLevel;
  /** Label prefix (e.g. 'SYSTEM', 'ALERT'). Auto-derived from level if omitted */
  label?: string;
  /** Duration in ms before auto-dismiss. 0 = manual dismiss only. Default: 4000 */
  duration?: number;
  /** Whether to use the decode (glitch) text reveal. Default: true */
  decode?: boolean;
}

// ── Constants ──────────────────────────────────────────────────────────

const GLYPH_SET = '░▒▓█▀▄▌▐─═╌╍┄┅⟋⟍⧸⧹';
const DECODE_FPS = 35;
const DECODE_PASSES = 5;
const DECODE_WAVE_DELAY = 0.6;

const MAX_VISIBLE = 6;
const DEFAULT_DURATION = 4000;
const MAX_MESSAGE_LEN = 256;
const KITTY_TITLE_TIMEOUT_MS = 500;

const LEVEL_LABELS: Record<NotificationLevel, string> = {
  info: 'INFO',
  success: 'OK',
  warning: 'WARN',
  error: 'ERROR',
  system: 'SYS',
};

// ── Controller ─────────────────────────────────────────────────────────

export class NotificationController {
  private container: HTMLElement;
  private queue: HTMLElement[] = [];
  private pendingKitty = new Map<string, { title: string; timer: number }>();

  constructor() {
    this.container = document.createElement('div');
    this.container.className = 'krypton-notif';
    // Mount on body so notifications float above all windows including Quick Terminal
    document.body.appendChild(this.container);
  }

  /** Reposition the notification container to align with a given element's bounds.
   *  Called on focus change so notifications appear anchored to the active window. */
  alignTo(element: HTMLElement): void {
    const rect = element.getBoundingClientRect();
    this.container.style.bottom = `${window.innerHeight - rect.bottom + 12}px`;
    this.container.style.right = `${window.innerWidth - rect.right + 12}px`;
  }

  // ── Public API ─────────────────────────────────────────────────────

  /** Push a new notification */
  show(opts: NotificationOptions): void {
    const level = opts.level ?? 'info';
    const label = opts.label ?? LEVEL_LABELS[level];
    const duration = opts.duration ?? DEFAULT_DURATION;
    const useDecode = opts.decode !== false;
    const message = opts.message.slice(0, MAX_MESSAGE_LEN);

    if (!message && !label) return;

    const el = document.createElement('div');
    el.className = `krypton-notif__item krypton-notif__item--${level}`;

    // Left accent bar
    const bar = document.createElement('div');
    bar.className = 'krypton-notif__bar';
    el.appendChild(bar);

    // Label badge
    const badge = document.createElement('span');
    badge.className = 'krypton-notif__label';
    badge.textContent = label;
    el.appendChild(badge);

    // Message text
    const msg = document.createElement('span');
    msg.className = 'krypton-notif__msg';
    msg.textContent = useDecode ? '' : message;
    el.appendChild(msg);

    // Timer progress bar
    if (duration > 0) {
      const timer = document.createElement('div');
      timer.className = 'krypton-notif__timer';
      timer.style.animationDuration = `${duration}ms`;
      el.appendChild(timer);
    }

    // Insert (prepend so newest is at visual bottom via column-reverse)
    this.container.prepend(el);
    this.queue.push(el);

    // Animate in
    requestAnimationFrame(() => {
      el.classList.add('krypton-notif__item--enter');
    });

    // Decode text animation
    if (useDecode && message) {
      this.decodeReveal(msg, message);
    }

    // Click to dismiss
    el.addEventListener('click', () => this.dismiss(el));

    // Auto-dismiss
    if (duration > 0) {
      setTimeout(() => this.dismiss(el), duration);
    }

    this.trim();
  }

  info(message: string, opts?: Partial<NotificationOptions>): void {
    this.show({ message, level: 'info', ...opts });
  }

  success(message: string, opts?: Partial<NotificationOptions>): void {
    this.show({ message, level: 'success', ...opts });
  }

  warn(message: string, opts?: Partial<NotificationOptions>): void {
    this.show({ message, level: 'warning', ...opts });
  }

  error(message: string, opts?: Partial<NotificationOptions>): void {
    this.show({ message, level: 'error', ...opts });
  }

  system(message: string, opts?: Partial<NotificationOptions>): void {
    this.show({ message, level: 'system', ...opts });
  }

  /** Dismiss all visible notifications */
  clear(): void {
    [...this.queue].forEach((el) => this.dismiss(el));
  }

  /** Destroy the controller and remove from DOM */
  destroy(): void {
    this.clear();
    this.container.remove();
  }

  // ── OSC Handlers ───────────────────────────────────────────────────

  /** Register OSC notification handlers on an xterm.js terminal */
  registerOscHandlers(terminal: Terminal): void {
    // OSC 9 — iTerm2/ConEmu: \e]9;message\a
    terminal.parser.registerOscHandler(9, (data: string) => {
      if (data) {
        this.show({ message: data, level: 'info', label: 'TERM' });
      }
      return true;
    });

    // OSC 777 — rxvt-unicode: \e]777;notify;title;body\a
    terminal.parser.registerOscHandler(777, (data: string) => {
      const parts = data.split(';');
      if (parts[0] === 'notify' && parts.length >= 3) {
        const title = parts[1];
        const body = parts.slice(2).join(';');
        if (body) {
          this.show({ message: body, level: 'info', label: title.toUpperCase() || 'TERM' });
        }
      }
      return true;
    });

    // OSC 99 — kitty notification protocol (multi-part)
    terminal.parser.registerOscHandler(99, (data: string) => {
      this.handleKittyNotification(data);
      return true;
    });
  }

  // ── Private ────────────────────────────────────────────────────────

  /** Handle kitty OSC 99 multi-part notification protocol */
  private handleKittyNotification(data: string): void {
    const semiIdx = data.indexOf(';');
    const meta = semiIdx >= 0 ? data.slice(0, semiIdx) : data;
    const payload = semiIdx >= 0 ? data.slice(semiIdx + 1) : '';

    const params = new Map<string, string>();
    for (const part of meta.split(':')) {
      const eq = part.indexOf('=');
      if (eq >= 0) params.set(part.slice(0, eq), part.slice(eq + 1));
    }

    const id = params.get('i') ?? 'default';
    const done = params.get('d') ?? '0';

    if (done === '0') {
      // Title part — wait for body
      const timer = window.setTimeout(() => {
        this.pendingKitty.delete(id);
        if (payload) {
          this.show({ message: payload, level: 'info', label: 'TERM' });
        }
      }, KITTY_TITLE_TIMEOUT_MS);
      this.pendingKitty.set(id, { title: payload, timer });
    } else if (done === '1') {
      // Body part — combine with pending title
      const pending = this.pendingKitty.get(id);
      if (pending) {
        clearTimeout(pending.timer);
        this.pendingKitty.delete(id);
        if (payload) {
          this.show({
            message: payload,
            level: 'info',
            label: pending.title.toUpperCase() || 'TERM',
          });
        }
      } else if (payload) {
        this.show({ message: payload, level: 'info', label: 'TERM' });
      }
    }
  }

  /** Remove a notification with exit animation */
  private dismiss(el: HTMLElement): void {
    if (el.classList.contains('krypton-notif__item--exit')) return;
    el.classList.add('krypton-notif__item--exit');
    el.classList.remove('krypton-notif__item--enter');
    setTimeout(() => {
      el.remove();
      const idx = this.queue.indexOf(el);
      if (idx !== -1) this.queue.splice(idx, 1);
    }, 400);
  }

  /** Remove oldest beyond MAX_VISIBLE */
  private trim(): void {
    while (this.queue.length > MAX_VISIBLE) {
      const oldest = this.queue.shift();
      if (oldest) this.dismiss(oldest);
    }
  }

  /** Glitch-decode text reveal: characters resolve from random glyphs left-to-right */
  private decodeReveal(el: HTMLElement, finalText: string): void {
    const len = finalText.length;
    const remaining = new Array<number>(len).fill(DECODE_PASSES);
    let frame = 0;

    const interval = setInterval(() => {
      let output = '';
      let allDone = true;

      for (let i = 0; i < len; i++) {
        const waveDelay = Math.floor(i * DECODE_WAVE_DELAY);
        if (frame < waveDelay) {
          // Not started — show dim glyph or space
          output += i < frame + 3
            ? GLYPH_SET[Math.floor(Math.random() * GLYPH_SET.length)]
            : ' ';
          allDone = false;
        } else if (remaining[i] > 0) {
          // Decoding — random glyph
          output += GLYPH_SET[Math.floor(Math.random() * GLYPH_SET.length)];
          remaining[i]--;
          allDone = false;
        } else {
          // Resolved
          output += finalText[i];
        }
      }

      el.textContent = output;
      frame++;

      if (allDone) {
        clearInterval(interval);
        el.textContent = finalText;
      }
    }, 1000 / DECODE_FPS);
  }
}
