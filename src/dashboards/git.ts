// Krypton — Git Dashboard
// Read-only overlay showing git status for the focused terminal's CWD.
// Toggled via Cmd+Shift+G. Single tab — content fits without scrolling.

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

async function runGit(args: string[], cwd: string): Promise<string> {
  return invoke('run_command', { program: 'git', args, cwd });
}

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
    const filePath = line.slice(3);
    const entry: GitFileEntry = { indexStatus, workTreeStatus, path: filePath };

    if (indexStatus === '?' && workTreeStatus === '?') { untracked.push(entry); continue; }
    if (indexStatus === 'R') renamed.push(entry);
    else if (indexStatus === 'D') deleted.push(entry);
    else if (indexStatus !== ' ' && indexStatus !== '?') staged.push(entry);
    if (workTreeStatus === 'M') modified.push(entry);
    else if (workTreeStatus === 'D' && indexStatus !== 'D') deleted.push(entry);
  }
  return { staged, modified, untracked, deleted, renamed };
}

function statusClass(ix: string, wt: string): string {
  if (ix === '?' && wt === '?') return 'untracked';
  if (ix === 'R') return 'renamed';
  if (ix === 'D' || wt === 'D') return 'deleted';
  if (ix !== ' ' && ix !== '?') return 'staged';
  return 'modified';
}

function statusLabel(ix: string, wt: string): string {
  if (ix === '?' && wt === '?') return '?';
  if (ix === 'R') return 'R';
  if (ix === 'D' || wt === 'D') return 'D';
  if (ix === 'A') return 'A';
  if (ix === 'M') return 'M';
  if (wt === 'M') return 'M';
  return ix + wt;
}

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

  // File list — fills remaining space
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
    section.style.flex = '1';
    section.style.overflow = 'hidden';

    const sectionTitle = document.createElement('div');
    sectionTitle.className = 'krypton-dashboard__section-title';
    sectionTitle.textContent = `Files (${allFiles.length})`;
    section.appendChild(sectionTitle);

    const list = document.createElement('ul');
    list.className = 'krypton-git__file-list';
    list.style.overflow = 'auto';
    list.style.flex = '1';

    for (const file of allFiles) {
      const li = document.createElement('li');
      li.className = 'krypton-git__file';
      const badge = document.createElement('span');
      badge.className = `krypton-git__file-status krypton-git__file-status--${statusClass(file.indexStatus, file.workTreeStatus)}`;
      badge.textContent = statusLabel(file.indexStatus, file.workTreeStatus);
      const path = document.createElement('span');
      path.className = 'krypton-git__file-path';
      path.textContent = file.path;
      li.appendChild(badge);
      li.appendChild(path);
      list.appendChild(li);
    }
    section.appendChild(list);
    section.style.display = 'flex';
    section.style.flexDirection = 'column';
    container.appendChild(section);
  }

  // Bottom hint
  const hint = document.createElement('div');
  hint.className = 'krypton-git__hint';
  hint.textContent = 'r refresh \u00b7 Esc close';
  container.appendChild(hint);
}

export function createGitDashboard(compositor: Compositor): DashboardDefinition {
  let status: GitStatus | null = null;
  let error: string | null = null;
  let readyCallback: (() => void) | null = null;

  async function load(): Promise<void> {
    const sessionId = compositor.getFocusedSessionId();
    if (sessionId === null) {
      error = 'No active terminal session';
      readyCallback?.();
      return;
    }
    try {
      const cwd: string | null = await invoke('get_pty_cwd', { sessionId });
      if (!cwd) { error = 'Could not determine working directory'; readyCallback?.(); return; }
      const [branchRaw, statusRaw] = await Promise.all([
        runGit(['branch', '--show-current'], cwd),
        runGit(['status', '--porcelain=v1'], cwd),
      ]);
      status = { branch: branchRaw.trim(), ...parseStatus(statusRaw) };
    } catch (e) {
      error = `Git error: ${e}`;
    }
    readyCallback?.();
  }

  function renderTab(container: HTMLElement): void {
    container.innerHTML = '';
    if (error) {
      const el = document.createElement('div');
      el.className = 'krypton-dashboard__error';
      el.textContent = error;
      container.appendChild(el);
      return;
    }
    if (status) {
      renderStatus(container, status);
    }
  }

  return {
    id: 'git',
    title: 'Git Status',
    shortcut: { key: 'KeyG', meta: true, shift: true },
    tabs: [{ label: 'Status', render: renderTab }],

    onOpen(ready: () => void): void {
      status = null;
      error = null;
      readyCallback = ready;
      load();
    },

    onClose(): void {
      status = null;
      error = null;
      readyCallback = null;
    },

    onKeyDown(e: KeyboardEvent): boolean {
      if (e.key === 'r' && !e.metaKey && !e.ctrlKey && !e.altKey && !e.shiftKey) {
        readyCallback = () => {
          // re-render after reload
          const content = document.querySelector('.krypton-dashboard__content') as HTMLElement | null;
          if (content) renderTab(content);
        };
        load();
        return true;
      }
      return false;
    },
  };
}
