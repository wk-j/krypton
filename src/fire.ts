// Krypton — Workspace and Titlebar Fire (specs 0362, 0363, 0365, 0391, 0392).
//
// A window counts as burning while its program-status aggregate (OSC 7501,
// spec 0284) is one of the states listed in `[fire] on`, or while a content
// view in it reports a fire trigger listed there (`tool_error`: an ACP Harness
// tool call failed, spec 0365). The compositor calls `sync` from
// `paintProgramStatus`, the only driver, so each window's entry always matches
// what the window holds.
// The workspace burns while any window does, with the look of the most urgent
// burning state (spec 0391). Each burning window also burns along its progress
// band: flames as wide as the band rise through the titlebar and past the top
// of the window (spec 0392). Two lazy WebGL2 contexts serve the workspace and all titlebars;
// titlebars copy the shared scratch renderer into their own 2D canvases.
// The loops stop once the fire is out; an unlit workspace allocates nothing.
// Each state has its own look (`[fire]` + `[fire.<state>]`, spec 0363); a lit
// fire eases to the new look when the top state changes.
//
// The ember table below ports rune-fx `cpu.rs::embers`; see the MIT notice in
// `fire-shader.ts`.

import type { BackgroundAnimation } from './background-animation';
import type { FireConfig, FireLookConfig } from './config';
import { FIRE_EMBER_VEC4S, FIRE_FRAGMENT_SHADER, FIRE_VERTEX_SHADER } from './fire-shader';
import { programStatePriority, type ProgramState } from './program-status';
import type { WindowId } from './types';

export type FireState = 'working' | 'blocked' | 'error' | 'done';
/** A non-program-status reason to burn, reported by a content view (spec 0365). */
export type FireTrigger = 'tool_error';

const FIRE_STATE_LIST: readonly FireState[] = ['working', 'blocked', 'error', 'done'];
const FIRE_STATES: Record<string, true> = { working: true, blocked: true, error: true, done: true };

function isFireState(value: string): value is FireState {
  return FIRE_STATES[value] === true;
}

/**
 * The look a window counts toward the workspace fire with: its program state
 * when `on` lists it, or `error` for a listed `tool_error`, whichever ranks
 * higher by program-status priority. Null when nothing listed in `on` applies.
 */
export function fireLookState(
  state: ProgramState | null,
  trigger: FireTrigger | null,
  on: ReadonlySet<FireState | FireTrigger>,
): FireState | null {
  let look: FireState | null = state !== null && isFireState(state) && on.has(state) ? state : null;
  if (trigger === 'tool_error' && on.has('tool_error')
    && (look === null || programStatePriority('error') > programStatePriority(look))) {
    look = 'error';
  }
  return look;
}

/**
 * The look the workspace burns with: the highest-priority burn state among
 * the windows (spec 0391). Null when no window burns.
 */
export function workspaceFireState(states: Iterable<FireState>): FireState | null {
  let top: FireState | null = null;
  for (const state of states) {
    if (top === null || programStatePriority(state) > programStatePriority(top)) top = state;
  }
  return top;
}

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

/** Built-in tallest flame for a content height (px): 22% of it, kept within 40–120. */
function flameBase(contentH: number): number {
  return Math.min(120, Math.max(40, 0.22 * contentH));
}

/** Canvas band for a content area: tall enough for the tallest flame (scaled by
 *  the look's `height`) and its embers, never taller than the content. */
export function fireBand(contentW: number, contentH: number, height: number): FireBand {
  const w = Math.max(0, Math.round(contentW));
  const h = Math.max(0, Math.round(contentH));
  const flameMax = flameBase(h) * height;
  return { cssWidth: w, cssHeight: Math.min(h, Math.ceil(flameMax * 2.2)), flameMax };
}

/**
 * Titlebar canvas (spec 0392): exactly as wide as the progress band, its bottom
 * edge on the band's bottom edge. `baseline` is that edge's depth below the top
 * of the chrome; the tallest flame is twice it (kept within 40–120, scaled by
 * the look's `height`), so flames rise through the titlebar and past the top of
 * the window. Tall enough for the flame and its embers, like `fireBand`.
 */
export function titlebarFireBand(bandWidth: number, baseline: number, height: number): FireBand {
  const flameMax = Math.min(120, Math.max(40, 2 * baseline)) * height;
  return { cssWidth: Math.max(0, Math.round(bandWidth)), cssHeight: Math.ceil(flameMax * 2.2), flameMax };
}

/** Exponential approach to the target: τ 0.25 s igniting, τ 0.45 s putting out. */
export function stepHeat(heat: number, target: 0 | 1, dt: number): number {
  const tau = target > heat ? IGNITE_TAU_S : PUT_OUT_TAU_S;
  return heat + (target - heat) * (1 - Math.exp(-Math.max(0, dt) / tau));
}

