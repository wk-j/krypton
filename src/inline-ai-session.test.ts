import { afterEach, describe, expect, it, vi } from 'vitest';

import type { AcpClient } from './acp/client';
import type { AcpEvent, StopReason } from './acp/types';
import type { InlineAiConfig } from './config';
import {
  InlineAcpSession,
  InlineAiError,
  type InlineAcpConversation,
  type InlineAcpSpawn,
  type InlineTurnEvent,
} from './inline-ai-session';

interface Deferred<T> {
  readonly promise: Promise<T>;
  resolve(value: T): void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => { resolve = res; });
  return { promise, resolve };
}

/** A stand-in for the ACP client one backend process owns. */
class FakeClient {
  readonly calls: string[] = [];
  readonly turns: Array<Deferred<StopReason>> = [];
  private readonly listeners: Array<(e: AcpEvent) => void> = [];
  modeError: Error | null = null;
  disposed = false;
  private promptWaiter: (() => void) | null = null;

  async initializeOnly(): Promise<unknown> {
    this.calls.push('initialize');
    return {};
  }

  async sessionNew(): Promise<unknown> {
    this.calls.push('sessionNew');
    return { session_id: `ses_${this.calls.length}` };
  }

  async setLaneModel(modelId: string): Promise<'ok'> {
    this.calls.push(`model:${modelId}`);
    return 'ok';
  }

  async setSessionMode(modeId: string): Promise<void> {
    this.calls.push(`mode:${modeId}`);
    if (this.modeError) throw this.modeError;
  }

  onEvent(cb: (e: AcpEvent) => void): () => void {
    this.listeners.push(cb);
    return () => {
      const i = this.listeners.indexOf(cb);
      if (i >= 0) this.listeners.splice(i, 1);
    };
  }

  emit(event: AcpEvent): void {
    for (const cb of this.listeners.slice()) cb(event);
  }

  prompt(): Promise<StopReason> {
    this.calls.push('prompt');
    const turn = deferred<StopReason>();
    this.turns.push(turn);
    const waiter = this.promptWaiter;
    this.promptWaiter = null;
    waiter?.();
    return turn.promise;
  }

  /** Resolves once the next (or an already issued, unawaited) prompt is on the wire. */
  async prompted(count: number): Promise<Deferred<StopReason>> {
    while (this.turns.length < count) {
      await new Promise<void>((resolve) => { this.promptWaiter = resolve; });
    }
    return this.turns[count - 1];
  }

  async cancel(): Promise<void> {
    this.calls.push('cancel');
  }

  async respondPermission(requestId: number, optionId: string | null): Promise<void> {
    this.calls.push(`perm:${requestId}:${optionId ?? 'null'}`);
  }

  async respondFsWrite(requestId: number, accept: boolean): Promise<void> {
    this.calls.push(`fsWrite:${requestId}:${accept}`);
  }

  async dispose(): Promise<void> {
    this.disposed = true;
    this.calls.push('dispose');
  }
}

const CFG: InlineAiConfig = { backend: 'claude', model: 'haiku', mode: 'default', context: true, follow_up: true };

function chunk(text: string): AcpEvent {
  return { type: 'message_chunk', text, content: { type: 'text', text } };
}

interface Harness {
  readonly session: InlineAcpSession;
  readonly spawned: FakeClient[];
  readonly spawnArgs: Array<{ backend: string; cwd: string | null }>;
  /** Resolves with the `n`th spawned client (1-based) once it exists. */
  nthClient(n: number): Promise<FakeClient>;
}

