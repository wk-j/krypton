// @vitest-environment happy-dom
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { FIRE, FireController, titlebarFireBand } from './fire';
import { ProgressGauge } from './progress-gauge';
import { ProgressState, type WindowId } from './types';

const TITLEBAR_FIRE = '.krypton-titlebar-fire-canvas';
const WORKSPACE_FIRE = '.krypton-fire-canvas';
const FIRST = 'fire-first' as WindowId;
const SECOND = 'fire-second' as WindowId;
const CHROME_FIRE = 'krypton-window__chrome--fire';
const WINDOW_FIRE = 'krypton-window--fire';

interface Paint {
  heat: number;
  intensity: number;
  flame: number;
  radius: number;
  width: number;
  height: number;
  /** `u_p0.w` and `u_p1.w`: the base glow and the bloom glow's reach. */
  baseGlow: number;
  glowReach: number;
}

interface CanvasFixture {
  rendered: Map<HTMLCanvasElement, Paint>;
  copied: Map<HTMLCanvasElement, Paint>;
  sources: Map<HTMLCanvasElement, HTMLCanvasElement>;
  /** Whether the last copy into a canvas ran under a vertical flip of its height. */
  flipped: Map<HTMLCanvasElement, boolean>;
  contexts: Map<HTMLCanvasElement, object>;
}

interface ObserverFixture {
  flush(): void;
  observes(target: Element): boolean;
  visible(target: Element, visible: boolean): void;
}

/** Only the GL output consumed by the copy is modelled, not the fire shader. */
function canvasFixture(): CanvasFixture {
  const rendered = new Map<HTMLCanvasElement, Paint>();
  const copied = new Map<HTMLCanvasElement, Paint>();
  const sources = new Map<HTMLCanvasElement, HTMLCanvasElement>();
  const flipped = new Map<HTMLCanvasElement, boolean>();
  const contexts = new Map<HTMLCanvasElement, object>();
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation(function (
    this: HTMLCanvasElement, kind: string,
  ) {
    const canvas = this;
    if (kind === '2d') {
      let transform = [1, 0, 0, 1, 0, 0];
      return {
        fillStyle: '#000000',
        setTransform: (...matrix: number[]) => { transform = matrix; },
        clearRect: () => copied.delete(canvas),
        fillRect: () => {},
        getImageData: () => ({ data: new Uint8ClampedArray([138, 20, 5, 255]) }),
        drawImage: (source: HTMLCanvasElement) => {
          const paint = rendered.get(source);
          if (paint) copied.set(canvas, { ...paint });
          sources.set(canvas, source);
          const [a, b, c, d, e, f] = transform;
          flipped.set(canvas, a === 1 && b === 0 && c === 0 && d === -1 && e === 0 && f === canvas.height);
        },
      } as unknown as CanvasRenderingContext2D;
    }
    if (kind !== 'webgl2') return null;
    if (!contexts.has(canvas)) {
      const uniforms = new Map<string, number[]>();
      const noop = () => {};
      contexts.set(canvas, {
        VERTEX_SHADER: 0x8b31, FRAGMENT_SHADER: 0x8b30,
        COMPILE_STATUS: 0x8b81, LINK_STATUS: 0x8b82,
        COLOR_BUFFER_BIT: 0x4000, TRIANGLES: 4,
        createShader: () => ({}), createProgram: () => ({}), createVertexArray: () => ({}),
        shaderSource: noop, compileShader: noop, attachShader: noop, linkProgram: noop,
        deleteShader: noop, deleteProgram: noop, deleteVertexArray: noop,
        getShaderParameter: () => true, getProgramParameter: () => true,
        getUniformLocation: (_program: unknown, name: string) => name,
        isContextLost: () => false,
        getExtension: () => ({ loseContext: noop }),
        viewport: noop, clearColor: noop, clear: noop, useProgram: noop, bindVertexArray: noop,
        uniform1f: (name: string, value: number) => uniforms.set(name, [value]),
        uniform1i: noop, uniform1ui: noop,
        uniform2f: (name: string, ...values: number[]) => uniforms.set(name, values),
        uniform3f: (name: string, ...values: number[]) => uniforms.set(name, values),
        uniform3fv: noop, uniform4fv: noop,
        uniform4f: (name: string, ...values: number[]) => uniforms.set(name, values),
        drawArrays: () => rendered.set(canvas, {
          heat: uniforms.get('u_heat')![0],
          intensity: uniforms.get('u_p1')![1] / FIRE.intensity,
          flame: uniforms.get('u_height')![0],
          radius: uniforms.get('u_radius')![0],
          width: uniforms.get('u_res')![0],
          height: uniforms.get('u_res')![1],
          baseGlow: uniforms.get('u_p0')![3],
          glowReach: uniforms.get('u_p1')![3],
        }),
      });
    }
    return contexts.get(canvas) as WebGL2RenderingContext;
  } as typeof HTMLCanvasElement.prototype.getContext);
  return { rendered, copied, sources, flipped, contexts };
}

