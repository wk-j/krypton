// @vitest-environment happy-dom

import { describe, expect, it, vi } from 'vitest';

import { HarnessTicketController } from './harness-ticket-controller';
import { HarnessDock } from './harness-dock';
import type { HarnessDockTab, PanelsCommand } from './harness-panel-visibility';
import type { HarnessTicketHost } from './harness-view-host';
import type { LocalTicketDetail } from './harness-view-types';

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn() }));
vi.mock('@tauri-apps/api/event', () => ({ listen: vi.fn(async () => () => {}) }));

type ApplyPanels = Exclude<PanelsCommand, { kind: 'usage' }>;

const TICKET: LocalTicketDetail = {
  schemaVersion: 1,
  id: 'KR-331',
  title: 'Ticket panel',
  status: 'todo',
  createdAt: 0,
  updatedAt: 0,
  contextRevision: 1,
  relativePath: 'tickets/KR-331',
  resourceCount: 0,
  contextMarkdown: '',
  resources: [],
};

function ticketDouble(activeTicket: LocalTicketDetail | null, ticketHidden = false): {
  ctl: HarnessTicketController;
  dock: HarnessDock;
  root: HTMLElement;
  commands: ApplyPanels[];
  flashes: string[];
} {
  const commands: ApplyPanels[] = [];
  const flashes: string[] = [];
  const root = document.createElement('div');
  let ctl: HarnessTicketController | null = null;
  const dock = new HarnessDock(root, () => '/repo', (tab) => {
    if (tab === 'ticket') ctl?.renderTicketDock();
  });
  const host = {
    element: root,
    isPanelHidden: (panel: string): boolean => panel === 'ticket' && ticketHidden,
    applyPanelsCommand: (command: ApplyPanels): void => { commands.push(command); },
    setDockTabAvailable: (tab: HarnessDockTab, available: boolean): void => dock.setAvailable(tab, available),
    dockTabShown: (tab: HarnessDockTab): boolean => dock.isShown(tab),
    flashChip: (text: string): void => { flashes.push(text); },
  } as unknown as HarnessTicketHost;
  ctl = new HarnessTicketController(host);
  ctl.mountDock();
  dock.setPane('ticket', ctl.ticketDockEl);
  ctl.activeTicket = activeTicket;
  ctl.renderTicketDock();
  return { ctl, dock, root, commands, flashes };
}

describe('Ticket tab of the dock column (spec 337)', () => {
  it('is available only while a ticket is active and its flag is clear', () => {
    const shown = ticketDouble(TICKET);
    expect(shown.dock.isShown('ticket')).toBe(true);
    expect(shown.ctl.ticketDockEl.hidden).toBe(false);
    expect(shown.root.classList.contains('acp-harness--dock-active')).toBe(true);
    expect(shown.ctl.ticketDockEl.textContent).toContain('Ticket panel');

    const hidden = ticketDouble(TICKET, true);
    expect(hidden.dock.isShown('ticket')).toBe(false);
    expect(hidden.ctl.ticketDockEl.hidden).toBe(true);
    expect(hidden.root.classList.contains('acp-harness--dock-active')).toBe(false);

    const none = ticketDouble(null);
    expect(none.dock.isAvailable('ticket')).toBe(false);
  });

  it('does not paint while the Rails tab is the shown one', () => {
    const { ctl, dock } = ticketDouble(null);
    dock.setAvailable('rails', true);
    dock.select('rails');
    ctl.activeTicket = TICKET;
    ctl.renderTicketDock();

    expect(dock.isShown('rails')).toBe(true);
    expect(ctl.ticketDockEl.hidden).toBe(true);
    expect(ctl.ticketDockEl.textContent).not.toContain('Ticket panel');

    dock.select('ticket');
    expect(ctl.ticketDockEl.hidden).toBe(false);
    expect(ctl.ticketDockEl.textContent).toContain('Ticket panel');
  });
});

describe('Ticket Panel hide (spec 331)', () => {
  it('hides through the ticket panel flag from the dock button, Escape and #ticket panel', async () => {
    const { ctl, commands } = ticketDouble(TICKET);

    ctl.ticketDockEl.querySelector<HTMLButtonElement>('[data-ticket-dock-action="hide"]')?.click();
    ctl.ticketDockEl.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    await ctl.runTicketCommand(['panel']);

    expect(commands).toEqual([
      { kind: 'panel', panel: 'ticket', action: 'hide' },
      { kind: 'panel', panel: 'ticket', action: 'hide' },
      { kind: 'panel', panel: 'ticket', action: 'toggle' },
    ]);
  });

  it('leaves the flag alone when #ticket panel runs without an active ticket', async () => {
    const { ctl, commands, flashes } = ticketDouble(null);

    await ctl.runTicketCommand(['panel']);

    expect(commands).toEqual([]);
    expect(flashes).toEqual(['no working ticket set']);
  });
});
