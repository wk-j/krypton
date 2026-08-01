// Krypton — ACP Harness View: shared state shapes.
//
// Extracted verbatim from acp-harness-view.ts (spec 204) so the render helpers
// and the view class can share one definition of lane / transcript state without
// the view file owning every type. Declarations only — no behavior lives here;
// the one non-type export is FILE_TOUCH_WINDOW_MS, the retention policy for the
// FileTouchRecord shape declared below (see its comment for why it lives here).

import type * as smd from 'streaming-markdown';

import type { AcpClient } from './client';
import type {
  AcpAgentMode,
  AcpAvailableCommand,
  AcpSessionCapabilities,
  AcpSessionInfo,
  AgentInitInfo,
  HarnessLaneStatus,
  HarnessMcpLaneStats,
  MessageResourceGitState,
  ModelInfo,
  PermissionOption,
  PlanEntry,
  ProviderErrorPayload,
  ToolCall,
  ToolCallUpdate,
  UsageInfo,
} from './types';
import type { CoordinatorDrainContext, InterLaneRowChannel, PendingPeerSummary } from './inter-lane';
import type { TelegramControlCaller } from './control-types';
import type { DebbyBuiltinRole } from './debby';
import type { SaltyRole } from './salty';
import type { AcpLaneMetrics } from '../types';

export type ComposerFocus = 'text' | 'transcript';
export type PendingExtraction = never;

export interface HarnessPermission {
  requestId: number;
  toolCall: ToolCall;
  options: PermissionOption[];
  resolvedLabel?: string;
  auto?: boolean;
  transcriptItem?: HarnessTranscriptItem;
}

/** A deterministic, user-visible reference extracted from one assistant row. */
export interface MessageResource {
  /** Normalized identity used for dedupe and delegated click lookup. */
  key: string;
  kind: 'file' | 'url';
  /** Absolute file path or normalized external URI. */
  target: string;
  label: string;
  source: 'protocol' | 'markdown';
  line?: number;
  column?: number;
  mimeType?: string;
  size?: number;
  description?: string;
  /** Volatile Git state derived locally from the current working tree. */
  git?: MessageResourceGitState;
  /** Transient label assigned only while transcript open-hint mode is active. */
  hintLabel: string | null;
}

export interface HarnessTranscriptItem {
  id: string;
  kind: 'system' | 'user' | 'assistant' | 'thought' | 'tool' | 'permission' | 'restart' | 'memory' | 'shell' | 'fs_activity' | 'fs_write_review' | 'inter_lane' | 'provider_error' | 'artifact';
  text: string;
  createdAt?: number;
  markdownSource?: string;
  markdownHtml?: string;
  // Spec 114 rev 4: append-only plain streaming. `streamPlainLength` is how
  // many characters of `text` are already in the body's single TextNode;
  // markdown is deferred until seal (no mid-stream plain↔HTML swap).
  // Spec 117 supersedes this for `kind === 'assistant'` — see streamingMarkdownWritten.
  streamPlainLength?: number;
  // Spec 117: chars of `item.text` already fed into the lane's streaming-markdown
  // parser. Transient; cleared by sealStreaming. Only used for assistant rows.
  streamingMarkdownWritten?: number;
  pretextSource?: string;
  pretextWidth?: number;
  pretextFont?: string;
  pretextLineHeight?: number;
  pretextLines?: string[];
  imageCount?: number;
  telegramProvenance?: TelegramControlCaller;
  status?: string;
  diff?: { title: string; unified: string };
  tool?: ToolPayload;
  toolStartedAt?: number;
  toolEndedAt?: number;
  permission?: PermissionPayload;
  fsActivity?: FsActivityPayload;
  fsReview?: FsWriteReviewPayload;
  interLane?: InterLanePayload;
  providerError?: ProviderErrorPayload;
  /** spec 120: first assistant row after coordinator drain. */
  replyingToLaneMail?: LaneMailProvenance;
  /** spec 133: hintable HTML artifact card. */
  artifact?: ArtifactCardPayload;
  /** spec 206: structured references belonging to this assistant message. */
  resources?: MessageResource[];
  /** Number of otherwise-valid unique references hidden by the per-row cap. */
  resourceOverflow?: number;
  /** True after the sealed Markdown DOM has been scanned exactly once. */
  resourcesScanned?: boolean;
}

