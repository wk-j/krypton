// Krypton — Cursor Trail (Rainbow Flame)
// Spawns particles that rise, spread, and shift through rainbow colors
// like a flame trailing behind the mouse cursor AND the terminal text cursor.

import type { Compositor } from './compositor';

interface Particle {
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
const SPAWN_THROTTLE = 10;
const MIN_MOVE = 2;
const MAX_PARTICLES = 120;
const PARTICLES_PER_MOVE = 3;
const TEXT_CURSOR_SPAWN_INTERVAL = 50;  // ms between text cursor particle bursts
const TEXT_CURSOR_PARTICLES = 2;

export class CursorTrail {
  private compositor: Compositor | null = null;
  private particles: Particle[] = [];
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

  // ─── Mouse cursor trail ───

  private onMouseMove = (e: MouseEvent): void => {
    if (!this.enabled) return;

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

  // ─── Text cursor trail ───

  private pollTextCursor(now: number): void {
    if (!this.compositor) return;
    if (now - this.lastTextSpawn < TEXT_CURSOR_SPAWN_INTERVAL) return;

    const terminal = this.compositor.getActiveTerminal();
    if (!terminal) return;

    const buf = terminal.buffer.active;
    const cursorCol = buf.cursorX;
    const cursorRow = buf.cursorY; // viewport-relative row

    // Find the terminal's screen element to compute pixel position
    const screenEl = terminal.element?.querySelector('.xterm-screen') as HTMLElement | null;
    if (!screenEl) return;

    const rect = screenEl.getBoundingClientRect();
    const cellWidth = rect.width / terminal.cols;
    const cellHeight = rect.height / terminal.rows;

    // Pixel position of cursor center (in viewport coords)
    const x = rect.left + cursorCol * cellWidth + cellWidth / 2;
    const y = rect.top + cursorRow * cellHeight + cellHeight / 2;

    // Only spawn if cursor actually moved
    if (cursorCol === this.lastTextX && cursorRow === this.lastTextY) return;

    this.lastTextX = cursorCol;
    this.lastTextY = cursorRow;
    this.lastTextSpawn = now;

    for (let i = 0; i < TEXT_CURSOR_PARTICLES; i++) {
      this.spawnParticle(x, y, now);
    }
  }

  // ─── Shared particle logic ───

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
    // Poll text cursor each frame
    if (this.enabled) {
      this.pollTextCursor(now);
    }

    // Remove expired
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
