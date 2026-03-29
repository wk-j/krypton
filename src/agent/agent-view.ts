// Krypton — AI Agent View
// ContentView implementation that renders a keyboard-driven coding agent panel.
// Uses manual input handling (no contenteditable) for full keyboard control.

import { AgentController, type AgentEventType } from './agent';
import { saveSession, loadSession, clearSession, type StoredMessage } from './session';
import type { ContentView, PaneContentType } from '../types';

const SPINNER_FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];

function escHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function truncateArgs(args: string, maxLen = 120): string {
  if (args.length <= maxLen) return args;
  return args.slice(0, maxLen) + '…';
}

export class AgentView implements ContentView {
  readonly type: PaneContentType = 'agent';
  readonly element: HTMLElement;

  private messagesEl!: HTMLElement;
  private inputRowEl!: HTMLElement;
  private promptGlyphEl!: HTMLElement;
  private inputDisplayEl!: HTMLElement;
  private stateHintEl!: HTMLElement;

  private state: 'input' | 'scroll' = 'input';
  private inputText = '';
  private cursorPos = 0;
  private promptHistory: string[] = [];
  private historyIdx = -1;

  private controller: AgentController;
  private storedMessages: StoredMessage[] = [];

  // Current streaming elements
  private currentAssistantTextEl: HTMLElement | null = null;
  private currentToolRowEl: HTMLElement | null = null;

  // Spinner
  private spinnerInterval: ReturnType<typeof setInterval> | null = null;
  private spinnerFrame = 0;

  // Project scoping
  private projectDir: string | null = null;

  // Close callback registered by compositor (called when user presses q)
  private closeCallback: (() => void) | null = null;

  constructor() {
    this.controller = new AgentController();

    this.element = document.createElement('div');
    this.element.className = 'agent-view';
    this.element.tabIndex = 0;

    this.buildDom();
  }

  private buildDom(): void {
    // Messages area
    this.messagesEl = document.createElement('div');
    this.messagesEl.className = 'agent-view__messages';

    // State hint (scroll mode indicator)
    this.stateHintEl = document.createElement('div');
    this.stateHintEl.className = 'agent-view__state-hint';
    this.stateHintEl.textContent = 'SCROLL  g/G top/bot  j/k lines  y yank  i insert';

    // Input row
    this.inputRowEl = document.createElement('div');
    this.inputRowEl.className = 'agent-view__input-row';

    this.promptGlyphEl = document.createElement('span');
    this.promptGlyphEl.className = 'agent-view__prompt-glyph';
    this.promptGlyphEl.textContent = '❯';

    this.inputDisplayEl = document.createElement('div');
    this.inputDisplayEl.className = 'agent-view__input-display';

    this.inputRowEl.appendChild(this.promptGlyphEl);
    this.inputRowEl.appendChild(this.inputDisplayEl);

    this.element.appendChild(this.messagesEl);
    this.element.appendChild(this.stateHintEl);
    this.element.appendChild(this.inputRowEl);

    this.renderInput();
  }

  // ─── Session ──────────────────────────────────────────────────────

  private async restoreSession(): Promise<void> {
    const msgs = await loadSession(this.projectDir);
    for (const m of msgs) {
      if (m.role === 'user') {
        this.appendUserMessageDom(m.text);
      } else if (m.role === 'assistant') {
        const el = this.appendAssistantMessageDom();
        el.textContent = m.text;
      } else if (m.role === 'tool') {
        const row = this.appendToolRowDom(m.toolName ?? 'tool', '');
        this.finalizeToolRow(row, m.isError ?? false, m.text);
      }
      this.storedMessages.push(m);
    }
    if (msgs.length > 0) this.scrollToBottom();
  }

  // ─── DOM helpers ─────────────────────────────────────────────────

  private appendUserMessageDom(text: string): void {
    const msg = document.createElement('div');
    msg.className = 'agent-view__msg agent-view__msg--user';

    const label = document.createElement('span');
    label.className = 'agent-view__msg-label';
    label.textContent = 'YOU';

    const body = document.createElement('div');
    body.className = 'agent-view__msg-body';
    body.textContent = text;

    msg.appendChild(label);
    msg.appendChild(body);
    this.messagesEl.appendChild(msg);
  }

