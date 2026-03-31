// Krypton — Cursor Trail Web Worker
// Receives mouse/cursor positions from main thread and renders rainbow flame
// particles on an OffscreenCanvas. No DOM access — pure canvas rendering.

interface Particle {
  x: number;
  y: number;
  vx: number;
  vy: number;
  birth: number;
  hue: number;
  size: number;
}

type WorkerMessage =
  | { type: 'init'; canvas: OffscreenCanvas; width: number; height: number; dpr: number }
  | { type: 'mouse'; x: number; y: number }
  | { type: 'cursor'; x: number; y: number }
  | { type: 'resize'; width: number; height: number; dpr: number }
  | { type: 'start' }
  | { type: 'stop' }
  | { type: 'dispose' };

const LIFETIME = 700;
const MAX_PARTICLES = 120;
const PARTICLES_PER_MOVE = 3;
const TEXT_CURSOR_PARTICLES = 2;

let canvas: OffscreenCanvas | null = null;
let ctx: OffscreenCanvasRenderingContext2D | null = null;
let W = 0;
let H = 0;
let dpr = 1;
let running = false;
let rafId = 0;
let hue = 0;

const particles: Particle[] = [];

function spawnParticle(x: number, y: number, now: number): void {
  // Evict oldest if at capacity
  if (particles.length >= MAX_PARTICLES) {
    particles.shift();
  }

  const angle = Math.random() * Math.PI * 2;
  const speed = Math.random() * 1.5 + 0.5;
  const vx = Math.cos(angle) * speed;
  const vy = -(Math.random() * 2.5 + 1.5);
  const size = Math.random() * 8 + 4;

  hue = (hue + 5) % 360;

  particles.push({ x, y, vx, vy, birth: now, hue, size });
}

function spawnBurst(x: number, y: number, count: number, now: number): void {
  for (let i = 0; i < count; i++) {
    spawnParticle(x, y, now);
  }
}

function tick(now: number): void {
  if (!running || !ctx) return;

  ctx.clearRect(0, 0, W, H);

  // Remove expired particles from front
  while (particles.length > 0 && now - particles[0].birth > LIFETIME) {
    particles.shift();
  }

  for (const p of particles) {
    const age = (now - p.birth) / LIFETIME;

    // Physics
    p.x += p.vx + (Math.random() - 0.5) * 0.8;
    p.y += p.vy;
    p.vy -= 0.03;

    // Color
    const currentHue = (p.hue + age * 60) % 360;
    const lightness = 65 - age * 25;
    const opacity = 1 - age * age;
    const scale = 1 - age * 0.7;

    if (opacity < 0.01) continue;

    const w = p.size * scale;
    const h = w * 1.4;

    ctx.save();
    ctx.globalAlpha = opacity;

    // Glow (box-shadow equivalent)
    const glowRadius = 4 + (1 - age) * 6;
    ctx.shadowColor = `hsla(${currentHue}, 100%, 60%, ${opacity * 0.7})`;
    ctx.shadowBlur = glowRadius;

    // Teardrop shape via radial gradient
    const grad = ctx.createRadialGradient(p.x, p.y, 0, p.x, p.y, Math.max(w, h) * 0.7);
    grad.addColorStop(0, `hsla(${currentHue}, 100%, ${lightness}%, 0.9)`);
    grad.addColorStop(1, `hsla(${currentHue}, 100%, ${lightness}%, 0)`);

    ctx.fillStyle = grad;

    // Draw teardrop-ish ellipse
    ctx.beginPath();
    ctx.ellipse(p.x, p.y, w / 2, h / 2, 0, 0, Math.PI * 2);
    ctx.fill();

    ctx.restore();
  }

  rafId = requestAnimationFrame(tick);
}

self.onmessage = (e: MessageEvent<WorkerMessage>) => {
  const msg = e.data;

  switch (msg.type) {
    case 'init':
      canvas = msg.canvas;
      ctx = canvas.getContext('2d');
      if (msg.width > 0 && msg.height > 0) {
        W = msg.width;
        H = msg.height;
        dpr = msg.dpr;
        canvas.width = W * dpr;
        canvas.height = H * dpr;
        ctx!.setTransform(dpr, 0, 0, dpr, 0, 0);
      }
      break;

    case 'start':
      if (!running) {
        running = true;
        rafId = requestAnimationFrame(tick);
      }
      break;

    case 'stop':
      running = false;
      if (rafId) {
        cancelAnimationFrame(rafId);
        rafId = 0;
      }
      // Clear canvas and particles
      particles.length = 0;
      if (ctx) ctx.clearRect(0, 0, W, H);
      break;

    case 'mouse': {
      if (!running) break;
      const now = performance.now();
      spawnBurst(msg.x, msg.y, PARTICLES_PER_MOVE, now);
      break;
    }

    case 'cursor': {
      if (!running) break;
      const now = performance.now();
      spawnBurst(msg.x, msg.y, TEXT_CURSOR_PARTICLES, now);
      break;
    }

    case 'resize':
      W = msg.width;
      H = msg.height;
      dpr = msg.dpr;
      if (canvas && ctx) {
        canvas.width = W * dpr;
        canvas.height = H * dpr;
        ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      }
      break;

    case 'dispose':
      running = false;
      if (rafId) cancelAnimationFrame(rafId);
      particles.length = 0;
      canvas = null;
      ctx = null;
      self.close();
      break;
  }
};
