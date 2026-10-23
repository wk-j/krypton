import { describe, expect, it, vi } from 'vitest';

import { AssistEngine, AssistError, type AssistCompletion } from './engine';
import type { AssistContext, AssistTask, AssistTaskConfig } from './types';

const FIVE_MIN = 5 * 60_000;
const TEN_MIN = 10 * 60_000;

/** The engine is task-agnostic, so the suite never imports a real task. */
const fakeTask: AssistTask<string> = {
  id: 'test',
  summary: 'fake task',
  surface: 'panel',
  onTurnEnd: true,
  defaults: {},
  system: () => 'system prompt',
  payload: (ctx) => `payload:${ctx.laneId}`,
  parse: (raw) => (raw.trim() === '' ? null : raw.trim()),
};

function ctx(over: Partial<AssistContext> = {}): AssistContext {
  return {
    laneId: 'lane-1',
    laneName: 'OMP-1',
    backendId: 'omp',
    modelName: 'claude-opus-5',
    projectDir: '/Users/wk/Source/krypton',
    turn: [],
    ...over,
  };
}

function cfg(over: Partial<AssistTaskConfig> = {}): AssistTaskConfig {
  return {
    mode: 'auto',
    backendId: 'claude',
    modelId: undefined,
    options: {},
    maxInputChars: 1_000,
    timeoutMs: 1_000,
    ...over,
  };
}

/** Rejects as soon as the engine's signal aborts — what a real client does. */
const hangs: AssistCompletion = (call) => new Promise<string>((_resolve, reject) => {
  call.signal.addEventListener('abort', () => reject(new Error('aborted')));
});

function clocked(complete: AssistCompletion): { engine: AssistEngine; at: (ms: number) => void; now: () => number } {
  let clock = 1_000_000;
  const engine = new AssistEngine(complete, () => clock);
  return { engine, at: (ms: number) => { clock = ms; }, now: () => clock };
}

describe('AssistEngine.run', () => {
  it('bounds the payload at maxInputChars as a backstop', async () => {
    const seen: string[] = [];
    const engine = new AssistEngine(async (call) => { seen.push(call.user); return 'ok'; });
    const greedy: AssistTask<string> = { ...fakeTask, payload: () => 'x'.repeat(50) };

    await engine.run(greedy, ctx(), cfg({ maxInputChars: 10 }));

    expect(seen).toEqual(['xxxxxxxxxx']);
  });

  it('passes the task system prompt and the ACP target through', async () => {
    const calls: Array<{ system: string; backendId: string; modelId: string | undefined }> = [];
    const engine = new AssistEngine(async (call) => {
      calls.push({ system: call.system, backendId: call.backendId, modelId: call.modelId });
      return 'done';
    });

    const run = await engine.run(fakeTask, ctx(), cfg({ backendId: 'codex', modelId: 'haiku' }));

    expect(run).toEqual({ ok: true, value: 'done' });
    expect(calls).toEqual([{ system: 'system prompt', backendId: 'codex', modelId: 'haiku' }]);
  });

  it('maps a null parse to invalid', async () => {
    const engine = new AssistEngine(async () => '   ');
    expect(await engine.run(fakeTask, ctx(), cfg())).toEqual({ ok: false, reason: 'invalid' });
  });

  it('maps an unknown throw to unavailable', async () => {
    const engine = new AssistEngine(async () => { throw new Error('socket closed'); });
    expect(await engine.run(fakeTask, ctx(), cfg())).toEqual({ ok: false, reason: 'unavailable' });
  });

  it('aborts at the deadline and reports timeout', async () => {
    const { engine } = clocked(hangs);
    expect(await engine.run(fakeTask, ctx(), cfg({ timeoutMs: 5 }))).toEqual({ ok: false, reason: 'timeout' });
  });

  it('restarts the deadline once the transport is ready, so a cold start does not eat it', async () => {
    vi.useFakeTimers();
    try {
      const engine = new AssistEngine((call) => new Promise<string>((resolve, reject) => {
        call.signal.addEventListener('abort', () => reject(new Error('aborted')));
        setTimeout(() => {
          call.ready();
          setTimeout(() => resolve('answer'), 800);
        }, 800);
      }));

      const run = engine.run(fakeTask, ctx(), cfg({ timeoutMs: 1_000 }));
      await vi.advanceTimersByTimeAsync(1_600);

      expect(await run).toEqual({ ok: true, value: 'answer' });
    } finally {
      vi.useRealTimers();
    }
  });

  it('supersedes an in-flight run, which resolves as timeout without tripping the breaker', async () => {
    let calls = 0;
    const { engine } = clocked((call) => {
      if (calls++ === 0) {
        return new Promise<string>((_resolve, reject) => {
          call.signal.addEventListener('abort', () => reject(new Error('aborted')));
        });
      }
      return Promise.resolve('second');
    });

    const first = engine.run(fakeTask, ctx(), cfg());
    const second = await engine.run(fakeTask, ctx(), cfg());

    expect(second).toEqual({ ok: true, value: 'second' });
    expect(await first).toEqual({ ok: false, reason: 'timeout' });
    expect(engine.cooldownUntil('test')).toBe(0);
  });
});

