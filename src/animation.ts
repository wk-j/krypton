// Krypton -- Animation Engine
// Handles all motion: workspace transitions (morph, slide, crossfade),
// window entrance/exit effects, and keyboard input buffering during animations.
// Uses the Web Animations API (WAAPI) for cancellable, hardware-accelerated animations.

import {
  WindowId,
  WindowBounds,
  AnimationStyle,
  AnimationEasing,
  WindowEffect,
  AnimationConfig,
} from './types';

/** Default animation configuration */
export const DEFAULT_ANIMATION_CONFIG: AnimationConfig = {
  style: AnimationStyle.Morph,
  duration: 250,
  easing: AnimationEasing.EaseOut,
  entranceEffect: WindowEffect.ScaleUp,
  exitEffect: WindowEffect.FadeOut,
};

/** Map of easing enum to CSS easing string */
function resolveEasing(easing: AnimationEasing): string {
  switch (easing) {
    case AnimationEasing.Linear:
      return 'linear';
    case AnimationEasing.EaseIn:
      return 'cubic-bezier(0.4, 0, 1, 1)';
    case AnimationEasing.EaseOut:
      return 'cubic-bezier(0, 0, 0.2, 1)';
    case AnimationEasing.EaseInOut:
      return 'cubic-bezier(0.4, 0, 0.2, 1)';
    case AnimationEasing.Spring:
      // Approximate spring with an overshoot cubic-bezier
      return 'cubic-bezier(0.34, 1.56, 0.64, 1)';
  }
}

/**
 * Snapshot of a window's bounds before a layout change.
 * Used to animate from old position to new position.
 */
export interface BoundsSnapshot {
  id: WindowId;
  bounds: WindowBounds;
}

export class AnimationEngine {
  private config: AnimationConfig;
  private running: Animation[] = [];
  private _isAnimating = false;
  private inputBuffer: KeyboardEvent[] = [];

  constructor(config: Partial<AnimationConfig> = {}) {
    this.config = { ...DEFAULT_ANIMATION_CONFIG, ...config };
  }

  /** Whether an animation is currently in progress */
  get isAnimating(): boolean {
    return this._isAnimating;
  }

  /** Update configuration */
  setConfig(config: Partial<AnimationConfig>): void {
    this.config = { ...this.config, ...config };
  }

  /** Get current config */
  getConfig(): AnimationConfig {
    return { ...this.config };
  }

  // ─── Input Buffering ─────────────────────────────────────────────

  /**
   * Buffer a keyboard event during animation.
   * Call this from the input router when isAnimating is true.
   */
  bufferInput(event: KeyboardEvent): void {
    this.inputBuffer.push(event);
  }

  /**
   * Flush buffered keyboard events after animation completes.
   * Returns the buffered events and clears the buffer.
   */
  flushInputBuffer(): KeyboardEvent[] {
    const events = this.inputBuffer;
    this.inputBuffer = [];
    return events;
  }

  // ─── Cancel ──────────────────────────────────────────────────────

  /** Cancel all running animations immediately, jumping to final state */
  cancelAll(): void {
    for (const anim of this.running) {
      anim.finish();
    }
    this.running = [];
    this._isAnimating = false;
  }

  // ─── Morph Animation ─────────────────────────────────────────────

  /**
   * Morph: animate each window from its old bounds to its new bounds.
   * Elements must already be positioned at their NEW bounds before calling this.
   * This method temporarily transforms them back to old positions and animates forward.
   *
   * @param elements Map of windowId -> { element, oldBounds, newBounds }
   * @returns Promise that resolves when all animations complete
   */
  async morph(
    elements: Map<WindowId, { element: HTMLElement; oldBounds: WindowBounds; newBounds: WindowBounds }>,
  ): Promise<void> {
    if (this.config.style === AnimationStyle.None || this.config.duration === 0) {
      return;
    }

    if (elements.size === 0) return;

    this._isAnimating = true;
    this.running = [];

    const easing = resolveEasing(this.config.easing);
    const duration = this.config.duration;

    const promises: Promise<void>[] = [];

    for (const [, { element, oldBounds, newBounds }] of elements) {
      // Calculate the transform offset: old position relative to new position
      const dx = oldBounds.x - newBounds.x;
      const dy = oldBounds.y - newBounds.y;
      const sx = oldBounds.width / newBounds.width;
      const sy = oldBounds.height / newBounds.height;

      const keyframes: Keyframe[] = [
        {
          transform: `translate(${dx}px, ${dy}px) scale(${sx}, ${sy})`,
          transformOrigin: 'top left',
        },
        {
          transform: 'translate(0, 0) scale(1, 1)',
          transformOrigin: 'top left',
        },
      ];

      const anim = element.animate(keyframes, {
        duration,
        easing,
        fill: 'none',
      });

      this.running.push(anim);
      promises.push(
        anim.finished.then(() => {}).catch(() => {}),
      );
    }

    await Promise.all(promises);
    this.running = [];
    this._isAnimating = false;
  }

