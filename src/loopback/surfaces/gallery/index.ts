// Spec 170 / 173 / 265 / 341 — the artifact gallery: every project's HTML
// artifacts as cards, `all` + one tab per project, polled from `/artifacts`.

import { Component, DisposableBag } from '../../../ui/component';
import { el } from '../../../ui/dom';
import { disposeList, reconcile } from '../../../ui/list';
import { card, dot, emptyState, fetchJson, formatBytes, kbdHints, keymap, pill, poll, StatBar, statusTone, Tabs } from '../../kit';
import type { AppShell, PollStatus, TabItem } from '../../kit';
import type { NavContext } from '../../surfaces';

import './gallery.css';

export const POLL_MS = 1000;
const ALL = '';

export interface GalleryArtifact {
  readonly id: string;
  readonly state?: string;
  readonly size?: number;
  readonly hash?: string;
  readonly token?: string;
  readonly title?: string;
  readonly laneLabel?: string;
  readonly tail?: string;
}

export interface GalleryProject {
  readonly projectId: string;
  readonly projectName?: string;
  readonly artifacts?: readonly GalleryArtifact[];
}

type ArtState = 'live' | 'pending';

function stateKey(state: string | undefined): ArtState {
  return state === 'live' ? 'live' : 'pending';
}

function artifactsOf(project: GalleryProject): readonly GalleryArtifact[] {
  return Array.isArray(project.artifacts) ? project.artifacts : [];
}

/** Same-basename projects gain the tail of their opaque id (spec 265). */
export function projectLabels(projects: readonly GalleryProject[]): Map<string, string> {
  const counts = new Map<string, number>();
  for (const p of projects) {
    const name = p.projectName || 'project';
    counts.set(name, (counts.get(name) ?? 0) + 1);
  }
  const labels = new Map<string, string>();
  for (const p of projects) {
    const name = p.projectName || 'project';
    const suffix = String(p.projectId || '').replace(/^project-/, '').slice(-6);
    labels.set(p.projectId, (counts.get(name) ?? 0) > 1 ? `${name} · ${suffix}` : name);
  }
  return labels;
}

function signature(projects: readonly GalleryProject[]): string {
  return JSON.stringify(
    projects.map((p) => [
      p.projectId,
      p.projectName,
      artifactsOf(p).map((a) => [a.id, a.state, a.size, a.hash, a.token, a.title, a.laneLabel, a.tail]),
    ]),
  );
}

class ArtifactCard extends Component<GalleryArtifact> {
  private readonly title: HTMLElement;
  private pillNode: HTMLElement;
  private readonly lane: HTMLElement;
  private readonly size: HTMLElement;
  private readonly tail: HTMLElement;
  private openNode: HTMLElement;

  constructor(art: GalleryArtifact) {
    const title = el('div', { class: 'lb-gallery__title' });
    const pillNode = el('span');
    const lane = el('div', { class: 'lb-gallery__lane' });
    const size = el('span', { class: 'lb-gallery__size' });
    const tail = el('div', { class: 'lb-gallery__tail' });
    const openNode = el('span');
    super(
      card(
        { tag: 'article', class: 'lb-gallery__art' },
        el('div', { class: 'lb-gallery__head' }, title, pillNode),
        lane,
        el('div', { class: 'lb-gallery__meta' }, size),
        tail,
        openNode,
      ),
    );
    this.title = title;
    this.pillNode = pillNode;
    this.lane = lane;
    this.size = size;
    this.tail = tail;
    this.openNode = openNode;
    this.update(art);
  }

  protected readDeps(a: GalleryArtifact): readonly unknown[] {
    return [a.state, a.size, a.hash, a.token, a.title, a.laneLabel, a.tail];
  }

