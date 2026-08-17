// Krypton — ACP wire types.
// Mirrors the subset of agentclientprotocol.com types we actually consume.

export type StopReason = 'end_turn' | 'max_tokens' | 'max_turn_requests' | 'refusal' | 'cancelled';

export type ContentBlock =
  | { type: 'text'; text: string }
  | { type: 'image'; data: string; mimeType: string; uri?: string }
  | { type: 'audio'; data: string; mimeType: string }
  | {
      type: 'resource_link';
      uri: string;
      name?: string;
      title?: string;
      description?: string;
      mimeType?: string;
      size?: number;
    }
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
  /** spec 143: sender requests the recipient's peer-injected turn auto-accept
   *  non-high-risk permissions (high-risk commands still prompt the human).
   *  Honored only for same-view sibling senders on request/initiation envelopes;
   *  coerced to false (and reported back) for foreign/cross-harness senders. */
  autoAccept?: boolean;
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
  /** spec 115: peer chat or composer @mention fan-out. */
  kind?: 'peer' | 'mention_request';
  /** spec 115: correlates fan-out replies on the requester. */
  mentionPacketId?: string;
}

// Artifact inline feedback (spec 149). The browser POSTs a batch of comments
// captured on a served HTML artifact; the harness routes them to the authoring
// lane as a system turn. These types mirror the JSON the scaffold sends.
export interface DomAnchor {
  /** location.pathname at pin time (single-page artifacts: usually "/"). */
  pathname: string;
  /** best-effort unique selector built on click (parentElement + nth-of-type). */
  cssSelector: string;
  /** ancestor tag names, outermost→innermost — a fallback if the selector drifts. */
  tagChain: string[];
  /** ARIA name / visible label fallback. */
  accessibleName?: string;
  /** ARIA role, if any. */
  role?: string;
  /** element snapshot at pin time (capped), for drift recovery. */
  outerHTML: string;
}

export interface ArtifactComment {
  /** stable client id, for server-side + frontend de-dupe. */
  id: string;
  /** 1-based, stable per artifact ("pin #3"). */
  pinNumber: number;
  /** the user's comment text. */
  body: string;
  /** selected text inside the element, if any. */
  quote?: string;
  anchor: DomAnchor;
  createdAt: number;
}

export interface ArtifactFeedbackEnvelope {
  kind: 'artifact_feedback';
  /** idempotency key — a retried POST with the same id is dropped. */
  batchId: string;
  artifactId: string;
  artifactTitle: string;
  /** owning lane label from the registry; the frontend resolves → live lane. */
  laneLabel: string;
  comments: ArtifactComment[];
  sentAt: number;
}

// Docs browser inline feedback (spec 172). The browser POSTs comments captured
// on a rendered `/doc` page; the harness routes them to its ACTIVE lane as a
// system turn. Unlike artifact feedback (spec 149), a doc has no owning lane and
// no token — it is a repo file addressed by harness + path. The page is comrak
// HTML, not the source markdown, so the anchor is the QUOTED TEXT + enclosing
// heading trail (a cssSelector into the rendered DOM is meaningless to a lane
// editing the `.md`); the lane locates the passage in source by that quote.
export interface DocComment {
  /** stable client id, for frontend de-dupe. */
  id: string;
  /** 1-based, stable per page ("pin #3"). */
  pinNumber: number;
  /** the user's comment text. */
  body: string;
  /** rendered text the user selected / the element's text — the lane greps for it. */
  quote?: string;
  /** nearest enclosing heading trail, outermost→innermost ("Decisions" › "Path validation"). */
  headingPath: string[];
  createdAt: number;
}

export interface DocFeedbackEnvelope {
  kind: 'doc_feedback';
  /** idempotency key — a retried POST with the same id is dropped. */
  batchId: string;
  harnessId: string;
  /** repo-relative `.md` path under the harness <cwd>. */
  docPath: string;
  comments: DocComment[];
  sentAt: number;
}

export interface DocArtifactRequestEnvelope {
  kind: 'doc_artifact_request';
  /** idempotency key — a retried POST with the same id is dropped. */
  batchId: string;
  harnessId: string;
  /** repo-relative `.md` path under the harness <cwd>. */
  docPath: string;
  /** title to pass to artifact_new. */
  title: string;
  sentAt: number;
}

// ─── Diff review comments (spec 158) ───
// Human→lane inline review on the working diff. A comment carries a precise
// file:line anchor (intrinsic to the diff, no synthesized selector) plus the
// quoted code and the human's note. Sibling to artifact feedback (spec 149):
// same drain-on-idle delivery, different surface.

