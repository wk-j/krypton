// Spec 341 — Home: the stat strip, the project picker and one tile per
// surface, grouped Monitor / Project / Reference. A tile that cannot open in
// this context stays in place, muted, with the reason.

import { el } from '../../../ui/dom';
import { chip, dot, emptyState, kbdHints, keymap, matchesQuery, SearchFilter, StatBar } from '../../kit';
import type { AppShell } from '../../kit';
import { availability, GROUP_TITLES, SURFACES } from '../../surfaces';
import type { NavContext, SurfaceDef, SurfaceGroup } from '../../surfaces';

import './home.css';

const GROUP_ORDER: readonly SurfaceGroup[] = ['monitor', 'project', 'reference'];

/** The live count a tile can show from the directory alone (no extra fetch). */
export function tileCount(def: SurfaceDef, ctx: NavContext): { text: string; alert: boolean } | null {
  const projects = ctx.directory.projects;
  if (def.id === 'dashboard') {
    const total = projects.reduce((n, p) => n + p.lanes.total, 0);
    if (total === 0) return null;
    const attention = projects.reduce((n, p) => n + p.attention, 0);
    const busy = projects.reduce((n, p) => n + p.lanes.busy, 0);
    return { text: attention > 0 ? `${attention} flagged` : `${busy}/${total} busy`, alert: attention > 0 };
  }
  if (def.id === 'gallery') {
    const live = projects.reduce((n, p) => n + p.artifacts.live, 0);
    const pending = projects.reduce((n, p) => n + p.artifacts.pending, 0);
    if (live + pending === 0) return null;
    return { text: pending > 0 ? `${live} live · ${pending} pending` : `${live} live`, alert: false };
  }
  return null;
}

export class HomeView {
  readonly el: HTMLElement;
  private readonly stats = new StatBar([], { align: 'end' });
  private readonly projectsRow = el('div', { class: 'lb-home__projects', attrs: { role: 'group', 'aria-label': 'Project' } });
  private readonly groups = el('div', { class: 'lb-home__groups' });
  private readonly filter: SearchFilter;
  private ctx: NavContext | null = null;

  constructor(private readonly shell: AppShell) {
    this.filter = new SearchFilter({
      placeholder: 'Filter surfaces',
      onInput: () => this.render(),
      onSubmit: () => this.tiles()[0]?.click(),
      onEscape: () => this.tiles()[0]?.focus(),
    });
    this.el = el(
      'div',
      { class: 'lb-page lb-home' },
      el(
        'header',
        { class: 'lb-home__head' },
        el(
          'div',
          { class: 'lb-home__intro' },
          el('h1', { class: 'lb-home__title', text: 'Krypton' }),
          el('p', { class: 'lb-home__sub', text: 'Every loopback surface for the harnesses open in Krypton.' }),
        ),
        this.stats.el,
      ),
      this.projectsRow,
      el('div', { class: 'lb-home__filter' }, this.filter.el),
      this.groups,
      kbdHints(
        [
          ['/', 'filter'],
          ['j / k', 'move'],
          ['Enter', 'open'],
          ['`', 'switch'],
          ['?', 'keys'],
        ],
        'refreshes when this tab regains focus',
      ),
    );
    keymap().bindAll([
      { key: ['j', 'ArrowDown', 'ArrowRight'], label: 'Next tile', run: () => this.moveFocus(1) },
      { key: ['k', 'ArrowUp', 'ArrowLeft'], label: 'Previous tile', run: () => this.moveFocus(-1) },
    ]);
    shell.onContext((ctx) => {
      this.ctx = ctx;
      this.render();
    });
  }

  private tiles(): HTMLAnchorElement[] {
    return [...this.groups.querySelectorAll<HTMLAnchorElement>('a.lb-tile')];
  }

  private moveFocus(delta: number): void {
    const tiles = this.tiles();
    if (tiles.length === 0) return;
    const index = tiles.indexOf(document.activeElement as HTMLAnchorElement);
    const next = index < 0 ? (delta > 0 ? 0 : tiles.length - 1) : (index + delta + tiles.length) % tiles.length;
    tiles[next].focus();
  }

  private render(): void {
    const ctx = this.ctx;
    if (!ctx) return;
    const projects = ctx.directory.projects;
    this.stats.update([
      { key: 'projects', label: 'projects', value: projects.length },
      {
        key: 'lanes',
        label: 'lanes busy',
        value: `${projects.reduce((n, p) => n + p.lanes.busy, 0)}/${projects.reduce((n, p) => n + p.lanes.total, 0)}`,
      },
      { key: 'artifacts', label: 'live artifacts', value: projects.reduce((n, p) => n + p.artifacts.live, 0) },
      {
        key: 'attention',
        label: 'attention',
        value: projects.reduce((n, p) => n + p.attention, 0),
        tone: projects.some((p) => p.attention > 0) ? 'del' : 'muted',
      },
    ]);

    this.projectsRow.replaceChildren(
      el('span', { class: 'lb-home__label', text: 'Project' }),
      ...(projects.length === 0
        ? [el('span', { class: 'lb-home__none', text: 'No harness is open in Krypton.' })]
        : projects.map((project) => {
            const active = project.projectId === ctx.project?.projectId;
            const node = el(
              'button',
              {
                class: 'lb-home__project',
                title: project.dir,
                attrs: { type: 'button', 'aria-pressed': String(active) },
              },
              dot(project.lanes.busy > 0 ? 'live' : 'idle'),
              el('span', { text: project.name }),
              el('span', { class: 'lb-home__project-meta', text: `${project.lanes.total} lanes` }),
            );
            node.addEventListener('click', () => this.shell.selectProject(project));
            return node;
          })),
    );

    const query = this.filter.query;
    const sections = GROUP_ORDER.map((group) => {
      const defs = SURFACES.filter(
        (def) => def.group === group && def.id !== 'home' && matchesQuery(`${def.title} ${def.summary}`, query),
      );
      if (defs.length === 0) return null;
      return el(
        'section',
        { class: 'lb-home__group' },
        el('h2', { class: 'lb-h3', text: GROUP_TITLES[group] }),
        el('div', { class: 'lb-home__grid' }, ...defs.map((def) => this.tile(def, ctx))),
      );
    }).filter((section): section is HTMLElement => section !== null);
    this.groups.replaceChildren(...(sections.length > 0 ? sections : [emptyState('No surface matches the filter.')]));
    this.filter.setCount(query ? `${this.tiles().length} open` : '');
  }

  private tile(def: SurfaceDef, ctx: NavContext): HTMLElement {
    const state = availability(def, ctx);
    const count = tileCount(def, ctx);
    const meta = el(
      'div',
      { class: 'lb-tile__meta' },
      def.scope === 'project' && ctx.project ? el('span', { class: 'lb-tile__scope', text: ctx.project.name }) : null,
      def.access === 'capability' ? el('span', { class: 'lb-tile__scope', text: 'session' }) : null,
      count ? chip(count.text, { alert: count.alert }) : null,
    );
    const body = [
      el('span', { class: 'lb-tile__title', text: def.title }),
      el('span', { class: 'lb-tile__summary', text: state.href === null ? state.reason : def.summary }),
      meta,
    ];
    if (state.href === null) {
      return el('div', { class: 'lb-tile lb-tile--off', attrs: { 'aria-disabled': 'true' } }, ...body);
    }
    return el('a', { class: 'lb-tile', attrs: { href: state.href } }, ...body);
  }
}
