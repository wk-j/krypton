// Spec 302 §5.7 — `TicketDock`.
//
//   active ticket
//   Harness UI refactor                                            ›
//   open   KR-301
//   GitHub  wk/krypton   #301 · open
//   Worker  codex-1
//   ISSUE ACTIONS   run in codex-1 · idle
//   [Analyze ✓ 10-27] [Fix here ✓ PR] [Handle]      (each label has its icon)
//   [Comment]         [Label]          [Attach]
//   CONTEXT     …
//   RESOURCES 7 …
//
// Ports `HarnessTicketController.renderTicketDock`
// (src/acp/harness-ticket-controller.ts:603-676). That method wrote the whole
// dock as one `innerHTML` string on every ticket event — including the ones
// that only changed the worker binding or the GitHub state — so the resource
// list and the progress note were rebuilt to repaint a single `<strong>`.
//
// **Props only.** The component never imports the controller: the ticket, the
// worker, the target lane and the per-action states arrive as data. The head
// button carries `data-ticket-dock-action="hide"` and each issue action
// `data-ticket-dock-action="<verb>"`, both for the delegated click handler the
// controller installed on the dock element. That handler, the `hidden` flag
// (owned by the dock column, `harness-dock.ts`, from spec 320's per-panel
// `ticket` flag and the shown tab) and the `acp-harness--dock-active` class on
// the harness root stay outside: they are the dock's placement, not its content.
//
// Spec 331: the dock has no collapsed state. `›` hides it through the same
// flag, and the titlebar `Ticket dock` toggle shows it again.
//
// The hide button is hand-built rather than an `ActionButton`: it needs an
// `aria-label`, and `ActionButton` carries no ARIA props. Spec 342's action
// buttons are `IssueActionButton`s for the same kind of reason: an icon, a
// state badge line and a tooltip while enabled are three things `ActionButton`
// does not have.

import './ticket-dock.css';

import { Component } from '../../../ui/component';
import { el, setAttr } from '../../../ui/dom';
import { disposeList, reconcile } from '../../../ui/list';
import { harnessIconEl } from '../../harness-icons';
import {
  TICKET_DOCK_ACTIONS,
  formatTicketBytes,
  type TicketActionState,
  type TicketDockAction,
} from '../../harness-ticket-helpers';
import type { LocalTicketDetail } from '../../harness-view-types';
import { EmptyState } from '../empty-state';
import type { ComponentDef } from '../types';

/** How many resources the dock lists before it collapses the tail into `+N more`. */
const RESOURCE_LIMIT = 6;

export interface TicketDockProps {
  readonly ticket: LocalTicketDetail | null;
  /** The lane bound to this ticket, or null when nobody is working it. */
  readonly workerName: string | null;
  /** Spec 342: the active lane — every issue action runs there. */
  readonly laneName: string | null;
  readonly laneStatus: string | null;
  /** `ticketWorkActionDisabledReason()`; non-null disables every issue action. */
  readonly workDisabledReason: string | null;
  /** `ticketActionStates()`; null paints every action idle. */
  readonly actions: Readonly<Record<TicketDockAction, TicketActionState>> | null;
}

const ACTION_BLOCK = 'acp-ticket-dock__action';
const IDLE: TicketActionState = { kind: 'idle' };

interface IssueActionProps {
  readonly state: TicketActionState;
  readonly disabledReason: string | null;
}

/** One stable string per state, so the dock's deps compare by value. */
function stateKey(state: TicketActionState): string {
  if (state.kind === 'running') return `running\u001f${state.lane}`;
  if (state.kind === 'done') return `done\u001f${state.badge}\u001f${state.detail}`;
  return 'idle';
}

/**
 * Spec 342: one issue action. Verb, label and icon are fixed for the button's
 * life; only the state and the lane's disabled reason change. A `done` button
 * stays enabled — its colour warns, it never blocks. A `running` button keeps
 * its colour while the lane is busy, so you can still see what is running.
 */
class IssueActionButton extends Component<IssueActionProps> {
  private readonly stateEl = el('span', { class: `${ACTION_BLOCK}-state` });
  private readonly headEl: HTMLElement;

