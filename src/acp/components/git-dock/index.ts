// Spec 396 — `GitDock`, the right dock's Git tab.
//
// Props only. The controller owns the snapshot, selection, and git calls.
// HarnessDock owns `hidden`. Rows are keyed by id. The commit textarea's value
// is written only when it differs from the DOM, so a prop echo keeps the caret.

import './git-dock.css';

import { Component } from '../../../ui/component';
import { el } from '../../../ui/dom';
import { keyHintNodes, type KeyHint } from '../../../ui/kbd';
import { disposeList, reconcile, type ListNode } from '../../../ui/list';
import type { ComponentDef } from '../types';

export type GitLamp = 'idle' | 'refreshing' | 'staging' | 'committing' | 'failed';

export interface GitRowModel {
  readonly type: 'row';
  readonly id: string;
  readonly index: number;
  readonly code: string;
  readonly dir: string;
  readonly name: string;
  readonly counts: string;
  readonly countsDim: boolean;
  readonly selected: boolean;
}

export interface GitSectionModel {
  readonly type: 'section';
  readonly id: string;
  readonly label: string;
  readonly count: number;
}

export type GitListItem = GitRowModel | GitSectionModel;

export interface GitDockProps {
  readonly generation: number;
  readonly headLabel: string;
  readonly ahead: number | null;
  readonly behind: number | null;
  readonly summary: string;
  readonly banner: string | null;
  readonly empty: string | null;
  readonly items: readonly GitListItem[];
  readonly selectedId: string | null;
  readonly message: string;
  readonly confirm: string | null;
  readonly lamp: GitLamp;
  readonly showCommit: boolean;
}

const B = 'acp-git-dock';

const LAMP_LABEL: Readonly<Record<GitLamp, string>> = {
  idle: 'IDLE',
  refreshing: 'REFRESHING',
  staging: 'STAGING',
  committing: 'COMMITTING',
  failed: 'FAILED',
};

const KEY_HINTS: readonly KeyHint[] = [
  { keys: ['j', 'k'], label: '', keySeparator: '/' },
  { keys: ['s'], label: 'stage' },
  { keys: ['u'], label: 'unstage' },
  { keys: ['x'], label: 'discard' },
  { keys: ['Enter'], label: 'diff' },
  { keys: ['r'], label: '' },
  { keys: ['Esc'], label: '' },
];

const COMMIT_HINTS: readonly KeyHint[] = [
  { keys: ['c'], label: 'edit' },
  { keys: ['⌘Enter'], label: 'commit' },
];

function setText(node: HTMLElement, value: string): void {
  if (node.textContent !== value) node.textContent = value;
}

class GitLine implements ListNode {
  readonly el = el('div');
  private mode: 'section' | 'row' | null = null;
  private readonly codeEl = el('span', { class: `${B}__code` });
  private readonly dirEl = el('span', { class: `${B}__dir` });
  private readonly nameEl = el('span', { class: `${B}__name` });
  private readonly countsEl = el('span', { class: `${B}__counts` });
  private readonly sectionLabel = el('span');
  private readonly sectionCount = el('span');

  update(item: GitListItem): void {
    if (item.type === 'section') {
      if (this.mode !== 'section') {
        this.mode = 'section';
        this.el.className = `${B}__section`;
        this.el.removeAttribute('role');
        this.el.removeAttribute('aria-selected');
        delete this.el.dataset.gitIndex;
        this.el.replaceChildren(this.sectionLabel, this.sectionCount);
      }
      setText(this.sectionLabel, item.label);
      setText(this.sectionCount, String(item.count));
      return;
    }
    if (this.mode !== 'row') {
      this.mode = 'row';
      this.el.className = `${B}__row`;
      this.el.setAttribute('role', 'option');
      this.el.replaceChildren(
        this.codeEl,
        el('span', { class: `${B}__path` }, this.dirEl, this.nameEl),
        this.countsEl,
      );
    }
    this.el.dataset.gitIndex = String(item.index);
    this.el.classList.toggle(`${B}__row--selected`, item.selected);
    this.el.setAttribute('aria-selected', item.selected ? 'true' : 'false');
    setText(this.codeEl, item.code);
    setText(this.dirEl, item.dir);
    this.dirEl.hidden = item.dir === '';
    setText(this.nameEl, item.name);
    setText(this.countsEl, item.counts);
    this.countsEl.hidden = item.counts === '';
    this.countsEl.classList.toggle(`${B}__counts--dim`, item.countsDim);
  }

