import { invoke } from '@tauri-apps/api/core';
import { listen, type UnlistenFn } from '@tauri-apps/api/event';

import type { ContentView, PaneContentType } from './types';

interface TelegramBotIdentity {
  id: string;
  username: string;
  displayName: string;
}

interface TelegramHealth {
  state: string;
  detail: string;
  lastPollAt: number | null;
  backoffSeconds: number | null;
}

interface PairingCode {
  code: string;
  expiresAt: number;
}

interface PendingPairing {
  requestId: string;
  userId: string;
  displayName: string;
  chatId: string;
  chatKind: string;
  chatTitle: string;
  expiresAt: number;
}

interface TelegramStatus {
  enabled: boolean;
  richMessages: boolean;
  credentialState: 'configured' | 'missing' | 'unavailable';
  authorizedUserIds: string[];
  authorizedGroupChatIds: string[];
  bot: TelegramBotIdentity | null;
  health: TelegramHealth;
  pairing: PairingCode | null;
  pendingPairing: PendingPairing | null;
}

const EMPTY_STATUS: TelegramStatus = {
  enabled: false,
  richMessages: false,
  credentialState: 'missing',
  authorizedUserIds: [],
  authorizedGroupChatIds: [],
  bot: null,
  health: {
    state: 'loading',
    detail: 'Loading Telegram Controller…',
    lastPollAt: null,
    backoffSeconds: null,
  },
  pairing: null,
  pendingPairing: null,
};

export class TelegramSettingsContentView implements ContentView {
  readonly type: PaneContentType = 'telegram_settings';
  readonly element: HTMLElement;

  private status: TelegramStatus = EMPTY_STATUS;
  private body: HTMLElement;
  private closeCallback: (() => void) | null = null;
  private unlisten: UnlistenFn[] = [];
  private events = new AbortController();
  private disposed = false;
  private busy = false;
  private notice = '';

  constructor(container: HTMLElement) {
    this.element = document.createElement('div');
    this.element.className = 'krypton-telegram';
    this.element.tabIndex = 0;
    container.appendChild(this.element);

    this.body = document.createElement('div');
    this.body.className = 'krypton-telegram__body';
    this.element.appendChild(this.body);

    const hints = document.createElement('div');
    hints.className = 'krypton-telegram__hints';
    hints.textContent = 'r refresh · m rich messages · j/k scroll · q close';
    this.element.appendChild(hints);

    this.render();
    void this.initialize();
  }

  onClose(callback: () => void): void {
    this.closeCallback = callback;
  }

  focusView(): void {
    this.element.focus();
  }

  onKeyDown(event: KeyboardEvent): boolean {
    const editable = event.target instanceof HTMLInputElement;
    if (event.key === 'Escape' && editable) {
      event.target.blur();
      this.element.focus();
      return true;
    }
    if (editable) return false;
    if (event.key === 'q') {
      this.closeCallback?.();
      return true;
    }
    if (event.key === 'Escape') {
      this.closeCallback?.();
      return true;
    }
    if (event.key === 'r') {
      void this.refresh();
      return true;
    }
    if (event.key === ' ') {
      void this.mutate('telegram_set_enabled', { enabled: !this.status.enabled });
      return true;
    }
    if (event.key === 'm') {
      void this.mutate('telegram_set_rich_messages', {
        enabled: !this.status.richMessages,
      });
      return true;
    }
    if (event.key === 'p') {
      void this.mutate(
        this.status.pairing ? 'telegram_cancel_pairing' : 'telegram_start_pairing',
      );
      return true;
    }
    if (event.key === 't') {
      void this.mutate('telegram_test_connection');
      return true;
    }
    if (event.key === 'a') {
      this.element.querySelector<HTMLInputElement>('[data-telegram-add]')?.focus();
      return true;
    }
    if (event.key === 'd') {
      this.element.querySelector<HTMLButtonElement>('[data-telegram-remove]')?.focus();
      return true;
    }
    if (event.key === 'j' || event.key === 'ArrowDown') {
      this.body.scrollBy({ top: 72, behavior: 'smooth' });
      return true;
    }
    if (event.key === 'k' || event.key === 'ArrowUp') {
      this.body.scrollBy({ top: -72, behavior: 'smooth' });
      return true;
    }
    return false;
  }

