// Krypton — Program-Status Fire (spec 0362).
//
// A window burns while its program-status aggregate (OSC 7501, spec 0284) is
// one of the states listed in `[fire] on`. The compositor calls `sync` from
// `paintProgramStatus`, so the fire always matches what the window chrome shows.
// Each burning window gets a WebGL2 canvas pinned to the bottom of its content
// area, under the panes. The context is created on the first ignite, the loop
// stops once the fire is out, and a window that never burns allocates nothing.
//
// The ember table below ports rune-fx `cpu.rs::embers`; see the MIT notice in
// `fire-shader.ts`.

import type { BackgroundAnimation } from './background-animation';
import { FIRE_EMBER_VEC4S, FIRE_FRAGMENT_SHADER, FIRE_VERTEX_SHADER } from './fire-shader';
import type { ProgramState } from './program-status';
import type { KryptonWindow, WindowId } from './types';

export type FireState = 'working' | 'blocked' | 'error' | 'done';

const FIRE_STATES: Record<string, true> = { working: true, blocked: true, error: true, done: true };

/** Look constants (rune `FireParams` defaults, Ship-page scale and ember count). */
export const FIRE = {
  scale: 26,
  speed: 1.5,
  warp: 1.0,
  baseGlow: 0.5,
  occlusion: 0.25,
  intensity: 0.6,
  embers: FIRE_EMBER_VEC4S / 2,
  emberRise: 58,
  emberSize: 0.8,
  emberLife: 1.5,
  glowRadius: 30,
  glowReach: 80,
  fpsCap: 60,
} as const;

/** rune `FireParams::default()` colours, used when a theme sets no fire token. */
const DEFAULT_COLORS = { low: '#8a1405', mid: '#ff5a14', hot: '#ffc65a' } as const;

const IGNITE_TAU_S = 0.25;
const PUT_OUT_TAU_S = 0.45;
/** Below this heat the fire is out: the loop stops and the canvas hides. */
const OUT_HEAT = 0.01;
/** `t` wraps here so highp noise inputs stay small on long burns. */
const TIME_WRAP_S = 600;
const EMBER_DRAG = 2.4;
const TAU = Math.PI * 2;

// ─── Pure helpers ───────────────────────────────────────────────

export interface FireBand {
  cssWidth: number;
  cssHeight: number;
  flameMax: number;
}

/** Canvas band for a content area: tall enough for the tallest flame and its embers. */
export function fireBand(contentW: number, contentH: number): FireBand {
  const w = Math.max(0, Math.round(contentW));
  const h = Math.max(0, Math.round(contentH));
  const flameMax = Math.min(120, Math.max(40, 0.22 * h));
  return { cssWidth: w, cssHeight: Math.min(h, Math.ceil(flameMax * 2.2)), flameMax };
}

/** Exponential approach to the target: τ 0.25 s igniting, τ 0.45 s putting out. */
export function stepHeat(heat: number, target: 0 | 1, dt: number): number {
  const tau = target > heat ? IGNITE_TAU_S : PUT_OUT_TAU_S;
  return heat + (target - heat) * (1 - Math.exp(-Math.max(0, dt) / tau));
}

function pcg(v: number): number {
  const s = (Math.imul(v >>> 0, 747796405) + 2891336453) >>> 0;
  const w = Math.imul(((s >>> ((s >>> 28) + 4)) ^ s) >>> 0, 277803737) >>> 0;
  return ((w >>> 22) ^ w) >>> 0;
}

function hu(a: number, b: number): number {
  return pcg((a ^ pcg((b + 0x9e3779b9) >>> 0)) >>> 0);
}

function u01(n: number): number {
  return (pcg(n >>> 0) >>> 8) * (1 / 16777216);
}

/**
 * Ember table for time `t` (port of rune `cpu.rs::embers`). Writes two vec4 per
 * live ember into `out` — (x, y, streak dx, streak dy), (size, temperature, 0, 0)
 * in band px with y down — and returns how many it wrote. Deterministic in
 * (t, seed, band, radius, height), so redrawing a frame never jitters.
 */
