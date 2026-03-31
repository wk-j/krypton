// Krypton — Cursor Trail (Rainbow Flame)
// Spawns particles that rise, spread, and shift through rainbow colors
// like a flame trailing behind the mouse cursor AND the terminal text cursor.
//
// Phase 2: When OffscreenCanvas is supported, all particle rendering runs in a
// Web Worker — the main thread only forwards mouse/cursor positions. Falls back
// to the legacy DOM-based implementation otherwise.

import type { Compositor } from './compositor';

const SPAWN_THROTTLE = 10;
const MIN_MOVE = 2;
const TEXT_CURSOR_SPAWN_INTERVAL = 50;

// ─── OffscreenCanvas Worker Proxy ────────────────────────────────

class CursorTrailWorker {
  private compositor: Compositor | null = null;
  private canvas: HTMLCanvasElement;
  private worker: Worker;
  private running = false;
  private bound = false;
  private lastMouseX = 0;
  private lastMouseY = 0;
  private lastMouseSpawn = 0;
  private lastTextX = -1;
  private lastTextY = -1;
  private lastTextSpawn = 0;
  private pollRafId = 0;

  constructor() {
    this.canvas = document.createElement('canvas');
    this.canvas.className = 'krypton-cursor-trail-canvas';

    const offscreen = this.canvas.transferControlToOffscreen();
    this.worker = new Worker(
      new URL('./cursor-trail-worker.ts', import.meta.url),
      { type: 'module' }
    );

    const dpr = window.devicePixelRatio || 1;
    this.worker.postMessage(
      { type: 'init', canvas: offscreen, width: window.innerWidth, height: window.innerHeight, dpr },
      [offscreen]
    );
  }

  setCompositor(compositor: Compositor): void {
    this.compositor = compositor;
  }

  init(): void {
    if (this.bound) return;
    this.bound = true;
    this.running = true;

    document.body.appendChild(this.canvas);
    this.resize();

    this.worker.postMessage({ type: 'start' });
    document.addEventListener('mousemove', this.onMouseMove, true);
    window.addEventListener('resize', this.onResize);
    this.pollRafId = requestAnimationFrame(this.pollTick);
  }

  toggle(): void {
    if (this.running) {
      this.running = false;
      this.worker.postMessage({ type: 'stop' });
    } else {
      this.running = true;
      this.worker.postMessage({ type: 'start' });
    }
  }

  destroy(): void {
    document.removeEventListener('mousemove', this.onMouseMove, true);
    window.removeEventListener('resize', this.onResize);
    if (this.pollRafId) cancelAnimationFrame(this.pollRafId);
    this.worker.postMessage({ type: 'dispose' });
    this.worker.terminate();
    this.canvas.remove();
    this.bound = false;
    this.running = false;
  }

  private resize(): void {
    const dpr = window.devicePixelRatio || 1;
    const w = window.innerWidth;
    const h = window.innerHeight;
    this.canvas.style.width = `${w}px`;
    this.canvas.style.height = `${h}px`;
    this.worker.postMessage({ type: 'resize', width: w, height: h, dpr });
  }

  private onResize = (): void => {
    this.resize();
  };

  private onMouseMove = (e: MouseEvent): void => {
    if (!this.running) return;
    if (e.buttons !== 0) return;

    const now = performance.now();
    if (now - this.lastMouseSpawn < SPAWN_THROTTLE) return;

    const dx = e.clientX - this.lastMouseX;
    const dy = e.clientY - this.lastMouseY;
    if (Math.abs(dx) + Math.abs(dy) < MIN_MOVE) return;

    this.lastMouseX = e.clientX;
    this.lastMouseY = e.clientY;
    this.lastMouseSpawn = now;

    this.worker.postMessage({ type: 'mouse', x: e.clientX, y: e.clientY });
  };

  private pollTick = (now: number): void => {
    if (this.running) {
      this.pollTextCursor(now);
    }
    this.pollRafId = requestAnimationFrame(this.pollTick);
  };

  private pollTextCursor(now: number): void {
    if (!this.compositor) return;
    if (now - this.lastTextSpawn < TEXT_CURSOR_SPAWN_INTERVAL) return;

    const terminal = this.compositor.getActiveTerminal();
    if (!terminal) return;

    const buf = terminal.buffer.active;
    const cursorCol = buf.cursorX;
    const cursorRow = buf.cursorY;

    const screenEl = terminal.element?.querySelector('.xterm-screen') as HTMLElement | null;
    if (!screenEl) return;

    const rect = screenEl.getBoundingClientRect();
    const cellWidth = rect.width / terminal.cols;
    const cellHeight = rect.height / terminal.rows;

    const x = rect.left + cursorCol * cellWidth + cellWidth / 2;
    const y = rect.top + cursorRow * cellHeight + cellHeight / 2;

    if (cursorCol === this.lastTextX && cursorRow === this.lastTextY) return;

    this.lastTextX = cursorCol;
    this.lastTextY = cursorRow;
    this.lastTextSpawn = now;

    this.worker.postMessage({ type: 'cursor', x, y });
  }
}

// ─── DOM Fallback (legacy implementation) ────────────────────────

interface DOMParticle {
  el: HTMLDivElement;
  x: number;
  y: number;
  vx: number;
  vy: number;
  birth: number;
  hue: number;
  size: number;
}

const LIFETIME = 700;
const MAX_PARTICLES = 120;
const PARTICLES_PER_MOVE = 3;
const TEXT_CURSOR_PARTICLES = 2;

