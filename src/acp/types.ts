// Krypton — ACP wire types.
// Mirrors the subset of agentclientprotocol.com types we actually consume.

export type StopReason = 'end_turn' | 'max_tokens' | 'max_turn_requests' | 'refusal' | 'cancelled';

export type ContentBlock =
  | { type: 'text'; text: string }
  | { type: 'image'; data: string; mimeType: string; uri?: string }
  | { type: 'audio'; data: string; mimeType: string }
  | { type: 'resource_link'; uri: string; name?: string; mimeType?: string }
  | { type: 'resource'; resource: { uri: string; mimeType?: string; text?: string; blob?: string } };

export type ToolKind = 'read' | 'edit' | 'delete' | 'move' | 'search' | 'execute' | 'think' | 'fetch' | 'other';

export type ToolStatus = 'pending' | 'in_progress' | 'completed' | 'failed';

export interface ToolCallContent {
  type: 'content' | 'diff' | 'terminal';
  // Diff-shaped:
  path?: string;
  oldText?: string | null;
  newText?: string;
  // Content-shaped:
  content?: ContentBlock;
  // Terminal-shaped:
  terminalId?: string;
}

export interface ToolCallLocation {
  path: string;
  line?: number;
}

export interface ToolCall {
  toolCallId: string;
  title?: string;
  kind?: ToolKind;
  status?: ToolStatus;
  content?: ToolCallContent[];
  locations?: ToolCallLocation[];
  rawInput?: unknown;
  rawOutput?: unknown;
}

export interface ToolCallUpdate {
  toolCallId: string;
  title?: string;
  kind?: ToolKind;
  status?: ToolStatus;
  content?: ToolCallContent[];
  locations?: ToolCallLocation[];
  rawInput?: unknown;
  rawOutput?: unknown;
}

export interface PlanEntry {
  content: string;
  priority?: 'low' | 'medium' | 'high';
  status: 'pending' | 'in_progress' | 'completed';
}

export interface PermissionOption {
  optionId: string;
  name: string;
  kind: 'allow_once' | 'allow_always' | 'reject_once' | 'reject_always';
}

/** spec 127: one agent-advertised model, from the session/new `models.availableModels[]`. */
export interface ModelInfo {
  model_id: string;
  name: string;
  description?: string | null;
}

export interface AgentInfo {
  agent_protocol_version: number;
  auth_methods: unknown[];
  agent_capabilities: {
    promptCapabilities?: { image?: boolean; audio?: boolean; embeddedContext?: boolean };
    sessionCapabilities?: { list?: unknown; resume?: unknown; close?: unknown };
    loadSession?: boolean;
    [k: string]: unknown;
  };
  session_id: string;
  /** spec 126: true when a configured model was not applied (session/set_model
   *  errored/timed out for an adapter that advertised model state). */
  model_apply_failed?: boolean;
  /** spec 127: agent-advertised models + confirmed current id (from session/new). */
  available_models?: ModelInfo[];
  current_model_id?: string | null;
}

export interface AgentInitInfo {
  agent_protocol_version: number;
  auth_methods: unknown[];
  agent_capabilities: AgentInfo['agent_capabilities'];
}

export interface AgentSessionInfo {
  session_id: string;
  /** spec 126: see AgentInfo.model_apply_failed. */
  model_apply_failed?: boolean;
  /** spec 127: agent-advertised models from session/new (or resume/load). Empty
   *  when the backend advertises no model state — model picker disabled. */
  available_models?: ModelInfo[];
  /** spec 127: confirmed current model id, or null/undefined when unverified. */
  current_model_id?: string | null;
}

export interface AcpSessionCapabilities {
  canList: boolean;
  canResume: boolean;
  canLoad: boolean;
}

export interface AcpSessionInfo {
  sessionId: string;
  cwd: string;
  title?: string | null;
  updatedAt?: string | null;
  _meta?: Record<string, unknown> | null;
}

export interface AcpSessionListResult {
  sessions: AcpSessionInfo[];
  nextCursor?: string | null;
}

export interface AcpBackendDescriptor {
  id: string;
  display_name: string;
  command: string;
}

export interface AcpHttpHeader {
  name: string;
  value: string;
}

export interface AcpEnvVar {
  name: string;
  value: string;
}

export interface AcpMcpServerStdio {
  name: string;
  type?: 'stdio';
  command: string;
  args: string[];
  env: AcpEnvVar[];
}

export interface AcpMcpServerHttp {
  name: string;
  type: 'http';
  url: string;
  headers: AcpHttpHeader[];
}

export interface AcpMcpServerSse {
  name: string;
  type: 'sse';
  url: string;
  headers: AcpHttpHeader[];
}

export type AcpMcpServerDescriptor = AcpMcpServerStdio | AcpMcpServerHttp | AcpMcpServerSse;

