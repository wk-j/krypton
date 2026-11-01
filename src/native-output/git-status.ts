// Krypton — the `git status` model behind a native output card (spec 352).
//
// Rust re-runs a plain `git status` as `--porcelain=v2 --branch -z` plus two
// `diff --numstat -z` passes (staged, unstaged); this module turns that into
// the branch line and the groups the card paints. Pure: no DOM.

export interface NativeGitStatusRaw {
  readonly status: string;
  readonly staged_numstat: string;
  readonly unstaged_numstat: string;
}

export type StatusGroupKind = 'conflicts' | 'staged' | 'unstaged' | 'untracked' | 'ignored';

export interface StatusEntry {
  /** Porcelain letter for this side: M A D R C T U, `?` untracked, `!` ignored; two letters for a conflict. */
  readonly code: string;
  readonly path: string;
  /** The source path of a rename or copy, else null. */
  readonly oldPath: string | null;
  /** Line counts from numstat; null when binary or unknown (untracked, conflict). */
  readonly added: number | null;
  readonly deleted: number | null;
}

export interface StatusGroup {
  readonly kind: StatusGroupKind;
  readonly entries: readonly StatusEntry[];
}

export interface BranchInfo {
  /** null when HEAD is detached. */
  readonly head: string | null;
  /** null before the first commit. */
  readonly oid: string | null;
  readonly upstream: string | null;
  readonly ahead: number;
  readonly behind: number;
}

export interface NativeGitStatus {
  readonly branch: BranchInfo;
  /** Non-empty groups only, in display order; none means a clean tree. */
  readonly groups: readonly StatusGroup[];
}

const GROUP_ORDER: readonly StatusGroupKind[] = ['conflicts', 'staged', 'unstaged', 'untracked', 'ignored'];

export const STATUS_GROUP_LABEL: Readonly<Record<StatusGroupKind, string>> = {
  conflicts: 'Conflicts',
  staged: 'Staged',
  unstaged: 'Unstaged',
  untracked: 'Untracked',
  ignored: 'Ignored',
};

/** Cheap pre-filter for the re-run IPC; Rust decides what may actually run. */
export function isGitStatusCmdline(cmdline: string): boolean {
  return /^\s*git(\s+--no-pager)?\s+status(\s|$)/.test(cmdline);
}

/** null when the output carries no `# branch.` header (not porcelain v2 with `--branch`). */
export function parseGitStatus(raw: NativeGitStatusRaw): NativeGitStatus | null {
  const fields = raw.status.split('\0');
  let head: string | null = null;
  let oid: string | null = null;
  let upstream: string | null = null;
  let ahead = 0;
  let behind = 0;
  let sawBranch = false;
  const staged = numstat(raw.staged_numstat);
  const unstaged = numstat(raw.unstaged_numstat);
  const groups: Record<StatusGroupKind, StatusEntry[]> = {
    conflicts: [], staged: [], unstaged: [], untracked: [], ignored: [],
  };

  for (let i = 0; i < fields.length; i++) {
    const field = fields[i];
    if (field.startsWith('# branch.')) {
      sawBranch = true;
      const [key, ...rest] = field.slice('# branch.'.length).split(' ');
      const value = rest.join(' ');
      if (key === 'head') head = value === '(detached)' ? null : value;
      else if (key === 'oid') oid = value === '(initial)' ? null : value;
      else if (key === 'upstream') upstream = value;
      else if (key === 'ab') {
        const match = /^\+(\d+) -(\d+)$/.exec(value);
        if (match) {
          ahead = Number(match[1]);
          behind = Number(match[2]);
        }
      }
      continue;
    }
    const parts = field.split(' ');
    const type = parts[0];
    if (type === '1' || type === '2') {
      const xy = parts[1] ?? '..';
      // Type 2 (rename/copy) has one more field, and its source path is the next NUL field.
      const path = parts.slice(type === '1' ? 8 : 9).join(' ');
      const source = type === '2' ? fields[++i] ?? null : null;
      const side = (code: string, counts: Map<string, Counts>): StatusEntry => ({
        code,
        path,
        oldPath: code === 'R' || code === 'C' ? source : null,
        added: counts.get(path)?.added ?? null,
        deleted: counts.get(path)?.deleted ?? null,
      });
      if (xy[0] !== '.') groups.staged.push(side(xy[0], staged));
      if (xy[1] !== '.') groups.unstaged.push(side(xy[1], unstaged));
    } else if (type === 'u') {
      groups.conflicts.push({ code: parts[1] ?? 'UU', path: parts.slice(10).join(' '), oldPath: null, added: null, deleted: null });
    } else if (type === '?' || type === '!') {
      groups[type === '?' ? 'untracked' : 'ignored'].push({ code: type, path: field.slice(2), oldPath: null, added: null, deleted: null });
    }
  }

  if (!sawBranch) return null;
  return {
    branch: { head, oid, upstream, ahead, behind },
    groups: GROUP_ORDER.filter((kind) => groups[kind].length > 0).map((kind) => ({ kind, entries: groups[kind] })),
  };
}

interface Counts {
  added: number | null;
  deleted: number | null;
}

/** `diff --numstat -z`: `A\tD\tpath\0`, or `A\tD\t\0old\0new\0` for a rename; `-` counts mean binary. */
function numstat(text: string): Map<string, Counts> {
  const out = new Map<string, Counts>();
  const fields = text.split('\0');
  for (let i = 0; i < fields.length; i++) {
    const [added, deleted, path] = fields[i].split('\t');
    if (deleted === undefined) continue;
    const key = path === '' ? fields[(i += 2)] : path;
    if (key === undefined) continue;
    out.set(key, { added: added === '-' ? null : Number(added), deleted: deleted === '-' ? null : Number(deleted) });
  }
  return out;
}

/** What Copy writes: the branch line, then each group's entries. */
export function gitStatusText(status: NativeGitStatus): string {
  const lines = [branchLine(status.branch)];
  if (status.groups.length === 0) lines.push('nothing to commit, working tree clean');
  for (const group of status.groups) {
    lines.push(`${STATUS_GROUP_LABEL[group.kind]}:`);
    for (const entry of group.entries) {
      const path = entry.oldPath ? `${entry.oldPath} -> ${entry.path}` : entry.path;
      lines.push(`  ${entry.code.padEnd(2)} ${path}`);
    }
  }
  return lines.join('\n');
}

/** `master → origin/master ↑1 ↓2`, `detached at abc1234`, `master (no upstream)`. */
export function branchLine(branch: BranchInfo): string {
  const head = branch.head ?? `detached at ${branch.oid?.slice(0, 7) ?? 'HEAD'}`;
  if (branch.upstream === null) return branch.head === null ? head : `${head} (no upstream)`;
  return `${head} → ${branch.upstream} ↑${branch.ahead} ↓${branch.behind}`;
}
