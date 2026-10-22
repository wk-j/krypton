import { describe, expect, it } from 'vitest';

import { ASSIST_LIMITS, ASSIST_MODES, resolveAssistConfig } from './config';
import { ASSIST_TASKS, assistTask } from './registry';

describe('ASSIST_TASKS', () => {
  it('is not empty and every id is a unique, non-empty `#assist` token', () => {
    expect(ASSIST_TASKS.length).toBeGreaterThan(0);
    const ids = ASSIST_TASKS.map((t) => t.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const id of ids) {
      expect(id).not.toBe('');
      expect(id).toMatch(/^[a-z0-9][a-z0-9-]*$/);
    }
  });

  it('every task carries a summary and a known surface', () => {
    for (const task of ASSIST_TASKS) {
      expect(['strip', 'panel', 'transcript']).toContain(task.surface);
      expect(task.summary.trim()).not.toBe('');
      expect(task.summary).not.toContain('\n');
    }
  });

  it('every task declares a valid default mode', () => {
    for (const task of ASSIST_TASKS) {
      if (task.defaults.mode !== undefined) expect(ASSIST_MODES).toContain(task.defaults.mode);
    }
  });

  it('every task default survives the config clamps unchanged', () => {
    for (const task of ASSIST_TASKS) {
      const resolved = resolveAssistConfig({}, task);
      const { timeoutMs, maxInputChars } = ASSIST_LIMITS;

      expect(resolved.timeoutMs).toBeGreaterThanOrEqual(timeoutMs.min);
      expect(resolved.timeoutMs).toBeLessThanOrEqual(timeoutMs.max);
      expect(resolved.maxInputChars).toBeGreaterThanOrEqual(maxInputChars.min);
      expect(resolved.maxInputChars).toBeLessThanOrEqual(maxInputChars.max);
      expect(resolved.backendId).not.toBe('');

      // A clamped default would mean the task ships a value it never gets.
      if (task.defaults.timeoutMs !== undefined) expect(resolved.timeoutMs).toBe(task.defaults.timeoutMs);
      if (task.defaults.maxInputChars !== undefined) expect(resolved.maxInputChars).toBe(task.defaults.maxInputChars);
      if (task.defaults.backendId !== undefined) expect(resolved.backendId).toBe(task.defaults.backendId);
      if (task.defaults.mode !== undefined) expect(resolved.mode).toBe(task.defaults.mode);
      expect(resolved.options).toMatchObject(task.defaults.options ?? {});
    }
  });

  it('assistTask looks a task up by id and rejects anything else', () => {
    for (const task of ASSIST_TASKS) expect(assistTask(task.id)).toBe(task);
    expect(assistTask('nope')).toBeUndefined();
    expect(assistTask('')).toBeUndefined();
  });
});

describe('resolveAssistConfig', () => {
  const task = ASSIST_TASKS[0];

  it('defaults to off with no config at all', () => {
    for (const raw of [undefined, null, {}, 'nonsense', { acp_harness: 7 }]) {
      expect(resolveAssistConfig(raw, task).mode).toBe('off');
    }
  });

  it('layers task defaults ← global ← per-task override', () => {
    const resolved = resolveAssistConfig({
      acp_harness: {
        assist: {
          mode: 'manual',
          backend: 'codex',
          model: 'haiku',
          timeout_ms: 9_000,
          tasks: { [task.id]: { mode: 'auto', count: 2, flag: true, note: 'hi' } },
        },
      },
    }, task);

    expect(resolved.mode).toBe('auto');
    expect(resolved.backendId).toBe('codex');
    expect(resolved.modelId).toBe('haiku');
    expect(resolved.timeoutMs).toBe(9_000);
    expect(resolved.options).toMatchObject({ count: 2, flag: true, note: 'hi' });
  });

  it('maps an empty model to undefined and clamps every budget field', () => {
    const resolved = resolveAssistConfig({
      acp_harness: {
        assist: {
          model: '',
          timeout_ms: 500_000,
          max_input_chars: 1,
        },
      },
    }, task);

    expect(resolved.modelId).toBeUndefined();
    expect(resolved.timeoutMs).toBe(ASSIST_LIMITS.timeoutMs.max);
    expect(resolved.maxInputChars).toBe(ASSIST_LIMITS.maxInputChars.min);
  });

  it('fails closed on an unknown mode and ignores non-scalar option values', () => {
    const resolved = resolveAssistConfig({
      acp_harness: {
        assist: {
          mode: 'auto',
          tasks: { [task.id]: { mode: 'loud', nested: { a: 1 }, list: [1, 2], ok: 5 } },
        },
      },
    }, task);

    expect(resolved.mode).toBe('off');
    expect(resolved.options.nested).toBeUndefined();
    expect(resolved.options.list).toBeUndefined();
    expect(resolved.options.ok).toBe(5);
  });
});
