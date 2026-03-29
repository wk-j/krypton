// Krypton — AI Agent View
// ContentView implementation that renders a keyboard-driven coding agent panel.
// Uses manual input handling (no contenteditable) for full keyboard control.

import { Marked } from 'marked';
import { markedHighlight } from 'marked-highlight';
import hljs from 'highlight.js';
import { AgentController, type AgentEventType, type AgentContextSnapshot, type ContextMessage } from './agent';
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

// Shared markdown renderer with syntax highlighting
const md = new Marked(
  markedHighlight({
    langPrefix: 'hljs language-',
    highlight(code: string, lang: string): string {
      if (lang && hljs.getLanguage(lang)) {
        return hljs.highlight(code, { language: lang }).value;
      }
      return hljs.highlightAuto(code).value;
    },
  }),
);

export class AgentView implements ContentView {
  readonly type: PaneContentType = 'agent';
  readonly element: HTMLElement;

  private messagesEl!: HTMLElement;
  private inputRowEl!: HTMLElement;
  private promptGlyphEl!: HTMLElement;
  private inputDisplayEl!: HTMLElement;
  private stateHintEl!: HTMLElement;

  private state: 'input' | 'scroll' | 'context' = 'input';
  private contextPanelEl!: HTMLElement;
  private contextSelectedIdx = 0;
  private inputText = '';
  private cursorPos = 0;
  private promptHistory: string[] = [];
  private historyIdx = -1;

  private controller: AgentController;
  private storedMessages: StoredMessage[] = [];

  // Current streaming elements
  private currentAssistantTextEl: HTMLElement | null = null;
  private currentAssistantBuffer = '';
  private currentToolRowEl: HTMLElement | null = null;

  // Spinner
  private spinnerInterval: ReturnType<typeof setInterval> | null = null;
  private spinnerFrame = 0;

  // Project scoping
  private projectDir: string | null = null;

  // Close callback registered by compositor (called when user presses q)
  private closeCallback: (() => void) | null = null;

  // Autocomplete state
  private autocompleteEl!: HTMLElement;
  private acMatches: string[] = [];
  private acSelectedIdx = -1;

  // Scroll position preservation across tab switches
  private savedScrollTop = 0;

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
    this.stateHintEl.textContent = 'SCROLL  g/G top/bot  j/k lines  y yank  c context  i insert';

    // Context inspector panel (hidden by default)
    this.contextPanelEl = document.createElement('div');
    this.contextPanelEl.className = 'agent-view__context-panel';

    // Input row
    this.inputRowEl = document.createElement('div');
    this.inputRowEl.className = 'agent-view__input-row';

    this.promptGlyphEl = document.createElement('span');
    this.promptGlyphEl.className = 'agent-view__prompt-glyph';
    this.promptGlyphEl.textContent = '❯';

    this.inputDisplayEl = document.createElement('div');
    this.inputDisplayEl.className = 'agent-view__input-display';

    this.autocompleteEl = document.createElement('div');
    this.autocompleteEl.className = 'agent-view__autocomplete';

    this.inputRowEl.appendChild(this.promptGlyphEl);
    this.inputRowEl.appendChild(this.inputDisplayEl);

    // Track scroll position so it can be restored after tab switch
    this.messagesEl.addEventListener('scroll', () => {
      this.savedScrollTop = this.messagesEl.scrollTop;
    }, { passive: true });

    this.element.appendChild(this.messagesEl);
    this.element.appendChild(this.contextPanelEl);
    this.element.appendChild(this.stateHintEl);
    this.element.appendChild(this.autocompleteEl);
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
        el.querySelector('.agent-view__stream-cursor')?.remove();
        try {
          el.innerHTML = md.parse(m.text) as string;
          el.classList.add('agent-view__msg-body--markdown');
        } catch {
          el.textContent = m.text;
        }
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

