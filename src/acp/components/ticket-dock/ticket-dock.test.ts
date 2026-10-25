import { describe, expect, it } from 'vitest';

import type { LocalTicketDetail, TicketResource } from '../../harness-view-types';
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
  return { ticket: ticket(), workerName: null, ...over };
}

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
        github: {
          issueKey: 'wk/krypton#301',
          issueUrl: 'https://github.com/wk/krypton/issues/301',
          repo: 'wk/krypton',
          number: 301,
          title: 'Harness UI refactor',
          state: 'open',
          fetchedAt: 0,
        },
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
    expect(sectionTexts(dock)[0]).toBe('ContextNo context note yet. Use #ticket note <text>.');
    expect(dock.el.querySelector('ul li')?.className).toBe('acp-ticket-dock__empty');
    expect(dock.el.querySelector('ul li')?.textContent).toBe('No managed resources');
    expect(sectionTexts(dock)[2]).toBe('AnalysisNo linked analysis bundle');
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
});
