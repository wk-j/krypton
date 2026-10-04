// Krypton — ACP Harness View: controller host contracts.
//
// Spec 275. Feature controllers extracted from `AcpHarnessView` never see the
// view itself — each receives a narrow host built from closures over the view,
// so the view's private state stays private and every dependency a controller
// has on the view is named here.

import type { CoordinatorDrainContext } from './inter-lane';
import type { JournalKind } from './journal';
import type { GithubTicketReference } from './harness-view-types';
import type { HarnessLane, HarnessTranscriptItem } from './harness-view-types';

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
  renderComposer(): void;
  setDraft(lane: HarnessLane, text: string, cursor: number): void;
}

/** Specs 253–267 timeline controller host. */
export interface HarnessTimelineHost extends HarnessViewHost {
  readonly harnessMemoryId: string | null;
  readonly remoteRuntimeId: string | null;
  render(): void;
  appendTranscript(lane: HarnessLane, kind: HarnessTranscriptItem['kind'], text: string): void;
  enqueueSystemPrompt(
    lane: HarnessLane,
    text: string,
    drain?: CoordinatorDrainContext,
    label?: string,
  ): Promise<boolean>;
  syncOrchestratorConsoleVisibility(): void;
}

export type GithubIssueRef = { repo: string; number: number; url: string };

/** Specs 194/238/239 shared working ticket controller host. */
export interface HarnessTicketHost extends HarnessViewHost {
  readonly harnessMemoryId: string | null;
  readonly projectDir: string | null;
  readonly panelsHidden: boolean;
  readonly openMarkdownViewCb: ((path: string) => Promise<void>) | null;
  readonly openFileReferenceCb: ((path: string, line?: number, column?: number) => Promise<boolean>) | null;
  render(): void;
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
