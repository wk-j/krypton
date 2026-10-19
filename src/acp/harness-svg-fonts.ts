// Krypton — ACP Harness View: the transcript font inside <img> SVG figures (spec 283).
//
// WebKit draws an <img>-loaded SVG with user-installed fonts disabled, so a
// `[font] family` from krypton.toml living in ~/Library/Fonts would fall back
// to a generic face inside a figure. The backend (`svg_font_faces`) subsets
// every user-installed family of the stack to the characters a figure uses;
// each subset is embedded as an @font-face data URL under its own family
// name, so the figure's existing font-family stack resolves to it. Results are
// cached per (stack, characters), so a rebuilt row paints synchronously.

import { invoke } from '@tauri-apps/api/core';

/** First `<svg>` start tag (any prefix), the root every injected <style> follows. */
export const SVG_ROOT_RE = /<(?:[\w.-]+:)?svg(?=[\s/>])[^>]*>/;

const FACES_CACHE_MAX = 64;

const GENERIC_FAMILIES: Record<string, true> = {
  serif: true, 'sans-serif': true, monospace: true, cursive: true, fantasy: true, math: true,
  emoji: true, fangsong: true, 'system-ui': true, 'ui-serif': true, 'ui-sans-serif': true,
  'ui-monospace': true, 'ui-rounded': true, '-apple-system': true, blinkmacsystemfont: true,
  inherit: true, initial: true, unset: true, revert: true,
};

interface SvgFontFace {
  family: string;
  /** Base64 TrueType/OpenType subset. */
  data: string;
}

/** Insertion-ordered: the first key is the least recently used. */
const cache = new Map<string, string>();
const inFlight = new Map<string, Promise<string>>();

/** Named families of a CSS font-family list in fallback order; generic
 *  keywords (unquoted) and repeats are dropped. */
export function fontStackFamilies(fontFamily: string): string[] {
  const families: string[] = [];
  const add = (name: string, quoted: boolean): void => {
    const family = quoted ? name : name.trim().replace(/\s+/g, ' ');
    const generic = !quoted && Object.prototype.hasOwnProperty.call(GENERIC_FAMILIES, family.toLowerCase());
    if (!family || generic) return;
    if (!families.includes(family)) families.push(family);
  };
  let current = '';
  let quote: string | null = null;
  let quoted = false;
  for (let i = 0; i < fontFamily.length; i++) {
    const ch = fontFamily[i];
    if (quote !== null) {
      if (ch === '\\' && i + 1 < fontFamily.length) current += fontFamily[++i];
      else if (ch === quote) quote = null;
      else current += ch;
    } else if (ch === '"' || ch === "'") {
      quote = ch;
      quoted = true;
      current = '';
    } else if (ch === ',') {
      add(current, quoted);
      current = '';
      quoted = false;
    } else if (!quoted) {
      current += ch;
    }
  }
  add(current, quoted);
  return families;
}

/** Non-ASCII characters of `source`, sorted and unique; printable ASCII is
 *  always subset, so Latin-only figures share one cache entry. */
function extraChars(source: string): string {
  const chars = new Set<string>();
  for (const ch of source) if (ch > '~') chars.add(ch);
  return [...chars].sort().join('');
}

function cssString(text: string): string {
  return `"${text.replace(/["\\]/g, '\\$&').replace(/[\n\r\f]/g, ' ')}"`;
}

function escapeXmlText(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;');
}

function facesCss(faces: SvgFontFace[]): string {
  return faces
    .map((face) => `@font-face{font-family:${cssString(face.family)};src:url(data:font/ttf;base64,${face.data})}`)
    .join('');
}

function cacheKey(families: string[], chars: string): string {
  return `${families.join('\n')}\0${chars}`;
}

function remember(key: string, css: string): void {
  cache.delete(key);
  cache.set(key, css);
  if (cache.size > FACES_CACHE_MAX) {
    const oldest = cache.keys().next().value;
    if (oldest !== undefined) cache.delete(oldest);
  }
}

/** The @font-face rules a figure drawn from `source` needs under the
 *  `fontFamily` stack, if already known ('' = nothing to embed). */
export function cachedSvgFontFaces(source: string, fontFamily: string): string | undefined {
  const families = fontStackFamilies(fontFamily);
  if (families.length === 0) return '';
  const key = cacheKey(families, extraChars(source));
  const css = cache.get(key);
  if (css !== undefined) remember(key, css);
  return css;
}

/** Load (or join the in-flight load of) the rules for `source`. Resolves ''
 *  when the backend finds nothing to embed or is unavailable. */
export function loadSvgFontFaces(source: string, fontFamily: string): Promise<string> {
  const families = fontStackFamilies(fontFamily);
  if (families.length === 0) return Promise.resolve('');
  // Only WebKit inside Tauri blocks user-installed fonts in an <img> SVG. A
  // plain browser page (the spec 313 gallery) resolves the stack itself and has
  // no backend to subset with, so asking would only log a failed invoke.
  if (typeof window !== 'undefined' && !('__TAURI_INTERNALS__' in window)) return Promise.resolve('');
  const text = extraChars(source);
  const key = cacheKey(families, text);
  const hit = cache.get(key);
  if (hit !== undefined) return Promise.resolve(hit);
  let pending = inFlight.get(key);
  if (!pending) {
    pending = (async (): Promise<string> => {
      let css = '';
      try {
        css = facesCss(await invoke<SvgFontFace[]>('svg_font_faces', { families, text }));
      } catch (error) {
        console.warn('[harness] svg_font_faces failed:', error);
      }
      remember(key, css);
      inFlight.delete(key);
      return css;
    })();
    inFlight.set(key, pending);
  }
  return pending;
}

/** Put `faces` in a <style> right after the root start tag. A self-closing
 *  root has no text to draw and is returned unchanged. */
export function embedSvgFontFaces(svg: string, faces: string): string {
  if (!faces) return svg;
  return svg.replace(SVG_ROOT_RE, (tag) => (tag.endsWith('/>') ? tag : `${tag}<style>${escapeXmlText(faces)}</style>`));
}

/** Test seam: forget cached faces. */
export function clearSvgFontFacesCache(): void {
  cache.clear();
  inFlight.clear();
}
