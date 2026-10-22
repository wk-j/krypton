import { beforeEach, describe, expect, it, vi } from 'vitest';

const invokeMock = vi.hoisted(() => vi.fn());
vi.mock('@tauri-apps/api/core', () => ({ invoke: invokeMock }));
vi.mock('@tauri-apps/api/event', () => ({ listen: vi.fn(async () => () => {}) }));

import {
  backendUpdates,
  buildUpdateScript,
  checkBackendUpdates,
  describeBackendUpdates,
  onBackendUpdatesChange,
  type BackendUpdate,
} from './backend-updates';

const OMP: BackendUpdate = {
  backend_id: 'omp',
  display_name: 'OMP',
  installed: '18.12.6',
  latest: '18.13.0',
  update_command: 'omp update',
};
const GROK: BackendUpdate = {
  backend_id: 'grok',
  display_name: 'Grok',
  installed: '1.0.67',
  latest: '1.0.70',
  update_command: 'grok update',
};

beforeEach(() => {
  invokeMock.mockReset();
});

describe('buildUpdateScript', () => {
  it('runs every update command even after one fails, then waits for Enter', () => {
    const script = buildUpdateScript([OMP, GROK]);
    const ompAt = script.indexOf('; omp update;');
    const grokAt = script.indexOf('; grok update;');
    expect(ompAt).toBeGreaterThan(-1);
    expect(grokAt).toBeGreaterThan(ompAt);
    expect(script).not.toContain('&&');
    expect(script.endsWith('; read _')).toBe(true);
  });

  it("escapes a single quote in printed fields as '\\''", () => {
    const script = buildUpdateScript([{ ...OMP, display_name: "O'MP" }]);
    expect(script).toContain("'[krypton] O'\\''MP 18.12.6 -> 18.13.0'");
  });

  it('never puts data in a printf format string', () => {
    const script = buildUpdateScript([{ ...OMP, display_name: '%s %n O\'MP', installed: '%d' }, GROK]);
    const formats = [...script.matchAll(/printf (\S+)/g)].map((m) => m[1]);
    expect(formats.length).toBe(3);
    for (const format of formats) expect(format).toBe("'%s\\n'");
  });
});

describe('checkBackendUpdates', () => {
  it('replaces the snapshot and notifies on success, keeps it when invoke rejects', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const listener = vi.fn();
    const unsubscribe = onBackendUpdatesChange(listener);

    invokeMock.mockResolvedValueOnce([OMP]);
    await checkBackendUpdates();
    expect(invokeMock).toHaveBeenCalledWith('acp_backend_updates');
    expect(backendUpdates()).toEqual([OMP]);
    expect(listener).toHaveBeenCalledTimes(1);

    invokeMock.mockRejectedValueOnce(new Error('offline'));
    await checkBackendUpdates();
    expect(backendUpdates()).toEqual([OMP]);
    expect(listener).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalled();

    unsubscribe();
    warn.mockRestore();
  });

  it('shares one in-flight request between concurrent calls', async () => {
    invokeMock.mockResolvedValueOnce([]);
    await Promise.all([checkBackendUpdates(), checkBackendUpdates()]);
    expect(invokeMock).toHaveBeenCalledTimes(1);
    expect(backendUpdates()).toEqual([]);
  });
});
