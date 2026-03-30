// Krypton — Agent Context Window
// Standalone ContentView that displays the agent's LLM context in real-time.
// Subscribes to AgentController.onChange() for live updates during streaming.

import { AgentController, type AgentContextSnapshot, type ContextMessage } from './agent';
import type { ContentView, PaneContentType } from '../types';

function escHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

export class ContextView implements ContentView {
  readonly type: PaneContentType = 'context';
  readonly element: HTMLElement;

  private controller: AgentController;
  private unsubscribe: (() => void) | null = null;
  private closeCallback: (() => void) | null = null;

  // Browse state
  private state: 'browse' | 'detail' = 'browse';
  private selectedIdx = 0;

  // DOM refs
  private headerEl!: HTMLElement;
  private listEl!: HTMLElement;
  private detailEl!: HTMLElement;
  private hintEl!: HTMLElement;

  // Throttle renders during streaming
  private renderScheduled = false;

  constructor(controller: AgentController) {
    this.controller = controller;

    this.element = document.createElement('div');
    this.element.className = 'context-view';
    this.element.tabIndex = 0;

    this.buildDom();
    this.render();

    // Subscribe to controller changes for live updates
    this.unsubscribe = this.controller.onChange(() => {
      this.scheduleRender();
    });
  }

  private buildDom(): void {
    // Header bar
    this.headerEl = document.createElement('div');
    this.headerEl.className = 'context-view__header';

    // Scrollable message list
    this.listEl = document.createElement('div');
    this.listEl.className = 'context-view__list';

    // Detail panel (hidden by default)
    this.detailEl = document.createElement('div');
    this.detailEl.className = 'context-view__detail';

    // Bottom hint bar
    this.hintEl = document.createElement('div');
    this.hintEl.className = 'context-view__hint';
    this.hintEl.textContent = 'j/k navigate  Enter expand  y yank  Y yank all  g/G top/bot  q close';

    this.element.appendChild(this.headerEl);
    this.element.appendChild(this.listEl);
    this.element.appendChild(this.detailEl);
    this.element.appendChild(this.hintEl);
  }

  private scheduleRender(): void {
    if (this.renderScheduled) return;
    this.renderScheduled = true;
    requestAnimationFrame(() => {
      this.renderScheduled = false;
      if (this.state === 'browse') {
        this.render();
      } else {
        // In detail mode, just update the header stats
        this.renderHeader(this.controller.getContext());
      }
    });
  }

  private render(): void {
    const ctx = this.controller.getContext();
    this.renderHeader(ctx);
    this.renderList(ctx);
  }

  private renderHeader(ctx: AgentContextSnapshot | null): void {
    if (!ctx) {
      this.headerEl.innerHTML = '<span class="context-view__stat">Agent not initialized</span>';
      return;
    }

    const streamingDot = ctx.isStreaming
      ? '<span class="context-view__live-dot"></span>'
      : '';

    this.headerEl.innerHTML =
      `${streamingDot}` +
      `<span class="context-view__stat-label">MODEL</span> ` +
      `<span class="context-view__stat-value">${escHtml(ctx.model)}</span>` +
      `<span class="context-view__stat-label">THINKING</span> ` +
      `<span class="context-view__stat-value">${escHtml(ctx.thinkingLevel)}</span>` +
      `<span class="context-view__stat-label">MSGS</span> ` +
      `<span class="context-view__stat-value">${ctx.messageCount}</span>` +
      `<span class="context-view__stat-label">STREAMING</span> ` +
      `<span class="context-view__stat-value">${ctx.isStreaming ? 'yes' : 'no'}</span>`;
  }

  private renderList(ctx: AgentContextSnapshot | null): void {
    this.listEl.innerHTML = '';

    if (!ctx) {
      const placeholder = document.createElement('div');
      placeholder.className = 'context-view__placeholder';
      placeholder.textContent = 'Agent not initialized — submit a prompt first.';
      this.listEl.appendChild(placeholder);
      return;
    }

    // System prompt row (index 0)
    this.listEl.appendChild(this.createRow(
      0,
      'system',
      ['text'],
      ctx.systemPrompt.length,
      `${ctx.systemPrompt.slice(0, 80)}${ctx.systemPrompt.length > 80 ? '…' : ''}`,
    ));

    // Message rows
    for (const msg of ctx.messages) {
      const rowIdx = msg.index + 1;
      const summary = this.summarizeMessage(msg);
      const row = this.createRow(
        rowIdx,
        msg.role,
        msg.contentTypes,
        msg.textLength,
        summary,
      );
      if (msg.errorMessage) row.classList.add('context-view__row--error');
      if (msg.stopReason) {
        const badge = document.createElement('span');
        badge.className = 'context-view__row-badge';
        badge.textContent = msg.stopReason;
        row.appendChild(badge);
      }
      this.listEl.appendChild(row);
    }

    // Tools row (last)
    const toolsIdx = ctx.messageCount + 1;
    const toolNames = ctx.tools.map((t) => t.name).join(', ');
    this.listEl.appendChild(this.createRow(
      toolsIdx,
      'tools',
      [],
      0,
      `${ctx.tools.length} tools: ${toolNames}`,
    ));

    // Scroll selected into view
    const selected = this.listEl.querySelector('.context-view__row--selected');
    selected?.scrollIntoView({ block: 'nearest' });
  }

