import { describe, expect, it } from 'vitest';

import { ToolRow } from './index';
import { tickAllSpinners } from '../spinner';
import type { RowProps } from '../transcript-row';
import type { HarnessTranscriptItem, JobsPayload, SubagentEntry, SubagentPayload, ToolPayload } from '../../harness-view-types';

function payload(over: Partial<ToolPayload> = {}): ToolPayload {
  return {
    glyph: '\u283b',
    status: 'in_progress',
    kind: 'execute',
    subject: 'npm run check',
    command: 'npm run check',
    result: '',
    exitCode: null,
    sections: [],
    diffs: [],
    ...over,
  };
}

function props(
  tool: ToolPayload,
  over: Partial<RowProps> = {},
  subagentExpanded?: readonly string[],
): RowProps {
  const item: HarnessTranscriptItem = {
    id: 'tool-1',
    kind: 'tool',
    text: '',
    status: tool.status,
    tool,
    ...(subagentExpanded ? { subagentExpanded: [...subagentExpanded] } : {}),
  };
  return {
    item,
    isNew: false,
    streaming: false,
    lane: null,
    projectDir: null,
    resolveLocalImages: false,
    ...over,
  };
}

function mount(row: ToolRow): HTMLElement {
  const host = document.createElement('div');
  host.appendChild(row.el);
  return host;
}

function records(target: Node, run: () => void): MutationRecord[] {
  const observer = new MutationObserver(() => undefined);
  observer.observe(target, { subtree: true, childList: true, attributes: true, characterData: true });
  run();
  const seen = observer.takeRecords();
  observer.disconnect();
  return seen;
}

function head(row: ToolRow): HTMLElement {
  const node = row.el.querySelector<HTMLElement>('.acp-harness__tool-head');
  if (!node) throw new Error('no head');
  return node;
}

/** The status LED, which sits inside the kind chip before its legend. */
function glyphOf(row: ToolRow): HTMLElement {
  const node = head(row).querySelector<HTMLElement>(':scope > .acp-harness__tool-kind > .acp-harness__tool-glyph');
  if (!node) throw new Error('no glyph in the kind chip');
  return node;
}

function agent(over: Partial<SubagentEntry> = {}): SubagentEntry {
  return {
    id: 'scout-1',
    agent: 'explore',
    status: 'running',
    activity: 'reading',
    recentTools: [],
    toolCount: null,
    tokens: null,
    durationMs: null,
    task: 'map the kernel',
    output: '',
    hintLabel: null,
    ...over,
  };
}