/** Subset of `agentCapabilities.mcpCapabilities` from the `initialize` response.
 *  Used by the harness to skip http/sse servers when an adapter doesn't advertise them. */
export interface AcpMcpCapabilities {
  http?: boolean;
  sse?: boolean;
}

export interface HarnessMemoryEntry {
  lane: string;
  summary: string;
  detail: string;
  updatedAt: number;
}

export interface HarnessMemorySession {
  harnessId: string;
  hookPort: number;
}

export interface HarnessMcpLaneStats {
  laneLabel: string;
  initializeCount: number;
  toolsListCount: number;
  toolsCallCount: number;
  lastMethod: string | null;
  lastSeenAt: number;
}

export interface UsageInfo {
  used?: number;
  size?: number;
  cost?: { amount: number; currency: string };
  inputTokens?: number;
  outputTokens?: number;
  cachedReadTokens?: number;
  cachedWriteTokens?: number;
}

export type ProviderErrorCategory =
  | 'rate_limit'
  | 'quota'
  | 'auth'
  | 'context'
  | 'network'
  | 'provider'
  | 'unknown';

export interface ProviderErrorPayload {
  category: ProviderErrorCategory;
  code?: string;
  headline: string;
  hint?: string;
  retryable: boolean;
  raw: string;
}

export interface AcpAvailableCommand {
  name: string;
  description?: string;
  inputHint?: string;
}

export interface AcpAgentMode {
  id: string;
  name: string;
  description?: string;
}

// Peering — inter-lane messaging (spec 106)
export type HarnessLaneStatus =
  | 'starting'
  | 'idle'
  | 'busy'
  | 'needs_permission'
  | 'awaiting_peer'
  | 'error'
  | 'stopped';

export interface InterLaneEnvelope {
  id: string;
  fromLaneId: string;
  toLaneId: string;
  message: string;
  done: boolean;
  sentAt: number;
  /** Rust-side harness scope tag. Used by the bridge to drop cross-harness leakage. */
  harnessId?: string;
  /** spec 141: the sender's globally-unique displayName, carried on cross-view
   * envelopes so the target coordinator can render the peer name and key pending
   * tracking without a local `getLane` lookup (which returns null for a foreign
   * lane). */
  fromDisplayName?: string;
  /** spec 141: set on the synthetic cancellation notice injected into a FOREIGN
   * peer (`acceptForeignCancellation`). When the peer drains it, the coordinator
   * routes a callback to the canceller's coordinator to clear the cross-view
   * cancellation tombstone — the cross-coordinator analogue of the local
   * drainedHarnessNotice suffix-clear, so the tombstone lives only until the peer
   * acknowledges the cancellation (not until the canceller re-initiates). */
  foreignCancelAck?: { cancellerDisplayName: string; peerDisplayName: string };
  /** spec 112 / 115: peer chat, review, or composer @mention fan-out. */
  kind?: 'peer' | 'review_request' | 'mention_request';
  reviewPacket?: ReviewPacket;
  /** spec 115: correlates fan-out replies on the requester. */
  mentionPacketId?: string;
  /**
   * spec 112: when set, this envelope is only relevant while the named review packet
   * is still open. Used for harness-injected protocol-retry prompts so that a stale
   * corrective prompt is dropped if the reviewer already produced an accepted reply
   * earlier in the same turn (which closes the packet).
   */
  reviewPacketId?: string;
}

export interface LaneSummary {
  laneId: string;
  displayName: string;
  backendId: string;
  status: HarnessLaneStatus;
  modelName: string | null;
  inboxDepth: number;
  /** spec 141: cross-harness routing/identity. `harnessId` is the owning view's
   * id (`hm-NN`); `local` is false for peers reached through the directory;
   * `cwd` is the owning view's working directory, surfaced so an agent can tell
   * which project a (possibly foreign) peer belongs to. */
  harnessId?: string;
  local?: boolean;
  cwd?: string | null;
  /** spec 124: lane-scope directive binding, if any. Surfaced via peer_list so
   * callers can pick the lane whose role fits the job. Reflects
   * `activeDirectiveId` only — one-shot `turnDirectiveOverride` is excluded
   * because it isn't the lane's persistent identity. */
  activeDirective: {
    id: string;
    title: string;
    task: string;
    description: string;
    enabled: boolean;
  } | null;
}

export interface LaneStatusEvent {
  laneId: string;
  prev: HarnessLaneStatus;
  next: HarnessLaneStatus;
  at: number;
}

// Review Lane Mode (spec 112)
export type ReviewSeverity = 'block' | 'warn' | 'nit';

export interface ReviewFinding {
  file: string;
  line: number;
  severity: ReviewSeverity;
  concern: string;
  suggestedCheck?: string;
}

export interface ReviewDiffstatEntry {
  path: string;
  status: 'M' | 'A' | 'D' | 'R' | '?';
  added: number;
  removed: number;
}

