// Spec 400 — the bug trail, pure. A frame is the trail up to one step: each
// map node's state, the step numbers pinned on it and the bug path between the
// symptoms and the roots. The drawing itself is the kit's system map (a port
// of valence's map layout, drawn inline); this module decides what it shows:
// one pin per step, the path edges and the node looks.

import type { E2eMap, E2eMapEdge } from '../e2e/map';
import type { LayoutPin, PinLook } from '../../kit';
import type { CheckStatus, TrailPayload, TrailStep } from './types';

/** The state a step kind leaves on its node; `decision` and `plan` leave none. */
export type NodeState = 'symptom' | 'ruled-out' | 'suspect' | 'root-cause';
/** How far a root cause is proven. */
export type RootLevel = 'reproduced' | 'cited' | 'claimed';
export interface Frame {
  /** Index of the last step included; -1 when the trail has no steps. */
  readonly upTo: number;
  /** Node id → its state, map nodes only. */
  readonly states: ReadonlyMap<string, NodeState>;
  /** Root-cause node id → its level. */
  readonly levels: ReadonlyMap<string, RootLevel>;
  /** Node id → its step labels in order (`4`, `?7` for a decision), map nodes only. */
  readonly pins: ReadonlyMap<string, readonly string[]>;
  /** Indexes of included steps whose `at` is not a node of the map. */
  readonly unplaced: readonly number[];
  readonly symptoms: readonly string[];
  /** Root-cause nodes; the suspects stand in while there is none. */
  readonly roots: readonly string[];
  /** True when `roots` are root-cause nodes, false when they are suspects (or none). */
  readonly hasRootCause: boolean;
  readonly anyReproduced: boolean;
  /** Decision steps up to the frame without an answer. */
  readonly openDecisions: number;
}

const CHECKED: ReadonlySet<string> = new Set(['cite', 'commit', 'observed']);
/**
 * A root-cause step's level. `reproduced`: a repro of it ran and ended as
 * expected. `cited`: at least one cite/commit/observed check, all `ok`, and no
 * repro that contradicted it. A repro that has not run yet does not lower it.
 */
export function rootLevel(step: TrailStep): RootLevel {
  if (step.evidence.some((e) => e.type === 'repro' && e.status === 'reproduced')) return 'reproduced';
  const checked = step.evidence.filter((e) => CHECKED.has(e.type));
  const contradicted = step.evidence.some((e) => e.type === 'repro' && e.status === 'unexpected');
  if (checked.length > 0 && checked.every((e) => e.status === 'ok') && !contradicted) return 'cited';
  return 'claimed';
}

function stepLabel(step: TrailStep, index: number): string {
  return step.kind === 'decision' ? `?${index + 1}` : String(index + 1);
}

function unique(ids: readonly string[]): string[] {
  return [...new Set(ids)];
}

/** The trail up to and including step `upTo` (clamped to the steps there are). */
export function frame(payload: TrailPayload, upTo: number): Frame {
  const map = payload.map.map;
  const nodeIds = new Set(map?.nodes.map((n) => n.id) ?? []);
  const last = Math.min(Math.max(upTo, -1), payload.steps.length - 1);
  const included = payload.steps.slice(0, last + 1);
  const states = new Map<string, NodeState>();
  const levels = new Map<string, RootLevel>();
  const pins = new Map<string, string[]>();
  const unplaced: number[] = [];
  let openDecisions = 0;
  included.forEach((step, i) => {
    if (step.kind === 'decision' && !step.answer) openDecisions += 1;
    if (!nodeIds.has(step.at)) {
      if (map) unplaced.push(i);
      return;
    }
    const labels = pins.get(step.at) ?? [];
    labels.push(stepLabel(step, i));
    pins.set(step.at, labels);
    if (step.kind === 'decision' || step.kind === 'plan') return;
    states.set(step.at, step.kind);
    if (step.kind === 'root-cause') levels.set(step.at, rootLevel(step));
    else levels.delete(step.at);
  });
  const ofState = (state: NodeState): string[] => [...states].filter(([, s]) => s === state).map(([id]) => id);
  const rootCauses = ofState('root-cause');
  const hasRootCause = rootCauses.length > 0;
  return {
    upTo: last,
    states,
    levels,
    pins,
    unplaced,
    symptoms: ofState('symptom'),
    roots: unique(hasRootCause ? rootCauses : ofState('suspect')),
    hasRootCause,
    anyReproduced: [...levels.values()].includes('reproduced'),
    openDecisions,
  };
}