  dispose(): void {
    this.disposed = true;
    this.events.abort();
    for (const unlisten of this.unlisten) unlisten();
    this.unlisten = [];
    this.element.remove();
  }

  private async initialize(): Promise<void> {
    try {
      await this.attachListener('telegram-status-changed');
      await this.attachListener('telegram-pairing-changed');
    } catch (error) {
      this.notice = `Event listener unavailable: ${String(error)}`;
    }
    await this.refresh();
  }

  private async attachListener(eventName: string): Promise<void> {
    const unlisten = await listen<TelegramStatus>(eventName, (event) => {
      if (this.disposed) return;
      this.status = event.payload;
      // A periodic poll-health event must not destroy a masked token or ID
      // input while the operator is typing. The next local action/refresh
      // renders the newest snapshot.
      if (!(document.activeElement instanceof HTMLInputElement)
        || !this.element.contains(document.activeElement)) {
        this.render();
      }
    });
    if (this.disposed) {
      unlisten();
      return;
    }
    this.unlisten.push(unlisten);
  }

  private async refresh(): Promise<void> {
    await this.run(async () => {
      this.status = await invoke<TelegramStatus>('telegram_get_status');
    });
  }

  private async run(action: () => Promise<void>, success = ''): Promise<void> {
    if (this.busy) return;
    this.busy = true;
    this.notice = '';
    this.render();
    try {
      await action();
      this.notice = success;
    } catch (error) {
      this.notice = String(error);
    } finally {
      this.busy = false;
      if (!this.disposed) this.render();
    }
  }

  private async mutate(command: string, args: Record<string, unknown> = {}, success = ''): Promise<void> {
    await this.run(async () => {
      this.status = await invoke<TelegramStatus>(command, args);
    }, success);
  }

  private render(): void {
    this.body.innerHTML = '';
    this.body.append(
      this.renderHero(),
      this.renderConnection(),
      this.renderAllowlist(),
      this.renderPairing(),
      this.renderSecurity(),
    );
  }

  private renderHero(): HTMLElement {
    const section = this.section('TELEGRAM // HARNESS CONTROL', 'Control live ACP lanes from approved Telegram identities.');
    section.classList.add('krypton-telegram__hero');
    const state = document.createElement('div');
    state.className = `krypton-telegram__state krypton-telegram__state--${healthTone(this.status.health.state)}`;
    state.textContent = this.status.health.state.replaceAll('_', ' ');
    section.querySelector('.krypton-telegram__section-head')?.appendChild(state);

    const copy = document.createElement('p');
    copy.className = 'krypton-telegram__lede';
    copy.textContent = 'Private chats accept normal messages. Groups require a command, @mention, or reply. Every Telegram-originated turn runs with one-turn BYPASS ALL.';
    section.appendChild(copy);

    if (this.notice) {
      const notice = document.createElement('div');
      notice.className = 'krypton-telegram__notice';
      notice.textContent = this.notice;
      section.appendChild(notice);
    }
    return section;
  }