  private appendAssistantMessageDom(): HTMLElement {
    const msg = document.createElement('div');
    msg.className = 'agent-view__msg agent-view__msg--assistant';

    const label = document.createElement('span');
    label.className = 'agent-view__msg-label';
    label.textContent = 'AI';

    const body = document.createElement('div');
    body.className = 'agent-view__msg-body';

    const cursor = document.createElement('span');
    cursor.className = 'agent-view__stream-cursor';
    cursor.textContent = '▋';

    msg.appendChild(label);
    msg.appendChild(body);
    body.appendChild(cursor);
    this.messagesEl.appendChild(msg);
    return body;
  }

  private appendToolRowDom(name: string, args: string): HTMLElement {
    const row = document.createElement('div');
    row.className = 'agent-view__tool-row';

    const icon = document.createElement('span');
    icon.className = 'agent-view__tool-icon';
    icon.textContent = SPINNER_FRAMES[0];

    const nameEl = document.createElement('span');
    nameEl.className = 'agent-view__tool-name';
    nameEl.textContent = name;

    const argsEl = document.createElement('span');
    argsEl.className = 'agent-view__tool-args';
    argsEl.textContent = truncateArgs(args);

    row.appendChild(icon);
    row.appendChild(nameEl);
    row.appendChild(argsEl);
    this.messagesEl.appendChild(row);
    return row;
  }

  private finalizeToolRow(row: HTMLElement, isError: boolean, resultText?: string): void {
    const icon = row.querySelector('.agent-view__tool-icon');
    if (icon) icon.textContent = isError ? '✗' : '✓';
    row.classList.add(isError ? 'agent-view__tool-row--error' : 'agent-view__tool-row--done');

    if (resultText) {
      const existing = row.querySelector('.agent-view__tool-result');
      if (!existing) {
        const result = document.createElement('div');
        result.className = 'agent-view__tool-result';
        const lines = resultText.split('\n');
        const MAX_LINES = 10;
        if (lines.length > MAX_LINES) {
          result.textContent = lines.slice(0, MAX_LINES).join('\n');
          const more = document.createElement('span');
          more.className = 'agent-view__tool-more';
          more.textContent = ` … ${lines.length - MAX_LINES} more lines`;
          result.appendChild(more);
        } else {
          result.textContent = resultText;
        }
        row.appendChild(result);
      }
    }
  }

  // ─── Input rendering ─────────────────────────────────────────────

  private renderInput(): void {
    const before = escHtml(this.inputText.slice(0, this.cursorPos));
    const after = escHtml(this.inputText.slice(this.cursorPos));
    // Preserve newlines in display
    const toDisplay = (s: string) => s.replace(/\n/g, '<br>');
    this.inputDisplayEl.innerHTML =
      `${toDisplay(before)}<span class="agent-view__input-cursor">▋</span>${toDisplay(after)}`;
  }

  // ─── Agent event handling ────────────────────────────────────────

  private handleAgentEvent(e: AgentEventType): void {
    switch (e.type) {
      case 'agent_start':
        this.startSpinner();
        this.promptGlyphEl.textContent = SPINNER_FRAMES[0];
        this.inputRowEl.classList.add('agent-view__input-row--busy');
        break;

      case 'agent_end':
        this.stopSpinner();
        this.promptGlyphEl.textContent = '❯';
        this.inputRowEl.classList.remove('agent-view__input-row--busy');
        // Remove streaming cursor from current assistant message
        this.currentAssistantTextEl
          ?.querySelector('.agent-view__stream-cursor')
          ?.remove();
        this.currentAssistantTextEl = null;
        this.currentToolRowEl = null;
        this.saveCurrentSession();
        break;

      case 'message_update':
        if (!this.currentAssistantTextEl) {
          this.currentAssistantTextEl = this.appendAssistantMessageDom();
        }
        // Append delta before the cursor span
        {
          const cursor = this.currentAssistantTextEl.querySelector('.agent-view__stream-cursor');
          const text = document.createTextNode(e.delta);
          if (cursor) {
            this.currentAssistantTextEl.insertBefore(text, cursor);
          } else {
            this.currentAssistantTextEl.appendChild(text);
          }
        }
        this.scrollToBottom();
        break;

      case 'tool_start':
        this.currentAssistantTextEl
          ?.querySelector('.agent-view__stream-cursor')
          ?.remove();
        this.currentAssistantTextEl = null;
        this.currentToolRowEl = this.appendToolRowDom(e.name, e.args);
        this.scrollToBottom();
        break;

      case 'tool_end':
        if (this.currentToolRowEl) {
          this.finalizeToolRow(this.currentToolRowEl, e.isError, e.result);
          this.currentToolRowEl = null;
        }
        break;

      case 'error':
        this.stopSpinner();
        this.promptGlyphEl.textContent = '❯';
        this.inputRowEl.classList.remove('agent-view__input-row--busy');
        {
          const errEl = document.createElement('div');
          errEl.className = 'agent-view__error';
          errEl.textContent = e.message;
          this.messagesEl.appendChild(errEl);
          this.scrollToBottom();
        }
        break;
    }
  }