describe('ToolRow head', () => {
  it('emits the kind chip with its LED inside, then subject and timer, in order', () => {
    const tool = payload({ startedAt: 1000, endedAt: 1400, status: 'completed', glyph: '\u2713' });
    const row = new ToolRow(props(tool));
    row.update(props(tool));

    expect(row.el.className).toBe('acp-harness__msg acp-harness__msg--tool acp-harness__msg--completed');
    expect(row.el.getAttribute('data-msg-id')).toBe('tool-1');
    expect(row.el.querySelector('.acp-harness__msg-label')?.textContent).toBe('tool');
    expect(row.el.querySelector('.acp-harness__msg-body')?.getAttribute('class')).toBe(
      'acp-harness__msg-body acp-harness__tool',
    );

    const cells = Array.from(head(row).children);
    expect(cells.map((cell) => cell.getAttribute('class'))).toEqual([
      'acp-harness__tool-kind',
      'acp-harness__tool-subject',
      'acp-harness__tool-timer acp-harness__tool-timer--completed',
    ]);
    const chip = cells[0];
    expect(chip.firstChild).toBe(glyphOf(row));
    expect(glyphOf(row).getAttribute('class')).toBe('acp-harness__tool-glyph acp-harness__tool-glyph--completed');
    expect(glyphOf(row).textContent).toBe('\u2713');
    expect(chip.getAttribute('data-kind')).toBe('execute');
    expect(chip.lastChild?.textContent).toBe('execute');
    expect(cells[1].textContent).toBe('npm run check');
    expect(cells[2].getAttribute('data-started-at')).toBe('1000');
    expect(cells[2].getAttribute('data-ended-at')).toBe('1400');
    expect(cells[2].textContent).toBe('400ms');
  });

  it('keeps the same LED node inside the chip when the kind changes', () => {
    const row = new ToolRow(props(payload()));
    row.update(props(payload()));
    const glyph = glyphOf(row);

    row.update(props(payload({ kind: 'search' })));
    expect(glyphOf(row)).toBe(glyph);
    expect(head(row).querySelector('.acp-harness__tool-kind')?.lastChild?.textContent).toBe('search');
    row.dispose();
  });

  it('keeps the spinner class while the call is in flight and ticks in place', () => {
    const tool = payload({ status: 'in_progress' });
    const row = new ToolRow(props(tool));
    row.update(props(tool));

    const glyph = glyphOf(row);
    expect(glyph.getAttribute('class')).toBe(
      'acp-harness__tool-glyph acp-harness__tool-glyph--in_progress acp-harness__spinner',
    );
    const frame = glyph.textContent;
    tickAllSpinners();
    expect(glyph.textContent).not.toBe(frame);
    expect(glyphOf(row)).toBe(glyph);
    row.dispose();
  });

  it('adds the result span only when the payload carries one', () => {
    const row = new ToolRow(props(payload()));
    row.update(props(payload()));
    expect(row.el.querySelector('.acp-harness__tool-result')).toBeNull();

    row.update(props(payload({ status: 'failed', result: 'exit 1' })));
    const result = row.el.querySelector('.acp-harness__tool-result');
    expect(result?.getAttribute('class')).toBe('acp-harness__tool-result acp-harness__tool-result--failed');
    expect(result?.textContent).toBe('exit 1');
  });
});