export interface DiffReviewComment {
  /** stable client id, for de-dupe within a batch. */
  id: string;
  /** newName, or oldName for a deletion. */
  file: string;
  /** which side the anchor sits on: 'new' = post-change line, 'old' = pre-change. */
  side: 'old' | 'new';
  /** diff line numbers (inclusive); lineStart === lineEnd for a single line. */
  lineStart: number;
  lineEnd: number;
  /** the selected/hunk code text (capped). */
  quote: string;
  /** the human's comment. */
  body: string;
  createdAt: number;
}

export interface DiffReviewEnvelope {
  kind: 'diff_review';
  /** idempotency key — a retried send carrying a seen id is dropped. */
  batchId: string;
  comments: DiffReviewComment[];
  sentAt: number;
}

/** A live lane that can receive review comments. */
export interface ReviewTarget {
  displayName: string;
  status: HarnessLaneStatus;
}

/** Snapshot of routable lanes for a repo, resolved on demand (no broadcast). */
export interface DiffReviewTargets {
  lanes: ReviewTarget[];
  /** Pre-selected target: the active lane if it is a candidate, else the sole
   *  candidate, else null (the human must pick). */
  default: string | null;
}

/** One batch the diff view sends to a chosen lane. */
export interface DiffReviewBatch {
  batchId: string;
  /** target lane displayName (globally unique via the HarnessDirectory). */
  target: string;
  comments: DiffReviewComment[];
}

export type DiffReviewSendResult = {
  /** 'accepted' = queued for the lane; 'no-live-lane' = target gone, keep the
   *  batch; 'duplicate' = already accepted (idempotent retry). */
  status: 'accepted' | 'no-live-lane' | 'duplicate';
};

// Diff review priority (spec 160) — the authoring lane self-reports, per change,
// how the human should spend reading attention on the working diff. The Diff
// Window FOLDS `routine` hunks (always expandable) and MARKS + navigates to
// `high` ones; it never hides or reorders. `normal` is the unreported default,
// so silence yields today's full diff. See docs/160-diff-review-priority.md and
// docs/adr/0009. Reuses the spec-158 line-range anchor concept (NOT the
// DiffReviewComment type — this carries no human note or idempotency id).

/** One lane-reported priority range over the working diff (spec 160). */
export interface ReviewPriorityRange {
  /** post-change (new-side) path, repo-relative. */
  file: string;
  /** new-side line numbers (inclusive) of the lines the lane wrote. */
  lineStart: number;
  lineEnd: number;
  /** 'normal' is the unreported default — only the non-default levels appear. */
  level: 'high' | 'routine';
  /** Optional short human-readable reason shown in priority panels. */
  reason?: string;
}

/** The latest priority report from one authoring lane. */
export interface ReviewPriorityReport {
  laneId: string;
  ranges: ReviewPriorityRange[];
  reportedAt: number;
}

/** Snapshot of the merged priority ranges over a repo's working diff, resolved
 *  on demand (a pull, like DiffReviewTargets — no broadcast). Merged across every
 *  authoring lane in the repo; the Window takes the max level per hunk. */
export interface ReviewPrioritySnapshot {
  ranges: ReviewPriorityRange[];
}

// ─── Review Board (spec 211) ───
// A lane-authored review DOCUMENT — Markdown plus a small set of typed fenced
// blocks — that a human reads in a guided order and answers once. The spine is
// explanation (prose + `walkthrough`); findings and decisions are additions, so
// a Board with zero of either is the normal comprehension case, not an error.
// The result is a file on disk (`.krypton/reviews/<date>-<slug>/`), never
// session state — see docs/211-review-board.md.

export type ReviewBlockKind =
  | 'markdown'
  | 'walkthrough'
  | 'diff'
  | 'finding'
  | 'decision'
  | 'chart'
  | 'metrics'
  | 'svg';

/** One step of the comprehension spine: a code location plus why it matters. */
export interface ReviewWalkthroughStep {
  /** `path` or `path:line` (or `path:lineStart-lineEnd`), repo-relative. */
  at: string;
  /** What this location does / why it matters — one or two sentences. */
  say: string;
}

/** The comprehension spine: an ordered tour of the code, each step anchored. */
export interface ReviewWalkthroughBlock {
  title?: string;
  steps: ReviewWalkthroughStep[];
}

export type ReviewBlockSeverity = 'blocking' | 'non-blocking' | 'suggestion';

export interface ReviewFindingBlock {
  severity: ReviewBlockSeverity;
  title: string;
  file?: string;
  line?: number;
  /** Prose that followed the fence, if the lane wrote any (the explanation). */
  detail?: string;
}

export interface ReviewDecisionBlock {
  question: string;
  options: string[];
  /** 1-based index of the lane's recommendation, if it made one. */
  recommended?: number;
}

export interface ReviewChartBlock {
  kind: 'bar' | 'line' | 'sparkline';
  title?: string;
  data: { label: string; value: number }[];
}

