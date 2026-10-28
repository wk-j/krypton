// Spec 302 §5.7 — `TicketDock`.
//
//   active ticket
//   Harness UI refactor                                            ›
//   open   KR-301
//   GitHub  wk/krypton   #301 · open
//   Worker  codex-1
//   CONTEXT     …
//   RESOURCES 7 …
//
// Ports `HarnessTicketController.renderTicketDock`
// (src/acp/harness-ticket-controller.ts:603-676). That method wrote the whole
// dock as one `innerHTML` string on every ticket event — including the ones
// that only changed the worker binding or the GitHub state — so the resource
// list and the progress note were rebuilt to repaint a single `<strong>`.
//
// **Props only.** The component never imports the controller: the dock's two
// surfaces (`ticket`, `workerName`) arrive as data, and the head button
// carries `data-ticket-dock-action="hide"` for the delegated click handler the
// controller installed on the dock element. That handler, the `hidden` flag
// (owned by the dock column, `harness-dock.ts`, from spec 320's per-panel
// `ticket` flag and the shown tab) and the `acp-harness--dock-active` class on
// the harness root stay outside: they are the dock's placement, not its content.
//
// Spec 331: the dock has no collapsed state. `›` hides it through the same
// flag, and the titlebar `Ticket dock` toggle shows it again.
//
// The hide button is hand-built rather than an `ActionButton`: it needs an
// `aria-label`, and `ActionButton` carries no ARIA props.

import './ticket-dock.css';

import { Component } from '../../../ui/component';
import { el } from '../../../ui/dom';
import { disposeList, reconcile } from '../../../ui/list';
import { formatTicketBytes } from '../../harness-ticket-helpers';
import type { LocalTicketDetail } from '../../harness-view-types';
import { EmptyState } from '../empty-state';
import type { ComponentDef } from '../types';

/** How many resources the dock lists before it collapses the tail into `+N more`. */
const RESOURCE_LIMIT = 6;

export interface TicketDockProps {
  readonly ticket: LocalTicketDetail | null;
  /** The lane bound to this ticket, or null when nobody is working it. */
  readonly workerName: string | null;
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
    this.parts = [
      this.headEl,
      this.statusRowEl,
      this.githubEl,
      this.workerEl,
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
    return [
      ticket === null,
      next.workerName,
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
    this.paintBody(ticket);
    this.el.replaceChildren(...this.parts);
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
  }
}

export const def: ComponentDef = { id: 'ticket-dock', blocks: ['acp-ticket-dock'] };
