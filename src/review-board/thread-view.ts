// Review thread reader over the existing Review Board and fixed Diff views.
//
// One header row (spec 354): the Board's title, text tabs, the snapshot, then
// the embedded Board's status, which it writes into `boardStatus`.

import { invoke } from '../profiler/ipc';
import type { DiffReviewComment, ReviewResponse } from '../acp/types';
import type { ContentView, LeaderKeyBinding, PaneContentType } from '../types';
import type { ReviewLineComment, ReviewThread, ReviewThreadRead, ReviewThreadVerdict } from '../acp/review-thread';
import { DiffContentView } from '../diff-view';
import { renderKicker } from './render';
import { keyCap } from '../ui/kbd';
import { ReviewBoardView } from './view';

type Mode = 'guide' | 'diff' | 'comments' | 'submit';
type VerdictKind = 'approve' | 'request_changes';

/** `label key`: a text control with its shortcut trailing as a cap. */
function keyButton(className: string, key: string | null, label: string): HTMLButtonElement {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = className;
  button.appendChild(document.createTextNode(label));
  if (key) {
    const hint = document.createElement('span');
    hint.className = 'krypton-review-thread__key';
    hint.appendChild(keyCap(key));
    button.appendChild(hint);
  }
  return button;
}

/** A layout slot holding one cap. */
function keyCapSlot(className: string, key: string): HTMLElement {
  const slot = document.createElement('span');
  slot.className = className;
  slot.appendChild(keyCap(key));
  return slot;
}

function textEl(tag: string, className: string, text: string): HTMLElement {
  const el = document.createElement(tag);
  el.className = className;
  el.textContent = text;
  return el;
}

export interface ReviewThreadViewOptions {
  cwd: string;
  threadId: string;
  slug: string;
  dir: string;
  laneName: string;
  deliver: (thread: ReviewThread, verdict: ReviewThreadVerdict) => Promise<'accepted' | 'no-live-lane' | 'duplicate'>;
  retryGuide: (thread: ReviewThread) => Promise<boolean>;
}

export class ReviewThreadView implements ContentView {
  readonly type: PaneContentType = 'review';
  readonly element: HTMLElement;
  private board: ReviewBoardView;
  private diff: DiffContentView | null = null;
  private diffSource: string | null = null;
  private thread: ReviewThread | null = null;
  private mode: Mode = 'guide';
  private selectedVerdict: VerdictKind | null = null;
  private closeCallback: (() => void) | null = null;
  private readonly nav: HTMLElement;
  /** Persistent node the embedded Board writes its status into; re-appended to
   *  the nav on every rebuild so the Board's flashes survive it. */
  private readonly boardStatus: HTMLElement;
  private readonly boardHost: HTMLElement;
  private readonly guideStatus: HTMLElement;
  private readonly guideMessage: HTMLElement;
  private readonly guideDiffButton: HTMLButtonElement;
  private readonly diffHost: HTMLElement;
  private readonly commentsHost: HTMLElement;
  private readonly submitHost: HTMLElement;
  private readonly notice: HTMLElement;
  private readonly summary: HTMLTextAreaElement;
  private readonly omittedCheck: HTMLInputElement;
  private saveChain: Promise<void> = Promise.resolve();
  private draftSaveError: string | null = null;
  private submitting = false;
  private stale = false;
  private obsoleteGuide = false;
  private guideAvailable = false;
  private loadGeneration = 0;
  private commentsVisible = 100;
  private boardCommentsVisible = 100;
  private verdictsVisible = 100;
  private disposeListeners: Array<() => void> = [];