/** spec 133 — transcript card for a registered HTML artifact. */
export interface ArtifactCardPayload {
  id: string;
  title: string;
  laneLabel: string;
  /** Absolute file path opened via `open_url(file://…)`. */
  path: string;
  size: number | null;
  hash: string | null;
  /** false once the file is swept/cancelled — the card reports "unavailable". */
  available: boolean;
  /** Hint label assigned while unified transcript open mode is active, else null. */
  hintLabel: string | null;
}

export interface InterLanePayload {
  direction: 'in' | 'out';
  peerId: string;
  peerDisplayName: string;
  peerBackendId?: string;
  done: boolean;
  envelopeId?: string;
  channel?: InterLaneRowChannel;
}

export interface LaneMailProvenance {
  envelopeId: string;
  peerDisplayName: string;
  envelopeCount: number;
}

export interface FsWriteReviewPayload {
  requestId: number;
  path: string;
  oldText: string;
  newText: string;
  resolved?: 'accepted' | 'rejected';
}

export interface FsActivityPayload {
  method: 'read' | 'write';
  path: string;
  ok: boolean;
  error?: string;
}

export type HarnessToolFamily = 'memory' | 'peer' | 'attention' | 'review';
export type PermissionDecision = 'pending' | 'accepted' | 'rejected' | 'auto_allowed' | 'failed';

export interface PermissionPayload {
  id: number;
  toolName: string;
  toolFamily: HarnessToolFamily | 'agent' | 'shell' | 'file' | 'other';
  serverName: string | null;
  kind: string;
  subject: string;
  suffix?: string;
  argsPreview: string;
  options: Array<{ optionId: string; name: string; action: 'accept' | 'reject' | 'other' }>;
  decision: PermissionDecision;
  decisionLabel?: string;
  autoReason?: string;
}

export interface ToolPayload {
  glyph: string;
  status: string;
  kind: string;
  subject: string;
  command: string;
  result: string;
  sections: Array<{ label: string; text: string }>;
  diffs: Array<{ path: string; oldText: string; newText: string }>;
  startedAt?: number;
  endedAt?: number;
  /** spec 133: set when this tool wrote/edited a registered artifact path. The
   * diff/content is redacted to path + bytes + hash so HTML never enters the
   * transcript model under the write tool. */
  artifactRedaction?: { tail: string; size: number | null; hash: string | null; pending: boolean };
}

export interface StagedImage {
  data: string;
  mimeType: string;
  path: string | null;
}

export interface LanePeekState {
  visible: boolean;
  dismissedAt: number | null;
  dismissedPriority: number | null;
  lockedLaneId: string | null;
  currentLaneId: string | null;
  currentReasonKey: string | null;
  selectedAt: number;
}

export type LanePeekPayload =
  | { kind: 'permission'; toolName: string; subject: string; decision: string }
  | { kind: 'peer'; direction: 'in' | 'out' | 'awaiting'; peerDisplayName: string; ageLabel: string }
  | { kind: 'error'; message: string }
  | { kind: 'activity'; label: string; ageLabel: string }
  | null;

export interface LanePeekSummary {
  status: HarnessLaneStatus;
  headline: string;
  detail: string | null;
  payload: LanePeekPayload;
}

export interface LanePeekCandidate {
  laneId: string;
  displayName: string;
  priority: number;
  direct: boolean;
  reasonKey: string;
  reasonLabel: string;
  summary: LanePeekSummary;
  at: number;
  visualIndex: number;
}

export interface LanePeekSnapshot {
  laneId: string;
  displayName: string;
  status: HarnessLaneStatus;
  active: boolean;
  stopped: boolean;
  visualIndex: number;
  inboxDepth: number;
  pendingPeers: PendingPeerSummary[];
  latestInterLane: { direction: 'in' | 'out'; peerId: string; peerDisplayName: string; at: number; message: string } | null;
  latestPermission: { toolName: string; subject: string; decision: string; at: number } | null;
  latestMeaningful: { kind: HarnessTranscriptItem['kind']; label: string; at: number } | null;
  error: string | null;
  // Derived fields used by render; all optional to keep buildLanePeekCandidates pure-testable.
  modelName?: string | null;
  usage?: UsageInfo | null;
  metrics?: AcpLaneMetrics | null;
  mcp?: HarnessMcpLaneStats | null;
  plan?: { done: number; total: number; activeText: string | null } | null;
  activeTool?: { name: string; subject: string | null; startedAt: number } | null;
  activeTurnStartedAt?: number | null;
  recentFiles?: string[];
  pendingShell?: boolean;
}

