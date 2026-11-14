// Spec 0355 / 400 — a system map laid out the way valence draws a run on its
// map; the e2e explorer and the bug trail both draw with it (kit/sysmap). This is a line-for-line port of valence's
// internal/report/maplayout.go (`Layout`) plus pinKeyCell from
// internal/web/components/sysmap.go; layout.test.ts deep-equals goldens the Go
// original produced, so keep every arithmetic step in Go's order.
//
// Layout draws a system map as a layered flowchart, the way mermaid draws
// Krypton's map: nodes in ranks along the map's direction (LR: columns, TB:
// rows), each group as one box, and each node's pins hung beside it (LR:
// below it, TB: right of it). It is deterministic: the same map and pins give
// the same drawing.
//
// The steps:
//  1. Ranks: cycles are broken by a depth-first walk (flow edges first), then
//     each node sits one rank after its furthest predecessor.
//  2. Order: barycenter sweeps order the nodes of each rank.
//  3. Items: a group with its members, or one node outside any group, is an
//     item. Items are stacked across the ranks they span (so group boxes never
//     overlap and no loose node falls inside a box), then nudged towards the
//     nodes they connect to, keeping their order. Inside a group, the members
//     of each rank slide the same way within the box.
//  4. Edges: one rank apart, an S-curve; further, an S-curve when nothing is in
//     the way, else a path through the nearest free corridor; backwards (a
//     reply closing a loop), a path around the nodes it spans.
//
// Text is measured as monospace (the drawing uses var(--mono)), so a label
// never overflows its box.
//
// Differences from the Go structs: every DrawnEdge carries its `from`/`to`
// node ids, every DrawnGroup its `id` and every DrawnPin the node it hangs on
// (`at`). A pin's texts are its key, its label (Go's check group, whose part
// "group" is "label" here) and its `problems` (Go's ProblemsText of its
// counts, handed in as text); its title is the caller's.

/**
 * A system map (spec 0355's map file, parsed). The e2e page's `E2eMap` has
 * this shape; it is declared here so the kit depends on no surface.
 */
export interface SystemMap {
  /** LR | TB */
  readonly direction: string;
  readonly groups: readonly { readonly id: string; readonly label: string }[];
  readonly nodes: readonly {
    readonly id: string;
    readonly label: string;
    readonly group: string | null;
    /** box | gate | store | actor */
    readonly shape: string;
    readonly source: string | null;
  }[];
  readonly edges: readonly {
    readonly from: string;
    readonly to: string;
    readonly label: string | null;
    /** flow | reply | refused */
    readonly kind: string;
  }[];
}

export interface Box {
  readonly x: number;
  readonly y: number;
  readonly w: number;
  readonly h: number;
}

/** One line of text centred at x, its middle at y. */
export interface TextLine {
  readonly x: number;
  readonly y: number;
  readonly text: string;
}

export interface DrawnGroup {
  readonly id: string;
  readonly box: Box;
  /** Left-aligned at x. */
  readonly label: TextLine;
  readonly title: string;
}

export interface DrawnNode {
  readonly id: string;
  readonly shape: string;
  readonly lit: boolean;
  readonly box: Box;
  /** The outline. */
  readonly d: string;
  /** A store: the front edge of the top; '' for other shapes. */
  readonly rim: string;
  readonly lines: readonly TextLine[];
  readonly title: string;
}

export interface DrawnEdge {
  readonly from: string;
  readonly to: string;
  readonly kind: string;
  /** An end of the edge is idle. */
  readonly idle: boolean;
  readonly d: string;
  readonly label: readonly TextLine[];
  readonly labelBox: Box | null;
}

/** One of a pin's texts, starting at x, its middle at y. */
export interface PinText {
  readonly x: number;
  readonly y: number;
  readonly text: string;
  /** 'key' | 'label' */
  readonly part: string;
}

/**
 * A label in a stadium: its key in a tinted cell at the left end, then its
 * label.
 */
export interface DrawnPin {
  readonly key: string;
  readonly at: string;
  readonly status: string;
  /** A stadium: corner radius h/2. */
  readonly box: Box;
  /** The key's cell, from the stadium's left end; box.w when the pin shows only its key. */
  readonly keyW: number;
  readonly texts: readonly PinText[];
  readonly title: string;
}

/** A laid-out map in pixels, origin at the top left. */
export interface MapDrawing {
  readonly width: number;
  readonly height: number;
  readonly groups: readonly DrawnGroup[];
  readonly edges: readonly DrawnEdge[];
  /** Dotted paths joining a node to its pins. */
  readonly stems: readonly string[];
  readonly nodes: readonly DrawnNode[];
  readonly pins: readonly DrawnPin[];
}

/** One pin hung on node `at`: a key cell (e.g. "4" or "?7") then `label` (e.g. "root cause"), truncated like the Go group text. */
export interface LayoutPin {
  readonly key: string;
  readonly at: string;
  readonly label: string;
  /** Go's `ProblemsText(counts)`, e.g. `1 failed, 2 blocked`; absent or empty for none. */
  readonly problems?: string;
  readonly status: string;
  readonly title: string;
}

// Sizes in pixels. Character advances are 0.6em of a monospace font.
const NODE_CHAR_W = 7.8; // 13px
const NODE_LINE_H = 17.0;
const NODE_PAD_X = 12.0;
const NODE_PAD_Y = 9.0;
const NODE_MIN_W = 72.0;
const STORE_RY = 6.0;
const SMALL_CHAR_W = 7.2; // 12px: pins, edge and group labels
const SMALL_LINE_H = 15.0;
const PIN_PAD_X = 9.0;
const PIN_PAD_Y = 3.5; // a pin is 22px high, as tall as a pill
const PIN_KEY_PAD = 6.0; // between a pin's key and the end of its cell, and from there to the label
const PIN_PART_GAP = 9.0; // between a pin's label and its problem count
const PIN_GAP = 7.0; // between a node and its pins, and between pins
const PIN_SIDE_GAP = 16.0; // TB: between a node and its pin column
const PIN_LABEL_MAX = 28; // runes of a label shown on a pin
const LABEL_PAD_X = 5.0;
const LABEL_PAD_Y = 2.0;
const CHANNEL_GAP = 14.0; // between the nodes and an edge routed around them
const CHANNEL_STEP = 8.0; // between two edges routed on the same side
// RANK_GAP is the gap between ranks: room for a back edge's channel on each
// side. Edge labels and group padding widen it.
const RANK_GAP = 2 * CHANNEL_GAP + CHANNEL_STEP;
const ITEM_GAP = 18.0; // between items in one rank
const GROUP_PAD = 12.0;
const GROUP_HEAD = 26.0; // the band that holds a group's label
const GROUP_LABEL_X = 10.0;
const CORNER_R = 8.0;
const REFUSED_GAP = 7.0; // a refused edge's cross stops this short of the node
const DRAW_MARGIN = 12.0;

interface Point {
  main: number;
  cross: number;
}

