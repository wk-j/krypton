// src/shaders.ts — Post-processing visual effects for terminal panes
// Uses CSS filters + SVG filters + animated pseudo-element overlays.
// Works with any xterm.js renderer (DOM or WebGL), no texture reads needed.

export type ShaderPreset = 'none' | 'crt' | 'hologram' | 'glitch' | 'bloom' | 'matrix';

export interface ShaderConfig {
  enabled: boolean;
  preset: ShaderPreset;
  intensity: number;
  animate: boolean;
  fps_cap: number;
}

export interface ShaderInstance {
  pane: HTMLElement;
  overlay: HTMLElement;
  preset: ShaderPreset;
  intensity: number;
  animationId: number;
  styleEl: HTMLStyleElement | null;
}

const PRESET_ORDER: ShaderPreset[] = ['none', 'crt', 'hologram', 'glitch', 'bloom', 'matrix'];

// ---------------------------------------------------------------------------
// SVG filter definitions (injected once into the document)
// ---------------------------------------------------------------------------

let svgFiltersInjected = false;

function injectSVGFilters(): void {
  if (svgFiltersInjected) return;
  svgFiltersInjected = true;

  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('width', '0');
  svg.setAttribute('height', '0');
  svg.style.position = 'absolute';
  svg.style.pointerEvents = 'none';

  svg.innerHTML = `
    <defs>
      <!-- CRT: slight blur for phosphor glow + color shift -->
      <filter id="krypton-filter-crt" color-interpolation-filters="sRGB">
        <feGaussianBlur in="SourceGraphic" stdDeviation="0.4" result="blur"/>
        <feComposite in="SourceGraphic" in2="blur" operator="over"/>
      </filter>

      <!-- Hologram: chromatic aberration via color channel offsets -->
      <filter id="krypton-filter-hologram" color-interpolation-filters="sRGB">
        <feOffset in="SourceGraphic" dx="1.5" dy="0" result="red"/>
        <feOffset in="SourceGraphic" dx="-1.5" dy="0" result="blue"/>
        <feColorMatrix in="red" type="matrix"
          values="1 0 0 0 0  0 0 0 0 0  0 0 0 0 0  0 0 0 1 0" result="r"/>
        <feColorMatrix in="SourceGraphic" type="matrix"
          values="0 0 0 0 0  0 1 0 0 0  0 0 0 0 0  0 0 0 1 0" result="g"/>
        <feColorMatrix in="blue" type="matrix"
          values="0 0 0 0 0  0 0 0 0 0  0 0 1 0 0  0 0 0 1 0" result="b"/>
        <feBlend in="r" in2="g" mode="screen" result="rg"/>
        <feBlend in="rg" in2="b" mode="screen"/>
      </filter>

      <!-- Bloom: gaussian blur blended additively -->
      <filter id="krypton-filter-bloom" color-interpolation-filters="sRGB">
        <feGaussianBlur in="SourceGraphic" stdDeviation="2" result="bloom"/>
        <feComposite in="SourceGraphic" in2="bloom" operator="over"/>
        <feBlend in="bloom" in2="SourceGraphic" mode="screen"/>
      </filter>

      <!-- Matrix: green color shift -->
      <filter id="krypton-filter-matrix" color-interpolation-filters="sRGB">
        <feColorMatrix type="matrix"
          values="0.3 0 0 0 0
                  0.1 1.2 0.1 0 0.02
                  0.1 0 0.3 0 0
                  0 0 0 1 0"/>
      </filter>

      <!-- Glitch: turbulence-based displacement -->
      <filter id="krypton-filter-glitch" color-interpolation-filters="sRGB">
        <feTurbulence type="fractalNoise" baseFrequency="0.01 0.03" numOctaves="1"
          seed="0" result="noise"/>
        <feDisplacementMap in="SourceGraphic" in2="noise" scale="0" xChannelSelector="R" yChannelSelector="G"/>
      </filter>
    </defs>
  `;

  document.body.appendChild(svg);
}

// ---------------------------------------------------------------------------
// CSS class + keyframe definitions per preset
// ---------------------------------------------------------------------------

interface PresetStyle {
  filter: string;
  overlayCSS: string;      // CSS for the overlay pseudo-element
  paneCSS: string;         // Additional CSS for the pane itself
  keyframes: string;       // @keyframes definitions
  animationClass: string;  // Animation class to apply to overlay
}