/** Native observers deliver their initial geometry asynchronously, after sync. */
function observerFixture(): ObserverFixture {
  const resize = new Set<ResizeObserver>();
  const intersect = new Set<IntersectionObserver>();
  const targets = new Map<object, Set<Element>>();
  const resizeCallbacks = new Map<ResizeObserver, ResizeObserverCallback>();
  const intersectionCallbacks = new Map<IntersectionObserver, IntersectionObserverCallback>();
  class Observer {
    constructor() { targets.set(this, new Set()); }
    observe(target: Element) { targets.get(this)!.add(target); }
    unobserve(target: Element) { targets.get(this)!.delete(target); }
    disconnect() { targets.get(this)!.clear(); }
  }
  vi.stubGlobal('ResizeObserver', class extends Observer {
    constructor(callback: ResizeObserverCallback) {
      super();
      const observer = this as unknown as ResizeObserver;
      resize.add(observer);
      resizeCallbacks.set(observer, callback);
    }
  });
  vi.stubGlobal('IntersectionObserver', class extends Observer {
    constructor(callback: IntersectionObserverCallback) {
      super();
      const observer = this as unknown as IntersectionObserver;
      intersect.add(observer);
      intersectionCallbacks.set(observer, callback);
    }
  });
  return {
    flush() {
      for (const observer of resize) {
        const entries = [...targets.get(observer)!].map((target) => ({
          target, contentRect: target.getBoundingClientRect(),
          contentBoxSize: [{ inlineSize: target.clientWidth, blockSize: target.clientHeight }],
          borderBoxSize: [{ inlineSize: target.clientWidth, blockSize: target.clientHeight }],
          devicePixelContentBoxSize: [{ inlineSize: target.clientWidth, blockSize: target.clientHeight }],
        } as ResizeObserverEntry));
        if (entries.length) resizeCallbacks.get(observer)!(entries, observer);
      }
      for (const observer of intersect) {
        const entries = [...targets.get(observer)!].map((target) => ({
          target, isIntersecting: true, intersectionRatio: 1,
        } as IntersectionObserverEntry));
        if (entries.length) intersectionCallbacks.get(observer)!(entries, observer);
      }
    },
    observes(target: Element) {
      return [...targets.values()].some((elements) => elements.has(target));
    },
    visible(target: Element, visible: boolean) {
      for (const observer of intersect) {
        if (targets.get(observer)!.has(target)) intersectionCallbacks.get(observer)!([
          { target, isIntersecting: visible, intersectionRatio: visible ? 1 : 0 } as IntersectionObserverEntry,
        ], observer);
      }
    },
  };
}

function sizedElement(width: number, height: number): HTMLElement {
  const element = document.createElement('div');
  Object.defineProperties(element, {
    clientWidth: { get: () => width },
    clientHeight: { get: () => height },
  });
  element.getBoundingClientRect = () => new DOMRect(0, 0, width, height);
  return element;
}

