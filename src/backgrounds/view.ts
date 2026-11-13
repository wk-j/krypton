import { convertFileSrc } from '@tauri-apps/api/core';

import type { ContentView } from '../types';
import { Component } from '../ui/component';
import { keyCap, keyHintNodes } from '../ui/kbd';
import { disposeList, reconcile } from '../ui/list';
import { ANCHORS, DESKTOP, itemFor, library, references, sameChoice, validChoice } from './model';
import { WorkspaceBackground } from './renderer';
import type { BackgroundStore } from './store';
import type { BackgroundChoice, BackgroundState, LibraryItem, PermissionBackgroundRule } from './types';
import './backgrounds.css';

function node<K extends keyof HTMLElementTagNameMap>(tag: K, className = '', text = ''): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  el.className = className;
  el.textContent = text;
  return el;
}
interface RowProps { item: LibraryItem; selected: boolean; applied: boolean; optionId: string }
class LibraryRow extends Component<RowProps> {
  private readonly swatch = node('span', 'krypton-backgrounds__swatch');
  private readonly name = node('span', 'krypton-backgrounds__name');
  private readonly kind = node('span', 'krypton-backgrounds__muted');
  private readonly applied = node('span', 'krypton-backgrounds__applied', 'Applied');
  constructor(props: RowProps) {
    super(node('button', 'krypton-backgrounds__row'));
    this.el.setAttribute('role', 'option');
    this.el.tabIndex = -1;
    const copy = node('span', 'krypton-backgrounds__row-copy');
    const meta = node('span', 'krypton-backgrounds__row-meta');
    meta.append(this.kind, this.applied);
    copy.append(this.name, meta);
    this.el.append(this.swatch, copy);
    if (props.item.asset) {
      const img = node('img');
      img.loading = 'lazy';
      img.alt = '';
      img.src = convertFileSrc(props.item.asset.thumbnailPath);
      this.swatch.append(img);
    } else {
      const s = props.item.choice.source;
      this.swatch.style.background = s.kind === 'solid' ? s.color : s.kind === 'gradient'
        ? `linear-gradient(${s.angle}deg, ${s.from}, ${s.to})` : 'transparent';
    }
    this.update(props);
  }
  protected readDeps(p: RowProps): readonly unknown[] { return [p.item.id, p.item.name, p.item.choice.source.kind, !!p.item.asset, p.selected, p.applied, p.optionId]; }
  protected paint(p: RowProps): void {
    this.el.id = p.optionId;
    this.el.dataset.item = p.item.id;
    this.name.textContent = p.item.id === 'desktop' ? 'Desktop' : p.item.name;
    this.el.title = p.item.name;
    this.kind.textContent = p.item.asset ? 'Image' : p.item.choice.source.kind === 'solid' ? 'Solid colour'
      : p.item.choice.source.kind === 'gradient' ? 'Gradient' : 'Transparent';
    this.applied.hidden = !p.applied;
    this.syncClasses(p);
  }
  protected syncClasses(p: RowProps): void { this.el.setAttribute('aria-selected', String(p.selected)); }
  protected onDispose(): void {
    this.swatch.querySelector('img')?.removeAttribute('src');
    this.el.remove();
  }
}

export class BackgroundsView implements ContentView {
  readonly type = 'backgrounds' as const;
  readonly element = node('div', 'krypton-backgrounds');
  private readonly events = new AbortController();
  private readonly filter = node('input');
  private readonly picker = node('div', 'krypton-backgrounds__picker');
  private readonly builtins = node('div');
  private readonly images = node('div');
  private readonly preview = node('div', 'krypton-backgrounds__preview');
  private readonly previewLabel = node('p', 'krypton-backgrounds__muted');
  private readonly status = node('div', 'krypton-backgrounds__notice');
  private readonly dirty = node('p', 'krypton-backgrounds__dirty');
  private readonly previewName = node('span');
  private readonly previewMeta = node('span', 'krypton-backgrounds__muted');
  private readonly previewState = node('span', 'krypton-backgrounds__readout');
  private readonly libraryCount = node('span', 'krypton-backgrounds__muted');
  private readonly appearanceNote = node('p', 'krypton-backgrounds__muted');
  private readonly ruleStatus = node('span');
  private readonly ruleSource = node('div', 'krypton-backgrounds__rule-source');
  private readonly rulePicker = node('div', 'krypton-backgrounds__rule-picker');
  private readonly ruleSwatch = node('span', 'krypton-backgrounds__swatch');
  private readonly ruleName = node('span');
  private readonly ruleTargetButton: HTMLButtonElement;
  private readonly file = node('input');
  private readonly color = node('input');
  private readonly colorSwatch = node('span', 'krypton-backgrounds__swatch');
  private readonly fit = node('fieldset', 'krypton-backgrounds__selectors');
  private readonly anchors = node('fieldset', 'krypton-backgrounds__anchors');
  private readonly anchorDisclosure = node('details', 'krypton-backgrounds__anchor-disclosure');
  private readonly anchorSummary = node('summary', '', 'Centre');
  private readonly opacity = node('input');
  private readonly opacityNumber = node('input');
  private readonly dimming = node('input');
  private readonly dimmingNumber = node('input');
  private readonly enabled = node('input');
  private readonly apply: HTMLButtonElement;
  private readonly saveRule: HTMLButtonElement;
  private readonly tryButton: HTMLButtonElement;
  private readonly removeButton: HTMLButtonElement;
  private readonly confirm = node('div', 'krypton-backgrounds__confirm');
  private readonly renderer: WorkspaceBackground;
  private readonly unsubscribe: () => void;
  private close: (() => void) | null = null;
  private disposed = false;
  private draft: BackgroundChoice;
  private ruleTarget: BackgroundChoice | null;
  private ruleEnabled: boolean;
  private lastRule: PermissionBackgroundRule;
  private selected: string | null;
  private confirming: string | null = null;
  private previewMode: 'draft' | 'try' = 'draft';
  private previewRevision = 0;
  private lastRevision: string;