  /** Convert the accumulated raw text buffer to rendered markdown HTML */
  private finalizeAssistantMessage(): void {
    if (!this.currentAssistantTextEl || !this.currentAssistantBuffer) return;
    const cursor = this.currentAssistantTextEl.querySelector('.agent-view__stream-cursor');
    cursor?.remove();
    try {
      const html = md.parse(this.currentAssistantBuffer) as string;
      this.currentAssistantTextEl.innerHTML = html;
      this.currentAssistantTextEl.classList.add('agent-view__msg-body--markdown');
    } catch {
      // Fallback: leave as plain text
    }
    this.currentAssistantBuffer = '';
    this.currentAssistantTextEl = null;
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
    this.updateAutocomplete();
  }

  // ─── Autocomplete ───────────────────────────────────────────────

  private updateAutocomplete(): void {
    const text = this.inputText.trim();

    // Only show when input starts with / and has no spaces (still typing the command)
    if (!text.startsWith('/') || text.includes(' ')) {
      this.hideAutocomplete();
      return;
    }

    const prefix = text.toLowerCase();
    const allCmds = Object.keys(AgentView.COMMANDS);
    this.acMatches = allCmds.filter((cmd) => cmd.startsWith(prefix) && cmd !== prefix);

    if (this.acMatches.length === 0) {
      this.hideAutocomplete();
      return;
    }

    // Clamp selection
    if (this.acSelectedIdx >= this.acMatches.length) this.acSelectedIdx = this.acMatches.length - 1;
    if (this.acSelectedIdx < 0) this.acSelectedIdx = 0;

    this.autocompleteEl.innerHTML = '';
    for (let i = 0; i < this.acMatches.length; i++) {
      const cmd = this.acMatches[i];
      const info = AgentView.COMMANDS[cmd];
      const row = document.createElement('div');
      row.className = 'agent-view__ac-row';
      if (i === this.acSelectedIdx) row.classList.add('agent-view__ac-row--selected');

      const cmdEl = document.createElement('span');
      cmdEl.className = 'agent-view__ac-cmd';
      cmdEl.textContent = cmd;

      const descEl = document.createElement('span');
      descEl.className = 'agent-view__ac-desc';
      descEl.textContent = info.description;

      row.appendChild(cmdEl);
      row.appendChild(descEl);
      this.autocompleteEl.appendChild(row);
    }
    this.autocompleteEl.classList.add('agent-view__autocomplete--visible');
  }

  private hideAutocomplete(): void {
    this.acMatches = [];
    this.acSelectedIdx = -1;
    this.autocompleteEl.classList.remove('agent-view__autocomplete--visible');
    this.autocompleteEl.innerHTML = '';
  }