  private createRow(
    idx: number,
    role: string,
    types: string[],
    textLen: number,
    summary: string,
  ): HTMLElement {
    const row = document.createElement('div');
    row.className = 'context-view__row';
    if (idx === this.selectedIdx) row.classList.add('context-view__row--selected');

    const idxEl = document.createElement('span');
    idxEl.className = 'context-view__row-idx';
    idxEl.textContent = String(idx);

    const roleEl = document.createElement('span');
    roleEl.className = `context-view__row-role context-view__row-role--${role}`;
    roleEl.textContent = role;

    const typesEl = document.createElement('span');
    typesEl.className = 'context-view__row-types';
    typesEl.textContent = types.join(', ');

    const lenEl = document.createElement('span');
    lenEl.className = 'context-view__row-len';
    lenEl.textContent = textLen > 0 ? `${textLen}ch` : '';

    const sumEl = document.createElement('span');
    sumEl.className = 'context-view__row-summary';
    sumEl.textContent = summary;

    row.appendChild(idxEl);
    row.appendChild(roleEl);
    row.appendChild(typesEl);
    row.appendChild(lenEl);
    row.appendChild(sumEl);
    return row;
  }

  private summarizeMessage(msg: ContextMessage): string {
    const raw = msg.raw;
    if (msg.role === 'user') {
      const text = typeof raw.content === 'string'
        ? raw.content
        : raw.content?.find((b: { type: string; text?: string }) => b.type === 'text')?.text ?? '';
      return text.slice(0, 100) + (text.length > 100 ? '…' : '');
    }
    if (msg.role === 'assistant') {
      const parts: string[] = [];
      for (const b of (raw.content ?? [])) {
        if (b.type === 'text') parts.push(b.text?.slice(0, 60) ?? '');
        if (b.type === 'toolCall') parts.push(`tool:${b.toolName}(…)`);
        if (b.type === 'thinking') parts.push(`thinking[${(b.text ?? '').length}ch]`);
      }
      return parts.join(' | ').slice(0, 120);
    }
    if (msg.role === 'toolResult') {
      const text = raw.content?.find((b: { type: string; text?: string }) => b.type === 'text')?.text ?? '';
      return `${msg.toolName ?? '?'}: ${text.slice(0, 80)}${text.length > 80 ? '…' : ''}`;
    }
    return JSON.stringify(raw).slice(0, 100);
  }

  // ─── Detail view ───────────────────────────────────────────────

  private enterDetail(): void {
    const ctx = this.controller.getContext();
    if (!ctx) return;

    let rawContent: unknown;
    if (this.selectedIdx === 0) {
      rawContent = ctx.systemPrompt;
    } else if (this.selectedIdx <= ctx.messageCount) {
      rawContent = ctx.messages[this.selectedIdx - 1].raw;
    } else {
      rawContent = ctx.tools;
    }

    this.state = 'detail';
    this.listEl.classList.add('context-view__list--hidden');
    this.detailEl.classList.add('context-view__detail--visible');
    this.hintEl.textContent = 'j/k scroll  y yank  Escape back  q close';

    const content = document.createElement('pre');
    content.className = 'context-view__detail-content';
    content.textContent = typeof rawContent === 'string'
      ? rawContent
      : JSON.stringify(rawContent, null, 2);
    this.detailEl.innerHTML = '';
    this.detailEl.appendChild(content);
  }

  private exitDetail(): void {
    this.state = 'browse';
    this.listEl.classList.remove('context-view__list--hidden');
    this.detailEl.classList.remove('context-view__detail--visible');
    this.detailEl.innerHTML = '';
    this.hintEl.textContent = 'j/k navigate  Enter expand  y yank  Y yank all  g/G top/bot  q close';
    this.render();
  }

  // ─── Keyboard ──────────────────────────────────────────────────