function reach(edges: readonly E2eMapEdge[], start: string, step: (edge: E2eMapEdge) => readonly [string, string]): Set<string> {
  const seen = new Set([start]);
  const queue = [start];
  while (queue.length) {
    const id = queue.shift() as string;
    for (const edge of edges) {
      const [from, to] = step(edge);
      if (from === id && !seen.has(to)) {
        seen.add(to);
        queue.push(to);
      }
    }
  }
  return seen;
}

/**
 * The bug path: every node on a `flow` path between a symptom and a root, in
 * either direction — `(fwd(s) ∩ bwd(r)) ∪ (fwd(r) ∩ bwd(s))`. `reply` and
 * `refused` edges are drawn but never followed, as in 0355.
 */
export function bugPath(map: E2eMap, f: Frame): ReadonlySet<string> {
  const flow = map.edges.filter((e) => e.kind === 'flow');
  const fwd = (id: string): Set<string> => reach(flow, id, (e) => [e.from, e.to]);
  const bwd = (id: string): Set<string> => reach(flow, id, (e) => [e.to, e.from]);
  const out = new Set<string>();
  for (const s of f.symptoms) {
    for (const r of f.roots) {
      const between = (a: Set<string>, b: Set<string>): void => {
        for (const id of a) if (b.has(id)) out.add(id);
      };
      between(fwd(s), bwd(r));
      between(fwd(r), bwd(s));
    }
  }
  return out;
}

/** The involved nodes: pinned, on the path, and the actors with a `flow` edge into either. */
export function focus(map: E2eMap, f: Frame, path: ReadonlySet<string>): ReadonlySet<string> {
  const core = new Set<string>([...f.pins.keys(), ...path]);
  const actors = new Set(map.nodes.filter((n) => n.shape === 'actor').map((n) => n.id));
  const out = new Set(core);
  for (const edge of map.edges) {
    if (edge.kind === 'flow' && actors.has(edge.from) && core.has(edge.to)) out.add(edge.from);
  }
  return out;
}

/** A pin's look: its step kind, and for a root cause how far it is proven. */
export type PinStatus =
  | 'symptom'
  | 'ruled-out'
  | 'suspect'
  | 'root-reproduced'
  | 'root-cited'
  | 'root-claimed'
  | 'decision-open'
  | 'decision-answered'
  | 'plan';

const KIND_WORD: Readonly<Record<TrailStep['kind'], string>> = {
  symptom: 'symptom',
  'ruled-out': 'ruled out',
  suspect: 'suspect',
  'root-cause': 'root cause',
  decision: 'decision',
  plan: 'plan',
};

export function pinStatus(step: TrailStep): PinStatus {
  switch (step.kind) {
    case 'root-cause':
      return `root-${rootLevel(step)}`;
    case 'decision':
      return step.answer ? 'decision-answered' : 'decision-open';
    default:
      return step.kind;
  }
}

/**
 * Every step whose `at` is a map node, as a pin on that node in step order:
 * key `4` (`?7` for a decision), label the step kind, title the note.
 */
