// Krypton — ACP Harness View: shared working ticket controller (specs 194, 238, 239).
//
// Extracted from acp-harness-view.ts (spec 275). Owns the harness's active
// local ticket, its worker binding, the `#ticket` picker dialog and the ticket
// dock. Reaches the view only through `HarnessTicketHost`.

import { esc, formatAge } from './harness-format';
import { statusLabel } from './harness-lane-chrome';
import { errorText } from './harness-permission-scan';
import { renderActiveTicketPin } from './harness-prompts';
import type {
  ActiveWorkTicket,
  ActiveTicketPointer,
  ActiveTicketSnapshot,
  HarnessLane,
  GithubTicketReference,
  LocalTicketDetail,
  LocalTicketSummary,
  LocalTicketStatus,
  TicketPickerRow,
  TicketWorkerBinding,
} from './harness-view-types';
import { TICKET_COMMAND_ARGS } from './hash-commands';
import { invoke } from '@tauri-apps/api/core';
import { listen, type UnlistenFn } from '@tauri-apps/api/event';
import {
  PointerPersistGate,
  controlError,
  type TicketPickerAction,
  type TicketPickerTab,
  ticketPickerActionForKey,
  ticketPickerTabCounts,
  filterTicketPickerRows,
  ticketWorkActionDisabledReason,
  ticketMarkdownPath,
  isSameTicketPicker,
  formatTicketBytes,
} from './harness-ticket-helpers';
import type { HarnessTicketHost } from './harness-view-host';

export class HarnessTicketController {
  /** spec 238: the harness's shared project-local ticket (one per harness). */
  activeTicket: LocalTicketDetail | null = null;
  /** Legacy spec-194 snapshot kept only when migration cannot write yet. */
  legacyActiveTicket: ActiveWorkTicket | null = null;
  ticketWorker: TicketWorkerBinding | null = null;
  readonly activeTicketPersist = new PointerPersistGate();
  ticketPanelCollapsed = false;
  ticketPanelSeen = false;
  /** spec 194: open `#ticket` picker — its own modal dialog (not a composer
   *  popup); the filter is typed live into the dialog (the draft was consumed
   *  by #ticket). */
  ticketPicker: {
    rows: TicketPickerRow[];
    filter: string;
    index: number;
    tab: TicketPickerTab;
  } | null = null;
  private ticketProgressUnlisten: UnlistenFn | null = null;
  private ticketWorkerUnlisten: UnlistenFn | null = null;
  ticketOverlayEl!: HTMLElement;
  ticketPanelEl!: HTMLElement;
  ticketDockEl!: HTMLElement;
  private readonly ticketPanelClickHandler = (event: MouseEvent): void => {
    this.handleTicketPickerClick(event);
  };
  private readonly ticketDockClickHandler = (event: MouseEvent): void => {
    void this.handleTicketDockClick(event);
  };
  private readonly ticketDockKeyHandler = (event: KeyboardEvent): void => {
    if (event.key !== 'Escape' || this.ticketPanelCollapsed) return;
    event.preventDefault();
    this.ticketPanelCollapsed = true;
    this.host.render();
    this.host.element.focus();
  };

  constructor(private readonly host: HarnessTicketHost) {}

  mountDock(body: HTMLElement): void {
    this.ticketDockEl = document.createElement('aside');
    this.ticketDockEl.className = 'acp-harness__ticket-dock';
    this.ticketDockEl.hidden = true;
    this.ticketDockEl.setAttribute('aria-label', 'Active ticket');
    this.ticketDockEl.addEventListener('click', this.ticketDockClickHandler);
    this.ticketDockEl.addEventListener('keydown', this.ticketDockKeyHandler);
    body.appendChild(this.ticketDockEl);
  }

  /** spec 194: `#ticket` picker — its own modal dialog, not a composer popup. */
  mountOverlay(body: HTMLElement): void {
    this.ticketOverlayEl = document.createElement('aside');
    this.ticketOverlayEl.className = 'acp-harness__ticket-overlay';
    this.ticketOverlayEl.hidden = true;
    this.ticketPanelEl = document.createElement('div');
    this.ticketPanelEl.className = 'acp-ticket__panel';
    this.ticketPanelEl.setAttribute('role', 'dialog');
    this.ticketPanelEl.setAttribute('aria-modal', 'true');
    this.ticketPanelEl.setAttribute('aria-label', 'Working ticket');
    this.ticketPanelEl.addEventListener('click', this.ticketPanelClickHandler);
    this.ticketOverlayEl.appendChild(this.ticketPanelEl);
    body.appendChild(this.ticketOverlayEl);
  }

  async subscribe(): Promise<void> {
    this.ticketProgressUnlisten = await listen<{
      harnessId: string;
      ticketId: string;
      ticket: LocalTicketDetail;
    }>('acp-ticket-progress', (event) => {
      if (event.payload.harnessId !== this.host.harnessMemoryId) return;
      if (event.payload.ticketId !== this.activeTicket?.id) return;
      // spec 239: ticket_link stores a minimal snapshot; a changed issue key
      // means an agent-side link, so fetch the real title/state/labels via gh.
      const previousIssueKey = this.activeTicket.github?.issueKey;
      this.activeTicket = event.payload.ticket;
      this.renderTicketDock();
      const github = event.payload.ticket.github;
      if (github && github.issueKey !== previousIssueKey) {
        void this.enrichActiveTicket(event.payload.ticketId, github);
      }
    });

    // spec 239: a worker tool call on an unassigned active ticket claims the
    // binding hook-server-side with the lane display name as a placeholder id.
    // Mirror it locally and reconcile the real lane id so lane-removal cleanup
    // (clearTicketWorkerForLane) keeps matching.
    this.ticketWorkerUnlisten = await listen<{
      harnessId: string;
      ticketId: string;
      laneDisplayName: string;
    }>('acp-ticket-worker', (event) => {
      if (event.payload.harnessId !== this.host.harnessMemoryId) return;
      this.handleTicketWorkerClaim(event.payload);
    });
  }

