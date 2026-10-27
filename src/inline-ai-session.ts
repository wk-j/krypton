// Krypton — Inline AI transport (spec 333).
//
// Inline AI reaches its model through an ACP backend subprocess — the same
// path the Harness lanes use — so the backend CLI's own login is the
// credential and no API key is needed.
//
// One warm process per backend + pane cwd (the session cwd and the fs scope
// are fixed at spawn in Rust). Every Cmd+K opens a fresh ACP session on it, so
// an earlier query never leaks into the next one; follow-up questions inside
// one overlay share that session. All work on the process runs through one
// serial queue: Krypton tracks a single current session id per process, so a
// `session/new` must never land while another conversation's turn is still
// streaming.

import { AcpClient } from './acp/client';
import { answerFencedRequest } from './acp/headless-fence';
import type { AcpEvent, AcpMcpServerDescriptor, StopReason } from './acp/types';
import type { InlineAiConfig } from './config';
import { INLINE_HOST_EXEC, hostExecCommand } from './inline-ai-remote';

export type InlineTurnEvent =
  | { type: 'status'; text: string }
  /** `command` is set for a `host_exec` call (spec 336). */
  | { type: 'tool'; title: string; command: string | null }
  | { type: 'chunk'; text: string };

/** A failure whose message is shown verbatim in the overlay. */
export class InlineAiError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InlineAiError';
  }
}

export type InlineAcpSpawn = (backendId: string, cwd: string | null) => Promise<AcpClient>;

export interface InlineAcpConversation {
  /** One turn on this conversation's session. Resolves on `end_turn`. */
  prompt(text: string, onEvent: (e: InlineTurnEvent) => void): Promise<void>;
  /** Escape/close: cancel a running turn and drop every later event. */
  close(): void;
}

/** How long a closed conversation's turn may take to honour `session/cancel`
 *  before its process is killed, so the next Cmd+K is not stuck behind it. */
export const CANCEL_GRACE_MS = 5_000;

const ABANDONED = Symbol('abandoned');

function errorText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

export class InlineAcpSession {
  private readonly spawn: InlineAcpSpawn;
  private readonly graceMs: number;
  private client: AcpClient | null = null;
  /** `backend\0cwd` of the live process; a change respawns it. */
  private key = '';
  private tail: Promise<unknown> = Promise.resolve();
  private current: Conversation | null = null;

  constructor(deps: { spawn?: InlineAcpSpawn; graceMs?: number } = {}) {
    this.spawn = deps.spawn ?? ((backendId, cwd) => AcpClient.spawn(backendId, cwd, []));
    this.graceMs = deps.graceMs ?? CANCEL_GRACE_MS;
  }

  /** Called on Cmd+K. Supersedes the previous conversation and prepares a
   *  fresh session in the background; returns at once. `mcp` resolves to the
   *  session's MCP servers (spec 336: `host_exec` in an SSH pane); none by default. */
  open(cfg: InlineAiConfig, cwd: string | null, mcp?: Promise<AcpMcpServerDescriptor[]>): InlineAcpConversation {
    this.current?.close();
    const conversation = new Conversation(this, { ...cfg }, cwd, mcp ?? Promise.resolve([]), this.graceMs);
    this.current = conversation;
    conversation.ready = this.enqueue(() => this.setup(conversation));
    // Errors surface through `prompt()`; an overlay closed before submitting
    // never asks, so the rejection must not go unhandled here.
    conversation.ready.then(() => { conversation.isReady = true; }, () => undefined);
    return conversation;
  }

  /** Serial queue: one setup or turn at a time on the process. */
  enqueue<T>(op: () => Promise<T>): Promise<T> {
    const run = this.tail.then(op);
    this.tail = run.catch(() => undefined);
    return run;
  }

  /** One turn, run inside the queue by `Conversation.prompt`. */
  async runTurn(
    conversation: Conversation,
    client: AcpClient,
    text: string,
    onEvent: (e: InlineTurnEvent) => void,
  ): Promise<void> {
    if (conversation.closed) throw new InlineAiError('inline AI: closed');
    const { backend } = conversation.cfg;
    if (this.client !== client) {
      throw new InlineAiError(`inline AI: "${backend}" exited — press Cmd+K again`);
    }
    const off = client.onEvent((event: AcpEvent) => {
      if (conversation.closed) return;
      if (event.type === 'message_chunk') {
        if (event.content.type === 'text' && event.text) onEvent({ type: 'chunk', text: event.text });
      } else if (event.type === 'tool_call') {
        const { title, rawInput } = event.call;
        onEvent({ type: 'tool', title: title ?? 'tool', command: hostExecCommand(title, rawInput) });
      } else if (event.type === 'permission_request') {
        // claude-agent-acp sends host_exec's input with its permission request;
        // its `tool_call` arrives with an empty one (spec 336 smoke).
        const { title, rawInput } = event.toolCall;
        const command = hostExecCommand(title, rawInput);
        if (command !== null) onEvent({ type: 'tool', title: title ?? 'tool', command });
      }
    });
    onEvent({ type: 'status', text: 'Thinking...' });
    const turn = client.prompt([{ type: 'text', text }]);
    conversation.activeTurn = client;
    try {
      const stop: StopReason | typeof ABANDONED = await Promise.race([turn, conversation.abandoned]);
      if (stop === ABANDONED) {
        // The agent ignored `session/cancel`; kill it rather than block the
        // next conversation behind a turn that may never end.
        this.forget(client);
        throw new InlineAiError('inline AI: cancelled');
      }
      if (stop !== 'end_turn') throw new InlineAiError(`inline AI: turn stopped (${stop})`);
    } catch (e) {
      if (e instanceof InlineAiError) throw e;
      // A rejected prompt means the wire or the subprocess is gone.
      this.forget(client);
      throw new InlineAiError(`inline AI: "${backend}" failed — ${errorText(e)}`);
    } finally {
      conversation.activeTurn = null;
      off();
      void turn.catch(() => undefined);
    }
  }