export function trailPins(payload: TrailPayload): LayoutPin[] {
  const nodes = new Set(payload.map.map?.nodes.map((n) => n.id) ?? []);
  return payload.steps.flatMap((step, i): LayoutPin[] =>
    nodes.has(step.at)
      ? [{ key: stepLabel(step, i), at: step.at, label: KIND_WORD[step.kind], status: pinStatus(step), title: `${stepLabel(step, i)} ${KIND_WORD[step.kind]}: ${step.question ?? step.note}` }]
      : [],
  );
}

/** The map cut down to `keep`: their edges, and the groups that still hold one. */
export function submap(map: E2eMap, keep: ReadonlySet<string>): E2eMap {
  const nodes = map.nodes.filter((n) => keep.has(n.id));
  const groups = new Set(nodes.map((n) => n.group).filter((g): g is string => g !== null));
  return {
    direction: map.direction,
    groups: map.groups.filter((g) => groups.has(g.id)),
    nodes,
    edges: map.edges.filter((e) => keep.has(e.from) && keep.has(e.to)),
  };
}

/** How a pin of each status looks on the map (kit tones). */
export function pinLook(status: string): PinLook {
  switch (status as PinStatus) {
    case 'symptom':
      return { tone: 'accent' };
    case 'ruled-out':
      return { tone: 'muted', dashed: true };
    case 'suspect':
    case 'root-claimed':
      return { tone: 'del', dashed: true };
    case 'root-cited':
      return { tone: 'del', strong: true };
    case 'root-reproduced':
      return { tone: 'del', strong: true, filled: true };
    case 'decision-open':
      return { tone: 'accent', dashed: true };
    case 'decision-answered':
      return { tone: 'muted' };
    default:
      return { tone: 'fg' };
  }
}

/** Whether an edge is drawn as the bug path in this frame. */
export function isPathEdge(edge: { readonly from: string; readonly to: string; readonly kind: string }, f: Frame, path: ReadonlySet<string>): boolean {
  return edge.kind === 'flow' && f.roots.length > 0 && path.has(edge.from) && path.has(edge.to);
}

export type StatusTone = 'accent' | 'add' | 'del' | 'muted';

/** The header pill: how far the investigation has got in this frame. */
export function trailStatus(f: Frame): { readonly label: string; readonly tone: StatusTone } {
  if (f.hasRootCause) {
    if (f.anyReproduced) return { label: 'root cause reproduced', tone: 'del' };
    if ([...f.levels.values()].includes('cited')) return { label: 'root cause cited', tone: 'del' };
    return { label: 'root cause claimed', tone: 'accent' };
  }
  if (f.roots.length > 0) return { label: 'suspect', tone: 'del' };
  return { label: 'investigating', tone: 'accent' };
}

/** `not reproduced on <commit>` while a root cause stands unreproduced; else null. */
export function gapText(payload: TrailPayload, f: Frame): string | null {
  return f.hasRootCause && !f.anyReproduced ? `not reproduced on ${payload.commit}` : null;
}

/** The analysis line: which commit, and whether the code stayed untouched while it ran. */
export function stateLine(payload: TrailPayload): { readonly text: string; readonly warn: boolean } {
  const head = `analysis @ ${payload.commit.slice(0, 8)}`;
  const { start, check } = payload.state;
  if (check && check.changed.length > 0) return { text: `${head} · changed during analysis (${check.changed.length})`, warn: true };
  if (!start) return { text: `${head} · start snapshot missing`, warn: true };
  if (start.dirty.length > 0) return { text: `${head} · tree dirty at start (${start.dirty.length})`, warn: true };
  return { text: `${head} · tree clean at start`, warn: false };
}

/** Status word tone: proven green, failed red, pending accent, unchecked muted. */
export function checkTone(status: CheckStatus): StatusTone {
  switch (status) {
    case 'ok':
    case 'reproduced':
      return 'add';
    case 'mismatch':
    case 'missing':
    case 'unknown':
    case 'unexpected':
      return 'del';
    case 'unavailable':
    case 'stale':
    case 'not-run':
    case 'untrusted':
      return 'accent';
    default:
      return 'muted';
  }
}
