// Krypton — ACP Harness View: ```svg fence preview cards (spec 283).
//
// A sealed assistant row's ```svg fences become cards whose preview is an
// <img src="data:image/svg+xml,…">. SVG used as an image runs in the SVG2
// secure animated mode — no script, no external fetch, no interaction — which
// keeps agent-authored markup inert in this csp:null, IPC-capable webview.
// The parsed SVG is used for validation only and is never inserted into the DOM.
//
// Before encoding, var(--name) references resolve against the active Krypton
// theme using OMP's palette names, so one SVG themes correctly in both the OMP
// TUI and here. Decoration is never cached in item.markdownHtml: it runs on
// every render of the row, like the resources rail.

import type { HarnessTranscriptItem, SvgFenceEntry } from './harness-view-types';

/** Fence sources longer than this stay plain code. */
export const SVG_FENCE_MAX_CHARS = 256 * 1024;

/** Revision 2: minimum gap between live repaints of a streaming fence (OMP parity). */
export const SVG_LIVE_INTERVAL_MS = 200;

/** Per-turn preamble line: tells every lane that ```svg renders here. */
export const SVG_FENCE_GUIDANCE =
  'SVG figures: when a diagram, chart, or UI mockup explains something better than prose, you may include it as a ```svg fenced block — Krypton renders it inline as an image (the user can toggle to source). Keep it self-contained: scripts, external images, and web fonts are blocked. Give the root a viewBox. Use theme colors via var(--fg), var(--muted), var(--border), var(--accent), var(--success), var(--warning), var(--error), var(--surface), var(--c1)…var(--c6), optionally with a fallback such as var(--accent, #0cf).';

export const SVG_PALETTE_KEYS = [
  'fg', 'muted', 'border', 'accent', 'success', 'warning', 'error', 'surface',
  'c1', 'c2', 'c3', 'c4', 'c5', 'c6',
] as const;
export type SvgPaletteKey = (typeof SVG_PALETTE_KEYS)[number];
/** Resolved colours; a missing key falls back to the var() fallback, then `fg`. */
export type SvgPalette = Partial<Record<SvgPaletteKey, string>>;

/** Krypton theme property per palette name; `rgb` props hold an "r, g, b" triplet. */
const PALETTE_SOURCES: Record<SvgPaletteKey, { prop: string; rgb?: true }> = {
  fg: { prop: '--krypton-fg' },
  muted: { prop: '--krypton-fg-dim' },
  border: { prop: '--krypton-border-color' },
  accent: { prop: '--krypton-accent' },
  success: { prop: '--krypton-success-rgb', rgb: true },
  warning: { prop: '--krypton-warning-rgb', rgb: true },
  error: { prop: '--krypton-danger-rgb', rgb: true },
  surface: { prop: '--krypton-bg-elev' },
  c1: { prop: '--krypton-ansi-5' }, // keyword — magenta
  c2: { prop: '--krypton-ansi-2' }, // string — green
  c3: { prop: '--krypton-ansi-4' }, // function — blue
  c4: { prop: '--krypton-ansi-3' }, // type — yellow
  c5: { prop: '--krypton-ansi-6' }, // number — cyan
  c6: { prop: '--krypton-ansi-1' }, // variable — red
};

// Last resort when neither --agent-font nor --krypton-font-family is set.
const SVG_FONT_FALLBACK = 'ui-monospace, SFMono-Regular, Menlo, monospace';
const SVG_DATA_URL_PREFIX = 'data:image/svg+xml;charset=utf-8,';
const VAR_RE = /var\(\s*--([\w-]+)\s*(?:,\s*((?:[^()]|\([^()]*\))*))?\)/g;
const ROOT_RE = /<(?:[\w.-]+:)?svg(?=[\s/>])[^>]*>/;

const CARD = 'acp-harness__svg-card';
const LIVE_CARD = `${CARD}--live`;

function isPaletteKey(name: string): name is SvgPaletteKey {
  return (SVG_PALETTE_KEYS as readonly string[]).includes(name);
}

/** Read the active theme's palette from computed root styles. */
export function readSvgPalette(root: Element = document.documentElement): SvgPalette {
  const style = getComputedStyle(root);
  const palette: SvgPalette = {};
  for (const key of SVG_PALETTE_KEYS) {
    const { prop, rgb } = PALETTE_SOURCES[key];
    const value = style.getPropertyValue(prop).trim();
    if (value) palette[key] = rgb ? `rgb(${value})` : value;
  }
  return palette;
}

/** The harness view's font stack (`--agent-font` → `--krypton-font-family`,
 *  i.e. `[font] family` from krypton.toml), resolved like acp-harness.css does.
 *  Configured families are installed fonts, so an <img>-loaded SVG can use them. */