function harness(
  options: { spawnError?: Error; graceMs?: number; onSpawn?: (c: FakeClient) => void } = {},
): Harness {
  const spawned: FakeClient[] = [];
  const spawnArgs: Array<{ backend: string; cwd: string | null }> = [];
  const spawnWaiters: Array<() => void> = [];
  const spawn: InlineAcpSpawn = async (backend, cwd) => {
    spawnArgs.push({ backend, cwd });
    if (options.spawnError) throw options.spawnError;
    const client = new FakeClient();
    options.onSpawn?.(client);
    spawned.push(client);
    for (const wake of spawnWaiters.splice(0)) wake();
    return client as unknown as AcpClient;
  };
  const session = new InlineAcpSession({ spawn, graceMs: options.graceMs ?? 1_000 });
  async function nthClient(n: number): Promise<FakeClient> {
    while (spawned.length < n) {
      await new Promise<void>((resolve) => { spawnWaiters.push(resolve); });
    }
    return spawned[n - 1];
  }
  return { session, spawned, spawnArgs, nthClient };
}

afterEach(() => {
  vi.useRealTimers();
});

/** Run one prompt to `end_turn` on the conversation, on the `nth` client. */
async function completeTurn(
  h: Harness,
  conversation: InlineAcpConversation,
  nth: number,
  turnIndex: number,
): Promise<void> {
  const turn = conversation.prompt('x', () => undefined);
  (await (await h.nthClient(nth)).prompted(turnIndex)).resolve('end_turn');
  await turn;
}

/** Let every queued microtask chain run without advancing any clock. */
async function settleMicrotasks(): Promise<void> {
  for (let i = 0; i < 50; i++) await Promise.resolve();
}