describe('AssistEngine breaker', () => {
  it('opens a ten-minute cooldown on a hard failure', async () => {
    const { engine, now } = clocked(async () => {
      throw new AssistError('no-backend', 'assist backend "claude" did not start');
    });

    expect(await engine.run(fakeTask, ctx(), cfg())).toEqual({ ok: false, reason: 'no-backend' });
    expect(engine.cooldownUntil('test')).toBe(now() + TEN_MIN);
  });

  it('opens a five-minute cooldown on the third soft failure', async () => {
    const { engine, now } = clocked(async () => { throw new Error('nope'); });

    await engine.run(fakeTask, ctx(), cfg());
    expect(engine.cooldownUntil('test')).toBe(0);
    await engine.run(fakeTask, ctx(), cfg());
    expect(engine.cooldownUntil('test')).toBe(0);
    await engine.run(fakeTask, ctx(), cfg());

    expect(engine.cooldownUntil('test')).toBe(now() + FIVE_MIN);
  });

  it('reports a closed breaker once the cooldown has elapsed', async () => {
    const { engine, at, now } = clocked(async () => {
      throw new AssistError('no-model', 'Unknown model preset "haiku".');
    });
    const start = now();

    await engine.run(fakeTask, ctx(), cfg());
    at(start + TEN_MIN);

    expect(engine.cooldownUntil('test')).toBe(0);
  });

  it('resets the soft counter on success', async () => {
    let fail = true;
    const { engine } = clocked(async () => {
      if (fail) throw new Error('nope');
      return 'ok';
    });

    await engine.run(fakeTask, ctx(), cfg());
    await engine.run(fakeTask, ctx(), cfg());
    fail = false;
    await engine.run(fakeTask, ctx(), cfg());
    fail = true;
    await engine.run(fakeTask, ctx(), cfg());
    await engine.run(fakeTask, ctx(), cfg());

    expect(engine.cooldownUntil('test')).toBe(0);
  });

  it('does not count a cancel() against the breaker', async () => {
    let fail = false;
    const { engine } = clocked((call) => {
      if (!fail) {
        return new Promise<string>((_resolve, reject) => {
          call.signal.addEventListener('abort', () => reject(new Error('aborted')));
        });
      }
      return Promise.reject(new Error('nope'));
    });

    const cancelled = engine.run(fakeTask, ctx(), cfg());
    engine.cancel();
    expect(await cancelled).toEqual({ ok: false, reason: 'timeout' });

    // Two real soft failures after the cancel must still leave the breaker shut.
    fail = true;
    await engine.run(fakeTask, ctx(), cfg());
    await engine.run(fakeTask, ctx(), cfg());

    expect(engine.cooldownUntil('test')).toBe(0);
  });

  it('clearCooldown re-arms a tripped task', async () => {
    const { engine } = clocked(async () => {
      throw new AssistError('no-backend', 'assist backend "claude" did not start');
    });

    await engine.run(fakeTask, ctx(), cfg());
    expect(engine.cooldownUntil('test')).toBeGreaterThan(0);

    engine.clearCooldown('test');

    expect(engine.cooldownUntil('test')).toBe(0);
  });
});
