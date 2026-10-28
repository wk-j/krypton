// Krypton — harness assist sidecar (spec 306): the guard layer around one
// model call. Single-flight harness-wide, with the deadline, the byte caps and
// the per-task circuit breaker. The call itself is injected — `AcpAssistSession`
// in the app, a stub in tests — so nothing here knows about ACP either.

import type { AssistCall, AssistFailure, AssistTaskConfig } from './types';

export type AssistCompletion = (call: {
  system: string;
  user: string;
  backendId: string;
  modelId: string | undefined;
  signal: AbortSignal;
  /** The transport's session is set up; the deadline restarts for the call. */
  ready(): void;
}) => Promise<string>;

export type AssistRun<T> = { ok: true; value: T } | { ok: false; reason: AssistFailure };

/** A failure the engine can classify. Anything else maps to `'unavailable'`. */
export class AssistError extends Error {
  readonly reason: AssistFailure;

  constructor(reason: AssistFailure, message: string) {
    super(message);
    this.name = 'AssistError';
    this.reason = reason;
  }
}

const SOFT_FAILURES_BEFORE_COOLDOWN = 3;
const SOFT_COOLDOWN_MS = 5 * 60_000;
const HARD_COOLDOWN_MS = 10 * 60_000;

export class AssistEngine {
  private readonly complete: AssistCompletion;
  private readonly now: () => number;
  /** Monotonic, bumped by every run and by `cancel()`. */
  private generation = 0;
  private controller: AbortController | null = null;
  private readonly softFailures = new Map<string, number>();
  private readonly cooldowns = new Map<string, number>();

  constructor(complete: AssistCompletion, now: () => number = Date.now) {
    this.complete = complete;
    this.now = now;
  }

  /** Run one call. The breaker is keyed by `call.id`. */
  async run<T, C>(call: AssistCall<T, C>, ctx: C, cfg: AssistTaskConfig): Promise<AssistRun<T>> {
    const budget = { maxInputChars: cfg.maxInputChars, timeoutMs: cfg.timeoutMs };
    // The call bounds its own payload; this is the backstop.
    const built = call.payload(ctx, budget);
    const user = built.length > cfg.maxInputChars ? built.slice(0, cfg.maxInputChars) : built;

    // Single flight: the previous call loses, this one wins.
    this.controller?.abort();
    const generation = ++this.generation;
    const controller = new AbortController();
    this.controller = controller;

    let deadlineHit = false;
    const arm = (): ReturnType<typeof setTimeout> =>
      setTimeout(() => {
        deadlineHit = true;
        controller.abort();
      }, cfg.timeoutMs);
    // The first window bounds the transport's setup; `ready()` opens a fresh
    // one for the model call, so a cold spawn does not eat the model's budget.
    let timer = arm();

    try {
      const raw = await this.complete({
        system: call.system(cfg),
        user,
        backendId: cfg.backendId,
        modelId: cfg.modelId,
        signal: controller.signal,
        ready: () => {
          if (controller.signal.aborted) return;
          clearTimeout(timer);
          timer = arm();
        },
      });
      const value = call.parse(raw, cfg, ctx);
      if (value === null) return this.record(call.id, 'invalid');
      this.softFailures.set(call.id, 0);
      this.cooldowns.set(call.id, 0);
      return { ok: true, value };
    } catch (e) {
      if (e instanceof AssistError) return this.record(call.id, e.reason);
      if (deadlineHit) return this.record(call.id, 'timeout');
      if (controller.signal.aborted) {
        // Aborted by `cancel()` or by a superseding run — not the model's
        // fault, and the caller discards a superseded result anyway, so this
        // must never feed the breaker.
        return { ok: false, reason: 'timeout' };
      }
      return this.record(call.id, 'unavailable');
    } finally {
      clearTimeout(timer);
      if (this.generation === generation) this.controller = null;
    }
  }

  /** Abort the in-flight call and bump the generation. */
  cancel(): void {
    this.generation++;
    this.controller?.abort();
    this.controller = null;
  }

  /** Epoch ms until which `taskId` is suppressed; 0 when the breaker is closed. */
  cooldownUntil(taskId: string): number {
    const until = this.cooldowns.get(taskId) ?? 0;
    return until > this.now() ? until : 0;
  }

  /** `#assist <task> auto|manual` re-arms a tripped breaker. */
  clearCooldown(taskId: string): void {
    this.cooldowns.set(taskId, 0);
    this.softFailures.set(taskId, 0);
  }

  private record<T>(taskId: string, reason: AssistFailure): AssistRun<T> {
    if (reason === 'no-backend' || reason === 'no-model') {
      // Hard: retrying cannot help until the user changes the config.
      this.cooldowns.set(taskId, this.now() + HARD_COOLDOWN_MS);
      this.softFailures.set(taskId, 0);
      return { ok: false, reason };
    }
    const count = (this.softFailures.get(taskId) ?? 0) + 1;
    if (count >= SOFT_FAILURES_BEFORE_COOLDOWN) {
      this.cooldowns.set(taskId, this.now() + SOFT_COOLDOWN_MS);
      this.softFailures.set(taskId, 0);
    } else {
      this.softFailures.set(taskId, count);
    }
    return { ok: false, reason };
  }
}