describe('InlineAcpSession', () => {
  it('opens a fresh session per Cmd+K on one warm process, applying model and mode each time', async () => {
    const h = harness();
    await completeTurn(h, h.session.open(CFG, '/repo'), 1, 1);
    await completeTurn(h, h.session.open(CFG, '/repo'), 1, 2);

    expect(h.spawned).toHaveLength(1);
    expect(h.spawned[0].calls).toEqual([
      'initialize',
      'sessionNew', 'model:haiku', 'mode:default', 'prompt',
      'sessionNew', 'model:haiku', 'mode:default', 'prompt',
    ]);
  });

  it('keeps follow-up questions of one overlay on its session', async () => {
    const h = harness();
    const conversation = h.session.open(CFG, '/repo');
    await completeTurn(h, conversation, 1, 1);
    await completeTurn(h, conversation, 1, 2);

    expect(h.spawned[0].calls.filter((c) => c === 'sessionNew')).toHaveLength(1);
  });

  it('skips model and mode when configured empty', async () => {
    const h = harness();
    await completeTurn(h, h.session.open({ ...CFG, backend: 'omp', model: '', mode: '' }, '/repo'), 1, 1);

    expect(h.spawned[0].calls).toEqual(['initialize', 'sessionNew', 'prompt']);
  });

  it('respawns when the pane cwd or the backend changes', async () => {
    const h = harness();
    await completeTurn(h, h.session.open(CFG, '/repo'), 1, 1);
    await completeTurn(h, h.session.open(CFG, '/other'), 2, 1);
    await completeTurn(h, h.session.open({ ...CFG, backend: 'codex' }, '/other'), 3, 1);

    expect(h.spawnArgs).toEqual([
      { backend: 'claude', cwd: '/repo' },
      { backend: 'claude', cwd: '/other' },
      { backend: 'codex', cwd: '/other' },
    ]);
    expect(h.spawned.map((c) => c.disposed)).toEqual([true, true, false]);
  });

  it('never starts a backend for an overlay closed before setup ran', async () => {
    const h = harness();
    h.session.open(CFG, '/repo').close();
    await completeTurn(h, h.session.open(CFG, '/repo'), 1, 1);

    expect(h.spawned).toHaveLength(1);
    expect(h.spawned[0].calls.filter((c) => c === 'sessionNew')).toHaveLength(1);
  });

  it('streams chunks and tool titles after the Starting and Thinking statuses', async () => {
    const h = harness();
    const events: InlineTurnEvent[] = [];
    const turn = h.session.open(CFG, '/repo').prompt('x', (e) => events.push(e));
    const client = await h.nthClient(1);
    const wire = await client.prompted(1);
    client.emit({ type: 'tool_call', call: { toolCallId: 't1', title: 'Terminal' } });
    client.emit({ type: 'thought_chunk', text: 'hidden' });
    client.emit(chunk('git commit'));
    wire.resolve('end_turn');
    await turn;

    expect(events).toEqual([
      { type: 'status', text: 'Starting claude...' },
      { type: 'status', text: 'Thinking...' },
      { type: 'tool', title: 'Terminal' },
      { type: 'chunk', text: 'git commit' },
    ]);
  });

  it('declines every request the backend raises, even after the turn settled', async () => {
    const h = harness();
    const turn = h.session.open(CFG, '/repo').prompt('x', () => undefined);
    const client = await h.nthClient(1);
    const wire = await client.prompted(1);
    client.emit({ type: 'permission_request', requestId: 7, toolCall: { toolCallId: 't' }, options: [] });
    client.emit({ type: 'fs_write_pending', requestId: 8, path: '/repo/a', oldText: '', newText: 'x' });
    client.emit({ type: 'elicitation_request', requestId: 9, message: 'pick', requestedSchema: {} });
    wire.resolve('end_turn');
    await turn;
    client.emit({ type: 'permission_request', requestId: 10, toolCall: { toolCallId: 't' }, options: [] });

    expect(client.calls).toEqual(expect.arrayContaining(['perm:7:null', 'fsWrite:8:false', 'cancel', 'perm:10:null']));
  });

  it('cancels on close and holds the next session/new until the cancelled turn settles', async () => {
    const h = harness();
    const events: InlineTurnEvent[] = [];
    const first = h.session.open(CFG, '/repo');
    const turn = first.prompt('x', (e) => events.push(e));
    const client = await h.nthClient(1);
    const wire = await client.prompted(1);

    first.close();
    expect(client.calls).toContain('cancel');
    const late = h.session.open(CFG, '/repo').prompt('y', () => undefined);
    await settleMicrotasks();
    expect(client.calls.filter((c) => c === 'sessionNew')).toHaveLength(1);

    client.emit(chunk('late text'));
    wire.resolve('cancelled');
    await expect(turn).rejects.toBeInstanceOf(InlineAiError);
    (await client.prompted(2)).resolve('end_turn');
    await late;

    expect(events.some((e) => e.type === 'chunk')).toBe(false);
    expect(client.calls.filter((c) => c === 'sessionNew')).toHaveLength(2);
  });

  it('kills a process whose cancelled turn never settles and respawns for the next Cmd+K', async () => {
    vi.useFakeTimers();
    const h = harness({ graceMs: 1_000 });
    const first = h.session.open(CFG, '/repo');
    const turn = first.prompt('x', () => undefined);
    await (await h.nthClient(1)).prompted(1);
    first.close();
    const rejected = expect(turn).rejects.toThrow('cancelled');
    await vi.advanceTimersByTimeAsync(1_000);
    await rejected;

    await completeTurn(h, h.session.open(CFG, '/repo'), 2, 1);

    expect(h.spawned.map((c) => c.disposed)).toEqual([true, false]);
  });

  it('names the backend when it does not start', async () => {
    const h = harness({ spawnError: new Error('ENOENT') });
    const conversation = h.session.open(CFG, '/repo');

    await expect(conversation.prompt('x', () => undefined)).rejects.toThrow('inline AI: "claude" did not start — ENOENT');
  });

  it('reports a rejected mode and keeps the process', async () => {
    const h = harness({ onSpawn: (c) => { c.modeError = new Error('unknown mode'); } });
    const conversation = h.session.open(CFG, '/repo');

    await expect(conversation.prompt('x', () => undefined)).rejects.toThrow('rejected mode "default"');
    expect(h.spawned[0].disposed).toBe(false);
  });

  it('respawns after the subprocess died between turns', async () => {
    const h = harness();
    await completeTurn(h, h.session.open(CFG, '/repo'), 1, 1);
    h.spawned[0].emit({ type: 'stop', stopReason: 'cancelled', reason: 'backend exited' });
    await completeTurn(h, h.session.open(CFG, '/repo'), 2, 1);

    expect(h.spawned.map((c) => c.disposed)).toEqual([true, false]);
  });
});
