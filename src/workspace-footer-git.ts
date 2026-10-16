// Git ref + dirty summary for the footer's focused cwd: a 10 s per-cwd cache,
// a 100 ms debounce on cwd changes, and a re-check that the result still
// belongs to the focused folder before notifying.
import { invoke } from './profiler/ipc';

interface GitSummary {
  text: string | null;
  expiresAt: number;
}

export const GIT_CACHE_TTL_MS = 10_000;
export const GIT_DEBOUNCE_MS = 100;

export class FooterGit {
  private gitByCwd = new Map<string, GitSummary>();
  private gitText: string | null = null;
  private gitCwd: string | null = null;
  private pendingGitCwd: string | null = null;
  private pendingGitTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(
    private readonly deps: {
      /** Current focused working directory, re-read after a git query lands. */
      getFocusedCwd: () => Promise<string | null>;
      /** Called when a fresh result for the focused cwd is available. */
      onChange: () => void;
    },
  ) {}

  /** Latest git text for the focused cwd (`ref`, `HEAD ref`, `+ ' *'` when dirty). */
  get text(): string | null {
    return this.gitText;
  }

  update(cwd: string | null): void {
    if (cwd !== this.gitCwd) {
      this.gitCwd = cwd;
      this.gitText = null;
      if (this.pendingGitTimer !== null) {
        clearTimeout(this.pendingGitTimer);
        this.pendingGitTimer = null;
      }
      this.pendingGitCwd = null;
    }
    if (!cwd) {
      this.gitText = null;
      return;
    }
    const cached = this.gitByCwd.get(cwd);
    const now = Date.now();
    if (cached && cached.expiresAt > now) {
      this.gitText = cached.text;
      return;
    }
    if (this.pendingGitTimer !== null && this.pendingGitCwd === cwd) return;
    if (this.pendingGitTimer !== null) {
      clearTimeout(this.pendingGitTimer);
      this.pendingGitTimer = null;
    }
    this.pendingGitCwd = cwd;
    this.pendingGitTimer = setTimeout(() => {
      this.pendingGitTimer = null;
      this.pendingGitCwd = null;
      void this.refreshGit(cwd);
    }, GIT_DEBOUNCE_MS);
  }

  dispose(): void {
    if (this.pendingGitTimer !== null) {
      clearTimeout(this.pendingGitTimer);
      this.pendingGitTimer = null;
    }
  }

  private async refreshGit(cwd: string): Promise<void> {
    let text: string | null = null;
    try {
      const branch = (await invoke<string>('run_command', {
        program: 'git',
        args: ['branch', '--show-current'],
        cwd,
      })).trim();
      const ref = branch || (await invoke<string>('run_command', {
        program: 'git',
        args: ['rev-parse', '--short', 'HEAD'],
        cwd,
      })).trim();
      const porcelain = (await invoke<string>('run_command', {
        program: 'git',
        args: ['status', '--porcelain=v1'],
        cwd,
      })).trim();
      text = ref ? `${branch ? ref : `HEAD ${ref}`}${porcelain ? ' *' : ''}` : null;
    } catch {
      text = null;
    }
    this.gitByCwd.set(cwd, { text, expiresAt: Date.now() + GIT_CACHE_TTL_MS });
    if ((await this.deps.getFocusedCwd()) === cwd) {
      this.gitText = text;
      this.deps.onChange();
    }
  }
}