  constructor(container: HTMLElement, private readonly options: ReviewThreadViewOptions) {
    this.element = document.createElement('div');
    this.element.className = 'krypton-review-thread';
    this.element.tabIndex = 0;
    container.appendChild(this.element);
    this.nav = document.createElement('nav');
    this.nav.className = 'krypton-review-thread__nav';
    this.element.appendChild(this.nav);
    this.notice = document.createElement('div');
    this.notice.className = 'krypton-review-thread__notice';
    this.element.appendChild(this.notice);
    this.boardHost = this.host('guide');
    this.diffHost = this.host('diff');
    this.commentsHost = this.host('comments');
    this.submitHost = this.host('submit');
    this.boardStatus = document.createElement('span');
    this.board = new ReviewBoardView(this.boardHost, {
      cwd: options.cwd,
      dir: options.dir,
      slug: options.slug,
      laneName: options.laneName,
      statusHost: this.boardStatus,
      jump: ({ path, line }) => {
        this.showMode('diff');
        this.diff?.revealLocation(path, line);
      },
    });
    this.board.onClose(() => this.closeCallback?.());
    this.board.element.style.display = 'none';
    this.guideStatus = document.createElement('div');
    this.guideStatus.className = 'krypton-review-thread__guide-status';
    this.guideStatus.setAttribute('role', 'status');
    this.guideMessage = document.createElement('p');
    this.guideDiffButton = keyButton('krypton-review-thread__button', 'D', 'เปิด snapshot diff');
    this.guideDiffButton.addEventListener('click', () => this.showMode('diff'));
    this.guideStatus.append(this.guideMessage, this.guideDiffButton);
    this.boardHost.appendChild(this.guideStatus);
    this.renderGuideStatus();
    this.summary = document.createElement('textarea');
    this.summary.className = 'krypton-review-thread__summary';
    this.summary.placeholder = 'สรุปผล review…';
    this.summary.rows = 5;
    this.omittedCheck = document.createElement('input');
    this.omittedCheck.type = 'checkbox';
    void this.load();
    this.showMode('guide');
  }

  private host(mode: Mode): HTMLElement {
    const el = document.createElement('section');
    el.className = 'krypton-review-thread__panel';
    el.dataset.mode = mode;
    this.element.appendChild(el);
    return el;
  }

  bundleSlug(): string { return this.options.slug; }
  addDisposeListener(cb: () => void): void { this.disposeListeners.push(cb); }
  getWorkingDirectory(): string | null { return this.options.cwd; }
  getLeaderKeyBindings(): LeaderKeyBinding[] { return []; }
  onClose(cb: () => void): void { this.closeCallback = cb; }

  private async load(): Promise<void> {
    const generation = ++this.loadGeneration;
    try {
      await this.saveChain;
      if (generation !== this.loadGeneration) return;
      const result = await invoke<ReviewThreadRead>('review_thread_read', {
        cwd: this.options.cwd, threadId: this.options.threadId,
      });
      if (generation !== this.loadGeneration) return;
      this.thread = result.thread;
      this.obsoleteGuide = result.thread.reviewSlug !== this.options.slug;
      if (!this.diff) this.diffSource = result.diff;
      const state = await invoke<{ stale: boolean }>('review_thread_check', {
        cwd: this.options.cwd, threadId: this.options.threadId,
      }).catch(() => null);
      if (generation !== this.loadGeneration) return;
      this.stale = state?.stale ?? false;
      if (result.thread.phase === 'ready' || this.obsoleteGuide) {
        await this.board.requestRefresh();
        if (generation !== this.loadGeneration) return;
      }
      if (this.mode === 'diff') this.ensureDiff();
      this.renderGuideStatus();
      this.renderNav();
      this.renderComments();
      this.renderSubmit();
    } catch (error) {
      if (generation !== this.loadGeneration) return;
      this.notice.textContent = `Review thread unavailable: ${String(error)}`;
      this.guideMessage.textContent = 'โหลด Review thread ไม่สำเร็จ กด r เพื่อลองอีกครั้ง';
    }
  }

