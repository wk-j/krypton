import { convertFileSrc } from '@tauri-apps/api/core';

import { backgroundStyles, DESKTOP, sameChoice, validChoice } from './model';
import type { BackgroundChoice, BackgroundState } from './types';
import '../styles/layers.css';
import './backgrounds.css';

export async function preloadChoice(c: BackgroundChoice, state: BackgroundState, signal?: AbortSignal): Promise<string | undefined> {
  if (!validChoice(c, state)) throw new Error('Invalid background choice');
  if (c.source.kind !== 'image') return undefined;
  const id = c.source.assetId;
  const asset = state.assets.find((a) => a.id === id);
  if (!asset) throw new Error('Image is no longer in the library; Refresh and choose another');
  const url = convertFileSrc(asset.imagePath);
  const image = new Image();
  image.src = url;
  let abort: (() => void) | undefined;
  try {
    await new Promise<void>((resolve, reject) => {
      abort = (): void => { image.src = ''; reject(new DOMException('Background load cancelled', 'AbortError')); };
      signal?.addEventListener('abort', abort, { once: true });
      if (signal?.aborted) { abort(); return; }
      void image.decode().then(resolve, reject);
    });
  } catch (error) {
    if (signal?.aborted) throw error;
    throw new Error(`Cannot load ${asset.name}; Refresh or choose another background`);
  } finally {
    if (abort) signal?.removeEventListener('abort', abort);
  }
  return url;
}

interface Slot { el: HTMLElement; appearance: HTMLElement; content: HTMLElement; scrim: HTMLElement }
function slot(parent: HTMLElement): Slot {
  const el = document.createElement('div');
  el.className = 'krypton-workspace-background__slot';
  const appearance = document.createElement('div');
  appearance.className = 'krypton-workspace-background__appearance';
  const content = document.createElement('div');
  content.className = 'krypton-workspace-background__content';
  const scrim = document.createElement('div');
  scrim.className = 'krypton-workspace-background__scrim';
  appearance.append(content, scrim);
  el.append(appearance);
  parent.append(el);
  return { el, appearance, content, scrim };
}
function paint(slot: Slot, c: BackgroundChoice, url?: string): void {
  Object.assign(slot.content.style, backgroundStyles(c, url));
  slot.appearance.hidden = c.source.kind === 'desktop';
  slot.appearance.style.opacity = String(c.opacity);
  slot.scrim.style.opacity = String(c.dimming);
}

/** Two slots only. The same implementation hosts the workspace and local Try it. */
export class WorkspaceBackground {
  readonly element = document.createElement('div');
  private readonly base: Slot;
  private readonly target: Slot;
  private animations: Animation[] = [];
  private readonly motion = window.matchMedia('(prefers-reduced-motion: reduce)');
  private readonly events = new AbortController();
  private generation = 0;
  private disposed = false;
  private desired = false;
  private endpoint = false;
  private hasPaint = false;
  private baseVisible = false;
  private targetVisible = false;
  private state: BackgroundState | null = null;
  private ready = new Map<string, Promise<string | undefined>>();
  private loads = new AbortController();
  private reported = new Set<string>();

  constructor(parent: HTMLElement, before: HTMLElement | null = null, private readonly report: (message: string) => void = console.warn) {
    this.element.className = 'krypton-workspace-background';
    this.element.setAttribute('aria-hidden', 'true');
    parent.insertBefore(this.element, before);
    this.base = slot(this.element);
    this.target = slot(this.element);
    paint(this.base, DESKTOP);
    paint(this.target, DESKTOP);
    this.weights(0);
    document.addEventListener('visibilitychange', () => {
      if (document.hidden) this.transition(this.desired, true);
    }, { signal: this.events.signal });
    this.motion.addEventListener('change', () => this.transition(this.desired, true), { signal: this.events.signal });
  }

