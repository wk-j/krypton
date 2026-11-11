// Spec 380 — the canonical lane model and the adapter contracts.
//
// Every lane's ACP traffic passes through one `LaneDecoder` inside `AcpClient`.
// The decoder turns raw wire JSON into these types; nothing outside
// `src/acp/adapters/` and `client.ts` interprets wire JSON. This module stays
// free of Tauri imports so the spec 381 gallery can run the decoder in the
// browser.

import type { AskUserQuestion } from '../ask-user-question';
import type { OmpJob } from '../harness-subagents';
import type {
  ExecutionPayload,
  GuardianReviewPayload,
  JobsPayload,
  RemoteCommandPayload,
  SubagentPayload,
} from '../harness-view-types';
import type {
  AcpAgentMode,
  AcpAvailableCommand,
  AcpMcpCapabilities,
  AcpSessionCapabilities,
  AcpSessionListResult,
  ContentBlock,
  ModelInfo,
  PermissionOption,
  PlanEntry,
  ProviderErrorPayload,
  SteerOutcome,
  StopReason,
  ToolCall,
  ToolCallUpdate,
  UsageInfo,
} from '../types';

/** One `acp-event-<session>` payload as Rust emits it. Wire data: adapters only. */
export interface RawAcpEvent {
  type:
    | 'session_update'
    | 'permission_request'
    | 'ask_user_question'
    | 'elicitation_request'
    | 'stop'
    | 'error'
    | 'fs_activity'
    | 'fs_write_pending'
    | 'provider_error'
    | 'turn_marker';
  // session_update:
  kind?: string;
  update?: {
    sessionUpdate: string;
    content?: ContentBlock | { type: 'text'; text: string };
    [k: string]: unknown;
  };
  // permission_request / ask_user_question / elicitation_request:
  requestId?: number;
  questions?: unknown;
  toolCallId?: string;
  requestedSchema?: unknown;
  params?: {
    toolCall?: ToolCall;
    options?: PermissionOption[];
    [k: string]: unknown;
  };
  // stop:
  stopReason?: StopReason;
  reason?: string;
  // error:
  message?: string;
  // fs_activity:
  method?: 'read' | 'write';
  path?: string;
  ok?: boolean;
  error?: string;
  // fs_write_pending:
  oldText?: string;
  newText?: string;
  // provider_error:
  payload?: ProviderErrorPayload;
  // turn_marker (spec 278; requestId above):
  outcome?: unknown;
}

export type ToolState = 'pending' | 'in_progress' | 'completed' | 'failed' | 'canceled';

/** An MCP tool as the adapter names it — never derived from the tool's arguments. */
export interface McpIdentity {
  readonly server: string;
  readonly tool: string;
}

export interface ToolSection {
  readonly label: string;
  readonly text: string;
}

export interface ToolDiff {
  readonly path: string;
  readonly oldText: string;
  readonly newText: string;
}

/** A background job a tool call detached (spec 305). */
export interface ToolBackgroundLaunch {
  readonly id: string;
  readonly outputPath: string;
  readonly command: string;
}

/**
 * Everything any surface may show about one tool call: a full snapshot on
 * every update. Arrays keep their reference across updates that did not change
 * them, because row components compare them by identity.
 *
 * `subagents` / `execution` / `jobs` / `guardianReview` are the same objects
 * the row payload holds; the view's card updates mutate them in place, and the
 * next decode builds on that state exactly as before spec 380.
 */
export interface ToolView {
  readonly id: string;
  /** spec 282: the subagent call this call belongs to. */
  readonly parentId: string | null;
  readonly status: ToolState;
  /** Inferred ACP kind, or `agents` / `wait` for the subagent and job cards. */
  readonly kind: string;
  /** The ACP `kind` exactly as the agent declared it (policy reads this, never an inference). */
  readonly declaredKind: string | null;
  /** Cleaned title, else the raw title. */
  readonly title: string;
  /** The tool's own name when its input states one. */
  readonly toolName: string | null;
  /** The command, else the primary path, else the title. */
  readonly subject: string;
  /** Display command line; '' unless `kind` is `execute`. */
  readonly command: string;
  /** The full, untruncated command in the input, whatever the kind (spec 143). */
  readonly commandLine: string | null;
  /** The file an edit/write targets. */
  readonly modifiedPath: string | null;
  readonly locations: readonly string[];
  /** String values under path-like input keys (spec 133 scratch check). */
  readonly inputPaths: readonly string[];
  readonly sections: ToolSection[];
  /** Exit code; null when the server reported none. */
  readonly exit: number | null;
  readonly diffs: ToolDiff[];
  readonly mcp: McpIdentity | null;
  readonly background: ToolBackgroundLaunch | null;
  readonly subagents?: SubagentPayload;
  readonly jobs?: JobsPayload;
  readonly execution?: ExecutionPayload;
  readonly guardianReview?: GuardianReviewPayload;
  readonly remoteCommand?: RemoteCommandPayload;
}

