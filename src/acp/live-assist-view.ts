import type { Parser as MarkdownParser } from 'streaming-markdown';

import { openExternalUrl } from '../external-url';

import {
  agentLinkOpenAction,
  beginLiveAssistMarkdown,
  liveAssistUsesMarkdown,
  renderLiveAssistMarkdown,
  sealLiveAssistMarkdown,
  writeLiveAssistMarkdown,
} from './live-assist-markdown';
import type {
  LiveAssistLaneSummary,
  LiveAssistPermission,
  LiveAssistSnapshot,
  LiveAssistTranscriptItem,
} from './live-assist-types';

const TRANSCRIPT_TAIL = 120;
const BUSY_STATUSES = new Set(['busy', 'needs_permission', 'awaiting_peer']);
const COMPACT_ACTIVITY_KINDS = new Set(['thought', 'tool', 'fs_activity', 'fs_write_review']);
/** How far back a snapshot is searched for text the incremental stream already
 *  rendered. Bounded so a full-tail snapshot never costs 120 substring scans. */
const STREAM_COVERAGE_SCAN = 8;

export type LiveAssistTranscriptBlock =
  | { kind: 'message'; item: LiveAssistTranscriptItem }
  | { kind: 'activity'; id: string; items: LiveAssistTranscriptItem[] };

/** What a snapshot should do with the row the incremental stream is writing to. */
export type LiveAssistStreamDisposition = 'adopt' | 'drop' | 'keep';

export interface LiveAssistViewHandlers {
  onSelectLane(lane: string): void;
  onSubmit(text: string): void;
  onCancel(): void;
  onResolvePermission(action: 'accept' | 'reject'): void;
  onHide(): void;
}

export function liveAssistPermissionFocusTarget(
  previousRequestId: number | null,
  nextRequestId: number | null,
  permissionHasFocus: boolean,
  composerHasFocus: boolean,
  draftIsEmpty: boolean,
): 'permission' | 'composer' | null {
  if (nextRequestId === null) return permissionHasFocus ? 'composer' : null;
  if (nextRequestId === previousRequestId) return null;
  if (permissionHasFocus || (composerHasFocus && draftIsEmpty)) return 'permission';
  return null;
}

export class LiveAssistView {
  private readonly abort = new AbortController();
  private readonly shell: HTMLElement;
  private readonly projectEl: HTMLElement;
  private readonly laneEl: HTMLElement;
  private readonly statusEl: HTMLElement;
  private readonly laneStrip: HTMLElement;
  private readonly transcriptEl: HTMLElement;
  private readonly permissionEl: HTMLElement;
  private readonly permissionToolEl: HTMLElement;
  private readonly permissionAcceptButton: HTMLButtonElement;
  private readonly composer: HTMLFormElement;
  private readonly textarea: HTMLTextAreaElement;
  private readonly sendButton: HTMLButtonElement;
  private readonly cancelButton: HTMLButtonElement;
  private readonly emptyEl: HTMLElement;
  private readonly noticeEl: HTMLElement;
  private noticeTimer: number | null = null;
  private selectedLane: string | null = null;
  private pendingPermission: LiveAssistPermission | null = null;
  private streamRow: HTMLElement | null = null;
  private streamTextNode: Text | null = null;
  private streamParser: MarkdownParser | null = null;
  private streamKind: string | null = null;
  private streamText = '';
  private pendingStream: Array<{ kind: string; text: string }> = [];
  private streamFrame: number | null = null;
  private currentStatus = 'idle';
  private renderedLane: string | null = null;
  private laneRoster: string[] = [];
  private projectDir: string | null = null;

