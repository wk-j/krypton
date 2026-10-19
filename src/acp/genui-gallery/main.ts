import './gallery.css';
// The panel body the Harness seats a spec in: the gallery preview carries the
// same block, so the roots get the app's own column rhythm, not a gallery one.
import '../components/genui-panel/genui-panel.css';

import { COMPONENTS, GROUP_ORDER } from '../genui/catalog';
import type { ComponentSpec, ParamSpec } from '../genui/catalog';
import { compile } from '../genui/compile';
import { evaluate, initialState } from '../genui/evaluate';
import type { Program } from '../genui/ast';
import type { UiAction, UiState, UiStateValue } from '../genui/types';
import { toStateValue } from '../genui/types';
import { renderChildren } from '../components/genui-catalog';
import type { GenUiContext } from '../components/genui-catalog';
import { FOCUSABLE_ATTR } from '../components/genui-catalog/renderer';
import { disposeList } from '../../ui/list';
import { themeCssProperties, themeScheme } from '../../theme';
import type { FullTheme } from '../../theme';
import { EXAMPLES } from './examples';

/** One catalog component: its index entry, and its view once it has been opened. */
interface Entry {
  readonly spec: ComponentSpec;
  readonly position: number;
  readonly nav: HTMLAnchorElement;
  element: HTMLElement | null;
  preview: GalleryPreview | null;
}

const shellNav = document.getElementById('gallery-nav');
const shellDetail = document.getElementById('gallery-detail');
const shellPager = document.getElementById('gallery-pager');
const shellMain = document.getElementById('gallery-main');
const shellSearch = document.getElementById('gallery-search');
const shellCount = document.getElementById('gallery-count');
const shellEmpty = document.getElementById('gallery-empty');
const shellTheme = document.getElementById('gallery-theme');
if (!(shellNav instanceof HTMLElement) || !(shellDetail instanceof HTMLElement)
  || !(shellPager instanceof HTMLElement) || !(shellMain instanceof HTMLElement)
  || !(shellSearch instanceof HTMLInputElement) || !(shellCount instanceof HTMLElement)
  || !(shellEmpty instanceof HTMLElement) || !(shellTheme instanceof HTMLElement)) {
  throw new Error('GenUI gallery shell is incomplete');
}
const nav: HTMLElement = shellNav;
const detail: HTMLElement = shellDetail;
const pager: HTMLElement = shellPager;
const main: HTMLElement = shellMain;
const search: HTMLInputElement = shellSearch;
const count: HTMLElement = shellCount;
const empty: HTMLElement = shellEmpty;
const themeLabel: HTMLElement = shellTheme;

/** `theme.json` from the loopback server: the app's resolved theme and its font. */
interface GalleryThemePayload {
  readonly theme: FullTheme;
  readonly font: { readonly family: readonly string[] | string; readonly size: number; readonly line_height: number };
}

/**
 * Paint the page with the running app's own tokens, so a preview is the
 * component as Krypton draws it — the same `themeCssProperties()` the window
 * applies, plus the `[font]` properties `Compositor.applyConfig` sets. The
 * served page is same-origin with the route; a Vite dev page is not, and falls
 * back to the built-in krypton-dark values in `gallery.css`.
 */
async function applyKryptonTheme(): Promise<string> {
  const response = await fetch('/genui-gallery/theme.json', { cache: 'no-store' });
  if (!response.ok) throw new Error(`theme.json: ${response.status}`);
  const payload = await response.json() as GalleryThemePayload;
  const root = document.documentElement;
  for (const [name, value] of Object.entries(themeCssProperties(payload.theme))) {
    root.style.setProperty(name, value);
  }
  const families = Array.isArray(payload.font.family) ? payload.font.family : [payload.font.family as string];
  const stack = families.map((family) => `'${family}'`).join(', ');
  root.style.setProperty('--krypton-font-family', `${stack}, 'Fira Code', 'Cascadia Code', monospace`);
  root.style.setProperty('--krypton-font-size', `${payload.font.size}px`);
  root.style.setProperty('--krypton-chrome-font-size', `${Math.round(payload.font.size * 0.786)}px`);
  root.style.setProperty('--krypton-line-height', `${payload.font.line_height}`);
  root.style.setProperty('--krypton-content-line-height', `${payload.font.line_height}`);
  root.style.setProperty('--krypton-prose-line-height', `${payload.font.line_height}`);
  root.dataset.themeScheme = themeScheme(payload.theme);
  root.dataset.theme = payload.theme.name;
  root.dataset.chrome = payload.theme.chrome.style;
  const name = payload.theme.meta.display_name || payload.theme.name;
  return `${name} · ${families[0] ?? 'default'} ${payload.font.size}px`;
}

