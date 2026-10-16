import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const invokeMock = vi.hoisted(() => vi.fn());
vi.mock('./profiler/ipc', () => ({ invoke: invokeMock }));

import { FooterGit, GIT_CACHE_TTL_MS, GIT_DEBOUNCE_MS } from './workspace-footer-git';

function gitResponder(branch: string, porcelain: string, sha = 'abc123') {
  return async (_cmd: string, payload: { args: string[] }) => {
    if (payload.args[0] === 'branch') return branch;
    if (payload.args[0] === 'rev-parse') return sha;
    return porcelain;
  };
}

describe('FooterGit', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    invokeMock.mockReset();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('debounces, queries git, and notifies when cwd is still focused', async () => {
    invokeMock.mockImplementation(gitResponder('main\n', ' M a.ts\n'));
    const onChange = vi.fn();
    const git = new FooterGit({ getFocusedCwd: async () => '/repo', onChange });

    git.update('/repo');
    git.update('/repo');
    expect(git.text).toBeNull();
    expect(invokeMock).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(GIT_DEBOUNCE_MS);
    // branch + status; rev-parse is skipped when a branch name exists.
    expect(invokeMock).toHaveBeenCalledTimes(2);
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(git.text).toBe('main *');
  });

  it('uses a detached HEAD sha and serves from cache within the TTL', async () => {
    invokeMock.mockImplementation(gitResponder('', ''));
    const onChange = vi.fn();
    const git = new FooterGit({ getFocusedCwd: async () => '/repo', onChange });

    git.update('/repo');
    await vi.advanceTimersByTimeAsync(GIT_DEBOUNCE_MS);
    expect(git.text).toBe('HEAD abc123');

    invokeMock.mockClear();
    git.update('/other');
    expect(git.text).toBeNull();
    git.update('/repo');
    expect(git.text).toBe('HEAD abc123');
    await vi.advanceTimersByTimeAsync(GIT_DEBOUNCE_MS);
    expect(invokeMock).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(GIT_CACHE_TTL_MS);
    git.update('/repo');
    await vi.advanceTimersByTimeAsync(GIT_DEBOUNCE_MS);
    expect(invokeMock).toHaveBeenCalled();
  });

  it('does not notify when focus moved to another folder', async () => {
    invokeMock.mockImplementation(gitResponder('main', ''));
    const onChange = vi.fn();
    const git = new FooterGit({ getFocusedCwd: async () => '/elsewhere', onChange });

    git.update('/repo');
    await vi.advanceTimersByTimeAsync(GIT_DEBOUNCE_MS);
    expect(onChange).not.toHaveBeenCalled();
    expect(git.text).toBeNull();
  });

  it('cancels the pending query on cwd change and dispose', async () => {
    invokeMock.mockImplementation(gitResponder('main', ''));
    const git = new FooterGit({ getFocusedCwd: async () => '/b', onChange: vi.fn() });

    git.update('/a');
    git.update(null);
    git.update('/b');
    git.dispose();
    await vi.advanceTimersByTimeAsync(GIT_DEBOUNCE_MS * 2);
    expect(invokeMock).not.toHaveBeenCalled();
  });

  it('treats a failing git as no repo', async () => {
    invokeMock.mockRejectedValue(new Error('not a repo'));
    const onChange = vi.fn();
    const git = new FooterGit({ getFocusedCwd: async () => '/tmp', onChange });

    git.update('/tmp');
    await vi.advanceTimersByTimeAsync(GIT_DEBOUNCE_MS);
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(git.text).toBeNull();
  });
});
