// Krypton — ACP Harness View: controller host contracts.
//
// Spec 275. Feature controllers extracted from `AcpHarnessView` never see the
// view itself — each receives a narrow host built from closures over the view,
// so the view's private state stays private and every dependency a controller
// has on the view is named here.

import type { CoordinatorDrainContext, MentionFanOutResult, MentionFanOutTarget } from './inter-lane';
import type { JournalKind } from './journal';
import type { GithubTicketReference } from './harness-view-types';
import type { HarnessLane, HarnessTranscriptItem, StagedImage } from './harness-view-types';
import type { ReviewSubject } from './review';
import type { HarnessPanelId } from './harness-panel-visibility';
import type { ContentBlock, LaneBusEvent, ReviewFinding, StopReason } from './types';
import type { LiveDelivery } from './live-voice';

/**
 * Spec 301 — the repaint regions a controller may dirty.
 *
 * Before this, five of the six host interfaces exposed a bare `render(): void`,
 * so every controller's only vocabulary was "repaint everything". A region says
 * which surface moved; the scheduler coalesces regions into one frame and
 * commits them in a fixed order.
 */
export type HarnessRegion =
  | 'rail'
  | 'laneChrome'
  | 'transcript'
  | 'rightRail'
  | 'composer'
  | 'overlay';

export const HARNESS_REGION_ORDER: readonly HarnessRegion[] = [
  'rail',
  'laneChrome',
  'transcript',
  'rightRail',
  'composer',
  'overlay',
];

/** Capabilities every harness controller may rely on. */
export interface HarnessViewHost {
  readonly element: HTMLElement;
  readonly lanes: readonly HarnessLane[];
  readonly activeLaneId: string;
  flashChip(text: string): void;
}

/** Spec 246 dictation controller host. */
export interface HarnessDictationHost extends HarnessViewHost {
  readonly composerEl: HTMLElement;
  /** False while any overlay, picker or pending prompt owns the keyboard. */
  canStartDictation(lane: HarnessLane): boolean;
  invalidate(region: HarnessRegion): void;
  setDraft(lane: HarnessLane, text: string, cursor: number): void;
}

/** Spec 280 live voice controller host. */
export interface HarnessLiveVoiceHost extends HarnessViewHost {
  readonly composerEl: HTMLElement;
  invalidate(region: HarnessRegion): void;
  /** An idle lane starts the turn; a busy lane is steered (spec 278), else the
   *  prompt queues (spec 136; full queue → 'rejected'). The prompt carries
   *  `delegationId` so the turn that consumes it reports back. */
  deliverLivePrompt(lane: HarnessLane, text: string, delegationId: string): Promise<LiveDelivery>;
}

/** Specs 253–267 timeline controller host. */
export interface HarnessTimelineHost extends HarnessViewHost {
  readonly harnessMemoryId: string | null;
  readonly remoteRuntimeId: string | null;
  enqueueSystemPrompt(
    lane: HarnessLane,
    text: string,
    drain?: CoordinatorDrainContext,
    label?: string,
  ): Promise<boolean>;
}

/** A `#review` subject collected from the lane's worktree, or why it could not be. */
export type ReviewSubjectResult =
  | { subject: ReviewSubject; note?: string; docMtime?: number }
  | { error: string };