class GalleryPreview {
  private program: Program | null | undefined;
  private state: UiState = {};
  private readonly views = new Map<string, Record<string, unknown>>();
  private mounted = false;
  private readonly context: GenUiContext;

  constructor(
    private readonly source: string,
    private readonly host: HTMLElement,
    private readonly status: HTMLElement,
  ) {
    const preview = this;
    this.context = {
      run: (actions: readonly UiAction[]): void => this.run(actions),
      setInput: (name: string, value: UiStateValue): void => this.setInput(name, value),
      get state(): UiState { return preview.state; },
      view: (key: string): Record<string, unknown> => this.view(key),
      repaint: (): void => this.render(),
    };
  }

  mount(): void {
    if (this.mounted) return;
    this.mounted = true;
    if (this.program === undefined) {
      const result = compile(`version 2\n${this.source}`);
      this.program = result.program;
      if (result.program === null) {
        this.status.textContent = result.diagnostics.map((diagnostic) => `line ${diagnostic.line}: ${diagnostic.message}`).join(' · ');
        return;
      }
      this.state = initialState(result.program);
    }
    this.render();
  }

  /** Tear the rendered components down; the example's input and view state survive. */
  dispose(): void {
    if (!this.mounted) return;
    this.mounted = false;
    disposeList(this.host);
  }

  reset(): void {
    if (this.program === null || this.program === undefined) return;
    this.state = initialState(this.program);
    this.views.clear();
    this.status.textContent = '';
    if (this.mounted) {
      disposeList(this.host);
      this.render();
    }
  }

  private render(): void {
    if (!this.mounted || this.program === null || this.program === undefined) return;
    const result = evaluate(this.program, this.state);
    renderChildren(this.host, result.roots, this.context);
    const error = result.diagnostics.find((diagnostic) => diagnostic.severity === 'error');
    if (error !== undefined) this.status.textContent = `line ${error.line}: ${error.message}`;
  }

  private setInput(name: string, value: UiStateValue): void {
    if (!Object.prototype.hasOwnProperty.call(this.state, name)) return;
    this.state[name] = value;
    this.render();
  }

  private view(key: string): Record<string, unknown> {
    let value = this.views.get(key);
    if (value === undefined) {
      value = {};
      this.views.set(key, value);
    }
    return value;
  }

  private run(actions: readonly UiAction[]): void {
    for (const action of actions) {
      if (action.type === 'set' && action.name !== undefined) {
        this.setInput(action.name, toStateValue(action.value ?? null) ?? null);
      } else if (action.type === 'copy') {
        const clipboard = navigator.clipboard;
        if (clipboard === undefined) {
          this.status.textContent = 'Clipboard unavailable';
        } else {
          void clipboard.writeText(action.text ?? '').then(
            () => { this.status.textContent = 'Copied'; },
            () => { this.status.textContent = 'Copy failed'; },
          );
        }
      } else if (action.type === 'draft') {
        this.status.textContent = `Demo only · draft: ${action.text ?? ''}`;
      } else if (action.type === 'openUrl') {
        this.status.textContent = `Demo only · link: ${action.text ?? ''}`;
      }
    }
  }
}

const examples = new Map(EXAMPLES.map((example) => [example.component, example]));
const entries: Entry[] = [];
const byName = new Map<string, Entry>();
let current: Entry | null = null;

