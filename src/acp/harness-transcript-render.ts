// Krypton — ACP Harness View: transcript row rendering.
//
// Extracted verbatim from acp-harness-view.ts (spec 204). Paints one
// HarnessTranscriptItem into a DOM row — the dispatcher (renderTranscriptItem),
// its per-kind bodies (lane mail, fs activity, provider error, fs write review,
// permission), and the render signature that lets the view skip untouched rows.

import * as smd from 'streaming-markdown';

import { renderDiffPreview } from './diff-render';
import type { ProviderErrorPayload } from './types';
import type { InterLaneRowChannel } from './inter-lane';
import type {
  FsActivityPayload,
  FsWriteReviewPayload,
  HarnessLane,
  HarnessTranscriptItem,
  InterLanePayload,
  LaneMailProvenance,
  MessageResource,
  PermissionPayload,
} from './harness-view-types';
import { optionHotkey, type QuestionPayload } from './ask-user-question';
import { backendLogoId } from './harness-lane-identity';
import { transcriptLabel } from './harness-lane-chrome';
import { collapseThoughtBlankLines } from './harness-format';
import {
  isTerminalToolStatus,
  renderArtifactCardBody,
  renderReviewCardBody,
  renderToolBody,
} from './harness-tool-render';
import {
  initLaneStreamingMarkdown,
  installThoughtVeil,
  md,
  resolveLocalImageSrcs,
} from './harness-markdown';
import {
  extractResourcesFromBody,
  mergeMessageResources,
  resourceDisplayTarget,
} from './message-resources';
import { annotationSignature, applyTranscriptAnnotations } from './transcript-annotation';

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

// Thought effort meter (length-derived). The full thought remains visible; the
// glyph meter is a quick depth cue. Length ≈ effort — log-scaled between a floor
// (~one short line) and a ceiling (~a long deliberation), bucketed to 5.
const THOUGHT_EFFORT_MIN_CHARS = 40;
const THOUGHT_EFFORT_MAX_CHARS = 4000;

export function thoughtEffortLevel(len: number): { filled: number; tier: string } {
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

export function buildThoughtEffortMeter(len: number): HTMLElement {
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

/** Patch the thought-label meter without remounting the row. */
export function syncThoughtEffortMeter(label: HTMLElement, textLen: number): void {
  label.querySelector('.acp-harness__thought-effort')?.remove();
  if (textLen > 0) label.appendChild(buildThoughtEffortMeter(textLen));
}

const PRETEXT_LINE_CLASS = 'acp-harness__pretext-line';

/** True when the row already paints `lines` — skip the textContent wipe. */
export function pretextRowMatchesLines(
  row: { children: ArrayLike<{ className: string; textContent: string | null }> },
  lines: string[],
): boolean {
  if (row.children.length !== lines.length) return false;
  for (let i = 0; i < lines.length; i++) {
    const child = row.children[i];
    if (child.className !== PRETEXT_LINE_CLASS) return false;
    if (child.textContent !== lines[i]) return false;
  }
  return true;
}

export function paintPretextLines(row: HTMLElement, lines: string[]): void {
  if (pretextRowMatchesLines(row, lines)) return;
  row.textContent = '';
  for (const text of lines) {
    const lineEl = document.createElement('div');
    lineEl.className = PRETEXT_LINE_CLASS;
    lineEl.textContent = text;
    row.appendChild(lineEl);
  }
}

export function renderTranscriptItem(
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
    body.dataset.annotatable = '1';
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
    if (!streaming) {
      applyTranscriptAnnotations(body, item);
      scanMessageResourceBody(body, item, projectDir);
      appendMessageResourceRail(body, item, projectDir);
    }
  } else if (item.kind === 'tool' && item.tool) {
    body.classList.add('acp-harness__tool');
    renderToolBody(body, item.tool);
  } else if (item.kind === 'permission' && item.permission) {
    body.classList.add('acp-harness__perm');
    renderPermissionBody(body, item.permission);
  } else if (item.kind === 'question' && item.question) {
    body.classList.add('acp-harness__question');
    renderQuestionBody(body, item.question);
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
  } else if (item.kind === 'review' && item.review) {
    label.textContent = 'review';
    el.classList.add('acp-harness__msg--artifact');
    if (item.review.hintLabel) el.classList.add('acp-harness__msg--artifact-hinted');
    renderReviewCardBody(body, item.review);
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
        const text = item.kind === 'thought' ? collapseThoughtBlankLines(item.text) : item.text;
        body.appendChild(document.createTextNode(text));
        item.streamPlainLength = item.text.length;
      }
    } else {
      const text = item.kind === 'thought' ? collapseThoughtBlankLines(item.text) : item.text;
      body.dataset.pretext = 'true';
      body.dataset.rawText = text;
      body.dataset.rowId = item.id;
      body.textContent = text;
    }
  } else {
    body.textContent = item.text;
  }
  el.appendChild(label);
  el.appendChild(body);
  // Rendering may populate provenance or sealed resource state, so capture the
  // post-render signature rather than the pre-render snapshot assigned above.
  el.dataset.renderSignature = transcriptRenderSignature(item, streaming);
  return el;
}