// ─── Looks (spec 0363) ──────────────────────────────────────────

/** Multiplier ranges for the `[fire]` look keys; 1 is the spec 0362 look. */
export const FIRE_LOOK_LIMITS = {
  height: { min: 0.25, max: 3 },
  intensity: { min: 0.1, max: 2 },
  speed: { min: 0.25, max: 4 },
} as const;

type LookNumberKey = keyof typeof FIRE_LOOK_LIMITS;
type LookColorKey = 'low' | 'mid' | 'hot';

/** One state's look. A colour is the first valid config value (state table
 *  first); null leaves it to the `krypton-fire-*` theme token, then the default. */
export interface FireLook {
  readonly height: number;
  readonly intensity: number;
  readonly speed: number;
  readonly low: string | null;
  readonly mid: string | null;
  readonly hot: string | null;
}

/** Every key unset: the spec 0362 look in the theme's fire colours. */
const BUILT_IN_LOOK: FireLook = { height: 1, intensity: 1, speed: 1, low: null, mid: null, hot: null };

type LookTable = readonly [name: string, table: FireLookConfig | null | undefined];

function lookNumber(tables: readonly LookTable[], key: LookNumberKey, warn: (msg: string) => void): number {
  for (const [name, table] of tables) {
    const raw = table?.[key];
    // `inf`/`nan` reach the frontend as null: unset, like a missing key.
    if (typeof raw !== 'number' || !Number.isFinite(raw)) continue;
    const { min, max } = FIRE_LOOK_LIMITS[key];
    const value = Math.min(max, Math.max(min, raw));
    if (value !== raw) warn(`${name} ${key} = ${raw} is outside ${min}–${max}; using ${value}`);
    return value;
  }
  return 1;
}

function lookColor(
  tables: readonly LookTable[],
  key: LookColorKey,
  warn: (msg: string) => void,
  isColor: (value: string) => boolean,
): string | null {
  for (const [name, table] of tables) {
    const raw = table?.[key];
    if (typeof raw !== 'string' || raw.trim() === '') continue;
    const value = raw.trim();
    if (isColor(value)) return value;
    warn(`${name} ${key} = "${raw}" is not a CSS colour; ignored`);
  }
  return null;
}

/**
 * Every state's look: each key comes from `[fire.<state>]`, then `[fire]`, then
 * the built-in value. Out-of-range numbers are clamped and invalid colours
 * skipped, each reported through `warn` (the caller deduplicates).
 */
export function resolveFireLooks(
  cfg: FireConfig | null | undefined,
  warn: (msg: string) => void,
  isColor: (value: string) => boolean,
): Record<FireState, FireLook> {
  const looks = {} as Record<FireState, FireLook>;
  for (const state of FIRE_STATE_LIST) {
    const tables: readonly LookTable[] = [[`[fire.${state}]`, cfg?.[state]], ['[fire]', cfg]];
    looks[state] = {
      height: lookNumber(tables, 'height', warn),
      intensity: lookNumber(tables, 'intensity', warn),
      speed: lookNumber(tables, 'speed', warn),
      low: lookColor(tables, 'low', warn, isColor),
      mid: lookColor(tables, 'mid', warn, isColor),
      hot: lookColor(tables, 'hot', warn, isColor),
    };
  }
  return looks;
}

type Rgb = [number, number, number];

/** A look as drawn: multipliers plus colours in linear RGB. */
export interface LiveLook {
  height: number;
  intensity: number;
  speed: number;
  low: Rgb;
  mid: Rgb;
  hot: Rgb;
}

const LOOK_COLOR_KEYS: readonly LookColorKey[] = ['low', 'mid', 'hot'];
/** Below this difference on every channel the ease snaps to its target. */
const LOOK_SETTLE = 0.001;

function copyLook(to: LiveLook, from: LiveLook): void {
  to.height = from.height;
  to.intensity = from.intensity;
  to.speed = from.speed;
  for (const c of LOOK_COLOR_KEYS) {
    to[c][0] = from[c][0];
    to[c][1] = from[c][1];
    to[c][2] = from[c][2];
  }
}

function lookSettled(a: LiveLook, b: LiveLook): boolean {
  if (Math.abs(a.height - b.height) >= LOOK_SETTLE) return false;
  if (Math.abs(a.intensity - b.intensity) >= LOOK_SETTLE) return false;
  if (Math.abs(a.speed - b.speed) >= LOOK_SETTLE) return false;
  for (const c of LOOK_COLOR_KEYS) {
    for (let i = 0; i < 3; i++) {
      if (Math.abs(a[c][i] - b[c][i]) >= LOOK_SETTLE) return false;
    }
  }
  return true;
}

/**
 * Ease `live` toward `target` in place with the ignite time constant (τ 0.25 s).
 * Returns true once every value is within 0.001, after snapping to the target.
 */