function label(text: string): HTMLElement {
  const element = document.createElement('div');
  element.className = 'gallery__label';
  element.textContent = text;
  return element;
}

function paramKind(param: ParamSpec): string {
  if (param.kind === 'enum' && param.values !== undefined) return param.values.join(' | ');
  if (param.kind === 'binding') return param.holds === undefined ? 'binding $name' : `binding $name → ${param.holds}`;
  return param.kind;
}

function buildParams(spec: ComponentSpec): HTMLElement {
  const section = document.createElement('section');
  section.className = 'gallery__params';
  section.append(label('PARAMETERS'));
  const table = document.createElement('dl');
  table.className = 'gallery__param-list';
  for (const param of spec.params) {
    const name = document.createElement('dt');
    name.className = 'gallery__param-name';
    name.textContent = param.name;
    if (param.required === true) {
      const required = document.createElement('span');
      required.className = 'gallery__param-required';
      required.textContent = 'required';
      name.append(required);
    }
    const kind = document.createElement('dd');
    kind.className = 'gallery__param-kind';
    kind.textContent = paramKind(param);
    table.append(name, kind);
  }
  if (spec.params.length === 0) {
    const name = document.createElement('dt');
    name.className = 'gallery__param-name';
    name.textContent = '—';
    const kind = document.createElement('dd');
    kind.className = 'gallery__param-kind';
    kind.textContent = 'no parameters';
    table.append(name, kind);
  }
  section.append(table);
  return section;
}

function buildEntryView(entry: Entry): HTMLElement {
  const spec = entry.spec;
  const example = examples.get(spec.name);
  if (example === undefined) throw new Error(`Missing GenUI gallery example: ${spec.name}`);

  const element = document.createElement('div');
  element.className = 'gallery__view';

  const head = document.createElement('header');
  head.className = 'gallery__view-head';
  const crumb = document.createElement('div');
  crumb.className = 'gallery__crumb';
  crumb.textContent = `${spec.group} · ${entry.position} / ${entries.length}`;
  const title = document.createElement('div');
  title.className = 'gallery__view-title';
  const name = document.createElement('h2');
  name.className = 'gallery__view-name';
  name.textContent = spec.name;
  const actions = document.createElement('div');
  actions.className = 'gallery__view-actions';
  const sourceButton = document.createElement('button');
  sourceButton.type = 'button';
  sourceButton.textContent = 'Source';
  sourceButton.setAttribute('aria-expanded', 'false');
  const resetButton = document.createElement('button');
  resetButton.type = 'button';
  resetButton.textContent = 'Reset';
  actions.append(sourceButton, resetButton);
  title.append(name, actions);
  const summary = document.createElement('p');
  summary.className = 'gallery__view-summary';
  summary.textContent = spec.summary;
  head.append(crumb, title, summary);

  const stage = document.createElement('div');
  stage.className = 'gallery__stage';
  const previewHost = document.createElement('div');
  previewHost.className = 'gallery__preview acp-genui-panel__body acp-genui';
  stage.append(previewHost);
  const status = document.createElement('div');
  status.className = 'gallery__status';
  status.setAttribute('role', 'status');
  const source = document.createElement('pre');
  source.className = 'gallery__source';
  source.textContent = `version 2\n${example.source}`;
  source.hidden = true;

  element.append(head, label('PREVIEW · KRYPTON SURFACE'), stage, status, source, buildParams(spec));

  const preview = new GalleryPreview(example.source, previewHost, status);
  entry.preview = preview;
  sourceButton.addEventListener('click', () => {
    source.hidden = !source.hidden;
    sourceButton.setAttribute('aria-expanded', String(!source.hidden));
    sourceButton.textContent = source.hidden ? 'Source' : 'Hide source';
  });
  resetButton.addEventListener('click', () => preview.reset());
  return element;
}

