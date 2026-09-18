// Krypton — ACP Harness composer insertion afterimage (spec 252).
// Real draft and the existing inline caret stay immediate. Direct insertions
// spawn overlay copies of the inserted graphemes — a fading phosphor letter,
// not the art-78 expanding ellipse. Catch-up text and a custom caret stay
// out of scope.

export const COMPOSER_BLOOM_DURATION_MIN_MS = 180;
export const COMPOSER_BLOOM_DURATION_MAX_MS = 700;
export const COMPOSER_BLOOM_TRAIL_MIN = 1;
export const COMPOSER_BLOOM_TRAIL_MAX = 12;
export const COMPOSER_BLOOM_DEFAULT_MS = 320;
export const COMPOSER_BLOOM_DEFAULT_TRAIL = 5;
export const COMPOSER_BLOOM_STAGGER_MS = 18;
export const COMPOSER_BLOOM_LAYER_CLASS = 'acp-harness__composer-blooms';
export const COMPOSER_BLOOM_PARTICLE_CLASS = 'acp-harness__composer-bloom';

export interface ComposerBloomSettings {
  enabled: boolean;
  durationMs: number;
  trail: number;
}

interface GraphemeSegmenter {
  segment(input: string): Iterable<{ segment: string }>;
}

const graphemeSegmenter: GraphemeSegmenter | null = (() => {
  const Ctor = (Intl as typeof Intl & {
    Segmenter?: new (
      locale: string | undefined,
      options: { granularity: 'grapheme' },
    ) => GraphemeSegmenter;
  }).Segmenter;
  return Ctor ? new Ctor(undefined, { granularity: 'grapheme' }) : null;
})();

export function clampComposerBloomSettings(
  raw: Partial<ComposerBloomSettings> | null | undefined,
): ComposerBloomSettings {
  const durationMs = Number(raw?.durationMs);
  const trail = Number(raw?.trail);
  return {
    enabled: raw?.enabled !== false,
    durationMs: Number.isFinite(durationMs)
      ? Math.max(
        COMPOSER_BLOOM_DURATION_MIN_MS,
        Math.min(COMPOSER_BLOOM_DURATION_MAX_MS, Math.round(durationMs)),
      )
      : COMPOSER_BLOOM_DEFAULT_MS,
    trail: Number.isFinite(trail)
      ? Math.max(
        COMPOSER_BLOOM_TRAIL_MIN,
        Math.min(COMPOSER_BLOOM_TRAIL_MAX, Math.round(trail)),
      )
      : COMPOSER_BLOOM_DEFAULT_TRAIL,
  };
}

export function applyComposerBloomSettings(
  root: HTMLElement,
  raw: Partial<ComposerBloomSettings> | null | undefined,
): ComposerBloomSettings {
  const settings = clampComposerBloomSettings(raw);
  root.style.setProperty('--acp-composer-bloom-duration', `${settings.durationMs}ms`);
  root.style.setProperty('--acp-composer-bloom-trail', String(settings.trail));
  root.dataset.acpComposerBloom = settings.enabled ? 'on' : 'off';
  return settings;
}

export function readComposerBloomSettings(
  root: HTMLElement = document.documentElement,
): ComposerBloomSettings {
  const durationMs = parseInt(
    getComputedStyle(root).getPropertyValue('--acp-composer-bloom-duration'),
    10,
  );
  const trail = parseInt(
    getComputedStyle(root).getPropertyValue('--acp-composer-bloom-trail'),
    10,
  );
  return clampComposerBloomSettings({
    enabled: root.dataset.acpComposerBloom !== 'off',
    durationMs: Number.isFinite(durationMs) ? durationMs : COMPOSER_BLOOM_DEFAULT_MS,
    trail: Number.isFinite(trail) ? trail : COMPOSER_BLOOM_DEFAULT_TRAIL,
  });
}

export function graphemeUnits(text: string): string[] {
  if (!text) return [];
  if (graphemeSegmenter) {
    return Array.from(graphemeSegmenter.segment(text), (part) => part.segment);
  }
  return Array.from(text);
}