/** What one tool update contributed toward the row's image strip (spec 281). */
export interface ToolImageUpdate {
  /** This update's content blocks. */
  readonly blocks: readonly ContentBlock[];
  /** This update's location paths, unresolved. */
  readonly locations: readonly string[];
  /** The call's first known location: pairs a lone byte image with its file. */
  readonly pairPath: string | null;
  /** Image-like paths found in the input, the output and text content. */
  readonly scanned: readonly string[];
  readonly overflow: number;
}

/**
 * A permission request, decoded once (spec 380 phase 2b). The policy facts are
 * computed by the decoder with the exact rules of specs 96 and 143, so the view
 * decides from them without reading the wire call.
 */
export interface PermissionRequest {
  readonly requestId: number;
  /** The request's own tool call, not merged with the call's earlier updates. */
  readonly view: ToolView;
  readonly options: PermissionOption[];
  /** The built-in harness tool, by exact adapter identity (spec 96); null for any other tool. */
  readonly harnessTool: string | null;
  /** spec 143: a high-risk command, or an execute surface whose command cannot be read. */
  readonly highRisk: boolean;
  /** The request's input, summarised for the card. */
  readonly argsPreview: string;
  /** The MCP server the request names, as the control API reports it. */
  readonly serverName: string | null;
}

/** Everything any surface may show about a lane's live traffic. */
export type LaneEvent =
  | { type: 'user_message_chunk'; text: string; content: ContentBlock }
  /** `parentToolId` (spec 282): subagent output, stamped with its parent tool call id. */
  | { type: 'message_chunk'; text: string; content: ContentBlock; messageId?: string; parentToolId?: string }
  | { type: 'thought_chunk'; text: string; parentToolId?: string }
  /** `phase` keeps ACP's `tool_call` / `tool_call_update` distinction. `jobsReport`
   *  (spec 370) is an OMP `wait` frame's job snapshot, only on the frame that carried it. */
  | {
    type: 'tool';
    phase: 'call' | 'update';
    view: ToolView;
    images: ToolImageUpdate;
    jobsReport?: readonly OmpJob[];
  }
  | { type: 'plan'; entries: PlanEntry[] }
  | ({ type: 'permission_request' } & PermissionRequest)
  /** Questions are already parsed; an empty list means the request carried none. */
  | { type: 'ask_user_question'; requestId: number; questions: AskUserQuestion[]; toolCallId?: string }
  | { type: 'elicitation_request'; requestId: number; message: string; requestedSchema: unknown; toolCallId?: string }
  | { type: 'usage'; usage: UsageInfo }
  | { type: 'available_commands'; commands: AcpAvailableCommand[] }
  | { type: 'mode_update'; modeId: string }
  | { type: 'fs_activity'; method: 'read' | 'write'; path: string; ok: boolean; error?: string }
  | { type: 'fs_write_pending'; requestId: number; path: string; oldText: string; newText: string }
  | { type: 'provider_error'; payload: ProviderErrorPayload }
  | { type: 'stop'; stopReason: StopReason; reason?: string }
  /** spec 278: agent thread state — the only end signal of a turn a steer started. */
  | { type: 'turn_state'; state: 'active' | 'idle' }
  /** spec 278: a `session/prompt` or `_session/steering` reply, in stdout order
   *  with the session updates around it. `outcome` is the steering outcome, else null. */
  | { type: 'turn_marker'; kind: 'prompt' | 'steer'; requestId: number; outcome: SteerOutcome | null }
  | { type: 'error'; message: string };

/** What the agent's `initialize` answer means for the UI. */
export interface LaneInit {
  readonly promptImage: boolean;
  readonly promptEmbeddedContext: boolean;
  readonly sessions: AcpSessionCapabilities;
  readonly mcp: AcpMcpCapabilities;
  /** spec 278: the agent advertised the `_session/steering` extension. */
  readonly steering: boolean;
  readonly authMethods: readonly unknown[];
  /** A model name an agent put somewhere in its capabilities, if any. */
  readonly reportedModel: string | null;
  /** Off-spec `agentCapabilities.availableModes`; the fallback when a session reports none. */
  readonly modes: readonly AcpAgentMode[];
}