/** An edge's geometry: a cubic Bézier (4 points) or a polyline with rounded corners. */
interface Path {
  readonly bezier: boolean;
  readonly pts: readonly Point[];
}

type XY = readonly [number, number];

interface Span {
  lo: number;
  hi: number;
}

interface Item {
  /** Index in map.groups; -1 for a loose node. */
  readonly group: number;
  readonly members: number[];
  lo: number;
  hi: number;
  /** Across. */
  size: number;
  start: number;
  score: number;
  first: number;
  // A group's members of rank lo+i, ordered, form stacks[i]: it sits at
  // stackOff[i] across the box, between the label band and the far padding.
  stacks: number[][];
  stackSize: number[];
  stackOff: number[];
  head: number;
  content: number;
}

function pt(main: number, cross: number): Point {
  return { main, cross };
}

function zeros(n: number): number[] {
  return new Array<number>(n).fill(0);
}

function lists(n: number): number[][] {
  return Array.from({ length: n }, (): number[] => []);
}

/** Go's cmp.Compare for floats: NaN sorts before every number. */
function compare(a: number, b: number): number {
  const an = Number.isNaN(a);
  const bn = Number.isNaN(b);
  if (an || bn) return an && bn ? 0 : an ? -1 : 1;
  return a < b ? -1 : a > b ? 1 : 0;
}

/** Go's math.Round: half away from zero (Math.round rounds half up). */
function goRound(x: number): number {
  return x < 0 ? -Math.round(-x) : Math.round(x);
}

/**
 * Go's math.Hypot (the amd64 routine and the portable one agree):
 * max·√(1 + (min/max)²).
 */
function hypot(x: number, y: number): number {
  let p = Math.abs(x);
  let q = Math.abs(y);
  if (p === Infinity || q === Infinity) return Infinity;
  if (Number.isNaN(p) || Number.isNaN(q)) return NaN;
  if (p < q) [p, q] = [q, p];
  if (p === 0) return 0;
  q = q / p;
  return p * Math.sqrt(1 + q * q);
}

const ZERO_WIDTH = /[\p{Mn}\p{Me}\p{Cf}]/u;
const WIDE_SCRIPT = /[\p{Script=Han}\p{Script=Hangul}\p{Script=Hiragana}\p{Script=Katakana}]/u;

/**
 * Counts the monospace cells of s: wide scripts take two, combining marks
 * none.
 */
export function cells(s: string): number {
  let n = 0;
  for (const ch of s) {
    const r = ch.codePointAt(0) ?? 0;
    if (ZERO_WIDTH.test(ch)) continue;
    if (
      WIDE_SCRIPT.test(ch) ||
      (r >= 0xff00 && r <= 0xff60) ||
      (r >= 0xffe0 && r <= 0xffe6) ||
      (r >= 0x1f300 && r <= 0x1faff)
    ) {
      n += 2;
    } else {
      n++;
    }
  }
  return n;
}

function textWidth(lines: readonly string[], charW: number): number {
  let w = 0;
  for (const line of lines) w = Math.max(w, cells(line));
  return w * charW;
}

/** Keeps at most n runes of s, ending in "…" when cut. */
function truncate(s: string, n: number): string {
  const r = [...s];
  if (r.length <= n) return s;
  return r.slice(0, n - 1).join('') + '…';
}

interface PinShape {
  readonly texts: readonly PinText[];
  readonly keyW: number;
  readonly w: number;
}

/**
 * Lays out a pin's texts from its left end: its key, then its label
 * (shortened). It returns the texts, the key cell's width and the pin's width;
 * a pin with no label is its key alone, its cell the whole pin.
 */
function pinGeometry(p: LayoutPin): PinShape {
  const width = (s: string): number => textWidth([s], SMALL_CHAR_W);
  const label = truncate(p.label, PIN_LABEL_MAX);
  const problems = p.problems ?? '';
  const texts: PinText[] = [{ x: PIN_PAD_X, y: 0, text: p.key, part: 'key' }];
  let at = PIN_PAD_X + width(p.key);
  if (label === '' && problems === '') {
    const w = at + PIN_PAD_X;
    return { texts, keyW: w, w };
  }
  const keyW = at + PIN_KEY_PAD;
  at = keyW + PIN_KEY_PAD;
  if (label !== '') {
    texts.push({ x: at, y: 0, text: label, part: 'label' });
    at += width(label);
    if (problems !== '') at += PIN_PART_GAP;
  }
  if (problems !== '') {
    texts.push({ x: at, y: 0, text: problems, part: 'problems' });
    at += width(problems);
  }
  return { texts, keyW, w: at + PIN_PAD_X };
}

function labelLines(s: string): string[] {
  return s.replaceAll('\r', '').split('\n');
}

function textLines(lines: readonly string[], x: number, top: number, lineH: number): TextLine[] {
  return lines.map((line, i) => ({ x, y: top + lineH * (i + 0.5), text: line }));
}

/** A drawing coordinate with at most one decimal, as Go's FormatFloat(round(v·10)/10, 'f', -1). */
function num(v: number): string {
  const r = goRound(v * 10) / 10;
  if (Object.is(r, -0)) return '-0';
  if (r === Infinity) return '+Inf';
  if (r === -Infinity) return '-Inf';
  return String(r);
}

function xyStr(p: XY): string {
  return num(p[0]) + ' ' + num(p[1]);
}

function roundedRect(b: Box, radius: number): string {
  const r = Math.min(radius, b.h / 2, b.w / 2);
  return (
    'M' + xyStr([b.x + r, b.y]) + ' H' + num(b.x + b.w - r) +
    ' Q' + xyStr([b.x + b.w, b.y]) + ' ' + xyStr([b.x + b.w, b.y + r]) +
    ' V' + num(b.y + b.h - r) +
    ' Q' + xyStr([b.x + b.w, b.y + b.h]) + ' ' + xyStr([b.x + b.w - r, b.y + b.h]) +
    ' H' + num(b.x + r) +
    ' Q' + xyStr([b.x, b.y + b.h]) + ' ' + xyStr([b.x, b.y + b.h - r]) +
    ' V' + num(b.y + r) +
    ' Q' + xyStr([b.x, b.y]) + ' ' + xyStr([b.x + r, b.y]) + ' Z'
  );
}

/** Draws a polyline with rounded corners; repeated points are dropped. */
function roundedPath(pts: readonly XY[]): string {
  const clean: XY[] = [];
  for (const p of pts) {
    const n = clean.length;
    if (n > 0 && Math.abs(clean[n - 1][0] - p[0]) < 0.5 && Math.abs(clean[n - 1][1] - p[1]) < 0.5) continue;
    clean.push(p);
  }
  let b = 'M' + xyStr(clean[0]);
  for (let i = 1; i < clean.length - 1; i++) {
    const prev = clean[i - 1];
    const at = clean[i];
    const next = clean[i + 1];
    const into = dist(prev, at);
    const out = dist(at, next);
    const r = Math.min(CORNER_R, into / 2, out / 2);
    const p1 = toward(at, prev, r);
    const p2 = toward(at, next, r);
    b += ' L' + xyStr(p1) + ' Q' + xyStr(at) + ' ' + xyStr(p2);
  }
  b += ' L' + xyStr(clean[clean.length - 1]);
  return b;
}

