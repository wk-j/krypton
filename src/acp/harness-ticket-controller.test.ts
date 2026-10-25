// @vitest-environment happy-dom

import { describe, expect, it, vi } from 'vitest';

import { HarnessTicketController } from './harness-ticket-controller';
import type { PanelsCommand } from './harness-panel-visibility';
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

function ticketDouble(activeTicket: LocalTicketDetail | null): {
  ctl: HarnessTicketController;
  commands: ApplyPanels[];
  flashes: string[];
} {
  const commands: ApplyPanels[] = [];
  const flashes: string[] = [];
  const host = {
    element: document.createElement('div'),
    isPanelHidden: (): boolean => false,
    applyPanelsCommand: (command: ApplyPanels): void => { commands.push(command); },
    flashChip: (text: string): void => { flashes.push(text); },
  } as unknown as HarnessTicketHost;
  const ctl = new HarnessTicketController(host);
  ctl.mountDock(document.createElement('div'));
  ctl.activeTicket = activeTicket;
  ctl.renderTicketDock();
  return { ctl, commands, flashes };
}

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
