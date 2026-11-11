// Spec 381 — canonical gallery input → transcript items, through the builders
// `AcpHarnessView` calls. Nothing here decides how a row looks: the tool,
// permission and question payloads come from the same pure functions the lane
// uses, and the row components paint them.

import { isTerminalState } from '../../../acp/adapters/tool';
import { createAskUserCardState, payloadFromCard } from '../../../acp/ask-user-question';
import { parseElicitationForm } from '../../../acp/elicitation';
import { createBytesImage, imageBytesSource } from '../../../acp/harness-images';
import {
  permissionItemText,
  permissionPayloadFromRequest,
  toolItemText,
  toolPayloadFromView,
} from '../../../acp/harness-transcript-items';
import type { HarnessImage, HarnessTranscriptItem } from '../../../acp/harness-view-types';
import type { ContentBlock } from '../../../acp/types';
import type { GalleryInput, GalleryState } from './examples/types';

/**
 * The view decodes image bytes into a Blob URL; this page's CSP allows only
 * `data:` images, so a decoded image is pointed at its own bytes instead.
 * Decoding, sniffing, size limits and labels stay the production ones.
 */
function stripImages(
  itemId: string,
  source: HarnessImage['source'],
  blocks: readonly ContentBlock[],
): HarnessImage[] {
  const images: HarnessImage[] = [];
  for (const block of blocks) {
    const src = imageBytesSource(block);
    if (src === null) continue;
    const image = createBytesImage(itemId, source, src, images.length, src.uri ?? null);
    if (image.objectUrl !== null) {
      URL.revokeObjectURL(image.objectUrl);
      image.objectUrl = `data:${image.mimeType};base64,${src.data}`;
    }
    images.push(image);
  }
  return images;
}

function itemImageSource(kind: HarnessTranscriptItem['kind']): HarnessImage['source'] {
  return kind === 'user' ? 'user' : kind === 'tool' ? 'tool' : 'agent';
}

/**
 * One input's row. `now` is the `performance.now()` the tool timing is drawn
 * against, so a running row's start sits `elapsedMs` before the mount.
 */
export function buildItem(input: GalleryInput, id: string, now: number): HarnessTranscriptItem {
  switch (input.kind) {
    case 'item': {
      // A copy: rows cache rendered markdown and image state on the item.
      const { imageBlocks, ...data } = structuredClone(input.item);
      const item: HarnessTranscriptItem = { id, ...data };
      if (imageBlocks !== undefined) item.images = stripImages(id, itemImageSource(item.kind), imageBlocks);
      return item;
    }
    case 'tool': {
      const { view, elapsedMs } = input;
      const startedAt = elapsedMs === null ? undefined : now - elapsedMs;
      const endedAt = elapsedMs !== null && isTerminalState(view.status) ? now : undefined;
      const tool = toolPayloadFromView(view, { startedAt, endedAt }, undefined);
      const item: HarnessTranscriptItem = {
        id,
        kind: 'tool',
        text: toolItemText(tool),
        status: view.status,
        tool,
        toolStartedAt: startedAt,
        toolEndedAt: endedAt,
      };
      // As `renderTool`: a code cell gets its inspector target.
      if (tool.execution) item.executionTarget = { executionItemId: id, hintLabel: null };
      if (tool.remoteCommand) item.remoteCommandTarget = { remoteCommandItemId: id, hintLabel: null };
      if (input.images !== undefined) item.images = stripImages(id, 'tool', input.images.blocks);
      return item;
    }
    case 'permission': {
      const payload = permissionPayloadFromRequest(input.event, { hideArgs: false });
      if (input.resolved !== undefined) {
        payload.decision = input.resolved.decision;
        payload.decisionLabel = input.resolved.label;
      }
      return { id, kind: 'permission', text: permissionItemText(payload), permission: payload };
    }
    case 'question': {
      const { event, resolved } = input;
      let questions;
      let wire: 'grok' | 'elicitation';
      if (event.type === 'ask_user_question') {
        questions = event.questions;
        wire = 'grok';
      } else {
        const form = parseElicitationForm(event.message, event.requestedSchema);
        if (form === null) throw new Error(`Unsupported elicitation form in a gallery example: ${event.message}`);
        questions = form.questions;
        wire = 'elicitation';
      }
      const payload = payloadFromCard(
        event.requestId,
        questions,
        createAskUserCardState(questions),
        wire,
        resolved?.decision ?? 'pending',
        resolved?.label,
      );
      return { id, kind: 'question', text: questions[0]?.question || 'question', question: payload };
    }
  }
}

/** A state's rows, in order. Ids are stable per entry, state and position. */
export function buildState(entryId: string, stateIndex: number, state: GalleryState, now: number): HarnessTranscriptItem[] {
  return state.inputs.map((input, index) => buildItem(input, `${entryId}-${stateIndex}-${index}`, now));
}