for (const group of GROUP_ORDER) {
  const specs = COMPONENTS.filter((component) => component.group === group);
  const section = document.createElement('section');
  section.className = 'gallery__nav-group';
  section.dataset.group = group;
  const heading = document.createElement('h2');
  heading.className = 'gallery__nav-heading';
  heading.dataset.group = group;
  heading.textContent = `${group} · ${specs.length}`;
  section.append(heading);
  for (const spec of specs) {
    const item = document.createElement('a');
    item.className = 'gallery__nav-item';
    item.href = `#${spec.name}`;
    item.textContent = spec.name;
    section.append(item);
    const entry: Entry = { spec, position: entries.length + 1, nav: item, element: null, preview: null };
    entries.push(entry);
    byName.set(spec.name, entry);
  }
  nav.append(section);
}

function visibleEntries(): Entry[] {
  return entries.filter((entry) => !entry.nav.hidden);
}

/** The list `[`/`]` and the pager walk: the search result when it holds the open component. */
function walkList(): Entry[] {
  const visible = visibleEntries();
  if (current !== null && visible.includes(current)) return visible;
  return entries;
}

function pagerLink(entry: Entry, direction: 'prev' | 'next'): HTMLAnchorElement {
  const link = document.createElement('a');
  link.className = `gallery__pager-link gallery__pager-link--${direction}`;
  link.href = `#${entry.spec.name}`;
  const arrow = document.createElement('span');
  arrow.className = 'gallery__pager-dir';
  arrow.textContent = direction === 'prev' ? '← prev' : 'next →';
  const name = document.createElement('span');
  name.className = 'gallery__pager-name';
  name.textContent = entry.spec.name;
  link.append(arrow, name);
  return link;
}

function updatePager(): void {
  const list = walkList();
  const index = current === null ? -1 : list.indexOf(current);
  if (index < 0 || list.length < 2) {
    pager.replaceChildren();
    return;
  }
  const previous = list[(index - 1 + list.length) % list.length];
  const next = list[(index + 1) % list.length];
  pager.replaceChildren(pagerLink(previous, 'prev'), pagerLink(next, 'next'));
}

/** Scroll the rail only when the item is out of its band — `scrollIntoView` hides it under the sticky group heading. */
function revealNav(item: HTMLElement): void {
  const port = nav.getBoundingClientRect();
  if (port.height === 0) return;
  const heading = item.parentElement?.querySelector<HTMLElement>('.gallery__nav-heading');
  const rect = item.getBoundingClientRect();
  const top = port.top + (heading?.offsetHeight ?? 0);
  if (rect.top < top) nav.scrollTop -= top - rect.top;
  else if (rect.bottom > port.bottom) nav.scrollTop += rect.bottom - port.bottom;
}

function focusPreviewOf(element: HTMLElement): void {
  const target = element.querySelector<HTMLElement>(`[${FOCUSABLE_ATTR}]`)
    ?? element.querySelector<HTMLElement>('.gallery__view-actions button');
  target?.focus();
}

function show(name: string, focusPreview: boolean): void {
  const entry = byName.get(name);
  if (entry === undefined) return;
  if (current !== entry) {
    current?.preview?.dispose();
    current = entry;
    if (entry.element === null) entry.element = buildEntryView(entry);
    detail.replaceChildren(entry.element);
    entry.preview?.mount();
    main.scrollTop = 0;
    document.title = `${entry.spec.name} · GenUI component gallery`;
    for (const other of entries) {
      other.nav.classList.toggle('gallery__nav-item--current', other === entry);
      if (other === entry) other.nav.setAttribute('aria-current', 'true');
      else other.nav.removeAttribute('aria-current');
    }
    revealNav(entry.nav);
    updatePager();
  }
  if (focusPreview && entry.element !== null) focusPreviewOf(entry.element);
}

function navigate(entry: Entry): void {
  if (location.hash === `#${entry.spec.name}`) show(entry.spec.name, false);
  else location.hash = entry.spec.name;
}

function showFromHash(): void {
  let name = '';
  try {
    name = decodeURIComponent(location.hash.slice(1));
  } catch {
    name = '';
  }
  if (byName.has(name)) show(name, false);
  else if (current === null) show(entries[0].spec.name, false);
}