/** A stat row — ordered label/value pairs, rendered as a definition strip. */
export interface ReviewMetricsBlock {
  rows: { label: string; value: string }[];
}

export interface ReviewDiffBlock {
  /** Unified-diff text handed to diff2html verbatim. */
  unified: string;
}

export interface ReviewSvgBlock {
  /** Raw `<svg>` source; sanitized at render time, never inserted as-is. */
  svg: string;
}

/** Fields every block carries, whatever its kind. */
export interface ReviewBlockMeta {
  /** Stable within a document: `b${ordinal}-${fnv1a(raw)}`. Re-attaches the
   *  human's comments/triage after the lane iterates on the file. */
  id: string;
  /** Original fenced/markdown source — the escape hatch and diagnostic view. */
  raw: string;
  /** Non-fatal parse complaint shown as a chip on the block. A typed block that
   *  fails to decode degrades to `markdown` carrying this; it is never dropped. */
  diagnostic?: string;
}

/** Discriminated on `kind`, so `data` narrows without a cast. */
export type ReviewBlock =
  | (ReviewBlockMeta & { kind: 'markdown' })
  | (ReviewBlockMeta & { kind: 'walkthrough'; data: ReviewWalkthroughBlock })
  | (ReviewBlockMeta & { kind: 'diff'; data: ReviewDiffBlock })
  | (ReviewBlockMeta & { kind: 'finding'; data: ReviewFindingBlock })
  | (ReviewBlockMeta & { kind: 'decision'; data: ReviewDecisionBlock })
  | (ReviewBlockMeta & { kind: 'chart'; data: ReviewChartBlock })
  | (ReviewBlockMeta & { kind: 'metrics'; data: ReviewMetricsBlock })
  | (ReviewBlockMeta & { kind: 'svg'; data: ReviewSvgBlock });

/** A parsed review document: its blocks plus the frontmatter stamp `review.md`
 *  carries so a bundle is self-describing on disk. */
export interface ReviewDocument {
  title: string | null;
  laneName: string | null;
  subject: string | null;
  blocks: ReviewBlock[];
}

export interface ReviewComment {
  blockId: string;
  quote: string;
  body: string;
}

export type ReviewFindingState = 'accepted' | 'dismissed';

/** What the human sends back — and, verbatim, what `response.md`'s frontmatter
 *  holds. One shape serves both the wire and the file, so a reopened bundle
 *  restores exactly what was sent (or what was answered but not yet sent). */
export interface ReviewResponse {
  /** The bundle slug — the durable id, e.g. `2026-08-07-peering-guard-rewrite`. */
  reviewId: string;
  /** Free-text note typed in the send preview, optional. */
  note?: string;
  comments: ReviewComment[];
  findings: { blockId: string; state: ReviewFindingState }[];
  decisions: { blockId: string; chosen: number }[];
  /** Set when the response was last handed to the lane; absent while it is only
   *  autosaved. Lets a reopened Board distinguish "answered" from "delivered". */
  sentAt?: number;
}

/** One review response delivered to a lane through the drain-on-idle queue. */
export interface ReviewResponseEnvelope {
  kind: 'review_response';
  /** idempotency key — a retried send carrying a seen id is dropped. */
  batchId: string;
  /** Bundle slug, so the lane can re-read `review.md` / `response.md`. */
  reviewId: string;
  /** Absolute bundle directory, so the lane can edit the files it authored. */
  dir: string;
  title: string;
  response: ReviewResponse;
  /** Human-readable label per answered block id (a finding's title, a decision's
   *  question). Without these the lane would receive opaque ids like `b7-9f2a1c`
   *  and have to re-read `review.md` to know what was accepted. */
  blockLabels?: Record<string, string>;
  sentAt: number;
}

export type ReviewResponseSendResult = {
  /** 'accepted' = queued for the lane; 'no-live-lane' = the authoring lane is
   *  gone (the answers are still on disk); 'duplicate' = idempotent retry. */
  status: 'accepted' | 'no-live-lane' | 'duplicate';
};

/** One bundle discovered by walking `.krypton/reviews/` (no session registry). */
export interface ReviewBundle {
  /** Directory name — the durable id, e.g. `2026-08-07-peering-guard-rewrite`. */
  slug: string;
  /** Absolute path to the bundle directory. */
  dir: string;
  title: string;
  laneName: string;
  createdAt: number;
  /** Present once the human has answered anything. */
  respondedAt?: number;
  /** Present once the response was handed to a lane. */
  sentAt?: number;
  counts: {
    blocks: number;
    steps: number;
    findings: number;
    decisions: number;
    unanswered: number;
  };
}

