// Krypton — Inline AI Overlay
// Warp-style command suggestion overlay triggered by Cmd+K.
// Floats inside the focused terminal window, sends natural language
// queries to the AgentController, and streams command suggestions.

import { AgentController } from './agent/agent';
import type { AgentEventCallback } from './agent/agent';
import { invoke } from './profiler/ipc';

/** Callback to write a string into the focused PTY */
type WriteCallback = (data: string) => void;
/** Callback to close the overlay and return to Normal mode */
type CloseCallback = () => void;

// ── Glitch-decode animation (borrowed from NotificationController) ────

const GLYPH_SET = 'アイウエオカキクケコサシスセソタチツテトナニヌネノハヒフヘホマミムメモヤユヨラリルレロワヲン０１２３４５６７８９';
const DECODE_FPS = 40;
const DECODE_BASE_CHANCE = 0.10;
const DECODE_POSITION_BIAS = 0.04;

function decodeReveal(el: HTMLElement, finalText: string): number {
  const len = finalText.length;
  if (len === 0) { el.textContent = ''; return 0; }

  const locked = new Uint8Array(len);
  const heat = new Float32Array(len);
  let resolved = 0;

  for (let i = 0; i < len; i++) {
    if (finalText[i] === ' ') { locked[i] = 1; resolved++; }
  }

  let buf = '';
  for (let i = 0; i < len; i++) {
    buf += locked[i] ? finalText[i] : GLYPH_SET[Math.floor(Math.random() * GLYPH_SET.length)];
  }
  el.textContent = buf;

  const interval = setInterval(() => {
    let out = '';
    for (let i = 0; i < len; i++) {
      if (locked[i]) { out += finalText[i]; continue; }
      const posFactor = 1 - (i / len) * DECODE_POSITION_BIAS * 10;
      const neighbourBoost = (i > 0 && locked[i - 1]) ? 0.06 : 0;
      heat[i] += (DECODE_BASE_CHANCE * posFactor + neighbourBoost) * (0.7 + Math.random() * 0.6);
      if (heat[i] >= 1.0) {
        locked[i] = 1; resolved++; out += finalText[i];
      } else if (heat[i] > 0.7) {
        out += Math.random() < 0.5 ? finalText[i] : GLYPH_SET[Math.floor(Math.random() * GLYPH_SET.length)];
      } else {
        out += GLYPH_SET[Math.floor(Math.random() * GLYPH_SET.length)];
      }
    }
    el.textContent = out;
    if (resolved >= len) {
      clearInterval(interval);
      el.textContent = finalText;
    }
  }, 1000 / DECODE_FPS);

  return interval as unknown as number;
}

// ── InlineAIOverlay ───────────────────────────────────────────────────

type Phase = 'input' | 'loading' | 'result';

/** Persists the user's last selected mode across overlay lifetimes */
let lastAskMode = false;

export class InlineAIOverlay {
  private el: HTMLElement;
  private inputEl: HTMLInputElement;
  private resultEl: HTMLElement;
  private commandEl: HTMLElement;
  private explainEl: HTMLElement;
  private spinnerEl: HTMLElement;
  private hintEl: HTMLElement;
  private phase: Phase = 'input';
  private askMode = lastAskMode;
  private command = '';
  private answer = '';      // full text answer in ask mode
  private explanation = '';
  private controller: AgentController;
  private writePty: WriteCallback;
  private onClose: CloseCallback;
  private decodeTimer: number | null = null;
  private sessionId: number | null;
  private promptEl: HTMLElement = null!;
  private modeEl: HTMLElement = null!;

