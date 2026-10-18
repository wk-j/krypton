import { invoke } from '@tauri-apps/api/core';
import { listen, type UnlistenFn } from '@tauri-apps/api/event';

import type { ContentView, PaneContentType } from './types';
import './styles/connected-computers.css';

export interface ComputerProfile {
  id: string;
  host: string;
  user?: string;
  port?: number;
  defaultCwd?: string;
}

type ConnectionState = 'configured' | 'connecting' | 'connected' | 'disconnected';

interface ComputerStatus {
  profile: ComputerProfile;
  state: ConnectionState;
  resolvedTarget: string | null;
  activeCommands: number;
  lastError: string | null;
}

interface ComputerList {
  revision: string;
  computers: ComputerStatus[];
}

export class ConnectedComputersContentView implements ContentView {
  readonly type: PaneContentType = 'connected_computers';
  readonly element: HTMLElement;

  private readonly listEl: HTMLElement;
  private readonly detailEl: HTMLElement;
  private readonly searchEl: HTMLInputElement;
  private readonly noticeEl: HTMLElement;
  private statuses: ComputerStatus[] = [];
  private revision = '';
  private selectedId: string | null = null;
  private editing = false;
  private busy = false;
  private loadError: string | null = null;
  private closeCallback: (() => void) | null = null;
  private openTerminalCallback: ((profile: ComputerProfile) => Promise<void>) | null = null;
  private unlisten: UnlistenFn | null = null;
  private readonly events = new AbortController();
  private disposed = false;

  constructor(container: HTMLElement) {
    this.element = document.createElement('div');
    this.element.className = 'krypton-computers';
    this.element.tabIndex = 0;
    container.appendChild(this.element);

    const header = document.createElement('header');
    header.className = 'krypton-computers__header';
    const heading = document.createElement('div');
    const eyebrow = document.createElement('span');
    eyebrow.className = 'krypton-computers__eyebrow';
    eyebrow.textContent = 'REMOTE ACCESS / LOCAL HARNESS';
    const title = document.createElement('h1');
    title.textContent = 'Connected Computers';
    const subtitle = document.createElement('p');
    subtitle.textContent = 'SSH targets available to local Harness lanes';
    heading.append(eyebrow, title, subtitle);
    const newButton = this.button('+ New computer', 'new');
    header.append(heading, newButton);

    const columns = document.createElement('div');
    columns.className = 'krypton-computers__columns';
    const listPanel = document.createElement('section');
    listPanel.className = 'krypton-computers__panel';
    const listHeading = document.createElement('h2');
    listHeading.textContent = 'COMPUTERS';
    this.searchEl = document.createElement('input');
    this.searchEl.type = 'search';
    this.searchEl.placeholder = 'Search by ID or host';
    this.searchEl.setAttribute('aria-label', 'Search computers');
    this.searchEl.addEventListener('input', () => this.renderList(), { signal: this.events.signal });
    this.listEl = document.createElement('div');
    this.listEl.className = 'krypton-computers__list';
    this.listEl.setAttribute('role', 'listbox');
    listPanel.append(listHeading, this.searchEl, this.listEl);

    const detailPanel = document.createElement('section');
    detailPanel.className = 'krypton-computers__panel';
    const detailHeading = document.createElement('h2');
    detailHeading.textContent = 'CONNECTION DETAILS';
    this.detailEl = document.createElement('div');
    this.detailEl.className = 'krypton-computers__detail';
    detailPanel.append(detailHeading, this.detailEl);
    columns.append(listPanel, detailPanel);

    this.noticeEl = document.createElement('div');
    this.noticeEl.className = 'krypton-computers__notice';
    this.noticeEl.setAttribute('role', 'status');
    this.noticeEl.setAttribute('aria-live', 'polite');
    const hint = document.createElement('footer');
    hint.className = 'krypton-computers__hint';
    hint.textContent = 'j/k select · / search · n new · e edit · Enter connect · x disconnect · t SSH terminal · r refresh · q close';
    this.element.append(header, columns, this.noticeEl, hint);
    this.element.addEventListener('click', (event) => this.handleClick(event), { signal: this.events.signal });
    this.element.addEventListener('submit', (event) => void this.handleSubmit(event), { signal: this.events.signal });
    this.renderList();
    this.renderDetail();
    void this.initialize();
  }

  onClose(callback: () => void): void { this.closeCallback = callback; }
  onOpenSshTerminal(callback: (profile: ComputerProfile) => Promise<void>): void {
    this.openTerminalCallback = callback;
  }
  focusView(): void { this.element.focus(); }