function dist(a: XY, b: XY): number {
  return hypot(b[0] - a[0], b[1] - a[1]);
}

/** The point r from a in the direction of b. */
function toward(a: XY, b: XY, r: number): XY {
  const d = dist(a, b);
  if (d === 0) return a;
  return [a[0] + (b[0] - a[0]) * r / d, a[1] + (b[1] - a[1]) * r / d];
}

/**
 * The point of cubic Bézier pts whose main coordinate is main (the curves
 * here only move forwards along the map).
 */
function bezierAt(pts: readonly Point[], main: number): Point {
  const at = (t: number): Point => {
    const a = (1 - t) * (1 - t) * (1 - t);
    const b = 3 * (1 - t) * (1 - t) * t;
    const c = 3 * (1 - t) * t * t;
    const d = t * t * t;
    return pt(
      a * pts[0].main + b * pts[1].main + c * pts[2].main + d * pts[3].main,
      a * pts[0].cross + b * pts[1].cross + c * pts[2].cross + d * pts[3].cross,
    );
  };
  let lo = 0.0;
  let hi = 1.0;
  for (let k = 0; k < 40; k++) {
    const mid = (lo + hi) / 2;
    if (at(mid).main < main) lo = mid;
    else hi = mid;
  }
  return at((lo + hi) / 2);
}

function overlaps(a: Item, b: Item): boolean {
  return a.lo <= b.hi && b.lo <= a.hi;
}

class Layout {
  private readonly tb: boolean;
  private readonly idx = new Map<string, number>();
  private readonly kindOrder = new Map<string, number>([
    ['flow', 0],
    ['refused', 1],
    ['reply', 2],
  ]);

  private rank: number[] = [];
  private ranks = 0;
  /** back[i]: edge i is drawn backwards (it closes a cycle). */
  private back: boolean[] = [];
  /** Depth-first preorder. */
  private readonly order: number[] = [];
  private pos: number[] = [];
  /** Nodes per rank, ordered. */
  private layer: number[][] = [];

  // Sizes along the main axis (the direction of the map) and across it.
  private nodeW: number[] = []; // physical
  private nodeH: number[] = [];
  private nodeMain: number[] = [];
  private nodeCross: number[] = [];
  private blockMain: number[] = [];
  private blockCross: number[] = [];
  private nodeOffMain: number[] = []; // node within its block
  private nodePins: number[][] = []; // pin indexes per node
  private pinW: number[] = [];
  private pinH: number[] = [];
  private pinOffMain: number[] = []; // pin within its block
  private pinOffCross: number[] = [];
  private itemOf: number[] = []; // node → item
  private crossOff: number[] = [];
  private items: Item[] = [];
  private colPos: number[] = [];
  private colSize: number[] = [];
  private gapAfter: number[] = [];
  private padAfter: number[] = []; // group padding in the gap after rank r
  private padBefore: number[] = []; // group padding in the gap before rank r
  private groupLabelW: number[] = [];
  private nodeMainStart: number[] = [];
  private nodeCrossStart: number[] = [];
  private channelsUsedLow = 0;
  private channelsUsedHigh = 0;

  constructor(
    private readonly m: SystemMap,
    private readonly pins: readonly LayoutPin[],
    private readonly lit: ReadonlySet<string>,
  ) {
    this.tb = m.direction === 'TB';
    m.nodes.forEach((n, i) => this.idx.set(n.id, i));
  }

  /** The index of node id; 0 for an unknown id, as Go's map lookup gives. */
  private node(id: string): number {
    return this.idx.get(id) ?? 0;
  }

  run(): MapDrawing {
    if (this.m.nodes.length === 0) {
      return { width: 2 * DRAW_MARGIN, height: 2 * DRAW_MARGIN, groups: [], edges: [], stems: [], nodes: [], pins: [] };
    }
    this.assignRanks();
    this.orderRanks();
    this.measure();
    this.buildItems();
    this.placeMain();
    this.placeCross();
    return this.draw();
  }

  // --- 1. ranks -------------------------------------------------------------

  private assignRanks(): void {
    const n = this.m.nodes.length;
    const edges = this.m.edges;
    this.back = new Array<boolean>(edges.length).fill(false);
    const kind = (i: number): number => this.kindOrder.get(edges[i].kind) ?? 0;
    const out = lists(n);
    const indeg = zeros(n);
    edges.forEach((e, i) => {
      if (e.from !== e.to) {
        out[this.node(e.from)].push(i);
        indeg[this.node(e.to)]++;
      }
    });
    for (const list of out) list.sort((a, b) => compare(kind(a), kind(b)));
    const state = zeros(n); // 0 unseen, 1 on the stack, 2 done
    const finish: number[] = [];
    const visit = (v: number): void => {
      state[v] = 1;
      this.order.push(v);
      for (const ei of out[v]) {
        const w = this.node(edges[ei].to);
        switch (state[w]) {
          case 0:
            visit(w);
            break;
          case 1:
            this.back[ei] = true;
            break;
        }
      }
      state[v] = 2;
      finish.push(v);
    };
    for (let v = 0; v < n; v++) {
      if (indeg[v] === 0 && state[v] === 0) visit(v);
    }
    for (let v = 0; v < n; v++) {
      if (state[v] === 0) visit(v);
    }

    // Longest path over the edges with cycles broken; reverse finish order is
    // a topological order of that graph.
    const { succ, pred } = this.dag();
    this.rank = zeros(n);
    for (let i = finish.length - 1; i >= 0; i--) {
      const v = finish[i];
      for (const w of succ[v]) this.rank[w] = Math.max(this.rank[w], this.rank[v] + 1);
    }
    // A source sits just before its nearest successor, not at the far left.
    for (let v = 0; v < n; v++) {
      if (pred[v].length === 0 && succ[v].length > 0) {
        let nearest = Infinity;
        for (const w of succ[v]) nearest = Math.min(nearest, this.rank[w]);
        this.rank[v] = Math.max(this.rank[v], nearest - 1);
      }
    }
    const low = Math.min(...this.rank);
    for (let v = 0; v < n; v++) this.rank[v] -= low;
    this.ranks = Math.max(...this.rank) + 1;
  }

  /** Each node's successors and predecessors with back edges reversed. */
  private dag(): { succ: number[][]; pred: number[][] } {
    const n = this.m.nodes.length;
    const succ = lists(n);
    const pred = lists(n);
    this.m.edges.forEach((e, i) => {
      if (e.from === e.to) return;
      let a = this.node(e.from);
      let b = this.node(e.to);
      if (this.back[i]) [a, b] = [b, a];
      succ[a].push(b);
      pred[b].push(a);
    });
    return { succ, pred };
  }