  /** Conversation setup: process, fresh session, model, agent-side mode. */
  private async setup(conversation: Conversation): Promise<AcpClient> {
    if (conversation.closed) throw new InlineAiError('inline AI: closed');
    const { backend, model, mode } = conversation.cfg;
    const client = await this.ensure(backend, conversation.cwd);
    // The process outlives conversations: every session sets its own list, so
    // a local pane after an SSH pane gets none again.
    const servers = await conversation.mcp;
    if (conversation.closed) throw new InlineAiError('inline AI: closed');
    try {
      await client.setMcpServers(servers);
      await client.sessionNew();
    } catch (e) {
      this.forget(client);
      throw new InlineAiError(`inline AI: "${backend}" did not start — ${errorText(e)}`);
    }
    if (model) {
      try {
        await client.setLaneModel(model);
      } catch {
        throw new InlineAiError(
          `inline AI: "${backend}" rejected model "${model}" — set [inline_ai] model = ""`,
        );
      }
    }
    // The user's own default mode may approve commands without asking (e.g.
    // Claude `auto`), and then the fence never sees them. `default` makes
    // every state-changing command raise a request the fence declines.
    if (mode) {
      try {
        await client.setSessionMode(mode);
      } catch {
        throw new InlineAiError(
          `inline AI: "${backend}" rejected mode "${mode}" — set [inline_ai] mode = ""`,
        );
      }
    }
    return client;
  }

  private async ensure(backend: string, cwd: string | null): Promise<AcpClient> {
    const key = `${backend}\u0000${cwd ?? ''}`;
    if (this.client && this.key === key) return this.client;
    if (this.client) this.forget(this.client);
    let client: AcpClient;
    try {
      client = await this.spawn(backend, cwd);
    } catch (e) {
      throw new InlineAiError(`inline AI: "${backend}" did not start — ${errorText(e)}`);
    }
    try {
      await client.initializeOnly();
    } catch (e) {
      void client.dispose();
      throw new InlineAiError(`inline AI: "${backend}" did not start — ${errorText(e)}`);
    }
    // Lives as long as the process: the fence must answer a request even
    // after the turn that raised it settled, and a death between turns must
    // drop the client so the next Cmd+K respawns.
    client.onEvent((event: AcpEvent) => {
      if (answerFencedRequest(client, event, INLINE_HOST_EXEC)) return;
      // Rust sets `reason` only when the subprocess died.
      if (event.type === 'stop' && event.reason !== undefined) this.forget(client);
    });
    this.client = client;
    this.key = key;
    return client;
  }

  private forget(client: AcpClient): void {
    if (this.client === client) {
      this.client = null;
      this.key = '';
    }
    void client.dispose();
  }
}

class Conversation implements InlineAcpConversation {
  closed = false;
  /** Set by `InlineAcpSession.open` right after construction. */
  ready!: Promise<AcpClient>;
  /** The client while a turn of this conversation is on the wire. */
  activeTurn: AcpClient | null = null;
  /** Resolves `ABANDONED` once closed mid-turn + grace; otherwise never. */
  readonly abandoned: Promise<typeof ABANDONED>;
  private resolveAbandoned!: (value: typeof ABANDONED) => void;
  /** True once `ready` resolved; set by `InlineAcpSession.open`. */
  isReady = false;

  constructor(
    private readonly owner: InlineAcpSession,
    readonly cfg: InlineAiConfig,
    readonly cwd: string | null,
    readonly mcp: Promise<AcpMcpServerDescriptor[]>,
    private readonly graceMs: number,
  ) {
    this.abandoned = new Promise((resolve) => {
      this.resolveAbandoned = resolve;
    });
  }

  async prompt(text: string, onEvent: (e: InlineTurnEvent) => void): Promise<void> {
    if (!this.isReady) onEvent({ type: 'status', text: `Starting ${this.cfg.backend}...` });
    const client = await this.ready;
    return this.owner.enqueue(() => this.owner.runTurn(this, client, text, onEvent));
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    const client = this.activeTurn;
    if (!client) return;
    void client.cancel().catch(() => undefined);
    setTimeout(() => this.resolveAbandoned(ABANDONED), this.graceMs);
  }
}
