// Spec 309 — Content group renderers (Text · Callout · Metric · Badge ·
// KeyValue · List · Sources).
//
// `Text` and `Callout` take inline markdown, and the whole of it is the three
// marks below: `` `code` ``, `**bold**`, `*italic*`. There is no parser and no
// `innerHTML` — one scanner emits literal text and three inline elements, so a
// spec that writes `<script>` writes the eight characters `<script>`.
//
// `Sources` never emits an `<a href>`: a link is a button that asks the host to
// run `OpenUrl`, which is re-checked for an `http(s)` scheme at run time and
// routed through the existing `open_url` command.

import { el, setChildren } from '../../../ui/dom';
import type { ElChild } from '../../../ui/dom';
import type { UiAction, Value } from '../../genui/types';
import { isAction, isList, isPlainObject } from '../../genui/types';
import {
  BLOCK,
  FOCUSABLE_ATTR,
  GenUiComponent,
  asList,
  asObject,
  asString,
  toneClass,
} from './renderer';
import type { GenUiContext, GenUiFactory, GenUiProps } from './renderer';

const EMPTY = '—';

// Order matters: `**` must win over `*` on the same opening character.
const INLINE_MARK = /`([^`]+)`|\*\*([\s\S]+?)\*\*|\*([^*\n]+)\*/g;

/** Literal text plus `code` / `strong` / `em` runs. Everything else stays literal. */
function inlineMarkdown(text: string): readonly ElChild[] {
  const out: ElChild[] = [];
  let last = 0;
  INLINE_MARK.lastIndex = 0;
  for (let match = INLINE_MARK.exec(text); match !== null; match = INLINE_MARK.exec(text)) {
    if (match.index > last) out.push(text.slice(last, match.index));
    const code = match[1];
    const bold = match[2];
    if (code) out.push(el('code', { class: `${BLOCK}__md-code`, text: code }));
    else if (bold) out.push(el('strong', { class: `${BLOCK}__md-strong`, text: bold }));
    else out.push(el('em', { class: `${BLOCK}__md-em`, text: match[3] }));
    last = match.index + match[0].length;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

/** One action, a list of them, or nothing — the shape a runtime value can hold. */
function toActions(value: Value): readonly UiAction[] {
  if (isAction(value)) return [value];
  const out: UiAction[] = [];
  for (const item of asList(value)) {
    if (isAction(item)) out.push(item);
  }
  return out;
}

/** Display text for a cell the model may have left null, empty or a list. */
function cellText(value: Value): string {
  if (isList(value)) {
    const parts: string[] = [];
    for (const item of value) {
      const text = asString(item);
      if (text !== '') parts.push(text);
    }
    return parts.length === 0 ? EMPTY : parts.join(', ');
  }
  const text = asString(value);
  return text === '' ? EMPTY : text;
}

class TextComponent extends GenUiComponent {
  private readonly root: HTMLElement;

  constructor(host: HTMLElement) {
    super(host);
    // `__text` belongs to the Input field (inputs.css); the paragraph is `__prose`.
    this.root = el('p', { class: `${BLOCK}__prose` });
    host.appendChild(this.root);
  }

  protected readDeps(next: GenUiProps): readonly unknown[] {
    return [next.node.props.text, next.node.props.tone];
  }

  protected paint(next: GenUiProps): void {
    this.root.className = toneClass(`${BLOCK}__prose`, next.node.props.tone);
    setChildren(this.root, inlineMarkdown(asString(next.node.props.text)));
  }
}

class CalloutComponent extends GenUiComponent {
  private readonly title = el('div', { class: `${BLOCK}__callout-title` });
  private readonly text = el('div', { class: `${BLOCK}__callout-text` });
  private readonly root: HTMLElement;

  constructor(host: HTMLElement) {
    super(host);
    this.root = el('div', { class: `${BLOCK}__callout`, children: [this.title, this.text] });
    host.appendChild(this.root);
  }

  protected readDeps(next: GenUiProps): readonly unknown[] {
    return [next.node.props.text, next.node.props.tone, next.node.props.title];
  }

  protected paint(next: GenUiProps): void {
    this.root.className = toneClass(`${BLOCK}__callout`, next.node.props.tone);
    const title = asString(next.node.props.title);
    this.title.textContent = title;
    this.title.hidden = title === '';
    setChildren(this.text, inlineMarkdown(asString(next.node.props.text)));
  }
}

class MetricComponent extends GenUiComponent {
  private readonly label = el('div', { class: `${BLOCK}__metric-label ${BLOCK}__label` });
  private readonly value = el('div', { class: `${BLOCK}__metric-value ${BLOCK}__value` });
  private readonly note = el('div', { class: `${BLOCK}__metric-note` });
  private readonly root: HTMLElement;

  constructor(host: HTMLElement) {
    super(host);
    this.root = el('div', { class: `${BLOCK}__metric`, children: [this.label, this.value, this.note] });
    host.appendChild(this.root);
  }

  protected readDeps(next: GenUiProps): readonly unknown[] {
    return [next.node.props.label, next.node.props.value, next.node.props.note, next.node.props.tone];
  }

  protected paint(next: GenUiProps): void {
    this.root.className = toneClass(`${BLOCK}__metric`, next.node.props.tone);
    this.label.textContent = asString(next.node.props.label);
    this.value.textContent = asString(next.node.props.value);
    const note = asString(next.node.props.note);
    this.note.textContent = note;
    this.note.hidden = note === '';
  }
}

class BadgeComponent extends GenUiComponent {
  private readonly root: HTMLElement;

  constructor(host: HTMLElement) {
    super(host);
    this.root = el('span', { class: `${BLOCK}__badge` });
    host.appendChild(this.root);
  }

  protected readDeps(next: GenUiProps): readonly unknown[] {
    return [next.node.props.text, next.node.props.tone];
  }

  protected paint(next: GenUiProps): void {
    this.root.className = toneClass(`${BLOCK}__badge`, next.node.props.tone);
    this.root.textContent = asString(next.node.props.text);
  }
}

class KeyValueComponent extends GenUiComponent {
  private readonly root: HTMLElement;

  constructor(host: HTMLElement) {
    super(host);
    this.root = el('dl', { class: `${BLOCK}__kv` });
    host.appendChild(this.root);
  }

  protected readDeps(next: GenUiProps): readonly unknown[] {
    return [next.node.props.pairs];
  }

  protected paint(next: GenUiProps): void {
    const pairs = next.node.props.pairs;
    const rows: HTMLElement[] = [];
    if (isPlainObject(pairs)) {
      for (const [key, value] of Object.entries(asObject(pairs))) {
        rows.push(el('dt', { class: `${BLOCK}__kv-key ${BLOCK}__label`, text: key }));
        rows.push(el('dd', { class: `${BLOCK}__kv-value`, text: cellText(value) }));
      }
    } else {
      for (const entry of asList(pairs)) {
        const cells = asList(entry);
        rows.push(el('dt', { class: `${BLOCK}__kv-key ${BLOCK}__label`, text: asString(cells[0]) }));
        rows.push(el('dd', { class: `${BLOCK}__kv-value`, text: cellText(cells[1] ?? null) }));
      }
    }
    this.root.replaceChildren(...rows);
  }
}

/**
 * Rows are rebuilt whenever `items` changes, so the click handler is one
 * delegated listener on the container: a per-row listener would accumulate in
 * the bag, one set per repaint, for the component's whole life.
 */
class ListComponent extends GenUiComponent {
  private readonly root: HTMLElement;
  private readonly actions: (readonly UiAction[])[] = [];
  private ctx: GenUiContext | null = null;

  constructor(host: HTMLElement) {
    super(host);
    this.root = el('div', { class: `${BLOCK}__list` });
    host.appendChild(this.root);
    this.bag.listen(this.root, 'click', (event) => {
      const index = rowIndex(event, `${BLOCK}__list-row--action`);
      const actions = index < 0 ? undefined : this.actions[index];
      if (actions !== undefined && this.ctx !== null) this.ctx.run(actions);
    });
  }

  protected readDeps(next: GenUiProps): readonly unknown[] {
    return [next.node.props.items];
  }

  protected paint(next: GenUiProps): void {
    this.ctx = next.ctx;
    this.actions.length = 0;
    const rows: HTMLElement[] = [];
    for (const item of asList(next.node.props.items)) {
      const fields = isPlainObject(item) ? item : { title: item };
      const cells: ElChild[] = [
        el('span', { class: `${BLOCK}__list-title`, text: asString(fields.title) }),
      ];
      const detail = asString(fields.detail);
      if (detail !== '') cells.push(el('span', { class: `${BLOCK}__list-detail`, text: detail }));
      const value = asString(fields.value);
      if (value !== '') {
        cells.push(el('span', { class: toneClass(`${BLOCK}__list-value`, fields.tone ?? null), text: value }));
      }

      const actions = toActions(fields.action ?? null);
      if (actions.length === 0) {
        rows.push(el('div', { class: `${BLOCK}__list-row`, children: cells }));
        continue;
      }
      rows.push(el('button', {
        class: `${BLOCK}__list-row ${BLOCK}__list-row--action`,
        data: { 'genui-row': String(this.actions.push(actions) - 1) },
        attrs: { type: 'button', [FOCUSABLE_ATTR]: true },
        children: cells,
      }));
    }
    this.root.replaceChildren(...rows);
  }
}

class SourcesComponent extends GenUiComponent {
  private readonly root: HTMLElement;
  private readonly urls: string[] = [];
  private ctx: GenUiContext | null = null;

  constructor(host: HTMLElement) {
    super(host);
    this.root = el('div', { class: `${BLOCK}__sources` });
    host.appendChild(this.root);
    this.bag.listen(this.root, 'click', (event) => {
      const index = rowIndex(event, `${BLOCK}__source`);
      const url = index < 0 ? undefined : this.urls[index];
      if (url !== undefined && this.ctx !== null) {
        this.ctx.run([{ kind: 'action', type: 'openUrl', text: url }]);
      }
    });
  }

  protected readDeps(next: GenUiProps): readonly unknown[] {
    return [next.node.props.links];
  }

  protected paint(next: GenUiProps): void {
    this.ctx = next.ctx;
    this.urls.length = 0;
    const rows: HTMLElement[] = [];
    for (const link of asList(next.node.props.links)) {
      const fields = isPlainObject(link) ? link : { url: link };
      const url = asString(fields.url);
      if (url === '') continue;
      const title = asString(fields.title);
      const cells: ElChild[] = [
        el('span', { class: `${BLOCK}__source-title`, text: title === '' ? url : title }),
      ];
      const note = asString(fields.note);
      if (note !== '') cells.push(el('span', { class: `${BLOCK}__source-note`, text: note }));
      rows.push(el('button', {
        class: `${BLOCK}__source`,
        title: url,
        data: { 'genui-row': String(this.urls.push(url) - 1) },
        attrs: { type: 'button', [FOCUSABLE_ATTR]: true },
        children: cells,
      }));
    }
    this.root.replaceChildren(...rows);
  }
}

/** The `data-genui-row` of the clicked row, or `-1` when the click missed one. */
function rowIndex(event: Event, rowClass: string): number {
  const target = event.target;
  if (!(target instanceof Element)) return -1;
  const row = target.closest(`.${rowClass}`);
  if (row === null) return -1;
  const index = Number(row.getAttribute('data-genui-row'));
  return Number.isInteger(index) ? index : -1;
}

export const CONTENT_RENDERERS: Readonly<Record<string, GenUiFactory>> = {
  Text: (host) => new TextComponent(host),
  Callout: (host) => new CalloutComponent(host),
  Metric: (host) => new MetricComponent(host),
  Badge: (host) => new BadgeComponent(host),
  KeyValue: (host) => new KeyValueComponent(host),
  List: (host) => new ListComponent(host),
  Sources: (host) => new SourcesComponent(host),
};
