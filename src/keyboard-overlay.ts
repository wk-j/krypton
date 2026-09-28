// Krypton — Keyboard overlay (spec 271)
// Read-only on-screen keyboard with wireframe "ghost hands", docked at the
// center-bottom of the workspace screen. It only observes keydown events —
// never preventDefault/stopPropagation, never writes to a PTY. Rendering runs
// in a worker on an OffscreenCanvas; the main thread falls back to the same
// driver when OffscreenCanvas is unavailable.

import { invoke } from './profiler/ipc';
import type { KeyboardOverlayConfig } from './config';
import {
  KeyboardOverlayDriver,
  clamp,
  detectLayout,
  initialLayout,
  overlaySize,
  resolveCode,
  type OverlayLayout,
  type OverlayMessage,
} from './keyboard-overlay-model';

/** How long a secure-input answer is reused before asking the backend again. */
const SECURE_CACHE_MS = 250;
/** Thai glyphs for Kedmanee labels; worker canvases fall back poorly on their own. */
const THAI_FONT_FALLBACK = "Thonburi, 'Noto Sans Thai', sans-serif";

export const DEFAULT_KEYBOARD_OVERLAY_CONFIG: KeyboardOverlayConfig = {
  enabled: false,
  layout: 'auto',
  width_ratio: 0.36,
  opacity: 0.7,
  mask_secure_input: true,
  idle_ghost: false,
};

interface SecureCache {
  sessionId: number;
  secure: boolean;
  at: number;
}

export class KeyboardOverlay {
  private readonly canvas: HTMLCanvasElement;
  private readonly post: (msg: OverlayMessage) => void;
  private readonly worker: Worker | null;
  private readonly styleObserver: MutationObserver;
  private config: KeyboardOverlayConfig = DEFAULT_KEYBOARD_OVERLAY_CONFIG;
  private layout: OverlayLayout = 'us';
  private enabled = false;
  private secureCache: SecureCache | null = null;
  private styleKey = '';
  private styleRaf = 0;

  constructor(
    private readonly getFocusedSessionId: () => number | null,
    config: KeyboardOverlayConfig,
  ) {
    this.canvas = document.createElement('canvas');
    this.canvas.className = 'krypton-keyboard-overlay';
    this.canvas.setAttribute('aria-hidden', 'true');

    const worker = this.startWorker();
    this.worker = worker;
    if (worker) {
      this.post = (msg) => worker.postMessage(msg);
    } else {
      const driver = new KeyboardOverlayDriver();
      driver.handle({ type: 'init', canvas: this.canvas });
      this.post = (msg) => driver.handle(msg);
    }

    document.body.appendChild(this.canvas);
    window.addEventListener('keydown', this.onKeyDown, { capture: true, passive: true });
    window.addEventListener('resize', this.onResize);
    // Theme and font changes land as inline custom properties on <html>.
    this.styleObserver = new MutationObserver(this.scheduleStyle);
    this.styleObserver.observe(document.documentElement, { attributes: true, attributeFilter: ['style'] });

    this.applyConfig(config);
    this.pushStyle();
  }

  get isEnabled(): boolean {
    return this.enabled;
  }

  setEnabled(enabled: boolean): void {
    if (this.enabled === enabled) return;
    this.enabled = enabled;
    this.secureCache = null;
    this.canvas.classList.toggle('krypton-keyboard-overlay--visible', enabled);
    if (enabled) {
      this.resize();
      this.pushStyle();
    }
    this.post({ type: 'visible', visible: enabled });
  }

  /** Workspace footer shown/hidden: sit flush on the 28px rail, or on the screen edge. */
  setFooterVisible(visible: boolean): void {
    this.canvas.classList.toggle('krypton-keyboard-overlay--no-footer', !visible);
  }

  /** Apply `[keyboard_overlay]` (startup + Reload Config). Visibility is owned by the caller. */
  applyConfig(config: KeyboardOverlayConfig): void {
    this.config = config;
    this.layout = config.layout === 'auto' ? this.layout : initialLayout(config.layout);
    const opacity = clamp(Number.isFinite(config.opacity) ? config.opacity : 0.7, 0.1, 1);
    this.canvas.style.setProperty('--kb-opacity', String(opacity));
    this.postConfig();
    this.resize();
  }