  dispose(): void {
    this.ticketProgressUnlisten?.();
    this.ticketProgressUnlisten = null;
    this.ticketWorkerUnlisten?.();
    this.ticketWorkerUnlisten = null;
    this.ticketPanelEl?.removeEventListener('click', this.ticketPanelClickHandler);
    this.ticketDockEl?.removeEventListener('click', this.ticketDockClickHandler);
    this.ticketDockEl?.removeEventListener('keydown', this.ticketDockKeyHandler);
  }

  controlActiveTicket(params: Record<string, unknown>): ActiveTicketSnapshot {
    this.host.controlLane(params);
    if (!this.host.harnessMemoryId) throw controlError('unknown_harness', 'harness is not ready');
    const ticket = this.activeTicket;
    if (!ticket) return { harnessId: this.host.harnessMemoryId, ticket: null };
    return {
      harnessId: this.host.harnessMemoryId,
      ticket: {
        id: ticket.id,
        title: ticket.title,
        status: ticket.status,
        github: ticket.github ? {
          issueKey: ticket.github.issueKey,
          issueUrl: ticket.github.issueUrl,
          state: ticket.github.state,
        } : null,
        worker: this.ticketWorker?.ticketId === ticket.id
          ? { laneDisplayName: this.ticketWorker.laneDisplayName }
          : null,
        contextExcerpt: ticket.contextExcerpt ?? null,
        resourceCount: ticket.resourceCount,
        resources: ticket.resources.slice(0, 6).map((resource) => ({
          name: resource.name,
          sizeBytes: resource.sizeBytes,
        })),
        analysis: ticket.analysis ? {
          markdownCount: ticket.analysis.markdownCount,
          attachmentCount: ticket.analysis.attachmentCount,
        } : null,
        lastProgressSummary: ticket.lastProgressSummary ?? null,
      },
    };
  }

  async activateTicket(ticket: LocalTicketDetail): Promise<void> {
    const changed = this.activeTicket?.id !== ticket.id;
    this.activeTicket = ticket;
    await this.persistActiveTicketNow(ticket.id);
    if (changed) {
      this.ticketWorker = null;
      await this.setTicketWorker(null);
      if (!this.ticketPanelSeen) {
        this.ticketPanelCollapsed = this.host.element.getBoundingClientRect().width < 960;
        this.ticketPanelSeen = true;
      }
    }
    this.host.render();
  }

  async bindActiveTicket(lane: HarnessLane): Promise<boolean> {
    if (!this.activeTicket || !this.host.harnessMemoryId) return false;
    const binding: TicketWorkerBinding = {
      ticketId: this.activeTicket.id,
      laneId: lane.id,
      laneDisplayName: lane.displayName,
      assignedAt: Date.now(),
    };
    try {
      await invoke('acp_set_ticket_worker', {
        harnessId: this.host.harnessMemoryId,
        binding,
      });
      this.ticketWorker = binding;
      const updated = await this.updateActiveTicketStatus('in_progress');
      if (!updated) {
        this.ticketWorker = null;
        await this.setTicketWorker(null);
        return false;
      }
      return true;
    } catch (e) {
      this.host.flashChip(`ticket worker failed: ${errorText(e)}`);
      return false;
    }
  }

  async clearActiveTicket(): Promise<void> {
    if (!this.activeTicket) {
      this.host.flashChip('no working ticket set');
      return;
    }
    const id = this.activeTicket.id;
    this.activeTicket = null;
    this.ticketWorker = null;
    await this.setTicketWorker(null);
    const persisted = await this.persistActiveTicketNow(null);
    this.host.flashChip(persisted
      ? `ticket cleared (${id}); bundle kept on disk`
      : `ticket cleared for this session, but the saved pointer could not be updated`);
    this.host.render();
  }

  async clearTicketWorkerForLane(laneId: string): Promise<void> {
    if (this.ticketWorker?.laneId !== laneId) return;
    this.ticketWorker = null;
    await this.setTicketWorker(null);
  }

  /** Refresh optional GitHub metadata without changing local context or status. */
  async enrichActiveTicket(ticketId: string, github: GithubTicketReference): Promise<void> {
    if (!this.host.harnessMemoryId) return;
    try {
      const raw = await this.host.runWorkspaceCommand(
        'gh',
        ['issue', 'view', String(github.number), '-R', github.repo, '--json', 'title,state,labels,updatedAt'],
      );
      const meta = JSON.parse(raw) as {
        title?: string;
        state?: string;
        labels?: { name: string }[];
        updatedAt?: string;
      };
      if (this.activeTicket?.id !== ticketId) return;
      const updated: GithubTicketReference = {
        ...github,
        title: meta.title?.trim() || github.title,
        state: meta.state?.toLowerCase() === 'closed' ? 'closed' : 'open',
        labels: (meta.labels ?? []).map((label) => label.name),
        sourceUpdatedAt: meta.updatedAt,
        fetchedAt: Date.now(),
      };
      const detail = await invoke<LocalTicketDetail>('acp_update_ticket_github', {
        harnessId: this.host.harnessMemoryId,
        ticketId,
        github: updated,
      });
      if (this.activeTicket?.id === ticketId) {
        this.activeTicket = detail;
        this.renderTicketDock();
        if (this.ticketPicker) this.renderTicketOverlayEl();
      }
    } catch (e) {
      console.warn('[acp-harness] ticket GitHub refresh failed; local ticket remains usable:', e);
    }
  }