  // ─── Submit ──────────────────────────────────────────────────────

  private async submit(): Promise<void> {
    const text = this.inputText.trim();
    if (!text || this.controller.isRunning) return;

    // Save to history
    if (this.promptHistory[this.promptHistory.length - 1] !== text) {
      this.promptHistory.push(text);
    }
    this.historyIdx = -1;

    // Clear input
    this.inputText = '';
    this.cursorPos = 0;
    this.renderInput();

    // Render user message
    this.appendUserMessageDom(text);
    this.storedMessages.push({ role: 'user', text });
    this.scrollToBottom();

    try {
      await this.controller.prompt(text, (e) => this.handleAgentEvent(e));
    } catch (e) {
      this.handleAgentEvent({ type: 'error', message: `Unexpected error: ${e}` });
    }
  }

  private async saveCurrentSession(): Promise<void> {
    // Sync DOM back to storedMessages for persistence
    const msgs: StoredMessage[] = [];
    for (const el of Array.from(this.messagesEl.children)) {
      if (el.classList.contains('agent-view__msg--user')) {
        msgs.push({ role: 'user', text: el.querySelector('.agent-view__msg-body')?.textContent ?? '' });
      } else if (el.classList.contains('agent-view__msg--assistant')) {
        msgs.push({ role: 'assistant', text: el.querySelector('.agent-view__msg-body')?.textContent ?? '' });
      } else if (el.classList.contains('agent-view__tool-row')) {
        const isError = el.classList.contains('agent-view__tool-row--error');
        const name = el.querySelector('.agent-view__tool-name')?.textContent ?? '';
        const result = el.querySelector('.agent-view__tool-result')?.textContent ?? '';
        msgs.push({ role: 'tool', toolName: name, text: result, isError });
      }
    }
    this.storedMessages = msgs;
    await saveSession(msgs, this.projectDir);
  }

  // ─── Keyboard ────────────────────────────────────────────────────

  onKeyDown(e: KeyboardEvent): boolean {
    if (this.state === 'input') {
      return this.handleInputKey(e);
    }
    return this.handleScrollKey(e);
  }