  private acceptAutocomplete(): boolean {
    if (this.acMatches.length === 0) return false;
    const idx = Math.max(0, this.acSelectedIdx);
    const cmd = this.acMatches[idx];
    if (!cmd) return false;
    this.inputText = cmd;
    this.cursorPos = cmd.length;
    this.hideAutocomplete();
    this.renderInput();
    return true;
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
        // Render accumulated text as markdown
        this.finalizeAssistantMessage();
        this.currentToolRowEl = null;
        this.saveCurrentSession();
        break;

      case 'message_update':
        if (!this.currentAssistantTextEl) {
          this.currentAssistantTextEl = this.appendAssistantMessageDom();
          this.currentAssistantBuffer = '';
        }
        // Accumulate raw text and show as plain text during streaming
        this.currentAssistantBuffer += e.delta;
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
        // Finalize any pending assistant text as markdown before showing tool row
        this.finalizeAssistantMessage();
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

  // ─── Slash commands ──────────────────────────────────────────────

  private static readonly COMMANDS: Record<string, { description: string; usage?: string }> = {
    '/help':    { description: 'Show available commands' },
    '/new':     { description: 'Clear conversation and start a new session' },
    '/context': { description: 'Open context inspector (view LLM messages, system prompt, tools)' },
    '/model':   { description: 'Show current model and provider info' },
    '/system':  { description: 'Show current system prompt' },
    '/tools':   { description: 'List registered tools' },
    '/yank':    { description: 'Copy last assistant response to clipboard' },
    '/yankall': { description: 'Copy entire conversation to clipboard' },
    '/abort':   { description: 'Abort the current agent run' },
    '/quit':    { description: 'Close the agent tab' },
    '/clear':   { description: 'Clear conversation display (alias for /new)' },
  };

  private handleSlashCommand(text: string): boolean {
    const parts = text.split(/\s+/);
    const cmd = parts[0].toLowerCase();

    switch (cmd) {
      case '/help':
        this.showSystemMessage(this.formatHelp());
        return true;

      case '/new':
      case '/clear':
        this.newSession();
        this.showSystemMessage('Session cleared.');
        return true;

      case '/context':
        this.enterContextState();
        return true;

      case '/model': {
        const ctx = this.controller.getContext();
        if (ctx) {
          this.showSystemMessage(
            `Model: ${ctx.model}\nThinking: ${ctx.thinkingLevel}\nMessages: ${ctx.messageCount}\nStreaming: ${ctx.isStreaming ? 'yes' : 'no'}`,
          );
        } else {
          this.showSystemMessage('Agent not initialized — submit a prompt first.');
        }
        return true;
      }

      case '/system': {
        const ctx = this.controller.getContext();
        if (ctx) {
          this.showSystemMessage(ctx.systemPrompt);
        } else {
          this.showSystemMessage('Agent not initialized — submit a prompt first.');
        }
        return true;
      }

      case '/tools': {
        const ctx = this.controller.getContext();
        if (ctx && ctx.tools.length > 0) {
          const lines = ctx.tools.map((t) => `  ${t.name} — ${t.description}`);
          this.showSystemMessage(`Registered tools (${ctx.tools.length}):\n${lines.join('\n')}`);
        } else if (ctx) {
          this.showSystemMessage('No tools registered.');
        } else {
          this.showSystemMessage('Agent not initialized — submit a prompt first.');
        }
        return true;
      }

      case '/yank':
        this.yankLastAssistant();
        this.showSystemMessage('Last assistant response copied to clipboard.');
        return true;

      case '/yankall':
        this.yankAll();
        this.showSystemMessage('Full conversation copied to clipboard.');
        return true;

      case '/abort':
        if (this.controller.isRunning) {
          this.controller.abort();
          this.stopSpinner();
          this.promptGlyphEl.textContent = '❯';
          this.inputRowEl.classList.remove('agent-view__input-row--busy');
          this.showSystemMessage('Agent run aborted.');
        } else {
          this.showSystemMessage('Nothing running.');
        }
        return true;

      case '/quit':
        this.closeCallback?.();
        return true;

      default:
        return false;
    }
  }

  private formatHelp(): string {
    const lines: string[] = ['Available commands:'];
    for (const [cmd, info] of Object.entries(AgentView.COMMANDS)) {
      lines.push(`  ${cmd.padEnd(12)} ${info.description}`);
    }
    lines.push('');
    lines.push('Keyboard shortcuts (scroll mode — Escape with empty input):');
    lines.push('  j/k          Scroll lines');
    lines.push('  g/G          Top/bottom');
    lines.push('  y/Y          Yank last/all');
    lines.push('  c            Context inspector');
    lines.push('  q            Close tab');
    lines.push('  i/Escape     Back to input');
    return lines.join('\n');
  }

  private showSystemMessage(text: string): void {
    const msg = document.createElement('div');
    msg.className = 'agent-view__msg agent-view__msg--system';

    const label = document.createElement('span');
    label.className = 'agent-view__msg-label agent-view__msg-label--system';
    label.textContent = 'SYS';

    const body = document.createElement('div');
    body.className = 'agent-view__msg-body agent-view__msg-body--system';
    body.textContent = text;

    msg.appendChild(label);
    msg.appendChild(body);
    this.messagesEl.appendChild(msg);
    this.scrollToBottom();
  }

  // ─── Submit ──────────────────────────────────────────────────────

  private async submit(): Promise<void> {
    const text = this.inputText.trim();
    if (!text) return;

    // Save to history
    if (this.promptHistory[this.promptHistory.length - 1] !== text) {
      this.promptHistory.push(text);
    }
    this.historyIdx = -1;

    // Clear input
    this.inputText = '';
    this.cursorPos = 0;
    this.renderInput();

    // Handle slash commands
    if (text.startsWith('/')) {
      if (this.handleSlashCommand(text)) return;
      // Unknown command — show error
      this.showSystemMessage(`Unknown command: ${text.split(/\s+/)[0]}\nType /help for available commands.`);
      return;
    }

    if (this.controller.isRunning) return;

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
    if (this.state === 'context') {
      return this.handleContextKey(e);
    }
    return this.handleScrollKey(e);
  }

  private handleInputKey(e: KeyboardEvent): boolean {
    // Escape — dismiss autocomplete first, then scroll state
    if (e.key === 'Escape') {
      if (this.acMatches.length > 0) {
        this.hideAutocomplete();
        return true;
      }
      if (this.inputText === '') {
        this.enterScrollState();
        return true;
      }
      return true;
    }

    // Tab — accept autocomplete or cycle
    if (e.key === 'Tab' && this.acMatches.length > 0) {
      if (e.shiftKey) {
        this.acSelectedIdx = (this.acSelectedIdx - 1 + this.acMatches.length) % this.acMatches.length;
        this.updateAutocomplete();
      } else {
        this.acceptAutocomplete();
      }
      return true;
    }

    // Arrow Up/Down navigate autocomplete when visible
    if (e.key === 'ArrowUp' && this.acMatches.length > 0) {
      this.acSelectedIdx = Math.max(0, this.acSelectedIdx - 1);
      this.updateAutocomplete();
      return true;
    }
    if (e.key === 'ArrowDown' && this.acMatches.length > 0) {
      this.acSelectedIdx = Math.min(this.acMatches.length - 1, this.acSelectedIdx + 1);
      this.updateAutocomplete();
      return true;
    }

    // Submit — accept autocomplete if visible, otherwise submit prompt
    if (e.key === 'Enter' && !e.shiftKey && !e.ctrlKey && !e.altKey && !e.metaKey) {
      if (this.acMatches.length > 0) {
        this.acceptAutocomplete();
        return true;
      }
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

    // c — context inspector
    if (e.key === 'c' && !e.ctrlKey && !e.metaKey && !e.altKey) {
      this.enterContextState();
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

  // ─── Context inspector ──────────────────────────────────────────

  // Track which state we came from so Escape returns correctly
  private preContextState: 'input' | 'scroll' = 'scroll';

  private enterContextState(): void {
    this.preContextState = this.state === 'input' ? 'input' : 'scroll';
    this.state = 'context';
    this.contextSelectedIdx = 0;
    this.messagesEl.classList.add('agent-view__messages--hidden');
    this.contextPanelEl.classList.add('agent-view__context-panel--visible');
    this.stateHintEl.classList.add('agent-view__state-hint--visible');
    this.stateHintEl.textContent = 'CONTEXT  j/k navigate  Enter expand  y yank  Escape back';
    this.inputRowEl.classList.add('agent-view__input-row--hidden');
    this.renderContextPanel();
  }

  private exitContextState(): void {
    this.messagesEl.classList.remove('agent-view__messages--hidden');
    this.contextPanelEl.classList.remove('agent-view__context-panel--visible');
    this.contextPanelEl.innerHTML = '';

    // Restore scroll position (display:none resets scrollTop)
    if (this.savedScrollTop > 0) {
      requestAnimationFrame(() => {
        this.messagesEl.scrollTop = this.savedScrollTop;
      });
    }

    // Return to the state we came from
    if (this.preContextState === 'input') {
      this.state = 'input';
      this.element.classList.remove('agent-view--scroll');
      this.inputRowEl.classList.remove('agent-view__input-row--hidden');
      this.stateHintEl.classList.remove('agent-view__state-hint--visible');
    } else {
      this.state = 'scroll';
      this.stateHintEl.textContent = 'SCROLL  g/G top/bot  j/k lines  y yank  c context  i insert';
    }
  }

  private handleContextKey(e: KeyboardEvent): boolean {
    if (e.key === 'Escape') {
      this.exitContextState();
      return true;
    }

    // Navigate message list
    if (e.key === 'j' || e.key === 'ArrowDown') {
      this.contextNavigate(1);
      return true;
    }
    if (e.key === 'k' || e.key === 'ArrowUp') {
      this.contextNavigate(-1);
      return true;
    }

    // Jump to top/bottom
    if (e.key === 'g' && !e.shiftKey) {
      this.contextSelectedIdx = 0;
      this.renderContextPanel();
      return true;
    }
    if (e.key === 'G' || (e.key === 'g' && e.shiftKey)) {
      const ctx = this.controller.getContext();
      if (ctx) {
        // +2 for system prompt row and tools row
        this.contextSelectedIdx = ctx.messageCount + 1;
      }
      this.renderContextPanel();
      return true;
    }

    // Expand selected message
    if (e.key === 'Enter') {
      this.contextExpandSelected();
      return true;
    }

    // Yank selected message raw JSON
    if (e.key === 'y') {
      this.contextYankSelected();
      return true;
    }

    // Half-page scroll
    if (e.key === 'PageDown' || (e.code === 'KeyD' && e.ctrlKey)) {
      this.contextPanelEl.scrollBy({ top: this.contextPanelEl.clientHeight * 0.4, behavior: 'instant' });
      return true;
    }
    if (e.key === 'PageUp' || (e.code === 'KeyU' && e.ctrlKey)) {
      this.contextPanelEl.scrollBy({ top: -this.contextPanelEl.clientHeight * 0.4, behavior: 'instant' });
      return true;
    }

    return true; // consume all keys in context mode
  }

  private contextNavigate(delta: number): void {
    const ctx = this.controller.getContext();
    if (!ctx) return;
    // Total rows: 1 (system prompt) + messages.length + 1 (tools)
    const maxIdx = ctx.messageCount + 1;
    this.contextSelectedIdx = Math.max(0, Math.min(maxIdx, this.contextSelectedIdx + delta));
    this.renderContextPanel();

    // Scroll selected row into view
    const selected = this.contextPanelEl.querySelector('.agent-view__ctx-row--selected');
    selected?.scrollIntoView({ block: 'nearest' });
  }

  private renderContextPanel(): void {
    const ctx = this.controller.getContext();
    this.contextPanelEl.innerHTML = '';

    if (!ctx) {
      this.contextPanelEl.textContent = 'Agent not initialized — submit a prompt first.';
      return;
    }

    // Header
    const header = document.createElement('div');
    header.className = 'agent-view__ctx-header';
    header.innerHTML =
      `<span class="agent-view__ctx-label">MODEL</span> ${escHtml(ctx.model)}` +
      `  <span class="agent-view__ctx-label">THINKING</span> ${escHtml(ctx.thinkingLevel)}` +
      `  <span class="agent-view__ctx-label">MSGS</span> ${ctx.messageCount}` +
      `  <span class="agent-view__ctx-label">STREAMING</span> ${ctx.isStreaming ? 'yes' : 'no'}`;
    this.contextPanelEl.appendChild(header);

    // System prompt row (index 0)
    const sysRow = this.createContextRow(
      0,
      'system',
      ['text'],
      ctx.systemPrompt.length,
      `${ctx.systemPrompt.slice(0, 80)}${ctx.systemPrompt.length > 80 ? '…' : ''}`,
    );
    this.contextPanelEl.appendChild(sysRow);

    // Message rows
    for (const msg of ctx.messages) {
      const rowIdx = msg.index + 1; // offset by 1 for system prompt row
      const summary = this.summarizeMessage(msg);
      const row = this.createContextRow(
        rowIdx,
        msg.role,
        msg.contentTypes,
        msg.textLength,
        summary,
      );
      if (msg.errorMessage) row.classList.add('agent-view__ctx-row--error');
      if (msg.stopReason) {
        const badge = document.createElement('span');
        badge.className = 'agent-view__ctx-badge';
        badge.textContent = msg.stopReason;
        row.appendChild(badge);
      }
      this.contextPanelEl.appendChild(row);
    }

    // Tools row (last)
    const toolsIdx = ctx.messageCount + 1;
    const toolNames = ctx.tools.map((t) => t.name).join(', ');
    const toolsRow = this.createContextRow(
      toolsIdx,
      'tools',
      [],
      0,
      `${ctx.tools.length} tools: ${toolNames}`,
    );
    this.contextPanelEl.appendChild(toolsRow);
  }

  private createContextRow(
    idx: number,
    role: string,
    types: string[],
    textLen: number,
    summary: string,
  ): HTMLElement {
    const row = document.createElement('div');
    row.className = 'agent-view__ctx-row';
    if (idx === this.contextSelectedIdx) row.classList.add('agent-view__ctx-row--selected');

    const idxEl = document.createElement('span');
    idxEl.className = 'agent-view__ctx-idx';
    idxEl.textContent = String(idx);

    const roleEl = document.createElement('span');
    roleEl.className = `agent-view__ctx-role agent-view__ctx-role--${role}`;
    roleEl.textContent = role;

    const typesEl = document.createElement('span');
    typesEl.className = 'agent-view__ctx-types';
    typesEl.textContent = types.join(', ');

    const lenEl = document.createElement('span');
    lenEl.className = 'agent-view__ctx-len';
    lenEl.textContent = textLen > 0 ? `${textLen}ch` : '';

    const sumEl = document.createElement('span');
    sumEl.className = 'agent-view__ctx-summary';
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

  private contextExpandSelected(): void {
    const ctx = this.controller.getContext();
    if (!ctx) return;

    let rawContent: unknown;
    if (this.contextSelectedIdx === 0) {
      rawContent = ctx.systemPrompt;
    } else if (this.contextSelectedIdx <= ctx.messageCount) {
      rawContent = ctx.messages[this.contextSelectedIdx - 1].raw;
    } else {
      rawContent = ctx.tools;
    }

    // Toggle: if there's already an expanded block, remove it
    const existing = this.contextPanelEl.querySelector('.agent-view__ctx-expanded');
    if (existing) {
      existing.remove();
      return;
    }

    // Find the selected row and insert expanded content after it
    const rows = this.contextPanelEl.querySelectorAll('.agent-view__ctx-row');
    const selectedRow = rows[this.contextSelectedIdx];
    if (!selectedRow) return;

    const expanded = document.createElement('pre');
    expanded.className = 'agent-view__ctx-expanded';
    expanded.textContent = typeof rawContent === 'string'
      ? rawContent
      : JSON.stringify(rawContent, null, 2);
    selectedRow.after(expanded);

    expanded.scrollIntoView({ block: 'nearest' });
  }

  private contextYankSelected(): void {
    const ctx = this.controller.getContext();
    if (!ctx) return;

    let rawContent: unknown;
    if (this.contextSelectedIdx === 0) {
      rawContent = ctx.systemPrompt;
    } else if (this.contextSelectedIdx <= ctx.messageCount) {
      rawContent = ctx.messages[this.contextSelectedIdx - 1].raw;
    } else {
      rawContent = ctx.tools;
    }

    const text = typeof rawContent === 'string'
      ? rawContent
      : JSON.stringify(rawContent, null, 2);
    navigator.clipboard.writeText(text).catch(() => {});
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
    // Restore scroll position after tab switch (DOM reflow resets scrollTop to 0)
    if (this.savedScrollTop > 0) {
      this.messagesEl.scrollTop = this.savedScrollTop;
    }
  }

  dispose(): void {
    this.controller.abort();
    this.stopSpinner();
    this.saveCurrentSession();
  }
}