  // ─── Slide Animation ─────────────────────────────────────────────

  /**
   * Slide: animate the entire workspace container horizontally.
   * Used for workspace transitions (like macOS Spaces).
   *
   * @param container The workspace DOM element
   * @param direction 'left' slides content left (switching to next), 'right' slides right (switching to prev)
   * @returns Promise that resolves when animation completes
   */
  async slide(
    container: HTMLElement,
    direction: 'left' | 'right',
  ): Promise<void> {
    if (this.config.style === AnimationStyle.None || this.config.duration === 0) {
      return;
    }

    this._isAnimating = true;
    this.running = [];

    const easing = resolveEasing(this.config.easing);
    const distance = window.innerWidth;
    const sign = direction === 'left' ? -1 : 1;

    const keyframes: Keyframe[] = [
      { transform: `translateX(${sign * distance}px)` },
      { transform: 'translateX(0)' },
    ];

    const anim = container.animate(keyframes, {
      duration: this.config.duration,
      easing,
      fill: 'none',
    });

    this.running.push(anim);

    try {
      await anim.finished;
    } catch {
      // Animation cancelled
    }

    this.running = [];
    this._isAnimating = false;
  }

  // ─── Crossfade Animation ─────────────────────────────────────────

  /**
   * Crossfade: fade out all current windows, then fade in.
   * Elements should already be at their new positions.
   *
   * @param elements Array of elements to crossfade
   * @returns Promise that resolves when animation completes
   */
  async crossfade(elements: HTMLElement[]): Promise<void> {
    if (this.config.style === AnimationStyle.None || this.config.duration === 0) {
      return;
    }

    if (elements.length === 0) return;

    this._isAnimating = true;
    this.running = [];

    const easing = resolveEasing(this.config.easing);
    const halfDuration = this.config.duration / 2;
    const promises: Promise<void>[] = [];

    // Fade out then fade in
    for (const el of elements) {
      const keyframes: Keyframe[] = [
        { opacity: '0' },
        { opacity: '1' },
      ];

      const anim = el.animate(keyframes, {
        duration: halfDuration * 2,
        easing,
        fill: 'none',
      });

      this.running.push(anim);
      promises.push(
        anim.finished.then(() => {}).catch(() => {}),
      );
    }

    await Promise.all(promises);
    this.running = [];
    this._isAnimating = false;
  }

  // ─── Window Entrance Effects ─────────────────────────────────────

  /**
   * Animate a window entrance effect.
   *
   * @param element The window DOM element (already in the DOM at final position)
   * @param effect The entrance effect to apply
   * @returns Promise that resolves when animation completes
   */
  async entrance(element: HTMLElement, effect?: WindowEffect): Promise<void> {
    const fx = effect ?? this.config.entranceEffect;
    if (fx === WindowEffect.None || this.config.duration === 0) {
      return;
    }

    const easing = resolveEasing(this.config.easing);
    const duration = Math.round(this.config.duration * 0.6); // Entrance is snappier

    let keyframes: Keyframe[];

    switch (fx) {
      case WindowEffect.FadeIn:
        keyframes = [
          { opacity: '0' },
          { opacity: '1' },
        ];
        break;
      case WindowEffect.ScaleUp:
        keyframes = [
          { opacity: '0', transform: 'scale(0.92)' },
          { opacity: '1', transform: 'scale(1)' },
        ];
        break;
      case WindowEffect.SlideIn:
        keyframes = [
          { opacity: '0', transform: 'translateY(24px)' },
          { opacity: '1', transform: 'translateY(0)' },
        ];
        break;
      default:
        return;
    }

    const anim = element.animate(keyframes, {
      duration,
      easing,
      fill: 'none',
    });

    this.running.push(anim);

    try {
      await anim.finished;
    } catch {
      // Animation cancelled
    }

    this.running = this.running.filter((a) => a !== anim);
    if (this.running.length === 0) {
      this._isAnimating = false;
    }
  }

