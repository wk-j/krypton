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

// <img> cannot load web fonts; name installed monospace faces (Krypton's voice).
const SVG_FONT_FAMILY = 'ui-monospace, SFMono-Regular, Menlo, monospace';
const SVG_DATA_URL_PREFIX = 'data:image/svg+xml;charset=utf-8,';
const VAR_RE = /var\(\s*--([\w-]+)\s*(?:,\s*((?:[^()]|\([^()]*\))*))?\)/g;
const ROOT_RE = /<(?:[\w.-]+:)?svg(?=[\s/>])[^>]*>/;

const CARD = 'acp-harness__svg-card';

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

/** Resolve palette var() references and give the root the attributes an
 *  <img>-loaded SVG needs: `xmlns` (without it the image does not render),
 *  `xmlns:xlink` when used, and default `color` / `fill` / `font-family`.
 *  `fill` departs from OMP: SVG's initial fill is black, so unstyled text and
 *  shapes would vanish on a dark theme; inheriting `fg` keeps them legible. */
export function themeSvgSource(source: string, palette: SvgPalette): string {
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
    if (!/\sfont-family\s*=/.test(tag)) extra += ` font-family="${SVG_FONT_FAMILY}"`;
    return extra ? tag.replace(/^<[^\s/>]+/, `$&${extra}`) : tag;
  });
}

function numericAttr(tag: string, name: string): number | null {
  const raw = new RegExp(`\\s${name}\\s*=\\s*["']\\s*([\\d.]+)(?:px)?\\s*["']`).exec(tag)?.[1];
  const n = raw === undefined ? NaN : Number(raw);
  return Number.isFinite(n) && n > 0 ? n : null;
}

export interface SvgFrame {
  /** CSS aspect-ratio value, reserving height before the image decodes. */
  ratio: string | null;
  /** Intrinsic px width when the root declares one; otherwise the card fills the column. */
  width: number | null;
}

/** Size hints from the root tag's viewBox / width / height. */
export function svgFrame(source: string): SvgFrame {
  const tag = ROOT_RE.exec(source)?.[0];
  if (!tag) return { ratio: null, width: null };
  const width = numericAttr(tag, 'width');
  const height = numericAttr(tag, 'height');
  const viewBox = /\sviewBox\s*=\s*["']([^"']*)["']/.exec(tag)?.[1];
  if (viewBox) {
    const parts = viewBox.trim().split(/[\s,]+/).map(Number);
    if (parts.length === 4 && parts[2] > 0 && parts[3] > 0) {
      return { ratio: `${parts[2]} / ${parts[3]}`, width };
    }
  }
  return { ratio: width && height ? `${width} / ${height}` : null, width };
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

function setPreview(img: HTMLImageElement, themed: string): void {
  const frame = svgFrame(themed);
  img.style.aspectRatio = frame.ratio ?? '';
  if (frame.width) img.width = Math.round(frame.width);
  else img.removeAttribute('width');
  img.classList.toggle('acp-harness__svg-card-img--fill', frame.width === null);
  img.src = SVG_DATA_URL_PREFIX + encodeURIComponent(themed);
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
      const themed = themeSvgSource(source, palette);
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
  for (const card of Array.from(cards)) {
    const code = card.querySelector<HTMLElement>(':scope > pre > code');
    const img = card.querySelector<HTMLImageElement>(`:scope > .${CARD}-preview > img`);
    if (code && img) setPreview(img, themeSvgSource(fenceSourceText(code.textContent ?? ''), palette));
  }
}
