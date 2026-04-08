// Krypton — Markdown Viewer AI Overlay
// Inline AI assistant for the markdown viewer. Provides context-aware
// document Q&A (ASK mode) and editing (ACT mode).
// Uses a lightweight, disposable AgentController per session.

import { Marked } from 'marked';
import { markedHighlight } from 'marked-highlight';
import hljs from 'highlight.js';

import { AgentController } from './agent/agent';
import type { AgentEventCallback } from './agent/agent';

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

/** Context snapshot from the markdown viewer */
export interface MarkdownViewContext {
  cwd: string;
  currentFile: string | null;
  selectedText: string | null;
}

type AIPhase = 'input' | 'loading' | 'result';

const ACT_SYSTEM_PROMPT = `You are a documentation AI assistant inside Krypton terminal's markdown viewer.
You have tools to read files, write files, and run shell commands.

You are in ACT mode: edit or transform the document. Rewrite sections, fix formatting, add content, restructure, or generate new material.
Execute operations using your tools, then report what you did concisely.

RULES:
- Always use absolute paths derived from the working directory.
- After modifying files, briefly list what changed.
- Be concise — 1-5 sentences max.
- Never ask follow-up questions. Make your best judgment.
- NEVER use tools unless the user asks you to do something that requires them.`;

const ASK_SYSTEM_PROMPT = `You are a documentation AI assistant inside Krypton terminal's markdown viewer.
You have tools to read files, write files, and run shell commands.

You are in ASK mode: answer questions about the document, explain sections, summarize content, clarify concepts.
Read relevant files using your tools, then answer concisely.

RULES:
- Always use absolute paths derived from the working directory.
- Be concise — 1-5 sentences max unless more detail is needed.
- Use markdown formatting (headings, lists, code blocks) for readability.
- Never ask follow-up questions. Make your best judgment.
- Use the read_file tool to examine file contents when needed.`;

/** Persists the user's last selected mode across overlay lifetimes */
let lastAskMode = true; // Default to ASK for docs viewer

export class MarkdownViewAI {
  private el: HTMLElement;
  private inputEl: HTMLInputElement;
  private resultEl: HTMLElement;
  private responseEl: HTMLElement;
  private spinnerEl: HTMLElement;
  private hintEl: HTMLElement;
  private promptEl: HTMLElement;
  private modeEl: HTMLElement;

  private phase: AIPhase = 'input';
  private askMode = lastAskMode;
  private controller: AgentController;
  private getContext: () => MarkdownViewContext;
  private onCloseCallback: () => void;

  constructor(opts: {
    cwd: string;
    getContext: () => MarkdownViewContext;
    onClose: () => void;
  }) {
    this.getContext = opts.getContext;
    this.onCloseCallback = opts.onClose;

    // Lightweight disposable controller
    this.controller = new AgentController();
    this.controller.setProjectDir(opts.cwd);

    // ── Build DOM ──────────────────────────────────────────
    this.el = document.createElement('div');
    this.el.className = 'krypton-md-ai';

    // Input row
    const inputRow = document.createElement('div');
    inputRow.className = 'krypton-md-ai__input-row';

    this.promptEl = document.createElement('span');
    this.promptEl.className = 'krypton-md-ai__prompt';
    this.updatePromptLabel();

    this.modeEl = document.createElement('span');
    this.modeEl.className = 'krypton-md-ai__mode';
    this.updateModeLabel();

    this.inputEl = document.createElement('input');
    this.inputEl.className = 'krypton-md-ai__input';
    this.inputEl.type = 'text';
    this.inputEl.spellcheck = false;
    this.inputEl.autocomplete = 'off';
    this.updatePlaceholder();

    inputRow.appendChild(this.promptEl);
    inputRow.appendChild(this.inputEl);
    inputRow.appendChild(this.modeEl);
    this.el.appendChild(inputRow);

    // Result area (hidden initially)
    this.resultEl = document.createElement('div');
    this.resultEl.className = 'krypton-md-ai__result';
    this.resultEl.hidden = true;

    this.responseEl = document.createElement('div');
    this.responseEl.className = 'krypton-md-ai__response';
    this.resultEl.appendChild(this.responseEl);
    this.el.appendChild(this.resultEl);

    // Spinner
    this.spinnerEl = document.createElement('div');
    this.spinnerEl.className = 'krypton-md-ai__spinner';
    this.spinnerEl.hidden = true;
    const dots = document.createElement('span');
    dots.className = 'krypton-md-ai__dots';
    dots.textContent = '\u25cf \u25cf \u25cf';
    this.spinnerEl.appendChild(dots);
    this.el.appendChild(this.spinnerEl);

    // Hint bar
    this.hintEl = document.createElement('div');
    this.hintEl.className = 'krypton-md-ai__hint';
    this.updateHint();
    this.el.appendChild(this.hintEl);
  }