  constructor(
    root: HTMLElement,
    private readonly handlers: LiveAssistViewHandlers,
  ) {
    root.className = 'live-assist-root';
    this.shell = document.createElement('section');
    this.shell.className = 'live-assist';
    this.shell.setAttribute('aria-label', 'Krypton Live Assist');

    const header = document.createElement('header');
    header.className = 'live-assist__header';
    header.dataset.tauriDragRegion = '';
    const brand = document.createElement('strong');
    brand.className = 'live-assist__brand';
    brand.textContent = 'LIVE ASSIST';
    this.projectEl = document.createElement('span');
    this.projectEl.className = 'live-assist__project';
    this.projectEl.textContent = 'waiting for Harness';
    this.laneEl = document.createElement('span');
    this.laneEl.className = 'live-assist__header-lane';
    this.laneEl.textContent = 'no lane';
    const headerSpacer = document.createElement('span');
    headerSpacer.className = 'live-assist__spacer';
    const topmost = document.createElement('span');
    topmost.className = 'live-assist__topmost';
    const topmostDot = document.createElement('span');
    topmostDot.className = 'live-assist__topmost-dot';
    topmost.append(topmostDot, document.createTextNode('topmost'));
    this.statusEl = document.createElement('span');
    this.statusEl.className = 'live-assist__status';
    this.statusEl.textContent = 'connecting';
    const hideButton = document.createElement('button');
    hideButton.className = 'live-assist__hide';
    hideButton.type = 'button';
    hideButton.textContent = '⌃⇧A HIDE';
    hideButton.setAttribute('aria-label', 'Hide Live Assist');
    header.append(brand, this.projectEl, this.laneEl, headerSpacer, topmost, this.statusEl, hideButton);

    this.laneStrip = document.createElement('nav');
    this.laneStrip.className = 'live-assist__lanes';
    this.laneStrip.setAttribute('aria-label', 'Harness lanes');

    this.transcriptEl = document.createElement('div');
    this.transcriptEl.className = 'live-assist__transcript';
    this.transcriptEl.setAttribute('role', 'log');
    this.transcriptEl.setAttribute('aria-live', 'polite');

    this.permissionEl = document.createElement('section');
    this.permissionEl.className = 'live-assist__permission';
    this.permissionEl.hidden = true;
    const permissionCopy = document.createElement('div');
    permissionCopy.className = 'live-assist__permission-copy';
    const permissionTitle = document.createElement('strong');
    permissionTitle.textContent = 'PERMISSION REQUIRED';
    this.permissionToolEl = document.createElement('span');
    permissionCopy.append(permissionTitle, this.permissionToolEl);
    const permissionActions = document.createElement('div');
    permissionActions.className = 'live-assist__permission-actions';
    const rejectButton = document.createElement('button');
    rejectButton.type = 'button';
    rejectButton.dataset.permissionAction = 'reject';
    rejectButton.textContent = 'R · Reject';
    this.permissionAcceptButton = document.createElement('button');
    this.permissionAcceptButton.type = 'button';
    this.permissionAcceptButton.dataset.permissionAction = 'accept';
    this.permissionAcceptButton.className = 'live-assist__permission-accept';
    this.permissionAcceptButton.textContent = 'A · Accept';
    permissionActions.append(rejectButton, this.permissionAcceptButton);
    this.permissionEl.append(permissionCopy, permissionActions);

    this.composer = document.createElement('form');
    this.composer.className = 'live-assist__composer';
    this.textarea = document.createElement('textarea');
    this.textarea.className = 'live-assist__input';
    this.textarea.rows = 2;
    this.textarea.placeholder = 'Message a Harness lane…';
    this.textarea.setAttribute('aria-label', 'Message Harness lane');
    const composerActions = document.createElement('div');
    composerActions.className = 'live-assist__composer-actions';
    this.cancelButton = document.createElement('button');
    this.cancelButton.type = 'button';
    this.cancelButton.className = 'live-assist__cancel';
    this.cancelButton.textContent = '⌘. CANCEL';
    this.cancelButton.hidden = true;
    this.sendButton = document.createElement('button');
    this.sendButton.type = 'submit';
    this.sendButton.className = 'live-assist__send';
    this.sendButton.textContent = 'SEND ⌘↵';
    composerActions.append(this.cancelButton, this.sendButton);
    this.composer.append(this.textarea, composerActions);

    this.emptyEl = document.createElement('section');
    this.emptyEl.className = 'live-assist__empty';
    this.emptyEl.hidden = true;
    const emptyMark = document.createElement('span');
    emptyMark.className = 'live-assist__empty-mark';
    emptyMark.textContent = '◇';
    const emptyTitle = document.createElement('h1');
    emptyTitle.textContent = 'NO LIVE HARNESS';
    const emptyCopy = document.createElement('p');
    emptyCopy.textContent = 'Open an ACP Harness in Krypton, then summon Live Assist again. This window will not create or focus one behind you.';
    this.emptyEl.append(emptyMark, emptyTitle, emptyCopy);

    this.noticeEl = document.createElement('div');
    this.noticeEl.className = 'live-assist__notice';
    this.noticeEl.hidden = true;
    this.noticeEl.setAttribute('role', 'status');

    this.shell.append(
      header,
      this.laneStrip,
      this.transcriptEl,
      this.permissionEl,
      this.composer,
      this.emptyEl,
      this.noticeEl,
    );
    root.replaceChildren(this.shell);

    const signal = this.abort.signal;
    hideButton.addEventListener('click', () => this.handlers.onHide(), { signal });
    this.cancelButton.addEventListener('click', () => this.handlers.onCancel(), { signal });
    this.composer.addEventListener('submit', (event) => {
      event.preventDefault();
      const text = this.textarea.value.trim();
      if (text) this.handlers.onSubmit(text);
    }, { signal });
    this.laneStrip.addEventListener('click', (event) => {
      const target = event.target instanceof Element
        ? event.target.closest<HTMLButtonElement>('[data-lane]')
        : null;
      if (target?.dataset.lane) this.handlers.onSelectLane(target.dataset.lane);
    }, { signal });
    this.permissionEl.addEventListener('click', (event) => {
      const target = event.target instanceof Element
        ? event.target.closest<HTMLButtonElement>('[data-permission-action]')
        : null;
      const action = target?.dataset.permissionAction;
      if (action === 'accept' || action === 'reject') this.handlers.onResolvePermission(action);
    }, { signal });
    this.transcriptEl.addEventListener('click', (event) => {
      const target = event.target;
      if (!(target instanceof Element)) return;
      const anchor = target.closest<HTMLAnchorElement>('a[href]');
      if (!anchor || !this.transcriptEl.contains(anchor)) return;
      event.preventDefault();
      const href = anchor.getAttribute('href') ?? '';
      if (agentLinkOpenAction(href) === 'external') {
        openExternalUrl(href, { external: true });
      }
    }, { signal });
  }