  // --- 2. order within ranks ------------------------------------------------

  private orderRanks(): void {
    this.layer = lists(this.ranks);
    for (const v of this.order) this.layer[this.rank[v]].push(v);
    this.pos = zeros(this.m.nodes.length);
    const setPos = (r: number): void => {
      this.layer[r].forEach((v, i) => {
        this.pos[v] = i;
      });
    };
    for (let r = 0; r < this.ranks; r++) setPos(r);
    const { succ, pred } = this.dag();
    const sweep = (r: number, neighbours: number[][]): void => {
      const bary = new Map<number, number>();
      for (const v of this.layer[r]) {
        bary.set(v, this.pos[v]);
        if (neighbours[v].length > 0) {
          let sum = 0.0;
          for (const u of neighbours[v]) sum += this.pos[u];
          bary.set(v, sum / neighbours[v].length);
        }
      }
      this.layer[r].sort((a, b) => compare(bary.get(a) ?? 0, bary.get(b) ?? 0));
      setPos(r);
    };
    for (let k = 0; k < 2; k++) {
      for (let r = 1; r < this.ranks; r++) sweep(r, pred);
      for (let r = this.ranks - 2; r >= 0; r--) sweep(r, succ);
    }
    for (let r = 1; r < this.ranks; r++) sweep(r, pred);
  }

  // --- 3. sizes and items ---------------------------------------------------

  /** Maps a physical width and height to (along the map, across it). */
  private axes(w: number, h: number): [number, number] {
    return this.tb ? [h, w] : [w, h];
  }

  private measure(): void {
    const n = this.m.nodes.length;
    const np = this.pins.length;
    this.nodeW = zeros(n);
    this.nodeH = zeros(n);
    this.nodeMain = zeros(n);
    this.nodeCross = zeros(n);
    this.blockMain = zeros(n);
    this.blockCross = zeros(n);
    this.nodeOffMain = zeros(n);
    this.nodePins = lists(n);
    this.pins.forEach((p, i) => this.nodePins[this.node(p.at)].push(i));
    this.pinW = zeros(np);
    this.pinH = zeros(np);
    this.pinOffMain = zeros(np);
    this.pinOffCross = zeros(np);
    this.pins.forEach((p, i) => {
      this.pinW[i] = pinGeometry(p).w;
      this.pinH[i] = SMALL_LINE_H + 2 * PIN_PAD_Y;
    });
    this.m.nodes.forEach((node, v) => {
      const lines = labelLines(node.label);
      let w = Math.max(NODE_MIN_W, textWidth(lines, NODE_CHAR_W) + 2 * NODE_PAD_X);
      let h = lines.length * NODE_LINE_H + 2 * NODE_PAD_Y;
      switch (node.shape) {
        case 'gate':
          w += h / 2;
          break;
        case 'store':
          h += 3 * STORE_RY;
          break;
      }
      this.nodeW[v] = w;
      this.nodeH[v] = h;
      [this.nodeMain[v], this.nodeCross[v]] = this.axes(w, h);

      const pins = this.nodePins[v];
      if (this.tb) {
        // Pins stand in a column right of the node, centred on it.
        let stack = 0.0;
        let widest = 0.0;
        pins.forEach((i, k) => {
          if (k > 0) stack += PIN_GAP;
          stack += this.pinH[i];
          widest = Math.max(widest, this.pinW[i]);
        });
        this.blockMain[v] = Math.max(h, stack);
        this.blockCross[v] = w;
        if (pins.length > 0) this.blockCross[v] += PIN_SIDE_GAP + widest;
        this.nodeOffMain[v] = (this.blockMain[v] - h) / 2;
        let at = (this.blockMain[v] - stack) / 2;
        for (const i of pins) {
          this.pinOffMain[i] = at;
          this.pinOffCross[i] = w + PIN_SIDE_GAP;
          at += this.pinH[i] + PIN_GAP;
        }
      } else {
        // Pins hang below the node, centred under it.
        let widest = w;
        let at = h;
        for (const i of pins) widest = Math.max(widest, this.pinW[i]);
        this.blockMain[v] = widest;
        this.nodeOffMain[v] = (widest - w) / 2;
        for (const i of pins) {
          at += PIN_GAP;
          this.pinOffMain[i] = (widest - this.pinW[i]) / 2;
          this.pinOffCross[i] = at;
          at += this.pinH[i];
        }
        this.blockCross[v] = at;
      }
    });
  }

  private buildItems(): void {
    const n = this.m.nodes.length;
    this.itemOf = zeros(n);
    this.crossOff = zeros(n);
    const frac = (v: number): number => (this.pos[v] + 0.5) / this.layer[this.rank[v]].length;
    const newItem = (group: number, lo: number, hi: number): Item => ({
      group,
      members: [],
      lo,
      hi,
      size: 0,
      start: 0,
      score: 0,
      first: 0,
      stacks: [],
      stackSize: [],
      stackOff: [],
      head: 0,
      content: 0,
    });
    const groupItem = new Map<string, Item>();
    this.groupLabelW = zeros(this.m.groups.length);
    this.m.groups.forEach((g, gi) => {
      this.groupLabelW[gi] = textWidth(labelLines(g.label), SMALL_CHAR_W) + 2 * GROUP_LABEL_X;
      groupItem.set(g.id, newItem(gi, Infinity, -1));
    });
    const loose: Item[] = [];
    this.m.nodes.forEach((node, v) => {
      const it = groupItem.get(node.group ?? '');
      if (it === undefined) {
        const one = newItem(-1, this.rank[v], this.rank[v]);
        one.members.push(v);
        one.first = v;
        loose.push(one);
        return;
      }
      if (it.members.length === 0) it.first = v;
      it.members.push(v);
      it.lo = Math.min(it.lo, this.rank[v]);
      it.hi = Math.max(it.hi, this.rank[v]);
    });
    for (const g of this.m.groups) {
      const it = groupItem.get(g.id);
      if (it !== undefined && it.members.length > 0) this.items.push(it);
    }
    this.items.push(...loose);
    for (const it of this.items) {
      let sum = 0.0;
      for (const v of it.members) sum += frac(v);
      it.score = sum / it.members.length;
    }
    this.items.sort((a, b) => compare(a.score, b.score) || compare(a.first, b.first));
    this.items.forEach((it, k) => {
      for (const v of it.members) this.itemOf[v] = k;
      if (it.group < 0) {
        it.size = this.blockCross[it.members[0]];
        return;
      }
      // Members of one rank stack across the box, centred in it at first.
      const count = it.hi - it.lo + 1;
      it.stacks = lists(count);
      it.stackSize = zeros(count);
      it.stackOff = zeros(count);
      for (const v of it.members) it.stacks[this.rank[v] - it.lo].push(v);
      it.stacks.forEach((vs, i) => {
        vs.sort((a, b) => compare(this.pos[a], this.pos[b]));
        vs.forEach((v, j) => {
          if (j > 0) it.stackSize[i] += ITEM_GAP;
          it.stackSize[i] += this.blockCross[v];
        });
        it.content = Math.max(it.content, it.stackSize[i]);
      });
      it.head = GROUP_HEAD;
      const tail = GROUP_PAD;
      if (this.tb) {
        it.head = GROUP_PAD;
        it.content = Math.max(it.content, this.groupLabelW[it.group] - 2 * GROUP_PAD);
      }
      it.size = it.head + it.content + tail;
      for (let i = 0; i < it.stacks.length; i++) {
        this.setStack(it, i, it.head + (it.content - it.stackSize[i]) / 2);
      }
    });
  }