function buildPresetStyle(preset: ShaderPreset, intensity: number): PresetStyle {
  const s = intensity;

  switch (preset) {
    case 'crt':
      return {
        filter: `url(#krypton-filter-crt) brightness(${1 + 0.05 * s})`,
        overlayCSS: `
          background: repeating-linear-gradient(
            0deg,
            transparent 0px,
            transparent 1px,
            rgba(0, 0, 0, ${0.12 * s}) 1px,
            rgba(0, 0, 0, ${0.12 * s}) 2px
          );
          border-radius: inherit;
        `,
        paneCSS: '',
        keyframes: `
          @keyframes krypton-crt-flicker {
            0%, 100% { opacity: 1; }
            50% { opacity: ${1 - 0.015 * s}; }
          }
          @keyframes krypton-crt-vignette {
            0%, 100% { box-shadow: inset 0 0 ${60 * s}px rgba(0,0,0,${0.4 * s}); }
          }
        `,
        animationClass: `animation: krypton-crt-flicker ${2 + Math.random()}s ease-in-out infinite;
          box-shadow: inset 0 0 ${60 * s}px rgba(0,0,0,${0.35 * s});`,
      };

    case 'hologram':
      return {
        filter: `url(#krypton-filter-hologram)`,
        overlayCSS: `
          background: repeating-linear-gradient(
            0deg,
            transparent 0px,
            transparent 2px,
            rgba(0, 200, 255, ${0.03 * s}) 2px,
            rgba(0, 200, 255, ${0.03 * s}) 4px
          );
        `,
        paneCSS: '',
        keyframes: `
          @keyframes krypton-holo-scan {
            0% { background-position: 0 0; }
            100% { background-position: 0 200px; }
          }
          @keyframes krypton-holo-flicker {
            0%, 90%, 100% { opacity: 1; }
            92% { opacity: ${0.85}; }
            94% { opacity: 1; }
            96% { opacity: ${0.9}; }
          }
        `,
        animationClass: `
          animation: krypton-holo-scan 3s linear infinite, krypton-holo-flicker 4s steps(1) infinite;
        `,
      };

    case 'glitch':
      return {
        filter: `url(#krypton-filter-glitch)`,
        overlayCSS: `
          background: transparent;
        `,
        paneCSS: '',
        keyframes: `
          @keyframes krypton-glitch-shift {
            0%, 85%, 100% { clip-path: none; filter: none; }
            86% { clip-path: inset(${10 + Math.random() * 30}% 0 ${30 + Math.random() * 30}% 0); transform: translateX(${(Math.random() - 0.5) * 10 * s}px); }
            88% { clip-path: inset(${40 + Math.random() * 20}% 0 ${10 + Math.random() * 20}% 0); transform: translateX(${(Math.random() - 0.5) * 8 * s}px); }
            90% { clip-path: none; transform: none; }
          }
          @keyframes krypton-glitch-color {
            0%, 85%, 100% { text-shadow: none; }
            87% { text-shadow: ${2 * s}px 0 rgba(255,0,0,0.7), ${-2 * s}px 0 rgba(0,255,255,0.7); }
            89% { text-shadow: ${-1 * s}px 0 rgba(255,0,0,0.5), ${1 * s}px 0 rgba(0,0,255,0.5); }
          }
        `,
        animationClass: `
          animation: krypton-glitch-shift ${3 + Math.random() * 2}s steps(1) infinite;
        `,
      };

    case 'bloom':
      return {
        filter: `url(#krypton-filter-bloom) brightness(${1 + 0.1 * s})`,
        overlayCSS: `background: transparent;`,
        paneCSS: '',
        keyframes: `
          @keyframes krypton-bloom-pulse {
            0%, 100% { filter: url(#krypton-filter-bloom) brightness(${1 + 0.1 * s}); }
            50% { filter: url(#krypton-filter-bloom) brightness(${1 + 0.15 * s}); }
          }
        `,
        animationClass: '',
      };

    case 'matrix':
      return {
        filter: `url(#krypton-filter-matrix)`,
        overlayCSS: `
          background: repeating-linear-gradient(
            0deg,
            transparent 0px,
            transparent 2px,
            rgba(0, 255, 70, ${0.02 * s}) 2px,
            rgba(0, 255, 70, ${0.02 * s}) 4px
          );
        `,
        paneCSS: '',
        keyframes: `
          @keyframes krypton-matrix-rain {
            0% { background-position: 0 0; }
            100% { background-position: 0 100px; }
          }
        `,
        animationClass: `animation: krypton-matrix-rain 2s linear infinite;`,
      };

    default:
      return {
        filter: 'none',
        overlayCSS: '',
        paneCSS: '',
        keyframes: '',
        animationClass: '',
      };
  }
}

// ---------------------------------------------------------------------------
// ShaderEngine
// ---------------------------------------------------------------------------

export class ShaderEngine {
  private instances = new Map<HTMLElement, ShaderInstance>();
  private animateEnabled: boolean;

  constructor(config?: Partial<ShaderConfig>) {
    this.animateEnabled = config?.animate ?? true;
    injectSVGFilters();
  }

  static isSupported(): boolean {
    return true; // CSS/SVG filters work everywhere
  }

