// Krypton — ACP Harness View: transcript item state helpers.
//
// Spec 301 phase 3 moved every per-kind body builder, the 18-branch dispatcher
// (`renderTranscriptItem`), the image strip and the 131-line
// `transcriptRenderSignature` into the row components under
// `src/acp/components/`. What remains here is the state each row component
// reads but does not own: coordinator provenance stamped on an assistant item,
// the one-shot resource scan of a sealed body, and the provenance line both the
// assistant row and the view print.

import { extractResourcesFromBody, mergeMessageResources } from './message-resources';
import type {
  HarnessLane,
  HarnessTranscriptItem,
  LaneMailProvenance,
} from './harness-view-types';

export function applyCoordinatorProvenanceToItem(lane: HarnessLane, item: HarnessTranscriptItem): void {
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

export function scanMessageResourceBody(
  body: ParentNode,
  item: HarnessTranscriptItem,
  projectDir: string | null,
): void {
  if (item.resourcesScanned) return;
  const merged = mergeMessageResources(
    item.resources ?? [],
    extractResourcesFromBody(body, projectDir),
    item.resourceOverflow ?? 0,
  );
  item.resources = merged.resources;
  item.resourceOverflow = merged.overflow;
  item.resourcesScanned = true;
}

export function formatLaneMailProvenanceLine(provenance: LaneMailProvenance): string {
  const peer = provenance.peerDisplayName.toLowerCase();
  if (provenance.envelopeCount > 1) {
    return `↩ replying to lane mail (${provenance.envelopeCount} messages) from ${peer}`;
  }
  return `↩ replying to lane mail from ${peer}`;
}
