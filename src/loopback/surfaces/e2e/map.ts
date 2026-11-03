// Spec 355 — the e2e system map. Pure: a run's checks become pins on the
// case's map, the reach rule decides which nodes are grey, and the map turns
// into mermaid source. Every mermaid id is generated here (`n0…`, `g0…`,
// `p0…`) and every project string goes through `mermaidText()`, so nothing a
// project writes can change the diagram's syntax. Same input, same string.

export interface E2eMapGroup {
  readonly id: string;
  readonly label: string;
}

export interface E2eMapNode {
  readonly id: string;
  readonly label: string;
  readonly group: string | null;
  /** box | gate | store | actor */
  readonly shape: string;
  readonly source: string | null;
}

export interface E2eMapEdge {
  readonly from: string;
  readonly to: string;
  readonly label: string | null;
  /** flow | reply | refused */
  readonly kind: string;
}

export interface E2eMap {
  /** LR | TB */
  readonly direction: string;
  readonly groups: readonly E2eMapGroup[];
  readonly nodes: readonly E2eMapNode[];
  readonly edges: readonly E2eMapEdge[];
}

/** One `status.maps` entry, keyed by the case's map path. */
export interface E2eMapEntry {
  readonly map: E2eMap | null;
  readonly errors: readonly string[];
  readonly warnings: readonly string[];
}

export interface MapCheck {
  readonly group?: string;
  readonly label: string;
  readonly status: string;
  readonly detail?: string;
  readonly at?: unknown;
}

/** Worst first: a pin takes the first tone any of its checks has. */
export type PinTone = 'fail' | 'blocked' | 'pass' | 'skip' | 'info';
const TONES: readonly PinTone[] = ['fail', 'blocked', 'pass', 'skip', 'info'];

export type StatusCounts = Record<PinTone, number>;

export interface MapPin {
  /** `P1`… in order of first appearance among the checks. */
  readonly key: string;
  readonly at: string;
  readonly group: string;
  readonly counts: StatusCounts;
  readonly tone: PinTone;
  /** Indexes into the Result's `checks`. */
  readonly checks: readonly number[];
  /** The newest earlier PASS's counts for this group, when its tone differs. */
  readonly before: { readonly runId: string; readonly counts: StatusCounts } | null;
}

export interface Unplaced {
  readonly index: number;
  /** null: the check has no `at`; otherwise why its `at` is not on the map. */
  readonly reason: string | null;
}

export interface PassRun {
  readonly runId: string;
  readonly checks: readonly MapCheck[];
}

export interface PinColours {
  readonly pass: string;
  readonly fail: string;
  readonly blocked: string;
  readonly muted: string;
}

/** More pins than this is a banner and the check list, not a picture. */
export const MAX_PINS = 120;

/** Used when a page token does not resolve to a colour. */
export const DEFAULT_PIN_COLOURS: PinColours = {
  pass: '#0ecb81',
  fail: '#f6465d',
  blocked: '#fcd535',
  muted: '#848e9c',
};

const SYMBOL: Record<PinTone, string> = { pass: '✓', fail: '✗', blocked: '⊘', skip: '–', info: 'i' };
const COUNT_ORDER: readonly PinTone[] = ['pass', 'fail', 'blocked', 'skip', 'info'];

const ZERO: Readonly<StatusCounts> = { fail: 0, blocked: 0, pass: 0, skip: 0, info: 0 };

/** A status Krypton does not know counts as info, as in `#e2e status`. */
function toneOfStatus(status: string): PinTone {
  return (TONES as readonly string[]).includes(status) ? (status as PinTone) : 'info';
}

export function toneOf(counts: StatusCounts): PinTone {
  return TONES.find((tone) => counts[tone] > 0) ?? 'info';
}

/** `✓×2 ✗×1`: pass, fail, blocked, skip, info; zero counts dropped. */
export function countsText(counts: StatusCounts): string {
  return COUNT_ORDER.filter((tone) => counts[tone] > 0)
    .map((tone) => `${SYMBOL[tone]}×${counts[tone]}`)
    .join(' ');
}