  dispose(): void {
    this.abort.abort();
    if (this.noticeTimer !== null) window.clearTimeout(this.noticeTimer);
    if (this.streamFrame !== null) window.cancelAnimationFrame(this.streamFrame);
    this.streamFrame = null;
    this.pendingStream = [];
    this.shell.remove();
  }

  // Every snapshot refresh calls this, so only a roster change rebuilds the
  // strip; status churn updates the existing buttons in place. Replacing the
  // buttons wholesale dropped hover/focus state and relaid out the strip on
  // each of a busy turn's status events.
  setLanes(lanes: LiveAssistLaneSummary[], selectedLane: string | null): void {
    this.selectedLane = selectedLane;
    const roster = lanes.map((lane) => lane.displayName);
    if (!sameLaneRoster(this.laneRoster, roster)) {
      const fragment = document.createDocumentFragment();
      for (const lane of lanes) fragment.appendChild(buildLaneButton(lane));
      this.laneStrip.replaceChildren(fragment);
      this.laneRoster = roster;
    }
    for (let index = 0; index < lanes.length; index += 1) {
      const button = this.laneStrip.children[index];
      if (button instanceof HTMLElement) syncLaneButton(button, lanes[index], index, selectedLane);
    }
    this.laneStrip.hidden = lanes.length < 2;
  }

  renderSnapshot(snapshot: LiveAssistSnapshot): void {
    this.showContent();
    const laneChanged = this.renderedLane !== snapshot.lane.displayName;
    this.selectedLane = snapshot.lane.displayName;
    this.projectDir = snapshot.lane.cwd;
    this.projectEl.textContent = projectLabel(snapshot.lane.cwd);
    this.laneEl.textContent = `${snapshot.lane.displayName} · ${snapshot.lane.backendId}`;
    this.statusEl.textContent = statusLabel(snapshot.status);
    this.statusEl.dataset.status = safeStatus(snapshot.status.status);
    this.currentStatus = snapshot.status.status;
    this.textarea.placeholder = `Message ${snapshot.lane.displayName}…`;
    this.textarea.setAttribute('aria-label', `Message ${snapshot.lane.displayName}`);
    this.sendButton.textContent = BUSY_STATUSES.has(snapshot.status.status) ? 'QUEUE ⌘↵' : 'SEND ⌘↵';
    this.cancelButton.hidden = !BUSY_STATUSES.has(snapshot.status.status);
    this.renderTranscript(snapshot.transcript, laneChanged);
    this.renderedLane = snapshot.lane.displayName;
    this.setPermission(snapshot.permissions[0] ?? null);
  }

  showEmpty(): void {
    this.selectedLane = null;
    this.renderedLane = null;
    this.projectDir = null;
    this.resetStream();
    this.projectEl.textContent = 'no Harness';
    this.laneEl.textContent = 'no lane';
    this.statusEl.textContent = 'offline';
    this.laneStrip.hidden = true;
    this.transcriptEl.hidden = true;
    this.permissionEl.hidden = true;
    this.composer.hidden = true;
    this.emptyEl.hidden = false;
  }