  onKeyDown(event: KeyboardEvent): boolean {
    const target = event.target;
    const editable = target instanceof HTMLInputElement;
    if (this.editing && event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
      this.detailEl.querySelector<HTMLFormElement>('form')?.requestSubmit();
      return true;
    }
    if (event.key === 'Escape' && this.editing) {
      this.editing = false;
      this.renderDetail();
      this.element.focus();
      return true;
    }
    if (editable) {
      if (event.key === 'Escape') { target.blur(); this.element.focus(); return true; }
      return false;
    }
    if (event.key === 'q' || event.key === 'Escape') { this.closeCallback?.(); return true; }
    if (event.key === '/') { this.searchEl.focus(); return true; }
    if (event.key === 'n') { this.startEdit(null); return true; }
    if (event.key === 'e') { this.startEdit(this.selected()); return true; }
    if (event.key === 'r') { void this.refresh(); return true; }
    if (event.key === 'x') { void this.disconnectSelected(); return true; }
    if (event.key === 't') { void this.openTerminalSelected(); return true; }
    if (event.key === 'Delete') { void this.removeSelected(); return true; }
    if (event.key === 'Enter') { void this.connectSelected(); return true; }
    if (event.key === 'j' || event.key === 'k' || event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      const filtered = this.visible();
      if (!filtered.length) return true;
      const at = filtered.findIndex((item) => item.profile.id === this.selectedId);
      const delta = event.key === 'j' || event.key === 'ArrowDown' ? 1 : -1;
      this.selectedId = filtered[(at + delta + filtered.length) % filtered.length].profile.id;
      this.renderList();
      this.renderDetail();
      return true;
    }
    return false;
  }

  dispose(): void {
    this.disposed = true;
    this.unlisten?.();
    this.unlisten = null;
    this.events.abort();
    this.statuses = [];
    this.closeCallback = null;
    this.openTerminalCallback = null;
    this.element.remove();
  }

  private async initialize(): Promise<void> {
    try {
      const unlisten = await listen('computer-status-changed', () => { void this.refresh(); });
      if (this.disposed) unlisten();
      else this.unlisten = unlisten;
    } catch (error) {
      this.notice(String(error));
    }
    await this.refresh();
  }

  private selected(): ComputerStatus | null {
    return this.statuses.find((item) => item.profile.id === this.selectedId) ?? null;
  }

  private filtered(): ComputerStatus[] {
    const query = this.searchEl.value.trim().toLowerCase();
    return this.statuses.filter((item) =>
      !query || (item.profile.id + ' ' + item.profile.host).toLowerCase().includes(query));
  }

  private visible(): ComputerStatus[] { return this.filtered().slice(0, 100); }

  private async refresh(reload = false): Promise<void> {
    try {
      const list = await invoke<ComputerList>(reload ? 'computer_reload' : 'computer_list');
      if (this.disposed) return;
      this.statuses = list.computers;
      this.revision = list.revision;
      this.loadError = null;
      if (!this.selected() && this.statuses.length) this.selectedId = this.statuses[0].profile.id;
      this.renderList();
      if (!this.editing) this.renderDetail();
    } catch (error) {
      this.loadError = String(error);
      this.notice(this.loadError);
      if (!this.editing) this.renderDetail();
    }
  }

  private renderList(): void {
    const selected = this.selectedId;
    const matches = this.filtered();
    const rows: HTMLElement[] = matches.slice(0, 100).map((item) => {
      const row = this.button('', 'select');
      row.className = 'krypton-computers__row';
      row.dataset.id = item.profile.id;
      row.setAttribute('role', 'option');
      row.setAttribute('aria-selected', String(item.profile.id === selected));
      const title = document.createElement('strong');
      title.textContent = item.profile.id;
      const state = document.createElement('span');
      state.className = 'krypton-computers__state krypton-computers__state--' + item.state;
      state.textContent = item.state;
      const target = document.createElement('small');
      target.textContent = item.resolvedTarget ?? item.profile.host;
      const activity = document.createElement('small');
      activity.textContent = item.activeCommands > 0
        ? item.activeCommands + ' commands running'
        : item.lastError ? 'Connection failed · see details' : '';
      row.append(title, state, target, activity);
      return row;
    });
    if (!rows.length) {
      const empty = document.createElement('p');
      empty.textContent = this.statuses.length ? 'No computers match.' : 'No saved computers. Press n to add one.';
      this.listEl.replaceChildren(empty);
    } else {
      if (matches.length > 100) {
        const more = document.createElement('p');
        more.textContent = 'Showing first 100 matches. Refine the search to find another computer.';
        rows.push(more);
      }
      this.listEl.replaceChildren(...rows);
    }
  }