  async update(state: BackgroundState, active: boolean, instant = false): Promise<void> {
    if (this.disposed) return;
    const generation = ++this.generation;
    this.desired = active && state.permissionRule.enabled && state.permissionRule.target !== null;
    if (!this.desired) this.transition(false, instant);
    if (instant && state.active.source.kind === 'desktop' && !state.permissionRule.enabled) {
      paint(this.base, DESKTOP);
      paint(this.target, DESKTOP);
      this.element.hidden = true;
    }
    if (this.state !== state) {
      this.state = state;
      this.loads.abort();
      this.loads = new AbortController();
      this.ready.clear();
      this.reported.clear();
    }
    const load = (c: BackgroundChoice): Promise<string | undefined> => {
      const key = JSON.stringify(c);
      let ready = this.ready.get(key);
      if (!ready) { ready = preloadChoice(c, state, this.loads.signal); this.ready.set(key, ready); }
      return ready;
    };
    const target = state.permissionRule.target ?? DESKTOP;
    const [baseResult, targetResult] = await Promise.allSettled([load(state.active), load(target)]);
    if (this.disposed || generation !== this.generation) return;
    for (const result of [baseResult, targetResult]) {
      if (result.status === 'rejected') {
        const message = String(result.reason);
        if (!this.reported.has(message)) { this.reported.add(message); this.report(message); }
      }
    }
    const base = baseResult.status === 'fulfilled' ? state.active : DESKTOP;
    const baseUrl = baseResult.status === 'fulfilled' ? baseResult.value : undefined;
    paint(this.base, base, baseUrl);
    paint(this.target, targetResult.status === 'fulfilled' ? target : base, targetResult.status === 'fulfilled' ? targetResult.value : baseUrl);
    this.baseVisible = base.source.kind !== 'desktop' && base.opacity > 0;
    this.targetVisible = targetResult.status === 'fulfilled' ? target.source.kind !== 'desktop' && target.opacity > 0 : this.baseVisible;
    this.element.hidden = false;
    const equivalent = sameChoice(base, target) || targetResult.status === 'rejected';
    this.desired = this.desired && !equivalent;
    this.transition(this.desired, instant || !this.hasPaint || equivalent);
    this.syncVisibility();
    this.hasPaint = true;
  }

  private syncVisibility(): void {
    const moving = this.animations.length > 0;
    this.element.hidden = !(this.baseVisible && (moving || !this.endpoint)) && !(this.targetVisible && (moving || this.endpoint));
  }
  private weights(w: number): void {
    this.base.el.style.opacity = String(1 - w);
    this.target.el.style.opacity = String(w);
  }
  private transition(active: boolean, instant: boolean): void {
    if (this.disposed) return;
    if (!instant && active === this.endpoint) return;
    // Read before cancel: cancelling removes the presentation effect.
    const weight = Number.parseFloat(getComputedStyle(this.target.el).opacity) || 0;
    for (const animation of this.animations) animation.cancel();
    this.animations = [];
    this.weights(weight);
    this.endpoint = active;
    const end = active ? 1 : 0;
    this.weights(end);
    if (instant || document.hidden || this.motion.matches || !this.target.el.animate || weight === end) {
      this.syncVisibility();
      return;
    }
    this.animations = [
      this.base.el.animate([{ opacity: 1 - weight }, { opacity: 1 - end }], { duration: 280, easing: 'ease-out' }),
      this.target.el.animate([{ opacity: weight }, { opacity: end }], { duration: 280, easing: 'ease-out' }),
    ];
    this.syncVisibility();
    const running = this.animations;
    void Promise.all(running.map((a) => a.finished)).catch(() => undefined).then(() => {
      if (this.animations === running) { this.animations = []; this.syncVisibility(); }
    });
  }
  dispose(): void {
    this.disposed = true;
    this.generation++;
    this.events.abort();
    this.loads.abort();
    for (const animation of this.animations) animation.cancel();
    this.animations = [];
    this.ready.clear();
    this.reported.clear();
    this.state = null;
    this.element.remove();
  }
}