  async handleTicketDockClick(event: MouseEvent): Promise<void> {
    if (!(event.target instanceof Element)) return;
    const button = event.target.closest<HTMLButtonElement>('[data-ticket-dock-action]');
    if (!button || !this.ticketDockEl.contains(button) || button.disabled) return;
    if (button.dataset.ticketDockAction !== 'toggle') return;
    this.ticketPanelCollapsed = !this.ticketPanelCollapsed;
    this.ticketPanelSeen = true;
    if (this.ticketPanelCollapsed) this.host.render();
    else await this.reloadActiveTicket(false);
  }

  handleTicketPickerClick(event: MouseEvent): void {
    if (!this.ticketPicker || !(event.target instanceof Element)) return;
    const tabButton = event.target.closest<HTMLButtonElement>('[data-ticket-tab]');
    if (tabButton && this.ticketPanelEl.contains(tabButton)) {
      const tab = tabButton.dataset.ticketTab;
      if (tab === 'open' || tab === 'closed') this.setTicketPickerTab(tab);
      return;
    }
    const actionButton = event.target.closest<HTMLButtonElement>('[data-ticket-action]');
    if (actionButton && this.ticketPanelEl.contains(actionButton)) {
      const action = actionButton.dataset.ticketAction as TicketPickerAction | undefined;
      if (action && !actionButton.disabled) void this.runTicketPickerAction(action);
      return;
    }
    const row = event.target.closest<HTMLElement>('[data-ticket-index]');
    if (!row || !this.ticketPanelEl.contains(row)) return;
    const index = Number(row.dataset.ticketIndex);
    if (!Number.isInteger(index)) return;
    this.ticketPicker.index = index;
    this.renderTicketOverlayEl();
  }

  /** Modal-dialog key handling while the ticket picker is open: Tab switches
   *  Open/Closed, printable keys build the filter, ↑↓/⌃n⌃p move, Enter selects,
   *  modified numbers run the selected ticket, and Esc dismisses. Unclaimed
   *  combos fall through so app-level shortcuts keep working. */
  handleTicketPickerKey(e: KeyboardEvent): boolean {
    const picker = this.ticketPicker;
    if (!picker) return false;
    const matches = this.ticketPickerMatches();
    if (e.key === 'Escape') {
      e.preventDefault();
      this.ticketPicker = null;
      this.renderTicketOverlayEl();
      return true;
    }
    if (e.key === 'Tab') {
      e.preventDefault();
      this.setTicketPickerTab(picker.tab === 'open' ? 'closed' : 'open');
      return true;
    }
    if (e.key === 'ArrowDown' || (e.ctrlKey && (e.key === 'n' || e.key === 'N'))) {
      e.preventDefault();
      if (matches.length > 0) picker.index = (picker.index + 1) % matches.length;
      this.renderTicketOverlayEl();
      return true;
    }
    if (e.key === 'ArrowUp' || (e.ctrlKey && (e.key === 'p' || e.key === 'P'))) {
      e.preventDefault();
      if (matches.length > 0) picker.index = (picker.index - 1 + matches.length) % matches.length;
      this.renderTicketOverlayEl();
      return true;
    }
    const action = ticketPickerActionForKey(e);
    if (action) {
      e.preventDefault();
      void this.runTicketPickerAction(action);
      return true;
    }
    if (e.key === 'Backspace') {
      e.preventDefault();
      picker.filter = picker.filter.slice(0, -1);
      picker.index = 0;
      this.renderTicketOverlayEl();
      return true;
    }
    if (e.key.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey) {
      e.preventDefault();
      picker.filter += e.key;
      picker.index = 0;
      this.renderTicketOverlayEl();
      return true;
    }
    return false;
  }

  /**
   * spec 239: a worker tool call on the unassigned active ticket claimed the
   * binding hook-server-side, with the lane display name standing in for the
   * lane id. Mirror the binding locally and reconcile the real lane id back to
   * the hook server so lane-removal cleanup (clearTicketWorkerForLane) matches.
   */
  handleTicketWorkerClaim(env: { ticketId: string; laneDisplayName: string }): void {
    if (env.ticketId !== this.activeTicket?.id) return;
    const lane = this.host.lanes.find((l) => l.displayName === env.laneDisplayName);
    const binding: TicketWorkerBinding = {
      ticketId: env.ticketId,
      laneId: lane?.id ?? env.laneDisplayName,
      laneDisplayName: env.laneDisplayName,
      assignedAt: Date.now(),
    };
    this.ticketWorker = binding;
    if (lane) void this.setTicketWorker(binding);
    this.host.recordJournal(env.laneDisplayName, 'ticket', `claimed ${env.ticketId}`, {
      ticketId: env.ticketId,
    });
    this.renderTicketDock();
  }

  /** spec 194: insert the working-ticket pin right after the identity line —
   *  shared scope must not be buried under the tool-discoverability blocks. */
  insertTicketPin(lines: string[], _lane: HarnessLane): void {
    if (!this.activeTicket) return;
    lines.splice(1, 0, renderActiveTicketPin(this.activeTicket));
  }

  async openActiveTicketAnalysis(): Promise<void> {
    const ticket = this.activeTicket;
    if (!ticket?.github || !ticket.analysis || !this.host.harnessMemoryId) {
      this.host.flashChip('active ticket has no local analysis bundle');
      return;
    }
    const port = await invoke<number>('get_hook_server_port').catch(() => 0);
    if (!port) {
      this.host.flashChip('analysis viewer unavailable - hook server not ready');
      return;
    }
    const issue = `${ticket.github.repo}/${ticket.github.number}`;
    const url = `http://127.0.0.1:${port}/analysis?harness=${encodeURIComponent(this.host.harnessMemoryId)}` +
      `&issue=${encodeURIComponent(issue)}`;
    try {
      await invoke('open_url', { url });
      this.host.flashChip(url);
    } catch (e) {
      this.host.flashChip(`analysis open failed: ${errorText(e)}`);
    }
  }

