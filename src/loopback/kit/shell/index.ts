// Spec 341 — the bar every loopback page carries: brand → Home, the
// project / surface location, a `limited` marker without a session, and the
// two shell keys (`` ` `` switcher, `?` keys). It renders at once and never
// waits for the page's data; the navigation context arrives afterwards.

import { DisposableBag } from '../../../ui/component';
import type { Disposer } from '../../../ui/component';
import { el } from '../../../ui/dom';
import { availability, GROUP_TITLES, SURFACES, surfaceById } from '../../surfaces';
import type { NavContext, ProjectEntry, SurfaceDef, SurfaceId } from '../../surfaces';
import { KeyHelp } from '../key-help';
import { keymap } from '../lib/keymap';
import { EMPTY_CONTEXT, loadNavContext, rememberProject } from '../lib/nav';
import { Switcher } from '../switcher';
import type { SwitcherItem } from '../switcher';

import './shell.css';

export interface ShellOptions {
  readonly surface: SurfaceId;
  /** Overrides the surface title in the bar (e.g. the open file). */
  readonly title?: string;
}

/** Refetch the directory on focus at most this often. */
const FOCUS_REFRESH_MS = 2000;

export class AppShell {
  readonly root: HTMLElement;
  readonly surface: SurfaceDef;
  private ctx: NavContext = EMPTY_CONTEXT;
  private loaded = false;
  private readonly listeners = new Set<(ctx: NavContext) => void>();
  private readonly bag = new DisposableBag();
  private readonly projectButton = el('button', { class: 'lb-shell__project', attrs: { type: 'button', hidden: true } });
  private readonly projectSep = el('span', { class: 'lb-shell__sep', text: '/', attrs: { hidden: true } });
  private readonly surfaceLabel = el('span', { class: 'lb-shell__surface' });
  private readonly sessionMarker = el('span', { class: 'lb-shell__session', text: 'limited', attrs: { hidden: true } });
  private readonly switcher: Switcher;
  private readonly keyHelp = new KeyHelp();
  private lastRefresh = 0;

  constructor(root: HTMLElement, options: ShellOptions) {
    this.root = root;
    this.surface = surfaceById(options.surface);
    this.surfaceLabel.textContent = options.title ?? this.surface.title;
    this.switcher = new Switcher(() => this.switcherItems());

    const switchButton = el(
      'button',
      { class: 'lb-shell__action', attrs: { type: 'button', title: 'Switch surface or project' } },
      el('kbd', { text: '`' }),
      ' Switch',
    );
    const helpButton = el(
      'button',
      { class: 'lb-shell__action', attrs: { type: 'button', title: 'Keyboard shortcuts' } },
      el('kbd', { text: '?' }),
      ' Keys',
    );
    this.root.replaceChildren(
      el(
        'div',
        { class: 'lb-shell__bar' },
        el(
          'a',
          { class: 'lb-shell__brand', attrs: { href: '/', title: 'Home' } },
          el('span', { class: 'lb-shell__mark', text: 'K' }),
          el('span', { class: 'lb-shell__name', text: 'Krypton' }),
        ),
        el(
          'nav',
          { class: 'lb-shell__crumbs', attrs: { 'aria-label': 'Location' } },
          el('span', { class: 'lb-shell__sep', text: '/' }),
          this.projectButton,
          this.projectSep,
          this.surfaceLabel,
        ),
        el('span', { class: 'lb-shell__spacer' }),
        this.sessionMarker,
        switchButton,
        helpButton,
      ),
    );
    document.body.append(this.switcher.el, this.keyHelp.el);
    document.title = `${options.title ?? this.surface.title} · Krypton`;

    this.bag.listen(switchButton, 'click', () => this.switcher.show());
    this.bag.listen(helpButton, 'click', () => this.keyHelp.show());
    this.bag.listen(this.projectButton, 'click', () => this.switcher.show('project'));
    this.bag.add(
      keymap().bindAll([
        {
          code: 'Backquote',
          display: '`',
          label: 'Switch surface or project',
          group: 'Shell',
          run: () => this.switcher.show(),
        },
        {
          key: '?',
          label: 'Keyboard shortcuts',
          group: 'Shell',
          run: () => this.keyHelp.show(),
        },
      ]),
    );
    this.bag.listen(window, 'focus', () => {
      if (Date.now() - this.lastRefresh >= FOCUS_REFRESH_MS) void this.refresh();
    });
    void this.refresh();
  }

