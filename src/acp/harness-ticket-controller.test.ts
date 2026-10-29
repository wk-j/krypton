// @vitest-environment happy-dom

import { describe, expect, it, vi } from 'vitest';
import { invoke } from '@tauri-apps/api/core';

import { HarnessTicketController } from './harness-ticket-controller';
import { HarnessDock } from './harness-dock';
import type { HarnessDockTab, PanelsCommand } from './harness-panel-visibility';
import type { TicketDockAction } from './harness-ticket-helpers';
import type { HarnessTicketHost } from './harness-view-host';
import type { HarnessLane, LocalTicketDetail } from './harness-view-types';

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

const LINKED: LocalTicketDetail = {
  ...TICKET,
  github: {
    issueKey: 'wk/krypton#342',
    issueUrl: 'https://github.com/wk/krypton/issues/342',
    repo: 'wk/krypton',
    number: 342,
    title: 'Ticket actions',
    state: 'open',
    fetchedAt: 0,
  },
};

function laneDouble(over: Partial<HarnessLane> = {}): HarnessLane {
  return { id: 'lane-1', displayName: 'codex-1', status: 'idle', client: {}, error: null, ...over } as HarnessLane;
}

interface VerbCall {
  lane: string;
  verb: string;
  args: string[];
}

function ticketDouble(
  activeTicket: LocalTicketDetail | null,
  ticketHidden = false,
  options: { lane?: HarnessLane; runVerb?: () => Promise<void> } = {},
): {
  ctl: HarnessTicketController;
  dock: HarnessDock;
  root: HTMLElement;
  commands: ApplyPanels[];
  flashes: string[];
  verbs: VerbCall[];
  lane: HarnessLane;
} {
  const commands: ApplyPanels[] = [];
  const flashes: string[] = [];
  const verbs: VerbCall[] = [];
  const lane = options.lane ?? laneDouble();
  const root = document.createElement('div');
  let ctl: HarnessTicketController | null = null;
  const dock = new HarnessDock(root, () => '/repo', (tab) => {
    if (tab === 'ticket') ctl?.renderTicketDock();
  });
  const host = {
    element: root,
    harnessMemoryId: 'harness-1',
    isPanelHidden: (panel: string): boolean => panel === 'ticket' && ticketHidden,
    applyPanelsCommand: (command: ApplyPanels): void => { commands.push(command); },
    setDockTabAvailable: (tab: HarnessDockTab, available: boolean): void => dock.setAvailable(tab, available),
    dockTabShown: (tab: HarnessDockTab): boolean => dock.isShown(tab),
    flashChip: (text: string): void => { flashes.push(text); },
    activeLane: (): HarnessLane => lane,
    issueBinding: (): null => null,
    runGithubIssuePromptVerb: (target: HarnessLane, verb: string, args: string[]): Promise<void> => {
      verbs.push({ lane: target.displayName, verb, args });
      return options.runVerb?.() ?? Promise.resolve();
    },
  } as unknown as HarnessTicketHost;
  ctl = new HarnessTicketController(host);
  ctl.mountDock();
  dock.setPane('ticket', ctl.ticketDockEl);
  ctl.activeTicket = activeTicket;
  ctl.renderTicketDock();
  return { ctl, dock, root, commands, flashes, verbs, lane };
}

const actionButton = (ctl: HarnessTicketController, verb: TicketDockAction): HTMLButtonElement => {
  const button = ctl.ticketDockEl.querySelector<HTMLButtonElement>(`[data-ticket-dock-action="${verb}"]`);
  if (!button) throw new Error(`no ${verb} button`);
  return button;
};

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

describe('Ticket Panel issue actions (spec 342)', () => {
  it('runs the clicked verb in the active lane with the ticket issue URL', () => {
    const { ctl, verbs } = ticketDouble(LINKED);

    actionButton(ctl, 'post-github-comment').click();

    expect(verbs).toEqual([
      { lane: 'codex-1', verb: 'post-github-comment', args: ['https://github.com/wk/krypton/issues/342'] },
    ]);
  });

  it('lets one dock action start per lane until its turn begins', () => {
    const { ctl, verbs, flashes, lane } = ticketDouble(LINKED, false, { runVerb: () => new Promise(() => {}) });

    actionButton(ctl, 'analyze-github-issue').click();
    actionButton(ctl, 'fix-github-issue').click();

    expect(verbs.map((call) => call.verb)).toEqual(['analyze-github-issue']);
    expect(flashes).toEqual(['Fix here: codex-1 is starting an action']);

    // The turn begins: the guard lifts and the button shows it running.
    ctl.beginAction(lane, 'analyze-github-issue');
    expect(actionButton(ctl, 'analyze-github-issue').textContent).toBe('Analyzerunning · codex-1');
  });

  it('records a finished turn and turns the button done without disabling it', async () => {
    const recorded: LocalTicketDetail = {
      ...LINKED,
      actions: { 'post-github-comment': { at: Date.now(), laneDisplayName: 'codex-1' } },
    };
    vi.mocked(invoke).mockReset();
    vi.mocked(invoke).mockResolvedValueOnce(recorded);
    const { ctl, lane } = ticketDouble(LINKED);

    ctl.beginAction(lane, 'post-github-comment');
    expect(actionButton(ctl, 'post-github-comment').classList.contains('acp-dock-action--running')).toBe(true);
    ctl.onTurnEnd(lane, 'end_turn');
    await vi.waitFor(() => {
      expect(actionButton(ctl, 'post-github-comment').classList.contains('acp-dock-action--done')).toBe(true);
    });

    expect(invoke).toHaveBeenCalledWith('acp_record_ticket_action', {
      harnessId: 'harness-1',
      ticketId: 'KR-331',
      verb: 'post-github-comment',
      laneDisplayName: 'codex-1',
    });
    expect(actionButton(ctl, 'post-github-comment').disabled).toBe(false);
  });

  it('records nothing for a turn that did not finish, and clears running', () => {
    vi.mocked(invoke).mockReset();
    const { ctl, lane } = ticketDouble(LINKED);

    ctl.beginAction(lane, 'fix-github-issue');
    ctl.onTurnEnd(lane, 'cancelled');
    ctl.beginAction(lane, 'fix-github-issue');
    lane.error = 'prompt failed';
    ctl.onTurnEnd(lane, 'end_turn');

    expect(invoke).not.toHaveBeenCalled();
    expect(actionButton(ctl, 'fix-github-issue').className).toBe('acp-dock-action');
  });

  it('cancels only the entry its own token registered', () => {
    const { ctl, lane } = ticketDouble(LINKED);

    const first = ctl.beginAction(lane, 'analyze-github-issue');
    const second = ctl.beginAction(lane, 'fix-github-issue');
    expect(first).not.toBeNull();
    expect(second).toBeNull();
    ctl.cancelAction(lane, {});
    expect(actionButton(ctl, 'analyze-github-issue').textContent).toBe('Analyzerunning · codex-1');
    if (first) ctl.cancelAction(lane, first);
    expect(actionButton(ctl, 'analyze-github-issue').textContent).toBe('Analyze');
  });
});