  /** Moves stack i of a group to off across its box. */
  private setStack(it: Item, i: number, off: number): void {
    it.stackOff[i] = off;
    for (const v of it.stacks[i]) {
      this.crossOff[v] = off;
      off += this.blockCross[v] + ITEM_GAP;
    }
  }

  /**
   * Slides each rank of a group's members within the box towards the nodes
   * they connect to, so a chain inside a group runs straight.
   */
  private nudgeStacks(it: Item): void {
    it.stacks.forEach((vs, i) => {
      if (vs.length === 0) return;
      let sum = 0.0;
      let count = 0;
      for (const e of this.m.edges) {
        const u = this.node(e.from);
        const w = this.node(e.to);
        const inU = vs.includes(u);
        const inW = vs.includes(w);
        if (inU && !inW) {
          sum += this.nodeCenter(w) - this.nodeCenter(u);
          count++;
        } else if (inW && !inU) {
          sum += this.nodeCenter(u) - this.nodeCenter(w);
          count++;
        }
      }
      if (count > 0) {
        const low = it.head;
        const high = it.head + it.content - it.stackSize[i];
        this.setStack(it, i, Math.min(Math.max(it.stackOff[i] + sum / count, low), high));
      }
    });
  }

  // --- 4. positions ---------------------------------------------------------

  /** The space a group box takes before and after its ranks. */
  private groupPads(): [number, number] {
    return this.tb ? [GROUP_HEAD, GROUP_PAD] : [GROUP_PAD, GROUP_PAD];
  }

  private placeMain(): void {
    this.colSize = zeros(this.ranks);
    this.m.nodes.forEach((_, v) => {
      this.colSize[this.rank[v]] = Math.max(this.colSize[this.rank[v]], this.blockMain[v]);
    });
    // Each gap fits the labels of the edges that leave the rank before it.
    const labels = zeros(this.ranks);
    this.m.edges.forEach((e, i) => {
      const label = e.label ?? '';
      if (label === '' || e.from === e.to || this.back[i]) return;
      const lines = labelLines(label);
      const w = textWidth(lines, SMALL_CHAR_W) + 2 * LABEL_PAD_X;
      const h = lines.length * SMALL_LINE_H + 2 * LABEL_PAD_Y;
      const [along] = this.axes(w, h);
      const r = this.rank[this.node(e.from)];
      // Room for the label in the middle, and on both sides for an edge
      // routed backwards past the ranks (see draw): the rank gap's channels.
      labels[r] = Math.max(labels[r], along + RANK_GAP);
    });
    // A gap holds a group's padding only where a group ends before it or
    // starts after it, so the arrows between two ranks of one group stay short.
    const [before, after] = this.groupPads();
    this.padAfter = zeros(this.ranks);
    this.padBefore = zeros(this.ranks);
    for (const it of this.items) {
      if (it.group >= 0) {
        this.padAfter[it.hi] = after;
        this.padBefore[it.lo] = before;
      }
    }
    this.gapAfter = zeros(this.ranks);
    for (let r = 0; r < this.ranks; r++) {
      this.gapAfter[r] = Math.max(RANK_GAP, labels[r]) + this.padAfter[r];
      if (r + 1 < this.ranks) this.gapAfter[r] += this.padBefore[r + 1];
    }
    this.colPos = zeros(this.ranks);
    const position = (): void => {
      let at = 0.0;
      for (let r = 0; r < this.ranks; r++) {
        this.colPos[r] = at;
        at += this.colSize[r] + this.gapAfter[r];
      }
    };
    position();
    if (this.tb) return;
    // LR: a group box is as wide as its ranks; widen its last rank to fit its label.
    for (let k = 0; k < 2; k++) {
      for (const it of this.items) {
        if (it.group < 0) continue;
        const span = this.colPos[it.hi] + this.colSize[it.hi] - this.colPos[it.lo] + 2 * GROUP_PAD;
        const short = this.groupLabelW[it.group] - span;
        if (short > 0) {
          this.colSize[it.hi] += short;
          position();
        }
      }
    }
  }

  /** The middle of node v across the map. */
  private nodeCenter(v: number): number {
    return this.items[this.itemOf[v]].start + this.crossOff[v] + this.nodeCross[v] / 2;
  }

  private placeCross(): void {
    // Stack items in order over the ranks each one spans.
    const sky = zeros(this.ranks);
    const used = new Array<boolean>(this.ranks).fill(false);
    for (const it of this.items) {
      let start = 0.0;
      for (let r = it.lo; r <= it.hi; r++) {
        if (used[r]) start = Math.max(start, sky[r] + ITEM_GAP);
      }
      it.start = start;
      for (let r = it.lo; r <= it.hi; r++) {
        sky[r] = start + it.size;
        used[r] = true;
      }
    }
    // Nudge each item towards the nodes it connects to, keeping the order of
    // items that share a rank.
    for (let pass = 0; pass < 8; pass++) {
      for (let j = 0; j < this.items.length; j++) {
        const k = pass % 2 === 1 ? this.items.length - 1 - j : j;
        this.nudge(k);
        if (this.items[k].group >= 0) this.nudgeStacks(this.items[k]);
      }
    }
    const n = this.m.nodes.length;
    this.nodeMainStart = zeros(n);
    this.nodeCrossStart = zeros(n);
    for (let v = 0; v < n; v++) {
      const r = this.rank[v];
      this.nodeMainStart[v] = this.colPos[r] + (this.colSize[r] - this.blockMain[v]) / 2 + this.nodeOffMain[v];
      this.nodeCrossStart[v] = this.items[this.itemOf[v]].start + this.crossOff[v];
    }
  }

  private nudge(k: number): void {
    const it = this.items[k];
    let sum = 0.0;
    let count = 0;
    for (const e of this.m.edges) {
      const u = this.node(e.from);
      const w = this.node(e.to);
      if (this.itemOf[u] === this.itemOf[w]) {
        // inside one item: nudgeStacks moves it
      } else if (this.itemOf[u] === k) {
        sum += this.nodeCenter(w) - this.nodeCenter(u);
        count++;
      } else if (this.itemOf[w] === k) {
        sum += this.nodeCenter(u) - this.nodeCenter(w);
        count++;
      }
    }
    if (count === 0) return;
    let lower = -Infinity;
    let upper = Infinity;
    this.items.forEach((other, j) => {
      if (j === k || !overlaps(it, other)) return;
      if (j < k) lower = Math.max(lower, other.start + other.size + ITEM_GAP);
      else upper = Math.min(upper, other.start - ITEM_GAP - it.size);
    });
    if (lower <= upper) it.start = Math.min(Math.max(it.start + sum / count, lower), upper);
  }