  // ─── Window Exit Effects ─────────────────────────────────────────

  /**
   * Animate a window exit effect.
   * The element will have opacity 0 at the end; caller should remove it from DOM after.
   *
   * @param element The window DOM element
   * @param effect The exit effect to apply
   * @returns Promise that resolves when animation completes
   */
  async exit(element: HTMLElement, effect?: WindowEffect): Promise<void> {
    const fx = effect ?? this.config.exitEffect;
    if (fx === WindowEffect.None || this.config.duration === 0) {
      return;
    }

    const easing = resolveEasing(this.config.easing);
    const duration = Math.round(this.config.duration * 0.5); // Exit is quick

    let keyframes: Keyframe[];

    switch (fx) {
      case WindowEffect.FadeOut:
        keyframes = [
          { opacity: '1' },
          { opacity: '0' },
        ];
        break;
      case WindowEffect.ScaleDown:
        keyframes = [
          { opacity: '1', transform: 'scale(1)' },
          { opacity: '0', transform: 'scale(0.92)' },
        ];
        break;
      case WindowEffect.SlideOut:
        keyframes = [
          { opacity: '1', transform: 'translateY(0)' },
          { opacity: '0', transform: 'translateY(24px)' },
        ];
        break;
      default:
        return;
    }

    const anim = element.animate(keyframes, {
      duration,
      easing,
      fill: 'forwards', // Keep final state (opacity: 0) until removal
    });

    this.running.push(anim);

    try {
      await anim.finished;
    } catch {
      // Animation cancelled
    }

    this.running = this.running.filter((a) => a !== anim);
    if (this.running.length === 0) {
      this._isAnimating = false;
    }
  }

  // ─── Layout Transition (high-level) ──────────────────────────────

  /**
   * Animate a layout transition using the configured style.
   * Elements must already be at their NEW positions when this is called.
   * The engine temporarily transforms them back to old positions and animates forward.
   *
   * @param snapshots Pre-layout bounds snapshots (captured before relayout)
   * @param getCurrentBounds Function to get current bounds for a window
   * @param getElement Function to get the DOM element for a window
   * @param container The workspace container (used for slide animation)
   */
  async animateLayoutTransition(
    snapshots: BoundsSnapshot[],
    getCurrentBounds: (id: WindowId) => WindowBounds | null,
    getElement: (id: WindowId) => HTMLElement | null,
    container?: HTMLElement,
  ): Promise<void> {
    switch (this.config.style) {
      case AnimationStyle.None:
        return;

      case AnimationStyle.Morph: {
        const morphData = new Map<WindowId, {
          element: HTMLElement;
          oldBounds: WindowBounds;
          newBounds: WindowBounds;
        }>();

        for (const snap of snapshots) {
          const newBounds = getCurrentBounds(snap.id);
          const element = getElement(snap.id);
          if (!newBounds || !element) continue;

          // Only animate if bounds actually changed
          if (
            snap.bounds.x !== newBounds.x ||
            snap.bounds.y !== newBounds.y ||
            snap.bounds.width !== newBounds.width ||
            snap.bounds.height !== newBounds.height
          ) {
            morphData.set(snap.id, {
              element,
              oldBounds: snap.bounds,
              newBounds,
            });
          }
        }

        if (morphData.size > 0) {
          await this.morph(morphData);
        }
        break;
      }

      case AnimationStyle.Crossfade: {
        const elements: HTMLElement[] = [];
        for (const snap of snapshots) {
          const el = getElement(snap.id);
          if (el) elements.push(el);
        }
        await this.crossfade(elements);
        break;
      }

      case AnimationStyle.Slide: {
        if (container) {
          await this.slide(container, 'left');
        }
        break;
      }
    }
  }
}