export function readSvgFontFamily(root: Element = document.documentElement): string {
  const style = getComputedStyle(root);
  return style.getPropertyValue('--agent-font').trim()
    || style.getPropertyValue('--krypton-font-family').trim()
    || SVG_FONT_FALLBACK;
}

function escapeXmlText(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;');
}

/** Resolve palette var() references and give the root the attributes an
 *  <img>-loaded SVG needs: `xmlns` (without it the image does not render),
 *  `xmlns:xlink` when used, and default `color` / `fill`.
 *  `fill` departs from OMP: SVG's initial fill is black, so unstyled text and
 *  shapes would vanish on a dark theme; inheriting `fg` keeps them legible.
 *  Text always renders in `fontFamily`: an injected `!important` rule beats
 *  author font-family attributes and plain inline styles, so figures match the
 *  harness transcript font. */
export function themeSvgSource(source: string, palette: SvgPalette, fontFamily: string): string {
  const fg = palette.fg ?? 'currentColor';
  const themed = source.replace(VAR_RE, (_match: string, name: string, fallback: string | undefined) => {
    const resolved = isPaletteKey(name) ? palette[name] : undefined;
    return resolved ?? (fallback?.trim() || fg);
  });
  const usesXlink = themed.includes('xlink:');
  return themed.replace(ROOT_RE, (tag) => {
    let extra = '';
    if (!/\sxmlns\s*=/.test(tag)) extra += ' xmlns="http://www.w3.org/2000/svg"';
    if (usesXlink && !/\sxmlns:xlink\s*=/.test(tag)) extra += ' xmlns:xlink="http://www.w3.org/1999/xlink"';
    if (!/\scolor\s*=/.test(tag)) extra += ` color="${fg}"`;
    if (!/\sfill\s*=/.test(tag)) extra += ` fill="${fg}"`;
    const open = extra ? tag.replace(/^<[^\s/>]+/, `$&${extra}`) : tag;
    if (open.endsWith('/>')) return open;
    return `${open}<style>*{font-family:${escapeXmlText(fontFamily)}!important}</style>`;
  });
}

function numericAttr(tag: string, name: string): number | null {
  const raw = new RegExp(`\\s${name}\\s*=\\s*["']\\s*([\\d.]+)(?:px)?\\s*["']`).exec(tag)?.[1];
  const n = raw === undefined ? NaN : Number(raw);
  return Number.isFinite(n) && n > 0 ? n : null;
}

/** Full HD in device pixels: the largest box a preview draws at. On a 2× Retina
 *  screen that is 960×540 CSS px; narrower lanes scale it down further. */
const SVG_PREVIEW_MAX_WIDTH = 1920;
const SVG_PREVIEW_MAX_HEIGHT = 1080;

export interface SvgFrame {
  /** CSS aspect-ratio value, reserving height before the image decodes. */
  ratio: string | null;
  /** Preview CSS px width: the figure's own size (explicit width, else viewBox
   *  units as px) fitted inside Full HD device pixels; null when the root declares neither. */
  width: number | null;
}

function viewBoxSize(tag: string): { width: number; height: number } | null {
  const viewBox = /\sviewBox\s*=\s*["']([^"']*)["']/.exec(tag)?.[1];
  if (!viewBox) return null;
  const parts = viewBox.trim().split(/[\s,]+/).map(Number);
  return parts.length === 4 && parts[2] > 0 && parts[3] > 0 ? { width: parts[2], height: parts[3] } : null;
}

/** Size hints from the root tag's viewBox / width / height. `pixelRatio` is
 *  device px per CSS px (`window.devicePixelRatio`). */
export function svgFrame(source: string, pixelRatio = 1): SvgFrame {
  const tag = ROOT_RE.exec(source)?.[0] ?? '';
  const width = numericAttr(tag, 'width');
  const height = numericAttr(tag, 'height');
  const box = viewBoxSize(tag);
  const ratio = box ? `${box.width} / ${box.height}` : width && height ? `${width} / ${height}` : null;
  if (!box && !width) return { ratio, width: null };
  const base = svgBaseSize(source);
  const dpr = pixelRatio > 0 ? pixelRatio : 1;
  const scale = Math.min(1, SVG_PREVIEW_MAX_WIDTH / dpr / base.width, SVG_PREVIEW_MAX_HEIGHT / dpr / base.height);
  return { ratio, width: base.width * scale };
}

/** The 100% size the viewer zooms from: explicit width/height win, the viewBox
 *  supplies a missing side (or both), and HTML's 300×150 default is the last resort. */