describe('ToolRow output', () => {
  it('lays a column-laid-out section on the cell grid and leaves plain output as text (spec 326)', () => {
    const frame = ['╭────╮', '│ กำ │', '╰────╯'].join('\n');
    const tool = payload({ sections: [{ label: 'stdout', text: frame }, { label: 'stderr', text: 'warn: x' }] });
    const row = new ToolRow(props(tool));
    row.update(props(tool));

    const [gridded, plain] = Array.from(row.el.querySelectorAll<HTMLElement>('.acp-harness__tool-section-text'));
    expect(gridded.querySelector(':scope > code.acp-cellgrid.acp-cellgrid--text')).not.toBeNull();
    expect(gridded.textContent).toBe(frame);
    expect(plain.childNodes.length).toBe(1);
    expect(plain.firstChild?.nodeType).toBe(Node.TEXT_NODE);
  });

  it('seals a gridded section without touching it again (spec 326)', () => {
    const sections = [{ label: 'stdout', text: '│ ชื่อ  │ ค่า │' }];
    const running = props(payload({ status: 'in_progress', sections }), { streaming: true });
    const row = new ToolRow(running);
    const host = mount(row);
    row.update(running);
    const code = row.el.querySelector('.acp-harness__tool-section-text > code');
    expect(code).not.toBeNull();

    const done = props(payload({ status: 'completed', glyph: '\u2713', sections }), { streaming: true });
    row.update(done);
    expect(row.isLive).toBe(false);
    expect(row.el.querySelector('.acp-harness__tool-section-text > code')).toBe(code);
    expect(records(host, () => row.update(done)).length).toBe(0);
  });

  it('renders a 500-line section verbatim — the cap lives in the lane decoder', () => {
    const text = Array.from({ length: 500 }, (_, i) => `line ${i + 1}`).join('\n');
    const tool = payload({ kind: 'read', command: '', subject: 'src/ui/list.ts', sections: [{ label: 'content', text }] });
    const row = new ToolRow(props(tool));
    row.update(props(tool));

    const pre = row.el.querySelector('.acp-harness__tool-section-text');
    expect(pre?.textContent?.split('\n').length).toBe(500);
  });

  it('renders the git diff --stat bar through Meter', () => {
    const text = [
      'src/acp/lane-peek.ts    | 42 +++++++++',
      'src/ui/list.ts          |  4 ++--',
      ' 2 files changed, 46 insertions(+)',
    ].join('\n');
    const tool = payload({ command: 'git diff --stat', subject: 'git diff --stat', sections: [{ label: 'stdout', text }] });
    const row = new ToolRow(props(tool));
    row.update(props(tool));

    const rich = row.el.querySelector('.acp-harness__tool-rich');
    expect(rich?.getAttribute('class')).toBe('acp-harness__tool-rich acp-harness__tool-rich--diffstat');
    const first = rich?.firstElementChild;
    expect(Array.from(first?.children ?? []).map((node) => node.getAttribute('class'))).toEqual([
      'acp-harness__tool-stat-path acp-harness__tok-path',
      'acp-harness__tool-stat-count',
      'acp-harness__tool-stat-bar',
    ]);
    expect(first?.children[0].textContent).toBe('src/acp/lane-peek.ts');
    expect(first?.children[1].textContent).toBe('42');
    expect(first?.children[2].getAttribute('style')).toContain('--stat-plus-width');
  });

  it('renders a unified git diff through DiffBlock', () => {
    const text = [
      'diff --git a/src/ui/list.ts b/src/ui/list.ts',
      '@@ -1,3 +1,4 @@',
      '+export function syncOrder() {}',
      '-export function old() {}',
      ' const keep = 1;',
    ].join('\n');
    const tool = payload({ command: 'git diff', subject: 'git diff', sections: [{ label: 'stdout', text }] });
    const row = new ToolRow(props(tool));
    row.update(props(tool));

    const rich = row.el.querySelector('.acp-harness__tool-rich--unidiff');
    expect(Array.from(rich?.children ?? []).map((node) => node.getAttribute('class'))).toEqual([
      'acp-harness__tool-diff-file acp-harness__tok-path',
      'acp-harness__tool-diff-line acp-harness__tool-diff-line--hunk',
      'acp-harness__tool-diff-line acp-harness__tool-diff-line--add',
      'acp-harness__tool-diff-line acp-harness__tool-diff-line--del',
      'acp-harness__tool-diff-line acp-harness__tool-diff-line--context',
    ]);
    expect(rich?.children[0].textContent).toBe('src/ui/list.ts');
  });

  it('renders git status --short rows', () => {
    const tool = payload({
      command: 'git status --short',
      subject: 'git status --short',
      sections: [{ label: 'stdout', text: ' M src/ui/list.ts\n?? notes.md' }],
    });
    const row = new ToolRow(props(tool));
    row.update(props(tool));

    const rich = row.el.querySelector('.acp-harness__tool-rich--gitstatus');
    const badges = Array.from(rich?.querySelectorAll('.acp-harness__tool-status-badge') ?? []);
    expect(badges.map((node) => node.textContent)).toEqual(['M', '??']);
    expect(badges[1].getAttribute('class')).toBe(
      'acp-harness__tool-status-badge acp-harness__tool-status-badge--new',
    );
  });

  it('hands a grep-like dump to the structured grep renderer', () => {
    const tool = payload({
      command: 'rg --line-number reconcile src/ui',
      subject: 'rg reconcile',
      exitCode: 0,
      sections: [{ label: 'stdout', text: 'src/ui/list.ts:52:export function reconcile(\nsrc/ui/list.ts:83:}' }],
    });
    const row = new ToolRow(props(tool));
    row.update(props(tool));

    const section = row.el.querySelector('.acp-harness__tool-output')?.firstElementChild;
    expect(section?.getAttribute('class')).toBe(
      'acp-harness__tool-section acp-harness__tool-section--output',
    );
    expect(section?.querySelector('.acp-harness__tool-section-label')).toBeNull();
    const rows = Array.from(section?.querySelectorAll('.acp-harness__grep-row') ?? []);
    expect(rows.length).toBe(2);
    expect(rows[0].querySelector('.acp-harness__tok-path')?.textContent).toBe('src/ui/list.ts');
  });

  it('caps a paired diff at 24 rows with the "… N more lines" tail', () => {
    const oldText = Array.from({ length: 60 }, (_, i) => `old ${i}`).join('\n');
    const newText = Array.from({ length: 60 }, (_, i) => `new ${i}`).join('\n');
    const tool = payload({ diffs: [{ path: 'src/ui/list.ts', oldText, newText }] });
    const row = new ToolRow(props(tool));
    row.update(props(tool));

    const block = row.el.querySelector('.acp-harness__tool-diffs > .acp-harness__tool-diff');
    expect(block?.firstElementChild?.getAttribute('class')).toBe('acp-harness__tool-diff-path');
    expect(block?.firstElementChild?.textContent).toBe('src/ui/list.ts');
    const body = block?.lastElementChild;
    expect(body?.getAttribute('class')).toBe('acp-harness__tool-body acp-harness__tool-body--diff');
    expect(body?.querySelectorAll('.acp-harness__diff-line').length).toBe(24);
    expect(body?.lastElementChild?.getAttribute('class')).toBe('acp-harness__tool-more');
    expect(body?.lastElementChild?.textContent).toMatch(/^… \d+ more lines$/);
  });

  it('keeps the node of each diff block across updates', () => {
    const diffs = [
      { path: 'a.ts', oldText: 'a', newText: 'b' },
      { path: 'b.ts', oldText: 'c', newText: 'd' },
    ];
    const tool = payload({ diffs });
    const row = new ToolRow(props(tool));
    row.update(props(tool));
    const blocks = Array.from(row.el.querySelectorAll('.acp-harness__tool-diff'));

    row.update(props(payload({ diffs, result: 'done', status: 'in_progress' })));
    expect(Array.from(row.el.querySelectorAll('.acp-harness__tool-diff'))).toEqual(blocks);
  });
});

