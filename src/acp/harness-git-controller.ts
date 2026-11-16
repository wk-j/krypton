// Spec 396 — Git dock lifetime: status, selection, poll, and mutations.
//
// HarnessDock owns `hidden`. This controller owns the snapshot and the keys.
// Tests inject `GitPanelApi` so a render never calls `invoke`.

import { invoke } from '@tauri-apps/api/core';

import { loadConfig } from '../config';
import { parseGitStatus, STATUS_GROUP_LABEL, type NativeGitStatus, type StatusGroupKind } from '../native-output/git-status';
import { GitDock, type GitDockProps, type GitLamp, type GitListItem } from './components/git-dock';
import type { GitTabBadge } from './harness-dock';
import { AcpAssistSession } from './assist/acp-completion';
import { resolveAssistConfig } from './assist/config';
import { AssistEngine, type AssistCompletion } from './assist/engine';
import { COMMIT_MESSAGE_DEFAULTS, COMMIT_MESSAGE_FAILURE, commitMessageCall, type GitCommitContext } from './git-commit-message';
import type { AcpInstanceOwner } from './types';

export const GIT_PANEL_POLL_MS = 4000;

export interface GitPanelStatusPayload {
  readonly repoRoot: string;
  readonly status: string;
  readonly stagedNumstat: string;
  readonly unstagedNumstat: string;
}

export type GitDiscardKind = 'unstaged' | 'untracked-file' | 'untracked-dir';

export interface WorkingDiffRequest {
  readonly cwd: string;
  readonly staged: boolean;
  readonly revealPath: string;
}

export interface GitPanelApi {
  status(cwd: string): Promise<GitPanelStatusPayload>;
  commitContext(cwd: string): Promise<GitCommitContext>;
  stage(cwd: string, paths: string[]): Promise<void>;
  unstage(cwd: string, paths: string[]): Promise<void>;
  discard(cwd: string, path: string, kind: GitDiscardKind): Promise<void>;
  commit(cwd: string, message: string): Promise<{ sha: string }>;
}

export interface HarnessGitHost {
  projectDir(): string | null;
  assistOwner(): AcpInstanceOwner;
  remote(): boolean;
  isPanelHidden(): boolean;
  setDockTabAvailable(available: boolean): void;
  dockTabShown(): boolean;
  invalidate(): void;
  focusComposer(): void;
  flash(message: string): void;
  setBadge(badge: GitTabBadge): void;
  openDiff: ((request: WorkingDiffRequest) => Promise<boolean>) | null;
}

export interface GitCommitMessageDeps {
  complete?: AssistCompletion;
  loadConfig?: () => Promise<unknown>;
}

interface CommitMessageRequest {
  readonly epoch: number;
  readonly revision: number;
  readonly dir: string;
  session: AcpAssistSession | null;
  cancelled: boolean;
}

interface PanelRow {
  readonly id: string;
  readonly kind: Exclude<StatusGroupKind, 'ignored'>;
  readonly code: string;
  readonly path: string;
  readonly oldPath: string | null;
  readonly added: number | null;
  readonly deleted: number | null;
  readonly submodule: boolean;
}

const STAGE_CHUNK = 200;

export const tauriGitPanelApi: GitPanelApi = {
  status: (cwd) => invoke<GitPanelStatusPayload>('git_panel_status', { cwd }),
  commitContext: (cwd) => invoke<GitCommitContext>('git_panel_commit_context', { cwd }),
  stage: (cwd, paths) => invoke('git_panel_stage', { cwd, paths }),
  unstage: (cwd, paths) => invoke('git_panel_unstage', { cwd, paths }),
  discard: (cwd, path, kind) => invoke('git_panel_discard', { cwd, path, kind }),
  commit: (cwd, message) => invoke<{ sha: string }>('git_panel_commit', { cwd, message }),
};

function invokeMessage(err: unknown): string {
  if (typeof err === 'string') return err;
  if (err instanceof Error && err.message) return err.message;
  return 'git failed';
}

