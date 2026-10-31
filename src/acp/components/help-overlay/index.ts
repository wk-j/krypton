// Spec 302 §7.12 — `HelpOverlay`.
//
// The keybinding reference (`acp-harness-view.ts:13655+` `renderHelp`). Today it
// is one 150-line `innerHTML` template literal rebuilt from scratch every time
// the overlay opens; here the content is DATA (`SECTIONS`) and the markup is
// built once, so opening the overlay is a `hidden` toggle and nothing else.
//
// NOT a `KeyHintBar` grid: the help sections are `<dt>`/`<dd>` pairs that must
// be direct children of a `<dl>` for the two-column grid to line up, and the
// bar emits `<span>`/`<kbd>` runs. The entry's "Shell + KeyHintBar grid" line in
// spec 302 does not match the markup it also asks to keep unchanged.

import { Component } from '../../../ui/component';
import { el, type ElChild } from '../../../ui/dom';
import { OverlayShell } from '../overlay-shell';
import type { ComponentDef } from '../types';
import './help-overlay.css';

interface HelpEntry {
  readonly term: string;
  /** Plain text, or the parts of a line that carries `<kbd>` runs. */
  readonly desc: string | readonly ElChild[];
}

interface HelpSection {
  readonly title: string;
  /** Spans both grid columns. */
  readonly wide?: boolean;
  readonly entries?: readonly HelpEntry[];
  /** Prose instead of a definition list (the Model section). */
  readonly paragraph?: string;
}

/**
 * Built lazily on first construction, not at module scope: `el()` touches
 * `document`, and this module is reachable from `acp-harness-view.ts`, which
 * the node-environment test suite imports.
 */
let sections: readonly HelpSection[] | null = null;

function helpSections(): readonly HelpSection[] {
  if (sections) return sections;
  sections = buildSections();
  return sections;
}