  get context(): NavContext {
    return this.ctx;
  }

  /** Called with every new context; immediately too, once the first one loaded. */
  onContext(listener: (ctx: NavContext) => void): Disposer {
    this.listeners.add(listener);
    if (this.loaded) listener(this.ctx);
    return () => this.listeners.delete(listener);
  }

  async refresh(): Promise<void> {
    this.lastRefresh = Date.now();
    this.apply(await loadNavContext());
  }

  setTitle(title: string): void {
    this.surfaceLabel.textContent = title;
    document.title = `${title} · Krypton`;
  }

  /** Pick a project: a project-scoped page moves to the same surface for it. */
  selectProject(project: ProjectEntry): void {
    rememberProject(project.projectId);
    if (this.surface.scope === 'project') {
      const href = this.surface.href({ ...this.ctx, project });
      if (href) {
        location.assign(href);
        return;
      }
    }
    this.apply({ ...this.ctx, project });
  }

  dispose(): void {
    this.bag.dispose();
    this.switcher.dispose();
    this.keyHelp.dispose();
    this.listeners.clear();
  }

  private apply(ctx: NavContext): void {
    this.ctx = ctx;
    this.loaded = true;
    const showProject = (this.surface.scope === 'project' || this.surface.id === 'home') && ctx.project !== null;
    this.projectButton.hidden = !showProject;
    this.projectSep.hidden = !showProject;
    if (ctx.project) {
      this.projectButton.textContent = `${ctx.project.name} ▾`;
      this.projectButton.title = `${ctx.project.dir} — switch project`;
    }
    this.sessionMarker.hidden = ctx.capabilities !== null;
    this.sessionMarker.title =
      ctx.session === 'expired'
        ? 'Krypton restarted: reopen from Krypton (#home) to link Terminal Control, ACP wire, Hurl and E2E'
        : 'Opened outside Krypton: reopen from Krypton (#home) to link Terminal Control, ACP wire, Hurl and E2E';
    for (const listener of this.listeners) listener(ctx);
  }

  private switcherItems(): SwitcherItem[] {
    const surfaces = SURFACES.map((def): SwitcherItem => {
      const state = availability(def, this.ctx);
      const scopeNote = def.scope === 'project' && this.ctx.project ? ` · ${this.ctx.project.name}` : '';
      return {
        id: def.id,
        kind: 'surface',
        title: def.title,
        meta: `${GROUP_TITLES[def.group]}${scopeNote}`,
        disabledReason: state.href === null ? state.reason : undefined,
        current: def.id === this.surface.id,
        run: () => {
          if (state.href !== null) location.assign(state.href);
        },
      };
    });
    const projects = this.ctx.directory.projects.map(
      (project): SwitcherItem => ({
        id: project.projectId,
        kind: 'project',
        title: project.name,
        meta: `project · ${project.dir}`,
        current: project.projectId === this.ctx.project?.projectId,
        run: () => this.selectProject(project),
      }),
    );
    return [...surfaces, ...projects];
  }
}

/** Mount the shell into the document's `#lb-shell` header. */
export function mountShell(options: ShellOptions): AppShell {
  let root = document.getElementById('lb-shell');
  if (!root) {
    root = el('header', { class: 'lb-shell', attrs: { id: 'lb-shell' } });
    document.body.prepend(root);
  }
  return new AppShell(root, options);
}