function clock(ms: number): string {
  const date = new Date(ms);
  const pad = (value: number): string => String(value).padStart(2, '0');
  return `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

function isPanelKind(kind: StatusGroupKind): kind is PanelRow['kind'] {
  return kind === 'conflicts' || kind === 'staged' || kind === 'unstaged' || kind === 'untracked';
}

function flatten(status: NativeGitStatus): PanelRow[] {
  const rows: PanelRow[] = [];
  for (const group of status.groups) {
    if (!isPanelKind(group.kind)) continue;
    for (const entry of group.entries) {
      rows.push({
        id: `${group.kind}\0${entry.path}`,
        kind: group.kind,
        code: entry.code,
        path: entry.path,
        oldPath: entry.oldPath,
        added: entry.added,
        deleted: entry.deleted,
        submodule: entry.submodule,
      });
    }
  }
  return rows;
}

function stagePaths(row: PanelRow): string[] {
  return row.oldPath ? [row.oldPath, row.path] : [row.path];
}

function dedupe(paths: readonly string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const path of paths) {
    if (seen.has(path)) continue;
    seen.add(path);
    out.push(path);
  }
  return out;
}

function pathParts(row: PanelRow): { dir: string; name: string } {
  if (row.oldPath) return { dir: '', name: `${row.oldPath} → ${row.path}` };
  const slash = row.path.lastIndexOf('/');
  if (slash < 0) return { dir: '', name: row.path };
  return { dir: row.path.slice(0, slash + 1), name: row.path.slice(slash + 1) };
}

function countLabel(row: PanelRow): { text: string; dim: boolean } {
  if (row.submodule || row.kind === 'untracked' || row.kind === 'conflicts') return { text: '', dim: false };
  if (row.added === null && row.deleted === null) return { text: 'bin', dim: true };
  return { text: `+${row.added ?? 0} -${row.deleted ?? 0}`, dim: false };
}

function summaryLine(rows: readonly PanelRow[]): string {
  const counts = { conflicts: 0, staged: 0, unstaged: 0, untracked: 0 };
  for (const row of rows) counts[row.kind] += 1;
  const parts: string[] = [];
  if (counts.conflicts) parts.push(`${counts.conflicts} conflict${counts.conflicts === 1 ? '' : 's'}`);
  if (counts.staged) parts.push(`${counts.staged} staged`);
  if (counts.unstaged) parts.push(`${counts.unstaged} unstaged`);
  if (counts.untracked) parts.push(`${counts.untracked} untracked`);
  return parts.join(' · ');
}

function discardKind(row: PanelRow): GitDiscardKind {
  if (row.kind === 'unstaged') return 'unstaged';
  return row.path.endsWith('/') ? 'untracked-dir' : 'untracked-file';
}

/** Status, keys, and mutations for one harness's Git tab. */
export class HarnessGitController {
  readonly dockEl: HTMLElement;
  readonly dock: GitDock;
  private shown = false;
  private disposed = false;
  private boundDir: string | null = null;
  private epoch = 0;
  private generation = 0;
  private timer: ReturnType<typeof setInterval> | null = null;
  private flight = false;
  private again = false;
  private mutating = false;
  private rows: PanelRow[] = [];
  private branch: NativeGitStatus['branch'] | null = null;
  private selectedId: string | null = null;
  private selectedIndex = 0;
  private message = '';
  private confirmId: string | null = null;
  private lamp: GitLamp = 'idle';
  private fault: string | null = null;
  private faultKind: 'status' | 'mutation' | null = null;
  private lastSuccess: number | null = null;
  private messageRevision = 0;
  private fieldFocused = false;
  private aiRequest: CommitMessageRequest | null = null;
  private aiSession: AcpAssistSession | null = null;
  private readonly aiEngine: AssistEngine;
  private readonly readAiConfig: () => Promise<unknown>;
  private readonly usesAiSession: boolean;

  constructor(
    private readonly host: HarnessGitHost,
    private readonly api: GitPanelApi = tauriGitPanelApi,
    deps: GitCommitMessageDeps = {},
  ) {
    this.readAiConfig = deps.loadConfig ?? loadConfig;
    this.usesAiSession = !deps.complete;
    this.aiEngine = new AssistEngine(deps.complete ?? ((call) => {
      const session = this.aiRequest?.session;
      if (!session) throw new Error('AI commit session is not available');
      return session.complete(call);
    }));
    this.dockEl = document.createElement('aside');
    this.dockEl.className = 'acp-harness__git-dock';
    this.dockEl.hidden = true;
    this.dockEl.tabIndex = -1;
    this.dock = new GitDock(this.dockEl);
    this.dockEl.addEventListener('click', this.onClick);
    this.dockEl.addEventListener('input', this.onInput);
    this.dockEl.addEventListener('focusin', this.onFocus);
    this.dockEl.addEventListener('focusout', this.onFocus);
    document.addEventListener('visibilitychange', this.onVisibility);
  }

  /** Paint and sync the poll. A show transition or a project change refreshes. */
  renderDock(): void {
    if (this.disposed) return;
    this.host.setDockTabAvailable(!this.host.isPanelHidden());
    const shown = this.host.dockTabShown();
    const dir = this.host.projectDir();
    const dirChanged = dir !== this.boundDir;
    if (dirChanged || !shown || this.host.remote()) this.cancelAi();
    if (dirChanged || this.host.remote()) {
      const session = this.aiSession;
      this.aiSession = null;
      if (session) void session.dispose().catch(() => undefined);
    }
    if (dirChanged) {
      this.boundDir = dir;
      this.epoch += 1;
      this.rows = [];
      this.branch = null;
      this.selectedId = null;
      this.selectedIndex = 0;
      this.confirmId = null;
      this.fault = null;
      this.faultKind = null;
      this.lastSuccess = null;
      this.generation += 1;
    }
    const opened = shown && !this.shown;
    this.shown = shown;
    this.syncTimer();
    if (shown && (opened || dirChanged) && this.canQuery()) this.requestStatus();
    if (shown) this.paintDock();
  }

  focus(): void {
    this.dockEl.focus({ preventScroll: true });
  }

  /** Refresh when this harness's lane goes idle and the tab is already shown. */
  noteLaneIdle(cwd: string): void {
    if (!this.shown || this.disposed || this.host.projectDir() !== cwd) return;
    this.requestStatus();
  }

  /**
   * True when the key must reach the commit textarea. The view returns false
   * from `onKeyDown` immediately, so the input router does not cancel it.
   */
  passesToField(event: KeyboardEvent): boolean {
    if (!(event.target instanceof HTMLTextAreaElement) || !this.dockEl.contains(event.target)) return false;
    if (event.isComposing) return true;
    if (event.key === 'Escape' && !event.metaKey && !event.ctrlKey && !event.altKey) return false;
    if ((event.metaKey || event.ctrlKey) && !event.altKey && event.key === 'Enter') return false;
    if (this.isAiChord(event)) return false;
    return true;
  }

  /** List and commit-field keys. False lets Cmd+W fall through to close the window. */
  handleDockKey(event: KeyboardEvent): boolean {
    if (!this.shown || !(event.target instanceof Node) || !this.dockEl.contains(event.target)) return false;
    if (event.target instanceof HTMLTextAreaElement) {
      if (event.isComposing) return false;
      if (this.isAiChord(event)) {
        event.preventDefault();
        void this.generateMessage();
        return true;
      }
      if (event.key === 'Escape' && !event.metaKey && !event.ctrlKey && !event.altKey) {
        event.preventDefault();
        this.confirmId = null;
        this.focus();
        return true;
      }
      if ((event.metaKey || event.ctrlKey) && !event.altKey && event.key === 'Enter') {
        event.preventDefault();
        void this.commit();
        return true;
      }
      return false;
    }
    if (event.metaKey && !event.ctrlKey && !event.altKey && !event.shiftKey && event.key.toLowerCase() === 'c') {
      const path = this.selected()?.path;
      if (path) void navigator.clipboard?.writeText(path);
      event.preventDefault();
      return true;
    }
    if (event.metaKey && !event.ctrlKey && !event.altKey && event.key.toLowerCase() === 'w') return false;
    if (event.metaKey || event.altKey) return false;
    if (event.ctrlKey) {
      const key = event.key.toLowerCase();
      if (key === 'c' || key === 'a' || key === 'e' || key === 'k') {
        event.preventDefault();
        return true;
      }
      return false;
    }
    if (this.confirmId) {
      if (event.key === 'y' || event.key === 'Y') {
        event.preventDefault();
        void this.confirmDiscard();
        return true;
      }
      if (event.key === 'n' || event.key === 'N' || event.key === 'Escape') {
        event.preventDefault();
        this.confirmId = null;
        this.paintDock();
        return true;
      }
      if (event.key === 'c') {
        event.preventDefault();
        this.confirmId = null;
        this.focusField();
        return true;
      }
      event.preventDefault();
      return true;
    }
    const current = this.rows.findIndex((row) => row.id === this.selectedId);
    if (event.key === 'j' || event.key === 'ArrowDown') {
      event.preventDefault();
      this.move(current + 1);
      return true;
    }
    if (event.key === 'k' || event.key === 'ArrowUp') {
      event.preventDefault();
      this.move(current < 0 ? 0 : current - 1);
      return true;
    }
    if (event.key === 'Home') {
      event.preventDefault();
      this.move(0);
      return true;
    }
    if (event.key === 'End') {
      event.preventDefault();
      this.move(this.rows.length - 1);
      return true;
    }
    if (event.key === 'Enter') {
      event.preventDefault();
      void this.openSelectedDiff();
      return true;
    }
    if (event.key === 's' || event.key === ' ') {
      event.preventDefault();
      void this.stageRow();
      return true;
    }
    if (event.key === 'S') {
      event.preventDefault();
      void this.stageAll();
      return true;
    }
    if (event.key === 'u') {
      event.preventDefault();
      void this.unstageRow();
      return true;
    }
    if (event.key === 'U') {
      event.preventDefault();
      void this.unstageAll();
      return true;
    }
    if (event.key === 'x') {
      event.preventDefault();
      this.armDiscard();
      return true;
    }
    if (event.key === 'c') {
      event.preventDefault();
      this.focusField();
      return true;
    }
    if (event.key === 'g') {
      event.preventDefault();
      void this.generateMessage();
      return true;
    }
    if (event.key === 'r') {
      event.preventDefault();
      this.requestStatus();
      return true;
    }
    if (event.key === 'Escape') {
      event.preventDefault();
      this.host.focusComposer();
      return true;
    }
    if (event.key === 'Tab' || event.key === 'Backspace' || event.key === 'Delete' || event.key.startsWith('Arrow')) {
      event.preventDefault();
      return true;
    }
    if (event.key.length === 1) {
      event.preventDefault();
      return true;
    }
    return false;
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.epoch += 1;
    this.cancelAi();
    const session = this.aiSession;
    this.aiSession = null;
    if (session) void session.dispose().catch(() => undefined);
    if (this.timer !== null) clearInterval(this.timer);
    this.timer = null;
    document.removeEventListener('visibilitychange', this.onVisibility);
    this.dockEl.removeEventListener('click', this.onClick);
    this.dockEl.removeEventListener('input', this.onInput);
    this.dockEl.removeEventListener('focusin', this.onFocus);
    this.dockEl.removeEventListener('focusout', this.onFocus);
    this.dock.dispose();
  }

  private readonly onVisibility = (): void => {
    this.syncTimer();
    if (document.visibilityState === 'visible' && this.shown) this.requestStatus();
  };

  private readonly onClick = (event: MouseEvent): void => {
    if (!(event.target instanceof Element)) return;
    if (event.target.closest('[data-git-ai]')) {
      void this.generateMessage();
      return;
    }
    if (event.target.closest('[data-git-commit]')) {
      void this.commit();
      return;
    }
    const row = event.target.closest<HTMLElement>('[data-git-index]');
    if (!row || !this.dockEl.contains(row)) return;
    const index = Number(row.dataset.gitIndex);
    const entry = this.rows[index];
    if (!entry) return;
    this.selectedIndex = index;
    this.selectedId = entry.id;
    this.confirmId = null;
    this.paintDock();
    this.focus();
  };

  private readonly onInput = (event: Event): void => {
    if (!(event.target instanceof HTMLTextAreaElement)) return;
    this.message = event.target.value;
    this.messageRevision += 1;
    this.cancelAi();
    if (this.lamp === 'failed' && !this.flight && !this.mutating) {
      this.lamp = 'idle';
      this.fault = null;
      this.faultKind = null;
    }
    this.paintDock();
  };

  private readonly onFocus = (event: FocusEvent): void => {
    const focused = event.type === 'focusin' ? event.target : event.relatedTarget;
    const fieldFocused = focused instanceof HTMLTextAreaElement && this.dockEl.contains(focused);
    if (fieldFocused === this.fieldFocused) return;
    this.fieldFocused = fieldFocused;
    this.paintDock();
  };

  private isAiChord(event: KeyboardEvent): boolean {
    return (event.metaKey || event.ctrlKey) && event.shiftKey && !event.altKey && event.key.toLowerCase() === 'g';
  }

  private aiDisabledReason(): string | null {
    if (this.disposed) return 'Git panel is closed.';
    if (this.host.remote()) return 'Git is local only.';
    if (!this.cwd()) return 'No project directory';
    if (!this.branch) return 'Git repository is not loaded.';
    if (this.mutating) return 'Git is busy';
    if (this.confirmId) return 'Confirm or cancel discard first.';
    if (this.rows.some((row) => row.kind === 'conflicts')) return 'Resolve conflicts before drafting a commit message.';
    if (!this.rows.some((row) => row.kind === 'staged')) return 'nothing staged';
    return null;
  }

  private currentAi(request: CommitMessageRequest): boolean {
    return this.aiRequest === request && !request.cancelled && !this.disposed && this.shown &&
      request.epoch === this.epoch && request.revision === this.messageRevision && this.cwd() === request.dir;
  }

  private cancelAi(): void {
    const request = this.aiRequest;
    if (!request) return;
    request.cancelled = true;
    this.aiRequest = null;
    this.aiEngine.cancel();
    if (request.session) {
      if (this.aiSession === request.session) this.aiSession = null;
      // Setup may still be in flight; its late client is also disposed in finally.
      void request.session.dispose().catch(() => undefined);
    }
  }

  private async generateMessage(): Promise<void> {
    if (this.aiRequest) {
      this.cancelAi();
      this.paintDock();
      return;
    }
    const reason = this.aiDisabledReason();
    if (reason) {
      this.host.flash(reason);
      return;
    }
    const dir = this.cwd();
    if (!dir) return;
    const request: CommitMessageRequest = {
      epoch: this.epoch, revision: this.messageRevision, dir, session: null, cancelled: false,
    };
    this.aiRequest = request;
    const draft = this.message;
    this.paintDock();
    try {
      const [context, rawConfig] = await Promise.all([this.api.commitContext(dir), this.readAiConfig()]);
      if (!this.currentAi(request)) return;
      const cfg = resolveAssistConfig(rawConfig, COMMIT_MESSAGE_DEFAULTS);
      if (this.aiEngine.cooldownUntil(commitMessageCall.id) > Date.now()) {
        throw new Error('AI commit message is cooling down. Try again later.');
      }
      const input = { diff: context.diff, draft };
      if (commitMessageCall.payload(input, cfg).length > cfg.maxInputChars) {
        throw new Error('Staged changes exceed the AI input limit; stage a smaller commit.');
      }
      if (this.usesAiSession) {
        this.aiSession ??= new AcpAssistSession({
          projectDir: () => dir,
          remoteRuntimeId: () => null,
          owner: () => this.host.assistOwner(),
        });
        request.session = this.aiSession;
      }
      const result = await this.aiEngine.run(commitMessageCall, input, cfg);
      if (!this.currentAi(request)) return;
      if (!result.ok) throw new Error(COMMIT_MESSAGE_FAILURE[result.reason]);
      const fresh = await this.api.commitContext(dir);
      if (!this.currentAi(request)) return;
      if (fresh.repoRoot !== context.repoRoot || fresh.fingerprint !== context.fingerprint) {
        throw new Error('Staged changes changed. Generate a new commit message.');
      }
      this.message = result.value;
      this.messageRevision += 1;
      this.fault = null;
      this.faultKind = null;
      if (this.lamp === 'failed') this.lamp = 'idle';
      const focusField = this.dockEl.contains(document.activeElement);
      this.paintDock();
      if (focusField) this.focusField();
    } catch (err) {
      if (this.currentAi(request)) {
        this.failLocal(invokeMessage(err));
        this.host.flash(invokeMessage(err));
      }
      if (request.session && !request.cancelled) {
        if (this.aiSession === request.session) this.aiSession = null;
        await request.session.dispose().catch(() => undefined);
      }
    } finally {
      if (request.cancelled && request.session) {
        await request.session.dispose().catch(() => undefined);
      }
      if (this.aiRequest === request) {
        this.aiRequest = null;
        if (!this.disposed && this.shown) this.paintDock();
      }
    }
  }

  private canQuery(): boolean {
    return !this.host.remote() && this.host.projectDir() !== null;
  }

  private cwd(): string | null {
    return this.host.remote() ? null : this.host.projectDir();
  }

  private syncTimer(): void {
    const want = !this.disposed && this.shown && document.visibilityState === 'visible' && this.canQuery();
    if (!want) {
      if (this.timer !== null) clearInterval(this.timer);
      this.timer = null;
      return;
    }
    if (this.timer !== null) return;
    this.timer = setInterval(() => this.requestStatus(), GIT_PANEL_POLL_MS);
  }

  private requestStatus(): void {
    if (!this.canQuery() || !this.shown || this.disposed) return;
    if (this.flight || this.mutating) {
      this.again = true;
      return;
    }
    const dir = this.host.projectDir();
    if (!dir) return;
    const epoch = this.epoch;
    this.again = false;
    this.flight = true;
    if (this.lamp !== 'staging' && this.lamp !== 'committing') this.lamp = 'refreshing';
    this.paintDock();
    void this.api.status(dir).then(
      (raw) => this.finishStatus(epoch, dir, raw, null),
      (err: unknown) => this.finishStatus(epoch, dir, null, invokeMessage(err)),
    );
  }

  private finishStatus(
    epoch: number,
    dir: string,
    raw: GitPanelStatusPayload | null,
    error: string | null,
  ): void {
    this.flight = false;
    if (epoch !== this.epoch || dir !== this.host.projectDir() || this.disposed) {
      this.kickAgain();
      return;
    }
    if (raw) {
      const parsed = parseGitStatus({
        status: raw.status,
        staged_numstat: raw.stagedNumstat,
        unstaged_numstat: raw.unstagedNumstat,
      });
      if (parsed) {
        this.branch = parsed.branch;
        this.rows = flatten(parsed);
        this.fault = null;
        this.faultKind = null;
        this.lastSuccess = Date.now();
        this.lamp = 'idle';
        this.generation += 1;
        this.reselect();
      } else {
        this.failStatus('git status output was not porcelain v2');
      }
    } else {
      this.failStatus(error ?? 'git failed');
    }
    if (this.shown) this.paintDock();
    this.host.invalidate();
    this.kickAgain();
  }

  private failStatus(message: string): void {
    this.fault = message;
    this.faultKind = 'status';
    this.lamp = 'failed';
    this.generation += 1;
  }

  private kickAgain(): void {
    if (!this.again) return;
    this.again = false;
    if (this.shown && !this.disposed) this.requestStatus();
  }

  private reselect(): void {
    if (this.confirmId && !this.rows.some((row) => row.id === this.confirmId)) this.confirmId = null;
    if (this.rows.length === 0) {
      this.selectedId = null;
      this.selectedIndex = 0;
      return;
    }
    const found = this.rows.findIndex((row) => row.id === this.selectedId);
    if (found >= 0) {
      this.selectedIndex = found;
      return;
    }
    const index = Math.min(this.selectedIndex, this.rows.length - 1);
    this.selectedIndex = index;
    this.selectedId = this.rows[index]?.id ?? null;
  }

  private selected(): PanelRow | null {
    return this.rows.find((row) => row.id === this.selectedId) ?? null;
  }

  private move(index: number): void {
    if (this.rows.length === 0) return;
    const next = Math.max(0, Math.min(this.rows.length - 1, index));
    this.selectedIndex = next;
    this.selectedId = this.rows[next]?.id ?? null;
    this.paintDock();
    this.dockEl.querySelector<HTMLElement>('[aria-selected="true"]')?.scrollIntoView({ block: 'nearest' });
  }

  private focusField(): void {
    this.paintDock();
    const field = this.dockEl.querySelector('textarea');
    if (field instanceof HTMLTextAreaElement) field.focus({ preventScroll: true });
  }

  private async runMutation(lamp: 'staging' | 'committing', work: () => Promise<void>): Promise<boolean> {
    if (this.mutating || this.aiRequest) {
      this.host.flash(this.aiRequest ? 'Cancel AI before changing Git.' : 'Git is busy');
      return false;
    }
    if (!this.cwd()) return false;
    this.mutating = true;
    this.lamp = lamp;
    this.paintDock();
    let ok = false;
    try {
      await work();
      ok = true;
    } catch (err) {
      this.fault = invokeMessage(err);
      this.faultKind = 'mutation';
      this.lamp = 'failed';
      this.generation += 1;
      this.host.flash(this.fault);
      this.paintDock();
    } finally {
      this.mutating = false;
      this.requestStatus();
    }
    return ok;
  }

  private async stageRow(): Promise<void> {
    const row = this.selected();
    const dir = this.cwd();
    if (!row || !dir) return;
    if (row.kind === 'conflicts') {
      this.host.flash('Resolve the conflict before staging.');
      return;
    }
    await this.runMutation('staging', () => this.api.stage(dir, stagePaths(row)));
  }

  private async stageAll(): Promise<void> {
    const dir = this.cwd();
    if (!dir) return;
    const conflicts = this.rows.filter((row) => row.kind === 'conflicts').length;
    const paths = dedupe(this.rows.filter((row) => row.kind !== 'conflicts').flatMap(stagePaths));
    if (paths.length === 0) {
      if (conflicts > 0) this.host.flash(`Staged 0 · ${conflicts} conflicts left`);
      return;
    }
    const ok = await this.runMutation('staging', async () => {
      for (let i = 0; i < paths.length; i += STAGE_CHUNK) {
        await this.api.stage(dir, paths.slice(i, i + STAGE_CHUNK));
      }
    });
    if (ok && conflicts > 0) this.host.flash(`Staged ${paths.length} · ${conflicts} conflicts left`);
  }

  private async unstageRow(): Promise<void> {
    const row = this.selected();
    const dir = this.cwd();
    if (!row || !dir) return;
    if (row.kind === 'untracked') {
      this.host.flash(`Nothing staged for ${row.path}.`);
      return;
    }
    await this.runMutation('staging', () => this.api.unstage(dir, stagePaths(row)));
  }

  private async unstageAll(): Promise<void> {
    const dir = this.cwd();
    if (!dir) return;
    await this.runMutation('staging', () => this.api.unstage(dir, ['.']));
  }

  private armDiscard(): void {
    const row = this.selected();
    if (!row) return;
    if (row.kind === 'conflicts') {
      this.host.flash('Resolve the conflict before discarding.');
      return;
    }
    if (row.submodule) {
      this.host.flash('Submodules are not discarded from this panel.');
      return;
    }
    if (row.kind === 'staged') {
      this.host.flash('Press u to unstage. The worktree copy stays.');
      return;
    }
    this.confirmId = row.id;
    this.paintDock();
  }

  private async confirmDiscard(): Promise<void> {
    const row = this.rows.find((entry) => entry.id === this.confirmId) ?? null;
    this.confirmId = null;
    const dir = this.cwd();
    if (!row || !dir) {
      this.paintDock();
      return;
    }
    await this.runMutation('staging', () => this.api.discard(dir, row.path, discardKind(row)));
  }

  private async commit(): Promise<void> {
    const dir = this.cwd();
    if (!dir) return;
    if (this.aiRequest) {
      this.host.flash('Cancel AI before changing Git.');
      return;
    }
    const trimmed = this.message.trim();
    if (trimmed === '') {
      this.failLocal('commit message is empty');
      return;
    }
    if (new TextEncoder().encode(trimmed).length > 100_000) {
      this.failLocal('commit message is too long');
      return;
    }
    if (!this.rows.some((row) => row.kind === 'staged')) {
      this.failLocal('nothing staged');
      return;
    }
    await this.runMutation('committing', async () => {
      const result = await this.api.commit(dir, trimmed);
      this.message = '';
      this.host.flash(`Committed ${result.sha}`);
    });
  }

  private failLocal(message: string): void {
    this.fault = message;
    this.faultKind = 'mutation';
    this.lamp = 'failed';
    this.generation += 1;
    this.paintDock();
  }

  private async openSelectedDiff(): Promise<void> {
    const row = this.selected();
    const dir = this.cwd();
    if (!row || !dir || this.host.remote()) return;
    if (!this.host.openDiff) {
      this.host.flash('Diff view is not available');
      return;
    }
    const revealed = await this.host.openDiff({
      cwd: dir,
      staged: row.kind === 'staged',
      revealPath: row.path,
    });
    if (!revealed) this.host.flash(`No rendered diff for ${row.path}`);
  }

  private paintDock(): void {
    this.dock.update(this.props());
    this.host.setBadge(this.badge());
  }

  private badge(): GitTabBadge {
    if (this.branch === null) return { conflicts: false, rows: null };
    if (this.rows.some((row) => row.kind === 'conflicts')) return { conflicts: true, rows: null };
    if (this.rows.length === 0) return { conflicts: false, rows: null };
    return { conflicts: false, rows: this.rows.length };
  }

  private props(): GitDockProps {
    const remote = this.host.remote();
    const dir = this.host.projectDir();
    const head = this.branch === null ? '' : this.branch.head ?? `detached at ${this.branch.oid?.slice(0, 7) ?? 'HEAD'}`;
    const upstream = this.branch?.upstream ?? null;
    const headLabel = this.branch === null
      ? ''
      : upstream === null
        ? (this.branch.head === null ? head : `${head} (no upstream)`)
        : `${head} → ${upstream}`;
    let empty: string | null = null;
    if (remote) empty = 'Git is local only. This Harness is on a remote host.';
    else if (!dir) empty = 'No project directory';
    else if (this.branch === null) empty = this.fault;
    else if (this.rows.length === 0) empty = 'Working tree clean';
    const banner = this.branch !== null && this.fault
      ? (this.faultKind === 'status' && this.lastSuccess !== null
        ? `Refresh failed: ${this.fault} · last success ${clock(this.lastSuccess)}`
        : this.fault)
      : null;
    const confirm = this.confirmText();
    return {
      generation: this.generation,
      headLabel,
      ahead: upstream === null || this.branch === null ? null : this.branch.ahead,
      behind: upstream === null || this.branch === null ? null : this.branch.behind,
      summary: this.branch === null ? '' : summaryLine(this.rows),
      banner,
      empty,
      items: empty === null ? this.listItems() : [],
      selectedId: this.selectedId,
      message: this.message,
      confirm,
      lamp: this.lamp,
      showCommit: !remote && dir !== null && this.branch !== null,
      aiRunning: this.aiRequest !== null,
      aiDisabledReason: this.aiDisabledReason(),
      commitDisabled: this.mutating || this.aiRequest !== null,
      fieldFocused: this.fieldFocused,
    };
  }

  private confirmText(): string | null {
    if (!this.confirmId) return null;
    const row = this.rows.find((entry) => entry.id === this.confirmId);
    if (!row) return null;
    if (row.kind === 'unstaged') {
      return `Discard unstaged changes in ${row.path}? Worktree returns to the index.`;
    }
    return `Delete untracked ${row.path}? This cannot be undone.`;
  }

  private listItems(): GitListItem[] {
    const items: GitListItem[] = [];
    let last: PanelRow['kind'] | null = null;
    this.rows.forEach((row, index) => {
      if (row.kind !== last) {
        const count = this.rows.filter((entry) => entry.kind === row.kind).length;
        items.push({
          type: 'section',
          id: `section:${row.kind}`,
          label: STATUS_GROUP_LABEL[row.kind].toUpperCase(),
          count,
        });
        last = row.kind;
      }
      const parts = pathParts(row);
      const counts = countLabel(row);
      items.push({
        type: 'row',
        id: row.id,
        index,
        code: row.code,
        dir: parts.dir,
        name: parts.name,
        counts: counts.text,
        countsDim: counts.dim,
        selected: row.id === this.selectedId,
      });
    });
    return items;
  }
}