  // --- 5. drawing -----------------------------------------------------------

  // rankBefore and rankAfter are the middles of the gaps around rank r.
  private rankBefore(r: number): number {
    if (r === 0) {
      const [before] = this.groupPads();
      return this.colPos[0] - before - 2 * CHANNEL_GAP;
    }
    return this.colPos[r] - this.gapAfter[r - 1] / 2;
  }

  private rankAfter(r: number): number {
    if (r === this.ranks - 1) {
      const [, after] = this.groupPads();
      return this.colPos[r] + this.colSize[r] + after + 2 * CHANNEL_GAP;
    }
    return this.colPos[r] + this.colSize[r] + this.gapAfter[r] / 2;
  }

  /**
   * Lists what lies across ranks lo..hi (exclusive), merged: node blocks, and
   * the boxes of groups other than those of the skip nodes.
   */
  private occupied(lo: number, hi: number, skip: readonly number[]): Span[] {
    const out: Span[] = [];
    this.m.nodes.forEach((_, v) => {
      const r = this.rank[v];
      if (r > lo && r < hi) {
        const s = this.nodeCrossStart[v];
        out.push({ lo: s, hi: s + this.blockCross[v] });
      }
    });
    this.items.forEach((it, k) => {
      if (it.group < 0 || it.hi <= lo || it.lo >= hi || skip.some((v) => this.itemOf[v] === k)) return;
      out.push({ lo: it.start, hi: it.start + it.size });
    });
    out.sort((a, b) => compare(a.lo, b.lo));
    const merged: Span[] = [];
    for (const s of out) {
      const n = merged.length;
      if (n > 0 && s.lo <= merged[n - 1].hi) merged[n - 1].hi = Math.max(merged[n - 1].hi, s.hi);
      else merged.push({ lo: s.lo, hi: s.hi });
    }
    return merged;
  }

  /**
   * Picks the line an edge takes around ranks lo..hi: just before (above,
   * left of) or after everything in them, whichever is nearer want. Each
   * further edge on a side runs a little further out.
   */
  private aroundChannel(lo: number, hi: number, want: number): number {
    const spans = this.occupied(lo - 1, hi + 1, []);
    if (spans.length === 0) return want;
    const low = spans[0].lo - CHANNEL_GAP;
    const high = spans[spans.length - 1].hi + CHANNEL_GAP;
    if (want - low < high - want) {
      this.channelsUsedLow++;
      return low - (this.channelsUsedLow - 1) * CHANNEL_STEP;
    }
    this.channelsUsedHigh++;
    return high + (this.channelsUsedHigh - 1) * CHANNEL_STEP;
  }

  /** Finds a free line across ranks lo..hi (exclusive) nearest want; null when there is none. */
  private corridor(lo: number, hi: number, want: number, skip: readonly number[]): number | null {
    const spans = this.occupied(lo, hi, skip);
    const free = (c: number): boolean => {
      for (const s of spans) {
        if (c > s.lo - 6 && c < s.hi + 6) return false;
      }
      return true;
    };
    if (free(want)) return want;
    let best = 0.0;
    let found = false;
    const tryLine = (c: number): void => {
      if (free(c) && (!found || Math.abs(c - want) < Math.abs(best - want))) {
        best = c;
        found = true;
      }
    };
    spans.forEach((s, i) => {
      tryLine(s.lo - CHANNEL_GAP);
      tryLine(s.hi + CHANNEL_GAP);
      if (i + 1 < spans.length) tryLine((s.hi + spans[i + 1].lo) / 2);
    });
    return found ? best : null;
  }

  /**
   * Reports whether a straight run from c0 (rank lo) to c1 (rank hi) crosses
   * nothing in the ranks between.
   */
  private clearLine(lo: number, hi: number, c0: number, c1: number, skip: readonly number[]): boolean {
    const m0 = this.colPos[lo] + this.colSize[lo];
    const m1 = this.colPos[hi];
    const spans = new Map<number, Span[]>();
    const add = (r: number, s: Span): void => {
      const list = spans.get(r);
      if (list === undefined) spans.set(r, [s]);
      else list.push(s);
    };
    this.m.nodes.forEach((_, v) => {
      const r = this.rank[v];
      if (r > lo && r < hi) {
        const s = this.nodeCrossStart[v];
        add(r, { lo: s, hi: s + this.blockCross[v] });
      }
    });
    this.items.forEach((it, k) => {
      if (it.group < 0 || skip.some((v) => this.itemOf[v] === k)) return;
      for (let r = Math.max(it.lo, lo + 1); r <= Math.min(it.hi, hi - 1); r++) {
        add(r, { lo: it.start, hi: it.start + it.size });
      }
    });
    const at = (m: number): number => c0 + (c1 - c0) * (m - m0) / (m1 - m0);
    for (let r = lo + 1; r < hi; r++) {
      const a = at(this.colPos[r]);
      const b = at(this.colPos[r] + this.colSize[r]);
      const low = Math.min(a, b) - 6;
      const high = Math.max(a, b) + 6;
      for (const s of spans.get(r) ?? []) {
        if (low < s.hi && s.lo < high) return false;
      }
    }
    return true;
  }

  /**
   * Where an edge meets node v along the map: its far side for an edge
   * leaving, its near side for one arriving. A gate's pointed sides (LR) move
   * the point inward off the middle.
   */
  private portMain(v: number, out: boolean, across: number): number {
    const start = this.nodeMainStart[v];
    const along = this.nodeMain[v];
    switch (this.m.nodes[v].shape) {
      case 'gate':
        if (!this.tb) {
          const half = this.nodeCross[v] / 2;
          const inset = this.nodeH[v] / 4 * Math.min(1, Math.abs(across - (this.nodeCrossStart[v] + half)) / half);
          return out ? start + along - inset : start + inset;
        }
        break;
      case 'store':
        if (this.tb) {
          // The top and bottom are half ellipses.
          const half = this.nodeW[v] / 2;
          const off = Math.min(1, Math.abs(across - (this.nodeCrossStart[v] + half)) / half);
          const bulge = STORE_RY * Math.sqrt(1 - off * off);
          return out ? start + along - STORE_RY + bulge : start + STORE_RY - bulge;
        }
        break;
    }
    return out ? start + along : start;
  }