  constructor(
    readonly verb: TicketDockAction,
    private readonly label: string,
    icon: string,
  ) {
    super(el('button', { attrs: { type: 'button' }, data: { 'ticket-dock-action': verb } }));
    this.headEl = el(
      'span',
      { class: `${ACTION_BLOCK}-head` },
      harnessIconEl(icon, `${ACTION_BLOCK}-icon`),
      el('span', { class: `${ACTION_BLOCK}-label`, text: label }),
    );
  }

  protected readDeps(next: IssueActionProps): readonly unknown[] {
    return [stateKey(next.state), next.disabledReason];
  }

  protected syncClasses(next: IssueActionProps): void {
    const state = next.state.kind;
    this.el.className = state === 'idle' ? ACTION_BLOCK : `${ACTION_BLOCK} ${ACTION_BLOCK}--${state}`;
  }

  protected paint(next: IssueActionProps): void {
    this.syncClasses(next);
    const state = next.state;
    const disabled = next.disabledReason !== null;
    setAttr(this.el, 'disabled', disabled);
    let title: string | undefined;
    if (disabled) title = next.disabledReason ?? undefined;
    else if (state.kind === 'running') title = `${this.label} running in ${state.lane}`;
    else if (state.kind === 'done') title = state.detail;
    setAttr(this.el, 'title', title);
    if (state.kind === 'idle') {
      this.el.replaceChildren(this.headEl);
      return;
    }
    this.stateEl.textContent = state.kind === 'running' ? `running · ${state.lane}` : state.badge;
    this.el.replaceChildren(this.headEl, this.stateEl);
  }
}

type ResourceItem =
  | { readonly kind: 'resource'; readonly key: string; readonly name: string; readonly size: string }
  | { readonly kind: 'note'; readonly key: string; readonly text: string };

class ResourceRow extends Component<ResourceItem> {
  private readonly nameEl = el('span');
  private readonly sizeEl = el('em');

  constructor() {
    super(el('li'));
    this.el.append(this.nameEl, this.sizeEl);
  }

  protected readDeps(next: ResourceItem): readonly unknown[] {
    return next.kind === 'resource' ? [next.name, next.size] : [];
  }

  protected syncClasses(_next: ResourceItem): void {
    this.el.removeAttribute('class');
  }

  protected paint(next: ResourceItem): void {
    this.syncClasses(next);
    if (next.kind !== 'resource') return;
    this.nameEl.textContent = next.name;
    this.sizeEl.textContent = next.size;
  }
}

function resourceItems(ticket: LocalTicketDetail): ResourceItem[] {
  if (ticket.resources.length === 0) {
    return [{ kind: 'note', key: 'empty', text: 'No managed resources' }];
  }
  const items: ResourceItem[] = ticket.resources.slice(0, RESOURCE_LIMIT).map((resource) => ({
    kind: 'resource',
    key: resource.relativePath,
    name: resource.name,
    size: formatTicketBytes(resource.sizeBytes),
  }));
  if (ticket.resources.length > RESOURCE_LIMIT) {
    items.push({
      kind: 'note',
      key: 'more',
      text: `+${ticket.resources.length - RESOURCE_LIMIT} more`,
    });
  }
  return items;
}

export class TicketDock extends Component<TicketDockProps> {
  /** '' when the dock owns its root; the view's dock element otherwise. */
  private readonly hostClass: string | null;

  private readonly titleEl = el('h2');
  private readonly headEl: HTMLElement;
  private readonly pillEl = el('span');
  private readonly idEl = el('code');
  private readonly statusRowEl: HTMLElement;

  private readonly githubEl = el('div', { class: 'acp-ticket-dock__meta' });
  private readonly githubRepoEl = el('strong');
  private readonly githubValueEl = el('em');

  private readonly workerEl = el('div', { class: 'acp-ticket-dock__meta' });
  private readonly workerNameEl = el('strong');
  private readonly workerNoneEl = el('em', { text: 'not assigned' });

  private readonly actionsHead = el('h3', { text: 'Issue actions' });
  private readonly actionTargetEl = el('p');
  private readonly actionGridEl = el('div', {
    class: 'acp-ticket-dock__actions',
    attrs: { role: 'group', 'aria-label': 'Issue actions' },
  });
  private readonly actionButtons: readonly IssueActionButton[];
  private readonly actionsEmpty = new EmptyState('p');
  private readonly actionsSection: HTMLElement;