  destroy(): void {
    window.removeEventListener('keydown', this.onKeyDown, { capture: true });
    window.removeEventListener('resize', this.onResize);
    this.styleObserver.disconnect();
    if (this.styleRaf) cancelAnimationFrame(this.styleRaf);
    this.post({ type: 'dispose' });
    this.worker?.terminate();
    this.canvas.remove();
  }

  private startWorker(): Worker | null {
    if (typeof this.canvas.transferControlToOffscreen !== 'function') return null;
    let worker: Worker | null = null;
    try {
      worker = new Worker(new URL('./keyboard-overlay-worker.ts', import.meta.url), { type: 'module' });
      const offscreen = this.canvas.transferControlToOffscreen();
      worker.postMessage({ type: 'init', canvas: offscreen } satisfies OverlayMessage, [offscreen]);
      return worker;
    } catch (e) {
      console.warn('[KeyboardOverlay] Worker unavailable, rendering on the main thread:', e);
      worker?.terminate();
      return null;
    }
  }

  private postConfig(): void {
    this.post({ type: 'config', layout: this.layout, ghost: this.config.idle_ghost });
  }

  private resize(): void {
    const { width, height } = overlaySize(window.innerWidth, this.config.width_ratio);
    this.canvas.style.width = `${width}px`;
    this.canvas.style.height = `${height}px`;
    this.post({ type: 'resize', width, height, dpr: window.devicePixelRatio || 1 });
  }

  private onResize = (): void => {
    this.resize();
  };

  private scheduleStyle = (): void => {
    if (this.styleRaf) return;
    this.styleRaf = requestAnimationFrame(() => {
      this.styleRaf = 0;
      this.pushStyle();
    });
  };

  /** Re-read theme colors + terminal font; post only when they changed. */
  private pushStyle(): void {
    const css = getComputedStyle(document.documentElement);
    const ink = css.getPropertyValue('--krypton-fg').trim() || '#b0c4d8';
    const accent = css.getPropertyValue('--krypton-accent').trim() || '#0cf';
    const family = css.getPropertyValue('--krypton-font-family').trim() || 'monospace';
    const font = `${family}, ${THAI_FONT_FALLBACK}`;
    const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    const key = `${ink}|${accent}|${font}|${reducedMotion}`;
    if (key === this.styleKey) return;
    this.styleKey = key;
    this.post({ type: 'style', style: { ink, accent, font, reducedMotion } });
  }

  // Passive observer: runs before every document listener, consumes nothing.
  private onKeyDown = (e: KeyboardEvent): void => {
    if (!this.enabled || e.repeat || e.metaKey) return;
    if (this.config.layout === 'auto') {
      const next = detectLayout(e.key, this.layout);
      if (next !== this.layout) {
        this.layout = next;
        this.postConfig();
      }
    }
    const code = resolveCode(e.code, e.key, this.layout);
    if (!code) return;

    const sessionId = this.config.mask_secure_input ? this.getFocusedSessionId() : null;
    if (sessionId === null) {
      this.post({ type: 'key', code, shift: false });
      return;
    }
    const cached = this.secureCache;
    if (cached && cached.sessionId === sessionId && performance.now() - cached.at < SECURE_CACHE_MS) {
      if (!cached.secure) this.post({ type: 'key', code, shift: false });
      return;
    }
    void this.checkSecure(sessionId).then((secure) => {
      if (!secure && this.enabled) this.post({ type: 'key', code, shift: false });
    });
  };

  /** Ask the backend whether the PTY is at a password prompt. Errors → not secure. */
  private async checkSecure(sessionId: number): Promise<boolean> {
    try {
      const secure = (await invoke<boolean | null>('get_pty_secure_input', { sessionId })) === true;
      this.secureCache = { sessionId, secure, at: performance.now() };
      return secure;
    } catch {
      return false;
    }
  }
}