  async openActiveTicketContext(): Promise<void> {
    const ticket = this.activeTicket;
    if (!ticket) return;
    const path = ticketMarkdownPath(this.host.projectDir, ticket.relativePath);
    if (this.host.openMarkdownViewCb) {
      try {
        await this.host.openMarkdownViewCb(path);
        this.host.flashChip(`opened ${ticket.relativePath}ticket.md`);
        return;
      } catch (e) {
        this.host.flashChip(`could not open ${path}: ${errorText(e)}`);
        return;
      }
    }
    if (this.host.openFileReferenceCb && await this.host.openFileReferenceCb(path)) {
      this.host.flashChip(`opened ${ticket.relativePath}ticket.md`);
      return;
    }
    this.host.flashChip(`could not open ${path}`);
  }

  /** Open local tickets immediately, then enrich the same picker with GitHub. */
  async openTicketPicker(): Promise<void> {
    if (!this.host.harnessMemoryId) {
      this.host.flashChip('ticket unavailable - no harness memory');
      return;
    }
    try {
      const local = await invoke<LocalTicketSummary[]>('acp_list_ticket_bundles', {
        harnessId: this.host.harnessMemoryId,
      });
      const rows: TicketPickerRow[] = local.map((ticket) => ({
        kind: 'local',
        ticketId: ticket.id,
        number: ticket.github?.number,
        title: ticket.title,
        labels: ticket.github ? [ticket.github.issueKey] : [],
        state: ticket.status,
        updatedAt: new Date(ticket.updatedAt).toISOString(),
        url: ticket.github?.issueUrl,
      }));
      const started = { rows, filter: '', index: 0, tab: 'open' as const };
      this.ticketPicker = started;
      this.renderTicketOverlayEl();

      try {
        const raw = await this.host.runWorkspaceCommand(
          'gh',
          ['issue', 'list', '--json', 'number,title,labels,state,updatedAt,url', '--limit', '50'],
        );
        const parsed = JSON.parse(raw) as {
          number: number;
          title?: string;
          labels?: { name: string }[];
          state?: string;
          updatedAt?: string;
          url?: string;
        }[];
        const linked = new Set(local.map((ticket) => ticket.github?.issueKey).filter(Boolean));
        const githubRows: TicketPickerRow[] = parsed
          .filter((r) => typeof r.number === 'number' && typeof r.url === 'string')
          .filter((r) => {
            const ref = this.host.parseIssueRef(r.url ?? '');
            return !ref || !linked.has(`${ref.repo}#${ref.number}`);
          })
          .sort((a, b) => b.number - a.number)
          .map((r) => ({
            kind: 'github' as const,
            number: r.number,
            title: r.title?.trim() ?? `#${r.number}`,
            labels: (r.labels ?? []).map((l) => l.name),
            state: r.state?.toLowerCase() === 'closed' ? 'closed' : 'open',
            updatedAt: r.updatedAt,
            url: r.url as string,
          }));
        if (isSameTicketPicker(started, this.ticketPicker)) {
          const seen = new Set(started.rows.map((row) => row.url ?? row.ticketId ?? row.title));
          for (const row of githubRows) {
            const key = row.url ?? row.title;
            if (seen.has(key)) continue;
            seen.add(key);
            started.rows.push(row);
          }
          this.renderTicketOverlayEl();
        }
      } catch (e) {
        console.warn('[acp-harness] GitHub ticket enrichment unavailable:', e);
        if (isSameTicketPicker(started, this.ticketPicker)) {
          started.rows.push({
            kind: 'unavailable',
            title: 'GitHub unavailable',
            labels: [],
            state: 'open',
          });
          this.renderTicketOverlayEl();
        }
      }
    } catch (e) {
      this.host.flashChip(`ticket list failed: ${errorText(e)}`);
    }
  }

  async persistActiveTicketNow(ticketId: string | null): Promise<boolean> {
    if (!this.host.harnessMemoryId) return false;
    const generation = this.activeTicketPersist.begin();
    const ticket: ActiveTicketPointer | null = ticketId
      ? { schemaVersion: 2, ticketId, activatedAt: Date.now() }
      : null;
    try {
      await invoke('acp_save_active_ticket', {
        harnessId: this.host.harnessMemoryId,
        ticket,
      });
      if (!this.activeTicketPersist.isCurrent(generation)) {
        return this.persistActiveTicketNow(this.activeTicket?.id ?? null);
      }
      return true;
    } catch (e) {
      console.warn('[acp-harness] persistActiveTicket failed:', e);
      return false;
    }
  }

  /** Rehydrate a v2 pointer, or migrate the former GitHub snapshot in place. */
  async refreshActiveTicket(): Promise<void> {
    if (!this.host.harnessMemoryId) return;
    try {
      const stored = await invoke<ActiveTicketPointer | ActiveWorkTicket | null>('acp_load_active_ticket', {
        harnessId: this.host.harnessMemoryId,
      });
      if (stored && 'ticketId' in stored && typeof stored.ticketId === 'string') {
        const detail = await invoke<LocalTicketDetail | null>('acp_load_ticket_bundle', {
          harnessId: this.host.harnessMemoryId,
          ticketId: stored.ticketId,
        });
        if (detail) {
          await this.activateTicket(detail);
        } else {
          await this.persistActiveTicketNow(null);
          this.host.flashChip(`ticket ${stored.ticketId} no longer exists; active pointer cleared`);
        }
        return;
      }
      if (stored && 'issueKey' in stored && typeof stored.issueKey === 'string') {
        this.legacyActiveTicket = stored;
        const ref = this.host.parseIssueRef(stored.issueKey);
        if (ref) {
          const migrated = await this.setActiveTicket(ref);
          if (migrated && await this.persistActiveTicketNow(migrated.id)) {
            this.legacyActiveTicket = null;
          }
        }
      }
    } catch (e) {
      console.warn('[acp-harness] refreshActiveTicket failed; legacy snapshot retained for retry:', e);
    }
  }

