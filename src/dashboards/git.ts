// Krypton — Git Dashboard
// Read-only overlay showing git status for the focused terminal's CWD.
// Toggled via Cmd+Shift+G.

import { invoke } from '@tauri-apps/api/core';
import type { DashboardDefinition } from '../types';
import type { Compositor } from '../compositor';

/** Parsed git file entry from `git status --porcelain=v1` */
interface GitFileEntry {
  indexStatus: string;
  workTreeStatus: string;
  path: string;
}

/** Parsed git status summary */
interface GitStatus {
  branch: string;
  staged: GitFileEntry[];
  modified: GitFileEntry[];
  untracked: GitFileEntry[];
  deleted: GitFileEntry[];
  renamed: GitFileEntry[];
}

/**
 * Run a command via the Tauri `run_command` IPC and return stdout.
 */
async function runGit(args: string[], cwd: string): Promise<string> {
  return invoke('run_command', { program: 'git', args, cwd });
}

/**
 * Parse `git status --porcelain=v1` output into structured data.
 * Format: XY filename
 * X = index status, Y = work-tree status
 */
function parseStatus(raw: string): Omit<GitStatus, 'branch'> {
  const staged: GitFileEntry[] = [];
  const modified: GitFileEntry[] = [];
  const untracked: GitFileEntry[] = [];
  const deleted: GitFileEntry[] = [];
  const renamed: GitFileEntry[] = [];

  for (const line of raw.split('\n')) {
    if (line.length < 3) continue;

    const indexStatus = line[0];
    const workTreeStatus = line[1];
    // Handle renames: "R  old -> new"
    const filePath = line.slice(3);
    const entry: GitFileEntry = { indexStatus, workTreeStatus, path: filePath };

    // Untracked
    if (indexStatus === '?' && workTreeStatus === '?') {
      untracked.push(entry);
      continue;
    }

    // Index changes (staged)
    if (indexStatus === 'R') {
      renamed.push(entry);
    } else if (indexStatus === 'D') {
      deleted.push(entry);
    } else if (indexStatus !== ' ' && indexStatus !== '?') {
      staged.push(entry);
    }

    // Work-tree changes (unstaged)
    if (workTreeStatus === 'M') {
      modified.push(entry);
    } else if (workTreeStatus === 'D' && indexStatus !== 'D') {
      deleted.push(entry);
    }
  }

  return { staged, modified, untracked, deleted, renamed };
}

/**
 * Get the CSS class suffix for a file status indicator.
 */
function statusClass(indexStatus: string, workTreeStatus: string): string {
  if (indexStatus === '?' && workTreeStatus === '?') return 'untracked';
  if (indexStatus === 'R') return 'renamed';
  if (indexStatus === 'D' || workTreeStatus === 'D') return 'deleted';
  if (indexStatus !== ' ' && indexStatus !== '?') return 'staged';
  if (workTreeStatus === 'M') return 'modified';
  return 'modified';
}

/**
 * Get a human-readable status label.
 */
function statusLabel(indexStatus: string, workTreeStatus: string): string {
  if (indexStatus === '?' && workTreeStatus === '?') return '?';
  if (indexStatus === 'R') return 'R';
  if (indexStatus === 'D' || workTreeStatus === 'D') return 'D';
  if (indexStatus === 'A') return 'A';
  if (indexStatus === 'M') return 'M';
  if (workTreeStatus === 'M') return 'M';
  return indexStatus + workTreeStatus;
}

/**
 * Render the git dashboard content into a container.
 */