/** Pending and in_progress share one reserved spinner cell. Collapsing them
 *  in the signature skips a full row replace on the in-flight tick, which is
 *  what made the empty `·` glyph jump the transcript. */
function toolStatusSignature(status: string): string {
  if (!status) return '';
  return isTerminalToolStatus(status) ? status : 'active';
}

export function transcriptRenderSignature(item: HarnessTranscriptItem, streaming: boolean): string {
  // Spec 114 rev 8: while a tool is in flight its section TEXT stays out of
  // the signature (labels/count stay in). Streaming output otherwise changed
  // the signature on every chunk, and the replaceChildren rebuild remounted
  // the whole row — spinner snapped to frame 0, head and diff previews
  // flashed. The body-only pass patches the output block in place instead
  // (patchStreamingToolBody); the terminal transition re-includes the text
  // for one final full rebuild.
  const toolInFlight = item.tool ? !isTerminalToolStatus(item.tool.status) : false;
  const tool = item.tool
    ? [
      toolStatusSignature(item.tool.status),
      item.tool.kind,
      item.tool.subject,
      item.tool.command,
      item.tool.result,
      item.tool.exitCode == null ? '' : String(item.tool.exitCode),
      toolInFlight
        ? item.tool.sections.map((section) => section.label).join('\u001f')
        : item.tool.sections.map((section) => `${section.label}:${section.text}`).join('\u001f'),
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
  const question = item.question
    ? [
      item.question.requestId,
      item.question.questionIndex,
      item.question.optionIndex,
      item.question.otherFocused ? '1' : '0',
      item.question.otherDraft,
      item.question.decision,
      item.question.decisionLabel ?? '',
      item.question.selected.map((row) => row.join(',')).join('|'),
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
  const resources = (item.resources ?? [])
    .map((resource) => [
      resource.key,
      resource.label,
      resource.source,
      resource.mimeType ?? '',
      resource.size ?? '',
      resource.description ?? '',
      resource.hintLabel ?? '',
      resource.git?.status ?? '',
      resource.git?.added ?? '',
      resource.git?.removed ?? '',
      resource.git?.countKind ?? '',
    ].join('\u001e'))
    .join('\u001f');
  return [
    item.kind,
    item.kind === 'tool' ? toolStatusSignature(item.status ?? '') : (item.status ?? ''),
    item.text,
    item.imageCount ?? '',
    streaming ? '1' : '0',
    tool,
    permission,
    question,
    fsActivity,
    fsReview,
    providerError,
    interLane,
    provenance,
    artifact,
    resources,
    item.resourceOverflow ?? 0,
    annotationSignature(item),
  ].join('\u001d');
}

/** Render one flat, keyboard-hintable rail beneath sealed assistant Markdown. */
export function appendMessageResourceRail(
  body: HTMLElement,
  item: HarnessTranscriptItem,
  projectDir: string | null,
): void {
  const resources = item.resources ?? [];
  if (resources.length === 0) return;
  body.querySelector(':scope > .acp-harness__resources')?.remove();

  const rail = document.createElement('section');
  rail.className = 'acp-harness__resources';
  rail.setAttribute('aria-label', 'Message references');
  const head = document.createElement('div');
  head.className = 'acp-harness__resources-head';
  const title = document.createElement('span');
  title.textContent = 'REFERENCES';
  const count = document.createElement('span');
  count.className = 'acp-harness__resource-count';
  const overflow = item.resourceOverflow ?? 0;
  count.textContent = overflow > 0 ? `${resources.length} · +${overflow} hidden` : String(resources.length);
  head.append(title, count);
  rail.appendChild(head);

  for (const resource of resources) rail.appendChild(renderMessageResource(resource, projectDir));
  body.appendChild(rail);
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

function renderMessageResource(resource: MessageResource, projectDir: string | null): HTMLButtonElement {
  const row = document.createElement('button');
  row.type = 'button';
  row.className = `acp-harness__resource acp-harness__resource--${resource.kind}`;
  if (resource.hintLabel) row.classList.add('acp-harness__resource--hinted');
  row.dataset.responseResource = resource.key;
  const displayTarget = resourceDisplayTarget(resource, projectDir);
  const gitSummary = resource.git ? referenceGitAccessibleSummary(resource.git) : null;
  row.title = gitSummary ? `${displayTarget} · ${gitSummary}` : displayTarget;
  row.setAttribute(
    'aria-label',
    `${resource.kind === 'file' ? 'Open file' : 'Open URL'} ${displayTarget}${gitSummary ? `. ${gitSummary}` : ''}`,
  );

  const hint = document.createElement('span');
  hint.className = 'acp-harness__resource-hint';
  hint.textContent = resource.hintLabel ?? '';
  hint.hidden = !resource.hintLabel;
  const kind = document.createElement('span');
  kind.className = 'acp-harness__resource-kind';
  kind.textContent = resource.kind === 'file' ? 'FILE' : 'URL';
  const content = document.createElement('span');
  content.className = 'acp-harness__resource-content';
  const label = document.createElement('span');
  label.className = 'acp-harness__resource-label';
  label.textContent = resource.label;
  const target = document.createElement('span');
  target.className = 'acp-harness__resource-target';
  target.textContent = displayTarget;
  content.append(label, target);
  const git = document.createElement('span');
  git.className = 'acp-harness__resource-git';
  if (resource.git) {
    const status = document.createElement('span');
    status.className = 'acp-harness__resource-git-status';
    status.dataset.status = resource.git.status;
    status.textContent = resource.git.status;
    const counts = document.createElement('span');
    counts.className = 'acp-harness__resource-git-counts';
    if (resource.git.countKind === 'lines') {
      const added = document.createElement('span');
      added.className = 'acp-harness__resource-git-add';
      added.textContent = `+${resource.git.added ?? 0}`;
      const removed = document.createElement('span');
      removed.className = 'acp-harness__resource-git-remove';
      removed.textContent = `−${resource.git.removed ?? 0}`;
      counts.append(added, removed);
    } else {
      counts.textContent = resource.git.countKind === 'binary' ? 'BIN' : 'N/A';
    }
    git.append(status, counts);
  } else {
    git.setAttribute('aria-hidden', 'true');
  }
  const action = document.createElement('span');
  action.className = 'acp-harness__resource-action';
  action.textContent = resource.kind === 'file' ? 'OPEN TAB ↗' : 'OPEN ↗';
  row.append(hint, kind, content, git, action);
  return row;
}

export function referenceGitAccessibleSummary(git: NonNullable<MessageResource['git']>): string {
  const status = {
    M: 'Modified',
    A: 'Added',
    D: 'Deleted',
    R: 'Renamed',
    '?': 'Untracked',
    '!': 'Conflicted',
  }[git.status];
  if (git.countKind === 'binary') return `${status}, binary file`;
  if (git.countKind === 'unavailable') return `${status}, line counts unavailable`;
  const added = git.added ?? 0;
  const removed = git.removed ?? 0;
  return `${status}, ${added} ${added === 1 ? 'line' : 'lines'} added, ${removed} ${removed === 1 ? 'line' : 'lines'} removed`;
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

export function renderLaneMailBody(
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

export function renderFsActivityBody(body: HTMLElement, payload: FsActivityPayload): void {
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

export function renderProviderErrorBody(body: HTMLElement, payload: ProviderErrorPayload): void {
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

export function providerErrorKicker(category: ProviderErrorPayload['category']): string {
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

export function renderFsWriteReviewBody(body: HTMLElement, payload: FsWriteReviewPayload): void {
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

export function renderQuestionBody(body: HTMLElement, payload: QuestionPayload): void {
  const pending = payload.decision === 'pending';
  body.dataset.decision = payload.decision;
  const head = document.createElement('div');
  head.className = 'acp-harness__question-row';
  if (!pending) {
    const glyph = document.createElement('span');
    glyph.className = `acp-harness__question-glyph acp-harness__question-glyph--${payload.decision}`;
    glyph.textContent = payload.decision === 'accepted' ? '✓' : '✗';
    head.appendChild(glyph);
    const decision = document.createElement('span');
    decision.className = 'acp-harness__question-decision';
    decision.textContent = payload.decisionLabel ?? payload.decision;
    head.appendChild(decision);
  }
  const subject = document.createElement('span');
  subject.className = 'acp-harness__question-subject';
  const current = payload.questions[payload.questionIndex];
  const title = pending
    ? (current?.question || payload.questions[0]?.question || 'question')
    : (payload.questions[0]?.question || 'question');
  subject.textContent = title;
  subject.title = title;
  head.appendChild(subject);
  if (pending && payload.questions.length > 1) {
    const pos = document.createElement('span');
    pos.className = 'acp-harness__question-pos';
    pos.textContent = `${payload.questionIndex + 1}/${payload.questions.length}`;
    head.appendChild(pos);
  }
  body.appendChild(head);
  if (!pending || !current) return;

  const list = document.createElement('div');
  list.className = 'acp-harness__question-options';
  current.options.forEach((option, index) => {
    const row = document.createElement('div');
    const selected = (payload.selected[payload.questionIndex] ?? []).includes(option.label);
    row.className = 'acp-harness__question-option'
      + (index === payload.optionIndex && !payload.otherFocused ? ' acp-harness__question-option--focus' : '')
      + (selected ? ' acp-harness__question-option--on' : '');
    const key = document.createElement('span');
    key.className = 'acp-harness__question-key';
    key.textContent = optionHotkey(index);
    const label = document.createElement('span');
    label.className = 'acp-harness__question-label';
    label.textContent = option.label;
    row.append(key, label);
    if (option.description) {
      const desc = document.createElement('span');
      desc.className = 'acp-harness__question-desc';
      desc.textContent = option.description;
      row.appendChild(desc);
    }
    list.appendChild(row);
  });
  const other = document.createElement('div');
  other.className = 'acp-harness__question-option'
    + (payload.otherFocused || payload.optionIndex >= current.options.length
      ? ' acp-harness__question-option--focus'
      : '');
  const otherKey = document.createElement('span');
  otherKey.className = 'acp-harness__question-key';
  otherKey.textContent = 'z';
  const otherLabel = document.createElement('span');
  otherLabel.className = 'acp-harness__question-label';
  otherLabel.textContent = payload.otherFocused
    ? (payload.otherDraft || '…')
    : 'Other';
  other.append(otherKey, otherLabel);
  list.appendChild(other);
  body.appendChild(list);

  const actions = document.createElement('div');
  actions.className = 'acp-harness__question-actions';
  actions.textContent = payload.otherFocused
    ? 'type · Enter submit · Esc back'
    : '1–9 pick · Enter · x skip · z other';
  body.appendChild(actions);
}

export function permissionDecisionGlyph(decision: string): string {
  return decision === 'rejected' || decision === 'failed' ? '✗' : '✓';
}

export function permissionDecisionLabel(perm: PermissionPayload): string {
  if (perm.decisionLabel) return perm.decisionLabel;
  switch (perm.decision) {
    case 'pending': return 'pending';
    case 'accepted': return 'accepted';
    case 'rejected': return 'rejected';
    case 'auto_allowed': return 'auto-allowed';
    case 'failed': return 'failed';
  }
}

export function renderImageAttachmentChip(count: number): HTMLElement {
  const chip = document.createElement('div');
  chip.className = 'acp-harness__msg-attachment';
  chip.title = `${count} image${count === 1 ? '' : 's'} attached`;
  chip.textContent = `▧ ${count} image${count === 1 ? '' : 's'}`;
  return chip;
}

export function usesPretext(kind: HarnessTranscriptItem['kind']): boolean {
  return kind !== 'assistant' && kind !== 'tool' && kind !== 'fs_activity' && kind !== 'fs_write_review' && kind !== 'provider_error' && kind !== 'question' && kind !== 'permission';
}