  async reloadActiveTicket(refreshGithub = false): Promise<LocalTicketDetail | null> {
    if (!this.activeTicket || !this.host.harnessMemoryId) return null;
    const ticketId = this.activeTicket.id;
    try {
      const detail = await invoke<LocalTicketDetail | null>('acp_load_ticket_bundle', {
        harnessId: this.host.harnessMemoryId,
        ticketId,
      });
      if (!detail) {
        this.activeTicket = null;
        this.ticketWorker = null;
        await this.setTicketWorker(null);
        await this.persistActiveTicketNow(null);
        this.host.render();
        this.host.flashChip(`ticket ${ticketId} was removed; active ticket cleared`);
        return null;
      }
      this.activeTicket = detail;
      // Ticket chrome only. A full dashboard remount here flashed the harness
      // when the worker lane went idle (setLaneStatus → this reload).
      this.renderTicketDock();
      if (this.ticketPicker) this.renderTicketOverlayEl();
      if (refreshGithub && detail.github) void this.enrichActiveTicket(ticketId, detail.github);
      return detail;
    } catch (e) {
      this.host.flashChip(`ticket refresh failed: ${errorText(e)}`);
      return null;
    }
  }

  renderTicketDock(): void {
    const ticket = this.activeTicket;
    this.ticketDockEl.hidden = !ticket || this.host.panelsHidden;
    this.host.element.classList.toggle('acp-harness--ticket-active', ticket !== null);
    this.host.element.classList.toggle(
      'acp-harness--ticket-collapsed',
      ticket !== null && this.ticketPanelCollapsed,
    );
    this.host.element.classList.toggle(
      'acp-harness--ticket-expanded',
      ticket !== null && !this.ticketPanelCollapsed,
    );
    if (!ticket) {
      this.ticketDockEl.innerHTML = '';
      return;
    }
    if (this.host.panelsHidden) return;
    const expanded = !this.ticketPanelCollapsed;
    this.ticketDockEl.setAttribute('aria-expanded', String(expanded));
    if (!expanded) {
      const statusLabel = ticket.status.replaceAll('_', ' ');
      this.ticketDockEl.innerHTML =
        `<button class="acp-ticket-dock__collapsed" type="button" data-ticket-dock-action="toggle" ` +
        `aria-label="Expand ticket ${esc(ticket.title)} (${esc(statusLabel)})" aria-expanded="false">‹</button>`;
      return;
    }
    const github = ticket.github
      ? `<div class="acp-ticket-dock__meta"><span>GitHub</span>` +
        `<strong title="${esc(ticket.github.issueKey)}">${esc(ticket.github.repo)}</strong>` +
        `<em><a class="acp-ticket-dock__issue-link" href="${esc(ticket.github.issueUrl)}" ` +
        `aria-label="Open ${esc(ticket.github.issueKey)} on GitHub">#${ticket.github.number}</a>` +
        ` · ${esc(ticket.github.state ?? 'unknown')}</em></div>`
      : `<div class="acp-ticket-dock__meta"><span>GitHub</span><em>not linked</em></div>`;
    const worker = this.ticketWorker
      ? `<strong>${esc(this.ticketWorker.laneDisplayName)}</strong>`
      : `<em>not assigned</em>`;
    const context = ticket.contextExcerpt
      ? esc(ticket.contextExcerpt)
      : 'No context note yet. Use #ticket note &lt;text&gt;.';
    const resources = ticket.resources.length === 0
      ? `<li class="acp-ticket-dock__empty">No managed resources</li>`
      : ticket.resources.slice(0, 6).map((resource) =>
          `<li><span>${esc(resource.name)}</span><em>${formatTicketBytes(resource.sizeBytes)}</em></li>`,
        ).join('');
    const moreResources = ticket.resources.length > 6
      ? `<li class="acp-ticket-dock__empty">+${ticket.resources.length - 6} more</li>`
      : '';
    const analysis = ticket.analysis
      ? `${ticket.analysis.markdownCount} Markdown · ${ticket.analysis.attachmentCount} attachments`
      : 'No linked analysis bundle';
    const progress = ticket.lastProgressSummary
      ? `<p>${esc(ticket.lastProgressSummary)}</p>`
      : `<p class="acp-ticket-dock__empty">No progress summary yet</p>`;
    this.ticketDockEl.innerHTML =
      `<header class="acp-ticket-dock__head">` +
      `<div><span class="acp-ticket-dock__eyebrow">active ticket</span>` +
      `<h2>${esc(ticket.title)}</h2></div>` +
      `<button type="button" data-ticket-dock-action="toggle" aria-label="Collapse ticket panel" ` +
      `aria-expanded="true">›</button></header>` +
      `<div class="acp-ticket-dock__status-row">` +
      `<span class="acp-ticket-dock__pill acp-ticket-dock__pill--${ticket.status}">${ticket.status}</span>` +
      `<code>${esc(ticket.id)}</code></div>` +
      github +
      `<div class="acp-ticket-dock__meta"><span>Worker</span>${worker}</div>` +
      `<section><h3>Context</h3><p>${context}</p></section>` +
      `<section><h3>Resources <span>${ticket.resourceCount}</span></h3>` +
      `<ul>${resources}${moreResources}</ul></section>` +
      `<section><h3>Analysis</h3><p>${esc(analysis)}</p></section>` +
      `<section><h3>Latest progress</h3>${progress}</section>`;
  }

