// Krypton — ACP client.
// Thin frontend wrapper around the Rust `acp_*` Tauri commands and
// `acp-event-<session>` notifications. One AcpClient per harness lane.
// Spec 380: every payload and command result goes through the lane's decoder
// (`adapters/`), so listeners and callers only ever see canonical lane data.

import { invoke } from '@tauri-apps/api/core';
import { type UnlistenFn } from '@tauri-apps/api/event';

import { setupListener } from '../util/listener';
import { createLaneDecoder } from './adapters/decoder';
import { steerOutcome } from './adapters/generic';
import type { LaneDecoder, LaneEvent, LaneInit, LaneSession, RawAcpEvent } from './adapters/types';
import { skipInterviewDecision, type AskUserReply } from './ask-user-question';
import { elicitationResponse, type QuestionTarget } from './elicitation';
import type {
  AcpBackendDescriptor,
  AcpInstanceOwner,
  AcpSessionListResult,
  AcpMcpServerDescriptor,
  ContentBlock,
  SteerOutcome,
  StopReason,
  WireInitInfo,
  WireSessionInfo,
} from './types';

export class AcpClient {
  private session: number;
  private backend: string;
  private unlisten: UnlistenFn | null = null;
  private listeners: Array<(e: LaneEvent) => void> = [];
  private disposed = false;
  private readonly decoder: LaneDecoder;

  private constructor(session: number, backend: string) {
    this.session = session;
    this.backend = backend;
    this.decoder = createLaneDecoder(backend);
  }

  static async listBackends(): Promise<AcpBackendDescriptor[]> {
    return invoke<AcpBackendDescriptor[]>('acp_list_backends');
  }

  static async spawn(
    backendId: string,
    cwd: string | null,
    owner: AcpInstanceOwner,
    mcpServers: AcpMcpServerDescriptor[] = [],
    junieMcpLocation: string | null = null,
    clineMcpSettingsPath: string | null = null,
    remoteRuntimeId: string | null = null,
    computerCapability: string | null = null,
  ): Promise<AcpClient> {
    const session = await invoke<number>('acp_spawn', {
      backendId,
      cwd,
      owner,
      mcpServers,
      junieMcpLocation,
      clineMcpSettingsPath,
      remoteRuntimeId,
      computerCapability,
    });
    const client = new AcpClient(session, backendId);
    client.unlisten = await setupListener<RawAcpEvent>(`acp-event-${session}`, (payload) => {
      client.handleRaw(payload);
    });
    return client;
  }

  get sessionId(): number {
    return this.session;
  }

  get backendId(): string {
    return this.backend;
  }

  async setInstanceOwner(owner: AcpInstanceOwner): Promise<void> {
    await invoke('acp_set_instance_owner', { session: this.session, owner });
  }

  /** Run `initialize` → optional capability-dependent MCP injection → `session/new`.
   *  If `onInitialized` is supplied, the result it returns replaces the MCP server
   *  list seeded at spawn time. Returning `undefined` keeps the seeded list. */
  async initialize(
    onInitialized?: (init: LaneInit) => Promise<AcpMcpServerDescriptor[] | undefined>,
  ): Promise<{ init: LaneInit; session: LaneSession }> {
    const init = await this.initializeOnly();
    if (onInitialized) {
      const servers = await onInitialized(init);
      if (servers !== undefined) {
        await this.setMcpServers(servers);
      }
    }
    const session = await this.sessionNew();
    return { init, session };
  }

  async initializeOnly(): Promise<LaneInit> {
    return this.decoder.init(await invoke<WireInitInfo>('acp_initialize', { session: this.session }));
  }

  async setMcpServers(mcpServers: AcpMcpServerDescriptor[]): Promise<void> {
    await invoke('acp_set_mcp_servers', {
      session: this.session,
      mcpServers,
    });
  }

  async sessionNew(): Promise<LaneSession> {
    this.decoder.reset();
    return this.decoder.session(await invoke<WireSessionInfo>('acp_session_new', { session: this.session }));
  }

  async listSessions(cwd: string | null, cursor?: string | null): Promise<AcpSessionListResult> {
    return this.decoder.sessionList(await invoke<unknown>('acp_session_list', {
      session: this.session,
      cwd,
      cursor: cursor ?? null,
    }));
  }