  private renderConnection(): HTMLElement {
    const section = this.section('CONNECTION', 'The bot token is stored in the operating-system credential vault and is never displayed again.');
    const grid = document.createElement('div');
    grid.className = 'krypton-telegram__grid';

    const token = this.input('Bot token', '123456789:AA…', 'password');
    token.input.autocomplete = 'off';
    const save = this.button('SAVE TOKEN', async () => {
      if (!token.input.value.trim()) return;
      await this.mutate('telegram_set_token', { token: token.input.value }, 'Credential saved');
      token.input.value = '';
    }, 'primary');
    const remove = this.button('REMOVE', () => this.mutate('telegram_remove_token', {}, 'Credential removed'));
    token.actions.append(save, remove);

    const toggle = document.createElement('label');
    toggle.className = 'krypton-telegram__toggle';
    const checkbox = document.createElement('input');
    checkbox.type = 'checkbox';
    checkbox.checked = this.status.enabled;
    checkbox.disabled = this.busy;
    checkbox.addEventListener(
      'change',
      () => {
        void this.mutate('telegram_set_enabled', { enabled: checkbox.checked });
      },
      { signal: this.events.signal },
    );
    const toggleCopy = document.createElement('span');
    toggleCopy.textContent = 'ENABLE CONTROLLER';
    toggle.append(checkbox, toggleCopy);

    const richToggle = document.createElement('label');
    richToggle.className = 'krypton-telegram__toggle';
    const richCheckbox = document.createElement('input');
    richCheckbox.type = 'checkbox';
    richCheckbox.checked = this.status.richMessages;
    richCheckbox.disabled = this.busy;
    richCheckbox.addEventListener(
      'change',
      () => {
        void this.mutate('telegram_set_rich_messages', {
          enabled: richCheckbox.checked,
        });
      },
      { signal: this.events.signal },
    );
    const richToggleCopy = document.createElement('span');
    richToggleCopy.textContent = 'NATIVE RICH MESSAGES';
    richToggle.append(richCheckbox, richToggleCopy);

    const identity = this.fact(
      'BOT IDENTITY',
      this.status.bot
        ? `@${this.status.bot.username || 'unnamed'} · ${this.status.bot.id}`
        : `credential ${this.status.credentialState}`,
    );
    const health = this.fact('POLLING HEALTH', this.status.health.detail);
    const test = this.button('TEST CONNECTION', () => this.mutate('telegram_test_connection'), 'primary');
    const control = document.createElement('div');
    control.className = 'krypton-telegram__controls';
    control.append(toggle, richToggle, test);

    grid.append(token.root, identity, health, control);
    section.appendChild(grid);
    const richWarning = document.createElement('p');
    richWarning.className = 'krypton-telegram__lede';
    richWarning.textContent = this.status.richMessages
      ? 'Rich delivery is active for new responses: headings, tables, lists, code, and quotes. Older or third-party Telegram clients may show unsupported content.'
      : 'Messages use the compatible plain-text path. Enable native rich messages for structured agent responses.';
    section.appendChild(richWarning);
    return section;
  }

  private renderAllowlist(): HTMLElement {
    const section = this.section('ACCESS CONTROL', 'A group message is admitted only when both its sender and its chat are allowlisted.');
    const columns = document.createElement('div');
    columns.className = 'krypton-telegram__columns';
    columns.append(
      this.renderIdList('AUTHORIZED USERS', 'Telegram user ID', this.status.authorizedUserIds, false),
      this.renderIdList('AUTHORIZED GROUPS', 'Negative group chat ID', this.status.authorizedGroupChatIds, true),
    );
    section.appendChild(columns);
    return section;
  }

  private renderIdList(title: string, placeholder: string, ids: string[], group: boolean): HTMLElement {
    const card = document.createElement('div');
    card.className = 'krypton-telegram__list-card';
    const heading = document.createElement('h3');
    heading.textContent = title;
    const entry = this.input('', placeholder, 'text');
    entry.root.classList.add('krypton-telegram__input--compact');
    entry.input.inputMode = 'numeric';
    entry.input.dataset.telegramAdd = group ? 'group' : 'user';
    entry.actions.appendChild(
      this.button('ADD', async () => {
        const id = entry.input.value.trim();
        if (!id) return;
        await this.mutate(group ? 'telegram_add_group' : 'telegram_add_user', { id });
      }, 'primary'),
    );
    card.append(heading, entry.root);
    const list = document.createElement('div');
    list.className = 'krypton-telegram__id-list';
    if (ids.length === 0) {
      const empty = document.createElement('div');
      empty.className = 'krypton-telegram__empty';
      empty.textContent = 'No IDs configured';
      list.appendChild(empty);
    }
    for (const id of ids) {
      const row = document.createElement('div');
      row.className = 'krypton-telegram__id-row';
      const value = document.createElement('code');
      value.textContent = id;
      row.append(
        value,
        this.button('REMOVE', () => this.mutate(
          group ? 'telegram_remove_group' : 'telegram_remove_user',
          { id },
        ), 'default', 'telegram-remove'),
      );
      list.appendChild(row);
    }
    card.appendChild(list);
    return card;
  }