/** Slice 109 — lane-pair activity heat (peek rail). */
export type LanePeekHeatMetric = 'auto' | 'tools' | 'tokens' | 'peer' | 'process' | 'alerts';
export type LanePeekHeatWindow = '30s' | '5m' | 'session';

export interface LaneActivitySample {
  at: number;
  usageUsed: number | null;
  cpuPercent: number | null;
  rssMb: number | null;
}

export interface LaneHeatSide {
  laneId: string;
  displayName: string;
  score: number;
  toolDelta: number;
  tokenDelta: number | null;
  peerDelta: number;
  permissionDelta: number;
  errorDelta: number;
  cpuPeak: number | null;
  label: string;
}

export interface LanePairHeatSummary {
  metric: Exclude<LanePeekHeatMetric, 'auto'>;
  window: LanePeekHeatWindow;
  active: LaneHeatSide;
  peeked: LaneHeatSide;
  pairScore: number;
  dominantSide: 'active' | 'peeked' | 'balanced';
  unavailableReason: string | null;
  deltaLine: string;
}

/** Transcript + lane-local inputs for heat derivation (tests use minimal objects). */
export interface LanePeekHeatLaneInput {
  id: string;
  displayName: string;
  status: HarnessLaneStatus;
  transcript: HarnessTranscriptItem[];
  usage: UsageInfo | null;
  pendingShell: boolean;
  pendingPeerCount: number;
  metricHistory: LaneActivitySample[];
}

/** spec 133 — frontend mirror of a Rust artifact registry entry. */
export type HarnessArtifactState = 'pending' | 'registered_live';

export interface HarnessArtifactRecord {
  id: string;
  laneLabel: string;
  path: string;
  tail: string;
  title: string;
  state: HarnessArtifactState;
  size: number | null;
  hash: string | null;
  /** spec 149: per-artifact feedback token, baked into the served URL. Set at
   *  `artifact_new`; empty only for entries from a prior (pre-149) app run. */
  feedbackToken: string;
}

export interface ArtifactEventPayload {
  harnessId: string;
  laneLabel: string;
  id: string;
  path?: string;
  tail?: string;
  title?: string;
  size?: number;
  hash?: string;
  state: 'pending' | 'registered' | 'cancelled';
  registered?: boolean;
  /** spec 149: present on the `pending` event from `artifact_new`. */
  feedbackToken?: string;
}

export interface FileTouchRecord {
  path: string;
  laneId: string;
  laneDisplayName: string;
  toolKind: 'edit' | 'write_like';
  at: number;
}

/** How long a `FileTouchRecord` stays relevant. ONE policy with two readers: the
 *  view's cross-lane permission-conflict suffix and `lane-peek`'s recent-files
 *  row. It lives beside the shape it governs because those two readers sit on
 *  opposite sides of the module graph (the view imports `lane-peek`, so the
 *  constant cannot live there without a cycle) — and because the two readers
 *  drifting apart would silently mean "recently touched" no longer agrees
 *  between the permission prompt and the peek card. */
export const FILE_TOUCH_WINDOW_MS = 10 * 60 * 1000;

/** spec 156: what the lane is doing right now, shown in the busy status chip.
 *  Written as plain field assignments on the hot streaming path (no render
 *  call); the existing 1 s composer tick paints it. */
export interface LaneActivity {
  kind: 'tool' | 'thinking' | 'writing';
  /** tool title (preferred) or kind; empty for thinking/writing */
  label: string;
}

/** spec 127: in-flight live model switch, used to revert/attribute correctly. */
export interface PendingModelSwitch {
  epoch: number;
  prevModelName: string | null;
  prevModelId: string | null;
  prevModeId: string | null;
  pickedName: string;
}

export interface PendingUserEcho {
  itemId: string;
  text: string;
  received: string;
}