  dispose(): void {}
}

export class GitDock extends Component<GitDockProps> {
  private readonly hostClass: string;
  private readonly lampEl = el('span', { class: `${B}__lamp` });
  private readonly branchEl = el('p', { class: `${B}__branch` });
  private readonly summaryEl = el('p', { class: `${B}__summary` });
  private readonly bannerEl = el('p', { class: `${B}__banner`, attrs: { role: 'status' } });
  private readonly emptyEl = el('p', { class: `${B}__empty` });
  private readonly listEl = el('div', { class: `${B}__list`, attrs: { role: 'listbox', 'aria-label': 'Git status' } });
  private readonly messageEl = el('textarea', {
    class: `${B}__message`,
    attrs: { rows: '3', placeholder: 'message…', 'aria-label': 'Commit message' },
  });
  private readonly commitHints = el('span', { class: `${B}__commit-hints` });
  private readonly commitEl: HTMLElement;
  private readonly hintsEl = el('footer', { class: `${B}__keys` });
  private hintKey = '';

  constructor(host?: HTMLElement) {
    super(host ?? el('aside'));
    this.hostClass = host?.className ?? '';
    this.el.setAttribute('aria-label', 'Git');
    this.commitHints.append(...keyHintNodes(COMMIT_HINTS));
    this.commitEl = el('div', { class: `${B}__commit` },
      this.messageEl,
      el('div', { class: `${B}__commit-row` },
        this.commitHints,
        el('button', {
          class: `${B}__commit-btn`,
          text: 'COMMIT',
          attrs: { type: 'button', 'data-git-commit': '' },
        }),
      ),
    );
    this.el.append(
      el('header', { class: `${B}__head` },
        el('h2', { class: `${B}__eyebrow`, text: 'GIT' }),
        this.lampEl,
      ),
      this.branchEl,
      this.summaryEl,
      this.bannerEl,
      this.listEl,
      this.emptyEl,
      this.commitEl,
      this.hintsEl,
    );
  }

  protected readDeps(next: GitDockProps): readonly unknown[] {
    const items = next.items.map((item) => item.type === 'section'
      ? `s:${item.id}:${item.count}`
      : `r:${item.id}:${item.code}:${item.dir}:${item.name}:${item.counts}:${item.countsDim}:${item.selected}`).join('\n');
    return [
      next.generation, next.selectedId, next.message, next.confirm, next.lamp,
      next.headLabel, next.ahead, next.behind, next.summary, next.banner, next.empty,
      next.showCommit, items,
    ];
  }

  protected syncClasses(): void {
    this.el.className = `${this.hostClass} ${B}`.trim();
  }

  protected paint(next: GitDockProps): void {
    this.syncClasses();
    this.lampEl.dataset.lamp = next.lamp;
    setText(this.lampEl, LAMP_LABEL[next.lamp]);
    this.branchEl.hidden = next.headLabel === '';
    this.branchEl.replaceChildren(document.createTextNode(next.headLabel));
    if (next.ahead !== null && next.behind !== null) {
      this.branchEl.append(
        ' ',
        el('span', { class: `${B}__ahead`, text: `↑${next.ahead}` }),
        ' ',
        el('span', { class: `${B}__behind`, text: `↓${next.behind}` }),
      );
    }
    this.summaryEl.hidden = next.summary === '';
    setText(this.summaryEl, next.summary);
    this.bannerEl.hidden = next.banner === null || next.banner === '';
    setText(this.bannerEl, next.banner ?? '');
    const showList = next.empty === null;
    this.listEl.hidden = !showList;
    this.emptyEl.hidden = showList;
    setText(this.emptyEl, next.empty ?? '');
    if (showList) {
      reconcile(this.listEl, next.items, {
        key: (item) => item.id,
        create: (item) => {
          const line = new GitLine();
          line.update(item);
          return line;
        },
        update: (line, item) => line.update(item),
      });
    }
    this.commitEl.hidden = !next.showCommit;
    if (this.messageEl.value !== next.message) this.messageEl.value = next.message;
    const hintKey = next.confirm ?? 'keys';
    if (hintKey !== this.hintKey) {
      this.hintKey = hintKey;
      this.hintsEl.replaceChildren(...(next.confirm === null
        ? keyHintNodes(KEY_HINTS)
        : [document.createTextNode(next.confirm)]));
    }
  }

  protected onDispose(): void {
    disposeList(this.listEl);
  }
}

export const def: ComponentDef = { id: 'git-dock', blocks: ['acp-git-dock'] };