export function stepLook(live: LiveLook, target: LiveLook, dt: number): boolean {
  const k = 1 - Math.exp(-Math.max(0, dt) / IGNITE_TAU_S);
  live.height += (target.height - live.height) * k;
  live.intensity += (target.intensity - live.intensity) * k;
  live.speed += (target.speed - live.speed) * k;
  for (const c of LOOK_COLOR_KEYS) {
    for (let i = 0; i < 3; i++) live[c][i] += (target[c][i] - live[c][i]) * k;
  }
  if (!lookSettled(live, target)) return false;
  copyLook(live, target);
  return true;
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

function srgbToLinear(c: number): number {
  return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
}

/** 1×1 scratch canvas that turns any computed CSS colour (rgb, oklch, color()…) into sRGB bytes. */
let colorScratch: CanvasRenderingContext2D | null = null;

/** Resolve one look colour into linear RGB: the config value when set, else
 *  `var(--krypton-fire-<key>, <default>)` through the cascade. */
function readFireColor(probe: HTMLElement, key: LookColorKey, value: string | null): Rgb {
  const fallback = DEFAULT_COLORS[key];
  probe.style.color = value ?? `var(--krypton-fire-${key}, ${fallback})`;
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

/** Shared GL resources and shader draw path; animation owners keep their clocks. */
class FirePainter {
  private gl: WebGL2RenderingContext | null = null;
  private program: WebGLProgram | null = null;
  private vao: WebGLVertexArrayObject | null = null;
  private uniforms: FireUniforms | null = null;
  private readonly embers = new Float32Array(FIRE_EMBER_VEC4S * 4);

  constructor(
    private readonly canvas: HTMLCanvasElement,
    private readonly onFailure: (reason: string) => void,
  ) {}

  init(): boolean {
    if (this.gl) return this.program !== null;
    this.gl = this.canvas.getContext('webgl2', CONTEXT_OPTIONS);
    if (!this.gl) {
      this.onFailure('WebGL2 is unavailable');
      return false;
    }
    return this.restore();
  }

  restore(): boolean {
    const gl = this.gl;
    if (!gl) return false;
    const vs = this.compile(gl, gl.VERTEX_SHADER, FIRE_VERTEX_SHADER);
    const fs = this.compile(gl, gl.FRAGMENT_SHADER, FIRE_FRAGMENT_SHADER);
    if (!vs || !fs) {
      if (vs) gl.deleteShader(vs);
      if (fs) gl.deleteShader(fs);
      return false;
    }
    const program = gl.createProgram();
    if (!program) {
      gl.deleteShader(vs);
      gl.deleteShader(fs);
      this.onFailure('fire shader program allocation failed');
      return false;
    }
    gl.attachShader(program, vs);
    gl.attachShader(program, fs);
    gl.linkProgram(program);
    gl.deleteShader(vs);
    gl.deleteShader(fs);
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
      const reason = `fire shader link failed: ${gl.getProgramInfoLog(program) ?? ''}`;
      gl.deleteProgram(program);
      if (!gl.isContextLost()) this.onFailure(reason);
      return false;
    }
    const at = (name: string): WebGLUniformLocation | null => gl.getUniformLocation(program, name);
    this.program = program;
    this.vao = gl.createVertexArray();
    this.uniforms = {
      res: at('u_res'), time: at('u_time'), heat: at('u_heat'), seed: at('u_seed'),
      height: at('u_height'), radius: at('u_radius'), p0: at('u_p0'), p1: at('u_p1'),
      low: at('u_low'), mid: at('u_mid'), hot: at('u_hot'),
      embers: at('u_embers[0]'), emberCount: at('u_emberCount'),
    };
    return true;
  }

  invalidate(): void {
    this.program = null;
    this.vao = null;
    this.uniforms = null;
  }

  dispose(): void {
    if (this.program) this.gl?.deleteProgram(this.program);
    if (this.vao) this.gl?.deleteVertexArray(this.vao);
    this.gl?.getExtension('WEBGL_lose_context')?.loseContext();
    this.gl = null;
    this.invalidate();
  }

  draw(
    band: FireBand, live: LiveLook, heat: number, t: number, seed: number,
    radius: number, height: number, withEmbers: boolean,
  ): void {
    const gl = this.gl;
    const u = this.uniforms;
    if (!gl || !u || !this.program || gl.isContextLost()) return;
    const w = band.cssWidth;
    const h = band.cssHeight;
    if (w <= 0 || h <= 0) return;
    const count = withEmbers ? fireEmbers(t, seed, band, radius, height, this.embers) : 0;
    gl.viewport(0, 0, w, h);
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT);
    gl.useProgram(this.program);
    gl.bindVertexArray(this.vao);
    gl.uniform2f(u.res, w, h);
    gl.uniform1f(u.time, t);
    gl.uniform1f(u.heat, heat);
    gl.uniform1ui(u.seed, seed);
    gl.uniform1f(u.height, height);
    gl.uniform1f(u.radius, radius);
    gl.uniform4f(u.p0, FIRE.scale, FIRE.speed, FIRE.warp, FIRE.baseGlow);
    gl.uniform4f(u.p1, FIRE.occlusion, FIRE.intensity * live.intensity, FIRE.glowRadius, FIRE.glowReach);
    gl.uniform3fv(u.low, live.low);
    gl.uniform3fv(u.mid, live.mid);
    gl.uniform3fv(u.hot, live.hot);
    gl.uniform4fv(u.embers, this.embers);
    gl.uniform1i(u.emberCount, count);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
  }

  private compile(gl: WebGL2RenderingContext, type: number, source: string): WebGLShader | null {
    const shader = gl.createShader(type);
    if (!shader) {
      this.onFailure('fire shader allocation failed');
      return null;
    }
    gl.shaderSource(shader, source);
    gl.compileShader(shader);
    if (gl.getShaderParameter(shader, gl.COMPILE_STATUS)) return shader;
    const reason = `fire shader compile failed: ${gl.getShaderInfoLog(shader) ?? ''}`;
    gl.deleteShader(shader);
    if (!gl.isContextLost()) this.onFailure(reason);
    return null;
  }
}