function groupCounts(checks: readonly MapCheck[]): Map<string, StatusCounts> {
  const out = new Map<string, StatusCounts>();
  for (const check of checks) {
    const name = check.group ?? '';
    const counts = out.get(name) ?? { ...ZERO };
    counts[toneOfStatus(check.status)] += 1;
    out.set(name, counts);
  }
  return out;
}

/** One pin per `(at, group)`; checks without a usable `at` are unplaced. */
export function buildPins(
  checks: readonly MapCheck[],
  map: E2eMap,
  before: PassRun | null,
): { pins: MapPin[]; unplaced: Unplaced[] } {
  const nodes = new Set(map.nodes.map((n) => n.id));
  const byKey = new Map<string, { at: string; group: string; counts: StatusCounts; checks: number[] }>();
  const unplaced: Unplaced[] = [];
  checks.forEach((check, index) => {
    const at = check.at;
    if (typeof at !== 'string' || at === '') {
      unplaced.push({ index, reason: null });
      return;
    }
    if (!nodes.has(at)) {
      unplaced.push({ index, reason: `"${at}" is not a node of the map` });
      return;
    }
    const group = check.group ?? '';
    const key = `${at}\u0000${group}`;
    const pin = byKey.get(key) ?? { at, group, counts: { ...ZERO }, checks: [] };
    pin.counts[toneOfStatus(check.status)] += 1;
    pin.checks.push(index);
    byKey.set(key, pin);
  });
  const earlier = before ? groupCounts(before.checks) : null;
  const pins = [...byKey.values()].map((pin, i): MapPin => {
    const tone = toneOf(pin.counts);
    const prev = earlier?.get(pin.group);
    return {
      key: `P${i + 1}`,
      at: pin.at,
      group: pin.group,
      counts: pin.counts,
      tone,
      checks: pin.checks,
      before: before && prev && toneOf(prev) !== tone ? { runId: before.runId, counts: prev } : null,
    };
  });
  return { pins, unplaced };
}

/**
 * Lit nodes: actors, pinned nodes, and every node on a directed path from an
 * actor to a pinned node over `flow` edges. `reply` and `refused` edges are
 * drawn but never followed, so a response leading back to a pinned node does
 * not light the node it leaves. Every other node is idle (grey).
 */
export function litNodes(map: E2eMap, pins: readonly MapPin[]): ReadonlySet<string> {
  const flow = map.edges.filter((e) => e.kind === 'flow');
  const actors = map.nodes.filter((n) => n.shape === 'actor').map((n) => n.id);
  const pinned = new Set(pins.map((p) => p.at));
  const reach = (start: Iterable<string>, step: (edge: E2eMapEdge) => [string, string]): Set<string> => {
    const seen = new Set(start);
    const queue = [...seen];
    while (queue.length) {
      const id = queue.shift() as string;
      for (const edge of flow) {
        const [from, to] = step(edge);
        if (from === id && !seen.has(to)) {
          seen.add(to);
          queue.push(to);
        }
      }
    }
    return seen;
  };
  const forward = reach(actors, (e) => [e.from, e.to]);
  const backward = reach(pinned, (e) => [e.to, e.from]);
  const lit = new Set<string>([...actors, ...pinned]);
  for (const id of forward) if (backward.has(id)) lit.add(id);
  return lit;
}