function makeWindow(workspace: HTMLElement) {
  const win = document.createElement('div');
  win.className = 'krypton-window';
  const titlebar = sizedElement(480, 36);
  titlebar.className = 'krypton-window__titlebar';
  const band = sizedElement(440, 6);
  band.className = 'krypton-window__header-accent';
  Object.defineProperties(band, {
    offsetLeft: { get: () => 20 },
    offsetTop: { get: () => 36 },
  });
  const chrome = sizedElement(480, 42);
  chrome.className = 'krypton-window__chrome';
  chrome.append(titlebar, band);
  const content = document.createElement('div');
  content.className = 'krypton-window__content';
  win.append(chrome, content);
  workspace.append(win);
  return { win, titlebar, band, chrome };
}

/** The z-index a window.css rule declares for exactly `selector`. */
function declaredZ(selector: string): number {
  const css = readFileSync(join(import.meta.dirname, 'styles', 'window.css'), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '');
  const escaped = selector.replace(/[.*+?^${}()|[\]\\-]/g, '\\$&');
  const block = new RegExp(`(?:^|\\})\\s*${escaped}\\s*\\{([^}]*)\\}`).exec(css);
  const z = block && /z-index:\s*(-?\d+)/.exec(block[1]);
  expect(z, `${selector} declares a z-index`).not.toBeNull();
  return Number(z![1]);
}

function titlebarCanvas(host: HTMLElement): HTMLCanvasElement {
  const canvas = host.parentElement!.querySelector<HTMLCanvasElement>(TITLEBAR_FIRE);
  expect(canvas).not.toBeNull();
  return canvas!;
}

function shown(canvas: HTMLCanvasElement): boolean {
  return canvas.isConnected && !canvas.hidden && canvas.style.display !== 'none'
    && canvas.style.visibility !== 'hidden' && canvas.style.opacity !== '0';
}

let graphics: CanvasFixture;
let observers: ObserverFixture;
let workspace: HTMLElement;
let controller: FireController;
let motion: EventTarget & { matches: boolean };
let visibility: DocumentVisibilityState;
let frames: Map<number, FrameRequestCallback>;
let nextFrame: number;
let timestamp: number;

function advanceFrames(duration = 1000) {
  for (let elapsed = 0; elapsed < duration; elapsed += 20) {
    timestamp += 20;
    const pending = [...frames.values()];
    frames.clear();
    for (const callback of pending) callback(timestamp);
  }
}

function expectPaint(canvas: HTMLCanvasElement, intensity: number) {
  expect(shown(canvas)).toBe(true);
  const paint = graphics.copied.get(canvas) ?? graphics.rendered.get(canvas);
  expect(paint?.heat).toBeGreaterThan(0);
  expect(paint?.intensity).toBeCloseTo(intensity, 2);
}

function setVisibility(value: DocumentVisibilityState) {
  visibility = value;
  document.dispatchEvent(new Event('visibilitychange'));
}

beforeEach(() => {
  document.body.innerHTML = '';
  vi.useFakeTimers();
  graphics = canvasFixture();
  observers = observerFixture();
  motion = Object.assign(new EventTarget(), { matches: false });
  vi.stubGlobal('matchMedia', () => motion as unknown as MediaQueryList);
  visibility = 'visible';
  vi.spyOn(document, 'visibilityState', 'get').mockImplementation(() => visibility);
  vi.spyOn(document, 'hidden', 'get').mockImplementation(() => visibility === 'hidden');
  frames = new Map();
  nextFrame = 0;
  timestamp = 0;
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
    frames.set(++nextFrame, callback);
    return nextFrame;
  });
  vi.stubGlobal('cancelAnimationFrame', (id: number) => frames.delete(id));
  workspace = sizedElement(1200, 800);
  document.body.append(workspace);
  controller = new FireController(workspace, 0);
  controller.configure({ on: ['working', 'blocked', 'tool_error'], working: { intensity: 0.5 }, blocked: { intensity: 2 }, error: { intensity: 1.5 } });
});

