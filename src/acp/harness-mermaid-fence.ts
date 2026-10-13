// Krypton — ACP Harness View: ```mermaid fence renderer (spec 294).
//
// Renders mermaid source to an SVG string with the official library, lazily
// loaded. The string only ever reaches the spec 283 card's <img> data URL, so
// the drawn diagram stays inert like an ```svg fence. Renders are async and
// run one at a time (mermaid's config is global state); results are cached by
// theme + source so a row rebuilt from `markdownHtml` paints synchronously.
// Card DOM lives in harness-svg-fence.ts; this module never touches it.

import type mermaidApi from 'mermaid';
import type { MermaidConfig } from 'mermaid';

import type { SvgPalette } from './harness-svg-fence';

/** Fence sources longer than this stay plain code (mermaid's own maxTextSize default). */
export const MERMAID_FENCE_MAX_CHARS = 50_000;

const MERMAID_CACHE_MAX = 64;

/** Lane-policy line (spec 289): tells every lane that ```mermaid renders here. */
export const MERMAID_FENCE_GUIDANCE =
  "```mermaid fenced blocks render inline as themed diagrams; don't set theme or themeCSS in %%{init}%%.";

export type MermaidResult =
  | { ok: true; svg: string; diagramType: string }
  | { ok: false; error: string };

export interface MermaidTheme {
  /** Joins every input that changes the drawn SVG; part of the cache key. */
  key: string;
  config: MermaidConfig;
}

/** Config keys a `%%{init}%%` directive may not override: mermaid's defaults
 *  plus everything that would let an agent re-theme or inject CSS. */
const SECURE_KEYS = [
  'secure', 'securityLevel', 'startOnLoad', 'maxTextSize', 'suppressErrorRendering', 'maxEdges',
  'theme', 'themeVariables', 'themeCSS', 'fontFamily', 'altFontFamily', 'darkMode', 'htmlLabels',
];

/** Mermaid's `base` theme variables from the spec 283 palette. Mermaid derives
 *  shades with khroma, so every value must be a concrete colour. */
export function mermaidThemeVariables(palette: SvgPalette, fontFamily: string): Record<string, string> {
  const fg = palette.fg ?? '#d8e8d8';
  const surface = palette.surface ?? '#10141c';
  const muted = palette.muted ?? fg;
  const border = palette.border ?? muted;
  const accent = palette.accent ?? fg;
  const vars: Record<string, string> = {
    fontFamily,
    background: surface,
    primaryColor: surface,
    primaryTextColor: fg,
    primaryBorderColor: muted,
    secondaryColor: surface,
    secondaryTextColor: fg,
    secondaryBorderColor: muted,
    tertiaryColor: surface,
    tertiaryTextColor: fg,
    tertiaryBorderColor: muted,
    mainBkg: surface,
    nodeBorder: muted,
    nodeTextColor: fg,
    textColor: fg,
    titleColor: accent,
    lineColor: muted,
    clusterBkg: surface,
    clusterBorder: border,
    edgeLabelBackground: surface,
    noteBkgColor: surface,
    noteTextColor: fg,
    noteBorderColor: border,
    actorBkg: surface,
    actorBorder: muted,
    actorTextColor: fg,
    actorLineColor: muted,
    signalColor: fg,
    signalTextColor: fg,
    labelBoxBkgColor: surface,
    labelBoxBorderColor: muted,
    labelTextColor: fg,
    loopTextColor: fg,
    pieTitleTextColor: fg,
    pieLegendTextColor: fg,
    pieSectionTextColor: surface,
    pieStrokeColor: surface,
  };
  const slices = [palette.c1, palette.c2, palette.c3, palette.c4, palette.c5, palette.c6];
  slices.forEach((colour, i) => {
    if (!colour) return;
    vars[`pie${i + 1}`] = colour;
    // Section scale for mindmap / timeline / journey; base derives it from
    // primaryColor, which leaves every branch the colour of the background.
    vars[`cScale${i}`] = colour;
    vars[`cScaleLabel${i}`] = surface;
  });
  return vars;
}

let colourContext: CanvasRenderingContext2D | null | undefined;

/** Any CSS colour → the canvas-serialized form (`#rrggbb` / `rgba(…)`), which
 *  khroma parses. A value the engine rejects is dropped. */