  protected paint(a: GalleryArtifact): void {
    const sk = stateKey(a.state);
    this.title.textContent = a.title || 'untitled';
    const nextPill = pill(sk, statusTone(sk));
    this.pillNode.replaceWith(nextPill);
    this.pillNode = nextPill;
    this.lane.textContent = a.laneLabel || '?';
    this.size.textContent = sk === 'live' ? formatBytes(Number(a.size) || 0) : 'writing…';
    this.tail.textContent = (a.hash ? `${String(a.hash).slice(0, 12)} · ` : '') + (a.tail || '');
    const nextOpen =
      sk === 'live' && a.token
        ? el('a', {
            class: ['lb-btn', 'lb-btn--primary', 'lb-gallery__open'],
            text: 'Open',
            attrs: { href: `/artifact/${encodeURIComponent(a.token)}`, target: '_blank', rel: 'noopener' },
          })
        : el('span', { class: ['lb-btn', 'lb-btn--secondary', 'lb-gallery__open'], text: 'pending', attrs: { 'aria-disabled': 'true' } });
    this.openNode.replaceWith(nextOpen);
    this.openNode = nextOpen;
    this.syncClasses(a);
  }

  protected syncClasses(a: GalleryArtifact): void {
    this.el.dataset.state = stateKey(a.state);
  }
}

interface SectionProps {
  readonly project: GalleryProject;
  readonly label: string;
  readonly showHead: boolean;
}

class ProjectSection extends Component<SectionProps> {
  private readonly name = el('h2', { class: 'lb-h2 lb-gallery__name' });
  private readonly meta = el('div', { class: 'lb-gallery__count' });
  private readonly head = el('div', { class: 'lb-gallery__project-head' }, this.name, this.meta);
  private readonly cards = el('div', { class: 'lb-gallery__cards' });

  constructor(props: SectionProps) {
    super(el('section', { class: 'lb-gallery__project' }));
    this.el.append(this.head, this.cards);
    this.update(props);
  }

  protected readDeps(next: SectionProps): readonly unknown[] {
    return [next.label, next.showHead, signature([next.project])];
  }

  protected paint(next: SectionProps): void {
    const arts = artifactsOf(next.project);
    this.head.hidden = !next.showHead;
    this.name.textContent = next.label;
    this.meta.textContent = `${arts.length} ${arts.length === 1 ? 'artifact' : 'artifacts'}`;
    reconcile(this.cards, arts, {
      key: (a) => a.id,
      create: (a) => new ArtifactCard(a),
      update: (cmp, a) => cmp.update(a),
    });
    this.syncClasses();
  }

  protected syncClasses(): void {
    /* static */
  }

  protected onDispose(): void {
    disposeList(this.cards);
  }
}

export class GalleryView {
  readonly el: HTMLElement;
  private readonly bag = new DisposableBag();
  private readonly dotSlot = el('span', { class: 'lb-gallery__dot' });
  private readonly status = el('span', { class: 'lb-gallery__status', text: 'connecting…' });
  private readonly stats = new StatBar([], { align: 'end' });
  private readonly tabs: Tabs;
  private readonly sections = el('div', { class: 'lb-gallery__projects' });
  private readonly empty = el('div', { class: 'lb-gallery__empty' });
  private projects: readonly GalleryProject[] = [];
  private labels = new Map<string, string>();
  /** `''` = the all tab. In memory only; kept across polls. */
  private active = ALL;
  private loaded = false;
  /** Once the reader picks a tab, the shell's project no longer steers it. */
  private picked = false;
  private ctxProject: string | null = null;

  constructor(shell: Pick<AppShell, 'onContext'>) {
    this.tabs = new Tabs({ label: 'Project', keys: true, numberFrom: 1, sticky: true, onSelect: (id) => this.pick(id) });
    this.el = el(
      'div',
      { class: 'lb-page lb-gallery' },
      el(
        'div',
        { class: 'lb-gallery__top' },
        el('div', { class: 'lb-gallery__state' }, this.dotSlot, this.status),
        this.stats.el,
      ),
      this.tabs.el,
      this.sections,
      this.empty,
      kbdHints(
        [
          ['[ ]', 'switch project'],
          ['1–9', 'jump'],
          ['0', 'all projects'],
        ],
        'read-only gallery · polls /artifacts · open links serve the registered artifact on this origin',
      ),
    );
    this.setDot(false);
    this.tabs.el.hidden = true;
    this.bag.add(
      keymap().bind({
        key: '0',
        label: 'All projects',
        run: () => {
          if (this.projects.length === 0) return false;
          this.pick(ALL);
        },
      }),
    );
    this.bag.add(
      shell.onContext((ctx: NavContext) => {
        this.ctxProject = ctx.project?.projectId ?? null;
        this.adoptContext();
      }),
    );
    const poller = poll<readonly GalleryProject[]>({
      load: async (signal) => {
        const body = await fetchJson<{ projects?: unknown }>('/artifacts', { signal });
        return Array.isArray(body?.projects) ? (body.projects as GalleryProject[]) : [];
      },
      apply: (next) => this.apply(next),
      onStatus: (s) => this.onStatus(s),
      intervalMs: POLL_MS,
      signature,
    });
    this.bag.add(() => poller.dispose());
  }