function buildSections(): readonly HelpSection[] {
  return [
  {
    title: 'Lane Control',
    entries: [
      { term: 'Cmd+P then +', desc: 'Add lane (open backend picker)' },
      { term: 'Cmd+P then _', desc: 'Close active lane' },
      { term: 'Cmd+P then =', desc: 'Toggle lane metrics overlay' },
      { term: 'Cmd+P then 0', desc: 'Resume/load a project session for the active backend' },
      { term: 'Ctrl+N / Ctrl+P', desc: 'Next / previous lane' },
      { term: 'Esc, then 1-9', desc: 'Switch lane in transcript mode' },
      { term: 'Esc, then r', desc: 'Refresh Git branch and file-reference line counts' },
      { term: 'Esc, then ?', desc: 'Open help' },
      { term: 'Tab buttons', desc: 'Click a lane directly' },
      {
        term: 'Enter',
        desc: 'Send prompt to active lane only (busy lane: steer the running turn when the agent supports it, else queue)',
      },
      { term: 'Cmd+Enter', desc: 'Busy lane: queue as a follow-up for the next turn' },
      {
        term: 'Shift+Tab',
        desc: 'Cycle the lane\'s permission mode: normal → auto-edit (file edits auto-accepted) → bypass (everything auto-accepted, including high-risk)',
      },
      { term: 'Shift+Enter', desc: 'Insert newline' },
      { term: 'Ctrl+C', desc: 'Cancel active busy lane' },
      { term: 'Ctrl+Shift+J / Ctrl+Shift+K', desc: 'Scroll transcript down / up (works in composer)' },
      { term: 'Cmd+W', desc: 'Close harness tab' },
      { term: 'Cmd+.', desc: 'Toggle Zen Mode' },
      { term: 'Cmd+Shift+.', desc: 'Toggle Concise Mode (tool cards collapse to one line)' },
    ],
  },
  {
    title: 'Composer (readline)',
    entries: [
      { term: 'Ctrl+A / Ctrl+E', desc: 'Begin / end of line' },
      { term: 'Ctrl+B / Ctrl+F', desc: 'Char back / forward' },
      { term: 'Ctrl+Left / Ctrl+Right', desc: 'Word back / forward' },
      { term: 'Ctrl+H', desc: 'Backspace' },
      { term: 'Ctrl+D', desc: 'Delete char forward' },
      { term: 'Cmd+D', desc: 'Start / stop English dictation (when available)' },
      { term: 'Cmd+Shift+D', desc: 'Start / stop Thai dictation (when available)' },
      { term: 'Ctrl+W', desc: 'Delete word backward (kill)' },
      { term: 'Ctrl+U', desc: 'Kill to start of line' },
      { term: 'Ctrl+K', desc: 'Kill to end of line' },
      { term: 'Ctrl+Y', desc: 'Yank last killed text' },
      { term: 'Ctrl+T', desc: 'Transpose chars around cursor' },
      {
        term: '# / @ / /',
        desc: 'Type at line start to autocomplete built-in #commands / @lanes / agent /commands · ↑↓ select, Tab completes',
      },
    ],
  },
  {
    title: 'Permissions',
    entries: [
      { term: 'a', desc: 'Accept current request once' },
      { term: 'A', desc: 'Accept all for current turn' },
      { term: 'r', desc: 'Reject current request once' },
      { term: 'R', desc: 'Reject all for current turn' },
      {
        term: 'Esc',
        desc: [
          'Never answers a request — only ',
          el('kbd', { text: 'r' }),
          ' / ',
          el('kbd', { text: 'R' }),
          ' reject',
        ],
      },
    ],
  },
  {
    title: 'Memory',
    entries: [
      { term: 'Ctrl+M', desc: 'Toggle memory drawer' },
      { term: 'q / Esc', desc: 'Close memory drawer' },
      { term: 'j / k', desc: 'Move memory cursor' },
      { term: 'g / G', desc: 'Top / bottom of memory list' },
      { term: 'Agents', desc: 'Create, update, delete, search, and fetch detail through MCP tools' },
      { term: '#resume list', desc: 'Open the handoff picker (merged local + Xenon; the only surface that resumes)' },
    ],
  },
  {
    title: 'Transcript',
    entries: [
      { term: 'Esc', desc: 'Focus active transcript scrolling' },
      { term: 'i / Esc', desc: 'Return to input composer' },
      { term: '1-9', desc: 'Switch lane' },
      { term: 'j / k', desc: 'Scroll line by line' },
      { term: 'Ctrl+d / Ctrl+u', desc: 'Page down / up' },
      { term: 'g / G', desc: 'Top / bottom' },
      { term: 'c', desc: 'Annotate selection (or nearest block)' },
      { term: 's', desc: 'Send unsent annotations as one turn' },
      { term: 'd', desc: 'Delete last unsent annotation' },
      { term: 'q', desc: 'Close harness tab' },
    ],
  },
  {
    title: 'Commands',
    wide: true,
    entries: [
      { term: '#cancel', desc: 'Cancel active lane, same as Ctrl+C' },
      { term: '#new', desc: 'Start fresh active lane, keep handoffs (the next #handoff starts a new thread)' },
      { term: '#new!', desc: 'Start fresh active lane and delete the handoff it is bound to' },
      {
        term: '#review [<lane> …] [-- <docpath | note>]',
        desc: 'Fan a review of your diff or a design doc out to other lanes (all live lanes if none named)',
      },
      {
        term: '#review pass [N] [<lane> …] [-- <docpath | note>]',
        desc: 'Review, fix the Blockers, re-review — until every reviewer passes or N rounds (default 3, max 8); one summary Board at the end',
      },
      {
        term: '#review stop',
        desc: 'Stop a review pass after the current step and write its summary (#cancel stops it with no summary)',
      },
      {
        term: '#review-thread',
        desc: 'Start a Review Thread for the active lane\'s diff, with a fixed snapshot and human verdict',
      },
      {
        term: '#polly <task>',
        desc: 'Polly orchestration from this lane — auto-spawns two other Cursor/Claude/Codex workers (orchestrator covers its own backend when in pool)',
      },
      {
        term: '#debby <question>',
        desc: 'Debby brainstorming from this lane — auto-spawns Claude and Codex heads as plain responders',
      },
      { term: '#restart', desc: 'Respawn active lane when error or stopped' },
      { term: '#mem', desc: 'Show memory command hint' },
      { term: '#mem clear', desc: 'Delete the handoff bound to the active lane' },
      { term: '#handoff', desc: 'Ask active lane to write or refresh the handoff for its current work' },
      { term: '#resume', desc: 'Resume the newest handoff in the project (local and Xenon), from any lane or machine' },
      { term: '#resume list', desc: 'Open the handoff picker: j/k move, enter resumes, esc closes' },
      { term: '#resume <id>', desc: 'Resume one handoff by id or a unique prefix of 4+ characters after ho-' },
      { term: '#push handoff [<id>]', desc: 'Publish handoffs (or one by id) to the Xenon server' },
      { term: '#wiki [hint]', desc: 'Compound this session into the project wiki (docs/wiki/)' },
      { term: '#recall <question>', desc: 'Answer a question from the project wiki, with citations' },
      { term: '#directive <intent>', desc: 'Have the active lane create/edit a reusable directive in acp-harness.toml' },
      {
        term: '#draw <request>',
        desc: 'Draw in an open tldraw Offline document (focused or named) — static shapes or durable document scripts',
      },
      { term: '#ui <request>', desc: 'Ask for an interactive UI card; actions load a visible draft' },
      { term: '#home', desc: 'Open Krypton Home — every browser surface on one page' },
      { term: '#ui-gallery', desc: 'Open the live GenUI component gallery in a browser' },
      { term: '#telegram', desc: 'Open Telegram controller settings' },
      { term: '#mcp', desc: 'Show MCP endpoint and lane status' },
      { term: '#bg', desc: 'List this lane’s background shell tasks' },
      {
        term: '#panels [hide | show | toggle] <left | right | panel>',
        desc: 'Hide or restore the left panel (Zen lane rail), the right panel (ticket/rails dock), or one of plan · peek · thought · grammar · queue · ticket · rails (also the window titlebar icons)',
      },
      {
        term: '#timeline [open | trace | conflicts | auto]',
        desc: 'เปิดดูหรือไล่ประวัติ ตรวจข้อขัดกัน และตั้งค่าบันทึกอัตโนมัติของ project ในเครื่อง',
      },
      { term: '#queue [clear | edit N]', desc: 'Manage prompts queued while the lane is busy' },
      { term: '#unqueue [N]', desc: 'Remove the last (or Nth) queued prompt' },
      { term: '!cmd', desc: 'Run shell command in project cwd, output goes to transcript' },
    ],
  },
  {
    title: 'Model',
    wide: true,
    paragraph:
      'Each lane is a separate ACP subprocess in the same project directory. Prompts go only to the active lane. '
      + 'Handoffs are project-wide, read-only for humans, and written by agents through the handoff_set MCP tool.',
  },
  ];
}