export function svgBaseSize(source: string): { width: number; height: number } {
  const tag = ROOT_RE.exec(source)?.[0] ?? '';
  const width = numericAttr(tag, 'width');
  const height = numericAttr(tag, 'height');
  if (width && height) return { width, height };
  const box = viewBoxSize(tag);
  if (box) {
    if (width) return { width, height: (width * box.height) / box.width };
    if (height) return { width: (height * box.width) / box.height, height };
    return box;
  }
  return { width: width ?? 300, height: height ?? 150 };
}

/** spec 283: what the image viewer needs to zoom a fence — the themed data URL and its base size. */
export function svgViewerSource(source: string): { src: string; width: number; height: number } {
  const themed = themeSvgSource(source, readSvgPalette(), readSvgFontFamily());
  return { src: SVG_DATA_URL_PREFIX + encodeURIComponent(themed), ...svgBaseSize(themed) };
}

/** Fence text as written; marked-highlight appends one trailing newline. */
export function fenceSourceText(text: string): string {
  return text.endsWith('\n') ? text.slice(0, -1) : text;
}

function isRenderableSvg(themed: string): boolean {
  const doc = new DOMParser().parseFromString(themed, 'image/svg+xml');
  const root = doc.documentElement;
  return root.localName === 'svg' && doc.getElementsByTagName('parsererror').length === 0;
}

function setPreview(img: HTMLImageElement, themed: string, src = SVG_DATA_URL_PREFIX + encodeURIComponent(themed)): void {
  const frame = svgFrame(themed, window.devicePixelRatio);
  img.style.aspectRatio = frame.ratio ?? '';
  if (frame.width) img.width = Math.round(frame.width);
  else img.removeAttribute('width');
  img.src = src;
}

function button(kind: 'toggle' | 'copy', index: number, text: string): HTMLButtonElement {
  const el = document.createElement('button');
  el.type = 'button';
  el.tabIndex = -1;
  el.className = `acp-harness__svg-card-btn acp-harness__svg-card-btn--${kind}`;
  el.dataset[kind === 'toggle' ? 'svgToggle' : 'svgCopy'] = '';
  el.dataset.svgIndex = String(index);
  el.textContent = text;
  return el;
}

function buildCard(pre: HTMLElement, themed: string, index: number): HTMLElement {
  const card = document.createElement('figure');
  card.className = CARD;
  card.dataset.svgIndex = String(index);
  const bar = document.createElement('div');
  bar.className = `${CARD}-bar`;
  const kind = document.createElement('span');
  kind.className = `${CARD}-kind`;
  kind.textContent = 'svg';
  const hint = document.createElement('span');
  hint.className = `${CARD}-hint`;
  hint.hidden = true;
  bar.append(kind, hint, button('toggle', index, 'Source'), button('copy', index, 'Copy'));
  const preview = document.createElement('div');
  preview.className = `${CARD}-preview`;
  const img = document.createElement('img');
  img.alt = 'SVG preview';
  img.decoding = 'async';
  // Click zooms the card in the image viewer.
  img.dataset.svgZoom = '';
  img.dataset.svgIndex = String(index);
  // A source the engine still refuses: show the code, drop the toggle.
  img.addEventListener('error', () => card.classList.add(`${CARD}--broken`), { once: true });
  setPreview(img, themed);
  preview.appendChild(img);
  pre.replaceWith(card);
  card.append(bar, preview, pre);
  return card;
}

function applyCardState(card: HTMLElement, entry: SvgFenceEntry): void {
  card.classList.toggle(`${CARD}--source`, entry.showSource);
  card.classList.toggle(`${CARD}--hinted`, entry.hintLabel !== null);
  const hint = card.querySelector<HTMLElement>(`.${CARD}-hint`);
  if (hint) {
    hint.textContent = entry.hintLabel ?? '';
    hint.hidden = entry.hintLabel === null;
  }
  const toggle = card.querySelector<HTMLElement>('[data-svg-toggle]');
  if (toggle) toggle.textContent = entry.showSource ? 'Preview' : 'Source';
}

/** Turn every valid ```svg fence in a sealed assistant body into a card and
 *  sync `item.svgFences`. Idempotent: an existing card is re-used. Entries keep
 *  their object identity and state across re-renders, keyed by fence index. */
