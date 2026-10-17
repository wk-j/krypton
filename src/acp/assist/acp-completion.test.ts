import { describe, expect, it } from 'vitest';

import type { AcpClient } from '../client';
import type { AcpEvent, StopReason } from '../types';

import { AcpAssistSession, type AcpSpawn } from './acp-completion';
import { AssistError } from './engine';

interface Deferred<T> {
  readonly promise: Promise<T>;
  resolve(value: T): void;
  reject(error: unknown): void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

/** A stand-in for the one ACP client the session owns. */
class FakeClient {
  readonly calls: string[] = [];
  private readonly listeners: Array<(e: AcpEvent) => void> = [];
  turn = deferred<StopReason>();
  modelError: Error | null = null;
  disposed = false;

  constructor(readonly backendId: string, private readonly onPrompt: () => void) {}

  async initializeOnly(): Promise<unknown> {
    this.calls.push('initialize');
    return {};
  }

  async sessionNew(): Promise<unknown> {
    this.calls.push('sessionNew');
    return { session_id: 'ses_1' };
  }

  async setLaneModel(modelId: string): Promise<'ok'> {
    this.calls.push(`setModel:${modelId}`);
    if (this.modelError) throw this.modelError;
    return 'ok';
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
    this.turn = deferred<StopReason>();
    this.onPrompt();
    return this.turn.promise;
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

function chunk(text: string): AcpEvent {
  return { type: 'message_chunk', text, content: { type: 'text', text } };
}

interface Harness {
  readonly session: AcpAssistSession;
  readonly spawned: FakeClient[];
  readonly spawnArgs: Array<{ backendId: string; cwd: string | null; remote: string | null }>;
  /** Resolves when the session has set a session up and issued `prompt`. */
  prompted(): Promise<FakeClient>;
}

function harness(options: {
  spawnError?: Error;
  onSpawn?: (client: FakeClient) => void;
} = {}): Harness {
  const spawned: FakeClient[] = [];
  const spawnArgs: Array<{ backendId: string; cwd: string | null; remote: string | null }> = [];
  let waiter: (() => void) | null = null;
  let pendingPrompt = false;

  const spawn: AcpSpawn = async (backendId, cwd, remoteRuntimeId) => {
    spawnArgs.push({ backendId, cwd, remote: remoteRuntimeId });
    if (options.spawnError) throw options.spawnError;
    const client = new FakeClient(backendId, () => {
      pendingPrompt = true;
      const resume = waiter;
      waiter = null;
      resume?.();
    });
    options.onSpawn?.(client);
    spawned.push(client);
    return client as unknown as AcpClient;
  };

  const session = new AcpAssistSession({
    projectDir: () => '/repo',
    remoteRuntimeId: () => null,
    spawn,
  });

  return {
    session,
    spawned,
    spawnArgs,
    async prompted(): Promise<FakeClient> {
      if (!pendingPrompt) await new Promise<void>((resolve) => { waiter = resolve; });
      pendingPrompt = false;
      return spawned[spawned.length - 1];
    },
  };
}

function call(
  session: AcpAssistSession,
  over: { backendId?: string; modelId?: string; signal?: AbortSignal; ready?: () => void } = {},
): Promise<string> {
  return session.complete({
    system: 'SYSTEM',
    user: 'USER',
    backendId: over.backendId ?? 'claude',
    modelId: 'modelId' in over ? over.modelId : 'haiku',
    signal: over.signal ?? new AbortController().signal,
    ready: over.ready ?? (() => undefined),
  });
}

describe('AcpAssistSession', () => {
  it('spawns once, sets the model, and returns the assistant text', async () => {
    const h = harness();
    const pending = call(h.session);
    const client = await h.prompted();

    client.emit(chunk('one '));
    client.emit({ type: 'thought_chunk', text: 'ignored' });
    client.emit(chunk('two'));
    client.turn.resolve('end_turn');

    expect(await pending).toBe('one two');
    expect(h.spawnArgs).toEqual([{ backendId: 'claude', cwd: '/repo', remote: null }]);
    expect(client.calls).toEqual(['initialize', 'sessionNew', 'setModel:haiku', 'prompt']);
  });

  it('reuses the warm session for the next turn', async () => {
    const h = harness();
    const first = call(h.session);
    (await h.prompted()).turn.resolve('end_turn');
    await first;

    const second = call(h.session);
    (await h.prompted()).turn.resolve('end_turn');
    await second;

    expect(h.spawned).toHaveLength(1);
    expect(h.spawned[0].calls.filter((c) => c === 'prompt')).toHaveLength(2);
  });

  it('respawns when the backend changes', async () => {
    const h = harness();
    const first = call(h.session);
    (await h.prompted()).turn.resolve('end_turn');
    await first;

    const second = call(h.session, { backendId: 'codex' });
    (await h.prompted()).turn.resolve('end_turn');
    await second;

    expect(h.spawned).toHaveLength(2);
    expect(h.spawned[0].disposed).toBe(true);
    expect(h.spawnArgs.map((a) => a.backendId)).toEqual(['claude', 'codex']);
  });

  it('declines every request the one-shot should never make', async () => {
    const h = harness();
    const pending = call(h.session);
    const client = await h.prompted();

    client.emit({ type: 'permission_request', requestId: 7, toolCall: {} as never, options: [] });
    client.emit({ type: 'fs_write_pending', requestId: 8, path: '/repo/a.ts', oldText: '', newText: 'x' });
    client.emit({ type: 'ask_user_question', requestId: 9, questions: [] });
    client.turn.resolve('end_turn');
    await pending;

    expect(client.calls).toContain('perm:7:null');
    expect(client.calls).toContain('fsWrite:8:false');
    expect(client.calls).toContain('cancel');
  });

  it('cancels the turn when the engine aborts, keeping the subprocess', async () => {
    const h = harness();
    const controller = new AbortController();
    const pending = call(h.session, { signal: controller.signal });
    const client = await h.prompted();

    controller.abort();
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    expect(client.calls).toContain('cancel');
    expect(client.disposed).toBe(false);
  });

  it('reports ready once the session is set up, before prompting', async () => {
    const h = harness();
    const seen: string[][] = [];
    const pending = call(h.session, { ready: () => seen.push([...h.spawned[0].calls]) });
    (await h.prompted()).turn.resolve('end_turn');
    await pending;

    expect(seen).toEqual([['initialize', 'sessionNew', 'setModel:haiku']]);
  });

  it('does not prompt when the deadline fired during setup', async () => {
    const h = harness();
    const controller = new AbortController();
    controller.abort();
    let ready = false;

    await expect(call(h.session, { signal: controller.signal, ready: () => { ready = true; } }))
      .rejects.toMatchObject({ name: 'AbortError' });
    expect(ready).toBe(false);
    expect(h.spawned[0].calls).not.toContain('prompt');
    expect(h.spawned[0].disposed).toBe(false);
  });

  it('reports a stop reason that is not end_turn as unavailable', async () => {
    const h = harness();
    const pending = call(h.session);
    (await h.prompted()).turn.resolve('refusal');

    await expect(pending).rejects.toMatchObject({ reason: 'unavailable' });
  });

  it('maps a failed spawn to no-backend', async () => {
    const h = harness({ spawnError: new Error('ENOENT') });
    const failure = call(h.session);

    await expect(failure).rejects.toBeInstanceOf(AssistError);
    await expect(call(h.session)).rejects.toMatchObject({ reason: 'no-backend' });
  });

  it('maps a rejected model id to no-model and kills the half-built session', async () => {
    const h = harness({ onSpawn: (client) => { client.modelError = new Error('unknown model'); } });

    await expect(call(h.session)).rejects.toMatchObject({ reason: 'no-model' });
    expect(h.spawned[0].disposed).toBe(true);
  });

  it('drops a client whose subprocess died and respawns on the next turn', async () => {
    const h = harness();
    const pending = call(h.session);
    const client = await h.prompted();

    client.emit({ type: 'stop', stopReason: 'cancelled', reason: 'backend exited' });
    client.turn.resolve('end_turn');
    await pending;

    const second = call(h.session);
    (await h.prompted()).turn.resolve('end_turn');
    await second;

    expect(h.spawned).toHaveLength(2);
  });

  it('kills the subprocess on dispose', async () => {
    const h = harness();
    const pending = call(h.session);
    (await h.prompted()).turn.resolve('end_turn');
    await pending;

    await h.session.dispose();
    expect(h.spawned[0].disposed).toBe(true);
  });
});