/** A project string as mermaid label text: `#` first, so the codes it adds stay intact. */
export function mermaidText(text: string): string {
  return text
    .replace(/\r/g, '')
    .replace(/#/g, '#35;')
    .replace(/"/g, '#quot;')
    .replace(/</g, '#lt;')
    .replace(/>/g, '#gt;')
    .replace(/`/g, '#96;')
    .replace(/\n/g, '<br/>');
}

/** A canvas-serialized colour (`#rrggbb` or `rgba(r, g, b, a)`) as `#rrggbb`; `classDef` splits on commas. */
export function hexColour(serialized: string): string | null {
  const value = serialized.trim().toLowerCase();
  if (/^#[0-9a-f]{6}$/.test(value)) return value;
  const rgb = /^rgba?\(\s*(\d{1,3})\s*,\s*(\d{1,3})\s*,\s*(\d{1,3})\s*(?:,\s*[\d.]+\s*)?\)$/.exec(value);
  if (!rgb) return null;
  const parts = rgb.slice(1, 4).map(Number);
  if (parts.some((n) => n > 255)) return null;
  return `#${parts.map((n) => n.toString(16).padStart(2, '0')).join('')}`;
}

function shaped(shape: string, text: string): string {
  const label = `"${text}"`;
  switch (shape) {
    case 'gate':
      return `{{${label}}}`;
    case 'store':
      return `[(${label})]`;
    case 'actor':
      return `(${label})`;
    default:
      return `[${label}]`;
  }
}

function pinLabel(pin: MapPin): string {
  const head = pin.group ? `${pin.key} · ${mermaidText(pin.group)}` : pin.key;
  const lines = [head, countsText(pin.counts)];
  if (pin.before) lines.push(`PASS ${mermaidText(pin.before.runId)}: ${countsText(pin.before.counts)}`);
  return lines.join('<br/>');
}

/** The mermaid flowchart for one run on its case's map. */
export function mapSource(
  map: E2eMap,
  pins: readonly MapPin[],
  lit: ReadonlySet<string>,
  colours: PinColours,
): string {
  const nodeId = new Map(map.nodes.map((n, i) => [n.id, `n${i}`]));
  const declaration = new Map(map.nodes.map((n, i) => [n.id, `n${i}${shaped(n.shape, mermaidText(n.label))}`]));
  const lines = [`flowchart ${map.direction === 'TB' ? 'TB' : 'LR'}`];
  map.groups.forEach((group, i) => {
    const members = map.nodes.filter((n) => n.group === group.id);
    if (!members.length) return;
    lines.push(`  subgraph g${i}["${mermaidText(group.label)}"]`);
    for (const node of members) lines.push(`    ${declaration.get(node.id)}`);
    lines.push('  end');
  });
  const grouped = new Set(map.groups.map((g) => g.id));
  for (const node of map.nodes) {
    if (node.group === null || !grouped.has(node.group)) lines.push(`  ${declaration.get(node.id)}`);
  }
  for (const edge of map.edges) {
    const from = nodeId.get(edge.from);
    const to = nodeId.get(edge.to);
    if (!from || !to) continue;
    const arrow = edge.kind === 'refused' ? '--x' : '-->';
    const label = edge.label ? `|"${mermaidText(edge.label)}"|` : '';
    lines.push(`  ${from} ${arrow}${label} ${to}`);
  }
  pins.forEach((pin, i) => {
    lines.push(`  p${i}(["${pinLabel(pin)}"])`);
    lines.push(`  p${i} -.-> ${nodeId.get(pin.at)}`);
  });
  lines.push(
    `  classDef pass stroke:${colours.pass},stroke-width:2px`,
    `  classDef fail stroke:${colours.fail},stroke-width:3px`,
    `  classDef blocked stroke:${colours.blocked},stroke-width:2px`,
    `  classDef skip stroke:${colours.muted},stroke-dasharray:4 3`,
    `  classDef info stroke:${colours.muted},stroke-dasharray:4 3`,
    `  classDef idle stroke:${colours.muted},stroke-dasharray:4 3,color:${colours.muted}`,
  );
  for (const tone of TONES) {
    const ids = pins.flatMap((pin, i) => (pin.tone === tone ? [`p${i}`] : []));
    if (ids.length) lines.push(`  class ${ids.join(',')} ${tone}`);
  }
  const idle = map.nodes.filter((n) => !lit.has(n.id)).map((n) => nodeId.get(n.id));
  if (idle.length) lines.push(`  class ${idle.join(',')} idle`);
  return `${lines.join('\n')}\n`;
}