export interface HelpOverlayProps {
  readonly open: boolean;
  onAutoClose?(): void;
}

export class HelpOverlay extends Component<HelpOverlayProps> {
  private readonly shell: OverlayShell;
  private readonly grid: HTMLElement;

  constructor() {
    const shell = new OverlayShell();
    super(shell.el);
    this.shell = shell;
    // The reference is static: build it once, here, and never again. The only
    // render state the overlay has is `open`.
    this.grid = el('div', { class: 'acp-harness__help-grid' }, ...helpSections().map(renderSection));
  }

  get isOpen(): boolean {
    return this.shell.isOpen;
  }

  protected readDeps(next: HelpOverlayProps): readonly unknown[] {
    return [next.open];
  }

  protected syncClasses(_next: HelpOverlayProps): void {
    /* the root is the shell's node; the shell re-derives its classes */
  }

  protected paint(next: HelpOverlayProps): void {
    this.shell.update({
      open: next.open,
      name: 'help',
      block: 'acp-harness__help',
      title: 'ACP Harness Help',
      sub: 'Esc / ? / q closes',
      body: this.grid,
      onAutoClose: next.onAutoClose,
    });
  }

  protected onDispose(): void {
    this.shell.dispose();
  }
}

function renderSection(section: HelpSection): HTMLElement {
  const node = el('section', {
    class: ['acp-harness__help-section', section.wide && 'acp-harness__help-section--wide'],
  });
  node.appendChild(el('h3', { text: section.title }));
  if (section.paragraph !== undefined) {
    node.appendChild(el('p', { text: section.paragraph }));
    return node;
  }
  const list = el('dl');
  for (const entry of section.entries ?? []) {
    list.appendChild(el('dt', { text: entry.term }));
    list.appendChild(typeof entry.desc === 'string'
      ? el('dd', { text: entry.desc })
      : el('dd', { children: entry.desc }));
  }
  node.appendChild(list);
  return node;
}

export const def: ComponentDef = {
  id: 'help-overlay',
  blocks: ['acp-harness__help-overlay', 'acp-harness__help'],
};