  showLoading(): void {
    this.statusEl.textContent = 'syncing';
  }

  showError(message: string): void {
    this.statusEl.textContent = 'bridge error';
    this.notice(message, true);
  }

  notice(message: string, error = false): void {
    if (this.noticeTimer !== null) window.clearTimeout(this.noticeTimer);
    this.noticeEl.textContent = message;
    this.noticeEl.classList.toggle('live-assist__notice--error', error);
    this.noticeEl.hidden = false;
    this.noticeTimer = window.setTimeout(() => {
      this.noticeEl.hidden = true;
      this.noticeTimer = null;
    }, 2600);
  }

  appendStream(kind: string, text: string): void {
    if (!text || this.transcriptEl.hidden) return;
    const tail = this.pendingStream[this.pendingStream.length - 1];
    if (tail?.kind === kind) tail.text += text;
    else this.pendingStream.push({ kind, text });
    if (this.streamFrame !== null) return;
    this.streamFrame = window.requestAnimationFrame(() => this.flushStream());
  }

  updateStatus(status: string): void {
    this.currentStatus = status;
    this.statusEl.textContent = status;
    this.statusEl.dataset.status = safeStatus(status);
    this.cancelButton.hidden = !BUSY_STATUSES.has(status);
    this.sendButton.textContent = BUSY_STATUSES.has(status) ? 'QUEUE ⌘↵' : 'SEND ⌘↵';
  }

  clearDraft(): void {
    this.textarea.value = '';
  }

  setSending(sending: boolean): void {
    this.sendButton.disabled = sending;
    this.sendButton.textContent = sending
      ? 'SENDING…'
      : BUSY_STATUSES.has(this.currentStatus) ? 'QUEUE ⌘↵' : 'SEND ⌘↵';
  }

  focusComposer(): void {
    this.textarea.focus({ preventScroll: true });
  }

  focusPrimaryControl(): void {
    if (this.pendingPermission) {
      this.permissionAcceptButton.focus({ preventScroll: true });
      return;
    }
    this.focusComposer();
  }

  draft(): string {
    return this.textarea.value.trim();
  }

  permissionHasFocus(): boolean {
    return !this.permissionEl.hidden && this.permissionEl.contains(document.activeElement);
  }

  currentPermission(): LiveAssistPermission | null {
    return this.pendingPermission;
  }

  currentLane(): string | null {
    return this.selectedLane;
  }

  private showContent(): void {
    this.emptyEl.hidden = true;
    this.transcriptEl.hidden = false;
    this.composer.hidden = false;
  }

  // A snapshot arrives on every status/stop/permission event, so this reconciles
  // the existing rows by key instead of replacing them. The old `replaceChildren`
  // tore down and relaid out the whole tail each time, which flickered, dropped
  // the text selection, and yanked the scroll position to the bottom.
  private renderTranscript(items: LiveAssistTranscriptItem[], laneChanged: boolean): void {
    if (laneChanged) {
      this.resetStream();
      this.transcriptEl.replaceChildren();
    }
    // Read scroll state before mutating: a refresh must not pull a reader who
    // scrolled up back down to the bottom.
    const stick = laneChanged || isNearBottom(this.transcriptEl);
    const blocks = groupLiveAssistTranscript(items.slice(-TRANSCRIPT_TAIL));
    const nodes = this.reconcile(this.transcriptEl, blocks);
    this.settleStream(blocks, nodes);
    if (stick) this.transcriptEl.scrollTop = this.transcriptEl.scrollHeight;
  }

  /** Align `container`'s children with `blocks`, reusing nodes whose key still
   *  matches and returning the node for each block in order. A *synthetic*
   *  streaming row is exempt — it has no key and stays after the last block. An
   *  adopted row does have a key and reconciles like any other. */
  private reconcile(
    container: HTMLElement,
    blocks: LiveAssistTranscriptBlock[],
  ): HTMLElement[] {
    const streamRow = this.streamRow?.isConnected && this.streamRow.dataset.blockKey === undefined
      ? this.streamRow
      : null;
    const reusable = new Map<string, HTMLElement>();
    const stale = new Set<HTMLElement>();
    for (const child of Array.from(container.children)) {
      if (!(child instanceof HTMLElement) || child === streamRow) continue;
      stale.add(child);
      const key = child.dataset.blockKey;
      if (key !== undefined) reusable.set(key, child);
    }

    const nodes: HTMLElement[] = [];
    let cursor: Element | null = container.firstElementChild;
    for (const block of blocks) {
      const key = liveAssistBlockKey(block);
      const reused = reusable.get(key);
      let node: HTMLElement;
      if (reused) {
        reusable.delete(key);
        stale.delete(reused);
        this.syncBlock(reused, block, block === blocks[blocks.length - 1]);
        node = reused;
      } else {
        node = this.buildBlock(block);
      }
      if (cursor === node) cursor = node.nextElementSibling;
      else container.insertBefore(node, cursor);
      nodes.push(node);
    }
    for (const orphan of stale) orphan.remove();
    return nodes;
  }