export interface ReviewPatchHunk {
  path: string;
  status: 'M' | 'A' | 'D' | 'R' | '?';
  hunk: string;
  truncated: boolean;
}

export interface ReviewUntrackedExcerpt {
  path: string;
  head: string;
}

export interface ReviewCommandSummary {
  command: string;
  exitCode: number | null;
  summary: string;
  at: number;
}

export interface ReviewToolSummary {
  kind: 'read' | 'edit' | 'search' | 'other';
  subject: string;
  count: number;
}

export interface ReviewGitState {
  repoRoot: string;
  hasGitRepo: boolean;
  hasStagedChanges: boolean;
  hasUnstagedChanges: boolean;
  partialStagingDetected: boolean;
  worktreeFingerprint: string;
  diffstat: ReviewDiffstatEntry[];
  patchHunks: ReviewPatchHunk[];
  untrackedExcerpts: ReviewUntrackedExcerpt[];
}

export interface ReviewPacket {
  packetId: string;
  fromLaneId: string;
  toLaneId: string;
  intent: string;
  repoRoot: string;
  patchBase: 'head';
  hasStagedChanges: boolean;
  hasUnstagedChanges: boolean;
  partialStagingDetected: boolean;
  worktreeFingerprint: string;
  diffstat: ReviewDiffstatEntry[];
  patchHunks: ReviewPatchHunk[];
  untrackedExcerpts: ReviewUntrackedExcerpt[];
  commands: ReviewCommandSummary[];
  toolSummary: ReviewToolSummary[];
  note?: string;
  sentAt: number;
  harnessId?: string;
}

export interface ReviewReply {
  packetId: string;
  fromLaneId: string;
  toLaneId: string;
  findings: ReviewFinding[];
  summary: string;
  interruptedReason?: string;
  sentAt: number;
  harnessId?: string;
}

// Attention Triage (spec 128) — self-reported judgement items.
export type Reversibility = 'reversible' | 'costly' | 'irreversible';

export type JudgementStatus = 'open' | 'accepted' | 'redirected' | 'self_resolved';

/** The raw fields a lane self-reports via the `attention_flag` MCP tool. */
export interface AttentionFlagPayload {
  question: string; // the decision needing judgement
  chosen: string; // the best-guess the lane already took (non-blocking)
  rationale: string; // why it chose that
  tradedOff: string[]; // options rejected + why — MANDATORY, non-empty (anti-rosy-card)
  uncertainty: string; // what the agent is unsure of / what would change its mind — MANDATORY, non-empty
  reversibility: Reversibility;
}

/** A flagged decision living in the demand queue (or the silent pile once resolved). */
export interface JudgementItem extends AttentionFlagPayload {
  id: string;
  laneId: string;
  packetId: string | null; // linked ReviewPacket id (blast-radius), null if no repo changes
  diffstat: ReviewDiffstatEntry[];
  createdAt: number;
  status: JudgementStatus;
}

/** Per-equipped-lane audit counters (spec 128 silent-turn audit). */
export interface LaneTriageStats {
  laneId: string;
  flaggedCount: number; // turns that produced ≥1 judgement item
  silentTurnCount: number; // turns that ended (busy→idle) with no flag
  lastSilentTurnAt: number | null;
}

/** Payload of a lane's `attention_resolve` MCP call (self-resolve / demote). */
export interface AttentionResolvePayload {
  itemId: string;
  note: string;
}

export type LaneBusEvent =
  | { type: 'lane:status'; payload: LaneStatusEvent }
  | { type: 'lane:spawned'; payload: { laneId: string } }
  | { type: 'lane:closed'; payload: { laneId: string; displayName: string } }
  | { type: 'triage:changed'; payload: { openCount: number } };

export type AcpEvent =
  | { type: 'user_message_chunk'; text: string }
  | { type: 'message_chunk'; text: string }
  | { type: 'thought_chunk'; text: string }
  | { type: 'tool_call'; call: ToolCall }
  | { type: 'tool_call_update'; update: ToolCallUpdate }
  | { type: 'plan'; entries: PlanEntry[] }
  | { type: 'permission_request'; requestId: number; toolCall: ToolCall; options: PermissionOption[] }
  | { type: 'usage'; usage: UsageInfo }
  | { type: 'available_commands'; commands: AcpAvailableCommand[] }
  | { type: 'mode_update'; modeId: string }
  | { type: 'fs_activity'; method: 'read' | 'write'; path: string; ok: boolean; error?: string }
  | { type: 'fs_write_pending'; requestId: number; path: string; oldText: string; newText: string }
  | { type: 'provider_error'; payload: ProviderErrorPayload }
  | { type: 'stop'; stopReason: StopReason; reason?: string }
  | { type: 'error'; message: string };