  private ensureDiff(): void {
    if (this.diff || this.diffSource === null || !this.thread) return;
    this.diff = new DiffContentView(this.diffSource, this.diffHost, {
      skipped: this.thread.omitted,
      draftOnly: true,
      initialComments: this.thread.lineComments.map((c) => ({ ...c, createdAt: this.thread?.createdAt ?? 0 })),
      onDraftChange: (comments) => this.saveComments(comments),
      review: {
        resolveTargets: async () => ({
          lanes: [{ displayName: 'Review thread draft', status: 'idle' }],
          default: 'Review thread draft',
        }),
        send: async () => ({ status: 'no-live-lane' }),
      },
    });
    this.diff.onClose(() => this.showMode('guide'));
    this.diffSource = null;
  }

  requestRefresh(): void {
    void this.load();
  }

  private renderGuideStatus(): void {
    const hadFocus = document.activeElement === this.guideDiffButton;
    this.guideAvailable = this.thread?.phase === 'ready' || this.obsoleteGuide;
    this.board.element.style.display = this.guideAvailable ? '' : 'none';
    this.guideStatus.hidden = this.guideAvailable;
    const failed = this.thread?.phase === 'guide_failed';
    this.guideStatus.classList.toggle('krypton-review-thread__guide-status--failed', failed);
    this.guideMessage.textContent = this.thread?.phase === 'guide_failed'
      ? 'สร้าง Guide ไม่สำเร็จ กด Retry Guide ด้านบน หรือเปิด snapshot diff เพื่อตรวจต่อ'
      : this.thread
        ? 'กำลังเตรียม Guide เปิด snapshot diff เพื่อตรวจโค้ดระหว่างรอได้'
        : 'กำลังโหลด snapshot…';
    if (hadFocus && this.guideAvailable && this.mode === 'guide') this.board.focusView();
  }

  private saveComments(comments: DiffReviewComment[]): void {
    if (!this.thread) return;
    const draft: ReviewLineComment[] = comments.map(({ createdAt: _createdAt, ...rest }) => rest);
    this.thread.lineComments = draft;
    this.saveChain = this.saveChain.then(async () => {
      try {
        await invoke('review_thread_save_draft', {
          cwd: this.options.cwd, threadId: this.options.threadId, comments: draft,
        });
        this.draftSaveError = null;
      } catch (error) {
        this.draftSaveError = String(error);
        this.notice.textContent = `บันทึก line comments ไม่สำเร็จ: ${this.draftSaveError}`;
      }
    });
    this.renderComments();
  }

  private showMode(mode: Mode): void {
    this.mode = mode;
    for (const panel of [this.boardHost, this.diffHost, this.commentsHost, this.submitHost]) {
      panel.hidden = panel.dataset.mode !== mode;
    }
    if (mode === 'diff') this.ensureDiff();
    this.renderNav();
    if (mode === 'comments') this.renderComments();
    if (mode === 'submit') this.renderSubmit();
    this.focusView();
  }

  private renderNav(): void {
    this.nav.replaceChildren();
    this.nav.appendChild(
      textEl('span', 'krypton-review-thread__title', this.board.documentTitle() ?? 'Review thread'),
    );
    for (const [key, mode, name] of [
      ['G', 'guide', 'Guide'], ['D', 'diff', 'Diff'],
      ['C', 'comments', 'Comments'], ['V', 'submit', 'Submit'],
    ] as const) {
      const button = keyButton('krypton-review-thread__tab', key, name);
      if (this.mode === mode) button.classList.add('krypton-review-thread__tab--active');
      button.addEventListener('click', () => this.showMode(mode));
      this.nav.appendChild(button);
    }
    if (this.thread?.phase === 'guide_failed') {
      const retry = keyButton('krypton-review-thread__tab', null, 'Retry Guide');
      retry.addEventListener('click', () => {
        if (!this.thread) return;
        void this.options.retryGuide(this.thread).then((started) => {
          this.notice.textContent = started
            ? 'กำลังเตรียม Guide อีกครั้ง'
            : 'session ต้นทางยังไม่พร้อม';
        }).catch((error) => { this.notice.textContent = String(error); });
      });
      this.nav.appendChild(retry);
    }
    // Exceptions only: the phase unless it is `ready`, then the snapshot.
    const status = document.createElement('span');
    status.className = 'krypton-review-thread__status';
    if (this.thread) {
      const warnings: string[] = [];
      if (this.obsoleteGuide) warnings.push('Guide รอบเก่า');
      if (this.stale) warnings.push('งานเปลี่ยนหลัง snapshot');
      if (this.thread.phase !== 'ready') status.append(`${this.thread.phase}  `);
      if (warnings.length > 0) {
        status.append(textEl('span', 'krypton-review-thread__warn', warnings.join('  ')), '  ');
      }
      status.append(`${this.thread.baseRef} @ ${this.thread.baseOid.slice(0, 8)}`);
    } else {
      status.textContent = 'loading snapshot…';
    }
    this.nav.append(status, this.boardStatus);
  }