/** `read_review_bundle` payload — the raw files, parsed in the frontend. */
export interface ReviewBundleFiles {
  slug: string;
  dir: string;
  /** `review.md` source; empty when the lane died before writing it. */
  review: string;
  /** `response.md` source, absent when the human has not answered yet. */
  response?: string;
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

// Shared git working-tree collector (spec 145). The structured Review Lane
// packet (spec 112) was removed; this minimal shape is shared by the
// `#review` command (diff + untracked subject) and attention triage
// (`diffstat` for a flagged decision's blast-radius).
export interface ReviewDiffstatEntry {
  path: string;
  status: 'M' | 'A' | 'D' | 'R' | '?';
  added: number;
  removed: number;
}

export interface ReviewUntrackedExcerpt {
  path: string;
  head: string;
}

export interface ReviewGitState {
  repoRoot: string;
  hasGitRepo: boolean;
  /** true when the repo has no commits yet → callers diff against the empty
   * tree / report "no committed baseline". */
  isUnbornHead: boolean;
  diffstat: ReviewDiffstatEntry[];
  /** `git diff HEAD` (or the empty tree when unborn), payload-capped + UTF-8-safe. */
  diff: string;
  /** bounded head excerpts of untracked files so new files are visible. */
  untracked: ReviewUntrackedExcerpt[];
}

// Live, deterministic Git decoration for assistant file references (spec 207).
// Rust derives these values from the working tree; ACP/LLM payloads never set
// them directly.
export type ReferenceGitStatus = 'M' | 'A' | 'D' | 'R' | '?' | '!';
export type ReferenceGitCountKind = 'lines' | 'binary' | 'unavailable';

export interface MessageResourceGitState {
  status: ReferenceGitStatus;
  added: number | null;
  removed: number | null;
  countKind: ReferenceGitCountKind;
}

export interface ReferenceGitChange extends MessageResourceGitState {
  target: string;
}

export interface ReferenceGitSnapshot {
  repoRoot: string;
  changes: ReferenceGitChange[];
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
  packetId: string | null; // synthetic blast-radius id for the diffstat, null if no repo changes
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

// Review Quality Matrix (spec 146) — a summary-only history of #review rounds.
// The authoring lane self-reports the totals at synthesis time; the matrix keeps
// no fine-grained detail (no stored diff size, no transcript anchor) — see
// docs/146-review-quality-matrix.md and docs/adr/0004. Observation, not a score.
export interface ReviewFinding {
  /** Repo-relative path. */
  file: string;
  /** Optional 1-based line anchor. */
  line?: number;
  severity: 'blocking' | 'non-blocking' | 'suggestion';
  /** One-line concern. */
  note: string;
}

export interface ReviewOutcome {
  /** The lane credited with the work under review (the convening lane). */
  authoringLaneId: string;
  /** Display name snapshot of the authoring lane, so the overlay can still label
   * the row after that lane has closed (history is kept until view dispose). */
  authoringLaneName: string;
  /** Short human label: diff summary or doc path (self-reported). */
  subjectLabel: string;
  /** How many reviewers the round fanned out to (self-reported). */
  reviewerCount: number;
  /** Total blockers reported across reviewers (self-reported). */
  blockers: number;
  /** Total warnings reported across reviewers (self-reported). */
  warnings: number;
  /** Optional per-finding detail captured at synthesis time. */
  findings?: ReviewFinding[];
  /** ms timestamp, stamped by the store on record(). */
  at: number;
}

export type LaneBusEvent =
  | { type: 'lane:status'; payload: LaneStatusEvent }
  | { type: 'lane:spawned'; payload: { laneId: string } }
  | { type: 'lane:closed'; payload: { laneId: string; displayName: string } }
  | { type: 'triage:changed'; payload: { openCount: number } }
  | { type: 'review:quality'; payload: { totalReviews: number } }
  | { type: 'review:priority'; payload: { highCount: number } };

export type AcpEvent =
  | { type: 'user_message_chunk'; text: string }
  | { type: 'message_chunk'; text: string; content: ContentBlock; messageId?: string }
  | { type: 'thought_chunk'; text: string }
  | { type: 'tool_call'; call: ToolCall }
  | { type: 'tool_call_update'; update: ToolCallUpdate }
  | { type: 'plan'; entries: PlanEntry[] }
  | { type: 'permission_request'; requestId: number; toolCall: ToolCall; options: PermissionOption[] }
  | { type: 'ask_user_question'; requestId: number; questions: unknown; toolCallId?: string }
  | { type: 'usage'; usage: UsageInfo }
  | { type: 'available_commands'; commands: AcpAvailableCommand[] }
  | { type: 'mode_update'; modeId: string }
  | { type: 'fs_activity'; method: 'read' | 'write'; path: string; ok: boolean; error?: string }
  | { type: 'fs_write_pending'; requestId: number; path: string; oldText: string; newText: string }
  | { type: 'provider_error'; payload: ProviderErrorPayload }
  | { type: 'stop'; stopReason: StopReason; reason?: string }
  | { type: 'error'; message: string };
