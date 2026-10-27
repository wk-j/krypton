// Spec 301 phase 3 — the row dispatcher.
//
// Replaces `renderTranscriptItem`'s 18-branch `if/else if` chain. The branch
// ORDER is load-bearing and reproduced exactly: a `system` item that carries
// both an inter-lane prefix and a `diff` renders as an event today, because the
// event branch ran first (`harness-transcript-render.ts:379` before `:395`).

import { AssistantRow } from '../assistant-row';
import { DirectiveDiffRow } from '../directive-diff-row';
import { DocCardRow } from '../doc-card-row';
import { FsActivityRow } from '../fs-activity-row';
import { FsWriteReviewRow } from '../fs-write-review-row';
import { InterLaneRow } from '../inter-lane-row';
import { PermissionRow } from '../permission-row';
import { ProviderErrorRow } from '../provider-error-row';
import { QuestionRow } from '../question-row';
import { SystemRow, systemRowVariant } from '../system-row';
import { ThoughtRow } from '../thought-row';
import { ToolRow } from '../tool-row';
import { UsageRow } from '../usage-row';
import { UserRow } from '../user-row';
import type { TranscriptRow, RowProps } from '../transcript-row';
import type { HarnessTranscriptItem } from '../../harness-view-types';

type RowKind =
  | 'assistant'
  | 'tool'
  | 'permission'
  | 'question'
  | 'fsActivity'
  | 'fsWriteReview'
  | 'providerError'
  | 'interLane'
  | 'usage'
  | 'event'
  | 'docCard'
  | 'directiveDiff'
  | 'thought'
  | 'user'
  | 'text';

/** The branch `renderTranscriptItem` would have taken, in its original order. */
export function rowKindFor(item: HarnessTranscriptItem): RowKind {
  if (item.kind === 'assistant') return 'assistant';
  if (item.kind === 'tool' && item.tool) return 'tool';
  if (item.kind === 'permission' && item.permission) return 'permission';
  if (item.kind === 'question' && item.question) return 'question';
  if (item.kind === 'fs_activity' && item.fsActivity) return 'fsActivity';
  if (item.kind === 'fs_write_review' && item.fsReview) return 'fsWriteReview';
  if (item.kind === 'provider_error' && item.providerError) return 'providerError';
  if (item.kind === 'inter_lane' && item.interLane) return 'interLane';
  if (item.kind === 'system' && item.usage) return 'usage';
  if (item.kind === 'system' && systemRowVariant(item) === 'event') return 'event';
  if (item.kind === 'artifact' && item.artifact) return 'docCard';
  if (item.kind === 'review' && item.review) return 'docCard';
  if (item.kind === 'system' && item.diff) return 'directiveDiff';
  if (item.kind === 'thought') return 'thought';
  if (item.kind === 'user') return 'user';
  return 'text';
}

export function createTranscriptRow(props: RowProps): TranscriptRow {
  switch (rowKindFor(props.item)) {
    case 'assistant':
      return new AssistantRow(props);
    case 'tool':
      return new ToolRow(props);
    case 'permission':
      return new PermissionRow(props);
    case 'question':
      return new QuestionRow(props);
    case 'fsActivity':
      return new FsActivityRow(props);
    case 'fsWriteReview':
      return new FsWriteReviewRow(props);
    case 'providerError':
      return new ProviderErrorRow(props);
    case 'interLane':
      return new InterLaneRow(props);
    case 'usage':
      return new UsageRow(props);
    case 'docCard':
      return new DocCardRow(props);
    case 'directiveDiff':
      return new DirectiveDiffRow(props);
    case 'thought':
      return new ThoughtRow(props);
    case 'user':
      return new UserRow(props);
    case 'event':
    case 'text':
      return new SystemRow(props);
  }
}