function renderStatus(container: HTMLElement, status: GitStatus): void {
  container.innerHTML = '';

  // Branch
  const branchEl = document.createElement('div');
  branchEl.className = 'krypton-git__branch';
  branchEl.textContent = `\u2387 ${status.branch || 'HEAD (detached)'}`;
  container.appendChild(branchEl);

  // Stats summary
  const stats = document.createElement('div');
  stats.className = 'krypton-git__stats';

  const statItems = [
    { label: 'Staged', count: status.staged.length + status.renamed.length, cls: 'staged' },
    { label: 'Modified', count: status.modified.length, cls: 'modified' },
    { label: 'Untracked', count: status.untracked.length, cls: 'untracked' },
    { label: 'Deleted', count: status.deleted.length, cls: 'deleted' },
  ];

  for (const item of statItems) {
    const stat = document.createElement('div');
    stat.className = `krypton-git__stat krypton-git__stat--${item.cls}`;

    const count = document.createElement('span');
    count.className = 'krypton-git__stat-count';
    count.textContent = String(item.count);

    const label = document.createElement('span');
    label.className = 'krypton-git__stat-label';
    label.textContent = item.label;

    stat.appendChild(count);
    stat.appendChild(label);
    stats.appendChild(stat);
  }
  container.appendChild(stats);

  // File list
  const allFiles = [
    ...status.staged.map((f) => ({ ...f, group: 'staged' as const })),
    ...status.renamed.map((f) => ({ ...f, group: 'staged' as const })),
    ...status.modified.map((f) => ({ ...f, group: 'modified' as const })),
    ...status.deleted.map((f) => ({ ...f, group: 'deleted' as const })),
    ...status.untracked.map((f) => ({ ...f, group: 'untracked' as const })),
  ];

  if (allFiles.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'krypton-dashboard__empty';
    empty.textContent = 'Working tree clean';
    container.appendChild(empty);
  } else {
    const section = document.createElement('div');
    section.className = 'krypton-dashboard__section';

    const sectionTitle = document.createElement('div');
    sectionTitle.className = 'krypton-dashboard__section-title';
    sectionTitle.textContent = `Files (${allFiles.length})`;
    section.appendChild(sectionTitle);

    const list = document.createElement('ul');
    list.className = 'krypton-git__file-list';

    for (const file of allFiles) {
      const li = document.createElement('li');
      li.className = 'krypton-git__file';

      const badge = document.createElement('span');
      const cls = statusClass(file.indexStatus, file.workTreeStatus);
      badge.className = `krypton-git__file-status krypton-git__file-status--${cls}`;
      badge.textContent = statusLabel(file.indexStatus, file.workTreeStatus);

      const path = document.createElement('span');
      path.className = 'krypton-git__file-path';
      path.textContent = file.path;

      li.appendChild(badge);
      li.appendChild(path);
      list.appendChild(li);
    }

    section.appendChild(list);
    container.appendChild(section);
  }

  // Hint
  const hint = document.createElement('div');
  hint.className = 'krypton-git__hint';
  hint.textContent = 'Press r to refresh \u00b7 Esc to close';
  container.appendChild(hint);
}

/**
 * Create a Git Dashboard definition.
 * Requires a Compositor reference to get the focused session's CWD.
 */
export function createGitDashboard(compositor: Compositor): DashboardDefinition {
  let currentContainer: HTMLElement | null = null;
  let currentCwd: string | null = null;

  async function loadAndRender(container: HTMLElement): Promise<void> {
    container.innerHTML = '';

    // Show loading
    const loading = document.createElement('div');
    loading.className = 'krypton-dashboard__loading';
    loading.textContent = 'Loading git status...';
    container.appendChild(loading);

    // Get CWD from focused session
    const sessionId = compositor.getFocusedSessionId();
    if (sessionId === null) {
      container.innerHTML = '';
      const err = document.createElement('div');
      err.className = 'krypton-dashboard__empty';
      err.textContent = 'No active terminal session';
      container.appendChild(err);
      return;
    }

    try {
      const cwd: string | null = await invoke('get_pty_cwd', { sessionId });
      if (!cwd) {
        container.innerHTML = '';
        const err = document.createElement('div');
        err.className = 'krypton-dashboard__empty';
        err.textContent = 'Could not determine terminal working directory';
        container.appendChild(err);
        return;
      }
      currentCwd = cwd;

      // Run git commands in parallel
      const [branchRaw, statusRaw] = await Promise.all([
        runGit(['branch', '--show-current'], cwd),
        runGit(['status', '--porcelain=v1'], cwd),
      ]);

      const branch = branchRaw.trim();
      const parsed = parseStatus(statusRaw);
      const status: GitStatus = { branch, ...parsed };

      renderStatus(container, status);
    } catch (err) {
      container.innerHTML = '';
      const errEl = document.createElement('div');
      errEl.className = 'krypton-dashboard__error';
      errEl.textContent = `Git error: ${err}`;
      container.appendChild(errEl);
    }
  }

  return {
    id: 'git',
    title: 'Git Status',
    shortcut: { key: 'KeyG', meta: true, shift: true },

    onOpen(container: HTMLElement): void {
      currentContainer = container;
      loadAndRender(container);
    },

    onClose(): void {
      currentContainer = null;
      currentCwd = null;
    },

    onKeyDown(e: KeyboardEvent): boolean {
      // r — refresh
      if (e.key === 'r' && !e.metaKey && !e.ctrlKey && !e.altKey && !e.shiftKey) {
        if (currentContainer) {
          loadAndRender(currentContainer);
        }
        return true;
      }
      return false;
    },
  };
}
