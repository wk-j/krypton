// Krypton — ACP Harness View.
// Coordinates several independent ACP subprocesses for one project directory.

import { prepareWithSegments, layoutWithLines } from '@chenglou/pretext';
import { Marked } from 'marked';
import { markedHighlight } from 'marked-highlight';
import hljs from 'highlight.js';
import 'highlight.js/styles/github-dark.css';
import * as smd from 'streaming-markdown';
import { invoke } from '@tauri-apps/api/core';
import { listen, type UnlistenFn } from '@tauri-apps/api/event';
import { openExternalUrl } from '../external-url';
import { AcpClient } from './client';
import { renderDiffPreview } from './diff-render';
import type {
  AcpAgentMode,
  AcpAvailableCommand,
  AcpBackendDescriptor,
  AcpEvent,
  AcpMcpCapabilities,
  AcpMcpServerDescriptor,
  AcpSessionCapabilities,
  AcpSessionInfo,
  AgentInfo,
  AgentInitInfo,
  ContentBlock,
  HarnessLaneStatus,
  HarnessMcpLaneStats,
  HarnessMemoryEntry,
  HarnessMemorySession,
  InterLaneEnvelope,
  LaneSummary,
  ModelInfo,
  PermissionOption,
  PlanEntry,
  ProviderErrorPayload,
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
import {
  InterLaneCoordinator,
  type CoordinatorDrainContext,
  type InterLaneRowChannel,
  type LaneHost,
  type PendingPeerSummary,
  type ReviewCardPayload,
} from './inter-lane';
import { parseMentionFanOut } from './mention-parse';
import {
  applyMentionSelection,
  filteredMentionTargets,
  mentionPaletteContext,
  mentionPaletteVisible,
} from './mention-palette';
import {
  buildPacket as buildReviewPacket,
  composeReviewerPrompt,
  appendReviewValidationSuffix,
  malformedFindingCount,
  reviewSummaryOrFallback,
  topLevelValidationErrorCount,
  validateReply as validateReviewReply,
} from './review';
import type {
  JudgementItem,
  ReviewCommandSummary,
  ReviewGitState,
  ReviewPacket,
  ReviewToolSummary,
} from './types';
import type {
  AcpLaneMetrics,
  CapturedImage,
  ContentView,
  LeaderKeyBinding,
  LeaderKeySpec,
  PaneContentType,
} from '../types';
import type { PaletteAction, PaletteContext } from '../palette-types';
import type { ViewBus } from '../view-bus';
import { SYSTEM_SOURCE } from '../view-bus-types';
import {
  loadConfig,
  getAcpHarnessConfig,
  type LaneModelConfig,
  type HarnessDirective,
} from '../config';
import { extractModifiedPath } from './acp-harness-memory';
import { classifyProviderError, shouldAppendProviderError } from './provider-error';
import {
  loadProjectMcpServers,
  filterByCapability,
  dedupeByName,
  gcJunieMcpOverlays,
  removeJunieMcpOverlay,
  writeJunieMcpOverlay,
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
  kind: 'system' | 'user' | 'assistant' | 'thought' | 'tool' | 'permission' | 'restart' | 'memory' | 'shell' | 'fs_activity' | 'fs_write_review' | 'inter_lane' | 'review' | 'provider_error' | 'artifact';
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
  review?: ReviewCardPayload;
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

type HarnessToolFamily = 'memory' | 'peer' | 'review' | 'attention';
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
}

const HARNESS_MEMORY_TOOL_NAMES = new Set(['memory_set', 'memory_get', 'memory_list']);
const HARNESS_PEER_TOOL_NAMES = new Set(['peer_send', 'peer_list']);
const HARNESS_REVIEW_TOOL_NAMES = new Set(['review_request', 'review_reply']);
// spec 130: attention triage is default-on built-in harness-bus tooling, so its
// calls must auto-allow like memory/peer/review — a permission prompt here also
// breaks the non-blocking contract (the lane proceeds with `chosen`, never waits).
const HARNESS_ATTENTION_TOOL_NAMES = new Set(['attention_flag', 'attention_resolve']);
const HARNESS_AUTO_ALLOW_TOOL_NAMES = new Set([
  ...HARNESS_MEMORY_TOOL_NAMES,
  ...HARNESS_PEER_TOOL_NAMES,
  ...HARNESS_REVIEW_TOOL_NAMES,
  ...HARNESS_ATTENTION_TOOL_NAMES,
]);
const HARNESS_SERVER_MARKERS = ['krypton-harness-bus', 'krypton_harness_bus', 'krypton-harness-memory', 'krypton_harness_memory', '/mcp/harness/'];

interface FileTouchRecord {
  path: string;
  laneId: string;
  laneDisplayName: string;
  toolKind: 'edit' | 'write_like';
  at: number;
}

/** spec 127: in-flight live model switch, used to revert/attribute correctly. */
interface PendingModelSwitch {
  epoch: number;
  prevModelName: string | null;
  prevModelId: string | null;
  prevModeId: string | null;
  pickedName: string;
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
  pendingTurnExtractions: PendingExtraction[];
  currentUserId: string | null;
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
  availableCommands: AcpAvailableCommand[];
  modesById: Map<string, AcpAgentMode>;
  currentMode: AcpAgentMode | null;
  slashPaletteIndex: number;
  slashPaletteDismissed: boolean;
  mentionPaletteIndex: number;
  mentionPaletteDismissed: boolean;
  plan: PlanEntry[] | null;
  planCollapsed: boolean;
  lastKilled: string;
  transcriptWindow: number;
  promptHistory: string[];
  historyIndex: number | null;
  historySavedDraft: string | null;
  /** spec 112: timestamp of the last delivered review reply received. */
  reviewedThrough: number;
  /**
   * spec 112: packetIds for which the reviewer called `review_reply` during
   * the current turn. Used by `checkProseOnlyReviewer` so a handled tool call
   * is not also resolved as a no-tool review.
   */
  reviewReplyAttemptsThisTurn: Set<string>;
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
}

interface TranscriptScrollAnchor {
  msgId: string;
  offsetTop: number;
}

/** spec 124: payload of `acp-directive-apply-requested` from Rust. */
interface DirectiveApplyEvent {
  action: 'upsert' | 'delete' | 'assign';
  requestId?: string;
  harnessId?: string;
  fromLaneId?: string; // requesting lane display name
  reason?: string;
  // upsert
  directive?: HarnessDirective;
  prior?: HarnessDirective | null;
  isUpdate?: boolean;
  // delete / assign
  directive_id?: string | null;
  // assign
  lane?: string | null;
  scope?: 'next_turn' | 'lane';
}

/** spec 124: an in-flight directive mutation awaiting the user's decision. */
interface PendingDirectiveApproval {
  requestId: string;
  laneId: string; // requesting lane (internal id)
  action: 'upsert' | 'delete' | 'assign';
  banner: string;
  reply: (result: unknown) => void;
  /** Run on approval; returns the tool result the agent receives. */
  onApprove: () => unknown;
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
  gemini: 'Gemini',
  opencode: 'OpenCode',
  'pi-acp': 'Pi',
  droid: 'Droid',
  cursor: 'Cursor',
  junie: 'Junie',
  omp: 'OMP',
};

function backendLabel(backendId: string): string {
  return BACKEND_LABELS[backendId] ?? backendId.charAt(0).toUpperCase() + backendId.slice(1);
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
    case 'gemini':
      return 'krypton-logo-gemini';
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

// Inline <symbol> defs for the nine built-in backends. Geometry is copied
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
  // gemini: 4-pointed sparkle
  '<symbol id="krypton-logo-gemini" viewBox="0 0 16 16">' +
    '<path d="M8 1 L9.4 6.6 L15 8 L9.4 9.4 L8 15 L6.6 9.4 L1 8 L6.6 6.6 Z" fill="currentColor"/>' +
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
  // cursor: arrow cursor
  '<symbol id="krypton-logo-cursor" viewBox="0 0 16 16">' +
    '<path d="M3 2 L13 8.5 L8.4 9.4 L10.7 13.8 L9.2 14.6 L6.9 10.2 L4 12.5 Z" fill="currentColor"/>' +
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
].join('');

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
  currentUserId: null,
  currentAssistantId: null,
  currentThoughtId: null,
  stickToBottom: true,
  savedScrollTop: 0,
  savedScrollAnchor: null,
  pendingShellId: null,
  supportsImages: false,
  activeTurnStartedAt: null,
  currentMode: null,
  slashPaletteIndex: 0,
  slashPaletteDismissed: false,
  mentionPaletteIndex: 0,
  mentionPaletteDismissed: false,
  plan: null,
  planCollapsed: false,
  lastKilled: '',
  transcriptWindow: TRANSCRIPT_WINDOW_DEFAULT,
  historyIndex: null,
  historySavedDraft: null,
  reviewedThrough: 0,
  reviewReplyAttemptsThisTurn: new Set<string>(),
  activeToolCount: 0,
  streamingMarkdownParser: null,
  streamingMarkdownBody: null,
  streamingMarkdownItemId: null,
  junieMcpOverlayDir: null,
  cursorMcpNames: null,
  pendingCoordinatorDrain: null,
  coordinatorDrainProvenanceUsed: false,
  activeDirectiveId: null,
  pendingDirectiveChange: null,
  turnDirectiveOverride: null,
  previousDirectiveId: null,
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

export class AcpHarnessView implements ContentView {
  readonly type: PaneContentType = 'acp_harness';
  readonly element: HTMLElement;

  private projectDir: string | null;
  /** spec 128: global ViewBus, used to publish the open attention count so the
   * workspace footer can show it regardless of which view is focused. */
  private viewBus: ViewBus | null = null;
  /** spec 128: stable identity for this harness instance on the footer's
   * attention tally. Lets the footer aggregate across multiple harness tabs. */
  private readonly attentionSourceId = `harness-${++harnessViewSeq}`;
  /** Last attention count published to the footer; dedupes redundant signals. */
  private lastPublishedAttention = -1;
  private lanes: HarnessLane[] = [];
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
  private interLaneUnlisten: UnlistenFn | null = null;
  private peerListUnlisten: UnlistenFn | null = null;
  private reviewRequestedUnlisten: UnlistenFn | null = null;
  private reviewReplyUnlisten: UnlistenFn | null = null;
  private memoryEntries: HarnessMemoryEntry[] = [];
  private harnessMemoryId: string | null = null;
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
  private memoryCursorRowId: string | null = null;
  private focus: ComposerFocus = 'text';
  private chip: string | null = null;
  private chipTimer: number | null = null;
  private composerTickTimer: number | null = null;
  private toolTickTimer: number | null = null;
  private metricsBySession = new Map<number, AcpLaneMetrics>();
  private metricsTimer: number | null = null;
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
  private directivesUnlisten: UnlistenFn | null = null;
  private directiveApplyUnlisten: UnlistenFn | null = null;
  /** spec 124: at most one outstanding directive mutation awaiting approval. */
  private pendingDirectiveApproval: PendingDirectiveApproval | null = null;
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
  private pickerEl!: HTMLElement;
  private directivePickerEl!: HTMLElement;
  private modelPickerEl!: HTMLElement;
  private planEl!: HTMLElement;
  private laneRailEl!: HTMLElement;
  private planSlotEl!: HTMLElement;
  private peekSlotEl!: HTMLElement;
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
    this.element = document.createElement('div');
    this.element.className = 'acp-harness';
    this.element.tabIndex = 0;
    this.coordinator = new InterLaneCoordinator(this.laneBus, this.buildLaneHost());
    // spec 128: refresh the backpressure gauge (and the overlay, if open) on
    // every queue mutation the store emits.
    this.laneBus.subscribe((e) => {
      if (e.type === 'triage:changed') {
        this.renderTriageGaugeEl();
        if (this.triageOverlayOpen) this.renderTriageOverlayEl();
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
    this.laneBus.emit({
      type: 'lane:status',
      payload: { laneId: lane.id, prev, next, at: Date.now() },
    });
    // Composer peer-strip age depends on lane status (busy / awaiting_peer)
    // and pending peers. Refresh the 1Hz tick whenever status changes so
    // mention / review / peer_send paths don't have to remember to call this
    // themselves. Idempotent and cheap.
    this.updateComposerTick();
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
        void this.enqueueSystemPrompt(l, text, drain);
      },
      appendInterLaneRow: (id, direction, peer, message, done, meta) => {
        const l = this.lanes.find((x) => x.id === id);
        if (!l) return;
        const item = this.appendTranscript(l, 'inter_lane', message);
        item.interLane = {
          direction,
          peerId: peer.id,
          peerDisplayName: peer.displayName,
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
      appendReviewCard: (id, payload) => {
        const l = this.lanes.find((x) => x.id === id);
        if (!l) return;
        const block = payload.findings.filter((f) => f.severity === 'block').length;
        const warn = payload.findings.filter((f) => f.severity === 'warn').length;
        const nit = payload.findings.filter((f) => f.severity === 'nit').length;
        const counts = [block ? `${block} block` : null, warn ? `${warn} warn` : null, nit ? `${nit} nit` : null]
          .filter(Boolean)
          .join(', ');
        const header = `review · from ${payload.fromDisplayName} · ${payload.findings.length} finding${
          payload.findings.length === 1 ? '' : 's'
        }${counts ? ` (${counts})` : ''}`;
        const item = this.appendTranscript(l, 'review', `${header}\n${payload.summary}`);
        item.review = payload;
        // Advance reviewedThrough on delivered review replies. Lane-failure
        // cards remain excluded so interrupted reviews can be requested again.
        if (!payload.interruptedReason) {
          l.reviewedThrough = payload.sentAt;
        }
        // Settle requester out of awaiting_peer if they were on this packet.
        this.coordinator.recomputePeerStatus(l.id);
        this.scheduleLaneRender(l);
      },
    };
  }

  /** spec 115: @mention fan-out from composer. */
  private tryMentionFanOut(lane: HarnessLane, text: string, hasImages: boolean): boolean {
    if (!text.trimStart().startsWith('@')) return false;
    const roster = this.lanes.map((l) => l.displayName);
    const parsed = parseMentionFanOut(text, lane.displayName, roster);
    if ('kind' in parsed) {
      if (parsed.kind === 'empty_body') return false;
      if (parsed.kind === 'self_only') {
        this.flashChip('mention: cannot target only yourself');
        return true;
      }
      this.flashChip(`mention: unknown lane ${parsed.token}`);
      return true;
    }
    if (parsed.targets.length === 0) return false;
    if (hasImages) {
      this.flashChip('mention fan-out: images not supported yet');
      return true;
    }
    const targets = parsed.targets
      .map((displayName) => {
        const target = this.lanes.find((l) => l.displayName === displayName);
        return target ? { laneId: target.id, displayName } : null;
      })
      .filter((t): t is { laneId: string; displayName: string } => t !== null);
    if (targets.length === 0) {
      this.flashChip('mention: no valid target lanes');
      return true;
    }
    const result = this.coordinator.deliverMentionFanOut(
      lane.id,
      lane.displayName,
      targets,
      parsed.body,
      this.harnessMemoryId ?? undefined,
    );
    this.setDraft(lane, '', 0);
    if (result.delivered.length === 0) {
      const why = result.failed.map((f) => `${f.displayName} (${f.reason})`).join(', ');
      this.flashChip(`mention failed: ${why || 'no targets'}`);
      this.render();
      return true;
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
    return true;
  }

  /** Inject a programmatic user-turn (no UI composer involved). */
  private async enqueueSystemPrompt(
    lane: HarnessLane,
    text: string,
    drain?: CoordinatorDrainContext,
  ): Promise<void> {
    if (!lane.client) return;
    if (lane.status !== 'idle' && lane.status !== 'awaiting_peer') return;
    lane.pendingCoordinatorDrain = drain ?? null;
    lane.coordinatorDrainProvenanceUsed = false;
    this.setLaneStatus(lane, 'busy');
    lane.activeTurnStartedAt = Date.now();
    lane.reviewReplyAttemptsThisTurn.clear();
    lane.pendingTurnExtractions = [];
    lane.currentAssistantId = null;
    lane.currentThoughtId = null;
    this.updateComposerTick();
    this.render();
    try {
      await lane.client.prompt([{ type: 'text', text }]);
    } catch (e) {
      this.setLaneStatus(lane, 'error');
      lane.error = String(e);
      this.appendTranscript(lane, 'system', `error: ${String(e)}`);
      this.render();
    }
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
        const toLane = this.lanes.find((l) => l.displayName === env.toLaneId);
        if (!fromLane) {
          reply({ delivered: false, reason: 'unknown_sender' });
          return;
        }
        const translated: InterLaneEnvelope = {
          ...env,
          fromLaneId: fromLane.id,
          toLaneId: toLane ? toLane.id : env.toLaneId,
        };
        const result = this.coordinator.deliver(translated);
        reply(result);
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
        const lanes = this.coordinator.listLanes();
        void invoke('acp_bus_reply', {
          requestId,
          result: { lanes, count: lanes.length },
        }).catch((err) => {
          console.warn('acp_bus_reply (peer_list) failed', err);
        });
      },
    );

    // spec 112: review request from an agent via review_request MCP tool.
    // Rust emits the event WITHOUT git state — the frontend listener collects
    // it via the acp_collect_review_git_state Tauri command using the lane's
    // own cwd. The agent never needs to know or pass `cwd`.
    type ReviewRequestedEvent = {
      packetId: string;
      fromLaneId: string; // display name from Rust
      toLaneId: string;
      note?: string | null;
      sentAt: number;
      harnessId?: string;
      requestId?: string;
    };
    this.reviewRequestedUnlisten = await listen<ReviewRequestedEvent>(
      'acp-review-requested',
      (e) => {
        const env = e.payload;
        const requestId = env.requestId;
        if (!this.harnessMemoryId || env.harnessId !== this.harnessMemoryId) return;
        const reply = (result: unknown): void => {
          if (!requestId) return;
          void invoke('acp_bus_reply', { requestId, result }).catch((err) => {
            console.warn('acp_bus_reply (review_request) failed', err);
          });
        };
        const fromLane = this.lanes.find((l) => l.displayName === env.fromLaneId);
        const toLane = this.lanes.find((l) => l.displayName === env.toLaneId);
        if (!fromLane) {
          reply({ delivered: false, reason: 'unknown_sender' });
          return;
        }
        if (!toLane) {
          reply({ delivered: false, reason: 'unknown_lane' });
          return;
        }
        void this.collectGitAndDeliverReviewRequest({
          packetId: env.packetId,
          fromLane,
          toLane,
          note: env.note ?? undefined,
          sentAt: env.sentAt,
          harnessId: env.harnessId,
        }).then(reply);
      },
    );

    // spec 112: review reply from a reviewer agent via review_reply MCP tool.
    type ReviewReplyEvent = {
      packetId: string;
      fromLaneId: string;
      summary: string;
      findings: unknown;
      harnessId?: string;
      requestId?: string;
      sentAt: number;
    };
    this.reviewReplyUnlisten = await listen<ReviewReplyEvent>(
      'acp-review-reply-requested',
      (e) => {
        const env = e.payload;
        const requestId = env.requestId;
        if (!this.harnessMemoryId || env.harnessId !== this.harnessMemoryId) return;
        const reply = (result: unknown): void => {
          if (!requestId) return;
          void invoke('acp_bus_reply', { requestId, result }).catch((err) => {
            console.warn('acp_bus_reply (review_reply) failed', err);
          });
        };
        void this.handleReviewReply(env, reply);
      },
    );

    // spec 124: persistent config changed on disk (a directive upsert/delete
    // was approved by some harness). Reload the directive library.
    this.directivesUnlisten = await listen<{ harnessId?: string }>(
      'acp-harness-directives-changed',
      (e) => {
        if (!this.harnessMemoryId || e.payload.harnessId !== this.harnessMemoryId) return;
        void this.refreshDirectives().then(() => this.render());
      },
    );

    // spec 124: a lane called directive_apply. Rust blocks on this round-trip;
    // the frontend approves/applies and replies with the outcome.
    this.directiveApplyUnlisten = await listen<DirectiveApplyEvent>(
      'acp-directive-apply-requested',
      (e) => {
        const env = e.payload;
        const requestId = env.requestId;
        if (!this.harnessMemoryId || env.harnessId !== this.harnessMemoryId) return;
        const reply = (result: unknown): void => {
          if (!requestId) return;
          void invoke('acp_bus_reply', { requestId, result }).catch((err) => {
            console.warn('acp_bus_reply (directive_apply) failed', err);
          });
        };
        this.handleDirectiveApply(env, reply);
      },
    );

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
      const git = await invoke<ReviewGitState & { hasGitRepo: boolean }>(
        'acp_collect_review_git_state',
        { cwd },
      );
      if (!git?.hasGitRepo || git.diffstat.length === 0) return;
      const packet = buildReviewPacket({
        packetId: `jpk-${itemId}`,
        fromLaneId: item.laneId,
        toLaneId: item.laneId,
        note: undefined,
        signals: { intent: '', commands: [], toolSummary: [] },
        git,
        sentAt: item.createdAt,
        harnessId: this.harnessMemoryId ?? undefined,
      });
      this.triageStore.setDiffstat(itemId, packet.diffstat, packet.packetId);
    } catch (err) {
      console.warn('attention_flag git collection failed', err);
    }
  }

  // spec 112: assemble transcript-derived signals since the given marker.
  private assembleReviewSignals(
    lane: HarnessLane,
    since: number,
  ): { intent: string; commands: ReviewCommandSummary[]; toolSummary: ReviewToolSummary[] } {
    const userIntents: string[] = [];
    const commands: ReviewCommandSummary[] = [];
    const toolCounts = new Map<ReviewToolSummary['kind'], Map<string, number>>();
    for (const item of lane.transcript) {
      if ((item.createdAt ?? 0) <= since) continue;
      if (item.kind === 'user') {
        if (item.text.trim().length > 0) userIntents.push(item.text.trim());
      }
      if (item.kind === 'tool' && item.tool) {
        const t = item.tool;
        const cmd = t.command?.trim();
        if (cmd && t.kind === 'execute') {
          // Best-effort exit-code tail parse: look for "exit \d+" or "exit code: \d+".
          const tail = (t.result || '').slice(-200);
          const match = tail.match(/exit(?:\s+code)?\s*[:=]?\s*(\d+)/i);
          const exitCode = match ? parseInt(match[1], 10) : null;
          commands.push({
            command: cmd,
            exitCode,
            summary: (t.result || '').slice(-400),
            at: item.createdAt ?? Date.now(),
          });
        }
        const kind: ReviewToolSummary['kind'] =
          t.kind === 'read'
            ? 'read'
            : t.kind === 'edit' || t.kind === 'delete' || t.kind === 'move'
              ? 'edit'
              : t.kind === 'search'
                ? 'search'
                : 'other';
        const subject = (t.subject || '').trim() || '(unknown)';
        if (!toolCounts.has(kind)) toolCounts.set(kind, new Map());
        const bucket = toolCounts.get(kind)!;
        bucket.set(subject, (bucket.get(subject) ?? 0) + 1);
      }
    }
    const toolSummary: ReviewToolSummary[] = [];
    for (const [kind, bucket] of toolCounts.entries()) {
      // Most-touched subject per kind.
      let bestSubject = '';
      let bestCount = 0;
      let total = 0;
      for (const [s, c] of bucket.entries()) {
        total += c;
        if (c > bestCount) {
          bestCount = c;
          bestSubject = s;
        }
      }
      toolSummary.push({ kind, subject: bestSubject, count: total });
    }
    return {
      intent: userIntents.join('\n\n'),
      commands,
      toolSummary,
    };
  }

  private async collectGitAndDeliverReviewRequest(args: {
    packetId: string;
    fromLane: HarnessLane;
    toLane: HarnessLane;
    note: string | undefined;
    sentAt: number;
    harnessId?: string;
  }): Promise<{ delivered: boolean; packetId?: string; reason?: string; queuedDepth?: number; hint?: string }> {
    const cwd = this.projectDir ?? '';
    if (!cwd) return { delivered: false, reason: 'no_cwd' };
    let git: (ReviewGitState & { hasGitRepo: boolean }) | null = null;
    try {
      git = await invoke<ReviewGitState & { hasGitRepo: boolean }>('acp_collect_review_git_state', { cwd });
    } catch (err) {
      console.warn('acp_collect_review_git_state failed', err);
      return { delivered: false, reason: 'git_collection_failed' };
    }
    if (!git?.hasGitRepo) return { delivered: false, reason: 'no_git_repo' };
    return this.buildAndDeliverReviewRequest({
      ...args,
      git,
    });
  }

  private buildAndDeliverReviewRequest(args: {
    packetId: string;
    fromLane: HarnessLane;
    toLane: HarnessLane;
    note: string | undefined;
    git: ReviewGitState;
    sentAt: number;
    harnessId?: string;
  }): { delivered: boolean; packetId?: string; reason?: string; queuedDepth?: number; hint?: string } {
    const signals = this.assembleReviewSignals(args.fromLane, args.fromLane.reviewedThrough);
    const packet: ReviewPacket = buildReviewPacket({
      packetId: args.packetId,
      fromLaneId: args.fromLane.id,
      toLaneId: args.toLane.id,
      note: args.note,
      signals,
      git: args.git,
      sentAt: args.sentAt,
      harnessId: args.harnessId,
    });
    const prompt = composeReviewerPrompt(packet, args.fromLane.displayName);
    const result = this.coordinator.deliverReviewRequest(packet, prompt);
    if (result.delivered) {
      return {
        delivered: true,
        packetId: result.packetId,
        queuedDepth: result.queuedDepth,
        hint: result.hint,
      };
    }
    return { delivered: false, reason: result.reason };
  }

  private async handleReviewReply(
    env: {
      packetId: string;
      fromLaneId: string;
      summary: string;
      findings: unknown;
      sentAt: number;
    },
    reply: (result: unknown) => void,
  ): Promise<void> {
    const packet = this.coordinator.getOpenReviewPacket(env.packetId);
    if (!packet) {
      reply({ delivered: false, reason: 'unknown_packet' });
      return;
    }
    const reviewerLane = this.lanes.find((l) => l.displayName === env.fromLaneId);
    if (!reviewerLane) {
      reply({ delivered: false, reason: 'unknown_sender' });
      return;
    }
    // The packet was sent FROM the requester TO the reviewer. So the requester is fromLaneId.
    const requesterLane = this.lanes.find((l) => l.id === packet.fromLaneId);
    if (!requesterLane) {
      reply({ delivered: false, reason: 'unknown_lane' });
      return;
    }
    // Reviewer mismatch guard: the lane sending the reply must be the lane the packet was addressed to.
    if (reviewerLane.id !== packet.toLaneId) {
      reply({ delivered: false, reason: 'unauthorized_reviewer' });
      return;
    }
    // Mark that review_reply was attempted for this packet during the current
    // turn (regardless of validation outcome). `checkProseOnlyReviewer` uses
    // this to avoid double-counting the same turn as a missing-tool failure.
    reviewerLane.reviewReplyAttemptsThisTurn.add(env.packetId);
    const validated = validateReviewReply(
      { packet_id: env.packetId, summary: env.summary, findings: env.findings },
      env.packetId,
      packet.repoRoot,
    );
    const summary = reviewSummaryOrFallback(validated, env.summary);
    const malformedFindings = malformedFindingCount(validated);
    const topLevelErrors = topLevelValidationErrorCount(validated);
    const validationNotes: string[] = [];
    if (malformedFindings > 0) {
      validationNotes.push(`${malformedFindings} malformed finding${malformedFindings === 1 ? '' : 's'} omitted`);
    }
    if (topLevelErrors > 0) {
      validationNotes.push(`${topLevelErrors} top-level field${topLevelErrors === 1 ? '' : 's'} ignored`);
    }
    const validationSuffix =
      !validated.ok && validationNotes.length > 0
        ? ` (${validationNotes.join('; ')}.)`
        : '';
    const deliveredSummary = appendReviewValidationSuffix(summary, validationSuffix);

    // Review replies are best-effort lane messages. Deliver cleaned findings
    // when present; otherwise render the reply as a clean review with a summary
    // instead of retrying a private protocol.
    let worktreeMatch = true;
    try {
      const cwd = this.projectDir ?? '';
      if (cwd) {
        const current = await invoke<{ worktreeFingerprint?: string }>('acp_collect_review_git_state', { cwd });
        if (current?.worktreeFingerprint) {
          worktreeMatch = current.worktreeFingerprint === packet.worktreeFingerprint;
        }
      }
    } catch {
      // If we can't recompute, render the card without the warning rather than blocking the reply.
    }

    const payload: ReviewCardPayload = {
      packetId: env.packetId,
      fromLaneId: reviewerLane.id,
      toLaneId: requesterLane.id,
      fromDisplayName: reviewerLane.displayName,
      toDisplayName: requesterLane.displayName,
      findings: validated.cleanedFindings,
      summary: deliveredSummary,
      worktreeMatchAtReceipt: worktreeMatch,
      sentAt: env.sentAt,
    };
    const result = this.coordinator.deliverReviewReply(payload);
    reply({ delivered: result.delivered, reason: result.reason });
  }

  /**
   * spec 112: detect a reviewer that ended its turn without calling
   * review_reply. Resolve the packet with a clean summary instead of injecting
   * retry prompts; lane-to-lane review should stay simple and non-blocking.
   */
  private async checkProseOnlyReviewer(reviewerLane: HarnessLane): Promise<void> {
    const packetId = this.coordinator.assignedReviewPacketFor(reviewerLane.id);
    if (!packetId) return;
    // If the validation handler already saw a review_reply for this packet
    // during this turn, delivery already happened there.
    if (reviewerLane.reviewReplyAttemptsThisTurn.has(packetId)) {
      reviewerLane.reviewReplyAttemptsThisTurn.delete(packetId);
      return;
    }
    const packet = this.coordinator.getOpenReviewPacket(packetId);
    if (!packet) {
      this.coordinator.clearReviewerAssignment(reviewerLane.id);
      return;
    }
    const requesterLane = this.lanes.find((l) => l.id === packet.fromLaneId);
    if (!requesterLane) return;
    const payload: ReviewCardPayload = {
      packetId,
      fromLaneId: reviewerLane.id,
      toLaneId: requesterLane.id,
      fromDisplayName: reviewerLane.displayName,
      toDisplayName: requesterLane.displayName,
      findings: [],
      summary: '(reviewer ended without a review_reply tool call)',
      worktreeMatchAtReceipt: true,
      sentAt: Date.now(),
    };
    this.coordinator.deliverReviewReply(payload);
    this.coordinator.clearReviewerAssignment(reviewerLane.id);
  }

  /**
   * spec 112: user-triggered `#review <lane>` chat command. Bypasses MCP —
   * frontend collects git state directly and delivers via the coordinator.
   */
  private async runReviewCommand(lane: HarnessLane, rest: string[]): Promise<void> {
    const target = rest[0]?.trim();
    if (!target) {
      this.flashChip('#review usage: #review <lane> [note...]');
      return;
    }
    const toLane = this.lanes.find(
      (l) => l.displayName.toLowerCase() === target.toLowerCase() && l.id !== lane.id,
    );
    if (!toLane) {
      this.flashChip(`#review: unknown lane "${target}"`);
      return;
    }
    if (toLane.status === 'stopped' || toLane.status === 'error') {
      this.flashChip(`#review: ${toLane.displayName} is ${toLane.status}`);
      return;
    }
    const note = rest.slice(1).join(' ').trim() || undefined;
    const cwd = this.projectDir ?? '';
    if (!cwd) {
      this.flashChip('#review: no working directory');
      return;
    }
    let git: (ReviewGitState & { hasGitRepo: boolean }) | null = null;
    try {
      git = await invoke<ReviewGitState & { hasGitRepo: boolean }>('acp_collect_review_git_state', { cwd });
    } catch (e) {
      this.flashChip(`#review: git collection failed: ${String(e)}`);
      return;
    }
    if (!git?.hasGitRepo) {
      this.flashChip('#review: no git repo in lane cwd');
      return;
    }
    const result = this.buildAndDeliverReviewRequest({
      packetId: `rev-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      fromLane: lane,
      toLane,
      note,
      git,
      sentAt: Date.now(),
      harnessId: this.harnessMemoryId ?? undefined,
    });
    if (!result.delivered) {
      this.flashChip(`#review failed: ${result.reason}`);
      return;
    }
    this.flashChip(`#review → ${toLane.displayName}`);
    // Sender goes to awaiting_peer once their turn would end; for user-triggered
    // review the sender lane is typically idle, so set awaiting_peer immediately.
    if (lane.status === 'idle') {
      this.setLaneStatus(lane, 'awaiting_peer');
    }
    this.scheduleLaneRender(lane);
    this.scheduleLaneRender(toLane);
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
    if (this.triageOverlayOpen) {
      e.preventDefault();
      this.handleTriageKey(e);
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

    if (this.pendingDirectiveApproval && this.pendingDirectiveApproval.laneId === lane.id) {
      if (e.key === 'a') {
        e.preventDefault();
        this.resolveDirectiveApproval(true);
        return true;
      }
      if (e.key === 'r' || e.key === 'Escape') {
        e.preventDefault();
        this.resolveDirectiveApproval(false);
        return true;
      }
      e.preventDefault();
      return true;
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

  onResize(_width: number, _height: number): void {
    this.schedulePretextLayout();
    this.scheduleStickyScroll();
  }

  dispose(): void {
    // spec 128: clear the footer attention badge — the harness is going away.
    this.publishAttentionCount(0);
    this.stopComposerTick();
    this.stopMetricsTick();
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
    if (this.reviewRequestedUnlisten) {
      this.reviewRequestedUnlisten();
      this.reviewRequestedUnlisten = null;
    }
    if (this.reviewReplyUnlisten) {
      this.reviewReplyUnlisten();
      this.reviewReplyUnlisten = null;
    }
    if (this.attentionFlagUnlisten) {
      this.attentionFlagUnlisten();
      this.attentionFlagUnlisten = null;
    }
    if (this.attentionResolveUnlisten) {
      this.attentionResolveUnlisten();
      this.attentionResolveUnlisten = null;
    }
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
    if (this.directivesUnlisten) {
      this.directivesUnlisten();
      this.directivesUnlisten = null;
    }
    if (this.directiveApplyUnlisten) {
      this.directiveApplyUnlisten();
      this.directiveApplyUnlisten = null;
    }
    if (this.pendingDirectiveApproval) {
      this.pendingDirectiveApproval.reply({ approved: false, approval: 'rejected', reason: 'harness_closed' });
      this.pendingDirectiveApproval = null;
    }
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
    this.triageOverlayOpen = true;
    this.triageRedirect = null;
    const open = this.triageStore.openItems();
    this.triageSelectedIndex = Math.min(this.triageSelectedIndex, Math.max(0, open.length - 1));
    this.helpOpen = false;
    this.memoryDrawerOpen = false;
    this.renderTriageOverlayEl();
  }

  private closeTriageOverlay(): void {
    if (!this.triageOverlayOpen) return;
    this.triageOverlayOpen = false;
    this.triageRedirect = null;
    this.triageOverlayEl.hidden = true;
  }

  private renderTriageGaugeEl(): void {
    // spec 128: the open-count gauge lives in the global workspace footer (its
    // documented home), not in the harness chrome — publish and let the footer
    // render it. The overlay is reached via the `;` leader key.
    this.publishAttentionCount(this.triageStore.openCount());
  }

  /** spec 128: surface the open attention count on the global workspace footer.
   * Deduped so a no-op `triage:changed` does not churn the footer. */
  private publishAttentionCount(openCount: number): void {
    if (openCount === this.lastPublishedAttention) return;
    this.lastPublishedAttention = openCount;
    this.viewBus?.publishSignal({
      kind: 'system:attention',
      source: SYSTEM_SOURCE,
      value: { sourceId: this.attentionSourceId, openCount },
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
      this.triageStore.accept(item.id);
      this.flashChip('acknowledged');
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

  private buildDOM(): void {
    // spec 125 — inject reusable backend logo <symbol> defs once. Hidden
    // off-screen so <use href="#krypton-logo-*"/> resolves from the rail.
    const logoDefs = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    logoDefs.setAttribute('width', '0');
    logoDefs.setAttribute('height', '0');
    logoDefs.setAttribute('aria-hidden', 'true');
    logoDefs.style.position = 'absolute';
    logoDefs.innerHTML = `<defs>${BACKEND_LOGO_SVG_DEFS}</defs>`;
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

    this.planEl = document.createElement('aside');
    this.planEl.className = 'acp-harness__plan';
    this.planEl.hidden = true;

    this.laneRailEl = document.createElement('div');
    this.laneRailEl.className = 'acp-harness__lane-rail';
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

    try {
      const cfg = await loadConfig();
      this.laneModels = cfg.acp_harness?.lane_models ?? {};
    } catch {
      this.laneModels = {};
    }

    await this.refreshDirectives();

    try {
      this.pickerEntries = await AcpClient.listBackends();
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
    if (this.lanes.length === 0 && this.pickerEntries.some((e) => e.id === 'claude')) {
      await this.addLane('claude');
    }
  }

  private async initializeHarnessMemory(): Promise<void> {
    const projectDir = this.projectDir || await invoke<string>('get_app_cwd').catch(() => null);
    const session = await invoke<HarnessMemorySession>('create_harness_memory', { projectDir });
    this.harnessMemoryId = session.harnessId;
    this.harnessMemoryPort = session.hookPort;
    this.harnessMemoryWarning = null;
    try {
      await gcJunieMcpOverlays(session.harnessId);
    } catch (e) {
      console.warn('[acp-harness] gc junie mcp overlays failed:', e);
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

  /** True when a directive may be assigned to a lane (enabled + backend match). */
  private directiveCompatible(directive: HarnessDirective, lane: HarnessLane): boolean {
    if (!directive.enabled) return false;
    return directive.backend === '' || directive.backend === lane.backendId;
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
      reviewReplyAttemptsThisTurn: new Set(),
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
      client = await AcpClient.spawn(lane.backendId, this.projectDir, seedMcp, junieMcpLocation);
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
    // Cursor ignores session/new mcpServers entirely (upstream regression); it
    // gets the harness memory server via native `.cursor/mcp.json` at spawn time.
    // OMP native-loads root `.mcp.json` in ACP mode but still accepts injected
    // harness memory servers, so skip only the project bridge.
    if (
      lane.backendId === 'claude' ||
      lane.backendId === 'pi-acp' ||
      lane.backendId === 'junie' ||
      lane.backendId === 'cursor' ||
      lane.backendId === 'omp'
    ) {
      return lane.backendId === 'junie' || lane.backendId === 'cursor' ? [] : memoryServers;
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

  private onLaneEvent(lane: HarnessLane, event: AcpEvent): void {
    let needsRender = true;
    switch (event.type) {
      case 'user_message_chunk':
        this.appendStreaming(lane, 'user', event.text);
        this.scheduleStreamingBodyOnly(lane);
        needsRender = false;
        break;
      case 'message_chunk':
        this.appendStreaming(lane, 'assistant', event.text);
        this.scheduleStreamingBodyOnly(lane);
        needsRender = false;
        break;
      case 'thought_chunk':
        this.appendStreaming(lane, 'thought', event.text);
        this.scheduleStreamingBodyOnly(lane);
        needsRender = false;
        break;
      case 'tool_call':
        this.sealStreaming(lane);
        this.renderTool(lane, event.call);
        break;
      case 'tool_call_update':
        this.renderTool(lane, event.update);
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
        lane.pendingTurnExtractions = [];
        lane.pendingPermissions = [];
        lane.acceptAllForTurn = false;
        lane.rejectAllForTurn = false;
        this.updateComposerTick();
        this.appendClassifiedError(lane, event.message, `error: ${event.message}`);
        break;
    }
    if (needsRender) this.scheduleLaneRender(lane);
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
    if (text.startsWith('#')) {
      await this.runHashCommand(lane, text);
      return;
    }
    if (text.startsWith('!')) {
      const command = text.slice(1).trim();
      this.setDraft(lane, '', 0);
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
    if (lane.status === 'busy' || lane.status === 'needs_permission') {
      this.flashChip('lane busy');
      return;
    }
    const images = lane.stagedImages.slice();
    const mentionParsed = this.tryMentionFanOut(lane, text, images.length > 0);
    if (mentionParsed) return;
    this.setDraft(lane, '', 0);
    lane.stagedImages = [];
    this.appendTranscript(lane, 'user', text, { imageCount: images.length });
    this.setLaneStatus(lane, 'busy');
    lane.activeTurnStartedAt = Date.now();
    lane.reviewReplyAttemptsThisTurn.clear();
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
      this.setLaneStatus(lane, 'error');
      lane.error = message;
      lane.activeTurnStartedAt = null;
      lane.pendingTurnExtractions = [];
      this.updateComposerTick();
      this.appendClassifiedError(lane, message, `prompt failed: ${message}`);
      this.render();
    }
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
    const directive = this.effectiveDirective(lane);
    if (!directive) return packet;
    const heading = directive.title.trim()
      ? `## Directive: ${directive.title.trim()}`
      : '## Directive';
    const block = `${heading}\n${directive.system_prompt.trim()}`;
    return packet ? `${packet}\n\n${block}` : block;
  }

  private renderPromptMemoryPacket(lane: HarnessLane): string {
    const self = lane.displayName;
    const roster = this.lanes.map((l) => l.displayName).join(', ');
    const hasPeers = this.lanes.length > 1;
    const lines: string[] = [`You are lane ${self}. Lanes: ${roster}.`];
    if (!this.harnessMemoryId || !this.harnessMemoryPort) {
      lines.push('Shared Krypton memory is unavailable in this harness because the localhost hook server did not initialize. Continue without krypton-harness-memory MCP tools.');
      return lines.join('\n');
    }
    if (hasPeers) {
      lines.push(
        'Shared memory is available through the krypton-harness-memory MCP server: call memory_list to see which lanes have entries, memory_get { lane } to read another lane, and memory_set { summary, detail } to update your own. Writes go to your own lane automatically; you cannot write to other lanes.',
      );
      lines.push(
        'Inter-lane peering: when the user asks you to consult, ask, or peer with another lane, call peer_send { to_lane, message, done } (use the display name shown above; recipient processes on its next idle turn). Use peer_list to see live peer lanes and their inbox depths. End your turn after peer_send; the reply (if any) arrives as a new user message. Leave `done` false when sending a request — `done:true` silences the recipient and is only for closing the conversation after their reply. Never peer proactively.',
      );
    } else {
      lines.push(
        'Shared memory is available through the krypton-harness-memory MCP server: call memory_set { summary, detail } to record state for future turns and memory_get { lane } / memory_list to read it back.',
      );
    }
    // spec 130: attention tools are default-on for every harness-memory-capable
    // lane, but a lane only learns their exact names via ranked tool discovery —
    // which can drop attention_flag under a capped query. Name both tools here so
    // the model can target them directly instead of relying on search ranking.
    lines.push(
      'Attention triage: when a turn forces a genuinely hard judgement call — an irreversible or costly choice, a real ambiguity in intent, or a trade-off you are not confident about — surface ONE such decision to the human review queue with attention_flag { question, chosen, rationale, traded_off, uncertainty, reversibility }, then keep working (it is non-blocking; proceed with `chosen`). Use attention_resolve { item_id } if you later settle it yourself. Never flag the routine, reversible 80%, and never flag proactively.',
    );
    // spec 133: discoverability only — the agent decides when an HTML artifact
    // beats prose. Opt-in, user-driven; never default to it.
    lines.push(
      'HTML artifacts: when the user asks for a visual or interactive view (side-by-side, diagram, annotated diff, dashboard), call artifact_new { title }. It returns a path to a file that ALREADY EXISTS — a styled scaffold (Krypton cyberpunk theme + light/auto toggle); EDIT it with your normal edit tool (do not recreate it with Write) to replace the placeholder inside <main data-artifact-content>, then artifact_register { id }; the user opens it in their browser. Opt-in only — keep ordinary prose, plans, and answers in your turn text.',
    );
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
    // spec 112: no-tool reviewer detection runs BEFORE the idle transition.
    // Going idle drains the coordinator's queue, and the drain calls
    // enqueueSystemPrompt() which clears reviewReplyAttemptsThisTurn — if that
    // happens first, this check can resolve an already-delivered reply as a
    // missing-tool review too.
    if (stopReason === 'end_turn' && !lane.error) {
      void this.checkProseOnlyReviewer(lane);
    }
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
      // The audit counters (shown in each card header) aren't a queue mutation,
      // so the store doesn't emit — refresh the overlay directly if it is open.
      if (this.triageOverlayOpen) this.renderTriageOverlayEl();
    }
    lane.flaggedThisTurn = false;
    // spec 133: a pending artifact carries a write grant and must not outlive
    // the turn — cancel any the lane created but never registered.
    this.cancelPendingArtifactsForLane(lane);
    lane.activeTurnStartedAt = null;
    lane.currentAssistantId = null;
    lane.currentThoughtId = null;
    lane.pendingCoordinatorDrain = null;
    lane.coordinatorDrainProvenanceUsed = false;
    this.updateComposerTick();
    if (stopReason !== 'end_turn' && stopReason !== 'cancelled') {
      this.appendTranscript(lane, 'system', `turn ended: ${stopReason}`);
    }
    if (lane.draft.trim()) this.flashChip('lane idle - Enter to send');
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
    if (lane.acceptAllForTurn || lane.rejectAllForTurn) {
      void this.resolvePermission(lane, lane.rejectAllForTurn ? 'reject' : 'accept', true);
    }
  }

  private async resolvePermission(lane: HarnessLane, action: 'accept' | 'reject', auto: boolean): Promise<void> {
    const permission = lane.pendingPermissions[0];
    if (!permission || !lane.client) return;
    const option = pickPermissionOption(permission.options, action);
    if (action === 'accept' && !option) {
      this.flashChip('no accept option');
      return;
    }
    lane.pendingPermissions.shift();
    const label = option?.name ?? (action === 'accept' ? 'accepted' : 'rejected');
    permission.resolvedLabel = `${action === 'accept' ? '✓' : '✗'} ${label}${auto ? ' (auto-turn)' : ''}`;
    permission.auto = auto;
    this.updatePermissionDecision(permission, action === 'accept' ? 'accepted' : 'rejected', permission.resolvedLabel);
    if (lane.pendingPermissions.length === 0 && lane.status === 'needs_permission') this.setLaneStatus(lane, 'busy');
    this.updateComposerTick();
    this.render();
    try {
      await lane.client.respondPermission(permission.requestId, option?.optionId ?? null);
    } catch (e) {
      lane.pendingPermissions.unshift(permission);
      this.setLaneStatus(lane, 'needs_permission');
      this.updatePermissionDecision(permission, 'failed', 'permission reply failed');
      this.appendTranscript(lane, 'system', `permission reply failed: ${String(e)}`);
      this.updateComposerTick();
      this.render();
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
    // ADR 0002: artifacts open verbatim in the user's real OS browser.
    // encodeURI so a project path with spaces/unicode yields a valid file URL
    // (the artifact's own components are sanitized, but the project dir is not).
    openExternalUrl(`file://${encodeURI(card.path)}`, { external: true });
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
    if (hadPending && this.harnessMemoryId) {
      void invoke('acp_cancel_pending_artifacts', {
        harnessId: this.harnessMemoryId,
        laneLabel: lane.displayName,
      }).catch(() => undefined);
    }
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
      argsPreview: isArtifact ? 'html artifact · contents hidden' : permissionArgsPreview(call.rawInput),
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

  /** Directives ordered for the spawn picker: enabled first, then disabled.
   * The picker always spawns a fresh lane using each directive's own backend,
   * so backend compatibility with the focused lane does not apply here — it is
   * only enforced when assigning a directive to an existing lane (MCP). */
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

  /** Spawn a new lane and start it with an active directive. */
  private async addLaneFromDirective(directive: HarnessDirective): Promise<void> {
    const backendId = directive.backend.trim() ? directive.backend.trim() : 'codex';
    const label = backendLabel(backendId);
    const existing = this.lanes.filter((l) => l.backendId === backendId).length;
    const lane = this.createLane(this.nextLaneIndex++, backendId, `${label}-${existing + 1}`);
    lane.activeDirectiveId = directive.id;
    lane.pendingDirectiveChange = null;
    lane.triageOverride = null;
    this.appendTranscript(lane, 'system', `directive set: ${directive.id}`);
    this.lanes.push(lane);
    this.activateLane(lane.id);
    // spec 130: attention tools are default-on; directive triage grants are
    // retained only as visible legacy metadata.
    await this.spawnLane(lane);
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
      void this.addLaneFromDirective(directive);
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

  // ─── Directive MCP round-trip (spec 124) ──────────────────────────────────

  private handleDirectiveApply(env: DirectiveApplyEvent, reply: (result: unknown) => void): void {
    const fromLane = this.lanes.find((l) => l.displayName === env.fromLaneId);
    if (!fromLane) {
      reply({ approved: false, approval: 'rejected', reason: 'unknown_sender' });
      return;
    }
    // One outstanding directive mutation per harness (mirrors the Rust /
    // peer_send one-in-flight rule).
    if (this.pendingDirectiveApproval) {
      reply({ approved: false, approval: 'rejected', reason: 'directive_approval_in_flight' });
      return;
    }

    if (env.action === 'assign') {
      this.handleDirectiveAssign(env, fromLane, reply);
      return;
    }

    // upsert / delete: persistent config change — always needs user approval.
    const reason = env.reason ? ` — ${env.reason}` : '';
    let banner: string;
    let cardText: string;
    let diff: { title: string; unified: string } | undefined;
    if (env.action === 'upsert' && env.directive) {
      const verb = env.isUpdate ? 'update' : 'create';
      // spec 130: triage metadata is legacy and no longer grants tool
      // visibility, but keep it visible so older directive files stay legible.
      const grant = env.directive.triage_equipped
        ? ' · legacy triage badge'
        : '';
      banner = `${fromLane.displayName} wants to ${verb} directive ${env.directive.id}${env.directive.triage_equipped ? ' [+triage]' : ''}`;
      cardText = `directive ${verb}: ${env.directive.id}${grant}${reason}`;
      const before = env.prior?.system_prompt ?? '';
      const after = env.directive.system_prompt;
      diff = { title: `directive ${env.directive.id} system_prompt`, unified: unifiedPromptDiff(before, after) };
    } else if (env.action === 'delete') {
      banner = `${fromLane.displayName} wants to delete directive ${env.directive_id}`;
      cardText = `directive delete: ${env.directive_id}${reason}`;
    } else {
      reply({ approved: false, approval: 'rejected', reason: 'invalid_request' });
      return;
    }

    const item = this.appendTranscript(fromLane, 'system', cardText);
    if (diff && item) item.diff = diff;
    this.pendingDirectiveApproval = {
      requestId: env.requestId ?? '',
      laneId: fromLane.id,
      action: env.action,
      banner,
      reply,
      onApprove: () => ({ approved: true }),
    };
    this.renderComposer();
    this.scheduleLaneRender(fromLane);
  }

  private handleDirectiveAssign(
    env: DirectiveApplyEvent,
    fromLane: HarnessLane,
    reply: (result: unknown) => void,
  ): void {
    const targetLane = env.lane ? this.lanes.find((l) => l.displayName === env.lane) : fromLane;
    if (!targetLane) {
      reply({ approved: false, approval: 'rejected', reason: 'unknown_lane' });
      return;
    }
    const scope: 'next_turn' | 'lane' = env.scope === 'next_turn' ? 'next_turn' : 'lane';
    const directiveId = env.directive_id ?? null;
    if (directiveId !== null) {
      const directive = this.directiveById(directiveId);
      if (!directive) {
        reply({ approved: false, approval: 'rejected', reason: 'unknown_directive' });
        return;
      }
      if (!this.directiveCompatible(directive, targetLane)) {
        reply({ approved: false, approval: 'rejected', reason: 'incompatible' });
        return;
      }
    }
    const crossLane = targetLane.id !== fromLane.id;
    // spec 130: attention tools are default-on, so triage metadata is no longer
    // a capability escalation. Same-lane assignment returns to the normal
    // auto-approval rule; cross-lane still requires approval.
    const autoApproved = !crossLane;
    const apply = (): unknown => {
      this.applyDirectiveAssignment(targetLane, directiveId, scope);
      this.appendTranscript(
        targetLane,
        'system',
        `directive ${directiveId ?? 'cleared'} assigned by ${fromLane.displayName} (${scope})`,
      );
      this.scheduleLaneRender(targetLane);
      return { action: 'assign', approved: true, approval: autoApproved ? 'auto' : 'approved', assigned: true, lane: targetLane.displayName };
    };

    if (autoApproved) {
      reply(apply());
      return;
    }
    // Needs explicit user approval for cross-lane assignment.
    const banner = `${fromLane.displayName} wants to assign directive to ${targetLane.displayName}`;
    this.appendTranscript(
      fromLane,
      'system',
      `directive assign → ${targetLane.displayName}: ${directiveId ?? 'clear'}${env.reason ? ` — ${env.reason}` : ''}`,
    );
    this.pendingDirectiveApproval = {
      requestId: env.requestId ?? '',
      laneId: fromLane.id,
      action: 'assign',
      banner,
      reply,
      onApprove: apply,
    };
    this.renderComposer();
    this.scheduleLaneRender(fromLane);
  }

  /** Apply a directive binding honoring scope and lane busy-state. */
  private applyDirectiveAssignment(lane: HarnessLane, directiveId: string | null, scope: 'next_turn' | 'lane'): void {
    if (scope === 'next_turn') {
      lane.previousDirectiveId = lane.activeDirectiveId;
      lane.turnDirectiveOverride = { directiveId };
      return;
    }
    this.assignDirectiveToLane(lane, directiveId);
  }

  private resolveDirectiveApproval(approved: boolean): void {
    const pending = this.pendingDirectiveApproval;
    if (!pending) return;
    this.pendingDirectiveApproval = null;
    const lane = this.lanes.find((l) => l.id === pending.laneId) ?? null;
    if (approved) {
      pending.reply(pending.onApprove());
      if (lane) this.appendTranscript(lane, 'system', `directive ${pending.action} approved`);
    } else {
      pending.reply({ action: pending.action, approved: false, approval: 'rejected' });
      if (lane) this.appendTranscript(lane, 'system', `directive ${pending.action} rejected`);
    }
    this.renderComposer();
    if (lane) this.scheduleLaneRender(lane);
  }

  private async openLanePicker(): Promise<void> {
    try {
      this.pickerEntries = await AcpClient.listBackends();
    } catch (e) {
      this.flashChip(`backend list failed: ${String(e)}`);
      return;
    }
    if (this.pickerEntries.length === 0) {
      this.flashChip('no ACP backends installed');
      return;
    }
    this.pickerOpen = true;
    this.pickerCursor = 0;
    this.helpOpen = false;
    this.memoryDrawerOpen = false;
    this.render();
  }

  private closeLanePicker(): void {
    if (!this.pickerOpen) return;
    this.pickerOpen = false;
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
        this.closeLanePicker();
        void this.addLane(entry.id);
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
        this.pickerEntries = await AcpClient.listBackends();
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
    const existing = this.lanes.filter((l) => l.backendId === state.backendId).length;
    const lane = this.createLane(this.nextLaneIndex++, state.backendId, `${label}-${existing + 1}`);
    lane.client = client;
    this.setLaneStatus(lane, 'starting');
    lane.transcript = [{ id: makeId(), kind: 'system', text: `${mode === 'resume' ? 'resuming' : 'loading'} ${shortId(session.sessionId)}...` }];
    this.lanes.push(lane);
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

  private async addLane(backendId: string): Promise<void> {
    const label = backendLabel(backendId);
    const existing = this.lanes.filter((l) => l.backendId === backendId).length;
    const lane = this.createLane(this.nextLaneIndex++, backendId, `${label}-${existing + 1}`);
    this.lanes.push(lane);
    this.activateLane(lane.id);
    await this.spawnLane(lane);
  }

  private async closeActiveLane(): Promise<void> {
    const lane = this.activeLane();
    if (!lane) return;
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
    if (lane.backendId === 'cursor' && lane.cursorMcpNames?.length && this.projectDir) {
      void cleanupCursorMcp(this.projectDir, lane.cursorMcpNames).catch((e) => {
        console.warn('[acp-harness] cleanup cursor mcp failed:', e);
      });
    }
    lane.cursorMcpNames = null;
    const index = this.lanes.findIndex((l) => l.id === lane.id);
    if (index !== -1) this.lanes.splice(index, 1);
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
    this.laneBus.emit({
      type: 'lane:closed',
      payload: { laneId: lane.id, displayName: lane.displayName },
    });
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
    lane.sessionId = null;
    lane.error = null;
    lane.plan = null;
    lane.planCollapsed = false;
    // spec 133: a restart reuses the display name — drop any pending artifact
    // write grant so the restarted lane can't inherit it.
    this.cancelPendingArtifactsForLane(lane);
    this.appendTranscript(lane, 'restart', '--- session restarted ---');
    await this.spawnLane(lane);
  }

  private async newLaneSession(lane: HarnessLane, options: { clearMemory: boolean }): Promise<void> {
    if (lane.status === 'busy' || lane.status === 'needs_permission' || lane.status === 'awaiting_peer') {
      this.flashChip('lane busy - #cancel first');
      return;
    }
    if (lane.status === 'starting') {
      this.flashChip('lane starting');
      return;
    }
    if (options.clearMemory && !this.harnessMemoryId) {
      this.flashChip(this.harnessMemoryWarning ? `memory unavailable: ${truncate(this.harnessMemoryWarning, 72)}` : 'memory unavailable - use #new');
      return;
    }
    if (options.clearMemory) {
      try {
        await this.clearActiveLaneMemory(lane, false);
      } catch (e) {
        this.flashChip(`memory clear failed: ${errorText(e)}`);
        return;
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
    lane.currentUserId = null;
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
    this.updateComposerTick();
    this.render();
    await this.spawnLane(lane);
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
    if (parts[0] === '#review') {
      this.setDraft(lane, '', 0);
      await this.runReviewCommand(lane, parts.slice(1));
      this.render();
      return;
    }
    this.flashChip('unknown command');
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
    this.element.classList.toggle('acp-harness--memory-open', this.memoryDrawerOpen);
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
    this.renderComposer();
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
    this.element.classList.toggle('acp-harness--memory-open', this.memoryDrawerOpen);
    this.renderActiveLaneChrome(lane);
    this.renderActiveTranscript(lane);
    this.renderLanePeek();
    this.renderPlanPanel(lane);
    this.renderComposer();
    this.scheduleStickyScroll();
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
          const next = renderTranscriptItem(item, false, streaming, lane);
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
        const next = renderTranscriptItem(item, isNew, streaming, lane);
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
    this.pickerEl.innerHTML =
      `<header class="acp-harness__picker-head">` +
      `<span>// add lane</span>` +
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
        const scope = [d.backend || 'all backends', d.task].filter(Boolean).join(' · ');
        const badge = d.enabled ? '' : 'disabled';
        const badgeEl = badge ? `<span class="acp-harness__directive-badge">${esc(badge)}</span>` : '';
        // spec 130: keep legacy triage metadata visible, but it no longer gates
        // attention_flag visibility.
        const triageEl = d.triage_equipped
          ? '<span class="acp-harness__directive-badge acp-harness__directive-badge--triage" title="legacy triage metadata; attention tools are default-on">◆ triage</span>'
          : '';
        const logoCls = d.backend === ''
          ? 'all'
          : d.backend === 'pi-acp'
            ? 'pi'
            : (BACKEND_LABELS[d.backend] ? d.backend : 'omp');
        const logoHtml =
          `<span class="acp-harness__directive-logo acp-harness__directive-logo--${logoCls}" aria-hidden="true">` +
          `<svg><use href="#${backendLogoId(d.backend)}"/></svg>` +
          `</span>`;
        return (
          `<li class="acp-harness__directive-row${active}${state}" data-directive-index="${i}">` +
          logoHtml +
          `<span class="acp-harness__directive-icon">${esc(d.icon)}</span>` +
          `<span class="acp-harness__directive-main">` +
          `<span class="acp-harness__directive-title">${esc(d.title || d.id)}${assigned}${badgeEl}${triageEl}</span>` +
          `<span class="acp-harness__directive-meta">${esc(d.id)} · ${esc(scope)}</span>` +
          (d.description ? `<span class="acp-harness__directive-desc">${esc(d.description)}</span>` : '') +
          `</span>` +
          `</li>`
        );
      })
      .join('');
    const selected = ordered[cursor];
    const preview = selected
      ? `<div class="acp-harness__directive-preview">` +
        `<div class="acp-harness__directive-preview-head">` +
        `<span>// prompt</span>` +
        `<span class="acp-harness__directive-preview-scope">${esc(selected.title || selected.id)}</span>` +
        `</div>` +
        `<div class="acp-harness__directive-preview-body">${esc(selected.system_prompt || '(empty prompt)')}</div>` +
        `</div>`
      : '';
    this.directivePickerEl.innerHTML =
      `<header class="acp-harness__directive-head">` +
      `<span>// directive · spawn new lane</span>` +
      `<span>j/k move · enter spawn · backspace clear ${esc(lane.displayName)} · esc cancel</span>` +
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
      metaHtml =
        `<span class="acp-harness__rail-meta">` +
        `<span class="acp-harness__rail-meta__hint">${esc(statusLabel(lane.status))}</span>` +
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
      this.composerEl.className = 'acp-harness__composer acp-harness__composer--permission';
      this.composerEl.innerHTML =
        `<div class="acp-harness__composer-meta">! permission required - see lane</div>` +
        `<div class="acp-harness__permission-options">a accept &nbsp;&nbsp; A accept-all-turn &nbsp;&nbsp; r reject &nbsp;&nbsp; R reject-all-turn &nbsp;&nbsp; Esc cancel</div>`;
      return;
    }
    if (this.pendingDirectiveApproval && this.pendingDirectiveApproval.laneId === lane.id) {
      this.composerEl.className = 'acp-harness__composer acp-harness__composer--permission';
      this.composerEl.innerHTML =
        `<div class="acp-harness__composer-meta">${esc(this.pendingDirectiveApproval.banner)} — see lane</div>` +
        `<div class="acp-harness__permission-options">a approve &nbsp;&nbsp; r reject &nbsp;&nbsp; Esc reject</div>`;
      return;
    }
    this.composerEl.className =
      `acp-harness__composer${this.focus === 'transcript' ? ' acp-harness__composer--command' : ''}` +
      `${this.memoryDrawerOpen ? ' acp-harness__composer--memory' : ''}` +
      `${lane.status === 'busy' ? ' acp-harness__composer--running' : ''}`;
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
    const peerStrip = buildComposerPeerStrip(
      lane.status,
      this.coordinator.pendingPeersFor(lane.id),
      this.coordinator.inboxDepth(lane.id),
    );
    this.composerEl.innerHTML =
      `<div class="acp-harness__composer-meta">` +
      `<span class="${chipClass}">${esc(chip)}</span>` +
      this.renderDirectiveChip(lane) +
      projectStatus +
      `</div>` +
      peerStrip +
      staging +
      mentionPalette +
      palette +
      `<div class="acp-harness__input-line">` +
      `<span class="acp-harness__lane-tag">${esc(lane.displayName)}</span>` +
      `<span class="acp-harness__prompt">›</span>` +
      `<span class="acp-harness__input">${esc(before)}<span class="acp-harness__caret">█</span>${esc(after)}</span>` +
      `<span class="acp-harness__help-hint">? help</span></div>`;
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
      return `${lane.displayName} running${elapsed} · Ctrl+C cancel`;
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
    const branchText = branch ? ` on ${branch}` : '';
    const title = this.projectDir ? `${this.projectDir}${this.gitBranch ? ` on ${this.gitBranch}` : ''}` : '';
    return `<span class="acp-harness__project-status" title="${esc(title)}">${esc(cwd)}${esc(branchText)}</span>`;
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
            <dt>#review &lt;lane&gt; [note]</dt><dd>Ask another lane to review your uncommitted work</dd>
            <dt>#restart</dt><dd>Respawn active lane when error or stopped</dd>
            <dt>#mem</dt><dd>Show memory command hint</dd>
            <dt>#mem clear</dt><dd>Clear active lane memory only</dd>
            <dt>#mcp</dt><dd>Show MCP endpoint and lane status</dd>
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
    const providerError = classifyProviderError(raw, lane.backendId);
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
    this.markLaneProviderError(lane, payload);
  }

  private markLaneProviderError(lane: HarnessLane, payload: ProviderErrorPayload): void {
    this.setLaneStatus(lane, 'error');
    lane.error = payload.headline;
    lane.activeTurnStartedAt = null;
    lane.pendingTurnExtractions = [];
    lane.pendingPermissions = [];
    lane.acceptAllForTurn = false;
    lane.rejectAllForTurn = false;
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
    if (kind !== 'user') lane.currentUserId = null;
    if (kind !== 'assistant') lane.currentAssistantId = null;
    if (kind !== 'thought') lane.currentThoughtId = null;
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
  }

  private sealStreaming(lane: HarnessLane): void {
    // Spec 114: capture the assistant id BEFORE nulling so we can find the
    // row that was just streaming.
    const assistantId = lane.currentAssistantId;
    lane.currentUserId = null;
    lane.currentAssistantId = null;
    lane.currentThoughtId = null;
    if (assistantId) {
      const item = lane.transcript.find((entry) => entry.id === assistantId);
      if (item) {
        const providerError = classifyProviderError(item.text, lane.backendId);
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
      const renderer = makeSafeRenderer(offscreen);
      const parser = smd.parser(renderer);
      try {
        smd.parser_write(parser, item.text);
        smd.parser_end(parser);
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
    const activeIdx = entries.findIndex((e) => e.status === 'in_progress');
    const stepNum = activeIdx >= 0 ? activeIdx + 1 : done < total ? done + 1 : total;
    const collapsed = lane.planCollapsed;

    const header =
      `<div class="acp-harness__plan-header">` +
      `<span class="acp-harness__plan-title">plan</span>` +
      `<span class="acp-harness__plan-step">step <b>${stepNum}</b> of ${total}</span>` +
      `<span class="acp-harness__plan-count"><b>${done}</b>/${total}</span>` +
      `</div>`;

    const segs = entries
      .map((e) => {
        const cls =
          e.status === 'completed'
            ? 'acp-harness__plan-seg acp-harness__plan-seg--done'
            : e.status === 'in_progress'
              ? 'acp-harness__plan-seg acp-harness__plan-seg--prog'
              : 'acp-harness__plan-seg';
        return `<span class="${cls}"></span>`;
      })
      .join('');
    const bar = `<div class="acp-harness__plan-bar">${segs}</div>`;

    const priorityLabel: Record<'low' | 'medium' | 'high', string> = {
      low: 'low',
      medium: 'med',
      high: 'high',
    };
    const rows = entries
      .map((entry) => {
        const cls = `acp-harness__plan-entry acp-harness__plan-entry--${entry.status}`;
        const tag = entry.priority
          ? `<span class="acp-harness__plan-tag acp-harness__plan-tag--${entry.priority}">${priorityLabel[entry.priority]}</span>`
          : `<span class="acp-harness__plan-tag-spacer"></span>`;
        return (
          `<div class="${cls}">` +
          `<span class="acp-harness__plan-dot"></span>` +
          `<span class="acp-harness__plan-entry-text">${esc(entry.content)}</span>` +
          tag +
          `</div>`
        );
      })
      .join('');
    const entriesBlock = collapsed
      ? ''
      : `<div class="acp-harness__plan-entries">${rows}</div>`;

    const footer =
      `<div class="acp-harness__plan-footer">` +
      `<span class="acp-harness__plan-key"><b>p</b> ${collapsed ? 'expand' : 'collapse'}</span>` +
      `</div>`;

    this.planEl.innerHTML = header + bar + entriesBlock + footer;
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
  const match = normalized.match(/(?:^|[^a-z0-9_])(memory_set|memory_get|memory_list|peer_send|peer_list|review_request|review_reply|attention_flag|attention_resolve)(?:$|[^a-z0-9_])/);
  return match && HARNESS_AUTO_ALLOW_TOOL_NAMES.has(match[1]) ? match[1] : null;
}

function harnessToolFamily(toolName: string): HarnessToolFamily | null {
  if (HARNESS_MEMORY_TOOL_NAMES.has(toolName)) return 'memory';
  if (HARNESS_PEER_TOOL_NAMES.has(toolName)) return 'peer';
  if (HARNESS_REVIEW_TOOL_NAMES.has(toolName)) return 'review';
  if (HARNESS_ATTENTION_TOOL_NAMES.has(toolName)) return 'attention';
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

function permissionArgsPreview(value: unknown): string {
  const args = extractToolArguments(value);
  if (!args || typeof args !== 'object' || Array.isArray(args)) return boundedInlineValue(args ?? value);
  const parts: string[] = [];
  for (const [key, raw] of Object.entries(args as Record<string, unknown>)) {
    if (parts.length >= 4) break;
    parts.push(`${key}: ${boundedInlineValue(raw, 42)}`);
  }
  return truncate(parts.join(' · '), 140);
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

// Spec 114 rev 4: append-only update for streaming assistant / thought /
// user rows. One TextNode grows via appendData; markdown waits for seal.
// Spec 117: assistant rows now use updateStreamingAssistantMarkdownBody; this
// helper still serves thought / user streaming rows.
function updateStreamingTextBody(body: HTMLElement, item: HarnessTranscriptItem): void {
  if (!body.classList.contains('acp-harness__msg-body--stream-plain')) {
    body.classList.remove('acp-harness__msg-body--markdown');
    delete body.dataset.pretext;
    delete body.dataset.rawText;
    delete body.dataset.rowId;
    body.classList.add('acp-harness__msg-body--stream-plain');
    const seed = document.createTextNode(item.text);
    body.replaceChildren(seed);
    item.streamPlainLength = item.text.length;
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

function renderTranscriptItem(item: HarnessTranscriptItem, isNew: boolean, streaming: boolean, lane: HarnessLane | null): HTMLElement {
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
    renderLaneMailBody(body, item.interLane, item.text);
  } else if (item.kind === 'system' && item.text.startsWith('[inter-lane]')) {
    label.textContent = 'event';
    el.classList.add('acp-harness__msg--harness-event');
    body.classList.add('acp-harness__harness-event-body');
    body.textContent = item.text.replace(/^\[inter-lane\]\s*/u, '');
  } else if (item.kind === 'review' && item.review) {
    body.classList.add('acp-harness__review-card');
    renderReviewCardBody(body, item.review);
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
      body.classList.add('acp-harness__msg-body--stream-plain');
      body.appendChild(document.createTextNode(item.text));
      item.streamPlainLength = item.text.length;
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
    ? `${item.interLane.direction}\u001e${item.interLane.peerId}\u001e${item.interLane.peerDisplayName}\u001e${item.interLane.done ? '1' : '0'}\u001e${item.interLane.channel ?? ''}`
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
  else if (channel === 'review') line += ' · review';
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

function renderLaneMailBody(body: HTMLElement, payload: InterLanePayload, message: string): void {
  body.classList.add('acp-harness__msg-body--lane-mail');
  const meta = document.createElement('span');
  meta.className = 'acp-harness__lane-mail-meta';
  meta.textContent = formatLaneMailMetaLine(
    payload.direction,
    payload.peerDisplayName,
    payload.done,
    payload.channel,
  );
  const text = document.createElement('span');
  text.className = 'acp-harness__lane-mail-text';
  text.textContent = message;
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

function renderPermissionBody(body: HTMLElement, perm: PermissionPayload): void {
  const card = document.createElement('div');
  card.className = 'acp-harness__perm-card';
  card.dataset.decision = perm.decision;
  const head = document.createElement('div');
  head.className = 'acp-harness__perm-row';
  const family = document.createElement('span');
  family.className = 'acp-harness__perm-family';
  family.textContent = perm.toolFamily;
  head.appendChild(family);
  const tool = document.createElement('span');
  tool.className = 'acp-harness__perm-tool';
  tool.textContent = perm.toolName;
  head.appendChild(tool);
  const subject = document.createElement('span');
  subject.className = 'acp-harness__perm-subject';
  subject.textContent = perm.subject;
  subject.title = perm.subject;
  head.appendChild(subject);
  const decision = document.createElement('span');
  decision.className = 'acp-harness__perm-decision';
  decision.textContent = permissionDecisionLabel(perm);
  head.appendChild(decision);
  card.appendChild(head);
  if (perm.suffix) {
    const suffix = document.createElement('span');
    suffix.className = 'acp-harness__perm-suffix';
    suffix.textContent = perm.suffix;
    card.appendChild(suffix);
  }
  if (perm.autoReason) {
    const reason = document.createElement('div');
    reason.className = 'acp-harness__perm-reason';
    reason.textContent = perm.autoReason;
    card.appendChild(reason);
  }
  if (perm.argsPreview) {
    const preview = document.createElement('div');
    preview.className = 'acp-harness__perm-preview';
    preview.textContent = perm.argsPreview;
    card.appendChild(preview);
  }
  if (perm.decision === 'pending') {
    const actions = document.createElement('div');
    actions.className = 'acp-harness__perm-actions';
    const labels = perm.options
      .filter((option) => option.action === 'accept' || option.action === 'reject')
      .map((option) => option.action === 'accept' ? 'a accept' : 'r reject');
    actions.textContent = Array.from(new Set(labels)).join(' · ');
    card.appendChild(actions);
  }
  body.appendChild(card);
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
): string {
  const mcpChip = renderMcpChip(mcp);
  const modelChip = renderModelChip(lane.modelName, lane.modelApplyFailed);
  const modeChip = renderModeChip(lane);
  const sandboxChip = renderSandboxChip(lane);
  const metricsChip = renderMetricsChip(metrics);
  const chipGroup = modelChip + modeChip + mcpChip + sandboxChip + metricsChip;
  const chips = chipGroup
    ? `<span class="acp-harness__lane-chips">${chipGroup}</span>`
    : '';
  const inboxChip = inboxDepth > 0
    ? `<span class="acp-harness__lane-inbox" title="${inboxDepth} pending peer message${inboxDepth === 1 ? '' : 's'}">▼${inboxDepth}</span>`
    : '';
  if (!active) {
    return (
      `<span class="acp-harness__lane-symbol">${statusSymbol(lane.status)}</span>` +
      `<span class="acp-harness__lane-name">${esc(lane.displayName)}</span>` +
      `<span class="acp-harness__lane-status">${esc(statusLabel(lane.status))}</span>` +
      inboxChip +
      chips +
      `<span class="acp-harness__lane-activity">${esc(laneActivity(lane, pendingPeers))}</span>`
    );
  }
  const cancelHint = lane.status === 'busy' || lane.status === 'needs_permission' || lane.status === 'awaiting_peer' || lane.pendingShellId
    ? `<span class="acp-harness__lane-cancel-hint">⌃C cancel</span>`
    : '';
  return (
    `<span class="acp-harness__lane-symbol">${statusSymbol(lane.status)}</span>` +
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
    const processName =
      `<span class="acp-harness__metrics-tree">${esc(prefix + branch)}</span>` +
      `<span class="acp-harness__metrics-name">${esc(p.name)}</span>` +
      role;
    lines.push(
      `<div class="acp-harness__metrics-row${depth === 0 ? ' acp-harness__metrics-row--root' : ''}">` +
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

function renderSandboxChip(lane: HarnessLane): string {
  // Surface backend-specific safety caveats directly in the lane chrome:
  // Pi is known to bypass the permission rail, while Cursor still needs
  // manual verification of ACP write-permission semantics.
  if (lane.backendId === 'pi-acp') {
    const title = 'No permission gate — Pi runs edits and shell commands immediately. Use a sandboxed cwd or container if untrusted.';
    return `<span class="acp-harness__lane-sandbox" title="${esc(title)}">⚠ unsandboxed</span>`;
  }
  if (lane.backendId === 'cursor') {
    const title = 'Cursor ACP write-permission behavior has not been verified yet. Krypton does not pass force/yolo flags, but use a trusted cwd until verified.';
    return `<span class="acp-harness__lane-sandbox" title="${esc(title)}">⚠ permissions unverified</span>`;
  }
  if (lane.backendId === 'junie') {
    const title = 'Junie ACP write-permission behavior has not been verified yet. Krypton does not pass force/yolo/brave flags, but use a trusted cwd until verified.';
    return `<span class="acp-harness__lane-sandbox" title="${esc(title)}">⚠ permissions unverified</span>`;
  }
  return '';
}

function renderModelChip(modelName: string | null, applyFailed = false): string {
  if (!modelName) return '';
  if (applyFailed) {
    const title = `requested model ${modelName} not applied — agent is using its default or prior model (session/set_model failed)`;
    return `<span class="acp-harness__lane-model acp-harness__lane-model--warn" title="${esc(title)}">⚠ ${esc(modelName)}</span>`;
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
  return `<span class="acp-harness__lane-mcp acp-harness__lane-mcp--on" title="${esc(title)}">mcp ✓${mcp.toolsCallCount > 0 ? ` ${mcp.toolsCallCount}` : ''}</span>`;
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
  ];
  return accents[(index - 1) % accents.length];
}

export function laneAccentForLabel(label: string): string {
  if (/codex/i.test(label)) return laneAccent(1);
  if (/claude/i.test(label)) return laneAccent(2);
  if (/gemini/i.test(label)) return laneAccent(3);
  if (/opencode/i.test(label)) return laneAccent(4);
  if (/^pi(-|$)/i.test(label)) return laneAccent(5);
  if (/droid/i.test(label)) return laneAccent(6);
  if (/cursor/i.test(label)) return laneAccent(7);
  if (/junie/i.test(label)) return laneAccent(8);
  if (/^omp(-|$)/i.test(label)) return laneAccent(9);
  const match = label.match(/-(\d+)$/);
  return match ? laneAccent(Number(match[1])) : 'var(--krypton-window-accent, #0cf)';
}

function renderLaneStats(lane: HarnessLane, projectDir: string | null): string {
  const parts: string[] = [];
  parts.push(lane.backendId);
  parts.push(lane.sessionId ? `sess ${shortId(lane.sessionId)}` : 'sess pending');
  if (projectDir) parts.push(basename(projectDir));

  const usage = lane.usage;
  if (usage) {
    if (typeof usage.used === 'number') {
      if (typeof usage.size === 'number' && usage.size > 0) {
        const pct = Math.round((usage.used / usage.size) * 100);
        parts.push(`ctx ${formatCount(usage.used)}/${formatCount(usage.size)} (${pct}%)`);
      } else {
        parts.push(`ctx ${formatCount(usage.used)}`);
      }
    }
    if (typeof usage.cachedReadTokens === 'number' || typeof usage.cachedWriteTokens === 'number') {
      const r = usage.cachedReadTokens ?? 0;
      const w = usage.cachedWriteTokens ?? 0;
      parts.push(`cache ${formatCount(r)}↓ ${formatCount(w)}↑`);
    }
    if (typeof usage.inputTokens === 'number' || typeof usage.outputTokens === 'number') {
      parts.push(`in ${formatCount(usage.inputTokens ?? 0)} out ${formatCount(usage.outputTokens ?? 0)}`);
    }
    if (usage.cost) parts.push(`$${usage.cost.amount.toFixed(4)} ${usage.cost.currency}`);
  }

  if (lane.toolCalls.size > 0) parts.push(`${lane.toolCalls.size} tools`);
  parts.push(`${lane.transcript.length} rows`);
  if (lane.pendingPermissions.length > 0) parts.push(`${lane.pendingPermissions.length} perm`);
  if (lane.acceptAllForTurn) parts.push('accept-all');
  if (lane.rejectAllForTurn) parts.push('reject-all');
  if (lane.error) parts.push(`err: ${truncate(lane.error, 48)}`);

  return parts.map((part) => `<span>${esc(part)}</span>`).join('');
}

function basename(path: string): string {
  const trimmed = path.replace(/\/+$/, '');
  const idx = trimmed.lastIndexOf('/');
  return idx === -1 ? trimmed : trimmed.slice(idx + 1) || trimmed;
}

function truncate(s: string, max: number): string {
  return s.length <= max ? s : `${s.slice(0, max - 1)}…`;
}

/** spec 124: compact line-based before/after diff for a directive system
 * prompt. Trims the common prefix/suffix lines, then shows the rest as
 * removed (`-`) / added (`+`) blocks. */
function unifiedPromptDiff(before: string, after: string): string {
  if (before === after) return after.split('\n').map((l) => ` ${l}`).join('\n');
  const b = before.length ? before.split('\n') : [];
  const a = after.length ? after.split('\n') : [];
  let start = 0;
  while (start < b.length && start < a.length && b[start] === a[start]) start += 1;
  let endB = b.length;
  let endA = a.length;
  while (endB > start && endA > start && b[endB - 1] === a[endA - 1]) {
    endB -= 1;
    endA -= 1;
  }
  const lines: string[] = [];
  for (let i = 0; i < start; i += 1) lines.push(` ${b[i]}`);
  for (let i = start; i < endB; i += 1) lines.push(`-${b[i]}`);
  for (let i = start; i < endA; i += 1) lines.push(`+${a[i]}`);
  for (let i = endB; i < b.length; i += 1) lines.push(` ${b[i]}`);
  return lines.join('\n');
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
    case 'review': return 'rev';
    case 'artifact': return 'html';
    default: return kind;
  }
}

function renderReviewCardBody(body: HTMLElement, payload: ReviewCardPayload): void {
  body.dataset.direction = 'received';
  if (payload.interruptedReason) body.classList.add('acp-harness__review-card--blocked');

  // Header line
  const block = payload.findings.filter((f) => f.severity === 'block').length;
  const warn = payload.findings.filter((f) => f.severity === 'warn').length;
  const nit = payload.findings.filter((f) => f.severity === 'nit').length;
  const counts: string[] = [];
  if (block) counts.push(`${block} block`);
  if (warn) counts.push(`${warn} warn`);
  if (nit) counts.push(`${nit} nit`);
  const head = document.createElement('div');
  head.className = 'acp-harness__review-head';
  head.innerHTML =
    `<span class="acp-harness__review-arrow">←</span>` +
    `<span class="acp-harness__review-peer">from ${esc(payload.fromDisplayName)}</span>` +
    `<span class="acp-harness__review-count">${payload.findings.length} finding${
      payload.findings.length === 1 ? '' : 's'
    }${counts.length ? ` (${esc(counts.join(', '))})` : ''}</span>`;
  body.appendChild(head);

  if (!payload.worktreeMatchAtReceipt) {
    const banner = document.createElement('div');
    banner.className = 'acp-harness__review-banner';
    banner.textContent = 'worktree changed since review request — verify findings against current code';
    body.appendChild(banner);
  }
  if (payload.interruptedReason) {
    const banner = document.createElement('div');
    banner.className = 'acp-harness__review-banner acp-harness__review-banner--blocked';
    banner.textContent = `review interrupted: ${payload.interruptedReason}`;
    body.appendChild(banner);
  }

  if (payload.summary && payload.summary.trim().length > 0) {
    const sum = document.createElement('div');
    sum.className = 'acp-harness__review-summary';
    sum.textContent = payload.summary;
    body.appendChild(sum);
  }

  if (payload.findings.length === 0 && !payload.interruptedReason) {
    const clean = document.createElement('div');
    clean.className = 'acp-harness__review-clean';
    clean.textContent = '(clean review — no findings)';
    body.appendChild(clean);
    return;
  }

  const list = document.createElement('div');
  list.className = 'acp-harness__review-findings';
  for (const f of payload.findings) {
    const row = document.createElement('div');
    row.className = `acp-harness__review-finding acp-harness__review-finding--${f.severity}`;
    const sev = document.createElement('span');
    sev.className = 'acp-harness__review-sev';
    sev.textContent = f.severity;
    const anchor = document.createElement('span');
    anchor.className = 'acp-harness__review-anchor';
    anchor.textContent = `${f.file}:${f.line}`;
    const concern = document.createElement('span');
    concern.className = 'acp-harness__review-concern';
    concern.textContent = f.concern;
    row.appendChild(sev);
    row.appendChild(anchor);
    row.appendChild(concern);
    if (f.suggestedCheck) {
      const check = document.createElement('div');
      check.className = 'acp-harness__review-check';
      check.textContent = `check: ${f.suggestedCheck}`;
      row.appendChild(check);
    }
    list.appendChild(row);
  }
  body.appendChild(list);
}

export function isDirectPeerPeekReasonKey(reasonKey: string): boolean {
  return reasonKey === 'awaiting-peer' || reasonKey === 'inbound-peer' || reasonKey === 'peer-counterpart';
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
  if (lane.status === 'needs_permission') return `perm: ${lane.pendingPermissions[0]?.toolCall.title ?? 'required'}`;
  if (lane.status === 'awaiting_peer') return awaitingPeerText(pendingPeers);
  const latest = lane.transcript[lane.transcript.length - 1];
  if (!latest) return lane.status;
  return latest.text.replace(/\s+/g, ' ').slice(0, 60);
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

function statusSymbol(status: HarnessLaneStatus): string {
  switch (status) {
    case 'starting': return '·';
    case 'idle': return '○';
    case 'busy': return '●';
    case 'needs_permission': return '!';
    case 'awaiting_peer': return '⇆';
    case 'error': return '×';
    case 'stopped': return '×';
  }
}

function statusLabel(status: HarnessLaneStatus): string {
  switch (status) {
    case 'starting': return 'starting';
    case 'idle': return 'idle';
    case 'busy': return 'busy';
    case 'needs_permission': return 'permission';
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

function extractCommandLine(rawInput: unknown): string {
  if (typeof rawInput === 'object' && rawInput) {
    const record = rawInput as Record<string, unknown>;
    for (const key of ['command', 'cmd']) {
      if (typeof record[key] === 'string') return truncateInline(record[key], 96);
    }
    if (Array.isArray(record.argv)) {
      const argv = record.argv.filter((part): part is string => typeof part === 'string');
      if (argv.length > 0) return truncateInline(argv.join(' '), 96);
    }
  }
  return '';
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

function rawOutputSections(rawOutput: unknown): Array<{ label: string; text: string }> {
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

function stringifyToolValue(value: unknown): string {
  if (value === null || value === undefined) return '';
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (Array.isArray(value)) {
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

function boundedOutputLines(value: string, maxLines: number): string {
  const kept = value
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

function formatShortTime(epochMs: number): string {
  const age = Date.now() - epochMs;
  if (age >= 0 && age < 24 * 60 * 60 * 1000) return `${formatAge(age)} ago`;
  return new Date(epochMs).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
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