  dispose(): void {
    this.bag.dispose();
    this.tabs.dispose();
    this.stats.dispose();
    disposeList(this.sections);
  }

  private onStatus(s: PollStatus): void {
    if (s === 'reconnecting') this.status.textContent = this.loaded ? 'reconnecting…' : 'connecting…';
    else if (s === 'ok') this.paintStatus();
  }

  private setDot(live: boolean): void {
    this.dotSlot.replaceChildren(dot(live ? 'live' : 'idle'));
  }

  private pick(id: string): void {
    this.picked = true;
    if (this.active === id) return;
    this.active = id;
    this.render();
    window.scrollTo({ top: 0 });
  }

  /** Default to the shell's project while the reader has not chosen a tab. */
  private adoptContext(): void {
    if (this.picked || !this.ctxProject) return;
    const match = this.projects.find((p) => p.projectId === this.ctxProject);
    if (match && artifactsOf(match).length > 0 && this.active !== match.projectId) {
      this.active = match.projectId;
      this.render();
    }
  }

  private apply(next: readonly GalleryProject[]): void {
    this.loaded = true;
    this.projects = next;
    this.labels = projectLabels(next);
    this.adoptContext();
    this.render();
  }

  private totals(): { total: number; live: number; pending: number } {
    let total = 0;
    let live = 0;
    for (const p of this.projects) {
      for (const a of artifactsOf(p)) {
        total++;
        if (stateKey(a.state) === 'live') live++;
      }
    }
    return { total, live, pending: total - live };
  }

  private paintStatus(): void {
    if (!this.loaded) return;
    const { total } = this.totals();
    this.status.textContent =
      total === 0
        ? 'no artifacts yet'
        : this.active
          ? `live gallery · ${this.labels.get(this.active) ?? 'project'}`
          : 'live gallery';
  }

  private render(): void {
    const { total, live, pending } = this.totals();
    this.stats.update([
      { key: 'total', label: 'artifacts', value: total },
      { key: 'live', label: 'live', value: live, tone: 'add' },
      { key: 'pending', label: 'pending', value: pending },
    ]);
    this.setDot(total > 0);
    if (this.active && !this.projects.some((p) => p.projectId === this.active)) this.active = ALL;
    if (total === 0) this.active = ALL;

    const tabs: TabItem[] = [{ id: ALL, label: 'all', count: total }];
    for (const p of this.projects) {
      tabs.push({ id: p.projectId, label: this.labels.get(p.projectId) ?? 'project', count: artifactsOf(p).length });
    }
    this.tabs.el.hidden = this.projects.length === 0;
    this.tabs.update({ tabs: this.projects.length === 0 ? [] : tabs, active: this.active });

    const visible = this.active ? this.projects.filter((p) => p.projectId === this.active) : this.projects;
    const emptyText =
      total === 0
        ? 'No artifacts yet — lanes will surface HTML artifacts here as they register them.'
        : visible.length === 0
          ? 'No artifacts for this project.'
          : null;
    this.empty.hidden = emptyText === null;
    this.empty.replaceChildren(...(emptyText ? [emptyState(emptyText)] : []));
    const showHead = !this.active;
    reconcile(this.sections, total === 0 ? [] : visible, {
      key: (p) => p.projectId,
      create: (p) => new ProjectSection({ project: p, label: this.labels.get(p.projectId) ?? 'project', showHead }),
      update: (cmp, p) => cmp.update({ project: p, label: this.labels.get(p.projectId) ?? 'project', showHead }),
    });
    this.paintStatus();
  }
}