function concreteColour(value: string): string | undefined {
  colourContext ??= document.createElement('canvas').getContext('2d');
  if (!colourContext) return value;
  const sentinel = '#010203';
  colourContext.fillStyle = sentinel;
  colourContext.fillStyle = value;
  const out = String(colourContext.fillStyle);
  return out === sentinel && value.trim().toLowerCase() !== sentinel ? undefined : out;
}

/** The mermaid config for the active Krypton theme. */
export function buildMermaidTheme(palette: SvgPalette, fontFamily: string, darkMode: boolean): MermaidTheme {
  const concrete: SvgPalette = {};
  for (const [name, value] of Object.entries(palette) as [keyof SvgPalette, string][]) {
    const colour = concreteColour(value);
    if (colour) concrete[name] = colour;
  }
  const themeVariables = mermaidThemeVariables(concrete, fontFamily);
  return {
    key: JSON.stringify([darkMode, themeVariables]),
    config: {
      startOnLoad: false,
      securityLevel: 'strict',
      suppressErrorRendering: true,
      htmlLabels: false,
      theme: 'base',
      darkMode,
      fontFamily,
      themeVariables,
      maxTextSize: MERMAID_FENCE_MAX_CHARS,
      secure: SECURE_KEYS,
    },
  };
}

/** `RenderResult.diagramType` → the card label ("flowchart-v2" → "flowchart"). */
export function normalizeDiagramType(raw: string): string {
  return raw.replace(/-v\d+$/, '').replace(/Diagram$/, '') || 'diagram';
}

type MermaidApi = typeof mermaidApi;

let mermaidModule: Promise<MermaidApi> | null = null;
let queue: Promise<unknown> = Promise.resolve();
let initializedKey = '';
let renderSeq = 0;

/** Insertion-ordered: the first key is the least recently used. */
const cache = new Map<string, MermaidResult>();

interface PendingRender {
  promise: Promise<MermaidResult | null>;
  /** One predicate per caller; the render is skipped when none still wants it. */
  wanted: Array<() => boolean>;
}
const pending = new Map<string, PendingRender>();

function remember(key: string, result: MermaidResult): void {
  cache.delete(key);
  cache.set(key, result);
  while (cache.size > MERMAID_CACHE_MAX) {
    const oldest = cache.keys().next().value;
    if (oldest === undefined) break;
    cache.delete(oldest);
  }
}

/** A finished render for this source under this theme, if cached. */
export function cachedMermaid(source: string, theme: MermaidTheme): MermaidResult | undefined {
  const key = `${theme.key}\u0000${source}`;
  const hit = cache.get(key);
  if (hit) remember(key, hit);
  return hit;
}

async function renderNow(source: string, theme: MermaidTheme): Promise<MermaidResult> {
  try {
    mermaidModule ??= import('mermaid').then((mod) => mod.default);
    const mermaid = await mermaidModule;
    if (initializedKey !== theme.key) {
      mermaid.initialize(theme.config);
      initializedKey = theme.key;
    }
    renderSeq += 1;
    const { svg, diagramType } = await mermaid.render(`krypton-mmd-${renderSeq}`, source);
    return { ok: true, svg, diagramType: normalizeDiagramType(diagramType) };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

/** Render (or join the queued render of) `source` under `theme`. Resolves null
 *  when every caller's `wanted` turned false before its turn came — nothing is
 *  cached then, so the next card build queues it again. Errors cache too, so a
 *  broken fence is not re-parsed on every row rebuild. */
export function renderMermaid(
  source: string,
  theme: MermaidTheme,
  wanted: () => boolean = () => true,
): Promise<MermaidResult | null> {
  const key = `${theme.key}\u0000${source}`;
  const hit = cache.get(key);
  if (hit) {
    remember(key, hit);
    return Promise.resolve(hit);
  }
  const joined = pending.get(key);
  if (joined) {
    joined.wanted.push(wanted);
    return joined.promise;
  }
  const entry: PendingRender = { promise: Promise.resolve(null), wanted: [wanted] };
  entry.promise = queue.then(async () => {
    pending.delete(key);
    if (!entry.wanted.some((want) => want())) return null;
    const result = await renderNow(source, theme);
    remember(key, result);
    return result;
  });
  queue = entry.promise.catch(() => undefined);
  pending.set(key, entry);
  return entry.promise;
}

/** Test seam: forget cached results. */
export function clearMermaidCache(): void {
  cache.clear();
}
