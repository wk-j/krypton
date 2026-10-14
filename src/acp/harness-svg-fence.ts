// Krypton — ACP Harness View: ```svg / ```mermaid fence preview cards (specs 283, 294).
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
//
// spec 294: a ```mermaid fence is the same card. harness-mermaid-fence.ts draws
// it to an SVG string (async, cached); the card shows it through the same <img>.
//
// The <img> page cannot reach user-installed fonts, so harness-svg-fonts.ts
// embeds subsets of the transcript font stack; a preview paints once they load.

import { buildMermaidTheme, cachedMermaid, MERMAID_FENCE_MAX_CHARS, renderMermaid } from './harness-mermaid-fence';
import type { MermaidResult, MermaidTheme } from './harness-mermaid-fence';
import { cachedSvgFontFaces, embedSvgFontFaces, loadSvgFontFaces, SVG_ROOT_RE } from './harness-svg-fonts';
import type { HarnessTranscriptItem, SvgFenceEntry } from './harness-view-types';

/** Fence sources longer than this stay plain code. */
export const SVG_FENCE_MAX_CHARS = 256 * 1024;

/** Revision 2: minimum gap between live repaints of a streaming fence (OMP parity). */
export const SVG_LIVE_INTERVAL_MS = 200;

/** Lane-policy line (spec 289): tells every lane that ```svg renders here. */
export const SVG_FENCE_GUIDANCE =
  '```svg fenced blocks render inline as images: self-contained (no scripts, external images, or web fonts), root viewBox, colors via var(--fg|--muted|--border|--accent|--success|--warning|--error|--surface|--c1…--c6) with optional fallbacks such as var(--accent, #0cf).';

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

const CARD = 'acp-harness__svg-card';
const LIVE_CARD = `${CARD}--live`;
const PENDING_CARD = `${CARD}--pending`;
const BROKEN_CARD = `${CARD}--broken`;

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
 *  User-installed families reach an <img>-loaded SVG only as embedded faces
 *  (harness-svg-fonts.ts). */
export function readSvgFontFamily(root: Element = document.documentElement): string {
  const style = getComputedStyle(root);
  return style.getPropertyValue('--agent-font').trim()
    || style.getPropertyValue('--krypton-font-family').trim()
    || SVG_FONT_FALLBACK;
}