export function prefersComposerBloomMotion(): boolean {
  return !window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}

export function ensureComposerBloomLayer(
  host: HTMLElement,
  existing: HTMLElement | null,
): HTMLElement {
  const layer = existing ?? document.createElement('div');
  layer.className = COMPOSER_BLOOM_LAYER_CLASS;
  layer.setAttribute('aria-hidden', 'true');
  if (layer.parentElement !== host) host.appendChild(layer);
  return layer;
}

export interface ComposerBloomPlan {
  offset: number;
  delayMs: number;
  unit: string;
}

export function isVisibleComposerGlyph(unit: string): boolean {
  return unit.trim().length > 0;
}

export function planComposerBlooms(inserted: string, trail: number): ComposerBloomPlan[] {
  const units = graphemeUnits(inserted);
  if (units.length === 0) return [];
  const limit = Math.max(COMPOSER_BLOOM_TRAIL_MIN, Math.min(COMPOSER_BLOOM_TRAIL_MAX, trail));
  const visible: Array<{ unit: string; offset: number }> = [];
  let charOffset = 0;
  for (const unit of units) {
    if (isVisibleComposerGlyph(unit)) visible.push({ unit, offset: charOffset });
    charOffset += unit.length;
  }
  const chosen = visible.slice(-limit);
  return chosen.map((item, i) => ({
    offset: item.offset,
    delayMs: i * COMPOSER_BLOOM_STAGGER_MS,
    unit: item.unit,
  }));
}

export function spawnComposerBlooms(
  inputEl: HTMLElement,
  layer: HTMLElement,
  inserted: string,
  settings: ComposerBloomSettings = readComposerBloomSettings(),
): void {
  if (!inserted || !settings.enabled || !prefersComposerBloomMotion()) return;

  const plans = planComposerBlooms(inserted, settings.trail);
  if (plans.length === 0) return;
  const pieces = textNodesBeforeCaret(inputEl);
  const beforeLength = pieces.reduce((sum, piece) => sum + piece.node.data.length, 0);
  const insertedStart = Math.max(0, beforeLength - inserted.length);
  const inputRect = inputEl.getBoundingClientRect();

  for (const plan of plans) {
    const rect = rectAtTextIndex(pieces, insertedStart + plan.offset, plan.unit.length)
      ?? inputEl.querySelector('.acp-harness__caret')?.getBoundingClientRect()
      ?? null;
    if (!rect) continue;
    const particle = document.createElement('span');
    particle.className = COMPOSER_BLOOM_PARTICLE_CLASS;
    particle.textContent = plan.unit;
    particle.style.left = `${rect.left - inputRect.left}px`;
    particle.style.top = `${rect.top - inputRect.top}px`;
    particle.style.animationDelay = `${plan.delayMs}ms`;
    particle.addEventListener('animationend', () => particle.remove());
    layer.appendChild(particle);
  }
}

interface TextPiece {
  node: Text;
  start: number;
}

function textNodesBeforeCaret(inputEl: HTMLElement): TextPiece[] {
  const caret = inputEl.querySelector('.acp-harness__caret');
  const pieces: TextPiece[] = [];
  let start = 0;
  for (const child of Array.from(inputEl.childNodes)) {
    if (caret && (child === caret || (child instanceof Element && child.contains(caret)))) {
      break;
    }
    if (child.nodeType === Node.TEXT_NODE) {
      const node = child as Text;
      pieces.push({ node, start });
      start += node.data.length;
    }
  }
  return pieces;
}

function rectAtTextIndex(pieces: TextPiece[], index: number, length = 0): DOMRect | null {
  for (const piece of pieces) {
    const local = index - piece.start;
    if (local >= 0 && local <= piece.node.data.length) {
      const range = document.createRange();
      const end = Math.min(piece.node.data.length, local + Math.max(0, length));
      range.setStart(piece.node, local);
      range.setEnd(piece.node, end);
      return range.getBoundingClientRect();
    }
  }
  return null;
}