  private buildBlock(block: LiveAssistTranscriptBlock): HTMLElement {
    const node = block.kind === 'message'
      ? this.buildMessage(block.item, false).row
      : this.buildActivity(block);
    node.dataset.blockKey = liveAssistBlockKey(block);
    return node;
  }

  private syncBlock(
    node: HTMLElement,
    block: LiveAssistTranscriptBlock,
    isTail: boolean,
  ): void {
    if (block.kind === 'message') {
      this.syncMessage(node, block.item, isTail);
      return;
    }
    const summary = node.querySelector('.live-assist__activity-summary');
    const label = liveAssistActivitySummary(block.items.length);
    if (summary && summary.textContent !== label) summary.textContent = label;
    const items = node.querySelector<HTMLElement>('.live-assist__activity-items');
    if (items) {
      this.reconcile(items, block.items.map((item) => ({ kind: 'message', item }) as const));
    }
  }

  private syncMessage(
    node: HTMLElement,
    item: LiveAssistTranscriptItem,
    isTail: boolean,
  ): void {
    const next = item.text || fallbackText(displayKind(item.kind), item.status);
    if (node === this.streamRow) {
      // The stream row owns its DOM. Write only a forward delta while it is
      // still the tail; settleStream seals or drops it once the snapshot moves on.
      if (isTail && next.length > this.streamText.length) {
        this.writeStreamDelta(next.slice(this.streamText.length));
        this.streamText = next;
      }
      return;
    }
    if (liveAssistUsesMarkdown(item.kind) && item.text) {
      const body = messageBody(node);
      if (body) renderLiveAssistMarkdown(body, item.text, this.projectDir);
      return;
    }
    const textNode = messageTextNode(node);
    if (!textNode) return;
    if (textNode.data !== next) textNode.data = next;
  }

  /** Merge the incremental streaming row with the authoritative snapshot so the
   *  same text is never shown twice, and never disappears and reappears. */
  private settleStream(blocks: LiveAssistTranscriptBlock[], nodes: HTMLElement[]): void {
    if (!this.streamRow || !this.streamKind) return;
    const disposition = liveAssistStreamDisposition(
      blocks,
      this.streamKind,
      this.streamText,
      BUSY_STATUSES.has(this.currentStatus),
    );
    if (disposition === 'keep') return;
    if (disposition === 'drop') {
      const key = this.streamRow?.dataset.blockKey;
      const block = key
        ? blocks.find((candidate) => liveAssistBlockKey(candidate) === key)
        : null;
      const snapshotText = block?.kind === 'message' ? block.item.text : '';
      this.endStream(snapshotText);
      return;
    }
    this.adoptStreamRow(nodes[nodes.length - 1]);
  }

  /** Hand streaming over to the snapshot's own trailing row. */
  private adoptStreamRow(node: HTMLElement | undefined): void {
    if (!node || !this.streamRow) return;
    if (this.streamRow === node) {
      ensureStreamCaret(node);
      return;
    }
    const fromSynthetic = this.streamRow.dataset.blockKey === undefined;
    const merged = liveAssistAdoptedText(fromSynthetic, this.streamText, messageSource(node));
    if (fromSynthetic) {
      if (merged.length > this.streamText.length) {
        this.writeStreamDelta(merged.slice(this.streamText.length));
      }
      this.streamText = merged;
      if (node.dataset.blockKey) this.streamRow.dataset.blockKey = node.dataset.blockKey;
      if (node.dataset.messageId) this.streamRow.dataset.messageId = node.dataset.messageId;
      node.replaceWith(this.streamRow);
      ensureStreamCaret(this.streamRow);
      return;
    }
    this.attachStreamToExisting(node, this.streamKind ?? 'assistant', merged);
  }