  constructor(
    controller: AgentController,
    writePty: WriteCallback,
    onClose: CloseCallback,
    sessionId: number | null,
  ) {
    this.controller = controller;
    this.writePty = writePty;
    this.onClose = onClose;
    this.sessionId = sessionId;

    // ── Build DOM ──────────────────────────────────────────────
    this.el = document.createElement('div');
    this.el.className = 'krypton-inline-ai';

    // Input row
    const inputRow = document.createElement('div');
    inputRow.className = 'krypton-inline-ai__input-row';

    this.promptEl = document.createElement('span');
    this.promptEl.className = 'krypton-inline-ai__prompt';
    this.promptEl.textContent = this.askMode ? 'ASK \u25b8' : 'CMD \u25b8';
    if (this.askMode) this.promptEl.classList.add('krypton-inline-ai__prompt--ask');

    this.modeEl = document.createElement('span');
    this.modeEl.className = 'krypton-inline-ai__mode';
    this.modeEl.textContent = this.askMode ? '\u21e5 cmd' : '\u21e5 ask';

    this.inputEl = document.createElement('input');
    this.inputEl.className = 'krypton-inline-ai__input';
    this.inputEl.type = 'text';
    this.inputEl.placeholder = this.askMode ? 'Ask a question...' : 'Describe a command...';
    this.inputEl.spellcheck = false;
    this.inputEl.autocomplete = 'off';

    inputRow.appendChild(this.promptEl);
    inputRow.appendChild(this.inputEl);
    inputRow.appendChild(this.modeEl);
    this.el.appendChild(inputRow);

    // Result area (hidden initially)
    this.resultEl = document.createElement('div');
    this.resultEl.className = 'krypton-inline-ai__result';
    this.resultEl.hidden = true;

    this.commandEl = document.createElement('pre');
    this.commandEl.className = 'krypton-inline-ai__command';

    this.explainEl = document.createElement('span');
    this.explainEl.className = 'krypton-inline-ai__explain';

    this.resultEl.appendChild(this.commandEl);
    this.resultEl.appendChild(this.explainEl);
    this.el.appendChild(this.resultEl);

    // Spinner (hidden initially)
    this.spinnerEl = document.createElement('div');
    this.spinnerEl.className = 'krypton-inline-ai__spinner';
    this.spinnerEl.hidden = true;

    const dots = document.createElement('span');
    dots.className = 'krypton-inline-ai__dots';
    dots.textContent = '\u25cf \u25cf \u25cf';
    this.spinnerEl.appendChild(dots);
    this.el.appendChild(this.spinnerEl);

    // Hint bar
    this.hintEl = document.createElement('div');
    this.hintEl.className = 'krypton-inline-ai__hint';
    this.hintEl.textContent = this.askMode
      ? '\u21b5 submit \u00b7 \u21e5 cmd \u00b7 \u238b dismiss'
      : '\u21b5 submit \u00b7 \u21e5 ask \u00b7 \u238b dismiss';
    this.el.appendChild(this.hintEl);
  }

  /** Attach overlay to a window's content element and focus input */
  open(contentEl: HTMLElement): void {
    contentEl.appendChild(this.el);
    // Trigger entrance animation
    requestAnimationFrame(() => {
      this.el.classList.add('krypton-inline-ai--visible');
      this.inputEl.focus();
    });
  }

  /** Remove overlay from DOM */
  close(): void {
    if (this.decodeTimer !== null) {
      clearInterval(this.decodeTimer);
      this.decodeTimer = null;
    }
    if (this.controller.isRunning) {
      this.controller.abort();
    }
    this.el.classList.remove('krypton-inline-ai--visible');
    this.el.remove();
  }

