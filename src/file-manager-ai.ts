// Krypton — File Manager AI Overlay
// Inline AI assistant for the file manager. Provides context-aware
// file operations (ACT mode) and file Q&A (ASK mode).
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

/** Minimal file entry info for context injection */
export interface FileContextEntry {
  name: string;
  path: string;
  is_dir: boolean;
  size: number;
}

/** Context snapshot from the file manager */
export interface FileManagerContext {
  cwd: string;
  cursorFile: FileContextEntry | null;
  markedFiles: FileContextEntry[];
  totalEntries: number;
}

type AIPhase = 'input' | 'loading' | 'result';

const ACT_SYSTEM_PROMPT = `You are a file management AI assistant inside Krypton terminal's file browser.
You have tools to read files, write files, and run shell commands.

You are in ACT mode: perform file operations (rename, move, copy, delete, organize, generate, transform).
Execute operations using your tools, then report what you did concisely.

RULES:
- Always use absolute paths derived from the working directory.
- After modifying files, briefly list what changed.
- Be concise — 1-5 sentences max.
- Never ask follow-up questions. Make your best judgment.
- NEVER use tools unless the user asks you to do something that requires them.`;

const ASK_SYSTEM_PROMPT = `You are a file management AI assistant inside Krypton terminal's file browser.
You have tools to read files, write files, and run shell commands.

You are in ASK mode: answer questions about files, explain code, summarize contents.
Read relevant files using your tools, then answer concisely.

RULES:
- Always use absolute paths derived from the working directory.
- Be concise — 1-5 sentences max unless more detail is needed.
- Never ask follow-up questions. Make your best judgment.
- Use the read_file tool to examine file contents when needed.`;

/** Persists the user's last selected mode across overlay lifetimes */
let lastAskMode = false;

const MAX_CONTEXT_MARKED = 50;

export class FileManagerAI {
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
  private getContext: () => FileManagerContext;
  private onDone: () => void;
  private onCloseCallback: () => void;

  constructor(opts: {
    cwd: string;
    getContext: () => FileManagerContext;
    onDone: () => void;
    onClose: () => void;
  }) {
    this.getContext = opts.getContext;
    this.onDone = opts.onDone;
    this.onCloseCallback = opts.onClose;

    // Lightweight disposable controller
    this.controller = new AgentController();
    this.controller.setProjectDir(opts.cwd);

    // ── Build DOM ──────────────────────────────────────────
    this.el = document.createElement('div');
    this.el.className = 'krypton-file-manager-ai';

    // Input row
    const inputRow = document.createElement('div');
    inputRow.className = 'krypton-file-manager-ai__input-row';

    this.promptEl = document.createElement('span');
    this.promptEl.className = 'krypton-file-manager-ai__prompt';
    this.updatePromptLabel();

    this.modeEl = document.createElement('span');
    this.modeEl.className = 'krypton-file-manager-ai__mode';
    this.updateModeLabel();

    this.inputEl = document.createElement('input');
    this.inputEl.className = 'krypton-file-manager-ai__input';
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
    this.resultEl.className = 'krypton-file-manager-ai__result';
    this.resultEl.hidden = true;

    this.responseEl = document.createElement('div');
    this.responseEl.className = 'krypton-file-manager-ai__response';
    this.resultEl.appendChild(this.responseEl);
    this.el.appendChild(this.resultEl);

    // Spinner
    this.spinnerEl = document.createElement('div');
    this.spinnerEl.className = 'krypton-file-manager-ai__spinner';
    this.spinnerEl.hidden = true;
    const dots = document.createElement('span');
    dots.className = 'krypton-file-manager-ai__dots';
    dots.textContent = '\u25cf \u25cf \u25cf';
    this.spinnerEl.appendChild(dots);
    this.el.appendChild(this.spinnerEl);

    // Hint bar
    this.hintEl = document.createElement('div');
    this.hintEl.className = 'krypton-file-manager-ai__hint';
    this.updateHint();
    this.el.appendChild(this.hintEl);
  }

  /** Attach to parent and focus input */
  open(parent: HTMLElement): void {
    parent.appendChild(this.el);
    requestAnimationFrame(() => {
      this.el.classList.add('krypton-file-manager-ai--visible');
      this.inputEl.focus();
    });
  }

  /** Remove from DOM and abort any running agent */
  close(): void {
    if (this.controller.isRunning) {
      this.controller.abort();
    }
    this.el.classList.remove('krypton-file-manager-ai--visible');
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
      // Ensure input has focus (compositor may have stolen it).
      // If focus was elsewhere, manually forward the character since
      // the current event won't reach the <input> naturally.
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
      this.promptEl.classList.add('krypton-file-manager-ai__prompt--ask');
    } else {
      this.promptEl.textContent = 'ACT \u25b8';
      this.promptEl.classList.remove('krypton-file-manager-ai__prompt--ask');
    }
  }

  private updateModeLabel(): void {
    this.modeEl.textContent = this.askMode ? '\u21e5 act' : '\u21e5 ask';
  }

  private updatePlaceholder(): void {
    this.inputEl.placeholder = this.askMode
      ? 'Ask about files...'
      : 'What should I do with these files?';
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

  /** Build the context string from file manager state */
  private buildContextPrefix(): string {
    const ctx = this.getContext();
    const lines: string[] = [`Working directory: ${ctx.cwd}`];

    if (ctx.cursorFile) {
      const kind = ctx.cursorFile.is_dir ? 'directory' : 'file';
      const size = ctx.cursorFile.is_dir ? '' : `, ${this.formatSize(ctx.cursorFile.size)}`;
      lines.push(`Current file: ${ctx.cursorFile.name} (${kind}${size})`);
    }

    if (ctx.markedFiles.length > 0) {
      const shown = ctx.markedFiles.slice(0, MAX_CONTEXT_MARKED);
      lines.push(`Marked files (${ctx.markedFiles.length}):`);
      for (const f of shown) {
        const kind = f.is_dir ? 'directory' : 'file';
        const size = f.is_dir ? '' : `, ${this.formatSize(f.size)}`;
        lines.push(`  - ${f.name} (${kind}${size})`);
      }
      if (ctx.markedFiles.length > MAX_CONTEXT_MARKED) {
        lines.push(`  (and ${ctx.markedFiles.length - MAX_CONTEXT_MARKED} more)`);
      }
    }

    return lines.join('\n');
  }

  private formatSize(bytes: number): string {
    if (bytes < 1024) return `${bytes}B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}K`;
    if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)}M`;
    return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)}G`;
  }

  private async submit(query: string): Promise<void> {
    this.phase = 'loading';
    this.inputEl.readOnly = true;
    this.spinnerEl.hidden = false;
    this.resultEl.hidden = true;
    this.updateHint();

    const dots = this.spinnerEl.querySelector('.krypton-file-manager-ai__dots') as HTMLElement;
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

    // Refresh the directory listing after AI operations
    this.onDone();
  }

  private onError(message: string): void {
    this.phase = 'result';
    this.spinnerEl.hidden = true;
    this.resultEl.hidden = false;
    this.inputEl.readOnly = false;
    this.responseEl.textContent = '';
    this.responseEl.innerHTML = `<span class="krypton-file-manager-ai__error">${this.escapeHtml(message)}</span>`;
    this.hintEl.textContent = '\u238b dismiss';
  }

  private escapeHtml(s: string): string {
    return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }
}