  /** Attach to parent and focus input */
  open(parent: HTMLElement): void {
    parent.appendChild(this.el);
    requestAnimationFrame(() => {
      this.el.classList.add('krypton-md-ai--visible');
      this.inputEl.focus();
    });
  }

  /** Remove from DOM and abort any running agent */
  close(): void {
    if (this.controller.isRunning) {
      this.controller.abort();
    }
    this.el.classList.remove('krypton-md-ai--visible');
    this.el.remove();
  }

  /** Handle keyboard events. Returns true if consumed. */
  onKeyDown(e: KeyboardEvent): boolean {
    if (e.key === 'Escape') {
      if (this.controller.isRunning) {
        this.controller.abort();
      }
      this.onCloseCallback();
      return true;
    }

    if (this.phase === 'input') {
      if (e.key === 'Enter') {
        e.preventDefault();
        const query = this.inputEl.value.trim();
        if (query) this.submit(query);
        return true;
      }
      if (e.key === 'Tab') {
        e.preventDefault();
        this.toggleMode();
        return true;
      }
      // Ensure input has focus
      if (document.activeElement !== this.inputEl) {
        this.inputEl.focus();
        if (e.key.length === 1 && !e.ctrlKey && !e.metaKey) {
          this.inputEl.value += e.key;
          return true;
        }
      }
      // Let typing keys flow to the <input>
      return false;
    }

    if (this.phase === 'loading') {
      return true; // Only Escape (handled above) during loading
    }

    if (this.phase === 'result') {
      // Cmd+C — copy response
      if ((e.key === 'c' || e.code === 'KeyC') && e.metaKey && !e.ctrlKey && !e.altKey && !e.shiftKey) {
        e.preventDefault();
        e.stopPropagation();
        const text = this.responseEl.textContent ?? '';
        navigator.clipboard.writeText(text).catch(() => {});
        return true;
      }

      if (e.key === 'Enter' || e.key === 'Tab') {
        e.preventDefault();
        this.resetToInput();
        return true;
      }
      return true;
    }

    return false;
  }

  // ── Private ────────────────────────────────────────────────────────

  private toggleMode(): void {
    this.askMode = !this.askMode;
    lastAskMode = this.askMode;
    this.updatePromptLabel();
    this.updateModeLabel();
    this.updatePlaceholder();
    this.updateHint();
    this.inputEl.focus();
  }

  private updatePromptLabel(): void {
    if (this.askMode) {
      this.promptEl.textContent = 'ASK \u25b8';
      this.promptEl.classList.add('krypton-md-ai__prompt--ask');
    } else {
      this.promptEl.textContent = 'ACT \u25b8';
      this.promptEl.classList.remove('krypton-md-ai__prompt--ask');
    }
  }

  private updateModeLabel(): void {
    this.modeEl.textContent = this.askMode ? '\u21e5 act' : '\u21e5 ask';
  }

  private updatePlaceholder(): void {
    this.inputEl.placeholder = this.askMode
      ? 'Ask about this document...'
      : 'Edit or transform this document...';
  }