  private ensureStreamRow(messageKind: string): void {
    this.streamRow?.querySelector('.live-assist__stream-caret')?.remove();
    const last = this.transcriptEl.lastElementChild;
    if (
      last instanceof HTMLElement
      && last.classList.contains(`live-assist__message--${messageKind}`)
    ) {
      this.attachStreamToExisting(last, messageKind, messageSource(last));
      return;
    }
    const built = this.buildMessage({
      id: `live-stream-${Date.now()}`,
      kind: messageKind,
      text: '',
      createdAt: null,
      status: null,
    }, true);
    this.streamRow = built.row;
    this.streamTextNode = built.textNode;
    this.streamParser = built.parser;
    this.streamKind = messageKind;
    this.streamText = '';
    this.transcriptEl.appendChild(built.row);
    trimChildren(this.transcriptEl, TRANSCRIPT_TAIL);
  }

  private attachStreamToExisting(node: HTMLElement, kind: string, text: string): void {
    if (this.streamRow && this.streamRow !== node) {
      this.streamRow.querySelector('.live-assist__stream-caret')?.remove();
    }
    this.streamParser = null;
    this.streamTextNode = null;
    this.streamRow = node;
    this.streamKind = kind;
    this.streamText = text;
    const body = messageBody(node);
    if (liveAssistUsesMarkdown(kind) && body) {
      this.streamParser = beginLiveAssistMarkdown(body, text);
    } else {
      const textNode = messageTextNode(node);
      if (textNode && textNode.data !== text) textNode.data = text;
      this.streamTextNode = textNode;
    }
    ensureStreamCaret(node);
  }

  private writeStreamDelta(chunk: string): void {
    if (!chunk || !this.streamRow) return;
    const body = messageBody(this.streamRow);
    if (this.streamParser && body && liveAssistUsesMarkdown(this.streamKind ?? '')) {
      writeLiveAssistMarkdown(this.streamParser, body, chunk, this.streamText + chunk);
      return;
    }
    this.streamTextNode?.appendData(chunk);
  }

  private buildActivity(
    block: Extract<LiveAssistTranscriptBlock, { kind: 'activity' }>,
  ): HTMLDetailsElement {
    const details = document.createElement('details');
    details.className = 'live-assist__activity';
    details.dataset.activityId = block.id;

    const summary = document.createElement('summary');
    summary.className = 'live-assist__activity-summary';
    summary.textContent = liveAssistActivitySummary(block.items.length);

    const items = document.createElement('div');
    items.className = 'live-assist__activity-items';
    for (const item of block.items) {
      const row = this.buildMessage(item, false).row;
      row.dataset.blockKey = liveAssistBlockKey({ kind: 'message', item });
      items.appendChild(row);
    }
    details.append(summary, items);
    return details;
  }

  private buildMessage(
    item: LiveAssistTranscriptItem,
    streaming: boolean,
  ): { row: HTMLElement; textNode: Text | null; parser: MarkdownParser | null } {
    const row = document.createElement('article');
    const kind = displayKind(item.kind);
    row.className = `live-assist__message live-assist__message--${safeStatus(kind)}`;
    row.dataset.messageId = item.id;
    const label = document.createElement('span');
    label.className = 'live-assist__message-label';
    label.textContent = kindLabel(kind);
    const body = document.createElement('div');
    body.className = 'live-assist__message-body';
    let textNode: Text | null = null;
    let parser: MarkdownParser | null = null;
    if (liveAssistUsesMarkdown(kind) && (item.text || streaming)) {
      if (streaming) parser = beginLiveAssistMarkdown(body, item.text);
      else renderLiveAssistMarkdown(body, item.text, this.projectDir);
    } else {
      textNode = document.createTextNode(item.text || fallbackText(kind, item.status));
      body.appendChild(textNode);
    }
    row.append(label, body);
    if (streaming) ensureStreamCaret(row);
    return { row, textNode, parser };
  }

  /** Stop writing to the current row. A synthetic row the snapshot has now
   *  superseded is removed; an adopted snapshot row stays and loses its caret. */
  private releaseStreamRow(): void {
    const row = this.streamRow;
    this.streamRow = null;
    this.streamTextNode = null;
    if (!row) return;
    row.querySelector('.live-assist__stream-caret')?.remove();
    if (row.dataset.blockKey === undefined) row.remove();
  }

  private endStream(snapshotText = ''): void {
    const row = this.streamRow;
    const adopted = row?.dataset.blockKey !== undefined;
    if (adopted && this.streamParser && row) {
      const body = messageBody(row);
      const text = snapshotText.length > this.streamText.length ? snapshotText : this.streamText;
      if (body) sealLiveAssistMarkdown(this.streamParser, body, text, this.projectDir);
    }
    this.clearStream();
  }

