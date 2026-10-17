// Spec 309 — Form group renderers (Form · FollowUps).
//
// `Form` is the only component that reads its siblings: submitting turns every
// input descendant into one `label: value` line and drafts the result as a
// single message, so a twelve-field spec costs the composer one draft instead
// of twelve. The field walk is driven by the catalog — a descendant counts as
// an input exactly when its `ComponentSpec` declares a `binding` param — so a
// component added to `catalog.ts` is picked up here without a second list.
//
// Submitting is terminal for the panel's lifetime of that node: the fieldset
// goes read-only and the button reads `Drafted`, both held in `ctx.view` so a
// re-evaluation (or reopening the panel) cannot resurrect the form and draft
// the same message twice.

import { el } from '../../../ui/dom';
import { COMPONENT_BY_NAME, tableHas } from '../../genui/catalog';
import type { UiNode, UiState, UiStateValue } from '../../genui/types';
import { isBinding } from '../../genui/types';
import {
  BLOCK,
  FOCUSABLE_ATTR,
  GenUiComponent,
  asList,
  asNodes,
  asString,
  renderChildren,
} from './renderer';
import type { GenUiContext, GenUiFactory, GenUiProps } from './renderer';

const EMPTY = '—';
const DEFAULT_SUBMIT = 'Submit';
const SUBMITTED = 'Drafted';

interface Field {
  readonly label: string;
  readonly text: string;
}

/** Flatten one state value into the text a draft line carries. */
function valueText(value: UiStateValue): string {
  if (value === null) return '';
  if (typeof value === 'boolean') return value ? 'Yes' : 'No';
  if (typeof value === 'number') return String(value);
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) {
    const parts: string[] = [];
    for (const item of value as readonly UiStateValue[]) {
      const text = valueText(item);
      if (text !== '') parts.push(text);
    }
    return parts.join(', ');
  }
  const pairs: string[] = [];
  for (const [key, item] of Object.entries(value as { readonly [key: string]: UiStateValue })) {
    pairs.push(`${key}=${valueText(item)}`);
  }
  return pairs.join(' ');
}

/**
 * Every input descendant, in document order. A node is an input when its
 * catalog entry declares a `binding` param and the spec wrote `$name` there.
 */
function collectFields(nodes: readonly UiNode[], state: UiState, out: Field[]): void {
  for (const node of nodes) {
    const spec = tableHas(COMPONENT_BY_NAME, node.component) ? COMPONENT_BY_NAME[node.component] : undefined;
    const param = spec?.params.find((candidate) => candidate.kind === 'binding');
    const binding = param === undefined ? null : node.props[param.name];
    if (isBinding(binding)) {
      const label = asString(node.props.label);
      const value = Object.prototype.hasOwnProperty.call(state, binding.name) ? state[binding.name] : null;
      // An unrated Rating is 0, which `valueText` would render as a score.
      const unrated = node.component === 'Rating' && value === 0;
      const text = unrated ? '' : valueText(value);
      out.push({ label: label === '' ? binding.name : label, text: text.trim() === '' ? EMPTY : text });
    }
    collectFields(asNodes(node.props.children), state, out);
  }
}

class FormComponent extends GenUiComponent {
  private readonly fields = el('fieldset', { class: `${BLOCK}__form-fields` });
  private readonly submit = el('button', {
    class: `${BLOCK}__form-submit`,
    attrs: { type: 'button', [FOCUSABLE_ATTR]: true },
  });

  private readonly root: HTMLElement;
  private current: GenUiProps | null = null;

  constructor(host: HTMLElement) {
    super(host);
    this.root = el('div', {
      class: `${BLOCK}__form`,
      children: [this.fields, el('div', { class: `${BLOCK}__form-foot`, children: [this.submit] })],
    });
    host.appendChild(this.root);
    this.bag.listen(this.submit, 'click', () => this.draft());
  }

  protected readDeps(next: GenUiProps): readonly unknown[] {
    return [next.node.props.children, next.node.props.submit, next.ctx.view(next.node.key).submitted === true];
  }

  protected paint(next: GenUiProps): void {
    this.current = next;
    const done = next.ctx.view(next.node.key).submitted === true;
    const label = asString(next.node.props.submit);
    this.submit.textContent = done ? SUBMITTED : (label === '' ? DEFAULT_SUBMIT : label);
    this.submit.disabled = done;
    this.fields.disabled = done;
    renderChildren(this.fields, asNodes(next.node.props.children), next.ctx);
  }

  private draft(): void {
    const props = this.current;
    if (props === null) return;
    const view = props.ctx.view(props.node.key);
    if (view.submitted === true) return;

    const fields: Field[] = [];
    collectFields(asNodes(props.node.props.children), props.ctx.state, fields);
    const lines = fields.map((field) => `${field.label}: ${field.text}`);
    const label = asString(props.node.props.submit);
    const text = lines.length === 0 ? (label === '' ? DEFAULT_SUBMIT : label) : lines.join('\n');

    view.submitted = true;
    props.ctx.run([{ kind: 'action', type: 'draft', text }]);
    props.ctx.repaint();
  }
}

class FollowUpsComponent extends GenUiComponent {
  private readonly root: HTMLElement;
  private readonly prompts: string[] = [];
  private ctx: GenUiContext | null = null;

  constructor(host: HTMLElement) {
    super(host);
    this.root = el('div', { class: `${BLOCK}__followups` });
    host.appendChild(this.root);
    // One delegated listener: the buttons are rebuilt whenever `prompts` moves.
    this.bag.listen(this.root, 'click', (event) => {
      const target = event.target;
      if (!(target instanceof Element)) return;
      const button = target.closest(`.${BLOCK}__followup`);
      if (button === null) return;
      const index = Number(button.getAttribute('data-genui-row'));
      const prompt = Number.isInteger(index) ? this.prompts[index] : undefined;
      if (prompt !== undefined && this.ctx !== null) {
        this.ctx.run([{ kind: 'action', type: 'draft', text: prompt }]);
      }
    });
  }

  protected readDeps(next: GenUiProps): readonly unknown[] {
    return [next.node.props.prompts];
  }

  protected paint(next: GenUiProps): void {
    this.ctx = next.ctx;
    this.prompts.length = 0;
    const buttons: HTMLElement[] = [];
    for (const entry of asList(next.node.props.prompts)) {
      const prompt = asString(entry);
      if (prompt === '') continue;
      buttons.push(el('button', {
        class: `${BLOCK}__followup`,
        data: { 'genui-row': String(this.prompts.push(prompt) - 1) },
        attrs: { type: 'button', [FOCUSABLE_ATTR]: true },
        text: prompt,
      }));
    }
    this.root.replaceChildren(...buttons);
  }
}

export const FORM_RENDERERS: Readonly<Record<string, GenUiFactory>> = {
  Form: (host) => new FormComponent(host),
  FollowUps: (host) => new FollowUpsComponent(host),
};