afterEach(() => {
  controller.dispose();
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('FireController titlebar lifecycle (spec 0392)', () => {
  it('draws each window look independently while the workspace follows aggregate priority and reloads config', () => {
    const first = makeWindow(workspace);
    const second = makeWindow(workspace);
    const idle = makeWindow(workspace);
    controller.sync(FIRST, 'working', null, first.titlebar);
    controller.sync(SECOND, null, 'tool_error', second.titlebar);
    controller.sync('idle' as WindowId, 'idle', null, idle.titlebar);
    observers.flush();
    advanceFrames(3000);

    expectPaint(titlebarCanvas(first.titlebar), 0.5);
    expectPaint(titlebarCanvas(second.titlebar), 1.5);
    expectPaint(workspace.querySelector<HTMLCanvasElement>(WORKSPACE_FIRE)!, 1.5);
    expect(idle.chrome.querySelector(TITLEBAR_FIRE)).toBeNull();

    controller.configure({ on: ['working', 'tool_error'], working: { intensity: 0.75 }, error: { intensity: 1.75 } });
    controller.sync(FIRST, 'working', null, first.titlebar);
    controller.sync(SECOND, null, 'tool_error', second.titlebar);
    advanceFrames(3000);
    expectPaint(titlebarCanvas(first.titlebar), 0.75);
    const secondCanvas = titlebarCanvas(second.titlebar);
    expectPaint(secondCanvas, 1.75);
    expectPaint(workspace.querySelector<HTMLCanvasElement>(WORKSPACE_FIRE)!, 1.75);

    controller.sync(SECOND, null, null, second.titlebar);
    advanceFrames(3000);
    expect(shown(secondCanvas)).toBe(false);
    expectPaint(titlebarCanvas(first.titlebar), 0.75);
    expectPaint(workspace.querySelector<HTMLCanvasElement>(WORKSPACE_FIRE)!, 0.75);
  });

  it('burns the workspace without the still glow wash while titlebars keep their scaled glow', () => {
    const first = makeWindow(workspace);
    controller.sync(FIRST, 'working', null, first.titlebar);
    observers.flush();
    advanceFrames(1000);

    const ground = graphics.rendered.get(workspace.querySelector<HTMLCanvasElement>(WORKSPACE_FIRE)!);
    expect(ground?.heat).toBeGreaterThan(0);
    expect(ground?.glowReach).toBe(0);
    expect(ground?.baseGlow).toBe(0);
    const band = graphics.copied.get(titlebarCanvas(first.titlebar));
    expect(band?.glowReach).toBeGreaterThan(0);
    expect(band?.baseGlow).toBe(FIRE.baseGlow);
  });

  it('detaches canvases and observers when a live titlebar is replaced or nulled', () => {
    const oldWindow = makeWindow(workspace);
    const replacementWindow = makeWindow(workspace);
    const old = oldWindow.titlebar;
    const replacement = replacementWindow.titlebar;
    controller.sync(FIRST, 'working', null, old);
    observers.flush();
    advanceFrames();
    const stale = titlebarCanvas(old);
    expect(observers.observes(old)).toBe(true);

    controller.sync(FIRST, 'working', null, replacement);
    observers.flush();
    advanceFrames();
    expect(stale.isConnected).toBe(false);
    expect(observers.observes(old)).toBe(false);
    expect(observers.observes(oldWindow.chrome)).toBe(false);
    expect(observers.observes(oldWindow.band)).toBe(false);
    expectPaint(titlebarCanvas(replacement), 0.5);
    expect(observers.observes(replacement)).toBe(true);

    const current = titlebarCanvas(replacement);
    controller.sync(FIRST, 'working', null, null);
    advanceFrames();
    expect(current.isConnected).toBe(false);
    expect(observers.observes(replacement)).toBe(false);
    expect(observers.observes(replacementWindow.chrome)).toBe(false);
    expect(observers.observes(replacementWindow.band)).toBe(false);
    expectPaint(workspace.querySelector<HTMLCanvasElement>(WORKSPACE_FIRE)!, 0.5);
  });

  it.each([0, 3000])('removes a stopped window immediately, including after %i ms of fade', (fadeMs) => {
    const { titlebar, chrome, band } = makeWindow(workspace);
    controller.sync(FIRST, 'working', null, titlebar);
    observers.flush();
    advanceFrames();
    const canvas = titlebarCanvas(titlebar);
    controller.sync(FIRST, null, null, titlebar);
    advanceFrames(fadeMs);
    controller.remove(FIRST);
    expect(canvas.isConnected).toBe(false);
    expect(chrome.classList.contains(CHROME_FIRE)).toBe(false);
    expect(observers.observes(titlebar)).toBe(false);
    expect(observers.observes(chrome)).toBe(false);
    expect(observers.observes(band)).toBe(false);
    advanceFrames(3000);
    expect(chrome.querySelector(TITLEBAR_FIRE)).toBeNull();
    expect(frames.size).toBe(0);
  });

  it('spans only the progress band, burns a third as tall as the workspace hanging from the band over the terminal while keeping progress dismissal independent', () => {
    const { win, titlebar, band, chrome } = makeWindow(workspace);
    const gauge = new ProgressGauge({
      getWindowElement: (id) => id === FIRST ? win : null,
      getQuickTerminalElement: () => null,
      getWindowDisplaySession: () => 1,
    });
    controller.sync(FIRST, 'working', null, titlebar);
    observers.flush();
    advanceFrames();
    const canvas = titlebarCanvas(titlebar);
    expect(canvas.parentElement).toBe(chrome);
    expect(canvas.getAttribute('aria-hidden')).toBe('true');
    expect(band.querySelector(TITLEBAR_FIRE)).toBeNull();
    expect(chrome.classList.contains(CHROME_FIRE)).toBe(true);

    // Horizontally the band, not the full-width titlebar or chrome.
    expect(canvas.style.left).toBe(`${band.offsetLeft}px`);
    expect(canvas.style.width).toBe(`${band.clientWidth}px`);
    expect(canvas.width).toBe(band.clientWidth);
    // Top edge on the band's top edge; the bottom hangs below the chrome, over the terminal.
    const top = parseFloat(canvas.style.top);
    expect(top).toBe(band.offsetTop);
    expect(canvas.height).toBe(parseFloat(canvas.style.height));
    expect(top + canvas.height).toBeGreaterThan(chrome.clientHeight);
    // Copied upside down: flames rise from the scratch image's bottom, so they
    // hang from the canvas top.
    expect(graphics.flipped.get(canvas)).toBe(true);
    // The tallest flame is a third of the workspace's 120px cap.
    expect(titlebarFireBand(band.clientWidth, 1)).toEqual({
      cssWidth: band.clientWidth, cssHeight: canvas.height, flameMax: 40,
    });

    // Drawn 1:1 at the canvas size, flames a third as tall as the workspace's.
    const paint = graphics.copied.get(canvas)!;
    expect(paint.width).toBe(canvas.width);
    expect(paint.height).toBe(canvas.height);
    expect(paint.flame).toBeGreaterThan(36);
    expect(paint.flame).toBeLessThanOrEqual(40);
    expect(paint.radius).toBeGreaterThan(0);

    gauge.handleProgress(1, ProgressState.Normal, 100, FIRST);
    expect(band.querySelector('.krypton-window__header-progress')).not.toBeNull();
    vi.advanceTimersByTime(2300);
    expect(band.querySelector('.krypton-window__header-progress')).toBeNull();
    expectPaint(canvas, 0.5);

    gauge.handleProgress(1, ProgressState.Error, 30, FIRST);
    controller.sync(FIRST, null, null, titlebar);
    advanceFrames(3000);
    expect(shown(canvas)).toBe(false);
    expect(band.querySelector<HTMLElement>('.krypton-window__header-progress')?.style.transform).toBe('scaleX(0.3)');
    controller.sync(FIRST, 'working', null, titlebar);
    advanceFrames();
    vi.advanceTimersByTime(4500);
    expect(band.querySelector('.krypton-window__header-progress')).toBeNull();
    expectPaint(canvas, 0.5);
  });

  it('paints over the whole titlebar, tab strip included, and lifts only a burning window over its siblings', () => {
    // The tab strip, label, LEDs and controls live inside the titlebar's own
    // stacking context, so a canvas above the titlebar is above all of them.
    expect(declaredZ('.krypton-titlebar-fire-canvas')).toBeGreaterThan(declaredZ('.krypton-window__titlebar'));
    expect(declaredZ('.krypton-window--fire')).toBeGreaterThan(0);

    const burning = makeWindow(workspace);
    const idle = makeWindow(workspace);
    controller.sync(FIRST, 'working', null, burning.titlebar);
    controller.sync(SECOND, null, null, idle.titlebar);
    observers.flush();
    advanceFrames();
    const canvas = titlebarCanvas(burning.titlebar);
    expect(shown(canvas)).toBe(true);
    expect(burning.win.classList.contains(WINDOW_FIRE)).toBe(true);
    expect(idle.win.classList.contains(WINDOW_FIRE)).toBe(false);

    // Fading flames still show and keep the lift; it drops once the canvas hides.
    controller.sync(FIRST, null, null, burning.titlebar);
    advanceFrames(100);
    expect(shown(canvas)).toBe(true);
    expect(burning.win.classList.contains(WINDOW_FIRE)).toBe(true);
    advanceFrames(3000);
    expect(shown(canvas)).toBe(false);
    expect(burning.win.classList.contains(WINDOW_FIRE)).toBe(false);

    // Offscreen hides the canvas, so it drops the lift too.
    controller.sync(FIRST, 'working', null, burning.titlebar);
    advanceFrames();
    expect(burning.win.classList.contains(WINDOW_FIRE)).toBe(true);
    observers.visible(burning.titlebar, false);
    expect(shown(canvas)).toBe(false);
    expect(burning.win.classList.contains(WINDOW_FIRE)).toBe(false);
    observers.visible(burning.titlebar, true);
    advanceFrames();
    expect(burning.win.classList.contains(WINDOW_FIRE)).toBe(true);

    controller.remove(FIRST);
    expect(burning.win.classList.contains(WINDOW_FIRE)).toBe(false);
    controller.sync(SECOND, 'working', null, idle.titlebar);
    observers.flush();
    advanceFrames();
    expect(idle.win.classList.contains(WINDOW_FIRE)).toBe(true);
    controller.dispose();
    expect(idle.win.classList.contains(WINDOW_FIRE)).toBe(false);
  });

  it('grows the canvas for a taller look at once and shrinks it only after the ease ends', () => {
    const { titlebar, band } = makeWindow(workspace);
    const tall = titlebarFireBand(band.clientWidth, 2).cssHeight;
    const normal = titlebarFireBand(band.clientWidth, 1).cssHeight;
    controller.sync(FIRST, 'working', null, titlebar);
    observers.flush();
    advanceFrames();
    const canvas = titlebarCanvas(titlebar);
    expect(canvas.height).toBe(normal);

    controller.configure({ on: ['working'], working: { height: 2 } });
    controller.sync(FIRST, 'working', null, titlebar);
    expect(canvas.height).toBe(tall);
    // The top stays on the band: a taller look grows the canvas downward.
    expect(parseFloat(canvas.style.top)).toBe(band.offsetTop);
    advanceFrames(3000);
    expect(canvas.height).toBe(tall);

    controller.configure({ on: ['working'] });
    controller.sync(FIRST, 'working', null, titlebar);
    expect(canvas.height).toBe(tall);
    advanceFrames(3000);
    expect(canvas.height).toBe(normal);
    expect(parseFloat(canvas.style.top)).toBe(band.offsetTop);
    expectPaint(canvas, 1);
  });

  it('renders reduced motion statically and never revives stopped or offscreen fire after visibility changes', () => {
    motion.matches = true;
    const { titlebar } = makeWindow(workspace);
    controller.sync(FIRST, 'working', null, titlebar);
    observers.flush();
    const canvas = titlebarCanvas(titlebar);
    expectPaint(canvas, 0.5);
    expect(frames.size).toBe(0);

    observers.visible(titlebar, false);
    const offscreenPaint = graphics.copied.get(canvas);
    controller.sync(FIRST, 'blocked', null, titlebar);
    expect(graphics.copied.get(canvas)).toBe(offscreenPaint);
    observers.visible(titlebar, true);
    expectPaint(canvas, 2);
    expect(frames.size).toBe(0);

    setVisibility('hidden');
    controller.sync(FIRST, null, null, titlebar);
    setVisibility('visible');
    expect(shown(canvas)).toBe(false);
    expect(frames.size).toBe(0);

    controller.sync(FIRST, 'working', null, titlebar);
    expectPaint(canvas, 0.5);
    motion.matches = false;
    motion.dispatchEvent(new Event('change'));
    advanceFrames();
    setVisibility('hidden');
    const hiddenPaint = graphics.copied.get(canvas);
    controller.sync(FIRST, 'blocked', null, titlebar);
    advanceFrames(3000);
    expect(graphics.copied.get(canvas)).toBe(hiddenPaint);
    setVisibility('visible');
    advanceFrames(3000);
    expectPaint(canvas, 2);
    motion.matches = true;
    motion.dispatchEvent(new Event('change'));
    controller.sync(FIRST, null, null, titlebar);
    expect(shown(canvas)).toBe(false);
    expect(frames.size).toBe(0);
  });

  it('hides lost titlebar output without stopping workspace fire and restores only currently burning windows', () => {
    const first = makeWindow(workspace).titlebar;
    const second = makeWindow(workspace).titlebar;
    controller.sync(FIRST, 'working', null, first);
    controller.sync(SECOND, 'blocked', null, second);
    observers.flush();
    advanceFrames();
    const firstCanvas = titlebarCanvas(first);
    const secondCanvas = titlebarCanvas(second);
    const scratch = graphics.sources.get(firstCanvas)!;
    expect(scratch).toBeDefined();
    expect(graphics.sources.get(secondCanvas)).toBe(scratch);
    const contexts = [...graphics.contexts.keys()];
    scratch.dispatchEvent(new Event('webglcontextlost', { cancelable: true }));
    expect(shown(firstCanvas)).toBe(false);
    expect(shown(secondCanvas)).toBe(false);
    expect([...graphics.contexts.keys()]).toEqual(contexts);
    advanceFrames();
    expectPaint(workspace.querySelector<HTMLCanvasElement>(WORKSPACE_FIRE)!, 2);

    controller.sync(FIRST, null, null, first);
    scratch.dispatchEvent(new Event('webglcontextrestored'));
    advanceFrames(3000);
    expect(shown(firstCanvas)).toBe(false);
    expectPaint(secondCanvas, 2);
    controller.remove(SECOND);
    scratch.dispatchEvent(new Event('webglcontextrestored'));
    advanceFrames(3000);
    expect(secondCanvas.isConnected).toBe(false);
    expect(observers.observes(second)).toBe(false);
    expect(frames.size).toBe(0);
  });

  it('restores the latest workspace burn state when it stops and reignites during context loss', () => {
    const { titlebar } = makeWindow(workspace);
    controller.sync(FIRST, 'working', null, titlebar);
    observers.flush();
    advanceFrames();
    const canvas = workspace.querySelector<HTMLCanvasElement>(WORKSPACE_FIRE)!;
    canvas.dispatchEvent(new Event('webglcontextlost', { cancelable: true }));
    controller.sync(FIRST, null, null, titlebar);
    controller.sync(FIRST, 'blocked', null, titlebar);
    advanceFrames();
    expect(shown(canvas)).toBe(false);

    canvas.dispatchEvent(new Event('webglcontextrestored'));
    advanceFrames(3000);
    expectPaint(canvas, 2);
    controller.sync(FIRST, null, null, titlebar);
    advanceFrames(3000);
    expect(shown(canvas)).toBe(false);
    expect(frames.size).toBe(0);
  });
});