  private clearStream(): void {
    this.streamParser = null;
    this.releaseStreamRow();
    this.streamKind = null;
    this.streamText = '';
  }

  private resetStream(): void {
    if (this.streamFrame !== null) window.cancelAnimationFrame(this.streamFrame);
    this.streamFrame = null;
    this.pendingStream = [];
    this.clearStream();
  }

  private flushStream(): void {
    this.streamFrame = null;
    if (this.pendingStream.length === 0 || this.transcriptEl.hidden) {
      this.pendingStream = [];
      return;
    }
    const nearBottom = isNearBottom(this.transcriptEl);
    const chunks = this.pendingStream.splice(0);
    for (const chunk of chunks) {
      const messageKind = chunk.kind === 'user_message_chunk' ? 'user' : 'assistant';
      if (!this.streamRow || this.streamKind !== messageKind || !this.streamRow.isConnected) {
        this.ensureStreamRow(messageKind);
      }
      this.writeStreamDelta(chunk.text);
      this.streamText += chunk.text;
    }
    if (nearBottom) this.transcriptEl.scrollTop = this.transcriptEl.scrollHeight;
  }

  private setPermission(permission: LiveAssistPermission | null): void {
    const activeElement = document.activeElement;
    const focusTarget = liveAssistPermissionFocusTarget(
      this.pendingPermission?.requestId ?? null,
      permission?.requestId ?? null,
      this.permissionEl.contains(activeElement),
      activeElement === this.textarea,
      this.textarea.value.trim().length === 0,
    );
    this.pendingPermission = permission;
    this.permissionEl.hidden = permission === null;
    this.permissionToolEl.textContent = permission
      ? `Allow ${permission.tool}? Only the oldest request can be resolved.`
      : '';
    if (focusTarget === 'permission') {
      this.permissionAcceptButton.focus({ preventScroll: true });
    } else if (focusTarget === 'composer') {
      this.focusComposer();
    }
  }
}

export function groupLiveAssistTranscript(
  items: LiveAssistTranscriptItem[],
): LiveAssistTranscriptBlock[] {
  const blocks: LiveAssistTranscriptBlock[] = [];
  let activity: Extract<LiveAssistTranscriptBlock, { kind: 'activity' }> | null = null;

  for (const item of items) {
    if (COMPACT_ACTIVITY_KINDS.has(item.kind)) {
      if (!activity) {
        activity = { kind: 'activity', id: item.id, items: [] };
        blocks.push(activity);
      }
      activity.items.push(item);
      continue;
    }

    activity = null;
    blocks.push({ kind: 'message', item });
  }

  return blocks;
}

/** Stable identity for reconciliation. Message and activity ids share a
 *  namespace (an activity is keyed by its first item), so they are prefixed. */
export function liveAssistBlockKey(block: LiveAssistTranscriptBlock): string {
  return block.kind === 'message' ? `m:${block.item.id}` : `a:${block.id}`;
}

/**
 * Decide what a snapshot does with the row the incremental stream is writing to.
 *
 * - `adopt` — the snapshot's trailing row is the same speaker, so streaming
 *   continues into that row (one node, no duplicate and no truncation).
 * - `drop` — the streamed text already appears in the snapshot tail (the turn
 *   sealed it, e.g. a tool call interrupted the message) or the turn is over.
 * - `keep` — the snapshot has not caught up; leave the synthetic row trailing.
 */
export function liveAssistStreamDisposition(
  blocks: LiveAssistTranscriptBlock[],
  streamKind: string,
  streamText: string,
  busy: boolean,
): LiveAssistStreamDisposition {
  const tail = blocks[blocks.length - 1];
  if (busy && tail?.kind === 'message' && displayKind(tail.item.kind) === streamKind) {
    return 'adopt';
  }
  if (!streamText) return 'drop';
  const scanFrom = Math.max(0, blocks.length - STREAM_COVERAGE_SCAN);
  for (let index = blocks.length - 1; index >= scanFrom; index -= 1) {
    const block = blocks[index];
    if (block.kind !== 'message') continue;
    if (displayKind(block.item.kind) !== streamKind) continue;
    if (block.item.text.includes(streamText)) return 'drop';
  }
  return busy ? 'keep' : 'drop';
}

/**
 * Text an adopted row should show.
 *
 * From a synthetic row the accumulated stream belongs to this very message, so
 * the longer side wins: the popup may hold only the suffix streamed since it
 * opened, or may be ahead of a snapshot taken mid-chunk.
 *
 * From an already-adopted row the snapshot has just revealed a message boundary
 * the popup could not see (the harness sealed one message and started another),
 * so the accumulated text spans two messages and only the snapshot is
 * trustworthy — otherwise the sealed row would keep the next message's opening.
 */