export function fireEmbers(
  t: number,
  seed: number,
  band: FireBand,
  radius: number,
  heightNow: number,
  out: Float32Array,
): number {
  const life0 = Math.max(0.1, FIRE.emberLife);
  const rectY = band.cssHeight;
  const rectW = band.cssWidth;
  const max = Math.min(FIRE.embers, 40, Math.floor(out.length / 8));
  let count = 0;
  for (let e = 0; e < max; e++) {
    const hk0 = hu((seed + 991) >>> 0, e * 7 + 3);
    const life = life0 * (0.6 + 0.8 * u01(hk0));
    const tau = t / life + u01(hk0 + 1);
    const kk = Math.floor(tau);
    const a = tau - kk;
    const hk = hu(hk0, kk >>> 0);
    const age = a * life;
    const x0 = radius * 0.6 + (rectW - radius * 1.2) * u01(hk + 2);
    const y0 = rectY - heightNow * (0.1 + 0.45 * u01(hk + 3));
    const v0 = -FIRE.emberRise * (1 + 0.8 * u01(hk + 4));
    const vt = -FIRE.emberRise * 0.32;
    const ek = Math.exp(-EMBER_DRAG * age);
    const y = y0 + vt * age + ((v0 - vt) * (1 - ek)) / EMBER_DRAG;
    const vy = vt + (v0 - vt) * ek;
    const sway = 2.5 + 5 * u01(hk + 5);
    const fq = 3 + 4 * u01(hk + 6);
    const ph = TAU * u01(hk + 7);
    const drift = (u01(hk + 8) - 0.5) * 14;
    const grow = 1 - Math.exp(-age * 3);
    const x = x0 + drift * age + sway * Math.sin(age * fq + ph) * grow;
    const vx = drift + sway * (Math.cos(age * fq + ph) * fq * grow + Math.sin(age * fq + ph) * 3 * Math.exp(-age * 3));
    const size = FIRE.emberSize * (0.5 + 0.8 * u01(hk + 9)) * (1 - 0.4 * a);
    const attack = Math.min(1, Math.max(0, age / 0.05));
    const temp = Math.exp(-age / (life * 0.42)) * (1 - a * a) * (0.8 + 0.3 * u01(hk + 10)) * attack;
    if (temp < 0.004) continue;
    const shutter = 0.6 / 60;
    const o = count * 8;
    out[o] = x;
    out[o + 1] = y;
    out[o + 2] = vx * shutter;
    out[o + 3] = vy * shutter;
    out[o + 4] = size;
    out[o + 5] = temp;
    out[o + 6] = 0;
    out[o + 7] = 0;
    count++;
  }
  return count;
}

// ─── Colours ────────────────────────────────────────────────────

type Rgb = [number, number, number];

function srgbToLinear(c: number): number {
  return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
}

/** 1×1 scratch canvas that turns any computed CSS colour (rgb, oklch, color()…) into sRGB bytes. */
let colorScratch: CanvasRenderingContext2D | null = null;

/** Resolve `var(--token, fallback)` through the cascade into linear RGB. */
function readTokenColor(probe: HTMLElement, token: string, fallback: string): Rgb {
  probe.style.color = `var(${token}, ${fallback})`;
  const computed = getComputedStyle(probe).color;
  probe.style.color = '';
  colorScratch ??= document.createElement('canvas').getContext('2d', { willReadFrequently: true });
  // DEFAULT_COLORS are `#rrggbb`; without a 2D context the default stands.
  let bytes: ArrayLike<number> = [1, 3, 5].map((i) => parseInt(fallback.slice(i, i + 2), 16));
  if (colorScratch) {
    colorScratch.clearRect(0, 0, 1, 1);
    colorScratch.fillStyle = fallback;
    colorScratch.fillStyle = computed; // an unparseable value keeps the fallback
    colorScratch.fillRect(0, 0, 1, 1);
    bytes = colorScratch.getImageData(0, 0, 1, 1).data;
  }
  return [srgbToLinear(bytes[0] / 255), srgbToLinear(bytes[1] / 255), srgbToLinear(bytes[2] / 255)];
}

// ─── Renderer ───────────────────────────────────────────────────

