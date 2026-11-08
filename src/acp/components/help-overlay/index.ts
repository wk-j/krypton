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
import { keyCap, type KeyHint } from '../../../ui/kbd';
import { OverlayShell } from '../overlay-shell';
import type { ComponentDef } from '../types';
import './help-overlay.css';

interface HelpEntry {
  /** A command as text, or a binding whose every key is a `<kbd>` cap (spec 369). */
  readonly term: string | readonly ElChild[];
  /** Plain text, or the parts of a line that carries `<kbd>` caps. */
  readonly desc: string | readonly ElChild[];
}

const SUB: readonly KeyHint[] = [{ keys: ['Esc', '?', 'q'], label: 'closes', keySeparator: '/' }];

/** Alternatives: one cap per key, joined by `/`. */
function alt(...keys: readonly string[]): ElChild[] {
  const out: ElChild[] = [];
  keys.forEach((key, index) => {
    if (index > 0) out.push('/');
    out.push(keyCap(key));
  });
  return out;
}

/** A sequence: `first`, then `second`. */
function then(first: string, second: string): ElChild[] {
  return [keyCap(first), ' then ', keyCap(second)];
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
 * Built per overlay, not at module scope: `el()` touches `document`, and this
 * module is reachable from `acp-harness-view.ts`, which the node-environment
 * test suite imports. Not cached either: the entries hold cap nodes, and a
 * node can sit in one overlay only.
 */
function buildSections(): readonly HelpSection[] {
  return [
  {
    title: 'Lane Control',
    entries: [
      { term: then('⌘P', '+'), desc: 'Add lane (open backend picker)' },
      { term: then('⌘P', '_'), desc: 'Close active lane' },
      { term: then('⌘P', '='), desc: 'Toggle lane metrics overlay' },
      { term: then('⌘P', '0'), desc: 'Resume/load a project session for the active backend' },
      { term: alt('⌃N', '⌃P'), desc: 'Next / previous lane' },
      { term: then('Esc', '1–9'), desc: 'Switch lane in transcript mode' },
      { term: then('Esc', 'r'), desc: 'Refresh Git branch and file-reference line counts' },
      { term: then('Esc', '?'), desc: 'Open help' },
      { term: 'Tab buttons', desc: 'Click a lane directly' },
      {
        term: alt('Enter'),
        desc: 'Send prompt to active lane only (busy lane: steer the running turn when the agent supports it, else queue)',
      },
      { term: alt('⌘Enter'), desc: 'Busy lane: queue as a follow-up for the next turn' },
      {
        term: alt('⇧Tab'),
        desc: 'Cycle the lane\'s permission mode: normal → auto-edit (file edits auto-accepted) → bypass (everything auto-accepted, including high-risk)',
      },
      { term: alt('⇧Enter'), desc: 'Insert newline' },
      { term: alt('⌃C'), desc: 'Cancel active busy lane' },
      { term: alt('⌃⇧J', '⌃⇧K'), desc: 'Scroll transcript down / up (works in composer)' },
      { term: alt('⌘W'), desc: 'Close harness tab' },
      { term: alt('⌘.'), desc: 'Toggle Zen Mode' },
      { term: alt('⇧⌘.'), desc: 'Toggle Concise Mode (tool cards collapse to one line, lane stats hide)' },
      { term: alt('⌥⌘.'), desc: 'Show / hide the lane stats row (or click the shown lane\'s name)' },
    ],
  },
  {
    title: 'Composer (readline)',
    entries: [
      { term: alt('⌃A', '⌃E'), desc: 'Begin / end of line' },
      { term: alt('⌃B', '⌃F'), desc: 'Char back / forward' },
      { term: alt('⌃←', '⌃→'), desc: 'Word back / forward' },
      { term: alt('⌃H'), desc: 'Backspace' },
      { term: alt('⌃D'), desc: 'Delete char forward' },
      { term: alt('⌘D'), desc: 'Start / stop English dictation (when available)' },
      { term: alt('⇧⌘D'), desc: 'Start / stop Thai dictation (when available)' },
      { term: alt('⌃W'), desc: 'Delete word backward (kill)' },
      { term: alt('⌃U'), desc: 'Kill to start of line' },
      { term: alt('⌃K'), desc: 'Kill to end of line' },
      { term: alt('⌃Y'), desc: 'Yank last killed text' },
      { term: alt('⌃T'), desc: 'Transpose chars around cursor' },
      {
        term: alt('#', '@', '/'),
        desc: [
          'Type at line start to autocomplete built-in #commands / @lanes / agent /commands · ',
          keyCap('↑↓'),
          ' select, ',
          keyCap('Tab'),
          ' completes',
        ],
      },
    ],
  },
  {
    title: 'Permissions',
    entries: [
      { term: alt('a'), desc: 'Accept current request once' },
      { term: alt('A'), desc: 'Accept all for current turn' },
      { term: alt('r'), desc: 'Reject current request once' },
      { term: alt('R'), desc: 'Reject all for current turn' },
      {
        term: alt('Esc'),
        desc: [
          'Never answers a request — only ',
          keyCap('r'),
          ' / ',
          keyCap('R'),
          ' reject',
        ],
      },
    ],
  },
  {
    title: 'Memory',
    entries: [
      { term: alt('⌃M'), desc: 'Toggle memory drawer' },
      { term: alt('q', 'Esc'), desc: 'Close memory drawer' },
      { term: alt('j', 'k'), desc: 'Move memory cursor' },
      { term: alt('g', 'G'), desc: 'Top / bottom of memory list' },
      { term: 'Agents', desc: 'Create, update, delete, search, and fetch detail through MCP tools' },
      { term: '#resume list', desc: 'Open the handoff picker (merged local + Xenon; the only surface that resumes)' },
    ],
  },
  {
    title: 'Transcript',
    entries: [
      { term: alt('Esc'), desc: 'Focus active transcript scrolling' },
      { term: alt('i', 'Esc'), desc: 'Return to input composer' },
      { term: alt('1–9'), desc: 'Switch lane' },
      { term: alt('j', 'k'), desc: 'Scroll line by line' },
      { term: alt('⌃D', '⌃U'), desc: 'Page down / up' },
      { term: alt('g', 'G'), desc: 'Top / bottom' },
      { term: alt('c'), desc: 'Annotate selection (or nearest block)' },
      { term: alt('s'), desc: 'Send unsent annotations as one turn' },
      { term: alt('d'), desc: 'Delete last unsent annotation' },
      { term: alt('q'), desc: 'Close harness tab' },
    ],
  },
  {
    title: 'Commands',
    wide: true,
    entries: [
      { term: '#cancel', desc: ['Cancel active lane, same as ', keyCap('⌃C')] },
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
      {
        term: '#resume list',
        desc: [
          'Open the handoff picker: ',
          ...alt('j', 'k'),
          ' move, ',
          keyCap('Enter'),
          ' resumes, ',
          keyCap('Esc'),
          ' closes',
        ],
      },
      { term: '#resume <id>', desc: 'Resume one handoff by id or a unique prefix of 4+ characters after ho-' },
      { term: '#push handoff [<id>]', desc: 'Publish handoffs (or one by id) to the Xenon server' },
      { term: '#wiki [hint]', desc: 'Compound this session into the project wiki (docs/wiki/)' },
      { term: '#recall <question>', desc: 'Answer a question from the project wiki, with citations' },
      { term: '#learn <sha>', desc: 'Explain a commit as a learning note in the knowledge dir' },
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
        desc: 'Hide or restore the left panel (Zen lane rail), the right panel (Ticket/Rails/Assistants dock), or one of plan · peek · thought · grammar · queue · ticket · rails · assistants (the first seven also have titlebar icons)',
      },
      {
        term: '#timeline [open | trace | conflicts | auto]',
        desc: 'เปิดดูหรือไล่ประวัติ ตรวจข้อขัดกัน และเลือกให้บันทึกอัตโนมัติหรือเฉพาะเมื่อสั่งของ project ในเครื่อง',
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
    this.grid = el('div', { class: 'acp-harness__help-grid' }, ...buildSections().map(renderSection));
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
      sub: SUB,
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
    list.appendChild(typeof entry.term === 'string'
      ? el('dt', { text: entry.term })
      : el('dt', { children: entry.term }));
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