/** What a `session/new`, `session/resume` or `session/load` answer means for the UI. */
export interface LaneSession {
  readonly sessionId: string;
  /** spec 127: Rust's parsed model list, already Krypton-shaped. */
  readonly models: readonly ModelInfo[];
  readonly currentModelId: string | null;
  /** ACP `modes.availableModes` of the session. */
  readonly modes: readonly AcpAgentMode[];
  readonly currentModeId: string | null;
  /** spec 126: a configured model was requested but not applied. */
  readonly modelApplyFailed: boolean;
}

export interface PromptResult {
  readonly stopReason: StopReason;
  /** Null when the response carried no usage. */
  readonly usage: UsageInfo | null;
}

/** A `ToolView` under construction. */
export type ToolDraft = { -readonly [K in keyof ToolView]: ToolView[K] };

/** One tool update being decoded. Adapters refine `draft` in place. */
export interface ToolStep {
  /** The incoming wire update. */
  readonly call: ToolCall | ToolCallUpdate;
  /** The update merged with everything seen for this id (bounded, `_meta` dropped). */
  readonly merged: ToolCall | ToolCallUpdate;
  readonly prior: ToolView | null;
  /** Subagent display names learned on this lane (Codex `_meta.codex.subagent`). */
  readonly agentNames: Map<string, string>;
  /** The call is the subject of a permission request, decoded without touching call state. */
  readonly permission: boolean;
  /** Command output collected from `_meta.terminal_output` (head kept); null until any arrived. */
  readonly terminalOutput: string | null;
  draft: ToolDraft;
  jobsReport?: OmpJob[];
}

/**
 * Whether a backend fills one canonical field (spec 380 supply matrix):
 * `yes` it does, `no` it never does (the field stays null or empty for every
 * lane of it), `unverified` nobody has checked it against captured wire.
 */
export type Supply = 'yes' | 'no' | 'unverified';

/**
 * What one backend supplies, per canonical field. Published in
 * `docs/0069-acp-agent-support.md`; the contract test holds each backend's
 * captured wire to it, so missing data is documented, not silently absent.
 */
export interface SupplyMatrix {
  /** `ToolView.exit` on a command. */
  readonly exit: Supply;
  /** `ToolView.subagents` on a call that spawns agents (spec 282). */
  readonly subagents: Supply;
  /** `turn_state` events (spec 278). */
  readonly turnState: Supply;
  /** `UsageInfo.cost`. */
  readonly usageCost: Supply;
  /** `LaneSession.models`. */
  readonly models: Supply;
  /** `LaneSession.modes` (or the off-spec `LaneInit.modes`). */
  readonly modes: Supply;
  /** Images on a tool row: image blocks or image paths (spec 281). */
  readonly images: Supply;
}

/**
 * One backend's deviations from the generic decoding. Every hook is optional;
 * an omitted hook keeps the generic result.
 */
export interface LaneAdapter {
  /** Backend id this adapter serves, or `generic`. */
  readonly id: string;
  readonly supplies: SupplyMatrix;
  /** The parent tool call id a message/thought chunk belongs to (spec 282). */
  chunkParent?(meta: unknown): string | null;
  /** Thread state from a `session_info_update` (spec 278). */
  turnState?(update: Readonly<Record<string, unknown>>): 'active' | 'idle' | null;
  /** Output sections from this backend's typed `rawOutput`; null keeps the generic walk. */
  outputSections?(rawOutput: unknown): ToolSection[] | null;
  /** Backend wrappers around a tool dump, removed before the line cap. */
  cleanOutput?(text: string, kind: string): string;
  /** `stdout`/`output` sections whose first line is `exit: N` carry the exit code. */
  readonly exitPrefix?: boolean;
  /**
   * A first output line in which the backend restates the exit code; group 1
   * is the code. The line is dropped from any section when that code is the
   * exit the row shows, so the code is not painted twice. Unknown exit: kept.
   */
  readonly exitLine?: RegExp;
  /** The status to show for a wire status (OMP keeps a settled card settled). */
  toolStatus?(step: ToolStep, wire: ToolState): ToolState;
  /** Refine the generic view: parent, identity, cards, background launch. */
  tool?(step: ToolStep): void;
}

export interface LaneDecoder {
  /** Zero or more canonical events for one raw payload. */
  event(raw: RawAcpEvent): LaneEvent[];
  init(raw: unknown): LaneInit;
  session(raw: unknown): LaneSession;
  sessionList(raw: unknown): AcpSessionListResult;
  promptResult(raw: unknown): PromptResult;
  /** Fresh session: forgets per-tool-call state and learned subagent names. */
  reset(): void;
}