/** Spec 276 `#review pass` loop controller host. */
export interface HarnessReviewLoopHost extends HarnessViewHost {
  readonly projectDir: string | null;
  subscribeLaneBus(handler: (event: LaneBusEvent) => void): () => void;
  invalidate(region: HarnessRegion): void;
  appendTranscript(lane: HarnessLane, kind: HarnessTranscriptItem['kind'], text: string): void;
  reserveCommandTurn(lane: HarnessLane, label: string): void;
  releaseReservedTurn(lane: HarnessLane, next?: 'idle' | 'awaiting_peer'): void;
  enqueueSystemPrompt(
    lane: HarnessLane,
    text: string,
    drain?: CoordinatorDrainContext,
    label?: string,
  ): Promise<boolean>;
  resolveReviewers(lane: HarnessLane, nameTokens: string[]): { reviewers: HarnessLane[]; skipped: string[] };
  collectReviewSubject(lane: HarnessLane, tail: string): Promise<ReviewSubjectResult>;
  collectReviewIntent(lane: HarnessLane): string;
  fanOutReview(lane: HarnessLane, targets: MentionFanOutTarget[], body: string): MentionFanOutResult;
  /** Withdraw the loop's harness-consumed review requests; the lane's own peer waits stay. */
  cancelPeerConversations(lane: HarnessLane): void;
  /** spec 277: loop state changed — republish the lane-monitor telemetry. */
  loopChanged(): void;
  pendingPeerCount(lane: HarnessLane): number;
  recordReviewOutcome(
    lane: HarnessLane,
    outcome: {
      subjectLabel: string;
      reviewerCount: number;
      blockers: number;
      warnings: number;
      findings?: ReviewFinding[];
    },
  ): void;
}

export type GithubIssueRef = { repo: string; number: number; url: string };

/** Specs 194/238/239 shared working ticket controller host. */
export interface HarnessTicketHost extends HarnessViewHost {
  readonly harnessMemoryId: string | null;
  readonly projectDir: string | null;
  /** spec 320: `#panels` master switch or the panel's own flag. */
  isPanelHidden(panel: HarnessPanelId): boolean;
  readonly openMarkdownViewCb: ((path: string) => Promise<void>) | null;
  readonly openFileReferenceCb: ((path: string, line?: number, column?: number) => Promise<boolean>) | null;
  invalidate(region: HarnessRegion): void;
  activeLane(): HarnessLane | null;
  controlLane(params: Record<string, unknown>): HarnessLane;
  parseIssueRef(input: string): GithubIssueRef | null;
  githubReference(ref: GithubIssueRef, previous?: GithubTicketReference): GithubTicketReference;
  runWorkspaceCommand(program: string, args: string[], cwd?: string | null): Promise<string>;
  recordJournal(laneLabel: string, kind: JournalKind, summary: string, meta?: Record<string, unknown>): void;
  runGithubIssuePromptVerb(
    lane: HarnessLane,
    verb: 'analyze-github-issue' | 'fix-github-issue' | 'tag-github-issue' | 'post-github-comment' | 'handle-github-issue',
    args: string[],
  ): Promise<void>;
}

/** Spec 278 mid-turn steering controller host. */
export interface HarnessSteerHost extends HarnessViewHost {
  invalidate(region: HarnessRegion): void;
  sealStreaming(lane: HarnessLane): void;
  appendTranscript(
    lane: HarnessLane,
    kind: HarnessTranscriptItem['kind'],
    text: string,
    metadata?: Pick<HarnessTranscriptItem, 'steer' | 'voice'> & { stagedImages?: StagedImage[] },
  ): HarnessTranscriptItem;
  removeTranscriptItem(lane: HarnessLane, itemId: string): void;
  /** The user's own blocks (images, then text) — no lane-context packet. */
  steerBlocks(text: string, images: StagedImage[]): ContentBlock[];
  /** The turn-end path, once no steer work is outstanding. */
  finishTurn(lane: HarnessLane, stopReason: StopReason, reason?: string): void;
  drainPromptQueue(lane: HarnessLane): void;
}

/** Spec 306 assist sidecar host. The controller reads lane state and publishes
 *  a result by dirtying a region or, for spec 323 follow-ups, asking the view
 *  to patch one reply's rail; it never touches the DOM. */
export interface HarnessAssistHost extends HarnessViewHost {
  readonly projectDir: string | null;
  /** Non-null on a remote harness (spec 247): the sidecar's backend spawns there too. */
  readonly remoteRuntimeId: string | null;
  invalidate(region: HarnessRegion): void;
  setDraft(lane: HarnessLane, text: string, cursor: number): void;
  /** Spec 323: `itemId`'s `followUps` changed — repaint only that reply's rail. */
  patchFollowUps(lane: HarnessLane, itemId: string): void;
}