function createLiveLook(): LiveLook {
  return { height: 1, intensity: 1, speed: 1, low: [0, 0, 0], mid: [0, 0, 0], hot: [0, 0, 0] };
}

function resolveLiveLook(probe: HTMLElement, look: FireLook, target: LiveLook): void {
  target.height = look.height;
  target.intensity = look.intensity;
  target.speed = look.speed;
  target.low = readFireColor(probe, 'low', look.low);
  target.mid = readFireColor(probe, 'mid', look.mid);
  target.hot = readFireColor(probe, 'hot', look.hot);
}

/** The workspace fire: a WebGL2 band canvas along the bottom of `host`, `floor`
 *  px above its bottom edge (the workspace footer), under every window. */
export class FireAnimation implements BackgroundAnimation {
  private readonly canvas: HTMLCanvasElement;
  private readonly reduceMotion: MediaQueryList;
  private readonly seed = (Math.random() * 0x100000000) >>> 0;
  private readonly painter: FirePainter;
  private band: FireBand = { cssWidth: 0, cssHeight: 0, flameMax: 40 };
  /** Built-in tallest flame for the current host height; the look scales it. */
  private flameBase = 40;
  /** The host under the band is the footer's square seam: flames and embers
   *  run to both screen edges. */
  private readonly radius = 0;
  /** The look the window's state asks for. `target` is it with colours
   *  resolved; `live` is what is drawn and eases toward `target`. */
  private look: FireLook = BUILT_IN_LOOK;
  private readonly target = createLiveLook();
  private readonly live = createLiveLook();
  /** `live` has reached `target`. */
  private settled = true;
  /** Target is lit (heat → 1). */
  private running = false;
  private rafId = 0;
  private lastDraw = 0;
  private heat = 0;
  private t = 0;
  private lost = false;
  private disposed = false;

