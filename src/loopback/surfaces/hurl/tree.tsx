// Spec 227 — the file roster: listing → visible rows (collapsed-by-default
// folders, flat list while filtering) and the session's run history.
// Spec 361: a row renders as JSX inside the kit `RosterList`.

import type { JSX } from 'react';

export interface HurlFile {
  readonly path: string;
  readonly rel_path?: string;
  readonly name: string;
}

export interface RunRecord {
  readonly path: string;
  readonly exit: number;
  readonly ms: number;
}

export interface TreeRow {
  readonly key: string;
  readonly kind: 'dir' | 'file' | 'run';
  /** Folder path for dirs, listing rel path for files, absolute path for runs. */
  readonly rel: string;
  readonly path: string;
  readonly name: string;
  readonly depth: number;
  readonly open: boolean;
  /** Last exit code of this file in this session, if it ran. */
  readonly exit: number | null;
  readonly ms: number;
}

interface Node {
  readonly children: Map<string, Node>;
  readonly files: HurlFile[];
}

export function fileRows(
  files: readonly HurlFile[],
  query: string,
  expanded: ReadonlySet<string>,
  runs: readonly RunRecord[],
): TreeRow[] {
  const q = query.trim().toLowerCase();
  const visible = files.filter((f) => !q || (f.rel_path ?? '').toLowerCase().includes(q));
  const lastExit = (path: string): number | null => runs.find((r) => r.path === path)?.exit ?? null;
  const fileRow = (f: HurlFile, depth: number): TreeRow => ({
    key: `f:${f.path}`,
    kind: 'file',
    rel: f.rel_path ?? f.path,
    path: f.path,
    name: f.name,
    depth,
    open: false,
    exit: lastExit(f.path),
    ms: 0,
  });
  if (q) return visible.map((f) => fileRow(f, 0));

  const root: Node = { children: new Map(), files: [] };
  for (const f of visible) {
    const segs = (f.rel_path || f.name).split('/');
    let node = root;
    for (const seg of segs.slice(0, -1)) {
      let child = node.children.get(seg);
      if (!child) {
        child = { children: new Map(), files: [] };
        node.children.set(seg, child);
      }
      node = child;
    }
    node.files.push(f);
  }
  const rows: TreeRow[] = [];
  const walk = (node: Node, rel: string, depth: number): void => {
    for (const name of [...node.children.keys()].sort()) {
      const childRel = rel ? `${rel}/${name}` : name;
      const open = expanded.has(childRel);
      rows.push({ key: `d:${childRel}`, kind: 'dir', rel: childRel, path: '', name, depth, open, exit: null, ms: 0 });
      if (open) walk(node.children.get(name) as Node, childRel, depth + 1);
    }
    for (const f of [...node.files].sort((a, b) => a.name.localeCompare(b.name))) rows.push(fileRow(f, depth));
  };
  walk(root, '', 0);
  return rows;
}

export function runRows(runs: readonly RunRecord[]): TreeRow[] {
  return runs.map((r, i) => ({
    key: `r:${i}`,
    kind: 'run',
    rel: r.path,
    path: r.path,
    name: r.path,
    depth: 0,
    open: false,
    exit: r.exit,
    ms: r.ms,
  }));
}

export function rowKey(row: TreeRow): string {
  return row.key;
}

/** What `renderRow` reads; the roster repaints a row only when these move. */
export function rowDeps(row: TreeRow): readonly unknown[] {
  return [row.name, row.depth, row.open, row.exit, row.ms];
}

export function renderRow(row: TreeRow): JSX.Element {
  const tone = row.exit === null ? '' : row.exit === 0 ? ' lb-hurl__mark--ok' : ' lb-hurl__mark--bad';
  return (
    <span
      className="lb-hurl__row"
      style={{ paddingLeft: `${row.depth * 14}px` }}
      aria-expanded={row.kind === 'dir' ? row.open : undefined}
    >
      {row.kind === 'dir' ? (
        <span className="lb-hurl__chev">{row.open ? '▾' : '▸'}</span>
      ) : (
        <span className={`lb-hurl__mark${tone}`} aria-hidden="true" />
      )}
      <span className={row.kind === 'dir' ? 'lb-hurl__name lb-hurl__name--dir' : 'lb-hurl__name'}>{row.name}</span>
      {row.kind === 'run' ? <span className="lb-hurl__meta">{`${row.ms}ms`}</span> : null}
    </span>
  );
}
