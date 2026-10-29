import { describe, expect, it } from 'vitest';

import type { TicketDockAction } from '../../harness-ticket-helpers';
import type { LocalTicketDetail, TicketResource } from '../../harness-view-types';
import type { DockActionState } from '../dock-action';
import { TicketDock, type TicketDockProps } from './index';

function resource(name: string, sizeBytes: number): TicketResource {
  return { name, relativePath: `res/${name}`, sizeBytes, modifiedAt: 0 };
}

function ticket(over: Partial<LocalTicketDetail> = {}): LocalTicketDetail {
  return {
    schemaVersion: 1,
    id: 'KR-301',
    title: 'Harness UI refactor',
    status: 'todo',
    createdAt: 0,
    updatedAt: 0,
    contextRevision: 1,
    relativePath: 'tickets/KR-301.md',
    resourceCount: 2,
    contextMarkdown: '# KR-301',
    resources: [resource('spec.md', 2048), resource('shot.png', 500)],
    ...over,
  };
}

function props(over: Partial<TicketDockProps> = {}): TicketDockProps {
  return {
    ticket: ticket(),
    workerName: null,
    laneName: 'codex-1',
    laneStatus: 'idle',
    workDisabledReason: null,
    actions: null,
    ...over,
  };
}

const GITHUB = {
  issueKey: 'wk/krypton#301',
  issueUrl: 'https://github.com/wk/krypton/issues/301',
  repo: 'wk/krypton',
  number: 301,
  title: 'Harness UI refactor',
  state: 'open' as const,
  fetchedAt: 0,
};

const IDLE: DockActionState = { kind: 'idle' };

function states(over: Partial<Record<TicketDockAction, DockActionState>> = {}): Record<TicketDockAction, DockActionState> {
  return {
    'analyze-github-issue': IDLE,
    'fix-github-issue': IDLE,
    'handle-github-issue': IDLE,
    'post-github-comment': IDLE,
    'tag-github-issue': IDLE,
    'attach-issue-artifact': IDLE,
    ...over,
  };
}

const action = (dock: TicketDock, verb: TicketDockAction): HTMLButtonElement => {
  const button = dock.el.querySelector<HTMLButtonElement>(`[data-ticket-dock-action="${verb}"]`);
  if (!button) throw new Error(`no ${verb} button`);
  return button;
};

const sectionTexts = (dock: TicketDock): string[] =>
  [...dock.el.querySelectorAll('section')].map((node) => node.textContent ?? '');

const metaTexts = (dock: TicketDock): string[] =>
  [...dock.el.querySelectorAll('.acp-ticket-dock__meta')].map((node) => node.textContent ?? '');

