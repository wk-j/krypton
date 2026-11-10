// Spec 381 — the harness component gallery's example model. Every preview is
// canonical lane data (spec 380); the stage turns it into rows with the same
// builders `AcpHarnessView` uses.

import type { LaneEvent, ToolImageUpdate, ToolView } from '../../../../acp/adapters/types';
import type { QuestionPayload } from '../../../../acp/ask-user-question';
import type { HarnessTranscriptItem, PermissionPayload } from '../../../../acp/harness-view-types';
import type { ContentBlock } from '../../../../acp/types';

/** Phase 1 groups; `session` (lane head, stats, plan) lands with spec 381 phase 2. */
export type GalleryGroup = 'messages' | 'tools' | 'requests' | 'files' | 'turn';

/**
 * A plain-data row: assistant, thought, user, fs activity, fs write review,
 * provider error, usage and system notices. The stage assigns the id. Image
 * blocks become the row's strip through the production image decoder.
 */
export type GalleryItem = Omit<HarnessTranscriptItem, 'id' | 'images'> & {
  readonly imageBlocks?: readonly ContentBlock[];
};

export type PermissionEvent = Extract<LaneEvent, { type: 'permission_request' }>;
export type QuestionEvent = Extract<LaneEvent, { type: 'ask_user_question' | 'elicitation_request' }>;

/** Canonical data for one preview. Tool, permission and question rows always go through the production builders. */
export type GalleryInput =
  | { readonly kind: 'item'; readonly item: GalleryItem }
  | {
    readonly kind: 'tool';
    readonly view: ToolView;
    /** Run time so far (running) or in total (settled); null paints no time. */
    readonly elapsedMs: number | null;
    /** What the tool events added to the row's image strip. */
    readonly images?: ToolImageUpdate;
  }
  | {
    readonly kind: 'permission';
    readonly event: PermissionEvent;
    /** The human's answer, as the view records it on the row. */
    readonly resolved?: { readonly decision: PermissionPayload['decision']; readonly label: string };
  }
  | {
    readonly kind: 'question';
    readonly event: QuestionEvent;
    readonly resolved?: { readonly decision: QuestionPayload['decision']; readonly label: string };
  };

export interface GalleryState {
  /** "exit 1", "no exit reported", "run of three". */
  readonly label: string;
  /** More than one renders as consecutive rows (a spec 379 run). */
  readonly inputs: readonly GalleryInput[];
  /** Paints the live legend; default sealed. */
  readonly streaming?: boolean;
}

export interface GalleryEntry {
  /** Hash fragment: `#tool-execute`. */
  readonly id: string;
  /** "Command". */
  readonly title: string;
  readonly group: GalleryGroup;
  /** One line under the title. */
  readonly summary: string;
  /** Registry ids the entry exercises: `['tool-row', 'diff-block']`. */
  readonly components: readonly string[];
  readonly states: readonly GalleryState[];
  /** Spec 380 fixture scenario for the Backends view (phase 3); null until then. */
  readonly scenario: string | null;
}