  private renderDetail(): void {
    this.detailEl.replaceChildren();
    if (this.editing) return;
    if (this.loadError) {
      const error = document.createElement('p');
      error.className = 'krypton-computers__error';
      error.textContent = this.loadError;
      this.detailEl.append(error, this.button('Reload profile file', 'reload'));
      return;
    }
    const item = this.selected();
    if (!item) {
      const empty = document.createElement('p');
      empty.textContent = 'Select a computer or create a new profile.';
      this.detailEl.appendChild(empty);
      return;
    }
    const target = document.createElement('h3');
    target.textContent = item.resolvedTarget ?? item.profile.host;
    const state = document.createElement('p');
    state.className = 'krypton-computers__state krypton-computers__state--' + item.state;
    state.textContent = item.state.toUpperCase() + ' · ' + item.activeCommands + ' active commands';
    const facts = document.createElement('dl');
    for (const [label, value] of [
      ['Profile ID', item.profile.id],
      ['SSH host', item.profile.host],
      ['User', item.profile.user ?? 'OpenSSH config/default'],
      ['Port', item.profile.port?.toString() ?? 'OpenSSH config/default'],
      ['Default directory', item.profile.defaultCwd ?? 'Remote login home'],
    ]) {
      const dt = document.createElement('dt');
      dt.textContent = label;
      const dd = document.createElement('dd');
      dd.textContent = value;
      facts.append(dt, dd);
    }
    const actions = document.createElement('div');
    actions.className = 'krypton-computers__actions';
    actions.append(
      this.button(item.state === 'connected' ? 'Disconnect' : 'Connect',
        item.state === 'connected' ? 'disconnect' : 'connect'),
      this.button('Open SSH Terminal', 'terminal'),
      this.button('Edit', 'edit'),
      this.button('Remove', 'remove'),
    );
    if (item.state === 'connecting') {
      actions.querySelector<HTMLButtonElement>('[data-action="connect"]')?.setAttribute('disabled', '');
    }
    if (item.state === 'connected' || item.state === 'connecting') {
      actions.querySelector<HTMLButtonElement>('[data-action="edit"]')?.setAttribute('disabled', '');
      actions.querySelector<HTMLButtonElement>('[data-action="remove"]')?.setAttribute('disabled', '');
    }
    this.detailEl.append(target, state, facts);
    if (item.lastError) {
      const error = document.createElement('p');
      error.className = 'krypton-computers__error';
      error.textContent = item.lastError;
      this.detailEl.appendChild(error);
    }
    this.detailEl.appendChild(actions);
  }

  private startEdit(item: ComputerStatus | null): void {
    if (this.loadError) { this.notice('Reload the profile file before editing.'); return; }
    if (item && (item.state === 'connected' || item.state === 'connecting')) {
      this.notice('Disconnect this computer before editing.'); return;
    }
    this.editing = true;
    this.detailEl.replaceChildren();
    const form = document.createElement('form');
    form.className = 'krypton-computers__form';
    const profile = item?.profile;
    for (const [name, label, value] of [
      ['id', 'ID', profile?.id ?? ''],
      ['host', 'Host / SSH alias', profile?.host ?? ''],
      ['user', 'User (optional)', profile?.user ?? ''],
      ['port', 'Port (optional)', profile?.port?.toString() ?? ''],
      ['defaultCwd', 'Default directory (optional)', profile?.defaultCwd ?? ''],
    ]) {
      const field = document.createElement('label');
      field.textContent = label;
      const input = document.createElement('input');
      input.name = name;
      input.value = value;
      input.required = name === 'id' || name === 'host';
      if (name === 'id' && profile) input.readOnly = true;
      if (name === 'port') { input.type = 'number'; input.min = '1'; input.max = '65535'; }
      field.appendChild(input);
      form.appendChild(field);
    }
    const hint = document.createElement('p');
    hint.textContent = 'Keys and jump hosts stay in OpenSSH config. No credentials are stored here.';
    const actions = document.createElement('div');
    actions.className = 'krypton-computers__actions';
    const save = this.button('Save profile · Cmd+Enter', 'save');
    save.type = 'submit';
    actions.append(save, this.button('Cancel · Esc', 'cancel'));
    form.append(hint, actions);
    this.detailEl.appendChild(form);
    form.querySelector<HTMLInputElement>('input:not([readonly])')?.focus();
  }