describe('ToolRow live contract', () => {
  it('writes nothing when pending becomes in_progress', () => {
    const sections = [{ label: 'stdout', text: 'building' }];
    const diffs: ToolPayload['diffs'] = [];
    const pending = payload({ status: 'pending', glyph: '\u283b', sections, diffs });
    const row = new ToolRow(props(pending));
    const host = mount(row);
    row.update(props(pending));

    // What the lane decoder hands the next pass (spec 380): a fresh object, the
    // same `sections` / `diffs` arrays.
    const inProgress = payload({ status: 'in_progress', glyph: '\u283b', sections, diffs });
    expect(records(host, () => row.update(props(inProgress))).length).toBe(0);
  });

  it('replaces only the output block when a section grows', () => {
    const pending = payload({ status: 'in_progress', sections: [{ label: 'stdout', text: 'one' }] });
    const row = new ToolRow(props(pending));
    mount(row);
    row.update(props(pending));

    const body = row.el.querySelector('.acp-harness__msg-body');
    const cells = Array.from(head(row).children);
    const before = head(row).outerHTML;
    const output = row.el.querySelector('.acp-harness__tool-output');
    const grown = payload({ status: 'in_progress', sections: [{ label: 'stdout', text: 'one\ntwo' }] });

    // Attribute records are left out on purpose: the SHARED base
    // (`TranscriptRow.syncClasses`) re-assigns `el`/`label`/`body` className on
    // every paint, which is not this row's write. The head is pinned by its
    // serialised form instead, which covers its attributes and its text.
    const observer = new MutationObserver(() => undefined);
    observer.observe(body as Node, { subtree: true, childList: true, characterData: true });
    row.update(props(grown));
    const seen = observer.takeRecords();
    observer.disconnect();

    expect(seen.length).toBeGreaterThan(0);
    for (const record of seen) expect(output?.contains(record.target)).toBe(true);
    expect(Array.from(head(row).children)).toEqual(cells);
    expect(head(row).outerHTML).toBe(before);
    expect(row.el.querySelector('.acp-harness__tool-section-text')?.textContent).toBe('one\ntwo');
  });

  it('seals on a terminal status and then writes nothing', () => {
    const sections = [{ label: 'stdout', text: 'done' }];
    const running = props(payload({ status: 'in_progress', sections }), { streaming: true });
    const row = new ToolRow(running);
    const host = mount(row);
    row.update(running);

    expect(row.isLive).toBe(true);
    expect(row.el.className).toContain('acp-harness__msg--streaming');
    const glyph = glyphOf(row);

    const done = props(payload({ status: 'completed', glyph: '\u2713', sections }), { streaming: true });
    row.update(done);

    expect(row.isLive).toBe(false);
    expect(row.el.className).toBe('acp-harness__msg acp-harness__msg--tool acp-harness__msg--completed');
    expect(glyphOf(row)).toBe(glyph);
    expect(glyph.getAttribute('class')).toBe(
      'acp-harness__tool-glyph acp-harness__tool-glyph--completed',
    );
    expect(glyph.textContent).toBe('\u2713');

    expect(records(host, () => row.update(done)).length).toBe(0);
  });

  it('re-derives the wrapper class when the lane stops and restarts streaming', () => {
    const sections = [{ label: 'stdout', text: 'x' }];
    const tool = payload({ status: 'in_progress', sections });
    const row = new ToolRow(props(tool, { streaming: true }));
    row.update(props(tool, { streaming: true }));
    expect(row.el.className).toContain('acp-harness__msg--streaming');

    row.update(props(tool, { streaming: false }));
    expect(row.el.className).toBe('acp-harness__msg acp-harness__msg--tool acp-harness__msg--in_progress');

    row.update(props(tool, { streaming: true }));
    expect(row.el.className).toBe(
      'acp-harness__msg acp-harness__msg--tool acp-harness__msg--in_progress acp-harness__msg--streaming',
    );
  });
});

