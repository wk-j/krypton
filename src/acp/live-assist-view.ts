import type {
  LiveAssistLaneSummary,
  LiveAssistPermission,
  LiveAssistSnapshot,
  LiveAssistTranscriptItem,
} from './live-assist-types';

const TRANSCRIPT_TAIL = 120;
const BUSY_STATUSES = new Set(['busy', 'needs_permission', 'awaiting_peer']);
const COMPACT_ACTIVITY_KINDS = new Set(['thought', 'tool', 'fs_activity', 'fs_write_review']);

export type LiveAssistTranscriptBlock =
  | { kind: 'message'; item: LiveAssistTranscriptItem }
  | { kind: 'activity'; id: string; items: LiveAssistTranscriptItem[] };

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
  private streamKind: string | null = null;
  private pendingStream: Array<{ kind: string; text: string }> = [];
  private streamFrame: number | null = null;
  private entranceFrame: number | null = null;
  private currentStatus = 'idle';

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
  }

  dispose(): void {
    this.abort.abort();
    if (this.noticeTimer !== null) window.clearTimeout(this.noticeTimer);
    if (this.streamFrame !== null) window.cancelAnimationFrame(this.streamFrame);
    if (this.entranceFrame !== null) window.cancelAnimationFrame(this.entranceFrame);
    this.shell.remove();
  }

  playEntrance(): void {
    this.shell.classList.remove('live-assist--enter');
    if (this.entranceFrame !== null) window.cancelAnimationFrame(this.entranceFrame);
    this.entranceFrame = window.requestAnimationFrame(() => {
      this.entranceFrame = null;
      this.shell.classList.add('live-assist--enter');
    });
  }

  setLanes(lanes: LiveAssistLaneSummary[], selectedLane: string | null): void {
    this.selectedLane = selectedLane;
    const fragment = document.createDocumentFragment();
    for (let index = 0; index < lanes.length; index += 1) {
      const lane = lanes[index];
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'live-assist__lane';
      button.dataset.lane = lane.displayName;
      button.setAttribute('aria-selected', String(lane.displayName === selectedLane));
      button.title = `⌘${index + 1} · ${lane.backendId} · ${lane.status}`;
      const dot = document.createElement('span');
      dot.className = `live-assist__lane-dot live-assist__lane-dot--${safeStatus(lane.status)}`;
      const name = document.createElement('span');
      name.textContent = lane.displayName;
      const state = document.createElement('span');
      state.className = 'live-assist__lane-state';
      state.textContent = lane.status;
      button.append(dot, name, state);
      fragment.appendChild(button);
    }
    this.laneStrip.replaceChildren(fragment);
    this.laneStrip.hidden = lanes.length < 2;
  }

  renderSnapshot(snapshot: LiveAssistSnapshot): void {
    this.showContent();
    this.selectedLane = snapshot.lane.displayName;
    this.projectEl.textContent = projectLabel(snapshot.lane.cwd);
    this.laneEl.textContent = `${snapshot.lane.displayName} · ${snapshot.lane.backendId}`;
    this.statusEl.textContent = statusLabel(snapshot.status);
    this.statusEl.dataset.status = safeStatus(snapshot.status.status);
    this.currentStatus = snapshot.status.status;
    this.textarea.placeholder = `Message ${snapshot.lane.displayName}…`;
    this.textarea.setAttribute('aria-label', `Message ${snapshot.lane.displayName}`);
    this.sendButton.textContent = BUSY_STATUSES.has(snapshot.status.status) ? 'QUEUE ⌘↵' : 'SEND ⌘↵';
    this.cancelButton.hidden = !BUSY_STATUSES.has(snapshot.status.status);
    this.renderTranscript(snapshot.transcript);
    this.setPermission(snapshot.permissions[0] ?? null);
  }

  showEmpty(): void {
    this.selectedLane = null;
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

  private renderTranscript(items: LiveAssistTranscriptItem[]): void {
    if (this.streamFrame !== null) window.cancelAnimationFrame(this.streamFrame);
    this.streamFrame = null;
    this.pendingStream = [];
    const openActivityIds = new Set(
      Array.from(this.transcriptEl.querySelectorAll<HTMLDetailsElement>('.live-assist__activity[open]'))
        .map((element) => element.dataset.activityId)
        .filter((id): id is string => Boolean(id)),
    );
    const fragment = document.createDocumentFragment();
    for (const block of groupLiveAssistTranscript(items.slice(-TRANSCRIPT_TAIL))) {
      if (block.kind === 'message') {
        fragment.appendChild(buildMessage(block.item, false).row);
      } else {
        fragment.appendChild(buildActivity(block, openActivityIds.has(block.id)));
      }
    }
    this.transcriptEl.replaceChildren(fragment);
    this.streamRow = null;
    this.streamTextNode = null;
    this.streamKind = null;
    this.transcriptEl.scrollTop = this.transcriptEl.scrollHeight;
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
        const built = buildMessage({
          id: `live-stream-${Date.now()}`,
          kind: messageKind,
          text: '',
          createdAt: null,
          status: null,
        }, true);
        this.streamRow = built.row;
        this.streamTextNode = built.textNode;
        this.streamKind = messageKind;
        this.transcriptEl.appendChild(built.row);
        trimChildren(this.transcriptEl, TRANSCRIPT_TAIL);
      }
      this.streamTextNode?.appendData(chunk.text);
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

function buildActivity(
  block: Extract<LiveAssistTranscriptBlock, { kind: 'activity' }>,
  open: boolean,
): HTMLDetailsElement {
  const details = document.createElement('details');
  details.className = 'live-assist__activity';
  details.dataset.activityId = block.id;
  details.open = open;

  const summary = document.createElement('summary');
  summary.className = 'live-assist__activity-summary';
  summary.textContent = liveAssistActivitySummary(block.items.length);

  const items = document.createElement('div');
  items.className = 'live-assist__activity-items';
  for (const item of block.items) items.appendChild(buildMessage(item, false).row);
  details.append(summary, items);
  return details;
}

export function liveAssistActivitySummary(stepCount: number): string {
  return `ACTIVITY · ${stepCount} ${stepCount === 1 ? 'step' : 'steps'}`;
}

function buildMessage(
  item: LiveAssistTranscriptItem,
  streaming: boolean,
): { row: HTMLElement; textNode: Text } {
  const row = document.createElement('article');
  const kind = displayKind(item.kind);
  row.className = `live-assist__message live-assist__message--${safeStatus(kind)}`;
  row.dataset.messageId = item.id;
  const label = document.createElement('span');
  label.className = 'live-assist__message-label';
  label.textContent = kindLabel(kind);
  const body = document.createElement('div');
  body.className = 'live-assist__message-body';
  const textNode = document.createTextNode(item.text || fallbackText(kind, item.status));
  body.appendChild(textNode);
  if (streaming) {
    const caret = document.createElement('span');
    caret.className = 'live-assist__stream-caret';
    caret.setAttribute('aria-label', 'Streaming');
    body.appendChild(caret);
  }
  row.append(label, body);
  return { row, textNode };
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