interface FireUniforms {
  res: WebGLUniformLocation | null;
  time: WebGLUniformLocation | null;
  heat: WebGLUniformLocation | null;
  seed: WebGLUniformLocation | null;
  height: WebGLUniformLocation | null;
  radius: WebGLUniformLocation | null;
  p0: WebGLUniformLocation | null;
  p1: WebGLUniformLocation | null;
  low: WebGLUniformLocation | null;
  mid: WebGLUniformLocation | null;
  hot: WebGLUniformLocation | null;
  embers: WebGLUniformLocation | null;
  emberCount: WebGLUniformLocation | null;
}

const CONTEXT_OPTIONS: WebGLContextAttributes = {
  alpha: true,
  premultipliedAlpha: true,
  antialias: false,
  depth: false,
  stencil: false,
  preserveDrawingBuffer: false,
  powerPreference: 'low-power',
};

/** One window's fire: a WebGL2 band canvas under the panes of `content`. */
export class FireAnimation implements BackgroundAnimation {
  private readonly canvas: HTMLCanvasElement;
  private readonly reduceMotion: MediaQueryList;
  private readonly seed = (Math.random() * 0x100000000) >>> 0;
  private readonly embers = new Float32Array(FIRE_EMBER_VEC4S * 4);
  private gl: WebGL2RenderingContext | null = null;
  private program: WebGLProgram | null = null;
  private vao: WebGLVertexArrayObject | null = null;
  private uniforms: FireUniforms | null = null;
  private band: FireBand = { cssWidth: 0, cssHeight: 0, flameMax: 40 };
  private radius = 8;
  private colors: { low: Rgb; mid: Rgb; hot: Rgb } | null = null;
  /** Target is lit (heat → 1). */
  private running = false;
  private rafId = 0;
  private lastDraw = 0;
  private heat = 0;
  private t = 0;
  private lost = false;
  private disposed = false;