export interface HarnessLane {
  id: string;
  index: number;
  backendId: string;
  displayName: string;
  accent: string;
  client: AcpClient | null;
  status: HarnessLaneStatus;
  draft: string;
  cursor: number;
  pendingPermissions: HarnessPermission[];
  transcript: HarnessTranscriptItem[];
  spawnEpoch: number;
  usage: UsageInfo | null;
  sessionId: string | null;
  modelName: string | null;
  /** spec 126: true when the configured model failed to apply (session/set_model
   *  errored/timed out). Drives the amber warning on the model chip; the chip
   *  text still shows configured intent, now flagged unconfirmed. */
  modelApplyFailed: boolean;
  /** spec 127: agent-advertised models for the picker. Empty when the backend
   *  advertises no model state — the leader-',' picker is then disabled. */
  availableModels: ModelInfo[];
  /** spec 127: confirmed current model id (marks `✓` in the picker), or null
   *  when unverified (alias applied / pre-switch state). */
  currentModelId: string | null;
  /** spec 127: bumped on every live model-switch dispatch; a resolution only
   *  mutates lane state when its captured epoch still equals this (Codex-1 #3). */
  modelSwitchEpoch: number;
  /** spec 127: set while a live switch is in flight; cleared on settle/deadline.
   *  Gates re-entry and lets the mode_update handler attribute a downgrade. */
  pendingModelSwitch: PendingModelSwitch | null;
  supportsEmbeddedContext: boolean;
  error: string | null;
  acceptAllForTurn: boolean;
  rejectAllForTurn: boolean;
  permissionMode: 'normal' | 'acceptEdits' | 'bypass';
  /** Trusted per-turn origin set only by Rust-admitted Telegram control calls. */
  activeTelegramTurn: TelegramControlCaller | null;
  /** spec 143: armed for one peer-injected turn (auto_accept). Auto-accepts every
   *  permission EXCEPT high-risk commands, which still prompt. Reset at turn end. */
  peerAutoAcceptForTurn: boolean;
  pendingTurnExtractions: PendingExtraction[];
  currentUserId: string | null;
  pendingUserEcho: PendingUserEcho | null;
  currentAssistantId: string | null;
  /** ACP message boundary associated with currentAssistantId, when advertised. */
  currentAssistantMessageId: string | null;
  currentThoughtId: string | null;
  toolTranscriptIds: Map<string, string>;
  toolCalls: Map<string, ToolCall | ToolCallUpdate>;
  seenTranscriptIds: Set<string>;
  stickToBottom: boolean;
  savedScrollTop: number;
  savedScrollAnchor: TranscriptScrollAnchor | null;
  pendingShellId: string | null;
  stagedImages: StagedImage[];
  supportsImages: boolean;
  activeTurnStartedAt: number | null;
  /** Human label for a custom-command-driven turn (e.g. 'reviewing', 'ingesting
   *  wiki') so the busy chip reads as that operation, not a generic 'running'.
   *  Set in enqueueSystemPrompt, auto-cleared in setLaneStatus on leaving busy. */
  activeSystemLabel: string | null;
  /** spec 156: live activity segment for the busy chip (current tool /
   *  thinking / writing). Cleared on stop/error. */
  activity: LaneActivity | null;
  availableCommands: AcpAvailableCommand[];
  modesById: Map<string, AcpAgentMode>;
  currentMode: AcpAgentMode | null;
  slashPaletteIndex: number;
  slashPaletteDismissed: boolean;
  mentionPaletteIndex: number;
  mentionPaletteDismissed: boolean;
  hashPaletteIndex: number;
  hashPaletteDismissed: boolean;
  verbPaletteIndex: number;
  verbPaletteDismissed: boolean;
  plan: PlanEntry[] | null;
  planCollapsed: boolean;
  lastKilled: string;
  transcriptWindow: number;
  promptHistory: string[];
  historyIndex: number | null;
  historySavedDraft: string | null;
  /**
   * Spec 114: cached count of tool rows on this lane in
   * `started but not yet ended` state. Replaces the O(rows) scan inside
   * `updateToolTick()`. Mutated as a before/after delta in `renderTool()`
   * and decremented in `appendTranscript()` whenever the 300-row cap shifts
   * an active tool row out of the transcript.
   */
  activeToolCount: number;
  // Spec 117: streaming-markdown parser bound to the active assistant row's
  // body. Null between turns. Only one streaming assistant row per lane at a
  // time (matches currentAssistantId).
  streamingMarkdownParser: smd.Parser | null;
  streamingMarkdownBody: HTMLElement | null;
  streamingMarkdownItemId: string | null;
  /** Junie native MCP overlay dir passed to `--mcp-location`. */
  junieMcpOverlayDir: string | null;
  /** Cline native MCP overlay file passed via `CLINE_MCP_SETTINGS_PATH`
   *  (Cline drops `session/new` mcpServers). null when not a Cline lane. */
  clineMcpOverlayDir: string | null;
  /** spec 113 rev — krypton server names written into `<project>/.cursor/mcp.json`
   *  for the Cursor lane (removed on close). null when not a Cursor lane. */
  cursorMcpNames: string[] | null;
  /** spec 120: set when drain calls enqueueSystemPrompt; cleared on turn end. */
  pendingCoordinatorDrain: CoordinatorDrainContext | null;
  coordinatorDrainProvenanceUsed: boolean;
  /** spec 124: directive assigned to this lane (lane scope). */
  activeDirectiveId: string | null;
  /** spec 124: queued lane-scope change while busy; promoted before next prompt.
   * Object presence = change pending; `directiveId: null` = clear on next send.
   * Plain `null` on the field = no pending change. */
  pendingDirectiveChange: { directiveId: string | null } | null;
  /** spec 124: MCP scope = "next_turn"; used for one prompt then cleared.
   * Object presence = override active; `directiveId: null` = clear active
   * directive for one turn. Plain `null` on the field = no override. */
  turnDirectiveOverride: { directiveId: string | null } | null;
  /** spec 124: restored after a next-turn override completes. */
  previousDirectiveId: string | null;
  /** spec 164: built-in Polly role overlay (orchestrator / implementer). Overrides
   *  user directives while set. */
  pollyBuiltinRole: 'orchestrator' | 'implementer' | null;
  /** spec 164: while a lane serves as a Polly implementer it auto-accepts
   *  permissions (`permissionMode = 'bypass'`). This stashes the user's own mode
   *  so `clearPollyBuiltinRole` can restore it; null when not enlisted. */
  pollySavedPermissionMode: 'normal' | 'acceptEdits' | 'bypass' | null;
  /** spec 167: built-in Debby role overlay (orchestrator / head). Heads are
   *  plain responders; unlike Polly implementers this never changes permissions. */
  debbyBuiltinRole: DebbyBuiltinRole | null;
  /** spec 195: built-in Salty role overlay (orchestrator / model-tiered executor).
   *  Mutually exclusive with the Polly/Debby overlays. */
  saltyBuiltinRole: SaltyRole | null;
  /** spec 195: stashes the user's own permission mode while a lane serves as a
   *  bypassed Salty executor (mechanical/codex-peer), mirroring
   *  `pollySavedPermissionMode`; null when not enlisted. */
  saltySavedPermissionMode: 'normal' | 'acceptEdits' | 'bypass' | null;
  /** spec 130: lane participates in attention-triage audit. Attention tools are
   *  default-on for every harness-memory-capable lane; this flag now drives local
   *  audit/UI behavior rather than MCP tool visibility. */
  triageEquipped: boolean;
  /** Legacy spec-129 override field retained for saved/runtime shape stability.
   *  The user-facing manual toggle was removed in spec 130. */
  triageOverride: boolean | null;
  /** spec 128: set when this lane flagged ≥1 judgement item during the current
   *  turn; read at busy→idle to classify the turn as flagged vs silent. */
  flaggedThisTurn: boolean;
  /** spec 136: prompts the user submitted while the lane was busy. FIFO — the
   *  head drains first on the next idle transition. Capped at PROMPT_QUEUE_MAX. */
  queuedPrompts: QueuedPrompt[];
  /** spec 199: timestamp of the first unacknowledged session/cancel of the
   *  current turn; null when no cancel is outstanding. Survives the
   *  busy ↔ needs_permission flap (same turn); cleared when the turn ends. */
  cancelRequestedAt: number | null;
  /** spec 199: true once CANCEL_ESCALATION_MS elapsed with the cancel still
   *  unacknowledged — the next Ctrl+C force-restarts (and resumes) the lane. */
  cancelUnacked: boolean;
  /** spec 199: pending escalation timer handle; null when disarmed. */
  cancelEscalationTimer: number | null;
  /** spec 148: active focus-scope goal, or undefined. Session-only harness-lane
   *  runtime state confined to THIS lane: it rides this lane's own turns via
   *  renderPromptMemoryPacket (never other lanes' / programmatic turns) and survives
   *  `#new`; dropped only on `#goal clear`, a replacing `#goal`, or lane close. */
  goal?: LaneGoal;
}