describe('ToolRow subagents', () => {
  it('mounts the card with its head summary and forwards live progress', () => {
    const entry = agent();
    const tool = payload({ kind: 'agents', subject: 'agents', subagents: { source: 'omp', background: false, agents: [entry], overflow: 0 } });
    const row = new ToolRow(props(tool));
    const host = mount(row);
    row.update(props(tool));

    const summary = head(row).querySelector('.acp-harness__subagent-summary');
    expect(summary?.getAttribute('class')).toBe('acp-harness__tool-result acp-harness__subagent-summary');
    expect(summary?.textContent).toBe('0/1 done');
    const card = row.el.querySelector('.acp-harness__subagents');
    expect(card).not.toBeNull();

    entry.activity = 'reading src/ui/list.ts';
    const seen = records(host, () => row.update(props(tool)));

    expect(row.el.querySelector('.acp-harness__subagents')).toBe(card);
    expect(seen.length).toBeGreaterThan(0);
    for (const record of seen) expect(card?.contains(record.target)).toBe(true);
  });

  it('repaints an expand toggle without remounting the head', () => {
    const entry = agent();
    const subagents = { source: 'omp' as const, background: false, agents: [entry], overflow: 0 };
    const tool = payload({ kind: 'agents', subagents });
    const row = new ToolRow(props(tool));
    row.update(props(tool));

    const cells = Array.from(head(row).children);
    const card = row.el.querySelector('.acp-harness__subagents');

    row.update(props(tool, {}, ['scout-1']));
    expect(row.el.querySelector('.acp-harness__subagent-detail')?.textContent).toContain('map the kernel');
    expect(Array.from(head(row).children)).toEqual(cells);
    expect(row.el.querySelector('.acp-harness__subagents')).toBe(card);

    row.update(props(tool, {}, []));
    expect(row.el.querySelector('.acp-harness__subagent-detail')).toBeNull();
  });

  it('drops the card for a rejected spawn and shows the error output', () => {
    const subagents = { source: 'omp' as const, background: false, agents: [agent({ status: 'pending' })], overflow: 0 };
    const pending = payload({ kind: 'agents', subagents });
    const row = new ToolRow(props(pending));
    row.update(props(pending));
    expect(row.el.querySelector('.acp-harness__subagents')).not.toBeNull();

    const failed = payload({
      status: 'failed',
      kind: 'agents',
      sections: [{ label: 'output', text: '`model` is only accepted for the `seance` agent.' }],
    });
    row.update(props(failed));
    expect(row.el.querySelector('.acp-harness__subagents')).toBeNull();
    expect(row.el.querySelector('.acp-harness__tool-output')?.textContent).toContain('only accepted for the `seance` agent');
  });

  it('shows the redaction card instead of output, sections and diffs', () => {
    const tool = payload({
      kind: 'write',
      sections: [{ label: 'stdout', text: 'never' }],
      artifactRedaction: { tail: 'report.html', size: 2048, hash: 'abc', pending: false },
    });
    const row = new ToolRow(props(tool));
    row.update(props(tool));

    const body = row.el.querySelector('.acp-harness__msg-body');
    expect(Array.from(body?.children ?? []).map((node) => node.getAttribute('class'))).toEqual([
      'acp-harness__tool-head',
      'acp-harness__artifact-redaction',
    ]);
  });

  it('keeps a background card live after the row seals, and seals it once it is last reported', () => {
    const bg = (entry: Partial<SubagentEntry>, extra: Partial<SubagentPayload> = {}): ToolPayload => payload({
      status: 'completed',
      glyph: '\u2713',
      kind: 'agents',
      subagents: { source: 'omp', background: true, agents: [agent(entry)], overflow: 0, ...extra },
    });
    const row = new ToolRow(props(bg({ tokens: 1000 })));
    mount(row);
    row.update(props(bg({ tokens: 1000 })));
    const stats = (): string | null | undefined => row.el.querySelector('.acp-harness__subagent-stats')?.textContent;
    expect(stats()).toBe('1k tok');

    // The spawn returned and the row sealed; its agent still reports.
    row.update(props(bg({ tokens: 5000 })));
    expect(stats()).toBe('5k tok');

    row.update(props(bg({ tokens: 6000 }, { lastReported: true })));
    expect(head(row).querySelector('.acp-harness__subagent-summary')?.textContent)
      .toBe('0/1 done \u00b7 background \u00b7 last reported');
    const card = row.el.querySelector('.acp-harness__subagents');
    if (!card) throw new Error('no card');
    expect(records(card, () => row.update(props(bg({ tokens: 9000 }, { lastReported: true }))))).toHaveLength(0);

    // Settling is structural, so the sealed card still lands the final stats.
    row.update(props(bg({ status: 'completed', tokens: 9000 }, { background: false })));
    expect(stats()).toBe('9k tok');
    expect(row.el.querySelector('.acp-harness__subagent')?.className).toContain('acp-harness__subagent--completed');
  });

  it('paints a wait row from its job snapshot, never from its text sections', () => {
    const jobs: JobsPayload = {
      jobs: [{ id: 'KeyHintInventory', type: 'task', status: 'running', label: 'KeyHintInventory', durationMs: 164_900, exitCode: null }],
      overflow: 0,
      interrupted: false,
    };
    const tool = payload({
      kind: 'wait',
      command: '',
      subject: 'Waiting for keyboard hint inventory',
      sections: [{ label: 'content', text: '## Still Running (1) <system-notice>' }],
      jobs,
    });
    const row = new ToolRow(props(tool));
    row.update(props(tool));

    const body = row.el.querySelector('.acp-harness__msg-body');
    expect(Array.from(body?.children ?? []).map((node) => node.getAttribute('class'))).toEqual([
      'acp-harness__tool-head',
      'acp-harness__jobs',
    ]);
    expect(head(row).querySelector('.acp-harness__subagent-summary')?.textContent).toBe('1 running');
    expect(row.el.querySelector('.acp-harness__job')?.textContent).toBe('\u25cfKeyHintInventorytask2m 44s');
    expect(row.el.textContent).not.toContain('system-notice');
  });
});

describe('ToolRow lifecycle', () => {
  it('detaches the entrance listener and the spinner on dispose', () => {
    const tool = payload({ status: 'in_progress' });
    const row = new ToolRow(props(tool, { isNew: true }));
    row.update(props(tool, { isNew: true }));
    expect(row.el.className).toContain('acp-harness__msg--enter');

    const glyph = glyphOf(row);
    const frame = glyph.textContent;
    row.dispose();

    const event = new Event('animationend') as AnimationEvent;
    Object.defineProperty(event, 'animationName', { value: 'acp-harness-msg-enter' });
    row.el.dispatchEvent(event);
    expect(row.el.className).toContain('acp-harness__msg--enter');

    tickAllSpinners();
    expect(glyph.textContent).toBe(frame);
  });
});