  constructor(
    private readonly content: HTMLElement,
    private readonly windowEl: HTMLElement,
    private readonly onFailure: (reason: string) => void,
  ) {
    this.canvas = document.createElement('canvas');
    this.canvas.className = 'krypton-fire-canvas';
    this.reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)');
    this.reduceMotion.addEventListener('change', this.onMotionChange);
    this.canvas.addEventListener('webglcontextlost', this.onContextLost);
    this.canvas.addEventListener('webglcontextrestored', this.onContextRestored);
  }

  getElement(): HTMLCanvasElement {
    return this.canvas;
  }

  isRunning(): boolean {
    return this.running;
  }

  start(): void {
    if (this.disposed || this.running) return;
    if (!this.gl && !this.initContext()) return;
    const wasOut = this.rafId === 0;
    this.running = true;
    if (this.lost) return;
    if (wasOut) {
      this.t = 0;
      this.heat = 0;
      this.lastDraw = 0;
      this.colors = {
        low: readTokenColor(this.canvas, '--krypton-fire-low', DEFAULT_COLORS.low),
        mid: readTokenColor(this.canvas, '--krypton-fire-mid', DEFAULT_COLORS.mid),
        hot: readTokenColor(this.canvas, '--krypton-fire-hot', DEFAULT_COLORS.hot),
      };
      this.radius = parseFloat(getComputedStyle(this.windowEl).borderTopLeftRadius) || 8;
      this.canvas.style.display = 'block';
      this.resize();
    }
    if (this.reduceMotion.matches) {
      this.drawStatic();
      return;
    }
    this.ensureLoop();
  }

  stop(): void {
    if (!this.running) return;
    this.running = false;
    // The loop puts the fire out over ~2 s; without one there is nothing to fade.
    if (this.rafId === 0) this.hide();
  }

  resize(): void {
    const band = fireBand(this.content.clientWidth, this.content.clientHeight);
    this.band = band;
    if (this.canvas.width !== band.cssWidth) this.canvas.width = band.cssWidth;
    if (this.canvas.height !== band.cssHeight) this.canvas.height = band.cssHeight;
    this.canvas.style.height = `${band.cssHeight}px`;
    if (this.running && this.rafId === 0 && this.reduceMotion.matches) this.drawStatic();
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.running = false;
    this.cancelLoop();
    this.reduceMotion.removeEventListener('change', this.onMotionChange);
    this.canvas.removeEventListener('webglcontextlost', this.onContextLost);
    this.canvas.removeEventListener('webglcontextrestored', this.onContextRestored);
    this.gl?.getExtension('WEBGL_lose_context')?.loseContext();
    this.gl = null;
    this.program = null;
    this.vao = null;
    this.uniforms = null;
    this.canvas.remove();
  }

  private initContext(): boolean {
    const gl = this.canvas.getContext('webgl2', CONTEXT_OPTIONS);
    if (!gl) {
      this.onFailure('WebGL2 is unavailable');
      return false;
    }
    this.gl = gl;
    return this.initResources();
  }

  /** Program, VAO and uniform locations; again after a context restore. */
  private initResources(): boolean {
    const gl = this.gl;
    if (!gl) return false;
    const vs = this.compile(gl, gl.VERTEX_SHADER, FIRE_VERTEX_SHADER);
    const fs = this.compile(gl, gl.FRAGMENT_SHADER, FIRE_FRAGMENT_SHADER);
    if (!vs || !fs) return false;
    const program = gl.createProgram();
    gl.attachShader(program, vs);
    gl.attachShader(program, fs);
    gl.linkProgram(program);
    gl.deleteShader(vs);
    gl.deleteShader(fs);
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
      if (!gl.isContextLost()) this.onFailure(`fire shader link failed: ${gl.getProgramInfoLog(program) ?? ''}`);
      gl.deleteProgram(program);
      return false;
    }
    const at = (name: string): WebGLUniformLocation | null => gl.getUniformLocation(program, name);
    this.program = program;
    this.vao = gl.createVertexArray();
    this.uniforms = {
      res: at('u_res'),
      time: at('u_time'),
      heat: at('u_heat'),
      seed: at('u_seed'),
      height: at('u_height'),
      radius: at('u_radius'),
      p0: at('u_p0'),
      p1: at('u_p1'),
      low: at('u_low'),
      mid: at('u_mid'),
      hot: at('u_hot'),
      embers: at('u_embers[0]'),
      emberCount: at('u_emberCount'),
    };
    return true;
  }

  private compile(gl: WebGL2RenderingContext, type: number, source: string): WebGLShader | null {
    const shader = gl.createShader(type);
    if (!shader) return null;
    gl.shaderSource(shader, source);
    gl.compileShader(shader);
    if (gl.getShaderParameter(shader, gl.COMPILE_STATUS)) return shader;
    if (!gl.isContextLost()) this.onFailure(`fire shader compile failed: ${gl.getShaderInfoLog(shader) ?? ''}`);
    gl.deleteShader(shader);
    return null;
  }

  private ensureLoop(): void {
    if (this.rafId === 0 && !this.lost && !this.disposed) this.rafId = requestAnimationFrame(this.frame);
  }

  private cancelLoop(): void {
    if (this.rafId !== 0) cancelAnimationFrame(this.rafId);
    this.rafId = 0;
  }

  private hide(): void {
    this.cancelLoop();
    this.heat = 0;
    this.canvas.style.display = 'none';
  }

  private readonly frame = (ts: number): void => {
    this.rafId = requestAnimationFrame(this.frame);
    // Timestamp gate: at most fpsCap draws per second on high-refresh displays.
    if (this.lastDraw !== 0 && ts - this.lastDraw < 1000 / FIRE.fpsCap - 2) return;
    const dt = this.lastDraw === 0 ? 1 / FIRE.fpsCap : Math.min(0.1, (ts - this.lastDraw) / 1000);
    this.lastDraw = ts;
    this.heat = stepHeat(this.heat, this.running ? 1 : 0, dt);
    this.t = (this.t + dt) % TIME_WRAP_S;
    if (!this.running && this.heat < OUT_HEAT) {
      this.hide();
      return;
    }
    this.draw(true);
  };

  /** Reduced motion: one frame at full heat, no embers, no loop. */
  private drawStatic(): void {
    this.cancelLoop();
    this.heat = 1;
    this.t = 0;
    this.draw(false);
  }

  private draw(withEmbers: boolean): void {
    const gl = this.gl;
    const u = this.uniforms;
    const colors = this.colors;
    if (!gl || !u || !this.program || !colors || this.lost) return;
    const { cssWidth: w, cssHeight: h } = this.band;
    if (w <= 0 || h <= 0) return;
    const height = this.band.flameMax * (0.45 + 0.55 * this.heat);
    const count = withEmbers ? fireEmbers(this.t, this.seed, this.band, this.radius, height, this.embers) : 0;
    gl.viewport(0, 0, w, h);
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT);
    gl.useProgram(this.program);
    gl.bindVertexArray(this.vao);
    gl.uniform2f(u.res, w, h);
    gl.uniform1f(u.time, this.t);
    gl.uniform1f(u.heat, this.heat);
    gl.uniform1ui(u.seed, this.seed);
    gl.uniform1f(u.height, height);
    gl.uniform1f(u.radius, this.radius);
    gl.uniform4f(u.p0, FIRE.scale, FIRE.speed, FIRE.warp, FIRE.baseGlow);
    gl.uniform4f(u.p1, FIRE.occlusion, FIRE.intensity, FIRE.glowRadius, FIRE.glowReach);
    gl.uniform3fv(u.low, colors.low);
    gl.uniform3fv(u.mid, colors.mid);
    gl.uniform3fv(u.hot, colors.hot);
    gl.uniform4fv(u.embers, this.embers);
    gl.uniform1i(u.emberCount, count);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
  }

  private readonly onMotionChange = (): void => {
    if (!this.running || this.lost) return;
    if (this.reduceMotion.matches) {
      this.drawStatic();
    } else {
      this.lastDraw = 0;
      this.ensureLoop();
    }
  };

  private readonly onContextLost = (e: Event): void => {
    // Never re-create the context here: WebKit would drop another one, and the
    // replacement loop storms (flutter/flutter#195025). Wait for a restore.
    e.preventDefault();
    this.lost = true;
    this.cancelLoop();
    this.canvas.style.display = 'none';
    this.program = null;
    this.vao = null;
    this.uniforms = null;
  };

  private readonly onContextRestored = (): void => {
    this.lost = false;
    if (this.disposed || !this.initResources() || !this.running) return;
    this.canvas.style.display = 'block';
    this.lastDraw = 0;
    if (this.reduceMotion.matches) this.drawStatic();
    else this.ensureLoop();
  };
}