  private renderComments(): void {
    this.commentsHost.replaceChildren();
    const thread = this.thread;
    if (!thread) return;
    this.commentsHost.appendChild(
      renderKicker({ label: 'Line comments', meta: [{ text: String(thread.lineComments.length) }] }, 'h2'),
    );
    for (const comment of thread.lineComments.slice(0, this.commentsVisible)) {
      this.commentsHost.appendChild(
        this.commentRow(`${comment.file}:${comment.lineStart} (${comment.side})`, comment.body),
      );
    }
    if (thread.lineComments.length > this.commentsVisible) {
      const more = keyButton(
        'krypton-review-thread__button',
        null,
        `Show 100 more (${this.commentsVisible}/${thread.lineComments.length})`,
      );
      more.addEventListener('click', () => {
        this.commentsVisible += 100;
        this.renderComments();
      });
      this.commentsHost.appendChild(more);
    }
    const boardComments = this.board.draftResponse().comments;
    if (boardComments.length > 0) {
      this.commentsHost.appendChild(
        renderKicker({ label: 'Guide comments', meta: [{ text: String(boardComments.length) }] }, 'h2'),
      );
    }
    for (const comment of boardComments.slice(0, this.boardCommentsVisible)) {
      this.commentsHost.appendChild(
        this.commentRow(this.board.blockLabel(comment.blockId), comment.body),
      );
    }
    if (boardComments.length > this.boardCommentsVisible) {
      const more = keyButton(
        'krypton-review-thread__button',
        null,
        `Show 100 more Guide comments (${this.boardCommentsVisible}/${boardComments.length})`,
      );
      more.addEventListener('click', () => {
        this.boardCommentsVisible += 100;
        this.renderComments();
      });
      this.commentsHost.appendChild(more);
    }
    this.commentsHost.appendChild(
      renderKicker({ label: 'Verdicts', meta: [{ text: String(thread.verdicts.length) }] }, 'h2'),
    );
    for (const verdict of [...thread.verdicts].reverse().slice(0, this.verdictsVisible)) {
      const approve = verdict.kind === 'approve';
      const row = document.createElement('div');
      row.className = `krypton-review-thread__verdict krypton-review-thread__verdict--${approve ? 'approve' : 'changes'}`;
      row.append(
        textEl('span', 'krypton-review-thread__verdict-kind', approve ? 'Approve' : 'Request changes'),
        textEl('span', 'krypton-review-thread__verdict-delivery', verdict.delivery.replace('_', ' ')),
        textEl('p', 'krypton-review-thread__verdict-summary', verdict.summary),
      );
      this.commentsHost.appendChild(row);
      if (verdict.delivery === 'pending' || verdict.delivery === 'queued' ||
          verdict.delivery === 'uncertain') {
        const retry = keyButton('krypton-review-thread__button', null, 'Send again');
        retry.addEventListener('click', () => { void this.deliver(verdict); });
        this.commentsHost.appendChild(retry);
      }
    }
    if (thread.verdicts.length > this.verdictsVisible) {
      const more = keyButton(
        'krypton-review-thread__button',
        null,
        `Show 100 older verdicts (${this.verdictsVisible}/${thread.verdicts.length})`,
      );
      more.addEventListener('click', () => {
        this.verdictsVisible += 100;
        this.renderComments();
      });
      this.commentsHost.appendChild(more);
    }
  }