  private readonly contextEl = el('p');
  private readonly resourceCountEl = el('span');
  private readonly resourcesEl = el('ul');
  private readonly analysisEl = el('p');
  private readonly progressEl = el('p');
  private readonly progressEmpty = new EmptyState('p');
  private readonly progressHead = el('h3', { text: 'Latest progress' });
  private readonly progressSection: HTMLElement;
  private readonly parts: readonly HTMLElement[];

  constructor(host?: HTMLElement) {
    super(host ?? el('aside'));
    this.hostClass = host ? host.className : null;

    this.headEl = el(
      'header',
      { class: 'acp-ticket-dock__head' },
      el(
        'div',
        {},
        el('span', { class: 'acp-ticket-dock__eyebrow', text: 'active ticket' }),
        this.titleEl,
      ),
      el('button', {
        attrs: { type: 'button', 'aria-label': 'Hide ticket panel' },
        data: { 'ticket-dock-action': 'hide' },
        text: '›',
      }),
    );
    this.statusRowEl = el('div', { class: 'acp-ticket-dock__status-row' }, this.pillEl, this.idEl);
    this.githubEl.appendChild(el('span', { text: 'GitHub' }));
    this.workerEl.appendChild(el('span', { text: 'Worker' }));
    this.progressSection = el('section', {}, this.progressHead);
    this.actionButtons = TICKET_DOCK_ACTIONS.map(
      (action) => new IssueActionButton(action.verb, action.label, action.icon),
    );
    for (const button of this.actionButtons) this.actionGridEl.appendChild(button.el);
    this.actionsSection = el('section', {}, this.actionsHead);
    this.parts = [
      this.headEl,
      this.statusRowEl,
      this.githubEl,
      this.workerEl,
      this.actionsSection,
      el('section', {}, el('h3', { text: 'Context' }), this.contextEl),
      el(
        'section',
        {},
        el('h3', {}, 'Resources ', this.resourceCountEl),
        this.resourcesEl,
      ),
      el('section', {}, el('h3', { text: 'Analysis' }), this.analysisEl),
      this.progressSection,
    ];
  }

  protected readDeps(next: TicketDockProps): readonly unknown[] {
    const ticket = next.ticket;
    const github = ticket?.github ?? null;
    const actions = next.actions;
    return [
      ticket === null,
      next.workerName,
      next.laneName,
      next.laneStatus,
      next.workDisabledReason,
      actions ? TICKET_DOCK_ACTIONS.map((action) => stateKey(actions[action.verb])).join('\u001e') : null,
      ticket?.id,
      ticket?.title,
      ticket?.status,
      github?.repo,
      github?.number,
      github?.state,
      github?.issueKey,
      github?.issueUrl,
      ticket?.contextExcerpt,
      ticket?.resourceCount,
      ticket?.resources,
      ticket?.analysis?.markdownCount,
      ticket?.analysis?.attachmentCount,
      ticket?.lastProgressSummary,
    ];
  }

  protected syncClasses(_next: TicketDockProps): void {
    if (this.hostClass !== null) this.el.className = this.hostClass;
  }

  protected paint(next: TicketDockProps): void {
    this.syncClasses(next);
    const ticket = next.ticket;
    if (!ticket) {
      disposeList(this.resourcesEl);
      this.el.replaceChildren();
      return;
    }
    this.titleEl.textContent = ticket.title;
    this.pillEl.className = `acp-ticket-dock__pill acp-ticket-dock__pill--${ticket.status}`;
    this.pillEl.textContent = ticket.status;
    this.idEl.textContent = ticket.id;
    this.paintGithub(ticket);
    this.paintWorker(next.workerName);
    this.paintActions(next, ticket);
    this.paintBody(ticket);
    this.el.replaceChildren(...this.parts);
  }