  /** spec 194: `#ticket` picker — its own modal dialog (same overlay shell family
   *  as triage/review), keeping the palette keyboard grammar. The live filter
   *  renders as a dialog input line because the draft was consumed when #ticket
   *  opened the picker. */
  renderTicketOverlayEl(): void {
    const picker = this.ticketPicker;
    this.ticketOverlayEl.hidden = !picker;
    if (!picker) return;
    const matches = this.ticketPickerMatches();
    const counts = ticketPickerTabCounts(picker.rows);
    const safeIndex = Math.max(0, Math.min(picker.index, matches.length - 1));
    const selectedRow = matches[safeIndex];
    const lane = this.host.activeLane();
    const workDisabledReason = ticketWorkActionDisabledReason(lane
      ? { displayName: lane.displayName, status: lane.status, hasClient: lane.client !== null }
      : null);
    const workDisabled = !selectedRow || selectedRow.kind === 'unavailable' || !selectedRow.url || workDisabledReason !== null;
    const workDisabledAttr = workDisabled ? ' disabled' : '';
    const setDisabledAttr = !selectedRow || selectedRow.kind === 'unavailable' ? ' disabled' : '';
    const workTitleAttr = workDisabledReason ? ` title="${esc(workDisabledReason)}"` : '';
    const target = lane
      ? `target: ${esc(lane.displayName)} · ${esc(lane.status)}`
      : 'target: no active lane';
    const filter = picker.filter
      ? esc(picker.filter)
      : `<span class="acp-ticket__filter-hint">type to filter</span>`;
    const tabButton = (id: TicketPickerTab, label: string, count: number): string => {
      const active = picker.tab === id ? ' acp-ticket__tab--active' : '';
      return (
        `<button class="acp-ticket__tab${active}" type="button" role="tab" ` +
        `aria-selected="${picker.tab === id}" data-ticket-tab="${id}">` +
        `${label} <span class="acp-ticket__tab-count">${count}</span></button>`
      );
    };
    const empty = picker.filter.trim()
      ? 'no matching tickets'
      : picker.tab === 'closed'
        ? 'no closed tickets'
        : 'no open tickets';
    const rows = matches.length === 0
      ? `<div class="acp-ticket__empty">${empty}</div>`
      : matches
          .map((row, i) => {
            const sel = i === safeIndex ? ' acp-ticket__row--selected' : '';
            const labels = row.labels.length > 0
              ? `<span class="acp-ticket__labels">${esc(row.labels.join(', '))}</span>`
              : '';
            const updated = Date.parse(row.updatedAt ?? '');
            const age = Number.isNaN(updated) ? '' : formatAge(Date.now() - updated);
            const state = row.kind === 'unavailable' ? '' : ` · ${row.state}`;
            const key = row.kind === 'local'
              ? row.ticketId ?? 'local'
              : row.kind === 'unavailable'
                ? 'gh'
                : `#${row.number ?? '?'}`;
            const badge = row.kind === 'local'
              ? '<span class="acp-ticket__badge">LOCAL</span>'
              : row.kind === 'github'
                ? '<span class="acp-ticket__badge">IMPORT</span>'
                : '';
            const tag = row.kind === 'unavailable' ? 'div' : 'button';
            const typeAttr = row.kind === 'unavailable' ? '' : ' type="button"';
            return (
              `<${tag} class="acp-ticket__row${sel}${row.kind === 'unavailable' ? ' acp-ticket__row--unavailable' : ''}"${typeAttr} role="option" ` +
              `aria-selected="${i === safeIndex}" data-ticket-index="${i}"` +
              `${row.kind === 'unavailable' ? ' aria-disabled="true"' : ''}>` +
              `<span class="acp-ticket__title">${esc(row.title)}</span>` +
              `<span class="acp-ticket__identity">` +
              `<span class="acp-ticket__num">${esc(key)}</span>` +
              badge +
              `</span>` +
              labels +
              `<span class="acp-ticket__age">${esc(age)}${state}</span>` +
              `</${tag}>`
            );
          })
          .join('');
    this.ticketPanelEl.innerHTML =
      `<header class="acp-ticket__head">local tickets + GitHub` +
      `<span class="acp-ticket__sub">${target}</span></header>` +
      `<div class="acp-ticket__tabs" role="tablist" aria-label="Ticket status">` +
      tabButton('open', 'Open', counts.open) +
      tabButton('closed', 'Closed', counts.closed) +
      `</div>` +
      `<div class="acp-ticket__filter">${filter}<span class="acp-harness__caret">█</span></div>` +
      `<div class="acp-ticket__rows" role="listbox" data-count="${matches.length}">${rows}</div>` +
      `<div class="acp-ticket__actions" aria-label="Selected ticket actions">` +
      `<button class="acp-ticket__action" type="button" data-ticket-action="set-ticket"${setDisabledAttr}>` +
      `<span class="acp-ticket__action-key">Enter</span> Set ticket</button>` +
      `<button class="acp-ticket__action" type="button" data-ticket-action="analyze-github-issue"` +
      `${workDisabledAttr}${workTitleAttr}>` +
      `<span class="acp-ticket__action-key">⌘1</span> Analyze</button>` +
      `<button class="acp-ticket__action" type="button" data-ticket-action="post-github-comment"` +
      `${workDisabledAttr}${workTitleAttr}>` +
      `<span class="acp-ticket__action-key">⌘2</span> Post comment</button>` +
      `<button class="acp-ticket__action acp-ticket__action--fix" type="button" ` +
      `data-ticket-action="fix-github-issue"${workDisabledAttr}${workTitleAttr}>` +
      `<span class="acp-ticket__action-key">⌘3</span> Fix here</button>` +
      `</div>` +
      `<footer class="acp-ticket__foot">` +
      `<span>Tab open/closed · ↑↓ / ⌃n⌃p select · Esc dismiss</span>` +
      `<span>shared with all ${this.host.lanes.length} lanes · work runs in ${esc(lane?.displayName ?? 'no lane')}</span>` +
      `</footer>`;
    this.ticketPanelEl.querySelector('.acp-ticket__row--selected')?.scrollIntoView({ block: 'nearest' });
  }