describe('TicketDock', () => {
  it('emits the expanded dock the controller writes today', () => {
    const dock = new TicketDock();
    dock.update(props({
      workerName: 'codex-1',
      ticket: ticket({
        github: GITHUB,
        contextExcerpt: 'Split the view into components.',
        analysis: { relativePath: 'analysis', markdownCount: 3, attachmentCount: 1, updatedAt: 0 },
        lastProgressSummary: 'layers 0-2 landed',
      }),
    }));

    expect(dock.el.querySelector('.acp-ticket-dock__eyebrow')?.textContent).toBe('active ticket');
    expect(dock.el.querySelector('.acp-ticket-dock__head h2')?.textContent)
      .toBe('Harness UI refactor');
    expect(dock.el.querySelector('.acp-ticket-dock__head button')?.getAttribute('aria-label'))
      .toBe('Hide ticket panel');
    expect(dock.el.querySelector<HTMLElement>('.acp-ticket-dock__head button')?.dataset.ticketDockAction)
      .toBe('hide');
    expect(dock.el.querySelector('.acp-ticket-dock__pill')?.className)
      .toBe('acp-ticket-dock__pill acp-ticket-dock__pill--todo');
    expect(dock.el.querySelector('.acp-ticket-dock__status-row code')?.textContent).toBe('KR-301');
    expect(metaTexts(dock)).toEqual(['GitHubwk/krypton#301 · open', 'Workercodex-1']);
    expect(dock.el.querySelector('.acp-ticket-dock__issue-link')?.getAttribute('href'))
      .toBe('https://github.com/wk/krypton/issues/301');
    expect(sectionTexts(dock)).toEqual([
      'Issue actionsrun in codex-1 · idleAnalyzeFix hereHandleCommentLabelAttach',
      'ContextSplit the view into components.',
      'Resources 2spec.md2.0 KiBshot.png500 B',
      'Analysis3 Markdown · 1 attachments',
      'Latest progresslayers 0-2 landed',
    ]);
  });

  it('falls back to the dock empty states when nothing is linked', () => {
    const dock = new TicketDock();
    dock.update(props({ ticket: ticket({ resources: [], resourceCount: 0 }) }));

    expect(metaTexts(dock)).toEqual(['GitHubnot linked', 'Workernot assigned']);
    expect(sectionTexts(dock)[0])
      .toBe('Issue actionsLink a GitHub issue to run issue actions: #ticket link <ref>');
    expect(dock.el.querySelector('[data-ticket-dock-action="fix-github-issue"]')).toBeNull();
    expect(sectionTexts(dock)[1]).toBe('ContextNo context note yet. Use #ticket note <text>.');
    expect(dock.el.querySelector('ul li')?.className).toBe('acp-ticket-dock__empty');
    expect(dock.el.querySelector('ul li')?.textContent).toBe('No managed resources');
    expect(sectionTexts(dock)[3]).toBe('AnalysisNo linked analysis bundle');
    expect(dock.el.querySelector('section:last-child p')?.className)
      .toBe('acp-ticket-dock__empty');
  });

  it('caps the resource list at six and counts the tail', () => {
    const dock = new TicketDock();
    const many = Array.from({ length: 9 }, (_unused, i) => resource(`r${i}.md`, 1024));
    dock.update(props({ ticket: ticket({ resources: many, resourceCount: 9 }) }));

    const rows = [...dock.el.querySelectorAll('ul li')];
    expect(rows.length).toBe(7);
    expect(rows[6].className).toBe('acp-ticket-dock__empty');
    expect(rows[6].textContent).toBe('+3 more');
    expect(dock.el.querySelector('h3 span')?.textContent).toBe('9');
  });

  it('keeps the resource rows when only the worker binding changes', () => {
    const dock = new TicketDock();
    const detail = ticket();
    dock.update(props({ ticket: detail, workerName: null }));
    const rows = [...dock.el.querySelectorAll('ul li')];

    dock.update(props({ ticket: detail, workerName: 'codex-1' }));

    expect([...dock.el.querySelectorAll('ul li')]).toEqual(rows);
    expect(metaTexts(dock)[1]).toBe('Workercodex-1');
  });

  it('empties itself when the active ticket is cleared', () => {
    const dock = new TicketDock();
    dock.update(props());
    dock.update(props({ ticket: null }));

    expect(dock.el.children.length).toBe(0);
    expect(dock.el.hasAttribute('aria-expanded')).toBe(false);
  });

  it('leaves a host element its own class', () => {
    const host = document.createElement('aside');
    host.className = 'acp-harness__ticket-dock';
    const dock = new TicketDock(host);
    dock.update(props());

    expect(dock.el).toBe(host);
    expect(host.className).toBe('acp-harness__ticket-dock');
  });

  it('writes nothing while the ticket fields hold', () => {
    const dock = new TicketDock();
    const detail = ticket();
    dock.update(props({ ticket: detail }));

    let mutations = 0;
    const observer = new MutationObserver((records) => {
      mutations += records.length;
    });
    observer.observe(dock.el, { subtree: true, childList: true, attributes: true, characterData: true });
    dock.update(props({ ticket: detail }));
    mutations += observer.takeRecords().length;
    observer.disconnect();

    expect(mutations).toBe(0);
  });

  it('escapes nothing by hand — the title goes through the DOM', () => {
    const dock = new TicketDock();
    dock.update(props({ ticket: ticket({ title: '<img src=x onerror=1>' }) }));

    expect(dock.el.querySelector('img')).toBeNull();
    expect(dock.el.querySelector('.acp-ticket-dock__head h2')?.textContent)
      .toBe('<img src=x onerror=1>');
  });

  it('tears its resource rows down on dispose', () => {
    const dock = new TicketDock();
    dock.update(props());
    dock.dispose();
    expect(dock.el.querySelectorAll('ul li').length).toBe(0);
  });

  // Spec 342 — issue actions.

  it('shows each action state on its button and keeps a done action clickable', () => {
    const dock = new TicketDock();
    dock.update(props({
      ticket: ticket({ github: GITHUB }),
      actions: states({
        'post-github-comment': { kind: 'done', badge: '✓ 14:02', detail: 'Comment ran 2026-10-29 14:02 in codex-1' },
        'fix-github-issue': { kind: 'running', badge: 'running · claude-1', detail: 'Fix here running in claude-1' },
      }),
    }));

    const comment = action(dock, 'post-github-comment');
    expect(comment.className).toBe('acp-dock-action acp-dock-action--done');
    expect(comment.disabled).toBe(false);
    expect(comment.textContent).toBe('Comment✓ 14:02');
    expect(comment.title).toBe('Comment ran 2026-10-29 14:02 in codex-1');
    expect(comment.querySelector('use')?.getAttribute('href')).toBe('#krypton-icon-issue-comment');

    const fix = action(dock, 'fix-github-issue');
    expect(fix.className).toBe('acp-dock-action acp-dock-action--running');
    expect(fix.textContent).toBe('Fix hererunning · claude-1');
    expect(fix.querySelector('use')?.getAttribute('href')).toBe('#krypton-icon-tool');

    const label = action(dock, 'tag-github-issue');
    expect(label.className).toBe('acp-dock-action');
    expect(label.textContent).toBe('Label');
    expect(label.hasAttribute('title')).toBe(false);
  });

  it('disables every action with the lane reason, as text and tooltip', () => {
    const dock = new TicketDock();
    dock.update(props({
      ticket: ticket({ github: GITHUB }),
      workDisabledReason: 'codex-1 is busy',
      actions: states({ 'post-github-comment': { kind: 'running', badge: 'running · codex-1', detail: 'Comment running in codex-1' } }),
    }));

    const buttons = [...dock.el.querySelectorAll<HTMLButtonElement>('.acp-dock-action')];
    expect(buttons.map((button) => button.disabled)).toEqual([true, true, true, true, true, true]);
    expect(action(dock, 'analyze-github-issue').title).toBe('codex-1 is busy');
    expect(action(dock, 'post-github-comment').classList.contains('acp-dock-action--running')).toBe(true);
    const target = dock.el.querySelector('.acp-ticket-dock__target');
    expect(target?.textContent).toBe('codex-1 is busy');
    expect(target?.classList.contains('acp-ticket-dock__target--blocked')).toBe(true);

    dock.update(props({ ticket: ticket({ github: GITHUB }), actions: states() }));
    expect(action(dock, 'analyze-github-issue').disabled).toBe(false);
    expect(action(dock, 'analyze-github-issue').hasAttribute('title')).toBe(false);
    expect(dock.el.querySelector('.acp-ticket-dock__target')?.textContent).toBe('run in codex-1 · idle');
  });

  it('writes nothing when equal action states arrive as a new object', () => {
    const dock = new TicketDock();
    const detail = ticket({ github: GITHUB });
    const done = (): DockActionState => ({ kind: 'done', badge: '✓ PR', detail: 'PR opened' });
    dock.update(props({ ticket: detail, actions: states({ 'fix-github-issue': done() }) }));

    let mutations = 0;
    const observer = new MutationObserver((records) => {
      mutations += records.length;
    });
    observer.observe(dock.el, { subtree: true, childList: true, attributes: true, characterData: true });
    dock.update(props({ ticket: detail, actions: states({ 'fix-github-issue': done() }) }));
    mutations += observer.takeRecords().length;
    observer.disconnect();

    expect(mutations).toBe(0);
  });
});
