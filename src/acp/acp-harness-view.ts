// Krypton — ACP Harness View.
// Coordinates several independent ACP subprocesses for one project directory.

import { prepareWithSegments, layoutWithLines } from '@chenglou/pretext';
import { Marked } from 'marked';
import { markedHighlight } from 'marked-highlight';
import hljs from 'highlight.js';
import 'highlight.js/styles/github-dark.css';
import * as smd from 'streaming-markdown';
import { invoke, convertFileSrc } from '@tauri-apps/api/core';
import { listen, type UnlistenFn } from '@tauri-apps/api/event';
import { openExternalUrl } from '../external-url';
import { AcpClient } from './client';
import { renderDiffPreview } from './diff-render';
import type {
  AcpAgentMode,
  AcpAvailableCommand,
  AcpBackendDescriptor,
  AcpEvent,
  DiffReviewComment,
  AcpMcpCapabilities,
  AcpMcpServerDescriptor,
  AcpSessionCapabilities,
  AcpSessionInfo,
  AgentInfo,
  AgentInitInfo,
  ContentBlock,
  HarnessLaneStatus,
  HarnessMcpLaneStats,
  ArtifactComment,
  ArtifactFeedbackEnvelope,
  DocArtifactRequestEnvelope,
  DocComment,
  DocFeedbackEnvelope,
  HarnessMemoryEntry,
  HarnessMemorySession,
  InterLaneEnvelope,
  LaneSummary,
  ModelInfo,
  PermissionOption,
  PlanEntry,
  ProviderErrorPayload,
  ReviewPriorityRange,
  StopReason,
  ToolCall,
  ToolCallUpdate,
  UsageInfo,
} from './types';
import { LaneBus } from './lane-bus';
import { AttentionTriageStore } from './attention-triage';
import {
  renderTriageOverlay,
  type TriageOverlayViewModel,
} from './attention-overlay';
import { ReviewQualityStore } from './review-quality';
import { ReviewPriorityStore } from './review-priority-store';
import {
  renderReviewPriorityOverlay,
  type ReviewPriorityOverlayViewModel,
} from './review-priority-overlay';
import { ArtifactFeedbackQueue, DocArtifactRequestQueue, DocFeedbackQueue } from './artifact-feedback';
import { DiffReviewQueue } from './diff-review';
import {
  InterLaneCoordinator,
  PEER_SEND_DEFERRED_TOOL_HINT,
  type CoordinatorDrainContext,
  type InterLaneRowChannel,
  type LaneHost,
  type PendingPeerSummary,
} from './inter-lane';
import { HarnessTelemetryPublisher } from './harness-telemetry';
import type { LaneResourceSample } from './harness-telemetry';
import {
  nextLaneNumber,
  registerHarness,
  unregisterHarness,
  notifyForeignLaneClosed,
  peersFor,
  resolveDisplayName,
  harnessEntry,
  listHarnessEntries,
  type HarnessEntry,
} from './harness-directory';
import { publishControlEvent, type ControlEventKind } from './control-publish';
import { parseMentionFanOut } from './mention-parse';
import {
  applyMentionSelection,
  filteredMentionTargets,
  mentionPaletteContext,
  mentionPaletteVisible,
} from './mention-palette';
import {
  HASH_COMMANDS,
  type HashCommand,
  buildCommandManifest,
  filteredHashCommands,
  hashPaletteVisible,
} from './hash-commands';
import {
  HANDOFF_WRITE_PROMPT,
  type GithubIssueVerbInput,
  analyzeGithubIssuePrompt,
  createGithubIssuePrompt,
  directivePrompt,
  fixGithubIssuePrompt,
  goalSeedPrompt,
  handleGithubIssuePrompt,
  handoffResumePrompt,
  issueFixPrompt,
  postGithubCommentPrompt,
  renderActiveTicketPin,
  tagGithubIssuePrompt,
  tldrawDrawPrompt,
  wikiIngestPrompt,
  wikiRecallPrompt,
} from './harness-prompts';
import { hasVerbTokens, resolveVerbTokens } from './verb-compose';
import { injectableVerbNames, injectableVerbPrompt } from './verb-registry';
import { applyVerbSelection, filteredVerbNames, verbPaletteContext } from './verb-palette';

// Re-exported from their new home (spec 185 moved the prompt builders to
// harness-prompts.ts) so existing import sites — tests included — keep working.
export { directivePrompt, tldrawDrawPrompt, wikiIngestPrompt, wikiRecallPrompt } from './harness-prompts';
import {
  POLLY_ROLE_PROMPTS,
  parsePollyTask,
  pollyRequestPrompt,
  pollyWorkerBackendsFor,
  type PollyEnsureOutcome,
  type PollyRoster,
  type PollyWorkerBackend,
} from './polly';
import {
  DEBBY_ROLE_PROMPTS,
  debbyHeadBackendsFor,
  debbyRequestPrompt,
  parseDebbyTask,
  type DebbyBuiltinRole,
  type DebbyEnsureOutcome,
  type DebbyHeadBackend,
  type DebbyRoster,
} from './debby';
import {
  SALTY_ROLE_PROMPTS,
  parseSaltyCommand,
  resolveSaltyModel,
  saltyExecutorPlan,
  saltyRequestPrompt,
  type SaltyEnsureOutcome,
  type SaltyExecutorRole,
  type SaltyExecutorSpec,
  type SaltyModelApply,
  type SaltyRole,
  type SaltyRoster,
} from './salty';
import {
  reviewRequestPrompt,
  REVIEW_INTENT_CAP,
  type ReviewSubject,
} from './review';
import type {
  JudgementItem,
  ReviewFinding,
  ReviewGitState,
} from './types';
import type {
  AcpLaneMetrics,
  AcpLaneProcMetric,
  CapturedImage,
  ContentView,
  LeaderKeyBinding,
  LeaderKeySpec,
  PaneContentType,
} from '../types';
import type { PaletteAction, PaletteContext } from '../palette-types';
import type { ViewBus } from '../view-bus';
import type { AttentionTier } from '../view-bus-types';
import { SYSTEM_SOURCE } from '../view-bus-types';
import { providerForBackend, type UsageProvider } from '../usage-store';
import {
  loadConfig,
  getAcpHarnessConfig,
  getAcpHarnessConfigPath,
  type LaneModelConfig,
  type HarnessDirective,
} from '../config';
import { extractModifiedPath } from './acp-harness-memory';
import { classifyBashCommand } from '../agent/tools';
import { classifyProviderError, shouldAppendProviderError, stripAnsi } from './provider-error';
import {
  loadProjectMcpServers,
  filterByCapability,
  dedupeByName,
  gcJunieMcpOverlays,
  removeJunieMcpOverlay,
  writeJunieMcpOverlay,
  gcClineMcpOverlays,
  removeClineMcpOverlay,
  writeClineMcpOverlay,
  prepareCursorMcp,
  cleanupCursorMcp,
  JUNIE_MCP_CAPABILITIES,
} from './mcp-bridge';

type ComposerFocus = 'text' | 'transcript';
type PendingExtraction = never;

interface HarnessPermission {
  requestId: number;
  toolCall: ToolCall;
  options: PermissionOption[];
  resolvedLabel?: string;
  auto?: boolean;
  transcriptItem?: HarnessTranscriptItem;
}

interface HarnessTranscriptItem {
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
}

/** spec 133 — transcript card for a registered HTML artifact. */
interface ArtifactCardPayload {
  id: string;
  title: string;
  laneLabel: string;
  /** Absolute file path opened via `open_url(file://…)`. */
  path: string;
  size: number | null;
  hash: string | null;
  /** false once the file is swept/cancelled — the card reports "unavailable". */
  available: boolean;
  /** Hint label assigned while artifact hint mode is active, else null. */
  hintLabel: string | null;
}

interface InterLanePayload {
  direction: 'in' | 'out';
  peerId: string;
  peerDisplayName: string;
  peerBackendId?: string;
  done: boolean;
  envelopeId?: string;
  channel?: InterLaneRowChannel;
}

interface LaneMailProvenance {
  envelopeId: string;
  peerDisplayName: string;
  envelopeCount: number;
}

interface FsWriteReviewPayload {
  requestId: number;
  path: string;
  oldText: string;
  newText: string;
  resolved?: 'accepted' | 'rejected';
}

interface FsActivityPayload {
  method: 'read' | 'write';
  path: string;
  ok: boolean;
  error?: string;
}

type HarnessToolFamily = 'memory' | 'peer' | 'attention' | 'review';
type PermissionDecision = 'pending' | 'accepted' | 'rejected' | 'auto_allowed' | 'failed';

interface PermissionPayload {
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

interface ToolPayload {
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

interface StagedImage {
  data: string;
  mimeType: string;
  path: string | null;
}

interface LanePeekState {
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

const LANE_PEEK_HEAT_TAIL = 200;
const LANE_PEEK_HEAT_SESSION_TAIL = 400;
const LANE_PEEK_HEAT_RING_MAX = 240;
const LANE_PEEK_HEAT_RING_MS = 10 * 60_000;
const LANE_PEEK_HEAT_SAMPLE_MIN_MS = 900;
const LANE_PEEK_HEAT_PENDING_PEER_WEIGHT = 2;

const MAX_STAGED_IMAGES = 4;
const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
const MEMORY_PERMISSION_SCAN_DEPTH = 8;
const LANE_PEEK_DWELL_MS = 8_000;
const LANE_PEEK_RECENT_MS = 5 * 60_000;
/** spec 118 — peer peek tiers: awaiting 10, inbound 20, counterpart 30 */
export const PEER_PREEMPT_MAX_PRIORITY = 30;
/** spec 133 — alphabet for artifact hint labels (mirrors the `f` hint mode). */
const ARTIFACT_HINT_ALPHABET = 'asdfghjklqweruiop';

/** spec 133 — frontend mirror of a Rust artifact registry entry. */
type HarnessArtifactState = 'pending' | 'registered_live';
interface HarnessArtifactRecord {
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

interface ArtifactEventPayload {
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

const HARNESS_MEMORY_TOOL_NAMES = new Set(['handoff_set', 'handoff_get', 'handoff_list']);
const HARNESS_PEER_TOOL_NAMES = new Set(['peer_send', 'peer_list']);
// spec 130: attention triage is default-on built-in harness-bus tooling, so its
// calls must auto-allow like memory/peer — a permission prompt here also
// breaks the non-blocking contract (the lane proceeds with `chosen`, never waits).
const HARNESS_ATTENTION_TOOL_NAMES = new Set(['attention_flag', 'attention_resolve']);
// spec 146: review_outcome is default-on built-in harness-bus tooling (the
// authoring lane self-reports a #review summary), so it must auto-allow like
// the others — a permission prompt mid-synthesis would derail the round.
// spec 160: mark_review_priority is likewise default-on — the authoring lane
// reports diff reading-order hints at end-of-turn; a permission prompt there
// would interrupt the turn boundary for a purely-advisory signal.
const HARNESS_REVIEW_TOOL_NAMES = new Set(['review_outcome', 'mark_review_priority']);
// spec 178: issue_progress is default-on built-in harness-bus tooling — the lane
// reports github issue-fixing progress to refresh the live status card. It must
// auto-allow like the others; a permission prompt on every progress report would
// defeat the live-overlay story (and the report is advisory, never destructive).
const HARNESS_ISSUE_TOOL_NAMES = new Set(['issue_progress']);
const HARNESS_AUTO_ALLOW_TOOL_NAMES = new Set([
  ...HARNESS_MEMORY_TOOL_NAMES,
  ...HARNESS_PEER_TOOL_NAMES,
  ...HARNESS_ATTENTION_TOOL_NAMES,
  ...HARNESS_REVIEW_TOOL_NAMES,
  ...HARNESS_ISSUE_TOOL_NAMES,
]);
const HARNESS_SERVER_MARKERS = ['krypton-harness-bus', 'krypton_harness_bus', 'krypton-harness-memory', 'krypton_harness_memory', '/mcp/harness/'];

// spec 139/148: the #handoff / #resume / #goal one-shot prompts now live in
// harness-prompts.ts (spec 185) alongside the other built-in command prompts.

function controlError(code: string, message: string): Error {
  return Object.assign(new Error(message), { code, retryable: false });
}

function requiredString(params: Record<string, unknown>, key: string): string {
  const value = params[key];
  if (typeof value !== 'string' || value.length === 0) {
    throw controlError('invalid_request', `${key} must be a non-empty string`);
  }
  return value;
}

function requiredNumber(params: Record<string, unknown>, key: string): number {
  const value = params[key];
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw controlError('invalid_request', `${key} must be a number`);
  }
  return value;
}

// spec 144: #wiki / #recall maintain an LLM-Wiki-style code wiki in the target
// repo at <cwd>/docs/wiki/ (NOT the harness memory store — see docs/adr/0003).
// The prompt builders moved to harness-prompts.ts (spec 185).

interface FileTouchRecord {
  path: string;
  laneId: string;
  laneDisplayName: string;
  toolKind: 'edit' | 'write_like';
  at: number;
}

/** spec 156: what the lane is doing right now, shown in the busy status chip.
 *  Written as plain field assignments on the hot streaming path (no render
 *  call); the existing 1 s composer tick paints it. */
interface LaneActivity {
  kind: 'tool' | 'thinking' | 'writing';
  /** tool title (preferred) or kind; empty for thinking/writing */
  label: string;
}

/** spec 127: in-flight live model switch, used to revert/attribute correctly. */
interface PendingModelSwitch {
  epoch: number;
  prevModelName: string | null;
  prevModelId: string | null;
  prevModeId: string | null;
  pickedName: string;
}

interface PendingUserEcho {
  itemId: string;
  text: string;
  received: string;
}

interface HarnessLane {
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
  /** spec 143: armed for one peer-injected turn (auto_accept). Auto-accepts every
   *  permission EXCEPT high-risk commands, which still prompt. Reset at turn end. */
  peerAutoAcceptForTurn: boolean;
  pendingTurnExtractions: PendingExtraction[];
  currentUserId: string | null;
  pendingUserEcho: PendingUserEcho | null;
  currentAssistantId: string | null;
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
  /** spec 148: active focus-scope goal, or undefined. Session-only harness-lane
   *  runtime state confined to THIS lane: it rides this lane's own turns via
   *  renderPromptMemoryPacket (never other lanes' / programmatic turns) and survives
   *  `#new`; dropped only on `#goal clear`, a replacing `#goal`, or lane close. */
  goal?: LaneGoal;
}

/** spec 148: a per-lane focus-scope goal — the current task the lane is anchored
 *  to. Not a completion condition (no evaluator, no auto-continue); just scope. */
interface LaneGoal {
  text: string;
  setAt: number;
}

/** spec 178: GitHub issue-fixing. A binding between a GitHub issue and the lane
 *  fixing it. Lives in a harness-level map keyed by `issueKey`, persisted to disk
 *  so it survives a Krypton restart (the lane process does not). `phase/summary/
 *  prUrl` are lane self-reported via the `issue_progress` MCP tool. */
type IssuePhase =
  | 'investigating' | 'fixing' | 'testing'
  | 'review' | 'pr_opened' | 'done' | 'blocked';

interface IssueBinding {
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
interface ActiveWorkTicket {
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
interface TicketPickerRow {
  number: number;
  title: string;
  labels: string[];
  state: 'open' | 'closed';
  updatedAt?: string;
  url: string;
}

/** spec 178: the snapshot any surface pulls for one issue — the persisted binding
 *  merged with the live lane status. Refresh-safe: a browser reload re-pulls this. */
interface IssueStatusSnapshot {
  bound: boolean;
  binding?: IssueBinding;
  laneStatus?: string;
  lastMessage?: string;
  pendingPermissions?: number;
  attention?: number;
}

/** spec 136: one user prompt captured while the lane was busy, awaiting drain. */
interface QueuedPrompt {
  /** Trimmed prompt text as submitted. */
  text: string;
  /** Frozen snapshot of staged images at enqueue (isolated from later composer edits). */
  images: StagedImage[];
  /** Lane display names resolved via parseMentionFanOut AT ENQUEUE (empty if not a
   *  mention); drives the →lane row tag without re-parsing at render. */
  mentionTargets: string[];
}

interface TranscriptScrollAnchor {
  msgId: string;
  offsetTop: number;
}

interface SessionPickerState {
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

const STICK_THRESHOLD_PX = 32;

const METRICS_POLL_MS = 2000;

// Braille spinner frames driven by a single JS interval (mirrors the agent
// view's SPINNER_FRAMES). A shared frame counter, re-applied to every spinner
// element on each tick, keeps the glyph continuous across DOM rebuilds — unlike
// a CSS animation, which restarts whenever its host element is recreated (the 2s
// metrics-poll head rebuild, the 1s composer tick), reading as a stutter / snap.
const SPINNER_FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];
const SPINNER_INTERVAL_MS = 80;

export const ACP_HARNESS_LEADER_KEYS: readonly LeaderKeySpec[] = [
  { key: '+', label: 'Add Lane', group: 'Harness' },
  { key: '_', label: 'Close Active Lane', group: 'Harness', effect: 'danger' },
  { key: '=', label: 'Lane Metrics', group: 'Harness' },
  { key: '0', label: 'Resume Session', group: 'Harness', effect: 'important' },
  { key: '.', label: 'Directives', group: 'Harness' },
];

const BACKEND_LABELS: Record<string, string> = {
  codex: 'Codex',
  claude: 'Claude',
  opencode: 'OpenCode',
  'pi-acp': 'Pi',
  droid: 'Droid',
  cursor: 'Cursor',
  junie: 'Junie',
  omp: 'OMP',
  grok: 'Grok',
  copilot: 'Copilot',
  mimo: 'MiMo',
  cline: 'Cline',
};

export function harnessBackends(backends: AcpBackendDescriptor[]): AcpBackendDescriptor[] {
  return backends.filter((backend) => backend.id !== 'gemini');
}

function backendLabel(backendId: string): string {
  return BACKEND_LABELS[backendId] ?? backendId.charAt(0).toUpperCase() + backendId.slice(1);
}

/** spec 141: normalize a cwd for cross-project comparison (cross_project_review,
 *  same-repo grouping). Strips a trailing slash so `/repo` and `/repo/` match.
 *  Symlink resolution would need Rust; the realistic cross-project case is
 *  clearly-distinct roots, which this already separates. null cwds never match a
 *  real path. */
function normalizeCwd(cwd: string | null): string | null {
  if (!cwd) return null;
  const trimmed = cwd.replace(/\/+$/, '');
  return trimmed.length > 0 ? trimmed : '/';
}

// spec 125 — lane-rail disambiguation helpers. Pure, side-effect-free
// derivations from data the schema already carries (HarnessLane.backendId,
// HarnessDirective.task / title). Exported so unit tests can exercise the
// table-driven mapping without spinning up a view.
export type DirectiveRoleBucket =
  | 'analysis'
  | 'review'
  | 'impl'
  | 'plan'
  | 'explore'
  | 'hash-1'
  | 'hash-2'
  | 'hash-3';

// djb2-style hash → 3 buckets. Stable across renders so two lanes with the
// same custom `task` always land in the same fallback color.
export function hashBucket(s: string): 'hash-1' | 'hash-2' | 'hash-3' {
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0;
  const i = Math.abs(h) % 3;
  return i === 0 ? 'hash-1' : i === 1 ? 'hash-2' : 'hash-3';
}

// Patterns are checked in declaration order. Overlap is intentional: a
// directive titled "review-implementation" lands in `review`, not `impl`.
export function directiveRole(task: string): DirectiveRoleBucket {
  const t = task.trim().toLowerCase();
  if (!t) return hashBucket('');
  if (/\banaly|\bdiagnos/.test(t)) return 'analysis';
  if (/\breview/.test(t)) return 'review';
  if (/\bimplement|\bimpl|\bfix/.test(t)) return 'impl';
  if (/\bplan|\bdesign|\bspec/.test(t)) return 'plan';
  if (/\bexplor|\bsurvey|\bmap|\bresearch|\binvestigat/.test(t)) return 'explore';
  return hashBucket(t);
}

// Decoupled from `directiveRole()` so a `task = "refactor"` can hash to a
// stable color while the chip still reads "refactor", not the bucket id.
export function directiveTagLabel(task: string): string {
  const t = task.trim().toLowerCase();
  if (!t) return 'custom';
  if (/\banaly|\bdiagnos/.test(t)) return 'analysis';
  if (/\breview/.test(t)) return 'review';
  if (/\bimplement|\bimpl|\bfix/.test(t)) return 'impl';
  if (/\bplan|\bdesign|\bspec/.test(t)) return 'plan';
  if (/\bexplor|\bsurvey|\bmap|\bresearch|\binvestigat/.test(t)) return 'explore';
  return t;
}

export function backendLogoId(backendId: string): string {
  switch (backendId) {
    case 'claude':
      return 'krypton-logo-claude';
    case 'codex':
      return 'krypton-logo-codex';
    case 'opencode':
      return 'krypton-logo-opencode';
    case 'pi-acp':
      return 'krypton-logo-pi';
    case 'droid':
      return 'krypton-logo-droid';
    case 'cursor':
      return 'krypton-logo-cursor';
    case 'junie':
      return 'krypton-logo-junie';
    case 'omp':
      return 'krypton-logo-omp';
    case 'grok':
      return 'krypton-logo-grok';
    case 'copilot':
      return 'krypton-logo-copilot';
    case 'mimo':
      return 'krypton-logo-mimo';
    case 'cline':
      return 'krypton-logo-cline';
    default:
      return 'krypton-logo-omp';
  }
}

// Presentation-only: strips a single leading "<BackendLabel> " token so the
// rail does not echo the backend that the logo + lane name already say.
// Never mutates storage; the picker and peer_list still see the full title.
export function trimBackendPrefix(title: string, backendId: string): string {
  const label = BACKEND_LABELS[backendId];
  if (!label) return title;
  const prefix = label + ' ';
  return title.startsWith(prefix) ? title.slice(prefix.length) : title;
}

// Inline <symbol> defs for the thirteen built-in backends. Geometry is copied
// from docs/prototypes/125-lane-rail-disambiguation.html — keep both sides
// in sync if iterated. All strokes/fills use currentColor so the rail can
// recolor via a single CSS class.
export const BACKEND_LOGO_SVG_DEFS = [
  // claude: 8-spoke asterisk
  '<symbol id="krypton-logo-claude" viewBox="0 0 16 16">' +
    '<g stroke="currentColor" stroke-width="1.4" stroke-linecap="round" fill="none">' +
    '<line x1="8" y1="2" x2="8" y2="14"/>' +
    '<line x1="2" y1="8" x2="14" y2="8"/>' +
    '<line x1="3.8" y1="3.8" x2="12.2" y2="12.2"/>' +
    '<line x1="3.8" y1="12.2" x2="12.2" y2="3.8"/>' +
    '</g></symbol>',
  // codex/openai: hex ring with dot
  '<symbol id="krypton-logo-codex" viewBox="0 0 16 16">' +
    '<polygon points="8,1.6 13.6,5 13.6,11 8,14.4 2.4,11 2.4,5" fill="none" stroke="currentColor" stroke-width="1.3"/>' +
    '<circle cx="8" cy="8" r="1.6" fill="currentColor"/>' +
    '</symbol>',
  // opencode: curly braces
  '<symbol id="krypton-logo-opencode" viewBox="0 0 16 16">' +
    '<path d="M6 2 Q3.5 2 3.5 4.5 V7 Q3.5 8 2.2 8 Q3.5 8 3.5 9 V11.5 Q3.5 14 6 14" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/>' +
    '<path d="M10 2 Q12.5 2 12.5 4.5 V7 Q12.5 8 13.8 8 Q12.5 8 12.5 9 V11.5 Q12.5 14 10 14" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/>' +
    '</symbol>',
  // pi-acp: pi glyph
  '<symbol id="krypton-logo-pi" viewBox="0 0 16 16">' +
    '<path d="M2.5 5 H13.5 M5 5 V12 Q5 13 6 13 M11 5 V12 Q11 13 12 13 M13 13 L13.5 11" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/>' +
    '</symbol>',
  // droid: robot face
  '<symbol id="krypton-logo-droid" viewBox="0 0 16 16">' +
    '<rect x="2.5" y="3.5" width="11" height="9" rx="1.6" fill="none" stroke="currentColor" stroke-width="1.3"/>' +
    '<circle cx="6" cy="7.5" r="1" fill="currentColor"/>' +
    '<circle cx="10" cy="7.5" r="1" fill="currentColor"/>' +
    '<line x1="6.5" y1="10.5" x2="9.5" y2="10.5" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/>' +
    '<line x1="8" y1="1.5" x2="8" y2="3.5" stroke="currentColor" stroke-width="1.3"/>' +
    '</symbol>',
  // cursor: isometric cube, filled top face (Anysphere mark)
  '<symbol id="krypton-logo-cursor" viewBox="0 0 16 16">' +
    '<polygon points="8,1.6 13.6,5 13.6,11 8,14.4 2.4,11 2.4,5" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linejoin="round"/>' +
    '<path d="M8 1.6 L13.6 5 L8 8.4 L2.4 5 Z" fill="currentColor"/>' +
    '<line x1="8" y1="8.4" x2="8" y2="14.4" stroke="currentColor" stroke-width="1.3"/>' +
    '</symbol>',
  // junie: bracket frame (jetbrains-ish)
  '<symbol id="krypton-logo-junie" viewBox="0 0 16 16">' +
    '<rect x="2.5" y="2.5" width="11" height="11" fill="none" stroke="currentColor" stroke-width="1.3"/>' +
    '<path d="M5.5 5.5 H10.5 M10.5 5.5 V9.5 Q10.5 11 9 11 H7.5" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/>' +
    '</symbol>',
  // omp: concentric rings (also serves as neutral fallback)
  '<symbol id="krypton-logo-omp" viewBox="0 0 16 16">' +
    '<circle cx="8" cy="8" r="5.5" fill="none" stroke="currentColor" stroke-width="1.3"/>' +
    '<circle cx="8" cy="8" r="2" fill="none" stroke="currentColor" stroke-width="1.3"/>' +
    '<circle cx="8" cy="8" r="0.6" fill="currentColor"/>' +
    '</symbol>',
  // grok/xai: angular bolt (hard-edged, x.ai identity)
  '<symbol id="krypton-logo-grok" viewBox="0 0 16 16">' +
    '<path d="M9.2 1.5 L3.8 8.8 H6.9 L5.8 14.5 L12.2 6.6 H8.8 Z" fill="currentColor"/>' +
    '</symbol>',
  // copilot: rounded goggle/visor head + antenna (GitHub Copilot mascot)
  '<symbol id="krypton-logo-copilot" viewBox="0 0 16 16">' +
    '<path d="M8 5 V3" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/>' +
    '<rect x="2.5" y="5" width="11" height="7.4" rx="3.2" fill="none" stroke="currentColor" stroke-width="1.4"/>' +
    '<ellipse cx="6.2" cy="8.7" rx="0.95" ry="1.5" fill="currentColor"/>' +
    '<ellipse cx="9.8" cy="8.7" rx="0.95" ry="1.5" fill="currentColor"/>' +
    '</symbol>',
  // mimo: "mi" mark in a rounded tile (Xiaomi MiMo-Code)
  '<symbol id="krypton-logo-mimo" viewBox="0 0 16 16">' +
    '<rect x="2" y="2" width="12" height="12" rx="3.2" fill="none" stroke="currentColor" stroke-width="1.3"/>' +
    '<path d="M4.8 11 V6 H7.6 Q8.8 6 8.8 7.2 V11" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"/>' +
    '<line x1="11.2" y1="6" x2="11.2" y2="11" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/>' +
    '</symbol>',
  // cline: terminal prompt bracket + caret (CLI coding agent)
  '<symbol id="krypton-logo-cline" viewBox="0 0 16 16">' +
    '<rect x="2" y="2.5" width="12" height="11" rx="2.4" fill="none" stroke="currentColor" stroke-width="1.3"/>' +
    '<path d="M5 6.2 L7.4 8 L5 9.8" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"/>' +
    '<line x1="8.6" y1="10.2" x2="11" y2="10.2" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/>' +
    '</symbol>',
].join('');

// Lane-bar telemetry icons — same <symbol>/<use> + currentColor mechanism as the
// backend logos above, sized to the text cell in CSS so they recolour per lane
// accent / status with no glyph-font dependency. Geometry mirrors the approved
// artifact (art-2 — ACP harness lane bar). Injected once in buildDOM().
export const HARNESS_ICON_SVG_DEFS = [
  // status set (row 1 leading glyph) — tinted by state via the symbol's color
  '<symbol id="krypton-icon-status-starting" viewBox="0 0 16 16"><circle cx="8" cy="8" r="2.2" fill="currentColor"/></symbol>',
  '<symbol id="krypton-icon-status-idle" viewBox="0 0 16 16"><circle cx="8" cy="8" r="4.4" fill="none" stroke="currentColor" stroke-width="1.5"/></symbol>',
  '<symbol id="krypton-icon-status-busy" viewBox="0 0 16 16"><circle cx="8" cy="8" r="4" fill="currentColor"/></symbol>',
  '<symbol id="krypton-icon-status-perm" viewBox="0 0 16 16"><circle cx="8" cy="8" r="6" fill="none" stroke="currentColor" stroke-width="1.4"/><line x1="8" y1="4.6" x2="8" y2="9" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/><circle cx="8" cy="11.3" r="0.9" fill="currentColor"/></symbol>',
  '<symbol id="krypton-icon-status-peer" viewBox="0 0 16 16"><g fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"><path d="M3 6 H12 M10 4 L12 6 L10 8"/><path d="M13 10 H4 M6 8 L4 10 L6 12"/></g></symbol>',
  '<symbol id="krypton-icon-status-error" viewBox="0 0 16 16"><circle cx="8" cy="8" r="6" fill="none" stroke="currentColor" stroke-width="1.4"/><path d="M5.6 5.6 L10.4 10.4 M10.4 5.6 L5.6 10.4" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/></symbol>',
  // chip + stat glyphs
  '<symbol id="krypton-icon-check" viewBox="0 0 16 16"><path d="M3.5 8.4 L6.4 11.3 L12.5 4.7" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"/></symbol>',
  '<symbol id="krypton-icon-warn" viewBox="0 0 16 16"><path d="M8 2.6 L14.6 13.4 H1.4 Z" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linejoin="round"/><line x1="8" y1="6.6" x2="8" y2="9.9" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/><circle cx="8" cy="11.6" r="0.8" fill="currentColor"/></symbol>',
  '<symbol id="krypton-icon-inbox" viewBox="0 0 16 16"><rect x="2.4" y="4" width="11.2" height="8" rx="1" fill="none" stroke="currentColor" stroke-width="1.3"/><path d="M2.8 5 L8 9 L13.2 5" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"/></symbol>',
  '<symbol id="krypton-icon-gauge" viewBox="0 0 16 16"><path d="M2.8 11.8 A5.6 5.6 0 1 1 13.2 11.8" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" opacity="0.4"/><path d="M2.8 11.8 A5.6 5.6 0 0 1 5.2 4.6" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></symbol>',
  '<symbol id="krypton-icon-dl" viewBox="0 0 16 16"><path d="M8 3 V12 M4.6 8.5 L8 12 L11.4 8.5" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></symbol>',
  '<symbol id="krypton-icon-ul" viewBox="0 0 16 16"><path d="M8 13 V4 M4.6 7.5 L8 4 L11.4 7.5" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></symbol>',
  '<symbol id="krypton-icon-list" viewBox="0 0 16 16"><g stroke="currentColor" stroke-width="1.4" stroke-linecap="round"><line x1="3.5" y1="5" x2="12.5" y2="5"/><line x1="3.5" y1="8" x2="12.5" y2="8"/><line x1="3.5" y1="11" x2="12.5" y2="11"/></g></symbol>',
  '<symbol id="krypton-icon-tool" viewBox="0 0 16 16"><path d="M11.2 2.4 a2.8 2.8 0 0 0 -3.5 3.5 L2.8 10.8 a1.25 1.25 0 0 0 1.8 1.8 L9.5 7.5 a2.8 2.8 0 0 0 3.5 -3.5 L11 6 L9.4 6 L9.4 4.4 Z" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linejoin="round"/></symbol>',
].join('');

/** Lane-bar telemetry icon — references a HARNESS_ICON_SVG_DEFS symbol. The svg
 * inherits currentColor so it recolours with its container (lane accent/status). */
function harnessIcon(id: string, cls = ''): string {
  return `<svg class="acp-harness__icon${cls ? ` ${cls}` : ''}" aria-hidden="true"><use href="#krypton-icon-${id}"/></svg>`;
}

const OPENCODE_DEFAULT_MODEL = 'zai-coding-plan/glm-5.1';
const FILE_TOUCH_WINDOW_MS = 10 * 60 * 1000;

// Tail-window rendering. Only the last N transcript rows render into the DOM
// to keep `renderActiveTranscript()` cheap on long sessions. See Spec 103.
const TRANSCRIPT_WINDOW_STEP = 60;
const TRANSCRIPT_WINDOW_DEFAULT = TRANSCRIPT_WINDOW_STEP;
const HIDDEN_INDICATOR_ID = '__hidden_indicator__';

// Spec 114: dev-only assertion gate. Mirrors the pattern in view-bus.ts
// to read Vite's `import.meta.env.DEV` without requiring the vite/client
// ambient types in tsconfig. Stripped to `false` in production bundles
// so the reduce-over-transcript check never runs.
const SPEC114_DEV = Boolean(
  (import.meta as unknown as { env?: { DEV?: boolean } }).env?.DEV,
);

// Immutable defaults shared across all lanes. Mutable containers (arrays,
// Maps, Sets) MUST NOT live here — createLane() instantiates fresh ones
// per lane to prevent reference aliasing.
/** spec 136: cap on queued-while-busy prompts per lane. */
const PROMPT_QUEUE_MAX = 10;

const LANE_DEFAULTS = {
  client: null,
  status: 'starting' as const,
  draft: '',
  cursor: 0,
  spawnEpoch: 0,
  usage: null,
  sessionId: null,
  modelName: null,
  modelApplyFailed: false,
  availableModels: [] as ModelInfo[],
  currentModelId: null,
  modelSwitchEpoch: 0,
  pendingModelSwitch: null,
  supportsEmbeddedContext: false,
  error: null,
  acceptAllForTurn: false,
  rejectAllForTurn: false,
  permissionMode: 'normal' as const,
  peerAutoAcceptForTurn: false,
  currentUserId: null,
  pendingUserEcho: null,
  currentAssistantId: null,
  currentThoughtId: null,
  stickToBottom: true,
  savedScrollTop: 0,
  savedScrollAnchor: null,
  pendingShellId: null,
  supportsImages: false,
  activeTurnStartedAt: null,
  activeSystemLabel: null,
  activity: null,
  currentMode: null,
  slashPaletteIndex: 0,
  slashPaletteDismissed: false,
  mentionPaletteIndex: 0,
  mentionPaletteDismissed: false,
  hashPaletteIndex: 0,
  hashPaletteDismissed: false,
  verbPaletteIndex: 0,
  verbPaletteDismissed: false,
  plan: null,
  planCollapsed: false,
  lastKilled: '',
  transcriptWindow: TRANSCRIPT_WINDOW_DEFAULT,
  historyIndex: null,
  historySavedDraft: null,
  activeToolCount: 0,
  streamingMarkdownParser: null,
  streamingMarkdownBody: null,
  streamingMarkdownItemId: null,
  junieMcpOverlayDir: null,
  clineMcpOverlayDir: null,
  cursorMcpNames: null,
  pendingCoordinatorDrain: null,
  coordinatorDrainProvenanceUsed: false,
  activeDirectiveId: null,
  pendingDirectiveChange: null,
  turnDirectiveOverride: null,
  previousDirectiveId: null,
  pollyBuiltinRole: null,
  pollySavedPermissionMode: null,
  debbyBuiltinRole: null,
  saltyBuiltinRole: null,
  saltySavedPermissionMode: null,
  triageEquipped: true,
  triageOverride: null,
  flaggedThisTurn: false,
};

const md = new Marked(
  markedHighlight({
    langPrefix: 'hljs language-',
    highlight(code: string, lang: string): string {
      if (lang && hljs.getLanguage(lang)) {
        return hljs.highlight(code, { language: lang }).value;
      }
      return hljs.highlightAuto(code).value;
    },
  }),
);

/** spec 128: monotonic per-session counter so each harness instance publishes
 * attention counts under a distinct `sourceId`, letting the footer sum them. */
let harnessViewSeq = 0;

/** spec 180: orchestrator dispatch purpose — mirrors the `#polly` worker brief. */
export type DispatchPurpose = 'implement' | 'review' | 'explore' | 'search';
export const DISPATCH_PURPOSES: readonly DispatchPurpose[] = ['implement', 'review', 'explore', 'search'];

/** spec 180: cycle the dispatch purpose (Tab in the dispatch input). */
export function nextDispatchPurpose(current: DispatchPurpose): DispatchPurpose {
  const i = DISPATCH_PURPOSES.indexOf(current);
  return DISPATCH_PURPOSES[(i + 1) % DISPATCH_PURPOSES.length];
}

/** spec 180: the dispatch message body. A dispatch is a plain `peer_send` (it
 *  carries a purpose-tagged task), NOT a Goal-set — so the body is just the
 *  bracketed purpose + task, never a directive/goal envelope. */
export function orchestratorDispatchBody(purpose: DispatchPurpose, text: string): string {
  return `[${purpose}] ${text.trim()}`;
}

/** spec 180: why a dispatch to `targetId` is not allowed from `seatId`, or null
 *  when it is. The orchestrator cannot dispatch to itself, needs a real seat, and
 *  needs at least one other lane. */
export function dispatchDisabledReason(opts: {
  seatId: string | null;
  targetId: string | null;
  laneCount: number;
}): string | null {
  if (!opts.seatId) return 'no orchestrator seat';
  if (!opts.targetId) return 'no target';
  if (opts.targetId === opts.seatId) return 'cannot dispatch to the seat';
  if (opts.laneCount < 2) return 'no other lanes';
  return null;
}

/** spec 181 (+ follow-up): what answering the selected console card does. A
 *  pending request resolves to its action — `accept` or `reject` — inline; no
 *  pending permission → `none`. High-risk commands are no longer blocked from
 *  the console: the selected-card strip surfaces the FULL command so the human
 *  reviews it in place (the lane view is no longer required to accept). */
export function consolePermissionAction(opts: {
  pending: boolean;
  action: 'accept' | 'reject';
}): 'accept' | 'reject' | 'none' {
  if (!opts.pending) return 'none';
  return opts.action;
}

/** spec 181: which all-for-turn flag an `A`/`R` press arms, given the resolved
 *  `consolePermissionAction` decision. A `none` decision arms NOTHING. `a`/`r`
 *  (lower-case, single answer) arm nothing either — only the shift-variants do. */
export function armConsolePermissionFlags(
  key: 'a' | 'A' | 'r' | 'R',
  decision: 'accept' | 'reject' | 'none',
): { acceptAll: boolean; rejectAll: boolean } {
  const all = key === 'A' || key === 'R';
  return {
    acceptAll: all && decision === 'accept',
    rejectAll: all && decision === 'reject',
  };
}

/** spec 182: why the orchestrator seat cannot be prompted from the console, or
 *  null when it can. A `busy` / `needs_permission` / `awaiting_peer` seat is fine
 *  — the prompt queues (spec 136) and drains on idle; only a missing or not-yet/
 *  no-longer-live seat blocks it. */
export function seatPromptDisabledReason(seat: { status: string } | null): string | null {
  if (!seat) return 'no orchestrator seat';
  if (seat.status === 'starting' || seat.status === 'error' || seat.status === 'stopped') {
    return `seat ${seat.status}`;
  }
  return null;
}

export function consumeOptimisticUserEcho(
  expected: string,
  received: string,
  chunk: string,
): { matched: boolean; received: string } {
  if (received === expected) {
    if (chunk.trim().length === 0) return { matched: true, received };
    // A duplicate echo of the same prompt may itself arrive chunked — restart
    // the consume cycle from this prefix (a full re-echo is the received ===
    // expected case of the restarted cycle).
    if (expected.startsWith(chunk)) return { matched: true, received: chunk };
    return { matched: false, received };
  }
  const next = received + chunk;
  if (expected.startsWith(next)) return { matched: true, received: next };
  if (next.startsWith(expected) && next.slice(expected.length).trim().length === 0) {
    return { matched: true, received: expected };
  }
  return { matched: false, received };
}

/** spec 182/184: inner HTML for an active dispatch/seat-prompt input. The box is
 *  a custom-rendered <span> (not a native <input>), so it has no OS caret — we
 *  render a blinking caret ourselves: after the draft text, or before the
 *  placeholder when the draft is still empty, so the operator can see the
 *  console is focused and accepting keystrokes. */
export function orchestratorInputHtml(draft: string, placeholder: string): string {
  const caret = '<span class="acp-orchestrator__caret"></span>';
  return draft
    ? `${esc(draft)}${caret}`
    : `${caret}<span class="acp-orchestrator__dispatch-placeholder">${esc(placeholder)}</span>`;
}

export class AcpHarnessView implements ContentView {
  readonly type: PaneContentType = 'acp_harness';
  readonly element: HTMLElement;

  /** Set by the compositor to drive the window's oscilloscope band. Pumped by any
   *  lane's streamed output — the band reads aggregate window activity. See docs/189. */
  onOutputPump?: (chars: number) => void;

  private projectDir: string | null;
  /** spec 128: global ViewBus, used to publish the open attention count so the
   * workspace footer can show it regardless of which view is focused. */
  private viewBus: ViewBus | null = null;
  /** spec 128: stable identity for this harness instance on the footer's
   * attention tally. Lets the footer aggregate across multiple harness tabs. */
  private readonly attentionSourceId = `harness-${++harnessViewSeq}`;
  /** Last attention count + tier published to the footer; dedupes redundant
   * signals (spec 138 — tier changes must re-publish even at the same count). */
  private lastPublishedAttention = -1;
  private lastPublishedTier: AttentionTier | null = null;
  /** spec 146: last review count published to the footer; dedupes the signal. */
  private lastPublishedReviews = -1;
  /** spec 162: last review-priority high-count published to the footer; dedupes. */
  private lastPublishedPriority = -1;
  private lanes: HarnessLane[] = [];
  private usageProviderListeners = new Set<() => void>();
  private activeLaneId = '';
  private laneBus = new LaneBus();
  private coordinator!: InterLaneCoordinator;
  /** spec 128: attention-triage demand queue + silent-turn audit. */
  private triageStore = new AttentionTriageStore(this.laneBus);
  private triageOverlayOpen = false;
  private triageSelectedIndex = 0;
  /** Non-null while the redirect one-line input is open for a selected item. */
  private triageRedirect: { itemId: string; draft: string } | null = null;
  private attentionFlagUnlisten: UnlistenFn | null = null;
  private attentionResolveUnlisten: UnlistenFn | null = null;
  /** spec 178: github issue-fixing bindings, keyed by issueKey. Persisted to disk
   *  (acp_save/load_issue_bindings) and rehydrated on register. */
  private readonly issueBindings = new Map<string, IssueBinding>();
  /** spec 194: the harness's shared working ticket (one per harness, or none). */
  private activeTicket: ActiveWorkTicket | null = null;
  /** spec 194: open `#ticket` picker — its own modal dialog (not a composer
   *  popup); the filter is typed live into the dialog (the draft was consumed
   *  by #ticket). */
  private ticketPicker: { rows: TicketPickerRow[]; filter: string; index: number } | null = null;
  private issueReportUnlisten: UnlistenFn | null = null;
  /** spec 146: review quality matrix — summary-only #review history per lane. */
  private reviewQualityStore = new ReviewQualityStore(this.laneBus);
  private reviewMatrixOverlayOpen = false;
  private reviewMatrixSelectedLaneIndex = 0;
  private reviewMatrixSelectedRowIndex = 0;
  /** Index of the expanded findings detail row within the selected lane, or null. */
  private reviewMatrixExpandedRowIndex: number | null = null;
  private reviewOutcomeUnlisten: UnlistenFn | null = null;
  /** spec 160/162: latest diff review-priority report per authoring lane. The
   *  Diff Window pulls a merged snapshot on open / refresh via the
   *  `diff.review-priority` control op; the footer + summon overlay (spec 162)
   *  read the same store. Session-only, dropped when the lane closes or the view
   *  disposes. */
  private reviewPriorityStore = new ReviewPriorityStore(this.laneBus);
  private reviewPriorityOverlayOpen = false;
  private reviewPrioritySelectedLaneIndex = 0;
  private reviewPriorityUnlisten: UnlistenFn | null = null;
  /** spec 180: the designated Orchestrator seat (≤1 per harness). A prompt-free
   *  badge field — NOT `pollyBuiltinRole`, which injects a prompt. Autonomy stays
   *  opt-in via `#polly`. Cleared when the seat lane closes/stops. */
  private orchestratorLaneId: string | null = null;
  private orchestratorConsoleOpen = false;
  /** j/k cursor over lane cards while the console is open. */
  private orchestratorSelectedLaneId: string | null = null;
  /** spec 184: cursor over the GLOBAL pending-permission queue (the laneId whose
   *  head request `a`/`r` answers). Independent of the card selection, so the
   *  operator confirms a worker's permission without switching the active lane.
   *  Falls back to the queue head when the focused lane is no longer pending. */
  private orchestratorPermFocusId: string | null = null;
  /** Non-null while the dispatch one-line input is open for the selected target. */
  private orchestratorDispatch: { draft: string; purpose: DispatchPurpose } | null = null;
  /** spec 182: non-null while the seat-prompt one-line input is open. Targets the
   *  orchestrator seat (a normal turn), independent of the j/k card selection. */
  private orchestratorSeatPrompt: { draft: string } | null = null;
  private orchestratorLaneBusUnsub: (() => void) | null = null;
  private interLaneUnlisten: UnlistenFn | null = null;
  private peerListUnlisten: UnlistenFn | null = null;
  private memoryEntries: HarnessMemoryEntry[] = [];
  private harnessMemoryId: string | null = null;
  /** spec 141: this view's entry in the process-wide HarnessDirectory, while
   * registered. Holds the `alive` flag the directory reads when routing. */
  private directoryEntry: HarnessEntry | null = null;
  private harnessMemoryPort: number | null = null;
  private harnessMemoryWarning: string | null = null;
  private gitBranch: string | null = null;
  private gitBranchLoading = false;
  private gitBranchProjectDir: string | null = null;
  private memoryUnlisten: UnlistenFn | null = null;
  private mcpStatsByLane = new Map<string, HarnessMcpLaneStats>();
  private mcpUnlisten: UnlistenFn | null = null;
  /** spec 133: HTML artifact registry mirror, keyed by artifact id. */
  private artifacts = new Map<string, HarnessArtifactRecord>();
  private artifactUnlisten: UnlistenFn | null = null;
  /** spec 149: per-lane artifact feedback queue, drained on the lane's next idle
   *  (a dedicated queue, NOT the peer LaneInbox). Constructed in the ctor. */
  private feedbackQueue: ArtifactFeedbackQueue;
  private docsFeedbackQueue: DocFeedbackQueue;
  private docsArtifactQueue: DocArtifactRequestQueue;
  private diffReviewQueue: DiffReviewQueue;
  private telemetryPublisher: HarnessTelemetryPublisher | null = null;
  private feedbackUnlisten: UnlistenFn | null = null;
  private docsFeedbackUnlisten: UnlistenFn | null = null;
  private docsArtifactUnlisten: UnlistenFn | null = null;
  /** spec 133: artifact hint mode (open-artifact labels), active only when on. */
  private artifactHintMode = false;
  private artifactHintBuffer = '';
  private fileTouchMap = new Map<string, FileTouchRecord>();
  private lanePeek: LanePeekState = {
    visible: true,
    dismissedAt: null,
    dismissedPriority: null,
    lockedLaneId: null,
    currentLaneId: null,
    currentReasonKey: null,
    selectedAt: 0,
  };
  /** Slice 109 — CPU / usage ring samples for peek heat (no extra timers). */
  private laneMetricHistory = new Map<string, LaneActivitySample[]>();
  private lanePeekHeatLastGlobalSample = 0;
  private lanePeekHeatMetric: LanePeekHeatMetric = 'auto';
  /** null = contextual window (30s for direct peer peek, else 5m). */
  private lanePeekHeatWindowExplicit: LanePeekHeatWindow | null = null;
  private lanePeekHeatExpanded = false;
  private memoryDrawerOpen = false;
  private helpOpen = false;
  private zenMode = false;
  /** spec 157: collapse tool cards to their head line, hide side-channel rows. */
  private conciseMode = false;
  private memoryCursorRowId: string | null = null;
  private focus: ComposerFocus = 'text';
  private chip: string | null = null;
  private chipTimer: number | null = null;
  private composerTickTimer: number | null = null;
  private toolTickTimer: number | null = null;
  private metricsBySession = new Map<number, AcpLaneMetrics>();
  private metricsTimer: number | null = null;
  private spinnerTimer: number | null = null;
  private spinnerFrame = 0;
  private metricsPanelOpen = false;
  private pickerOpen = false;
  private pickerCursor = 0;
  private pickerEntries: AcpBackendDescriptor[] = [];
  private sessionPickerEl!: HTMLElement;
  private sessionPicker: SessionPickerState = {
    open: false,
    phase: 'loading',
    backendCursor: 0,
    sessionCursor: 0,
    backendId: null,
    probeClient: null,
    initInfo: null,
    capabilities: null,
    sessions: [],
    nextCursor: null,
    error: null,
  };
  private nextLaneIndex = 1;
  private systemRows: string[] = ['loading ACP backends...'];
  private laneModels: Record<string, LaneModelConfig> = {};
  /** spec 124: reusable directives loaded from acp-harness.toml. */
  private directives: HarnessDirective[] = [];
  /** spec 124: directive picker overlay state. */
  private directivePickerOpen = false;
  private directivePickerCursor = 0;
  /** spec 163: directive whose lane the backend (lane) picker is about to spawn,
   * set by Shift+Enter in the directive picker. null = plain "+ new lane" flow. */
  private pendingSpawnDirectiveId: string | null = null;
  /** spec 127: model picker overlay state. */
  private modelPickerOpen = false;
  private modelPickerCursor = 0;
  /** spec 127: lane the model picker is acting on (captured at open). */
  private modelPickerLaneId: string | null = null;
  private closeCb: (() => void) | null = null;

  private dashboardEl!: HTMLElement;
  private memoryOverlayEl!: HTMLElement;
  private memoryPanelEl!: HTMLElement;
  private helpOverlayEl!: HTMLElement;
  private metricsOverlayEl!: HTMLElement;
  private triageOverlayEl!: HTMLElement;
  private triagePanelEl!: HTMLElement;
  private reviewMatrixOverlayEl!: HTMLElement;
  private reviewMatrixPanelEl!: HTMLElement;
  private reviewPriorityOverlayEl!: HTMLElement;
  private reviewPriorityPanelEl!: HTMLElement;
  private ticketOverlayEl!: HTMLElement;
  private ticketPanelEl!: HTMLElement;
  private orchestratorConsoleEl!: HTMLElement;
  private orchestratorPanelEl!: HTMLElement;
  private pickerEl!: HTMLElement;
  private directivePickerEl!: HTMLElement;
  private modelPickerEl!: HTMLElement;
  private planEl!: HTMLElement;
  private laneRailEl!: HTMLElement;
  private planSlotEl!: HTMLElement;
  private peekSlotEl!: HTMLElement;
  private pinSlotEl!: HTMLElement;
  private queueSlotEl!: HTMLElement;
  private composerEl!: HTMLElement;
  private pretextRaf = false;
  private scrollRaf = false;
  private renderRaf = false;
  private streamingBodyRaf = false;
  // Spec 114: coalesces scroll-event storms into one anchor capture per
  // frame. Set on scroll; re-reads live state inside the RAF callback so
  // a lane switch or programmatic scroll between event and frame cannot
  // write a stale anchor.
  private scrollHandlerRaf = false;
  private suppressScrollListener = false;
  private suppressScrollToken = 0;
  private transcriptResizeObserver: ResizeObserver | null = null;
  private observedTranscriptBody: HTMLElement | null = null;
  private observedTranscriptRows = new Set<HTMLElement>();

  constructor(projectDir: string | null = null, bus: ViewBus | null = null) {
    this.projectDir = projectDir;
    this.viewBus = bus;
    this.zenMode = readZenModePreference(projectDir);
    this.conciseMode = readConciseModePreference(projectDir);
    this.element = document.createElement('div');
    this.element.className = 'acp-harness';
    this.element.tabIndex = 0;
    this.coordinator = new InterLaneCoordinator(this.laneBus, this.buildLaneHost());
    // spec 149: artifact feedback drains on the lane's next idle, like peer mail,
    // but through its own queue (human→lane review, not lane↔lane mail).
    // ORDERING MATTERS: construct this AFTER the coordinator. LaneBus dispatches
    // subscribers in insertion order, and the coordinator drains peer mail without
    // re-checking status, so it must claim a contested idle first; this queue
    // re-checks status in its own drain and defers when the lane is already busy.
    // If this were constructed first, a peer inbox could be emptied into a turn
    // this queue had already claimed. (Codex-1 review W1.)
    this.feedbackQueue = new ArtifactFeedbackQueue(this.laneBus, {
      getLaneStatus: (laneId) => this.lanes.find((l) => l.id === laneId)?.status ?? null,
      artifactPath: (artifactId) => this.artifacts.get(artifactId)?.path ?? null,
      injectFeedbackTurn: (laneId, text) => {
        const lane = this.lanes.find((l) => l.id === laneId);
        if (lane) void this.enqueueSystemPrompt(lane, text, undefined, 'artifact feedback');
      },
    });
    // spec 172: docs-browser feedback drains the same way, into whichever lane was
    // resolved as the recipient before accept(). Shares the drain-on-idle core.
    this.docsFeedbackQueue = new DocFeedbackQueue(
      this.laneBus,
      (laneId) => this.lanes.find((l) => l.id === laneId)?.status ?? null,
      (laneId, text) => {
        const lane = this.lanes.find((l) => l.id === laneId);
        if (lane) void this.enqueueSystemPrompt(lane, text, undefined, 'docs feedback');
      },
    );
    // spec 174: docs-browser artifact requests also route to the active lane and
    // drain on idle/awaiting_peer, but compose an artifact-generation task rather
    // than source-edit feedback.
    this.docsArtifactQueue = new DocArtifactRequestQueue(
      this.laneBus,
      (laneId) => this.lanes.find((l) => l.id === laneId)?.status ?? null,
      (laneId, text) => {
        const lane = this.lanes.find((l) => l.id === laneId);
        if (lane) void this.enqueueSystemPrompt(lane, text, undefined, 'docs artifact');
      },
    );
    // spec 158: diff review comments drain on the lane's next idle, same as
    // artifact feedback. Constructed AFTER the feedback queue (and the
    // coordinator) for the same reason: LaneBus dispatches in insertion order,
    // so this re-checking drainer must run last and defer when an earlier
    // drainer already claimed a contested idle. (Codex-1 review W2.)
    this.diffReviewQueue = new DiffReviewQueue(this.laneBus, {
      getLaneStatus: (laneId) => this.lanes.find((l) => l.id === laneId)?.status ?? null,
      injectReviewTurn: (laneId, text) => {
        const lane = this.lanes.find((l) => l.id === laneId);
        if (lane) void this.enqueueSystemPrompt(lane, text, undefined, 'diff review');
      },
    });
    // spec 128: refresh the backpressure gauge (and the overlay, if open) on
    // every queue mutation the store emits.
    this.laneBus.subscribe((e) => {
      if (e.type === 'triage:changed') {
        this.renderTriageGaugeEl();
        if (this.triageOverlayOpen) this.renderTriageOverlayEl();
      } else if (e.type === 'review:quality') {
        // spec 146: refresh the neutral footer review-count indicator (and the
        // overlay, if open) whenever a round is recorded or a lane is dropped.
        this.renderReviewGaugeEl();
        if (this.reviewMatrixOverlayOpen) this.renderReviewMatrixOverlayEl();
      } else if (e.type === 'review:priority') {
        // spec 162: refresh the neutral footer priority indicator (and the
        // roll-up overlay, if open) whenever a lane re-reports or is dropped.
        this.publishReviewPriority(this.reviewPriorityStore.highCount());
        if (this.reviewPriorityOverlayOpen) this.renderReviewPriorityOverlayEl();
      }
    });
    this.buildDOM();
    this.render();
    void this.refreshGitBranch();
    void this.start();
    this.startMetricsTick();
    void this.subscribeInterLaneBridge();
    void loadHomeDir().then((home) => {
      if (home) this.render();
    });
  }

  /** Centralized status mutation. Emits a lane:status event for the bus. */
  private setLaneStatus(lane: HarnessLane, next: HarnessLaneStatus): void {
    const prev = lane.status;
    if (prev === next) return;
    lane.status = next;
    // The operation label describes an in-flight custom-command turn. Keep it
    // across `busy` AND `needs_permission` — a permission pause is still the same
    // turn, and it resumes to `busy` after the human decides (Codex-1 B2). Clear it
    // only when the turn truly ends (idle / awaiting_peer / error / stopped / starting)
    // so the chip never shows a stale 'reviewing'.
    if (next !== 'busy' && next !== 'needs_permission') lane.activeSystemLabel = null;
    this.laneBus.emit({
      type: 'lane:status',
      payload: { laneId: lane.id, prev, next, at: Date.now() },
    });
    // Mirror status transitions to the control SSE stream (doc 175) so a web
    // mirror sees the lane go busy/idle/error without polling.
    this.publishStream(lane, 'status', { prev, next });
    // spec 155: a transition into `idle` is a lane quiet point (ADR-0008) —
    // announce it globally so a Diff Window over the same repo refreshes its
    // working diff. Payload is just the projectDir; no lane identity needed.
    if (next === 'idle' && this.projectDir) {
      this.viewBus?.publishSignal({
        kind: 'harness:lane-idle',
        source: SYSTEM_SOURCE,
        value: { cwd: this.projectDir },
      });
    }
    // Composer peer-strip age depends on lane status (busy / awaiting_peer)
    // and pending peers. Refresh the 1Hz tick whenever status changes so
    // mention / review / peer_send paths don't have to remember to call this
    // themselves. Idempotent and cheap.
    this.updateComposerTick();
    this.updateSpinnerTicker();
  }

  private buildLaneHost(): LaneHost {
    return {
      listLanes: () =>
        this.lanes
          .filter((l) => l.status !== 'stopped')
          .map<LaneSummary>((l) => {
            const directive = this.directiveById(l.activeDirectiveId);
            return {
              laneId: l.id,
              displayName: l.displayName,
              backendId: l.backendId,
              status: l.status,
              modelName: l.modelName,
              inboxDepth: 0,
              // spec 141: local lanes are tagged local:true and carry this view's
              // harnessId + cwd so peer_list presents local and foreign peers
              // uniformly.
              local: true,
              harnessId: this.harnessMemoryId ?? undefined,
              cwd: this.projectDir,
              activeDirective: directive
                ? {
                    id: directive.id,
                    title: directive.title,
                    task: directive.task,
                    description: directive.description,
                    enabled: directive.enabled,
                  }
                : null,
            };
          }),
      getLane: (id) => {
        const l = this.lanes.find((x) => x.id === id);
        if (!l) return null;
        return { status: l.status, displayName: l.displayName };
      },
      setLaneStatus: (id, next) => {
        const l = this.lanes.find((x) => x.id === id);
        if (!l) return;
        this.setLaneStatus(l, next);
        this.scheduleLaneRender(l);
      },
      enqueueSystemPrompt: (id, text, drain) => {
        const l = this.lanes.find((x) => x.id === id);
        if (!l) return;
        // Label the drained peer turn so a human watching a recipient lane (e.g. a
        // reviewer mid-#review) sees 'handling peer' rather than a generic 'running'
        // (Claude-2). It's the recipient's ordinary peer turn, not command-specific.
        void this.enqueueSystemPrompt(l, text, drain, 'handling peer');
      },
      appendInterLaneRow: (id, direction, peer, message, done, meta) => {
        const l = this.lanes.find((x) => x.id === id);
        if (!l) return;
        const item = this.appendTranscript(l, 'inter_lane', message);
        item.interLane = {
          direction,
          peerId: peer.id,
          peerDisplayName: peer.displayName,
          peerBackendId: this.lanes.find((x) => x.id === peer.id)?.backendId,
          done,
          envelopeId: meta?.envelopeId,
          channel: meta?.channel,
        };
        this.scheduleLaneRender(l);
      },
      appendSystemNotice: (id, text) => {
        const l = this.lanes.find((x) => x.id === id);
        if (!l) return;
        this.appendTranscript(l, 'system', `[inter-lane] ${text}`);
        this.scheduleLaneRender(l);
      },
    };
  }

  /**
   * spec 141: register this view in the process-wide HarnessDirectory so its
   * lanes are reachable by name from every other open harness view. Idempotent
   * — no-op before the harness id is known or once already registered. Removal
   * happens in dispose().
   */
  private registerWithDirectory(): void {
    if (!this.harnessMemoryId || this.directoryEntry) return;
    const entry: HarnessEntry = {
      harnessId: this.harnessMemoryId,
      cwd: this.projectDir,
      alive: true,
      listLanes: () => this.coordinator.listLanes(),
      resolveLocalDisplayName: (name) => {
        const lane = this.lanes.find((l) => l.displayName === name && l.status !== 'stopped');
        return lane ? { laneId: lane.id, displayName: lane.displayName } : null;
      },
      acceptInbound: (env) => {
        if (!entry.alive) {
          return {
            result: { delivered: false, reason: 'harness_closed' },
            senderIsReplier: false,
            effectiveDone: env.done,
          };
        }
        return this.coordinator.acceptInbound(env);
      },
      acceptForeignCancellation: (targetLaneId, cancellerDisplayName) => {
        if (!entry.alive) return;
        this.coordinator.acceptForeignCancellation(targetLaneId, cancellerDisplayName);
      },
      clearCancellationTombstone: (cancellerLaneId, peerDisplayName) => {
        this.coordinator.clearForeignCancellationTombstone(cancellerLaneId, peerDisplayName);
      },
      onForeignHarnessClosed: (snapshot) => {
        this.coordinator.onForeignHarnessClosed(snapshot);
      },
      control: (operation, params) => this.handleControlOperation(operation, params),
    };
    this.directoryEntry = entry;
    registerHarness(entry);
  }

  private startTelemetryPublisher(): void {
    if (!this.harnessMemoryId || this.telemetryPublisher) return;
    this.telemetryPublisher = new HarnessTelemetryPublisher({
      harnessId: this.harnessMemoryId,
      projectDir: this.projectDir,
      laneBus: this.laneBus,
      coordinator: this.coordinator,
      lanes: () => this.lanes,
      triageStore: this.triageStore,
      reviewQualityStore: this.reviewQualityStore,
      reviewPriorityStore: this.reviewPriorityStore,
      metricsFor: (laneId) => this.laneResourceSample(laneId),
    });
  }

  async handleControlOperation(operation: string, params: Record<string, unknown>): Promise<unknown> {
    if (operation === 'lane.list') return this.controlLaneList();
    if (operation === 'lane.spawn') {
      const backendId = requiredString(params, 'backendId');
      if (!this.pickerEntries.some((entry) => entry.id === backendId)) {
        throw controlError('unsupported_backend', `backend is not available: ${backendId}`);
      }
      await this.addLane(backendId);
      return this.controlLaneList();
    }
    if (operation === 'peer.list') {
      return listHarnessEntries().flatMap((entry) => entry.listLanes());
    }
    if (operation === 'memory.list') {
      return this.memoryEntries;
    }
    // spec 158: diff review routing. Resolved on demand through the
    // HarnessDirectory (no ViewBus broadcast), so the compositor talks to the
    // one harness that owns the target rather than every harness on the repo.
    if (operation === 'diff.review-targets') {
      const lanes = this.lanes
        .filter((l) => l.status !== 'stopped' && l.status !== 'error' && l.status !== 'starting')
        .map((l) => ({ displayName: l.displayName, status: l.status }));
      const active = this.activeLane();
      const activeName = active && lanes.some((l) => l.displayName === active.displayName)
        ? active.displayName
        : null;
      const def = activeName ?? (lanes.length === 1 ? lanes[0].displayName : null);
      return { lanes, default: def };
    }
    // spec 160: pull the merged review-priority snapshot for this harness's
    // lanes. A pull (no broadcast), like diff.review-targets — the Diff Window
    // gets a fresh snapshot on open and on each refresh. Reports from lanes that
    // have since closed are dropped (their reports were removed on close).
    if (operation === 'diff.review-priority') {
      return { ranges: this.reviewPriorityStore.allRanges() };
    }
    if (operation === 'diff.review-send') {
      const target = requiredString(params, 'target');
      const batchId = requiredString(params, 'batchId');
      const comments = Array.isArray(params.comments)
        ? (params.comments as DiffReviewComment[])
        : [];
      const lane = this.lanes.find((l) => l.displayName === target && l.status !== 'stopped');
      if (!lane) return { status: 'no-live-lane' };
      const outcome = this.diffReviewQueue.accept(lane.id, {
        kind: 'diff_review',
        batchId,
        comments,
        sentAt: Date.now(),
      });
      return { status: outcome === 'duplicate' ? 'duplicate' : 'accepted' };
    }
    // spec 175: harness-scoped read operations for a web mirror.
    if (operation === 'lane.status') {
      return this.lanes.map((l) => {
        const directive = this.directiveById(l.activeDirectiveId);
        return {
          laneId: l.id,
          displayName: l.displayName,
          backendId: l.backendId,
          sessionId: l.sessionId,
          status: l.status,
          modelName: l.modelName,
          currentModelId: l.currentModelId,
          queueDepth: l.queuedPrompts.length,
          pendingPermissions: l.pendingPermissions.length,
          goal: l.goal ?? null,
          permissionMode: l.permissionMode,
          directive: directive
            ? { id: directive.id, title: directive.title, task: directive.task }
            : null,
          activity: l.activity ?? null,
        };
      });
    }
    if (operation === 'directive.list') {
      return this.directives.map((d) => ({
        id: d.id,
        title: d.title,
        task: d.task,
        description: d.description,
        enabled: d.enabled,
      }));
    }
    if (operation === 'review.outcomes') {
      return this.reviewQualityStore
        .lanesWithHistory()
        .flatMap((laneId) => this.reviewQualityStore.historyFor(laneId));
    }
    if (operation === 'attention.list') {
      return this.triageStore.openItems().map((item) => ({
        id: item.id,
        lane: this.lanes.find((l) => l.id === item.laneId)?.displayName ?? null,
        question: item.question,
        chosen: item.chosen,
        rationale: item.rationale,
        tradedOff: item.tradedOff,
        uncertainty: item.uncertainty,
        reversibility: item.reversibility,
        diffstat: item.diffstat,
        createdAt: item.createdAt,
        status: item.status,
      }));
    }
    if (operation === 'attention.resolve') {
      const itemId = requiredString(params, 'itemId');
      const resolved = this.triageStore.accept(itemId);
      if (!resolved) throw controlError('attention_not_found', `no open attention item: ${itemId}`);
      if (this.triageOverlayOpen) this.renderTriageOverlayEl();
      return { resolved: true, itemId };
    }
    if (operation === 'artifact.list') {
      return Array.from(this.artifacts.values()).map((record) => ({
        id: record.id,
        title: record.title,
        path: record.path,
        lane: record.laneLabel,
        state: record.state, // 'pending' | 'registered_live'
        size: record.size,
        hash: record.hash,
      }));
    }
    // spec 178: github issue-fixing. dispatch-issue runs the shared dispatchIssue
    // path (also used by the Krypton palette / #dispatch-github-issue). The issueKey-addressed
    // reads (status/list/unlink) are fanned out across harnesses by control-bridge.
    if (operation === 'github.dispatch-issue') {
      const repo = requiredString(params, 'repo');
      const number = requiredNumber(params, 'number');
      const issueKey =
        (typeof params.issueKey === 'string' && params.issueKey) || `${repo}#${number}`;
      const issueUrl =
        (typeof params.issueUrl === 'string' && params.issueUrl) ||
        `https://github.com/${repo}/issues/${number}`;
      // dispatchIssue fetches metadata itself when title is absent (single fetch site).
      const title = typeof params.title === 'string' ? params.title : undefined;
      const body = typeof params.body === 'string' ? params.body : undefined;
      const targetLane = typeof params.targetLane === 'string' ? params.targetLane : null;
      const prompt = typeof params.prompt === 'string' ? params.prompt : undefined;
      return this.dispatchIssue({ issueKey, issueUrl, repo, number, title, body, targetLane, prompt });
    }
    if (operation === 'github.issue-status') {
      return this.issueStatusSnapshot(requiredString(params, 'issueKey'));
    }
    if (operation === 'github.list-issues') {
      return Array.from(this.issueBindings.values());
    }
    if (operation === 'github.unlink-issue') {
      const issueKey = requiredString(params, 'issueKey');
      const had = this.issueBindings.delete(issueKey);
      if (had) this.persistIssueBindings();
      return { ok: had };
    }
    const lane = this.controlLane(params);
    switch (operation) {
      case 'lane.commands':
        return lane.availableCommands.map((command) => ({
          name: command.name,
          description: command.description ?? null,
        }));
      case 'lane.metrics':
        return {
          lane: lane.displayName,
          status: lane.status,
          usage: lane.usage ?? null,
          queueDepth: lane.queuedPrompts.length,
          modelName: lane.modelName,
        };
      case 'lane.models':
        return {
          lane: lane.displayName,
          currentModelId: lane.currentModelId,
          models: lane.availableModels.map((m) => ({
            modelId: m.model_id,
            name: m.name,
            description: m.description ?? null,
          })),
        };
      case 'lane.send': {
        const text = requiredString(params, 'text').trim();
        if (!text) throw controlError('invalid_request', 'text must not be empty');
        if (!lane.client || lane.status === 'starting' || lane.status === 'error' || lane.status === 'stopped') {
          throw controlError('lane_not_ready', `${lane.displayName} is ${lane.status}`);
        }
        if (lane.status === 'busy' || lane.status === 'needs_permission' || lane.status === 'awaiting_peer') {
          if (lane.queuedPrompts.length >= PROMPT_QUEUE_MAX) {
            throw controlError('queue_full', `${lane.displayName} prompt queue is full`);
          }
          lane.queuedPrompts.push({ text, images: [], mentionTargets: [] });
          this.render();
          return { status: 'queued', lane: lane.displayName, queueDepth: lane.queuedPrompts.length };
        }
        void this.sendUserPrompt(lane, text, [], { clearDraft: false });
        return { status: 'started', lane: lane.displayName };
      }
      case 'lane.cancel':
        await this.cancelLane(lane);
        return { cancelled: true, lane: lane.displayName };
      case 'lane.close':
        await this.closeLane(lane);
        return { closed: true, lane: lane.displayName };
      case 'lane.restart':
        await this.restartLane(lane);
        return { status: lane.status, lane: lane.displayName };
      case 'lane.new': {
        const clearMemory = params.clearMemory === true;
        const ok = await this.newLaneSession(lane, { clearMemory });
        if (!ok) throw controlError('conflict', `could not create a fresh session for ${lane.displayName}`);
        return { status: lane.status, lane: lane.displayName };
      }
      case 'lane.model': {
        const modelId = requiredString(params, 'modelId');
        if (!lane.client) throw controlError('lane_not_ready', `${lane.displayName} has no client`);
        const result = await lane.client.setLaneModel(modelId);
        lane.currentModelId = modelId;
        lane.modelName = modelId;
        this.render();
        return { lane: lane.displayName, modelId, result };
      }
      case 'lane.directive': {
        const directiveId = params.directiveId === null ? null : requiredString(params, 'directiveId');
        if (directiveId) {
          const directive = this.directiveById(directiveId);
          if (!directive || !this.directiveAssignable(directive)) {
            throw controlError('invalid_directive', `directive ${directiveId} is unavailable (unknown or disabled)`);
          }
        }
        this.assignDirectiveToLane(lane, directiveId);
        return { lane: lane.displayName, directiveId };
      }
      case 'lane.goal': {
        const text = params.text === null ? 'clear' : requiredString(params, 'text');
        if (params.text !== null && lane.status !== 'idle') {
          throw controlError('lane_not_idle', `${lane.displayName} is ${lane.status}`);
        }
        await this.runGoalCommand(lane, `#goal ${text}`);
        return { lane: lane.displayName, goal: lane.goal ?? null };
      }
      case 'lane.permission_mode': {
        const mode = requiredString(params, 'mode');
        if (mode !== 'normal' && mode !== 'acceptEdits' && mode !== 'bypass') {
          throw controlError('invalid_request', 'mode must be normal, acceptEdits, or bypass');
        }
        lane.permissionMode = mode;
        this.render();
        return { lane: lane.displayName, permissionMode: mode };
      }
      case 'lane.transcript':
        return lane.transcript.map((item) => ({
          id: item.id,
          kind: item.kind,
          text: item.text,
          createdAt: item.createdAt ?? null,
          status: item.status ?? null,
          permission: item.permission ?? null,
          providerError: item.providerError ?? null,
        }));
      case 'permission.list':
        return lane.pendingPermissions.map((permission) => ({
          requestId: permission.requestId,
          tool: permission.toolCall.title ?? permission.toolCall.kind ?? 'tool',
          options: permission.options,
        }));
      case 'permission.resolve': {
        const requestId = requiredNumber(params, 'requestId');
        const action = requiredString(params, 'action');
        const index = lane.pendingPermissions.findIndex((permission) => permission.requestId === requestId);
        if (index < 0) throw controlError('permission_not_found', `permission not found: ${requestId}`);
        if (index !== 0) throw controlError('conflict', 'only the oldest pending permission can be resolved');
        if (action !== 'accept' && action !== 'reject') {
          throw controlError('invalid_request', 'action must be accept or reject');
        }
        await this.resolvePermission(lane, action, false);
        return { resolved: true, requestId, action };
      }
      case 'memory.get':
        return this.memoryEntries.find((entry) => entry.lane === lane.displayName) ?? null;
      case 'memory.clear':
        await this.clearActiveLaneMemory(lane, false);
        return { cleared: true, lane: lane.displayName };
      default:
        throw controlError('unsupported_operation', `unsupported operation: ${operation}`);
    }
  }

  private controlLaneList(): unknown[] {
    return this.lanes.map((lane) => ({
      harnessId: this.harnessMemoryId,
      cwd: this.projectDir,
      laneId: lane.id,
      displayName: lane.displayName,
      backendId: lane.backendId,
      status: lane.status,
      sessionId: lane.sessionId,
      modelName: lane.modelName,
      queueDepth: lane.queuedPrompts.length,
      pendingPermissions: lane.pendingPermissions.length,
      goal: lane.goal ?? null,
      permissionMode: lane.permissionMode,
    }));
  }

  private controlLane(params: Record<string, unknown>): HarnessLane {
    const name = requiredString(params, 'lane');
    const lane = this.lanes.find((candidate) => candidate.displayName === name);
    if (!lane) throw controlError('unknown_lane', `unknown lane: ${name}`);
    return lane;
  }

  /** spec 115: @mention fan-out from composer.
   *  spec 136: returns { handled, delivered } and gates the draft-clear so the
   *  prompt-queue drain path can fan out without wiping the user's live draft. */
  private tryMentionFanOut(
    lane: HarnessLane,
    text: string,
    hasImages: boolean,
    opts?: { clearDraftOnDeliver?: boolean },
  ): { handled: boolean; delivered: boolean } {
    if (!text.trimStart().startsWith('@')) return { handled: false, delivered: false };
    const clearDraft = opts?.clearDraftOnDeliver !== false;
    const roster = this.lanes.map((l) => l.displayName);
    const parsed = parseMentionFanOut(text, lane.displayName, roster);
    if ('kind' in parsed) {
      if (parsed.kind === 'empty_body') return { handled: false, delivered: false };
      if (parsed.kind === 'self_only') {
        this.flashChip('mention: cannot target only yourself');
        return { handled: true, delivered: false };
      }
      this.flashChip(`mention: unknown lane ${parsed.token}`);
      return { handled: true, delivered: false };
    }
    if (parsed.targets.length === 0) return { handled: false, delivered: false };
    if (hasImages) {
      this.flashChip('mention fan-out: images not supported yet');
      return { handled: true, delivered: false };
    }
    const targets = parsed.targets
      .map((displayName) => {
        const target = this.lanes.find((l) => l.displayName === displayName);
        return target ? { laneId: target.id, displayName } : null;
      })
      .filter((t): t is { laneId: string; displayName: string } => t !== null);
    if (targets.length === 0) {
      this.flashChip('mention: no valid target lanes');
      return { handled: true, delivered: false };
    }
    const result = this.coordinator.deliverMentionFanOut(
      lane.id,
      lane.displayName,
      targets,
      parsed.body,
      this.harnessMemoryId ?? undefined,
    );
    if (clearDraft) this.setDraft(lane, '', 0);
    if (result.delivered.length === 0) {
      const why = result.failed.map((f) => `${f.displayName} (${f.reason})`).join(', ');
      this.flashChip(`mention failed: ${why || 'no targets'}`);
      this.render();
      return { handled: true, delivered: false };
    }
    if (result.failed.length > 0) {
      const why = result.failed.map((f) => `${f.displayName} (${f.reason})`).join(', ');
      this.flashChip(`mention partial: failed ${why}`);
    }
    const preview = parsed.body.length > 80 ? `${parsed.body.slice(0, 80)}…` : parsed.body;
    this.appendTranscript(
      lane,
      'system',
      `mention → ${result.delivered.join(', ')}${result.failed.length ? ` · failed: ${result.failed.map((f) => `${f.displayName} (${f.reason})`).join(', ')}` : ''}\n${preview}`,
    );
    if (this.coordinator.pendingPeersFor(lane.id).length > 0) {
      this.setLaneStatus(lane, 'awaiting_peer');
    }
    this.render();
    return { handled: true, delivered: true };
  }

  /** spec 136: resolve a queued prompt's mention targets at enqueue time using
   *  the real parser (not an ad-hoc regex). Empty when the text is not a mention. */
  private resolveMentionTargets(text: string, lane: HarnessLane): string[] {
    if (!text.trimStart().startsWith('@')) return [];
    const parsed = parseMentionFanOut(text, lane.displayName, this.lanes.map((l) => l.displayName));
    return 'kind' in parsed ? [] : parsed.targets;
  }

  /** Inject a programmatic user-turn (no UI composer involved). */
  private async enqueueSystemPrompt(
    lane: HarnessLane,
    text: string,
    drain?: CoordinatorDrainContext,
    label?: string,
  ): Promise<void> {
    if (!lane.client) return;
    if (lane.status !== 'idle' && lane.status !== 'awaiting_peer') return;
    this.beginSystemTurn(lane, drain, label);
    await this.dispatchTurn(lane, text);
  }

  /** Turn-start bookkeeping shared by enqueueSystemPrompt and the reserve-then-send
   *  path (reserveCommandTurn). Flips the lane to `busy` so it stops being drainable
   *  (canDrainInbound is false for `busy`), which is what blocks a peer envelope or a
   *  user prompt from claiming the lane mid-command. */
  private beginSystemTurn(
    lane: HarnessLane,
    drain: CoordinatorDrainContext | undefined,
    label: string | undefined,
  ): void {
    lane.pendingCoordinatorDrain = drain ?? null;
    lane.coordinatorDrainProvenanceUsed = false;
    // Label the operation BEFORE the status flip so the busy chip and any
    // synchronous lane:status observer see it from the turn's first render.
    // setLaneStatus only clears the label on a non-busy transition, so a label
    // set here survives the idle→busy flip.
    lane.activeSystemLabel = label ?? null;
    this.setLaneStatus(lane, 'busy');
    lane.activeTurnStartedAt = Date.now();
    lane.pendingTurnExtractions = [];
    lane.currentAssistantId = null;
    lane.currentThoughtId = null;
    // spec 143: a delegated peer turn may run non-high-risk permissions
    // autonomously. Arm here (turn-start), reset at turn end like the manual
    // accept-all flag. Visible via the `peer-auto` chip + the system line below.
    if (drain?.autoAcceptPermissions) {
      lane.peerAutoAcceptForTurn = true;
      const granter = drain.primaryPeerDisplayName ?? 'a peer';
      const extra = (drain.envelopeCount ?? 1) > 1 ? ` (+${(drain.envelopeCount ?? 1) - 1} more)` : '';
      this.appendTranscript(
        lane,
        'system',
        `auto-accept (non-high-risk) armed by ${granter}${extra} for this turn — destructive commands still prompt`,
      );
    }
    this.updateComposerTick();
    this.render();
  }

  private async dispatchTurn(lane: HarnessLane, text: string): Promise<void> {
    if (!lane.client) return;
    try {
      await lane.client.prompt([{ type: 'text', text }]);
    } catch (e) {
      this.setLaneStatus(lane, 'error');
      lane.error = String(e);
      // spec 143: the turn never started — clear the arm so it cannot leak into a
      // later manual turn (this catch does not get the normal turn-end reset).
      lane.peerAutoAcceptForTurn = false;
      lane.acceptAllForTurn = false;
      lane.rejectAllForTurn = false;
      this.appendTranscript(lane, 'system', `error: ${String(e)}`);
      this.render();
    }
  }

  /** Reserve an idle lane for a custom command BEFORE its slow async prelude
   *  (e.g. `#review`'s git-diff collection): flips it to `busy` + labels it so the
   *  busy chip shows the operation persistently (not a 2s flash) and peer mail / a
   *  user prompt cannot claim the lane during the awaits (Codex-1 B1). Pair with
   *  dispatchTurn on success or releaseReservedTurn on a prep failure. */
  private reserveCommandTurn(lane: HarnessLane, label: string): void {
    this.beginSystemTurn(lane, undefined, label);
  }

  /** Undo a reserveCommandTurn when the command bails before dispatch (bad subject,
   *  git collection failed): return the lane to idle so it drains held peer mail and
   *  accepts input again. setLaneStatus(idle) clears activeSystemLabel. */
  private releaseReservedTurn(lane: HarnessLane): void {
    lane.activeTurnStartedAt = null;
    lane.pendingCoordinatorDrain = null;
    this.setLaneStatus(lane, 'idle');
    this.updateComposerTick();
    this.render();
  }

  private async subscribeInterLaneBridge(): Promise<void> {
    this.interLaneUnlisten = await listen<InterLaneEnvelope & { requestId?: string }>(
      'acp-inter-lane-message',
      (e) => {
        const env = e.payload;
        const requestId = env.requestId;
        // Tauri events are app-wide. Rust always tags envelopes with `harnessId`;
        // accept only those that match this harness AFTER it has been initialized.
        // A still-initializing harness (harnessMemoryId === null) must NOT consume
        // the bus reply — otherwise it would race the correct harness and drop its
        // legitimate response (Rust removes the oneshot on first reply).
        if (!this.harnessMemoryId || env.harnessId !== this.harnessMemoryId) {
          return;
        }
        const reply = (result: unknown): void => {
          if (!requestId) return;
          void invoke('acp_bus_reply', { requestId, result }).catch((err) => {
            console.warn('acp_bus_reply failed', err);
          });
        };
        // The Rust side addresses lanes by display name; translate to
        // internal lane ids before handing to the coordinator.
        const fromLane = this.lanes.find((l) => l.displayName === env.fromLaneId);
        if (!fromLane) {
          reply({ delivered: false, reason: 'unknown_sender' });
          return;
        }
        const toLane = this.lanes.find((l) => l.displayName === env.toLaneId);
        if (toLane) {
          // Same-view delivery — both lanes live in this coordinator.
          const translated: InterLaneEnvelope = {
            ...env,
            fromLaneId: fromLane.id,
            toLaneId: toLane.id,
          };
          reply(this.coordinator.deliver(translated));
          return;
        }
        // spec 141: cross-view delivery. The target displayName is globally
        // unique, so resolve it across every live harness view.
        const resolved = resolveDisplayName(env.toLaneId);
        if (!resolved) {
          // Unknown or closed lane (names are never recycled → no false match).
          reply({ delivered: false, reason: 'unknown_lane' });
          return;
        }
        const target = harnessEntry(resolved.harnessId);
        if (!target) {
          reply({ delivered: false, reason: 'harness_closed' });
          return;
        }
        // Sender-side "one outstanding per target" guard, keyed by the foreign
        // displayName — must run on THIS (sender's) coordinator before the hop.
        const senderEnv: InterLaneEnvelope = {
          ...env,
          fromLaneId: fromLane.id,
          toLaneId: resolved.displayName,
        };
        if (this.coordinator.isPeerInFlight(senderEnv, resolved.displayName)) {
          reply({ delivered: false, reason: 'peer_in_flight' });
          return;
        }
        // Recipient side runs on the TARGET coordinator (where the pending state
        // that classifies the sender lives). Resolve names exactly once, here at
        // the view boundary: fromLaneId = sender's globally-unique displayName
        // (the foreign pending key), toLaneId = the target's local lane id.
        const inboundEnv: InterLaneEnvelope = {
          ...env,
          fromLaneId: env.fromLaneId,
          fromDisplayName: env.fromLaneId,
          toLaneId: resolved.laneId,
          // spec 143: auto_accept never crosses the harness trust boundary — a
          // foreign peer cannot arm autonomous execution on this lane.
          autoAccept: false,
        };
        const inbound = target.acceptInbound(inboundEnv);
        if (inbound.result.delivered) {
          this.coordinator.recordOutbound(
            fromLane.id,
            { key: resolved.displayName, displayName: resolved.displayName },
            senderEnv,
            inbound,
          );
        }
        // spec 143: tell the sender its auto_accept was dropped on the hop, so it
        // does not assume the foreign lane is running its work autonomously.
        if (env.autoAccept && inbound.result.delivered) {
          inbound.result.hint = `${inbound.result.hint} auto_accept ignored: cross-view sender.`;
        }
        reply(inbound.result);
      },
    );
    this.peerListUnlisten = await listen<{ harnessId?: string; requestId?: string }>(
      'acp-peer-list-requested',
      (e) => {
        const { harnessId, requestId } = e.payload;
        if (!requestId) return;
        // Strict harness filter — same reasoning as the inter-lane listener.
        if (!this.harnessMemoryId || harnessId !== this.harnessMemoryId) {
          return;
        }
        // spec 141: local lanes (tagged local:true by the host) plus every other
        // live harness's lanes (tagged local:false, carrying their cwd) so an
        // agent can pick a peer across projects.
        const local = this.coordinator.listLanes();
        const foreign = this.harnessMemoryId ? peersFor(this.harnessMemoryId) : [];
        const lanes = [...local, ...foreign];
        void invoke('acp_bus_reply', {
          requestId,
          result: { lanes, count: lanes.length },
        }).catch((err) => {
          console.warn('acp_bus_reply (peer_list) failed', err);
        });
      },
    );

    // spec 149: a browser POSTed artifact feedback. Rust blocks on this round-trip
    // (mirrors peer_send): resolve the registry laneLabel → live lane, de-dupe by
    // batchId, enqueue into the dedicated feedback queue, and reply with the
    // acceptance so the POST reports a real status (not fire-and-forget).
    this.feedbackUnlisten = await listen<{
      harnessId?: string;
      laneLabel: string;
      artifactId: string;
      artifactTitle: string;
      batchId: string;
      comments: ArtifactComment[];
      requestId?: string;
    }>('acp-artifact-feedback-received', (e) => {
      const p = e.payload;
      if (!this.harnessMemoryId || p.harnessId !== this.harnessMemoryId) return;
      const reply = (result: unknown): void => {
        if (!p.requestId) return;
        void invoke('acp_bus_reply', { requestId: p.requestId, result }).catch((err) => {
          console.warn('acp_bus_reply (feedback) failed', err);
        });
      };
      // Resolve the registry's laneLabel → the live authoring lane. A closed /
      // `#new`'d lane has had its token revoked in Rust (so the POST would have
      // 410'd first); this guards the race where the lane is gone but the token
      // lingered, replying no-live-lane → 409.
      const lane = this.lanes.find((l) => l.displayName === p.laneLabel && l.status !== 'stopped');
      if (!lane) {
        reply({ accepted: false, reason: 'no_live_lane' });
        return;
      }
      // Forward-only revocation guard against the close/`#new` race: the Rust
      // token revoke is async (fire-and-forget invoke), but `dropAllArtifactsForLane`
      // deletes the artifact RECORD synchronously. So if a feedback event for an
      // old session is processed after the lane was reset, the record is already
      // gone — reject rather than enqueue into the same-id/displayName successor
      // session. (`#restart` keeps the registered record, so this passes there.)
      const record = this.artifacts.get(p.artifactId);
      if (!record || record.laneLabel !== p.laneLabel) {
        reply({ accepted: false, reason: 'no_live_lane' });
        return;
      }
      const envelope: ArtifactFeedbackEnvelope = {
        kind: 'artifact_feedback',
        batchId: p.batchId,
        artifactId: p.artifactId,
        artifactTitle: p.artifactTitle,
        laneLabel: p.laneLabel,
        comments: p.comments ?? [],
        sentAt: Date.now(),
      };
      const outcome = this.feedbackQueue.accept(lane.id, envelope);
      if (outcome === 'duplicate') {
        // A retried POST after a bus timeout — already queued, ack idempotently.
        reply({ accepted: true, reason: 'duplicate' });
        return;
      }
      const n = envelope.comments.length;
      this.appendTranscript(
        lane,
        'system',
        `${n} comment${n === 1 ? '' : 's'} received on artifact «${p.artifactTitle}»`,
      );
      this.scheduleLaneRender(lane);
      reply({ accepted: true });
    });

    // spec 172: a browser POSTed docs-browser feedback. A doc has no owning lane
    // (it is a repo file, not a lane artifact), so the recipient is THIS harness's
    // currently active lane — resolved here at delivery, redirectable by switching
    // the active lane in-app. Rust blocks on this round-trip like artifact feedback.
    this.docsFeedbackUnlisten = await listen<{
      harnessId?: string;
      docPath: string;
      batchId: string;
      comments: DocComment[];
      requestId?: string;
    }>('acp-docs-feedback-received', (e) => {
      const p = e.payload;
      if (!this.harnessMemoryId || p.harnessId !== this.harnessMemoryId) return;
      const reply = (result: unknown): void => {
        if (!p.requestId) return;
        void invoke('acp_bus_reply', { requestId: p.requestId, result }).catch((err) => {
          console.warn('acp_bus_reply (docs feedback) failed', err);
        });
      };
      // No token/registry to resolve: route to the harness's active live lane.
      // An idle/empty harness with no usable lane has no recipient → 409.
      const lane = this.activeLane();
      if (!lane || lane.status === 'stopped') {
        reply({ accepted: false, reason: 'no_live_lane' });
        return;
      }
      const envelope: DocFeedbackEnvelope = {
        kind: 'doc_feedback',
        batchId: p.batchId,
        harnessId: this.harnessMemoryId,
        docPath: p.docPath,
        comments: p.comments ?? [],
        sentAt: Date.now(),
      };
      const outcome = this.docsFeedbackQueue.accept(lane.id, envelope);
      if (outcome === 'duplicate') {
        reply({ accepted: true, reason: 'duplicate' });
        return;
      }
      const n = envelope.comments.length;
      this.appendTranscript(
        lane,
        'system',
        `${n} comment${n === 1 ? '' : 's'} received on docs «${p.docPath}»`,
      );
      this.scheduleLaneRender(lane);
      reply({ accepted: true });
    });

    // spec 174: a browser POSTed a docs-browser artifact request. Like docs
    // feedback, the recipient is this harness's active live lane. The lane still
    // creates the artifact through artifact_new/edit/artifact_register so the
    // normal artifact transcript, write grant, and feedback token all apply.
    this.docsArtifactUnlisten = await listen<{
      harnessId?: string;
      docPath: string;
      batchId: string;
      title: string;
      requestId?: string;
    }>('acp-docs-artifact-requested', (e) => {
      const p = e.payload;
      if (!this.harnessMemoryId || p.harnessId !== this.harnessMemoryId) return;
      const reply = (result: unknown): void => {
        if (!p.requestId) return;
        void invoke('acp_bus_reply', { requestId: p.requestId, result }).catch((err) => {
          console.warn('acp_bus_reply (docs artifact) failed', err);
        });
      };
      const lane = this.activeLane();
      if (!lane || lane.status === 'stopped') {
        reply({ accepted: false, reason: 'no_live_lane' });
        return;
      }
      const envelope: DocArtifactRequestEnvelope = {
        kind: 'doc_artifact_request',
        batchId: p.batchId,
        harnessId: this.harnessMemoryId,
        docPath: p.docPath,
        title: p.title,
        sentAt: Date.now(),
      };
      const outcome = this.docsArtifactQueue.accept(lane.id, envelope);
      if (outcome === 'duplicate') {
        reply({ accepted: true, reason: 'duplicate' });
        return;
      }
      this.appendTranscript(lane, 'system', `Artifact requested for docs «${p.docPath}»`);
      this.scheduleLaneRender(lane);
      reply({ accepted: true });
    });

    // spec 161: the directive_* MCP tools were removed, so the Rust round-trip
    // events `acp-harness-directives-changed` / `acp-directive-apply-requested`
    // are no longer emitted and their listeners are gone. Directive authoring is
    // now the `#directive` command (the lane edits acp-harness.toml directly);
    // the picker reloads from disk on every open via refreshDirectives().

    // spec 130: a lane flagged a judgement item via attention_flag.
    type AttentionFlagEvent = {
      itemId: string;
      fromLaneId: string; // display name from Rust
      question: string;
      chosen: string;
      rationale: string;
      tradedOff: string[];
      uncertainty: string;
      reversibility: JudgementItem['reversibility'];
      sentAt: number;
      harnessId?: string;
      requestId?: string;
    };
    this.attentionFlagUnlisten = await listen<AttentionFlagEvent>('acp-attention-flag', (e) => {
      const env = e.payload;
      const requestId = env.requestId;
      if (!this.harnessMemoryId || env.harnessId !== this.harnessMemoryId) return;
      const reply = (result: unknown): void => {
        if (!requestId) return;
        void invoke('acp_bus_reply', { requestId, result }).catch((err) => {
          console.warn('acp_bus_reply (attention_flag) failed', err);
        });
      };
      // Insert + reply synchronously so the bus reply never races the 2.5s
      // timeout (which would make the agent think the flag failed and retry,
      // creating a duplicate). Git blast-radius is enriched asynchronously.
      const result = this.handleAttentionFlag(env);
      reply(result);
      if (result.inserted) void this.enrichJudgementDiffstat(env.itemId);
    });

    // spec 128: a lane self-resolves a previously-flagged item.
    type AttentionResolveEvent = {
      itemId: string;
      fromLaneId: string;
      note?: string;
      harnessId?: string;
      requestId?: string;
    };
    this.attentionResolveUnlisten = await listen<AttentionResolveEvent>(
      'acp-attention-resolve',
      (e) => {
        const env = e.payload;
        const requestId = env.requestId;
        if (!this.harnessMemoryId || env.harnessId !== this.harnessMemoryId) return;
        const sendReply = (result: { ok: boolean; reason?: string }): void => {
          if (!requestId) return;
          void invoke('acp_bus_reply', { requestId, result }).catch((err) =>
            console.warn('acp_bus_reply (attention_resolve) failed', err),
          );
        };
        // Ownership: a lane may only resolve items it itself flagged, even if it
        // somehow learned another lane's item id. An unknown sender can't own
        // anything; otherwise the store enforces laneId match.
        const lane = this.lanes.find((l) => l.displayName === env.fromLaneId);
        if (!lane) {
          sendReply({ ok: false, reason: 'not_owner' });
          return;
        }
        const result = this.triageStore.selfResolve(env.itemId, lane.id);
        sendReply(result.ok ? { ok: true } : { ok: false, reason: result.reason });
        if (this.triageOverlayOpen) this.renderTriageOverlayEl();
      },
    );

    // spec 178: a lane self-reports github issue-fixing progress via the
    // issue_progress MCP tool. Mirrors the attention_flag round-trip: update the
    // lane's most-recent binding, persist, republish status, reply inside the
    // bus timeout so the agent never sees a false failure.
    type IssueReportEvent = {
      fromLaneId: string; // display name from Rust (lane label)
      issueKey: string; // which issue this report is about (required on the tool)
      phase?: IssuePhase;
      summary?: string;
      prUrl?: string;
      harnessId?: string;
      requestId?: string;
    };
    this.issueReportUnlisten = await listen<IssueReportEvent>('acp-issue-report', (e) => {
      const env = e.payload;
      const requestId = env.requestId;
      if (!this.harnessMemoryId || env.harnessId !== this.harnessMemoryId) return;
      const sendReply = (result: { ok: boolean; reason?: string }): void => {
        if (!requestId) return;
        void invoke('acp_bus_reply', { requestId, result }).catch((err) =>
          console.warn('acp_bus_reply (issue_progress) failed', err),
        );
      };
      const lane = this.lanes.find((l) => l.displayName === env.fromLaneId);
      if (!lane) {
        sendReply({ ok: false, reason: 'unknown_lane' });
        return;
      }
      // spec 190: normalize the reported key to canonical `owner/repo#123` (a lane may
      // report a URL) so lookup/delete/auto-bind all key off the SAME string dispatchIssue
      // stores under — otherwise a URL report would miss its own binding and duplicate it.
      const ref = this.parseIssueRef(env.issueKey);
      const issueKey = ref ? `${ref.repo}#${ref.number}` : env.issueKey;
      // Resolve the binding by the issueKey the lane reported, not by guessing its
      // most-recent dispatch — that breaks when one lane is fixing several issues.
      let binding = this.issueBindings.get(issueKey);
      if (binding && binding.laneId !== lane.id) {
        // spec 190: a live owner keeps its binding (misroute guard). But a binding
        // whose owner lane is gone (stale, e.g. post-restart) is taken over by the
        // reporting live lane — same stale-binding handling as dispatchIssue.
        const owner = this.lanes.find((l) => l.id === binding!.laneId);
        if (owner && owner.status !== 'stopped') {
          sendReply({ ok: false, reason: 'wrong_lane' });
          return;
        }
        this.issueBindings.delete(issueKey);
        binding = undefined;
      }
      // spec 190: auto-bind. A lane that picked up an issue directly in the harness
      // (no prior dispatchIssue) has no binding — self-register one from issue_key
      // instead of rejecting, so issue_progress works whether the fix started from
      // the browser plugin or straight in the lane.
      if (!binding) {
        const bound = this.autoBindIssue(lane, issueKey);
        if (!bound) {
          sendReply({ ok: false, reason: 'invalid_issue_key' });
          return;
        }
        binding = bound;
      }
      if (env.phase) binding.phase = env.phase;
      if (typeof env.summary === 'string') binding.summary = env.summary.slice(0, 300);
      if (typeof env.prUrl === 'string') binding.prUrl = env.prUrl.slice(0, 500);
      binding.updatedAt = Date.now();
      this.persistIssueBindings();
      this.publishIssueStatus(binding);
      sendReply({ ok: true });
    });

    // spec 146: the authoring lane self-reports a #review summary at synthesis
    // time. All fields are self-reported (no git collection, no session state) —
    // we just record the summary row, mirroring the attention_flag round-trip.
    type ReviewOutcomeEvent = {
      fromLaneId: string; // display name from Rust
      blockers: number;
      warnings: number;
      reviewerCount: number;
      subjectLabel: string;
      findings?: unknown;
      harnessId?: string;
      requestId?: string;
    };
    this.reviewOutcomeUnlisten = await listen<ReviewOutcomeEvent>('acp-review-outcome', (e) => {
      const env = e.payload;
      const requestId = env.requestId;
      if (!this.harnessMemoryId || env.harnessId !== this.harnessMemoryId) return;
      const reply = (result: { recorded: boolean; reason?: string }): void => {
        if (!requestId) return;
        void invoke('acp_bus_reply', { requestId, result }).catch((err) => {
          console.warn('acp_bus_reply (review_outcome) failed', err);
        });
      };
      reply(this.handleReviewOutcome(env));
    });

    // spec 160: the authoring lane self-reports diff review-priority ranges at
    // end-of-turn. Store the latest report per lane; the Diff Window pulls a
    // merged snapshot on open / refresh. Mirrors the review_outcome round-trip.
    type ReviewPriorityEvent = {
      fromLaneId: string; // display name from Rust
      ranges: ReviewPriorityRange[];
      harnessId?: string;
      requestId?: string;
    };
    this.reviewPriorityUnlisten = await listen<ReviewPriorityEvent>('acp-review-priority', (e) => {
      const env = e.payload;
      const requestId = env.requestId;
      if (!this.harnessMemoryId || env.harnessId !== this.harnessMemoryId) return;
      const reply = (result: { recorded: boolean; reason?: string }): void => {
        if (!requestId) return;
        void invoke('acp_bus_reply', { requestId, result }).catch((err) => {
          console.warn('acp_bus_reply (mark_review_priority) failed', err);
        });
      };
      reply(this.handleReviewPriority(env));
    });
  }

  /**
   * spec 160: record (or replace) one authoring lane's diff review-priority
   * report. The latest call wins — the working diff is cumulative state, so the
   * freshest read is the one the Window should triage by. An empty `ranges`
   * array clears the lane's report (reverts its hunks to the full diff).
   */
  private handleReviewPriority(env: {
    fromLaneId: string;
    ranges: ReviewPriorityRange[];
  }): { recorded: boolean; reason?: string } {
    const lane = this.lanes.find((l) => l.displayName === env.fromLaneId);
    if (!lane) return { recorded: false, reason: 'unknown_sender' };
    const ranges = Array.isArray(env.ranges) ? env.ranges : [];
    // The store emits `review:priority`, which drives the footer + overlay
    // refresh via the LaneBus subscription (spec 162).
    this.reviewPriorityStore.record(lane.id, ranges);
    return { recorded: true };
  }

  /**
   * spec 146: record one self-reported #review summary against the authoring
   * (convening) lane. Synchronous — there is no git collection or anchor to
   * mint, so we record and reply immediately.
   */
  private handleReviewOutcome(env: {
    fromLaneId: string;
    blockers: number;
    warnings: number;
    reviewerCount: number;
    subjectLabel: string;
    findings?: unknown;
  }): { recorded: boolean; reason?: string } {
    const lane = this.lanes.find((l) => l.displayName === env.fromLaneId);
    if (!lane) return { recorded: false, reason: 'unknown_sender' };
    const label = env.subjectLabel.trim() || '(review)';
    const findings = parseReviewFindings(env.findings);
    this.reviewQualityStore.record({
      authoringLaneId: lane.id,
      authoringLaneName: lane.displayName,
      subjectLabel: label,
      reviewerCount: Math.max(0, Math.trunc(env.reviewerCount)),
      blockers: Math.max(0, Math.trunc(env.blockers)),
      warnings: Math.max(0, Math.trunc(env.warnings)),
      findings,
    });
    this.appendTranscript(
      lane,
      'system',
      `[review] recorded: ${label} — ${env.blockers} blocker${env.blockers === 1 ? '' : 's'}, ${env.warnings} warning${env.warnings === 1 ? '' : 's'} across ${env.reviewerCount} reviewer${env.reviewerCount === 1 ? '' : 's'}`,
    );
    this.scheduleLaneRender(lane);
    return { recorded: true };
  }

  /**
   * spec 128: build a JudgementItem from a flag event and insert it into the
   * demand queue. Synchronous: the diffstat starts empty and is filled in later
   * by `enrichJudgementDiffstat()` so the bus reply returns before the timeout.
   */
  private handleAttentionFlag(env: {
    itemId: string;
    fromLaneId: string;
    question: string;
    chosen: string;
    rationale: string;
    tradedOff: string[];
    uncertainty: string;
    reversibility: JudgementItem['reversibility'];
    sentAt: number;
    harnessId?: string;
  }): { inserted: boolean; reason?: string } {
    const lane = this.lanes.find((l) => l.displayName === env.fromLaneId);
    if (!lane) return { inserted: false, reason: 'unknown_sender' };
    // spec 130: attention tools are default-on. If this lane came from an older
    // runtime path, seed the local audit state instead of rejecting the flag.
    if (!lane.triageEquipped) {
      lane.triageEquipped = true;
      this.triageStore.equip(lane.id);
    }

    const item: JudgementItem = {
      id: env.itemId,
      laneId: lane.id,
      question: env.question,
      chosen: env.chosen,
      rationale: env.rationale,
      tradedOff: env.tradedOff,
      uncertainty: env.uncertainty,
      reversibility: env.reversibility,
      packetId: null,
      diffstat: [],
      createdAt: env.sentAt,
      status: 'open',
    };
    this.triageStore.insert(item);
    lane.flaggedThisTurn = true;
    this.appendTranscript(lane, 'system', `[triage] flagged for review: ${item.question}`);
    this.scheduleLaneRender(lane);
    return { inserted: true };
  }

  /**
   * spec 128: fill in a flagged item's git blast-radius after it was inserted.
   * Runs after the bus reply, so a slow git probe never trips the bus timeout.
   */
  private async enrichJudgementDiffstat(itemId: string): Promise<void> {
    const item = this.triageStore.get(itemId);
    if (!item) return; // already resolved/closed
    const cwd = this.projectDir ?? '';
    if (!cwd) return;
    try {
      const git = await invoke<ReviewGitState>('acp_collect_review_git_state', { cwd });
      if (!git?.hasGitRepo || git.diffstat.length === 0) return;
      this.triageStore.setDiffstat(itemId, git.diffstat, `jpk-${itemId}`);
    } catch (err) {
      console.warn('attention_flag git collection failed', err);
    }
  }

  /**
   * spec 145: transcript-derived "what the author was trying to do", carried
   * into the review prompt so reviewers judge against intent (not a raw diff).
   * Earliest user turns hold the original task, so we read from the front.
   */
  private collectReviewIntent(lane: HarnessLane): string {
    const intents: string[] = [];
    for (const item of lane.transcript) {
      if (item.kind === 'user' && item.text.trim().length > 0) {
        intents.push(item.text.trim());
      }
    }
    return intents.join('\n\n').slice(0, REVIEW_INTENT_CAP);
  }

  /**
   * spec 145: classify the `--` tail as a design-doc subject. Only a path that
   * is relative (no leading `/`) with no `..` segment AND exists under the
   * project dir qualifies — an absolute path or a traversal escapes the repo and
   * is treated as a focus note instead, so `#review -- /etc/passwd` can't leak an
   * arbitrary file to reviewers. (A directory that happens to exist is a residual
   * edge: `stat_files` reports only mtime, so the agent would try to read it as a
   * doc and report that it can't — low harm.)
   */
  private async docPathExists(token: string): Promise<boolean> {
    const dir = this.projectDir ?? '';
    if (!dir) return false;
    if (token.startsWith('/') || token.split('/').includes('..')) return false;
    try {
      const mtimes = await invoke<number[]>('stat_files', { paths: [`${dir}/${token}`] });
      return (mtimes[0] ?? 0) > 0;
    } catch {
      return false;
    }
  }

  /**
   * spec 145: user-triggered `#review [<lane> ...] [-- <docpath | note>]`.
   * Agent-orchestrated: collect the review subject (working diff or a design
   * doc) and inject ONE prompt directing the convening lane to fan it out to
   * every reviewer via peer_send, then synthesize the replies. The harness no
   * longer assembles packets or routes a bespoke reply channel.
   */
  private async runReviewCommand(lane: HarnessLane, rest: string[]): Promise<void> {
    if (!this.projectDir) {
      this.flashChip('#review: no project dir');
      return;
    }
    // Require strictly idle (spec 145 Data Flow): an `awaiting_peer` convening
    // lane already has an outstanding peer_send, so a reviewer we pick could be
    // that same pending peer — the review send would fail `peer_in_flight` and
    // the unrelated outstanding reply could be miscounted as a review response.
    // An idle lane has no pending peers (recomputePeerStatus), so the fan-out is
    // unambiguous. The user can #cancel the peer conversation first.
    if (lane.status !== 'idle') {
      this.flashChip('lane busy - #cancel first');
      return;
    }

    // Split `<lane> ... -- <docpath | note>`: tokens before `--` name reviewers,
    // the tail after `--` is a doc path or a free focus note.
    const { nameTokens, tail } = parseReviewCommandArgs(rest);

    // Resolve reviewers: named subset (case-insensitive, exclude self,
    // exclude stopped/error) or — when none named — every other live local lane.
    const isLive = (l: HarnessLane): boolean => l.status !== 'stopped' && l.status !== 'error';
    let reviewers: HarnessLane[];
    let skipped: string[] = [];
    if (nameTokens.length > 0) {
      const wanted = nameTokens.map((t) => t.toLowerCase());
      reviewers = this.lanes.filter(
        (l) => l.id !== lane.id && isLive(l) && wanted.includes(l.displayName.toLowerCase()),
      );
      // Surface named reviewers that didn't resolve (unknown/self/stopped) so a
      // requested reviewer is never silently dropped from the fan-out.
      const matched = new Set(reviewers.map((r) => r.displayName.toLowerCase()));
      skipped = nameTokens.filter((t) => !matched.has(t.toLowerCase()));
    } else {
      reviewers = this.lanes.filter((l) => l.id !== lane.id && isLive(l));
    }
    if (reviewers.length === 0) {
      this.flashChip('#review: no reviewable lanes');
      return;
    }
    if (!lane.client) {
      this.flashChip('#review: lane not ready');
      return;
    }

    // Reserve the lane up front (Codex-1 B1): flip to busy + 'reviewing' label
    // BEFORE the async subject collection so peer mail or another prompt can't
    // claim it mid-command (a claimed lane would make the dispatch below no-op
    // while the chip still reported success). The busy label also shows the
    // operation persistently for the whole collection instead of via a 2s flash
    // that could expire first on a large repo (Claude-2). releaseReservedTurn
    // returns the lane to idle on any bail before dispatch.
    this.reserveCommandTurn(lane, 'reviewing');
    this.flashChip(`#review → ${reviewers.map((l) => l.displayName).join(', ')}: collecting subject…`);

    // Classify the tail: an existing repo file is the design-doc subject;
    // anything else is a free focus note over the working diff.
    let subject: ReviewSubject;
    let note: string | undefined;
    if (tail.length > 0 && (await this.docPathExists(tail))) {
      subject = { kind: 'doc', path: tail };
    } else {
      if (tail.length > 0) note = tail;
      const cwd = this.projectDir;
      let git: ReviewGitState | null = null;
      try {
        git = await invoke<ReviewGitState>('acp_collect_review_git_state', { cwd });
      } catch (e) {
        this.releaseReservedTurn(lane);
        this.flashChip(`#review: git collection failed: ${String(e)}`);
        return;
      }
      if (!git?.hasGitRepo) {
        this.releaseReservedTurn(lane);
        this.flashChip('#review: no git repo in lane cwd');
        return;
      }
      subject = {
        kind: 'diff',
        repoRoot: git.repoRoot,
        isUnbornHead: git.isUnbornHead,
        diffstat: git.diffstat,
        diff: git.diff,
        untracked: git.untracked,
      };
    }

    // Revalidate reviewers (Codex-1 W2): a lane may have closed or errored during
    // the async collection. Drop any no longer live so the prompt never advertises
    // a dead reviewer; bail (releasing the reservation) if none survive.
    const liveReviewers = reviewers.filter((r) => this.lanes.includes(r) && isLive(r));
    if (liveReviewers.length === 0) {
      this.releaseReservedTurn(lane);
      this.flashChip('#review: reviewers no longer available');
      return;
    }
    const reviewerNames = liveReviewers.map((l) => l.displayName);
    const prompt = reviewRequestPrompt({
      reviewers: reviewerNames,
      subject,
      intent: this.collectReviewIntent(lane),
      note,
    });
    // Lane is already reserved (busy) — send directly via dispatchTurn rather than
    // enqueueSystemPrompt (whose idle/awaiting_peer guard would now reject it).
    await this.dispatchTurn(lane, prompt);
    this.flashChip(
      `#review → ${reviewerNames.join(', ')}${skipped.length ? ` · skipped: ${skipped.join(', ')}` : ''}`,
    );
  }

  /**
   * spec 164: `#polly <task>` — any lane orchestrates; harness ensures
   * cursor/claude/codex worker lanes and injects a fan-out orchestration prompt.
   */
  private async runPollyCommand(lane: HarnessLane, task: string): Promise<void> {
    if (!task) {
      this.flashChip('#polly: no task');
      return;
    }
    if (lane.status !== 'idle') {
      this.flashChip('lane busy - #cancel first');
      return;
    }
    if (!lane.client) {
      this.flashChip('#polly: lane not ready');
      return;
    }

    this.reserveCommandTurn(lane, 'orchestrating');
    const outcome = await this.ensurePollyWorkers(lane);
    if (!outcome.ok) {
      this.releaseReservedTurn(lane);
      if (outcome.missing.length > 0) {
        this.flashChip(`#polly: ${outcome.missing.join(', ')} not installed`);
      } else if (outcome.errored.length > 0) {
        this.flashChip(`#polly: ${outcome.errored.join(', ')} failed to start`);
      } else {
        this.flashChip('#polly: worker roster incomplete');
      }
      return;
    }

    const { roster } = outcome;
    if (roster.spawned.length > 0) {
      const names = roster.workers
        .filter((w) => roster.spawned.includes(w.backendId))
        .map((w) => w.displayName);
      this.flashChip(`#polly: spawned ${names.join(', ')}`);
    }

    const prompt = pollyRequestPrompt({
      task,
      roster,
      intent: this.collectReviewIntent(lane),
    });
    await this.dispatchTurn(lane, prompt);
    this.flashChip(`#polly → ${roster.workers.map((w) => w.displayName).join(', ')}`);
  }

  /**
   * spec 167: `#debby <question>` — any lane orchestrates; harness ensures
   * claude/codex head lanes and injects a brainstorm prompt. Debby heads are
   * responders only, so this does not alter permissionMode.
   */
  private async runDebbyCommand(lane: HarnessLane, question: string): Promise<void> {
    if (!question) {
      this.flashChip('#debby: no question');
      return;
    }
    if (lane.status !== 'idle') {
      this.flashChip('lane busy - #cancel first');
      return;
    }
    if (!lane.client) {
      this.flashChip('#debby: lane not ready');
      return;
    }

    this.reserveCommandTurn(lane, 'brainstorming');
    const outcome = await this.ensureDebbyHeads(lane);
    if (!outcome.ok) {
      this.releaseReservedTurn(lane);
      if (outcome.missing.length > 0) {
        this.flashChip(`#debby: ${outcome.missing.join(', ')} not installed`);
      } else if (outcome.errored.length > 0) {
        this.flashChip(`#debby: ${outcome.errored.join(', ')} failed to start`);
      } else {
        this.flashChip('#debby: head roster incomplete');
      }
      return;
    }

    const { roster } = outcome;
    if (roster.spawned.length > 0) {
      const names = roster.heads
        .filter((h) => roster.spawned.includes(h.backendId))
        .map((h) => h.displayName);
      this.flashChip(`#debby: spawned ${names.join(', ')}`);
    }

    const prompt = debbyRequestPrompt({
      task: question,
      roster,
      intent: this.collectReviewIntent(lane),
    });
    await this.dispatchTurn(lane, prompt);
    this.flashChip(`#debby → ${roster.heads.map((h) => h.displayName).join(', ')}`);
  }

  private findPollyWorkerLane(
    orchestratorLaneId: string,
    backendId: PollyWorkerBackend,
  ): HarnessLane | undefined {
    // Includes `starting` lanes — peer_send queues to the inbox and drains on idle.
    return this.lanes.find(
      (l) =>
        l.backendId === backendId &&
        l.id !== orchestratorLaneId &&
        l.status !== 'stopped' &&
        l.status !== 'error',
    );
  }

  private findDebbyHeadLane(
    orchestratorLaneId: string,
    backendId: DebbyHeadBackend,
  ): HarnessLane | undefined {
    // Includes `starting` lanes — peer_send queues to the inbox and drains on idle.
    return this.lanes.find(
      (l) =>
        l.backendId === backendId &&
        l.id !== orchestratorLaneId &&
        l.status !== 'stopped' &&
        l.status !== 'error',
    );
  }

  /** Drop this lane's Polly role overlay (self-scoped — no cross-lane sweep). */
  private clearPollyBuiltinRole(lane: HarnessLane): void {
    // Restore the user's own permission mode if this lane was bypassed as a
    // Polly implementer (null saved mode = orchestrator or never enlisted, so
    // its permissionMode is left untouched).
    if (lane.pollySavedPermissionMode !== null) {
      lane.permissionMode = lane.pollySavedPermissionMode;
      lane.pollySavedPermissionMode = null;
    }
    lane.pollyBuiltinRole = null;
  }

  /** Drop this lane's Debby role overlay (self-scoped — no cross-lane sweep). */
  private clearDebbyBuiltinRole(lane: HarnessLane): void {
    lane.debbyBuiltinRole = null;
  }

  private async addPollyWorkerLane(
    orchestratorLane: HarnessLane,
    backendId: PollyWorkerBackend,
  ): Promise<HarnessLane | null> {
    const beforeCount = this.lanes.length;
    await this.addLane(backendId);
    if (this.lanes.length <= beforeCount) return null;
    const candidates = this.lanes.filter(
      (l) => l.backendId === backendId && l.id !== orchestratorLane.id,
    );
    return candidates[candidates.length - 1] ?? null;
  }

  private async addDebbyHeadLane(
    orchestratorLane: HarnessLane,
    backendId: DebbyHeadBackend,
  ): Promise<HarnessLane | null> {
    const beforeCount = this.lanes.length;
    await this.addLane(backendId);
    if (this.lanes.length <= beforeCount) return null;
    const candidates = this.lanes.filter(
      (l) => l.backendId === backendId && l.id !== orchestratorLane.id,
    );
    return candidates[candidates.length - 1] ?? null;
  }

  private async ensurePollyWorkers(orchestratorLane: HarnessLane): Promise<PollyEnsureOutcome> {
    const workerBackends = pollyWorkerBackendsFor(orchestratorLane.backendId);
    let installed: Set<string>;
    try {
      installed = new Set((await AcpClient.listBackends()).map((b) => b.id));
    } catch {
      return { ok: false, missing: [...workerBackends], errored: [] };
    }

    const workers: PollyRoster['workers'] = [];
    const spawned: PollyWorkerBackend[] = [];
    const spawnedLanes: HarnessLane[] = [];
    const missing: PollyWorkerBackend[] = [];
    const errored: PollyWorkerBackend[] = [];

    for (const backend of workerBackends) {
      let workerLane = this.findPollyWorkerLane(orchestratorLane.id, backend);
      if (!workerLane) {
        if (!installed.has(backend)) {
          missing.push(backend);
          continue;
        }
        workerLane = (await this.addPollyWorkerLane(orchestratorLane, backend)) ?? undefined;
        if (!workerLane) {
          errored.push(backend);
          continue;
        }
        spawned.push(backend);
        spawnedLanes.push(workerLane);
      }
      if (workerLane.status === 'error' || !workerLane.client) {
        errored.push(backend);
        continue;
      }
      workers.push({
        displayName: workerLane.displayName,
        laneId: workerLane.id,
        backendId: backend,
      });
    }

    this.activateLane(orchestratorLane.id);

    // spawn/collect first; prune dead spawns on failure; stamp roles only on full roster.
    if (missing.length > 0 || errored.length > 0 || workers.length !== workerBackends.length) {
      for (const lane of spawnedLanes) {
        if (lane.status === 'error') await this.closeLane(lane);
      }
      return { ok: false, missing, errored };
    }

    orchestratorLane.pollyBuiltinRole = 'orchestrator';
    this.clearDebbyBuiltinRole(orchestratorLane);
    this.clearSaltyBuiltinRole(orchestratorLane);
    for (const worker of workers) {
      const workerLane = this.lanes.find((l) => l.id === worker.laneId);
      if (!workerLane) continue;
      workerLane.pollyBuiltinRole = 'implementer';
      this.clearDebbyBuiltinRole(workerLane);
      this.clearSaltyBuiltinRole(workerLane);
      // Polly implementers auto-accept permissions for the run; stash the user's
      // own mode once (guard against re-stamping a reused lane that is already
      // bypassed) so clearPollyBuiltinRole can restore it.
      if (workerLane.pollySavedPermissionMode === null) {
        workerLane.pollySavedPermissionMode = workerLane.permissionMode;
      }
      workerLane.permissionMode = 'bypass';
    }
    this.render();

    return {
      ok: true,
      roster: {
        orchestrator: {
          displayName: orchestratorLane.displayName,
          laneId: orchestratorLane.id,
          backendId: orchestratorLane.backendId,
        },
        workers,
        spawned,
        missing,
        errored,
      },
    };
  }

  private async ensureDebbyHeads(orchestratorLane: HarnessLane): Promise<DebbyEnsureOutcome> {
    const headBackends = debbyHeadBackendsFor();
    let installed: Set<string>;
    try {
      installed = new Set((await AcpClient.listBackends()).map((b) => b.id));
    } catch {
      return { ok: false, missing: [...headBackends], errored: [] };
    }

    const heads: DebbyRoster['heads'] = [];
    const spawned: DebbyHeadBackend[] = [];
    const spawnedLanes: HarnessLane[] = [];
    const missing: DebbyHeadBackend[] = [];
    const errored: DebbyHeadBackend[] = [];

    for (const backend of headBackends) {
      let headLane = this.findDebbyHeadLane(orchestratorLane.id, backend);
      if (!headLane) {
        if (!installed.has(backend)) {
          missing.push(backend);
          continue;
        }
        headLane = (await this.addDebbyHeadLane(orchestratorLane, backend)) ?? undefined;
        if (!headLane) {
          errored.push(backend);
          continue;
        }
        spawned.push(backend);
        spawnedLanes.push(headLane);
      }
      if (headLane.status === 'error' || !headLane.client) {
        errored.push(backend);
        continue;
      }
      heads.push({
        displayName: headLane.displayName,
        laneId: headLane.id,
        backendId: backend,
      });
    }

    this.activateLane(orchestratorLane.id);

    // spawn/collect first; prune dead spawns on failure; stamp roles only on full roster.
    if (missing.length > 0 || errored.length > 0 || heads.length !== headBackends.length) {
      for (const lane of spawnedLanes) {
        if (lane.status === 'error') await this.closeLane(lane);
      }
      return { ok: false, missing, errored };
    }

    orchestratorLane.debbyBuiltinRole = 'orchestrator';
    this.clearPollyBuiltinRole(orchestratorLane);
    this.clearSaltyBuiltinRole(orchestratorLane);
    for (const head of heads) {
      const headLane = this.lanes.find((l) => l.id === head.laneId);
      if (!headLane) continue;
      headLane.debbyBuiltinRole = 'head';
      this.clearPollyBuiltinRole(headLane);
      this.clearSaltyBuiltinRole(headLane);
    }
    this.render();

    return {
      ok: true,
      roster: {
        orchestrator: {
          displayName: orchestratorLane.displayName,
          laneId: orchestratorLane.id,
          backendId: orchestratorLane.backendId,
        },
        heads,
        spawned,
        missing,
        errored,
      },
    };
  }

  /** Drop this lane's Salty role overlay (self-scoped — no cross-lane sweep). */
  private clearSaltyBuiltinRole(lane: HarnessLane): void {
    // Restore the user's own permission mode if this lane was bypassed as a
    // Salty mechanical/codex-peer executor (null saved mode = orchestrator,
    // responder, or never enlisted — its permissionMode is left untouched).
    if (lane.saltySavedPermissionMode !== null) {
      lane.permissionMode = lane.saltySavedPermissionMode;
      lane.saltySavedPermissionMode = null;
    }
    lane.saltyBuiltinRole = null;
  }

  /** spec 195: reuse ONLY an idle lane already stamped with this exact role —
   *  never conscript an arbitrary user lane (that would hijack its session and
   *  silently change its model). Busy/awaiting stamped lanes are skipped
   *  (never `session/set_model` mid-turn) — a fresh lane is spawned instead. */
  private findSaltyExecutorLane(
    spec: SaltyExecutorSpec,
    claimed: Set<string>,
  ): HarnessLane | undefined {
    return this.lanes.find(
      (l) =>
        !claimed.has(l.id) &&
        l.saltyBuiltinRole === spec.role &&
        l.backendId === spec.backendId &&
        l.status === 'idle' &&
        !!l.client,
    );
  }

  private async addSaltyExecutorLane(
    backendId: string,
    claimed: Set<string>,
  ): Promise<HarnessLane | null> {
    const beforeCount = this.lanes.length;
    await this.addLane(backendId);
    if (this.lanes.length <= beforeCount) return null;
    const candidates = this.lanes.filter(
      (l) => l.backendId === backendId && !claimed.has(l.id) && l.saltyBuiltinRole === null,
    );
    return candidates[candidates.length - 1] ?? null;
  }

  /** spec 195: apply an executor's model tier via the spec-127 switch path.
   *  Resolution: exact/unique-substring match against the agent-advertised
   *  list; an unresolved alias degrades (never sends a guessed id to
   *  `session/set_model`) and lights the existing modelApplyFailed amber chip.
   *  The returned outcome is embedded in `saltyRequestPrompt` so the
   *  orchestrator can route around a degraded tier. */
  private async applySaltyModel(
    lane: HarnessLane,
    spec: SaltyExecutorSpec,
  ): Promise<SaltyModelApply> {
    const current = lane.currentModelId ?? lane.modelName ?? undefined;
    if (!spec.modelAlias) return { effective: current, applied: true };
    const resolved = resolveSaltyModel(spec.modelAlias, lane.availableModels);
    if (!resolved) {
      lane.modelApplyFailed = true;
      return { requested: spec.modelAlias, effective: current, applied: false };
    }
    if (resolved.model_id === lane.currentModelId) {
      return { requested: spec.modelAlias, effective: resolved.model_id, applied: true };
    }
    await this.switchLaneModel(lane, resolved);
    const applied = lane.currentModelId === resolved.model_id && !lane.modelApplyFailed;
    return { requested: spec.modelAlias, effective: lane.currentModelId ?? current, applied };
  }

  private async ensureSaltyExecutors(
    orchestratorLane: HarnessLane,
    includeFellow: boolean,
  ): Promise<SaltyEnsureOutcome> {
    const plan = saltyExecutorPlan(includeFellow);
    let installed: Set<string>;
    try {
      installed = new Set((await AcpClient.listBackends()).map((b) => b.id));
    } catch {
      return { ok: false, missing: plan.map((s) => s.role), errored: [] };
    }

    // spec 195: invoking #salty from a stamped executor promotes it to
    // orchestrator — clear its old executor role (restoring any permission
    // snapshot) before the roster is built, so it can never double-assign.
    if (orchestratorLane.saltyBuiltinRole && orchestratorLane.saltyBuiltinRole !== 'orchestrator') {
      this.clearSaltyBuiltinRole(orchestratorLane);
    }

    const executors: SaltyRoster['executors'] = [];
    const spawned: SaltyExecutorRole[] = [];
    const spawnedLanes: HarnessLane[] = [];
    const missing: SaltyExecutorRole[] = [];
    const errored: SaltyExecutorRole[] = [];
    const claimed = new Set<string>([orchestratorLane.id]);

    for (const spec of plan) {
      let executorLane = this.findSaltyExecutorLane(spec, claimed);
      if (!executorLane) {
        if (!installed.has(spec.backendId)) {
          missing.push(spec.role);
          continue;
        }
        executorLane = (await this.addSaltyExecutorLane(spec.backendId, claimed)) ?? undefined;
        if (!executorLane) {
          errored.push(spec.role);
          continue;
        }
        spawned.push(spec.role);
        spawnedLanes.push(executorLane);
      }
      if (executorLane.status === 'error' || !executorLane.client) {
        errored.push(spec.role);
        continue;
      }
      claimed.add(executorLane.id);
      // Revalidate the tier on EVERY run (a reused lane's model may have
      // drifted via the live picker); the lane is idle here, so the switch
      // never lands mid-turn. Degradation is non-fatal by contract.
      const modelApply = await this.applySaltyModel(executorLane, spec);
      executors.push({
        displayName: executorLane.displayName,
        laneId: executorLane.id,
        backendId: spec.backendId,
        role: spec.role,
        modelApply,
      });
    }

    this.activateLane(orchestratorLane.id);

    // spec 195 partial-roster contract: abort when the thinker is unavailable
    // (the pushback gate is the workflow's spine) or when NO implementer
    // (mechanical/codex-peer) is live; otherwise proceed degraded — fellow is
    // best-effort. Prune dead spawns on abort (Polly parity).
    const unavailable = new Set<SaltyExecutorRole>([...missing, ...errored]);
    const abort =
      unavailable.has('thinker') ||
      (unavailable.has('mechanical') && unavailable.has('codexPeer'));
    if (abort) {
      for (const spawnedLane of spawnedLanes) {
        if (spawnedLane.status === 'error') await this.closeLane(spawnedLane);
      }
      return { ok: false, missing, errored };
    }

    orchestratorLane.saltyBuiltinRole = 'orchestrator';
    this.clearPollyBuiltinRole(orchestratorLane);
    this.clearDebbyBuiltinRole(orchestratorLane);
    for (const executor of executors) {
      const executorLane = this.lanes.find((l) => l.id === executor.laneId);
      if (!executorLane) continue;
      executorLane.saltyBuiltinRole = executor.role;
      this.clearPollyBuiltinRole(executorLane);
      this.clearDebbyBuiltinRole(executorLane);
      const spec = plan.find((s) => s.role === executor.role);
      if (spec?.bypass) {
        // Stash the user's own mode once (guard against re-stamping a reused
        // lane that is already bypassed) so clearSaltyBuiltinRole can restore it.
        if (executorLane.saltySavedPermissionMode === null) {
          executorLane.saltySavedPermissionMode = executorLane.permissionMode;
        }
        executorLane.permissionMode = 'bypass';
      }
    }
    this.render();

    return {
      ok: true,
      roster: {
        orchestrator: {
          displayName: orchestratorLane.displayName,
          laneId: orchestratorLane.id,
          backendId: orchestratorLane.backendId,
        },
        executors,
        spawned,
        missing,
        errored,
      },
    };
  }

  /**
   * spec 195: `#salty <task>` — model-tiered orchestration (SaltyAom workflow).
   * The active lane orchestrates; the harness ensures mechanical (claude@sonnet),
   * thinker (claude@opus), codex-peer (codex), optionally fellow (claude@fable)
   * executor lanes and injects the plan→pushback→dispatch→gate→cross-review
   * prompt. `#salty clear` sweeps all Salty roles and restores permission modes.
   */
  private async runSaltyCommand(
    lane: HarnessLane,
    command: ReturnType<typeof parseSaltyCommand>,
  ): Promise<void> {
    if (command.kind === 'clear') {
      let cleared = 0;
      for (const l of this.lanes) {
        if (l.saltyBuiltinRole !== null) {
          this.clearSaltyBuiltinRole(l);
          cleared += 1;
        }
      }
      this.flashChip(
        cleared > 0
          ? `#salty: cleared ${cleared} role${cleared === 1 ? '' : 's'}`
          : '#salty: no roles to clear',
      );
      return;
    }
    if (!command.task) {
      this.flashChip('#salty: no task');
      return;
    }
    if (lane.status !== 'idle') {
      this.flashChip('lane busy - #cancel first');
      return;
    }
    if (!lane.client) {
      this.flashChip('#salty: lane not ready');
      return;
    }

    this.reserveCommandTurn(lane, 'orchestrating');
    const outcome = await this.ensureSaltyExecutors(lane, command.includeFellow);
    if (!outcome.ok) {
      this.releaseReservedTurn(lane);
      if (outcome.missing.length > 0) {
        this.flashChip(`#salty: ${outcome.missing.join(', ')} not installed`);
      } else if (outcome.errored.length > 0) {
        this.flashChip(`#salty: ${outcome.errored.join(', ')} failed to start`);
      } else {
        this.flashChip('#salty: executor roster incomplete');
      }
      return;
    }

    const { roster } = outcome;
    if (roster.spawned.length > 0) {
      const names = roster.executors
        .filter((e) => roster.spawned.includes(e.role))
        .map((e) => e.displayName);
      this.flashChip(`#salty: spawned ${names.join(', ')}`);
    }

    const prompt = saltyRequestPrompt({
      task: command.task,
      roster,
      intent: this.collectReviewIntent(lane),
    });
    await this.dispatchTurn(lane, prompt);
    this.flashChip(`#salty → ${roster.executors.map((e) => e.displayName).join(', ')}`);
  }

  getWorkingDirectory(): string | null {
    return this.projectDir;
  }

  onClose(cb: () => void): void {
    this.closeCb = cb;
  }

  getLeaderKeyBindings(): LeaderKeyBinding[] {
    return [
      {
        key: '+',
        label: 'Add Lane',
        group: 'Harness',
        run: () => this.openLanePicker(),
      },
      {
        key: '_',
        label: 'Close Active Lane',
        group: 'Harness',
        effect: 'danger',
        run: () => this.closeActiveLane(),
        isEnabled: () => this.lanes.length > 0,
        disabledReason: () => 'no active lane',
      },
      {
        key: '=',
        label: 'Lane Metrics',
        group: 'Harness',
        run: () => this.toggleMetricsPanel(),
      },
      {
        key: '0',
        label: 'Resume Session',
        group: 'Harness',
        effect: 'important',
        run: () => this.openSessionPicker(),
      },
      {
        // spec 124 wanted `R` ("diRective"), but every letter is a reserved
        // global leader key (and `/` `;` `?` are taken by other views), so the
        // free non-reserved key is `.`.
        key: '.',
        label: 'Directives',
        group: 'Harness',
        run: () => this.openDirectivePicker(),
        isEnabled: () => this.lanes.length > 0,
        disabledReason: () => 'no active lane',
      },
      {
        // spec 127: model picker. `,` is the free non-reserved key (all letters
        // are reserved global leader keys; ⌃/⌘M is the memory drawer).
        key: ',',
        label: 'Switch Model',
        group: 'Lane',
        run: () => this.openModelPicker(),
        isEnabled: () => (this.activeLane()?.availableModels.length ?? 0) > 0,
        disabledReason: () => 'backend advertises no models',
      },
      {
        // spec 128: triage overlay. The spec's mnemonic `j` ("judgement") is a
        // reserved global leader key (compositor focus-down), so — per the
        // spec-124/127 precedent of substituting a free symbol — `;` opens the
        // judgement queue. Inside the overlay, j/k/a/r/o navigate directly.
        key: ';',
        label: 'Triage Queue',
        group: 'Harness',
        run: () => this.openTriageOverlay(),
      },
      {
        // spec 146: review quality matrix overlay. `'` is a free non-reserved
        // key (all letters are reserved global leader keys; `;` is the adjacent
        // triage queue, `,` `.` are model/directives). Inside, j/k switch lane.
        key: "'",
        label: 'Review Matrix',
        group: 'Harness',
        run: () => this.openReviewMatrixOverlay(),
        isEnabled: () => this.reviewQualityStore.totalReviews() > 0,
        disabledReason: () => 'no reviews recorded yet',
      },
      {
        // spec 162: review-priority roll-up overlay. `/` is the next free key in
        // the bottom punctuation cluster (`; ' , .`) where the harness overlays
        // live. Read-only; inside, j/k switch lane.
        key: '/',
        label: 'Review Priority',
        group: 'Harness',
        run: () => this.openReviewPriorityOverlay(),
        isEnabled: () => this.reviewPriorityStore.lanesWithReports().length > 0,
        disabledReason: () => 'no reading priority reported',
      },
      {
        // spec 180 shipped with no leader key (`o`/`O`, the "orchestrator"
        // mnemonic, are reserved *global* leader keys). Per the spec-124/127/128
        // precedent of substituting a free symbol, the backtick `` ` `` — the one
        // free non-reserved punctuation key adjacent to the harness cluster
        // (`; ' , . /`) — opens the console (promoting the active lane to the seat
        // if there is none yet, exactly like `#orchestrator`/`#console`).
        key: '`',
        label: 'Orchestrator',
        group: 'Harness',
        run: () => {
          const lane = this.activeLane();
          if (lane) this.openOrchestratorConsole(lane);
        },
        isEnabled: () => this.lanes.length > 0,
        disabledReason: () => 'no active lane',
      },
    ];
  }

  onKeyDown(e: KeyboardEvent): boolean {
    // spec 133: artifact hint mode swallows keys while active (read-only
    // transcript exception, active only in hint mode).
    if (this.artifactHintMode) return this.handleArtifactHintKey(e);
    if (e.key === '.' && (e.metaKey || e.ctrlKey) && !e.shiftKey && !e.altKey) {
      e.preventDefault();
      this.toggleZenMode();
      return true;
    }
    // spec 157: Cmd+Shift+. — with Shift held macOS reports the shifted char,
    // so match both '.' and '>'.
    if ((e.key === '.' || e.key === '>') && (e.metaKey || e.ctrlKey) && e.shiftKey && !e.altKey) {
      e.preventDefault();
      this.toggleConciseMode();
      return true;
    }
    if (this.helpOpen) {
      e.preventDefault();
      if (e.key === 'Escape' || e.key === '?' || e.key === 'q') this.toggleHelp(false);
      return true;
    }
    if (this.sessionPicker.open) {
      e.preventDefault();
      void this.handleSessionPickerKey(e);
      return true;
    }
    if (this.pickerOpen) {
      e.preventDefault();
      this.handlePickerKey(e);
      return true;
    }
    if (this.directivePickerOpen) {
      e.preventDefault();
      this.handleDirectivePickerKey(e);
      return true;
    }
    if (this.modelPickerOpen) {
      e.preventDefault();
      void this.handleModelPickerKey(e);
      return true;
    }
    // spec 194: `#ticket` picker modal — owns typing/arrows/Enter/Esc while
    // open, regardless of composer/transcript focus. Unclaimed combos (e.g.
    // Cmd+W) fall through so app-level shortcuts keep working.
    if (this.ticketPicker && this.handleTicketPickerKey(e)) return true;
    if (this.triageOverlayOpen) {
      e.preventDefault();
      this.handleTriageKey(e);
      return true;
    }
    if (this.reviewMatrixOverlayOpen) {
      e.preventDefault();
      this.handleReviewMatrixKey(e);
      return true;
    }
    if (this.reviewPriorityOverlayOpen) {
      e.preventDefault();
      this.handleReviewPriorityKey(e);
      return true;
    }
    // The console captures keys only while it is the visible top surface. When a
    // modal (metrics/memory, which are checked below it) has collapsed it, keys
    // must fall through to that modal — otherwise Escape would close the hidden
    // console instead of the modal on top. Modals checked ABOVE already win.
    if (this.orchestratorConsoleOpen && !this.consoleObscuringModalOpen()) {
      e.preventDefault();
      this.handleOrchestratorKey(e);
      return true;
    }
    if (this.metricsPanelOpen && e.key === 'Escape') {
      e.preventDefault();
      this.toggleMetricsPanel(false);
      return true;
    }
    if (this.memoryDrawerOpen && this.handleMemoryKey(e)) return true;
    if ((e.key === 'n' || e.key === 'N' || e.key === 'p' || e.key === 'P') && e.ctrlKey && !e.metaKey && !e.altKey && !e.shiftKey) {
      const composerLane = this.focus === 'text' ? this.activeLane() : null;
      if (composerLane && this.mentionPaletteVisibleFor(composerLane)) {
        return this.handleMentionPaletteKey(e, composerLane);
      }
      if (composerLane && slashPaletteVisible(composerLane)) {
        return this.handleSlashPaletteKey(e, composerLane);
      }
      if (composerLane && hashPaletteVisible(composerLane.draft, composerLane.hashPaletteDismissed)) {
        return this.handleHashPaletteKey(e, composerLane);
      }
      if (composerLane && this.verbPaletteVisibleFor(composerLane)) {
        return this.handleInlineVerbPaletteKey(e, composerLane);
      }
      e.preventDefault();
      this.activateLaneByDelta(e.key === 'n' || e.key === 'N' ? 1 : -1);
      return true;
    }
    if ((e.key === 'J' || e.key === 'K') && e.ctrlKey && e.shiftKey && !e.metaKey && !e.altKey) {
      const body = this.activeTranscriptBody();
      if (body) {
        e.preventDefault();
        body.scrollBy({ top: e.key === 'J' ? 60 : -60, behavior: 'instant' });
        return true;
      }
    }
    if ((e.key === 'h' || e.key === 'H') && e.ctrlKey && !e.metaKey && !e.altKey && !e.shiftKey) {
      const lane = this.activeLane();
      if (lane) {
        e.preventDefault();
        this.expandTranscriptWindow(lane);
        return true;
      }
    }
    if (this.focus === 'transcript' && this.handleTranscriptKey(e)) return true;

    const lane = this.activeLane();
    if (!lane) return false;

    if (lane.pendingPermissions.length > 0) {
      return this.handlePermissionKey(e, lane);
    }

    const pendingReview = this.firstUnresolvedFsReview(lane);
    if (pendingReview) {
      return this.handleFsReviewKey(e, lane, pendingReview);
    }

    if (e.key === 'Escape') {
      e.preventDefault();
      if (this.mentionPaletteVisibleFor(lane)) {
        lane.mentionPaletteDismissed = true;
        this.renderComposer();
      } else if (this.verbPaletteVisibleFor(lane)) {
        lane.verbPaletteDismissed = true;
        this.renderComposer();
      } else if (this.helpOpen) this.toggleHelp(false);
      else if (this.memoryDrawerOpen) this.toggleMemoryDrawer(false);
      else if (lane.stagedImages.length > 0) this.clearStagedImages(lane);
      else if (this.lanePeek.visible && this.lanePeek.currentLaneId) this.hideLanePeek();
      else this.enterTranscriptFocus();
      return true;
    }

    if (e.key === 'w' && e.metaKey && !e.ctrlKey && !e.altKey) {
      e.preventDefault();
      this.closeCb?.();
      return true;
    }

    if (e.key === 'c' && (e.ctrlKey || e.metaKey)) {
      e.preventDefault();
      if (lane.pendingShellId) void this.cancelShell(lane);
      else if (lane.status === 'busy' || lane.status === 'needs_permission' || lane.status === 'awaiting_peer') void this.cancelLane(lane);
      else this.setDraft(lane, '', 0);
      return true;
    }

    if ((e.key === 'm' || e.key === 'M') && (e.ctrlKey || e.metaKey) && !e.altKey && !e.shiftKey) {
      e.preventDefault();
      this.toggleMemoryDrawer(!this.memoryDrawerOpen);
      return true;
    }

    if (this.handleMentionPaletteKey(e, lane)) return true;

    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      void this.submitActiveLane().catch((error: unknown) => this.handleSubmitError(error));
      return true;
    }

    if (this.handleSlashPaletteKey(e, lane)) return true;
    if (this.handleHashPaletteKey(e, lane)) return true;
    if (this.handleInlineVerbPaletteKey(e, lane)) return true;
    if (this.handleHistoryKey(e, lane)) return true;
    if (this.handleEditingKey(e, lane)) return true;
    if (e.key.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey) {
      e.preventDefault();
      this.insertDraft(lane, e.key);
      return true;
    }
    return false;
  }

  private mentionRosterNames(): string[] {
    return this.lanes.map((l) => l.displayName);
  }

  private mentionPaletteVisibleFor(lane: HarnessLane): boolean {
    const roster = this.mentionRosterNames().filter((n) => n !== lane.displayName);
    return mentionPaletteVisible(
      lane.draft,
      lane.cursor,
      lane.mentionPaletteDismissed,
      roster.length,
    );
  }

  private filteredMentionPaletteTargets(lane: HarnessLane): string[] {
    const ctx = mentionPaletteContext(lane.draft, lane.cursor);
    if (!ctx) return [];
    return filteredMentionTargets(this.mentionRosterNames(), lane.displayName, ctx.prefix);
  }

  private handleMentionPaletteKey(e: KeyboardEvent, lane: HarnessLane): boolean {
    if (!this.mentionPaletteVisibleFor(lane)) return false;
    const matches = this.filteredMentionPaletteTargets(lane);
    if (matches.length === 0) return false;
    if (e.key === 'ArrowDown' || (e.ctrlKey && (e.key === 'n' || e.key === 'N'))) {
      e.preventDefault();
      lane.mentionPaletteIndex = (lane.mentionPaletteIndex + 1) % matches.length;
      this.renderComposer();
      return true;
    }
    if (e.key === 'ArrowUp' || (e.ctrlKey && (e.key === 'p' || e.key === 'P'))) {
      e.preventDefault();
      lane.mentionPaletteIndex = (lane.mentionPaletteIndex - 1 + matches.length) % matches.length;
      this.renderComposer();
      return true;
    }
    if (e.key === 'Enter' || e.key === 'Tab') {
      e.preventDefault();
      const pick = matches[Math.max(0, Math.min(lane.mentionPaletteIndex, matches.length - 1))];
      if (pick) {
        const next = applyMentionSelection(lane.draft, lane.cursor, pick);
        lane.mentionPaletteDismissed = false;
        this.setDraft(lane, next.draft, next.cursor);
      }
      return true;
    }
    if (e.key === 'Escape') {
      e.preventDefault();
      lane.mentionPaletteDismissed = true;
      this.renderComposer();
      return true;
    }
    return false;
  }

  private renderMentionPalette(lane: HarnessLane): string {
    if (!this.mentionPaletteVisibleFor(lane)) return '';
    const matches = this.filteredMentionPaletteTargets(lane);
    if (matches.length === 0) {
      return (
        `<div class="acp-harness__slash-palette" data-count="0">` +
        `<div class="acp-harness__slash-palette-meta">no matching lanes · Esc dismiss</div>` +
        `</div>`
      );
    }
    const safeIndex = Math.max(0, Math.min(lane.mentionPaletteIndex, matches.length - 1));
    const rows = matches
      .map((name, i) => {
        const sel = i === safeIndex ? ' acp-harness__slash-palette-row--selected' : '';
        return (
          `<div class="acp-harness__slash-palette-row${sel}">` +
          `<span class="acp-harness__slash-palette-name">@${esc(name)}</span>` +
          `</div>`
        );
      })
      .join('');
    return (
      `<div class="acp-harness__slash-palette" data-count="${matches.length}">` +
      `<div class="acp-harness__slash-palette-meta">↑↓ / ⌃n⌃p select · Enter/Tab insert · Esc dismiss</div>` +
      rows +
      `</div>`
    );
  }

  private handleSlashPaletteKey(e: KeyboardEvent, lane: HarnessLane): boolean {
    if (!slashPaletteVisible(lane)) return false;
    const matches = filteredSlashCommands(lane);
    if (matches.length === 0) return false;
    if (e.key === 'ArrowDown' || (e.ctrlKey && (e.key === 'n' || e.key === 'N'))) {
      e.preventDefault();
      lane.slashPaletteIndex = (lane.slashPaletteIndex + 1) % matches.length;
      this.renderComposer();
      return true;
    }
    if (e.key === 'ArrowUp' || (e.ctrlKey && (e.key === 'p' || e.key === 'P'))) {
      e.preventDefault();
      lane.slashPaletteIndex = (lane.slashPaletteIndex - 1 + matches.length) % matches.length;
      this.renderComposer();
      return true;
    }
    if (e.key === 'Enter' || e.key === 'Tab') {
      e.preventDefault();
      const cmd = matches[Math.max(0, Math.min(lane.slashPaletteIndex, matches.length - 1))];
      if (cmd) this.setDraft(lane, `/${cmd.name} `, cmd.name.length + 2);
      return true;
    }
    if (e.key === 'Escape') {
      e.preventDefault();
      lane.slashPaletteDismissed = true;
      this.renderComposer();
      return true;
    }
    return false;
  }

  /** Built-in `#` command palette. Mirrors the slash palette: Tab completes the
   *  highlighted command to `#name ` (a trailing space closes the palette via the
   *  regex), while Enter falls through to submit — so a fully-typed `#cancel` + Enter
   *  still fires immediately and only Tab is needed to autocomplete a partial token. */
  private handleHashPaletteKey(e: KeyboardEvent, lane: HarnessLane): boolean {
    if (!hashPaletteVisible(lane.draft, lane.hashPaletteDismissed)) return false;
    const matches = filteredHashCommands(lane.draft);
    if (matches.length === 0) return false;
    if (e.key === 'ArrowDown' || (e.ctrlKey && (e.key === 'n' || e.key === 'N'))) {
      e.preventDefault();
      lane.hashPaletteIndex = (lane.hashPaletteIndex + 1) % matches.length;
      this.renderComposer();
      return true;
    }
    if (e.key === 'ArrowUp' || (e.ctrlKey && (e.key === 'p' || e.key === 'P'))) {
      e.preventDefault();
      lane.hashPaletteIndex = (lane.hashPaletteIndex - 1 + matches.length) % matches.length;
      this.renderComposer();
      return true;
    }
    if (e.key === 'Tab') {
      e.preventDefault();
      const cmd = matches[Math.max(0, Math.min(lane.hashPaletteIndex, matches.length - 1))];
      if (cmd) this.setDraft(lane, `#${cmd.name} `, cmd.name.length + 2);
      return true;
    }
    if (e.key === 'Escape') {
      e.preventDefault();
      lane.hashPaletteDismissed = true;
      this.renderComposer();
      return true;
    }
    return false;
  }

  private renderHashPalette(lane: HarnessLane): string {
    if (!hashPaletteVisible(lane.draft, lane.hashPaletteDismissed)) return '';
    const matches = filteredHashCommands(lane.draft);
    if (matches.length === 0) return '';
    const safeIndex = Math.max(0, Math.min(lane.hashPaletteIndex, matches.length - 1));
    const rows = matches
      .map((cmd: HashCommand, i: number) => {
        const sel = i === safeIndex ? ' acp-harness__slash-palette-row--selected' : '';
        const hint = cmd.args ? `<span class="acp-harness__slash-palette-hint">${esc(cmd.args)}</span>` : '';
        const desc = `<span class="acp-harness__slash-palette-desc">${esc(cmd.description)}</span>`;
        return (
          `<div class="acp-harness__slash-palette-row${sel}">` +
          `<span class="acp-harness__slash-palette-name">#${esc(cmd.name)}</span>` +
          hint +
          desc +
          `</div>`
        );
      })
      .join('');
    return (
      `<div class="acp-harness__slash-palette" data-count="${matches.length}">` +
      `<div class="acp-harness__slash-palette-meta">↑↓ / ⌃n⌃p select · Tab complete · Esc dismiss</div>` +
      rows +
      `</div>`
    );
  }

  /** spec 194: `#ticket` picker — its own modal dialog (same overlay shell family
   *  as triage/review), keeping the palette keyboard grammar. The live filter
   *  renders as a dialog input line because the draft was consumed when #ticket
   *  opened the picker. */
  private renderTicketOverlayEl(): void {
    const picker = this.ticketPicker;
    this.ticketOverlayEl.hidden = !picker;
    if (!picker) return;
    const matches = this.ticketPickerMatches();
    const safeIndex = Math.max(0, Math.min(picker.index, matches.length - 1));
    const filter = picker.filter
      ? esc(picker.filter)
      : `<span class="acp-ticket__filter-hint">type to filter</span>`;
    const rows = matches.length === 0
      ? `<div class="acp-ticket__empty">no matching issues</div>`
      : matches
          .map((row, i) => {
            const sel = i === safeIndex ? ' acp-ticket__row--selected' : '';
            const labels = row.labels.length > 0
              ? `<span class="acp-ticket__labels">${esc(row.labels.join(', '))}</span>`
              : '';
            const updated = Date.parse(row.updatedAt ?? '');
            const age = Number.isNaN(updated) ? '' : formatAge(Date.now() - updated);
            const state = row.state === 'closed' ? ' · closed' : '';
            return (
              `<div class="acp-ticket__row${sel}">` +
              `<span class="acp-ticket__num">#${row.number}</span>` +
              `<span class="acp-ticket__title">${esc(row.title)}</span>` +
              labels +
              `<span class="acp-ticket__age">${esc(age)}${state}</span>` +
              `</div>`
            );
          })
          .join('');
    this.ticketPanelEl.innerHTML =
      `<header class="acp-ticket__head">working ticket` +
      `<span class="acp-ticket__sub">↑↓ / ⌃n⌃p select · Enter set · Esc dismiss</span></header>` +
      `<div class="acp-ticket__filter">${filter}<span class="acp-harness__caret">█</span></div>` +
      `<div class="acp-ticket__rows" data-count="${matches.length}">${rows}</div>` +
      `<footer class="acp-ticket__foot">shared with all ${this.lanes.length} lanes in this harness · read-only</footer>`;
    this.ticketPanelEl.querySelector('.acp-ticket__row--selected')?.scrollIntoView({ block: 'nearest' });
  }

  /** spec 191: inline verb-injection palette. Cursor-aware — fires when the user types
   *  a bare `#<prefix>` ANYWHERE mid-prompt (not the whole-draft `#command` case, which
   *  the command palette owns) and offers only injectable verbs. Tab inserts the full
   *  `{{#verb-name}}` token so the user never types the double braces by hand. */
  private verbPaletteEntriesFor(lane: HarnessLane): { name: string; description: string }[] {
    // The whole-draft `#command` palette owns a bare leading `#token` (regex-only check,
    // ignoring dismiss state) — so the two palettes never show at once.
    if (hashPaletteVisible(lane.draft, false)) return [];
    const ctx = verbPaletteContext(lane.draft, lane.cursor);
    if (!ctx) return [];
    return filteredVerbNames(injectableVerbNames(), ctx.prefix).map((name) => ({
      name,
      description: HASH_COMMANDS.find((c) => c.name === name)?.description ?? '',
    }));
  }

  private verbPaletteVisibleFor(lane: HarnessLane): boolean {
    if (lane.verbPaletteDismissed) return false;
    return this.verbPaletteEntriesFor(lane).length > 0;
  }

  private handleInlineVerbPaletteKey(e: KeyboardEvent, lane: HarnessLane): boolean {
    if (!this.verbPaletteVisibleFor(lane)) return false;
    const matches = this.verbPaletteEntriesFor(lane);
    if (matches.length === 0) return false;
    if (e.key === 'ArrowDown' || (e.ctrlKey && (e.key === 'n' || e.key === 'N'))) {
      e.preventDefault();
      lane.verbPaletteIndex = (lane.verbPaletteIndex + 1) % matches.length;
      this.renderComposer();
      return true;
    }
    if (e.key === 'ArrowUp' || (e.ctrlKey && (e.key === 'p' || e.key === 'P'))) {
      e.preventDefault();
      lane.verbPaletteIndex = (lane.verbPaletteIndex - 1 + matches.length) % matches.length;
      this.renderComposer();
      return true;
    }
    if (e.key === 'Tab') {
      e.preventDefault();
      const pick = matches[Math.max(0, Math.min(lane.verbPaletteIndex, matches.length - 1))];
      if (pick) {
        const next = applyVerbSelection(lane.draft, lane.cursor, pick.name);
        this.setDraft(lane, next.draft, next.cursor);
      }
      return true;
    }
    if (e.key === 'Escape') {
      e.preventDefault();
      lane.verbPaletteDismissed = true;
      this.renderComposer();
      return true;
    }
    return false;
  }

  private renderInlineVerbPalette(lane: HarnessLane): string {
    if (!this.verbPaletteVisibleFor(lane)) return '';
    const matches = this.verbPaletteEntriesFor(lane);
    if (matches.length === 0) return '';
    const safeIndex = Math.max(0, Math.min(lane.verbPaletteIndex, matches.length - 1));
    const rows = matches
      .map((entry, i) => {
        const sel = i === safeIndex ? ' acp-harness__slash-palette-row--selected' : '';
        const desc = entry.description
          ? `<span class="acp-harness__slash-palette-desc">${esc(entry.description)}</span>`
          : '';
        return (
          `<div class="acp-harness__slash-palette-row${sel}">` +
          `<span class="acp-harness__slash-palette-name">{{#${esc(entry.name)}}}</span>` +
          desc +
          `</div>`
        );
      })
      .join('');
    return (
      `<div class="acp-harness__slash-palette" data-count="${matches.length}">` +
      `<div class="acp-harness__slash-palette-meta">inject verb · ↑↓ / ⌃n⌃p select · Tab insert · Esc dismiss</div>` +
      rows +
      `</div>`
    );
  }

  onResize(_width: number, _height: number): void {
    this.schedulePretextLayout();
    this.scheduleStickyScroll();
  }

  getUsageProviders(): readonly UsageProvider[] {
    const providers = this.lanes
      .map((lane) => providerForBackend(lane.backendId))
      .filter((provider): provider is UsageProvider => provider !== null);
    return [...new Set(providers)];
  }

  onUsageProvidersChange(cb: () => void): () => void {
    this.usageProviderListeners.add(cb);
    return () => this.usageProviderListeners.delete(cb);
  }

  private notifyUsageProvidersChanged(): void {
    for (const listener of [...this.usageProviderListeners]) listener();
  }

  dispose(): void {
    // spec 141: leave the cross-harness directory FIRST — flip `alive` false (so
    // any delivery already past resolveDisplayName is rejected deterministically)
    // and unregister (which captures a close snapshot from the still-intact lanes
    // and fans a "peer closed" notice out to other harnesses) — all before
    // tearing lanes/clients/listeners down.
    if (this.directoryEntry) {
      this.directoryEntry.alive = false;
      unregisterHarness(this.directoryEntry.harnessId);
      this.directoryEntry = null;
    }
    if (this.telemetryPublisher) {
      this.telemetryPublisher.dispose();
      this.telemetryPublisher = null;
    }
    // spec 142: drop the active-lane accent while this.element is still in the
    // DOM (closePaneInTab disposes the contentView BEFORE removing the element),
    // so a surviving host window (sibling pane promoted) reverts to its
    // compositor-allocated color rather than keeping a stale lane tint.
    const accentHost = this.element.closest('.krypton-window');
    if (accentHost instanceof HTMLElement) delete accentHost.dataset.laneAccent;
    // spec 128: clear the footer attention badge — the harness is going away.
    this.publishAttention(0, null);
    // spec 146: clear the footer review-count indicator — the harness is going away.
    this.publishReviews(0);
    // spec 162: clear the footer review-priority indicator — going away.
    this.publishReviewPriority(0);
    // spec 180: drop the orchestrator console's live lane-bus subscription.
    this.orchestratorLaneBusUnsub?.();
    this.orchestratorLaneBusUnsub = null;
    this.stopComposerTick();
    this.stopMetricsTick();
    this.stopSpinnerTicker();
    if (this.toolTickTimer !== null) {
      window.clearInterval(this.toolTickTimer);
      this.toolTickTimer = null;
    }
    for (const lane of this.lanes) {
      if (lane.client) void lane.client.dispose();
      lane.client = null;
      // Spec 117: null streaming-markdown fields without calling parser_end —
      // the body may be detached and parser_end would flush tokens into a
      // soon-GC'd renderer.
      lane.streamingMarkdownParser = null;
      lane.streamingMarkdownBody = null;
      lane.streamingMarkdownItemId = null;
    }
    if (this.memoryUnlisten) {
      this.memoryUnlisten();
      this.memoryUnlisten = null;
    }
    if (this.interLaneUnlisten) {
      this.interLaneUnlisten();
      this.interLaneUnlisten = null;
    }
    if (this.attentionFlagUnlisten) {
      this.attentionFlagUnlisten();
      this.attentionFlagUnlisten = null;
    }
    if (this.attentionResolveUnlisten) {
      this.attentionResolveUnlisten();
      this.attentionResolveUnlisten = null;
    }
    if (this.issueReportUnlisten) {
      this.issueReportUnlisten();
      this.issueReportUnlisten = null;
    }
    if (this.reviewOutcomeUnlisten) {
      this.reviewOutcomeUnlisten();
      this.reviewOutcomeUnlisten = null;
    }
    if (this.reviewPriorityUnlisten) {
      this.reviewPriorityUnlisten();
      this.reviewPriorityUnlisten = null;
    }
    // The store is a private member GC'd with the view, and dispose already
    // re-published `highCount: 0` to the footer above — no explicit clear needed
    // (mirrors ReviewQualityStore; OpenCode-1 review W2).
    if (this.peerListUnlisten) {
      this.peerListUnlisten();
      this.peerListUnlisten = null;
    }
    if (this.mcpUnlisten) {
      this.mcpUnlisten();
      this.mcpUnlisten = null;
    }
    if (this.artifactUnlisten) {
      this.artifactUnlisten();
      this.artifactUnlisten = null;
    }
    if (this.feedbackUnlisten) {
      this.feedbackUnlisten();
      this.feedbackUnlisten = null;
    }
    if (this.docsFeedbackUnlisten) {
      this.docsFeedbackUnlisten();
      this.docsFeedbackUnlisten = null;
    }
    if (this.docsArtifactUnlisten) {
      this.docsArtifactUnlisten();
      this.docsArtifactUnlisten = null;
    }
    this.feedbackQueue.dispose();
    this.docsFeedbackQueue.dispose();
    this.docsArtifactQueue.dispose();
    this.diffReviewQueue.dispose();
    this.usageProviderListeners.clear();
    if (this.transcriptResizeObserver) {
      this.transcriptResizeObserver.disconnect();
      this.transcriptResizeObserver = null;
      this.observedTranscriptBody = null;
      this.observedTranscriptRows.clear();
    }
    if (this.harnessMemoryId) {
      void invoke('dispose_harness_memory', { harnessId: this.harnessMemoryId });
    }
  }

  stageCapturedImage(image: CapturedImage): boolean {
    const lane = this.activeLane();
    if (!lane) return false;
    if (this.helpOpen || this.memoryDrawerOpen) {
      this.flashChip('close overlay to stage capture');
      return true;
    }
    if (lane.pendingPermissions.length > 0) {
      this.flashChip('resolve permission before staging capture');
      return true;
    }
    const staged = this.stageImageData(lane, image.data, image.mimeType, image.path);
    if (staged) this.flashChip('screen capture staged');
    return true;
  }

  showLanePeek(): void {
    const candidate = this.bestLanePeekCandidate({ force: true });
    if (!candidate) {
      this.flashChip('no lane peek candidate');
      return;
    }
    this.lanePeek.visible = true;
    this.lanePeek.dismissedAt = null;
    this.lanePeek.dismissedPriority = null;
    this.lanePeek.lockedLaneId = null;
    this.applyLanePeekCandidate(candidate, true);
    this.render();
  }

  hideLanePeek(): void {
    const current = this.lanePeekCandidates().find((candidate) => candidate.laneId === this.lanePeek.currentLaneId) ?? null;
    this.lanePeek.visible = false;
    this.lanePeek.dismissedAt = Date.now();
    this.lanePeek.dismissedPriority = current?.priority ?? null;
    this.lanePeek.lockedLaneId = null;
    this.render();
  }

  unlockLanePeek(): void {
    this.lanePeek.lockedLaneId = null;
    this.lanePeek.dismissedAt = null;
    this.lanePeek.dismissedPriority = null;
    this.lanePeek.visible = true;
    this.render();
  }

  peekLaneByDelta(delta: number): void {
    const candidates = this.lanePeekCandidates();
    if (candidates.length === 0) {
      this.flashChip('no lane peek candidate');
      return;
    }
    if (candidates.length === 1) {
      this.lanePeek.visible = true;
      this.lanePeek.dismissedAt = null;
      this.lanePeek.dismissedPriority = null;
      this.lanePeek.lockedLaneId = null;
      this.applyLanePeekCandidate(candidates[0], true);
      this.flashChip('only one lane peek candidate');
      this.render();
      return;
    }
    const current = this.lanePeek.currentLaneId;
    const index = Math.max(0, candidates.findIndex((candidate) => candidate.laneId === current));
    const next = candidates[(index + delta + candidates.length) % candidates.length];
    this.lanePeek.visible = true;
    this.lanePeek.dismissedAt = null;
    this.lanePeek.dismissedPriority = null;
    this.lanePeek.lockedLaneId = next.laneId;
    this.applyLanePeekCandidate(next, true);
    this.render();
  }

  activatePeekedLane(): void {
    const laneId = this.lanePeek.currentLaneId;
    if (!laneId || laneId === this.activeLaneId) {
      this.flashChip('no peeked lane');
      return;
    }
    if (!this.lanes.some((lane) => lane.id === laneId)) {
      this.flashChip('peeked lane gone');
      this.lanePeek.currentLaneId = null;
      this.lanePeek.lockedLaneId = null;
      this.render();
      return;
    }
    this.lanePeek.visible = false;
    this.lanePeek.lockedLaneId = null;
    this.activateLane(laneId);
  }

  cyclePeekHeatMetric(): void {
    if (!this.isLanePeekHeatUiAvailable()) {
      this.flashChip('no lane peek candidate');
      return;
    }
    const order: LanePeekHeatMetric[] = ['auto', 'tools', 'tokens', 'peer', 'process', 'alerts'];
    const i = order.indexOf(this.lanePeekHeatMetric);
    this.lanePeekHeatMetric = order[(i + 1) % order.length];
    this.renderLanePeek();
  }

  cyclePeekHeatWindow(): void {
    if (!this.isLanePeekHeatUiAvailable()) {
      this.flashChip('no lane peek candidate');
      return;
    }
    const cand = this.bestLanePeekCandidate();
    if (!cand) {
      this.flashChip('no lane peek candidate');
      return;
    }
    const cur = this.effectivePeekHeatWindow(cand);
    const order: LanePeekHeatWindow[] = ['30s', '5m', 'session'];
    const idx = order.indexOf(cur);
    this.lanePeekHeatWindowExplicit = order[(idx + 1) % order.length];
    this.renderLanePeek();
  }

  togglePeekHeatDetail(): void {
    if (!this.isLanePeekHeatUiAvailable()) {
      this.flashChip('no lane peek candidate');
      return;
    }
    this.lanePeekHeatExpanded = !this.lanePeekHeatExpanded;
    this.renderLanePeek();
  }

  // ──────────────────────────────────────────────────────────────────
  // Attention triage (spec 128)

  /** Legacy spec-129 metadata: directives may still carry/show a triage badge,
   * but spec 130 no longer uses it to control tool visibility. */
  private directiveGrantsTriage(lane: HarnessLane): boolean {
    const directive = this.directiveById(lane.activeDirectiveId);
    return directive?.triage_equipped === true && directive.enabled;
  }

  /** spec 130: attention triage is default-on for harness-memory-capable lanes. */
  private computeTriageEquipped(lane: HarnessLane): boolean {
    void lane;
    return true;
  }

  /** Where the visible triage chip comes from. Directive grants are legacy
   * metadata; default is the active capability source. */
  private triageSource(lane: HarnessLane): 'default' | 'legacy' {
    return this.directiveGrantsTriage(lane) ? 'legacy' : 'default';
  }

  /**
   * spec 130: ensure a running lane participates in attention audit. Directive
   * changes no longer affect MCP tool visibility.
   */
  private refreshTriageEquip(lane: HarnessLane): void {
    const next = this.computeTriageEquipped(lane);
    if (next === lane.triageEquipped) return;
    lane.triageEquipped = next;
    if (next) this.triageStore.equip(lane.id);
    else this.triageStore.unequip(lane.id);
    this.renderTriageGaugeEl();
    this.scheduleLaneRender(lane);
  }

  private openTriageOverlay(): void {
    this.closeReviewMatrixOverlay(); // mutual-exclude: never stack the full-screen overlays
    this.closeReviewPriorityOverlay();
    this.triageOverlayOpen = true;
    this.triageRedirect = null;
    const open = this.triageStore.openItems();
    this.triageSelectedIndex = Math.min(this.triageSelectedIndex, Math.max(0, open.length - 1));
    this.helpOpen = false;
    this.memoryDrawerOpen = false;
    this.renderTriageOverlayEl();
    this.syncOrchestratorConsoleVisibility();
  }

  private closeTriageOverlay(): void {
    if (!this.triageOverlayOpen) return;
    this.triageOverlayOpen = false;
    this.triageRedirect = null;
    this.triageOverlayEl.hidden = true;
    this.syncOrchestratorConsoleVisibility();
  }

  private renderTriageGaugeEl(): void {
    // spec 128: the open-count gauge lives in the global workspace footer (its
    // documented home), not in the harness chrome — publish and let the footer
    // render it. The overlay is reached via the `;` leader key.
    this.publishAttention(
      this.triageStore.openCount(),
      this.triageStore.openItems()[0]?.reversibility ?? null,
    );
  }

  /** spec 128/138: surface the open attention count + heaviest reversibility tier
   * on the global workspace footer. Deduped on both fields so a no-op
   * `triage:changed` does not churn the footer, but a tier change at the same
   * count still re-publishes. `openItems()` is pre-sorted by reversibility
   * descending, so element 0 is the heaviest tier. */
  private publishAttention(openCount: number, maxReversibility: AttentionTier | null): void {
    if (openCount === this.lastPublishedAttention && maxReversibility === this.lastPublishedTier) return;
    this.lastPublishedAttention = openCount;
    this.lastPublishedTier = maxReversibility;
    this.viewBus?.publishSignal({
      kind: 'system:attention',
      source: SYSTEM_SOURCE,
      value: { sourceId: this.attentionSourceId, openCount, maxReversibility },
    });
  }

  private renderTriageOverlayEl(): void {
    this.triageOverlayEl.hidden = !this.triageOverlayOpen;
    if (!this.triageOverlayOpen) return;
    const items = this.triageStore.openItems();
    if (this.triageSelectedIndex >= items.length) {
      this.triageSelectedIndex = Math.max(0, items.length - 1);
    }
    const vm: TriageOverlayViewModel = {
      items,
      selectedIndex: this.triageSelectedIndex,
      laneName: (id) => this.lanes.find((l) => l.id === id)?.displayName ?? id,
      laneStats: (id) => this.triageStore.statsFor(id),
      redirect: this.triageRedirect ? { draft: this.triageRedirect.draft } : null,
      silentPileCount: this.triageStore.silentPile().length,
    };
    renderTriageOverlay(this.triagePanelEl, vm);
  }

  private selectedTriageItem(): JudgementItem | null {
    const items = this.triageStore.openItems();
    return items[this.triageSelectedIndex] ?? null;
  }

  /** Overlay key handling. Returns having consumed the event. */
  private handleTriageKey(e: KeyboardEvent): void {
    // Redirect one-line input sub-mode captures keys until Enter/Esc.
    if (this.triageRedirect) {
      this.handleTriageRedirectKey(e);
      return;
    }
    const items = this.triageStore.openItems();
    if (e.key === 'Escape' || e.key === 'q') {
      this.closeTriageOverlay();
      return;
    }
    if (items.length === 0) return;
    if (e.key === 'j' || e.key === 'ArrowDown') {
      this.triageSelectedIndex = (this.triageSelectedIndex + 1) % items.length;
      this.renderTriageOverlayEl();
      return;
    }
    if (e.key === 'k' || e.key === 'ArrowUp') {
      this.triageSelectedIndex = (this.triageSelectedIndex - 1 + items.length) % items.length;
      this.renderTriageOverlayEl();
      return;
    }
    const item = this.selectedTriageItem();
    if (!item) return;
    if (e.key === 'a') {
      // spec 183: acknowledge is no longer silent — tell the flagging lane its
      // chosen path is approved (deliver before the store transition; the item
      // clears from the queue regardless of delivery).
      const ack = this.coordinator.deliverAcknowledge(item.laneId);
      this.triageStore.accept(item.id);
      const lane = this.lanes.find((l) => l.id === item.laneId);
      const who = lane?.displayName ?? item.laneId;
      this.flashChip(ack.delivered ? `acknowledged → ${who}` : 'acknowledged (lane stopped — not notified)');
      this.renderTriageOverlayEl();
      return;
    }
    if (e.key === 'r') {
      this.triageRedirect = { itemId: item.id, draft: '' };
      this.renderTriageOverlayEl();
      return;
    }
    if (e.key === 'o' || e.key === 'Enter') {
      this.closeTriageOverlay();
      this.activateLane(item.laneId);
      return;
    }
  }

  private handleTriageRedirectKey(e: KeyboardEvent): void {
    const redirect = this.triageRedirect;
    if (!redirect) return;
    if (e.key === 'Escape') {
      this.triageRedirect = null;
      this.renderTriageOverlayEl();
      return;
    }
    if (e.key === 'Enter') {
      const text = redirect.draft.trim();
      if (!text) {
        this.triageRedirect = null;
        this.renderTriageOverlayEl();
        return;
      }
      this.submitTriageRedirect(redirect.itemId, text);
      return;
    }
    if (e.key === 'Backspace') {
      redirect.draft = redirect.draft.slice(0, -1);
      this.renderTriageOverlayEl();
      return;
    }
    if (e.key.length === 1 && !e.metaKey && !e.ctrlKey && !e.altKey) {
      redirect.draft += e.key;
      this.renderTriageOverlayEl();
    }
  }

  private submitTriageRedirect(itemId: string, text: string): void {
    const item = this.triageStore.get(itemId);
    if (!item) {
      this.triageRedirect = null;
      this.renderTriageOverlayEl();
      return;
    }
    const result = this.coordinator.deliverRedirect(item.laneId, text);
    if (!result.delivered) {
      // Edge case: stopped/cancelled lane — item stays open, surface a notice.
      const lane = this.lanes.find((l) => l.id === item.laneId);
      if (lane) this.appendTranscript(lane, 'system', `[triage] redirect failed: ${result.reason}`);
      this.flashChip(`redirect failed: ${result.reason}`);
      this.triageRedirect = null;
      this.renderTriageOverlayEl();
      return;
    }
    this.triageStore.redirect(itemId);
    this.triageRedirect = null;
    this.flashChip('redirect queued (next idle)');
    this.renderTriageOverlayEl();
  }

  // ── spec 146: review quality matrix ─────────────────────────────────────

  private openReviewMatrixOverlay(): void {
    if (this.reviewQualityStore.totalReviews() === 0) return;
    this.closeTriageOverlay(); // mutual-exclude: never stack the full-screen overlays
    this.closeReviewPriorityOverlay();
    this.reviewMatrixOverlayOpen = true;
    const lanes = this.reviewQualityStore.lanesWithHistory();
    this.reviewMatrixSelectedLaneIndex = Math.min(
      this.reviewMatrixSelectedLaneIndex,
      Math.max(0, lanes.length - 1),
    );
    this.reviewMatrixSelectedRowIndex = 0;
    this.reviewMatrixExpandedRowIndex = null;
    this.helpOpen = false;
    this.memoryDrawerOpen = false;
    this.renderReviewMatrixOverlayEl();
    this.syncOrchestratorConsoleVisibility();
  }

  private closeReviewMatrixOverlay(): void {
    if (!this.reviewMatrixOverlayOpen) return;
    this.reviewMatrixOverlayOpen = false;
    this.reviewMatrixExpandedRowIndex = null;
    this.reviewMatrixOverlayEl.hidden = true;
    this.syncOrchestratorConsoleVisibility();
  }

  private renderReviewGaugeEl(): void {
    // spec 146: the neutral review-count indicator lives in the global
    // workspace footer (beside, but distinct from, the attention gauge) —
    // publish and let the footer render it. The overlay is reached via `'`.
    this.publishReviews(this.reviewQualityStore.totalReviews());
  }

  /** spec 146: surface the total recorded review rounds on the global footer.
   * Deduped so a no-op does not churn the footer. Just a count — never coloured
   * by badness, never a score (ADR-0004). */
  private publishReviews(totalReviews: number): void {
    if (totalReviews === this.lastPublishedReviews) return;
    this.lastPublishedReviews = totalReviews;
    this.viewBus?.publishSignal({
      kind: 'review:quality',
      source: SYSTEM_SOURCE,
      value: { sourceId: this.attentionSourceId, totalReviews },
    });
  }

  private renderReviewMatrixOverlayEl(): void {
    this.reviewMatrixOverlayEl.hidden = !this.reviewMatrixOverlayOpen;
    if (!this.reviewMatrixOverlayOpen) return;
    const panel = this.reviewMatrixPanelEl;
    panel.replaceChildren();

    const lanes = this.reviewQualityStore.lanesWithHistory();
    if (this.reviewMatrixSelectedLaneIndex >= lanes.length) {
      this.reviewMatrixSelectedLaneIndex = Math.max(0, lanes.length - 1);
    }

    const header = document.createElement('header');
    header.className = 'acp-review__head';
    const title = document.createElement('span');
    title.className = 'acp-review__title';
    title.textContent = 'Review quality matrix';
    const sub = document.createElement('span');
    sub.className = 'acp-review__sub';
    sub.textContent = 'this session · in-memory · not persisted';
    header.append(title, sub);
    panel.appendChild(header);

    if (lanes.length === 0) {
      const empty = document.createElement('div');
      empty.className = 'acp-review__empty';
      empty.textContent = 'No reviews recorded.';
      panel.appendChild(empty);
      return;
    }

    // Lane switcher (only meaningful with >1 lane in history).
    if (lanes.length > 1) {
      const tabs = document.createElement('div');
      tabs.className = 'acp-review__lanes';
      lanes.forEach((laneId, i) => {
        const tab = document.createElement('span');
        tab.className = 'acp-review__lane' + (i === this.reviewMatrixSelectedLaneIndex ? ' is-active' : '');
        // A closed lane is gone from this.lanes; fall back to the displayName
        // snapshot stored on its newest recorded outcome so the row stays labelled.
        const history = this.reviewQualityStore.historyFor(laneId);
        const name =
          this.lanes.find((l) => l.id === laneId)?.displayName ?? history[0]?.authoringLaneName ?? laneId;
        tab.textContent = `${name} · ${history.length}`;
        tabs.appendChild(tab);
      });
      panel.appendChild(tabs);
    }

    const selectedLaneId = lanes[this.reviewMatrixSelectedLaneIndex];
    const rows = this.reviewQualityStore.historyFor(selectedLaneId);
    if (this.reviewMatrixSelectedRowIndex >= rows.length) {
      this.reviewMatrixSelectedRowIndex = Math.max(0, rows.length - 1);
    }
    if (
      this.reviewMatrixExpandedRowIndex !== null
      && this.reviewMatrixExpandedRowIndex >= rows.length
    ) {
      this.reviewMatrixExpandedRowIndex = null;
    }

    const table = document.createElement('table');
    table.className = 'acp-review__table';
    table.innerHTML =
      '<thead><tr>' +
      '<th class="acp-review__col-when">round</th>' +
      '<th class="acp-review__col-subj">subject</th>' +
      '<th class="acp-review__col-num">reviewers</th>' +
      '<th class="acp-review__col-num acp-review__col-block">block</th>' +
      '<th class="acp-review__col-num acp-review__col-warn">warn</th>' +
      '</tr></thead>';
    const tbody = document.createElement('tbody');
    rows.forEach((row, rowIndex) => {
      const hasFindings = (row.findings?.length ?? 0) > 0;
      const isSelected = rowIndex === this.reviewMatrixSelectedRowIndex;
      const isExpanded = hasFindings && this.reviewMatrixExpandedRowIndex === rowIndex;

      const tr = document.createElement('tr');
      if (isSelected) {
        tr.style.background = 'rgba(0, 204, 255, 0.08)';
      }
      const when = document.createElement('td');
      when.className = 'acp-review__when';
      when.textContent = formatReviewRoundTime(row.at);
      const subj = document.createElement('td');
      subj.className = 'acp-review__subj';
      subj.textContent = hasFindings
        ? `${isExpanded ? '▾' : '▸'} ${row.subjectLabel}`
        : row.subjectLabel;
      const rev = document.createElement('td');
      rev.className = 'acp-review__num acp-review__rev';
      rev.textContent = String(row.reviewerCount);
      const block = document.createElement('td');
      block.className = 'acp-review__num acp-review__block' + (row.blockers === 0 ? ' is-zero' : '');
      block.textContent = String(row.blockers);
      const warn = document.createElement('td');
      warn.className = 'acp-review__num acp-review__warn' + (row.warnings === 0 ? ' is-zero' : '');
      warn.textContent = String(row.warnings);
      tr.append(when, subj, rev, block, warn);
      tbody.appendChild(tr);

      if (isExpanded && row.findings) {
        const detailTr = document.createElement('tr');
        const detailTd = document.createElement('td');
        detailTd.colSpan = 5;
        detailTd.style.padding = '0 14px 8px';
        detailTd.style.background = 'rgba(0, 204, 255, 0.05)';
        detailTd.style.borderBottom = '1px solid rgba(0, 204, 255, 0.08)';
        detailTd.appendChild(this.renderReviewFindingsDetail(row.findings));
        detailTr.appendChild(detailTd);
        tbody.appendChild(detailTr);
      }
    });
    table.appendChild(tbody);
    panel.appendChild(table);

    const foot = document.createElement('div');
    foot.className = 'acp-review__foot';
    const hints: string[] = [];
    const rowsHaveFindings = rows.some((row) => (row.findings?.length ?? 0) > 0);
    if (rows.length > 0) {
      hints.push('<span><kbd>j</kbd> <kbd>k</kbd> select round</span>');
      if (rowsHaveFindings) {
        hints.push('<span><kbd>enter</kbd> <kbd>space</kbd> expand findings</span>');
      }
    }
    if (lanes.length > 1) {
      hints.unshift('<span><kbd>h</kbd> <kbd>l</kbd> switch lane</span>');
    }
    hints.push('<span><kbd>esc</kbd> close</span>');
    foot.innerHTML =
      hints.join('') +
      '<span class="acp-review__foot-note">read-only — observation, not a score</span>';
    panel.appendChild(foot);
  }

  /** Flat detail block grouped by severity; content font, no nested panels. */
  private renderReviewFindingsDetail(findings: ReviewFinding[]): HTMLElement {
    const wrap = document.createElement('div');
    wrap.style.padding = '6px 0 2px';
    wrap.style.fontFamily = 'var(--agent-font, var(--krypton-font-family, monospace))';
    // Findings are reading content (file paths + human-written notes), so anchor
    // to the standard content font size rather than shrinking it — the parent
    // table cell is already 0.9em, and a further em reduction here compounded the
    // notes down to ~10px. An absolute var() resets that compounding to the
    // user's configured body size; the group headings below stay a small label
    // kicker (0.72em of this), matching the table's column headers.
    wrap.style.fontSize = 'var(--krypton-font-size, 13px)';
    wrap.style.letterSpacing = 'normal';
    wrap.style.lineHeight = 'var(--krypton-content-line-height, 1.5)';

    const groups: Array<{ severity: ReviewFinding['severity']; label: string; color: string }> = [
      { severity: 'blocking', label: 'blocking', color: '#ff5d6c' },
      { severity: 'non-blocking', label: 'non-blocking', color: '#ffb454' },
      { severity: 'suggestion', label: 'suggestion', color: 'rgba(216, 232, 216, 0.72)' },
    ];

    let groupIndex = 0;
    for (const group of groups) {
      const items = findings.filter((f) => f.severity === group.severity);
      if (items.length === 0) continue;

      const heading = document.createElement('div');
      heading.textContent = group.label;
      heading.style.fontSize = '0.72em';
      heading.style.letterSpacing = '0.08em';
      heading.style.textTransform = 'uppercase';
      heading.style.color = group.color;
      heading.style.marginTop = groupIndex === 0 ? '0' : '8px';
      heading.style.marginBottom = '4px';
      wrap.appendChild(heading);

      for (const finding of items) {
        const line = document.createElement('div');
        const loc = finding.line !== undefined ? `${finding.file}:${finding.line}` : finding.file;
        line.textContent = `${loc} — ${finding.severity} — ${finding.note}`;
        line.style.color = 'rgba(216, 232, 216, 0.86)';
        line.style.padding = '2px 0';
        wrap.appendChild(line);
      }
      groupIndex += 1;
    }
    return wrap;
  }

  /** Overlay key handling. Read-only: h/l switch lane, j/k select round, Enter/Space expand. */
  private handleReviewMatrixKey(e: KeyboardEvent): void {
    if (e.key === 'Escape' || e.key === 'q') {
      this.closeReviewMatrixOverlay();
      return;
    }
    const lanes = this.reviewQualityStore.lanesWithHistory();
    if (lanes.length > 1 && (e.key === 'h' || e.key === 'ArrowLeft')) {
      this.reviewMatrixSelectedLaneIndex =
        (this.reviewMatrixSelectedLaneIndex - 1 + lanes.length) % lanes.length;
      this.reviewMatrixSelectedRowIndex = 0;
      this.reviewMatrixExpandedRowIndex = null;
      this.renderReviewMatrixOverlayEl();
      return;
    }
    if (lanes.length > 1 && (e.key === 'l' || e.key === 'ArrowRight')) {
      this.reviewMatrixSelectedLaneIndex = (this.reviewMatrixSelectedLaneIndex + 1) % lanes.length;
      this.reviewMatrixSelectedRowIndex = 0;
      this.reviewMatrixExpandedRowIndex = null;
      this.renderReviewMatrixOverlayEl();
      return;
    }

    const selectedLaneId = lanes[this.reviewMatrixSelectedLaneIndex];
    const rows = selectedLaneId ? this.reviewQualityStore.historyFor(selectedLaneId) : [];
    if (rows.length === 0) return;

    if (e.key === 'j' || e.key === 'ArrowDown') {
      this.reviewMatrixSelectedRowIndex = (this.reviewMatrixSelectedRowIndex + 1) % rows.length;
      this.reviewMatrixExpandedRowIndex = null;
      this.renderReviewMatrixOverlayEl();
      return;
    }
    if (e.key === 'k' || e.key === 'ArrowUp') {
      this.reviewMatrixSelectedRowIndex =
        (this.reviewMatrixSelectedRowIndex - 1 + rows.length) % rows.length;
      this.reviewMatrixExpandedRowIndex = null;
      this.renderReviewMatrixOverlayEl();
      return;
    }
    if (e.key === 'Enter' || e.key === ' ') {
      const row = rows[this.reviewMatrixSelectedRowIndex];
      if (!row?.findings?.length) return;
      this.reviewMatrixExpandedRowIndex =
        this.reviewMatrixExpandedRowIndex === this.reviewMatrixSelectedRowIndex
          ? null
          : this.reviewMatrixSelectedRowIndex;
      this.renderReviewMatrixOverlayEl();
    }
  }

  // ── spec 162: review-priority roll-up overlay + footer indicator ──────────

  private openReviewPriorityOverlay(): void {
    if (this.reviewPriorityStore.lanesWithReports().length === 0) return;
    this.closeTriageOverlay(); // mutual-exclude: never stack the full-screen overlays
    this.closeReviewMatrixOverlay();
    this.reviewPriorityOverlayOpen = true;
    const lanes = this.reviewPriorityStore.lanesWithReports();
    this.reviewPrioritySelectedLaneIndex = Math.min(
      this.reviewPrioritySelectedLaneIndex,
      Math.max(0, lanes.length - 1),
    );
    this.helpOpen = false;
    this.memoryDrawerOpen = false;
    this.renderReviewPriorityOverlayEl();
    this.syncOrchestratorConsoleVisibility();
  }

  private closeReviewPriorityOverlay(): void {
    if (!this.reviewPriorityOverlayOpen) return;
    this.reviewPriorityOverlayOpen = false;
    this.reviewPriorityOverlayEl.hidden = true;
    this.syncOrchestratorConsoleVisibility();
  }

  /** spec 162: surface the count of `high` review-priority ranges on the global
   * footer. Deduped so a no-op does not churn the footer. Neutral — never
   * coloured; an advisory reading hint, not an action queue (ADR-0009). */
  private publishReviewPriority(highCount: number): void {
    if (highCount === this.lastPublishedPriority) return;
    this.lastPublishedPriority = highCount;
    this.viewBus?.publishSignal({
      kind: 'review:priority',
      source: SYSTEM_SOURCE,
      value: { sourceId: this.attentionSourceId, highCount },
    });
  }

  private renderReviewPriorityOverlayEl(): void {
    this.reviewPriorityOverlayEl.hidden = !this.reviewPriorityOverlayOpen;
    if (!this.reviewPriorityOverlayOpen) return;
    const lanes = this.reviewPriorityStore.lanesWithReports();
    if (this.reviewPrioritySelectedLaneIndex >= lanes.length) {
      this.reviewPrioritySelectedLaneIndex = Math.max(0, lanes.length - 1);
    }
    const selectedLaneId = lanes[this.reviewPrioritySelectedLaneIndex];
    const vm: ReviewPriorityOverlayViewModel = {
      lanes,
      selectedIndex: this.reviewPrioritySelectedLaneIndex,
      laneName: (laneId) => this.lanes.find((l) => l.id === laneId)?.displayName ?? laneId,
      highCountFor: (laneId) => this.reviewPriorityStore.highCountFor(laneId),
      report: selectedLaneId ? this.reviewPriorityStore.reportFor(selectedLaneId) ?? null : null,
    };
    renderReviewPriorityOverlay(this.reviewPriorityPanelEl, vm);
  }

  /** Overlay key handling. Read-only: j/k switch lane, Esc/q close. */
  private handleReviewPriorityKey(e: KeyboardEvent): void {
    if (e.key === 'Escape' || e.key === 'q') {
      this.closeReviewPriorityOverlay();
      return;
    }
    const lanes = this.reviewPriorityStore.lanesWithReports();
    if (lanes.length < 2) return;
    if (e.key === 'j' || e.key === 'ArrowDown') {
      this.reviewPrioritySelectedLaneIndex =
        (this.reviewPrioritySelectedLaneIndex + 1) % lanes.length;
      this.renderReviewPriorityOverlayEl();
    } else if (e.key === 'k' || e.key === 'ArrowUp') {
      this.reviewPrioritySelectedLaneIndex =
        (this.reviewPrioritySelectedLaneIndex - 1 + lanes.length) % lanes.length;
      this.renderReviewPriorityOverlayEl();
    }
  }

  // ── spec 180: orchestrator console (in-app, acting) ──────────────────────

  /** The lane currently holding the orchestrator seat, or null. Resolved each
   *  read so a stopped/closed seat is treated as vacant. */
  private orchestratorLane(): HarnessLane | null {
    if (!this.orchestratorLaneId) return null;
    const lane = this.lanes.find(
      (l) => l.id === this.orchestratorLaneId && l.status !== 'stopped',
    );
    return lane ?? null;
  }

  /** Promote `lane` to the orchestrator seat (one-per-harness; transfers the seat
   *  if another lane already holds it). Behavior-neutral — no prompt injected. */
  private designateOrchestrator(lane: HarnessLane): void {
    if (this.orchestratorLaneId === lane.id) return;
    const prev = this.orchestratorLane();
    this.orchestratorLaneId = lane.id;
    if (prev) this.scheduleLaneRender(prev);
    this.scheduleLaneRender(lane);
    this.flashChip(`orchestrator → ${lane.displayName}`);
  }

  /** #orchestrator / #console entry: designate the active lane the seat if there
   *  is none yet, then open the console. An existing seat is left untouched. */
  private openOrchestratorConsole(lane: HarnessLane): void {
    if (!this.orchestratorLane()) this.designateOrchestrator(lane);
    this.closeTriageOverlay(); // mutual-exclude: never stack full-screen overlays
    this.closeReviewMatrixOverlay();
    this.closeReviewPriorityOverlay();
    this.helpOpen = false;
    this.memoryDrawerOpen = false;
    this.orchestratorConsoleOpen = true;
    this.orchestratorDispatch = null;
    this.orchestratorSeatPrompt = null;
    // Default the selection to the first non-orchestrator lane (a dispatch target).
    const seatId = this.orchestratorLaneId;
    const cards = this.lanes.filter((l) => l.status !== 'stopped');
    const firstTarget = cards.find((l) => l.id !== seatId) ?? cards[0] ?? null;
    if (!this.orchestratorSelectedLaneId || !cards.some((l) => l.id === this.orchestratorSelectedLaneId)) {
      this.orchestratorSelectedLaneId = firstTarget?.id ?? null;
    }
    // Live re-render while open: any lane-bus signal refreshes the grid/feed.
    this.orchestratorLaneBusUnsub?.();
    this.orchestratorLaneBusUnsub = this.laneBus.subscribe(() => {
      if (this.orchestratorConsoleOpen) this.renderOrchestratorConsoleEl();
    });
    this.renderOrchestratorConsoleEl();
  }

  private closeOrchestratorConsole(): void {
    if (!this.orchestratorConsoleOpen) return;
    this.orchestratorConsoleOpen = false;
    this.orchestratorDispatch = null;
    this.orchestratorSeatPrompt = null;
    this.orchestratorLaneBusUnsub?.();
    this.orchestratorLaneBusUnsub = null;
    this.orchestratorConsoleEl.hidden = true;
  }

  /** Modals that render as their own full-screen surface. While any is open, the
   *  orchestrator console is collapsed (hidden) so the two never stack, then
   *  restored when the modal closes. These modals reach the user via the leader
   *  menu (Cmd+P → key, handled by the InputRouter), which bypasses the console's
   *  own key capture — so a picker/overlay really can open on top of the console. */
  private consoleObscuringModalOpen(): boolean {
    return this.helpOpen
      || this.pickerOpen
      || this.directivePickerOpen
      || this.modelPickerOpen
      || this.sessionPicker.open
      || this.triageOverlayOpen
      || this.reviewMatrixOverlayOpen
      || this.reviewPriorityOverlayOpen
      || this.metricsPanelOpen
      || this.memoryDrawerOpen;
  }

  /** Collapse the console while a modal covers it; restore it — repainted from
   *  current state — when the modal closes. The console's OPEN state is untouched
   *  throughout (only its visibility changes), so the seat, `j/k` selection, and
   *  `a/r` permission target all survive the round-trip. No-op unless open. */
  private syncOrchestratorConsoleVisibility(): void {
    if (!this.orchestratorConsoleOpen) return;
    if (this.consoleObscuringModalOpen()) {
      this.orchestratorConsoleEl.hidden = true;
    } else if (this.orchestratorConsoleEl.hidden) {
      // Restoring from a collapse — lanes/permissions may have moved while the
      // modal was up, so repaint before showing (renderOrchestratorConsoleEl
      // clears `hidden` itself once no modal obscures it).
      this.renderOrchestratorConsoleEl();
    }
  }

  /** Console lane cards: every live lane (the orchestrator included, badged). */
  private orchestratorCards(): HarnessLane[] {
    return this.lanes.filter((l) => l.status !== 'stopped');
  }

  private orchestratorSelectedLane(): HarnessLane | null {
    const cards = this.orchestratorCards();
    return cards.find((l) => l.id === this.orchestratorSelectedLaneId) ?? cards[0] ?? null;
  }

  /** spec 184: the fleet-wide pending-permission queue — every live lane that is
   *  awaiting a permission, in grid order (top-to-bottom). The head of THIS list
   *  is the default answer target; one row per lane (its head request), with
   *  `(+N more)` flagging a per-lane backlog. Drives the console's global
   *  permission region and the `a`/`r` target. */
  private pendingPermissionLanes(): HarnessLane[] {
    return this.orchestratorCards().filter((l) => l.pendingPermissions.length > 0);
  }

  /** spec 184: the focused queue lane (whose head request `a`/`r` answers).
   *  Honors `orchestratorPermFocusId` while that lane is still pending; otherwise
   *  falls back to the queue head, so answering one auto-advances to the next. */
  private orchestratorPermFocusLane(): HarnessLane | null {
    const queue = this.pendingPermissionLanes();
    return queue.find((l) => l.id === this.orchestratorPermFocusId) ?? queue[0] ?? null;
  }

  /** spec 181 follow-up: the console mirrors the live permission queue, but the
   *  `LaneBus` subscription only fires on status *transitions*. A queue mutation
   *  that keeps the lane `needs_permission` — answering the head when >1 are
   *  queued, a new request arriving while the lane is already paused, or a
   *  transport rollback back into the same status — emits nothing, so the strip /
   *  `(+N more)` / footer legend would go stale while `a`/`r` act on the real new
   *  head. Re-render the console directly on those mutations. No-op (guarded) when
   *  the console is closed, so the generic permission path stays unaffected. */
  private refreshOrchestratorConsole(): void {
    if (this.orchestratorConsoleOpen) this.renderOrchestratorConsoleEl();
  }

  private renderOrchestratorConsoleEl(): void {
    // Hidden when closed OR while a modal is collapsing the console over it — so
    // a background laneBus re-render never un-hides a collapsed console.
    this.orchestratorConsoleEl.hidden = !this.orchestratorConsoleOpen || this.consoleObscuringModalOpen();
    if (!this.orchestratorConsoleOpen) return;
    const cards = this.orchestratorCards();
    if (!cards.some((l) => l.id === this.orchestratorSelectedLaneId)) {
      this.orchestratorSelectedLaneId = cards[0]?.id ?? null;
    }
    const seatId = this.orchestratorLaneId;
    const selected = this.orchestratorSelectedLane();

    const busy = cards.filter((l) => l.status === 'busy' || l.status === 'needs_permission').length;
    const awaiting = cards.filter((l) => l.status === 'awaiting_peer').length;
    const flags = this.triageStore.openCount();
    const permLanes = this.pendingPermissionLanes();
    const seatLane = this.orchestratorLane();
    const summary =
      `${cards.length} lane${cards.length === 1 ? '' : 's'} · ${busy} busy · ` +
      `${awaiting} awaiting · ${flags} flag${flags === 1 ? '' : 's'}` +
      (permLanes.length > 0 ? ` · ${permLanes.length} perm` : '');

    const cardHtml = cards
      .map((l) => {
        const isSeat = l.id === seatId;
        const isSel = l.id === this.orchestratorSelectedLaneId;
        const cls =
          'acp-orchestrator__card' +
          (isSel ? ' acp-orchestrator__card--selected' : '') +
          (isSeat ? ' acp-orchestrator__card--seat' : '');
        const triageOpen = this.triageStore.openItems().filter((i) => i.laneId === l.id).length;
        const high = this.reviewPriorityStore.highCountFor(l.id);
        const tags: string[] = [];
        if (isSeat) tags.push(`<span class="acp-orchestrator__badge">◆ orchestrator</span>`);
        const inbox = this.coordinator.inboxDepth(l.id);
        if (inbox > 0) tags.push(`<span class="acp-orchestrator__tag">inbox ${inbox}</span>`);
        if (triageOpen > 0) tags.push(`<span class="acp-orchestrator__tag acp-orchestrator__tag--attn">⚑ ${triageOpen}</span>`);
        if (high > 0) tags.push(`<span class="acp-orchestrator__tag">diff ${high}</span>`);
        if (l.pendingPermissions.length > 0) tags.push(`<span class="acp-orchestrator__tag acp-orchestrator__tag--perm">⚠ perm</span>`);
        const goal = l.goal ? `<div class="acp-orchestrator__goal">${esc(truncate(l.goal.text, 72))}</div>` : '';
        const model = l.modelName ? ` · ${esc(l.modelName)}` : '';
        return (
          `<div class="${cls}" data-orch-lane="${esc(l.id)}">` +
          `<div class="acp-orchestrator__card-head">` +
          `<span class="acp-orchestrator__card-name">${esc(l.displayName)}</span>` +
          `<span class="acp-orchestrator__card-status acp-orchestrator__card-status--${esc(l.status)}">${esc(statusLabel(l.status))}</span>` +
          `</div>` +
          `<div class="acp-orchestrator__card-meta">${esc(backendLabel(l.backendId))}${model}</div>` +
          (tags.length ? `<div class="acp-orchestrator__tags">${tags.join('')}</div>` : '') +
          goal +
          `</div>`
        );
      })
      .join('');

    // spec 184: the GLOBAL pending-permission region — a fleet-wide queue shown
    // above the body whenever any lane is awaiting permission, so the operator
    // confirms from a single place without selecting (and activating) each card.
    const permQueueHtml = this.renderOrchestratorPermQueue(permLanes);

    // Orchestration feed: recent inter-lane + flag rows from the seat's transcript.
    const feedHtml = this.renderOrchestratorFeed(seatLane);

    const dispatchHtml = this.renderOrchestratorDispatch(selected, seatId);
    const seatPromptHtml = this.renderOrchestratorSeatPrompt(seatLane);

    this.orchestratorPanelEl.innerHTML =
      `<header class="acp-orchestrator__head">` +
      `<span class="acp-orchestrator__title">Orchestrator console</span>` +
      `<span class="acp-orchestrator__seat">${seatLane ? esc(seatLane.displayName) : 'no seat'}</span>` +
      `<span class="acp-orchestrator__summary">${esc(summary)}</span>` +
      `</header>` +
      permQueueHtml +
      `<div class="acp-orchestrator__body">` +
      `<section class="acp-orchestrator__region" data-region="lanes">` +
      `<h3 class="acp-orchestrator__region-title">Lanes</h3>` +
      `<div class="acp-orchestrator__grid">${cardHtml || '<div class="acp-orchestrator__empty">no lanes</div>'}</div>` +
      `</section>` +
      `<section class="acp-orchestrator__region" data-region="feed">` +
      `<h3 class="acp-orchestrator__region-title">Feed</h3>${feedHtml}` +
      `</section>` +
      `<section class="acp-orchestrator__region acp-orchestrator__region--reserved" data-region="reserved">` +
      `<div class="acp-orchestrator__reserved-note">reserved — task list · delegation graph (future)</div>` +
      `</section>` +
      `</div>` +
      dispatchHtml +
      seatPromptHtml +
      `<footer class="acp-orchestrator__keys">` +
      esc(this.orchestratorKeyLegend(selected)) +
      `</footer>`;

    // The whole panel is re-rendered via innerHTML each keystroke, so an open
    // dispatch/seat-prompt input resets its scroll to the top. Once a draft
    // exceeds the input's max-height it scrolls internally — pin it to the
    // bottom so the caret (appended after the draft) stays visible while typing.
    if (this.orchestratorDispatch || this.orchestratorSeatPrompt) {
      this.orchestratorPanelEl
        .querySelectorAll<HTMLElement>(
          '.acp-orchestrator__dispatch--active .acp-orchestrator__dispatch-input',
        )
        .forEach((input) => {
          input.scrollTop = input.scrollHeight;
        });
    }
  }

  /** spec 182: the seat-prompt line (a normal turn to the orchestrator seat),
   *  below dispatch. Mirrors the dispatch line: a hint when idle, an input while
   *  open. Disabled (with the reason) when there is no live seat. */
  private renderOrchestratorSeatPrompt(seat: HarnessLane | null): string {
    const reason = seatPromptDisabledReason(seat);
    const target = seat ? esc(seat.displayName) : '—';
    if (!this.orchestratorSeatPrompt) {
      const hint = reason
        ? `<span class="acp-orchestrator__dispatch-disabled">${esc(reason)}</span>`
        : `<span class="acp-orchestrator__dispatch-hint">press i to prompt ${target}</span>`;
      return (
        `<section class="acp-orchestrator__dispatch" data-region="seat-prompt">` +
        `<span class="acp-orchestrator__dispatch-label">prompt → ${target}</span>${hint}` +
        `</section>`
      );
    }
    return (
      `<section class="acp-orchestrator__dispatch acp-orchestrator__dispatch--active" data-region="seat-prompt">` +
      `<span class="acp-orchestrator__dispatch-label">prompt → ${target}</span>` +
      `<span class="acp-orchestrator__dispatch-input">${orchestratorInputHtml(this.orchestratorSeatPrompt.draft, 'type a prompt · Enter send · Esc cancel')}</span>` +
      `</section>`
    );
  }

  /** Footer legend. While the selected card has a pending permission, a/r answer
   *  it (r shadows restart, per spec 181); otherwise the standard action keys. */
  private orchestratorKeyLegend(_selected: HarnessLane | null): string {
    if (this.pendingPermissionLanes().length > 0) {
      // spec 184: a/r answer the FOCUSED queue item (global, no lane switch); Tab
      // steps the focus; j/k still select cards beneath the queue.
      return 'a accept · r reject (A/R all) · Tab next perm · j/k select · c interrupt · x kill · Esc close';
    }
    return 'j/k select · Enter jump · d dispatch · i prompt seat · c interrupt · x kill · r restart · o set seat · Esc close';
  }

  private renderOrchestratorFeed(seat: HarnessLane | null): string {
    if (!seat) return `<div class="acp-orchestrator__empty">designate a seat to see its feed</div>`;
    const rows = seat.transcript
      .filter((t) => t.kind === 'inter_lane' || t.kind === 'system')
      .slice(-8)
      .reverse()
      .map((t) => {
        const who = t.interLane
          ? `${t.interLane.direction === 'out' ? '→' : '←'} ${esc(t.interLane.peerDisplayName)}`
          : 'system';
        return (
          `<div class="acp-orchestrator__feed-row">` +
          `<span class="acp-orchestrator__feed-who">${who}</span>` +
          `<span class="acp-orchestrator__feed-text">${esc(truncate(t.text.replace(/\s+/g, ' ').trim(), 96))}</span>` +
          `</div>`
        );
      })
      .join('');
    return rows
      ? `<div class="acp-orchestrator__feed">${rows}</div>`
      : `<div class="acp-orchestrator__empty">no coordination activity yet</div>`;
  }

  /** spec 184: the global pending-permission queue region. One row per awaiting
   *  lane (its head request), in grid order, rendered above the body whenever any
   *  lane is paused on a permission — so the operator answers from a single fleet
   *  view without selecting (and activating) each lane. The FOCUSED row (`a`/`r`
   *  target) is ringed; `Tab` steps the focus when more than one lane is queued.
   *  A high-risk request (rm / force-push / network / script / unparseable) shows
   *  its FULL, UNTRUNCATED command (`extractCommandLineRaw` — never the 48-char
   *  label, which could hide a destructive tail) + a `⚠ high-risk` marker, so the
   *  dangerous accept is reviewed in place. `(+N more)` flags a per-lane backlog. */
  private renderOrchestratorPermQueue(permLanes: HarnessLane[]): string {
    if (permLanes.length === 0) return '';
    const focus = this.orchestratorPermFocusLane();
    const rows = permLanes
      .map((l) => {
        const permission = l.pendingPermissions[0];
        if (!permission) return '';
        const isFocus = focus !== null && l.id === focus.id;
        const more = l.pendingPermissions.length - 1;
        const moreTag = more > 0 ? `<span class="acp-orchestrator__perm-more">(+${more} more)</span>` : '';
        const highRisk = this.isHighRiskPermission(permission);
        const fullCommand = highRisk ? extractCommandLineRaw(permission.toolCall.rawInput) : '';
        const detail = fullCommand
          ? `<span class="acp-orchestrator__perm-command">${esc(fullCommand)}</span>`
          : '';
        const hint = isFocus
          ? highRisk
            ? `<span class="acp-orchestrator__perm-hint acp-orchestrator__perm-hint--highrisk">⚠ high-risk · a accept · A all · r reject · R all</span>`
            : `<span class="acp-orchestrator__perm-hint">a accept · A all · r reject · R all</span>`
          : highRisk
            ? `<span class="acp-orchestrator__perm-hint acp-orchestrator__perm-hint--highrisk">⚠ high-risk</span>`
            : '';
        const cls =
          'acp-orchestrator__perm' +
          (isFocus ? ' acp-orchestrator__perm--focus' : '') +
          (highRisk ? ' acp-orchestrator__perm--highrisk' : '');
        return (
          `<div class="${cls}">` +
          `<span class="acp-orchestrator__perm-lane">${esc(l.displayName)}</span>` +
          `<span class="acp-orchestrator__perm-label">${esc(compactPermissionLabel(permission))}</span>${moreTag}` +
          detail +
          hint +
          `</div>`
        );
      })
      .join('');
    const stepHint = permLanes.length > 1 ? ' · Tab next' : '';
    return (
      `<section class="acp-orchestrator__permq" data-region="permissions">` +
      `<h3 class="acp-orchestrator__region-title">Pending permissions${esc(stepHint)}</h3>` +
      rows +
      `</section>`
    );
  }

  private renderOrchestratorDispatch(selected: HarnessLane | null, seatId: string | null): string {
    const disabledReason = dispatchDisabledReason({
      seatId,
      targetId: selected?.id ?? null,
      laneCount: this.orchestratorCards().length,
    });
    const target = selected ? esc(selected.displayName) : '—';
    if (!this.orchestratorDispatch) {
      const hint = disabledReason
        ? `<span class="acp-orchestrator__dispatch-disabled">${esc(disabledReason)}</span>`
        : `<span class="acp-orchestrator__dispatch-hint">press d to dispatch to ${target}</span>`;
      return (
        `<section class="acp-orchestrator__dispatch" data-region="dispatch">` +
        `<span class="acp-orchestrator__dispatch-label">dispatch → ${target}</span>${hint}` +
        `</section>`
      );
    }
    const purposes = DISPATCH_PURPOSES.map(
      (p) =>
        `<span class="acp-orchestrator__purpose${p === this.orchestratorDispatch?.purpose ? ' acp-orchestrator__purpose--active' : ''}">${esc(p)}</span>`,
    ).join('');
    return (
      `<section class="acp-orchestrator__dispatch acp-orchestrator__dispatch--active" data-region="dispatch">` +
      `<span class="acp-orchestrator__dispatch-label">dispatch → ${target}</span>` +
      `<span class="acp-orchestrator__purposes" title="Tab cycles purpose">${purposes}</span>` +
      `<span class="acp-orchestrator__dispatch-input">${orchestratorInputHtml(this.orchestratorDispatch.draft, 'type a task · Enter send · Esc cancel')}</span>` +
      `</section>`
    );
  }

  /** j/k card selection. The console overlay (`orchestratorConsoleEl`) is a
   *  separate element `render()` never touches, so switching the background
   *  active lane to the selected card keeps the transcript behind the console in
   *  sync without disturbing the overlay — the console stays open and on top, and
   *  closing it (Esc / Enter) lands on the lane the operator was just inspecting. */
  private selectOrchestratorCard(id: string): void {
    this.orchestratorSelectedLaneId = id;
    if (id !== this.activeLaneId) this.activateLane(id); // re-renders the background
    this.renderOrchestratorConsoleEl();
  }

  /** Console key handling. Dispatch / seat-prompt input sub-modes capture keys
   *  until Enter/Esc. */
  private handleOrchestratorKey(e: KeyboardEvent): void {
    if (this.orchestratorDispatch) {
      this.handleOrchestratorDispatchKey(e);
      return;
    }
    if (this.orchestratorSeatPrompt) {
      this.handleOrchestratorSeatPromptKey(e);
      return;
    }
    if (e.key === 'Escape' || e.key === 'q') {
      this.closeOrchestratorConsole();
      this.render();
      return;
    }
    const cards = this.orchestratorCards();
    if (cards.length === 0) return;
    let idx = cards.findIndex((l) => l.id === this.orchestratorSelectedLaneId);
    if (idx < 0) idx = 0;
    if (e.key === 'j' || e.key === 'ArrowDown') {
      this.selectOrchestratorCard(cards[(idx + 1) % cards.length].id);
      return;
    }
    if (e.key === 'k' || e.key === 'ArrowUp') {
      this.selectOrchestratorCard(cards[(idx - 1 + cards.length) % cards.length].id);
      return;
    }
    // spec 184: the GLOBAL pending-permission queue takes precedence for a/A/r/R
    // and Tab, fleet-wide — mirroring the lane view, where a pending permission
    // shadows other keys. The target is the FOCUSED queue lane (not the card
    // selection), and answering does NOT switch the active lane, so the operator
    // confirms a worker's permission without leaving their vantage. While any
    // permission is pending, `r` is reject (shadowing restart); `a` accepts inline
    // even for a high-risk command (its full command is shown for review).
    const permQueue = this.pendingPermissionLanes();
    if (permQueue.length > 0) {
      if (e.key === 'Tab') {
        const fIdx = permQueue.findIndex((l) => l.id === this.orchestratorPermFocusLane()?.id);
        const step = e.shiftKey ? -1 : 1;
        this.orchestratorPermFocusId = permQueue[(fIdx + step + permQueue.length) % permQueue.length].id;
        this.renderOrchestratorConsoleEl();
        return;
      }
      if (e.key === 'a' || e.key === 'A' || e.key === 'r' || e.key === 'R') {
        const focus = this.orchestratorPermFocusLane();
        if (focus) this.answerConsolePermission(focus, e.key);
        return;
      }
    }
    const selected = this.orchestratorSelectedLane();
    if (!selected) return;
    if (e.key === 'Enter') {
      this.closeOrchestratorConsole();
      this.activateLane(selected.id);
      this.render();
      return;
    }
    if (e.key === 'o') {
      this.designateOrchestrator(selected);
      this.renderOrchestratorConsoleEl();
      return;
    }
    if (e.key === 'd') {
      const reason = dispatchDisabledReason({
        seatId: this.orchestratorLaneId,
        targetId: selected.id,
        laneCount: this.orchestratorCards().length,
      });
      if (reason) {
        this.flashChip(`dispatch: ${reason}`);
        return;
      }
      this.orchestratorDispatch = { draft: '', purpose: 'implement' };
      this.renderOrchestratorConsoleEl();
      return;
    }
    if (e.key === 'i') {
      // spec 182: prompt the SEAT (a normal turn), independent of the selection.
      const reason = seatPromptDisabledReason(this.orchestratorLane());
      if (reason) {
        this.flashChip(`prompt: ${reason}`);
        return;
      }
      this.orchestratorSeatPrompt = { draft: '' };
      this.renderOrchestratorConsoleEl();
      return;
    }
    if (e.key === 'c') {
      void this.cancelLane(selected);
      this.flashChip(`interrupt → ${selected.displayName}`);
      return;
    }
    if (e.key === 'x') {
      void this.closeLane(selected);
      this.flashChip(`kill → ${selected.displayName}`);
      return;
    }
    if (e.key === 'r') {
      void this.restartLane(selected);
      this.flashChip(`restart → ${selected.displayName}`);
      return;
    }
  }

  private handleOrchestratorDispatchKey(e: KeyboardEvent): void {
    const dispatch = this.orchestratorDispatch;
    if (!dispatch) return;
    if (e.key === 'Escape') {
      this.orchestratorDispatch = null;
      this.renderOrchestratorConsoleEl();
      return;
    }
    if (e.key === 'Tab') {
      dispatch.purpose = nextDispatchPurpose(dispatch.purpose);
      this.renderOrchestratorConsoleEl();
      return;
    }
    if (e.key === 'Enter') {
      const text = dispatch.draft.trim();
      if (!text) {
        this.orchestratorDispatch = null;
        this.renderOrchestratorConsoleEl();
        return;
      }
      this.dispatchFromConsole(dispatch.purpose, text);
      return;
    }
    if (e.key === 'Backspace') {
      dispatch.draft = dispatch.draft.slice(0, -1);
      this.renderOrchestratorConsoleEl();
      return;
    }
    if (e.key.length === 1 && !e.metaKey && !e.ctrlKey && !e.altKey) {
      dispatch.draft += e.key;
      this.renderOrchestratorConsoleEl();
    }
  }

  /** spec 182: seat-prompt input — Enter sends a normal turn to the seat, Esc
   *  cancels (input only; does not close the console). Mirrors the dispatch input. */
  private handleOrchestratorSeatPromptKey(e: KeyboardEvent): void {
    const prompt = this.orchestratorSeatPrompt;
    if (!prompt) return;
    if (e.key === 'Escape') {
      this.orchestratorSeatPrompt = null;
      this.renderOrchestratorConsoleEl();
      return;
    }
    if (e.key === 'Enter') {
      const text = prompt.draft.trim();
      this.orchestratorSeatPrompt = null;
      if (!text) {
        this.renderOrchestratorConsoleEl();
        return;
      }
      this.sendSeatPrompt(text);
      return;
    }
    if (e.key === 'Backspace') {
      prompt.draft = prompt.draft.slice(0, -1);
      this.renderOrchestratorConsoleEl();
      return;
    }
    if (e.key.length === 1 && !e.metaKey && !e.ctrlKey && !e.altKey) {
      prompt.draft += e.key;
      this.renderOrchestratorConsoleEl();
    }
  }

  /** spec 182: send a normal user turn to the orchestrator seat from the console
   *  (NOT a `peer_send` — the human is the seat's operator). Routes through the
   *  shared `submitLanePrompt`, so `#`-commands, `!`-shell, and the spec-136
   *  busy-queue behave exactly as in the lane composer. */
  private sendSeatPrompt(text: string): void {
    const seat = this.orchestratorLane();
    const reason = seatPromptDisabledReason(seat);
    if (!seat || reason) {
      this.flashChip(`prompt: ${reason ?? 'no seat'}`);
      this.renderOrchestratorConsoleEl();
      return;
    }
    this.flashChip(`prompt → ${seat.displayName}`);
    void this.submitLanePrompt(seat, text, []);
    this.renderOrchestratorConsoleEl();
  }

  /** spec 180: a dispatch is an ordinary `peer_send` from the orchestrator seat to
   *  the selected lane (inbox drop, drained on the target's own idle turn). It is
   *  NOT a Goal-set — the worker keeps its session and context. */
  private dispatchFromConsole(purpose: DispatchPurpose, text: string): void {
    const seat = this.orchestratorLane();
    const target = this.orchestratorSelectedLane();
    this.orchestratorDispatch = null;
    if (!seat) {
      this.flashChip('dispatch: no orchestrator seat');
      this.renderOrchestratorConsoleEl();
      return;
    }
    const reason = dispatchDisabledReason({
      seatId: seat.id,
      targetId: target?.id ?? null,
      laneCount: this.orchestratorCards().length,
    });
    if (!target || reason) {
      this.flashChip(`dispatch: ${reason ?? 'pick another lane'}`);
      this.renderOrchestratorConsoleEl();
      return;
    }
    const body = orchestratorDispatchBody(purpose, text);
    const result = this.coordinator.deliverMentionFanOut(
      seat.id,
      seat.displayName,
      [{ laneId: target.id, displayName: target.displayName }],
      body,
      this.harnessMemoryId ?? undefined,
    );
    if (result.delivered.length === 0) {
      const reason = result.failed[0]?.reason ?? 'no target';
      this.flashChip(`dispatch failed: ${reason}`);
      this.renderOrchestratorConsoleEl();
      return;
    }
    if (this.coordinator.pendingPeersFor(seat.id).length > 0) {
      this.setLaneStatus(seat, 'awaiting_peer');
    }
    this.flashChip(`dispatched ${purpose} → ${target.displayName}`);
    this.scheduleLaneRender(seat);
    this.renderOrchestratorConsoleEl();
  }

  /** spec 181/184: answer a lane's head pending permission from the console,
   *  reusing `resolvePermission` — high-risk commands included (their full command
   *  is shown in the queue row for review). The lane is the focused queue item, so
   *  this never switches the active lane. Set accept/reject-all only after the
   *  action resolves, immediately before resolving. `A`/`R` mirror the lane view's
   *  all-for-turn. The re-render falls the focus back to the new queue head. */
  private answerConsolePermission(lane: HarnessLane, key: 'a' | 'A' | 'r' | 'R'): void {
    const permission = lane.pendingPermissions[0];
    const action: 'accept' | 'reject' = key === 'a' || key === 'A' ? 'accept' : 'reject';
    const decision = consolePermissionAction({ pending: !!permission, action });
    if (decision === 'none') return;
    const flags = armConsolePermissionFlags(key, decision);
    if (flags.acceptAll) lane.acceptAllForTurn = true;
    if (flags.rejectAll) lane.rejectAllForTurn = true;
    this.flashChip(`${decision} → ${lane.displayName}`);
    void this.resolvePermission(lane, decision, flags.acceptAll || flags.rejectAll, 'orchestrator console');
  }

  private buildDOM(): void {
    // spec 125 — inject reusable backend logo <symbol> defs once. Hidden
    // off-screen so <use href="#krypton-logo-*"/> resolves from the rail.
    const logoDefs = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    logoDefs.setAttribute('width', '0');
    logoDefs.setAttribute('height', '0');
    logoDefs.setAttribute('aria-hidden', 'true');
    logoDefs.style.position = 'absolute';
    logoDefs.innerHTML = `<defs>${BACKEND_LOGO_SVG_DEFS}${HARNESS_ICON_SVG_DEFS}</defs>`;
    this.element.appendChild(logoDefs);

    const body = document.createElement('div');
    body.className = 'acp-harness__body';
    this.dashboardEl = document.createElement('div');
    this.dashboardEl.className = 'acp-harness__dashboard';
    this.dashboardEl.addEventListener(
      'scroll',
      (e: Event) => {
        if (e.target instanceof HTMLElement && e.target.classList.contains('acp-harness__lane-body')) {
          this.onTranscriptScroll();
        }
      },
      true,
    );
    body.appendChild(this.dashboardEl);

    // Agent-rendered markdown anchors (the only <a> elements anywhere in this
    // view — transcript, peek, plan) always open in the OS browser; the click
    // is intercepted so the app webview never navigates. See agentLinkOpenAction.
    this.element.addEventListener('click', (e: MouseEvent) => {
      const target = e.target;
      if (!(target instanceof Element)) return;
      const anchor = target.closest<HTMLAnchorElement>('a[href]');
      if (!anchor) return;
      e.preventDefault();
      const href = anchor.getAttribute('href') ?? '';
      if (agentLinkOpenAction(href) === 'external') {
        openExternalUrl(href, { external: true });
      }
    });

    this.memoryOverlayEl = document.createElement('aside');
    this.memoryOverlayEl.className = 'acp-harness__memory-overlay';
    this.memoryOverlayEl.hidden = true;
    const memoryHead = document.createElement('header');
    memoryHead.className = 'acp-harness__memory-head';
    memoryHead.textContent = 'Memory';
    this.memoryOverlayEl.appendChild(memoryHead);
    this.memoryPanelEl = document.createElement('section');
    this.memoryPanelEl.className = 'acp-harness__memory-panel';
    this.memoryPanelEl.addEventListener('click', (event: MouseEvent) => {
      const target = event.target;
      if (!(target instanceof Element)) return;
      const row = target.closest<HTMLElement>('[data-memory-lane]');
      if (!row) return;
      const lane = row.dataset.memoryLane;
      if (!lane) return;
      this.memoryCursorRowId = lane;
      this.renderMemory();
    });
    this.memoryOverlayEl.appendChild(this.memoryPanelEl);
    body.appendChild(this.memoryOverlayEl);

    this.helpOverlayEl = document.createElement('aside');
    this.helpOverlayEl.className = 'acp-harness__help-overlay';
    this.helpOverlayEl.hidden = true;
    body.appendChild(this.helpOverlayEl);

    this.metricsOverlayEl = document.createElement('aside');
    this.metricsOverlayEl.className = 'acp-harness__metrics-overlay';
    this.metricsOverlayEl.hidden = true;
    body.appendChild(this.metricsOverlayEl);

    // spec 128: attention-triage overlay (summon-on-demand judgement queue).
    this.triageOverlayEl = document.createElement('aside');
    this.triageOverlayEl.className = 'acp-harness__triage-overlay';
    this.triageOverlayEl.hidden = true;
    this.triagePanelEl = document.createElement('div');
    this.triagePanelEl.className = 'acp-triage__panel';
    this.triageOverlayEl.appendChild(this.triagePanelEl);
    body.appendChild(this.triageOverlayEl);

    // spec 146: review-quality-matrix overlay (summon-on-demand, read-only).
    this.reviewMatrixOverlayEl = document.createElement('aside');
    this.reviewMatrixOverlayEl.className = 'acp-harness__review-overlay';
    this.reviewMatrixOverlayEl.hidden = true;
    this.reviewMatrixPanelEl = document.createElement('div');
    this.reviewMatrixPanelEl.className = 'acp-review__panel';
    this.reviewMatrixOverlayEl.appendChild(this.reviewMatrixPanelEl);
    body.appendChild(this.reviewMatrixOverlayEl);

    // spec 162: review-priority roll-up overlay (summon-on-demand, read-only).
    this.reviewPriorityOverlayEl = document.createElement('aside');
    this.reviewPriorityOverlayEl.className = 'acp-harness__priority-overlay';
    this.reviewPriorityOverlayEl.hidden = true;
    this.reviewPriorityPanelEl = document.createElement('div');
    this.reviewPriorityPanelEl.className = 'acp-priority__panel';
    this.reviewPriorityOverlayEl.appendChild(this.reviewPriorityPanelEl);
    body.appendChild(this.reviewPriorityOverlayEl);

    // spec 194: `#ticket` picker — its own modal dialog, not a composer popup.
    this.ticketOverlayEl = document.createElement('aside');
    this.ticketOverlayEl.className = 'acp-harness__ticket-overlay';
    this.ticketOverlayEl.hidden = true;
    this.ticketPanelEl = document.createElement('div');
    this.ticketPanelEl.className = 'acp-ticket__panel';
    this.ticketOverlayEl.appendChild(this.ticketPanelEl);
    body.appendChild(this.ticketOverlayEl);

    // spec 180: orchestrator console (in-app, acting; opened with #orchestrator).
    this.orchestratorConsoleEl = document.createElement('aside');
    this.orchestratorConsoleEl.className = 'acp-harness__orchestrator';
    this.orchestratorConsoleEl.hidden = true;
    this.orchestratorPanelEl = document.createElement('div');
    this.orchestratorPanelEl.className = 'acp-orchestrator__panel';
    this.orchestratorConsoleEl.appendChild(this.orchestratorPanelEl);
    body.appendChild(this.orchestratorConsoleEl);

    this.planEl = document.createElement('aside');
    this.planEl.className = 'acp-harness__plan';
    this.planEl.hidden = true;

    this.laneRailEl = document.createElement('div');
    this.laneRailEl.className = 'acp-harness__lane-rail';
    // spec 148/194: ticket + goal pins — top rail slot, same surface cluster as
    // the lane peek (moved out of the composer).
    this.pinSlotEl = document.createElement('div');
    this.pinSlotEl.className = 'acp-harness__lane-rail__slot';
    this.pinSlotEl.dataset.slot = 'pins';
    this.pinSlotEl.hidden = true;
    this.laneRailEl.appendChild(this.pinSlotEl);
    this.planSlotEl = document.createElement('div');
    this.planSlotEl.className = 'acp-harness__lane-rail__slot';
    this.planSlotEl.dataset.slot = 'plan';
    this.planSlotEl.hidden = true;
    this.planSlotEl.appendChild(this.planEl);
    this.laneRailEl.appendChild(this.planSlotEl);
    this.peekSlotEl = document.createElement('div');
    this.peekSlotEl.className = 'acp-harness__lane-rail__slot';
    this.peekSlotEl.dataset.slot = 'peek';
    this.peekSlotEl.hidden = true;
    this.laneRailEl.appendChild(this.peekSlotEl);
    // spec 136: bottom-anchored slot for the ACTIVE lane's prompt queue. Shown
    // independently of the peek; CSS `margin-top: auto` pins it to the rail bottom.
    this.queueSlotEl = document.createElement('div');
    this.queueSlotEl.className = 'acp-harness__lane-rail__slot';
    this.queueSlotEl.dataset.slot = 'queue';
    this.queueSlotEl.hidden = true;
    this.laneRailEl.appendChild(this.queueSlotEl);

    this.pickerEl = document.createElement('aside');
    this.pickerEl.className = 'acp-harness__picker';
    this.pickerEl.hidden = true;
    body.appendChild(this.pickerEl);

    this.sessionPickerEl = document.createElement('aside');
    this.sessionPickerEl.className = 'acp-harness__session-picker';
    this.sessionPickerEl.hidden = true;
    body.appendChild(this.sessionPickerEl);

    this.directivePickerEl = document.createElement('aside');
    this.directivePickerEl.className = 'acp-harness__directive-picker';
    this.directivePickerEl.hidden = true;
    this.directivePickerEl.addEventListener('click', (event: MouseEvent) => {
      const target = event.target;
      if (!(target instanceof Element)) return;
      const row = target.closest<HTMLElement>('[data-directive-index]');
      if (!row) return;
      const idx = Number(row.dataset.directiveIndex);
      if (!Number.isInteger(idx)) return;
      this.directivePickerCursor = idx;
      this.handleDirectivePickerKey(new KeyboardEvent('keydown', { key: 'Enter' }));
    });
    body.appendChild(this.directivePickerEl);

    // spec 127: model picker (keyboard-only — j/k/↵/esc, no mouse handlers).
    this.modelPickerEl = document.createElement('aside');
    this.modelPickerEl.className = 'acp-harness__model-picker';
    this.modelPickerEl.hidden = true;
    body.appendChild(this.modelPickerEl);

    this.element.appendChild(body);

    const commandCenter = document.createElement('div');
    commandCenter.className = 'acp-harness__command-center';
    // spec 128: the open-count gauge lives in the global workspace footer, not
    // here — see renderTriageGaugeEl / WorkspaceFooter. Overlay opens via `;`.
    this.composerEl = document.createElement('div');
    this.composerEl.className = 'acp-harness__composer';
    this.composerEl.addEventListener('click', (e: MouseEvent) => {
      const target = e.target;
      if (!(target instanceof HTMLElement)) return;
      if (target.closest('[data-open-directive-picker]')) {
        e.preventDefault();
        void this.openDirectivePicker();
        return;
      }
      const button = target.closest<HTMLButtonElement>('[data-remove-staged-image]');
      if (!button) return;
      const lane = this.activeLane();
      if (!lane) return;
      const index = Number(button.dataset.removeStagedImage);
      if (!Number.isInteger(index)) return;
      e.preventDefault();
      this.removeStagedImage(lane, index);
    });
    commandCenter.appendChild(this.composerEl);
    this.element.appendChild(commandCenter);

    this.element.addEventListener('paste', (e: ClipboardEvent) => {
      if (this.helpOpen || this.memoryDrawerOpen) return;
      const lane = this.activeLane();
      if (!lane || lane.pendingPermissions.length > 0) return;
      const items = e.clipboardData?.items;
      if (items) {
        for (const item of Array.from(items)) {
          if (item.type.startsWith('image/')) {
            e.preventDefault();
            const file = item.getAsFile();
            if (file) this.stageImageFile(lane, file);
            return;
          }
        }
      }
      const text = e.clipboardData?.getData('text');
      if (!text) return;
      e.preventDefault();
      this.insertDraft(lane, text);
    });

    this.element.addEventListener('dragover', (e: DragEvent) => {
      if (!e.dataTransfer) return;
      const hasFile = Array.from(e.dataTransfer.items ?? []).some((i) => i.kind === 'file');
      if (!hasFile) return;
      e.preventDefault();
      this.element.classList.add('acp-harness--drag-over');
    });
    this.element.addEventListener('dragleave', (e: DragEvent) => {
      if (e.target === this.element) this.element.classList.remove('acp-harness--drag-over');
    });
    this.element.addEventListener('drop', (e: DragEvent) => {
      e.preventDefault();
      this.element.classList.remove('acp-harness--drag-over');
      const lane = this.activeLane();
      if (!lane || lane.pendingPermissions.length > 0) return;
      const files = e.dataTransfer?.files;
      if (!files) return;
      for (const file of Array.from(files)) {
        if (file.type.startsWith('image/')) {
          this.stageImageFile(lane, file);
          break;
        }
      }
    });
  }

  private async start(): Promise<void> {
    try {
      await this.initializeHarnessMemory();
    } catch (e) {
      this.harnessMemoryId = null;
      this.harnessMemoryPort = null;
      this.harnessMemoryWarning = errorText(e);
      this.memoryEntries = [];
    }

    // spec 141: join the cross-harness directory once the harness id is known.
    // No-op when memory init failed (no id). Removal is in dispose().
    this.registerWithDirectory();
    this.startTelemetryPublisher();

    try {
      const cfg = await loadConfig();
      this.laneModels = cfg.acp_harness?.lane_models ?? {};
    } catch {
      this.laneModels = {};
    }

    await this.refreshDirectives();

    try {
      this.pickerEntries = harnessBackends(await AcpClient.listBackends());
      this.systemRows = [
        ...(this.harnessMemoryWarning ? [`memory warning: ${this.harnessMemoryWarning}`] : []),
        'no lanes running',
        'press Cmd+P then + to add a lane',
      ];
    } catch (e) {
      this.systemRows = [
        ...(this.harnessMemoryWarning ? [`memory warning: ${this.harnessMemoryWarning}`] : []),
        `backend list failed: ${errorText(e)}`,
      ];
    }
    this.render();
    // On first open, let the user pick which ACP backend to start instead of
    // auto-creating a default lane. Falls back to the empty system rows (with
    // the "press Cmd+P then + to add a lane" hint) if no backends are installed.
    if (this.lanes.length === 0 && this.pickerEntries.length > 0) {
      this.pickerOpen = true;
      this.pickerCursor = 0;
      this.render();
    }
  }

  private async initializeHarnessMemory(): Promise<void> {
    const projectDir = this.projectDir || await invoke<string>('get_app_cwd').catch(() => null);
    // spec 141: persist the resolved fallback so the cwd the memory session runs
    // in is the same cwd the directory entry (registerWithDirectory, called right
    // after start) exposes to peer_list, and that refreshGitBranch / AcpClient.spawn
    // use. Without this, a view constructed with projectDir=null reports cwd:null to
    // cross-harness peers even though it actually resolved get_app_cwd here.
    this.projectDir = projectDir;
    const session = await invoke<HarnessMemorySession>('create_harness_memory', { projectDir });
    this.harnessMemoryId = session.harnessId;
    this.harnessMemoryPort = session.hookPort;
    this.harnessMemoryWarning = null;
    // spec 185: publish the built-in command manifest for GET /commands.json.
    // Compile-time data, identical for every harness — a one-shot push into the
    // hook server's single global slot; failure only degrades the /commands page.
    try {
      await invoke('acp_store_command_manifest', { manifest: buildCommandManifest() });
    } catch (e) {
      console.warn('[acp-harness] store command manifest failed:', e);
    }
    try {
      await gcJunieMcpOverlays(session.harnessId);
    } catch (e) {
      console.warn('[acp-harness] gc junie mcp overlays failed:', e);
    }
    try {
      await gcClineMcpOverlays(session.harnessId);
    } catch (e) {
      console.warn('[acp-harness] gc cline mcp overlays failed:', e);
    }
    this.memoryUnlisten = await listen<{ harnessId: string }>('acp-harness-memory-changed', (event) => {
      if (event.payload.harnessId === this.harnessMemoryId) void this.refreshMemory();
    });
    this.mcpUnlisten = await listen<{ harnessId: string; laneLabel: string }>('acp-harness-mcp-touched', (event) => {
      if (event.payload.harnessId === this.harnessMemoryId) void this.refreshMcpStats();
    });
    this.artifactUnlisten = await listen<ArtifactEventPayload>('acp-harness-artifact', (event) => {
      if (event.payload.harnessId === this.harnessMemoryId) this.handleArtifactEvent(event.payload);
    });
    await this.refreshMemory();
    await this.refreshMcpStats();
    await this.refreshArtifacts();
    await this.refreshIssueBindings();
    await this.refreshActiveTicket();
  }

  // ─── spec 178: GitHub issue fixing ────────────────────────────────────────

  /** Rehydrate persisted issue bindings on register. After a Krypton restart the
   *  lanes they reference are gone, so their snapshots report `stopped` — the card
   *  still renders the last persisted phase/PR and offers re-dispatch. */
  private async refreshIssueBindings(): Promise<void> {
    if (!this.harnessMemoryId) return;
    try {
      const rows = await invoke<IssueBinding[]>('acp_load_issue_bindings', {
        harnessId: this.harnessMemoryId,
      });
      for (const row of rows) this.issueBindings.set(row.issueKey, row);
    } catch (e) {
      console.warn('[acp-harness] refreshIssueBindings failed:', e);
    }
  }

  private persistIssueBindings(): void {
    if (!this.harnessMemoryId) return;
    void invoke('acp_save_issue_bindings', {
      harnessId: this.harnessMemoryId,
      bindings: Array.from(this.issueBindings.values()),
    }).catch((e) => console.warn('[acp-harness] persistIssueBindings failed:', e));
  }

  /** Parse a GitHub issue reference: a full issue URL or `owner/repo#123`. */
  private parseIssueRef(input: string): { repo: string; number: number; url: string } | null {
    const s = input.trim();
    const build = (repo: string, raw: string): { repo: string; number: number; url: string } | null => {
      const number = Number(raw);
      // Reject zero / negatives: a positive integer issue number, like the
      // extension's parseIssueRef, so the two free-text parsers validate alike.
      if (!Number.isInteger(number) || number <= 0) return null;
      return { repo, number, url: `https://github.com/${repo}/issues/${number}` };
    };
    const m = s.match(/github\.com\/([^/\s]+\/[^/\s]+)\/issues\/(\d+)/i);
    if (m) return build(m[1], m[2]);
    const m2 = s.match(/^([\w.-]+\/[\w.-]+)#(\d+)$/);
    if (m2) return build(m2[1], m2[2]);
    return null;
  }

  /** Fetch issue title/body via the local `gh` CLI. Returns null when `gh` is
   *  missing/unauthed — the caller falls back to letting the lane fetch it. */
  private async fetchIssueMeta(
    repo: string,
    issueNumber: number,
  ): Promise<{ title?: string; body?: string } | null> {
    try {
      const raw = await invoke<string>('run_command', {
        program: 'gh',
        args: ['issue', 'view', String(issueNumber), '-R', repo, '--json', 'title,body'],
        cwd: this.projectDir ?? undefined,
      });
      return JSON.parse(raw) as { title?: string; body?: string };
    } catch (e) {
      console.warn('[acp-harness] gh issue view failed (falling back to URL-only):', e);
      return null;
    }
  }

  // ─── spec 194: shared working ticket ───────────────────────────────────────

  /** Rehydrate the persisted working ticket on register (survives restart). */
  private async refreshActiveTicket(): Promise<void> {
    if (!this.harnessMemoryId) return;
    try {
      const stored = await invoke<ActiveWorkTicket | null>('acp_load_active_ticket', {
        harnessId: this.harnessMemoryId,
      });
      if (stored && typeof stored.issueKey === 'string') this.activeTicket = stored;
    } catch (e) {
      console.warn('[acp-harness] refreshActiveTicket failed:', e);
    }
  }

  private persistActiveTicket(): void {
    if (!this.harnessMemoryId) return;
    void invoke('acp_save_active_ticket', {
      harnessId: this.harnessMemoryId,
      ticket: this.activeTicket,
    }).catch((e) => console.warn('[acp-harness] persistActiveTicket failed:', e));
  }

  /** Set (or refresh) the working ticket from a parsed ref. Re-pointing at the
   *  SAME issue bumps `revision` and keeps the last snapshot until the background
   *  `gh` enrich lands — the chip and pin never gate on the fetch. Never touches
   *  issue bindings: a ticket is context, not an assignment (spec 194). */
  private setActiveTicket(ref: { repo: string; number: number; url: string }): void {
    const issueKey = `${ref.repo}#${ref.number}`;
    const prev = this.activeTicket;
    const same = prev !== null && prev.issueKey === issueKey;
    const ticket: ActiveWorkTicket = {
      issueKey,
      issueUrl: ref.url,
      repo: ref.repo,
      number: ref.number,
      title: same ? prev.title : issueKey,
      state: same ? prev.state : undefined,
      labels: same ? prev.labels : undefined,
      fetchedAt: Date.now(),
      sourceUpdatedAt: same ? prev.sourceUpdatedAt : undefined,
      revision: same ? prev.revision + 1 : 1,
    };
    this.activeTicket = ticket;
    this.persistActiveTicket();
    this.flashChip(`ticket ${same ? 'refreshed' : 'set'} → ${issueKey} (r${ticket.revision})`);
    this.render();
    void this.enrichActiveTicket(ticket);
  }

  /** Background `gh` enrich for the pin/chip: title, state, labels, updatedAt.
   *  Drops the result when the ticket was replaced or cleared mid-fetch. */
  private async enrichActiveTicket(ticket: ActiveWorkTicket): Promise<void> {
    try {
      const raw = await invoke<string>('run_command', {
        program: 'gh',
        args: ['issue', 'view', String(ticket.number), '-R', ticket.repo, '--json', 'title,state,labels,updatedAt'],
        cwd: this.projectDir ?? undefined,
      });
      const meta = JSON.parse(raw) as {
        title?: string;
        state?: string;
        labels?: { name: string }[];
        updatedAt?: string;
      };
      if (this.activeTicket !== ticket) return;
      const title = meta.title?.trim();
      if (title) ticket.title = title;
      ticket.state = meta.state?.toLowerCase() === 'closed' ? 'closed' : 'open';
      ticket.labels = (meta.labels ?? []).map((l) => l.name);
      ticket.sourceUpdatedAt = meta.updatedAt;
      ticket.fetchedAt = Date.now();
      this.persistActiveTicket();
      this.render();
    } catch (e) {
      console.warn('[acp-harness] ticket gh enrich failed (URL-only ticket):', e);
    }
  }

  private clearActiveTicket(): void {
    if (!this.activeTicket) {
      this.flashChip('no working ticket set');
      return;
    }
    const key = this.activeTicket.issueKey;
    this.activeTicket = null;
    this.persistActiveTicket();
    this.flashChip(`ticket cleared (${key})`);
    this.render();
  }

  /** spec 194: `#ticket [<ref> | refresh | clear]` — manage the shared ticket. */
  private async runTicketCommand(args: string[]): Promise<void> {
    const sub = args[0];
    if (!sub) {
      await this.openTicketPicker();
      return;
    }
    if (sub === 'clear') {
      this.clearActiveTicket();
      return;
    }
    if (sub === 'refresh') {
      const t = this.activeTicket;
      if (!t) {
        this.flashChip('no working ticket set - #ticket to pick one');
        return;
      }
      this.setActiveTicket({ repo: t.repo, number: t.number, url: t.issueUrl });
      return;
    }
    const ref = this.parseIssueRef(args.join(' '));
    if (!ref) {
      this.flashChip('usage: #ticket [<issue url | owner/repo#123> | refresh | clear]');
      return;
    }
    this.setActiveTicket(ref);
  }

  /** Open the `#ticket` picker over the harness repo's open issues. Read-only
   *  toward GitHub — the picker never comments, labels, or assigns. The repo is
   *  resolved by `gh` from the git remote of `projectDir`; each row's `url`
   *  carries the canonical owner/repo for selection. */
  private async openTicketPicker(): Promise<void> {
    this.flashChip('fetching issues…');
    try {
      const raw = await invoke<string>('run_command', {
        program: 'gh',
        args: ['issue', 'list', '--json', 'number,title,labels,state,updatedAt,url', '--limit', '50'],
        cwd: this.projectDir ?? undefined,
      });
      const parsed = JSON.parse(raw) as {
        number: number;
        title?: string;
        labels?: { name: string }[];
        state?: string;
        updatedAt?: string;
        url?: string;
      }[];
      const rows: TicketPickerRow[] = parsed
        .filter((r) => typeof r.number === 'number' && typeof r.url === 'string')
        .map((r) => ({
          number: r.number,
          title: r.title?.trim() ?? `#${r.number}`,
          labels: (r.labels ?? []).map((l) => l.name),
          state: r.state?.toLowerCase() === 'closed' ? 'closed' : 'open',
          updatedAt: r.updatedAt,
          url: r.url as string,
        }));
      if (rows.length === 0) {
        this.flashChip('no open issues');
        return;
      }
      this.ticketPicker = { rows, filter: '', index: 0 };
      this.renderTicketOverlayEl();
    } catch (e) {
      this.flashChip(`gh issue list failed: ${errorText(e)}`);
    }
  }

  private ticketPickerMatches(): TicketPickerRow[] {
    const picker = this.ticketPicker;
    if (!picker) return [];
    const filter = picker.filter.trim().toLowerCase();
    if (!filter) return picker.rows;
    return picker.rows.filter((r) =>
      `#${r.number} ${r.title} ${r.labels.join(' ')}`.toLowerCase().includes(filter),
    );
  }

  /** Modal-dialog key handling while the ticket picker is open: printable keys
   *  build the filter, ↑↓/⌃n⌃p move, Enter selects, Esc dismisses. Unclaimed
   *  combos fall through so app-level shortcuts keep working. */
  private handleTicketPickerKey(e: KeyboardEvent): boolean {
    const picker = this.ticketPicker;
    if (!picker) return false;
    const matches = this.ticketPickerMatches();
    if (e.key === 'Escape') {
      e.preventDefault();
      this.ticketPicker = null;
      this.renderTicketOverlayEl();
      return true;
    }
    if (e.key === 'ArrowDown' || (e.ctrlKey && (e.key === 'n' || e.key === 'N'))) {
      e.preventDefault();
      if (matches.length > 0) picker.index = (picker.index + 1) % matches.length;
      this.renderTicketOverlayEl();
      return true;
    }
    if (e.key === 'ArrowUp' || (e.ctrlKey && (e.key === 'p' || e.key === 'P'))) {
      e.preventDefault();
      if (matches.length > 0) picker.index = (picker.index - 1 + matches.length) % matches.length;
      this.renderTicketOverlayEl();
      return true;
    }
    if (e.key === 'Enter') {
      e.preventDefault();
      const row = matches[Math.max(0, Math.min(picker.index, matches.length - 1))];
      this.ticketPicker = null;
      this.renderTicketOverlayEl();
      if (row) {
        const ref = this.parseIssueRef(row.url);
        if (ref) this.setActiveTicket(ref);
        else this.flashChip(`could not parse issue url: ${row.url}`);
      }
      return true;
    }
    if (e.key === 'Backspace') {
      e.preventDefault();
      picker.filter = picker.filter.slice(0, -1);
      picker.index = 0;
      this.renderTicketOverlayEl();
      return true;
    }
    if (e.key.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey) {
      e.preventDefault();
      picker.filter += e.key;
      picker.index = 0;
      this.renderTicketOverlayEl();
      return true;
    }
    return false;
  }

  /** spec 194: insert the working-ticket pin right after the goal line (or the
   *  identity line when no goal) — same head-placement rationale as spec 148:
   *  shared scope must not be buried under the tool-discoverability blocks. */
  private insertTicketPin(lines: string[], lane: HarnessLane): void {
    if (!this.activeTicket) return;
    lines.splice(lane.goal ? 2 : 1, 0, renderActiveTicketPin(this.activeTicket));
  }

  /** spec 190: self-register a binding for a lane reporting progress on an issue it
   *  picked up directly (no prior dispatchIssue). Mirrors dispatchIssue's binding
   *  creation but never spawns/targets a lane or sends a fix prompt — the lane is
   *  already working. Returns null on an unparseable issue_key. Title is enriched
   *  via `gh` in the background so the ok reply is never gated on the fetch. */
  private autoBindIssue(lane: HarnessLane, issueKey: string): IssueBinding | null {
    const ref = this.parseIssueRef(issueKey);
    if (!ref || !this.harnessMemoryId) return null;
    // Canonicalize: bind under `owner/repo#123` even if the lane reported a URL, so the
    // key/value match dispatchIssue and every status/browser surface (which expect it).
    const canonicalKey = `${ref.repo}#${ref.number}`;
    const now = Date.now();
    const placeholderGoal = `Fix #${ref.number}`;
    const binding: IssueBinding = {
      issueKey: canonicalKey,
      issueUrl: ref.url,
      repo: ref.repo,
      number: ref.number,
      title: canonicalKey, // enriched below, in the background
      harnessId: this.harnessMemoryId,
      laneId: lane.id,
      laneDisplayName: lane.displayName,
      dispatchedAt: now,
      updatedAt: now,
    };
    this.issueBindings.set(canonicalKey, binding);
    // Don't clobber a user/agent-set goal — only surface the issue if there's none.
    if (!lane.goal) lane.goal = { text: placeholderGoal, setAt: now };
    this.persistIssueBindings();
    this.publishIssueStatus(binding);
    // Background enrich: fetch the title, then re-publish + refine the goal chip.
    void this.fetchIssueMeta(ref.repo, ref.number).then((meta) => {
      const t = meta?.title?.trim();
      if (!t || this.issueBindings.get(canonicalKey) !== binding) return;
      binding.title = t;
      if (lane.goal && lane.goal.text === placeholderGoal) {
        lane.goal = { text: `Fix #${ref.number}: ${t}`.slice(0, 200), setAt: binding.dispatchedAt };
      }
      this.persistIssueBindings();
      this.publishIssueStatus(binding);
      this.render();
    });
    return binding;
  }

  /** The single convergence point for "fix this issue", called by every surface
   *  (Krypton palette / #dispatch-github-issue, and the github.dispatch-issue control op). */
  private async dispatchIssue(args: {
    issueKey: string;
    issueUrl: string;
    repo: string;
    number: number;
    title?: string;
    body?: string;
    targetLane?: string | null;
    prompt?: string;
  }): Promise<{ harnessId: string; lane: string; issueKey: string }> {
    if (!this.harnessMemoryId) throw controlError('control_failed', 'harness memory not ready');
    // Dedupe: if the issue is already bound to a live lane, focus it instead of
    // spawning a duplicate. A stale binding (lane gone) is dropped + re-dispatched.
    const existing = this.issueBindings.get(args.issueKey);
    if (existing) {
      const live = this.lanes.find((l) => l.id === existing.laneId && l.status !== 'stopped');
      if (live) {
        this.activateLane(live.id);
        return { harnessId: this.harnessMemoryId, lane: live.displayName, issueKey: args.issueKey };
      }
      this.issueBindings.delete(args.issueKey);
    }
    // Resolve metadata here so every caller (control op, #dispatch-github-issue, palette) shares
    // ONE fetch site + ONE fallback policy: fetch via `gh` only when title is absent.
    let title = args.title?.trim() ?? '';
    let body = args.body;
    if (!title) {
      const meta = await this.fetchIssueMeta(args.repo, args.number);
      title = meta?.title?.trim() || args.issueKey;
      if (body == null) body = meta?.body;
    }
    // Choose the lane: a named existing lane, or a fresh dedicated one (default).
    let lane: HarnessLane;
    const want = args.targetLane && args.targetLane !== '__new__' ? args.targetLane : null;
    if (want) {
      const found = this.lanes.find((l) => l.displayName === want);
      if (!found) throw controlError('unknown_lane', `unknown lane: ${want}`);
      lane = found;
      // Refuse before mutating state if we can neither send nor queue — otherwise
      // the card would show "bound/working" while the lane never receives the task.
      if (lane.status !== 'idle' && lane.queuedPrompts.length >= PROMPT_QUEUE_MAX) {
        throw controlError('queue_full', `${lane.displayName} prompt queue is full`);
      }
    } else {
      const backendId = this.activeLane()?.backendId ?? this.pickerEntries[0]?.id;
      if (!backendId) throw controlError('control_failed', 'no backend available to spawn a lane');
      const before = new Set(this.lanes.map((l) => l.id));
      await this.addLane(backendId);
      lane = this.lanes.find((l) => !before.has(l.id)) ?? this.lanes[this.lanes.length - 1];
    }
    const now = Date.now();
    const binding: IssueBinding = {
      issueKey: args.issueKey,
      issueUrl: args.issueUrl,
      repo: args.repo,
      number: args.number,
      title,
      harnessId: this.harnessMemoryId,
      laneId: lane.id,
      laneDisplayName: lane.displayName,
      dispatchedAt: now,
      updatedAt: now,
    };
    this.issueBindings.set(args.issueKey, binding);
    // The lane badge rides the existing goal chip (spec 148) — set it directly so
    // a freshly-spawned lane shows the issue without a session respawn.
    lane.goal = { text: `Fix #${args.number}: ${title}`.slice(0, 200), setAt: now };
    this.persistIssueBindings();
    this.publishIssueStatus(binding);
    const prompt = args.prompt?.trim() || issueFixPrompt(binding, body);
    if (lane.status === 'idle') {
      void this.sendUserPrompt(lane, prompt, [], { clearDraft: false });
    } else {
      // A just-spawned lane is 'starting' — queue; the queue drains on first idle.
      // Capacity was checked above for the existing-lane path; a fresh lane is empty.
      lane.queuedPrompts.push({ text: prompt, images: [], mentionTargets: [] });
    }
    this.render();
    return { harnessId: this.harnessMemoryId, lane: lane.displayName, issueKey: args.issueKey };
  }

  private issueStatusSnapshot(issueKey: string): IssueStatusSnapshot {
    const binding = this.issueBindings.get(issueKey);
    if (!binding) return { bound: false };
    const lane = this.lanes.find((l) => l.id === binding.laneId);
    const lastMessage = lane
      ? [...lane.transcript].reverse().find((t) => t.kind === 'assistant')?.text
      : undefined;
    const attention = lane
      ? this.triageStore.openItems().filter((i) => i.laneId === lane.id).length
      : 0;
    return {
      bound: true,
      binding,
      laneStatus: lane ? lane.status : 'stopped',
      lastMessage: lastMessage ? truncate(lastMessage.replace(/\s+/g, ' ').trim(), 160) : undefined,
      pendingPermissions: lane ? lane.pendingPermissions.length : 0,
      attention,
    };
  }

  private publishIssueStatus(binding: IssueBinding): void {
    if (!this.harnessMemoryId) return;
    publishControlEvent({
      harnessId: this.harnessMemoryId,
      lane: binding.laneDisplayName,
      kind: 'issue_status',
      payload: this.issueStatusSnapshot(binding.issueKey),
    });
  }

  /** spec 173: replay the harness's disk-rehydrated artifacts into the mirror.
   *  Rehydration runs in `create_harness_memory` (Rust `register_harness`) before
   *  the `acp-harness-artifact` listener above is attached, so those init-time
   *  events are lost — we pull the entries here and feed them through the same
   *  `handleArtifactEvent` path. That populates `this.artifacts` (the gate the
   *  feedback listener checks) and raises a card under any matching live lane. */
  private async refreshArtifacts(): Promise<void> {
    if (!this.harnessMemoryId) return;
    try {
      const rows = await invoke<ArtifactEventPayload[]>('acp_list_harness_artifacts', {
        harnessId: this.harnessMemoryId,
      });
      for (const row of rows) this.handleArtifactEvent(row);
    } catch (e) {
      console.warn('[acp-harness] refreshArtifacts failed:', e);
    }
  }

  private async refreshGitBranch(): Promise<void> {
    const cwd = this.projectDir;
    this.gitBranch = null;
    this.gitBranchProjectDir = cwd;
    this.gitBranchLoading = Boolean(cwd);
    this.render();
    if (!cwd) {
      this.gitBranchLoading = false;
      return;
    }

    let branch: string | null = null;
    try {
      const rawBranch = await invoke<string>('run_command', {
        program: 'git',
        args: ['branch', '--show-current'],
        cwd,
      });
      branch = rawBranch.trim() || null;
      if (!branch) {
        const rawHead = await invoke<string>('run_command', {
          program: 'git',
          args: ['rev-parse', '--short', 'HEAD'],
          cwd,
        });
        const head = rawHead.trim();
        if (head) branch = `HEAD ${head}`;
      }
    } catch {
      branch = null;
    }

    if (this.gitBranchProjectDir !== cwd) return;
    this.gitBranch = branch;
    this.gitBranchLoading = false;
    this.render();
  }

  private async refreshMcpStats(): Promise<void> {
    if (!this.harnessMemoryId) return;
    try {
      const stats = await invoke<HarnessMcpLaneStats[]>('list_harness_mcp_stats', {
        harnessId: this.harnessMemoryId,
      });
      this.mcpStatsByLane.clear();
      for (const entry of stats) this.mcpStatsByLane.set(entry.laneLabel, entry);
      this.render();
    } catch {
      // ignore — stats are diagnostic only
    }
  }

  private async refreshMemory(): Promise<void> {
    if (!this.harnessMemoryId) return;
    try {
      this.memoryEntries = await invoke<HarnessMemoryEntry[]>('list_harness_memory', {
        harnessId: this.harnessMemoryId,
      });
      this.renderMemory();
      this.renderComposer();
    } catch (e) {
      this.flashChip(`memory unavailable: ${String(e)}`);
    }
  }

  private async refreshDirectives(): Promise<void> {
    try {
      const cfg = await getAcpHarnessConfig();
      this.directives = cfg.directives ?? [];
    } catch (e) {
      console.warn('[acp-harness] load directives failed:', e);
      this.directives = [];
    }
    // Drop bindings to directives that no longer exist (deleted on disk).
    // `pendingDirectiveChange` with `directiveId: null` is a deliberate clear
    // and must survive a refresh — only drop it when it targets a directive
    // that has disappeared.
    for (const lane of this.lanes) {
      if (lane.activeDirectiveId && !this.directiveById(lane.activeDirectiveId)) {
        lane.activeDirectiveId = null;
      }
      const pending = lane.pendingDirectiveChange;
      if (pending && pending.directiveId !== null && !this.directiveById(pending.directiveId)) {
        lane.pendingDirectiveChange = null;
      }
      const override = lane.turnDirectiveOverride;
      if (override && override.directiveId !== null && !this.directiveById(override.directiveId)) {
        lane.turnDirectiveOverride = null;
        lane.previousDirectiveId = null;
      }
      // spec 130: directive changes no longer grant/revoke attention tools, but
      // recomputing keeps legacy chip metadata and audit state coherent.
      this.refreshTriageEquip(lane);
    }
  }

  private directiveById(id: string | null): HarnessDirective | null {
    if (!id) return null;
    return this.directives.find((d) => d.id === id) ?? null;
  }

  /** The directive that will be injected on the lane's next prompt: a one-shot
   * next-turn override wins over the lane-scoped active directive. An override
   * with `directiveId: null` deliberately clears for the turn. */
  private effectiveDirective(lane: HarnessLane): HarnessDirective | null {
    const id = lane.turnDirectiveOverride
      ? lane.turnDirectiveOverride.directiveId
      : lane.activeDirectiveId;
    const directive = this.directiveById(id);
    return directive && directive.enabled ? directive : null;
  }

  /** True when a directive may be assigned to any lane. Directives are
   * backend-agnostic (spec 163), so assignability is just the enabled flag. */
  private directiveAssignable(directive: HarnessDirective): boolean {
    return directive.enabled;
  }

  private createLane(index: number, backendId: string, displayName: string): HarnessLane {
    const lane: HarnessLane = {
      ...LANE_DEFAULTS,
      id: `${backendId}-${index}`,
      index,
      backendId,
      displayName,
      accent: laneAccent(index),
      // Per-lane mutable containers — each lane needs fresh instances:
      pendingPermissions: [],
      pendingTurnExtractions: [],
      stagedImages: [],
      transcript: [{ id: makeId(), kind: 'system', text: `starting ${displayName}...` }],
      toolTranscriptIds: new Map(),
      toolCalls: new Map(),
      seenTranscriptIds: new Set(),
      availableCommands: [],
      modesById: new Map(),
      promptHistory: [],
      queuedPrompts: [],
    };
    // spec 130: every harness-memory-capable lane gets attention tools by
    // default; seed local audit counters at lane creation so silent turns count
    // from the first response.
    this.triageStore.equip(lane.id);
    return lane;
  }

  private async spawnLane(lane: HarnessLane): Promise<void> {
    const spawnEpoch = lane.spawnEpoch;
    this.setLaneStatus(lane, 'starting');
    lane.error = null;
    this.render();
    let client: AcpClient | null = null;
    try {
      let seedMcp = this.memoryServerForLane(lane);
      let junieMcpLocation: string | null = null;
      let clineMcpSettingsPath: string | null = null;
      if (lane.backendId === 'junie') {
        seedMcp = [];
        if (this.harnessMemoryId) {
          const overlayServers = await this.junieOverlayServersForLane(lane);
          junieMcpLocation = await writeJunieMcpOverlay(
            this.harnessMemoryId,
            lane.displayName,
            overlayServers,
          );
          lane.junieMcpOverlayDir = junieMcpLocation;
        }
      } else if (lane.backendId === 'cline') {
        // Cline advertises no `mcpCapabilities`, so `session/new` mcpServers are
        // dropped (verified cline 3.0.24). Deliver them through a per-lane
        // `cline_mcp_settings.json` pointed at by `CLINE_MCP_SETTINGS_PATH`.
        seedMcp = [];
        if (this.harnessMemoryId) {
          const overlayServers = await this.clineOverlayServersForLane(lane);
          clineMcpSettingsPath = await writeClineMcpOverlay(
            this.harnessMemoryId,
            lane.displayName,
            overlayServers,
          );
          lane.clineMcpOverlayDir = clineMcpSettingsPath;
        }
      } else if (lane.backendId === 'cursor') {
        // cursor-agent ignores `session/new` mcpServers (upstream regression);
        // deliver the harness memory server via native `<project>/.cursor/mcp.json`
        // + `cursor-agent mcp enable` instead (see prepareCursorMcp).
        seedMcp = [];
        if (this.harnessMemoryId && this.projectDir) {
          try {
            lane.cursorMcpNames = await prepareCursorMcp(
              this.projectDir,
              this.memoryServerForLane(lane),
            );
          } catch (e) {
            console.warn('[acp-harness] prepare cursor mcp failed:', e);
          }
        }
      }
      // Non-Junie: seed memory only; project `.mcp.json` is injected after `initialize`.
      client = await AcpClient.spawn(
        lane.backendId,
        this.projectDir,
        seedMcp,
        junieMcpLocation,
        clineMcpSettingsPath,
      );
      if (lane.spawnEpoch !== spawnEpoch) {
        await client.dispose();
        return;
      }
      lane.client = client;
      client.onEvent((event) => {
        if (lane.spawnEpoch !== spawnEpoch || lane.client !== client) return;
        this.onLaneEvent(lane, event);
      });
      const info: AgentInfo = await client.initialize(async (caps) => {
        return this.mcpServersForLane(lane, caps);
      });
      if (lane.spawnEpoch !== spawnEpoch || lane.client !== client) {
        await client.dispose();
        return;
      }
      lane.sessionId = info.session_id ?? null;
      this.configureLaneFromInfo(lane, info);
      this.setLaneStatus(lane, 'idle');
      this.appendTranscript(lane, 'system', `connected to ${lane.displayName}.`);
      if (this.harnessMemoryWarning) {
        this.appendTranscript(lane, 'system', `warning: harness memory unavailable: ${this.harnessMemoryWarning}`);
      }
    } catch (e) {
      if (lane.spawnEpoch !== spawnEpoch) {
        if (client) await client.dispose();
        return;
      }
      this.setLaneStatus(lane, 'error');
      lane.error = String(e);
      this.appendTranscript(lane, 'system', `error: ${String(e)}`);
    }
    this.render();
  }

  private async junieOverlayServersForLane(lane: HarnessLane): Promise<AcpMcpServerDescriptor[]> {
    const memoryServers = this.memoryServerForLane(lane);
    const projectServers = await loadProjectMcpServers(this.projectDir);
    if (projectServers.length === 0) return memoryServers;
    const gated = filterByCapability(projectServers, JUNIE_MCP_CAPABILITIES);
    return dedupeByName(gated, memoryServers);
  }

  private async clineOverlayServersForLane(lane: HarnessLane): Promise<AcpMcpServerDescriptor[]> {
    // Cline's native config reads stdio/sse/streamableHttp directly, so no ACP
    // capability gating is needed — forward the per-lane memory server plus the
    // project `.mcp.json` bridge (spec 83) as-is.
    const memoryServers = this.memoryServerForLane(lane);
    const projectServers = await loadProjectMcpServers(this.projectDir);
    if (projectServers.length === 0) return memoryServers;
    return dedupeByName(projectServers, memoryServers);
  }

  private memoryServerForLane(lane: HarnessLane): AcpMcpServerDescriptor[] {
    // Pi has no MCP host — emit nothing rather than ship an unreachable URL.
    if (lane.backendId === 'pi-acp') return [];
    if (!this.harnessMemoryId || !this.harnessMemoryPort) return [];
    const harness = encodeURIComponent(this.harnessMemoryId);
    const laneLabel = encodeURIComponent(lane.displayName);
    return [{
      name: 'krypton-harness-memory',
      type: 'http',
      url: `http://127.0.0.1:${this.harnessMemoryPort}/mcp/harness/${harness}/lane/${laneLabel}`,
      headers: [],
    }];
  }

  private async mcpServersForLane(lane: HarnessLane, caps: unknown): Promise<AcpMcpServerDescriptor[] | undefined> {
    const memoryServers = this.memoryServerForLane(lane);
    // Claude Code's adapter loads `.mcp.json` natively — re-injecting via
    // ACP would duplicate every entry. Pi has no MCP host at all (by design),
    // so the bridge has nowhere to land for Pi-1.
    // Junie loads MCP via `--mcp-location` overlay; session/new mcpServers is a no-op.
    // Cline advertises no mcpCapabilities and drops session/new mcpServers; it
    // gets servers via a native `cline_mcp_settings.json` (CLINE_MCP_SETTINGS_PATH).
    // Cursor ignores session/new mcpServers entirely (upstream regression); it
    // gets the harness memory server via native `.cursor/mcp.json` at spawn time.
    // OMP native-loads root `.mcp.json` in ACP mode but still accepts injected
    // harness memory servers, so skip only the project bridge.
    if (
      lane.backendId === 'claude' ||
      lane.backendId === 'pi-acp' ||
      lane.backendId === 'junie' ||
      lane.backendId === 'cline' ||
      lane.backendId === 'cursor' ||
      lane.backendId === 'omp'
    ) {
      return lane.backendId === 'junie' ||
        lane.backendId === 'cline' ||
        lane.backendId === 'cursor'
        ? []
        : memoryServers;
    }
    const projectServers = await loadProjectMcpServers(this.projectDir);
    if (projectServers.length === 0) return memoryServers;
    const mcpCaps = (caps as { mcpCapabilities?: AcpMcpCapabilities } | null)?.mcpCapabilities;
    const gated = filterByCapability(projectServers, mcpCaps);
    return dedupeByName(gated, memoryServers);
  }

  private configureLaneFromInfo(lane: HarnessLane, info: AgentInfo | AgentInitInfo): void {
    lane.modelName = inferLaneModelName(lane.backendId, info, this.laneModels);
    // AgentInitInfo (resume/load path) carries no apply status — no model was
    // applied there, so it correctly falls back to false.
    lane.modelApplyFailed = (info as AgentInfo).model_apply_failed ?? false;
    // spec 127: agent-advertised model list + confirmed current id for the picker.
    // AgentInitInfo carries neither; the resume path overrides these from its own
    // AgentSessionInfo after this call.
    lane.availableModels = (info as AgentInfo).available_models ?? [];
    lane.currentModelId = (info as AgentInfo).current_model_id ?? null;
    lane.supportsEmbeddedContext = !!info.agent_capabilities?.promptCapabilities?.embeddedContext;
    lane.supportsImages = !!info.agent_capabilities?.promptCapabilities?.image;
    lane.modesById = new Map();
    const availableModes = (info.agent_capabilities as { availableModes?: unknown } | null)?.availableModes;
    if (Array.isArray(availableModes)) {
      for (const m of availableModes) {
        if (m && typeof m === 'object') {
          const mode = m as { id?: unknown; name?: unknown; description?: unknown };
          if (typeof mode.id === 'string') {
            lane.modesById.set(mode.id, {
              id: mode.id,
              name: typeof mode.name === 'string' ? mode.name : mode.id,
              description: typeof mode.description === 'string' ? mode.description : undefined,
            });
          }
        }
      }
    }
  }

  /** Forward a lane event to the control server's SSE subscribers (doc 175). */
  private publishStream(lane: HarnessLane, kind: ControlEventKind, payload: unknown): void {
    if (!this.harnessMemoryId) return;
    publishControlEvent({
      harnessId: this.harnessMemoryId,
      lane: lane.displayName,
      kind,
      payload,
    });
  }

  private onLaneEvent(lane: HarnessLane, event: AcpEvent): void {
    // Mirror every agent event to the control SSE stream (doc 175) before local
    // handling. The frontend stays the authority; this only forwards.
    this.publishStream(lane, event.type as ControlEventKind, event);
    let needsRender = true;
    switch (event.type) {
      case 'user_message_chunk':
        this.appendUserStreaming(lane, event.text);
        this.scheduleStreamingBodyOnly(lane);
        needsRender = false;
        break;
      case 'message_chunk':
        lane.activity = { kind: 'writing', label: '' };
        this.appendStreaming(lane, 'assistant', event.text);
        this.scheduleStreamingBodyOnly(lane);
        needsRender = false;
        break;
      case 'thought_chunk':
        lane.activity = { kind: 'thinking', label: '' };
        this.appendStreaming(lane, 'thought', event.text);
        this.scheduleStreamingBodyOnly(lane);
        needsRender = false;
        break;
      case 'tool_call':
        this.sealStreaming(lane);
        this.renderTool(lane, event.call);
        this.noteToolActivity(lane, event.call.toolCallId);
        break;
      case 'tool_call_update':
        this.renderTool(lane, event.update);
        this.noteToolActivity(lane, event.update.toolCallId);
        this.observeFileTouch(lane, event.update);
        if (isMemoryTool(event.update)) void this.refreshMemory();
        break;
      case 'plan':
        this.sealStreaming(lane);
        this.renderPlan(lane, event.entries);
        break;
      case 'permission_request':
        this.sealStreaming(lane);
        this.addPermission(lane, event.requestId, event.toolCall, event.options);
        break;
      case 'usage':
        lane.usage = mergeUsage(lane.usage, event.usage);
        break;
      case 'available_commands':
        lane.availableCommands = event.commands;
        if (lane.slashPaletteIndex >= event.commands.length) lane.slashPaletteIndex = 0;
        this.renderComposer();
        needsRender = false;
        break;
      case 'mode_update': {
        const known = lane.modesById.get(event.modeId);
        lane.currentMode = known ?? { id: event.modeId, name: event.modeId };
        // spec 127 (Codex-1 #4/#5): a live model switch can make the adapter clamp
        // the mode to a supported one (e.g. `auto` → `default` on Haiku), emitting
        // this update. Attribute it to the in-flight switch (token-gated, not a
        // wall-clock window) and surface the downgrade so it isn't silent.
        const pending = lane.pendingModelSwitch;
        if (pending && pending.prevModeId && event.modeId !== pending.prevModeId) {
          this.appendTranscript(
            lane,
            'system',
            `model switch: mode downgraded to "${lane.currentMode.name}" — "${pending.pickedName}" does not support "${pending.prevModeId}"`,
          );
        }
        this.refreshMetricsRender();
        // The mode chip lives in the lane header, not the metrics panel — leave
        // needsRender true so the lane re-renders and the chip refreshes
        // (previously this set needsRender=false and only refreshed metrics, so
        // the header chip went stale).
        break;
      }
      case 'fs_activity':
        this.appendFsActivity(lane, event.method, event.path, event.ok, event.error);
        break;
      case 'fs_write_pending':
        this.appendFsWriteReview(lane, event.requestId, event.path, event.oldText, event.newText);
        break;
      case 'provider_error':
        this.sealStreaming(lane);
        this.appendProviderError(lane, event.payload);
        break;
      case 'stop':
        this.finishTurn(lane, event.stopReason, event.reason);
        void this.refreshMemory();
        break;
      case 'error':
        // Seal any in-flight streaming row first so its --streaming class and
        // pretext-deferred state get a clean signature transition. Without
        // this, a thought/assistant/user row that was streaming when the
        // error arrived keeps currentThoughtId/AssistantId/UserId set and
        // stays in native-wrap (no pretext layout) until the next prompt.
        this.sealStreaming(lane);
        this.setLaneStatus(lane, 'error');
        lane.error = event.message;
        lane.activeTurnStartedAt = null;
        lane.activity = null;
        lane.pendingTurnExtractions = [];
        lane.pendingPermissions = [];
        lane.acceptAllForTurn = false;
        lane.rejectAllForTurn = false;
        lane.peerAutoAcceptForTurn = false;
        this.updateComposerTick();
        this.appendClassifiedError(lane, event.message, `error: ${event.message}`);
        break;
    }
    if (needsRender) this.scheduleLaneRender(lane);
  }

  /** spec 156: stamp the busy-chip activity from the merged tool record (after
   *  renderTool has cached it). Terminal updates are skipped, so a finished
   *  tool's label simply lingers until the next chunk or tool call replaces
   *  it — no completion bookkeeping. */
  private noteToolActivity(lane: HarnessLane, toolCallId: string | undefined): void {
    if (!toolCallId) return;
    const merged = lane.toolCalls.get(toolCallId);
    if (!merged || (merged.status && isTerminalToolStatus(merged.status))) return;
    lane.activity = { kind: 'tool', label: merged.title ?? merged.kind ?? 'tool' };
  }

  private async submitActiveLane(): Promise<void> {
    const lane = this.activeLane();
    if (!lane) return;
    const text = lane.draft.trim();
    const hasImages = lane.stagedImages.length > 0;
    if (!text && !hasImages) return;
    if (text && text !== lane.promptHistory[lane.promptHistory.length - 1]) {
      lane.promptHistory.push(text);
      if (lane.promptHistory.length > 100) lane.promptHistory.shift();
    }
    lane.historyIndex = null;
    lane.historySavedDraft = null;
    const images = lane.stagedImages.slice();
    // The composer owns its draft/staged-image lifecycle; submitLanePrompt clears
    // them at the right moment via this callback (a `#` command returns before it
    // fires, preserving the composer's existing "leave the draft" behavior there).
    await this.submitLanePrompt(lane, text, images, () => {
      this.setDraft(lane, '', 0);
      lane.stagedImages = [];
    });
  }

  /**
   * spec 136/182: route + send a user prompt to `lane` — the shared tail of the
   * lane composer (`submitActiveLane`) and the orchestrator console seat prompt
   * (spec 182). Handles `#`-commands, `!`-shell, the not-ready guard, the
   * busy-queue, and the mention-aware send identically for both. `clearComposer`
   * (optional) lets a composer caller clear its draft/staged images at the right
   * moment; the console passes nothing (it has no composer draft).
   */
  private async submitLanePrompt(
    lane: HarnessLane,
    text: string,
    images: StagedImage[],
    clearComposer?: () => void,
  ): Promise<void> {
    if (text.startsWith('#')) {
      await this.runHashCommand(lane, text);
      return;
    }
    if (text.startsWith('!')) {
      const command = text.slice(1).trim();
      clearComposer?.();
      this.render();
      if (!command) {
        this.flashChip('empty shell command');
        return;
      }
      await this.runShellCommand(lane, command);
      return;
    }
    if (!lane.client || lane.status === 'starting' || lane.status === 'error' || lane.status === 'stopped') {
      this.flashChip(`lane ${lane.status}`);
      return;
    }
    // spec 191: inline verb injection — a free-form user prompt may embed a verb as
    // a `{{#verb}}` token at ANY position; expand each to its rendered prompt (same
    // registry + resolver as composed verbs) before the prompt is queued or sent, so
    // the lane receives one combined prompt. Bad token → flash + abort, never send a
    // half-expanded prompt. Expanding here (once) means a queued prompt stores the
    // resolved text and the drain path sends it verbatim.
    if (hasVerbTokens(text)) {
      try {
        text = resolveVerbTokens(text, injectableVerbPrompt);
      } catch (e) {
        this.flashChip(errorText(e));
        return;
      }
    }
    if (lane.status === 'busy' || lane.status === 'needs_permission') {
      // spec 136: queue the prompt instead of discarding it — it drains on the
      // next idle transition. Capture text + a frozen image snapshot + resolved
      // mention targets, then clear the composer so the user can type the next.
      if (lane.queuedPrompts.length >= PROMPT_QUEUE_MAX) {
        this.flashChip(`queue full (${PROMPT_QUEUE_MAX})`);
        return;
      }
      const queuedImages = images.map((img) => Object.freeze({ ...img }) as StagedImage);
      lane.queuedPrompts.push({
        text,
        images: queuedImages,
        mentionTargets: this.resolveMentionTargets(text, lane),
      });
      clearComposer?.();
      this.flashChip(`queued (${lane.queuedPrompts.length})`);
      this.render();
      return;
    }
    clearComposer?.();
    await this.sendUserPrompt(lane, text, images);
  }

  /**
   * spec 136: dispatch a user prompt to the agent — the back half of the old
   * submitActiveLane, shared by the immediate composer submit and the queued
   * drain. Does NOT clear the live draft / staged images itself (callers own
   * that), so draining a queued prompt never wipes a draft the user is typing.
   * Returns { handled, delivered }: handled=false only when the lane has no
   * client; delivered=false when a mention fan-out consumed the prompt without
   * starting a turn (the lane stays idle — maybeDrainPromptQueue re-arms on that).
   */
  private async sendUserPrompt(
    lane: HarnessLane,
    text: string,
    images: StagedImage[],
    opts?: { clearDraft?: boolean },
  ): Promise<{ handled: boolean; delivered: boolean }> {
    if (!lane.client) return { handled: false, delivered: false };
    const mention = this.tryMentionFanOut(lane, text, images.length > 0, {
      clearDraftOnDeliver: opts?.clearDraft === true,
    });
    if (mention.handled) return mention;
    const userItem = this.appendTranscript(lane, 'user', text, { imageCount: images.length });
    lane.pendingUserEcho = { itemId: userItem.id, text, received: '' };
    this.setLaneStatus(lane, 'busy');
    lane.activeTurnStartedAt = Date.now();
    lane.pendingTurnExtractions = [];
    lane.currentAssistantId = null;
    lane.currentThoughtId = null;
    // spec 124: promote a deferred lane-scope assignment, then build blocks
    // (which read the effective directive), then consume any one-shot override.
    // The deferred change is a sentinel-safe object: a queued clear is
    // represented as `{ directiveId: null }`, not by a plain null on the field.
    if (lane.pendingDirectiveChange) {
      lane.activeDirectiveId = lane.pendingDirectiveChange.directiveId;
      lane.pendingDirectiveChange = null;
      this.refreshTriageEquip(lane); // spec 130: keep audit/default state coherent
    }
    const blocks = this.buildPromptBlocks(lane, text, images);
    if (lane.turnDirectiveOverride) {
      lane.turnDirectiveOverride = null;
      lane.previousDirectiveId = null;
    }
    this.updateComposerTick();
    this.render();
    try {
      await lane.client.prompt(blocks);
    } catch (e) {
      const message = String(e);
      this.sealStreaming(lane);
      // Reset this turn's pointers first, matching finishTurn — an errored (or
      // recovered) lane must not carry a stale active assistant/thought row
      // (Grok-1 R3 #1).
      lane.activeTurnStartedAt = null;
      lane.currentAssistantId = null;
      this.dropVeiledThoughtRow(lane);
      lane.currentThoughtId = null;
      const providerError = classifyProviderError(message);
      if (providerError) {
        // A classified provider fault came back as a JSON-RPC error *response* —
        // the agent subprocess answered, so the session is still alive.
        // markLaneProviderError owns the status decision: a retryable fault keeps
        // the lane usable (idle) so the user can resend in the same session; a
        // fatal one (auth/quota/context) flips it to error.
        this.appendProviderError(lane, providerError);
      } else {
        // Unclassifiable — genuine transport / subprocess death. The lane is gone;
        // flip it to error (only a restart recovers it).
        this.setLaneStatus(lane, 'error');
        lane.error = message;
        lane.pendingTurnExtractions = [];
        this.appendTranscript(lane, 'system', `prompt failed: ${message}`);
      }
      this.updateComposerTick();
      this.render();
      // Mirror finishTurn: if the lane recovered to idle, drain a queued prompt.
      if (lane.status === 'idle' && lane.queuedPrompts.length > 0) {
        queueMicrotask(() => this.maybeDrainPromptQueue(lane));
      }
    }
    return { handled: true, delivered: true };
  }

  /**
   * spec 136: drain at most one queued user prompt when the lane settles to idle.
   * Called (deferred) from finishTurn's tail. The status gate lets a synchronous
   * peer-mail drain win (it flips the lane back to busy before this runs). A
   * consumed-but-undelivered drain (a queued @mention whose target vanished)
   * leaves the lane idle, so re-arm the drain or the rest of the queue stalls.
   */
  private maybeDrainPromptQueue(lane: HarnessLane): void {
    if (lane.status !== 'idle') return; // busy (peer mail) / awaiting_peer / error / stopped → hold
    const next = lane.queuedPrompts.shift();
    if (!next) return;
    const reArm = (): void => {
      this.appendTranscript(lane, 'system', `queued prompt not sent: ${truncate(next.text, 80)}`);
      this.render();
      if (lane.status === 'idle' && lane.queuedPrompts.length > 0) {
        queueMicrotask(() => this.maybeDrainPromptQueue(lane));
      }
    };
    void this.sendUserPrompt(lane, next.text, next.images, { clearDraft: false })
      .then((r) => {
        if (r.delivered) return; // a turn started; the next finishTurn drains the rest
        if (r.handled) reArm();
        // r.handled === false means !lane.client (a dead lane) — not idle anyway,
        // so we neither re-arm nor discard the remaining queue here.
      })
      .catch((e) => {
        // sendUserPrompt is self-contained (client.prompt errors are caught inside
        // it), but guard defensively: a synchronous throw must not silently drop
        // the already-shifted item and stall the queue (Grok-1 R3 #3).
        console.warn('[acp-harness] queued drain failed', e);
        reArm();
      });
  }

  private handleSubmitError(error: unknown): void {
    const message = errorText(error);
    const lane = this.activeLane();
    console.warn('[AcpHarnessView] submit failed:', error);
    if (lane?.status === 'starting') {
      this.setLaneStatus(lane, 'error');
      lane.error = message;
      this.appendTranscript(lane, 'system', `command failed: ${message}`);
    }
    this.flashChip(message);
    this.render();
  }

  private buildPromptBlocks(lane: HarnessLane, userText: string, images: StagedImage[] = []): ContentBlock[] {
    const imageBlocks: ContentBlock[] = images.map((img) => ({
      type: 'image',
      data: img.data,
      mimeType: img.mimeType,
      ...(img.path ? { uri: pathToFileUri(img.path) } : {}),
    }));
    const userBlocks: ContentBlock[] = [];
    if (userText) userBlocks.push({ type: 'text', text: userText });
    const tail = [...imageBlocks, ...userBlocks];
    // spec 124: the directive block rides inside the SAME leading packet as the
    // lane-context stub so adapters that only honor the first resource/text
    // block still see both. Never emit the directive as a second block.
    const leading = this.composeLeadingContext(lane);
    if (!leading) return tail;
    if (lane.supportsEmbeddedContext) {
      return [
        {
          type: 'resource',
          resource: {
            uri: 'krypton://acp-harness/lane-context.md',
            mimeType: 'text/markdown',
            text: leading,
          },
        },
        ...tail,
      ];
    }
    return [
      { type: 'text', text: leading },
      ...tail,
    ];
  }

  /** Join the lane-context stub and the active directive into one block. */
  private composeLeadingContext(lane: HarnessLane): string {
    const packet = this.renderPromptMemoryPacket(lane);
    if (lane.pollyBuiltinRole) {
      const heading =
        lane.pollyBuiltinRole === 'orchestrator' ? '## Polly orchestrator' : '## Polly worker';
      const block = `${heading}\n${POLLY_ROLE_PROMPTS[lane.pollyBuiltinRole]}`;
      return packet ? `${packet}\n\n${block}` : block;
    }
    if (lane.debbyBuiltinRole) {
      const heading =
        lane.debbyBuiltinRole === 'orchestrator' ? '## Debby orchestrator' : '## Debby head';
      const block = `${heading}\n${DEBBY_ROLE_PROMPTS[lane.debbyBuiltinRole]}`;
      return packet ? `${packet}\n\n${block}` : block;
    }
    if (lane.saltyBuiltinRole) {
      const heading =
        lane.saltyBuiltinRole === 'orchestrator'
          ? '## Salty orchestrator'
          : `## Salty executor — ${lane.saltyBuiltinRole}`;
      const block = `${heading}\n${SALTY_ROLE_PROMPTS[lane.saltyBuiltinRole]}`;
      return packet ? `${packet}\n\n${block}` : block;
    }
    const directive = this.effectiveDirective(lane);
    if (!directive) return packet;
    const heading = directive.title.trim()
      ? `## Directive: ${directive.title.trim()}`
      : '## Directive';
    const block = `${heading}\n${directive.system_prompt.trim()}`;
    return packet ? `${packet}\n\n${block}` : block;
  }

  /** spec 148: insert the active-goal pin near the HEAD of a context packet (right
   *  after the identity line at index 0), not the tail. Called from BOTH return paths
   *  of renderPromptMemoryPacket so a lane without harness memory still carries its
   *  goal. Head placement keeps the goal prominent instead of buried under the
   *  memory/attention/artifact blocks, where it was treated as background and often
   *  ignored. Internal whitespace is collapsed to keep it a single line. */
  private insertGoalLine(lines: string[], lane: HarnessLane): void {
    const text = lane.goal?.text.replace(/\s+/g, ' ').trim();
    if (!text) return;
    lines.splice(
      1,
      0,
      `Active goal: ${text}. Stay scoped to this; if a turn pulls you off it, say so before continuing.`,
    );
  }

  private renderPromptMemoryPacket(lane: HarnessLane): string {
    const self = lane.displayName;
    const roster = this.lanes.map((l) => l.displayName).join(', ');
    const hasPeers = this.lanes.length > 1;
    const lines: string[] = [`You are lane ${self}. Lanes: ${roster}.`];
    if (!this.harnessMemoryId || !this.harnessMemoryPort) {
      lines.push('Shared Krypton memory is unavailable in this harness because the localhost hook server did not initialize. Continue without krypton-harness-memory MCP tools.');
      this.insertGoalLine(lines, lane);
      this.insertTicketPin(lines, lane);
      return lines.join('\n');
    }
    // Memory is intentionally NOT advertised here. Per the handoff-only decision,
    // handoff_set/handoff_get/handoff_list are the backing store for #handoff/#resume
    // ONLY — not an ambient shared scratchpad. Surfacing them every turn pushed
    // lanes to record/read state proactively, and a reader cannot tell a stale
    // snapshot from current truth (the cache-coherence hazard). The #handoff and
    // #resume prompts name the tools explicitly when the user invokes them, so the
    // model still reaches them at the right moment without a per-turn stub.
    if (hasPeers) {
      lines.push(
        'Inter-lane peering: when the user asks you to consult, ask, or peer with another lane, call peer_send { to_lane, message, done } (use the display name shown above; recipient processes on its next idle turn). Use peer_list to see live peer lanes and their inbox depths. End your turn after peer_send; the reply (if any) arrives as a new user message. Leave `done` false when sending a request — `done:true` silences the recipient and is only for closing the conversation after their reply. Never peer proactively. ' +
          PEER_SEND_DEFERRED_TOOL_HINT,
      );
    }
    // spec 130: attention tools are default-on for every harness-memory-capable
    // lane, but a lane only learns their exact names via ranked tool discovery —
    // which can drop attention_flag under a capped query. Name both tools here so
    // the model can target them directly instead of relying on search ranking.
    // spec 134: reframed to lead with positive, recognizable fork triggers and a
    // symmetric "don't let a genuine fork pass unflagged" calibration. The old
    // prohibition-first wording ("never flag the routine … never proactively")
    // had pushed flagging to near-zero; the single retained guard now trails the
    // triggers rather than dominating them. Mirrors the tool description.
    lines.push(
      'Attention triage: at the end of a turn where you hit a real fork — you picked among two or more genuinely viable approaches the user could reasonably decide differently on, you resolved a consequential ambiguity in their intent (one that changes the user-visible outcome, architecture, or workflow) by guessing, or you did something costly or hard to undo — surface ONE such decision to the human review queue with attention_flag { question, chosen, rationale, traded_off, uncertainty, reversibility }, then keep working (non-blocking; proceed with `chosen`). Calibrate in both directions: both a silent genuine fork and a trivia flag degrade the queue, so flag the consequential forks but skip the routine, reversible, machine-verifiable 80%, at most one per turn, and never flag just to cover yourself. Use attention_resolve { item_id } if you later settle it yourself. Write the free-text fields (question, chosen, rationale, traded_off, uncertainty) in Thai, for a human who is NOT reading the code: `question` names the real stake in plain language (not just an API or data-structure name), and `rationale` explains the consequence — why it matters — not only the technical mechanism; if a technical term is unavoidable, follow it with one plain sentence on its concrete impact.',
    );
    // spec 160: mark_review_priority is default-on for every harness-memory lane
    // (it triages a diff the lane wrote — relevant even for a solo lane), so name
    // it unconditionally for discoverability under a capped tool search, like the
    // attention tools. Purely advisory: the Window only folds/marks, never hides.
    lines.push(
      'Diff reading priority: at the end of a turn where you edited files, you MAY call mark_review_priority { ranges } to tell the human\'s Diff Window where to spend reading attention. Report only the non-default ranges — `high` for core logic / interface / risk to read first, `routine` for mechanical churn (generated code, renames, imports, formatting) — anchored on the NEW side (the post-change line numbers you wrote); each range may include an optional short `reason` explaining why it was marked. Everything you omit stays `normal` and renders in full. The Window only folds `routine` (always one keystroke from full) and marks/navigates `high`; it never hides or reorders, so a small honest report is right and silence yields the full diff. At most once per turn, only when you changed files.',
    );
    // spec 146: review_outcome is default-on but only used during a #review
    // round (which needs reviewer lanes), so name it for discoverability only
    // when peers exist. The #review prompt already instructs the call; this just
    // ensures the model can target the tool by name under a capped tool search.
    if (hasPeers) {
      lines.push(
        'Review quality matrix: after you synthesize a #review round (you convened reviewers and aggregated their Blockers/Warnings), call review_outcome { blockers, warnings, reviewer_count, subject_label } once to record a summary row for your own work. It stores the raw counts only — no score, no grade — so the human can observe the trend across rounds. Only call it for a real review you convened; never fabricate one.',
      );
    }
    // spec 133: discoverability only — the agent decides when an HTML artifact
    // beats prose. Opt-in, user-driven; never default to it.
    lines.push(
      'HTML artifacts: when the user asks for a visual or interactive view (side-by-side, diagram, annotated diff, dashboard), call artifact_new { title }. It returns a path to a file that ALREADY EXISTS — a styled scaffold (Binance dark theme + light/auto toggle); EDIT it with your normal edit tool (do not recreate it with Write) to replace the placeholder inside <main data-artifact-content>, then artifact_register { id }; the user opens it in their browser. Opt-in only — keep ordinary prose, plans, and answers in your turn text. Style rule: never color-code blocks with left accent borders (border-left rails) — use a full border, background tint, or heading color; the scaffold strips left-only borders at runtime.',
    );
    this.insertGoalLine(lines, lane);
    this.insertTicketPin(lines, lane);
    return lines.join('\n');
  }

  private finishTurn(lane: HarnessLane, stopReason: StopReason, reason?: string): void {
    this.sealStreaming(lane);
    if (stopReason === 'cancelled') {
      // `reason` is set only for harness-synthesized stops (e.g. the subprocess
      // exited mid-turn) — distinguish that from a user-initiated cancel so a
      // dead lane never reads as "cancelled without reason". The full crash
      // detail (stderr tail) arrives separately on the `prompt failed` line.
      this.appendTranscript(lane, 'system', reason ? `turn ended — ${reason}` : 'turn cancelled');
    }
    lane.pendingTurnExtractions = [];
    lane.pendingPermissions = [];
    lane.acceptAllForTurn = false;
    lane.rejectAllForTurn = false;
    lane.peerAutoAcceptForTurn = false;
    // Reset this turn's pointers BEFORE the status transition below. setLaneStatus
    // can synchronously drain queued peer mail (InterLaneCoordinator.onBus ->
    // enqueueSystemPrompt), which stamps the NEXT turn's activeTurnStartedAt /
    // currentAssistantId / pendingCoordinatorDrain before this method resumes.
    // Clearing them here — not at the tail — stops that re-entrant turn's state
    // from being clobbered (fixes back-to-back peer-turn provenance + elapsed UI).
    lane.activeTurnStartedAt = null;
    lane.activity = null;
    lane.currentAssistantId = null;
    lane.pendingUserEcho = null;
    this.dropVeiledThoughtRow(lane);
    lane.currentThoughtId = null;
    lane.pendingCoordinatorDrain = null;
    lane.coordinatorDrainProvenanceUsed = false;
    if (lane.error) {
      this.setLaneStatus(lane, 'error');
    } else {
      const suggested = this.coordinator.onLaneStop(lane.id);
      this.setLaneStatus(lane, suggested ?? 'idle');
    }
    // spec 128 silent-turn audit: a completed turn (busy→idle) that produced no
    // judgement item counts toward the lane's silent pile. The flagged case was
    // already counted by the store on insert.
    if (stopReason === 'end_turn' && !lane.error && lane.triageEquipped) {
      this.triageStore.recordTurnEnd(lane.id, lane.flaggedThisTurn);
      this.telemetryPublisher?.schedule();
      // The audit counters (shown in each card header) aren't a queue mutation,
      // so the store doesn't emit — refresh the overlay directly if it is open.
      if (this.triageOverlayOpen) this.renderTriageOverlayEl();
    }
    lane.flaggedThisTurn = false;
    // spec 133: a pending artifact carries a write grant and must not outlive
    // the turn — cancel any the lane created but never registered.
    this.cancelPendingArtifactsForLane(lane);
    this.updateComposerTick();
    if (stopReason !== 'end_turn' && stopReason !== 'cancelled') {
      this.appendTranscript(lane, 'system', `turn ended: ${stopReason}`);
    }
    if (lane.draft.trim() && lane.queuedPrompts.length === 0) {
      this.flashChip('lane idle - Enter to send');
    }
    // spec 136: drain one queued prompt on idle — deferred to a microtask so it
    // reads the settled status (a synchronous peer-mail drain above wins if any).
    if (lane.queuedPrompts.length > 0) {
      queueMicrotask(() => this.maybeDrainPromptQueue(lane));
    }
  }

  private observeFileTouch(lane: HarnessLane, call: ToolCall | ToolCallUpdate): void {
    const path = extractModifiedPath(call);
    if (path && call.status === 'completed') {
      this.fileTouchMap.set(path, {
        path,
        laneId: lane.id,
        laneDisplayName: lane.displayName,
        toolKind: call.kind === 'edit' ? 'edit' : 'write_like',
        at: Date.now(),
      });
    }
  }

  private addPermission(lane: HarnessLane, requestId: number, toolCall: ToolCall, options: PermissionOption[]): void {
    const permission: HarnessPermission = { requestId, toolCall, options };
    const payload = this.describePermission(lane, permission);
    const item = this.appendPermissionTranscript(lane, permission, payload);
    permission.transcriptItem = item;
    const harnessToolName = harnessAutoAllowToolName(permission);
    if (harnessToolName && pickPermissionOption(permission.options, 'accept')) {
      void this.resolveHarnessPermission(lane, permission, harnessToolName);
      return;
    }
    // spec 133: issued-path-only artifact write auto-approval — a SEPARATE
    // mechanism from the memory/peer server-marker detector. The write tool is a
    // backend-native filesystem tool, so we key off path + registry entry +
    // same lane, never the built-in-server marker.
    const artifactWrite = this.matchArtifactWriteForGrant(lane, toolCall);
    if (artifactWrite && pickPermissionOption(permission.options, 'accept')) {
      void this.resolveArtifactWritePermission(lane, permission, artifactWrite);
      return;
    }
    lane.pendingPermissions.push(permission);
    this.setLaneStatus(lane, 'needs_permission');
    // A second request while already paused does not transition status, so the
    // LaneBus emit the console relies on never fires — refresh it directly.
    this.refreshOrchestratorConsole();
    if (lane.permissionMode === 'bypass' || (lane.permissionMode === 'acceptEdits' && toolCall.kind === 'edit')) {
      void this.resolvePermission(lane, 'accept', true, `mode:${lane.permissionMode}`);
      return;
    }
    if (lane.acceptAllForTurn || lane.rejectAllForTurn) {
      void this.resolvePermission(lane, lane.rejectAllForTurn ? 'reject' : 'accept', true);
      return;
    }
    // spec 143: a peer-delegated turn auto-accepts non-high-risk requests; a
    // destructive/unparseable command falls through to the human permission gate.
    if (lane.peerAutoAcceptForTurn && !this.isHighRiskPermission(permission)) {
      void this.resolvePermission(lane, 'accept', true, 'peer-auto');
    }
  }

  /** spec 143: is this permission a high-risk command (destructive verb, dangerous
   *  git, or unparseable/script/network)? Non-command surfaces (edits, writes) are
   *  not gated here — fs writes are diff-shown + VCS-recoverable. Reuses the spec
   *  140 classifier so there is one source of truth. */
  private isHighRiskPermission(permission: HarnessPermission): boolean {
    return permissionCommandIsHighRisk(permission.toolCall);
  }

  private async resolvePermission(
    lane: HarnessLane,
    action: 'accept' | 'reject',
    auto: boolean,
    autoReason = 'auto-turn',
  ): Promise<void> {
    const permission = lane.pendingPermissions[0];
    if (!permission || !lane.client) return;
    const option = pickPermissionOption(permission.options, action);
    if (action === 'accept' && !option) {
      this.flashChip('no accept option');
      return;
    }
    lane.pendingPermissions.shift();
    const label = option?.name ?? (action === 'accept' ? 'accepted' : 'rejected');
    permission.resolvedLabel = `${action === 'accept' ? '✓' : '✗'} ${label}${auto ? ` (${autoReason})` : ''}`;
    permission.auto = auto;
    this.updatePermissionDecision(permission, action === 'accept' ? 'accepted' : 'rejected', permission.resolvedLabel);
    if (lane.pendingPermissions.length === 0 && lane.status === 'needs_permission') this.setLaneStatus(lane, 'busy');
    this.updateComposerTick();
    this.render();
    // The head shifted; when the queue is non-empty the status stays
    // `needs_permission` (no LaneBus emit), so refresh the console on the new head.
    this.refreshOrchestratorConsole();
    try {
      await lane.client.respondPermission(permission.requestId, option?.optionId ?? null);
    } catch (e) {
      lane.pendingPermissions.unshift(permission);
      this.setLaneStatus(lane, 'needs_permission');
      this.updatePermissionDecision(permission, 'failed', 'permission reply failed');
      this.appendTranscript(lane, 'system', `permission reply failed: ${String(e)}`);
      this.updateComposerTick();
      this.render();
      this.refreshOrchestratorConsole();
      return;
    }
    this.render();
  }

  private async resolveHarnessPermission(lane: HarnessLane, permission: HarnessPermission, toolName: string): Promise<void> {
    if (!lane.client) return;
    const option = pickPermissionOption(permission.options, 'accept');
    if (!option) return;
    const family = harnessToolFamily(toolName);
    try {
      await lane.client.respondPermission(permission.requestId, option.optionId);
      const reason = family
        ? `matched harness ${family} auto-allow rule`
        : 'matched harness memory auto-allow rule';
      this.updatePermissionDecision(permission, 'auto_allowed', `✓ ${toolName} (harness auto-allow)`, reason);
    } catch (e) {
      this.updatePermissionDecision(permission, 'failed', 'permission reply failed');
      this.appendTranscript(lane, 'system', `permission reply failed: ${String(e)}`);
    }
    this.render();
  }

  // ─── HTML artifacts (spec 133) ──────────────────────────────────────────

  /** Apply a Rust artifact registry event: update the mirror + the card. */
  private handleArtifactEvent(payload: ArtifactEventPayload): void {
    const { id, laneLabel, state } = payload;
    if (state === 'cancelled') {
      this.artifacts.delete(id);
      this.markArtifactCardUnavailable(id);
      return;
    }
    const existing = this.artifacts.get(id);
    const record: HarnessArtifactRecord = {
      id,
      laneLabel,
      path: payload.path ?? existing?.path ?? '',
      tail: payload.tail ?? existing?.tail ?? '',
      title: payload.title ?? existing?.title ?? id,
      state: state === 'registered' ? 'registered_live' : 'pending',
      size: typeof payload.size === 'number' ? payload.size : existing?.size ?? null,
      hash: payload.hash ?? existing?.hash ?? null,
      // spec 149: the token ships only on the `pending` event; carry it forward
      // across the later `registered`/refresh events that omit it.
      feedbackToken: payload.feedbackToken ?? existing?.feedbackToken ?? '',
    };
    this.artifacts.set(id, record);
    if (state === 'pending') return;
    // state === 'registered': first register raises the card; a refresh updates it.
    if (payload.registered === false) {
      this.updateArtifactCard(record);
      return;
    }
    this.raiseArtifactCard(record);
  }

  /** Append a hintable artifact card to the owning lane's transcript. */
  private raiseArtifactCard(record: HarnessArtifactRecord): void {
    const lane = this.lanes.find((l) => l.displayName === record.laneLabel);
    if (!lane) return;
    // Idempotent: a re-register on an id that already has a card just refreshes.
    const prior = lane.transcript.find((item) => item.artifact?.id === record.id);
    if (prior) {
      this.updateArtifactCard(record);
      return;
    }
    const item = this.appendTranscript(lane, 'artifact', record.title);
    item.artifact = {
      id: record.id,
      title: record.title,
      laneLabel: record.laneLabel,
      path: record.path,
      size: record.size,
      hash: record.hash,
      available: true,
      hintLabel: null,
    };
    this.scheduleLaneRender(lane);
  }

  private updateArtifactCard(record: HarnessArtifactRecord): void {
    for (const lane of this.lanes) {
      const item = lane.transcript.find((t) => t.artifact?.id === record.id);
      if (!item || !item.artifact) continue;
      item.artifact.size = record.size;
      item.artifact.hash = record.hash;
      item.artifact.path = record.path;
      item.artifact.available = true;
      this.scheduleLaneRender(lane);
      return;
    }
  }

  private markArtifactCardUnavailable(id: string): void {
    for (const lane of this.lanes) {
      const item = lane.transcript.find((t) => t.artifact?.id === id);
      if (!item || !item.artifact) continue;
      item.artifact.available = false;
      item.artifact.hintLabel = null;
      this.scheduleLaneRender(lane);
      return;
    }
  }

  /** Find a registered/pending artifact whose path matches a write target. */
  private findArtifactForWrite(laneLabel: string, target: string | null): HarnessArtifactRecord | null {
    if (!target) return null;
    for (const record of this.artifacts.values()) {
      if (record.laneLabel !== laneLabel) continue;
      if (artifactWritePathMatches(target, record.path, record.tail)) return record;
    }
    return null;
  }

  /** Match a tool call against the artifact registry by path (broad — used for
   * transcript redaction, which must also cover reads of the artifact). */
  private matchArtifactWrite(lane: HarnessLane, call: ToolCall | ToolCallUpdate): HarnessArtifactRecord | null {
    const target = extractModifiedPath(call) ?? call.locations?.[0]?.path ?? null;
    return this.findArtifactForWrite(lane.displayName, target);
  }

  /** Auto-approval gate: a path match is NOT enough — the spec auto-approves a
   * file *write*, not any tool whose `locations[]` happens to name the artifact
   * (a read/search/execute could otherwise be silently granted). */
  private matchArtifactWriteForGrant(lane: HarnessLane, call: ToolCall | ToolCallUpdate): HarnessArtifactRecord | null {
    if (!isArtifactWriteGrantKind(inferToolLabel(call))) return null;
    return this.matchArtifactWrite(lane, call);
  }

  private async resolveArtifactWritePermission(
    lane: HarnessLane,
    permission: HarnessPermission,
    record: HarnessArtifactRecord,
  ): Promise<void> {
    if (!lane.client) return;
    const option = pickPermissionOption(permission.options, 'accept');
    if (!option) return;
    try {
      await lane.client.respondPermission(permission.requestId, option.optionId);
      this.updatePermissionDecision(
        permission,
        'auto_allowed',
        '✓ artifact write (auto-allow)',
        `matched issued artifact path ${record.tail}`,
      );
    } catch (e) {
      this.updatePermissionDecision(permission, 'failed', 'permission reply failed');
      this.appendTranscript(lane, 'system', `permission reply failed: ${String(e)}`);
    }
    this.render();
  }

  /** Re-stat/re-hash a live artifact after observing an edit; refresh the card. */
  private async refreshArtifact(record: HarnessArtifactRecord): Promise<void> {
    if (!this.harnessMemoryId) return;
    try {
      const result = await invoke<{ size: number; hash: string }>('acp_refresh_artifact', {
        harnessId: this.harnessMemoryId,
        laneLabel: record.laneLabel,
        id: record.id,
      });
      record.size = result.size;
      record.hash = result.hash;
      this.updateArtifactCard(record);
    } catch {
      // A failed refresh (e.g. the edit grew past the cap) marks the card
      // unavailable rather than silently opening a too-large file.
      this.markArtifactCardUnavailable(record.id);
    }
  }

  // ─── Artifact hint mode ─────────────────────────────────────────────────

  /** Live artifact cards in the active lane, in transcript order. */
  private activeLaneArtifactCards(): HarnessTranscriptItem[] {
    const lane = this.activeLane();
    if (!lane) return [];
    return lane.transcript.filter((item) => item.artifact && item.artifact.available);
  }

  private enterArtifactHintMode(): boolean {
    const cards = this.activeLaneArtifactCards();
    if (cards.length === 0) return false;
    const labels = generateArtifactHintLabels(cards.length);
    cards.forEach((item, i) => {
      if (item.artifact) item.artifact.hintLabel = labels[i] ?? null;
    });
    this.artifactHintMode = true;
    this.artifactHintBuffer = '';
    this.render();
    return true;
  }

  private exitArtifactHintMode(): void {
    if (!this.artifactHintMode) return;
    this.artifactHintMode = false;
    this.artifactHintBuffer = '';
    for (const item of this.activeLane()?.transcript ?? []) {
      if (item.artifact) item.artifact.hintLabel = null;
    }
    this.render();
  }

  private handleArtifactHintKey(e: KeyboardEvent): boolean {
    if (e.key === 'Escape') {
      e.preventDefault();
      this.exitArtifactHintMode();
      return true;
    }
    if (e.key.length !== 1 || e.ctrlKey || e.metaKey || e.altKey) {
      // Ignore modifier/navigation keys; stay in hint mode.
      if (e.key !== 'Shift') e.preventDefault();
      return true;
    }
    e.preventDefault();
    const ch = e.key.toLowerCase();
    if (!ARTIFACT_HINT_ALPHABET.includes(ch)) {
      this.exitArtifactHintMode();
      return true;
    }
    const candidate = this.artifactHintBuffer + ch;
    const cards = this.activeLaneArtifactCards();
    const exact = cards.find((item) => item.artifact?.hintLabel === candidate);
    if (exact && exact.artifact) {
      void this.openArtifact(exact.artifact);
      this.exitArtifactHintMode();
      return true;
    }
    const stillPossible = cards.some((item) => item.artifact?.hintLabel?.startsWith(candidate));
    if (stillPossible) {
      this.artifactHintBuffer = candidate;
      return true;
    }
    this.exitArtifactHintMode();
    return true;
  }

  private async openArtifact(card: ArtifactCardPayload): Promise<void> {
    if (!card.available || !card.path) {
      this.flashChip('artifact unavailable');
      return;
    }
    // spec 133 Limits: re-validate the file at OPEN time (not just register) —
    // a path/size violation introduced after register makes the card
    // unavailable rather than opening a swapped/oversized file.
    const record = this.artifacts.get(card.id);
    if (record && this.harnessMemoryId) {
      try {
        await invoke('acp_refresh_artifact', {
          harnessId: this.harnessMemoryId,
          laneLabel: record.laneLabel,
          id: record.id,
        });
      } catch {
        this.markArtifactCardUnavailable(card.id);
        this.flashChip('artifact unavailable');
        return;
      }
    }
    // ADR 0002 (amended, spec 149): artifacts open in the user's real OS browser,
    // but served over loopback HTTP (`http://127.0.0.1:<port>/artifact/<token>`)
    // rather than `file://` — so the page is same-origin with the feedback
    // endpoint (inline comments) and gets a real origin for future SSE/server
    // features. The token in the path is the capability. Fall back to `file://`
    // only for a pre-149 record without a token (no feedback channel, still opens).
    if (record?.feedbackToken && this.harnessMemoryPort) {
      openExternalUrl(`http://127.0.0.1:${this.harnessMemoryPort}/artifact/${record.feedbackToken}`, {
        external: true,
      });
    } else {
      openExternalUrl(`file://${encodeURI(card.path)}`, { external: true });
    }
    this.flashChip(`opening ${card.title}`);
  }

  /** Turn-end: cancel a lane's still-pending artifacts (drops the frontend write
   * grant + asks Rust to delete the issued files). Registered-live artifacts
   * survive across turns — they are the deliverable the user still opens. */
  private cancelPendingArtifactsForLane(lane: HarnessLane): void {
    let hadPending = false;
    for (const [id, record] of this.artifacts) {
      if (record.laneLabel === lane.displayName && record.state === 'pending') {
        this.artifacts.delete(id);
        hadPending = true;
      }
    }
    if (!hadPending || !this.harnessMemoryId) return;
    void invoke('acp_cancel_pending_artifacts', {
      harnessId: this.harnessMemoryId,
      laneLabel: lane.displayName,
    }).catch(() => undefined);
  }

  /** Session reset / lane removal (#new, close): drop ALL of the lane's artifact
   * records — pending *and* registered. The transcript (and its cards) are gone,
   * so leaving registered entries in the map would be a stale auto-approval grant
   * that a later same-display-name lane could inherit. Pending files are deleted
   * via Rust; registered files are reclaimed by the harness-close/startup sweep. */
  private dropAllArtifactsForLane(lane: HarnessLane): void {
    let hadPending = false;
    for (const [id, record] of this.artifacts) {
      if (record.laneLabel !== lane.displayName) continue;
      if (record.state === 'pending') hadPending = true;
      this.artifacts.delete(id);
    }
    if (!this.harnessMemoryId) return;
    if (hadPending) {
      void invoke('acp_cancel_pending_artifacts', {
        harnessId: this.harnessMemoryId,
        laneLabel: lane.displayName,
      }).catch(() => undefined);
    }
    // spec 149: revoke the lane's feedback tokens (pending AND registered) so a
    // browser page left open on a closed/#new'd lane gets `410 revoked` rather
    // than routing into a same-display-name successor. `#restart` does NOT call
    // this path (it uses cancelPendingArtifactsForLane) — the channel survives.
    void invoke('acp_revoke_artifact_feedback', {
      harnessId: this.harnessMemoryId,
      laneLabel: lane.displayName,
    }).catch(() => undefined);
    // Drop any queued-but-undrained feedback for the lane's now-dead session.
    this.feedbackQueue.dropLane(lane.id);
    this.docsFeedbackQueue.dropLane(lane.id);
    this.docsArtifactQueue.dropLane(lane.id);
    this.diffReviewQueue.dropLane(lane.id);
    // spec 160: the lane's diff review-priority report describes a diff its now
    // dead session produced — drop it so the Diff Window stops triaging by it.
    // The store re-emits `review:priority`, ticking the footer/overlay down.
    this.reviewPriorityStore.onLaneClosed(lane.id);
  }

  private describePermission(lane: HarnessLane, permission: HarnessPermission): PermissionPayload {
    const call = permission.toolCall;
    const subject = extractModifiedPath(call) ?? call.locations?.[0]?.path ?? call.title ?? 'unknown target';
    const kind = inferToolLabel(call);
    const toolName = harnessAutoAllowToolName(permission) ?? (cleanToolTitle(call.title, kind) || call.title || kind);
    const family = harnessToolFamily(toolName);
    let suffix: string | undefined;
    const touch = this.fileTouchMap.get(subject);
    if (touch && touch.laneId !== lane.id && Date.now() - touch.at <= FILE_TOUCH_WINDOW_MS) {
      suffix = `· also ${touch.laneDisplayName} ${formatAge(Date.now() - touch.at)} ago`;
    }
    // spec 133: the permission card's argsPreview echoes the tool's raw input —
    // which for an artifact write is the HTML. Redact it (registry match OR raw
    // scratch-path pattern, to survive the pending-event race) so HTML never
    // leaks into the transcript via the permission row, just like the tool card.
    const isArtifact = this.matchArtifactWrite(lane, call) !== null || callTargetsArtifactScratch(call);
    return {
      id: permission.requestId,
      toolName,
      toolFamily: family ?? permissionToolFamily(kind),
      serverName: extractHarnessServerName(call),
      kind,
      subject,
      suffix,
      argsPreview: isArtifact ? 'html artifact · contents hidden' : permissionArgsPreview(call.rawInput, subject),
      options: permission.options.map((option) => ({
        optionId: option.optionId,
        name: option.name,
        action: option.kind.startsWith('allow') ? 'accept' : option.kind.startsWith('reject') ? 'reject' : 'other',
      })),
      decision: 'pending',
    };
  }

  private appendPermissionTranscript(
    lane: HarnessLane,
    permission: HarnessPermission,
    payload: PermissionPayload,
  ): HarnessTranscriptItem {
    const text = payload.suffix ? `${payload.kind} ${payload.subject} ${payload.suffix}` : `${payload.kind} ${payload.subject}`;
    const item = this.appendTranscript(lane, 'permission', text);
    item.permission = payload;
    permission.transcriptItem = item;
    return item;
  }

  private updatePermissionDecision(
    permission: HarnessPermission,
    decision: PermissionDecision,
    label: string,
    autoReason?: string,
  ): void {
    const payload = permission.transcriptItem?.permission;
    if (!payload) return;
    payload.decision = decision;
    payload.decisionLabel = label;
    payload.autoReason = autoReason;
  }

  // ─── Directive picker (spec 124) ──────────────────────────────────────────

  /** Directives ordered for the picker: enabled first, then disabled. Directives
   * are backend-agnostic (spec 163) — any directive applies to any lane, so there
   * is no backend filter here. Enter assigns to the focused lane; Shift+Enter
   * spawns a new lane after the user picks a backend. */
  private pickerDirectives(): HarnessDirective[] {
    return [...this.directives].sort((a, b) => Number(b.enabled) - Number(a.enabled));
  }

  private async openDirectivePicker(): Promise<void> {
    const lane = this.activeLane();
    if (!lane) {
      this.flashChip('no active lane');
      return;
    }
    await this.refreshDirectives();
    if (this.directives.length === 0) {
      this.flashChip('no directives — edit ~/.config/krypton/acp-harness.toml');
      return;
    }
    this.pickerOpen = false;
    this.helpOpen = false;
    this.memoryDrawerOpen = false;
    this.directivePickerOpen = true;
    // Start the cursor on the lane's current directive when present.
    const ordered = this.pickerDirectives();
    const currentId = lane.pendingDirectiveChange
      ? lane.pendingDirectiveChange.directiveId
      : lane.activeDirectiveId;
    const idx = ordered.findIndex((d) => d.id === currentId);
    this.directivePickerCursor = idx >= 0 ? idx : 0;
    this.render();
  }

  private closeDirectivePicker(): void {
    if (!this.directivePickerOpen) return;
    this.directivePickerOpen = false;
    this.render();
  }

  /** Assign (lane scope) or defer a directive to the focused lane. */
  private assignDirectiveToLane(lane: HarnessLane, directiveId: string | null): void {
    const busy = lane.status === 'busy' || lane.status === 'needs_permission' || lane.status === 'awaiting_peer';
    // spec 130: manual triage override is legacy; clear it when directive
    // context changes. For the deferred (busy) case the recompute happens when
    // the change is promoted before the next send.
    lane.triageOverride = null;
    if (busy) {
      lane.pendingDirectiveChange = { directiveId };
      this.flashChip(directiveId ? 'directive changes next send' : 'directive clears next send');
    } else {
      lane.activeDirectiveId = directiveId;
      lane.pendingDirectiveChange = null;
      this.refreshTriageEquip(lane);
    }
    this.appendTranscript(
      lane,
      'system',
      directiveId ? `directive set: ${directiveId}` : 'directive cleared',
    );
    this.renderComposer();
  }

  private handleDirectivePickerKey(e: KeyboardEvent): void {
    const lane = this.activeLane();
    if (!lane) {
      this.closeDirectivePicker();
      return;
    }
    const ordered = this.pickerDirectives();
    const total = ordered.length;
    if (e.key === 'Escape' || e.key === 'q') {
      this.closeDirectivePicker();
      return;
    }
    if (e.key === 'Backspace') {
      this.assignDirectiveToLane(lane, null);
      this.closeDirectivePicker();
      return;
    }
    if (total === 0) return;
    if (e.key === 'ArrowDown' || e.key === 'j') {
      this.directivePickerCursor = (this.directivePickerCursor + 1) % total;
      this.renderDirectivePicker();
      return;
    }
    if (e.key === 'ArrowUp' || e.key === 'k') {
      this.directivePickerCursor = (this.directivePickerCursor - 1 + total) % total;
      this.renderDirectivePicker();
      return;
    }
    if (e.key === 'Enter') {
      const directive = ordered[this.directivePickerCursor];
      if (!directive) return;
      if (!directive.enabled) {
        this.flashChip('directive disabled');
        return;
      }
      this.closeDirectivePicker();
      if (e.shiftKey) {
        // Shift+Enter: spawn a fresh lane with this directive. Directives are
        // backend-agnostic (spec 163), so ask which backend to spawn via the
        // lane backend picker; the chosen backend pairs with this directive.
        // Pass the id into openLanePicker so it binds atomically with the open
        // (set after the async backend fetch) — never as shared state across the
        // await, which a re-entrant plain "+ new lane" open could inherit.
        void this.openLanePicker(directive.id);
      } else {
        // Enter: switch the focused lane's directive in place. assignDirectiveToLane
        // defers the change to the next send when the lane is busy.
        this.assignDirectiveToLane(lane, directive.id);
      }
    }
  }

  // ─── Model picker (spec 127) ──────────────────────────────────────────────

  /** Open the model picker for the focused lane. Disabled when the lane has no
   *  client, advertises no models, or already has a switch in flight. */
  private openModelPicker(): void {
    const lane = this.activeLane();
    if (!lane) {
      this.flashChip('no active lane');
      return;
    }
    if (!lane.client || lane.availableModels.length === 0) {
      this.flashChip('model picker: backend advertises no models');
      return;
    }
    if (lane.pendingModelSwitch) {
      this.flashChip('model switch already in flight');
      return;
    }
    this.pickerOpen = false;
    this.helpOpen = false;
    this.memoryDrawerOpen = false;
    this.directivePickerOpen = false;
    this.modelPickerOpen = true;
    this.modelPickerLaneId = lane.id;
    const idx = lane.availableModels.findIndex((m) => m.model_id === lane.currentModelId);
    this.modelPickerCursor = idx >= 0 ? idx : 0;
    this.render();
  }

  private closeModelPicker(): void {
    if (!this.modelPickerOpen) return;
    this.modelPickerOpen = false;
    this.modelPickerLaneId = null;
    this.render();
  }

  /** The lane the picker is bound to (captured at open, so the picker stays on
   *  its lane even if focus changes). Null when the lane went away. */
  private modelPickerLane(): HarnessLane | null {
    if (!this.modelPickerLaneId) return null;
    return this.lanes.find((l) => l.id === this.modelPickerLaneId) ?? null;
  }

  private handleModelPickerKey(e: KeyboardEvent): void {
    const lane = this.modelPickerLane();
    if (!lane) {
      this.closeModelPicker();
      return;
    }
    const total = lane.availableModels.length;
    if (e.key === 'Escape' || e.key === 'q') {
      this.closeModelPicker();
      return;
    }
    if (total === 0) return;
    if (e.key === 'ArrowDown' || e.key === 'j') {
      this.modelPickerCursor = (this.modelPickerCursor + 1) % total;
      this.renderModelPicker();
      return;
    }
    if (e.key === 'ArrowUp' || e.key === 'k') {
      this.modelPickerCursor = (this.modelPickerCursor - 1 + total) % total;
      this.renderModelPicker();
      return;
    }
    if (e.key === 'Enter') {
      const picked = lane.availableModels[this.modelPickerCursor];
      if (!picked) return;
      this.closeModelPicker();
      if (picked.model_id === lane.currentModelId) return; // already current — no-op
      void this.switchLaneModel(lane, picked);
    }
  }

  /** Perform a live model switch with an epoch-guarded optimistic update
   *  (Zed-style: revert on a rejected id, keep + flag on a timeout). */
  private async switchLaneModel(lane: HarnessLane, picked: ModelInfo): Promise<void> {
    const client = lane.client;
    if (!client) {
      this.flashChip('lane has no active session');
      return;
    }
    const epoch = ++lane.modelSwitchEpoch;
    const prev: PendingModelSwitch = {
      epoch,
      prevModelName: lane.modelName,
      prevModelId: lane.currentModelId,
      prevModeId: lane.currentMode?.id ?? null,
      pickedName: picked.name,
    };
    lane.pendingModelSwitch = prev;
    // Optimistic: show the picked model immediately.
    lane.modelName = picked.name;
    lane.currentModelId = picked.model_id;
    lane.modelApplyFailed = false;
    this.render();
    this.flashChip(`→ ${picked.name}`);

    // Deadline timer: clears a still-pending token so a switch that neither
    // errors nor emits a mode update never leaves the lane stuck "in flight".
    // 12s > the 10s backend timeout, so a late mode_update still attributes.
    const deadline = window.setTimeout(() => {
      if (lane.pendingModelSwitch?.epoch === epoch) {
        lane.pendingModelSwitch = null;
      }
    }, 12_000);

    try {
      const outcome = await client.setLaneModel(picked.model_id);
      if (lane.modelSwitchEpoch !== epoch) return; // a newer switch superseded us
      if (outcome === 'timed_out_uncertain') {
        // The agent may still apply it — keep the optimistic chip but flag it
        // unconfirmed, and leave the token live to the deadline for a late
        // mode_update. Do NOT revert.
        lane.modelApplyFailed = true;
        this.flashChip('model switch timed out; state uncertain');
        this.render();
        return;
      }
      // Success: clear the token (deadline timer will no-op).
      window.clearTimeout(deadline);
      lane.pendingModelSwitch = null;
    } catch (err) {
      window.clearTimeout(deadline);
      if (lane.modelSwitchEpoch !== epoch) return; // a newer switch won — don't revert
      // Rejected id: revert the optimistic update and flag.
      lane.modelName = prev.prevModelName;
      lane.currentModelId = prev.prevModelId;
      lane.modelApplyFailed = true;
      lane.pendingModelSwitch = null;
      this.flashChip(`model switch failed: ${errorText(err)}`);
      this.render();
    }
  }

  /** Open the lane backend picker. `forDirectiveId` (spec 163: Shift+Enter from
   * the directive picker) carries the directive the spawned lane will start with;
   * it is bound to the picker ONLY on a successful open, after the async backend
   * fetch — so a re-entrant plain "+ new lane" open during the await can never
   * inherit it, and a failed open leaves no stale pending state. */
  private async openLanePicker(forDirectiveId?: string | null): Promise<void> {
    let entries: AcpBackendDescriptor[];
    try {
      entries = harnessBackends(await AcpClient.listBackends());
    } catch (e) {
      this.flashChip(`backend list failed: ${String(e)}`);
      return;
    }
    if (entries.length === 0) {
      this.flashChip('no ACP backends installed');
      return;
    }
    this.pickerEntries = entries;
    this.pickerOpen = true;
    this.pickerCursor = 0;
    this.pendingSpawnDirectiveId = forDirectiveId ?? null;
    this.helpOpen = false;
    this.memoryDrawerOpen = false;
    this.render();
  }

  private closeLanePicker(): void {
    if (!this.pickerOpen) return;
    this.pickerOpen = false;
    // spec 163: drop any pending directive-spawn intent on close (cancel or
    // after consuming) so a later plain "+ new lane" never inherits it.
    this.pendingSpawnDirectiveId = null;
    this.render();
  }

  private handlePickerKey(e: KeyboardEvent): void {
    const total = this.pickerEntries.length;
    if (e.key === 'Escape' || e.key === 'q') {
      this.closeLanePicker();
      return;
    }
    if (total === 0) return;
    if (e.key === 'ArrowDown' || e.key === 'j') {
      this.pickerCursor = (this.pickerCursor + 1) % total;
      this.renderPicker();
      return;
    }
    if (e.key === 'ArrowUp' || e.key === 'k') {
      this.pickerCursor = (this.pickerCursor - 1 + total) % total;
      this.renderPicker();
      return;
    }
    if (e.key === 'Enter') {
      const entry = this.pickerEntries[this.pickerCursor];
      if (entry) {
        // spec 163: consume a pending directive from a Shift+Enter spawn before
        // closeLanePicker() clears it, so the new lane starts with that directive.
        const directiveId = this.pendingSpawnDirectiveId;
        this.closeLanePicker();
        void this.addLane(entry.id, directiveId);
      }
      return;
    }
  }

  private async openSessionPicker(): Promise<void> {
    this.closeLanePicker();
    this.helpOpen = false;
    this.memoryDrawerOpen = false;
    if (this.pickerEntries.length === 0) {
      try {
        this.pickerEntries = harnessBackends(await AcpClient.listBackends());
      } catch (e) {
        this.flashChip(`backend list failed: ${errorText(e)}`);
        return;
      }
    }
    const active = this.activeLane();
    if (!active) {
      this.sessionPicker = {
        ...this.emptySessionPickerState(),
        open: true,
        phase: 'backend',
      };
      this.render();
      return;
    }
    this.sessionPicker = {
      ...this.emptySessionPickerState(),
      open: true,
      phase: 'loading',
      backendId: active.backendId,
      backendCursor: Math.max(0, this.pickerEntries.findIndex((entry) => entry.id === active.backendId)),
    };
    this.render();
    await this.loadSessionPickerBackend(active.backendId);
  }

  private emptySessionPickerState(): SessionPickerState {
    return {
      open: false,
      phase: 'loading',
      backendCursor: 0,
      sessionCursor: 0,
      backendId: null,
      probeClient: null,
      initInfo: null,
      capabilities: null,
      sessions: [],
      nextCursor: null,
      error: null,
    };
  }

  private async closeSessionPicker(disposeProbe = true): Promise<void> {
    const client = this.sessionPicker.probeClient;
    this.sessionPicker = this.emptySessionPickerState();
    if (disposeProbe && client) {
      try {
        await client.dispose();
      } catch {
        // ignore — best-effort teardown
      }
    }
    this.render();
  }

  private async handleSessionPickerKey(e: KeyboardEvent): Promise<void> {
    const state = this.sessionPicker;
    if (e.key === 'Escape' || e.key === 'q') {
      await this.closeSessionPicker();
      return;
    }
    if (state.phase === 'loading') return;
    if (state.phase === 'backend') {
      this.handleSessionBackendKey(e);
      return;
    }
    if (e.key === 'b') {
      if (state.probeClient) {
        await state.probeClient.dispose();
      }
      this.sessionPicker = {
        ...this.emptySessionPickerState(),
        open: true,
        phase: 'backend',
        backendCursor: Math.max(0, this.pickerEntries.findIndex((entry) => entry.id === state.backendId)),
      };
      this.renderSessionPicker();
      return;
    }
    if (e.key === 'n' && state.backendId) {
      const backendId = state.backendId;
      await this.closeSessionPicker();
      void this.addLane(backendId);
      return;
    }
    if (e.key === 'PageDown' && state.nextCursor && state.backendId) {
      await this.loadMoreSessions();
      return;
    }
    const total = state.sessions.length;
    if (total === 0) return;
    if (e.key === 'ArrowDown' || e.key === 'j') {
      state.sessionCursor = (state.sessionCursor + 1) % total;
      this.renderSessionPicker();
      return;
    }
    if (e.key === 'ArrowUp' || e.key === 'k') {
      state.sessionCursor = (state.sessionCursor - 1 + total) % total;
      this.renderSessionPicker();
      return;
    }
    if (e.key === 'Enter') {
      await this.startSelectedSession();
    }
  }

  private handleSessionBackendKey(e: KeyboardEvent): void {
    const total = this.pickerEntries.length;
    if (total === 0) return;
    if (e.key === 'ArrowDown' || e.key === 'j') {
      this.sessionPicker.backendCursor = (this.sessionPicker.backendCursor + 1) % total;
      this.renderSessionPicker();
      return;
    }
    if (e.key === 'ArrowUp' || e.key === 'k') {
      this.sessionPicker.backendCursor = (this.sessionPicker.backendCursor - 1 + total) % total;
      this.renderSessionPicker();
      return;
    }
    if (e.key === 'Enter') {
      const entry = this.pickerEntries[this.sessionPicker.backendCursor];
      if (entry) void this.loadSessionPickerBackend(entry.id);
    }
  }

  private async loadSessionPickerBackend(backendId: string): Promise<void> {
    if (this.sessionPicker.probeClient) {
      await this.sessionPicker.probeClient.dispose();
    }
    this.sessionPicker = {
      ...this.emptySessionPickerState(),
      open: true,
      phase: 'loading',
      backendId,
      backendCursor: Math.max(0, this.pickerEntries.findIndex((entry) => entry.id === backendId)),
    };
    this.render();
    let client: AcpClient | null = null;
    try {
      client = await AcpClient.spawn(backendId, this.projectDir, []);
      const init = await client.initializeOnly();
      const capabilities = sessionCapabilitiesFromAgent(init.agent_capabilities);
      if (!capabilities.canList) {
        await client.dispose();
        client = null;
        this.sessionPicker = {
          ...this.emptySessionPickerState(),
          open: true,
          phase: 'error',
          backendId,
          backendCursor: this.sessionPicker.backendCursor,
          capabilities,
          error: `${backendLabel(backendId)} does not support session/list`,
        };
        this.render();
        return;
      }
      const list = await client.listSessions(this.projectDir);
      this.sessionPicker = {
        ...this.emptySessionPickerState(),
        open: true,
        phase: 'sessions',
        backendId,
        backendCursor: this.sessionPicker.backendCursor,
        probeClient: client,
        initInfo: init,
        capabilities,
        sessions: filterSessionsForProject(list.sessions, this.projectDir),
        nextCursor: list.nextCursor ?? null,
      };
      client = null;
    } catch (e) {
      if (client) await client.dispose();
      this.sessionPicker = {
        ...this.emptySessionPickerState(),
        open: true,
        phase: 'error',
        backendId,
        backendCursor: Math.max(0, this.pickerEntries.findIndex((entry) => entry.id === backendId)),
        error: errorText(e),
      };
    }
    this.render();
  }

  private async loadMoreSessions(): Promise<void> {
    const state = this.sessionPicker;
    if (!state.probeClient || !state.nextCursor) return;
    try {
      const list = await state.probeClient.listSessions(this.projectDir, state.nextCursor);
      state.sessions = state.sessions.concat(filterSessionsForProject(list.sessions, this.projectDir));
      state.nextCursor = list.nextCursor ?? null;
      this.renderSessionPicker();
    } catch (e) {
      state.error = errorText(e);
      this.renderSessionPicker();
    }
  }

  private async startSelectedSession(): Promise<void> {
    const state = this.sessionPicker;
    const session = state.sessions[state.sessionCursor];
    const client = state.probeClient;
    const init = state.initInfo;
    const capabilities = state.capabilities;
    if (!session || !client || !init || !capabilities || !state.backendId) return;
    const mode: 'resume' | 'load' | null = capabilities.canResume ? 'resume' : capabilities.canLoad ? 'load' : null;
    if (!mode) {
      state.error = 'selected backend can list sessions but cannot resume or load them';
      this.renderSessionPicker();
      return;
    }
    const label = backendLabel(state.backendId);
    // spec 141: globally-unique displayName from the directory's monotonic counter.
    const lane = this.createLane(this.nextLaneIndex++, state.backendId, `${label}-${nextLaneNumber(label)}`);
    lane.client = client;
    this.setLaneStatus(lane, 'starting');
    lane.transcript = [{ id: makeId(), kind: 'system', text: `${mode === 'resume' ? 'resuming' : 'loading'} ${shortId(session.sessionId)}...` }];
    this.lanes.push(lane);
    this.notifyUsageProvidersChanged();
    this.activateLane(lane.id);
    this.sessionPicker.probeClient = null;
    await this.closeSessionPicker(false);
    const spawnEpoch = lane.spawnEpoch;
    client.onEvent((event) => {
      if (lane.spawnEpoch !== spawnEpoch || lane.client !== client) return;
      this.onLaneEvent(lane, event);
    });
    try {
      const servers = await this.mcpServersForLane(lane, init.agent_capabilities);
      await client.setMcpServers(servers ?? []);
      const info = mode === 'resume'
        ? await client.resumeSession(session.sessionId)
        : await client.loadSession(session.sessionId);
      if (lane.spawnEpoch !== spawnEpoch || lane.client !== client) {
        await client.dispose();
        return;
      }
      lane.sessionId = info.session_id;
      this.configureLaneFromInfo(lane, init);
      // spec 127: resume/load surfaces its own model state — merge it in (init,
      // an AgentInitInfo, has none). The picker then works on restored lanes too.
      lane.availableModels = info.available_models ?? [];
      lane.currentModelId = info.current_model_id ?? null;
      this.setLaneStatus(lane, 'idle');
      this.sealStreaming(lane);
      this.appendTranscript(lane, 'system', `${mode === 'resume' ? 'resumed' : 'loaded'} ${shortId(session.sessionId)}.`);
    } catch (e) {
      if (lane.spawnEpoch !== spawnEpoch) {
        await client.dispose();
        return;
      }
      this.setLaneStatus(lane, 'error');
      lane.error = errorText(e);
      this.appendTranscript(lane, 'system', `session ${mode} failed: ${errorText(e)}`);
    }
    this.render();
  }

  /** Spawn a new lane on `backendId`. When `directiveId` is given (spec 163:
   * Shift+Enter from the directive picker), the lane starts with that directive
   * active — directives are backend-agnostic, so any directive pairs with any
   * chosen backend. */
  private async addLane(backendId: string, directiveId?: string | null): Promise<void> {
    const label = backendLabel(backendId);
    // spec 141: number from the process-wide, never-recycled counter keyed by
    // the rendered label prefix so the displayName is globally unique across all
    // harness views (no per-view collision, safe to address bare).
    const lane = this.createLane(this.nextLaneIndex++, backendId, `${label}-${nextLaneNumber(label)}`);
    if (directiveId) {
      // Revalidate at spawn time: the directive may have been disabled or removed
      // while the backend picker was open. Apply only if still assignable; surface
      // the degrade rather than silently spawning an un-directed lane.
      const directive = this.directiveById(directiveId);
      if (directive && this.directiveAssignable(directive)) {
        lane.activeDirectiveId = directiveId;
        this.appendTranscript(lane, 'system', `directive set: ${directiveId}`);
      } else {
        this.flashChip(`directive ${directiveId} unavailable — lane spawned without it`);
      }
    }
    this.lanes.push(lane);
    this.notifyUsageProvidersChanged();
    // A lane added while the orchestrator console is open must appear at once.
    // The console only re-renders on a LaneBus *transition*, but spawnLane sets
    // 'starting'→'starting' (a setLaneStatus no-op that emits nothing), so the
    // card would otherwise stay invisible until the FIRST real transition. For a
    // slow/blocking backend startup (notably cursor, which awaits
    // `cursor-agent mcp enable` in prepareCursorMcp before connecting) that
    // transition can be far off or never arrive — so the new card never shows.
    // Refresh the console directly on the roster growth (guarded; no-op closed).
    this.refreshOrchestratorConsole();
    this.activateLane(lane.id);
    await this.spawnLane(lane);
  }

  private async closeActiveLane(): Promise<void> {
    const lane = this.activeLane();
    if (!lane) return;
    await this.closeLane(lane);
  }

  private async closeLane(lane: HarnessLane): Promise<void> {
    lane.spawnEpoch += 1;
    // spec 133: the lane is being removed — drop all its artifact records
    // (pending grants + registered entries) so a later same-name lane can't
    // inherit them.
    this.dropAllArtifactsForLane(lane);
    if (lane.client) {
      try {
        await lane.client.dispose();
      } catch {
        // ignore — best-effort teardown
      }
      lane.client = null;
    }
    if (lane.pendingShellId) {
      try {
        await this.cancelShell(lane);
      } catch {
        // ignore
      }
    }
    if (lane.backendId === 'junie' && this.harnessMemoryId) {
      void removeJunieMcpOverlay(this.harnessMemoryId, lane.displayName).catch((e) => {
        console.warn('[acp-harness] remove junie mcp overlay failed:', e);
      });
    }
    lane.junieMcpOverlayDir = null;
    if (lane.backendId === 'cline' && this.harnessMemoryId) {
      void removeClineMcpOverlay(this.harnessMemoryId, lane.displayName).catch((e) => {
        console.warn('[acp-harness] remove cline mcp overlay failed:', e);
      });
    }
    lane.clineMcpOverlayDir = null;
    if (lane.backendId === 'cursor' && lane.cursorMcpNames?.length && this.projectDir) {
      void cleanupCursorMcp(this.projectDir, lane.cursorMcpNames).catch((e) => {
        console.warn('[acp-harness] cleanup cursor mcp failed:', e);
      });
    }
    lane.cursorMcpNames = null;
    this.clearPollyBuiltinRole(lane);
    this.clearDebbyBuiltinRole(lane);
    this.clearSaltyBuiltinRole(lane);
    // spec 180: the orchestrator seat is vacated when its lane closes; close the
    // console too (a re-promote is needed before it can be reopened).
    if (this.orchestratorLaneId === lane.id) {
      this.orchestratorLaneId = null;
      this.closeOrchestratorConsole();
    }
    const index = this.lanes.findIndex((l) => l.id === lane.id);
    if (index !== -1) this.lanes.splice(index, 1);
    this.notifyUsageProvidersChanged();
    this.mcpStatsByLane.delete(lane.displayName);
    this.laneMetricHistory.delete(lane.id);
    // Drop the closed lane's queued items + audit row. The legacy Rust mirror is
    // also cleared, though spec 130 no longer gates attention tools with it.
    if (lane.triageEquipped && this.harnessMemoryId) {
      void invoke('acp_set_lane_triage_equipped', {
        harnessId: this.harnessMemoryId,
        laneLabel: lane.displayName,
        equipped: false,
      }).catch(() => {});
    }
    this.triageStore.onLaneClosed(lane.id);
    this.renderTriageGaugeEl();
    // spec 146: a closed lane's review history is deliberately KEPT until the
    // whole view disposes (the matrix observes the per-session trend; closing or
    // restarting a lane mid-session must not erase its history). The record
    // snapshots the lane displayName so the overlay can still label these rows.
    this.laneBus.emit({
      type: 'lane:closed',
      payload: { laneId: lane.id, displayName: lane.displayName },
    });
    // spec 141: this lane stopped but the harness stays open — tell other harness
    // views so a cross-view initiator waiting on it isn't left in awaiting_peer.
    // (Whole-harness dispose goes through unregisterHarness instead.)
    if (this.directoryEntry) {
      notifyForeignLaneClosed(this.directoryEntry.harnessId, lane.displayName, this.projectDir);
    }
    if (this.lanes.length === 0) {
      this.activeLaneId = '';
      this.systemRows = [
        ...(this.harnessMemoryWarning ? [`memory warning: ${this.harnessMemoryWarning}`] : []),
        'no lanes running',
        'press Cmd+P then + to add a lane',
      ];
    } else {
      const next = this.lanes[Math.min(index, this.lanes.length - 1)] ?? this.lanes[0];
      this.activeLaneId = next.id;
    }
    this.flashChip(`closed ${lane.displayName}`);
    this.render();
  }

  private async cancelLane(lane: HarnessLane): Promise<void> {
    // spec 136: #cancel / Ctrl+C is the explicit "stop" gesture — drop the prompt
    // queue here, before any early return, so it can't be left half-cleared.
    lane.queuedPrompts = [];
    const pending = this.coordinator.pendingPeersFor(lane.id);
    // spec 116: busy cancel stops the ACP turn only — keep outstanding peer waits.
    if (lane.status === 'awaiting_peer' || (lane.status === 'idle' && pending.length > 0)) {
      this.coordinator.cancelConversationsFor(lane.id);
      this.coordinator.recomputePeerStatus(lane.id);
      this.render();
      return;
    }
    if (!lane.client) {
      this.render();
      return;
    }
    lane.pendingTurnExtractions = [];
    try {
      await lane.client.cancel();
      this.appendTranscript(lane, 'system', 'cancel requested');
    } catch (e) {
      this.appendTranscript(lane, 'system', `cancel failed: ${String(e)}`);
    }
    this.render();
  }

  private async restartLane(lane: HarnessLane): Promise<void> {
    if (lane.status !== 'error' && lane.status !== 'stopped') {
      this.flashChip(`lane ${lane.status} - #cancel first`);
      return;
    }
    if (lane.client) {
      await lane.client.dispose();
      lane.client = null;
    }
    lane.pendingPermissions = [];
    lane.pendingTurnExtractions = [];
    lane.acceptAllForTurn = false;
    lane.rejectAllForTurn = false;
    lane.peerAutoAcceptForTurn = false;
    lane.sessionId = null;
    lane.error = null;
    lane.plan = null;
    lane.planCollapsed = false;
    lane.queuedPrompts = []; // spec 136: fresh session — queued prompts were for the old context
    this.clearPollyBuiltinRole(lane);
    this.clearDebbyBuiltinRole(lane);
    this.clearSaltyBuiltinRole(lane);
    // spec 133: a restart reuses the display name — drop any pending artifact
    // write grant so the restarted lane can't inherit it.
    this.cancelPendingArtifactsForLane(lane);
    this.appendTranscript(lane, 'restart', '--- session restarted ---');
    await this.spawnLane(lane);
  }

  /** Reset a lane to a fresh ACP session. Returns true once the lane has been
   *  disposed and successfully respawned; false if it bailed (wrong status,
   *  memory-clear failure) or the respawn errored — so callers like `#goal`
   *  (spec 148) can abort their follow-up rather than act on a dead session. */
  private async newLaneSession(
    lane: HarnessLane,
    options: { clearMemory: boolean },
  ): Promise<boolean> {
    if (lane.status === 'busy' || lane.status === 'needs_permission' || lane.status === 'awaiting_peer') {
      this.flashChip('lane busy - #cancel first');
      return false;
    }
    if (lane.status === 'starting') {
      this.flashChip('lane starting');
      return false;
    }
    if (options.clearMemory && !this.harnessMemoryId) {
      this.flashChip(this.harnessMemoryWarning ? `memory unavailable: ${truncate(this.harnessMemoryWarning, 72)}` : 'memory unavailable - use #new');
      return false;
    }
    if (options.clearMemory) {
      try {
        await this.clearActiveLaneMemory(lane, false);
      } catch (e) {
        this.flashChip(`memory clear failed: ${errorText(e)}`);
        return false;
      }
    }
    if (lane.pendingShellId) await this.cancelShell(lane);
    lane.spawnEpoch += 1;
    // spec 133: a fresh session wipes the transcript (and its artifact cards),
    // so drop ALL of this lane's artifact records — pending grants AND now-stale
    // registered entries that a same-name lane would otherwise inherit.
    this.dropAllArtifactsForLane(lane);
    if (lane.client) {
      await lane.client.dispose();
      lane.client = null;
    }
    this.setLaneStatus(lane, 'starting');
    lane.draft = '';
    lane.cursor = 0;
    lane.pendingPermissions = [];
    lane.pendingTurnExtractions = [];
    lane.stagedImages = [];
    lane.queuedPrompts = []; // spec 136: fresh session — drop queued prompts
    lane.transcript = [{ id: makeId(), kind: 'system', text: `starting fresh ${lane.displayName}...` }];
    lane.usage = null;
    lane.sessionId = null;
    lane.modelName = null;
    lane.modelApplyFailed = false;
    lane.supportsEmbeddedContext = false;
    lane.supportsImages = false;
    lane.error = null;
    lane.acceptAllForTurn = false;
    lane.rejectAllForTurn = false;
    lane.peerAutoAcceptForTurn = false;
    lane.currentUserId = null;
    lane.pendingUserEcho = null;
    lane.currentAssistantId = null;
    lane.currentThoughtId = null;
    lane.toolTranscriptIds = new Map();
    lane.toolCalls = new Map();
    lane.seenTranscriptIds = new Set();
    lane.stickToBottom = true;
    lane.pendingShellId = null;
    lane.activeTurnStartedAt = null;
    lane.plan = null;
    lane.planCollapsed = false;
    lane.transcriptWindow = TRANSCRIPT_WINDOW_DEFAULT;
    this.clearPollyBuiltinRole(lane);
    this.clearDebbyBuiltinRole(lane);
    this.clearSaltyBuiltinRole(lane);
    this.updateComposerTick();
    this.render();
    await this.spawnLane(lane);
    // spec 148: false when spawn/initialize failed (lane left in 'error'), so #goal
    // doesn't claim success or seed a turn that can't start (Codex-1 W1).
    return lane.status !== 'error';
  }

  /** spec 148: `#goal <text>` sets a focus scope — it clears the lane like `#new`
   *  (fresh session, memory kept) and seeds the first turn; `#goal` shows the
   *  current goal; `#goal clear` (aliases stop/off/none/reset) removes the scope
   *  without touching the session. */
  private async runGoalCommand(lane: HarnessLane, text: string): Promise<void> {
    this.setDraft(lane, '', 0);
    const arg = text.trim().slice('#goal'.length).trim();
    const CLEAR_ALIASES = new Set(['clear', 'stop', 'off', 'none', 'reset']);
    if (!arg) {
      this.flashChip(
        lane.goal
          ? `goal: ${truncate(lane.goal.text, 56)} · ${formatAge(Date.now() - lane.goal.setAt)}`
          : 'no active goal · #goal <text> to set',
      );
      return;
    }
    if (CLEAR_ALIASES.has(arg.toLowerCase())) {
      if (!lane.goal) {
        this.flashChip('no active goal');
        return;
      }
      lane.goal = undefined;
      this.flashChip('goal cleared');
      this.render();
      return;
    }
    // Setting clears the session via newLaneSession, which only accepts `idle`.
    if (lane.status !== 'idle') {
      this.flashChip('lane busy - #cancel first');
      return;
    }
    // Respawn FIRST, then publish the goal (Codex-1 B1): if the goal were set before
    // the respawn's awaits, a peer message arriving in that window could start an
    // old-session turn carrying the new goal, then be disposed mid-turn. Publishing
    // after a confirmed respawn closes that window.
    const ok = await this.newLaneSession(lane, { clearMemory: false });
    if (!ok) return; // respawn bailed or errored — leave the lane goal-free
    // The goal is set regardless of what follows: it rides this lane's subsequent
    // turns via insertGoalLine, so it takes effect even when the immediate seed is
    // deferred below.
    lane.goal = { text: arg, setAt: Date.now() };
    this.flashChip(`goal set · ${truncate(arg, 56)}`);
    this.render();
    // newLaneSession does NOT guarantee an idle lane on return (Codex-1 B3):
    // spawnLane's idle transition synchronously drains any queued peer mail, which
    // can flip the fresh session to busy before we reach here. Seed only when the
    // lane is actually idle; otherwise the goal already applies to the next turn, so
    // record the deferral rather than letting enqueueSystemPrompt silently no-op.
    if (lane.status !== 'idle') {
      this.appendTranscript(lane, 'system', 'goal set; first turn deferred — lane is handling other work');
      this.render();
      return;
    }
    // Kick the first turn on the goal. Self-contained seed (the goal text is embedded),
    // sent only to THIS lane — it does not touch the shared inter-lane drain path, so a
    // cancelled-peer tombstone is never cleared and other lanes are untouched (human redirect).
    await this.enqueueSystemPrompt(lane, goalSeedPrompt(arg), undefined, 'setting goal');
  }

  private async clearActiveLaneMemory(lane: HarnessLane, showSuccess = true): Promise<void> {
    if (!this.harnessMemoryId) {
      throw new Error('memory unavailable');
    }
    await invoke('clear_harness_memory_lane', {
      harnessId: this.harnessMemoryId,
      lane: lane.displayName,
    });
    await this.refreshMemory();
    await this.refreshMcpStats();
    if (showSuccess) this.flashChip(`memory cleared for ${lane.displayName}`);
  }

  private async runHashCommand(lane: HarnessLane, text: string): Promise<void> {
    const parts = text.trim().split(/\s+/);
    if (parts[0] === '#new') {
      this.setDraft(lane, '', 0);
      await this.newLaneSession(lane, { clearMemory: false });
      return;
    }
    if (parts[0] === '#new!') {
      this.setDraft(lane, '', 0);
      await this.newLaneSession(lane, { clearMemory: true });
      return;
    }
    if (parts[0] === '#goal') {
      await this.runGoalCommand(lane, text);
      return;
    }
    // spec 194: shared working ticket — picker (no args), direct ref, refresh, clear.
    if (parts[0] === '#ticket') {
      this.setDraft(lane, '', 0);
      await this.runTicketCommand(parts.slice(1));
      return;
    }
    if (parts[0] === '#cancel') {
      await this.cancelLane(lane);
      this.setDraft(lane, '', 0);
      return;
    }
    if (parts[0] === '#restart') {
      this.setDraft(lane, '', 0);
      await this.restartLane(lane);
      return;
    }
    if (parts[0] === '#mem') {
      this.setDraft(lane, '', 0);
      if (parts[1] === 'clear') {
        try {
          await this.clearActiveLaneMemory(lane);
        } catch (e) {
          this.flashChip(errorText(e));
        }
        this.render();
        return;
      }
      this.flashChip('memory commands: #mem clear, #mcp, Ctrl+M drawer');
      return;
    }
    if (parts[0] === '#mcp') {
      this.setDraft(lane, '', 0);
      await this.printMcpStatus(lane);
      this.render();
      return;
    }
    if (parts[0] === '#dashboard') {
      this.setDraft(lane, '', 0);
      const port = await invoke<number>('get_hook_server_port').catch(() => 0);
      if (!port) {
        this.flashChip('dashboard unavailable - hook server not ready');
        return;
      }
      const url = `http://127.0.0.1:${port}/dashboard`;
      try {
        await invoke('open_url', { url });
        this.flashChip(url);
      } catch (e) {
        this.flashChip(`dashboard open failed: ${errorText(e)}`);
      }
      return;
    }
    if (parts[0] === '#gallery') {
      this.setDraft(lane, '', 0);
      const port = await invoke<number>('get_hook_server_port').catch(() => 0);
      if (!port) {
        this.flashChip('gallery unavailable - hook server not ready');
        return;
      }
      const url = `http://127.0.0.1:${port}/gallery`;
      try {
        await invoke('open_url', { url });
        this.flashChip(url);
      } catch (e) {
        this.flashChip(`gallery open failed: ${errorText(e)}`);
      }
      return;
    }
    if (parts[0] === '#docs') {
      this.setDraft(lane, '', 0);
      const port = await invoke<number>('get_hook_server_port').catch(() => 0);
      if (!port) {
        this.flashChip('docs unavailable - hook server not ready');
        return;
      }
      const url = `http://127.0.0.1:${port}/docs`;
      try {
        await invoke('open_url', { url });
        this.flashChip(url);
      } catch (e) {
        this.flashChip(`docs open failed: ${errorText(e)}`);
      }
      return;
    }
    // spec 192: GitHub issue analysis viewer (.krypton/analyses bundles).
    if (parts[0] === '#analyses') {
      this.setDraft(lane, '', 0);
      const port = await invoke<number>('get_hook_server_port').catch(() => 0);
      if (!port) {
        this.flashChip('analyses unavailable - hook server not ready');
        return;
      }
      const url = `http://127.0.0.1:${port}/analyses`;
      try {
        await invoke('open_url', { url });
        this.flashChip(url);
      } catch (e) {
        this.flashChip(`analyses open failed: ${errorText(e)}`);
      }
      return;
    }
    // spec 185: fixed external-browser reference for the built-in # commands.
    if (parts[0] === '#commands') {
      this.setDraft(lane, '', 0);
      const port = await invoke<number>('get_hook_server_port').catch(() => 0);
      if (!port) {
        this.flashChip('commands unavailable - hook server not ready');
        return;
      }
      const url = `http://127.0.0.1:${port}/commands`;
      try {
        await invoke('open_url', { url });
        this.flashChip(url);
      } catch (e) {
        this.flashChip(`commands open failed: ${errorText(e)}`);
      }
      return;
    }
    // spec 186: fixed external-browser reference for the built-in MCP tools.
    if (parts[0] === '#tools') {
      this.setDraft(lane, '', 0);
      const port = await invoke<number>('get_hook_server_port').catch(() => 0);
      if (!port) {
        this.flashChip('tools unavailable - hook server not ready');
        return;
      }
      const url = `http://127.0.0.1:${port}/tools`;
      try {
        await invoke('open_url', { url });
        this.flashChip(url);
      } catch (e) {
        this.flashChip(`tools open failed: ${errorText(e)}`);
      }
      return;
    }
    // spec 139: user-triggered handoff. #handoff writes a resume-ready handoff_set
    // doc; #resume reads it back and continues. One-shot injection only — no
    // always-on stub, no per-turn cost. Guard like #new for user-facing feedback;
    // enqueueSystemPrompt re-checks lane.client + idle status internally.
    if (parts[0] === '#handoff' || parts[0] === '#resume') {
      this.setDraft(lane, '', 0);
      if (!this.harnessMemoryId) {
        this.flashChip(this.harnessMemoryWarning ? `memory unavailable: ${truncate(this.harnessMemoryWarning, 72)}` : 'memory unavailable - use #new');
        return;
      }
      if (lane.status !== 'idle' && lane.status !== 'awaiting_peer') {
        this.flashChip('lane busy - #cancel first');
        return;
      }
      const prompt = parts[0] === '#handoff' ? HANDOFF_WRITE_PROMPT : handoffResumePrompt(lane.displayName);
      await this.enqueueSystemPrompt(lane, prompt, undefined, parts[0] === '#handoff' ? 'writing handoff' : 'resuming');
      return;
    }
    // spec 144: #wiki ingests the current conversation into the repo's docs/wiki/;
    // #recall answers a question from it read-only. One-shot like #handoff, but
    // guarded on projectDir (writes/reads repo files, not the memory store).
    // Draft is cleared before validation, so a rejected command still consumes the
    // typed text — intentional, matching #handoff.
    if (parts[0] === '#wiki') {
      this.setDraft(lane, '', 0);
      if (!this.projectDir) {
        this.flashChip('no project dir - cannot build wiki');
        return;
      }
      if (lane.status !== 'idle' && lane.status !== 'awaiting_peer') {
        this.flashChip('lane busy - #cancel first');
        return;
      }
      const hint = text.trim().slice('#wiki'.length).trim();
      await this.enqueueSystemPrompt(lane, wikiIngestPrompt(hint), undefined, 'saving to wiki');
      return;
    }
    if (parts[0] === '#recall') {
      this.setDraft(lane, '', 0);
      if (!this.projectDir) {
        this.flashChip('no project dir - no wiki to read');
        return;
      }
      const question = text.trim().slice('#recall'.length).trim();
      if (!question) {
        this.flashChip('usage: #recall <question>');
        return;
      }
      if (lane.status !== 'idle' && lane.status !== 'awaiting_peer') {
        this.flashChip('lane busy - #cancel first');
        return;
      }
      await this.enqueueSystemPrompt(lane, wikiRecallPrompt(question), undefined, 'recalling wiki');
      return;
    }
    // spec 161: #directive authors a reusable directive by having the lane edit
    // acp-harness.toml with its own file tools (the directive_* MCP tools were
    // removed). One-shot injection like #wiki — tokens cost only when invoked.
    if (parts[0] === '#directive') {
      this.setDraft(lane, '', 0);
      const intent = text.trim().slice('#directive'.length).trim();
      if (!intent) {
        this.flashChip('usage: #directive <what to create/change>');
        return;
      }
      if (lane.status !== 'idle' && lane.status !== 'awaiting_peer') {
        this.flashChip('lane busy - #cancel first');
        return;
      }
      let configPath = '~/.config/krypton/acp-harness.toml';
      try {
        configPath = await getAcpHarnessConfigPath();
      } catch (e) {
        console.warn('[acp-harness] config path lookup failed, using default:', e);
      }
      await this.enqueueSystemPrompt(lane, directivePrompt(configPath, intent), undefined, 'authoring directive');
      return;
    }
    // spec 196: one-shot tldraw Offline local-agent workflow. The lane uses its
    // existing shell tools and permission policy; Krypton never receives the
    // app's token or writes the native document format.
    if (parts[0] === '#draw') {
      this.setDraft(lane, '', 0);
      const intent = text.trim().slice('#draw'.length).trim();
      if (!intent) {
        this.flashChip('usage: #draw <drawing request>');
        return;
      }
      if (lane.status !== 'idle' && lane.status !== 'awaiting_peer') {
        this.flashChip('lane busy - #cancel first');
        return;
      }
      await this.enqueueSystemPrompt(lane, tldrawDrawPrompt(intent), undefined, 'drawing in tldraw');
      return;
    }
    if (parts[0] === '#review') {
      this.setDraft(lane, '', 0);
      await this.runReviewCommand(lane, parts.slice(1));
      this.render();
      return;
    }
    if (parts[0] === '#polly') {
      this.setDraft(lane, '', 0);
      const task = parsePollyTask(text);
      await this.runPollyCommand(lane, task);
      this.render();
      return;
    }
    // spec 180: #orchestrator — designate the active lane the orchestrator seat
    // (if none yet) and open the in-app console. Behavior-neutral: it injects no
    // prompt; autonomy stays opt-in via #polly.
    if (parts[0] === '#orchestrator' || parts[0] === '#console') {
      this.setDraft(lane, '', 0);
      this.openOrchestratorConsole(lane);
      this.render();
      return;
    }
    if (parts[0] === '#debby') {
      this.setDraft(lane, '', 0);
      const question = parseDebbyTask(text);
      await this.runDebbyCommand(lane, question);
      this.render();
      return;
    }
    if (parts[0] === '#salty') {
      this.setDraft(lane, '', 0);
      await this.runSaltyCommand(lane, parseSaltyCommand(text));
      this.render();
      return;
    }
    if (parts[0] === '#unqueue') {
      this.setDraft(lane, '', 0); // consume the command text on every branch
      this.unqueuePrompt(lane, parts[1]);
      this.render();
      return;
    }
    if (parts[0] === '#queue') {
      this.setDraft(lane, '', 0);
      this.runQueueCommand(lane, parts.slice(1));
      this.render();
      return;
    }
    // spec 178: dispatch a GitHub issue fix to a FRESH lane (control-op — spawns a
    // lane, sets its goal, clears its session). Metadata via local `gh`; URL-only
    // fallback when gh is absent. This is NOT the #fix-github-issue prompt-verb.
    if (parts[0] === '#dispatch-github-issue') {
      this.setDraft(lane, '', 0);
      // spec 194: with no args, dispatch the shared working ticket.
      const ticket = this.activeTicket;
      const ref =
        this.parseIssueRef(parts.slice(1).join(' ')) ??
        (parts.length === 1 && ticket
          ? { repo: ticket.repo, number: ticket.number, url: ticket.issueUrl }
          : null);
      if (!ref) {
        this.flashChip(`usage: ${parts[0]} <issue url | owner/repo#123> (or set one with #ticket)`);
        return;
      }
      const issueKey = `${ref.repo}#${ref.number}`;
      this.flashChip(`fetching ${issueKey}…`);
      try {
        // dispatchIssue resolves the title via `gh` itself (single fetch site).
        const res = await this.dispatchIssue({
          issueKey,
          issueUrl: ref.url,
          repo: ref.repo,
          number: ref.number,
          targetLane: '__new__',
        });
        this.flashChip(`fixing ${issueKey} → ${res.lane}`);
      } catch (e) {
        this.flashChip(`dispatch-github-issue failed: ${errorText(e)}`);
      }
      return;
    }
    // spec 191: composable GitHub-issue prompt-verbs. Each injects a one-shot prompt
    // into THIS lane (the lane does the work with its own gh/edit tools); the composed
    // #create-github-issue files a NEW issue from free text (no existing ref).
    if (parts[0] === '#create-github-issue') {
      this.setDraft(lane, '', 0);
      await this.runCreateGithubIssue(lane, parts.slice(1));
      return;
    }
    // #handle-github-issue embeds the others as tokens, resolved into one prompt.
    if (parts[0] === '#analyze-github-issue') {
      this.setDraft(lane, '', 0);
      await this.runGithubIssuePromptVerb(lane, 'analyze-github-issue', parts.slice(1));
      return;
    }
    if (parts[0] === '#fix-github-issue') {
      this.setDraft(lane, '', 0);
      await this.runGithubIssuePromptVerb(lane, 'fix-github-issue', parts.slice(1));
      return;
    }
    if (parts[0] === '#tag-github-issue') {
      this.setDraft(lane, '', 0);
      await this.runGithubIssuePromptVerb(lane, 'tag-github-issue', parts.slice(1));
      return;
    }
    if (parts[0] === '#post-github-comment') {
      this.setDraft(lane, '', 0);
      await this.runGithubIssuePromptVerb(lane, 'post-github-comment', parts.slice(1));
      return;
    }
    if (parts[0] === '#handle-github-issue') {
      this.setDraft(lane, '', 0);
      await this.runGithubIssuePromptVerb(lane, 'handle-github-issue', parts.slice(1));
      return;
    }
    this.flashChip('unknown command');
  }

  /** spec 191: run a composable GitHub-issue prompt-verb. Parses the issue ref from
   *  `args[0]` (URL or owner/repo#123), builds the verb's prompt, resolves any
   *  embedded verb tokens (composed verbs), and injects it as a one-shot prompt into
   *  the current lane. The lane does the work with its own tools; the harness observes
   *  via issue_progress + auto-bind (spec 190). */
  private async runGithubIssuePromptVerb(
    lane: HarnessLane,
    verb: 'analyze-github-issue' | 'fix-github-issue' | 'tag-github-issue' | 'post-github-comment' | 'handle-github-issue',
    args: string[],
  ): Promise<void> {
    let ref = this.parseIssueRef(args[0] ?? '');
    // Args after the ref token are verb payload (labels for #tag-github-issue).
    let payload = args.slice(1);
    if (!ref && this.activeTicket) {
      // spec 194: a no-ref verb resolves to the shared working ticket. No ref
      // token was consumed, so ALL args are payload.
      ref = { repo: this.activeTicket.repo, number: this.activeTicket.number, url: this.activeTicket.issueUrl };
      payload = args;
    }
    if (!ref) {
      this.flashChip(`usage: #${verb} <issue url | owner/repo#123> (or set one with #ticket)`);
      return;
    }
    if (lane.status !== 'idle' && lane.status !== 'awaiting_peer') {
      this.flashChip('lane busy - #cancel first');
      return;
    }
    const input: GithubIssueVerbInput = {
      issueKey: `${ref.repo}#${ref.number}`,
      repo: ref.repo,
      number: ref.number,
      url: ref.url,
    };
    let prompt: string;
    let label: string;
    switch (verb) {
      case 'analyze-github-issue':
        prompt = analyzeGithubIssuePrompt(input);
        label = 'analyzing issue';
        break;
      case 'fix-github-issue':
        prompt = fixGithubIssuePrompt(input);
        label = 'fixing issue';
        break;
      case 'tag-github-issue':
        prompt = tagGithubIssuePrompt(input, payload);
        label = 'labelling issue';
        break;
      case 'post-github-comment':
        prompt = postGithubCommentPrompt(input);
        label = 'commenting on issue';
        break;
      case 'handle-github-issue':
        prompt = handleGithubIssuePrompt(input);
        label = 'handling issue';
        break;
    }
    try {
      prompt = resolveVerbTokens(prompt, injectableVerbPrompt);
    } catch (e) {
      this.flashChip(`#${verb}: ${errorText(e)}`);
      return;
    }
    await this.enqueueSystemPrompt(lane, prompt, undefined, label);
  }

  /** Create a NEW GitHub issue from a plain-language request. Args are the free-text
   *  description, with an optional `-R owner/repo` flag naming the target repo (else the
   *  lane infers it from the current git remote). Unlike the other issue verbs this does
   *  not reference an existing issue, so it uses no issue ref. */
  private async runCreateGithubIssue(lane: HarnessLane, args: string[]): Promise<void> {
    let repo: string | undefined;
    const rest: string[] = [];
    for (let i = 0; i < args.length; i++) {
      if ((args[i] === '-R' || args[i] === '--repo') && i + 1 < args.length) {
        repo = args[++i];
      } else {
        rest.push(args[i]);
      }
    }
    const description = rest.join(' ').trim();
    if (!description) {
      this.flashChip('usage: #create-github-issue <what to file> [-R owner/repo]');
      return;
    }
    if (lane.status !== 'idle' && lane.status !== 'awaiting_peer') {
      this.flashChip('lane busy - #cancel first');
      return;
    }
    const prompt = createGithubIssuePrompt(description, repo);
    await this.enqueueSystemPrompt(lane, prompt, undefined, 'creating issue');
  }

  /** spec 136: #unqueue [N] — remove the last queued item, or the 1-indexed N. */
  private unqueuePrompt(lane: HarnessLane, arg: string | undefined): void {
    if (lane.queuedPrompts.length === 0) {
      this.flashChip('nothing queued');
      return;
    }
    if (arg === undefined) {
      lane.queuedPrompts.pop();
      this.flashChip(`unqueued (${lane.queuedPrompts.length} left)`);
      return;
    }
    const n = parseQueueIndex(arg);
    if (n === null || n > lane.queuedPrompts.length) {
      this.flashChip(`no item ${arg}`);
      return;
    }
    lane.queuedPrompts.splice(n - 1, 1);
    this.flashChip(`unqueued ${n} (${lane.queuedPrompts.length} left)`);
  }

  /** spec 136: #queue { clear | edit N }. */
  private runQueueCommand(lane: HarnessLane, args: string[]): void {
    const sub = args[0];
    if (sub === 'clear') {
      const n = lane.queuedPrompts.length;
      lane.queuedPrompts = [];
      this.flashChip(n > 0 ? `queue cleared (${n})` : 'queue empty');
      return;
    }
    if (sub === 'edit') {
      this.editQueuedPrompt(lane, args[1]);
      return;
    }
    this.flashChip('queue: #queue clear | #queue edit N | #unqueue [N]');
  }

  /** spec 136: #queue edit N — pop item N into the composer to edit and re-send.
   *  The command text was the live draft (intended overwrite); only an image-only
   *  draft is a real clobber risk, so guard on staged images, not draft text. */
  private editQueuedPrompt(lane: HarnessLane, arg: string | undefined): void {
    const n = parseQueueIndex(arg);
    if (n === null || n > lane.queuedPrompts.length) {
      this.flashChip(arg === undefined ? 'usage: #queue edit N' : `no item ${arg}`);
      return;
    }
    if (lane.stagedImages.length > 0) {
      this.flashChip('clear staged image first');
      return;
    }
    const [item] = lane.queuedPrompts.splice(n - 1, 1);
    this.setDraft(lane, item.text, item.text.length);
    lane.stagedImages = item.images.slice();
    this.flashChip(`editing queued ${n} — re-send to re-queue`);
  }

  private async printMcpStatus(lane: HarnessLane): Promise<void> {
    await this.refreshMcpStats();
    const lines: string[] = [];
    if (!this.harnessMemoryId || !this.harnessMemoryPort) {
      lines.push(`mcp: harness memory unavailable${this.harnessMemoryWarning ? ` - ${this.harnessMemoryWarning}` : ''}`);
      lines.push('lanes continue without the krypton-harness-memory MCP server');
    } else {
      lines.push(`mcp endpoint: http://127.0.0.1:${this.harnessMemoryPort}/mcp/harness/${this.harnessMemoryId}/lane/<laneLabel>`);
      lines.push('');
      lines.push('lane                  init  list  call  last');
      for (const l of this.lanes) {
        const s = this.mcpStatsByLane.get(l.displayName);
        const init = s?.initializeCount ?? 0;
        const list = s?.toolsListCount ?? 0;
        const call = s?.toolsCallCount ?? 0;
        const last = s?.lastSeenAt ? formatShortTime(s.lastSeenAt) : '—';
        const flag = list > 0 ? '✓' : '—';
        lines.push(
          `${flag} ${l.displayName.padEnd(20).slice(0, 20)} ${String(init).padStart(4)}  ${String(list).padStart(4)}  ${String(call).padStart(4)}  ${last}`,
        );
      }
      lines.push('');
      lines.push('✓ = adapter listed tools at least once. — = adapter never queried this lane.');
    }
    this.appendTranscript(lane, 'system', lines.join('\n'));
  }

  private async runShellCommand(lane: HarnessLane, command: string): Promise<void> {
    if (lane.pendingShellId) {
      this.flashChip('shell already running');
      return;
    }
    const id = makeId();
    const item = this.appendTranscript(lane, 'shell', `$ ${command}\n…`);
    item.status = 'pending';
    lane.pendingShellId = id;
    this.render();
    let output: string;
    let status: 'completed' | 'failed';
    try {
      const result = await invoke<string>('run_shell', {
        id,
        command,
        cwd: this.projectDir,
      });
      output = result;
      status = 'completed';
    } catch (e) {
      output = String(e);
      status = 'failed';
    }
    if (lane.pendingShellId === id) lane.pendingShellId = null;
    const trimmed = output.replace(/\s+$/, '');
    item.text = trimmed ? `$ ${command}\n${trimmed}` : `$ ${command}`;
    item.status = status;
    this.render();
  }

  private async cancelShell(lane: HarnessLane): Promise<void> {
    const id = lane.pendingShellId;
    if (!id) return;
    try {
      await invoke('kill_shell', { id });
    } catch (e) {
      this.appendTranscript(lane, 'system', `kill_shell failed: ${String(e)}`);
      this.render();
    }
  }

  private render(): void {
    this.renderRaf = false;
    this.element.classList.toggle('acp-harness--transcript-focus', this.focus === 'transcript');
    this.element.classList.toggle('acp-harness--zen', this.zenMode);
    this.element.classList.toggle('acp-harness--concise', this.conciseMode);
    this.element.classList.toggle('acp-harness--memory-open', this.memoryDrawerOpen);
    this.applyActiveLaneAccent();
    this.renderDashboard();
    this.renderMemory();
    this.renderHelp();
    this.renderPlanPanel(this.activeLane());
    this.renderPicker();
    this.renderDirectivePicker();
    this.renderModelPicker();
    this.renderSessionPicker();
    this.renderTriageGaugeEl();
    this.renderTriageOverlayEl();
    this.renderActiveLaneQueue();
    this.renderPinSlot();
    this.renderComposer();
    // Collapse/restore the orchestrator console around whichever modal render()
    // just opened or closed (lane/session/directive/model picker, help, memory).
    this.syncOrchestratorConsoleVisibility();
    this.scheduleStickyScroll();
  }

  private scheduleLaneRender(lane: HarnessLane): void {
    if (lane.id !== this.activeLaneId) {
      this.refreshMetricsRender();
      return;
    }
    if (this.renderRaf) return;
    this.renderRaf = true;
    requestAnimationFrame(() => {
      this.renderRaf = false;
      this.renderActiveLane(lane);
    });
  }

  private isLaneStreaming(lane: HarnessLane): boolean {
    return lane.currentAssistantId !== null
      || lane.currentThoughtId !== null
      || lane.currentUserId !== null;
  }

  // Spec 114 rev 4: text chunks update only the transcript body (+ one
  // sticky scroll write). Lane chrome, composer, peek, and plan are not
  // rebuilt on every streaming chunk.
  private scheduleStreamingBodyOnly(lane: HarnessLane): void {
    if (lane.id !== this.activeLaneId) {
      this.refreshMetricsRender();
      return;
    }
    if (this.streamingBodyRaf) return;
    this.streamingBodyRaf = true;
    requestAnimationFrame(() => {
      this.streamingBodyRaf = false;
      if (lane.id !== this.activeLaneId) return;
      this.renderActiveTranscript(lane);
      if (this.isLaneStreaming(lane)) {
        this.applyStickyScroll();
      } else {
        this.scheduleStickyScroll();
      }
    });
  }

  private renderActiveLane(lane: HarnessLane): void {
    if (lane.id !== this.activeLaneId) {
      this.render();
      return;
    }
    this.element.classList.toggle('acp-harness--transcript-focus', this.focus === 'transcript');
    this.element.classList.toggle('acp-harness--zen', this.zenMode);
    this.element.classList.toggle('acp-harness--concise', this.conciseMode);
    this.element.classList.toggle('acp-harness--memory-open', this.memoryDrawerOpen);
    this.renderActiveLaneChrome(lane);
    this.renderActiveTranscript(lane);
    this.renderLanePeek();
    this.renderPlanPanel(lane);
    this.renderActiveLaneQueue();
    this.renderPinSlot();
    this.renderComposer();
    this.scheduleStickyScroll();
  }

  /** spec 136: render the ACTIVE lane's prompt queue into the bottom rail slot.
   *  Shown independently of the peek; hidden only when empty. The bottom rail
   *  lives inside the active lane shell, which renders in zen too, so the queue
   *  follows the active lane there as well. Numbered drain-order rows, ▸ head
   *  marker (dimmed when the queue is held/paused), per-item →lane / img×N tags. */
  private renderActiveLaneQueue(): void {
    const slot = this.queueSlotEl;
    const lane = this.activeLane();
    if (!lane || lane.queuedPrompts.length === 0) {
      slot.replaceChildren();
      slot.hidden = true;
      return;
    }
    const held = lane.status === 'awaiting_peer';
    const paused = lane.status === 'error';
    const stateSuffix = held ? ' · held behind lane mail' : paused ? ' · paused' : '';
    const rows = lane.queuedPrompts
      .map((q, i) => {
        const isNext = i === 0 && !held && !paused;
        const marker = isNext ? '▸1' : String(i + 1);
        const tags: string[] = [];
        if (q.mentionTargets.length > 0) {
          const extra = q.mentionTargets.length - 1;
          tags.push(
            `<span class="acp-harness__lane-queue-tag">→${esc(q.mentionTargets[0])}${extra > 0 ? ` +${extra}` : ''}</span>`,
          );
        }
        if (q.images.length > 0) {
          tags.push(`<span class="acp-harness__lane-queue-tag">img×${q.images.length}</span>`);
        }
        return (
          `<li class="acp-harness__lane-queue-row${isNext ? ' acp-harness__lane-queue-row--next' : ''}">` +
          `<span class="acp-harness__lane-queue-n">${esc(marker)}</span>` +
          `<span class="acp-harness__lane-queue-body">${esc(q.text)}</span>` +
          tags.join('') +
          `</li>`
        );
      })
      .join('');
    const el = document.createElement('div');
    el.className = `acp-harness__lane-queue${held || paused ? ' acp-harness__lane-queue--held' : ''}`;
    el.style.setProperty('--acp-lane-accent', lane.accent);
    el.innerHTML =
      `<div class="acp-harness__lane-queue-head">⏎ queue (${lane.queuedPrompts.length})${stateSuffix}</div>` +
      `<ol class="acp-harness__lane-queue-list">${rows}</ol>` +
      `<div class="acp-harness__lane-queue-hint">#unqueue · #queue clear</div>`;
    slot.replaceChildren(el);
    slot.hidden = false;
  }

  private renderActiveLaneChrome(lane: HarnessLane): void {
    const laneEl = this.dashboardEl.querySelector<HTMLElement>(`[data-lane-id="${CSS.escape(lane.id)}"]`);
    if (!laneEl) {
      this.render();
      return;
    }
    laneEl.className = `acp-harness__lane acp-harness__lane--active acp-harness__lane--${lane.status}`;
    laneEl.style.setProperty('--acp-lane-accent', lane.accent);
    const head = laneEl.querySelector<HTMLElement>('.acp-harness__lane-head');
    if (head) {
      const laneSession = lane.client?.sessionId ?? null;
      const laneMetrics = laneSession !== null ? this.metricsBySession.get(laneSession) ?? null : null;
      head.innerHTML = renderLaneHead(
        lane,
        true,
        this.mcpStatsByLane.get(lane.displayName) ?? null,
        laneMetrics,
        this.coordinator.inboxDepth(lane.id),
        this.coordinator.pendingPeersFor(lane.id),
        lane.id === this.orchestratorLaneId,
      );
    }
    const stats = laneEl.querySelector<HTMLElement>('.acp-harness__lane-stats');
    if (stats) stats.innerHTML = renderLaneStats(lane, this.projectDir);
    if (this.zenMode) this.refreshZenRail();
  }

  private expandTranscriptWindow(lane: HarnessLane): void {
    const total = lane.transcript.length;
    const current = lane.transcriptWindow;
    let next: number;
    if (!Number.isFinite(current)) {
      next = TRANSCRIPT_WINDOW_DEFAULT;
    } else {
      const candidate = current + TRANSCRIPT_WINDOW_STEP;
      next = candidate >= total ? Number.POSITIVE_INFINITY : candidate;
    }
    lane.transcriptWindow = next;
    // Suppress row-entrance animations for rows that are about to enter the
    // DOM because the window grew — they're not "new" to the conversation.
    for (const item of lane.transcript) lane.seenTranscriptIds.add(item.id);
    const label = Number.isFinite(next) ? `transcript window: ${next} rows` : 'transcript window: all rows';
    this.flashChip(label);
    this.scheduleLaneRender(lane);
  }

  private renderActiveTranscript(lane: HarnessLane): void {
    const body = this.activeTranscriptBody();
    if (!body) {
      this.render();
      return;
    }
    const anchor = lane.stickToBottom ? null : this.captureTranscriptScrollAnchor(body);
    const existing = new Map<string, HTMLElement>();
    for (const el of body.querySelectorAll<HTMLElement>('.acp-harness__msg[data-msg-id]')) {
      const id = el.dataset.msgId;
      if (id) existing.set(id, el);
    }
    const expected = new Set<string>();
    if (lane.transcript.length === 0) {
      body.innerHTML = '';
      const empty = document.createElement('div');
      empty.className = 'acp-harness__transcript-empty';
      empty.textContent = 'lane transcript will appear here';
      body.appendChild(empty);
      return;
    }
    const empty = body.querySelector('.acp-harness__transcript-empty');
    if (empty) empty.remove();
    const total = lane.transcript.length;
    const windowSize = lane.transcriptWindow;
    const start = Number.isFinite(windowSize) ? Math.max(0, total - windowSize) : 0;
    const hidden = start;
    const itemsToRender: HarnessTranscriptItem[] = [];
    if (hidden > 0) {
      itemsToRender.push({
        id: HIDDEN_INDICATOR_ID,
        kind: 'system',
        text: `↑ ${hidden} earlier row${hidden === 1 ? '' : 's'} hidden — Ctrl+H show ${TRANSCRIPT_WINDOW_STEP} more`,
      });
      // Keep the indicator visually static (no row-entrance fade) even on
      // its first appearance.
      lane.seenTranscriptIds.add(HIDDEN_INDICATOR_ID);
    }
    for (let i = start; i < total; i++) itemsToRender.push(lane.transcript[i]);
    // Spec 117: tail-window invariant. The streaming assistant row must be in
    // itemsToRender while the parser is bound. If it ever falls out (e.g. a
    // future spec inserts rows after a still-current assistant such that the
    // window slides past it), tear down the parser to avoid mutating an
    // orphaned subtree. Dev-build warning only.
    if (
      lane.streamingMarkdownParser !== null &&
      lane.streamingMarkdownItemId !== null &&
      !itemsToRender.some((entry) => entry.id === lane.streamingMarkdownItemId)
    ) {
      console.warn('[spec117] streaming row outside tail window; tearing down parser');
      lane.streamingMarkdownParser = null;
      lane.streamingMarkdownBody = null;
      lane.streamingMarkdownItemId = null;
    }
    let previous: ChildNode | null = null;
    for (const item of itemsToRender) {
      expected.add(item.id);
      const streaming =
        item.id === lane.currentAssistantId ||
        item.id === lane.currentThoughtId ||
        item.id === lane.currentUserId;
      const isNew = !lane.seenTranscriptIds.has(item.id);
      const current = existing.get(item.id) ?? null;

      // Spec 114 rev 4: append-only streaming fast path (assistant / thought /
      // user). Must run BEFORE the signature compare — stable 'stream'
      // signature would otherwise no-op and freeze visible text.
      const streamingTextRow =
        item.id === lane.currentAssistantId ||
        item.id === lane.currentThoughtId ||
        item.id === lane.currentUserId;
      if (
        current &&
        streaming &&
        streamingTextRow &&
        (item.kind === 'assistant' || item.kind === 'thought' ||
          (item.kind === 'user' && !(item.imageCount && item.imageCount > 0)))
      ) {
        const body = current.querySelector<HTMLElement>('.acp-harness__msg-body');
        if (body) {
          // Spec 117: assistant rows use the streaming-markdown parser; thought
          // and user rows keep the Spec 114 plain-text appendData path.
          if (item.kind === 'assistant') {
            updateStreamingAssistantMarkdownBody(body, item, lane);
          } else {
            updateStreamingTextBody(body, item);
          }
          current.dataset.renderSignature = 'stream';
          lane.seenTranscriptIds.add(item.id);
          previous = current;
          continue;
        }
      }

      const signature = transcriptRenderSignature(item, streaming);
      const isIndicator = item.id === HIDDEN_INDICATOR_ID;
      if (current) {
        if (current.dataset.renderSignature === signature) {
          previous = current;
        } else {
          const next = renderTranscriptItem(item, false, streaming, lane, this.projectDir);
          if (isIndicator) next.classList.add('acp-harness__msg--hidden-indicator');
          if (streaming) {
            current.className = next.className;
            current.dataset.renderSignature = signature;
            current.replaceChildren(...Array.from(next.childNodes));
            previous = current;
          } else {
            current.replaceWith(next);
            previous = next;
          }
        }
      } else {
        const next = renderTranscriptItem(item, isNew, streaming, lane, this.projectDir);
        if (isIndicator) next.classList.add('acp-harness__msg--hidden-indicator');
        if (previous?.nextSibling) body.insertBefore(next, previous.nextSibling);
        else body.appendChild(next);
        previous = next;
      }
      lane.seenTranscriptIds.add(item.id);
    }
    for (const [id, el] of existing) {
      if (!expected.has(id)) el.remove();
    }
    if (anchor) {
      this.restoreTranscriptScrollAnchor(body, anchor);
      lane.savedScrollAnchor = this.captureTranscriptScrollAnchor(body) ?? anchor;
    }
    this.observeActiveTranscriptBody();
    this.schedulePretextLayout();
  }

  private renderLanePeek(): void {
    const now = Date.now();
    this.maybeRecordLaneMetricSamples(now);
    const slot = this.peekSlotEl;
    const snapshots = this.lanePeekSnapshots();
    const candidate = this.bestLanePeekCandidate({ snapshots });
    if (!candidate || !this.lanePeek.visible) {
      slot.replaceChildren();
      slot.hidden = true;
      return;
    }
    this.applyLanePeekCandidate(candidate, false);
    const snapshot = snapshots.find((s) => s.laneId === candidate.laneId) ?? null;
    const next = renderLanePeek(candidate, snapshot, this.lanePeek.lockedLaneId === candidate.laneId);
    const heatRoot = next.querySelector<HTMLElement>('.acp-harness__lane-peek-heat-root');
    const activeLane = this.lanes.find((lane) => lane.id === this.activeLaneId) ?? null;
    const peekLane = this.lanes.find((lane) => lane.id === candidate.laneId) ?? null;
    if (heatRoot && activeLane && peekLane) {
      this.mountLanePeekHeat(heatRoot, candidate, activeLane, peekLane, now);
    }
    slot.replaceChildren(next);
    slot.hidden = false;
  }

  private isLanePeekHeatUiAvailable(): boolean {
    return this.lanePeek.visible && this.bestLanePeekCandidate() !== null;
  }

  private effectivePeekHeatWindow(candidate: LanePeekCandidate): LanePeekHeatWindow {
    if (this.lanePeekHeatWindowExplicit !== null) return this.lanePeekHeatWindowExplicit;
    return isDirectPeerPeekReasonKey(candidate.reasonKey) ? '30s' : '5m';
  }

  private lanePeekHeatInput(lane: HarnessLane): LanePeekHeatLaneInput {
    return {
      id: lane.id,
      displayName: lane.displayName,
      status: lane.status,
      transcript: lane.transcript,
      usage: lane.usage,
      pendingShell: lane.pendingShellId !== null,
      pendingPeerCount: this.coordinator.pendingPeersFor(lane.id).length,
      metricHistory: this.laneMetricHistory.get(lane.id) ?? [],
    };
  }

  private maybeRecordLaneMetricSamples(now: number): void {
    if (now - this.lanePeekHeatLastGlobalSample < LANE_PEEK_HEAT_SAMPLE_MIN_MS) return;
    this.lanePeekHeatLastGlobalSample = now;
    for (const lane of this.lanes) {
      if (lane.status === 'stopped') continue;
      this.appendLaneMetricSample(lane, now);
    }
  }

  private appendLaneMetricSample(lane: HarnessLane, now: number): void {
    const sessionId = lane.client?.sessionId ?? null;
    const m = sessionId !== null ? this.metricsBySession.get(sessionId) ?? null : null;
    const u = lane.usage;
    const sample: LaneActivitySample = {
      at: now,
      usageUsed: typeof u?.used === 'number' && Number.isFinite(u.used) ? u.used : null,
      cpuPercent:
        m && Number.isFinite(m.total_cpu_percent) ? Math.max(0, m.total_cpu_percent) : null,
      rssMb: m && Number.isFinite(m.total_rss_mb) ? m.total_rss_mb : null,
    };
    const arr = this.laneMetricHistory.get(lane.id) ?? [];
    arr.push(sample);
    while (arr.length > LANE_PEEK_HEAT_RING_MAX || (arr.length > 0 && arr[0].at < now - LANE_PEEK_HEAT_RING_MS)) {
      arr.shift();
    }
    this.laneMetricHistory.set(lane.id, arr);
  }

  private mountLanePeekHeat(
    root: HTMLElement,
    candidate: LanePeekCandidate,
    activeLane: HarnessLane,
    peekLane: HarnessLane,
    now: number,
  ): void {
    root.replaceChildren();
    const win = this.effectivePeekHeatWindow(candidate);
    const summary = deriveLanePairHeat(
      this.lanePeekHeatInput(activeLane),
      this.lanePeekHeatInput(peekLane),
      now,
      win,
      this.lanePeekHeatMetric,
    );
    root.style.setProperty('--acp-peek-heat-active', activeLane.accent);
    root.style.setProperty('--acp-peek-heat-peek', peekLane.accent);

    const wrap = document.createElement('section');
    wrap.className = 'acp-harness__lane-peek-heat';
    if (summary.unavailableReason) {
      wrap.title = summary.unavailableReason;
    }

    const compact = document.createElement('div');
    compact.className = 'acp-harness__lane-peek-heat-compact';

    const prefix = document.createElement('span');
    prefix.className = 'acp-harness__lane-peek-heat-prefix';
    prefix.textContent = 'heat';

    const metricBtn = document.createElement('button');
    metricBtn.type = 'button';
    metricBtn.className = 'acp-harness__lane-peek-heat-cmd';
    metricBtn.textContent = this.lanePeekHeatMetric;
    metricBtn.title = 'Cycle peek heat metric (click or command palette)';
    metricBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      this.cyclePeekHeatMetric();
    });

    const sep = document.createElement('span');
    sep.className = 'acp-harness__lane-peek-heat-sep';
    sep.textContent = '·';

    const winBtn = document.createElement('button');
    winBtn.type = 'button';
    winBtn.className = 'acp-harness__lane-peek-heat-cmd';
    winBtn.textContent = win;
    winBtn.title = 'Cycle peek heat time window (click or command palette)';
    winBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      this.cyclePeekHeatWindow();
    });

    const bars = document.createElement('div');
    bars.className = 'acp-harness__lane-peek-heat-bars';

    const mkSide = (side: LaneHeatSide, which: 'active' | 'peek'): HTMLElement => {
      const col = document.createElement('div');
      col.className = 'acp-harness__lane-peek-heat-side';
      const fullName = which === 'active' ? activeLane.displayName : peekLane.displayName;
      col.title = `${which === 'active' ? 'Active' : 'Peeked'}: ${fullName}`;
      const tag = document.createElement('span');
      tag.className =
        `acp-harness__lane-peek-heat-tag acp-harness__lane-peek-heat-tag--${which}`;
      tag.textContent = which === 'active' ? 'active' : 'peek';
      const row = document.createElement('div');
      row.className = 'acp-harness__lane-peek-heat-bar-row';
      const track = document.createElement('div');
      track.className = 'acp-harness__lane-peek-heat-track';
      const fill = document.createElement('div');
      fill.className =
        `acp-harness__lane-peek-heat-fill acp-harness__lane-peek-heat-fill--${which}`;
      fill.style.width = `${Math.min(100, Math.max(0, side.score))}%`;
      track.appendChild(fill);
      const score = document.createElement('span');
      score.className = 'acp-harness__lane-peek-heat-score';
      score.textContent = String(side.score);
      row.appendChild(track);
      row.appendChild(score);
      col.appendChild(tag);
      col.appendChild(row);
      return col;
    };

    bars.appendChild(mkSide(summary.active, 'active'));
    bars.appendChild(mkSide(summary.peeked, 'peek'));

    const delta = document.createElement('div');
    delta.className = 'acp-harness__lane-peek-heat-delta';
    delta.textContent = summary.deltaLine;

    compact.appendChild(prefix);
    compact.appendChild(metricBtn);
    compact.appendChild(sep);
    compact.appendChild(winBtn);
    compact.appendChild(bars);
    compact.appendChild(delta);

    compact.addEventListener('click', () => {
      this.togglePeekHeatDetail();
    });

    const expanded = document.createElement('div');
    expanded.className = 'acp-harness__lane-peek-heat-expanded';
    expanded.hidden = !this.lanePeekHeatExpanded;
    const table = document.createElement('table');
    table.className = 'acp-harness__lane-peek-heat-table';
    const caption = document.createElement('caption');
    caption.className = 'acp-harness__lane-peek-heat-caption';
    caption.textContent = 'Heat detail';
    table.appendChild(caption);
    const head = document.createElement('tr');
    for (const label of ['', 'active', 'peek']) {
      const th = document.createElement('th');
      th.scope = label === '' ? 'col' : 'col';
      th.textContent = label;
      head.appendChild(th);
    }
    table.appendChild(head);
    const tokStr = (s: LaneHeatSide): string => {
      if (s.tokenDelta === null) return '—';
      return `+${formatHeatTokenSuffix(s.tokenDelta)}`;
    };
    const cpuStr = (s: LaneHeatSide): string => {
      if (s.cpuPeak === null) return '—';
      return `${Math.round(s.cpuPeak)}%`;
    };
    const addRow = (key: string, a: string, b: string): void => {
      const tr = document.createElement('tr');
      const k = document.createElement('th');
      k.scope = 'row';
      k.textContent = key;
      const c1 = document.createElement('td');
      c1.textContent = a;
      const c2 = document.createElement('td');
      c2.textContent = b;
      tr.appendChild(k);
      tr.appendChild(c1);
      tr.appendChild(c2);
      table.appendChild(tr);
    };
    addRow('tools', String(summary.active.toolDelta), String(summary.peeked.toolDelta));
    addRow('tokens', tokStr(summary.active), tokStr(summary.peeked));
    addRow('peer', String(summary.active.peerDelta), String(summary.peeked.peerDelta));
    addRow('cpu', cpuStr(summary.active), cpuStr(summary.peeked));
    expanded.appendChild(table);

    wrap.appendChild(compact);
    wrap.appendChild(expanded);
    root.appendChild(wrap);
  }

  private bestLanePeekCandidate(options: { force?: boolean; snapshots?: LanePeekSnapshot[] } = {}): LanePeekCandidate | null {
    const snapshots = options.snapshots ?? this.lanePeekSnapshots();
    const candidates = buildLanePeekCandidates(snapshots, Date.now());
    if (shouldPreemptPeekDismissal(candidates, this.lanePeek.dismissedAt)) {
      this.lanePeek.visible = true;
      this.lanePeek.dismissedAt = null;
      this.lanePeek.dismissedPriority = null;
    }
    const best = selectLanePeekCandidate(
      candidates,
      {
        currentLaneId: this.lanePeek.currentLaneId,
        lockedLaneId: this.lanePeek.lockedLaneId,
        selectedAt: this.lanePeek.selectedAt,
        dismissedAt: options.force ? null : this.lanePeek.dismissedAt,
        dismissedPriority: options.force ? null : this.lanePeek.dismissedPriority,
      },
      Date.now(),
    );
    if (!best) return null;
    if (!options.force && !this.lanePeek.visible && this.lanePeek.dismissedAt !== null) {
      this.lanePeek.visible = true;
      this.lanePeek.dismissedAt = null;
      this.lanePeek.dismissedPriority = null;
    }
    return best;
  }

  private lanePeekCandidates(): LanePeekCandidate[] {
    return buildLanePeekCandidates(this.lanePeekSnapshots(), Date.now());
  }

  private lanePeekSnapshots(): LanePeekSnapshot[] {
    const now = Date.now();
    return this.lanes.map((lane, index) => {
      const sessionId = lane.client?.sessionId ?? null;
      const metrics = sessionId !== null ? this.metricsBySession.get(sessionId) ?? null : null;
      const mcp = this.mcpStatsByLane.get(lane.displayName) ?? null;
      return {
        laneId: lane.id,
        displayName: lane.displayName,
        status: lane.status,
        active: lane.id === this.activeLaneId,
        stopped: lane.status === 'stopped',
        visualIndex: index,
        inboxDepth: this.coordinator.inboxDepth(lane.id),
        pendingPeers: this.coordinator.pendingPeersFor(lane.id),
        latestInterLane: latestInterLaneForPeek(lane),
        latestPermission: latestPermissionForPeek(lane),
        latestMeaningful: latestMeaningfulForPeek(lane),
        error: lane.error,
        modelName: lane.modelName,
        usage: lane.usage,
        metrics,
        mcp,
        plan: derivePlanForPeek(lane),
        activeTool: deriveActiveToolForPeek(lane, now),
        activeTurnStartedAt: lane.activeTurnStartedAt,
        recentFiles: deriveRecentFilesForPeek(lane.id, this.fileTouchMap, now),
        pendingShell: lane.pendingShellId !== null,
      };
    });
  }

  private applyLanePeekCandidate(candidate: LanePeekCandidate, force: boolean): void {
    if (
      force ||
      this.lanePeek.currentLaneId !== candidate.laneId ||
      this.lanePeek.currentReasonKey !== candidate.reasonKey
    ) {
      this.lanePeek.currentLaneId = candidate.laneId;
      this.lanePeek.currentReasonKey = candidate.reasonKey;
      this.lanePeek.selectedAt = Date.now();
    }
  }

  private refreshZenRail(): void {
    const railEl = this.dashboardEl.querySelector<HTMLElement>('.acp-harness__rail');
    if (!railEl) return;
    railEl.replaceChildren();
    for (const lane of this.lanes) {
      railEl.appendChild(this.renderRailEntry(lane, lane.id === this.activeLaneId));
    }
  }

  private renderPicker(): void {
    this.pickerEl.hidden = !this.pickerOpen;
    if (!this.pickerOpen) {
      this.pickerEl.innerHTML = '';
      return;
    }
    const total = this.pickerEntries.length;
    const cursor = total === 0 ? 0 : Math.max(0, Math.min(this.pickerCursor, total - 1));
    const counts = new Map<string, number>();
    for (const lane of this.lanes) {
      counts.set(lane.backendId, (counts.get(lane.backendId) ?? 0) + 1);
    }
    const rows = this.pickerEntries
      .map((entry, i) => {
        const label = backendLabel(entry.id);
        const running = counts.get(entry.id) ?? 0;
        const runningSuffix = running > 0 ? ` <span class="acp-harness__picker-count">·${running} running</span>` : '';
        const active = i === cursor ? ' acp-harness__picker-row--active' : '';
        return `<li class="acp-harness__picker-row${active}" data-picker-index="${i}">` +
          `<span class="acp-harness__picker-label">${esc(label)}</span>` +
          `<span class="acp-harness__picker-id">${esc(entry.id)}</span>` +
          runningSuffix +
          `</li>`;
      })
      .join('');
    const empty = total === 0
      ? '<div class="acp-harness__picker-empty">no ACP backends installed</div>'
      : '';
    // spec 163: when the picker was opened by Shift+Enter from the directive
    // picker, surface which directive the spawned lane will carry.
    const pendingDirective = this.pendingSpawnDirectiveId
      ? this.directiveById(this.pendingSpawnDirectiveId)
      : null;
    const headLabel = pendingDirective
      ? `// add lane · directive: ${esc(pendingDirective.title || pendingDirective.id)}`
      : '// add lane';
    this.pickerEl.innerHTML =
      `<header class="acp-harness__picker-head">` +
      `<span>${headLabel}</span>` +
      `<span>j/k move · enter spawn · esc cancel</span>` +
      `</header>` +
      `<ul class="acp-harness__picker-list">${rows}</ul>${empty}`;
  }

  private renderDirectivePicker(): void {
    this.directivePickerEl.hidden = !this.directivePickerOpen;
    if (!this.directivePickerOpen) {
      this.directivePickerEl.innerHTML = '';
      return;
    }
    const lane = this.activeLane();
    if (!lane) {
      this.directivePickerEl.innerHTML = '';
      return;
    }
    const ordered = this.pickerDirectives();
    const total = ordered.length;
    const cursor = total === 0 ? 0 : Math.max(0, Math.min(this.directivePickerCursor, total - 1));
    const currentId = lane.pendingDirectiveChange
      ? lane.pendingDirectiveChange.directiveId
      : lane.activeDirectiveId;
    const rows = ordered
      .map((d, i) => {
        const active = i === cursor ? ' acp-harness__directive-row--active' : '';
        const state = d.enabled ? '' : ' acp-harness__directive-row--disabled';
        const assigned = d.id === currentId ? '<span class="acp-harness__directive-assigned">assigned</span>' : '';
        const badgeEl = d.enabled ? '' : '<span class="acp-harness__directive-badge">disabled</span>';
        // spec 130: keep legacy triage metadata visible, but it no longer gates
        // attention_flag visibility. Concise picker: a glyph only (full label in
        // the title tooltip), so it costs no row width when scanning many rows.
        const triageEl = d.triage_equipped
          ? '<span class="acp-harness__directive-badge acp-harness__directive-badge--triage" title="legacy triage metadata; attention tools are default-on">◆</span>'
          : '';
        // Single-line row: icon · title · badges · dimmed truncated description,
        // so many directives stay scannable without scrolling. The id and task
        // (dev-facing detail) move to the preview head, not each row.
        const desc = d.description
          ? `<span class="acp-harness__directive-desc">${esc(d.description)}</span>`
          : '';
        return (
          `<li class="acp-harness__directive-row${active}${state}" data-directive-index="${i}">` +
          `<span class="acp-harness__directive-icon">${esc(d.icon)}</span>` +
          `<span class="acp-harness__directive-title">${esc(d.title || d.id)}</span>` +
          `${assigned}${badgeEl}${triageEl}${desc}` +
          `</li>`
        );
      })
      .join('');
    const selected = ordered[cursor];
    const selectedMeta = selected ? [selected.id, selected.task].filter(Boolean).join(' · ') : '';
    const preview = selected
      ? `<div class="acp-harness__directive-preview">` +
        `<div class="acp-harness__directive-preview-head">` +
        `<span>// prompt</span>` +
        `<span class="acp-harness__directive-preview-scope">${esc(selectedMeta)}</span>` +
        `</div>` +
        `<div class="acp-harness__directive-preview-body">${esc(selected.system_prompt || '(empty prompt)')}</div>` +
        `</div>`
      : '';
    this.directivePickerEl.innerHTML =
      `<header class="acp-harness__directive-head">` +
      `<span>// directive · ${esc(lane.displayName)}</span>` +
      `<span>j/k move · enter switch · shift+enter new lane · backspace clear · esc cancel</span>` +
      `</header>` +
      `<ul class="acp-harness__directive-list">${rows}</ul>` +
      preview;
  }

  private renderModelPicker(): void {
    this.modelPickerEl.hidden = !this.modelPickerOpen;
    if (!this.modelPickerOpen) {
      this.modelPickerEl.innerHTML = '';
      return;
    }
    const lane = this.modelPickerLane();
    if (!lane) {
      this.modelPickerEl.innerHTML = '';
      return;
    }
    const models = lane.availableModels;
    const total = models.length;
    const cursor = total === 0 ? 0 : Math.max(0, Math.min(this.modelPickerCursor, total - 1));
    const rows = models
      .map((m, i) => {
        const active = i === cursor ? ' acp-harness__model-row--active' : '';
        const current = m.model_id === lane.currentModelId
          ? '<span class="acp-harness__model-current">✓</span>'
          : '';
        return (
          `<li class="acp-harness__model-row${active}" data-model-index="${i}">` +
          `<span class="acp-harness__model-name">${esc(m.name)}${current}</span>` +
          (m.description ? `<span class="acp-harness__model-desc">${esc(m.description)}</span>` : '') +
          `</li>`
        );
      })
      .join('');
    this.modelPickerEl.innerHTML =
      `<header class="acp-harness__model-head">` +
      `<span>// model · ${esc(lane.displayName)}</span>` +
      `<span>j/k move · enter switch · esc cancel</span>` +
      `</header>` +
      `<ul class="acp-harness__model-list">${rows}</ul>`;
  }

  private renderSessionPicker(): void {
    const state = this.sessionPicker;
    this.sessionPickerEl.hidden = !state.open;
    if (!state.open) {
      this.sessionPickerEl.innerHTML = '';
      return;
    }
    const backendName = state.backendId ? backendLabel(state.backendId) : 'backend';
    if (state.phase === 'backend') {
      const rows = this.pickerEntries.map((entry, i) => {
        const active = i === state.backendCursor ? ' acp-harness__session-row--active' : '';
        const running = this.lanes.filter((lane) => lane.backendId === entry.id).length;
        return `<li class="acp-harness__session-row${active}" data-session-backend="${esc(entry.id)}">` +
          `<span class="acp-harness__session-title">${esc(backendLabel(entry.id))}</span>` +
          `<span class="acp-harness__session-meta">${esc(entry.id)}</span>` +
          `<span class="acp-harness__session-action">${running > 0 ? `${running} running` : 'select'}</span>` +
          `</li>`;
      }).join('');
      this.sessionPickerEl.innerHTML =
        `<header class="acp-harness__session-head">` +
        `<span>// resume session</span>` +
        `<span>j/k move · enter list · esc cancel</span>` +
        `</header>` +
        `<ul class="acp-harness__session-list">${rows}</ul>`;
      return;
    }
    if (state.phase === 'loading') {
      this.sessionPickerEl.innerHTML =
        `<header class="acp-harness__session-head">` +
        `<span>// ${esc(backendName)} sessions</span>` +
        `<span>initializing...</span>` +
        `</header>` +
        `<div class="acp-harness__session-empty">loading sessions</div>`;
      return;
    }
    if (state.phase === 'error') {
      this.sessionPickerEl.innerHTML =
        `<header class="acp-harness__session-head">` +
        `<span>// ${esc(backendName)} sessions</span>` +
        `<span>b switch backend · n fresh · esc cancel</span>` +
        `</header>` +
        `<div class="acp-harness__session-empty">${esc(state.error ?? 'session list unavailable')}</div>`;
      return;
    }
    const capabilities = state.capabilities;
    const canOpen = !!capabilities && (capabilities.canResume || capabilities.canLoad);
    const action = capabilities?.canResume ? 'resume' : capabilities?.canLoad ? 'load' : 'list only';
    const rows = state.sessions.map((session, i) => {
      const active = i === state.sessionCursor ? ' acp-harness__session-row--active' : '';
      const disabled = canOpen ? '' : ' acp-harness__session-row--disabled';
      const title = session.title?.trim() || 'untitled session';
      const metaParts = [shortId(session.sessionId)];
      const updated = formatSessionUpdatedAt(session.updatedAt);
      if (updated) metaParts.push(updated);
      if (session.cwd && this.projectDir && normalizePathForCompare(session.cwd) !== normalizePathForCompare(this.projectDir)) {
        metaParts.push(session.cwd);
      }
      return `<li class="acp-harness__session-row${active}${disabled}">` +
        `<span class="acp-harness__session-title">${esc(title)}</span>` +
        `<span class="acp-harness__session-meta">${esc(metaParts.join(' · '))}</span>` +
        `<span class="acp-harness__session-action">${esc(action)}</span>` +
        `</li>`;
    }).join('');
    const empty = state.sessions.length === 0
      ? '<div class="acp-harness__session-empty">no sessions for this project</div>'
      : '';
    const pageHint = state.nextCursor ? ' · PageDown more' : '';
    const error = state.error ? `<div class="acp-harness__session-error">${esc(state.error)}</div>` : '';
    this.sessionPickerEl.innerHTML =
      `<header class="acp-harness__session-head">` +
      `<span>// ${esc(backendName)} sessions</span>` +
      `<span>enter ${esc(action)} · b backend · n fresh${pageHint} · esc cancel</span>` +
      `</header>` +
      `<ul class="acp-harness__session-list">${rows}</ul>${empty}${error}`;
  }

  private renderDashboard(): void {
    // Preserve the active lane body's DOM identity across the rebuild so the
    // browser's real scroll position and any in-flight streaming layout stay
    // intact. Detach before clearing dashboardEl, reattach inside the new
    // active lane shell. renderActiveTranscript then diffs its children.
    const prevBody = this.activeTranscriptBody();
    const prevBodyLaneId =
      prevBody?.dataset.laneId ?? prevBody?.parentElement?.dataset.laneId ?? null;
    if (prevBody) {
      prevBody.dataset.laneId = prevBodyLaneId ?? prevBody.dataset.laneId ?? '';
      prevBody.parentElement?.removeChild(prevBody);
    }

    this.dashboardEl.innerHTML = '';
    if (this.lanes.length === 0) {
      const empty = document.createElement('div');
      empty.className = 'acp-harness__empty';
      empty.textContent = this.systemRows.join('\n') || 'no ACP lanes';
      this.dashboardEl.appendChild(empty);
      return;
    }

    let railEl: HTMLElement | null = null;
    let bodyCell: HTMLElement | null = null;
    if (this.zenMode) {
      railEl = document.createElement('aside');
      railEl.className = 'acp-harness__rail';
      bodyCell = document.createElement('div');
      bodyCell.className = 'acp-harness__body-cell';
      this.dashboardEl.appendChild(railEl);
      this.dashboardEl.appendChild(bodyCell);
      for (const lane of this.lanes) {
        const active = lane.id === this.activeLaneId;
        railEl.appendChild(this.renderRailEntry(lane, active));
      }
    }

    for (const lane of this.lanes) {
      const active = lane.id === this.activeLaneId;
      if (this.zenMode && !active) continue;
      const laneEl = document.createElement(active ? 'section' : 'div');
      laneEl.className = `acp-harness__lane ${active ? 'acp-harness__lane--active' : 'acp-harness__lane--collapsed'} acp-harness__lane--${lane.status}`;
      laneEl.dataset.laneId = lane.id;
      laneEl.style.setProperty('--acp-lane-accent', active ? lane.accent : 'rgba(216, 232, 216, 0.42)');
      const head = document.createElement('header');
      head.className = 'acp-harness__lane-head';
      const laneSession = lane.client?.sessionId ?? null;
      const laneMetrics = laneSession !== null ? this.metricsBySession.get(laneSession) ?? null : null;
      head.innerHTML = renderLaneHead(
        lane,
        active,
        this.mcpStatsByLane.get(lane.displayName) ?? null,
        laneMetrics,
        this.coordinator.inboxDepth(lane.id),
        this.coordinator.pendingPeersFor(lane.id),
        lane.id === this.orchestratorLaneId,
      );
      laneEl.appendChild(head);
      if (active) {
        const stats = document.createElement('div');
        stats.className = 'acp-harness__lane-stats';
        stats.innerHTML = renderLaneStats(lane, this.projectDir);
        laneEl.appendChild(stats);
        let body: HTMLElement;
        if (prevBody && prevBodyLaneId === lane.id) {
          body = prevBody;
        } else {
          body = document.createElement('div');
          body.className = 'acp-harness__lane-body';
          body.dataset.laneId = lane.id;
        }
        laneEl.appendChild(body);
        this.laneRailEl.parentElement?.removeChild(this.laneRailEl);
        laneEl.appendChild(this.laneRailEl);
      }
      (bodyCell ?? this.dashboardEl).appendChild(laneEl);
    }
    const activeLane = this.activeLane();
    if (activeLane) {
      this.renderActiveTranscript(activeLane);
      this.renderLanePeek();
    }
    this.observeActiveTranscriptBody();
    if (activeLane && activeLane.stickToBottom) {
      const body = this.activeTranscriptBody();
      if (body) {
        const token = this.beginProgrammaticScroll();
        body.scrollTop = body.scrollHeight;
        this.releaseProgrammaticScroll(token);
      }
    }
  }

  private renderRailEntry(lane: HarnessLane, active: boolean): HTMLElement {
    const entry = document.createElement('div');
    const now = Date.now();
    const peerHint = deriveRailPeerHint(
      {
        pendingPeers: this.coordinator.pendingPeersFor(lane.id),
        inboxDepth: this.coordinator.inboxDepth(lane.id),
        latestInterLane: latestInterLaneForPeek(lane),
      },
      (laneId) => this.lanes.find((l) => l.id === laneId)?.status ?? null,
      now,
    );

    // spec 124: directive state for the meta line. A pending change is
    // shown when it actually differs from the current binding — a swap
    // (directiveId → different id) or a clear (directiveId → null while a
    // directive is bound). For a pending clear the meta line keeps showing
    // the currently bound directive's name (with a strike on the icon) so
    // the user can see which directive is being removed.
    const pendingChange = lane.pendingDirectiveChange;
    const boundDirective = this.directiveById(lane.activeDirectiveId);
    const swapTarget =
      pendingChange && pendingChange.directiveId !== null && pendingChange.directiveId !== lane.activeDirectiveId
        ? this.directiveById(pendingChange.directiveId)
        : null;
    const isPendingClear = !!pendingChange && pendingChange.directiveId === null && !!boundDirective;
    const isPendingSwap = !!swapTarget;
    const metaDirective = swapTarget ?? boundDirective;
    const hasDirective = !!metaDirective;

    entry.className =
      `acp-harness__rail-entry acp-harness__rail-entry--${lane.status}` +
      (active ? ' acp-harness__rail-entry--active' : '') +
      (peerHint.kind !== 'none' ? ` acp-harness__rail-entry--peer-${peerHint.kind}` : '') +
      (hasDirective ? ' acp-harness__rail-entry--directive' : '') +
      (isPendingSwap || isPendingClear ? ' acp-harness__rail-entry--pending' : '');
    entry.style.setProperty('--acp-lane-accent', lane.accent);

    const toolCount = lane.toolCalls.size;
    const ctxUsed = typeof lane.usage?.used === 'number' ? lane.usage!.used : null;
    const toolHtml = toolCount > 0
      ? `<span class="acp-harness__rail-metric acp-harness__rail-metric--tools" title="${esc(`${toolCount} tool call${toolCount === 1 ? '' : 's'}`)}">${esc(formatCount(toolCount))}</span>`
      : '';
    const ctxHtml = ctxUsed !== null
      ? `<span class="acp-harness__rail-metric acp-harness__rail-metric--ctx" title="${esc(typeof lane.usage?.size === 'number' && lane.usage!.size! > 0 ? `context ${ctxUsed}/${lane.usage!.size} tokens` : `context ${ctxUsed} tokens`)}">${esc(formatCount(ctxUsed))}</span>`
      : '';
    const peerHtml = renderRailPeerSpans(peerHint);
    const titleBase = peerHint.title ? `${peerHint.title} · ` : '';
    const titleDirective = metaDirective
      ? ` · directive ${metaDirective.id}${isPendingSwap ? ' (next send)' : isPendingClear ? ' (clear next send)' : ''}`
      : '';
    entry.title = `${titleBase}${statusLabel(lane.status)}${titleDirective}`;

    const headHtml =
      `<span class="acp-harness__rail-head">` +
      `<span class="acp-harness__rail-name">${esc(lane.displayName)}</span>` +
      peerHtml +
      toolHtml +
      ctxHtml +
      `</span>`;

    // spec 125 — meta line replaces the user-icon with a role tag chip and
    // trimmed title. The tag carries the pending-clear strike (previously on
    // the icon span) via `--clearing`.
    let metaHtml: string;
    if (metaDirective) {
      const role = directiveRole(metaDirective.task);
      const tagLabel = directiveTagLabel(metaDirective.task);
      const tagCls = isPendingClear ? ' acp-harness__rail-tag--clearing' : '';
      const trimmedRaw = trimBackendPrefix(metaDirective.title.trim(), lane.backendId);
      const title = trimmedRaw || metaDirective.title.trim() || metaDirective.id;
      const pendingHint = isPendingSwap
        ? '<span class="acp-harness__rail-meta__hint">· next send</span>'
        : isPendingClear
          ? '<span class="acp-harness__rail-meta__hint">· clear next send</span>'
          : '';
      metaHtml =
        `<span class="acp-harness__rail-meta">` +
        `<span class="acp-harness__rail-tag acp-harness__rail-tag--${role}${tagCls}">${esc(tagLabel)}</span>` +
        `<span class="acp-harness__rail-meta__title">${esc(title)}</span>` +
        pendingHint +
        `</span>`;
    } else {
      const permissionMeta = lane.status === 'needs_permission' && lane.pendingPermissions.length > 0
        ? compactPermissionMeta(lane.pendingPermissions[0])
        : statusLabel(lane.status);
      metaHtml =
        `<span class="acp-harness__rail-meta">` +
        `<span class="acp-harness__rail-meta__hint">${esc(permissionMeta)}</span>` +
        `</span>`;
    }

    const logoId = backendLogoId(lane.backendId);
    const logoCls =
      lane.backendId === 'pi-acp' ? 'pi' : (BACKEND_LABELS[lane.backendId] ? lane.backendId : 'omp');
    const logoHtml =
      `<span class="acp-harness__rail-logo acp-harness__rail-logo--${logoCls}" aria-hidden="true">` +
      `<svg><use href="#${logoId}"/></svg>` +
      `</span>`;

    entry.innerHTML =
      `<span class="acp-harness__rail-dot"></span>` +
      logoHtml +
      headHtml +
      metaHtml;
    return entry;
  }

  private renderMemory(): void {
    this.memoryOverlayEl.hidden = !this.memoryDrawerOpen;
    const head = this.memoryOverlayEl.querySelector('.acp-harness__memory-head');
    if (head) {
      head.textContent = this.harnessMemoryWarning
        ? 'Memory · unavailable'
        : `Memory · ${this.memoryEntries.length} entries`;
    }
    this.memoryPanelEl.innerHTML = '';
    if (this.harnessMemoryWarning) {
      const empty = document.createElement('div');
      empty.className = 'acp-harness__memory-empty';
      empty.textContent = `memory unavailable: ${this.harnessMemoryWarning}`;
      this.memoryPanelEl.appendChild(empty);
      return;
    }
    const rows = this.sortedMemoryRows();
    if (rows.length === 0) {
      const empty = document.createElement('div');
      empty.className = 'acp-harness__memory-empty';
      empty.textContent = 'no memory yet';
      this.memoryPanelEl.appendChild(empty);
      return;
    }
    if (!this.memoryCursorRowId || !rows.some((entry) => entry.lane === this.memoryCursorRowId)) {
      this.memoryCursorRowId = rows[0]?.lane ?? null;
    }
    for (const entry of rows) {
      const row = document.createElement('div');
      const selected = entry.lane === this.memoryCursorRowId;
      row.className = `acp-harness__memory-row${selected ? ' acp-harness__memory-row--cursor' : ''}`;
      row.dataset.memoryLane = entry.lane;
      row.innerHTML =
        `<span class="acp-harness__memory-source" style="--acp-memory-accent:${esc(laneAccentForLabel(entry.lane))}">${esc(entry.lane)}</span>` +
        `<span class="acp-harness__memory-text">${esc(entry.summary)}</span>` +
        `<span class="acp-harness__memory-kind">${esc(formatShortTime(entry.updatedAt))}</span>` +
        (selected ? `<div class="acp-harness__memory-detail">${esc(entry.detail)}</div>` : '');
      this.memoryPanelEl.appendChild(row);
    }
  }

  private renderComposer(): void {
    const lane = this.activeLane();
    if (!lane) {
      this.composerEl.textContent = 'no lanes';
      return;
    }
    if (lane.pendingPermissions.length > 0) {
      // The pending request's command/subject already renders in the transcript
      // permission row directly above; repeating it here just prints the command
      // twice. The composer is the decision surface, so it carries only the
      // "perm" prompt label and the action buttons.
      this.composerEl.className = 'acp-harness__composer acp-harness__composer--permission';
      this.composerEl.style.setProperty('--acp-lane-accent', lane.accent);
      this.composerEl.innerHTML =
        `<div class="acp-harness__composer-meta">perm</div>` +
        `<div class="acp-harness__permission-options">a accept · A all · r reject · R all · Esc</div>`;
      return;
    }
    this.composerEl.className =
      `acp-harness__composer${this.focus === 'transcript' ? ' acp-harness__composer--command' : ''}` +
      `${this.memoryDrawerOpen ? ' acp-harness__composer--memory' : ''}`;
    const chip = this.chip ?? this.composerStatusChip(lane);
    const chipClass = `acp-harness__memory-chip${!this.chip && lane.status === 'busy' ? ' acp-harness__memory-chip--running' : ''}`;
    const projectStatus = this.renderComposerProjectStatus();
    const before = lane.draft.slice(0, lane.cursor);
    const after = lane.draft.slice(lane.cursor);
    this.composerEl.style.setProperty('--acp-lane-accent', lane.accent);
    let staging = '';
    if (lane.stagedImages.length > 0) {
      const chips = lane.stagedImages
        .map((img, index) => {
          const label = img.path ? basename(img.path) : img.mimeType;
          return (
            `<div class="acp-harness__staged-image">` +
            `<img class="acp-harness__staged-thumb" src="data:${img.mimeType};base64,${img.data}" alt="" />` +
            `<span class="acp-harness__staged-label">${esc(label)}</span>` +
            `<button class="acp-harness__staged-remove" type="button" data-remove-staged-image="${index}" title="Remove image">x</button>` +
            `</div>`
          );
        })
        .join('');
      const hint = `${lane.stagedImages.length} image${lane.stagedImages.length === 1 ? '' : 's'} · Esc to clear`;
      staging = `<div class="acp-harness__staging">${chips}<span class="acp-harness__staging-hint">${esc(hint)}</span></div>`;
    }
    const mentionPalette = this.renderMentionPalette(lane);
    const palette = renderSlashPalette(lane);
    const hashPalette = this.renderHashPalette(lane);
    const inlineVerbPalette = this.renderInlineVerbPalette(lane);
    const peerStrip = buildComposerPeerStrip(
      lane.status,
      this.coordinator.pendingPeersFor(lane.id),
      this.coordinator.inboxDepth(lane.id),
    );
    this.composerEl.innerHTML =
      `<div class="acp-harness__composer-meta">` +
      `<span class="${chipClass}">${esc(chip)}</span>` +
      // spec 157: persistent token explaining why tool detail is absent — the
      // flag survives reopen, so the cue must too.
      (this.conciseMode ? `<span class="acp-harness__concise-tag">concise</span>` : '') +
      renderPollyBypassChip(lane) +
      renderSaltyBypassChip(lane) +
      this.renderDirectiveChip(lane) +
      projectStatus +
      `</div>` +
      peerStrip +
      staging +
      mentionPalette +
      palette +
      hashPalette +
      inlineVerbPalette +
      `<div class="acp-harness__input-line">` +
      `<span class="acp-harness__lane-tag">${esc(lane.displayName)}</span>` +
      `<span class="acp-harness__prompt">${lane.status === 'busy'
        ? `<span class="acp-harness__spinner">${SPINNER_FRAMES[0]}</span>`
        : SPINNER_FRAMES[0]}</span>` +
      `<span class="acp-harness__input">${esc(before)}<span class="acp-harness__caret">█</span>${esc(after)}</span>` +
      `<span class="acp-harness__help-hint">? help</span></div>`;
  }

  /** spec 148/194: ticket + goal pins in the lane rail's top slot (same surface
   *  cluster as the lane peek — moved out of the composer). Rendered on
   *  lane/state changes only, never per keystroke; hidden when neither is set. */
  private renderPinSlot(): void {
    const lane = this.activeLane();
    if (lane) this.pinSlotEl.style.setProperty('--acp-lane-accent', lane.accent);
    const html = this.renderTicketBar() + (lane ? this.renderGoalBar(lane) : '');
    this.pinSlotEl.innerHTML = html;
    this.pinSlotEl.hidden = html === '';
  }

  /** spec 148: static goal-bar in the rail pin slot, shown only when the
   *  active lane has a focus-scope goal. Quiet depth indicator — never blinks. The
   *  age is a snapshot refreshed on each render, deliberately NOT driven by a live
   *  1s ticker (an idle lane with a goal must not keep the rail re-rendering —
   *  idle CPU budget). Minutes-granularity makes the staleness invisible in practice. */
  private renderGoalBar(lane: HarnessLane): string {
    if (!lane.goal) return '';
    const age = formatAge(Date.now() - lane.goal.setAt);
    return (
      `<div class="acp-harness__goal-bar">` +
      `<span class="acp-harness__goal-age">${esc(age)}</span>` +
      `<span class="acp-harness__goal-label">◎ goal</span>` +
      `<span class="acp-harness__goal-text">${esc(lane.goal.text)}</span>` +
      `</div>`
    );
  }

  /** spec 194: harness-scoped working-ticket bar, sibling of the goal bar in the
   *  rail pin slot. Shown while a ticket is set regardless of the active lane —
   *  the ticket is shared. Quiet, never blinks (same budget as the goal bar). */
  private renderTicketBar(): string {
    const t = this.activeTicket;
    if (!t) return '';
    const title = t.title && t.title !== t.issueKey ? t.title : '';
    const state = t.state === 'closed' ? ' · closed' : '';
    return (
      `<div class="acp-harness__ticket-bar">` +
      `<span class="acp-harness__ticket-rev">r${t.revision}${state}</span>` +
      `<span class="acp-harness__ticket-label">⬡ ticket</span>` +
      `<span class="acp-harness__ticket-body">` +
      `<span class="acp-harness__ticket-key">${esc(t.issueKey)}</span>` +
      (title ? ` <span class="acp-harness__ticket-title">${esc(title)}</span>` : '') +
      `</span>` +
      `</div>`
    );
  }

  /** Composer directive chip: clickable, opens the picker. Keyboard users use
   * `Cmd+P → /`. Shows the pending (deferred) directive when the lane is busy. */
  private renderDirectiveChip(lane: HarnessLane): string {
    const pendingChange = lane.pendingDirectiveChange;
    const pending = pendingChange !== null && pendingChange.directiveId !== lane.activeDirectiveId;
    const id = pendingChange ? pendingChange.directiveId : lane.activeDirectiveId;
    const directive = this.directiveById(id);
    const label = directive ? directive.id : 'none';
    const cls = `acp-harness__directive-chip${directive ? ' acp-harness__directive-chip--set' : ''}${pending ? ' acp-harness__directive-chip--pending' : ''}`;
    const suffix = pending ? ' (next send)' : '';
    // spec 130: all harness-memory lanes may flag by default. Keep showing
    // legacy directive metadata when present so older directive files stay
    // legible.
    const source = this.triageSource(lane);
    const triageTag = lane.triageEquipped
      ? ` <span class="acp-harness__directive-chip__triage" title="attention triage ${source}; tools are available when this lane has harness memory MCP">◆ ${source}</span>`
      : '';
    return `<span class="${cls}" data-open-directive-picker="1" title="Cmd+P then . to change">directive ${esc(label)}${suffix}${triageTag}</span>`;
  }

  private composerStatusChip(lane: HarnessLane): string {
    if (this.artifactHintMode) return 'open artifact: press label · Esc cancel';
    if (this.focus === 'transcript') return 'command mode: 1-9 lanes · ^M memory · f open artifact · ? help · i/Esc input';
    if (lane.status === 'busy') {
      const elapsed = lane.activeTurnStartedAt ? ` · ${formatElapsed(Date.now() - lane.activeTurnStartedAt)}` : '';
      // spec 156: live activity + output-token counter, re-read on each 1 s tick.
      const activity = lane.activity ? ` · ${formatLaneActivity(lane.activity)}` : '';
      const outputTokens = lane.usage?.outputTokens;
      const tokens = typeof outputTokens === 'number' && outputTokens > 0 ? ` · ${formatCount(outputTokens)} tok` : '';
      const queued = lane.queuedPrompts.length > 0 ? ` · ${lane.queuedPrompts.length} queued` : '';
      // Custom commands name the operation (reviewing / saving to wiki / …) so the
      // user can tell a #review in flight from an ordinary turn; else plain 'running'.
      const verb = lane.activeSystemLabel ?? 'running';
      return `${lane.displayName} ${verb}${elapsed}${activity}${tokens}${queued} · Ctrl+C cancel`;
    }
    if (lane.status === 'starting') {
      // Session is (re)initializing — the slowest sub-window of #goal/#new/#new!.
      // Cue it rather than falling through to the generic memory readout (Claude-2).
      return `${lane.displayName} starting…`;
    }
    const pending = this.coordinator.pendingPeersFor(lane.id);
    if (pending.length > 0 && (lane.status === 'awaiting_peer' || lane.status === 'idle')) {
      return `${lane.displayName} · ${awaitingPeerText(pending)}`;
    }
    if (lane.status === 'awaiting_peer') return `${lane.displayName} ${awaitingPeerText(pending)}`;
    if (this.harnessMemoryWarning) return `memory off: ${truncate(this.harnessMemoryWarning, 64)}`;
    return `memory: ${Math.min(this.memoryEntries.length, 10)}/${this.memoryEntries.length}`;
  }

  private updateComposerTick(): void {
    const shouldTick = this.lanes.some((lane) => {
      if (lane.status === 'busy' && lane.activeTurnStartedAt !== null) return true;
      if (this.coordinator.pendingPeersFor(lane.id).length > 0) return true;
      return lane.status === 'awaiting_peer';
    });
    if (shouldTick && this.composerTickTimer === null) {
      this.composerTickTimer = window.setInterval(() => this.renderComposer(), 1000);
    } else if (!shouldTick) {
      this.stopComposerTick();
    }
  }

  private stopComposerTick(): void {
    if (this.composerTickTimer === null) return;
    window.clearInterval(this.composerTickTimer);
    this.composerTickTimer = null;
  }

  /** Run a single braille-spinner interval whenever any lane is busy, advancing
   *  one shared frame counter and writing the glyph to every `.acp-harness__spinner`
   *  element in the view. Because the frame counter lives on the instance (not on
   *  the DOM nodes) and is re-applied to whatever spinners currently exist, the
   *  metrics-poll head rebuild and the composer tick can recreate those nodes
   *  without resetting the animation — the glyph just continues from the live
   *  frame on the next tick. */
  private updateSpinnerTicker(): void {
    const anyBusy = this.lanes.some((lane) => lane.status === 'busy');
    if (anyBusy && this.spinnerTimer === null) {
      this.spinnerTimer = window.setInterval(() => this.tickSpinner(), SPINNER_INTERVAL_MS);
    } else if (!anyBusy) {
      this.stopSpinnerTicker();
    }
  }

  private tickSpinner(): void {
    this.spinnerFrame = (this.spinnerFrame + 1) % SPINNER_FRAMES.length;
    const glyph = SPINNER_FRAMES[this.spinnerFrame];
    const spinners = this.element.querySelectorAll<HTMLElement>('.acp-harness__spinner');
    for (const el of spinners) el.textContent = glyph;
  }

  private stopSpinnerTicker(): void {
    if (this.spinnerTimer === null) return;
    window.clearInterval(this.spinnerTimer);
    this.spinnerTimer = null;
  }

  private updateToolTick(): void {
    // Spec 114: O(lanes) instead of O(lanes × rows). Counter mutated as
    // a before/after delta in `renderTool()` and adjusted on cap-shift
    // inside `appendTranscript()`.
    const hasActive = this.lanes.some((lane) => lane.activeToolCount > 0);
    if (hasActive && this.toolTickTimer === null) {
      this.toolTickTimer = window.setInterval(() => this.tickToolTimers(), 500);
    } else if (!hasActive && this.toolTickTimer !== null) {
      window.clearInterval(this.toolTickTimer);
      this.toolTickTimer = null;
    }
  }

  private tickToolTimers(): void {
    const now = performance.now();
    const nodes = this.dashboardEl.querySelectorAll<HTMLElement>('.acp-harness__tool-timer');
    for (const node of nodes) {
      if (node.dataset.endedAt !== undefined) continue;
      const startedAt = Number(node.dataset.startedAt);
      if (!Number.isFinite(startedAt)) continue;
      node.textContent = formatToolElapsed(now - startedAt);
    }
  }

  private startMetricsTick(): void {
    if (this.metricsTimer !== null) return;
    void this.pollMetrics();
    this.metricsTimer = window.setInterval(() => void this.pollMetrics(), METRICS_POLL_MS);
  }

  private stopMetricsTick(): void {
    if (this.metricsTimer === null) return;
    window.clearInterval(this.metricsTimer);
    this.metricsTimer = null;
  }

  private async pollMetrics(): Promise<void> {
    let entries: AcpLaneMetrics[];
    try {
      entries = await invoke<AcpLaneMetrics[]>('acp_get_lane_metrics');
    } catch {
      return;
    }
    const next = new Map<number, AcpLaneMetrics>();
    for (const m of entries) next.set(m.session, m);
    this.metricsBySession = next;
    // Lightweight refresh — only redraw chips and the breakdown panel,
    // not the whole transcript (which would thrash on every tick).
    this.refreshMetricsRender();
    // spec 169 (option A-hybrid): nudge the telemetry publisher so the dashboard's
    // CPU sparkline gets a fresh sample at the metrics cadence — but ONLY while a
    // lane is active, so an idle harness still makes zero periodic publishes and
    // keeps idle CPU < 1% (the one deliberate deviation from spec 168's no-tick rule).
    if (this.anyLaneActive()) this.telemetryPublisher?.schedule();
  }

  /** spec 169: any lane doing work whose resource draw is worth streaming. */
  private anyLaneActive(): boolean {
    return this.lanes.some(
      (lane) =>
        lane.status === 'busy' ||
        lane.status === 'needs_permission' ||
        lane.status === 'awaiting_peer',
    );
  }

  /** spec 169: current resource sample for a lane, mapping the publisher's string
   *  laneId → the lane's numeric ACP client session → metricsBySession. Null when
   *  the lane has no live client session or no metrics sample yet. */
  private laneResourceSample(laneId: string): LaneResourceSample | null {
    const lane = this.lanes.find((l) => l.id === laneId);
    const sessionId = lane?.client?.sessionId ?? null;
    if (sessionId === null) return null;
    const m = this.metricsBySession.get(sessionId);
    if (!m) return null;
    return {
      cpuPercent: m.total_cpu_percent,
      rssMb: m.total_rss_mb,
      procCount: m.proc_count,
      rootAlive: m.root_alive,
    };
  }

  private refreshMetricsRender(): void {
    for (const lane of this.lanes) {
      const sessionId = lane.client?.sessionId ?? null;
      const m = sessionId !== null ? this.metricsBySession.get(sessionId) ?? null : null;
      const head = this.dashboardEl.querySelector<HTMLElement>(
        `[data-lane-id="${CSS.escape(lane.id)}"] .acp-harness__lane-head`,
      );
      if (head) {
        const active = lane.id === this.activeLaneId;
        head.innerHTML = renderLaneHead(
          lane,
          active,
          this.mcpStatsByLane.get(lane.displayName) ?? null,
          m,
          this.coordinator.inboxDepth(lane.id),
          this.coordinator.pendingPeersFor(lane.id),
          lane.id === this.orchestratorLaneId,
        );
      }
    }
    if (this.metricsPanelOpen) this.renderMetricsPanel();
    this.renderLanePeek();
  }

  private toggleMetricsPanel(open?: boolean): void {
    const next = open ?? !this.metricsPanelOpen;
    if (next === this.metricsPanelOpen) return;
    this.metricsPanelOpen = next;
    this.renderMetricsPanel();
    this.syncOrchestratorConsoleVisibility();
  }

  private renderMetricsPanel(): void {
    this.metricsOverlayEl.hidden = !this.metricsPanelOpen;
    if (!this.metricsPanelOpen) return;
    const rows: string[] = [];
    rows.push(
      `<header class="acp-harness__metrics-head">` +
        `<span class="acp-harness__metrics-title">Lane Resource Usage</span>` +
        `<span class="acp-harness__metrics-hint">Esc to close · refreshes every ${(METRICS_POLL_MS / 1000).toFixed(0)}s</span>` +
      `</header>`,
    );
    for (const lane of this.lanes) {
      const sessionId = lane.client?.sessionId ?? null;
      const m = sessionId !== null ? this.metricsBySession.get(sessionId) ?? null : null;
      rows.push(this.renderMetricsLaneBlock(lane, m));
    }
    this.metricsOverlayEl.innerHTML = rows.join('');
  }

  private renderMetricsLaneBlock(lane: HarnessLane, m: AcpLaneMetrics | null): string {
    const totals = m && m.root_alive
      ? (
        `<span class="acp-harness__metrics-total acp-harness__metrics-total--cpu">CPU ${esc(formatCpu(m.total_cpu_percent))}</span>` +
        `<span class="acp-harness__metrics-total">MEM ${esc(formatRss(m.total_rss_mb))}</span>` +
        `<span class="acp-harness__metrics-total">${m.proc_count} proc${m.proc_count === 1 ? '' : 's'}</span>`
      )
      : `<span class="acp-harness__metrics-total acp-harness__metrics-total--dim">no live process</span>`;
    const head =
      `<div class="acp-harness__metrics-lane-head">` +
      `<span class="acp-harness__metrics-lane-name">${esc(lane.displayName)}</span>` +
      `<span class="acp-harness__metrics-lane-totals">${totals}</span>` +
      `</div>`;
    if (!m || !m.root_alive || m.proc_count === 0) return `<section class="acp-harness__metrics-lane">${head}</section>`;
    const tree = renderProcessTree(m);
    return `<section class="acp-harness__metrics-lane">${head}${tree}</section>`;
  }

  private renderComposerProjectStatus(): string {
    const cwd = this.projectDir ? abbreviatePath(this.projectDir) : 'no cwd';
    const branch = this.gitBranchLoading ? '...' : this.gitBranch;
    const title = this.projectDir ? `${this.projectDir}${this.gitBranch ? ` on ${this.gitBranch}` : ''}` : '';
    const branchChip = branch
      ? `<span class="acp-harness__project-branch">⎇ ${esc(branch)}</span>`
      : '';
    return (
      `<span class="acp-harness__project-status" title="${esc(title)}">` +
      `<span class="acp-harness__project-cwd">${esc(cwd)}</span>` +
      branchChip +
      `</span>`
    );
  }

  private renderHelp(): void {
    this.helpOverlayEl.hidden = !this.helpOpen;
    if (!this.helpOpen) return;
    this.helpOverlayEl.innerHTML = `
      <header class="acp-harness__help-head">
        <span>ACP Harness Help</span>
        <span>Esc / ? / q closes</span>
      </header>
      <div class="acp-harness__help-grid">
        <section class="acp-harness__help-section">
          <h3>Lane Control</h3>
          <dl>
            <dt>Cmd+P then +</dt><dd>Add lane (open backend picker)</dd>
            <dt>Cmd+P then _</dt><dd>Close active lane</dd>
            <dt>Cmd+P then =</dt><dd>Toggle lane metrics overlay</dd>
            <dt>Cmd+P then 0</dt><dd>Resume/load a project session for the active backend</dd>
            <dt>Ctrl+N / Ctrl+P</dt><dd>Next / previous lane</dd>
            <dt>Esc, then 1-9</dt><dd>Switch lane in transcript mode</dd>
            <dt>Esc, then ?</dt><dd>Open help</dd>
            <dt>Tab buttons</dt><dd>Click a lane directly</dd>
            <dt>Enter</dt><dd>Send prompt to active lane only</dd>
            <dt>Shift+Enter</dt><dd>Insert newline</dd>
            <dt>Ctrl+C</dt><dd>Cancel active busy lane</dd>
            <dt>Ctrl+Shift+J / Ctrl+Shift+K</dt><dd>Scroll transcript down / up (works in composer)</dd>
            <dt>Cmd+W</dt><dd>Close harness tab</dd>
            <dt>Cmd+.</dt><dd>Toggle Zen Mode</dd>
            <dt>Cmd+Shift+.</dt><dd>Toggle Concise Mode (tool cards collapse to one line)</dd>
          </dl>
        </section>
        <section class="acp-harness__help-section">
          <h3>Composer (readline)</h3>
          <dl>
            <dt>Ctrl+A / Ctrl+E</dt><dd>Begin / end of line</dd>
            <dt>Ctrl+B / Ctrl+F</dt><dd>Char back / forward</dd>
            <dt>Ctrl+Left / Ctrl+Right</dt><dd>Word back / forward</dd>
            <dt>Ctrl+H</dt><dd>Backspace</dd>
            <dt>Ctrl+D</dt><dd>Delete char forward</dd>
            <dt>Ctrl+W</dt><dd>Delete word backward (kill)</dd>
            <dt>Ctrl+U</dt><dd>Kill to start of line</dd>
            <dt>Ctrl+K</dt><dd>Kill to end of line</dd>
            <dt>Ctrl+Y</dt><dd>Yank last killed text</dd>
            <dt>Ctrl+T</dt><dd>Transpose chars around cursor</dd>
            <dt># / @ / /</dt><dd>Type at line start to autocomplete built-in #commands / @lanes / agent /commands · ↑↓ select, Tab completes</dd>
          </dl>
        </section>
        <section class="acp-harness__help-section">
          <h3>Permissions</h3>
          <dl>
            <dt>a</dt><dd>Accept current request once</dd>
            <dt>A</dt><dd>Accept all for current turn</dd>
            <dt>r</dt><dd>Reject current request once</dd>
            <dt>R</dt><dd>Reject all for current turn</dd>
            <dt>Esc</dt><dd>Reject / cancel request</dd>
          </dl>
        </section>
        <section class="acp-harness__help-section">
          <h3>Memory</h3>
          <dl>
            <dt>Ctrl+M</dt><dd>Toggle memory drawer</dd>
            <dt>q / Esc</dt><dd>Close memory drawer</dd>
            <dt>j / k</dt><dd>Move memory cursor</dd>
            <dt>g / G</dt><dd>Top / bottom of memory list</dd>
            <dt>Agents</dt><dd>Create, update, delete, search, and fetch detail through MCP tools</dd>
          </dl>
        </section>
        <section class="acp-harness__help-section">
          <h3>Transcript</h3>
          <dl>
            <dt>Esc</dt><dd>Focus active transcript scrolling</dd>
            <dt>i / Esc</dt><dd>Return to input composer</dd>
            <dt>1-9</dt><dd>Switch lane</dd>
            <dt>j / k</dt><dd>Scroll line by line</dd>
            <dt>Ctrl+d / Ctrl+u</dt><dd>Page down / up</dd>
            <dt>g / G</dt><dd>Top / bottom</dd>
            <dt>q</dt><dd>Close harness tab</dd>
          </dl>
        </section>
        <section class="acp-harness__help-section acp-harness__help-section--wide">
          <h3>Commands</h3>
          <dl>
            <dt>#cancel</dt><dd>Cancel active lane, same as Ctrl+C</dd>
            <dt>#new</dt><dd>Start fresh active lane, keep memory</dd>
            <dt>#new!</dt><dd>Start fresh active lane and clear its memory</dd>
            <dt>#goal &lt;text&gt;</dt><dd>Set a focus scope: clears the lane (keeps memory) and anchors it to this task</dd>
            <dt>#goal</dt><dd>Show the active goal · #goal clear removes it</dd>
            <dt>#review [&lt;lane&gt; …] [-- &lt;docpath | note&gt;]</dt><dd>Fan a review of your diff or a design doc out to other lanes (all live lanes if none named)</dd>
            <dt>#polly &lt;task&gt;</dt><dd>Polly orchestration from this lane — auto-spawns two other Cursor/Claude/Codex workers (orchestrator covers its own backend when in pool)</dd>
            <dt>#debby &lt;question&gt;</dt><dd>Debby brainstorming from this lane — auto-spawns Claude and Codex heads as plain responders</dd>
            <dt>#restart</dt><dd>Respawn active lane when error or stopped</dd>
            <dt>#mem</dt><dd>Show memory command hint</dd>
            <dt>#mem clear</dt><dd>Clear active lane memory only</dd>
            <dt>#handoff</dt><dd>Ask active lane to write a resume-ready handoff to its memory</dd>
            <dt>#resume</dt><dd>Ask active lane to read its memory handoff and continue</dd>
            <dt>#wiki [hint]</dt><dd>Compound this session into the project wiki (docs/wiki/)</dd>
            <dt>#recall &lt;question&gt;</dt><dd>Answer a question from the project wiki, with citations</dd>
            <dt>#directive &lt;intent&gt;</dt><dd>Have the active lane create/edit a reusable directive in acp-harness.toml</dd>
            <dt>#draw &lt;request&gt;</dt><dd>Draw in an open tldraw Offline document (focused or named) — static shapes or durable document scripts</dd>
            <dt>#mcp</dt><dd>Show MCP endpoint and lane status</dd>
            <dt>#queue [clear | edit N]</dt><dd>Manage prompts queued while the lane is busy</dd>
            <dt>#unqueue [N]</dt><dd>Remove the last (or Nth) queued prompt</dd>
            <dt>!cmd</dt><dd>Run shell command in project cwd, output goes to transcript</dd>
          </dl>
        </section>
        <section class="acp-harness__help-section acp-harness__help-section--wide">
          <h3>Model</h3>
          <p>Each lane is a separate ACP subprocess in the same project directory. Prompts go only to the active lane. Memory is tab-local, read-only for humans, and managed by agents through MCP tools.</p>
        </section>
      </div>
    `;
  }

  private appendTranscript(
    lane: HarnessLane,
    kind: HarnessTranscriptItem['kind'],
    text: string,
    metadata: Pick<HarnessTranscriptItem, 'imageCount'> = {},
  ): HarnessTranscriptItem {
    const item: HarnessTranscriptItem = { id: makeId(), kind, text, createdAt: Date.now(), ...metadata };
    lane.transcript.push(item);
    if (lane.transcript.length > 300) {
      const dropped = lane.transcript.shift();
      if (dropped) {
        lane.seenTranscriptIds.delete(dropped.id);
        // Spec 114: keep `activeToolCount` and the `toolTranscriptIds`
        // map in sync when the cap shifts a tool row out. Without this,
        // an active tool dropped from the prefix would leave the
        // spinner timer running forever and a late toolCall update for
        // the same id would resurrect a phantom row.
        if (dropped.kind === 'tool') {
          const wasActive = dropped.toolStartedAt !== undefined && dropped.toolEndedAt === undefined;
          if (wasActive && lane.activeToolCount > 0) lane.activeToolCount -= 1;
          for (const [callId, transcriptId] of lane.toolTranscriptIds) {
            if (transcriptId === dropped.id) {
              lane.toolTranscriptIds.delete(callId);
              break;
            }
          }
          if (SPEC114_DEV) assertActiveToolCount(lane);
        }
      }
    }
    return item;
  }

  private appendFsActivity(
    lane: HarnessLane,
    method: 'read' | 'write',
    path: string,
    ok: boolean,
    error: string | undefined,
  ): void {
    this.sealStreaming(lane);
    const item = this.appendTranscript(lane, 'fs_activity', '');
    item.fsActivity = { method, path, ok, error };
  }

  private appendClassifiedError(lane: HarnessLane, raw: string, fallbackText: string): void {
    this.sealStreaming(lane);
    const providerError = classifyProviderError(raw);
    if (providerError) {
      this.appendProviderError(lane, providerError);
      return;
    }
    this.appendTranscript(lane, 'system', fallbackText);
  }

  private appendProviderError(lane: HarnessLane, payload: ProviderErrorPayload): HarnessTranscriptItem {
    const last = lane.transcript[lane.transcript.length - 1];
    if (!shouldAppendProviderError(last, payload)) {
      this.markLaneProviderError(lane, payload);
      return last as HarnessTranscriptItem;
    }
    const item = this.appendTranscript(lane, 'provider_error', payload.headline);
    item.providerError = payload;
    this.markLaneProviderError(lane, payload);
    return item;
  }

  private convertAssistantRowToProviderError(
    lane: HarnessLane,
    item: HarnessTranscriptItem,
    payload: ProviderErrorPayload,
  ): void {
    item.kind = 'provider_error';
    item.text = payload.headline;
    item.providerError = payload;
    item.markdownSource = undefined;
    item.markdownHtml = undefined;
    item.streamPlainLength = undefined;
    item.streamingMarkdownWritten = undefined;
    item.pretextSource = undefined;
    item.pretextLines = undefined;
    // Seal-time reclassification can run inside finishTurn's sealStreaming — defer
    // the status transition to finishTurn (which reads lane.error) to avoid the
    // re-entrant peer-mail-drain race. Non-seal callers set status directly.
    this.markLaneProviderError(lane, payload, { deferStatus: true });
  }

  private markLaneProviderError(
    lane: HarnessLane,
    payload: ProviderErrorPayload,
    opts?: { deferStatus?: boolean },
  ): void {
    lane.activeTurnStartedAt = null;
    lane.pendingTurnExtractions = [];
    lane.pendingPermissions = [];
    lane.acceptAllForTurn = false;
    lane.rejectAllForTurn = false;
    lane.peerAutoAcceptForTurn = false;
    // `lane.error` is the single source of truth for the terminal status, read by
    // finishTurn (null → idle/coordinator-suggested; set → error). A retryable
    // fault (rate limit / network blip / overloaded, e.g. a `session/prompt` reply
    // of `-32603 "API Error: Overloaded"`) arrives over a LIVE session — the agent
    // subprocess answered, only this one request failed — so keep the lane usable
    // rather than stranding it at `error` (which freezes the composer and forces a
    // context-discarding restart). A fatal fault (auth / quota / context) can't be
    // resent, so it stays errored; the card's hint tells the user what to fix.
    lane.error = payload.retryable ? null : payload.headline;
    if (opts?.deferStatus) {
      // Seal-time conversion runs INSIDE finishTurn's sealStreaming, BEFORE its
      // pointer cleanup and single status transition. Transitioning here — the
      // retryable `idle` especially, which re-entrantly drains queued peer mail —
      // would race that cleanup and be clobbered. Set `lane.error` only and let
      // finishTurn own the one correctly-ordered transition.
      return;
    }
    this.setLaneStatus(lane, payload.retryable ? 'idle' : 'error');
    this.updateComposerTick();
  }

  private appendFsWriteReview(
    lane: HarnessLane,
    requestId: number,
    path: string,
    oldText: string,
    newText: string,
  ): void {
    this.sealStreaming(lane);
    const item = this.appendTranscript(lane, 'fs_write_review', '');
    item.fsReview = { requestId, path, oldText, newText };
    if (lane.acceptAllForTurn || lane.rejectAllForTurn) {
      void this.resolveFsWriteReview(lane, item.id, lane.rejectAllForTurn ? 'rejected' : 'accepted', true);
    } else if (lane.permissionMode === 'acceptEdits' || lane.permissionMode === 'bypass') {
      void this.resolveFsWriteReview(lane, item.id, 'accepted', true);
    } else if (lane.peerAutoAcceptForTurn) {
      // spec 143: file writes are low-risk (diff shown + VCS-recoverable), so a
      // peer-delegated turn auto-accepts them — only commands are risk-gated.
      void this.resolveFsWriteReview(lane, item.id, 'accepted', true);
    }
  }

  private async resolveFsWriteReview(
    lane: HarnessLane,
    itemId: string,
    decision: 'accepted' | 'rejected',
    auto: boolean,
  ): Promise<void> {
    const item = lane.transcript.find((t) => t.id === itemId);
    if (!item || !item.fsReview || item.fsReview.resolved) return;
    if (!lane.client) return;
    item.fsReview.resolved = decision;
    this.render();
    try {
      await lane.client.respondFsWrite(item.fsReview.requestId, decision === 'accepted');
    } catch (e) {
      this.appendTranscript(lane, 'system', `fs_write reply failed: ${String(e)}`);
    }
    if (auto) {
      // No-op; flag set externally for accept-all/reject-all bulk flows.
    }
    this.render();
  }

  private firstUnresolvedFsReview(lane: HarnessLane): HarnessTranscriptItem | null {
    for (const item of lane.transcript) {
      if (item.kind === 'fs_write_review' && item.fsReview && !item.fsReview.resolved) return item;
    }
    return null;
  }

  private appendStreaming(lane: HarnessLane, kind: 'user' | 'assistant' | 'thought', text: string): void {
    // NOTE: pendingUserEcho deliberately survives assistant/thought chunks — some
    // backends echo the user prompt after the assistant has started streaming, and
    // a cleared echo would duplicate the optimistic user row. It is reset at turn
    // end and on lane reset.
    if (kind !== 'user') lane.currentUserId = null;
    if (kind !== 'assistant') lane.currentAssistantId = null;
    if (kind !== 'thought') {
      this.dropVeiledThoughtRow(lane);
      lane.currentThoughtId = null;
    }
    const currentId = kind === 'user'
      ? lane.currentUserId
      : kind === 'assistant'
        ? lane.currentAssistantId
        : lane.currentThoughtId;
    let item = currentId ? lane.transcript.find((entry) => entry.id === currentId) : null;
    if (!item) {
      item = this.appendTranscript(lane, kind, '');
      if (kind === 'user') lane.currentUserId = item.id;
      else if (kind === 'assistant') {
        lane.currentAssistantId = item.id;
        applyCoordinatorProvenanceToItem(lane, item);
      } else lane.currentThoughtId = item.id;
    }
    item.text += text;
    this.onOutputPump?.(text.length);
  }

  private appendUserStreaming(lane: HarnessLane, text: string): void {
    const pending = lane.pendingUserEcho;
    if (pending) {
      const consumed = consumeOptimisticUserEcho(pending.text, pending.received, text);
      if (consumed.matched) {
        pending.received = consumed.received;
        lane.currentUserId = pending.itemId;
        return;
      }
      lane.pendingUserEcho = null;
      // Never let unmatched backend text extend the optimistic row — a partial
      // echo match may have pointed currentUserId at it (Cursor-3 review).
      if (lane.currentUserId === pending.itemId) lane.currentUserId = null;
    }
    this.appendStreaming(lane, 'user', text);
  }

  /** Drop a thought row that never received any text. Providers that keep
   *  reasoning server-side (Claude Code on current Opus models) stream
   *  thought deltas with empty text; the row shows an animated veil while
   *  streaming and would otherwise be left behind as an empty block. */
  private dropVeiledThoughtRow(lane: HarnessLane): void {
    const id = lane.currentThoughtId;
    if (!id) return;
    const idx = lane.transcript.findIndex((entry) => entry.id === id);
    if (idx === -1) return;
    const item = lane.transcript[idx];
    if (item.kind === 'thought' && item.text.length === 0) {
      lane.transcript.splice(idx, 1);
    }
  }

  private sealStreaming(lane: HarnessLane): void {
    this.dropVeiledThoughtRow(lane);
    // Spec 114: capture the assistant id BEFORE nulling so we can find the
    // row that was just streaming.
    const assistantId = lane.currentAssistantId;
    lane.currentUserId = null;
    lane.currentAssistantId = null;
    lane.currentThoughtId = null;
    if (assistantId) {
      const item = lane.transcript.find((entry) => entry.id === assistantId);
      if (item) {
        const providerError = classifyProviderError(item.text, { prose: true });
        if (providerError) {
          this.convertAssistantRowToProviderError(lane, item, providerError);
          lane.streamingMarkdownParser = null;
          lane.streamingMarkdownBody = null;
          lane.streamingMarkdownItemId = null;
          this.scheduleLaneRender(lane);
          return;
        }
        // Spec 117: seal assistant rows through the streaming-markdown parser
        // (branch A) or via an offscreen capture if this lane streamed entirely
        // in the background and never created a parser (branch B). Either way,
        // populate the markdownSource/markdownHtml cache so future renders skip
        // marked.parse for this row.
        this.sealAssistantStreamingMarkdown(lane, item);
        item.streamPlainLength = undefined;
        item.streamingMarkdownWritten = undefined;
      }
    }
    // Guarantee a final render even on terminal paths that don't append
    // a follow-up item (no-ops on non-active lanes — pre-existing).
    this.scheduleLaneRender(lane);
  }

  /**
   * Spec 117 seal path. Drains any residual delta into the streaming-markdown
   * parser, flushes via parser_end, captures the rendered HTML into the row's
   * cache, and stabilises the wrapper's renderSignature so the next pass
   * through renderActiveTranscript() short-circuits to the no-op branch.
   *
   * Branch A: lane.streamingMarkdownParser exists (lane was foreground at some
   * point during the turn). Uses the parser-owned body (may be detached).
   *
   * Branch B: no parser ever existed (purely background stream). Builds an
   * offscreen parser, parses item.text in one shot, captures innerHTML.
   */
  private sealAssistantStreamingMarkdown(lane: HarnessLane, item: HarnessTranscriptItem): void {
    if (
      lane.streamingMarkdownParser !== null &&
      lane.streamingMarkdownBody !== null &&
      lane.streamingMarkdownItemId === item.id
    ) {
      const body = lane.streamingMarkdownBody;
      const parser = lane.streamingMarkdownParser;
      const written = item.streamingMarkdownWritten ?? 0;
      // Seal-drain: write any residual delta that accumulated between the
      // last RAF tick and now (e.g. final ACP chunk + stop event in the same
      // task, or background lane whose RAF was skipped).
      if (item.text.length > written) {
        try {
          smd.parser_write(parser, item.text.slice(written));
        } catch (e) {
          console.warn('[spec117] parser_write during seal failed', e);
        }
        item.streamingMarkdownWritten = item.text.length;
      }
      try {
        smd.parser_end(parser);
      } catch (e) {
        console.warn('[spec117] parser_end during seal failed', e);
      }
      // Spec 117 table fix: if the message contains a GFM table, re-render the
      // sealed body with marked (smd's single-pass table parser is brittle);
      // otherwise keep smd's output. Either branch resolves agent-emitted local
      // image paths on the LIVE body before caching — a sealed foreground row is
      // not re-rendered (renderSignature is stabilised below), so this is the
      // only chance to fix its <img> srcs.
      if (hasMarkdownTable(item.text)) {
        rerenderAssistantMarkdownWithMarked(body, item.text, this.projectDir);
      } else {
        resolveLocalImageSrcs(body, this.projectDir);
      }
      item.markdownHtml = body.innerHTML;
      item.markdownSource = item.text;
      // Stabilise signature so the next renderActiveTranscript() pass hits the
      // no-op branch instead of rebuilding via marked.parse. Only meaningful
      // when the wrapper is in the live transcript DOM (active lane); for
      // background lanes the cache populated above is the protection.
      const wrapper = body.parentElement;
      if (wrapper && wrapper.dataset.msgId === item.id) {
        wrapper.dataset.renderSignature = transcriptRenderSignature(item, false);
      }
    } else {
      // Branch B — cold-cache offscreen capture for background-only streams.
      const offscreen = document.createElement('div');
      try {
        if (hasMarkdownTable(item.text)) {
          // Spec 117 table fix: marked renders the table correctly; smd would
          // break it. No provenance node exists on this fresh offscreen div.
          offscreen.innerHTML = md.parse(item.text, { async: false }) as string;
        } else {
          const parser = smd.parser(makeSafeRenderer(offscreen));
          smd.parser_write(parser, item.text);
          smd.parser_end(parser);
        }
        resolveLocalImageSrcs(offscreen, this.projectDir);
        item.markdownHtml = offscreen.innerHTML;
        item.markdownSource = item.text;
      } catch (e) {
        console.warn('[spec117] offscreen seal capture failed', e);
        // Leave cache unset; cold-load path will use marked as a fallback.
      }
    }
    lane.streamingMarkdownParser = null;
    lane.streamingMarkdownBody = null;
    lane.streamingMarkdownItemId = null;
  }

  private renderTool(lane: HarnessLane, call: ToolCall | ToolCallUpdate): void {
    if (!call.toolCallId) return;
    const merged = mergeToolCall(lane.toolCalls.get(call.toolCallId), call);
    lane.toolCalls.set(call.toolCallId, merged);
    const status = merged.status ?? 'pending';
    const existingId = lane.toolTranscriptIds.get(merged.toolCallId);
    const existing = existingId ? lane.transcript.find((item) => item.id === existingId) : null;
    const target = existing ?? this.appendTranscript(lane, 'tool', '');
    // Spec 114: before/after delta on the row's "active" state. A row is
    // active iff it has a start timestamp but no end timestamp.
    const wasActive = target.toolStartedAt !== undefined && target.toolEndedAt === undefined;
    // Capture the terminal transition BEFORE stamping toolEndedAt below —
    // otherwise the check always reads false (spec 133 live-edit refresh).
    const justEnded = isTerminalToolStatus(status) && target.toolEndedAt === undefined;
    if (target.toolStartedAt === undefined) target.toolStartedAt = performance.now();
    if (justEnded) {
      target.toolEndedAt = performance.now();
    }
    const isActive = target.toolStartedAt !== undefined && target.toolEndedAt === undefined;
    if (wasActive !== isActive) {
      lane.activeToolCount += isActive ? 1 : -1;
    }
    const tool = buildToolPayload(merged, status, target.toolStartedAt, target.toolEndedAt);
    // spec 133: redact write/edit cards on an artifact path to path + bytes +
    // hash — HTML must never reach the transcript model under the write tool
    // (the real spec-103 fix). Match the registry when known, but ALSO redact on
    // the raw scratch-path pattern so a write card that renders before the
    // pending event arrives still never shows the HTML (event/registry race).
    const artifactRecord = this.matchArtifactWrite(lane, merged);
    const artifactTarget = extractModifiedPath(merged) ?? merged.locations?.[0]?.path ?? null;
    if (artifactRecord || callTargetsArtifactScratch(merged)) {
      tool.diffs = [];
      tool.sections = [];
      tool.artifactRedaction = {
        tail: artifactRecord?.tail ?? normalizeArtifactPath(artifactTarget ?? ''),
        size: artifactRecord?.size ?? null,
        hash: artifactRecord?.hash ?? null,
        pending: artifactRecord ? artifactRecord.state === 'pending' : true,
      };
      // A completed edit to a live artifact refreshes its card's size/hash
      // without a lane round-trip.
      if (justEnded && artifactRecord?.state === 'registered_live') {
        void this.refreshArtifact(artifactRecord);
      }
    }
    const text = tool.subject ? `${tool.glyph} ${tool.kind} ${tool.subject}` : `${tool.glyph} ${tool.kind}`;
    target.text = text;
    target.status = status;
    target.tool = tool;
    if (!existing) lane.toolTranscriptIds.set(merged.toolCallId, target.id);
    if (SPEC114_DEV) assertActiveToolCount(lane);
    this.updateToolTick();
  }

  private renderPlan(lane: HarnessLane, entries: PlanEntry[]): void {
    lane.plan = entries;
    this.renderPlanPanel(lane);
  }

  private renderPlanPanel(lane: HarnessLane | null): void {
    if (!lane || !lane.plan || lane.plan.length === 0) {
      this.planEl.hidden = true;
      this.planEl.innerHTML = '';
      this.planSlotEl.hidden = true;
      return;
    }
    const entries = lane.plan;
    const done = entries.filter((e) => e.status === 'completed').length;
    const total = entries.length;
    const collapsed = lane.planCollapsed;
    const progressPct = Math.round((done / total) * 100);
    this.planEl.title = `p ${collapsed ? 'expand' : 'collapse'}`;

    const header =
      `<div class="acp-harness__plan-header">` +
      `<span class="acp-harness__plan-title">plan</span>` +
      `<span class="acp-harness__plan-count"><b>${done}</b> / ${total}</span>` +
      `</div>`;

    const progress =
      `<div class="acp-harness__plan-progress">` +
      `<span class="acp-harness__plan-progress-fill" style="width: ${progressPct}%"></span>` +
      `</div>`;

    const rows = entries
      .map((entry) => {
        const cls = `acp-harness__plan-entry acp-harness__plan-entry--${entry.status}`;
        const marker = entry.status === 'completed' ? '✓' : entry.status === 'in_progress' ? '▸' : '·';
        const priority = entry.priority === 'high'
          ? `<span class="acp-harness__plan-priority">high</span>`
          : '';
        return (
          `<div class="${cls}">` +
          `<span class="acp-harness__plan-entry-mark">${marker}</span>` +
          `<span class="acp-harness__plan-entry-text">${esc(entry.content)}${priority}</span>` +
          `</div>`
        );
      })
      .join('');
    const entriesBlock = collapsed
      ? ''
      : `<div class="acp-harness__plan-entries">${rows}</div>`;

    this.planEl.innerHTML = header + progress + entriesBlock;
    if (!collapsed) {
      const entriesEl = this.planEl.querySelector('.acp-harness__plan-entries');
      if (entriesEl) {
        const scrollTarget =
          entriesEl.querySelector<HTMLElement>('.acp-harness__plan-entry--in_progress') ??
          entriesEl.querySelector<HTMLElement>('.acp-harness__plan-entry:last-child');
        scrollTarget?.scrollIntoView({ block: 'nearest' });
      }
    }
    this.planEl.classList.toggle('acp-harness__plan--collapsed', collapsed);
    this.planEl.hidden = false;
    this.planSlotEl.hidden = false;
  }

  private handleFsReviewKey(e: KeyboardEvent, lane: HarnessLane, item: HarnessTranscriptItem): boolean {
    if (!item.fsReview) return false;
    if (e.key === 'a' || e.key === 'A' || e.key === 'r' || e.key === 'R' || e.key === 'Escape') {
      e.preventDefault();
      const reject = e.key === 'r' || e.key === 'R' || e.key === 'Escape';
      if (e.key === 'A') lane.acceptAllForTurn = true;
      if (e.key === 'R') lane.rejectAllForTurn = true;
      void this.resolveFsWriteReview(lane, item.id, reject ? 'rejected' : 'accepted', e.key === 'A' || e.key === 'R');
      return true;
    }
    return true;
  }

  private handlePermissionKey(e: KeyboardEvent, lane: HarnessLane): boolean {
    if (e.key === 'a' || e.key === 'A' || e.key === 'r' || e.key === 'R' || e.key === 'Escape') {
      e.preventDefault();
      const reject = e.key === 'r' || e.key === 'R' || e.key === 'Escape';
      if (e.key === 'A') lane.acceptAllForTurn = true;
      if (e.key === 'R') lane.rejectAllForTurn = true;
      void this.resolvePermission(lane, reject ? 'reject' : 'accept', e.key === 'A' || e.key === 'R');
      return true;
    }
    return true;
  }

  private handleMemoryKey(e: KeyboardEvent): boolean {
    if (e.key === 'Escape') {
      e.preventDefault();
      this.toggleMemoryDrawer(false);
      return true;
    }
    if ((e.key === 'm' || e.key === 'M') && (e.ctrlKey || e.metaKey) && !e.altKey && !e.shiftKey) {
      e.preventDefault();
      this.toggleMemoryDrawer(false);
      return true;
    }
    if (e.key === '?' && !e.ctrlKey && !e.metaKey && !e.altKey) {
      e.preventDefault();
      this.toggleHelp(true);
      return true;
    }
    if (this.isMemoryCursorKey(e)) {
      e.preventDefault();
      this.moveMemoryCursor(e.key);
      return true;
    }
    e.preventDefault();
    return true;
  }

  private isMemoryCursorKey(e: KeyboardEvent): boolean {
    if (['ArrowDown', 'ArrowUp', 'Home', 'End', 'PageDown', 'PageUp'].includes(e.key)) {
      return true;
    }
    const key = e.key.toLowerCase();
    return e.ctrlKey && !e.metaKey && !e.altKey && (key === 'n' || key === 'p');
  }

  private handleTranscriptKey(e: KeyboardEvent): boolean {
    const body = this.dashboardEl.querySelector<HTMLElement>('.acp-harness__lane--active .acp-harness__lane-body');
    if (!body) return false;
    if (/^[1-9]$/.test(e.key) && !e.ctrlKey && !e.metaKey && !e.altKey) {
      const lane = this.lanes[Number(e.key) - 1];
      if (lane) {
        e.preventDefault();
        this.activateLane(lane.id);
        this.focus = 'transcript';
        this.element.classList.add('acp-harness--transcript-focus');
        return true;
      }
    }
    if (e.key === '?' && !e.ctrlKey && !e.metaKey && !e.altKey) {
      e.preventDefault();
      this.toggleHelp(true);
      return true;
    }
    if (e.key === 'f' && !e.ctrlKey && !e.metaKey && !e.altKey) {
      e.preventDefault();
      if (!this.enterArtifactHintMode()) this.flashChip('no artifacts to open');
      return true;
    }
    if (e.key === 'j') { e.preventDefault(); body.scrollBy({ top: 24, behavior: 'instant' }); return true; }
    if (e.key === 'k') { e.preventDefault(); body.scrollBy({ top: -24, behavior: 'instant' }); return true; }
    if (e.key === 'g') {
      e.preventDefault();
      body.scrollTop = 0;
      const lane = this.activeLane();
      if (lane) { lane.stickToBottom = false; lane.savedScrollTop = 0; }
      return true;
    }
    if (e.key === 'G') {
      e.preventDefault();
      const lane = this.activeLane();
      if (lane) lane.stickToBottom = true;
      this.scheduleStickyScroll();
      return true;
    }
    if (e.key === 'q') { e.preventDefault(); this.closeCb?.(); return true; }
    if (e.key === 'p' && !e.ctrlKey && !e.metaKey && !e.altKey) {
      const lane = this.activeLane();
      if (lane && lane.plan && lane.plan.length > 0) {
        e.preventDefault();
        lane.planCollapsed = !lane.planCollapsed;
        this.renderPlanPanel(lane);
        return true;
      }
    }
    if (e.key === 'Escape' || e.key === 'i') { e.preventDefault(); this.focus = 'text'; this.render(); return true; }
    if ((e.key === 'd' && e.ctrlKey) || e.key === 'PageDown') { e.preventDefault(); body.scrollBy({ top: body.clientHeight * 0.5, behavior: 'instant' }); return true; }
    if ((e.key === 'u' && e.ctrlKey) || e.key === 'PageUp') { e.preventDefault(); body.scrollBy({ top: -body.clientHeight * 0.5, behavior: 'instant' }); return true; }
    if (e.key.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey) {
      e.preventDefault();
      return true;
    }
    return false;
  }

  private handleEditingKey(e: KeyboardEvent, lane: HarnessLane): boolean {
    const len = lane.draft.length;
    const pos = lane.cursor;
    const ctrlOnly = e.ctrlKey && !e.metaKey && !e.altKey;
    const cmdOnly = e.metaKey && !e.ctrlKey && !e.altKey;
    const noMod = !e.ctrlKey && !e.metaKey && !e.altKey;
    if (e.key === 'Enter' && e.shiftKey) { e.preventDefault(); this.insertDraft(lane, '\n'); return true; }
    if (e.key === 'ArrowLeft' && noMod) { e.preventDefault(); this.setDraftCursor(lane, pos - 1); return true; }
    if (e.key === 'ArrowRight' && noMod) { e.preventDefault(); this.setDraftCursor(lane, pos + 1); return true; }
    if (e.key === 'Home' || (ctrlOnly && e.key === 'a') || (cmdOnly && e.key === 'ArrowLeft')) { e.preventDefault(); this.setDraftCursor(lane, 0); return true; }
    if (e.key === 'End' || (ctrlOnly && e.key === 'e') || (cmdOnly && e.key === 'ArrowRight')) { e.preventDefault(); this.setDraftCursor(lane, len); return true; }
    if (e.key === 'Backspace' && noMod) {
      e.preventDefault();
      if (pos > 0) this.setDraft(lane, lane.draft.slice(0, pos - 1) + lane.draft.slice(pos), pos - 1);
      return true;
    }
    if (e.key === 'Delete' && noMod) {
      e.preventDefault();
      if (pos < len) this.setDraft(lane, lane.draft.slice(0, pos) + lane.draft.slice(pos + 1), pos);
      return true;
    }
    if (ctrlOnly && e.key === 'b') { e.preventDefault(); this.setDraftCursor(lane, pos - 1); return true; }
    if (ctrlOnly && e.key === 'f') { e.preventDefault(); this.setDraftCursor(lane, pos + 1); return true; }
    if (ctrlOnly && e.key === 'ArrowLeft') { e.preventDefault(); this.setDraftCursor(lane, this.wordBackward(lane.draft, pos)); return true; }
    if (ctrlOnly && e.key === 'ArrowRight') { e.preventDefault(); this.setDraftCursor(lane, this.wordForward(lane.draft, pos)); return true; }
    if (ctrlOnly && e.key === 'h') {
      e.preventDefault();
      if (pos > 0) this.setDraft(lane, lane.draft.slice(0, pos - 1) + lane.draft.slice(pos), pos - 1);
      return true;
    }
    if (ctrlOnly && e.key === 'd') {
      e.preventDefault();
      if (pos < len) this.setDraft(lane, lane.draft.slice(0, pos) + lane.draft.slice(pos + 1), pos);
      return true;
    }
    if (ctrlOnly && e.key === 't') {
      e.preventDefault();
      if (len >= 2 && pos > 0) {
        const i = pos === len ? pos - 2 : pos - 1;
        const swapped = lane.draft.slice(0, i) + lane.draft[i + 1] + lane.draft[i] + lane.draft.slice(i + 2);
        const newCursor = pos === len ? pos : pos + 1;
        this.setDraft(lane, swapped, newCursor);
      }
      return true;
    }
    if (ctrlOnly && e.key === 'u') {
      e.preventDefault();
      if (pos > 0) lane.lastKilled = lane.draft.slice(0, pos);
      this.setDraft(lane, lane.draft.slice(pos), 0);
      return true;
    }
    if (ctrlOnly && e.key === 'k') {
      e.preventDefault();
      if (pos < len) lane.lastKilled = lane.draft.slice(pos);
      this.setDraft(lane, lane.draft.slice(0, pos), pos);
      return true;
    }
    if (ctrlOnly && e.key === 'w') {
      e.preventDefault();
      const start = this.wordBackward(lane.draft, pos);
      if (start < pos) {
        lane.lastKilled = lane.draft.slice(start, pos);
        this.setDraft(lane, lane.draft.slice(0, start) + lane.draft.slice(pos), start);
      }
      return true;
    }
    if (ctrlOnly && e.key === 'y') {
      e.preventDefault();
      if (lane.lastKilled) this.insertDraft(lane, lane.lastKilled);
      return true;
    }
    return false;
  }

  private wordBackward(text: string, pos: number): number {
    let i = pos;
    while (i > 0 && !/\w/.test(text[i - 1])) i--;
    while (i > 0 && /\w/.test(text[i - 1])) i--;
    return i;
  }

  private wordForward(text: string, pos: number): number {
    let i = pos;
    while (i < text.length && !/\w/.test(text[i])) i++;
    while (i < text.length && /\w/.test(text[i])) i++;
    return i;
  }

  private insertDraft(lane: HarnessLane, text: string): void {
    this.setDraft(lane, lane.draft.slice(0, lane.cursor) + text + lane.draft.slice(lane.cursor), lane.cursor + text.length);
  }

  private stageImageFile(lane: HarnessLane, file: File): void {
    const reader = new FileReader();
    reader.onload = (): void => {
      const dataUrl = reader.result as string;
      const commaIdx = dataUrl.indexOf(',');
      const base64 = commaIdx >= 0 ? dataUrl.slice(commaIdx + 1) : dataUrl;
      void this.stageImageDataFromFile(lane, base64, file.type);
    };
    reader.readAsDataURL(file);
  }

  private async stageImageDataFromFile(lane: HarnessLane, data: string, mimeType: string): Promise<void> {
    if (lane.stagedImages.length >= MAX_STAGED_IMAGES) {
      this.flashChip(`max ${MAX_STAGED_IMAGES} images per message`);
      return;
    }
    if (data.length > MAX_IMAGE_BYTES * 1.34) {
      this.flashChip('image too large (max 5MB)');
      return;
    }
    try {
      const path = await invoke<string>('save_temp_image', { data, mimeType });
      this.stageImageData(lane, data, mimeType, path);
    } catch (e) {
      this.flashChip(`image save failed: ${String(e)}`);
    }
  }

  private canStageImage(lane: HarnessLane, data: string): boolean {
    if (lane.stagedImages.length >= MAX_STAGED_IMAGES) {
      this.flashChip(`max ${MAX_STAGED_IMAGES} images per message`);
      return false;
    }
    if (!lane.supportsImages) {
      this.flashChip(`${lane.displayName} did not advertise image support; sending anyway`);
    }
    if (data.length > MAX_IMAGE_BYTES * 1.34) {
      this.flashChip('image too large (max 5MB)');
      return false;
    }
    return true;
  }

  private stageImageData(lane: HarnessLane, data: string, mimeType: string, path: string | null): boolean {
    if (!this.canStageImage(lane, data)) return false;
    lane.stagedImages.push({ data, mimeType, path });
    this.renderComposer();
    return true;
  }

  private clearStagedImages(lane: HarnessLane): void {
    if (lane.stagedImages.length === 0) return;
    lane.stagedImages = [];
    this.renderComposer();
  }

  private removeStagedImage(lane: HarnessLane, index: number): void {
    if (index < 0 || index >= lane.stagedImages.length) return;
    lane.stagedImages.splice(index, 1);
    this.renderComposer();
  }

  private setDraft(lane: HarnessLane, text: string, cursor: number): void {
    lane.draft = text;
    lane.cursor = Math.max(0, Math.min(cursor, text.length));
    this.focus = 'text';
    // Reset the palette's transient state on every draft change. Index returns to
    // the top of the (re-)filtered list; an Esc-dismiss only suppresses the palette
    // until the user types again.
    lane.slashPaletteIndex = 0;
    lane.slashPaletteDismissed = false;
    lane.mentionPaletteIndex = 0;
    lane.mentionPaletteDismissed = false;
    lane.hashPaletteIndex = 0;
    lane.hashPaletteDismissed = false;
    lane.verbPaletteIndex = 0;
    lane.verbPaletteDismissed = false;
    lane.historyIndex = null;
    lane.historySavedDraft = null;
    this.renderComposer();
  }

  private applyHistoryDraft(lane: HarnessLane, text: string): void {
    lane.draft = text;
    lane.cursor = text.length;
    this.focus = 'text';
    lane.slashPaletteIndex = 0;
    lane.slashPaletteDismissed = false;
    lane.mentionPaletteIndex = 0;
    lane.mentionPaletteDismissed = false;
    lane.hashPaletteIndex = 0;
    lane.hashPaletteDismissed = false;
    this.renderComposer();
  }

  private cursorOnFirstLine(lane: HarnessLane): boolean {
    return lane.draft.lastIndexOf('\n', lane.cursor - 1) === -1;
  }

  private cursorOnLastLine(lane: HarnessLane): boolean {
    return lane.draft.indexOf('\n', lane.cursor) === -1;
  }

  private handleHistoryKey(e: KeyboardEvent, lane: HarnessLane): boolean {
    if (e.ctrlKey || e.metaKey || e.altKey || e.shiftKey) return false;
    if (slashPaletteVisible(lane) || this.mentionPaletteVisibleFor(lane)) return false;
    if (e.key === 'ArrowUp') {
      if (lane.promptHistory.length === 0) return false;
      if (!this.cursorOnFirstLine(lane)) return false;
      if (lane.historyIndex === null) {
        lane.historySavedDraft = lane.draft;
        lane.historyIndex = lane.promptHistory.length - 1;
      } else if (lane.historyIndex > 0) {
        lane.historyIndex -= 1;
      } else {
        e.preventDefault();
        return true;
      }
      e.preventDefault();
      this.applyHistoryDraft(lane, lane.promptHistory[lane.historyIndex]);
      return true;
    }
    if (e.key === 'ArrowDown') {
      if (lane.historyIndex === null) return false;
      if (!this.cursorOnLastLine(lane)) return false;
      e.preventDefault();
      if (lane.historyIndex < lane.promptHistory.length - 1) {
        lane.historyIndex += 1;
        this.applyHistoryDraft(lane, lane.promptHistory[lane.historyIndex]);
      } else {
        const saved = lane.historySavedDraft ?? '';
        lane.historyIndex = null;
        lane.historySavedDraft = null;
        this.applyHistoryDraft(lane, saved);
      }
      return true;
    }
    return false;
  }

  private setDraftCursor(lane: HarnessLane, cursor: number): void {
    lane.cursor = Math.max(0, Math.min(cursor, lane.draft.length));
    this.renderComposer();
  }

  private activeLane(): HarnessLane | null {
    return this.lanes.find((lane) => lane.id === this.activeLaneId) ?? null;
  }

  /**
   * Spec 142: paint the host `.krypton-window` with the active lane's identity
   * accent by setting `data-lane-accent="<slot 1–10>"`; CSS (`window.css`) maps
   * the slot to the accent vars with `!important`, layered under the
   * `data-signal` status override. Driven from `render()` — the single funnel
   * every active-lane change passes through (activateLane, closeActiveLane,
   * initial mount) — so no `activeLaneId` write can bypass it. Cheap + guarded:
   * a no-op when the slot is unchanged or the harness isn't mounted in a window
   * (e.g. tests). The slot derives from `lane.index`, never `lane.accent`
   * (slot 1's accent is the self-referential `--krypton-window-accent` var). On
   * no active lane the attribute is dropped so the window reverts to its
   * compositor-allocated color (the inline accent vars sit underneath, intact).
   */
  private applyActiveLaneAccent(): void {
    const host = this.element.closest('.krypton-window');
    if (!(host instanceof HTMLElement)) return;
    const lane = this.activeLane();
    if (lane) {
      const slot = ((lane.index - 1) % 10) + 1;
      const value = String(slot);
      if (host.dataset.laneAccent !== value) host.dataset.laneAccent = value;
    } else if (host.dataset.laneAccent !== undefined) {
      delete host.dataset.laneAccent;
    }
  }

  // ─── Palette contributor ─────────────────────────────────────────────
  // Public, thin wrappers around private lane operations so the command
  // palette can invoke them. Closures capture `this`, not lane objects —
  // lane state is re-read at execute time and fails soft if it has gone.
  public cancelActiveLane(): void {
    const lane = this.activeLane();
    if (!lane) return;
    if (lane.pendingShellId) {
      void this.cancelShell(lane);
      return;
    }
    if (lane.status === 'busy' || lane.status === 'needs_permission' || lane.status === 'awaiting_peer') {
      void this.cancelLane(lane);
    }
  }
  public restartActiveLane(): void {
    const lane = this.activeLane();
    if (lane) void this.restartLane(lane);
  }
  public cycleActiveLane(delta: number): void {
    this.activateLaneByDelta(delta);
  }
  public showMemoryDrawer(): void {
    if (!this.memoryDrawerOpen) this.toggleMemoryDrawer(true);
  }

  getPaletteActions(_ctx: PaletteContext): readonly PaletteAction[] {
    const lane = this.activeLane();
    if (!lane) return [];
    const out: PaletteAction[] = [];

    if (
      lane.pendingShellId ||
      lane.status === 'busy' ||
      lane.status === 'needs_permission' ||
      lane.status === 'awaiting_peer'
    ) {
      out.push({
        id: 'acp.harness.cancel',
        label: 'Cancel Current Turn',
        category: 'ACP Harness',
        keybinding: 'Ctrl+C',
        execute: () => this.cancelActiveLane(),
      });
    }
    if (lane.status === 'error' || lane.status === 'stopped') {
      out.push({
        id: 'acp.harness.restart',
        label: 'Restart Lane Session',
        category: 'ACP Harness',
        execute: () => this.restartActiveLane(),
      });
    }
    if (this.lanes.length > 1) {
      out.push({
        id: 'acp.harness.switch-lane',
        label: `Switch Lane (current: ${lane.displayName})`,
        category: 'ACP Harness',
        keybinding: 'Ctrl+n',
        execute: () => this.cycleActiveLane(1),
      });
    }
    out.push({
      id: 'acp.harness.show-memory',
      label: 'Open Lane Memory Drawer',
      category: 'ACP Harness',
      keybinding: 'Ctrl+M',
      execute: () => this.showMemoryDrawer(),
    });
    // spec 178/191: prefill the #dispatch-github-issue verb (keyboard-first dispatch
    // to a fresh lane). The user pastes the issue URL inline and submits — reuses the
    // hash-command path.
    out.push({
      id: 'acp.harness.dispatch-github-issue',
      label: 'Fix GitHub Issue…',
      category: 'ACP Harness',
      execute: () => {
        this.setDraft(lane, '#dispatch-github-issue ', '#dispatch-github-issue '.length);
        this.render();
      },
    });
    const boundForLane = Array.from(this.issueBindings.values()).find((b) => b.laneId === lane.id);
    if (boundForLane) {
      out.push({
        id: 'acp.harness.open-issue',
        label: `Open Bound GitHub Issue (#${boundForLane.number})`,
        category: 'ACP Harness',
        execute: () => {
          void invoke('open_url', { url: boundForLane.issueUrl }).catch(() =>
            this.flashChip('open issue failed'),
          );
        },
      });
    }
    return out;
  }

  private activateLane(id: string): void {
    this.activeLaneId = id;
    this.focus = 'text';
    this.lanePeek.visible = true;
    this.lanePeek.dismissedAt = null;
    this.lanePeek.dismissedPriority = null;
    this.lanePeek.lockedLaneId = null;
    this.lanePeek.currentLaneId = null;
    this.lanePeek.currentReasonKey = null;
    this.render();
    this.scrollActiveTranscriptToBottom();
  }

  private activateLaneByDelta(delta: number): void {
    if (this.lanes.length === 0) return;
    const index = Math.max(0, this.lanes.findIndex((lane) => lane.id === this.activeLaneId));
    const next = (index + delta + this.lanes.length) % this.lanes.length;
    this.activateLane(this.lanes[next].id);
  }

  private enterTranscriptFocus(): void {
    this.focus = 'transcript';
    this.render();
  }

  private toggleMemoryDrawer(open: boolean): void {
    this.memoryDrawerOpen = open;
    if (open) this.helpOpen = false;
    this.render();
  }

  private toggleHelp(open: boolean): void {
    this.helpOpen = open;
    if (open) this.memoryDrawerOpen = false;
    this.render();
  }

  private toggleZenMode(): void {
    this.zenMode = !this.zenMode;
    writeZenModePreference(this.projectDir, this.zenMode);
    this.render();
  }

  private toggleConciseMode(): void {
    this.conciseMode = !this.conciseMode;
    writeConciseModePreference(this.projectDir, this.conciseMode);
    this.render();
  }

  private sortedMemoryRows(): HarnessMemoryEntry[] {
    return this.memoryEntries.slice().sort((a, b) => b.updatedAt - a.updatedAt);
  }

  private moveMemoryCursor(key: string): void {
    const rows = this.sortedMemoryRows();
    if (rows.length === 0) return;
    const current = rows.findIndex((entry) => entry.lane === this.memoryCursorRowId);
    let next = current < 0 ? 0 : current;
    const normalizedKey = key.toLowerCase();
    if (normalizedKey === 'n' || key === 'ArrowDown' || key === 'PageDown') next = Math.min(rows.length - 1, next + 1);
    else if (normalizedKey === 'p' || key === 'ArrowUp' || key === 'PageUp') next = Math.max(0, next - 1);
    else if (key === 'Home') next = 0;
    else if (key === 'End') next = rows.length - 1;
    this.memoryCursorRowId = rows[next].lane;
    this.renderMemory();
  }

  private flashChip(text: string): void {
    this.chip = text;
    if (this.chipTimer !== null) window.clearTimeout(this.chipTimer);
    this.chipTimer = window.setTimeout(() => {
      this.chip = null;
      this.renderComposer();
    }, 2000);
    this.renderComposer();
  }

  private scrollActiveTranscriptToBottom(): void {
    const lane = this.activeLane();
    if (lane) lane.stickToBottom = true;
    this.scheduleStickyScroll();
  }

  private scheduleStickyScroll(): void {
    if (this.scrollRaf) return;
    this.scrollRaf = true;
    const lane = this.activeLane();
    const singlePass = lane !== null && this.isLaneStreaming(lane);
    requestAnimationFrame(() => {
      this.scrollRaf = false;
      this.applyStickyScroll();
      if (singlePass) return;
      requestAnimationFrame(() => {
        this.applyStickyScroll();
        requestAnimationFrame(() => this.applyStickyScroll());
      });
    });
  }

  private applyStickyScroll(): void {
    const lane = this.activeLane();
    if (!lane) return;
    const body = this.activeTranscriptBody();
    if (!body) return;
    const token = this.beginProgrammaticScroll();
    if (lane.stickToBottom) {
      body.scrollTop = body.scrollHeight;
    } else if (body.scrollTop === 0 && lane.savedScrollTop > 0) {
      body.scrollTop = lane.savedScrollTop;
    } else {
      lane.savedScrollTop = body.scrollTop;
    }
    this.releaseProgrammaticScroll(token);
  }

  private activeTranscriptBody(): HTMLElement | null {
    return this.dashboardEl.querySelector<HTMLElement>('.acp-harness__lane--active .acp-harness__lane-body');
  }

  private captureTranscriptScrollAnchor(body: HTMLElement): TranscriptScrollAnchor | null {
    const bodyRect = body.getBoundingClientRect();
    for (const msg of body.querySelectorAll<HTMLElement>('.acp-harness__msg[data-msg-id]')) {
      const rect = msg.getBoundingClientRect();
      if (rect.bottom <= bodyRect.top) continue;
      const msgId = msg.dataset.msgId;
      if (!msgId) continue;
      return {
        msgId,
        offsetTop: rect.top - bodyRect.top,
      };
    }
    return null;
  }

  private restoreTranscriptScrollAnchor(body: HTMLElement, anchor: TranscriptScrollAnchor): void {
    const msg = body.querySelector<HTMLElement>(
      `.acp-harness__msg[data-msg-id="${CSS.escape(anchor.msgId)}"]`,
    );
    if (!msg) return;
    const bodyRect = body.getBoundingClientRect();
    const rect = msg.getBoundingClientRect();
    const delta = rect.top - bodyRect.top - anchor.offsetTop;
    if (Math.abs(delta) < 0.5) return;
    const token = this.beginProgrammaticScroll();
    body.scrollTop += delta;
    const lane = this.activeLane();
    if (lane) {
      lane.savedScrollTop = body.scrollTop;
      lane.savedScrollAnchor = this.captureTranscriptScrollAnchor(body) ?? anchor;
    }
    this.releaseProgrammaticScroll(token);
  }

  private observeActiveTranscriptBody(): void {
    const body = this.activeTranscriptBody();
    if (!this.transcriptResizeObserver) {
      this.transcriptResizeObserver = new ResizeObserver(() => {
        const lane = this.activeLane();
        const activeBody = this.activeTranscriptBody();
        if (!lane || !activeBody) return;
        if (lane.stickToBottom) {
          this.applyStickyScroll();
          return;
        }
        if (lane.savedScrollAnchor) {
          this.restoreTranscriptScrollAnchor(activeBody, lane.savedScrollAnchor);
        }
      });
    }
    if (body === this.observedTranscriptBody) {
      this.refreshObservedTranscriptRows(body);
      return;
    }
    if (this.observedTranscriptBody) this.transcriptResizeObserver.unobserve(this.observedTranscriptBody);
    for (const row of this.observedTranscriptRows) {
      this.transcriptResizeObserver.unobserve(row);
    }
    this.observedTranscriptRows.clear();
    this.observedTranscriptBody = body;
    if (body) this.transcriptResizeObserver.observe(body);
    this.refreshObservedTranscriptRows(body);
  }

  private refreshObservedTranscriptRows(body: HTMLElement | null): void {
    if (!this.transcriptResizeObserver) return;
    for (const row of this.observedTranscriptRows) {
      if (!body || !body.contains(row)) {
        this.transcriptResizeObserver.unobserve(row);
        this.observedTranscriptRows.delete(row);
      }
    }
    if (!body) return;
    for (const row of body.querySelectorAll<HTMLElement>('.acp-harness__msg[data-msg-id]')) {
      if (this.observedTranscriptRows.has(row)) continue;
      this.transcriptResizeObserver.observe(row);
      this.observedTranscriptRows.add(row);
    }
  }

  private onTranscriptScroll(): void {
    // Drop the event at dispatch time when a programmatic scroll is in
    // flight. Without this, the RAF callback below reads scrollHeight/
    // scrollTop AFTER a streaming chunk has grown scrollHeight but
    // BEFORE applyStickyScroll re-pins to the new bottom — distance
    // exceeds STICK_THRESHOLD_PX and stickToBottom flips to false even
    // though the user never scrolled.
    if (this.suppressScrollListener) return;
    if (this.scrollHandlerRaf) return;
    this.scrollHandlerRaf = true;
    requestAnimationFrame(() => {
      this.scrollHandlerRaf = false;
      if (this.suppressScrollListener) return;
      const lane = this.activeLane();
      const body = this.activeTranscriptBody();
      if (!lane || !body) return;
      const distance = body.scrollHeight - body.scrollTop - body.clientHeight;
      lane.stickToBottom = distance <= STICK_THRESHOLD_PX;
      lane.savedScrollTop = body.scrollTop;
      lane.savedScrollAnchor = lane.stickToBottom ? null : this.captureTranscriptScrollAnchor(body);
    });
  }

  private beginProgrammaticScroll(): number {
    this.suppressScrollListener = true;
    return ++this.suppressScrollToken;
  }

  // Two RAFs covers the browser's async scroll-event dispatch + the
  // scroll handler's own RAF gate. Token ensures a release scheduled
  // by an older begin can't open suppression created by a newer one
  // (the 3-RAF chain in scheduleStickyScroll overlaps releases).
  private releaseProgrammaticScroll(token: number): void {
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        if (this.suppressScrollToken === token) this.suppressScrollListener = false;
      });
    });
  }

  private schedulePretextLayout(): void {
    if (this.pretextRaf) return;
    this.pretextRaf = true;
    requestAnimationFrame(() => {
      this.pretextRaf = false;
      const lane = this.activeLane();
      const body = this.activeTranscriptBody();
      const anchor = lane && body && !lane.stickToBottom
        ? this.captureTranscriptScrollAnchor(body)
        : null;
      this.layoutPretextRows();
      if (body && anchor) {
        this.restoreTranscriptScrollAnchor(body, anchor);
        if (lane) lane.savedScrollAnchor = this.captureTranscriptScrollAnchor(body) ?? anchor;
      }
      this.applyStickyScroll();
    });
  }

  private layoutPretextRows(): void {
    const lane = this.activeLane();
    const itemById = lane ? new Map(lane.transcript.map((entry) => [entry.id, entry])) : null;
    const rows = this.dashboardEl.querySelectorAll<HTMLElement>('.acp-harness__msg-body[data-pretext="true"]');
    for (const row of rows) {
      const raw = row.dataset.rawText ?? '';
      const width = row.clientWidth;
      if (!raw || width <= 0) continue;
      const cs = getComputedStyle(row);
      const font = `${cs.fontWeight} ${cs.fontSize} ${cs.fontFamily}`;
      let lineHeight = parseFloat(cs.lineHeight);
      if (!Number.isFinite(lineHeight)) lineHeight = (parseFloat(cs.fontSize) || 13) * 1.35;
      const rowId = row.dataset.rowId ?? '';
      try {
        const item = rowId ? itemById?.get(rowId) ?? null : null;
        let lineTexts = item?.pretextLines;
        if (
          !item ||
          item.pretextSource !== raw ||
          item.pretextWidth !== width ||
          item.pretextFont !== font ||
          item.pretextLineHeight !== lineHeight ||
          !lineTexts
        ) {
          const prepared = prepareWithSegments(raw, font, { whiteSpace: 'pre-wrap' });
          const { lines } = layoutWithLines(prepared, width, lineHeight);
          lineTexts = lines.map((line) => line.text || '\u00a0');
          if (item) {
            item.pretextSource = raw;
            item.pretextWidth = width;
            item.pretextFont = font;
            item.pretextLineHeight = lineHeight;
            item.pretextLines = lineTexts;
          }
        }
        row.textContent = '';
        for (let i = 0; i < lineTexts.length; i++) {
          const lineEl = document.createElement('div');
          lineEl.className = 'acp-harness__pretext-line';
          lineEl.textContent = lineTexts[i];
          row.appendChild(lineEl);
        }
      } catch {
        row.textContent = raw;
      }
    }
  }
}

function zenModeStorageKey(projectDir: string | null): string {
  return `krypton:acp-harness:zen:${projectDir ?? ''}`;
}

function readZenModePreference(projectDir: string | null): boolean {
  try {
    return localStorage.getItem(zenModeStorageKey(projectDir)) === '1';
  } catch {
    return false;
  }
}

function writeZenModePreference(projectDir: string | null, value: boolean): void {
  try {
    if (value) localStorage.setItem(zenModeStorageKey(projectDir), '1');
    else localStorage.removeItem(zenModeStorageKey(projectDir));
  } catch {
    // localStorage unavailable — preference simply won't persist
  }
}

function conciseModeStorageKey(projectDir: string | null): string {
  return `krypton:acp-harness:concise:${projectDir ?? ''}`;
}

function readConciseModePreference(projectDir: string | null): boolean {
  try {
    return localStorage.getItem(conciseModeStorageKey(projectDir)) === '1';
  } catch {
    return false;
  }
}

function writeConciseModePreference(projectDir: string | null, value: boolean): void {
  try {
    if (value) localStorage.setItem(conciseModeStorageKey(projectDir), '1');
    else localStorage.removeItem(conciseModeStorageKey(projectDir));
  } catch {
    // localStorage unavailable — preference simply won't persist
  }
}

function pickPermissionOption(options: PermissionOption[], action: 'accept' | 'reject'): PermissionOption | null {
  if (action === 'accept') {
    return options.find((option) => option.kind === 'allow_once') ?? options.find((option) => option.kind === 'allow_always') ?? null;
  }
  return options.find((option) => option.kind === 'reject_once') ?? options.find((option) => option.kind === 'reject_always') ?? null;
}

export function harnessAutoAllowToolName(permission: Pick<HarnessPermission, 'toolCall' | 'options'>): string | null {
  const call = permission.toolCall;
  const optionNames = (permission.options ?? [])
    .map((option) => option.name)
    .filter((name): name is string => typeof name === 'string');
  const hasServerMarker = containsHarnessServerMarker(call)
    || optionNames.some((name) => HARNESS_SERVER_MARKERS.some((marker) => name.includes(marker)));
  if (!hasServerMarker) return null;
  return structuredHarnessToolNameFromUnknown(call.rawInput)
    ?? harnessToolNameFromUnknown(call.rawInput)
    ?? harnessToolNameFromString(call.title)
    ?? harnessToolNameFromUnknown(call.content)
    ?? harnessToolNameFromOptionLabels(optionNames)
    ?? null;
}

function harnessToolNameFromOptionLabels(names: string[]): string | null {
  for (const name of names) {
    const match = harnessToolNameFromString(name);
    if (match) return match;
  }
  return null;
}

function structuredHarnessToolNameFromUnknown(value: unknown, depth = 0): string | null {
  if (depth > MEMORY_PERMISSION_SCAN_DEPTH) return null;
  if (!value || typeof value !== 'object') return null;
  if (Array.isArray(value)) {
    for (const item of value) {
      const match = structuredHarnessToolNameFromUnknown(item, depth + 1);
      if (match) return match;
    }
    return null;
  }
  const record = value as Record<string, unknown>;
  for (const key of ['name', 'toolName', 'tool_name', 'tool']) {
    const value = record[key];
    if (typeof value === 'string') {
      const match = harnessToolNameFromString(value);
      if (match) return match;
    }
  }
  for (const item of Object.values(record)) {
    const match = structuredHarnessToolNameFromUnknown(item, depth + 1);
    if (match) return match;
  }
  return null;
}

function harnessToolNameFromUnknown(value: unknown, depth = 0): string | null {
  if (depth > MEMORY_PERMISSION_SCAN_DEPTH) return null;
  if (typeof value === 'string') return harnessToolNameFromString(value);
  if (!value || typeof value !== 'object') return null;
  if (Array.isArray(value)) {
    for (const item of value) {
      const match = harnessToolNameFromUnknown(item, depth + 1);
      if (match) return match;
    }
    return null;
  }
  const record = value as Record<string, unknown>;
  for (const key of ['name', 'toolName', 'tool_name', 'tool', 'title', 'text']) {
    const match = harnessToolNameFromUnknown(record[key], depth + 1);
    if (match) return match;
  }
  const content = record.content;
  if (typeof content === 'string') return harnessToolNameFromString(content);
  if (content && typeof content === 'object') {
    const match = harnessToolNameFromUnknown(content, depth + 1);
    if (match) return match;
  }
  return null;
}

function harnessToolNameFromString(value: string | undefined): string | null {
  if (!value) return null;
  const normalized = value.toLowerCase();
  for (const toolName of HARNESS_AUTO_ALLOW_TOOL_NAMES) {
    if (normalized === toolName || normalized.endsWith(`__${toolName}`)) return toolName;
  }
  const match = normalized.match(/(?:^|[^a-z0-9_])(handoff_set|handoff_get|handoff_list|peer_send|peer_list|attention_flag|attention_resolve|review_outcome)(?:$|[^a-z0-9_])/);
  return match && HARNESS_AUTO_ALLOW_TOOL_NAMES.has(match[1]) ? match[1] : null;
}

function harnessToolFamily(toolName: string): HarnessToolFamily | null {
  if (HARNESS_MEMORY_TOOL_NAMES.has(toolName)) return 'memory';
  if (HARNESS_PEER_TOOL_NAMES.has(toolName)) return 'peer';
  if (HARNESS_ATTENTION_TOOL_NAMES.has(toolName)) return 'attention';
  if (HARNESS_REVIEW_TOOL_NAMES.has(toolName)) return 'review';
  return null;
}

function permissionToolFamily(kind: string): PermissionPayload['toolFamily'] {
  if (kind === 'execute') return 'shell';
  if (kind === 'edit' || kind === 'delete' || kind === 'move' || kind === 'write') return 'file';
  if (kind === 'read' || kind === 'search') return 'file';
  if (kind === 'think' || kind === 'fetch') return 'agent';
  return 'other';
}

function extractHarnessServerName(call: ToolCall): string | null {
  return stringValueForKeys(call.rawInput, ['server', 'serverName', 'server_name', 'serverUrl', 'server_url'])
    ?? stringValueForKeys(call, ['server', 'serverName', 'server_name'])
    ?? null;
}

function stringValueForKeys(value: unknown, keys: string[], depth = 0): string | null {
  if (depth > 4 || !value || typeof value !== 'object') return null;
  if (Array.isArray(value)) {
    for (const item of value) {
      const match = stringValueForKeys(item, keys, depth + 1);
      if (match) return match;
    }
    return null;
  }
  const record = value as Record<string, unknown>;
  for (const key of keys) {
    const candidate = record[key];
    if (typeof candidate === 'string' && candidate.trim()) return candidate.trim();
  }
  for (const item of Object.values(record)) {
    const match = stringValueForKeys(item, keys, depth + 1);
    if (match) return match;
  }
  return null;
}

// spec 167: tightened limits — the pending card shows this on one compact line,
// so favour a short scannable head over an exhaustive arg dump.
const PERMISSION_SAFETY_KEYS = new Set([
  'command', 'cmd', 'path', 'file', 'file_path', 'filepath', 'cwd', 'url', 'target',
]);
export function permissionArgsPreview(value: unknown, subject?: string): string {
  const args = extractToolArguments(value);
  if (!args || typeof args !== 'object' || Array.isArray(args)) return boundedInlineValue(args ?? value, 90);
  // Drop any arg that merely echoes the subject line — an execute permission's
  // `command` is already shown in full as the subject, so repeating it in the
  // preview just prints the command twice. Keeps signal-carrying args (e.g.
  // `description`) so the preview still earns its line.
  const subjectNorm = subject ? subject.replace(/\s+/g, ' ').trim() : '';
  // The 3-part cap can drop a safety-critical arg (the command/path being run) if
  // it sits late in the object, so surface those keys first before the cap bites.
  const entries = Object.entries(args as Record<string, unknown>).filter(
    ([, raw]) => !(subjectNorm && typeof raw === 'string' && raw.replace(/\s+/g, ' ').trim() === subjectNorm),
  );
  entries.sort(([a], [b]) => {
    const aSafe = PERMISSION_SAFETY_KEYS.has(a.toLowerCase()) ? 0 : 1;
    const bSafe = PERMISSION_SAFETY_KEYS.has(b.toLowerCase()) ? 0 : 1;
    return aSafe - bSafe;
  });
  const parts: string[] = [];
  for (const [key, raw] of entries) {
    if (parts.length >= 3) break;
    parts.push(`${key}: ${boundedInlineValue(raw, 30)}`);
  }
  return truncate(parts.join(' · '), 96);
}

function extractToolArguments(value: unknown): unknown {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return value;
  const record = value as Record<string, unknown>;
  return record.arguments ?? record.args ?? record.input ?? value;
}

function boundedInlineValue(value: unknown, max = 140): string {
  if (value === null || value === undefined) return '';
  if (typeof value === 'string') return truncate(value.replace(/\s+/g, ' ').trim(), max);
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  try {
    return truncate(JSON.stringify(value).replace(/\s+/g, ' '), max);
  } catch {
    return truncate(String(value), max);
  }
}

function containsHarnessServerMarker(value: unknown, depth = 0): boolean {
  if (depth > MEMORY_PERMISSION_SCAN_DEPTH) return false;
  if (typeof value === 'string') return HARNESS_SERVER_MARKERS.some((marker) => value.includes(marker));
  if (!value || typeof value !== 'object') return false;
  if (Array.isArray(value)) return value.some((item) => containsHarnessServerMarker(item, depth + 1));
  return Object.values(value as Record<string, unknown>).some((item) => containsHarnessServerMarker(item, depth + 1));
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** spec 133 — normalize a path for artifact registry matching (forward slashes). */
export function normalizeArtifactPath(path: string): string {
  return path.replace(/\\/g, '/').replace(/\/+$/, '');
}

/** spec 133 — does a file-write target match an issued artifact path? An
 * ABSOLUTE target must equal the issued path exactly — never a mere suffix
 * match, or an attacker-controlled parent (`/evil/<tail>`) sharing the tail
 * would be auto-approved. A RELATIVE target (adapter reports relative to the
 * lane cwd) matches when it is a suffix of the *trusted* issued path. Empty
 * tail never matches. */
export function artifactWritePathMatches(target: string, recordPath: string, recordTail: string): boolean {
  if (!recordTail) return false;
  const t = normalizeArtifactPath(target);
  const p = normalizeArtifactPath(recordPath);
  if (t === p) return true;
  if (t.startsWith('/')) return false; // absolute, non-equal → reject
  const rel = t.replace(/^\.\//, '');
  return rel.length > 0 && (p === rel || p.endsWith('/' + rel));
}

/** spec 133 — tool kinds eligible for artifact-write auto-approval. A path
 * match alone must NOT grant: only a file *write* is auto-approved, never a
 * read/search/execute/delete that merely names the artifact in `locations`. */
export function isArtifactWriteGrantKind(kind: string): boolean {
  return kind === 'edit' || kind === 'write' || kind === 'create';
}

/** spec 133 — does a path sit under any harness artifact scratch root? Used for
 * transcript REDACTION only (never for grant): redacting is always safe, so a
 * broad `.krypton/artifacts/` pattern closes the window where the registry
 * pending event has not yet arrived when a write card first renders. Grant
 * stays strictly registry-keyed (see `artifactWritePathMatches`). */
export function isArtifactScratchPath(path: string | null | undefined): boolean {
  if (!path) return false;
  return normalizeArtifactPath(path).includes('/.krypton/artifacts/');
}

/** spec 133 — does a tool call target a scratch path anywhere (modified-path,
 * locations, or a path-bearing rawInput field)? Used for REDACTION only, so it
 * is deliberately broad: it closes the gap where an adapter reports the artifact
 * path only inside rawInput (not as a diff/location), which `extractModifiedPath`
 * would miss — leaking HTML during the registry-event race. Only path-ish keys
 * are inspected, never large content blobs. */
export function callTargetsArtifactScratch(call: ToolCall | ToolCallUpdate): boolean {
  if (isArtifactScratchPath(extractModifiedPath(call))) return true;
  for (const loc of call.locations ?? []) {
    if (isArtifactScratchPath(loc.path)) return true;
  }
  return rawInputPathMentionsScratch(call.rawInput, 0);
}

function rawInputPathMentionsScratch(value: unknown, depth: number): boolean {
  if (depth > 4 || !value || typeof value !== 'object') return false;
  if (Array.isArray(value)) return value.some((v) => rawInputPathMentionsScratch(v, depth + 1));
  for (const [key, val] of Object.entries(value as Record<string, unknown>)) {
    if (typeof val === 'string') {
      if (/path|file|target|dest|location/i.test(key) && isArtifactScratchPath(val)) return true;
    } else if (val && typeof val === 'object') {
      if (rawInputPathMentionsScratch(val, depth + 1)) return true;
    }
  }
  return false;
}

/** spec 133 — prefix-free hint labels from the same alphabet as the `f` mode. */
export function generateArtifactHintLabels(count: number): string[] {
  const chars = [...ARTIFACT_HINT_ALPHABET];
  const labels: string[] = [];
  if (count <= chars.length) {
    for (let i = 0; i < count; i++) labels.push(chars[i]);
    return labels;
  }
  for (let i = 0; i < chars.length && labels.length < count; i++) {
    for (let j = 0; j < chars.length && labels.length < count; j++) {
      labels.push(chars[i] + chars[j]);
    }
  }
  return labels;
}

// Spec 114: dev-build assertion that the cached `lane.activeToolCount`
// matches the actual count of active tool rows. Catches counter drift
// from missed delta updates or cap-shift bugs. Stripped at build time
// via `import.meta.env.DEV` so it never runs in release.
function assertActiveToolCount(lane: HarnessLane): void {
  const actual = lane.transcript.reduce(
    (acc, item) =>
      acc + (item.kind === 'tool' && item.toolStartedAt !== undefined && item.toolEndedAt === undefined ? 1 : 0),
    0,
  );
  if (lane.activeToolCount !== actual) {
    // eslint-disable-next-line no-console
    console.warn(
      `[spec114] activeToolCount drift on lane ${lane.displayName}: cached=${lane.activeToolCount} actual=${actual}`,
    );
  }
}

// Spec 117 sanitisation. streaming-markdown@0.2.15 has no HTML tag tokens
// (raw HTML in markdown source is written via document.createTextNode in the
// default renderer, which is XSS-safe), so the only attack surface is URL
// schemes on LINK / RAW_URL / IMAGE attrs. We allowlist common schemes for
// HREF/SRC; everything else falls back to '#' (href) or drops the attribute
// (src). Normalisation strips leading/trailing whitespace and ASCII control
// chars (0x00-0x1F, 0x7F) — these are the classic bypass vectors.
const CTRL_RE = /[\x00-\x1F\x7F]/g;

function normalizeUrl(value: string): string {
  return value.replace(CTRL_RE, '').trim();
}

function isSafeRelative(value: string): boolean {
  if (value === '') return true;
  if (value.startsWith('#') || value.startsWith('/') || value.startsWith('./') || value.startsWith('../')) {
    return true;
  }
  return false;
}

function sanitizeHref(value: string): string {
  const v = normalizeUrl(value);
  if (isSafeRelative(v)) return v;
  const colon = v.indexOf(':');
  if (colon === -1) return v; // bare token, treat as relative
  const scheme = v.slice(0, colon).toLowerCase();
  if (scheme === 'http' || scheme === 'https' || scheme === 'mailto') return v;
  return '#';
}

function sanitizeSrc(value: string): string | null {
  const v = normalizeUrl(value);
  if (isSafeRelative(v)) return v;
  const colon = v.indexOf(':');
  if (colon === -1) return v;
  const scheme = v.slice(0, colon).toLowerCase();
  if (scheme === 'http' || scheme === 'https') return v;
  return null;
}

/** Decide what a click on a transcript anchor does. The chrome never creates
 *  <a> elements, so every anchor in this view is agent-rendered markdown — and
 *  the single app webview must never navigate away, so every click is
 *  intercepted: http/https/mailto always open in the OS browser; anything else
 *  (sanitizeHref '#' fallbacks, fragments, relative paths) is suppressed. */
export function agentLinkOpenAction(href: string): 'external' | 'suppress' {
  return /^(https?|mailto):/i.test(normalizeUrl(href)) ? 'external' : 'suppress';
}

/** Resolve local <img src> in a rendered transcript body to Tauri asset URLs so
 *  agent-generated images load inside the webview. Agents (e.g. Grok's image_gen)
 *  emit markdown `![alt](/abs/path.jpg)` with a bare absolute filesystem path; the
 *  webview origin can't fetch raw FS paths, so they show as broken-image boxes.
 *  convertFileSrc() maps an on-disk path under the assetProtocol scope ($HOME/**)
 *  to a loadable asset URL. Idempotent: already-resolved / remote / data sources
 *  are skipped, so it is safe to re-run on cached HTML across re-renders.
 *  Unlike markdown-view's rewriter, a leading "/" is treated as a TRUE absolute
 *  path (agent output), not as a cwd-root-relative path. */
function resolveLocalImageSrcs(root: HTMLElement, cwd: string | null): void {
  const imgs = root.querySelectorAll('img[src]');
  for (const img of Array.from(imgs) as HTMLImageElement[]) {
    const src = img.getAttribute('src') ?? '';
    // Leave remote / data / already-resolved sources untouched (also keeps the
    // pass idempotent on cached HTML that was rewritten on a prior render).
    if (/^(https?:|data:|asset:|blob:|file:)/i.test(src) || src.startsWith('//')) continue;

    // Strip ?query / #fragment before FS resolution.
    const raw = src.replace(/[?#].*$/, '');
    if (!raw) continue;

    let abs: string;
    if (raw.startsWith('/')) {
      abs = raw; // true absolute path from the agent
    } else if (cwd) {
      // Relative path — resolve against the lane's project dir.
      const joined = `${cwd}/${raw}`;
      const parts: string[] = [];
      for (const seg of joined.split('/')) {
        if (seg === '..') parts.pop();
        else if (seg !== '.' && seg !== '') parts.push(seg);
      }
      abs = '/' + parts.join('/');
    } else {
      continue; // relative path with no base — cannot resolve
    }

    const original = src;
    img.src = convertFileSrc(abs);
    img.addEventListener(
      'error',
      () => {
        const breach = document.createElement('span');
        breach.className = 'acp-harness__img-breach';
        breach.textContent = `IMG BREACH // ${original}`;
        img.replaceWith(breach);
      },
      { once: true },
    );
  }
}

function makeSafeRenderer(root: HTMLElement): smd.Default_Renderer {
  const base = smd.default_renderer(root);
  return {
    data: base.data,
    add_token: base.add_token,
    end_token: base.end_token,
    add_text: base.add_text,
    set_attr: (data, type, value) => {
      if (type === smd.HREF) {
        base.set_attr(data, type, sanitizeHref(value));
      } else if (type === smd.SRC) {
        const safe = sanitizeSrc(value);
        if (safe !== null) base.set_attr(data, type, safe);
      } else {
        base.set_attr(data, type, value);
      }
    },
  };
}

/** Spec 117 shared init: wipe body, set class, install fresh parser/renderer,
 *  reset lane fields. Called from renderTranscriptItem (first paint) and from
 *  updateStreamingAssistantMarkdownBody (body rebind / item swap / backtrack). */
function initLaneStreamingMarkdown(
  lane: HarnessLane,
  item: HarnessTranscriptItem,
  body: HTMLElement,
): void {
  body.replaceChildren();
  body.classList.remove('acp-harness__msg-body--stream-plain');
  // Apply both --markdown (for typography rules in acp-harness.css) and
  // --stream-markdown (state indicator for tests / future styling). Avoids a
  // runtime class swap at seal time.
  body.classList.add('acp-harness__msg-body--markdown');
  body.classList.add('acp-harness__msg-body--stream-markdown');
  delete body.dataset.pretext;
  delete body.dataset.rawText;
  delete body.dataset.rowId;
  const renderer = makeSafeRenderer(body);
  lane.streamingMarkdownParser = smd.parser(renderer);
  lane.streamingMarkdownBody = body;
  lane.streamingMarkdownItemId = item.id;
  item.streamingMarkdownWritten = 0;
  item.streamPlainLength = undefined;
}

/** Spec 117 fast-path body update for the active assistant streaming row.
 *  Writes only the delta since the last parser_write; honours the
 *  RAF-only-write invariant (parser_write is called only from this helper
 *  and from sealAssistantStreamingMarkdown, never from appendStreaming). */
function updateStreamingAssistantMarkdownBody(
  body: HTMLElement,
  item: HarnessTranscriptItem,
  lane: HarnessLane,
): void {
  const written = item.streamingMarkdownWritten ?? 0;
  // Body rebind, item swap, or first bind via the fast path.
  if (
    lane.streamingMarkdownParser === null ||
    lane.streamingMarkdownBody !== body ||
    lane.streamingMarkdownItemId !== item.id
  ) {
    initLaneStreamingMarkdown(lane, item, body);
  } else if (item.text.length < written) {
    // Backtrack — rare; rebuild parser.
    console.warn('[spec117] streaming text backtracked; rebuilding parser');
    initLaneStreamingMarkdown(lane, item, body);
  }
  const startedAt = item.streamingMarkdownWritten ?? 0;
  if (item.text.length > startedAt) {
    try {
      smd.parser_write(lane.streamingMarkdownParser!, item.text.slice(startedAt));
    } catch (e) {
      console.warn('[spec117] parser_write failed', e);
    }
    item.streamingMarkdownWritten = item.text.length;
  }
}

// Spec 117 table fix: streaming-markdown is a single-pass parser whose table
// state machine desyncs if a stream chunk boundary lands mid-table — the rest of
// the table then renders as literal `| … |` text and that broken DOM is frozen at
// seal. marked is a full two-pass GFM parser that renders tables correctly, so at
// seal we re-render with marked — but ONLY when the message actually contains a
// table, so ordinary messages keep the cheaper smd output and pay no extra cost.
// The guard matches a GFM delimiter row (the |---|---| line under the header)
// with at least two columns.
const MARKDOWN_TABLE_DELIMITER =
  /^[ \t]*\|?[ \t]*:?-+:?[ \t]*(?:\|[ \t]*:?-+:?[ \t]*)+\|?[ \t]*$/m;

export function hasMarkdownTable(text: string): boolean {
  return MARKDOWN_TABLE_DELIMITER.test(text);
}

// Re-render assistant markdown into `body` with marked (robust GFM tables),
// preserving a leading lane-mail provenance node the streaming body may carry.
// On parse failure the existing streaming-markdown body is left untouched.
function rerenderAssistantMarkdownWithMarked(
  body: HTMLElement,
  text: string,
  projectDir: string | null,
): void {
  const prov = body.querySelector<HTMLElement>(
    ':scope > .acp-harness__lane-mail-provenance',
  );
  let html: string;
  try {
    html = md.parse(text, { async: false }) as string;
  } catch (e) {
    console.warn('[spec117] marked table re-render failed; keeping stream output', e);
    return;
  }
  body.innerHTML = html;
  if (prov) body.insertBefore(prov, body.firstChild);
  resolveLocalImageSrcs(body, projectDir);
}

// Veiled thinking: providers that keep reasoning server-side (Claude Code on
// current Opus models) stream thought deltas whose text is EMPTY — the model
// is thinking, but the content never reaches the client. Instead of an empty
// body, show a small text animation ("thinking" + pulsing dots). The row is
// dropped at seal (dropVeiledThoughtRow) if no text ever arrived, so the veil
// only ever exists on a streaming row.
function installThoughtVeil(body: HTMLElement): void {
  if (body.classList.contains('acp-harness__msg-body--thought-veil')) return;
  body.classList.remove('acp-harness__msg-body--stream-plain');
  body.classList.add('acp-harness__msg-body--thought-veil');
  const veil = document.createElement('span');
  veil.className = 'acp-harness__thought-veil';
  const word = document.createElement('span');
  word.className = 'acp-harness__thought-veil-word';
  word.textContent = 'thinking';
  veil.appendChild(word);
  for (let i = 0; i < 3; i++) {
    const dot = document.createElement('span');
    dot.className = 'acp-harness__thought-veil-dot';
    dot.textContent = '·';
    veil.appendChild(dot);
  }
  body.replaceChildren(veil);
}

// Spec 114 rev 4: append-only update for streaming assistant / thought /
// user rows. One TextNode grows via appendData; markdown waits for seal.
// Spec 117: assistant rows now use updateStreamingAssistantMarkdownBody; this
// helper still serves thought / user streaming rows.
function updateStreamingTextBody(body: HTMLElement, item: HarnessTranscriptItem): void {
  if (item.kind === 'thought' && item.text.length === 0) {
    installThoughtVeil(body);
    return;
  }
  if (!body.classList.contains('acp-harness__msg-body--stream-plain')) {
    body.classList.remove('acp-harness__msg-body--markdown');
    body.classList.remove('acp-harness__msg-body--thought-veil');
    delete body.dataset.pretext;
    delete body.dataset.rawText;
    delete body.dataset.rowId;
    body.classList.add('acp-harness__msg-body--stream-plain');
    const seed = document.createTextNode(item.text);
    body.replaceChildren(seed);
    item.streamPlainLength = item.text.length;
    if (item.kind === 'thought') body.scrollTop = body.scrollHeight;
    return;
  }
  let textNode = body.firstChild;
  if (!textNode || textNode.nodeType !== Node.TEXT_NODE) {
    body.replaceChildren(document.createTextNode(''));
    textNode = body.firstChild;
    item.streamPlainLength = 0;
  }
  const plain = textNode as Text;
  const len = item.streamPlainLength ?? 0;
  if (item.text.length > len) {
    plain.appendData(item.text.slice(len));
    item.streamPlainLength = item.text.length;
  } else if (item.text.length < len) {
    plain.data = item.text;
    item.streamPlainLength = item.text.length;
  }
  // Thought rows render in a fixed-height clamped window; keep the latest
  // reasoning line pinned to the bottom so live thinking stays visible.
  if (item.kind === 'thought') body.scrollTop = body.scrollHeight;
}

function applyCoordinatorProvenanceToItem(lane: HarnessLane, item: HarnessTranscriptItem): void {
  if (item.kind !== 'assistant' || lane.coordinatorDrainProvenanceUsed) return;
  const drain = lane.pendingCoordinatorDrain;
  if (!drain?.primaryPeerDisplayName) return;
  item.replyingToLaneMail = {
    envelopeId: drain.envelopeIds[0] ?? '',
    peerDisplayName: drain.primaryPeerDisplayName,
    envelopeCount: drain.envelopeCount,
  };
  lane.coordinatorDrainProvenanceUsed = true;
}

// Thought effort meter (length-derived). Thinking is dimmed and clamped to a
// few lines, so a glyph meter on the label restores the lost signal: how much
// reasoning is hidden below the fold. Length ≈ effort — log-scaled between a
// floor (~one short line) and a ceiling (~a long deliberation), bucketed to 5.
const THOUGHT_EFFORT_MIN_CHARS = 40;
const THOUGHT_EFFORT_MAX_CHARS = 4000;

function thoughtEffortLevel(len: number): { filled: number; tier: string } {
  let ratio = 0;
  if (len > THOUGHT_EFFORT_MIN_CHARS) {
    ratio =
      Math.log(len / THOUGHT_EFFORT_MIN_CHARS) /
      Math.log(THOUGHT_EFFORT_MAX_CHARS / THOUGHT_EFFORT_MIN_CHARS);
    ratio = Math.max(0, Math.min(1, ratio));
  }
  const filled = Math.max(1, Math.round(ratio * 5));
  const tier =
    ratio < 0.2
      ? 'brief'
      : ratio < 0.45
        ? 'considered'
        : ratio < 0.7
          ? 'deep'
          : ratio < 0.9
            ? 'extended'
            : 'exhaustive';
  return { filled, tier };
}

function buildThoughtEffortMeter(len: number): HTMLElement {
  const { filled, tier } = thoughtEffortLevel(len);
  const meter = document.createElement('span');
  meter.className = 'acp-harness__thought-effort';
  const glyph = document.createElement('span');
  glyph.className = 'acp-harness__thought-effort-glyph';
  glyph.textContent = '▰'.repeat(filled) + '▱'.repeat(5 - filled);
  const word = document.createElement('span');
  word.className = 'acp-harness__thought-effort-tier';
  word.textContent = tier;
  meter.append(glyph, word);
  return meter;
}

function renderTranscriptItem(
  item: HarnessTranscriptItem,
  isNew: boolean,
  streaming: boolean,
  lane: HarnessLane | null,
  projectDir: string | null,
): HTMLElement {
  const el = document.createElement('div');
  el.className =
    `acp-harness__msg acp-harness__msg--${item.kind}` +
    `${item.status ? ` acp-harness__msg--${item.status}` : ''}` +
    `${isNew ? ' acp-harness__msg--enter' : ''}` +
    `${streaming ? ' acp-harness__msg--streaming' : ''}`;
  el.dataset.msgId = item.id;
  el.dataset.renderSignature = transcriptRenderSignature(item, streaming);
  const label = document.createElement('div');
  label.className = 'acp-harness__msg-label';
  label.textContent = transcriptLabel(item.kind);
  if (item.kind === 'thought') {
    label.classList.add('acp-harness__msg-label--thought');
    // No meter while the row is veiled (zero text) — a "brief" reading on
    // hidden reasoning would be a lie about how much thinking is happening.
    if (item.text.length > 0) label.appendChild(buildThoughtEffortMeter(item.text.length));
  }
  const body = document.createElement('div');
  body.className = 'acp-harness__msg-body';
  if (item.kind === 'assistant') {
    if (lane) applyCoordinatorProvenanceToItem(lane, item);
    if (item.replyingToLaneMail) {
      const prov = document.createElement('div');
      prov.className = 'acp-harness__lane-mail-provenance';
      prov.textContent = formatLaneMailProvenanceLine(item.replyingToLaneMail);
      body.appendChild(prov);
    }
    if (streaming && lane) {
      // Spec 117: initialise the lane's streaming-markdown parser bound to this
      // body and seed it with the current item.text. The fast path in
      // renderActiveTranscript() takes over from the second chunk onward.
      initLaneStreamingMarkdown(lane, item, body);
      if (item.text.length > 0) {
        try {
          smd.parser_write(lane.streamingMarkdownParser!, item.text);
        } catch (e) {
          console.warn('[spec117] parser_write during first render failed', e);
        }
        item.streamingMarkdownWritten = item.text.length;
      }
    } else {
      body.classList.add('acp-harness__msg-body--markdown');
      if (item.markdownSource !== item.text || item.markdownHtml === undefined) {
        try {
          item.markdownHtml = md.parse(item.text, { async: false }) as string;
          item.markdownSource = item.text;
        } catch {
          item.markdownHtml = undefined;
          item.markdownSource = undefined;
        }
      }
      if (item.markdownHtml !== undefined) {
        body.innerHTML = item.markdownHtml;
        // Resolve agent-emitted local image paths (marked cold-load output, or a
        // cached seal that has not yet been rewritten) to loadable asset URLs.
        resolveLocalImageSrcs(body, projectDir);
      } else {
        body.textContent = item.text;
      }
    }
  } else if (item.kind === 'tool' && item.tool) {
    body.classList.add('acp-harness__tool');
    renderToolBody(body, item.tool);
  } else if (item.kind === 'permission' && item.permission) {
    body.classList.add('acp-harness__perm');
    renderPermissionBody(body, item.permission);
  } else if (item.kind === 'fs_activity' && item.fsActivity) {
    body.classList.add('acp-harness__fs-activity');
    if (!item.fsActivity.ok) body.classList.add('acp-harness__fs-activity--err');
    renderFsActivityBody(body, item.fsActivity);
  } else if (item.kind === 'fs_write_review' && item.fsReview) {
    body.classList.add('acp-harness__fs-review');
    if (item.fsReview.resolved) body.classList.add('acp-harness__fs-review--resolved');
    renderFsWriteReviewBody(body, item.fsReview);
  } else if (item.kind === 'provider_error' && item.providerError) {
    body.classList.add('acp-harness__provider-error');
    body.classList.add(`acp-harness__provider-error--${item.providerError.category}`);
    renderProviderErrorBody(body, item.providerError);
  } else if (item.kind === 'inter_lane' && item.interLane) {
    const { direction, done } = item.interLane;
    label.textContent = 'mail';
    el.classList.add('acp-harness__msg--inter_lane', `acp-harness__msg--mail-${direction}`);
    if (done) el.classList.add('acp-harness__msg--mail-done');
    renderLaneMailBody(body, item, item.interLane, item.text);
  } else if (item.kind === 'system' && item.text.startsWith('[inter-lane]')) {
    label.textContent = 'event';
    el.classList.add('acp-harness__msg--harness-event');
    body.classList.add('acp-harness__harness-event-body');
    body.textContent = item.text.replace(/^\[inter-lane\]\s*/u, '');
  } else if (item.kind === 'artifact' && item.artifact) {
    label.textContent = 'html';
    el.classList.add('acp-harness__msg--artifact');
    if (!item.artifact.available) el.classList.add('acp-harness__msg--artifact-unavailable');
    if (item.artifact.hintLabel) el.classList.add('acp-harness__msg--artifact-hinted');
    renderArtifactCardBody(body, item.artifact);
  } else if (item.kind === 'system' && item.diff) {
    // spec 124: directive upsert approval card with a before/after diff.
    const text = document.createElement('div');
    text.className = 'acp-harness__msg-text';
    text.textContent = item.text;
    body.appendChild(text);
    const pre = document.createElement('pre');
    pre.className = 'acp-harness__directive-diff';
    for (const line of item.diff.unified.split('\n')) {
      const row = document.createElement('div');
      const sign = line.charAt(0);
      row.className =
        sign === '+'
          ? 'acp-harness__directive-diff-add'
          : sign === '-'
            ? 'acp-harness__directive-diff-del'
            : 'acp-harness__directive-diff-ctx';
      row.textContent = line;
      pre.appendChild(row);
    }
    body.appendChild(pre);
  } else if (item.kind === 'user' && item.imageCount && item.imageCount > 0) {
    if (item.text) {
      const textEl = document.createElement('div');
      textEl.className = 'acp-harness__msg-text';
      textEl.textContent = item.text;
      body.appendChild(textEl);
    }
    body.appendChild(renderImageAttachmentChip(item.imageCount));
  } else if (usesPretext(item.kind)) {
    // While streaming, use the same append-only plain TextNode path as
    // assistant (fast path in renderActiveTranscript). Pretext layout runs
    // once after seal when streaming is false.
    if (streaming) {
      if (item.kind === 'thought' && item.text.length === 0) {
        installThoughtVeil(body);
      } else {
        body.classList.add('acp-harness__msg-body--stream-plain');
        body.appendChild(document.createTextNode(item.text));
        item.streamPlainLength = item.text.length;
      }
    } else {
      body.dataset.pretext = 'true';
      body.dataset.rawText = item.text;
      body.dataset.rowId = item.id;
      body.textContent = item.text;
    }
  } else {
    body.textContent = item.text;
  }
  el.appendChild(label);
  el.appendChild(body);
  return el;
}

function transcriptRenderSignature(item: HarnessTranscriptItem, streaming: boolean): string {
  const tool = item.tool
    ? [
      item.tool.status,
      item.tool.kind,
      item.tool.subject,
      item.tool.command,
      item.tool.result,
      item.tool.sections.map((section) => `${section.label}:${section.text}`).join('\u001f'),
      item.tool.diffs.map((diff) => `${diff.path}:${diff.oldText}:${diff.newText}`).join('\u001f'),
    ].join('\u001e')
    : '';
  const permission = item.permission
    ? [
      item.permission.id,
      item.permission.toolName,
      item.permission.toolFamily,
      item.permission.serverName ?? '',
      item.permission.kind,
      item.permission.subject,
      item.permission.suffix ?? '',
      item.permission.argsPreview,
      item.permission.options.map((option) => `${option.name}:${option.action}`).join('\u001f'),
      item.permission.decision,
      item.permission.decisionLabel ?? '',
      item.permission.autoReason ?? '',
    ].join('\u001e')
    : '';
  const fsActivity = item.fsActivity
    ? `${item.fsActivity.method}\u001e${item.fsActivity.path}\u001e${item.fsActivity.ok}\u001e${item.fsActivity.error ?? ''}`
    : '';
  const fsReview = item.fsReview
    ? `${item.fsReview.path}\u001e${item.fsReview.oldText}\u001e${item.fsReview.newText}\u001e${item.fsReview.resolved ?? ''}`
    : '';
  const providerError = item.providerError
    ? `${item.providerError.category}\u001e${item.providerError.code ?? ''}\u001e${item.providerError.headline}\u001e${item.providerError.hint ?? ''}\u001e${item.providerError.retryable}\u001e${item.providerError.raw}`
    : '';
  const interLane = item.interLane
    ? `${item.interLane.direction}\u001e${item.interLane.peerId}\u001e${item.interLane.peerDisplayName}\u001e${item.interLane.done ? '1' : '0'}\u001e${item.interLane.channel ?? ''}\u001e${item.interLane.peerBackendId ?? ''}`
    : '';
  const provenance = item.replyingToLaneMail
    ? `${item.replyingToLaneMail.envelopeId}\u001e${item.replyingToLaneMail.peerDisplayName}\u001e${item.replyingToLaneMail.envelopeCount}`
    : '';
  const artifact = item.artifact
    ? `${item.artifact.id}|${item.artifact.title}|${item.artifact.size ?? ''}|${item.artifact.hash ?? ''}|${item.artifact.available ? '1' : '0'}|${item.artifact.hintLabel ?? ''}`
    : item.tool?.artifactRedaction
      ? `red|${item.tool.artifactRedaction.tail}|${item.tool.artifactRedaction.size ?? ''}|${item.tool.artifactRedaction.hash ?? ''}|${item.tool.artifactRedaction.pending ? '1' : '0'}`
      : '';
  return [
    item.kind,
    item.status ?? '',
    item.text,
    item.imageCount ?? '',
    streaming ? '1' : '0',
    tool,
    permission,
    fsActivity,
    fsReview,
    providerError,
    interLane,
    provenance,
    artifact,
  ].join('\u001d');
}

/** spec 120 — flat lane-mail body (exported for tests). */
export function formatLaneMailMetaLine(
  direction: 'in' | 'out',
  peerDisplayName: string,
  done: boolean,
  channel?: InterLaneRowChannel,
): string {
  const arrow = direction === 'in' ? '←' : '→';
  const rel = direction === 'in' ? 'from' : 'to';
  const peer = peerDisplayName.toLowerCase();
  let line = `${arrow} ${rel} ${peer} · lane mail`;
  if (channel === 'mention') line += ' · mention';
  if (done) line += ' · closed';
  return line;
}

export function formatLaneMailProvenanceLine(provenance: LaneMailProvenance): string {
  const peer = provenance.peerDisplayName.toLowerCase();
  if (provenance.envelopeCount > 1) {
    return `↩ replying to lane mail (${provenance.envelopeCount} messages) from ${peer}`;
  }
  return `↩ replying to lane mail from ${peer}`;
}

function renderLaneMailBody(
  body: HTMLElement,
  item: HarnessTranscriptItem,
  payload: InterLanePayload,
  message: string,
): void {
  body.classList.add('acp-harness__msg-body--lane-mail');
  const meta = document.createElement('span');
  meta.className = 'acp-harness__lane-mail-meta';
  if (payload.peerBackendId) {
    const logo = document.createElement('span');
    logo.className = `acp-harness__lane-mail-logo acp-harness__lane-mail-logo--${payload.peerBackendId}`;
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    const use = document.createElementNS('http://www.w3.org/2000/svg', 'use');
    use.setAttribute('href', `#${backendLogoId(payload.peerBackendId)}`);
    svg.setAttribute('aria-hidden', 'true');
    svg.appendChild(use);
    logo.appendChild(svg);
    meta.appendChild(logo);
  }
  meta.appendChild(document.createTextNode(formatLaneMailMetaLine(
    payload.direction,
    payload.peerDisplayName,
    payload.done,
    payload.channel,
  )));
  const text = document.createElement('div');
  text.className = 'acp-harness__lane-mail-text';
  // Render the mail body as markdown, mirroring normal agent messages (same
  // `md` parser + `--markdown` styling), with the parse cached on the item.
  if (item.markdownSource !== message || item.markdownHtml === undefined) {
    try {
      item.markdownHtml = md.parse(message, { async: false }) as string;
      item.markdownSource = message;
    } catch {
      item.markdownHtml = undefined;
      item.markdownSource = undefined;
    }
  }
  if (item.markdownHtml !== undefined) {
    text.classList.add('acp-harness__msg-body--markdown');
    text.innerHTML = item.markdownHtml;
  } else {
    text.textContent = message;
  }
  body.appendChild(meta);
  body.appendChild(text);
}

function renderFsActivityBody(body: HTMLElement, payload: FsActivityPayload): void {
  const icon = document.createElement('span');
  icon.className = 'acp-harness__fs-activity-icon';
  icon.textContent = payload.ok ? (payload.method === 'read' ? '📖' : '✏️') : '✗';
  body.appendChild(icon);

  const verb = document.createElement('span');
  verb.className = 'acp-harness__fs-activity-verb';
  verb.textContent = payload.ok
    ? (payload.method === 'read' ? 'read' : 'wrote')
    : `${payload.method} failed`;
  body.appendChild(verb);

  const path = document.createElement('span');
  path.className = 'acp-harness__fs-activity-path';
  path.textContent = payload.path || '«empty»';
  path.title = payload.path;
  body.appendChild(path);

  if (payload.error) {
    const err = document.createElement('span');
    err.className = 'acp-harness__fs-activity-error';
    err.textContent = payload.error;
    body.appendChild(err);
  }
}

function renderProviderErrorBody(body: HTMLElement, payload: ProviderErrorPayload): void {
  const kicker = document.createElement('div');
  kicker.className = 'acp-harness__provider-error-kicker';
  kicker.textContent = providerErrorKicker(payload.category);
  body.appendChild(kicker);

  const headline = document.createElement('div');
  headline.className = 'acp-harness__provider-error-headline';
  headline.textContent = payload.headline;
  body.appendChild(headline);

  if (payload.hint) {
    const hint = document.createElement('div');
    hint.className = 'acp-harness__provider-error-hint';
    hint.textContent = payload.hint;
    body.appendChild(hint);
  }

  const meta = document.createElement('div');
  meta.className = 'acp-harness__provider-error-meta';
  if (payload.code) {
    const code = document.createElement('span');
    code.className = 'acp-harness__provider-error-chip';
    code.textContent = payload.code;
    meta.appendChild(code);
  }
  const retry = document.createElement('span');
  retry.className = `acp-harness__provider-error-chip${payload.retryable ? ' acp-harness__provider-error-chip--retry' : ''}`;
  retry.textContent = payload.retryable ? 'retryable' : 'not retryable';
  meta.appendChild(retry);
  body.appendChild(meta);

  const details = document.createElement('details');
  details.className = 'acp-harness__provider-error-details';
  const summary = document.createElement('summary');
  summary.textContent = 'details';
  details.appendChild(summary);
  const raw = document.createElement('pre');
  raw.textContent = payload.raw;
  details.appendChild(raw);
  body.appendChild(details);
}

function providerErrorKicker(category: ProviderErrorPayload['category']): string {
  switch (category) {
    case 'rate_limit': return 'agent limit hit';
    case 'quota': return 'agent quota hit';
    case 'auth': return 'agent auth failed';
    case 'context': return 'agent context limit';
    case 'network': return 'agent network failed';
    case 'provider': return 'agent provider failed';
    case 'unknown': return 'agent request failed';
  }
}

function renderFsWriteReviewBody(body: HTMLElement, payload: FsWriteReviewPayload): void {
  const head = document.createElement('div');
  head.className = 'acp-harness__fs-review-head';
  const verb = document.createElement('span');
  verb.className = 'acp-harness__fs-review-verb';
  verb.textContent = '✏️ write';
  head.appendChild(verb);
  const path = document.createElement('span');
  path.className = 'acp-harness__fs-review-path';
  path.textContent = payload.path || '«empty»';
  path.title = payload.path;
  head.appendChild(path);
  body.appendChild(head);

  const diff = document.createElement('div');
  diff.className = 'acp-harness__tool-diff';
  diff.innerHTML = renderDiffPreview(payload.oldText, payload.newText, { cssPrefix: 'acp-harness' });
  body.appendChild(diff);

  if (payload.resolved) {
    const stamp = document.createElement('div');
    stamp.className = `acp-harness__fs-review-resolved acp-harness__fs-review-resolved--${payload.resolved}`;
    stamp.textContent = payload.resolved === 'accepted' ? '✓ accepted' : '✗ rejected';
    body.appendChild(stamp);
  } else {
    const actions = document.createElement('div');
    actions.className = 'acp-harness__fs-review-actions';
    const accept = document.createElement('span');
    accept.className = 'acp-harness__fs-review-action acp-harness__fs-review-action--accept';
    accept.textContent = '[a] accept';
    actions.appendChild(accept);
    const reject = document.createElement('span');
    reject.className = 'acp-harness__fs-review-action acp-harness__fs-review-action--reject';
    reject.textContent = '[r] reject';
    actions.appendChild(reject);
    const acceptAll = document.createElement('span');
    acceptAll.className = 'acp-harness__fs-review-action acp-harness__fs-review-action--accept-all';
    acceptAll.textContent = '[A] accept all';
    actions.appendChild(acceptAll);
    body.appendChild(actions);
  }
}

export function renderPermissionBody(body: HTMLElement, perm: PermissionPayload): void {
  const pending = perm.decision === 'pending';
  body.dataset.decision = perm.decision;
  const head = document.createElement('div');
  head.className = 'acp-harness__perm-row';
  // spec 167: collapse permission rows. A resolved row leads with its decision
  // (accepted/rejected/auto-allowed); a pending row drops the redundant
  // family/"pending" noise — the actions line already signals it awaits input.
  // The head mirrors the tool row's layout (glyph + tag + inline subject) so
  // permission and tool rows align in the shared body column.
  if (!pending) {
    const glyph = document.createElement('span');
    glyph.className = `acp-harness__perm-glyph acp-harness__perm-glyph--${perm.decision}`;
    glyph.textContent = permissionDecisionGlyph(perm.decision);
    head.appendChild(glyph);
    const decision = document.createElement('span');
    decision.className = 'acp-harness__perm-decision';
    // The glyph now carries the ✓/✗, so strip it from the chip text.
    decision.textContent = permissionDecisionLabel(perm).replace(/^[✓✗]\s*/u, '');
    head.appendChild(decision);
  }
  // For execute permissions the toolName is the command — i.e. identical to the
  // subject — so rendering both would print the command twice. Only show the
  // tool tag when it carries signal the subject doesn't (e.g. Write src/app.ts).
  if (perm.toolName && perm.toolName !== perm.subject) {
    const tool = document.createElement('span');
    tool.className = 'acp-harness__perm-tool';
    tool.textContent = perm.toolName;
    head.appendChild(tool);
  }
  const subject = document.createElement('span');
  subject.className = 'acp-harness__perm-subject';
  subject.textContent = perm.subject;
  subject.title = perm.subject;
  head.appendChild(subject);
  body.appendChild(head);
  // spec 167: a resolved row stays strictly one line (decision + tool + subject).
  // The cross-touch suffix and auto-allow reason only carry decision-time signal,
  // so — like argsPreview — they render on the pending row only.
  if (pending && perm.suffix) {
    const suffix = document.createElement('span');
    suffix.className = 'acp-harness__perm-suffix';
    suffix.textContent = perm.suffix;
    body.appendChild(suffix);
  }
  if (pending && perm.autoReason) {
    const reason = document.createElement('div');
    reason.className = 'acp-harness__perm-reason';
    reason.textContent = perm.autoReason;
    body.appendChild(reason);
  }
  if (pending && perm.argsPreview) {
    const preview = document.createElement('div');
    preview.className = 'acp-harness__perm-preview';
    preview.textContent = perm.argsPreview;
    body.appendChild(preview);
  }
  if (pending) {
    const actions = document.createElement('div');
    actions.className = 'acp-harness__perm-actions';
    const labels = perm.options
      .filter((option) => option.action === 'accept' || option.action === 'reject')
      .map((option) => option.action === 'accept' ? 'a accept' : 'r reject');
    actions.textContent = Array.from(new Set(labels)).join(' · ');
    body.appendChild(actions);
  }
}

function permissionDecisionGlyph(decision: string): string {
  return decision === 'rejected' || decision === 'failed' ? '✗' : '✓';
}

function permissionDecisionLabel(perm: PermissionPayload): string {
  if (perm.decisionLabel) return perm.decisionLabel;
  switch (perm.decision) {
    case 'pending': return 'pending';
    case 'accepted': return 'accepted';
    case 'rejected': return 'rejected';
    case 'auto_allowed': return 'auto-allowed';
    case 'failed': return 'failed';
  }
}

function renderImageAttachmentChip(count: number): HTMLElement {
  const chip = document.createElement('div');
  chip.className = 'acp-harness__msg-attachment';
  chip.title = `${count} image${count === 1 ? '' : 's'} attached`;
  chip.textContent = `▧ ${count} image${count === 1 ? '' : 's'}`;
  return chip;
}

function usesPretext(kind: HarnessTranscriptItem['kind']): boolean {
  return kind !== 'assistant' && kind !== 'tool' && kind !== 'fs_activity' && kind !== 'fs_write_review' && kind !== 'provider_error';
}

function buildToolPayload(
  call: ToolCall | ToolCallUpdate,
  status: string,
  startedAt?: number,
  endedAt?: number,
): ToolPayload {
  const kind = inferToolLabel(call);
  const path = extractModifiedPath(call);
  const command = kind === 'execute' ? extractCommandLine(call.rawInput) : '';
  const subject = command || path || cleanToolTitle(call.title, kind) || '';
  const exit = extractToolExit(call.rawOutput);
  const result = exit || (status === 'failed' ? 'failed' : '');
  const raw = rawOutputSections(call.rawOutput);
  const sections = raw.length > 0 ? raw : contentOutputSections(call.content);
  const sectionLineLimit = kind === 'execute' && isGitDiffCommand(command) ? 80 : kind === 'execute' ? 12 : 6;
  const trimmed = sections
    .map((s) => ({ label: s.label, text: boundedOutputLines(s.text, sectionLineLimit) }))
    .filter((s) => s.text)
    .slice(0, 4);
  const diffs = extractToolDiffs(call.content);
  return { glyph: statusGlyph(status), status, kind, subject, command, result, sections: trimmed, diffs, startedAt, endedAt };
}

function isTerminalToolStatus(status: string): boolean {
  return status === 'completed' || status === 'failed' || status === 'canceled';
}

function formatToolElapsed(ms: number): string {
  if (ms < 0) return '';
  if (ms < 1000) return `${Math.round(ms / 100) * 100}ms`;
  if (ms < 10_000) return `${(ms / 1000).toFixed(1)}s`;
  if (ms < 60_000) return `${Math.floor(ms / 1000)}s`;
  const m = Math.floor(ms / 60_000);
  const s = Math.floor((ms % 60_000) / 1000);
  return `${m}m ${s}s`;
}

function extractToolDiffs(content: ToolCall['content']): Array<{ path: string; oldText: string; newText: string }> {
  const out: Array<{ path: string; oldText: string; newText: string }> = [];
  for (const item of content ?? []) {
    if (item.type === 'diff' && (item.newText !== undefined || item.oldText !== undefined)) {
      out.push({
        path: item.path ?? '',
        oldText: item.oldText ?? '',
        newText: item.newText ?? '',
      });
    }
  }
  return out;
}

function renderToolBody(body: HTMLElement, tool: ToolPayload): void {
  const head = document.createElement('div');
  head.className = 'acp-harness__tool-head';
  const glyph = document.createElement('span');
  glyph.className = `acp-harness__tool-glyph acp-harness__tool-glyph--${tool.status}`;
  glyph.textContent = tool.glyph;
  head.appendChild(glyph);
  const kind = document.createElement('span');
  kind.className = 'acp-harness__tool-kind';
  kind.textContent = tool.kind;
  head.appendChild(kind);
  if (tool.subject) {
    const subject = document.createElement('span');
    subject.className = 'acp-harness__tool-subject';
    subject.textContent = tool.subject;
    head.appendChild(subject);
  }
  if (tool.result) {
    const result = document.createElement('span');
    result.className = `acp-harness__tool-result acp-harness__tool-result--${tool.status}`;
    result.textContent = tool.result;
    head.appendChild(result);
  }
  if (tool.startedAt !== undefined) {
    const timer = document.createElement('span');
    timer.className = `acp-harness__tool-timer acp-harness__tool-timer--${tool.status}`;
    timer.dataset.startedAt = String(tool.startedAt);
    if (tool.endedAt !== undefined) {
      timer.dataset.endedAt = String(tool.endedAt);
      timer.textContent = formatToolElapsed(tool.endedAt - tool.startedAt);
    } else {
      timer.textContent = formatToolElapsed(performance.now() - tool.startedAt);
    }
    head.appendChild(timer);
  }
  body.appendChild(head);
  if (tool.artifactRedaction) {
    body.appendChild(renderArtifactRedaction(tool.artifactRedaction));
    return;
  }
  if (tool.sections.length > 0) {
    body.appendChild(renderToolOutput(tool));
  }
  if (tool.diffs.length > 0) {
    const wrap = document.createElement('div');
    wrap.className = 'acp-harness__tool-diffs';
    for (const d of tool.diffs) {
      const block = document.createElement('div');
      block.className = 'acp-harness__tool-diff';
      if (d.path) {
        const path = document.createElement('div');
        path.className = 'acp-harness__tool-diff-path';
        path.textContent = d.path;
        block.appendChild(path);
      }
      const inner = document.createElement('div');
      inner.innerHTML = renderDiffPreview(d.oldText, d.newText, { cssPrefix: 'acp-harness' });
      block.appendChild(inner);
      wrap.appendChild(block);
    }
    body.appendChild(wrap);
  }
}

function formatArtifactBytes(size: number | null): string {
  if (size === null) return '— bytes';
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`;
  return `${(size / (1024 * 1024)).toFixed(1)} MB`;
}

/** spec 133 — redacted body for an artifact-path write/edit card: never the
 * HTML, only path + bytes + hash. */
function renderArtifactRedaction(r: NonNullable<ToolPayload['artifactRedaction']>): HTMLElement {
  const wrap = document.createElement('div');
  wrap.className = 'acp-harness__artifact-redaction';
  const note = document.createElement('div');
  note.className = 'acp-harness__artifact-redaction-note';
  note.textContent = r.pending ? 'html artifact · contents hidden' : 'html artifact edit · contents hidden';
  wrap.appendChild(note);
  const meta = document.createElement('div');
  meta.className = 'acp-harness__artifact-redaction-meta';
  const hash7 = r.hash ? r.hash.slice(0, 7) : '—';
  meta.textContent = `${r.tail} · ${formatArtifactBytes(r.size)} · ${hash7}`;
  wrap.appendChild(meta);
  return wrap;
}

/** spec 133 — hintable artifact card body. */
function renderArtifactCardBody(body: HTMLElement, card: ArtifactCardPayload): void {
  const head = document.createElement('div');
  head.className = 'acp-harness__artifact-head';
  if (card.hintLabel) {
    const hint = document.createElement('span');
    hint.className = 'acp-harness__artifact-hint';
    hint.textContent = card.hintLabel;
    head.appendChild(hint);
  }
  const glyph = document.createElement('span');
  glyph.className = 'acp-harness__artifact-glyph';
  glyph.textContent = '◫';
  head.appendChild(glyph);
  const title = document.createElement('span');
  title.className = 'acp-harness__artifact-title';
  title.textContent = card.title;
  head.appendChild(title);
  body.appendChild(head);

  const meta = document.createElement('div');
  meta.className = 'acp-harness__artifact-meta';
  const hash7 = card.hash ? card.hash.slice(0, 7) : '—';
  meta.textContent = card.available
    ? `${formatArtifactBytes(card.size)} · ${hash7}`
    : 'unavailable — file removed';
  body.appendChild(meta);

  const action = document.createElement('div');
  action.className = 'acp-harness__artifact-action';
  action.textContent = card.available
    ? (card.hintLabel ? `press ${card.hintLabel} to open in browser` : 'f then label to open in browser')
    : 'reopen unavailable';
  body.appendChild(action);
}

function renderToolOutput(tool: ToolPayload): HTMLElement {
  const output = document.createElement('div');
  output.className = 'acp-harness__tool-output';
  for (const section of tool.sections) {
    const rich = tool.kind === 'execute' ? renderRichExecuteSection(tool, section) : null;
    output.appendChild(rich ?? renderPlainToolSection(section));
  }
  return output;
}

function renderPlainToolSection(section: { label: string; text: string }): HTMLElement {
  const block = document.createElement('div');
  const tone = toolSectionTone(section.label);
  block.className = `acp-harness__tool-section acp-harness__tool-section--${tone}`;
  const label = document.createElement('div');
  label.className = 'acp-harness__tool-section-label';
  label.textContent = section.label;
  const pre = document.createElement('pre');
  pre.className = 'acp-harness__tool-section-text';
  pre.textContent = section.text;
  block.appendChild(label);
  block.appendChild(pre);
  return block;
}

function renderRichExecuteSection(tool: ToolPayload, section: { label: string; text: string }): HTMLElement | null {
  const label = section.label.toLowerCase();
  if (label !== 'stdout' && label !== 'output') return null;
  if (/\bgit\s+diff\s+--stat\b/.test(tool.command)) {
    const rows = parseGitDiffStat(section.text);
    if (rows.length > 0) return renderGitDiffStat(rows, section.text);
  }
  if (isGitDiffCommand(tool.command) && section.text.includes('diff --git')) {
    return renderUnifiedGitDiff(section.text);
  }
  if (/\bgit\s+status\s+--short\b/.test(tool.command)) {
    const rows = parseGitStatusShort(section.text);
    if (rows.length > 0) return renderGitStatusShort(rows);
  }
  return null;
}

function isGitDiffCommand(command: string): boolean {
  return /\bgit\s+diff\b/.test(command);
}

function parseGitDiffStat(text: string): Array<{ path: string; changes: number; plus: number; minus: number }> {
  const rows: Array<{ path: string; changes: number; plus: number; minus: number }> = [];
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (!line || /\d+\s+files?\s+changed/.test(line)) continue;
    const match = line.match(/^(.+?)\s+\|\s+(\d+)\s+([+\-]+)$/);
    if (!match) continue;
    const marks = match[3] ?? '';
    rows.push({
      path: match[1]?.trim() ?? '',
      changes: Number(match[2] ?? 0),
      plus: (marks.match(/\+/g) ?? []).length,
      minus: (marks.match(/-/g) ?? []).length,
    });
  }
  return rows.slice(0, 8);
}

function renderGitDiffStat(rows: Array<{ path: string; changes: number; plus: number; minus: number }>, source: string): HTMLElement {
  const block = document.createElement('div');
  block.className = 'acp-harness__tool-rich acp-harness__tool-rich--diffstat';
  const total = Math.max(1, ...rows.map((row) => row.changes));
  for (const row of rows) {
    const item = document.createElement('div');
    item.className = 'acp-harness__tool-stat-row';
    const path = document.createElement('span');
    path.className = 'acp-harness__tool-stat-path';
    path.textContent = row.path;
    const count = document.createElement('span');
    count.className = 'acp-harness__tool-stat-count';
    count.textContent = String(row.changes);
    const bar = document.createElement('span');
    bar.className = 'acp-harness__tool-stat-bar';
    bar.style.setProperty('--stat-plus-width', `${(row.plus / total) * 100}%`);
    bar.style.setProperty('--stat-minus-width', `${(row.minus / total) * 100}%`);
    item.append(path, count, bar);
    block.appendChild(item);
  }
  const omitted = source.split('\n').filter((line) => line.trim() && !/\d+\s+files?\s+changed/.test(line)).length - rows.length;
  if (omitted > 0) {
    const more = document.createElement('div');
    more.className = 'acp-harness__tool-rich-more';
    more.textContent = `${omitted} more file${omitted === 1 ? '' : 's'}`;
    block.appendChild(more);
  }
  return block;
}

function renderUnifiedGitDiff(text: string): HTMLElement {
  const block = document.createElement('div');
  block.className = 'acp-harness__tool-rich acp-harness__tool-rich--unidiff';
  const lines = text.split('\n').filter((line) => line.length > 0);
  for (const line of lines) {
    if (line.startsWith('diff --git ')) {
      const file = document.createElement('div');
      file.className = 'acp-harness__tool-diff-file';
      file.textContent = gitDiffFileLabel(line);
      block.appendChild(file);
      continue;
    }
    const row = document.createElement('div');
    row.className = `acp-harness__tool-diff-line acp-harness__tool-diff-line--${gitDiffLineTone(line)}`;
    const mark = document.createElement('span');
    mark.className = 'acp-harness__tool-diff-mark';
    mark.textContent = gitDiffLineMark(line);
    const body = document.createElement('span');
    body.className = 'acp-harness__tool-diff-text';
    body.textContent = gitDiffLineText(line);
    row.append(mark, body);
    block.appendChild(row);
  }
  return block;
}

function gitDiffFileLabel(line: string): string {
  const match = line.match(/^diff --git a\/(.+?) b\/(.+)$/);
  if (!match) return line.replace(/^diff --git\s+/, '');
  const oldPath = match[1] ?? '';
  const newPath = match[2] ?? '';
  return oldPath === newPath ? newPath : `${oldPath} -> ${newPath}`;
}

function gitDiffLineTone(line: string): string {
  if (line.startsWith('@@')) return 'hunk';
  if (line.startsWith('+++') || line.startsWith('---') || line.startsWith('index ')) return 'meta';
  if (line.startsWith('+')) return 'add';
  if (line.startsWith('-')) return 'del';
  return 'context';
}

function gitDiffLineMark(line: string): string {
  if (line.startsWith('@@')) return '@@';
  if (line.startsWith('+++') || line.startsWith('---') || line.startsWith('index ')) return '·';
  if (line.startsWith('+')) return '+';
  if (line.startsWith('-')) return '-';
  return '';
}

function gitDiffLineText(line: string): string {
  if (line.startsWith('@@')) return line;
  if (line.startsWith('+++') || line.startsWith('---')) return line.slice(4);
  if (line.startsWith('+') || line.startsWith('-')) return line.slice(1);
  return line.startsWith(' ') ? line.slice(1) : line;
}

function parseGitStatusShort(text: string): Array<{ index: string; worktree: string; path: string }> {
  const rows: Array<{ index: string; worktree: string; path: string }> = [];
  for (const raw of text.split('\n')) {
    if (!raw.trim()) continue;
    const match = raw.match(/^(.)(.)\s+(.+)$/);
    if (!match) continue;
    rows.push({
      index: match[1] ?? ' ',
      worktree: match[2] ?? ' ',
      path: match[3] ?? '',
    });
  }
  return rows.slice(0, 10);
}

function renderGitStatusShort(rows: Array<{ index: string; worktree: string; path: string }>): HTMLElement {
  const block = document.createElement('div');
  block.className = 'acp-harness__tool-rich acp-harness__tool-rich--gitstatus';
  for (const row of rows) {
    const item = document.createElement('div');
    item.className = 'acp-harness__tool-status-row';
    const badge = document.createElement('span');
    badge.className = `acp-harness__tool-status-badge acp-harness__tool-status-badge--${gitStatusTone(row.index, row.worktree)}`;
    badge.textContent = `${row.index}${row.worktree}`.trim() || 'M';
    const path = document.createElement('span');
    path.className = 'acp-harness__tool-status-path';
    path.textContent = row.path;
    item.append(badge, path);
    block.appendChild(item);
  }
  return block;
}

function gitStatusTone(index: string, worktree: string): string {
  if (index === '?' || worktree === '?') return 'new';
  if (index === 'D' || worktree === 'D') return 'deleted';
  if (index === 'A' || worktree === 'A') return 'added';
  return 'modified';
}

function toolSectionTone(label: string): string {
  const normalized = label.toLowerCase();
  if (normalized === 'stderr' || normalized === 'error' || normalized === 'message') return 'error';
  if (normalized === 'stdout' || normalized === 'output' || normalized === 'text') return 'output';
  if (normalized === 'summary') return 'summary';
  if (normalized === 'diff') return 'diff';
  if (normalized === 'terminal') return 'terminal';
  if (normalized === 'content') return 'content';
  return 'default';
}

function inferLaneModelName(
  backendId: string,
  info: AgentInfo | AgentInitInfo,
  laneModels: Record<string, LaneModelConfig>,
): string | null {
  const configured = laneModels[backendId]?.active;
  if (configured && configured.length > 0) return configured;
  const reported = findModelName(info.agent_capabilities);
  if (reported) return reported;
  if (backendId === 'opencode') return OPENCODE_DEFAULT_MODEL;
  return null;
}

function findModelName(value: unknown, depth = 0): string | null {
  if (depth > 8 || !value || typeof value !== 'object') return null;
  if (Array.isArray(value)) {
    for (const item of value) {
      const match = findModelName(item, depth + 1);
      if (match) return match;
    }
    return null;
  }
  const record = value as Record<string, unknown>;
  for (const key of ['model', 'modelId', 'model_id', 'selectedModel', 'selected_model', 'activeModel', 'active_model', 'defaultModel', 'default_model']) {
    const candidate = record[key];
    if (typeof candidate === 'string' && candidate.trim()) return candidate.trim();
  }
  for (const item of Object.values(record)) {
    const match = findModelName(item, depth + 1);
    if (match) return match;
  }
  return null;
}

function renderLaneHead(
  lane: HarnessLane,
  active: boolean,
  mcp: HarnessMcpLaneStats | null,
  metrics: AcpLaneMetrics | null,
  inboxDepth: number,
  pendingPeers: PendingPeerSummary[],
  isOrchestrator = false,
): string {
  const mcpChip = renderMcpChip(mcp);
  const modelChip = renderModelChip(lane.modelName, lane.modelApplyFailed);
  const modeChip = renderModeChip(lane);
  const sandboxChip = renderSandboxChip(lane);
  const pollyBypassChip = renderPollyBypassChip(lane);
  const saltyBypassChip = renderSaltyBypassChip(lane);
  const metricsChip = renderMetricsChip(metrics);
  // spec 180: behavior-neutral orchestrator-seat badge (≤1 per harness).
  const orchestratorChip = isOrchestrator
    ? `<span class="acp-harness__lane-orchestrator" title="orchestrator seat (#orchestrator)">◆ orch</span>`
    : '';
  const chipGroup = orchestratorChip + modelChip + modeChip + mcpChip + sandboxChip + pollyBypassChip + saltyBypassChip + metricsChip;
  const chips = chipGroup
    ? `<span class="acp-harness__lane-chips">${chipGroup}</span>`
    : '';
  const inboxChip = inboxDepth > 0
    ? `<span class="acp-harness__lane-inbox" title="${inboxDepth} pending peer message${inboxDepth === 1 ? '' : 's'}">${harnessIcon('inbox', 'acp-harness__icon--dot')}${inboxDepth}</span>`
    : '';
  if (!active) {
    const statusText = lane.status === 'needs_permission' ? 'perm' : statusLabel(lane.status);
    return (
      renderLaneSymbol(lane.status) +
      `<span class="acp-harness__lane-name">${esc(lane.displayName)}</span>` +
      `<span class="acp-harness__lane-status">${esc(statusText)}</span>` +
      inboxChip +
      chips +
      `<span class="acp-harness__lane-activity">${esc(laneActivity(lane, pendingPeers))}</span>`
    );
  }
  const cancelHint = lane.status === 'busy' || lane.status === 'needs_permission' || lane.status === 'awaiting_peer' || lane.pendingShellId
    ? `<span class="acp-harness__lane-cancel-hint">⌃C cancel</span>`
    : '';
  return (
    renderLaneSymbol(lane.status) +
    `<span class="acp-harness__lane-name">${esc(lane.displayName)}</span>` +
    `<span class="acp-harness__lane-status">${esc(statusLabel(lane.status))}</span>` +
    inboxChip +
    chips +
    `<span class="acp-harness__lane-activity">${esc(laneActivity(lane, pendingPeers))}</span>` +
    cancelHint
  );
}

function renderMetricsChip(metrics: AcpLaneMetrics | null): string {
  if (!metrics || !metrics.root_alive || metrics.proc_count === 0) return '';
  const cpu = formatCpu(metrics.total_cpu_percent);
  const rss = formatRss(metrics.total_rss_mb);
  const bucket = metricsBucket(metrics.total_cpu_percent);
  const title = `pid ${metrics.root_pid} · adapter + ${metrics.proc_count - 1} children · ⌘P m for breakdown`;
  return (
    `<span class="acp-harness__lane-metrics acp-harness__lane-metrics--${bucket}" title="${esc(title)}">` +
    `<span class="acp-harness__lane-metrics-cpu">${esc(cpu)}</span>` +
    `<span class="acp-harness__lane-metrics-rss">${esc(rss)}</span>` +
    `</span>`
  );
}

function formatCpu(pct: number): string {
  if (!Number.isFinite(pct)) return '--';
  if (pct >= 100) return `${pct.toFixed(0)}%`;
  if (pct >= 10) return `${pct.toFixed(0)}%`;
  return `${pct.toFixed(1)}%`;
}

function formatRss(mb: number): string {
  if (!Number.isFinite(mb) || mb <= 0) return '--';
  if (mb >= 1024) return `${(mb / 1024).toFixed(1)}G`;
  return `${mb.toFixed(0)}M`;
}

function renderProcessTree(m: AcpLaneMetrics): string {
  // Build parent → children map and render BFS-tree from root.
  const childrenByParent = new Map<number, number[]>();
  for (const p of m.processes) {
    if (p.parent_pid !== null && p.parent_pid !== undefined) {
      const arr = childrenByParent.get(p.parent_pid) ?? [];
      arr.push(p.pid);
      childrenByParent.set(p.parent_pid, arr);
    }
  }
  const byPid = new Map<number, AcpLaneMetrics['processes'][number]>();
  for (const p of m.processes) byPid.set(p.pid, p);

  const lines: string[] = [];
  const walk = (pid: number, depth: number, isLast: boolean, prefix: string): void => {
    const p = byPid.get(pid);
    if (!p) return;
    const branch = depth === 0 ? '' : isLast ? '└─ ' : '├─ ';
    const role = depth === 0
      ? `<span class="acp-harness__metrics-role">adapter</span>`
      : '';
    const { label, command } = describeProc(p);
    const detail = label
      ? `<span class="acp-harness__metrics-detail">${esc(label)}</span>`
      : '';
    const processName =
      `<span class="acp-harness__metrics-tree">${esc(prefix + branch)}</span>` +
      `<span class="acp-harness__metrics-name">${esc(p.name)}</span>` +
      detail +
      role;
    lines.push(
      `<div class="acp-harness__metrics-row${depth === 0 ? ' acp-harness__metrics-row--root' : ''}" title="${esc(command)}">` +
        `<span class="acp-harness__metrics-process">${processName}</span>` +
        `<span class="acp-harness__metrics-pid">${p.pid}</span>` +
        renderMetricCell('cpu', formatCpu(p.cpu_percent), metricPercent(p.cpu_percent, 100)) +
        renderMetricCell('rss', formatRss(p.rss_mb), metricPercent(p.rss_mb, m.total_rss_mb)) +
      `</div>`,
    );
    const kids = [...(childrenByParent.get(pid) ?? [])].sort((a, b) => {
      const procA = byPid.get(a);
      const procB = byPid.get(b);
      return (procB?.cpu_percent ?? 0) - (procA?.cpu_percent ?? 0);
    });
    const visibleKids = kids.filter((k) => byPid.has(k));
    visibleKids.forEach((kid, i) => {
      const last = i === visibleKids.length - 1;
      const nextPrefix = depth === 0 ? '' : prefix + (isLast ? '   ' : '│  ');
      walk(kid, depth + 1, last, nextPrefix);
    });
  };
  walk(m.root_pid, 0, true, '');
  return (
    `<div class="acp-harness__metrics-tree-block">` +
      `<div class="acp-harness__metrics-row acp-harness__metrics-row--header">` +
        `<span>Process</span><span>PID</span><span>CPU</span><span>Mem</span>` +
      `</div>` +
      lines.join('') +
    `</div>`
  );
}

// Interpreters whose bare process name ("node", "python3") says nothing about
// what they're actually running — the useful identity lives in the script /
// module argument. Everything else is assumed to be its own meaningful name.
const PROC_INTERPRETERS = new Set([
  'node', 'node.exe', 'deno', 'bun', 'electron',
  'python', 'python.exe', 'ruby', 'perl', 'php', 'java', 'dotnet',
]);

function isInterpreter(name: string): boolean {
  const n = name.toLowerCase();
  return PROC_INTERPRETERS.has(n) || n.startsWith('python');
}

// "@scope/pkg@1.2.3" → "@scope/pkg"; "pkg@1.2.3" → "pkg"; leaves a bare
// "@scope/pkg" (no version) and a plain "pkg" untouched.
function stripPkgVersion(spec: string): string {
  const at = spec.lastIndexOf('@');
  return at > 0 ? spec.slice(0, at) : spec;
}

function procBasename(path: string): string {
  const trimmed = path.replace(/[/\\]+$/, '');
  const i = Math.max(trimmed.lastIndexOf('/'), trimmed.lastIndexOf('\\'));
  return i === -1 ? trimmed : trimmed.slice(i + 1);
}

// Turn a script path into the most recognizable name: the npm package when it
// lives under node_modules (handles @scope/name and .bin shims), otherwise the
// file's basename. e.g.
//   .../node_modules/@modelcontextprotocol/server-filesystem/dist/index.js
//     → "@modelcontextprotocol/server-filesystem"
//   .../node_modules/.bin/claude-code-acp → "claude-code-acp"
//   /Users/me/proj/server.js              → "server.js"
function prettifyScriptPath(path: string): string {
  const marker = path.lastIndexOf('node_modules/');
  if (marker !== -1) {
    const parts = path.slice(marker + 'node_modules/'.length).split('/').filter(Boolean);
    if (parts.length) {
      if (parts[0] === '.bin' && parts[1]) return parts[1];
      if (parts[0].startsWith('@') && parts[1]) return `${parts[0]}/${parts[1]}`;
      return parts[0];
    }
  }
  return procBasename(path);
}

// Derive a short human label for a process row plus the full command for the
// hover tooltip. The label answers "which node is this?" — the question the
// bare process tree can't, since a busy lane is mostly indistinguishable
// "node" rows (the adapter wrapper, each MCP server, tool subprocesses).
function describeProc(p: AcpLaneProcMetric): { label: string; command: string } {
  const argv = Array.isArray(p.cmd) ? p.cmd.filter((a) => a.length > 0) : [];
  const command = argv.length ? argv.join(' ') : (p.exe ?? p.name);
  // First argument that isn't a flag — for interpreters this is the script or,
  // after `-m`/`-e` style flags, the module/code token.
  const firstArg = argv.slice(1).find((a) => !a.startsWith('-'));

  let label = '';
  if (isInterpreter(p.name)) {
    if (firstArg) {
      label = prettifyScriptPath(firstArg);
      // npx / npm-exec launchers: the script *is* the launcher ("npm"), so the
      // useful identity is the package it's running, further along argv. The
      // Claude lane (`npx -y @agentclientprotocol/claude-agent-acp`) lands here.
      const launcher = procBasename(firstArg).toLowerCase();
      if (launcher === 'npx-cli.js' || launcher === 'npx' || launcher === 'npm-cli.js' || launcher === 'npm') {
        const after = argv.slice(argv.indexOf(firstArg) + 1).find((a) => !a.startsWith('-'));
        if (after) label = stripPkgVersion(after);
      }
    }
  } else if (firstArg) {
    // Non-interpreter binary (claude, rg, git…): a path arg → its basename,
    // a short bareword → the subcommand itself.
    label = /[/\\]/.test(firstArg)
      ? prettifyScriptPath(firstArg)
      : (firstArg.length <= 24 ? firstArg : '');
  } else if (argv.length === 0 && p.exe) {
    // No argv at all (restricted process): fall back to the exe basename when
    // it adds something the name doesn't already say.
    const base = procBasename(p.exe);
    if (base && base.toLowerCase() !== p.name.toLowerCase()) label = base;
  }

  // Never echo the process name back as its own label.
  if (label.toLowerCase() === p.name.toLowerCase()) label = '';
  return { label, command };
}

function renderMetricCell(kind: 'cpu' | 'rss', value: string, width: number): string {
  return (
    `<span class="acp-harness__metrics-meter acp-harness__metrics-meter--${kind}">` +
      `<span class="acp-harness__metrics-meter-value">${esc(value)}</span>` +
      `<span class="acp-harness__metrics-meter-track">` +
        `<span class="acp-harness__metrics-meter-fill" style="width:${width.toFixed(0)}%"></span>` +
      `</span>` +
    `</span>`
  );
}

function metricPercent(value: number, max: number): number {
  if (!Number.isFinite(value) || !Number.isFinite(max) || max <= 0) return 0;
  return Math.max(0, Math.min(100, (value / max) * 100));
}

function metricsBucket(cpu: number): 'idle' | 'warm' | 'hot' | 'crit' {
  if (cpu > 95) return 'crit';
  if (cpu > 80) return 'hot';
  if (cpu > 60) return 'warm';
  return 'idle';
}

function renderModeChip(lane: HarnessLane): string {
  if (!lane.currentMode) return '';
  const title = lane.currentMode.description
    ? `${lane.currentMode.name} — ${lane.currentMode.description}`
    : `mode ${lane.currentMode.id}`;
  return `<span class="acp-harness__lane-mode" title="${esc(title)}">${esc(lane.currentMode.name)}</span>`;
}

function isPollyImplementerBypass(lane: HarnessLane): boolean {
  return lane.pollyBuiltinRole === 'implementer' && lane.permissionMode === 'bypass';
}

/** spec 164 — Polly implementers run with permissionMode bypass; surface in chrome. */
function renderPollyBypassChip(lane: HarnessLane): string {
  if (!isPollyImplementerBypass(lane)) return '';
  const title =
    'Polly worker — all tool permissions auto-accepted for this lane until the Polly role clears';
  return `<span class="acp-harness__lane-sandbox" title="${esc(title)}">polly-bypass</span>`;
}

function isSaltyExecutorBypass(lane: HarnessLane): boolean {
  return (
    (lane.saltyBuiltinRole === 'mechanical' || lane.saltyBuiltinRole === 'codexPeer') &&
    lane.permissionMode === 'bypass'
  );
}

/** spec 195 — Salty mechanical/codex-peer executors run bypassed; surface in chrome. */
function renderSaltyBypassChip(lane: HarnessLane): string {
  if (!isSaltyExecutorBypass(lane)) return '';
  const title =
    'Salty executor — all tool permissions auto-accepted for this lane until the Salty role clears (#salty clear)';
  return `<span class="acp-harness__lane-sandbox" title="${esc(title)}">salty-bypass</span>`;
}

function renderSandboxChip(lane: HarnessLane): string {
  // Surface backend-specific safety caveats directly in the lane chrome:
  // Pi is known to bypass the permission rail; Junie still needs manual
  // verification of ACP write-permission semantics.
  const warn = harnessIcon('warn', 'acp-harness__icon--dot');
  if (lane.backendId === 'pi-acp') {
    const title = 'No permission gate — Pi runs edits and shell commands immediately. Use a sandboxed cwd or container if untrusted.';
    return `<span class="acp-harness__lane-sandbox" title="${esc(title)}">${warn} unsandboxed</span>`;
  }
  if (lane.backendId === 'junie') {
    const title = 'Junie ACP write-permission behavior has not been verified yet. Krypton does not pass force/yolo/brave flags, but use a trusted cwd until verified.';
    return `<span class="acp-harness__lane-sandbox" title="${esc(title)}">${warn} permissions unverified</span>`;
  }
  return '';
}

function renderModelChip(modelName: string | null, applyFailed = false): string {
  if (!modelName) return '';
  if (applyFailed) {
    const title = `requested model ${modelName} not applied — agent is using its default or prior model (session/set_model failed)`;
    return `<span class="acp-harness__lane-model acp-harness__lane-model--warn" title="${esc(title)}">${harnessIcon('warn', 'acp-harness__icon--dot')} ${esc(modelName)}</span>`;
  }
  return `<span class="acp-harness__lane-model" title="model ${esc(modelName)}">${esc(modelName)}</span>`;
}

function renderMcpChip(mcp: HarnessMcpLaneStats | null): string {
  if (!mcp || mcp.toolsListCount === 0) {
    const title = mcp
      ? `MCP descriptor sent; adapter has not called tools/list. init=${mcp.initializeCount}`
      : 'MCP descriptor sent; adapter has not contacted the server.';
    return `<span class="acp-harness__lane-mcp acp-harness__lane-mcp--off" title="${esc(title)}">mcp —</span>`;
  }
  const title = `tools/list ${mcp.toolsListCount} · tools/call ${mcp.toolsCallCount}` +
    (mcp.lastMethod ? ` · last ${mcp.lastMethod}` : '');
  return `<span class="acp-harness__lane-mcp acp-harness__lane-mcp--on" title="${esc(title)}">mcp ${harnessIcon('check', 'acp-harness__icon--dot')}${mcp.toolsCallCount > 0 ? ` ${mcp.toolsCallCount}` : ''}</span>`;
}

const SLASH_PALETTE_REGEX = /^\/[a-zA-Z0-9_-]*$/;

function slashPaletteVisible(lane: HarnessLane): boolean {
  if (lane.slashPaletteDismissed) return false;
  if (lane.availableCommands.length === 0) return false;
  return SLASH_PALETTE_REGEX.test(lane.draft);
}

function filteredSlashCommands(lane: HarnessLane): AcpAvailableCommand[] {
  const match = lane.draft.match(SLASH_PALETTE_REGEX);
  if (!match) return [];
  const prefix = lane.draft.slice(1).toLowerCase();
  return lane.availableCommands.filter((c) => c.name.toLowerCase().startsWith(prefix));
}

function renderSlashPalette(lane: HarnessLane): string {
  if (!slashPaletteVisible(lane)) return '';
  const matches = filteredSlashCommands(lane);
  if (matches.length === 0) return '';
  const safeIndex = Math.max(0, Math.min(lane.slashPaletteIndex, matches.length - 1));
  const rows = matches
    .map((cmd, i) => {
      const sel = i === safeIndex ? ' acp-harness__slash-palette-row--selected' : '';
      const desc = cmd.description ? `<span class="acp-harness__slash-palette-desc">${esc(cmd.description)}</span>` : '';
      const hint = cmd.inputHint ? `<span class="acp-harness__slash-palette-hint">${esc(cmd.inputHint)}</span>` : '';
      return (
        `<div class="acp-harness__slash-palette-row${sel}">` +
        `<span class="acp-harness__slash-palette-name">/${esc(cmd.name)}</span>` +
        hint +
        desc +
        `</div>`
      );
    })
    .join('');
  return (
    `<div class="acp-harness__slash-palette" data-count="${matches.length}">` +
    `<div class="acp-harness__slash-palette-meta">↑↓ / ⌃n⌃p select · Enter/Tab insert · Esc dismiss</div>` +
    rows +
    `</div>`
  );
}

export function laneAccent(index: number): string {
  const accents = [
    'var(--krypton-window-accent, #0cf)',
    '#8effb0',
    '#ffd166',
    '#c77dff',
    '#ff6b8b',
    '#5fb3b3',
    '#ff9f1c',
    '#b18cff',
    '#4dd0ff',
    '#5ce6a8',
    '#7fa8ff',
    '#ff8552',
    '#56d6c0',
  ];
  return accents[(index - 1) % accents.length];
}

export function laneAccentForLabel(label: string): string {
  if (/codex/i.test(label)) return laneAccent(1);
  if (/claude/i.test(label)) return laneAccent(2);
  if (/opencode/i.test(label)) return laneAccent(4);
  if (/^pi(-|$)/i.test(label)) return laneAccent(5);
  if (/droid/i.test(label)) return laneAccent(6);
  if (/cursor/i.test(label)) return laneAccent(7);
  if (/junie/i.test(label)) return laneAccent(8);
  if (/^omp(-|$)/i.test(label)) return laneAccent(9);
  if (/grok/i.test(label)) return laneAccent(10);
  if (/copilot/i.test(label)) return laneAccent(11);
  if (/mimo/i.test(label)) return laneAccent(12);
  if (/cline/i.test(label)) return laneAccent(13);
  const match = label.match(/-(\d+)$/);
  return match ? laneAccent(Number(match[1])) : 'var(--krypton-window-accent, #0cf)';
}

function renderLaneStats(lane: HarnessLane, projectDir: string | null): string {
  // Each cell is a <span>; iconified cells carry a title so the dropped noun
  // (ctx/tools/rows) and the ↓↑ arrows stay legible to tooltips + screen readers.
  const spans: string[] = [];
  const cell = (inner: string, title?: string): string =>
    `<span${title ? ` title="${esc(title)}"` : ''}>${inner}</span>`;
  const text = (s: string): string => cell(esc(s));

  spans.push(cell(
    `<svg class="acp-harness__icon acp-harness__icon--accent" aria-hidden="true"><use href="#${backendLogoId(lane.backendId)}"/></svg>${esc(lane.backendId)}`,
    `backend ${lane.backendId}`,
  ));
  spans.push(text(lane.sessionId ? `sess ${shortId(lane.sessionId)}` : 'sess pending'));
  if (projectDir) spans.push(text(basename(projectDir)));

  const usage = lane.usage;
  if (usage) {
    if (typeof usage.used === 'number') {
      const val = typeof usage.size === 'number' && usage.size > 0
        ? `${formatCount(usage.used)}/${formatCount(usage.size)} (${Math.round((usage.used / usage.size) * 100)}%)`
        : formatCount(usage.used);
      spans.push(cell(`${harnessIcon('gauge')}${esc(val)}`, `context ${val}`));
    }
    if (typeof usage.cachedReadTokens === 'number' || typeof usage.cachedWriteTokens === 'number') {
      const r = formatCount(usage.cachedReadTokens ?? 0);
      const w = formatCount(usage.cachedWriteTokens ?? 0);
      spans.push(cell(
        `cache ${esc(r)}${harnessIcon('dl', 'acp-harness__icon--dot')}${esc(w)}${harnessIcon('ul', 'acp-harness__icon--dot')}`,
        `cache read ${r}, write ${w}`,
      ));
    }
    if (typeof usage.inputTokens === 'number' || typeof usage.outputTokens === 'number') {
      spans.push(text(`in ${formatCount(usage.inputTokens ?? 0)} out ${formatCount(usage.outputTokens ?? 0)}`));
    }
    if (usage.cost) spans.push(text(`$${usage.cost.amount.toFixed(4)} ${usage.cost.currency}`));
  }

  if (lane.toolCalls.size > 0) {
    spans.push(cell(`${harnessIcon('tool')}${esc(String(lane.toolCalls.size))}`, `${lane.toolCalls.size} tool calls`));
  }
  spans.push(cell(`${harnessIcon('list')}${esc(String(lane.transcript.length))}`, `${lane.transcript.length} transcript rows`));
  if (lane.pendingPermissions.length > 0) spans.push(text(`${lane.pendingPermissions.length} perm`));
  if (lane.acceptAllForTurn) spans.push(text('accept-all'));
  if (lane.rejectAllForTurn) spans.push(text('reject-all'));
  if (lane.peerAutoAcceptForTurn) spans.push(text('peer-auto'));
  if (isPollyImplementerBypass(lane)) spans.push(text('polly-bypass'));
  if (lane.error) spans.push(text(`err: ${truncate(lane.error, 48)}`));

  return spans.join('');
}

function basename(path: string): string {
  const trimmed = path.replace(/\/+$/, '');
  const idx = trimmed.lastIndexOf('/');
  return idx === -1 ? trimmed : trimmed.slice(idx + 1) || trimmed;
}

function truncate(s: string, max: number): string {
  return s.length <= max ? s : `${s.slice(0, max - 1)}…`;
}

/** spec 136: strict positive base-10 index parse for #unqueue / #queue edit.
 *  Rejects 0, negatives, decimals, and trailing junk (1foo). null = invalid. */
export function parseQueueIndex(arg: string | undefined): number | null {
  if (arg === undefined || !/^[1-9]\d*$/.test(arg)) return null;
  return Number(arg);
}

function transcriptLabel(kind: HarnessTranscriptItem['kind']): string {
  switch (kind) {
    case 'system': return 'sys';
    case 'assistant': return 'agent';
    case 'provider_error': return 'agent';
    case 'permission': return 'perm';
    case 'memory': return 'mem';
    case 'shell': return 'sh';
    case 'fs_activity': return 'fs';
    case 'inter_lane': return 'mail';
    case 'artifact': return 'html';
    default: return kind;
  }
}

export function isDirectPeerPeekReasonKey(reasonKey: string): boolean {
  return reasonKey === 'awaiting-peer' || reasonKey === 'inbound-peer' || reasonKey === 'peer-counterpart';
}

/**
 * spec 145: split `#review` args into reviewer name tokens (before `--`) and the
 * trailing doc-path-or-note (after `--`). With no `--`, every token is a name.
 */
export function parseReviewCommandArgs(rest: string[]): { nameTokens: string[]; tail: string } {
  const sepIdx = rest.indexOf('--');
  const nameTokens = (sepIdx === -1 ? rest : rest.slice(0, sepIdx))
    .map((t) => t.trim())
    .filter((t) => t.length > 0);
  const tail = sepIdx === -1 ? '' : rest.slice(sepIdx + 1).join(' ').trim();
  return { nameTokens, tail };
}

function heatWindowCutoffMs(window: LanePeekHeatWindow, now: number): number {
  if (window === '30s') return now - 30_000;
  if (window === '5m') return now - 5 * 60_000;
  return 0;
}

function scanTranscriptHeat(
  transcript: HarnessTranscriptItem[],
  window: LanePeekHeatWindow,
  now: number,
): { tools: number; peerRows: number; permissions: number; errors: number } {
  const cutoff = heatWindowCutoffMs(window, now);
  const timed = window !== 'session';
  const maxItems = window === 'session' ? LANE_PEEK_HEAT_SESSION_TAIL : LANE_PEEK_HEAT_TAIL;
  let tools = 0;
  let peerRows = 0;
  let permissions = 0;
  let errors = 0;
  let scanned = 0;
  for (let i = transcript.length - 1; i >= 0 && scanned < maxItems; i--) {
    const item = transcript[i];
    const t = item.createdAt ?? now;
    if (timed && t < cutoff) break;
    scanned++;
    if (item.kind === 'tool') tools++;
    else if (item.kind === 'inter_lane') peerRows++;
    else if (item.kind === 'permission') permissions++;
    else if (item.kind === 'provider_error') errors++;
  }
  return { tools, peerRows, permissions, errors };
}

function tokenDeltaFromHistory(history: LaneActivitySample[], window: LanePeekHeatWindow, now: number): number | null {
  if (history.length === 0) return null;
  const last = history[history.length - 1];
  if (last.usageUsed === null || !Number.isFinite(last.usageUsed)) return null;
  const cutoff = heatWindowCutoffMs(window, now);
  let oldest: LaneActivitySample | null = null;
  for (let i = history.length - 1; i >= 0; i--) {
    const s = history[i];
    if (window !== 'session' && s.at < cutoff) break;
    oldest = s;
  }
  if (!oldest || oldest.usageUsed === null || !Number.isFinite(oldest.usageUsed)) return null;
  const d = last.usageUsed - oldest.usageUsed;
  return d > 0 ? d : null;
}

function cpuPeakFromHistory(history: LaneActivitySample[], window: LanePeekHeatWindow, now: number): number | null {
  const cutoff = heatWindowCutoffMs(window, now);
  let peak: number | null = null;
  for (const s of history) {
    if (window !== 'session' && s.at < cutoff) continue;
    if (s.cpuPercent === null || !Number.isFinite(s.cpuPercent)) continue;
    peak = peak === null ? s.cpuPercent : Math.max(peak, s.cpuPercent);
  }
  return peak;
}

function heatAlertBoost(lane: LanePeekHeatLaneInput): number {
  if (lane.status === 'error') return 100;
  if (lane.status === 'needs_permission') return 70;
  if (lane.pendingShell) return 55;
  if (lane.status === 'awaiting_peer') return 65;
  return 0;
}

function heatToolScore100(toolDelta: number): number {
  return Math.min(100, Math.max(0, (toolDelta / 8) * 100));
}

function heatTokenScore100(tokenDelta: number | null): number {
  if (tokenDelta === null || tokenDelta <= 0) return 0;
  const v = Math.log10(tokenDelta + 1) / 4;
  return Math.min(100, Math.max(0, v * 100));
}

function heatPeerScore100(peerRows: number, pendingPeerCount: number): number {
  const w = pendingPeerCount * LANE_PEEK_HEAT_PENDING_PEER_WEIGHT;
  const frac = (peerRows + w) / 6;
  return Math.min(100, Math.max(0, frac * 100));
}

function heatProcessScore100(cpuPeak: number | null): number {
  if (cpuPeak === null || !Number.isFinite(cpuPeak)) return 0;
  return Math.min(100, Math.max(0, cpuPeak));
}

type HeatConcreteMetric = Exclude<LanePeekHeatMetric, 'auto'>;

function scoreForConcreteMetric(
  m: HeatConcreteMetric,
  toolS: number,
  tokenS: number,
  peerS: number,
  procS: number,
  alertS: number,
): number {
  switch (m) {
    case 'tools':
      return toolS;
    case 'tokens':
      return tokenS;
    case 'peer':
      return peerS;
    case 'process':
      return procS;
    case 'alerts':
      return alertS;
  }
}

function heatSideLabel(lane: LanePeekHeatLaneInput): string {
  return statusLabel(lane.status);
}

function buildHeatDeltaLine(
  metric: HeatConcreteMetric,
  a: LaneHeatSide,
  b: LaneHeatSide,
  tokensMissing: boolean,
): string {
  if (metric === 'tools') {
    return `tools ${a.toolDelta} vs ${b.toolDelta}`;
  }
  if (metric === 'tokens') {
    if (tokensMissing) return 'tokens --';
    const fa = a.tokenDelta === null ? '--' : `+${formatHeatTokenSuffix(a.tokenDelta)}`;
    const fb = b.tokenDelta === null ? '--' : `+${formatHeatTokenSuffix(b.tokenDelta)}`;
    return `tokens ${fa} vs ${fb}`;
  }
  if (metric === 'peer') {
    return `peer ${a.peerDelta} vs ${b.peerDelta}`;
  }
  if (metric === 'process') {
    const ca = a.cpuPeak === null ? '--' : `${Math.round(a.cpuPeak)}%`;
    const cb = b.cpuPeak === null ? '--' : `${Math.round(b.cpuPeak)}%`;
    return `cpu ${ca} vs ${cb}`;
  }
  return `alerts ${a.label} vs ${b.label}`;
}

function formatHeatTokenSuffix(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return '0';
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}m`;
  if (n >= 1000) return `${(n / 1000).toFixed(1)}k`;
  return String(Math.round(n));
}

function buildLaneHeatSide(
  lane: LanePeekHeatLaneInput,
  window: LanePeekHeatWindow,
  now: number,
  metric: HeatConcreteMetric,
): LaneHeatSide {
  const scan = scanTranscriptHeat(lane.transcript, window, now);
  const tokenDelta = tokenDeltaFromHistory(lane.metricHistory, window, now);
  const cpuPeak = cpuPeakFromHistory(lane.metricHistory, window, now);
  const alertS = heatAlertBoost(lane);
  const toolS = heatToolScore100(scan.tools);
  const tokenS = heatTokenScore100(tokenDelta);
  const peerS = heatPeerScore100(scan.peerRows, lane.pendingPeerCount);
  const procS = heatProcessScore100(cpuPeak);
  const score = Math.round(scoreForConcreteMetric(metric, toolS, tokenS, peerS, procS, alertS));
  return {
    laneId: lane.id,
    displayName: lane.displayName,
    score,
    toolDelta: scan.tools,
    tokenDelta,
    peerDelta: scan.peerRows,
    permissionDelta: scan.permissions,
    errorDelta: scan.errors,
    cpuPeak,
    label: heatSideLabel(lane),
  };
}

/**
 * Derives lane-pair heat for the active lane + peeked lane (slice 109).
 * Pure: callers supply coordinator-derived counts on each `LanePeekHeatLaneInput`.
 */
export function deriveLanePairHeat(
  active: LanePeekHeatLaneInput,
  peeked: LanePeekHeatLaneInput,
  now: number,
  window: LanePeekHeatWindow,
  metric: LanePeekHeatMetric,
): LanePairHeatSummary {
  const scanA = scanTranscriptHeat(active.transcript, window, now);
  const scanP = scanTranscriptHeat(peeked.transcript, window, now);
  const tokA = tokenDeltaFromHistory(active.metricHistory, window, now);
  const tokP = tokenDeltaFromHistory(peeked.metricHistory, window, now);
  const cpuA = cpuPeakFromHistory(active.metricHistory, window, now);
  const cpuP = cpuPeakFromHistory(peeked.metricHistory, window, now);
  const alertA = heatAlertBoost(active);
  const alertP = heatAlertBoost(peeked);
  const subA = {
    toolS: heatToolScore100(scanA.tools),
    tokenS: heatTokenScore100(tokA),
    peerS: heatPeerScore100(scanA.peerRows, active.pendingPeerCount),
    procS: heatProcessScore100(cpuA),
    alertS: alertA,
  };
  const subP = {
    toolS: heatToolScore100(scanP.tools),
    tokenS: heatTokenScore100(tokP),
    peerS: heatPeerScore100(scanP.peerRows, peeked.pendingPeerCount),
    procS: heatProcessScore100(cpuP),
    alertS: alertP,
  };

  let resolved: HeatConcreteMetric;
  if (metric !== 'auto') {
    resolved = metric;
  } else {
    const cand: HeatConcreteMetric[] = ['tools', 'tokens', 'peer', 'process', 'alerts'];
    resolved = 'alerts';
    let best = -1;
    for (const m of cand) {
      const va = scoreForConcreteMetric(m, subA.toolS, subA.tokenS, subA.peerS, subA.procS, subA.alertS);
      const vb = scoreForConcreteMetric(m, subP.toolS, subP.tokenS, subP.peerS, subP.procS, subP.alertS);
      const vmax = Math.max(va, vb);
      if (vmax > best) {
        best = vmax;
        resolved = m;
      }
    }
  }

  const sideA = buildLaneHeatSide(active, window, now, resolved);
  const sideP = buildLaneHeatSide(peeked, window, now, resolved);
  const pairScore = Math.max(sideA.score, sideP.score);
  let dominant: 'active' | 'peeked' | 'balanced' = 'balanced';
  if (sideA.score > sideP.score + 5) dominant = 'active';
  else if (sideP.score > sideA.score + 5) dominant = 'peeked';

  const tokensMissing =
    resolved === 'tokens' && sideA.tokenDelta === null && sideP.tokenDelta === null;
  const unavailableReason =
    resolved === 'tokens' && tokA === null && tokP === null ? 'no usage counters on either lane' : null;

  const deltaLine = buildHeatDeltaLine(resolved, sideA, sideP, tokensMissing);

  return {
    metric: resolved,
    window,
    active: sideA,
    peeked: sideP,
    pairScore,
    dominantSide: dominant,
    unavailableReason,
    deltaLine,
  };
}

function lanePeekPriorityClass(candidate: LanePeekCandidate): 'high' | 'warn' | 'info' {
  const kind = candidate.summary.payload?.kind;
  if (kind === 'permission' || kind === 'error') return 'high';
  if (candidate.summary.status === 'busy' || candidate.summary.status === 'awaiting_peer') return 'warn';
  if (candidate.reasonKey === 'lane-shell') return 'warn';
  return 'info';
}

function renderLanePeekEventRow(candidate: LanePeekCandidate): string {
  const payload = candidate.summary.payload;
  let text = candidate.reasonLabel;
  let meta = '';
  if (payload?.kind === 'permission') {
    text = `▸ approve <b>${esc(payload.toolName)}</b>`;
    meta = esc(truncateInline(payload.subject, 36));
  } else if (payload?.kind === 'peer') {
    const verb = payload.direction === 'in' ? 'message from' : payload.direction === 'out' ? 'sent to' : 'awaiting';
    text = `▸ ${esc(verb)} <b>${esc(payload.peerDisplayName)}</b>`;
    meta = esc(payload.ageLabel);
  } else if (payload?.kind === 'error') {
    text = `▸ <b>${esc(truncateInline(payload.message, 32))}</b>`;
  } else if (payload?.kind === 'activity') {
    text = `▸ ${esc(truncateInline(payload.label, 36))}`;
    meta = esc(payload.ageLabel);
  } else {
    text = `▸ ${esc(candidate.reasonLabel)}`;
  }
  return (
    `<div class="acp-harness__lane-peek-event">` +
      `<span class="acp-harness__lane-peek-event-text">${text}</span>` +
      (meta ? `<span class="acp-harness__lane-peek-event-meta">${meta}</span>` : '') +
    `</div>`
  );
}

function renderLanePeekRow(prefix: string, value: string): string {
  return (
    `<div class="acp-harness__lane-peek-row">` +
      `<span class="acp-harness__lane-peek-prefix">${esc(prefix)}</span>` +
      `<span class="acp-harness__lane-peek-value">${value}</span>` +
    `</div>`
  );
}

function renderLanePeekPlanRow(plan: NonNullable<LanePeekSnapshot['plan']>): string {
  const text = plan.activeText ? truncateInline(plan.activeText, 32) : 'all done';
  return (
    `<div class="acp-harness__lane-peek-row">` +
      `<span class="acp-harness__lane-peek-prefix">plan</span>` +
      `<span class="acp-harness__lane-peek-plan">` +
        `<span class="acp-harness__lane-peek-plan-count">${plan.done}/${plan.total}</span>` +
        `<span class="acp-harness__lane-peek-plan-text">${esc(text)}</span>` +
      `</span>` +
    `</div>`
  );
}

function renderLanePeekStatChips(snapshot: LanePeekSnapshot): string {
  const chips: string[] = [];
  if (snapshot.modelName) chips.push(`<span class="acp-harness__lane-peek-chip">${esc(snapshot.modelName)}</span>`);
  const usage = snapshot.usage;
  if (usage && typeof usage.used === 'number') {
    const used = formatCount(usage.used);
    if (typeof usage.size === 'number' && usage.size > 0) {
      chips.push(`<span class="acp-harness__lane-peek-chip"><b>${esc(used)}</b>/${esc(formatCount(usage.size))}</span>`);
    } else {
      chips.push(`<span class="acp-harness__lane-peek-chip"><b>${esc(used)}</b> ctx</span>`);
    }
  }
  const m = snapshot.metrics;
  if (m && m.proc_count > 0) {
    const hot = m.total_cpu_percent >= 80 || m.total_rss_mb >= 1500;
    const cls = hot ? 'acp-harness__lane-peek-chip acp-harness__lane-peek-chip--hot' : 'acp-harness__lane-peek-chip';
    const cpu = Math.round(m.total_cpu_percent);
    const mem = m.total_rss_mb >= 1024 ? `${(m.total_rss_mb / 1024).toFixed(1)}G` : `${Math.round(m.total_rss_mb)}M`;
    chips.push(`<span class="${cls}"><b>${cpu}%</b> ${esc(mem)}</span>`);
  }
  const mcp = snapshot.mcp;
  if (mcp && mcp.toolsCallCount > 0) {
    chips.push(`<span class="acp-harness__lane-peek-chip">mcp <b>${mcp.toolsCallCount}</b></span>`);
  }
  if (chips.length === 0) return '';
  return `<footer class="acp-harness__lane-peek-foot">${chips.join('')}</footer>`;
}

function lanePeekAgeLabel(snapshot: LanePeekSnapshot, candidate: LanePeekCandidate, now: number): string {
  if (snapshot.status === 'busy' && snapshot.activeTurnStartedAt) {
    return formatElapsed(now - snapshot.activeTurnStartedAt);
  }
  const at = candidate.at;
  if (!at) return '';
  return formatCoarseAge(now - at);
}

function renderLanePeek(
  candidate: LanePeekCandidate,
  snapshot: LanePeekSnapshot | null,
  locked: boolean,
): HTMLElement {
  const el = document.createElement('aside');
  el.className = 'acp-harness__lane-peek';
  el.dataset.reason = candidate.reasonKey;
  el.dataset.priority = lanePeekPriorityClass(candidate);
  const now = Date.now();
  const age = snapshot ? lanePeekAgeLabel(snapshot, candidate, now) : '';
  const statusText = `${statusLabel(candidate.summary.status)}${locked ? ' · locked' : ''}`;
  let html =
    `<header class="acp-harness__lane-peek-head">` +
      `<span class="acp-harness__lane-peek-name">${esc(candidate.displayName)}</span>` +
      `<span class="acp-harness__lane-peek-status">${esc(statusText)}</span>` +
      (age ? `<span class="acp-harness__lane-peek-age">${esc(age)}</span>` : '') +
    `</header>` +
    renderLanePeekEventRow(candidate);

  if (snapshot?.plan) html += renderLanePeekPlanRow(snapshot.plan);

  if (snapshot?.pendingShell && candidate.reasonKey !== 'lane-shell') {
    html += renderLanePeekRow('shell', '<b>running</b>');
  }

  if (snapshot?.activeTool && snapshot.status === 'busy') {
    const subject = snapshot.activeTool.subject ? ` · ${esc(snapshot.activeTool.subject)}` : '';
    html += renderLanePeekRow('tool', `<b>${esc(snapshot.activeTool.name)}</b>${subject}`);
  } else if (snapshot?.latestMeaningful && candidate.summary.payload?.kind !== 'activity') {
    const label = truncateInline(snapshot.latestMeaningful.label, 40);
    html += renderLanePeekRow('last', esc(label));
  }

  if (snapshot?.recentFiles && snapshot.recentFiles.length > 0) {
    const files = snapshot.recentFiles.map((p) => basename(p)).join(', ');
    html += renderLanePeekRow('files', esc(truncateInline(files, 40)));
  }

  if (snapshot && snapshot.inboxDepth > 0) {
    html += renderLanePeekRow('inbox', `<b>${snapshot.inboxDepth}</b> pending`);
  }

  if (snapshot) {
    html += '<div class="acp-harness__lane-peek-heat-root"></div>';
    html += renderLanePeekStatChips(snapshot);
  }

  el.innerHTML = html;
  return el;
}

export interface RailPeerHint {
  awaitingSuffix: string;
  inboxSuffix: string;
  trafficSuffix: string;
  title: string;
  kind: 'none' | 'awaiting' | 'inbox' | 'traffic';
}

export interface DeriveRailPeerHintInput {
  pendingPeers: PendingPeerSummary[];
  inboxDepth: number;
  latestInterLane: LanePeekSnapshot['latestInterLane'];
}

export function deriveRailPeerHint(
  input: DeriveRailPeerHintInput,
  getLaneStatus: (laneId: string) => HarnessLaneStatus | null,
  now: number,
): RailPeerHint {
  const { pendingPeers, inboxDepth, latestInterLane } = input;
  const titleParts: string[] = [];
  let awaitingSuffix = '';
  let inboxSuffix = '';
  let trafficSuffix = '';
  if (pendingPeers.length > 0) {
    awaitingSuffix = '⇆';
    const oldest = pendingPeers.reduce((min, peer) => (peer.sentAt < min.sentAt ? peer : min), pendingPeers[0]);
    const age = formatAwaitingPeerAge(now - oldest.sentAt);
    if (pendingPeers.length === 1) titleParts.push(`awaiting ${oldest.toDisplayName} · ${age}`);
    else titleParts.push(`awaiting ${pendingPeers.length} peers · ${age}`);
  }
  if (inboxDepth > 0) {
    inboxSuffix = `▼${inboxDepth}`;
    titleParts.push(`${inboxDepth} peer message${inboxDepth === 1 ? '' : 's'} queued`);
  }
  let kind: RailPeerHint['kind'] = 'none';
  if (pendingPeers.length > 0) kind = 'awaiting';
  else if (inboxDepth > 0) kind = 'inbox';
  const hasAwaitingOrInbox = pendingPeers.length > 0 || inboxDepth > 0;
  if (!hasAwaitingOrInbox && latestInterLane && latestInterLane.peerId !== '__harness__') {
    const ageMs = now - latestInterLane.at;
    if (ageMs <= LANE_PEEK_RECENT_MS) {
      if (latestInterLane.direction === 'in') {
        trafficSuffix = '←';
        titleParts.push(`message from ${latestInterLane.peerDisplayName}`);
        kind = 'traffic';
      } else {
        const counterpart = getLaneStatus(latestInterLane.peerId);
        if (counterpart === 'busy' || counterpart === 'awaiting_peer') {
          trafficSuffix = '→';
          titleParts.push(`sent to ${latestInterLane.peerDisplayName}`);
          kind = 'traffic';
        }
      }
    }
  }
  return { awaitingSuffix, inboxSuffix, trafficSuffix, title: titleParts.join(' · '), kind };
}

/**
 * spec 118 — emit a single wrapper span around peer glyphs so the rail entry
 * grid (dot | name | peers | tools | ctx) has stable column placement even
 * when only some glyphs are present. Returns '' when there are no glyphs;
 * the wrapper column is `auto` so an absent wrapper collapses to zero width.
 */
function renderRailPeerSpans(hint: RailPeerHint): string {
  let glyphs = '';
  if (hint.awaitingSuffix) {
    glyphs += `<span class="acp-harness__rail-peer acp-harness__rail-peer--awaiting">${esc(hint.awaitingSuffix)}</span>`;
  }
  if (hint.inboxSuffix) {
    glyphs += `<span class="acp-harness__rail-peer acp-harness__rail-peer--inbox">${esc(hint.inboxSuffix)}</span>`;
  }
  if (hint.trafficSuffix) {
    glyphs += `<span class="acp-harness__rail-peer acp-harness__rail-peer--traffic">${esc(hint.trafficSuffix)}</span>`;
  }
  if (!glyphs) return '';
  return `<span class="acp-harness__rail-peers">${glyphs}</span>`;
}

/** spec 118 — composer status strip above input (informational; spec 116 soft awaiting). */
export function buildComposerPeerStrip(
  laneStatus: HarnessLaneStatus,
  pendingPeers: PendingPeerSummary[],
  inboxDepth: number,
): string {
  if (pendingPeers.length > 0) {
    const body = awaitingPeerText(pendingPeers).replace(/ · #cancel$/, '');
    return (
      `<div class="acp-harness__composer-peer" role="status">` +
      `⇆ ${esc(body)} · #cancel drops pending lane-mail wait` +
      `</div>`
    );
  }
  if (inboxDepth > 0) {
    return (
      `<div class="acp-harness__composer-peer" role="status">` +
      `${esc(`▼${inboxDepth} lane mail${inboxDepth === 1 ? '' : 's'} queued`)}` +
      `</div>`
    );
  }
  if (laneStatus === 'awaiting_peer') {
    return (
      `<div class="acp-harness__composer-peer" role="status">` +
      `${esc('awaiting lane mail · #cancel drops pending wait')}` +
      `</div>`
    );
  }
  return '';
}

/**
 * spec 118: a direct peer event (priority ≤30 = awaiting / inbound / counterpart)
 * preempts a prior `Esc` dismissal — but ONLY when that peer event happened
 * *after* the dismissal. Re-opening the same dismissed candidate on every render
 * would make Esc useless whenever a peer candidate is sitting in the snapshot.
 */
export function shouldPreemptPeekDismissal(
  candidates: LanePeekCandidate[],
  dismissedAt: number | null,
): boolean {
  if (dismissedAt === null) return false;
  const top = candidates[0];
  return !!(
    top &&
    top.priority <= PEER_PREEMPT_MAX_PRIORITY &&
    top.summary.payload?.kind === 'peer' &&
    top.at > dismissedAt
  );
}

export function buildLanePeekCandidates(snapshots: LanePeekSnapshot[], now: number): LanePeekCandidate[] {
  const active = snapshots.find((lane) => lane.active);
  if (!active) return [];
  const byId = new Map(snapshots.map((lane) => [lane.laneId, lane]));
  const candidates = new Map<string, LanePeekCandidate>();
  const add = (candidate: LanePeekCandidate): void => {
    const prev = candidates.get(candidate.laneId);
    if (!prev || compareLanePeekCandidates(candidate, prev) < 0) candidates.set(candidate.laneId, candidate);
  };
  const oldestPendingPeer = active.pendingPeers.reduce<PendingPeerSummary | null>(
    (oldest, peer) => !oldest || peer.sentAt < oldest.sentAt ? peer : oldest,
    null,
  );
  if (oldestPendingPeer) {
    const lane = byId.get(oldestPendingPeer.toLaneId);
    if (lane && laneCanPeek(lane)) {
      add(makePeerCandidate(lane, 10, true, 'awaiting-peer', 'awaiting reply', 'awaiting', active.displayName, oldestPendingPeer.sentAt, now));
    }
  }
  if (active.latestInterLane?.direction === 'in') {
    const lane = byId.get(active.latestInterLane.peerId);
    if (lane && laneCanPeek(lane)) {
      add(makePeerCandidate(lane, 20, true, 'inbound-peer', 'peer message', 'in', active.displayName, active.latestInterLane.at, now));
    }
  }
  if (active.latestInterLane?.direction === 'out') {
    const lane = byId.get(active.latestInterLane.peerId);
    if (lane && laneCanPeek(lane) && (lane.status === 'busy' || lane.status === 'awaiting_peer' || now - active.latestInterLane.at <= LANE_PEEK_RECENT_MS)) {
      add(makePeerCandidate(lane, 30, true, 'peer-counterpart', 'peer counterpart', 'out', active.displayName, active.latestInterLane.at, now));
    }
  }
  const activeText = `${active.latestMeaningful?.label ?? ''} ${active.latestInterLane?.message ?? ''}`.toLowerCase();
  for (const lane of snapshots) {
    if (!laneCanPeek(lane)) continue;
    if (lane.latestPermission && lane.status === 'needs_permission' && pathMatchesText(lane.latestPermission.subject, activeText)) {
      add(makePermissionCandidate(lane, 40, true, 'related-permission', 'related permission', lane.latestPermission));
    }
    if (lane.status === 'error') add(makeErrorCandidate(lane, 50, false, 'lane-error', 'lane error', now));
    if (lane.status === 'needs_permission' && lane.latestPermission) {
      add(makePermissionCandidate(lane, 60, false, 'lane-permission', 'permission required', lane.latestPermission));
    }
    if (lane.pendingShell) {
      add(makeActivityCandidate(lane, 65, false, 'lane-shell', 'shell running', 'shell command running', now, now));
    }
    if (lane.inboxDepth > 0) add(makeActivityCandidate(lane, 70, false, 'lane-inbox', 'inbox pending', `inbox ${lane.inboxDepth}`, now, now));
    if (lane.latestMeaningful && now - lane.latestMeaningful.at <= LANE_PEEK_RECENT_MS) {
      add(makeActivityCandidate(lane, 80, false, 'recent-activity', 'recent activity', lane.latestMeaningful.label, lane.latestMeaningful.at, now));
    }
  }
  return Array.from(candidates.values()).sort(compareLanePeekCandidates);
}

export function selectLanePeekCandidate(
  candidates: LanePeekCandidate[],
  state: Pick<LanePeekState, 'currentLaneId' | 'lockedLaneId' | 'selectedAt' | 'dismissedAt' | 'dismissedPriority'>,
  now: number,
): LanePeekCandidate | null {
  if (candidates.length === 0) return null;
  if (state.lockedLaneId) {
    const locked = candidates.find((candidate) => candidate.laneId === state.lockedLaneId);
    if (locked) return locked;
  }
  const best = candidates[0];
  const current = candidates.find((candidate) => candidate.laneId === state.currentLaneId) ?? null;
  if (state.dismissedAt !== null && state.dismissedPriority !== null && best.priority >= state.dismissedPriority) return null;
  if (!current || current.laneId === best.laneId) return best;
  const dwellMet = now - state.selectedAt >= LANE_PEEK_DWELL_MS;
  const strongPreempt = best.priority <= current.priority - 20;
  return dwellMet || strongPreempt ? best : current;
}

function laneCanPeek(lane: LanePeekSnapshot): boolean {
  return !lane.active && !lane.stopped;
}

function compareLanePeekCandidates(a: LanePeekCandidate, b: LanePeekCandidate): number {
  if (a.priority !== b.priority) return a.priority - b.priority;
  if (a.direct !== b.direct) return a.direct ? -1 : 1;
  if (a.at !== b.at) return b.at - a.at;
  if (a.visualIndex !== b.visualIndex) return a.visualIndex - b.visualIndex;
  return a.laneId.localeCompare(b.laneId);
}

function makePeerCandidate(
  lane: LanePeekSnapshot,
  priority: number,
  direct: boolean,
  reasonKey: string,
  reasonLabel: string,
  direction: 'in' | 'out' | 'awaiting',
  peerDisplayName: string,
  at: number,
  now: number,
): LanePeekCandidate {
  return {
    laneId: lane.laneId,
    displayName: lane.displayName,
    priority,
    direct,
    reasonKey,
    reasonLabel,
    at,
    visualIndex: lane.visualIndex,
    summary: {
      status: lane.status,
      headline: statusLabel(lane.status),
      detail: null,
      payload: { kind: 'peer', direction, peerDisplayName, ageLabel: formatCoarseAge(now - at) },
    },
  };
}

function makePermissionCandidate(
  lane: LanePeekSnapshot,
  priority: number,
  direct: boolean,
  reasonKey: string,
  reasonLabel: string,
  permission: NonNullable<LanePeekSnapshot['latestPermission']>,
): LanePeekCandidate {
  return {
    laneId: lane.laneId,
    displayName: lane.displayName,
    priority,
    direct,
    reasonKey,
    reasonLabel,
    at: permission.at,
    visualIndex: lane.visualIndex,
    summary: {
      status: lane.status,
      headline: 'permission required',
      detail: permission.subject,
      payload: { kind: 'permission', toolName: permission.toolName, subject: permission.subject, decision: permission.decision },
    },
  };
}

function makeErrorCandidate(lane: LanePeekSnapshot, priority: number, direct: boolean, reasonKey: string, reasonLabel: string, now: number): LanePeekCandidate {
  return {
    laneId: lane.laneId,
    displayName: lane.displayName,
    priority,
    direct,
    reasonKey,
    reasonLabel,
    at: now,
    visualIndex: lane.visualIndex,
    summary: {
      status: lane.status,
      headline: 'error',
      detail: lane.error,
      payload: { kind: 'error', message: lane.error ?? 'failed' },
    },
  };
}

function makeActivityCandidate(
  lane: LanePeekSnapshot,
  priority: number,
  direct: boolean,
  reasonKey: string,
  reasonLabel: string,
  label: string,
  at: number,
  now: number,
): LanePeekCandidate {
  return {
    laneId: lane.laneId,
    displayName: lane.displayName,
    priority,
    direct,
    reasonKey,
    reasonLabel,
    at,
    visualIndex: lane.visualIndex,
    summary: {
      status: lane.status,
      headline: statusLabel(lane.status),
      detail: label,
      payload: { kind: 'activity', label, ageLabel: formatCoarseAge(now - at) },
    },
  };
}

function pathMatchesText(path: string, text: string): boolean {
  if (!path || !text) return false;
  const normalized = path.toLowerCase();
  const base = basename(path).toLowerCase();
  return text.includes(normalized) || (base.length > 2 && text.includes(base));
}

function latestInterLaneForPeek(lane: HarnessLane): LanePeekSnapshot['latestInterLane'] {
  for (let i = lane.transcript.length - 1; i >= 0; i--) {
    const item = lane.transcript[i];
    if (item.kind !== 'inter_lane' || !item.interLane) continue;
    return {
      direction: item.interLane.direction,
      peerId: item.interLane.peerId,
      peerDisplayName: item.interLane.peerDisplayName,
      at: item.createdAt ?? Date.now(),
      message: item.text,
    };
  }
  return null;
}

function latestPermissionForPeek(lane: HarnessLane): LanePeekSnapshot['latestPermission'] {
  const permission = lane.pendingPermissions[0]?.transcriptItem?.permission;
  if (permission) {
    return {
      toolName: permission.toolName,
      subject: permission.subject,
      decision: permission.decision,
      at: Date.now(),
    };
  }
  for (let i = lane.transcript.length - 1; i >= 0; i--) {
    const item = lane.transcript[i];
    if (item.kind === 'permission' && item.permission) {
      return {
        toolName: item.permission.toolName,
        subject: item.permission.subject,
        decision: item.permission.decision,
        at: item.createdAt ?? Date.now(),
      };
    }
  }
  return null;
}

function latestMeaningfulForPeek(lane: HarnessLane): LanePeekSnapshot['latestMeaningful'] {
  for (let i = lane.transcript.length - 1; i >= 0; i--) {
    const item = lane.transcript[i];
    if (!['tool', 'permission', 'inter_lane', 'shell', 'fs_activity', 'fs_write_review'].includes(item.kind)) continue;
    return {
      kind: item.kind,
      label: item.text.replace(/\s+/g, ' ').trim(),
      at: item.createdAt ?? Date.now(),
    };
  }
  return null;
}

function derivePlanForPeek(lane: HarnessLane): LanePeekSnapshot['plan'] {
  if (!lane.plan || lane.plan.length === 0) return null;
  const total = lane.plan.length;
  const done = lane.plan.filter((entry) => entry.status === 'completed').length;
  const active = lane.plan.find((entry) => entry.status === 'in_progress');
  const next = lane.plan.find((entry) => entry.status === 'pending');
  const activeText = active?.content ?? next?.content ?? null;
  return { done, total, activeText: activeText ? activeText.replace(/\s+/g, ' ').trim() : null };
}

function deriveActiveToolForPeek(lane: HarnessLane, now: number): LanePeekSnapshot['activeTool'] {
  // Pick the oldest still-pending/in_progress tool — the likely blocking call. Map iteration
  // is insertion order so the first match is also the oldest.
  for (const call of lane.toolCalls.values()) {
    if (call.status !== 'in_progress' && call.status !== 'pending') continue;
    const name = call.title?.replace(/\s+/g, ' ').trim() || (call.kind ?? 'tool');
    const loc = call.locations?.[0]?.path ?? null;
    const subject = loc ? basename(loc) : null;
    return { name, subject, startedAt: lane.activeTurnStartedAt ?? now };
  }
  return null;
}

function deriveRecentFilesForPeek(laneId: string, touchMap: Map<string, FileTouchRecord>, now: number): string[] {
  const mine: FileTouchRecord[] = [];
  for (const rec of touchMap.values()) {
    if (rec.laneId !== laneId) continue;
    if (now - rec.at > FILE_TOUCH_WINDOW_MS) continue;
    mine.push(rec);
  }
  mine.sort((a, b) => b.at - a.at);
  return mine.slice(0, 2).map((r) => r.path);
}

function formatCoarseAge(ms: number): string {
  if (!Number.isFinite(ms) || ms < 60_000) return '<1m';
  if (ms < 5 * 60_000) return '1m+';
  if (ms < 15 * 60_000) return '5m+';
  return '15m+';
}

function mergeUsage(prev: UsageInfo | null, next: UsageInfo): UsageInfo {
  return { ...(prev ?? {}), ...next };
}

function laneActivity(lane: HarnessLane, pendingPeers: PendingPeerSummary[] = []): string {
  if (lane.status === 'error') return `error: ${lane.error ?? 'failed'}`;
  if (lane.status === 'needs_permission') {
    const permission = lane.pendingPermissions[0];
    if (!permission) return 'perm required';
    return `perm ${compactPermissionSubject(permission.toolCall) || compactPermissionTool(permission)}`;
  }
  if (lane.status === 'awaiting_peer') return awaitingPeerText(pendingPeers);
  const latest = lane.transcript[lane.transcript.length - 1];
  if (!latest) return lane.status;
  return latest.text.replace(/\s+/g, ' ').slice(0, 60);
}

function compactPermissionLabel(permission: HarnessPermission): string {
  const tool = compactPermissionTool(permission);
  const subject = compactPermissionSubject(permission.toolCall);
  return truncateInline(subject ? `${tool} ${subject}` : tool, 48);
}

function compactPermissionMeta(permission: HarnessPermission): string {
  return `${compactPermissionLabel(permission)} · a/r/Esc`;
}

function compactPermissionTool(permission: HarnessPermission): string {
  const call = permission.toolCall;
  const kind = inferToolLabel(call);
  return harnessAutoAllowToolName(permission) ?? (cleanToolTitle(call.title, kind) || kind);
}

function compactPermissionSubject(call: ToolCall | ToolCallUpdate): string {
  const path = extractModifiedPath(call) ?? call.locations?.[0]?.path ?? '';
  if (path) return basename(path);
  const command = extractCommandLine(call.rawInput);
  if (command) return truncateInline(command, 28);
  return '';
}

function awaitingPeerText(pendingPeers: PendingPeerSummary[]): string {
  if (pendingPeers.length === 0) return 'awaiting lane mail reply · #cancel';
  const oldest = pendingPeers.reduce((min, peer) => peer.sentAt < min.sentAt ? peer : min, pendingPeers[0]);
  const age = formatAwaitingPeerAge(Date.now() - oldest.sentAt);
  if (pendingPeers.length === 1) return `awaiting ${oldest.toDisplayName} · ${age} · #cancel`;
  return `awaiting ${pendingPeers.length} peers · ${age} · #cancel`;
}

function formatAwaitingPeerAge(ms: number): string {
  if (!Number.isFinite(ms) || ms < 60_000) return '<1m';
  if (ms < 5 * 60_000) return '1m+';
  if (ms < 15 * 60_000) return '5m+';
  return '15m+';
}

function statusIconId(status: HarnessLaneStatus): string {
  switch (status) {
    case 'starting': return 'status-starting';
    case 'idle': return 'status-idle';
    case 'busy': return 'status-busy';
    case 'needs_permission': return 'status-perm';
    case 'awaiting_peer': return 'status-peer';
    case 'error': return 'status-error';
    case 'stopped': return 'status-error';
  }
}

// Row-1 leading status glyph as an SVG, in a state-tinted wrapper so CSS can
// colour idle/busy/permission/peer/error distinctly (was Unicode · ○ ● ! ⇆ ×).
function renderLaneSymbol(status: HarnessLaneStatus): string {
  // busy → braille spinner glyph advanced by the JS ticker (tickSpinner); every
  // other status → static SVG status icon.
  const inner = status === 'busy'
    ? `<span class="acp-harness__spinner">${SPINNER_FRAMES[0]}</span>`
    : harnessIcon(statusIconId(status));
  return (
    `<span class="acp-harness__lane-symbol acp-harness__lane-symbol--${status}">` +
    inner +
    `</span>`
  );
}

function statusLabel(status: HarnessLaneStatus): string {
  switch (status) {
    case 'starting': return 'starting';
    case 'idle': return 'idle';
    case 'busy': return 'busy';
    case 'needs_permission': return 'action required';
    case 'awaiting_peer': return 'awaiting peer';
    case 'error': return 'error';
    case 'stopped': return 'stopped';
  }
}

function statusGlyph(status: string): string {
  if (status === 'completed') return '✓';
  if (status === 'failed') return '✗';
  if (status === 'in_progress') return '⟳';
  return '·';
}

function mergeToolCall(
  previous: ToolCall | ToolCallUpdate | undefined,
  next: ToolCall | ToolCallUpdate,
): ToolCall | ToolCallUpdate {
  return {
    ...previous,
    ...next,
    title: next.title ?? previous?.title,
    kind: next.kind ?? previous?.kind,
    content: next.content ?? previous?.content,
    locations: next.locations ?? previous?.locations,
    rawInput: next.rawInput ?? previous?.rawInput,
    rawOutput: next.rawOutput ?? previous?.rawOutput,
  };
}

function inferToolLabel(call: ToolCall | ToolCallUpdate): string {
  const kind = call.kind;
  if (kind && kind !== 'other') return kind;
  if (extractCommandLine(call.rawInput)) return 'execute';
  const rawName = extractRawToolName(call.rawInput);
  if (rawName) return rawName;
  const title = cleanToolTitle(call.title, 'tool').toLowerCase();
  if (/^(bash|shell|terminal|run|exec|execute|command)\b/.test(title)) return 'execute';
  if (/^(edit|write|create|modify|patch)\b/.test(title)) return 'edit';
  if (/^(read|open|cat)\b/.test(title)) return 'read';
  if (/^(search|grep|rg|find)\b/.test(title)) return 'search';
  if (/^(fetch|web|http)\b/.test(title)) return 'fetch';
  return title || 'tool';
}

function extractRawToolName(rawInput: unknown): string {
  if (typeof rawInput !== 'object' || !rawInput) return '';
  const record = rawInput as Record<string, unknown>;
  for (const key of ['toolName', 'tool_name', 'name', 'tool', 'type']) {
    const value = record[key];
    if (typeof value === 'string' && value.trim()) return truncateInline(value, 40);
  }
  return '';
}

function isMemoryTool(call: ToolCall | ToolCallUpdate): boolean {
  const rawName = extractRawToolName(call.rawInput).toLowerCase();
  const title = (call.title ?? '').toLowerCase();
  return rawName.startsWith('memory_') || title.includes('memory_');
}

function cleanToolTitle(title: string | undefined, fallback: string): string {
  const value = title?.trim() ?? '';
  if (!value || value.toLowerCase() === 'tool' || value.toLowerCase() === fallback) return '';
  if (/^tool\s+exit\s+\d+$/i.test(value)) return '';
  return value;
}

/** Full command string from a tool's rawInput, UNTRUNCATED. Used by policy
 *  (spec 143 high-risk gating) — must never be the 96-char display form, or a
 *  destructive tail past the cutoff (`echo …<96> && rm -rf x`) would be hidden. */
function extractCommandLineRaw(rawInput: unknown): string {
  if (typeof rawInput === 'object' && rawInput) {
    const record = rawInput as Record<string, unknown>;
    for (const key of ['command', 'cmd']) {
      if (typeof record[key] === 'string') return record[key];
    }
    if (Array.isArray(record.argv)) {
      const argv = record.argv.filter((part): part is string => typeof part === 'string');
      if (argv.length > 0) return argv.join(' ');
    }
  }
  return '';
}

/** Display form — truncated for transcript/label rendering. */
function extractCommandLine(rawInput: unknown): string {
  const raw = extractCommandLineRaw(rawInput);
  return raw ? truncateInline(raw, 96) : '';
}

/** Is this tool call an execute/shell surface (even when its command string is
 *  not extractable)? Conservative: kind, a present command, or a shell-ish raw
 *  name / title all count. */
/** A leading shell/exec verb. Shared by the rawName and title checks so the
 *  policy gate can't drift between the two surfaces (Codex-1 nit, spec 143). */
const SHELL_LIKE_PREFIX = /^(bash|shell|terminal|run|exec|execute|command|sh|zsh|fish|cmd|powershell|pwsh)\b/;

function isExecuteLikeToolCall(call: Pick<ToolCall, 'rawInput' | 'kind' | 'title'>): boolean {
  if (call.kind === 'execute') return true;
  if (extractCommandLineRaw(call.rawInput)) return true;
  if (SHELL_LIKE_PREFIX.test(extractRawToolName(call.rawInput).toLowerCase())) return true;
  return SHELL_LIKE_PREFIX.test((call.title ?? '').trim().toLowerCase());
}

/** spec 143 policy: should this permission still prompt the human under peer
 *  auto-accept? A parseable command is classified via the spec 140 highRisk set;
 *  an execute-like surface whose command cannot be read is treated as high-risk
 *  (unknown ⇒ high-risk); any other surface (edit/read/write/fetch) is not gated
 *  here (writes are diff-shown + VCS-recoverable). */
export function permissionCommandIsHighRisk(
  call: Pick<ToolCall, 'rawInput' | 'kind' | 'title'>,
): boolean {
  const command = extractCommandLineRaw(call.rawInput);
  if (command) return classifyBashCommand(command).highRisk;
  return isExecuteLikeToolCall(call);
}

function extractToolExit(rawOutput: unknown): string {
  if (typeof rawOutput !== 'object' || !rawOutput) return '';
  const record = rawOutput as Record<string, unknown>;
  for (const key of ['exitCode', 'exit_code', 'code']) {
    const value = record[key];
    if (typeof value === 'number') return value === 0 ? '' : `exit ${value}`;
  }
  return '';
}

export function rawOutputSections(rawOutput: unknown): Array<{ label: string; text: string }> {
  const decodedRoot = decodeByteArray(rawOutput);
  if (decodedRoot !== null) return decodedRoot ? [{ label: 'output', text: decodedRoot }] : [];
  if (typeof rawOutput === 'object' && rawOutput) {
    const record = rawOutput as Record<string, unknown>;
    const sections: Array<{ label: string; text: string }> = [];
    for (const key of ['summary', 'stdout', 'stderr', 'output', 'content', 'text', 'message']) {
      const text = stringifyToolValue(record[key]);
      if (text) sections.push({ label: key, text });
    }
    return sections;
  }
  const text = stringifyToolValue(rawOutput);
  return text ? [{ label: 'output', text }] : [];
}

function contentOutputSections(content: ToolCall['content']): Array<{ label: string; text: string }> {
  const sections: Array<{ label: string; text: string }> = [];
  for (const item of content ?? []) {
    // 'diff' items are rendered by extractToolDiffs/renderToolBody as HTML blocks.
    if (item.type === 'terminal' && item.terminalId) sections.push({ label: 'terminal', text: item.terminalId });
    if (item.type === 'content' && item.content) {
      const text = contentBlockText(item.content);
      if (text) sections.push({ label: 'content', text });
    }
  }
  return sections;
}

function contentBlockText(block: ContentBlock): string {
  if (block.type === 'text') return block.text;
  if (block.type === 'resource' && block.resource.text) return block.resource.text;
  if (block.type === 'resource_link') return block.uri;
  return '';
}

const byteArrayDecoder = new TextDecoder();

/**
 * Some ACP backends (Grok's `grok agent stdio`) serialize terminal/command output as a
 * raw byte array (a JSON `number[]` of 0–255 values) instead of a decoded UTF-8 string.
 * Detect that shape and decode it back to text; otherwise the generic array branch below
 * would stringify each byte and join them, rendering "79 110 32 …" decimal dumps in the
 * tool-output panel. Returns null when `value` is not a byte array (so callers fall back
 * to their normal handling).
 */
function decodeByteArray(value: unknown): string | null {
  if (!Array.isArray(value) || value.length === 0) return null;
  for (const n of value) {
    if (typeof n !== 'number' || !Number.isInteger(n) || n < 0 || n > 255) return null;
  }
  const decoded = byteArrayDecoder.decode(Uint8Array.from(value as number[]));
  // Validate it's actually text, not a semantic number array (RGB tuples, flag
  // vectors, line counts) that happens to sit in 0–255. Real command output is
  // near-printable; a semantic array decodes to mostly control / replacement
  // chars. Reject when >30% of chars are non-text (tab/newline/CR stay allowed).
  let bad = 0;
  for (const ch of decoded) {
    const code = ch.codePointAt(0) ?? 0;
    const printable = code === 9 || code === 10 || code === 13 || (code >= 32 && code !== 127 && code !== 0xfffd);
    if (!printable) bad += 1;
  }
  if (bad / decoded.length > 0.3) return null;
  return decoded;
}

export function stringifyToolValue(value: unknown): string {
  if (value === null || value === undefined) return '';
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (Array.isArray(value)) {
    const decoded = decodeByteArray(value);
    if (decoded !== null) return decoded;
    return value.map((item) => stringifyToolValue(item)).filter(Boolean).join(' ');
  }
  if (typeof value === 'object') {
    const record = value as Record<string, unknown>;
    for (const key of ['summary', 'stdout', 'stderr', 'output', 'content', 'text', 'message']) {
      const nested = stringifyToolValue(record[key]);
      if (nested) return nested;
    }
  }
  return '';
}

export function boundedOutputLines(value: string, maxLines: number): string {
  // Backends that captured their tool output under a PTY / forced color (e.g. `gh`
  // colorizing JSON) hand us raw ANSI SGR codes. This panel renders via
  // `pre.textContent`, so an unhandled ESC (0x1b) byte shows as a garbage glyph and
  // the trailing `[1;37m` shows as literal text. Strip ANSI + leftover C0/C1 control
  // chars here (keeping \t and \n) so every lane's output reads clean.
  const kept = stripAnsi(value)
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '')
    .replace(/\r/g, '')
    .split('\n')
    .map((line) => line.replace(/\s+$/, ''))
    .filter((line) => line.length > 0)
    .slice(0, maxLines);
  let minIndent = Infinity;
  for (const line of kept) {
    const match = line.match(/^[ \t]*/);
    const indent = match ? match[0].length : 0;
    if (indent < minIndent) minIndent = indent;
    if (minIndent === 0) break;
  }
  if (!Number.isFinite(minIndent)) minIndent = 0;
  return kept
    .map((line) => line.slice(minIndent))
    .map((line) => (line.length > 140 ? `${line.slice(0, 139).trimEnd()}…` : line))
    .join('\n');
}

function truncateInline(value: string, max: number): string {
  const normalized = value.replace(/\s+/g, ' ').trim();
  if (normalized.length <= max) return normalized;
  return `${normalized.slice(0, Math.max(0, max - 1)).trimEnd()}…`;
}

function abbreviatePath(path: string): string {
  const home = getHomeLikePrefix();
  const p = home && path.startsWith(home) ? `~${path.slice(home.length)}` : path;
  const parts = p.split('/').filter(Boolean);
  if (parts.length <= 3) return p;
  return `${p.startsWith('~') ? '~/' : '/'}.../${parts.slice(-2).join('/')}`;
}

function pathToFileUri(path: string): string {
  if (path.startsWith('file://')) return path;
  return `file://${path.split('/').map((part) => encodeURIComponent(part)).join('/')}`;
}

let cachedHomeDir: string | null = null;
let homeDirLoad: Promise<string | null> | null = null;

function loadHomeDir(): Promise<string | null> {
  if (cachedHomeDir) return Promise.resolve(cachedHomeDir);
  if (!homeDirLoad) {
    homeDirLoad = invoke<string | null>('get_env_var', { name: 'HOME' })
      .then((value) => {
        const trimmed = value ? value.replace(/\/+$/, '') : null;
        cachedHomeDir = trimmed || null;
        return cachedHomeDir;
      })
      .catch(() => null);
  }
  return homeDirLoad;
}

function getHomeLikePrefix(): string | null {
  if (cachedHomeDir) return cachedHomeDir;
  const match = location.pathname.match(/^\/Users\/[^/]+/);
  return match ? match[0] : null;
}

function formatAge(ms: number): string {
  const minutes = Math.max(1, Math.round(ms / 60000));
  return minutes < 60 ? `${minutes}m` : `${Math.round(minutes / 60)}h`;
}

function formatElapsed(ms: number): string {
  const totalSeconds = Math.max(0, Math.floor(ms / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}:${seconds.toString().padStart(2, '0')}`;
}

/** spec 156: activity segment of the busy chip. Tool titles are hard-truncated
 *  so a full-path title cannot push the chip past one line. */
function formatLaneActivity(activity: LaneActivity): string {
  if (activity.kind === 'thinking') return 'thinking…';
  if (activity.kind === 'writing') return 'writing…';
  return `⚒ ${truncate(activity.label, 32)}`;
}

function formatShortTime(epochMs: number): string {
  const age = Date.now() - epochMs;
  if (age >= 0 && age < 24 * 60 * 60 * 1000) return `${formatAge(age)} ago`;
  return new Date(epochMs).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

/** spec 146: review matrix round timestamp — clock time today, else "Mon D · HH:MM". */
function formatReviewRoundTime(epochMs: number): string {
  const d = new Date(epochMs);
  const time = d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
  const sameDay = new Date().toDateString() === d.toDateString();
  if (sameDay) return time;
  return `${d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })} · ${time}`;
}

/** Parse optional review_outcome findings from the acp-review-outcome event payload.
 * Untrusted IPC input — all-or-nothing: one malformed item rejects the whole array. */
function parseReviewFindings(raw: unknown): ReviewFinding[] | undefined {
  if (!Array.isArray(raw) || raw.length === 0) return undefined;
  const findings: ReviewFinding[] = [];
  for (const item of raw) {
    const finding = parseReviewFindingItem(item);
    if (!finding) return undefined;
    findings.push(finding);
  }
  return findings;
}

function parseReviewFindingItem(item: unknown): ReviewFinding | null {
  if (!item || typeof item !== 'object') return null;
  const obj = item as Record<string, unknown>;
  const file = typeof obj.file === 'string' ? obj.file.trim() : '';
  if (!file) return null;
  const note = typeof obj.note === 'string' ? obj.note.trim() : '';
  if (!note) return null;
  const severity = obj.severity;
  if (severity !== 'blocking' && severity !== 'non-blocking' && severity !== 'suggestion') return null;
  const finding: ReviewFinding = { file, severity, note };
  if (obj.line !== undefined) {
    const line = obj.line;
    if (typeof line !== 'number' || !Number.isInteger(line) || line < 1) return null;
    finding.line = line;
  }
  return finding;
}

function formatSessionUpdatedAt(value: string | null | undefined): string | null {
  if (!value) return null;
  const ms = Date.parse(value);
  if (!Number.isFinite(ms)) return value;
  return formatShortTime(ms);
}

function normalizePathForCompare(value: string): string {
  return value.replace(/\/+$/, '');
}

function filterSessionsForProject(sessions: AcpSessionInfo[], projectDir: string | null): AcpSessionInfo[] {
  if (!projectDir) return sessions;
  const project = normalizePathForCompare(projectDir);
  return sessions.filter((session) => !session.cwd || normalizePathForCompare(session.cwd) === project);
}

function sessionCapabilitiesFromAgent(caps: AgentInitInfo['agent_capabilities']): AcpSessionCapabilities {
  const sessionCaps = caps.sessionCapabilities;
  return {
    canList: Boolean(sessionCaps?.list),
    canResume: Boolean(sessionCaps?.resume),
    canLoad: caps.loadSession === true,
  };
}

function shortId(id: string): string {
  return id.length <= 10 ? id : id.slice(0, 8);
}

function formatCount(value: number): string {
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}m`;
  if (value >= 1_000) return `${(value / 1_000).toFixed(1)}k`;
  return String(value);
}

function makeId(): string {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
