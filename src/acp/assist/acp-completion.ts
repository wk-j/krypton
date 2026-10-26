// Krypton — harness assist sidecar (spec 306): the transport.
//
// The sidecar reaches a model the same way a lane does — through an ACP
// backend subprocess — so it needs no API key: the backend's own CLI login is
// the credential, and the call spends the same subscription the lane spends.
//
// One warm session per harness, reused across turns because the costs that
// hurt are the ones paid at setup: process spawn, `initialize`, `session/new`.
// It is deliberately fenced (`answerFencedRequest`): no MCP servers, every
// permission auto-declined, every file write refused, every question
// cancelled. A one-shot that needs a tool has already gone wrong.

import { AcpClient } from '../client';
import { answerFencedRequest } from '../headless-fence';
import type { AcpEvent, ContentBlock } from '../types';

import { AssistError } from './engine';
import type { AssistCompletion } from './engine';

export type AcpSpawn = (
  backendId: string,
  cwd: string | null,
  remoteRuntimeId: string | null,
) => Promise<AcpClient>;

export interface AcpAssistDeps {
  /** The harness project directory — the session's cwd. */
  projectDir(): string | null;
  /** Non-null on a remote harness (spec 247); the backend spawns there. */
  remoteRuntimeId(): string | null;
  spawn?: AcpSpawn;
}

const defaultSpawn: AcpSpawn = (backendId, cwd, remoteRuntimeId) =>
  AcpClient.spawn(backendId, cwd, [], null, null, remoteRuntimeId);

function errorText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/** One warm, fenced ACP session the assist engine prompts through. */
export class AcpAssistSession {
  private readonly deps: AcpAssistDeps;
  private readonly spawn: AcpSpawn;
  private client: AcpClient | null = null;
  /** `backendId\0modelId` of the live session; a change respawns it. */
  private key = '';
  private starting: Promise<AcpClient> | null = null;

  constructor(deps: AcpAssistDeps) {
    this.deps = deps;
    this.spawn = deps.spawn ?? defaultSpawn;
  }

  /** The engine's injected transport, bound so it can be passed as a value. */
  readonly complete: AssistCompletion = async (call) => {
    const client = await this.ensure(call.backendId, call.modelId);
    // The deadline fired during setup: do not spend a prompt on a dead call.
    if (call.signal.aborted) throw new DOMException('assist turn aborted', 'AbortError');
    call.ready();
    let text = '';
    const off = client.onEvent((event: AcpEvent) => {
      if (event.type === 'message_chunk') {
        if (event.content.type === 'text') text += event.text;
        return;
      }
      if (answerFencedRequest(client, event)) return;
      if (event.type === 'stop' && event.reason !== undefined) {
        // Rust only sets `reason` when the subprocess died; our own turn-end
        // event carries none. Drop the client so the next call respawns.
        this.forget(client);
      }
    });

    const blocks: ContentBlock[] = [{ type: 'text', text: `${call.system}\n\n${call.user}` }];
    const turn = client.prompt(blocks);
    try {
      const stopReason = await Promise.race([turn, abortRace(call.signal, client)]);
      if (stopReason !== 'end_turn') {
        throw new AssistError('unavailable', `assist turn stopped: ${stopReason}`);
      }
      return text;
    } catch (e) {
      if (e instanceof AssistError) throw e;
      if (call.signal.aborted) throw e;
      // A rejected prompt means the wire or the subprocess is gone.
      this.forget(client);
      throw new AssistError('unavailable', errorText(e));
    } finally {
      off();
      // The loser of the race must not surface as an unhandled rejection.
      void turn.catch(() => undefined);
    }
  };

  /** Kill the subprocess. The next call spawns a fresh one. */
  async dispose(): Promise<void> {
    const client = this.client;
    this.client = null;
    this.key = '';
    this.starting = null;
    if (client) await client.dispose();
  }

  private forget(client: AcpClient): void {
    if (this.client !== client) return;
    this.client = null;
    this.key = '';
    void client.dispose();
  }

  private ensure(backendId: string, modelId: string | undefined): Promise<AcpClient> {
    const key = `${backendId}\u0000${modelId ?? ''}`;
    if (this.client && this.key === key) return Promise.resolve(this.client);
    if (this.starting && this.key === key) return this.starting;
    const starting = this.start(backendId, modelId, key);
    this.key = key;
    this.starting = starting;
    return starting;
  }

  private async start(backendId: string, modelId: string | undefined, key: string): Promise<AcpClient> {
    await this.dispose();
    this.key = key;
    let client: AcpClient;
    try {
      client = await this.spawn(backendId, this.deps.projectDir(), this.deps.remoteRuntimeId());
    } catch (e) {
      this.key = '';
      this.starting = null;
      throw new AssistError('no-backend', `assist backend "${backendId}" did not start: ${errorText(e)}`);
    }
    try {
      await client.initializeOnly();
      await client.sessionNew();
      // `setLaneModel` throws when the agent rejects the id; a backend that
      // advertises no model state rejects every id, which is a config error.
      if (modelId) await client.setLaneModel(modelId);
    } catch (e) {
      await client.dispose();
      this.key = '';
      this.starting = null;
      const reason = modelId ? 'no-model' : 'no-backend';
      throw new AssistError(reason, `assist session on "${backendId}" failed: ${errorText(e)}`);
    }
    this.client = client;
    this.starting = null;
    return client;
  }
}

/** Rejects when the engine's deadline or `cancel()` fires, cancelling the turn. */
function abortRace(signal: AbortSignal, client: AcpClient): Promise<never> {
  return new Promise<never>((_resolve, reject) => {
    const abort = (): void => {
      void client.cancel().catch(() => undefined);
      reject(new DOMException('assist turn aborted', 'AbortError'));
    };
    if (signal.aborted) {
      abort();
      return;
    }
    signal.addEventListener('abort', abort, { once: true });
  });
}