  /**
   * Spec 342: six buttons, or a hint when there is no issue to act on. The
   * target line names the lane every action runs in, or says why it cannot
   * take one — in text, not only as greyed buttons.
   */
  private paintActions(next: TicketDockProps, ticket: LocalTicketDetail): void {
    if (!ticket.github) {
      this.actionsEmpty.update({
        block: 'acp-ticket-dock__empty',
        text: 'Link a GitHub issue to run issue actions: #ticket link <ref>',
      });
      this.actionsSection.replaceChildren(this.actionsHead, this.actionsEmpty.el);
      return;
    }
    const reason = next.workDisabledReason;
    this.actionTargetEl.className = reason === null
      ? 'acp-ticket-dock__target'
      : 'acp-ticket-dock__target acp-ticket-dock__target--blocked';
    this.actionTargetEl.textContent = reason ?? `run in ${next.laneName ?? ''} · ${next.laneStatus ?? ''}`;
    for (const button of this.actionButtons) {
      button.update({ state: next.actions?.[button.verb] ?? IDLE, disabledReason: reason });
    }
    this.actionsSection.replaceChildren(this.actionsHead, this.actionTargetEl, this.actionGridEl);
  }

  /** `GitHub  wk/krypton  #301 · open`, or `GitHub  not linked`. */
  private paintGithub(ticket: LocalTicketDetail): void {
    const github = ticket.github;
    const label = this.githubEl.firstElementChild;
    if (!github) {
      this.githubValueEl.replaceChildren('not linked');
      this.githubEl.replaceChildren(...(label ? [label] : []), this.githubValueEl);
      return;
    }
    this.githubRepoEl.title = github.issueKey;
    this.githubRepoEl.textContent = github.repo;
    this.githubValueEl.replaceChildren(
      el('a', {
        class: 'acp-ticket-dock__issue-link',
        attrs: { href: github.issueUrl, 'aria-label': `Open ${github.issueKey} on GitHub` },
        text: `#${github.number}`,
      }),
      ` · ${github.state ?? 'unknown'}`,
    );
    this.githubEl.replaceChildren(
      ...(label ? [label] : []),
      this.githubRepoEl,
      this.githubValueEl,
    );
  }

  private paintWorker(workerName: string | null): void {
    const label = this.workerEl.firstElementChild;
    if (workerName) this.workerNameEl.textContent = workerName;
    this.workerEl.replaceChildren(
      ...(label ? [label] : []),
      workerName ? this.workerNameEl : this.workerNoneEl,
    );
  }

  private paintBody(ticket: LocalTicketDetail): void {
    // The template carried `&lt;text&gt;`; through `textContent` the same line
    // is written with real angle brackets.
    this.contextEl.textContent = ticket.contextExcerpt
      ? ticket.contextExcerpt
      : 'No context note yet. Use #ticket note <text>.';
    this.resourceCountEl.textContent = String(ticket.resourceCount);
    reconcile(this.resourcesEl, resourceItems(ticket), {
      key: (item: ResourceItem): string => `${item.kind}\u001f${item.key}`,
      create: (item: ResourceItem): ResourceRow | EmptyState => {
        if (item.kind === 'note') {
          const empty = new EmptyState('li');
          empty.update({ block: 'acp-ticket-dock__empty', text: item.text });
          return empty;
        }
        const row = new ResourceRow();
        row.update(item);
        return row;
      },
      update: (cmp: ResourceRow | EmptyState, item: ResourceItem): void => {
        if (item.kind === 'note' && cmp instanceof EmptyState) {
          cmp.update({ block: 'acp-ticket-dock__empty', text: item.text });
        } else if (item.kind === 'resource' && cmp instanceof ResourceRow) {
          cmp.update(item);
        }
      },
    });
    this.analysisEl.textContent = ticket.analysis
      ? `${ticket.analysis.markdownCount} Markdown · ${ticket.analysis.attachmentCount} attachments`
      : 'No linked analysis bundle';
    if (ticket.lastProgressSummary) {
      this.progressEl.textContent = ticket.lastProgressSummary;
      this.progressSection.replaceChildren(this.progressHead, this.progressEl);
    } else {
      this.progressEmpty.update({
        block: 'acp-ticket-dock__empty',
        text: 'No progress summary yet',
      });
      this.progressSection.replaceChildren(this.progressHead, this.progressEmpty.el);
    }
  }

  protected onDispose(): void {
    disposeList(this.resourcesEl);
    this.progressEmpty.dispose();
    this.actionsEmpty.dispose();
    for (const button of this.actionButtons) button.dispose();
  }
}

export const def: ComponentDef = { id: 'ticket-dock', blocks: ['acp-ticket-dock'] };