  private renderPairing(): HTMLElement {
    const section = this.section('PAIRING', 'Generate a five-minute code, send /pair CODE to the bot, then approve the exact identity locally.');
    const actions = document.createElement('div');
    actions.className = 'krypton-telegram__controls';
    actions.appendChild(this.button(
      this.status.pairing ? 'REGENERATE CODE' : 'GENERATE CODE',
      () => this.mutate('telegram_start_pairing'),
      'primary',
    ));
    if (this.status.pairing) {
      const code = document.createElement('code');
      code.className = 'krypton-telegram__pair-code';
      code.textContent = this.status.pairing.code;
      actions.append(
        code,
        this.button('CANCEL', () => this.mutate('telegram_cancel_pairing')),
      );
    }
    section.appendChild(actions);
    const pending = this.status.pendingPairing;
    if (pending) {
      const request = document.createElement('div');
      request.className = 'krypton-telegram__pair-request';
      const copy = document.createElement('div');
      const heading = document.createElement('strong');
      heading.textContent = 'PAIRING REQUEST';
      copy.appendChild(heading);
      const details = document.createElement('p');
      details.textContent = `${pending.displayName} · user ${pending.userId} · ${pending.chatKind} ${pending.chatId} · ${pending.chatTitle}`;
      copy.appendChild(details);
      const buttons = document.createElement('div');
      buttons.className = 'krypton-telegram__controls';
      buttons.append(
        this.button('APPROVE', () => this.mutate(
          'telegram_accept_pairing',
          { requestId: pending.requestId },
          'Pairing approved',
        ), 'primary'),
        this.button('REJECT', () => this.mutate(
          'telegram_reject_pairing',
          { requestId: pending.requestId },
          'Pairing rejected',
        )),
      );
      request.append(copy, buttons);
      section.appendChild(request);
    }
    return section;
  }

  private renderSecurity(): HTMLElement {
    const section = this.section('SECURITY CONTRACT', 'Telegram is a privileged remote controller, not a chat mirror.');
    const list = document.createElement('ul');
    for (const text of [
      'Unknown users are ignored; allowlisted users in unknown groups are rejected.',
      'Display names are informational. Authorization uses numeric user and chat IDs.',
      'Telegram turns bypass every agent permission prompt for that turn only.',
      'Removing an allowlist entry clears active chat-to-lane targets immediately.',
      'A bot-token change resets the update watermark for the new bot identity.',
    ]) {
      const item = document.createElement('li');
      item.textContent = text;
      list.appendChild(item);
    }
    section.appendChild(list);
    return section;
  }

  private section(title: string, subtitle: string): HTMLElement {
    const section = document.createElement('section');
    section.className = 'krypton-telegram__section';
    const head = document.createElement('div');
    head.className = 'krypton-telegram__section-head';
    const copy = document.createElement('div');
    const heading = document.createElement('h2');
    heading.textContent = title;
    const sub = document.createElement('p');
    sub.textContent = subtitle;
    copy.append(heading, sub);
    head.appendChild(copy);
    section.appendChild(head);
    return section;
  }

  private fact(label: string, value: string): HTMLElement {
    const root = document.createElement('div');
    root.className = 'krypton-telegram__fact';
    const key = document.createElement('span');
    key.textContent = label;
    const copy = document.createElement('strong');
    copy.textContent = value;
    root.append(key, copy);
    return root;
  }

  private input(label: string, placeholder: string, type: 'text' | 'password'): {
    root: HTMLElement;
    input: HTMLInputElement;
    actions: HTMLElement;
  } {
    const root = document.createElement('label');
    root.className = 'krypton-telegram__input';
    if (label) {
      const copy = document.createElement('span');
      copy.textContent = label;
      root.appendChild(copy);
    }
    const row = document.createElement('div');
    const input = document.createElement('input');
    input.type = type;
    input.placeholder = placeholder;
    input.disabled = this.busy;
    const actions = document.createElement('div');
    actions.className = 'krypton-telegram__input-actions';
    row.append(input, actions);
    root.appendChild(row);
    return { root, input, actions };
  }

  private button(
    label: string,
    action: () => void | Promise<void>,
    tone: 'default' | 'primary' = 'default',
    dataRole?: string,
  ): HTMLButtonElement {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = `krypton-telegram__button krypton-telegram__button--${tone}`;
    button.textContent = label;
    button.disabled = this.busy;
    if (dataRole) button.dataset.telegramRemove = '';
    button.addEventListener('click', () => void action(), {
      signal: this.events.signal,
    });
    return button;
  }
}

function healthTone(state: string): 'ok' | 'warn' | 'off' {
  if (state === 'connected') return 'ok';
  if (state === 'disabled' || state === 'stopped') return 'off';
  return 'warn';
}
