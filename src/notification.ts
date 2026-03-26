// Krypton — Persistent Notification Control
// Pinned to bottom-right of the focused terminal window.
// Updates in-place with glitch-decode reveal. Captures OSC 9/777/99 from terminals.

import type { Terminal } from '@xterm/xterm';

/** Notification severity / visual style */
export type NotificationLevel = 'info' | 'success' | 'warning' | 'error' | 'system';

/** Options for creating a notification */
export interface NotificationOptions {
  message: string;
  level?: NotificationLevel;
  /** Label prefix (e.g. 'SYSTEM', 'ALERT'). Auto-derived from level if omitted */
  label?: string;
  /** Whether to use the decode (glitch) text reveal. Default: true */
  decode?: boolean;
}

// ── Constants ──────────────────────────────────────────────────────────

const GLYPH_SET = '░▒▓█▀▄▌▐─═╌╍┄┅⟋⟍⧸⧹';
const DECODE_FPS = 40;
const DECODE_BASE_CHANCE = 0.08;
const DECODE_POSITION_BIAS = 0.04;

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
  private el: HTMLElement;
  private barEl: HTMLElement;
  private labelEl: HTMLElement;
  private msgEl: HTMLElement;
  private decodeInterval: ReturnType<typeof setInterval> | null = null;
  private pendingKitty = new Map<string, { title: string; timer: number }>();
  private currentLevel: NotificationLevel = 'info';

  constructor() {
    this.el = document.createElement('div');
    this.el.className = 'krypton-notif krypton-notif--idle';

    this.barEl = document.createElement('div');
    this.barEl.className = 'krypton-notif__bar';
    this.el.appendChild(this.barEl);

    this.labelEl = document.createElement('span');
    this.labelEl.className = 'krypton-notif__label';
    this.labelEl.textContent = 'SYS';
    this.el.appendChild(this.labelEl);

    this.msgEl = document.createElement('span');
    this.msgEl.className = 'krypton-notif__msg';
    this.msgEl.textContent = 'Ready';
    this.el.appendChild(this.msgEl);
  }

  /** Attach the notification control to a window's footer (called on focus change) */
  attachTo(windowEl: HTMLElement): void {
    const footer = windowEl.querySelector('.krypton-window__footer');
    if (footer) {
      footer.appendChild(this.el);
    }
  }

  // ── Public API ─────────────────────────────────────────────────────

  /** Update the notification control with a new message */
  show(opts: NotificationOptions): void {
    const level = opts.level ?? 'info';
    const label = opts.label ?? LEVEL_LABELS[level];
    const useDecode = opts.decode !== false;
    const message = opts.message.slice(0, MAX_MESSAGE_LEN);

    if (!message && !label) return;

    // Stop any running decode animation
    if (this.decodeInterval !== null) {
      clearInterval(this.decodeInterval);
      this.decodeInterval = null;
    }

    // Update level styling
    if (level !== this.currentLevel) {
      this.el.classList.remove(`krypton-notif--${this.currentLevel}`);
    }
    this.currentLevel = level;
    this.el.classList.remove('krypton-notif--idle');
    this.el.classList.add(`krypton-notif--${level}`);

    // Update label
    this.labelEl.textContent = label;

    // Update message
    if (useDecode && message) {
      this.decodeReveal(this.msgEl, message);
    } else {
      this.msgEl.textContent = message;
    }

    // Trigger scanline flash
    this.el.classList.remove('krypton-notif--flash');
    void this.el.offsetWidth;
    this.el.classList.add('krypton-notif--flash');
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

  /** Reset to idle */
  clear(): void {
    if (this.decodeInterval !== null) {
      clearInterval(this.decodeInterval);
      this.decodeInterval = null;
    }
    this.el.classList.remove(`krypton-notif--${this.currentLevel}`, 'krypton-notif--flash');
    this.el.classList.add('krypton-notif--idle');
    this.labelEl.textContent = 'SYS';
    this.msgEl.textContent = 'Ready';
  }

  /** Destroy the controller and remove from DOM */
  destroy(): void {
    this.clear();
    this.el.remove();
  }

  // ── OSC Handlers ───────────────────────────────────────────────────

  registerOscHandlers(terminal: Terminal): void {
    terminal.parser.registerOscHandler(9, (data: string) => {
      if (data) {
        this.show({ message: data, level: 'info', label: 'TERM' });
      }
      return true;
    });

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

    terminal.parser.registerOscHandler(99, (data: string) => {
      this.handleKittyNotification(data);
      return true;
    });
  }

  // ── Private ────────────────────────────────────────────────────────

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
      const timer = window.setTimeout(() => {
        this.pendingKitty.delete(id);
        if (payload) {
          this.show({ message: payload, level: 'info', label: 'TERM' });
        }
      }, KITTY_TITLE_TIMEOUT_MS);
      this.pendingKitty.set(id, { title: payload, timer });
    } else if (done === '1') {
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

  private decodeReveal(el: HTMLElement, finalText: string): void {
    const len = finalText.length;
    const locked = new Uint8Array(len);
    const heat = new Float32Array(len);
    let resolved = 0;

    for (let i = 0; i < len; i++) {
      if (finalText[i] === ' ') {
        locked[i] = 1;
        resolved++;
      }
    }

    let output = '';
    for (let i = 0; i < len; i++) {
      output += locked[i]
        ? finalText[i]
        : GLYPH_SET[Math.floor(Math.random() * GLYPH_SET.length)];
    }
    el.textContent = output;

    this.decodeInterval = setInterval(() => {
      let buf = '';

      for (let i = 0; i < len; i++) {
        if (locked[i]) {
          buf += finalText[i];
          continue;
        }

        const positionFactor = 1 - (i / len) * DECODE_POSITION_BIAS * 10;
        const neighbourBoost = (i > 0 && locked[i - 1]) ? 0.06 : 0;
        heat[i] += (DECODE_BASE_CHANCE * positionFactor + neighbourBoost) * (0.7 + Math.random() * 0.6);

        if (heat[i] >= 1.0) {
          locked[i] = 1;
          resolved++;
          buf += finalText[i];
        } else if (heat[i] > 0.7) {
          buf += Math.random() < 0.5
            ? finalText[i]
            : GLYPH_SET[Math.floor(Math.random() * GLYPH_SET.length)];
        } else {
          buf += GLYPH_SET[Math.floor(Math.random() * GLYPH_SET.length)];
        }
      }

      el.textContent = buf;

      if (resolved >= len) {
        clearInterval(this.decodeInterval!);
        this.decodeInterval = null;
        el.textContent = finalText;
      }
    }, 1000 / DECODE_FPS);
  }
}
