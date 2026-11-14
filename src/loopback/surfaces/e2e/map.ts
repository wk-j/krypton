// Spec 355 — the e2e system map. Pure: a run's checks become pins on the
// case's map, the reach rule decides which nodes are grey, and the pins are
// handed to the kit's system map (valence's layout, drawn as inline SVG from
// React elements) the way valence draws a run: key, check group, failed and
// blocked counts, and the earlier PASS in the pin's title.

import type { LayoutPin, PinLook } from '../../kit';

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

/** More pins than this is a banner and the check list, not a picture. */
export const MAX_PINS = 120;

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

/** valence's words for a count line, in this order; zero counts dropped. */
const COUNT_WORDS: readonly (readonly [PinTone, string])[] = [
  ['pass', 'passed'],
  ['fail', 'failed'],
  ['blocked', 'blocked'],
  ['skip', 'skipped'],
  ['info', 'info'],
];

function countsIn(counts: StatusCounts, tones: readonly PinTone[]): string {
  return COUNT_WORDS.filter(([tone]) => tones.includes(tone) && counts[tone] > 0)
    .map(([tone, word]) => `${counts[tone]} ${word}`)
    .join(', ');
}

/** `2 passed, 1 failed` (valence's CountsWords). */
export function countsWords(counts: StatusCounts): string {
  return countsIn(counts, TONES);
}

/** `1 failed, 2 blocked`, or '' when none failed or blocked (valence's ProblemsText). */
export function problemsText(counts: StatusCounts): string {
  return countsIn(counts, ['fail', 'blocked']);
}

/**
 * The pins as the kit lays them out, as valence draws a run: key, check group
 * and the failed / blocked count on the pin; the full counts and the earlier
 * PASS in its title.
 */
export function layoutPins(pins: readonly MapPin[]): LayoutPin[] {
  return pins.map((pin) => {
    let title = pin.key + (pin.group ? ` ${pin.group}` : '') + `: ${countsWords(pin.counts)}`;
    if (pin.before) title += `\nEarlier PASS ${pin.before.runId}: ${countsWords(pin.before.counts)}`;
    return { key: pin.key, at: pin.at, label: pin.group, problems: problemsText(pin.counts), status: pin.tone, title };
  });
}

/** A pin's look by its worst status: fail red and heavy, blocked accent, pass green, skip / info muted and dashed. */
export function pinLook(tone: string): PinLook {
  switch (tone as PinTone) {
    case 'fail':
      return { tone: 'del', strong: true };
    case 'blocked':
      return { tone: 'accent' };
    case 'pass':
      return { tone: 'add' };
    default:
      return { tone: 'muted', dashed: true };
  }
}