  private draw(): MapDrawing {
    const edges = this.m.edges;
    // How each edge runs: straight to its far end, or along a line across the
    // map (a corridor between nodes, or a channel around them).
    interface Route {
      path: Path;
      /** Channel or corridor across the map; NaN when direct. */
      around: number;
    }
    const routes: Route[] = edges.map(() => ({ path: { bezier: false, pts: [] }, around: NaN }));
    // One side of a node: where its edges leave (out) or arrive.
    interface Port {
      readonly node: number;
      readonly out: boolean;
      readonly list: number[];
    }
    const ends = new Map<string, Port>();
    const addEnd = (node: number, out: boolean, i: number): void => {
      const key = `${node}:${out ? 1 : 0}`;
      const port = ends.get(key);
      if (port === undefined) ends.set(key, { node, out, list: [i] });
      else port.list.push(i);
    };
    edges.forEach((e, i) => {
      const u = this.node(e.from);
      const w = this.node(e.to);
      routes[i].around = NaN;
      if (u === w) return;
      const ru = this.rank[u];
      const rw = this.rank[w];
      const mid = (this.nodeCenter(u) + this.nodeCenter(w)) / 2;
      if (this.back[i] || rw <= ru) {
        routes[i].around = this.aroundChannel(Math.min(ru, rw), Math.max(ru, rw), mid);
      } else if (rw > ru + 1) {
        const c0 = this.nodeCenter(u);
        const c1 = this.nodeCenter(w);
        if (!this.clearLine(ru, rw, c0, c1, [u, w])) {
          const c = this.corridor(ru, rw, mid, [u, w]);
          if (c !== null) routes[i].around = c;
        }
      }
      addEnd(u, true, i);
      addEnd(w, false, i);
    });
    // (edge, 0 out | 1 in) → across
    const ports = new Map<string, number>();
    const portOf = (i: number, side: number): number => ports.get(`${i}:${side}`) ?? 0;
    for (const { node: v, out, list } of ends.values()) {
      const far = (i: number): number => {
        if (!Number.isNaN(routes[i].around)) return routes[i].around;
        if (out) return this.nodeCenter(this.node(edges[i].to));
        return this.nodeCenter(this.node(edges[i].from));
      };
      list.sort((a, b) => compare(far(a), far(b)) || compare(a, b));
      list.forEach((i, k) => {
        const at = this.nodeCrossStart[v] + this.nodeCross[v] * (0.2 + 0.6 * (k + 1) / (list.length + 1));
        ports.set(`${i}:${out ? 0 : 1}`, at);
      });
    }

    // Edges.
    interface Labelled {
      readonly at: Point;
      readonly lines: readonly string[];
    }
    const labels: (Labelled | null)[] = edges.map(() => null);
    edges.forEach((e, i) => {
      const u = this.node(e.from);
      const w = this.node(e.to);
      let p: Path;
      let labelAt: Point;
      if (u === w) {
        const me = this.nodeMainStart[u] + this.nodeMain[u];
        const c0 = this.nodeCrossStart[u] + this.nodeCross[u] * 0.3;
        const c1 = this.nodeCrossStart[u] + this.nodeCross[u] * 0.7;
        p = { bezier: true, pts: [pt(me, c0), pt(me + 30, c0 - 10), pt(me + 30, c1 + 10), pt(me, c1)] };
        labelAt = pt(me + 30, (c0 + c1) / 2);
      } else {
        const start = pt(this.portMain(u, true, portOf(i, 0)), portOf(i, 0));
        const end = pt(this.portMain(w, false, portOf(i, 1)), portOf(i, 1));
        if (e.kind === 'refused') end.main -= REFUSED_GAP; // the cross stands in front of the node, whole
        const c = routes[i].around;
        if (!Number.isNaN(c)) {
          let a = this.rankAfter(this.rank[u]);
          let b = this.rankBefore(this.rank[w]);
          if (this.rank[w] <= this.rank[u]) {
            // Backwards: turn close to the ranks, leaving the middle of the
            // gaps to the labels of forward edges.
            a = this.colPos[this.rank[u]] + this.colSize[this.rank[u]] + this.padAfter[this.rank[u]] + CHANNEL_GAP;
            b = this.colPos[this.rank[w]] - this.padBefore[this.rank[w]] - CHANNEL_GAP;
          }
          p = { bezier: false, pts: [start, pt(a, start.cross), pt(a, c), pt(b, c), pt(b, end.cross), end] };
          if (b < a) {
            // Backwards: the label rides the channel, clear of every node.
            labelAt = pt((a + b) / 2, c);
          } else {
            // Forwards: the label sits in the gap after the source, sized for it.
            labelAt = pt(a, (start.cross + c) / 2);
          }
        } else {
          const k = (end.main - start.main) / 2;
          p = { bezier: true, pts: [start, pt(start.main + k, start.cross), pt(end.main - k, end.cross), end] };
          labelAt = bezierAt(p.pts, Math.min(this.rankAfter(this.rank[u]), (start.main + end.main) / 2));
        }
      }
      routes[i].path = p;
      const label = e.label ?? '';
      if (label !== '') labels[i] = { at: labelAt, lines: labelLines(label) };
    });

    // Everything in physical coordinates, then shifted into view.
    const xy = (p: Point): XY => (this.tb ? [p.cross, p.main] : [p.main, p.cross]);
    const box = (main: number, cross: number, along: number, across: number): Box => {
      const [x, y] = xy(pt(main, cross));
      return this.tb ? { x, y, w: across, h: along } : { x, y, w: along, h: across };
    };
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    const grow = (b: Box): void => {
      minX = Math.min(minX, b.x);
      minY = Math.min(minY, b.y);
      maxX = Math.max(maxX, b.x + b.w);
      maxY = Math.max(maxY, b.y + b.h);
    };

    const [before, after] = this.groupPads();
    const groupBoxes: { readonly box: Box; readonly gi: number }[] = [];
    for (const it of this.items) {
      if (it.group < 0) continue;
      const mainStart = this.colPos[it.lo] - before;
      const along = this.colPos[it.hi] + this.colSize[it.hi] - this.colPos[it.lo] + before + after;
      const b = box(mainStart, it.start, along, it.size);
      groupBoxes.push({ box: b, gi: it.group });
      grow(b);
    }
    const nodeBoxes: Box[] = this.m.nodes.map((_, v) => {
      const [x, y] = xy(pt(this.nodeMainStart[v], this.nodeCrossStart[v]));
      const b = { x, y, w: this.nodeW[v], h: this.nodeH[v] };
      grow(b);
      return b;
    });
    const pinBoxes: Box[] = this.pins.map((p, i) => {
      const v = this.node(p.at);
      const r = this.rank[v];
      const blockMain = this.colPos[r] + (this.colSize[r] - this.blockMain[v]) / 2;
      const [x, y] = xy(pt(blockMain + this.pinOffMain[i], this.nodeCrossStart[v] + this.pinOffCross[i]));
      const b = { x, y, w: this.pinW[i], h: this.pinH[i] };
      grow(b);
      return b;
    });
    const edgePts: XY[][] = routes.map((route) =>
      route.path.pts.map((p) => {
        const [x, y] = xy(p);
        grow({ x, y, w: 0, h: 0 });
        return [x, y] as const;
      }),
    );
    const labelBoxes: (Box | null)[] = labels.map((lb) => {
      if (lb === null) return null;
      const [x, y] = xy(lb.at);
      const w = textWidth(lb.lines, SMALL_CHAR_W) + 2 * LABEL_PAD_X;
      const h = lb.lines.length * SMALL_LINE_H + 2 * LABEL_PAD_Y;
      const b = { x: x - w / 2, y: y - h / 2, w, h };
      grow(b);
      return b;
    });

    const dx = DRAW_MARGIN - minX;
    const dy = DRAW_MARGIN - minY;
    const shift = (b: Box): Box => ({ x: b.x + dx, y: b.y + dy, w: b.w, h: b.h });

    const groups: DrawnGroup[] = groupBoxes.map((g) => {
      const b = shift(g.box);
      const group = this.m.groups[g.gi];
      const label = labelLines(group.label).join(' ');
      return {
        id: group.id,
        box: b,
        label: { x: b.x + GROUP_LABEL_X, y: b.y + GROUP_HEAD / 2, text: label },
        title: group.label,
      };
    });
    const drawnEdges: DrawnEdge[] = edges.map((e, i) => {
      const pts: XY[] = edgePts[i].map(([x, y]) => [x + dx, y + dy]);
      const d = routes[i].path.bezier
        ? 'M' + xyStr(pts[0]) + ' C' + xyStr(pts[1]) + ' ' + xyStr(pts[2]) + ' ' + xyStr(pts[3])
        : roundedPath(pts);
      const lb = labelBoxes[i];
      const lines = labels[i];
      let label: TextLine[] = [];
      let labelBox: Box | null = null;
      if (lb !== null && lines !== null) {
        labelBox = shift(lb);
        label = textLines(lines.lines, labelBox.x + labelBox.w / 2, labelBox.y + LABEL_PAD_Y, SMALL_LINE_H);
      }
      return {
        from: e.from,
        to: e.to,
        kind: e.kind,
        idle: !this.lit.has(e.from) || !this.lit.has(e.to),
        d,
        label,
        labelBox,
      };
    });
    const nodes: DrawnNode[] = this.m.nodes.map((node, v) => {
      const b = shift(nodeBoxes[v]);
      let d: string;
      let rim = '';
      let textTop = b.y + NODE_PAD_Y;
      let textH = b.h - 2 * NODE_PAD_Y;
      switch (node.shape) {
        case 'gate': {
          const t = b.h / 4;
          d =
            'M' + xyStr([b.x + t, b.y]) + ' H' + num(b.x + b.w - t) + ' L' + xyStr([b.x + b.w, b.y + b.h / 2]) +
            ' L' + xyStr([b.x + b.w - t, b.y + b.h]) + ' H' + num(b.x + t) + ' L' + xyStr([b.x, b.y + b.h / 2]) + ' Z';
          break;
        }
        case 'store': {
          const rx = b.w / 2;
          const ry = STORE_RY;
          const arc = ' A' + num(rx) + ' ' + num(ry) + ' 0 0 ';
          d =
            'M' + xyStr([b.x, b.y + ry]) + arc + '1 ' + xyStr([b.x + b.w, b.y + ry]) +
            ' V' + num(b.y + b.h - ry) + arc + '1 ' + xyStr([b.x, b.y + b.h - ry]) + ' Z';
          rim = 'M' + xyStr([b.x, b.y + ry]) + arc + '0 ' + xyStr([b.x + b.w, b.y + ry]);
          textTop = b.y + 2 * ry + NODE_PAD_Y;
          textH = b.h - 3 * ry - 2 * NODE_PAD_Y;
          break;
        }
        case 'actor':
          d = roundedRect(b, 10);
          break;
        default:
          d = roundedRect(b, 3);
      }
      const lines = labelLines(node.label);
      const top = textTop + (textH - lines.length * NODE_LINE_H) / 2;
      let title = lines.join(' ');
      const source = node.source ?? '';
      if (source !== '') title += '\n' + source;
      return {
        id: node.id,
        shape: node.shape,
        lit: this.lit.has(node.id),
        box: b,
        d,
        rim,
        lines: textLines(lines, b.x + b.w / 2, top, NODE_LINE_H),
        title,
      };
    });
    const pins: DrawnPin[] = this.pins.map((p, i) => {
      const b = shift(pinBoxes[i]);
      const { texts, keyW } = pinGeometry(p);
      return {
        key: p.key,
        at: p.at,
        status: p.status,
        box: b,
        keyW,
        texts: texts.map((t) => ({ x: t.x + b.x, y: b.y + b.h / 2, text: t.text, part: t.part })),
        title: p.title,
      };
    });
    // Stems: a dotted line from each pinned node through its pins.
    const stems: string[] = [];
    this.m.nodes.forEach((_, v) => {
      const pinsOf = this.nodePins[v];
      if (pinsOf.length === 0) return;
      const n = shift(nodeBoxes[v]);
      const first = shift(pinBoxes[pinsOf[0]]);
      const last = shift(pinBoxes[pinsOf[pinsOf.length - 1]]);
      if (this.tb) {
        const cy = n.y + n.h / 2;
        const px = first.x + first.w / 2;
        stems.push(
          'M' + xyStr([n.x + n.w, cy]) + ' H' + num(px) +
          ' M' + xyStr([px, first.y + first.h / 2]) + ' V' + num(last.y + last.h / 2),
        );
      } else {
        const cx = n.x + n.w / 2;
        stems.push('M' + xyStr([cx, n.y + n.h]) + ' V' + num(last.y));
      }
    });
    return {
      width: maxX - minX + 2 * DRAW_MARGIN,
      height: maxY - minY + 2 * DRAW_MARGIN,
      groups,
      edges: drawnEdges,
      stems,
      nodes,
      pins,
    };
  }
}

/** Lays out map with its pins; lit is the set of lit node ids. */
export function layoutMap(map: SystemMap, pins: readonly LayoutPin[], lit: ReadonlySet<string>): MapDrawing {
  return new Layout(map, pins, lit).run();
}

/**
 * The pin key cell outline, ported from sysmap.templ's pinKeyCell: the left
 * end of the pin's stadium, up to the edge of its key's cell. It sits inside
 * the stadium's ring, so the ring stays whole.
 */
export function pinKeyCellPath(pin: DrawnPin): string {
  const inset = 0.75; // half the widest ring
  const b = pin.box;
  const r = b.h / 2 - inset;
  const left = b.x + inset + r;
  const top = b.y + inset;
  const bottom = b.y + b.h - inset;
  return (
    'M' + num(left) + ' ' + num(top) + 'H' + num(b.x + pin.keyW) + 'V' + num(bottom) + 'H' + num(left) +
    'A' + num(r) + ' ' + num(r) + ' 0 0 1 ' + num(left) + ' ' + num(top) + 'Z'
  );
}