  private handleInputKey(e: KeyboardEvent): boolean {
    // Escape (empty input) → scroll state
    if (e.key === 'Escape' && this.inputText === '') {
      this.enterScrollState();
      return true;
    }

    // Submit
    if (e.key === 'Enter' && !e.shiftKey && !e.ctrlKey && !e.altKey && !e.metaKey) {
      this.submit();
      return true;
    }

    // Newline
    if (e.key === 'Enter' && e.shiftKey) {
      this.insert('\n');
      return true;
    }

    // Abort (Ctrl+C) — clear input if idle, abort if running
    if (e.code === 'KeyC' && e.ctrlKey && !e.metaKey && !e.altKey) {
      if (this.controller.isRunning) {
        this.controller.abort();
        this.stopSpinner();
        this.promptGlyphEl.textContent = '❯';
        this.inputRowEl.classList.remove('agent-view__input-row--busy');
      } else {
        this.inputText = '';
        this.cursorPos = 0;
        this.renderInput();
      }
      return true;
    }

    // Delete word (Ctrl+W)
    if (e.code === 'KeyW' && e.ctrlKey && !e.metaKey && !e.altKey) {
      const before = this.inputText.slice(0, this.cursorPos);
      const trimmed = before.replace(/\S+\s*$/, '');
      this.inputText = trimmed + this.inputText.slice(this.cursorPos);
      this.cursorPos = trimmed.length;
      this.renderInput();
      return true;
    }

    // Backspace
    if (e.key === 'Backspace') {
      if (this.cursorPos > 0) {
        this.inputText = this.inputText.slice(0, this.cursorPos - 1) + this.inputText.slice(this.cursorPos);
        this.cursorPos--;
        this.renderInput();
      }
      return true;
    }

    // Delete
    if (e.key === 'Delete') {
      if (this.cursorPos < this.inputText.length) {
        this.inputText = this.inputText.slice(0, this.cursorPos) + this.inputText.slice(this.cursorPos + 1);
        this.renderInput();
      }
      return true;
    }

    // Cursor movement
    if (e.key === 'ArrowLeft' && !e.metaKey && !e.ctrlKey) {
      if (this.cursorPos > 0) this.cursorPos--;
      this.renderInput();
      return true;
    }
    if (e.key === 'ArrowRight' && !e.metaKey && !e.ctrlKey) {
      if (this.cursorPos < this.inputText.length) this.cursorPos++;
      this.renderInput();
      return true;
    }
    if (e.key === 'Home' || (e.key === 'ArrowLeft' && (e.metaKey || e.ctrlKey))) {
      this.cursorPos = 0;
      this.renderInput();
      return true;
    }
    if (e.key === 'End' || (e.key === 'ArrowRight' && (e.metaKey || e.ctrlKey))) {
      this.cursorPos = this.inputText.length;
      this.renderInput();
      return true;
    }

    // History navigation (only when input is empty)
    if (e.key === 'ArrowUp' && this.inputText === '') {
      this.historyBack();
      return true;
    }
    if (e.key === 'ArrowDown' && this.inputText === '') {
      this.historyForward();
      return true;
    }

    // Scroll message list without leaving input state
    if (e.key === 'PageUp' || (e.code === 'KeyU' && e.ctrlKey && !e.metaKey && !e.altKey)) {
      this.scrollMessagesFraction(-0.4);
      return true;
    }
    if (e.key === 'PageDown' || (e.code === 'KeyD' && e.ctrlKey && !e.metaKey && !e.altKey)) {
      this.scrollMessagesFraction(0.4);
      return true;
    }

    // Paste (Cmd+V / Ctrl+V)
    if (e.code === 'KeyV' && (e.metaKey || e.ctrlKey) && !e.altKey) {
      navigator.clipboard.readText().then((text) => {
        if (text) {
          this.insert(text);
        }
      }).catch(() => { /* clipboard unavailable */ });
      return true;
    }

    // Select all (Cmd+A / Ctrl+A)
    if (e.code === 'KeyA' && (e.metaKey || e.ctrlKey) && !e.altKey) {
      return true; // consume — no text selection in manual input
    }

    // Printable character
    if (e.key.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey) {
      this.insert(e.key);
      return true;
    }

    return false;
  }

  private handleScrollKey(e: KeyboardEvent): boolean {
    // Return to input state
    if (e.key === 'Escape' || (e.key === 'i' && !e.ctrlKey && !e.metaKey && !e.altKey)) {
      this.exitScrollState();
      return true;
    }

    // Line scrolling
    if (e.key === 'j' || e.key === 'ArrowDown') {
      this.messagesEl.scrollBy({ top: 24, behavior: 'instant' });
      return true;
    }
    if (e.key === 'k' || e.key === 'ArrowUp') {
      this.messagesEl.scrollBy({ top: -24, behavior: 'instant' });
      return true;
    }

    // Half-page scrolling
    if (e.key === 'PageDown' || (e.code === 'KeyD' && e.ctrlKey && !e.metaKey)) {
      this.scrollMessagesFraction(0.4);
      return true;
    }
    if (e.key === 'PageUp' || (e.code === 'KeyU' && e.ctrlKey && !e.metaKey)) {
      this.scrollMessagesFraction(-0.4);
      return true;
    }

    // Top / bottom
    if (e.key === 'g' && !e.shiftKey) {
      this.messagesEl.scrollTop = 0;
      return true;
    }
    if (e.key === 'G' || (e.key === 'g' && e.shiftKey)) {
      this.scrollToBottom();
      return true;
    }

    // Yank
    if (e.key === 'y' && !e.shiftKey) {
      this.yankLastAssistant();
      return true;
    }
    if (e.key === 'Y' || (e.key === 'y' && e.shiftKey)) {
      this.yankAll();
      return true;
    }

    // q — close tab (same convention as diff/markdown viewers)
    if (e.key === 'q') {
      this.closeCallback?.();
      return true;
    }

    return false;
  }

  onClose(cb: () => void): void {
    this.closeCallback = cb;
  }

  private insert(char: string): void {
    this.inputText = this.inputText.slice(0, this.cursorPos) + char + this.inputText.slice(this.cursorPos);
    this.cursorPos += char.length;
    this.renderInput();
  }