  /** Attach visual effect to a pane element */
  attach(pane: HTMLElement, preset: ShaderPreset, intensity: number): ShaderInstance | null {
    if (preset === 'none') return null;

    // Remove existing instance if any
    const existing = this.instances.get(pane);
    if (existing) this.detach(existing);

    // Create overlay element for scanlines/effects
    const overlay = document.createElement('div');
    overlay.className = 'krypton-shader-overlay';
    pane.appendChild(overlay);

    const instance: ShaderInstance = {
      pane,
      overlay,
      preset,
      intensity,
      animationId: 0,
      styleEl: null,
    };

    this.instances.set(pane, instance);
    this._applyPreset(instance);

    console.log(`[krypton:shaders] Attached ${preset} effect (intensity: ${intensity})`);
    return instance;
  }

  /** Detach and clean up effect */
  detach(instance: ShaderInstance): void {
    if (instance.animationId) {
      cancelAnimationFrame(instance.animationId);
      instance.animationId = 0;
    }

    // Remove overlay
    instance.overlay.remove();

    // Remove dynamic style
    if (instance.styleEl) {
      instance.styleEl.remove();
      instance.styleEl = null;
    }

    // Clear filter from pane
    const xtermEl = instance.pane.querySelector('.xterm') as HTMLElement | null;
    if (xtermEl) xtermEl.style.filter = '';
    instance.pane.classList.remove('krypton-shader-active');

    this.instances.delete(instance.pane);
  }

  /** Switch preset on a live instance */
  setPreset(instance: ShaderInstance, preset: ShaderPreset): void {
    instance.preset = preset;
    if (preset === 'none') {
      const xtermEl = instance.pane.querySelector('.xterm') as HTMLElement | null;
      if (xtermEl) xtermEl.style.filter = '';
      instance.overlay.style.cssText = '';
      instance.pane.classList.remove('krypton-shader-active');
      if (instance.styleEl) { instance.styleEl.remove(); instance.styleEl = null; }
    } else {
      this._applyPreset(instance);
    }
  }

  /** Update intensity */
  setIntensity(instance: ShaderInstance, intensity: number): void {
    instance.intensity = Math.max(0, Math.min(1, intensity));
    this._applyPreset(instance);
  }

  /** Pause — no-op for CSS approach (animations controlled via CSS) */
  pause(_instance: ShaderInstance): void {}

  /** Resume — no-op for CSS approach */
  resume(_instance: ShaderInstance): void {}

  /** Cycle to next preset */
  cyclePreset(instance: ShaderInstance): ShaderPreset {
    const idx = PRESET_ORDER.indexOf(instance.preset);
    const next = PRESET_ORDER[(idx + 1) % PRESET_ORDER.length];
    this.setPreset(instance, next);
    console.log(`[krypton:shaders] Cycled to: ${next}`);
    return next;
  }

  /** Get instance for a pane element */
  getInstance(pane: HTMLElement): ShaderInstance | undefined {
    return this.instances.get(pane);
  }

  // -----------------------------------------------------------------------
  // Private
  // -----------------------------------------------------------------------

  private _applyPreset(instance: ShaderInstance): void {
    const { pane, overlay, preset, intensity } = instance;
    const style = buildPresetStyle(preset, intensity);

    // Apply SVG/CSS filter to the .xterm element (affects terminal content)
    const xtermEl = pane.querySelector('.xterm') as HTMLElement | null;
    if (xtermEl) {
      xtermEl.style.filter = style.filter;
      if (this.animateEnabled && preset === 'bloom') {
        xtermEl.style.animation = `krypton-bloom-pulse 3s ease-in-out infinite`;
      } else {
        xtermEl.style.animation = '';
      }
    }

    // Apply glitch animation to the pane content for clip-path effects
    if (this.animateEnabled && preset === 'glitch') {
      const xtermScreen = pane.querySelector('.xterm-screen') as HTMLElement | null;
      if (xtermScreen) {
        xtermScreen.style.animation = `krypton-glitch-shift ${3 + Math.random() * 2}s steps(1) infinite, krypton-glitch-color ${4 + Math.random()}s steps(1) infinite`;
      }
    } else {
      const xtermScreen = pane.querySelector('.xterm-screen') as HTMLElement | null;
      if (xtermScreen) xtermScreen.style.animation = '';
    }

    // Apply overlay (scanlines, color tints, effects)
    overlay.style.cssText = `
      position: absolute;
      inset: 0;
      pointer-events: none;
      z-index: 10;
      border-radius: inherit;
      ${style.overlayCSS}
      ${this.animateEnabled ? style.animationClass : ''}
    `;

    // Inject keyframes
    if (instance.styleEl) instance.styleEl.remove();
    if (style.keyframes) {
      const styleEl = document.createElement('style');
      styleEl.textContent = style.keyframes;
      document.head.appendChild(styleEl);
      instance.styleEl = styleEl;
    }

    pane.classList.add('krypton-shader-active');
  }
}