  /** Location above body: the comment row of the Comments tab. */
  private commentRow(location: string, body: string): HTMLElement {
    const item = document.createElement('div');
    item.className = 'krypton-review-thread__comment';
    item.append(
      textEl('span', 'krypton-review-thread__loc', location),
      textEl('p', 'krypton-review-thread__comment-body', body),
    );
    return item;
  }

  private renderSubmit(): void {
    this.submitHost.replaceChildren(renderKicker({ label: 'Verdict' }));
    for (const [kind, key, label] of [
      ['approve', '1', 'Approve'], ['request_changes', '2', 'Request changes'],
    ] as const) {
      // Decision-style option row: number, label, and the reason it is off.
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'krypton-review-thread__choice';
      button.append(
        keyCapSlot('krypton-review-thread__choice-key', key),
        textEl('span', 'krypton-review-thread__choice-label', label),
      );
      if (kind === 'approve' && (this.stale || this.thread?.phase !== 'ready')) {
        const reason = this.stale ? 'เริ่ม review รอบใหม่ก่อน Approve' : 'รอ Guide ให้พร้อม';
        button.disabled = true;
        button.title = reason;
        button.appendChild(textEl('span', 'krypton-review-thread__choice-reason', reason));
      }
      if (this.selectedVerdict === kind) button.classList.add('krypton-review-thread__choice--active');
      button.addEventListener('click', () => {
        this.selectedVerdict = kind;
        this.renderSubmit();
      });
      this.submitHost.appendChild(button);
    }
    this.submitHost.append(renderKicker({ label: 'Summary' }), this.summary);
    if (this.thread?.omitted.length) {
      const row = document.createElement('label');
      row.className = 'krypton-review-thread__omitted';
      const text = document.createElement('span');
      text.textContent = `ตรวจไฟล์ที่ไม่อยู่ใน diff ด้วยวิธีอื่นแล้ว (${this.thread.omitted.length} ไฟล์)`;
      row.append(this.omittedCheck, text);
      this.submitHost.appendChild(row);
    }
    const send = this.submitting
      ? keyButton('krypton-review-thread__send', null, 'กำลังส่ง…')
      : keyButton('krypton-review-thread__send', '⌘Enter', 'Submit review');
    send.disabled = this.submitting;
    send.addEventListener('click', () => { void this.submit(); });
    this.submitHost.appendChild(send);
  }

  private async submit(): Promise<void> {
    if (!this.thread || this.submitting) return;
    if (this.obsoleteGuide) {
      this.notice.textContent = 'Guide นี้ถูกแทนที่แล้ว · เปิดรายการล่าสุดจาก Review picker';
      return;
    }
    if (!this.selectedVerdict) {
      this.notice.textContent = 'เลือก Approve หรือ Request Changes ก่อน';
      return;
    }
    if (!this.summary.value.trim()) {
      this.notice.textContent = 'กรอกสรุปผล review ก่อน';
      return;
    }
    this.submitting = true;
    this.renderSubmit();
    try {
      await this.saveChain;
      if (this.draftSaveError) throw new Error(`บันทึก line comments ไม่สำเร็จ: ${this.draftSaveError}`);
      await this.board.flushDraft();
      const state = await invoke<{ stale: boolean }>('review_thread_check', {
        cwd: this.options.cwd, threadId: this.options.threadId,
      });
      if (state.stale && this.selectedVerdict === 'approve') {
        throw new Error('งานเปลี่ยนหลังเริ่ม review · เปิด review รอบใหม่ก่อน Approve');
      }
      const response: ReviewResponse = this.board.draftResponse();
      const verdict = await invoke<ReviewThreadVerdict>('review_thread_submit', {
        cwd: this.options.cwd,
        threadId: this.options.threadId,
        verdict: this.selectedVerdict,
        summary: this.summary.value,
        response,
        acceptOmitted: this.omittedCheck.checked,
      });
      this.thread.verdicts.push(verdict);
      await this.deliver(verdict);
      this.showMode('comments');
      this.summary.value = '';
      this.selectedVerdict = null;
    } catch (error) {
      this.notice.textContent = String(error);
    } finally {
      this.submitting = false;
      this.renderSubmit();
    }
  }