/** spec 148: a per-lane focus-scope goal — the current task the lane is anchored
 *  to. Not a completion condition (no evaluator, no auto-continue); just scope. */
export interface LaneGoal {
  text: string;
  setAt: number;
}

/** spec 178: GitHub issue-fixing. A binding between a GitHub issue and the lane
 *  fixing it. Lives in a harness-level map keyed by `issueKey`, persisted to disk
 *  so it survives a Krypton restart (the lane process does not). `phase/summary/
 *  prUrl` are lane self-reported via the `issue_progress` MCP tool. */
export type IssuePhase =
  | 'investigating' | 'fixing' | 'testing'
  | 'review' | 'pr_opened' | 'done' | 'blocked';

export interface IssueBinding {
  issueKey: string; // canonical id: "owner/repo#123"
  issueUrl: string;
  repo: string; // "owner/repo"
  number: number;
  title: string;
  harnessId: string;
  laneId: string;
  laneDisplayName: string;
  dispatchedAt: number;
  phase?: IssuePhase;
  summary?: string;
  prUrl?: string;
  updatedAt: number;
}

/** spec 194: one shared working ticket per harness — reference context for every
 *  lane, NOT an assignment and NOT an `IssueBinding` (single-owner progress
 *  semantics stay with the binding). Persisted like issue bindings; the frontend
 *  is the state authority (ADR-0007). */