  /** spec 238: local-first `#ticket` command family. */
  async runTicketCommand(args: string[]): Promise<void> {
    const sub = args[0];
    if (!sub) {
      await this.openTicketPicker();
      return;
    }
    if (sub === 'new') {
      const title = args.slice(1).join(' ').trim();
      if (!title || !this.host.harnessMemoryId) {
        this.host.flashChip('usage: #ticket new <title>');
        return;
      }
      try {
        const ticket = await invoke<LocalTicketDetail>('acp_create_ticket_bundle', {
          harnessId: this.host.harnessMemoryId,
          title,
          github: null,
        });
        await this.activateTicket(ticket);
        this.host.flashChip(`ticket created → ${ticket.id}`);
      } catch (e) {
        this.host.flashChip(`ticket create failed: ${errorText(e)}`);
      }
      return;
    }
    if (sub === 'clear') {
      await this.clearActiveTicket();
      return;
    }
    if (sub === 'refresh') {
      if (!this.activeTicket) {
        const legacyRef = this.legacyActiveTicket
          ? this.host.parseIssueRef(this.legacyActiveTicket.issueKey)
          : null;
        if (legacyRef) {
          const migrated = await this.setActiveTicket(legacyRef);
          if (migrated && await this.persistActiveTicketNow(migrated.id)) {
            this.legacyActiveTicket = null;
          }
          return;
        }
        this.host.flashChip('no working ticket set - #ticket to pick one');
        return;
      }
      await this.reloadActiveTicket(true);
      return;
    }
    if (sub === 'note') {
      const markdown = args.slice(1).join(' ').trim();
      if (!this.activeTicket || !this.host.harnessMemoryId || !markdown) {
        this.host.flashChip('usage: #ticket note <text> (with an active ticket)');
        return;
      }
      try {
        this.activeTicket = await invoke<LocalTicketDetail>('acp_append_ticket_note', {
          harnessId: this.host.harnessMemoryId,
          ticketId: this.activeTicket.id,
          markdown,
        });
        this.host.flashChip('ticket note added');
        this.host.render();
      } catch (e) {
        this.host.flashChip(`ticket note failed: ${errorText(e)}`);
      }
      return;
    }
    if (sub === 'add') {
      const sourcePath = args.slice(1).join(' ').trim();
      if (!this.activeTicket || !this.host.harnessMemoryId || !sourcePath) {
        this.host.flashChip('usage: #ticket add <path> (with an active ticket)');
        return;
      }
      try {
        this.activeTicket = await invoke<LocalTicketDetail>('acp_add_ticket_resource', {
          harnessId: this.host.harnessMemoryId,
          ticketId: this.activeTicket.id,
          sourcePath,
        });
        this.host.flashChip('ticket resource copied');
        this.host.render();
      } catch (e) {
        this.host.flashChip(`ticket resource failed: ${errorText(e)}`);
      }
      return;
    }
    if (sub === 'status') {
      const status = args[1] as LocalTicketStatus | undefined;
      if (!status || !['todo', 'in_progress', 'blocked', 'done'].includes(status)) {
        this.host.flashChip('usage: #ticket status <todo | in_progress | blocked | done>');
        return;
      }
      await this.updateActiveTicketStatus(status);
      return;
    }
    if (sub === 'work') {
      const lane = this.host.activeLane();
      const reason = ticketWorkActionDisabledReason(lane
        ? { displayName: lane.displayName, status: lane.status, hasClient: lane.client !== null }
        : null);
      if (!this.activeTicket || !lane || reason) {
        this.host.flashChip(!this.activeTicket ? 'no working ticket set' : (reason ?? 'no active lane'));
        return;
      }
      if (await this.bindActiveTicket(lane)) {
        this.host.flashChip(`ticket assigned → ${lane.displayName}`);
        this.host.render();
      }
      return;
    }
    if (sub === 'panel') {
      if (!this.activeTicket) {
        this.host.flashChip('no working ticket set');
        return;
      }
      this.ticketPanelCollapsed = !this.ticketPanelCollapsed;
      this.ticketPanelSeen = true;
      if (this.ticketPanelCollapsed) this.host.render();
      else await this.reloadActiveTicket(false);
      return;
    }
    if (sub === 'open') {
      await this.openActiveTicketContext();
      return;
    }
    if (sub === 'path') {
      if (!this.activeTicket) {
        this.host.flashChip('no working ticket set');
        return;
      }
      try {
        await navigator.clipboard.writeText(this.activeTicket.relativePath);
        this.host.flashChip(`copied ${this.activeTicket.relativePath}`);
      } catch (e) {
        this.host.flashChip(`copy failed: ${errorText(e)}`);
      }
      return;
    }
    if (sub === 'unlink') {
      if (!this.activeTicket || !this.host.harnessMemoryId) {
        this.host.flashChip('no working ticket set');
        return;
      }
      try {
        this.activeTicket = await invoke<LocalTicketDetail>('acp_update_ticket_github', {
          harnessId: this.host.harnessMemoryId,
          ticketId: this.activeTicket.id,
          github: null,
        });
        this.host.flashChip('GitHub reference removed; local bundle kept');
        this.host.render();
      } catch (e) {
        this.host.flashChip(`ticket unlink failed: ${errorText(e)}`);
      }
      return;
    }
    if (sub === 'link') {
      const ref = this.host.parseIssueRef(args.slice(1).join(' '));
      if (!ref || !this.activeTicket || !this.host.harnessMemoryId) {
        this.host.flashChip('usage: #ticket link <issue url | owner/repo#123>');
        return;
      }
      try {
        this.activeTicket = await invoke<LocalTicketDetail>('acp_update_ticket_github', {
          harnessId: this.host.harnessMemoryId,
          ticketId: this.activeTicket.id,
          github: this.host.githubReference(ref, this.activeTicket.github),
        });
        void this.enrichActiveTicket(this.activeTicket.id, this.activeTicket.github!);
        this.host.flashChip(`ticket linked → ${ref.repo}#${ref.number}`);
        this.host.render();
      } catch (e) {
        this.host.flashChip(`ticket link failed: ${errorText(e)}`);
      }
      return;
    }
    const ref = this.host.parseIssueRef(args.join(' '));
    if (!ref) {
      this.host.flashChip(`usage: #ticket ${TICKET_COMMAND_ARGS}`);
      return;
    }
    await this.setActiveTicket(ref);
  }