  constructor(private readonly store: BackgroundStore, private readonly permissionActive: () => boolean = () => false) {
    this.element.tabIndex = 0;
    this.draft = structuredClone(store.state.active);
    this.selected = itemFor(this.draft, store.state);
    this.ruleTarget = structuredClone(store.state.permissionRule.target);
    this.ruleEnabled = store.state.permissionRule.enabled;
    this.lastRule = structuredClone(store.state.permissionRule);
    this.lastRevision = store.state.revision;
    const header = node('header', 'krypton-backgrounds__header');
    const heading = node('div');
    heading.append(node('h1', '', 'Backgrounds'), node('p', 'krypton-backgrounds__muted', 'Your workspace. A quieter canvas.'));
    const importButton = this.button('Import image ', 'import');
    importButton.append(keyCap('i'));
    header.append(heading, importButton);
    const columns = node('div', 'krypton-backgrounds__columns');
    columns.tabIndex = 0;
    columns.setAttribute('role', 'region');
    columns.setAttribute('aria-label', 'Background editor');
    const left = node('aside', 'krypton-backgrounds__library');
    left.setAttribute('aria-label', 'Background library sidebar');
    this.filter.type = 'search';
    this.filter.placeholder = '/ Filter backgrounds';
    this.filter.setAttribute('aria-label', 'Search backgrounds');
    this.picker.id = `background-library-${crypto.randomUUID()}`;
    this.picker.tabIndex = 0;
    this.picker.setAttribute('role', 'listbox');
    this.picker.setAttribute('aria-label', 'Background library');
    this.picker.append(node('h2', '', 'Built-in'), this.builtins, node('h2', '', 'Your images'), this.images);
    const libraryHead = node('div', 'krypton-backgrounds__section-head');
    libraryHead.append(node('h2', '', '01 / Library'), this.libraryCount);
    left.append(libraryHead, this.filter, this.picker, node('p', 'krypton-backgrounds__muted', 'Images stay local. This never changes your OS wallpaper.'));
    const right = node('div', 'krypton-backgrounds__detail');
    right.tabIndex = 0;
    right.setAttribute('role', 'region'); right.setAttribute('aria-label', 'Background details');
    const previewSection = node('section', 'krypton-backgrounds__preview-section');
    previewSection.setAttribute('aria-label', 'Workspace preview');
    const previewHead = node('div', 'krypton-backgrounds__section-head');
    const title = node('div', 'krypton-backgrounds__preview-title');
    title.append(this.previewName, this.previewMeta);
    previewHead.append(title, this.previewState);
    const sample = node('div', 'krypton-backgrounds__sample');
    sample.append(node('div', 'krypton-backgrounds__sample-chrome', '● KRYPTON / TERMINAL'), node('div', 'krypton-backgrounds__sample-body', '$ npm run check\n✓ Ready\n$ _'));
    this.preview.append(sample);
    this.renderer = new WorkspaceBackground(this.preview, sample, (message) => this.notice(message));
    const caption = node('div', 'krypton-backgrounds__preview-caption');
    caption.append(this.dirty, this.previewLabel);
    previewSection.append(previewHead, this.preview, caption);
    const appearance = node('section', 'krypton-backgrounds__appearance');
    appearance.setAttribute('aria-label', 'Background appearance');
    this.color.type = 'text';
    this.color.maxLength = 7;
    this.color.name = 'color';
    this.color.spellcheck = false;
    this.color.setAttribute('aria-label', 'Colour #RRGGBB');
    const colorLabel = node('label', 'krypton-backgrounds__control', 'Colour #RRGGBB');
    this.colorSwatch.setAttribute('aria-hidden', 'true');
    colorLabel.append(this.color, this.colorSwatch);
    this.fit.append(node('legend', '', 'Image fit'));
    for (const [value, label] of [['cover', 'Fill'], ['contain', 'Fit'], ['stretch', 'Stretch']]) {
      const b = this.button(label, 'fit'); b.dataset.value = value; this.fit.append(b);
    }
    this.anchors.append(node('legend', '', 'Image anchor'));
    const anchorGlyphs = ['↖', '↑', '↗', '←', '●', '→', '↙', '↓', '↘'];
    for (const [index, anchor] of ANCHORS.entries()) {
      const b = this.button(anchorGlyphs[index], 'anchor');
      b.dataset.value = anchor;
      b.title = `Image anchor: ${anchor.replaceAll('-', ' ')}`;
      b.setAttribute('aria-label', b.title);
      this.anchors.append(b);
    }
    colorLabel.classList.add('krypton-backgrounds__colour');
    const placement = node('div', 'krypton-backgrounds__placement');
    this.anchorSummary.setAttribute('aria-label', 'Image position');
    this.anchorDisclosure.append(this.anchorSummary, this.anchors);
    placement.append(this.fit, this.anchorDisclosure);
    appearance.append(colorLabel, placement,
      this.slider('Opacity', 'opacity', this.opacity, this.opacityNumber, 100),
      this.slider('Dimming', 'dimming', this.dimming, this.dimmingNumber, 90), this.appearanceNote);
    const actions = node('div', 'krypton-backgrounds__actions krypton-backgrounds__commit-actions');
    this.apply = this.button('Apply', 'apply');
    this.removeButton = this.button('Remove image', 'remove');
    this.apply.append(' ', keyCap('⌘Enter'));
    actions.append(this.apply, this.button('Return to base', 'return'), this.button('Restore Desktop', 'reset'), this.removeButton, this.button('Refresh', 'refresh'));
    const rules = node('section', 'krypton-backgrounds__rules');
    rules.setAttribute('aria-label', 'Event rules');
    const rulesHead = node('div', 'krypton-backgrounds__section-head');
    const rulesTitle = node('div', 'krypton-backgrounds__actions');
    rulesTitle.append(node('h2', '', '02 / Event rules'), node('span', 'krypton-backgrounds__readout', '1 RULE'));
    const enableLabel = node('label', 'krypton-backgrounds__rule-toggle');
    this.enabled.type = 'checkbox'; this.enabled.name = 'permissionEnabled';
    this.enabled.setAttribute('aria-label', 'Enable Needs permission background');
    enableLabel.append(this.enabled, this.ruleStatus);
    this.tryButton = this.button('Try it ↗', 'try');
    this.tryButton.setAttribute('aria-label', 'Preview Needs permission background');
    this.saveRule = this.button('Save rule', 'save-rule');
    const ruleActions = node('div', 'krypton-backgrounds__actions');
    ruleActions.append(enableLabel, this.saveRule);
    rulesHead.append(rulesTitle, ruleActions);
    const table = node('div', 'krypton-backgrounds__rule-table');
    table.setAttribute('role', 'table'); table.setAttribute('aria-label', 'Background event rules');
    const labels = node('div', 'krypton-backgrounds__rule-row krypton-backgrounds__rule-head');
    labels.setAttribute('role', 'row');
    for (const text of ['When', 'Background', 'Transition', 'Preview']) {
      const label = node('span', '', text); label.setAttribute('role', 'columnheader'); labels.append(label);
    }
    const row = node('div', 'krypton-backgrounds__rule-row'); row.setAttribute('role', 'row');
    const event = node('span', 'krypton-backgrounds__rule-event', 'Needs permission'); event.setAttribute('role', 'cell');
    this.ruleTargetButton = this.button('', 'rule-picker');
    this.ruleTargetButton.setAttribute('aria-haspopup', 'listbox');
    this.ruleTargetButton.append(this.ruleSwatch, this.ruleName, node('span', '', '▾'));
    this.rulePicker.id = `background-rule-picker-${crypto.randomUUID()}`;
    this.rulePicker.hidden = true;
    this.rulePicker.setAttribute('role', 'listbox'); this.rulePicker.setAttribute('aria-label', 'Permission background');
    this.ruleTargetButton.setAttribute('aria-controls', this.rulePicker.id);
    this.ruleSource.setAttribute('role', 'cell');
    this.ruleSource.append(this.ruleTargetButton, this.rulePicker);
    const transition = node('span', 'krypton-backgrounds__muted', '280ms fade'); transition.setAttribute('role', 'cell');
    const test = node('div'); test.setAttribute('role', 'cell'); test.append(this.tryButton);
    row.append(event, this.ruleSource, transition, test);
    table.append(labels, row);
    rules.append(rulesHead, node('p', 'krypton-backgrounds__muted', 'Let the background respond. Your normal background stays saved.'), table,
      node('p', 'krypton-backgrounds__muted', 'All Harness lanes · While permission is pending; when clear, return to base.'));
    right.append(previewSection, appearance, rules, this.confirm);
    columns.append(left, right);
    this.file.type = 'file'; this.file.accept = 'image/png,image/jpeg,image/webp'; this.file.hidden = true;
    this.file.setAttribute('aria-label', 'Import one background image');
    this.status.setAttribute('role', 'status'); this.status.setAttribute('aria-live', 'polite');
    const footer = node('footer', 'krypton-backgrounds__hints');
    footer.tabIndex = 0;
    footer.setAttribute('aria-label', 'Background keyboard shortcuts');
    footer.append(...keyHintNodes([
      { keys: ['j', 'k'], keySeparator: '/', label: 'select' }, { keys: ['/'], label: 'search' },
      { keys: ['i'], label: 'import' }, { keys: ['⌘Enter'], label: 'apply' }, { keys: ['p'], label: 'try rule' },
      { keys: ['r'], label: 'refresh' }, { keys: ['D'], label: 'desktop' }, { keys: ['q'], label: 'close' },
    ]));
    this.element.append(header, columns, actions, this.status, footer, this.file);
    this.element.addEventListener('click', (event) => this.click(event), { signal: this.events.signal });
    this.filter.addEventListener('input', () => this.renderList(), { signal: this.events.signal });
    this.color.addEventListener('input', () => {
      if (this.draft?.source.kind === 'solid') this.draft.source.color = this.color.value;
      this.edited();
    }, { signal: this.events.signal });
    this.enabled.addEventListener('change', () => {
      this.ruleEnabled = this.enabled.checked; this.renderControls();
    }, { signal: this.events.signal });
    for (const event of ['pointerdown', 'focusin']) document.addEventListener(event, (e) => {
      if (!(e.target instanceof Node)) return;
      if (!this.rulePicker.hidden && !this.ruleSource.contains(e.target)) this.closeRulePicker(false);
      if (this.anchorDisclosure.open && !this.anchorDisclosure.contains(e.target)) this.anchorDisclosure.open = false;
    }, { signal: this.events.signal });
    this.file.addEventListener('change', () => {
      const file = this.file.files?.[0];
      this.file.value = '';
      if (file) void this.run(async () => {
        const result = await store.import(file);
        if (!this.disposed) this.select(result.assetId);
      });
    }, { signal: this.events.signal });
    this.unsubscribe = store.subscribe(() => this.storeChanged());
    this.renderList();
    this.renderControls();
    this.renderPreview();
  }
  private button(label: string, action: string): HTMLButtonElement {
    const b = node('button', '', label); b.type = 'button'; b.dataset.action = action; return b;
  }
  private slider(label: string, field: 'opacity' | 'dimming', range: HTMLInputElement, number: HTMLInputElement, max: number): HTMLElement {
    const row = node('label', 'krypton-backgrounds__control krypton-backgrounds__slider');
    row.append(node('span', '', label));
    range.type = 'range'; number.type = 'number';
    for (const input of [range, number]) {
      input.min = '0'; input.max = String(max); input.step = '1'; input.name = field;
      input.setAttribute('aria-label', `${label} percent`);
      input.addEventListener('input', () => {
        if (this.draft) this.draft[field] = input.valueAsNumber / 100;
        const other = input === range ? number : range; other.value = input.value;
        this.edited();
      }, { signal: this.events.signal });
    }
    row.append(number, node('span', '', '%'), range); return row;
  }
  private get state(): BackgroundState { return this.store.state; }
  private items(): LibraryItem[] {
    const query = this.filter.value.toLocaleLowerCase();
    return library(this.state).filter((item) => item.name.toLocaleLowerCase().includes(query));
  }
  private renderList(): void {
    const items = this.items();
    this.libraryCount.textContent = String(items.length);
    for (const [container, imported] of [[this.builtins, false], [this.images, true]] as const) {
      const props = items.filter((i) => !!i.asset === imported).map((item) => ({ item, selected: item.id === this.selected, applied: item.id === itemFor(this.state.active, this.state), optionId: `${this.picker.id}-${item.id}` }));
      reconcile(container, props, {
        key: (p) => p.item.id,
        create: (p) => new LibraryRow(p),
        update: (row, p) => row.update(p),
      });
    }
    if (items.some((item) => item.id === this.selected)) this.picker.setAttribute('aria-activedescendant', `${this.picker.id}-${this.selected}`);
    else this.picker.removeAttribute('aria-activedescendant');
  }
  private select(id: string): void {
    const item = library(this.state).find((i) => i.id === id);
    if (!item) return;
    this.selected = id; this.draft = structuredClone(item.choice); this.previewMode = 'draft'; this.confirming = null;
    this.renderList(); this.renderControls(); this.renderPreview();
    this.revealSelection();
  }
  private revealSelection(): void {
    this.picker.querySelector<HTMLElement>('[aria-selected="true"]')?.scrollIntoView({ block: 'nearest' });
  }
  private restoreDrafts(): void {
    this.ruleTarget = structuredClone(this.state.permissionRule.target);
    this.ruleEnabled = this.state.permissionRule.enabled;
    this.returnToBase();
  }
  private returnToBase(): void {
    this.draft = structuredClone(this.state.active);
    this.selected = itemFor(this.draft, this.state);
    this.previewMode = 'draft'; this.confirming = null;
    this.closeRulePicker(false);
    this.renderList(); this.renderControls(); this.renderPreview();
    this.revealSelection();
  }
  private edited(): void {
    this.previewMode = 'draft'; this.selected = itemFor(this.draft, this.state);
    this.renderList(); this.renderControls(); this.renderPreview();
  }
  private choiceName(c: BackgroundChoice | null): string {
    if (!c) return 'Select background';
    const name = library(this.state).find((item) => item.id === itemFor(c, this.state))?.name ?? 'Background';
    return c.source.kind === 'solid' ? `${name} ${c.source.color}` : name;
  }
  private paintSwatch(el: HTMLElement, c: BackgroundChoice | null): void {
    const signature = JSON.stringify(c?.source);
    if (el.dataset.source === signature) return;
    el.dataset.source = signature;
    el.querySelector('img')?.removeAttribute('src'); el.replaceChildren(); el.style.background = '';
    if (!validChoice(c, this.state)) return;
    const s = c.source;
    if (s.kind === 'solid') el.style.background = s.color;
    if (s.kind === 'gradient') el.style.background = `linear-gradient(${s.angle}deg, ${s.from}, ${s.to})`;
    if (s.kind === 'image') {
      const asset = this.state.assets.find((a) => a.id === s.assetId);
      if (asset) { const img = node('img'); img.alt = ''; img.loading = 'lazy'; img.src = convertFileSrc(asset.thumbnailPath); el.append(img); }
    }
  }
  private openRulePicker(): void {
    if (!this.rulePicker.hidden) { this.closeRulePicker(); return; }
    if (this.previewMode === 'try') { this.previewMode = 'draft'; this.renderPreview(); }
    const items = [{ id: 'preview', name: 'Use current preview', choice: this.draft }, ...library(this.state)];
    for (const item of items) {
      const option = this.button('', 'rule-option'); option.dataset.ruleItem = item.id;
      option.className = 'krypton-backgrounds__rule-option'; option.setAttribute('role', 'option'); option.tabIndex = -1;
      option.setAttribute('aria-selected', String(item.id !== 'preview' && sameChoice(item.choice, this.ruleTarget)));
      option.disabled = !validChoice(item.choice, this.state);
      const swatch = node('span', 'krypton-backgrounds__swatch'); this.paintSwatch(swatch, item.choice);
      option.title = this.choiceName(item.choice);
      option.append(swatch, node('span', 'krypton-backgrounds__name', item.name)); this.rulePicker.append(option);
    }
    this.rulePicker.hidden = false; this.ruleTargetButton.setAttribute('aria-expanded', 'true');
    const first = this.rulePicker.querySelector<HTMLButtonElement>('[aria-selected="true"]') ?? this.rulePicker.querySelector<HTMLButtonElement>('button:not(:disabled)');
    if (first) { first.tabIndex = 0; first.focus(); }
  }
  private closeRulePicker(focus = true): void {
    if (this.rulePicker.hidden) return;
    this.rulePicker.hidden = true; this.ruleTargetButton.setAttribute('aria-expanded', 'false');
    for (const img of this.rulePicker.querySelectorAll('img')) img.removeAttribute('src');
    this.rulePicker.replaceChildren();
    if (focus) this.ruleTargetButton.focus({ preventScroll: true });
  }
  private renderControls(): void {
    const c = this.draft;
    const valid = validChoice(c, this.state);
    const desktop = !c || c.source.kind === 'desktop';
    const image = c?.source.kind === 'image';
    const unavailable = this.store.busy || !this.store.loaded;
    this.element.setAttribute('aria-busy', String(this.store.busy));
    this.color.parentElement!.hidden = c?.source.kind !== 'solid';
    if (c?.source.kind === 'solid' && this.color.value !== c.source.color) this.color.value = c.source.color;
    this.color.setAttribute('aria-invalid', String(!valid));
    this.colorSwatch.style.backgroundColor = c?.source.kind === 'solid' && /^#[0-9a-f]{6}$/i.test(c.source.color) ? c.source.color : 'transparent';
    this.appearanceNote.hidden = c.source.kind === 'solid' || image;
    this.appearanceNote.textContent = desktop ? 'Desktop is transparent. Select Custom colour in the library to edit a colour.'
      : 'This is a preset gradient. Select Custom colour to edit a single colour.';
    this.fit.parentElement!.hidden = !image;
    this.fit.hidden = !image; this.anchors.hidden = !image;
    this.anchorSummary.textContent = c.anchor === 'center' ? 'Centre' : c.anchor.replaceAll('-', ' ');
    if (!image) this.anchorDisclosure.open = false;
    this.element.querySelector<HTMLElement>('.krypton-backgrounds__appearance')!.dataset.kind = c.source.kind;
    this.fit.disabled = !image; this.anchors.disabled = !image;
    for (const input of [this.opacity, this.opacityNumber]) { input.disabled = desktop; input.value = String(Math.round((c?.opacity ?? 1) * 100)); }
    for (const input of [this.dimming, this.dimmingNumber]) { input.disabled = desktop; input.value = String(Math.round((c?.dimming ?? 0) * 100)); }
    for (const b of this.element.querySelectorAll<HTMLButtonElement>('[data-action="fit"], [data-action="anchor"]')) {
      b.setAttribute('aria-pressed', String(b.dataset.value === (b.dataset.action === 'fit' ? c?.fit : c?.anchor)));
    }
    this.apply.disabled = !valid || unavailable;
    const ruleSaved = sameChoice(this.ruleTarget, this.state.permissionRule.target) && this.ruleEnabled === this.state.permissionRule.enabled;
    this.saveRule.disabled = unavailable || ruleSaved || (this.ruleTarget !== null && !validChoice(this.ruleTarget, this.state));
    this.ruleStatus.textContent = `${this.ruleEnabled ? 'On' : 'Off'}${ruleSaved ? '' : ' · Unsaved'}`;
    this.ruleTargetButton.disabled = unavailable;
    this.ruleTargetButton.setAttribute('aria-expanded', String(!this.rulePicker.hidden));
    this.ruleTargetButton.setAttribute('aria-label', `Permission background: ${this.choiceName(this.ruleTarget)}`);
    this.ruleTargetButton.title = this.choiceName(this.ruleTarget);
    this.ruleName.textContent = this.choiceName(this.ruleTarget);
    this.paintSwatch(this.ruleSwatch, this.ruleTarget);
    this.enabled.disabled = !validChoice(this.ruleTarget, this.state) || unavailable;
    this.enabled.checked = this.ruleEnabled;
    this.tryButton.disabled = !validChoice(this.ruleTarget, this.state);
    this.removeButton.disabled = unavailable; this.removeButton.hidden = !this.selected || !this.state.assets.some((a) => a.id === this.selected);
    for (const action of ['import', 'reset']) {
      const b = this.element.querySelector<HTMLButtonElement>(`[data-action="${action}"]`);
      if (b) b.disabled = unavailable;
    }
    const isSaved = sameChoice(c, this.state.active);
    this.dirty.textContent = `${this.store.busy ? 'Updating library…' : isSaved ? 'Selected background is applied.' : 'Not applied · Apply saves your normal background.'}${this.permissionActive() && this.state.permissionRule.enabled ? ' · Needs permission active' : ''}`;
    this.confirm.hidden = !this.confirming;
    if (this.store.error) this.notice(`${this.store.error} · Repair or move the manifest externally, then Refresh.`);
  }
  private renderPreview(): void {
    if (this.disposed) return;
    const chosen = validChoice(this.draft, this.state) ? this.draft : DESKTOP;
    const target = this.ruleTarget;
    const simulation = this.previewMode === 'try' && validChoice(target, this.state);
    const base = this.previewMode === 'draft' ? chosen : this.state.active;
    const state: BackgroundState = {
      ...this.state, revision: `${this.state.revision}:preview:${++this.previewRevision}`, active: base,
      permissionRule: { enabled: true, target },
    };
    const shown = simulation ? target : chosen;
    this.previewName.textContent = this.choiceName(shown);
    const assetId = shown?.source.kind === 'image' ? shown.source.assetId : null;
    const asset = this.state.assets.find((a) => a.id === assetId);
    this.previewMeta.textContent = asset ? `${asset.width} × ${asset.height}` : '';
    this.previewState.textContent = simulation ? 'Permission preview' : sameChoice(chosen, this.state.active) ? 'Base background' : 'Preview only';
    this.previewLabel.textContent = simulation ? 'Needs permission simulation · Preview only'
      : base.source.kind === 'desktop' ? 'Transparent · Your desktop stays visible' : 'Preview only · No live sessions';
    void this.renderer.update(state, simulation, this.previewMode === 'draft');
  }
  private storeChanged(): void {
    if (this.disposed) return;
    if (this.lastRevision !== this.state.revision) {
      const cleanRule = sameChoice(this.ruleTarget, this.lastRule.target) && this.ruleEnabled === this.lastRule.enabled;
      if (cleanRule || this.ruleTarget && !validChoice(this.ruleTarget, this.state)) {
        this.ruleTarget = structuredClone(this.state.permissionRule.target);
        this.ruleEnabled = this.state.permissionRule.enabled;
      }
      this.lastRule = structuredClone(this.state.permissionRule);
      this.lastRevision = this.state.revision;
      if (this.draft.source.kind === 'image' && !this.state.assets.some((asset) => references(this.draft, asset.id))) {
        this.draft = structuredClone(this.state.active); this.selected = itemFor(this.draft, this.state);
      }
      this.closeRulePicker(false);
      this.renderList(); this.renderPreview();
    }
    this.renderControls();
  }
  private notice(message: string): void { if (!this.disposed) this.status.textContent = message; }
  private async run(action: () => Promise<unknown>): Promise<void> {
    if (this.store.busy || this.disposed) return;
    try { await action(); }
    catch (error) { this.notice(String(error)); }
  }
  private async save(): Promise<void> {
    if (!validChoice(this.draft, this.state)) return;
    await this.store.apply(this.draft);
    this.notice(this.permissionActive() && this.state.permissionRule.enabled ? 'Base saved · Needs permission active' : 'Base saved');
  }
  private askRemove(): void {
    const asset = this.state.assets.find((a) => a.id === this.selected);
    if (!asset) return;
    this.confirming = asset.id;
    this.confirm.replaceChildren(node('p', '', `Remove ${asset.name}?${references(this.state.active, asset.id) ? ' The base will return to Desktop.' : ''}${references(this.state.permissionRule.target, asset.id) ? ' The permission rule will be cleared and disabled.' : ''} The original source file is untouched.`), this.button('Remove', 'confirm-remove'), this.button('Cancel', 'cancel-remove'));
    this.confirm.hidden = false;
    this.confirm.querySelector<HTMLButtonElement>('button')?.focus();
  }
  private click(event: MouseEvent): void {
    const target = event.target instanceof Element ? event.target : null;
    const item = target?.closest<HTMLElement>('[data-item]');
    if (item?.dataset.item) { this.select(item.dataset.item); this.focusView(); return; }
    const b = target?.closest<HTMLButtonElement>('button[data-action]');
    if (!b || b.disabled) return;
    switch (b.dataset.action) {
      case 'rule-picker': this.openRulePicker(); break;
      case 'rule-option': {
        const selected = b.dataset.ruleItem === 'preview' ? this.draft : library(this.state).find((item) => item.id === b.dataset.ruleItem)?.choice;
        if (selected && validChoice(selected, this.state)) this.ruleTarget = structuredClone(selected);
        this.closeRulePicker(); this.renderControls(); break;
      }
      case 'fit': if (this.draft && ['cover', 'contain', 'stretch'].includes(b.dataset.value ?? '')) { this.draft.fit = b.dataset.value as BackgroundChoice['fit']; this.edited(); } break;
      case 'anchor': if (this.draft && ANCHORS.includes(b.dataset.value as BackgroundChoice['anchor'])) { this.draft.anchor = b.dataset.value as BackgroundChoice['anchor']; this.edited(); this.anchorDisclosure.open = false; this.anchorSummary.focus(); } break;
      case 'import': this.file.click(); break;
      case 'apply': void this.run(() => this.save()); break;
      case 'save-rule': void this.run(async () => {
        await this.store.saveRule({ enabled: this.ruleEnabled, target: this.ruleTarget }); this.notice('Permission rule saved');
      }); break;
      case 'try': this.previewMode = 'try'; this.renderPreview(); break;
      case 'return': this.returnToBase(); break;
      case 'refresh': void this.run(async () => { await this.store.refresh(); if (!this.disposed) { this.restoreDrafts(); this.notice('Library refreshed'); } }); break;
      case 'reset': void this.run(async () => { await this.store.reset(); if (!this.disposed) { this.restoreDrafts(); this.notice('Desktop restored · Permission rule disabled'); } }); break;
      case 'remove': this.askRemove(); break;
      case 'cancel-remove': this.confirming = null; this.confirm.hidden = true; this.focusView(); break;
      case 'confirm-remove': void this.run(async () => {
        if (!this.confirming) return;
        const result = await this.store.remove(this.confirming);
        if (!this.disposed) { this.restoreDrafts(); this.notice(result.cleanupWarning ?? 'Image removed'); this.focusView(); }
      }); break;
    }
  }
  onKeyDown(e: KeyboardEvent): boolean {
    if (e.metaKey && e.key === 'Enter') { void this.run(() => this.save()); return true; }
    if (e.metaKey || e.ctrlKey || e.altKey) return false;
    if (!this.rulePicker.hidden) {
      if (e.key === 'Escape') { this.closeRulePicker(); return true; }
      if (['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(e.key)) {
        const options = [...this.rulePicker.querySelectorAll<HTMLButtonElement>('button:not(:disabled)')];
        const index = options.findIndex((option) => option === document.activeElement);
        const next = e.key === 'Home' ? 0 : e.key === 'End' ? options.length - 1
          : (index + (e.key === 'ArrowDown' ? 1 : -1) + options.length) % options.length;
        for (const option of options) option.tabIndex = -1;
        if (options[next]) { options[next].tabIndex = 0; options[next].focus(); }
        return true;
      }
      return false;
    }
    if (e.key === 'Escape' && this.anchorDisclosure.open) {
      this.anchorDisclosure.open = false; this.anchorSummary.focus(); return true;
    }
    if (e.key === 'Escape' && this.previewMode === 'try') { this.previewMode = 'draft'; this.renderPreview(); return true; }
    if (this.confirming) {
      if (e.key === 'Escape') { this.confirming = null; this.confirm.hidden = true; this.focusView(); return true; }
      if (e.key === 'Enter') { this.confirm.querySelector<HTMLButtonElement>('[data-action="confirm-remove"]')?.click(); return true; }
    }
    const active = document.activeElement;
    if (active instanceof HTMLInputElement || active instanceof HTMLTextAreaElement || active instanceof HTMLElement && active.isContentEditable) {
      if (e.key === 'Escape') { this.focusView(); return true; }
      return false;
    }
    if (e.key === 'j' || e.key === 'k' || (active === this.picker && (e.key === 'ArrowDown' || e.key === 'ArrowUp'))) {
      const items = this.items();
      const index = items.findIndex((i) => i.id === this.selected);
      const next = Math.max(0, Math.min(items.length - 1, index + (e.key === 'j' || e.key === 'ArrowDown' ? 1 : -1)));
      if (items[next]) this.select(items[next].id);
      return true;
    }
    switch (e.key) {
      case '/': this.filter.focus(); return true;
      case 'i': this.element.querySelector<HTMLButtonElement>('[data-action="import"]')?.click(); return true;
      case 'r': this.element.querySelector<HTMLButtonElement>('[data-action="refresh"]')?.click(); return true;
      case 'D': this.element.querySelector<HTMLButtonElement>('[data-action="reset"]')?.click(); return true;
      case 'p': if (!this.tryButton.disabled) { this.previewMode = 'try'; this.renderPreview(); } return true;
      case 'Delete': case 'Backspace': if (!this.removeButton.hidden && !this.removeButton.disabled) this.askRemove(); return true;
      case 'Enter': if (active === this.picker || active === this.element) { void this.run(() => this.save()); return true; } return false;
      case 'q': case 'Escape': this.close?.(); return true;
      default: return false;
    }
  }
  onClose(cb: () => void): void { this.close = cb; }
  focusView(): void { this.picker.focus({ preventScroll: true }); this.revealSelection(); }
  dispose(): void {
    this.disposed = true;
    this.unsubscribe(); this.events.abort(); this.renderer.dispose(); this.closeRulePicker(false);
    this.ruleSwatch.querySelector('img')?.removeAttribute('src');
    disposeList(this.builtins); disposeList(this.images);
    this.file.value = ''; this.close = null; this.element.remove();
  }
}