  private historyBack(): void {
    if (this.promptHistory.length === 0) return;
    if (this.historyIdx === -1) this.historyIdx = this.promptHistory.length - 1;
    else if (this.historyIdx > 0) this.historyIdx--;
    this.inputText = this.promptHistory[this.historyIdx] ?? '';
    this.cursorPos = this.inputText.length;
    this.renderInput();
  }

  private historyForward(): void {
    if (this.historyIdx === -1) return;
    this.historyIdx++;
    if (this.historyIdx >= this.promptHistory.length) {
      this.historyIdx = -1;
      this.inputText = '';
    } else {
      this.inputText = this.promptHistory[this.historyIdx] ?? '';
    }
    this.cursorPos = this.inputText.length;
    this.renderInput();
  }

  // ─── Scroll state ─────────────────────────────────────────────────

  private enterScrollState(): void {
    this.state = 'scroll';
    this.element.classList.add('agent-view--scroll');
    this.inputRowEl.classList.add('agent-view__input-row--hidden');
    this.stateHintEl.classList.add('agent-view__state-hint--visible');
  }

  private exitScrollState(): void {
    this.state = 'input';
    this.element.classList.remove('agent-view--scroll');
    this.inputRowEl.classList.remove('agent-view__input-row--hidden');
    this.stateHintEl.classList.remove('agent-view__state-hint--visible');
  }

  private scrollToBottom(): void {
    this.messagesEl.scrollTop = this.messagesEl.scrollHeight;
  }

  private scrollMessagesFraction(fraction: number): void {
    const delta = this.messagesEl.clientHeight * fraction;
    this.messagesEl.scrollBy({ top: delta, behavior: 'instant' });
  }

  // ─── Yank ─────────────────────────────────────────────────────────

  private yankLastAssistant(): void {
    const msgs = Array.from(this.messagesEl.querySelectorAll('.agent-view__msg--assistant'));
    const last = msgs[msgs.length - 1];
    if (last) {
      navigator.clipboard.writeText(last.querySelector('.agent-view__msg-body')?.textContent ?? '');
    }
  }

  private yankAll(): void {
    const parts: string[] = [];
    for (const el of Array.from(this.messagesEl.children)) {
      if (el.classList.contains('agent-view__msg--user')) {
        parts.push(`YOU: ${el.querySelector('.agent-view__msg-body')?.textContent ?? ''}`);
      } else if (el.classList.contains('agent-view__msg--assistant')) {
        parts.push(`AI: ${el.querySelector('.agent-view__msg-body')?.textContent ?? ''}`);
      }
    }
    navigator.clipboard.writeText(parts.join('\n\n'));
  }

  // ─── Spinner ──────────────────────────────────────────────────────

  private startSpinner(): void {
    if (this.spinnerInterval !== null) return;
    this.spinnerInterval = setInterval(() => {
      this.spinnerFrame = (this.spinnerFrame + 1) % SPINNER_FRAMES.length;
      this.promptGlyphEl.textContent = SPINNER_FRAMES[this.spinnerFrame];
      if (this.currentToolRowEl) {
        const icon = this.currentToolRowEl.querySelector('.agent-view__tool-icon');
        if (icon) icon.textContent = SPINNER_FRAMES[this.spinnerFrame];
      }
    }, 80);
  }

  private stopSpinner(): void {
    if (this.spinnerInterval !== null) {
      clearInterval(this.spinnerInterval);
      this.spinnerInterval = null;
    }
    this.spinnerFrame = 0;
  }

  // ─── New session ──────────────────────────────────────────────────

  async newSession(): Promise<void> {
    this.controller.reset();
    this.storedMessages = [];
    this.messagesEl.innerHTML = '';
    this.inputText = '';
    this.cursorPos = 0;
    this.promptHistory = [];
    this.historyIdx = -1;
    await clearSession(this.projectDir);
    this.renderInput();
  }

  // ─── Set context ──────────────────────────────────────────────────

  /** Set the project directory for per-project session scoping and tool CWD. Restores the matching session. */
  setProjectDir(dir: string | null): void {
    console.log('[agent] setProjectDir:', dir);
    this.projectDir = dir;
    this.controller.setProjectDir(dir);
    this.restoreSession();
  }

  // ─── ContentView interface ────────────────────────────────────────

  onResize(_w: number, _h: number): void {
    // Layout is pure CSS flex — no manual resize needed
  }

  dispose(): void {
    this.controller.abort();
    this.stopSpinner();
    this.saveCurrentSession();
  }
}