  /** Handle keyboard events while overlay is open. Returns true if consumed. */
  onKeyDown(e: KeyboardEvent): boolean {
    // Escape always closes
    if (e.key === 'Escape') {
      this.onClose();
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
      // Let all other keys flow to the <input> element
      return false;
    }

    if (this.phase === 'loading') {
      // Only escape (handled above) during loading
      return true;
    }

    if (this.phase === 'result') {
      // Cmd+C — copy to clipboard (check using code for reliability)
      if ((e.key === 'c' || e.code === 'KeyC') && e.metaKey && !e.ctrlKey && !e.altKey && !e.shiftKey) {
        e.preventDefault();
        e.stopPropagation();
        const textToCopy = this.askMode ? this.answer : this.command;
        navigator.clipboard.writeText(textToCopy).catch((err) => {
          console.error('[InlineAI] Failed to copy to clipboard:', err);
        });
        return true;
      }

      if (this.askMode) {
        // Ask mode — allow continuous questions
        if (e.key === 'Enter' || e.key === 'Tab') {
          // Return to input for next question
          e.preventDefault();
          this.resetToInput();
          return true;
        }
        return true;
      }

      // Command mode
      if (e.key === 'Enter' && !e.shiftKey) {
        // Accept — insert command into terminal (no execute)
        e.preventDefault();
        this.writePty(this.command);
        this.onClose();
        return true;
      }
      if (e.key === 'Enter' && e.shiftKey) {
        // Accept and execute
        e.preventDefault();
        this.writePty(this.command + '\n');
        this.onClose();
        return true;
      }
      if (e.key === 'Tab') {
        // Edit the suggestion — put it back in the input
        e.preventDefault();
        this.inputEl.value = this.command;
        this.resultEl.hidden = true;
        this.phase = 'input';
        this.updateInputHint();
        this.inputEl.focus();
        return true;
      }
      return true;
    }

    return false;
  }

  // ── Private ─────────────────────────────────────────────────────────

  private resetToInput(): void {
    this.resultEl.hidden = true;
    this.commandEl.textContent = '';
    this.explainEl.textContent = '';
    this.explainEl.classList.remove('krypton-inline-ai__explain--error');
    this.commandEl.classList.remove('krypton-inline-ai__command--answer');
    this.commandEl.classList.remove('krypton-inline-ai__command--ready');
    this.phase = 'input';
    this.inputEl.value = '';
    this.inputEl.readOnly = false;
    this.updateInputHint();
    this.inputEl.focus();
  }

  private toggleMode(): void {
    this.askMode = !this.askMode;
    lastAskMode = this.askMode;
    if (this.askMode) {
      this.promptEl.textContent = 'ASK \u25b8';
      this.promptEl.classList.add('krypton-inline-ai__prompt--ask');
      this.modeEl.textContent = '\u21e5 cmd';
      this.inputEl.placeholder = 'Ask a question...';
    } else {
      this.promptEl.textContent = 'CMD \u25b8';
      this.promptEl.classList.remove('krypton-inline-ai__prompt--ask');
      this.modeEl.textContent = '\u21e5 ask';
      this.inputEl.placeholder = 'Describe a command...';
    }
    this.updateInputHint();
    this.inputEl.focus();
  }

  private updateInputHint(): void {
    this.hintEl.textContent = this.askMode
      ? '\u21b5 submit \u00b7 \u21e5 cmd \u00b7 \u238b dismiss'
      : '\u21b5 submit \u00b7 \u21e5 ask \u00b7 \u238b dismiss';
  }