class CursorTrailDOM {
  private compositor: Compositor | null = null;
  private particles: DOMParticle[] = [];
  private hue = 0;
  private lastMouseX = 0;
  private lastMouseY = 0;
  private lastMouseSpawn = 0;
  private lastTextX = -1;
  private lastTextY = -1;
  private lastTextSpawn = 0;
  private rafId = 0;
  private enabled = true;
  private bound = false;

  setCompositor(compositor: Compositor): void {
    this.compositor = compositor;
  }

  init(): void {
    if (this.bound) return;
    this.bound = true;
    document.addEventListener('mousemove', this.onMouseMove, true);
    this.rafId = requestAnimationFrame(this.tick);
  }

  toggle(): void {
    this.enabled = !this.enabled;
    if (!this.enabled) this.clearAll();
  }

  destroy(): void {
    document.removeEventListener('mousemove', this.onMouseMove, true);
    cancelAnimationFrame(this.rafId);
    this.clearAll();
    this.bound = false;
  }

  private clearAll(): void {
    for (const p of this.particles) p.el.remove();
    this.particles.length = 0;
  }

  private onMouseMove = (e: MouseEvent): void => {
    if (!this.enabled) return;
    if (e.buttons !== 0) return;

    const now = performance.now();
    if (now - this.lastMouseSpawn < SPAWN_THROTTLE) return;

    const dx = e.clientX - this.lastMouseX;
    const dy = e.clientY - this.lastMouseY;
    if (Math.abs(dx) + Math.abs(dy) < MIN_MOVE) return;

    this.lastMouseX = e.clientX;
    this.lastMouseY = e.clientY;
    this.lastMouseSpawn = now;

    for (let i = 0; i < PARTICLES_PER_MOVE; i++) {
      this.spawnParticle(e.clientX, e.clientY, now);
    }
  };

  private pollTextCursor(now: number): void {
    if (!this.compositor) return;
    if (now - this.lastTextSpawn < TEXT_CURSOR_SPAWN_INTERVAL) return;

    const terminal = this.compositor.getActiveTerminal();
    if (!terminal) return;

    const buf = terminal.buffer.active;
    const cursorCol = buf.cursorX;
    const cursorRow = buf.cursorY;

    const screenEl = terminal.element?.querySelector('.xterm-screen') as HTMLElement | null;
    if (!screenEl) return;

    const rect = screenEl.getBoundingClientRect();
    const cellWidth = rect.width / terminal.cols;
    const cellHeight = rect.height / terminal.rows;

    const x = rect.left + cursorCol * cellWidth + cellWidth / 2;
    const y = rect.top + cursorRow * cellHeight + cellHeight / 2;

    if (cursorCol === this.lastTextX && cursorRow === this.lastTextY) return;

    this.lastTextX = cursorCol;
    this.lastTextY = cursorRow;
    this.lastTextSpawn = now;

    for (let i = 0; i < TEXT_CURSOR_PARTICLES; i++) {
      this.spawnParticle(x, y, now);
    }
  }

  private spawnParticle(x: number, y: number, now: number): void {
    while (this.particles.length >= MAX_PARTICLES) {
      const old = this.particles.shift()!;
      old.el.remove();
    }

    const el = document.createElement('div');
    el.className = 'krypton-cursor-trail__particle';

    const angle = Math.random() * Math.PI * 2;
    const speed = Math.random() * 1.5 + 0.5;
    const vx = Math.cos(angle) * speed;
    const vy = -(Math.random() * 2.5 + 1.5);

    const size = Math.random() * 8 + 4;

    this.hue = (this.hue + 5) % 360;

    el.style.width = `${size}px`;
    el.style.height = `${size * 1.4}px`;
    el.style.left = `${x}px`;
    el.style.top = `${y}px`;

    document.body.appendChild(el);
    this.particles.push({ el, x, y, vx, vy, birth: now, hue: this.hue, size });
  }

  private tick = (now: number): void => {
    if (this.enabled) {
      this.pollTextCursor(now);
    }

    while (this.particles.length > 0 && now - this.particles[0].birth > LIFETIME) {
      const old = this.particles.shift()!;
      old.el.remove();
    }

    for (const p of this.particles) {
      const age = (now - p.birth) / LIFETIME;

      p.x += p.vx + (Math.random() - 0.5) * 0.8;
      p.y += p.vy;
      p.vy -= 0.03;

      const currentHue = (p.hue + age * 60) % 360;
      const saturation = 100;
      const lightness = 65 - age * 25;

      const opacity = 1 - age * age;
      const scale = 1 - age * 0.7;

      const style = p.el.style;
      style.left = `${p.x}px`;
      style.top = `${p.y}px`;
      style.opacity = String(Math.max(0, opacity));
      style.transform = `translate(-50%, -50%) scale(${scale})`;
      style.background = `radial-gradient(ellipse, hsla(${currentHue}, ${saturation}%, ${lightness}%, 0.9) 0%, hsla(${currentHue}, ${saturation}%, ${lightness}%, 0) 70%)`;
      style.boxShadow = `0 0 ${4 + (1 - age) * 6}px hsla(${currentHue}, 100%, 60%, ${opacity * 0.7})`;
    }

    this.rafId = requestAnimationFrame(this.tick);
  };
}

// ─── Public API — auto-selects worker or DOM implementation ──────

export interface CursorTrailAPI {
  setCompositor(compositor: Compositor): void;
  init(): void;
  toggle(): void;
  destroy(): void;
}

export type CursorTrail = CursorTrailAPI;

export function createCursorTrail(): CursorTrailAPI {
  if (typeof HTMLCanvasElement.prototype.transferControlToOffscreen === 'function') {
    try {
      return new CursorTrailWorker();
    } catch {
      // Worker creation failed — fall back to DOM
    }
  }
  return new CursorTrailDOM();
}
