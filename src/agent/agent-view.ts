// Krypton — AI Agent View
// ContentView implementation that renders a keyboard-driven coding agent panel.
// Uses manual input handling (no contenteditable) for full keyboard control.

import { Marked } from 'marked';
import { markedHighlight } from 'marked-highlight';
import hljs from 'highlight.js';
import 'highlight.js/styles/github-dark.css';
import { AgentController, type AgentEventType } from './agent';
import type { ContentView, PaneContentType } from '../types';
import { invoke } from '@tauri-apps/api/core';

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
  private statusLineEl!: HTMLElement;

  private state: 'input' | 'scroll' = 'input';
  private inputText = '';
  private cursorPos = 0;
  private promptHistory: string[] = [];
  private historyIdx = -1;

  private controller: AgentController;

  // Current streaming elements
  private currentAssistantTextEl: HTMLElement | null = null;
  private currentAssistantBuffer = '';
  private currentToolRowEl: HTMLElement | null = null;

  // Spinner & timer
  private spinnerInterval: ReturnType<typeof setInterval> | null = null;
  private spinnerFrame = 0;
  private promptStartTime = 0;
  private timerInterval: ReturnType<typeof setInterval> | null = null;

  // Streaming markdown render throttle
  private streamRenderPending = false;
  private streamRenderRaf: ReturnType<typeof requestAnimationFrame> | null = null;

  // Project scoping
  private projectDir: string | null = null;

  // Close callback registered by compositor (called when user presses q)
  private closeCallback: (() => void) | null = null;

  // Context window callback (compositor opens a dedicated ContextView)
  private contextCallback: ((controller: AgentController) => void) | null = null;

  // Diff view callback (compositor opens DiffContentView in new tab)
  private diffCallback: ((diff: string, title: string) => void) | null = null;

  // Autocomplete state
  private autocompleteEl!: HTMLElement;
  private acMatches: string[] = [];
  private acSelectedIdx = -1;

  // Scroll position preservation across tab switches
  private savedScrollTop = 0;
  private pendingScrollToBottom = false;

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

    // Status line (token usage)
    this.statusLineEl = document.createElement('div');
    this.statusLineEl.className = 'agent-view__status-line';

    this.inputRowEl.appendChild(this.promptGlyphEl);
    this.inputRowEl.appendChild(this.inputDisplayEl);

    // Track scroll position so it can be restored after tab switch
    this.messagesEl.addEventListener('scroll', () => {
      this.savedScrollTop = this.messagesEl.scrollTop;
    }, { passive: true });

    this.element.appendChild(this.messagesEl);
    this.element.appendChild(this.stateHintEl);
    this.element.appendChild(this.autocompleteEl);
    this.element.appendChild(this.statusLineEl);
    this.element.appendChild(this.inputRowEl);

    this.renderInput();
  }

  // ─── Session ──────────────────────────────────────────────────────

  private async restoreSession(): Promise<void> {
    await this.controller.initSession();
    const entries = await this.controller.restoreFromSession();
    for (const { role, message } of entries) {
      if (role === 'user') {
        const text = typeof message.content === 'string'
          ? message.content
          : this.extractTextFromContent(message.content);
        this.appendUserMessageDom(text);
      } else if (role === 'assistant') {
        const text = this.extractTextFromContent(message.content);
        const el = this.appendAssistantMessageDom();
        el.querySelector('.agent-view__stream-cursor')?.remove();
        try {
          el.innerHTML = md.parse(text) as string;
          el.classList.add('agent-view__msg-body--markdown');
        } catch {
          el.textContent = text;
        }
      } else if (role === 'toolResult') {
        const name = (message.toolName as string) ?? 'tool';
        const isError = Boolean(message.isError);
        const text = this.extractTextFromContent(message.content);
        const row = this.appendToolRowDom(name, '');
        this.finalizeToolRow(row, isError, text);
      }
    }
    if (entries.length > 0) this.scrollToBottom();
  }

  /** Extract plain text from pi-agent-core content blocks (string | Array<{type, text}>). */
  private extractTextFromContent(content: unknown): string {
    if (typeof content === 'string') return content;
    if (!Array.isArray(content)) return '';
    return content
      .filter((b: Record<string, unknown>) => b.type === 'text' && typeof b.text === 'string')
      .map((b: Record<string, unknown>) => b.text as string)
      .join('');
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

  /** Final markdown render — remove cursor, cancel pending RAF. */
  private finalizeAssistantMessage(): void {
    if (!this.currentAssistantTextEl) return;
    // Cancel any pending streaming render
    if (this.streamRenderRaf !== null) {
      cancelAnimationFrame(this.streamRenderRaf);
      this.streamRenderRaf = null;
      this.streamRenderPending = false;
    }
    if (this.currentAssistantBuffer) {
      try {
        this.currentAssistantTextEl.innerHTML = md.parse(this.currentAssistantBuffer) as string;
      } catch {
        // leave as-is
      }
    }
    this.currentAssistantTextEl.querySelector('.agent-view__stream-cursor')?.remove();
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

  private finalizeToolRow(row: HTMLElement, isError: boolean, resultText?: string, diff?: string, filePath?: string): void {
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

    // Render inline diff preview for write_file
    if (diff && filePath) {
      row.dataset.diff = diff;
      row.dataset.filePath = filePath;
      row.classList.add('agent-view__tool-row--has-diff');
      this.renderDiffPreview(row, diff);
    }
  }

  private renderDiffPreview(row: HTMLElement, diff: string): void {
    const preview = document.createElement('div');
    preview.className = 'agent-view__diff-preview';

    const diffLines = diff.split('\n');
    // Collect changed lines (skip unified diff headers)
    const changedLines: { type: 'added' | 'removed' | 'context'; text: string }[] = [];
    let inHunk = false;
    for (const line of diffLines) {
      if (line.startsWith('@@')) {
        inHunk = true;
        continue;
      }
      if (!inHunk) continue;
      if (line.startsWith('+')) {
        changedLines.push({ type: 'added', text: line.slice(1) });
      } else if (line.startsWith('-')) {
        changedLines.push({ type: 'removed', text: line.slice(1) });
      } else if (line.startsWith(' ')) {
        changedLines.push({ type: 'context', text: line.slice(1) });
      }
    }

    // Count additions and deletions
    const additions = changedLines.filter((l) => l.type === 'added').length;
    const deletions = changedLines.filter((l) => l.type === 'removed').length;

    if (additions === 0 && deletions === 0) {
      const noChange = document.createElement('div');
      noChange.className = 'agent-view__diff-line agent-view__diff-line--context';
      noChange.textContent = '(no changes)';
      preview.appendChild(noChange);
      row.appendChild(preview);
      return;
    }

    // Show only changed lines (additions + deletions), limited to 8
    const MAX_PREVIEW = 8;
    const significant = changedLines.filter((l) => l.type !== 'context');
    const showing = significant.slice(0, MAX_PREVIEW);

    for (const line of showing) {
      const el = document.createElement('div');
      el.className = `agent-view__diff-line agent-view__diff-line--${line.type}`;
      el.textContent = (line.type === 'added' ? '+' : '-') + line.text;
      preview.appendChild(el);
    }

    // Summary line
    const remaining = significant.length - showing.length;
    const summary = document.createElement('div');
    summary.className = 'agent-view__diff-summary';
    const stats = `+${additions} -${deletions}`;
    if (remaining > 0) {
      summary.textContent = `${stats}  … ${remaining} more lines  Enter → full diff`;
    } else {
      summary.textContent = `${stats}  Enter → full diff`;
    }
    preview.appendChild(summary);

    row.appendChild(preview);
  }

  private appendShellCommandDom(command: string): HTMLElement {
    const msg = document.createElement('div');
    msg.className = 'agent-view__msg agent-view__msg--shell';

    const label = document.createElement('span');
    label.className = 'agent-view__msg-label agent-view__msg-label--shell';
    label.textContent = 'SH';

    const body = document.createElement('div');
    body.className = 'agent-view__msg-body';
    body.textContent = `$ ${command}`;

    msg.appendChild(label);
    msg.appendChild(body);
    this.messagesEl.appendChild(msg);
    return body;
  }

  private appendShellResultDom(output: string, isError: boolean): void {
    const result = document.createElement('div');
    result.className = 'agent-view__shell-result';
    if (isError) result.classList.add('agent-view__shell-result--error');
    
    const lines = output.split('\n');
    const MAX_LINES = 20;
    if (lines.length > MAX_LINES) {
      result.textContent = lines.slice(0, MAX_LINES).join('\n');
      const more = document.createElement('span');
      more.className = 'agent-view__shell-more';
      more.textContent = `\n… ${lines.length - MAX_LINES} more lines`;
      result.appendChild(more);
    } else {
      result.textContent = output || '(no output)';
    }
    
    this.messagesEl.appendChild(result);
    this.scrollToBottom();
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

  /** Get all slash commands: built-in + custom commands from .claude/commands/. */
  private getAllCommands(): Record<string, { description: string; usage?: string }> {
    const cmds: Record<string, { description: string; usage?: string }> = { ...AgentView.COMMANDS };
    for (const cmd of this.controller.getCommands()) {
      const key = `/${cmd.name}`;
      if (!cmds[key]) {
        cmds[key] = { description: cmd.description, usage: `/${cmd.name} [args]` };
      }
    }
    return cmds;
  }

  private updateAutocomplete(): void {
    const text = this.inputText.trim();

    // Only show when input starts with / and has no spaces (still typing the command)
    if (!text.startsWith('/') || text.includes(' ')) {
      this.hideAutocomplete();
      return;
    }

    const prefix = text.toLowerCase();
    const allCmds = Object.keys(this.getAllCommands());
    this.acMatches = allCmds.filter((cmd) => cmd.startsWith(prefix) && cmd !== prefix);

    if (this.acMatches.length === 0) {
      this.hideAutocomplete();
      return;
    }

    // Clamp selection
    if (this.acSelectedIdx >= this.acMatches.length) this.acSelectedIdx = this.acMatches.length - 1;
    if (this.acSelectedIdx < 0) this.acSelectedIdx = 0;

    const allCmdInfo = this.getAllCommands();
    this.autocompleteEl.innerHTML = '';
    for (let i = 0; i < this.acMatches.length; i++) {
      const cmd = this.acMatches[i];
      const info = allCmdInfo[cmd];
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
        this.stopTimer();
        this.promptGlyphEl.textContent = '❯';
        this.inputRowEl.classList.remove('agent-view__input-row--busy');
        // Render accumulated text as markdown
        this.finalizeAssistantMessage();
        this.currentToolRowEl = null;
        if (e.usage) this.renderStatusLine(e.usage);
        break;

      case 'message_update':
        if (!this.currentAssistantTextEl) {
          this.currentAssistantTextEl = this.appendAssistantMessageDom();
          this.currentAssistantBuffer = '';
          this.currentAssistantTextEl.classList.add('agent-view__msg-body--markdown');
          // Show active skills in the label
          const activeSkills = this.controller.getLastActiveSkills();
          if (activeSkills.length > 0) {
            const msgEl = this.currentAssistantTextEl.closest('.agent-view__msg');
            const labelEl = msgEl?.querySelector('.agent-view__msg-label');
            if (labelEl) labelEl.textContent = `AI [${activeSkills.join(', ')}]`;
          }
        }
        // Accumulate raw text and render markdown on next animation frame
        this.currentAssistantBuffer += e.delta;
        if (!this.streamRenderPending) {
          this.streamRenderPending = true;
          this.streamRenderRaf = requestAnimationFrame(() => {
            this.streamRenderPending = false;
            this.streamRenderRaf = null;
            if (this.currentAssistantTextEl && this.currentAssistantBuffer) {
              try {
                const html = md.parse(this.currentAssistantBuffer) as string;
                this.currentAssistantTextEl.innerHTML =
                  html + '<span class="agent-view__stream-cursor">▋</span>';
              } catch {
                this.currentAssistantTextEl.textContent = this.currentAssistantBuffer;
              }
              this.scrollToBottom();
            }
          });
        }
        break;

      case 'tool_start':
        // Finalize any pending assistant text as markdown before showing tool row
        this.finalizeAssistantMessage();
        this.currentToolRowEl = this.appendToolRowDom(e.name, e.args);
        this.scrollToBottom();
        break;

      case 'tool_end':
        if (this.currentToolRowEl) {
          this.finalizeToolRow(this.currentToolRowEl, e.isError, e.result, e.diff, e.filePath);
          this.currentToolRowEl = null;
        }
        this.scrollToBottom();
        break;

      case 'usage_update':
        this.renderStatusLine(e.usage);
        break;

      case 'message_usage': {
        // Annotate the current assistant message with token count + response time (top-right)
        const msgEl = this.currentAssistantTextEl?.closest('.agent-view__msg');
        if (msgEl) {
          const badge = document.createElement('span');
          badge.className = 'agent-view__msg-tokens';
          const n = e.outputTokens;
          const tokStr = n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n);
          const elapsed = this.promptStartTime > 0 ? (Date.now() - this.promptStartTime) / 1000 : 0;
          const timeStr = elapsed >= 60
            ? `${Math.floor(elapsed / 60)}m${Math.floor(elapsed % 60).toString().padStart(2, '0')}s`
            : `${elapsed.toFixed(1)}s`;
          badge.textContent = `${tokStr} tok · ${timeStr}`;
          msgEl.appendChild(badge);
        }
        break;
      }

      case 'error':
        this.stopSpinner();
        this.stopTimer();
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

  // ─── Shell command execution (! prefix) ─────────────────────────────

  private async executeShellCommand(command: string): Promise<void> {
    // Display the command being executed
    this.appendShellCommandDom(command);
    this.scrollToBottom();

    try {
      const [program, shellArgs] = await invoke<[string, string[]]>('get_default_shell');
      const output = await invoke<string>('run_command', {
        program,
        args: [...shellArgs, '-c', command],
        cwd: this.projectDir ?? null,
      });
      this.appendShellResultDom(output, false);
    } catch (e) {
      const errorMsg = e instanceof Error ? e.message : String(e);
      this.appendShellResultDom(`Error: ${errorMsg}`, true);
    }
  }

  // ─── Slash commands ──────────────────────────────────────────────

  private static readonly COMMANDS: Record<string, { description: string; usage?: string }> = {
    '/help':    { description: 'Show available commands' },
    '/new':     { description: 'Clear conversation and start a new session' },
    '/skills':  { description: 'List discovered skills' },
    '/skill':   { description: 'Force-activate a skill for the next prompt', usage: '/skill <name>' },
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
        this.contextCallback?.(this.controller);
        return true;

      case '/skills': {
        const skills = this.controller.getSkills();
        if (skills.length === 0) {
          this.showSystemMessage('No skills discovered.\nPlace SKILL.md files in .claude/skills/ or .agents/skills/\nOr add commands in .claude/commands/*.md');
        } else {
          const lines = skills.map((s) => {
            const tag = s.isCommand ? ' [cmd]' : '';
            return `  ${(s.name + tag).padEnd(28)} ${s.description}`;
          });
          const active = this.controller.getLastActiveSkills();
          const activeNote = active.length > 0 ? `\n\nLast active: ${active.join(', ')}` : '';
          this.showSystemMessage(`Discovered skills (${skills.length}):\n${lines.join('\n')}${activeNote}`);
        }
        return true;
      }

      case '/skill': {
        const skillName = parts[1];
        if (!skillName) {
          this.showSystemMessage('Usage: /skill <name>\nUse /skills to list available skills.');
          return true;
        }
        const ok = this.controller.setForcedSkill(skillName);
        if (ok) {
          this.showSystemMessage(`Skill "${skillName}" will be active for the next prompt.`);
        } else {
          const available = this.controller.getSkills().map((s) => s.name).join(', ');
          this.showSystemMessage(`Skill "${skillName}" not found.\nAvailable: ${available || 'none'}`);
        }
        return true;
      }

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

  /**
   * Handle a custom command from .claude/commands/.
   * Force-activates the command skill, then sends args as a prompt to the agent.
   */
  private async handleCustomCommand(text: string): Promise<boolean> {
    const parts = text.split(/\s+/);
    const cmdName = parts[0].slice(1); // strip leading /
    const cmd = this.controller.findCommand(cmdName);
    if (!cmd) return false;

    const args = parts.slice(1).join(' ');

    // Force-activate the command skill with args
    this.controller.setForcedSkill(cmdName);

    if (this.controller.isRunning) return true;

    // Show the command invocation as a user message and start spinner immediately
    this.appendUserMessageDom(text);
    this.scrollToBottom();
    this.startSpinner();
    this.startTimer();
    this.inputRowEl.classList.add('agent-view__input-row--busy');

    try {
      await this.controller.prompt(args || cmdName, (e) => this.handleAgentEvent(e), args);
    } catch (e) {
      this.handleAgentEvent({ type: 'error', message: `Unexpected error: ${e}` });
    }
    return true;
  }

  private formatHelp(): string {
    const lines: string[] = ['Available commands:'];
    for (const [cmd, info] of Object.entries(AgentView.COMMANDS)) {
      lines.push(`  ${cmd.padEnd(12)} ${info.description}`);
    }

    // Include custom commands from .claude/commands/
    const customCmds = this.controller.getCommands();
    if (customCmds.length > 0) {
      lines.push('');
      lines.push('Custom commands (.claude/commands/):');
      for (const cmd of customCmds) {
        lines.push(`  /${cmd.name.padEnd(11)} ${cmd.description}`);
      }
    }

    lines.push('');
    lines.push('Quick shell commands:');
    lines.push('  !<command>    Execute shell command directly');
    lines.push('                 Example: !ls -la, !git status');
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

    // Handle shell commands (! prefix)
    if (text.startsWith('!')) {
      const command = text.slice(1).trim();
      if (!command) {
        this.showSystemMessage('Usage: !<command>\nExecute shell command directly.\nExample: !ls -la');
      } else {
        await this.executeShellCommand(command);
      }
      return;
    }

    // Handle slash commands (built-in, then custom .claude/commands/)
    if (text.startsWith('/')) {
      if (this.handleSlashCommand(text)) return;
      if (await this.handleCustomCommand(text)) return;
      this.showSystemMessage(`Unknown command: ${text.split(/\s+/)[0]}\nType /help for available commands.`);
      return;
    }

    if (this.controller.isRunning) return;

    // Render user message and show processing indicator immediately
    this.appendUserMessageDom(text);
    this.scrollToBottom();
    this.startSpinner();
    this.startTimer();
    this.inputRowEl.classList.add('agent-view__input-row--busy');

    try {
      await this.controller.prompt(text, (e) => this.handleAgentEvent(e));
    } catch (e) {
      this.handleAgentEvent({ type: 'error', message: `Unexpected error: ${e}` });
    }
  }

  // ─── Keyboard ────────────────────────────────────────────────────

  onKeyDown(e: KeyboardEvent): boolean {
    if (this.state === 'input') {
      return this.handleInputKey(e);
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

    // Readline: Ctrl+U — kill line before cursor
    if (e.code === 'KeyU' && e.ctrlKey && !e.metaKey && !e.altKey) {
      this.inputText = this.inputText.slice(this.cursorPos);
      this.cursorPos = 0;
      this.renderInput();
      return true;
    }

    // Readline: Ctrl+K — kill line after cursor
    if (e.code === 'KeyK' && e.ctrlKey && !e.metaKey && !e.altKey) {
      this.inputText = this.inputText.slice(0, this.cursorPos);
      this.renderInput();
      return true;
    }

    // Readline: Ctrl+A — move to beginning of line
    if (e.code === 'KeyA' && e.ctrlKey && !e.metaKey && !e.altKey) {
      this.cursorPos = 0;
      this.renderInput();
      return true;
    }

    // Readline: Ctrl+E — move to end of line
    if (e.code === 'KeyE' && e.ctrlKey && !e.metaKey && !e.altKey) {
      this.cursorPos = this.inputText.length;
      this.renderInput();
      return true;
    }

    // Readline: Ctrl+B — move back one char
    if (e.code === 'KeyB' && e.ctrlKey && !e.metaKey && !e.altKey) {
      if (this.cursorPos > 0) this.cursorPos--;
      this.renderInput();
      return true;
    }

    // Readline: Ctrl+F — move forward one char
    if (e.code === 'KeyF' && e.ctrlKey && !e.metaKey && !e.altKey) {
      if (this.cursorPos < this.inputText.length) this.cursorPos++;
      this.renderInput();
      return true;
    }

    // Readline: Ctrl+D — delete char under cursor
    if (e.code === 'KeyD' && e.ctrlKey && !e.metaKey && !e.altKey) {
      if (this.cursorPos < this.inputText.length) {
        this.inputText = this.inputText.slice(0, this.cursorPos) + this.inputText.slice(this.cursorPos + 1);
        this.renderInput();
      }
      return true;
    }

    // Readline: Ctrl+H — backspace
    if (e.code === 'KeyH' && e.ctrlKey && !e.metaKey && !e.altKey) {
      if (this.cursorPos > 0) {
        this.inputText = this.inputText.slice(0, this.cursorPos - 1) + this.inputText.slice(this.cursorPos);
        this.cursorPos--;
        this.renderInput();
      }
      return true;
    }

    // Readline: Ctrl+T — transpose chars
    if (e.code === 'KeyT' && e.ctrlKey && !e.metaKey && !e.altKey) {
      if (this.cursorPos > 0 && this.cursorPos < this.inputText.length) {
        const chars = this.inputText.split('');
        [chars[this.cursorPos - 1], chars[this.cursorPos]] = [chars[this.cursorPos], chars[this.cursorPos - 1]];
        this.inputText = chars.join('');
        this.cursorPos++;
        this.renderInput();
      }
      return true;
    }

    // Readline: Ctrl+W — delete word backward
    if (e.code === 'KeyW' && e.ctrlKey && !e.metaKey && !e.altKey) {
      const before = this.inputText.slice(0, this.cursorPos);
      const trimmed = before.replace(/\S+\s*$/, '');
      this.inputText = trimmed + this.inputText.slice(this.cursorPos);
      this.cursorPos = trimmed.length;
      this.renderInput();
      return true;
    }

    // Readline: Alt+B — move back one word
    if (e.code === 'KeyB' && e.altKey && !e.ctrlKey && !e.metaKey) {
      const before = this.inputText.slice(0, this.cursorPos);
      const match = before.match(/(?:\S+\s*|\s+)$/);
      this.cursorPos -= match ? match[0].length : 0;
      this.renderInput();
      return true;
    }

    // Readline: Alt+F — move forward one word
    if (e.code === 'KeyF' && e.altKey && !e.ctrlKey && !e.metaKey) {
      const after = this.inputText.slice(this.cursorPos);
      const match = after.match(/^(?:\s*\S+|\s+)/);
      this.cursorPos += match ? match[0].length : 0;
      this.renderInput();
      return true;
    }

    // Readline: Alt+D — delete word forward
    if (e.code === 'KeyD' && e.altKey && !e.ctrlKey && !e.metaKey) {
      const after = this.inputText.slice(this.cursorPos);
      const match = after.match(/^\s*\S+/);
      if (match) {
        this.inputText = this.inputText.slice(0, this.cursorPos) + after.slice(match[0].length);
        this.renderInput();
      }
      return true;
    }

    // Readline: Alt+Backspace — delete word backward
    if (e.key === 'Backspace' && e.altKey && !e.ctrlKey && !e.metaKey) {
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
    if (e.key === 'PageUp') {
      this.scrollMessagesFraction(-0.4);
      return true;
    }
    if (e.key === 'PageDown') {
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

    // Select all (Cmd+A)
    if (e.code === 'KeyA' && e.metaKey && !e.ctrlKey && !e.altKey) {
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

    // Enter — open full diff for nearest tool row with diff data
    if (e.key === 'Enter') {
      this.openNearestDiff();
      return true;
    }

    // c — open dedicated context window
    if (e.key === 'c' && !e.ctrlKey && !e.metaKey && !e.altKey) {
      this.contextCallback?.(this.controller);
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

  onOpenContext(cb: (controller: AgentController) => void): void {
    this.contextCallback = cb;
  }

  onOpenDiff(cb: (diff: string, title: string) => void): void {
    this.diffCallback = cb;
  }

  getController(): AgentController {
    return this.controller;
  }

  /** Find the tool row closest to the current scroll position that has diff data, and open it. */
  private openNearestDiff(): void {
    if (!this.diffCallback) return;
    const rows = this.messagesEl.querySelectorAll<HTMLElement>('.agent-view__tool-row--has-diff');
    if (rows.length === 0) return;

    // Find row closest to viewport center
    const viewCenter = this.messagesEl.scrollTop + this.messagesEl.clientHeight / 2;
    let closest: HTMLElement | null = null;
    let closestDist = Infinity;
    for (const row of rows) {
      const rowCenter = row.offsetTop + row.offsetHeight / 2;
      const dist = Math.abs(rowCenter - viewCenter);
      if (dist < closestDist) {
        closestDist = dist;
        closest = row;
      }
    }

    if (closest?.dataset.diff && closest.dataset.filePath) {
      this.diffCallback(closest.dataset.diff, `DIFF // ${closest.dataset.filePath}`);
    }
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

  // ─── Status line ──────────────────────────────────────────────────

  private renderStatusLine(usage: import('./agent').TokenUsage): void {
    const fmt = (n: number): string => {
      if (n >= 1_000_000) return (n / 1_000_000).toFixed(1) + 'M';
      if (n >= 1_000) return (n / 1_000).toFixed(1) + 'k';
      return String(n);
    };

    const parts: string[] = [
      `IN ${fmt(usage.input)}`,
      `OUT ${fmt(usage.output)}`,
    ];
    if (usage.cacheRead > 0) parts.push(`CACHE ${fmt(usage.cacheRead)}`);
    parts.push(`Σ ${fmt(usage.totalTokens)}`);
    if (usage.cost > 0) parts.push(`$${usage.cost.toFixed(4)}`);
    if (usage.contextWindow > 0) parts.push(`CTX ${usage.contextPercent}%`);
    const skillCount = this.controller.getSkills().length;
    if (skillCount > 0) parts.push(`SKILLS ${skillCount}`);

    this.statusLineEl.textContent = parts.join('  ·  ');
    this.statusLineEl.classList.add('agent-view__status-line--visible');

    // Visual warning when context is getting full
    this.statusLineEl.classList.toggle('agent-view__status-line--warn', usage.contextPercent >= 70);
    this.statusLineEl.classList.toggle('agent-view__status-line--critical', usage.contextPercent >= 90);
  }

  private scrollToBottom(): void {
    if (!this.messagesEl.offsetParent) {
      // Element is detached from DOM (tab not visible) — defer scroll
      this.pendingScrollToBottom = true;
      return;
    }
    this.pendingScrollToBottom = false;
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

  // ─── Timer ────────────────────────────────────────────────────────

  private startTimer(): void {
    this.stopTimer();
    this.promptStartTime = Date.now();
    this.statusLineEl.classList.add('agent-view__status-line--visible');
    this.timerInterval = setInterval(() => {
      const elapsed = (Date.now() - this.promptStartTime) / 1000;
      const timeStr = elapsed >= 60
        ? `${Math.floor(elapsed / 60)}:${Math.floor(elapsed % 60).toString().padStart(2, '0')}`
        : `${elapsed.toFixed(1)}s`;
      // Update or create the timer segment in the status line
      const existing = this.statusLineEl.querySelector('.agent-view__timer');
      if (existing) {
        existing.textContent = timeStr;
      } else {
        const timer = document.createElement('span');
        timer.className = 'agent-view__timer';
        timer.textContent = timeStr;
        this.statusLineEl.prepend(timer);
      }
    }, 100);
  }

  private stopTimer(): void {
    if (this.timerInterval !== null) {
      clearInterval(this.timerInterval);
      this.timerInterval = null;
    }
    // Remove the live timer element
    this.statusLineEl.querySelector('.agent-view__timer')?.remove();
  }

  // ─── New session ──────────────────────────────────────────────────

  async newSession(): Promise<void> {
    await this.controller.reset();
    this.messagesEl.innerHTML = '';
    this.inputText = '';
    this.cursorPos = 0;
    this.promptHistory = [];
    this.historyIdx = -1;
    this.statusLineEl.textContent = '';
    this.statusLineEl.classList.remove('agent-view__status-line--visible');
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

  getWorkingDirectory(): string | null {
    return this.projectDir;
  }

  onResize(_w: number, _h: number): void {
    // After tab switch, DOM reflow resets scrollTop to 0.
    // If new content arrived while detached, scroll to bottom; otherwise restore.
    if (this.pendingScrollToBottom) {
      this.pendingScrollToBottom = false;
      this.messagesEl.scrollTop = this.messagesEl.scrollHeight;
    } else if (this.savedScrollTop > 0) {
      this.messagesEl.scrollTop = this.savedScrollTop;
    }
  }

  dispose(): void {
    this.controller.abort();
    this.stopSpinner();
  }
}