  async resumeSession(sessionId: string): Promise<LaneSession> {
    this.decoder.reset();
    return this.decoder.session(await invoke<WireSessionInfo>('acp_session_resume', {
      session: this.session,
      sessionId,
    }));
  }

  async loadSession(sessionId: string): Promise<LaneSession> {
    this.decoder.reset();
    return this.decoder.session(await invoke<WireSessionInfo>('acp_session_load', {
      session: this.session,
      sessionId,
    }));
  }

  /** spec 127: switch the model of this live lane. Resolves to 'ok' on success or
   *  'timed_out_uncertain' on a client-side timeout (the agent may still apply it);
   *  rejects (throws) when the agent rejects the model id. */
  async setLaneModel(modelId: string): Promise<'ok' | 'timed_out_uncertain'> {
    return invoke<'ok' | 'timed_out_uncertain'>('acp_set_lane_model', {
      session: this.session,
      modelId,
    });
  }

  /** spec 333: switch the agent-side session mode (`session/set_mode`).
   *  Rejects when the agent refuses the id or does not answer in time. */
  async setSessionMode(modeId: string): Promise<void> {
    await invoke('acp_set_session_mode', { session: this.session, modeId });
  }

  onEvent(cb: (e: LaneEvent) => void): () => void {
    this.listeners.push(cb);
    return () => {
      const i = this.listeners.indexOf(cb);
      if (i >= 0) this.listeners.splice(i, 1);
    };
  }

  async prompt(blocks: ContentBlock[]): Promise<StopReason> {
    const { stopReason, usage } = this.decoder.promptResult(
      await invoke<unknown>('acp_prompt', { session: this.session, blocks }),
    );
    if (usage) {
      for (const cb of this.listeners.slice()) cb({ type: 'usage', usage });
    }
    // Per the ACP spec, the `session/prompt` JSON-RPC *response* is the turn-end signal;
    // it is not delivered as a `session/update` notification. Surface it through the
    // event stream so the view can clear `turnActive`.
    for (const cb of this.listeners.slice()) cb({ type: 'stop', stopReason });
    return stopReason;
  }

  /** spec 278: inject `blocks` into the running turn via `_session/steering`.
   *  Rejects on a JSON-RPC error (e.g. method not found, unsteerable turn).
   *  `requestId` matches the reply's ordered `turn_marker` event. */
  async steer(blocks: ContentBlock[]): Promise<{ outcome: SteerOutcome; requestId: number | null }> {
    const result = await invoke<{ outcome?: unknown; _kryptonRequestId?: unknown } | null>('acp_steer', {
      session: this.session,
      blocks,
    });
    const requestId = typeof result?._kryptonRequestId === 'number' ? result._kryptonRequestId : null;
    return { outcome: steerOutcome(result?.outcome), requestId };
  }

  async cancel(): Promise<void> {
    await invoke('acp_cancel', { session: this.session });
  }

  async respondPermission(requestId: number, optionId: string | null): Promise<void> {
    await invoke('acp_permission_response', {
      session: this.session,
      requestId,
      optionId,
    });
  }

  /** Answer a parked question card on its wire (Grok ext method or ACP elicitation). */
  async respondQuestion(target: QuestionTarget, reply: AskUserReply): Promise<void> {
    if (target.wire === 'elicitation') {
      await invoke('acp_elicitation_response', {
        session: this.session,
        requestId: target.requestId,
        response: elicitationResponse(target.fields ?? [], reply),
      });
      return;
    }
    await invoke('acp_ask_user_response', {
      session: this.session,
      requestId: target.requestId,
      decision: reply.kind === 'accept' ? reply.decision : skipInterviewDecision(),
    });
  }

  async respondFsWrite(requestId: number, accept: boolean): Promise<void> {
    await invoke('acp_fs_write_response', {
      session: this.session,
      requestId,
      accept,
    });
  }

  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    if (this.unlisten) {
      this.unlisten();
      this.unlisten = null;
    }
    try {
      await invoke('acp_dispose', { session: this.session });
    } catch (e) {
      console.warn('[AcpClient] dispose failed:', e);
    }
  }

  private handleRaw(raw: RawAcpEvent): void {
    if (this.disposed) return;
    for (const event of this.decoder.event(raw)) {
      for (const cb of this.listeners.slice()) cb(event);
    }
  }
}