export interface ActiveWorkTicket {
  issueKey: string; // canonical "owner/repo#123"
  issueUrl: string;
  repo: string; // "owner/repo"
  number: number;
  title: string; // issueKey until the background `gh` enrich resolves
  state?: 'open' | 'closed';
  labels?: string[];
  fetchedAt: number;
  sourceUpdatedAt?: string; // GitHub updatedAt — staleness signal
  revision: number; // bumped on every set/refresh of the same issue
}

/** spec 194: one row in the `#ticket` picker (from `gh issue list`). */
export interface TicketPickerRow {
  number: number;
  title: string;
  labels: string[];
  state: 'open' | 'closed';
  updatedAt?: string;
  url: string;
}

/** spec 178: the snapshot any surface pulls for one issue — the persisted binding
 *  merged with the live lane status. Refresh-safe: a browser reload re-pulls this. */
export interface IssueStatusSnapshot {
  bound: boolean;
  binding?: IssueBinding;
  laneStatus?: string;
  lastMessage?: string;
  pendingPermissions?: number;
  attention?: number;
}

/** spec 136: one user prompt captured while the lane was busy, awaiting drain. */
export interface QueuedPrompt {
  /** Trimmed prompt text as submitted. */
  text: string;
  /** Frozen snapshot of staged images at enqueue (isolated from later composer edits). */
  images: StagedImage[];
  /** Lane display names resolved via parseMentionFanOut AT ENQUEUE (empty if not a
   *  mention); drives the →lane row tag without re-parsing at render. */
  mentionTargets: string[];
  /** Frozen trusted origin; a queued Telegram turn keeps its one-turn bypass. */
  telegramCaller?: TelegramControlCaller;
}

export interface TranscriptScrollAnchor {
  msgId: string;
  offsetTop: number;
}

export interface SessionPickerState {
  open: boolean;
  phase: 'sessions' | 'backend' | 'loading' | 'error';
  backendCursor: number;
  sessionCursor: number;
  backendId: string | null;
  probeClient: AcpClient | null;
  initInfo: AgentInitInfo | null;
  capabilities: AcpSessionCapabilities | null;
  sessions: AcpSessionInfo[];
  nextCursor: string | null;
  error: string | null;
}