function filterNav(): void {
  const query = search.value.trim().toLowerCase();
  for (const entry of entries) {
    const haystack = `${entry.spec.name} ${entry.spec.summary}`.toLowerCase();
    entry.nav.hidden = query !== '' && !haystack.includes(query);
  }
  for (const section of nav.querySelectorAll<HTMLElement>('.gallery__nav-group')) {
    const group = section.dataset.group;
    const shown = entries.filter((entry) => entry.spec.group === group && !entry.nav.hidden);
    section.hidden = shown.length === 0;
    const heading = section.querySelector<HTMLElement>('.gallery__nav-heading');
    if (heading !== null) heading.textContent = `${group ?? ''} · ${shown.length}`;
  }
  const visible = visibleEntries().length;
  count.textContent = query === '' ? `${entries.length} components` : `${visible} / ${entries.length} match`;
  empty.hidden = visible > 0;
  updatePager();
}

/** Move focus inside the rail; native focus scrolling would tuck the item under the sticky heading. */
function focusNavItem(entry: Entry): void {
  entry.nav.focus({ preventScroll: true });
  revealNav(entry.nav);
}

function focusNav(step: number): void {
  const visible = visibleEntries();
  if (visible.length === 0) return;
  const active = document.activeElement;
  const index = visible.findIndex((entry) => entry.nav === active);
  const next = index < 0
    ? (step > 0 ? 0 : visible.length - 1)
    : (index + step + visible.length) % visible.length;
  focusNavItem(visible[next]);
}

search.addEventListener('input', filterNav);
search.addEventListener('keydown', (event: KeyboardEvent) => {
  if (event.key === 'Escape') {
    event.preventDefault();
    search.value = '';
    filterNav();
    if (current !== null) focusNavItem(current);
  } else if (event.key === 'Enter') {
    event.preventDefault();
    const first = visibleEntries()[0];
    if (first === undefined) return;
    navigate(first);
    focusNavItem(first);
  } else if (event.key === 'ArrowDown') {
    event.preventDefault();
    focusNav(1);
  }
});

nav.addEventListener('keydown', (event: KeyboardEvent) => {
  if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
    event.preventDefault();
    focusNav(event.key === 'ArrowDown' ? 1 : -1);
  } else if (event.key === 'Enter') {
    const target = event.target;
    if (!(target instanceof HTMLAnchorElement)) return;
    const entry = entries.find((candidate) => candidate.nav === target);
    if (entry === undefined) return;
    event.preventDefault();
    navigate(entry);
    if (entry.element !== null) focusPreviewOf(entry.element);
  }
});

window.addEventListener('hashchange', showFromHash);

document.addEventListener('keydown', (event: KeyboardEvent) => {
  if (event.metaKey || event.ctrlKey || event.altKey) return;
  const target = event.target;
  const typing = target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement
    || target instanceof HTMLSelectElement || (target instanceof HTMLElement && target.isContentEditable);
  if (typing) return;
  if (event.key === '/') {
    event.preventDefault();
    search.focus();
    search.select();
  } else if (event.key === '[' || event.key === ']') {
    event.preventDefault();
    const list = walkList();
    if (list.length === 0) return;
    const index = current === null ? -1 : list.indexOf(current);
    const next = list[(index + (event.key === ']' ? 1 : -1) + list.length) % list.length];
    navigate(next);
    focusNavItem(next);
  } else if (event.key === 'Escape' && search.value !== '') {
    event.preventDefault();
    search.value = '';
    filterNav();
  }
});

// Theme first: the mermaid Diagram renderer reads the resolved tokens at mount,
// so the first component must already be on the app's palette.
try {
  themeLabel.textContent = await applyKryptonTheme();
} catch {
  themeLabel.textContent = 'krypton-dark (built-in) · app theme unavailable';
}

filterNav();
showFromHash();

// A palette switch or Reload Config in Krypton lands the next time this tab is
// looked at; the custom properties repaint the mounted preview with no rebuild.
window.addEventListener('focus', () => {
  void applyKryptonTheme().then((label) => { themeLabel.textContent = label; }).catch(() => {});
});