  async runTicketPickerAction(action: TicketPickerAction): Promise<void> {
    const picker = this.ticketPicker;
    if (!picker) return;
    const matches = this.ticketPickerMatches();
    const row = matches[Math.max(0, Math.min(picker.index, matches.length - 1))];
    if (!row) {
      this.host.flashChip('select a ticket first');
      return;
    }
    if (row.kind === 'unavailable') {
      this.host.flashChip('GitHub unavailable');
      return;
    }
    let lane: HarnessLane | null = null;
    if (action !== 'set-ticket') {
      lane = this.host.activeLane();
      const disabledReason = ticketWorkActionDisabledReason(lane
        ? { displayName: lane.displayName, status: lane.status, hasClient: lane.client !== null }
        : null);
      if (disabledReason) {
        this.host.flashChip(disabledReason);
        this.renderTicketOverlayEl();
        return;
      }
    }

    // Close before starting work so click/key repeat cannot enqueue the same action twice.
    this.ticketPicker = null;
    this.renderTicketOverlayEl();
    let ticket: LocalTicketDetail | null = null;
    try {
      if (row.kind === 'local' && row.ticketId && this.host.harnessMemoryId) {
        ticket = await invoke<LocalTicketDetail | null>('acp_load_ticket_bundle', {
          harnessId: this.host.harnessMemoryId,
          ticketId: row.ticketId,
        });
        if (ticket) await this.activateTicket(ticket);
      } else if (row.url) {
        const ref = this.host.parseIssueRef(row.url);
        if (ref) ticket = await this.setActiveTicket(ref);
      }
    } catch (e) {
      this.host.flashChip(`ticket failed: ${errorText(e)}`);
      return;
    }
    if (!ticket) {
      this.host.flashChip('could not activate selected ticket');
      return;
    }
    if (action === 'set-ticket') return;
    if (!ticket.github) {
      this.host.flashChip('active ticket has no GitHub reference; use #ticket link <ref>');
      return;
    }
    if (lane) await this.host.runGithubIssuePromptVerb(lane, action, [ticket.github.issueUrl]);
  }

  /** Find or create the local bundle linked to a GitHub issue, then activate it. */
  async setActiveTicket(
    ref: { repo: string; number: number; url: string },
  ): Promise<LocalTicketDetail | null> {
    if (!this.host.harnessMemoryId) {
      this.host.flashChip('ticket unavailable - no harness memory');
      return null;
    }
    const issueKey = `${ref.repo}#${ref.number}`;
    try {
      const rows = await invoke<LocalTicketSummary[]>('acp_list_ticket_bundles', {
        harnessId: this.host.harnessMemoryId,
      });
      const existing = rows.find((row) => row.github?.issueKey === issueKey);
      const ticket = existing
        ? await invoke<LocalTicketDetail | null>('acp_load_ticket_bundle', {
            harnessId: this.host.harnessMemoryId,
            ticketId: existing.id,
          })
        : await invoke<LocalTicketDetail>('acp_create_ticket_bundle', {
            harnessId: this.host.harnessMemoryId,
            title: issueKey,
            github: this.host.githubReference(ref),
          });
      if (!ticket) throw new Error(`local ticket ${existing?.id ?? issueKey} was not found`);
      await this.activateTicket(ticket);
      this.host.flashChip(`ticket active → ${ticket.id}`);
      void this.enrichActiveTicket(ticket.id, this.host.githubReference(ref, ticket.github));
      return ticket;
    } catch (e) {
      this.host.flashChip(`ticket failed: ${errorText(e)}`);
      return null;
    }
  }

  setTicketPickerTab(tab: TicketPickerTab): void {
    const picker = this.ticketPicker;
    if (!picker || picker.tab === tab) return;
    picker.tab = tab;
    picker.index = 0;
    this.renderTicketOverlayEl();
  }

  async setTicketWorker(binding: TicketWorkerBinding | null): Promise<void> {
    if (!this.host.harnessMemoryId) return;
    try {
      await invoke('acp_set_ticket_worker', {
        harnessId: this.host.harnessMemoryId,
        binding,
      });
    } catch (e) {
      console.warn('[acp-harness] set ticket worker failed:', e);
    }
  }

  ticketPickerMatches(): TicketPickerRow[] {
    const picker = this.ticketPicker;
    if (!picker) return [];
    return filterTicketPickerRows(picker.rows, picker.filter, picker.tab);
  }

  async updateActiveTicketStatus(
    status: LocalTicketStatus,
    summary?: string,
  ): Promise<LocalTicketDetail | null> {
    if (!this.activeTicket || !this.host.harnessMemoryId) return null;
    try {
      const detail = await invoke<LocalTicketDetail>('acp_update_ticket_status', {
        harnessId: this.host.harnessMemoryId,
        ticketId: this.activeTicket.id,
        status,
        summary,
      });
      this.activeTicket = detail;
      this.host.render();
      return detail;
    } catch (e) {
      this.host.flashChip(`ticket status failed: ${errorText(e)}`);
      return null;
    }
  }
}