  onKeyDown(e: KeyboardEvent): boolean {
    if (this.state === 'detail') {
      return this.handleDetailKey(e);
    }
    return this.handleBrowseKey(e);
  }

  private handleBrowseKey(e: KeyboardEvent): boolean {
    // Close
    if (e.key === 'q' || e.key === 'Escape') {
      this.closeCallback?.();
      return true;
    }

    // Navigate
    if (e.key === 'j' || e.key === 'ArrowDown') {
      this.navigate(1);
      return true;
    }
    if (e.key === 'k' || e.key === 'ArrowUp') {
      this.navigate(-1);
      return true;
    }

    // Jump to top/bottom
    if (e.key === 'g' && !e.shiftKey) {
      this.selectedIdx = 0;
      this.render();
      return true;
    }
    if (e.key === 'G' || (e.key === 'g' && e.shiftKey)) {
      const ctx = this.controller.getContext();
      if (ctx) this.selectedIdx = ctx.messageCount + 1;
      this.render();
      return true;
    }

    // Expand
    if (e.key === 'Enter') {
      this.enterDetail();
      return true;
    }

    // Yank selected
    if (e.key === 'y' && !e.shiftKey) {
      this.yankSelected();
      return true;
    }

    // Yank all
    if (e.key === 'Y' || (e.key === 'y' && e.shiftKey)) {
      this.yankAll();
      return true;
    }

    // Half-page scroll
    if (e.key === 'PageDown' || (e.code === 'KeyD' && e.ctrlKey)) {
      this.listEl.scrollBy({ top: this.listEl.clientHeight * 0.4, behavior: 'instant' });
      return true;
    }
    if (e.key === 'PageUp' || (e.code === 'KeyU' && e.ctrlKey)) {
      this.listEl.scrollBy({ top: -this.listEl.clientHeight * 0.4, behavior: 'instant' });
      return true;
    }

    return true; // consume all keys in browse mode
  }

  private handleDetailKey(e: KeyboardEvent): boolean {
    if (e.key === 'Escape') {
      this.exitDetail();
      return true;
    }

    if (e.key === 'q') {
      this.closeCallback?.();
      return true;
    }

    // Scroll detail content
    if (e.key === 'j' || e.key === 'ArrowDown') {
      this.detailEl.scrollBy({ top: 24, behavior: 'instant' });
      return true;
    }
    if (e.key === 'k' || e.key === 'ArrowUp') {
      this.detailEl.scrollBy({ top: -24, behavior: 'instant' });
      return true;
    }

    // Half-page scroll
    if (e.key === 'PageDown' || (e.code === 'KeyD' && e.ctrlKey)) {
      this.detailEl.scrollBy({ top: this.detailEl.clientHeight * 0.4, behavior: 'instant' });
      return true;
    }
    if (e.key === 'PageUp' || (e.code === 'KeyU' && e.ctrlKey)) {
      this.detailEl.scrollBy({ top: -this.detailEl.clientHeight * 0.4, behavior: 'instant' });
      return true;
    }

    // Yank detail content
    if (e.key === 'y') {
      const content = this.detailEl.querySelector('.context-view__detail-content');
      if (content?.textContent) {
        navigator.clipboard.writeText(content.textContent).catch(() => {});
      }
      return true;
    }

    return true;
  }

  private navigate(delta: number): void {
    const ctx = this.controller.getContext();
    if (!ctx) return;
    const maxIdx = ctx.messageCount + 1;
    this.selectedIdx = Math.max(0, Math.min(maxIdx, this.selectedIdx + delta));
    this.render();
  }

  // ─── Yank ──────────────────────────────────────────────────────

  private yankSelected(): void {
    const ctx = this.controller.getContext();
    if (!ctx) return;

    let content: unknown;
    if (this.selectedIdx === 0) {
      content = ctx.systemPrompt;
    } else if (this.selectedIdx <= ctx.messageCount) {
      content = ctx.messages[this.selectedIdx - 1].raw;
    } else {
      content = ctx.tools;
    }

    const text = typeof content === 'string' ? content : JSON.stringify(content, null, 2);
    navigator.clipboard.writeText(text).catch(() => {});
  }

  private yankAll(): void {
    const ctx = this.controller.getContext();
    if (!ctx) return;
    const text = JSON.stringify(ctx, null, 2);
    navigator.clipboard.writeText(text).catch(() => {});
  }

  // ─── Lifecycle ─────────────────────────────────────────────────

  onClose(cb: () => void): void {
    this.closeCallback = cb;
  }

  dispose(): void {
    this.unsubscribe?.();
    this.unsubscribe = null;
  }
}