  private updateHint(): void {
    if (this.phase === 'loading') {
      this.hintEl.textContent = '\u238b cancel';
      return;
    }
    if (this.phase === 'result') {
      this.hintEl.textContent = '\u21b5 again \u00b7 \u2318C copy \u00b7 \u238b dismiss';
      return;
    }
    this.hintEl.textContent = this.askMode
      ? '\u21b5 submit \u00b7 \u21e5 act \u00b7 \u238b dismiss'
      : '\u21b5 submit \u00b7 \u21e5 ask \u00b7 \u238b dismiss';
  }

  private resetToInput(): void {
    this.resultEl.hidden = true;
    this.responseEl.textContent = '';
    this.responseEl.innerHTML = '';
    this.phase = 'input';
    this.inputEl.value = '';
    this.inputEl.readOnly = false;
    this.updateHint();
    this.inputEl.focus();
  }

  /** Build the context string from markdown viewer state */
  private buildContextPrefix(): string {
    const ctx = this.getContext();
    const lines: string[] = [`Working directory: ${ctx.cwd}`];

    if (ctx.currentFile) {
      lines.push(`Current document: ${ctx.currentFile}`);
    }

    if (ctx.selectedText) {
      lines.push(`\nSelected text:\n\`\`\`markdown\n${ctx.selectedText}\n\`\`\``);
    }

    return lines.join('\n');
  }

  private async submit(query: string): Promise<void> {
    this.phase = 'loading';
    this.inputEl.readOnly = true;
    this.spinnerEl.hidden = false;
    this.resultEl.hidden = true;
    this.updateHint();

    const dots = this.spinnerEl.querySelector('.krypton-md-ai__dots') as HTMLElement;
    if (dots) dots.textContent = 'Initializing...';

    // Set system prompt for the mode
    this.controller.setInlineSystemPrompt(
      this.askMode ? ASK_SYSTEM_PROMPT : ACT_SYSTEM_PROMPT,
    );

    // Build contextual prompt
    const contextPrefix = this.buildContextPrefix();
    const fullPrompt = `${contextPrefix}\n\nUser request: ${query}`;

    let latestResponse = '';
    let usedTools = false;

    const onEvent: AgentEventCallback = (e) => {
      switch (e.type) {
        case 'agent_start':
          if (dots) dots.textContent = 'Thinking...';
          break;

        case 'message_update':
          if (usedTools) {
            latestResponse = '';
            usedTools = false;
          }
          latestResponse += e.delta;
          this.spinnerEl.hidden = true;
          if (this.resultEl.hidden && latestResponse.length > 0) {
            this.resultEl.hidden = false;
          }
          this.responseEl.innerHTML = md.parse(latestResponse.trim()) as string;
          break;

        case 'tool_start':
          this.resultEl.hidden = true;
          this.responseEl.innerHTML = '';
          if (dots) dots.textContent = `Running ${e.name}...`;
          this.spinnerEl.hidden = false;
          usedTools = true;
          break;

        case 'tool_end':
          if (dots) dots.textContent = 'Thinking...';
          break;

        case 'agent_end':
          this.spinnerEl.hidden = true;
          this.onComplete();
          break;

        case 'error':
          this.onError(e.message);
          break;
      }
    };

    try {
      await this.controller.prompt(fullPrompt, onEvent);
    } catch (err) {
      this.onError(String(err));
    }
  }

  private onComplete(): void {
    this.phase = 'result';
    this.spinnerEl.hidden = true;
    this.resultEl.hidden = false;
    this.inputEl.readOnly = false;
    this.updateHint();
  }

  private onError(message: string): void {
    this.phase = 'result';
    this.spinnerEl.hidden = true;
    this.resultEl.hidden = false;
    this.inputEl.readOnly = false;
    this.responseEl.textContent = '';
    this.responseEl.innerHTML = `<span class="krypton-md-ai__error">${this.escapeHtml(message)}</span>`;
    this.hintEl.textContent = '\u238b dismiss';
  }

  private escapeHtml(s: string): string {
    return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }
}