  constructor(
    private readonly host: HTMLElement,
    private floor: number,
    onFailure: (reason: string) => void,
  ) {
    this.canvas = document.createElement('canvas');
    this.canvas.className = 'krypton-fire-canvas';
    this.canvas.style.bottom = `${floor}px`;
    this.painter = new FirePainter(this.canvas, onFailure);
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
    if (this.lost) {
      this.running = true;
      return;
    }
    if (!this.painter.init()) return;
    const wasOut = this.rafId === 0;
    this.running = true;
    if (wasOut) {
      this.t = 0;
      this.heat = 0;
      this.lastDraw = 0;
      // Igniting never eases from a stale look; colours re-read theme tokens here.
      resolveLiveLook(this.canvas, this.look, this.target);
      copyLook(this.live, this.target);
      this.settled = true;
      this.setShown(true);
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

  /** Show `look`: eased while lit; while out, `start()` picks it up. */
  setLook(look: FireLook): void {
    if (this.disposed || look === this.look) return;
    this.look = look;
    if (!this.running && this.rafId === 0) return;
    resolveLiveLook(this.canvas, this.look, this.target);
    if (this.rafId === 0) {
      // No loop to ease with (reduced motion, or a lost context): switch at once.
      copyLook(this.live, this.target);
      this.settled = true;
    } else {
      this.settled = false;
    }
    // Grows the band now if the target is taller; redraws a static frame.
    this.resize();
  }

  /** Move the band's bottom edge: the footer's height while it shows, 0 when hidden. */
  setFloor(px: number): void {
    if (this.disposed || px === this.floor) return;
    this.floor = px;
    this.canvas.style.bottom = `${px}px`;
    if (this.running || this.rafId !== 0) this.resize();
  }

  resize(): void {
    // While easing, the band fits the taller of the drawn and the target look,
    // so it grows when a change starts and shrinks once the ease ends.
    const scale = Math.max(this.live.height, this.target.height);
    const band = fireBand(this.host.clientWidth, Math.max(0, this.host.clientHeight - this.floor), scale);
    this.band = band;
    this.flameBase = band.flameMax / scale;
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
    this.painter.dispose();
    this.canvas.remove();
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
    this.setShown(false);
  }

  private setShown(shown: boolean): void {
    this.canvas.style.display = shown ? 'block' : 'none';
  }


  private readonly frame = (ts: number): void => {
    this.rafId = requestAnimationFrame(this.frame);
    // Timestamp gate: at most fpsCap draws per second on high-refresh displays.
    if (this.lastDraw !== 0 && ts - this.lastDraw < 1000 / FIRE.fpsCap - 2) return;
    const dt = this.lastDraw === 0 ? 1 / FIRE.fpsCap : Math.min(0.1, (ts - this.lastDraw) / 1000);
    this.lastDraw = ts;
    this.heat = stepHeat(this.heat, this.running ? 1 : 0, dt);
    if (!this.settled && stepLook(this.live, this.target, dt)) {
      this.settled = true;
      this.resize(); // the ease ended: shrink the band if the look got shorter
    }
    // A phase clock, so a speed change never jumps the noise or the embers.
    this.t = (this.t + dt * this.live.speed) % TIME_WRAP_S;
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
    if (this.lost) return;
    const height = this.flameBase * this.live.height * (0.45 + 0.55 * this.heat);
    this.painter.draw(this.band, this.live, this.heat, this.t, this.seed, this.radius, height, withEmbers);
  }

  private readonly onMotionChange = (): void => {
    if (!this.running || this.lost) return;
    if (this.reduceMotion.matches) {
      // Reduced motion never eases: show the target look in the static frame.
      this.cancelLoop();
      copyLook(this.live, this.target);
      this.settled = true;
      this.resize(); // fits the band and draws the static frame
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
    this.setShown(false);
    this.painter.invalidate();
  };

  private readonly onContextRestored = (): void => {
    this.lost = false;
    if (this.disposed || !this.painter.restore() || !this.running) return;
    this.running = false;
    this.start();
  };
}

/** Flames taper over the band's last ~11px at each end instead of stopping at
 *  the canvas edge; embers stay inside the same inset. */
const TITLEBAR_FIRE_RADIUS = 12;
/** Chrome modifier that lets the canvas rise past the top of the window. */
const CHROME_FIRE_CLASS = 'krypton-window__chrome--fire';
/** Window modifier while the canvas shows: lifts the window above its siblings
 *  so the flames above it paint over neighbouring windows. */
const WINDOW_FIRE_CLASS = 'krypton-window--fire';

interface TitlebarFire {
  readonly host: HTMLElement;
  readonly surface: HTMLElement;
  readonly edge: HTMLElement;
  /** The `.krypton-window` that owns the chrome, raised while the fire shows. */
  readonly win: HTMLElement | null;
  readonly canvas: HTMLCanvasElement;
  readonly ctx: CanvasRenderingContext2D;
  readonly seed: number;
  readonly live: LiveLook;
  readonly target: LiveLook;
  /** Band geometry in chrome px, read only on observer/state events. */
  left: number;
  baseline: number;
  width: number;
  /** The canvas: band-wide, bottom on the band's bottom edge. */
  band: FireBand;
  /** Built-in tallest flame for the band; the look scales it. */
  flameBase: number;
  look: FireLook;
  running: boolean;
  visible: boolean;
  settled: boolean;
  heat: number;
  t: number;
}

/** One scratch WebGL context and clock for every titlebar, never one per window. */
class TitlebarFires {
  private readonly scratch = document.createElement('canvas');
  private readonly painter = new FirePainter(this.scratch, (reason) => this.disable(reason));
  private readonly entries = new Map<WindowId, TitlebarFire>();
  private readonly hosts = new Map<Element, TitlebarFire>();
  private readonly drawing: TitlebarFire[] = [];
  private readonly reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)');
  private readonly sizes = new ResizeObserver((entries) => {
    for (const observed of entries) {
      const entry = this.hosts.get(observed.target);
      if (!entry) continue;
      this.measure(entry);
    }
    this.resizeScratch();
    this.refresh();
  });
  private readonly visibility = new IntersectionObserver((entries) => {
    for (const observed of entries) {
      const entry = this.hosts.get(observed.target);
      if (entry) entry.visible = observed.isIntersecting;
    }
    this.refresh();
  });
  private rafId = 0;
  private lastDraw = 0;
  private lost = false;
  private disposed = false;

  constructor(private readonly onFailure: (reason: string) => void) {
    this.reduceMotion.addEventListener('change', this.onMotionChange);
    document.addEventListener('visibilitychange', this.onVisibilityChange);
    this.scratch.addEventListener('webglcontextlost', this.onContextLost);
    this.scratch.addEventListener('webglcontextrestored', this.onContextRestored);
  }

  sync(id: WindowId, host: HTMLElement | null, look: FireLook | null): void {
    if (this.disposed) return;
    let entry = this.entries.get(id);
    const surface = host?.parentElement ?? null;
    const edge = surface?.querySelector<HTMLElement>(':scope > .krypton-window__header-accent') ?? null;
    if (entry && (entry.host !== host || entry.surface !== surface || entry.edge !== edge)) {
      this.remove(id);
      entry = undefined;
    }
    if (!host || !surface || !edge || (!entry && !look)) return;
    if (!entry) {
      if (!look) return;
      const canvas = document.createElement('canvas');
      canvas.className = 'krypton-titlebar-fire-canvas';
      canvas.setAttribute('aria-hidden', 'true');
      canvas.style.display = 'none';
      const ctx = canvas.getContext('2d');
      if (!ctx) {
        this.disable('Canvas 2D is unavailable');
        return;
      }
      entry = {
        host, surface, edge, win: surface.closest<HTMLElement>('.krypton-window'), canvas, ctx, seed: (Math.random() * 0x100000000) >>> 0,
        look, live: createLiveLook(), target: createLiveLook(),
        left: 0, baseline: 0, width: 0,
        band: { cssWidth: 0, cssHeight: 0, flameMax: 40 }, flameBase: 40,
        running: false, visible: false, settled: true, heat: 0, t: 0,
      };
      this.entries.set(id, entry);
      this.hosts.set(host, entry);
      this.hosts.set(surface, entry);
      this.hosts.set(edge, entry);
      surface.prepend(canvas);
      surface.classList.add(CHROME_FIRE_CLASS);
      this.measure(entry);
      this.sizes.observe(host);
      this.sizes.observe(surface);
      this.sizes.observe(edge);
      this.visibility.observe(host);
    }
    const starting = look !== null && !entry.running;
    if (look && (starting || entry.look !== look)) {
      entry.look = look;
      resolveLiveLook(entry.canvas, look, entry.target);
      if (entry.heat < OUT_HEAT) {
        entry.heat = 0;
        entry.t = 0;
        copyLook(entry.live, entry.target);
        entry.settled = true;
      } else {
        entry.settled = false;
      }
      // A taller target grows the canvas now; the frame loop shrinks it once the ease ends.
      this.layout(entry);
      this.resizeScratch();
    } else if (entry.running === (look !== null)) {
      return;
    }
    entry.running = look !== null;
    this.refresh();
  }

  remove(id: WindowId): void {
    const entry = this.entries.get(id);
    if (!entry) return;
    this.entries.delete(id);
    this.hosts.delete(entry.host);
    this.hosts.delete(entry.surface);
    this.hosts.delete(entry.edge);
    this.sizes.unobserve(entry.host);
    this.sizes.unobserve(entry.surface);
    this.sizes.unobserve(entry.edge);
    this.visibility.unobserve(entry.host);
    entry.canvas.remove();
    entry.surface.classList.remove(CHROME_FIRE_CLASS);
    entry.win?.classList.remove(WINDOW_FIRE_CLASS);
    this.resizeScratch();
    this.refresh();
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.cancelLoop();
    this.sizes.disconnect();
    this.visibility.disconnect();
    this.reduceMotion.removeEventListener('change', this.onMotionChange);
    document.removeEventListener('visibilitychange', this.onVisibilityChange);
    this.scratch.removeEventListener('webglcontextlost', this.onContextLost);
    this.scratch.removeEventListener('webglcontextrestored', this.onContextRestored);
    this.painter.dispose();
    for (const entry of this.entries.values()) {
      entry.canvas.remove();
      entry.surface.classList.remove(CHROME_FIRE_CLASS);
      entry.win?.classList.remove(WINDOW_FIRE_CLASS);
    }
    this.entries.clear();
    this.hosts.clear();
    this.drawing.length = 0;
  }

  /** Read the band's box in chrome px (observer and creation paths only). */
  private measure(entry: TitlebarFire): void {
    entry.left = entry.edge.offsetLeft;
    entry.baseline = entry.edge.offsetTop + entry.edge.clientHeight;
    entry.width = entry.edge.clientWidth;
    this.layout(entry);
  }

  /** Fit the canvas to the band and the taller of the drawn and target look.
   *  Writes only; the canvas bottom sits on the band's bottom edge and its top
   *  reaches above the chrome (negative `top`). */
  private layout(entry: TitlebarFire): void {
    const scale = Math.max(entry.live.height, entry.target.height);
    const band = titlebarFireBand(entry.width, entry.baseline, scale);
    entry.band = band;
    entry.flameBase = band.flameMax / scale;
    const { canvas } = entry;
    if (canvas.width !== band.cssWidth) canvas.width = band.cssWidth;
    if (canvas.height !== band.cssHeight) canvas.height = band.cssHeight;
    canvas.style.left = `${entry.left}px`;
    canvas.style.top = `${entry.baseline - band.cssHeight}px`;
    canvas.style.width = `${band.cssWidth}px`;
    canvas.style.height = `${band.cssHeight}px`;
  }

  private resizeScratch(): void {
    let w = 0;
    let h = 64;
    for (const entry of this.entries.values()) {
      w = Math.max(w, entry.band.cssWidth);
      h = Math.max(h, entry.band.cssHeight);
    }
    if (this.scratch.width !== w) this.scratch.width = w;
    if (this.scratch.height !== h) this.scratch.height = h;
  }

  /** Rebuild only on state/observer events, not in the frame loop. */
  private refresh(): void {
    if (this.disposed) return;
    this.drawing.length = 0;
    for (const entry of this.entries.values()) {
      const visible = !document.hidden && !this.lost && entry.visible && entry.host.isConnected
        && entry.canvas.width > 0 && entry.canvas.height > 0;
      if (!visible || (!entry.running && this.reduceMotion.matches)) {
        if (!entry.running) entry.heat = 0;
        this.show(entry, false);
      } else if (entry.running || entry.heat >= OUT_HEAT) {
        this.drawing.push(entry);
      }
    }
    if (this.drawing.length === 0) {
      this.cancelLoop();
    } else if (this.reduceMotion.matches) {
      this.cancelLoop();
      if (!this.painter.init()) return;
      for (const entry of this.drawing) {
        copyLook(entry.live, entry.target);
        entry.settled = true;
        entry.heat = 1;
        entry.t = 0;
        this.layout(entry); // never taller than before: the scratch still fits
        this.draw(entry, false);
      }
      this.resizeScratch();
    } else if (this.rafId === 0) {
      this.lastDraw = 0;
      this.rafId = requestAnimationFrame(this.frame);
    }
  }

  private draw(entry: TitlebarFire, withEmbers: boolean): void {
    const { band } = entry;
    const height = entry.flameBase * entry.live.height * (0.45 + 0.55 * entry.heat);
    this.painter.draw(band, entry.live, entry.heat, entry.t, entry.seed, TITLEBAR_FIRE_RADIUS, height, withEmbers);
    entry.ctx.clearRect(0, 0, band.cssWidth, band.cssHeight);
    // GL viewports start at bottom-left; drawImage source rectangles at top-left.
    // Same size on both sides: a 1:1 copy, no scaling.
    entry.ctx.drawImage(
      this.scratch, 0, this.scratch.height - band.cssHeight, band.cssWidth, band.cssHeight,
      0, 0, band.cssWidth, band.cssHeight,
    );
    this.show(entry, true);
  }

  /** The canvas and the window lift change together, and only on a change. */
  private show(entry: TitlebarFire, shown: boolean): void {
    const display = shown ? 'block' : 'none';
    if (entry.canvas.style.display === display) return;
    entry.canvas.style.display = display;
    entry.win?.classList.toggle(WINDOW_FIRE_CLASS, shown);
  }

  private readonly frame = (ts: number): void => {
    this.rafId = 0;
    if (this.lastDraw !== 0 && ts - this.lastDraw < 1000 / FIRE.fpsCap - 2) {
      this.rafId = requestAnimationFrame(this.frame);
      return;
    }
    if (!this.painter.init()) return;
    const dt = this.lastDraw === 0 ? 1 / FIRE.fpsCap : Math.min(0.1, (ts - this.lastDraw) / 1000);
    this.lastDraw = ts;
    let active = false;
    let shrunk = false;
    for (let i = 0; i < this.drawing.length; i++) {
      const entry = this.drawing[i];
      entry.heat = stepHeat(entry.heat, entry.running ? 1 : 0, dt);
      if (!entry.running && entry.heat < OUT_HEAT) {
        this.show(entry, false);
        continue;
      }
      if (!entry.settled && stepLook(entry.live, entry.target, dt)) {
        entry.settled = true;
        this.layout(entry); // the ease ended: shrink the canvas if the look got shorter
        shrunk = true;
      }
      entry.t = (entry.t + dt * entry.live.speed) % TIME_WRAP_S;
      this.draw(entry, true);
      active = true;
    }
    if (shrunk) this.resizeScratch();
    if (active) this.rafId = requestAnimationFrame(this.frame);
  };

  private cancelLoop(): void {
    if (this.rafId !== 0) cancelAnimationFrame(this.rafId);
    this.rafId = 0;
    this.lastDraw = 0;
  }

  private disable(reason: string): void {
    this.dispose();
    this.onFailure(reason);
  }

  private readonly onMotionChange = (): void => { this.refresh(); };
  private readonly onVisibilityChange = (): void => { this.refresh(); };

  private readonly onContextLost = (event: Event): void => {
    event.preventDefault();
    this.lost = true;
    this.painter.invalidate();
    this.cancelLoop();
    this.refresh();
  };

  private readonly onContextRestored = (): void => {
    if (this.disposed) return;
    this.lost = false;
    if (this.painter.restore()) this.refresh();
  };
}

// ─── Controller ─────────────────────────────────────────────────

/** Workspace aggregate plus each window's own titlebar, from one status driver. */
export class FireController {
  private on: ReadonlySet<FireState | FireTrigger> = new Set();
  private looks: Record<FireState, FireLook> = {
    working: BUILT_IN_LOOK,
    blocked: BUILT_IN_LOOK,
    error: BUILT_IN_LOOK,
    done: BUILT_IN_LOOK,
  };
  /** Each burning window's look state; the workspace burns with the top one. */
  private readonly burning = new Map<WindowId, FireState>();
  /** Created on the first ignite; disposed only when fire is unavailable. */
  private fire: FireAnimation | null = null;
  private titlebars: TitlebarFires | null = null;
  private disposed = false;
  /** The band's bottom edge above the workspace bottom: the footer height, 0 when hidden. */
  private floor: number;
  /** Config warnings already printed; a Reload Config repeats none of them. */
  private readonly warned = new Set<string>();
  private unavailable = false;

  constructor(private readonly host: HTMLElement, floor: number) {
    this.floor = floor;
  }

  /** `[fire]`: keep known `on` values and resolve every state's look. */
  configure(cfg: FireConfig | null | undefined): void {
    if (this.disposed) return;
    const next = new Set<FireState | FireTrigger>();
    for (const value of cfg?.on ?? []) {
      if (isFireState(value)) next.add(value);
      else if (value === 'tool_error') next.add(value);
      else this.warnOnce(`[fire] on: unknown value "${value}" ignored`);
    }
    this.on = next;
    this.looks = resolveFireLooks(cfg, this.warnOnce, (value) => CSS.supports('color', value));
  }

  /** Derive a window's burn state once for its titlebar and the workspace aggregate. */
  sync(
    windowId: WindowId, state: ProgramState | null, trigger: FireTrigger | null,
    titlebar: HTMLElement | null,
  ): void {
    if (this.disposed) return;
    const look = fireLookState(state, trigger, this.on);
    if (look === null) this.burning.delete(windowId);
    else this.burning.set(windowId, look);
    if (look !== null && titlebar && !this.titlebars) {
      this.titlebars = new TitlebarFires((reason) => this.warnOnce(`Titlebar fire disabled: ${reason}`));
    }
    this.titlebars?.sync(windowId, titlebar, look === null ? null : this.looks[look]);
    this.apply();
  }

  /** A closed window stops counting; the workspace may go out. */
  remove(windowId: WindowId): void {
    this.titlebars?.remove(windowId);
    if (this.burning.delete(windowId)) this.apply();
  }

  /** Footer shown → its height, hidden → 0. */
  setFloor(px: number): void {
    this.floor = px;
    this.fire?.setFloor(px);
  }

  private apply(): void {
    const top = workspaceFireState(this.burning.values());
    if (top === null) {
      this.fire?.stop();
      return;
    }
    if (this.unavailable) return;
    if (!this.fire) {
      this.fire = new FireAnimation(this.host, this.floor, (reason) => this.disable(reason));
      // First child: every window is painted after it, so none is ever covered.
      this.host.insertBefore(this.fire.getElement(), this.host.firstChild);
    }
    this.fire.setLook(this.looks[top]);
    this.fire.start();
  }

  private readonly warnOnce = (msg: string): void => {
    if (this.warned.has(msg)) return;
    this.warned.add(msg);
    console.warn(`[Krypton] ${msg}`);
  };

  /** Re-measure after relayout or a viewport resize. */
  resize(): void {
    if (this.fire?.isRunning()) this.fire.resize();
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.fire?.dispose();
    this.titlebars?.dispose();
    this.fire = null;
    this.titlebars = null;
    this.burning.clear();
  }

  /** WebGL2 or the shader failed: it would fail again, so stop trying for the session. */
  private disable(reason: string): void {
    if (this.unavailable) return;
    this.unavailable = true;
    console.warn(`[Krypton] Program-status fire disabled: ${reason}`);
    this.fire?.dispose();
    this.fire = null;
  }
}