  private async deliver(verdict: ReviewThreadVerdict): Promise<void> {
    if (!this.thread) return;
    try {
      const result = await this.options.deliver(this.thread, verdict);
      if (result !== 'no-live-lane') {
        verdict.delivery = 'queued';
        this.notice.textContent = 'บันทึก verdict แล้ว · รอ lane ต้นทางรับ';
      } else {
        this.notice.textContent = 'บันทึก verdict แล้ว · session ต้นทางไม่อยู่ กด Send again เมื่อกลับมา';
      }
    } catch (error) {
      this.notice.textContent = `บันทึก verdict แล้ว · ส่งไม่สำเร็จ: ${String(error)}`;
    }
    this.renderComments();
  }

  onKeyDown(e: KeyboardEvent): boolean {
    if (this.mode === 'submit' && e.metaKey && e.key === 'Enter') {
      void this.submit();
      return true;
    }
    if (this.mode === 'diff' && e.target instanceof HTMLTextAreaElement &&
        this.diff?.element.contains(e.target)) {
      return this.diff.onKeyDown(e);
    }
    if (e.target instanceof HTMLTextAreaElement || e.target instanceof HTMLInputElement) {
      if (e.key === 'Escape') { this.showMode('guide'); return true; }
      return false;
    }
    if (e.metaKey || e.ctrlKey || e.altKey) return false;
    if (this.mode === 'submit' && (e.key === '1' || e.key === '2')) {
      this.selectedVerdict = e.key === '1' ? 'approve' : 'request_changes';
      this.renderSubmit();
      return true;
    }
    if (e.key === 'D') { this.showMode('diff'); return true; }
    if (e.key === 'C' && this.mode !== 'diff') { this.showMode('comments'); return true; }
    if (e.key === 'V' || (e.key === 's' && this.mode === 'guide')) {
      this.showMode('submit');
      return true;
    }
    if (e.key === 'G') { this.showMode('guide'); return true; }
    if (e.key === 'r') { this.requestRefresh(); return true; }
    if (e.key === 'Escape' && this.mode !== 'guide') { this.showMode('guide'); return true; }
    if (this.mode === 'guide') return this.guideAvailable ? this.board.onKeyDown(e) : false;
    if (this.mode === 'diff') return this.diff?.onKeyDown(e) ?? false;
    if (e.key === 'Escape' || e.key === 'q') { this.showMode('guide'); return true; }
    return false;
  }

  focusView(): void {
    if (this.mode === 'guide') {
      if (this.guideAvailable) this.board.focusView();
      else this.guideDiffButton.focus();
    }
    else if (this.mode === 'diff') this.diff?.element.focus();
    else this.element.focus();
  }

  onShow(): void {
    if (this.mode === 'guide' && this.guideAvailable) this.board.onShow();
    else this.diff?.onShow?.();
  }

  dispose(): void {
    this.loadGeneration++;
    this.board.dispose();
    this.diff?.dispose();
    this.diff = null;
    this.diffSource = null;
    this.thread = null;
    for (const cb of this.disposeListeners) cb();
    this.disposeListeners = [];
    this.element.remove();
  }
}