export function liveAssistAdoptedText(
  fromSynthetic: boolean,
  streamedText: string,
  snapshotText: string,
): string {
  return fromSynthetic && streamedText.length > snapshotText.length ? streamedText : snapshotText;
}

export function sameLaneRoster(previous: string[], next: string[]): boolean {
  return previous.length === next.length && previous.every((name, index) => name === next[index]);
}

function buildLaneButton(lane: LiveAssistLaneSummary): HTMLButtonElement {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'live-assist__lane';
  button.dataset.lane = lane.displayName;
  const dot = document.createElement('span');
  dot.className = 'live-assist__lane-dot';
  const name = document.createElement('span');
  name.textContent = lane.displayName;
  const state = document.createElement('span');
  state.className = 'live-assist__lane-state';
  button.append(dot, name, state);
  return button;
}

function syncLaneButton(
  button: HTMLElement,
  lane: LiveAssistLaneSummary,
  index: number,
  selectedLane: string | null,
): void {
  const selected = String(lane.displayName === selectedLane);
  if (button.getAttribute('aria-selected') !== selected) {
    button.setAttribute('aria-selected', selected);
  }
  const title = `⌘${index + 1} · ${lane.backendId} · ${lane.status}`;
  if (button.title !== title) button.title = title;
  const dot = button.querySelector<HTMLElement>('.live-assist__lane-dot');
  const dotClass = `live-assist__lane-dot live-assist__lane-dot--${safeStatus(lane.status)}`;
  if (dot && dot.className !== dotClass) dot.className = dotClass;
  const state = button.querySelector<HTMLElement>('.live-assist__lane-state');
  if (state && state.textContent !== lane.status) state.textContent = lane.status;
}

function messageBody(node: HTMLElement): HTMLElement | null {
  return node.querySelector('.live-assist__message-body');
}

function messageSource(node: HTMLElement): string {
  const body = messageBody(node);
  if (!body) return '';
  if (body.dataset.mdSource !== undefined) return body.dataset.mdSource;
  const text = messageTextNode(node);
  return text?.data ?? '';
}

function messageTextNode(node: HTMLElement): Text | null {
  const first = node.querySelector('.live-assist__message-body')?.firstChild ?? null;
  return first instanceof Text ? first : null;
}

function ensureStreamCaret(node: HTMLElement): void {
  const body = node.querySelector('.live-assist__message-body');
  if (!body || body.querySelector('.live-assist__stream-caret')) return;
  const caret = document.createElement('span');
  caret.className = 'live-assist__stream-caret';
  caret.setAttribute('aria-label', 'Streaming');
  body.appendChild(caret);
}

export function liveAssistActivitySummary(stepCount: number): string {
  return `ACTIVITY · ${stepCount} ${stepCount === 1 ? 'step' : 'steps'}`;
}

function displayKind(kind: string): string {
  if (kind === 'user_message_chunk') return 'user';
  if (kind === 'message_chunk') return 'assistant';
  return kind;
}

function kindLabel(kind: string): string {
  if (kind === 'user') return 'YOU';
  if (kind === 'assistant') return 'ASSISTANT';
  if (kind === 'tool') return 'TOOL';
  if (kind === 'thought') return 'THOUGHT';
  if (kind === 'error' || kind === 'provider_error') return 'ERROR';
  if (kind === 'system') return 'SYSTEM';
  if (kind === 'inter_lane') return 'LANE MAIL';
  return kind.replaceAll('_', ' ').toUpperCase().slice(0, 18);
}

function fallbackText(kind: string, status: string | null): string {
  if (kind === 'tool') return status ? `Tool ${status}` : 'Tool activity';
  return status ?? kindLabel(kind);
}

function safeStatus(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9_-]/g, '-');
}

function projectLabel(cwd: string | null): string {
  if (!cwd) return 'no project';
  const parts = cwd.split('/').filter(Boolean);
  return parts.slice(-2).join(' / ') || cwd;
}

function statusLabel(status: LiveAssistSnapshot['status']): string {
  const queue = status.queueDepth > 0 ? ` · queue ${status.queueDepth}` : '';
  return `${status.status}${queue}`;
}

function trimChildren(element: HTMLElement, cap: number): void {
  while (element.childElementCount > cap) element.firstElementChild?.remove();
}

function isNearBottom(element: HTMLElement): boolean {
  return element.scrollHeight - element.scrollTop - element.clientHeight < 48;
}