/** spec 294: the mermaid config for the active theme (palette, font, scheme). */
export function readMermaidTheme(): MermaidTheme {
  return buildMermaidTheme(readSvgPalette(), readSvgFontFamily(), document.documentElement.dataset.themeScheme !== 'light');
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
  return themed.replace(SVG_ROOT_RE, (tag) => {
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
  const tag = SVG_ROOT_RE.exec(source)?.[0] ?? '';
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
  const tag = SVG_ROOT_RE.exec(source)?.[0] ?? '';
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

/** spec 283/294: what the image viewer needs to zoom a fence — the data URL and
 *  its base size. Null while a mermaid fence is still rendering or failed. */
export function figureViewerSource(entry: SvgFenceEntry): { src: string; width: number; height: number } | null {
  let svg: string;
  if (entry.kind === 'mermaid') {
    const result = cachedMermaid(entry.source, readMermaidTheme());
    if (!result?.ok) return null;
    svg = result.svg;
  } else {
    const fontFamily = readSvgFontFamily();
    const faces = cachedSvgFontFaces(entry.source, fontFamily) ?? '';
    svg = embedSvgFontFaces(themeSvgSource(entry.source, readSvgPalette(), fontFamily), faces);
  }
  return { src: SVG_DATA_URL_PREFIX + encodeURIComponent(svg), ...svgBaseSize(svg) };
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

/** Latest data URL requested per preview <img>; a superseded decode never paints. */
const previewRequests = new WeakMap<HTMLImageElement, string>();

/** Show `themed` without a blank frame: an empty <img> takes it directly; one
 *  already showing a frame (adopted live frame, theme refresh) keeps it until
 *  the new one decodes off-DOM. An unchanged frame is left alone. */
function paintPreview(img: HTMLImageElement, themed: string): void {
  const src = SVG_DATA_URL_PREFIX + encodeURIComponent(themed);
  previewRequests.set(img, src);
  const current = img.getAttribute('src');
  if (current === src) return;
  if (!current) {
    setPreview(img, themed, src);
    return;
  }
  // A refused frame still lands, so the card's error listener marks it broken.
  const swap = (): void => {
    if (previewRequests.get(img) === src) setPreview(img, themed, src);
  };
  const probe = new Image();
  probe.src = src;
  probe.decode().then(swap, swap);
}

/** Latest paint request per svg card; a superseded font load never paints. */
const svgPaints = new WeakMap<HTMLElement, object>();

/** Paint an svg card with the transcript font embedded: synchronously when the
 *  faces are cached, else once they load. A card without a frame stays
 *  `--pending` meanwhile (one paint, no fallback-font flash on a sealed row);
 *  a card with one keeps it until the new frame is ready. */
function requestSvgPaint(card: HTMLElement, img: HTMLImageElement, source: string, themed: string, fontFamily: string): void {
  const faces = cachedSvgFontFaces(source, fontFamily);
  if (faces !== undefined) {
    svgPaints.delete(card);
    card.classList.remove(PENDING_CARD);
    paintPreview(img, embedSvgFontFaces(themed, faces));
    return;
  }
  const token = {};
  svgPaints.set(card, token);
  if (!img.getAttribute('src')) card.classList.add(PENDING_CARD);
  void loadSvgFontFaces(source, fontFamily).then((loaded) => {
    if (svgPaints.get(card) !== token) return;
    svgPaints.delete(card);
    card.classList.remove(PENDING_CARD);
    paintPreview(img, embedSvgFontFaces(themed, loaded));
  });
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

function buildCard(pre: HTMLElement, index: number, kind: SvgFenceEntry['kind']): HTMLElement {
  const card = document.createElement('figure');
  card.className = kind === 'mermaid' ? `${CARD} ${CARD}--mermaid` : CARD;
  card.dataset.svgIndex = String(index);
  card.dataset.svgKind = kind;
  const bar = document.createElement('div');
  bar.className = `${CARD}-bar`;
  const label = document.createElement('span');
  label.className = `${CARD}-kind`;
  label.textContent = kind;
  const hint = document.createElement('span');
  hint.className = `${CARD}-hint`;
  hint.hidden = true;
  bar.append(label, hint, button('toggle', index, 'Source'), button('copy', index, 'Copy'));
  const preview = document.createElement('div');
  preview.className = `${CARD}-preview`;
  // Seal: keep the live card's decoded <img> so the figure never blanks.
  const img = liveFrames.get(pre) ?? document.createElement('img');
  liveFrames.delete(pre);
  img.alt = kind === 'mermaid' ? 'Mermaid diagram' : 'SVG preview';
  img.decoding = 'async';
  // Click zooms the card in the image viewer.
  img.dataset.svgZoom = '';
  img.dataset.svgIndex = String(index);
  // A source the engine still refuses: show the code, drop the toggle.
  img.addEventListener('error', () => card.classList.add(BROKEN_CARD), { once: true });
  preview.appendChild(img);
  pre.replaceWith(card);
  card.append(bar, preview, pre);
  return card;
}

/** spec 294: show a finished mermaid render on its card (sub-DOM only). */
function paintMermaidCard(card: HTMLElement, result: MermaidResult): void {
  card.classList.remove(PENDING_CARD);
  const label = card.querySelector<HTMLElement>(`:scope > .${CARD}-bar > .${CARD}-kind`);
  const img = card.querySelector<HTMLImageElement>(`:scope > .${CARD}-preview > img`);
  if (result.ok) {
    card.classList.remove(BROKEN_CARD);
    card.removeAttribute('title');
    if (label) label.textContent = `mermaid · ${result.diagramType}`;
    if (img) paintPreview(img, result.svg);
  } else {
    card.classList.add(BROKEN_CARD);
    card.title = result.error;
    if (label) label.textContent = 'mermaid · error';
  }
}

/** spec 294: paint from cache, else queue a render and patch the card when it
 *  settles. A settled render whose card left the DOM (row rebuilt) or whose
 *  theme was superseded paints nothing; the cache keeps it for the next build.
 *  The previous frame stays up meanwhile, so a theme switch never flashes. */
function requestMermaidPaint(card: HTMLElement, source: string, theme: MermaidTheme): void {
  card.dataset.mermaidTheme = theme.key;
  const hit = cachedMermaid(source, theme);
  if (hit) {
    paintMermaidCard(card, hit);
    return;
  }
  const label = card.querySelector<HTMLElement>(`:scope > .${CARD}-bar > .${CARD}-kind`);
  if (label && !card.querySelector(`:scope > .${CARD}-preview > img[src]`)) {
    card.classList.add(PENDING_CARD);
    label.textContent = 'mermaid · rendering…';
  }
  void renderMermaid(source, theme, () => card.isConnected).then((result) => {
    if (result && card.isConnected && card.dataset.mermaidTheme === theme.key) paintMermaidCard(card, result);
  });
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

/** smd puts the whole info string in `class` ("svg"); marked-highlight uses "hljs language-svg". */
function fenceKind(code: HTMLElement): SvgFenceEntry['kind'] | null {
  const classes = code.classList;
  if (classes.contains('svg') || classes.contains('language-svg')) return 'svg';
  if (classes.contains('mermaid') || classes.contains('language-mermaid')) return 'mermaid';
  return null;
}

/** Turn every valid ```svg and every ```mermaid fence in a sealed assistant
 *  body into a card and sync `item.svgFences`. Idempotent: an existing card is
 *  re-used. Entries keep their object identity and state across re-renders,
 *  keyed by fence index (one sequence across both kinds). */
export function decorateSvgFences(body: HTMLElement, item: HarnessTranscriptItem): void {
  const previous = item.svgFences ?? [];
  const entries: SvgFenceEntry[] = [];
  let palette: SvgPalette | null = null;
  let fontFamily: string | null = null;
  let mermaidTheme: MermaidTheme | null = null;
  for (const code of Array.from(body.querySelectorAll<HTMLElement>('pre > code'))) {
    const kind = fenceKind(code);
    if (!kind) continue;
    const pre = code.parentElement;
    if (!pre) continue;
    const source = fenceSourceText(code.textContent ?? '');
    const index = entries.length;
    let card = pre.parentElement?.classList.contains(CARD) ? pre.parentElement : null;
    if (!card && kind === 'svg') {
      if (source.length > SVG_FENCE_MAX_CHARS) continue;
      palette ??= readSvgPalette();
      fontFamily ??= readSvgFontFamily();
      const themed = themeSvgSource(source, palette, fontFamily);
      if (!isRenderableSvg(themed)) continue;
      card = buildCard(pre, index, kind);
      const img = card.querySelector<HTMLImageElement>('img');
      if (img) requestSvgPaint(card, img, source, themed, fontFamily);
    } else if (!card) {
      if (source.length > MERMAID_FENCE_MAX_CHARS) continue;
      card = buildCard(pre, index, kind);
      mermaidTheme ??= readMermaidTheme();
      requestMermaidPaint(card, source, mermaidTheme);
    }
    const entry = previous.find((candidate) => candidate.index === index && candidate.kind === kind)
      ?? { index, kind, hintLabel: null, showSource: false, source };
    entry.source = source;
    entries.push(entry);
    applyCardState(card, entry);
  }
  if (entries.length > 0) item.svgFences = entries;
  else delete item.svgFences;
}

/** Theme switch: re-theme every rendered svg card's preview in place; mermaid
 *  cards re-render under the new theme and keep their frame until it lands. */
export function refreshSvgFencePreviews(root: ParentNode): void {
  const cards = root.querySelectorAll<HTMLElement>(`.${CARD}`);
  if (cards.length === 0) return;
  const palette = readSvgPalette();
  const fontFamily = readSvgFontFamily();
  let mermaidTheme: MermaidTheme | null = null;
  for (const card of Array.from(cards)) {
    // Live cards have no <pre> child, so they are skipped here.
    const code = card.querySelector<HTMLElement>(':scope > pre > code');
    const img = card.querySelector<HTMLImageElement>(`:scope > .${CARD}-preview > img`);
    if (!code || !img) continue;
    const source = fenceSourceText(code.textContent ?? '');
    if (card.dataset.svgKind === 'mermaid') {
      mermaidTheme ??= readMermaidTheme();
      requestMermaidPaint(card, source, mermaidTheme);
    } else {
      requestSvgPaint(card, img, source, themeSvgSource(source, palette, fontFamily), fontFamily);
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

function buildLiveCard(label: string, alt: string): HTMLElement {
  const card = document.createElement('figure');
  card.className = `${CARD} ${LIVE_CARD}`;
  const bar = document.createElement('div');
  bar.className = `${CARD}-bar`;
  const kind = document.createElement('span');
  kind.className = `${CARD}-kind`;
  kind.textContent = label;
  bar.appendChild(kind);
  const preview = document.createElement('div');
  preview.className = `${CARD}-preview`;
  const img = document.createElement('img');
  img.alt = alt;
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
  // Palette and font read per tick: a mid-stream theme switch heals on the next frame.
  const fontFamily = readSvgFontFamily();
  const plain = themeSvgSource(closed, readSvgPalette(), fontFamily);
  if (plain === state.requested) return;
  state.requested = plain;
  const stale = (): boolean => state.requested !== plain || liveSvgs.get(code) !== state;
  void loadSvgFontFaces(closed, fontFamily).then((faces) => {
    if (stale()) return;
    const themed = embedSvgFontFaces(plain, faces);
    const src = SVG_DATA_URL_PREFIX + encodeURIComponent(themed);
    // Decode off-DOM first: the visible <img> swaps only to a ready frame (no
    // blank flash), and a prefix the engine refuses keeps the last good frame.
    const probe = new Image();
    probe.src = src;
    return probe.decode().then(() => {
      if (stale()) return;
      const pre = code.parentElement;
      if (!pre || !code.isConnected) {
        // Lane switched away mid-decode: forget the frame so the next tick on a
        // re-attached body paints it instead of skipping unchanged text.
        state.source = '';
        state.requested = '';
        return;
      }
      const card = state.card ?? buildLiveCard('svg · drawing…', 'SVG preview (drawing)');
      if (card.nextElementSibling !== pre) pre.before(card);
      state.card = card;
      const img = card.querySelector<HTMLImageElement>('img');
      if (img) setPreview(img, themed, src);
    });
  }).catch(() => undefined);
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
  updateLiveMermaidFences(body);
}

/** spec 294: one token per streaming ```mermaid fence that has been sent to
 *  render; seal deletes it so a render settling later never paints. */
const liveMermaids = new WeakMap<HTMLElement, object>();

/** True once smd has written anything after `pre` — it only appends, so the
 *  fence is closed. The reply's last fence closes at seal instead. */
export function isFenceClosed(pre: Node, body: Node): boolean {
  for (let node: Node | null = pre; node && node !== body; node = node.parentNode) {
    if (node.nextSibling) return true;
  }
  return false;
}

/** spec 294: draw each streaming ```mermaid fence once, when it closes (OMP
 *  TUI behaviour) — per-delta renders would re-run layout and make the
 *  diagram jump. The live card is a sibling before the parser-owned <pre>. */
function updateLiveMermaidFences(body: HTMLElement): void {
  for (const code of Array.from(body.querySelectorAll<HTMLElement>('pre > code.mermaid'))) {
    const pre = code.parentElement;
    if (!pre || liveMermaids.has(code) || !isFenceClosed(pre, body)) continue;
    const token = {};
    liveMermaids.set(code, token);
    const source = fenceSourceText(code.textContent ?? '');
    if (source.length > MERMAID_FENCE_MAX_CHARS) continue;
    const live = (): boolean => liveMermaids.get(code) === token && code.isConnected;
    void renderMermaid(source, readMermaidTheme(), live).then((result) => {
      if (!result?.ok || !live()) return;
      const card = buildLiveCard(`mermaid · ${result.diagramType}`, 'Mermaid diagram');
      pre.before(card);
      const img = card.querySelector<HTMLImageElement>('img');
      if (img) setPreview(img, result.svg);
    });
  }
}

/** Seal hand-off: a live card's painted <img>, keyed by the fence <pre> it
 *  stood in for, adopted by the card buildCard makes for that <pre>. */
const liveFrames = new WeakMap<HTMLElement, HTMLImageElement>();

/** Revision 2: at seal, drop live cards and pending ticks before the body is
 *  captured into `markdownHtml`; decorateSvgFences then builds the real card,
 *  re-using each live card's painted <img> so the figure does not blank. */
export function clearLiveSvgFences(body: HTMLElement): void {
  for (const code of Array.from(body.querySelectorAll<HTMLElement>('pre > code.svg'))) {
    const state = liveSvgs.get(code);
    if (!state) continue;
    clearTimeout(state.timer ?? undefined);
    liveSvgs.delete(code);
  }
  for (const code of Array.from(body.querySelectorAll<HTMLElement>('pre > code.mermaid'))) liveMermaids.delete(code);
  for (const card of Array.from(body.querySelectorAll<HTMLElement>(`.${LIVE_CARD}`))) {
    const pre = card.nextElementSibling;
    const img = card.querySelector<HTMLImageElement>(`:scope > .${CARD}-preview > img[src]`);
    if (pre instanceof HTMLElement && pre.tagName === 'PRE' && img) liveFrames.set(pre, img);
    card.remove();
  }
}