export function decorateSvgFences(body: HTMLElement, item: HarnessTranscriptItem): void {
  const previous = item.svgFences ?? [];
  const entries: SvgFenceEntry[] = [];
  let palette: SvgPalette | null = null;
  let fontFamily: string | null = null;
  for (const code of Array.from(body.querySelectorAll<HTMLElement>('pre > code'))) {
    // smd puts the whole info string in `class` ("svg"); marked-highlight uses "hljs language-svg".
    if (!code.classList.contains('svg') && !code.classList.contains('language-svg')) continue;
    const pre = code.parentElement;
    if (!pre) continue;
    const source = fenceSourceText(code.textContent ?? '');
    const index = entries.length;
    let card = pre.parentElement?.classList.contains(CARD) ? pre.parentElement : null;
    if (!card) {
      if (source.length > SVG_FENCE_MAX_CHARS) continue;
      palette ??= readSvgPalette();
      fontFamily ??= readSvgFontFamily();
      const themed = themeSvgSource(source, palette, fontFamily);
      if (!isRenderableSvg(themed)) continue;
      card = buildCard(pre, themed, index);
    }
    const entry = previous.find((candidate) => candidate.index === index)
      ?? { index, hintLabel: null, showSource: false, source };
    entry.source = source;
    entries.push(entry);
    applyCardState(card, entry);
  }
  if (entries.length > 0) item.svgFences = entries;
  else delete item.svgFences;
}

/** Theme switch: re-theme every rendered card's preview in place. */
export function refreshSvgFencePreviews(root: ParentNode): void {
  const cards = root.querySelectorAll<HTMLElement>(`.${CARD}`);
  if (cards.length === 0) return;
  const palette = readSvgPalette();
  const fontFamily = readSvgFontFamily();
  for (const card of Array.from(cards)) {
    const code = card.querySelector<HTMLElement>(':scope > pre > code');
    const img = card.querySelector<HTMLImageElement>(`:scope > .${CARD}-preview > img`);
    if (code && img) {
      setPreview(img, themeSvgSource(fenceSourceText(code.textContent ?? ''), palette, fontFamily));
    }
  }
}

/** End (exclusive) of the markup token opening at `source[start] === '<'`, or -1 while unfinished. */
function markupTokenEnd(source: string, start: number): number {
  const after = (marker: string, from: number): number => {
    const at = source.indexOf(marker, from);
    return at < 0 ? -1 : at + marker.length;
  };
  if (source.startsWith('<!--', start)) return after('-->', start + 4);
  if (source.startsWith('<![CDATA[', start)) return after(']]>', start + 9);
  if (source.startsWith('<?', start)) return after('?>', start + 2);
  let quote: string | null = null;
  let inSubset = false; // <!DOCTYPE … [ … ]>
  for (let i = start + 1; i < source.length; i++) {
    const ch = source[i];
    if (quote !== null) {
      if (ch === quote) quote = null;
    } else if (ch === '"' || ch === "'") {
      quote = ch;
    } else if (ch === '[' && source[start + 1] === '!') {
      inSubset = true;
    } else if (ch === ']') {
      inSubset = false;
    } else if (ch === '>' && !inSubset) {
      return i + 1;
    }
  }
  return -1;
}

/** Revision 2 (port of OMP's streaming SVG close): turn a half-streamed SVG into
 *  a well-formed document. Cuts at the end of the last complete tag (dropping a
 *  dangling `&entity`), then closes every still-open element innermost first.
 *  Trailing text is kept, so `<text>` content draws in as it streams.
 *  Null until an `<svg` start tag is complete. A complete document is returned unchanged. */
export function closeSvgPrefix(source: string): string | null {
  const open: string[] = [];
  let sawRoot = false;
  let cut = 0;
  let pos = 0;
  for (;;) {
    const lt = source.indexOf('<', pos);
    if (lt < 0) {
      const amp = source.lastIndexOf('&');
      cut = amp >= pos && !source.includes(';', amp) ? amp : source.length;
      break;
    }
    cut = lt;
    const end = markupTokenEnd(source, lt);
    if (end < 0) break;
    if (source.startsWith('</', lt)) {
      const name = source.slice(lt + 2, end - 1).trim();
      const at = open.lastIndexOf(name);
      if (at >= 0) open.length = at;
    } else if (source[lt + 1] !== '!' && source[lt + 1] !== '?') {
      const name = /^<([^\s/>]+)/.exec(source.slice(lt, end))?.[1];
      if (name !== undefined) {
        if (source[end - 2] !== '/') open.push(name);
        if (name === 'svg' || name.endsWith(':svg')) sawRoot = true;
      }
    }
    pos = end;
    cut = end;
  }
  if (!sawRoot) return null;
  let closed = source.slice(0, cut);
  for (let i = open.length - 1; i >= 0; i--) closed += `</${open[i]}>`;
  return closed;
}