// ─── Controller ─────────────────────────────────────────────────

/** Per-window fires, driven by the compositor's program-status paint. */
export class FireController {
  private states: ReadonlySet<FireState> = new Set();
  private readonly fires = new Map<WindowId, FireAnimation>();
  private readonly warnedStates = new Set<string>();
  private unavailable = false;

  /** `[fire] on`: keep known states, warn once per unknown value. */
  configure(on: readonly string[]): void {
    const next = new Set<FireState>();
    for (const value of on) {
      if (FIRE_STATES[value] === true) {
        next.add(value as FireState);
      } else if (!this.warnedStates.has(value)) {
        this.warnedStates.add(value);
        console.warn(`[Krypton] [fire] on: unknown program state "${value}" ignored`);
      }
    }
    this.states = next;
  }

  /** Light or put out `win` for its current program-status aggregate. */
  sync(win: KryptonWindow, state: ProgramState | null): void {
    const burning = state !== null && this.states.has(state as FireState);
    let fire = this.fires.get(win.id);
    if (!burning) {
      fire?.stop();
      return;
    }
    if (this.unavailable) return;
    if (!fire) {
      fire = new FireAnimation(win.contentElement, win.element, (reason) => this.disable(reason));
      this.fires.set(win.id, fire);
      win.contentElement.insertBefore(fire.getElement(), win.contentElement.firstChild);
    }
    fire.start();
  }

  /** Re-measure after relayout. */
  resize(): void {
    for (const fire of this.fires.values()) {
      if (fire.isRunning()) fire.resize();
    }
  }

  remove(windowId: WindowId): void {
    this.fires.get(windowId)?.dispose();
    this.fires.delete(windowId);
  }

  /** WebGL2 or the shader failed: the cause is the same for every window, so stop trying. */
  private disable(reason: string): void {
    if (this.unavailable) return;
    this.unavailable = true;
    console.warn(`[Krypton] Program-status fire disabled: ${reason}`);
    for (const fire of this.fires.values()) fire.dispose();
    this.fires.clear();
  }
}