  private async handleSubmit(event: Event): Promise<void> {
    const target = event.target;
    if (!(target instanceof HTMLFormElement) || !this.editing) return;
    event.preventDefault();
    const fields = new FormData(target);
    const id = String(fields.get('id') ?? '').trim();
    const host = String(fields.get('host') ?? '').trim();
    const user = String(fields.get('user') ?? '').trim();
    const portText = String(fields.get('port') ?? '').trim();
    const defaultCwd = String(fields.get('defaultCwd') ?? '').trim();
    if (!/^[a-z][a-z0-9_-]*$/.test(id)) { this.notice('ID must match [a-z][a-z0-9_-]*.'); return; }
    if (!host || host.startsWith('-') || /\s/.test(host)) { this.notice('Enter a valid host or SSH alias.'); return; }
    if (defaultCwd && !defaultCwd.startsWith('/')) { this.notice('Default directory must be absolute.'); return; }
    const profile: ComputerProfile = { id, host };
    if (user) profile.user = user;
    if (portText) profile.port = Number(portText);
    if (defaultCwd) profile.defaultCwd = defaultCwd;
    try {
      await this.mutate('computer_profile_save', { profile, expectedRevision: this.revision });
      this.selectedId = id;
      this.editing = false;
      this.renderList();
      this.renderDetail();
      this.element.focus();
    } catch (error) {
      // Reload changes the revision and list without replacing the active form.
      if (String(error).includes('Profile file changed')) {
        const actions = target.querySelector('.krypton-computers__actions');
        if (actions && !actions.querySelector('[data-action="reload"]')) {
          actions.appendChild(this.button('Reload file, then retry Save', 'reload'));
        }
      }
    }
  }

  private handleClick(event: MouseEvent): void {
    const target = event.target;
    if (!(target instanceof Element)) return;
    const button = target.closest<HTMLButtonElement>('[data-action]');
    if (!button) return;
    const action = button.dataset.action;
    if (action === 'select') {
      this.selectedId = button.dataset.id ?? null;
      this.editing = false;
      this.renderList();
      this.renderDetail();
    } else if (action === 'new') this.startEdit(null);
    else if (action === 'edit') this.startEdit(this.selected());
    else if (action === 'cancel') { this.editing = false; this.renderDetail(); this.element.focus(); }
    else if (action === 'connect') void this.connectSelected();
    else if (action === 'disconnect') void this.disconnectSelected();
    else if (action === 'remove') void this.removeSelected();
    else if (action === 'reload') void this.refresh(true);
    else if (action === 'terminal') {
      void this.openTerminalSelected();
    }
  }

  private async openTerminalSelected(): Promise<void> {
    const item = this.selected();
    if (!item || !this.openTerminalCallback) return;
    try { await this.openTerminalCallback(item.profile); }
    catch (error) { this.notice(String(error)); }
  }

  private async connectSelected(): Promise<void> {
    const item = this.selected();
    if (!item || item.state === 'connected' || item.state === 'connecting') return;
    await this.mutate('computer_connect', { id: item.profile.id }).catch(() => undefined);
  }

  private async disconnectSelected(): Promise<void> {
    const item = this.selected();
    if (!item || item.state !== 'connected') return;
    if (item.activeCommands > 0 && !window.confirm(
      item.activeCommands + ' commands are running. Disconnect and mark their outcomes unknown?',
    )) return;
    await this.mutate('computer_disconnect', { id: item.profile.id }).catch(() => undefined);
  }

  private async removeSelected(): Promise<void> {
    const item = this.selected();
    if (!item || item.state === 'connected' || item.state === 'connecting') return;
    if (!window.confirm('Remove profile ' + item.profile.id + '?')) return;
    await this.mutate('computer_profile_delete', {
      id: item.profile.id, expectedRevision: this.revision,
    }).catch(() => undefined);
  }

  private async mutate(command: string, args: Record<string, unknown>): Promise<void> {
    if (this.busy) return;
    this.busy = true;
    try {
      const list = await invoke<ComputerList>(command, args);
      if (this.disposed) return;
      this.statuses = list.computers;
      this.revision = list.revision;
      this.loadError = null;
      if (!this.selected() && this.statuses.length) this.selectedId = this.statuses[0].profile.id;
      this.notice('');
      this.renderList();
      if (!this.editing) this.renderDetail();
    } catch (error) {
      this.notice(String(error));
      throw error;
    } finally {
      this.busy = false;
    }
  }

  private notice(message: string): void { this.noticeEl.textContent = message; }

  private button(label: string, action: string): HTMLButtonElement {
    const button = document.createElement('button');
    button.type = 'button';
    button.textContent = label;
    button.dataset.action = action;
    return button;
  }
}