interface LiveSvg {
  /** The live card, inserted before the fence's <pre> on the first decoded frame. */
  card: HTMLElement | null;
  /** Fence text at the last tick — unchanged text skips all work. */
  source: string;
  /** Themed document last sent to decode; a stale decode never paints. */
  requested: string;
  lastTickAt: number;
  timer: number | null;
}

/** Keyed by smd's live <code>; a rebuilt body drops its nodes and so its entries. */
const liveSvgs = new WeakMap<HTMLElement, LiveSvg>();

function buildLiveCard(): HTMLElement {
  const card = document.createElement('figure');
  card.className = `${CARD} ${LIVE_CARD}`;
  const bar = document.createElement('div');
  bar.className = `${CARD}-bar`;
  const kind = document.createElement('span');
  kind.className = `${CARD}-kind`;
  kind.textContent = 'svg · drawing…';
  bar.appendChild(kind);
  const preview = document.createElement('div');
  preview.className = `${CARD}-preview`;
  const img = document.createElement('img');
  img.alt = 'SVG preview (drawing)';
  img.decoding = 'async';
  preview.appendChild(img);
  card.append(bar, preview);
  return card;
}

function paintLiveSvg(code: HTMLElement, state: LiveSvg): void {
  state.lastTickAt = performance.now();
  const source = code.textContent ?? '';
  if (source === state.source) return;
  state.source = source;
  if (source.length > SVG_FENCE_MAX_CHARS) {
    state.card?.remove();
    state.card = null;
    state.requested = '';
    return;
  }
  const closed = closeSvgPrefix(source);
  if (closed === null) return;
  // Palette read per tick: a mid-stream theme switch heals on the next frame.
  const themed = themeSvgSource(closed, readSvgPalette(), readSvgFontFamily());
  if (themed === state.requested) return;
  state.requested = themed;
  const src = SVG_DATA_URL_PREFIX + encodeURIComponent(themed);
  // Decode off-DOM first: the visible <img> swaps only to a ready frame (no
  // blank flash), and a prefix the engine refuses keeps the last good frame.
  const probe = new Image();
  probe.src = src;
  probe.decode().then(() => {
    if (state.requested !== themed || liveSvgs.get(code) !== state) return;
    const pre = code.parentElement;
    if (!pre || !code.isConnected) {
      // Lane switched away mid-decode: forget the frame so the next tick on a
      // re-attached body paints it instead of skipping unchanged text.
      state.source = '';
      state.requested = '';
      return;
    }
    const card = state.card ?? buildLiveCard();
    if (card.nextElementSibling !== pre) pre.before(card);
    state.card = card;
    const img = card.querySelector<HTMLImageElement>('img');
    if (img) setPreview(img, themed, src);
  }, () => undefined);
}

function tickLiveSvg(code: HTMLElement, state: LiveSvg): void {
  if (state.timer !== null) return;
  const wait = state.lastTickAt + SVG_LIVE_INTERVAL_MS - performance.now();
  if (wait <= 0) {
    paintLiveSvg(code, state);
    return;
  }
  // Trailing tick: a stream that pauses mid-figure still paints its latest prefix.
  state.timer = window.setTimeout(() => {
    state.timer = null;
    if (liveSvgs.get(code) === state && code.isConnected) paintLiveSvg(code, state);
  }, wait);
}

/** Revision 2: progressively preview every ```svg fence in a streaming smd
 *  body. Called after each parser_write. The live card is a sibling inserted
 *  before the fence's <pre>: smd only ever appends into the nodes it holds,
 *  so the parser-owned <pre>/<code> are never wrapped or moved. */
export function updateLiveSvgFences(body: HTMLElement): void {
  // Live bodies are always smd: the whole info string is the class ("svg").
  for (const code of Array.from(body.querySelectorAll<HTMLElement>('pre > code.svg'))) {
    let state = liveSvgs.get(code);
    if (!state) {
      state = { card: null, source: '', requested: '', lastTickAt: Number.NEGATIVE_INFINITY, timer: null };
      liveSvgs.set(code, state);
    }
    tickLiveSvg(code, state);
  }
}

/** Revision 2: at seal, drop live cards and pending ticks before the body is
 *  captured into `markdownHtml`; decorateSvgFences then builds the real card. */
export function clearLiveSvgFences(body: HTMLElement): void {
  for (const code of Array.from(body.querySelectorAll<HTMLElement>('pre > code.svg'))) {
    const state = liveSvgs.get(code);
    if (!state) continue;
    clearTimeout(state.timer ?? undefined);
    liveSvgs.delete(code);
  }
  for (const card of Array.from(body.querySelectorAll<HTMLElement>(`.${LIVE_CARD}`))) card.remove();
}