  private async submit(query: string): Promise<void> {
    this.phase = 'loading';
    this.inputEl.readOnly = true;
    this.spinnerEl.hidden = false;
    this.resultEl.hidden = true;
    this.hintEl.textContent = '\u238b cancel';

    // Show initializing text while agent lazy-loads
    const dots = this.spinnerEl.querySelector('.krypton-inline-ai__dots') as HTMLElement;
    if (dots) dots.textContent = 'Initializing...';

    // Gather context
    let cwd = '';
    if (this.sessionId !== null) {
      try {
        cwd = await invoke<string>('get_pty_cwd', { sessionId: this.sessionId });
      } catch { /* ignore */ }
    }

    // Build contextual prompt based on mode
    const systemLines = this.askMode
      ? [
          'You are a helpful terminal assistant. Answer the user\'s question concisely.',
          'Keep answers short — a few sentences max. Use plain text, no markdown.',
          '',
          cwd ? `Working directory: ${cwd}` : '',
          '',
          `User question: ${query}`,
        ]
      : [
          'You are a terminal command assistant. The user will describe what they want to do.',
          'Return ONLY the command on the first line.',
          'Optionally add a one-line explanation on the second line, prefixed with #.',
          'Do NOT use markdown formatting, code fences, or backticks.',
          'Nothing else.',
          '',
          cwd ? `Working directory: ${cwd}` : '',
          '',
          `User query: ${query}`,
        ];
    const contextualPrompt = systemLines.filter(Boolean).join('\n');

    this.command = '';
    this.answer = '';
    this.explanation = '';

    let fullResponse = '';

    const onEvent: AgentEventCallback = (e) => {
      switch (e.type) {
        case 'agent_start':
          // Agent initialized — update spinner to show we're waiting for response
          if (dots) dots.textContent = 'Thinking...';
          break;
        case 'message_update':
          fullResponse += e.delta;
          // Hide spinner, show result area on first token
          this.spinnerEl.hidden = true;
          if (this.resultEl.hidden && fullResponse.length > 0) {
            this.resultEl.hidden = false;
          }
          if (this.askMode) {
            // Ask mode — show full response as-is
            this.answer = fullResponse.trim();
            this.commandEl.textContent = this.answer;
          } else {
            // Command mode — parse first line as command
            this.parseResponse(fullResponse);
            this.commandEl.textContent = this.command;
            if (this.explanation) {
              this.explainEl.textContent = this.explanation;
            }
          }
          break;
        case 'tool_start':
          // Agent is using tools — update status
          if (dots) dots.textContent = 'Working...';
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
      await this.controller.prompt(contextualPrompt, onEvent);
    } catch (err) {
      this.onError(String(err));
    }
  }

  private parseResponse(text: string): void {
    // Strip markdown code fences if the model wraps the response
    let cleaned = text.trim();
    if (cleaned.startsWith('```')) {
      const lines = cleaned.split('\n');
      // Remove opening fence (```bash, ```sh, ```, etc.)
      lines.shift();
      // Remove closing fence if present
      if (lines.length > 0 && lines[lines.length - 1].trim().startsWith('```')) {
        lines.pop();
      }
      cleaned = lines.join('\n').trim();
    }

    const lines = cleaned.split('\n');
    this.command = lines[0] ?? '';
    // Look for explanation line starting with #
    const explainLine = lines.find((l, i) => i > 0 && l.startsWith('#'));
    this.explanation = explainLine ? explainLine.slice(1).trim() : '';
  }

  private onComplete(): void {
    this.phase = 'result';
    this.spinnerEl.hidden = true;
    this.resultEl.hidden = false;
    this.inputEl.readOnly = false;

    if (this.askMode) {
      // Ask mode — text answer, no execute actions
      this.commandEl.classList.add('krypton-inline-ai__command--answer');
      this.hintEl.textContent = '\u2318C copy \u00b7 \u21b5 ask another \u00b7 \u238b dismiss';
    } else {
      // Command mode — show final command
      if (this.command) {
        const alreadyShown = this.commandEl.textContent === this.command;
        if (alreadyShown) {
          this.commandEl.classList.add('krypton-inline-ai__command--ready');
        } else {
          this.decodeTimer = decodeReveal(this.commandEl, this.command);
        }
      }
      if (this.explanation) {
        this.explainEl.textContent = this.explanation;
      }
      this.hintEl.textContent = '\u21b5 accept \u00b7 \u21e7\u21b5 run \u00b7 \u21e5 edit \u00b7 \u2318C copy \u00b7 \u238b dismiss';
    }
  }

  private onError(message: string): void {
    this.phase = 'result';
    this.spinnerEl.hidden = true;
    this.resultEl.hidden = false;
    this.inputEl.readOnly = false;
    this.commandEl.textContent = '';
    this.explainEl.textContent = message;
    this.explainEl.classList.add('krypton-inline-ai__explain--error');
    this.hintEl.textContent = '\u238b dismiss';
  }
}
