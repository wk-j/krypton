// Spec 309 §Catalog — the Inputs group (12 components).
//
// Every control here is a view over ONE declared input. The value lives in
// `ctx.state`, never in the component: a change calls `ctx.setInput`, the panel
// re-evaluates the whole spec and calls `update()` with fresh props. That is
// why `readDeps()` carries the current state value — the binding name alone is
// constant, so a component keyed on it would never repaint after the first
// paint.
//
// Structure is built ONCE, in the constructor, and listeners are attached to it
// there. `paint()` only writes values, classes and attributes. A control that
// rebuilt its children on every paint would drop focus on the keystroke that
// caused the repaint, which is exactly what typing in a text field does.

import { el, setAttr } from '../../../ui/dom';
import type { UiAction, UiState, UiStateValue, Value } from '../../genui/types';
import { isAction, isBinding, isList, isPlainObject } from '../../genui/types';

import {
  asList,
  asNumber,
  asString,
  BLOCK,
  FOCUSABLE_ATTR,
  GenUiComponent,
  type GenUiFactory,
  type GenUiProps,
} from './renderer';

const FOCUSABLE = { [FOCUSABLE_ATTR]: true } as const;

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

/** One option of `Choice` / `Radio` / `Select` / `Checklist`. */
interface Option {
  readonly value: string | number;
  readonly label: string;
  readonly detail: string;
}

/** A bare scalar, or `{ value, label?, detail? }` as `Radio` documents. */
function readOptions(value: Value): Option[] {
  const out: Option[] = [];
  for (const item of asList(value)) {
    if (isPlainObject(item)) {
      const scalar = typeof item.value === 'number' ? item.value : asString(item.value);
      out.push({
        value: scalar,
        label: asString(item.label, String(scalar)),
        detail: asString(item.detail),
      });
      continue;
    }
    const scalar = typeof item === 'number' ? item : asString(item);
    out.push({ value: scalar, label: String(scalar), detail: '' });
  }
  return out;
}

/** Identity of an option set: the signature that decides whether to rebuild. */
function optionsKey(options: readonly Option[]): string {
  return options.map((o) => `${typeof o.value}\u0001${o.value}\u0001${o.label}\u0001${o.detail}`).join('\u0002');
}

/**
 * Index of `current` in `options`. The typed comparison runs first so `1` never
 * matches `"1"` when both are offered; the string pass catches a value that
 * came back from a loaded file or a `Set` action in the other representation.
 */
function indexOfOption(options: readonly Option[], current: UiStateValue): number {
  for (let i = 0; i < options.length; i += 1) {
    if (options[i].value === current) return i;
  }
  if (current === null || typeof current === 'object') return -1;
  for (let i = 0; i < options.length; i += 1) {
    if (String(options[i].value) === String(current)) return i;
  }
  return -1;
}

function readActions(value: Value): UiAction[] {
  if (isAction(value)) return [value];
  const out: UiAction[] = [];
  if (isList(value)) {
    for (const item of value) out.push(...readActions(item));
  }
  return out;
}

/**
 * Shared base: the bound name, the current value, the visible label and the
 * write path. `props` is refreshed by every `update()`, including one the deps
 * stop before `paint()`, so a listener attached in the constructor always sees
 * the live props without being a dependency itself.
 */
abstract class InputField extends GenUiComponent {
  protected props: GenUiProps | null = null;

  constructor(host: HTMLElement, modifier: string) {
    super(host);
    host.classList.add(`${BLOCK}__field`, `${BLOCK}__field--${modifier}`);
  }

  update(next: GenUiProps): void {
    this.props = next;
    super.update(next);
  }

  /** Name of the input this control writes; `''` when `value` is not a binding. */
  protected bindingName(next: GenUiProps): string {
    const bound = next.node.props.value;
    return isBinding(bound) ? bound.name : '';
  }

  protected stateValue(next: GenUiProps): UiStateValue {
    const name = this.bindingName(next);
    const state: UiState = next.ctx.state;
    if (name === '' || !Object.prototype.hasOwnProperty.call(state, name)) return null;
    return state[name];
  }

  /** The `label` prop, falling back to the binding name so no control is anonymous. */
  protected labelText(next: GenUiProps): string {
    const text = asString(next.node.props.label);
    return text === '' ? this.bindingName(next) : text;
  }

  protected write(value: UiStateValue): void {
    const next = this.props;
    if (next === null) return;
    const name = this.bindingName(next);
    if (name !== '') next.ctx.setInput(name, value);
  }
}

// ── Slider ──────────────────────────────────────────────────────────────────

class SliderComponent extends InputField {
  private readonly labelEl = el('span', { class: `${BLOCK}__label` });
  private readonly readout = el('span', { class: `${BLOCK}__value ${BLOCK}__readout` });
  private readonly range = el('input', { class: `${BLOCK}__range`, attrs: { type: 'range', ...FOCUSABLE } });

  constructor(host: HTMLElement) {
    super(host, 'slider');
    host.append(el('span', { class: `${BLOCK}__head` }, this.labelEl, this.readout), this.range);
    this.bag.listen(this.range, 'input', () => this.write(Number(this.range.value)));
  }

  protected readDeps(next: GenUiProps): readonly unknown[] {
    const p = next.node.props;
    return [
      this.bindingName(next),
      this.stateValue(next),
      asNumber(p.min, 0),
      asNumber(p.max, 100),
      asNumber(p.step, 1),
      this.labelText(next),
    ];
  }

  protected paint(next: GenUiProps): void {
    const p = next.node.props;
    const min = asNumber(p.min, 0);
    const max = asNumber(p.max, 100);
    const label = this.labelText(next);
    const current = clamp(asNumber(this.stateValue(next), min), min, max);
    this.labelEl.textContent = label;
    this.readout.textContent = String(current);
    setAttr(this.range, 'min', min);
    setAttr(this.range, 'max', max);
    setAttr(this.range, 'step', asNumber(p.step, 1));
    setAttr(this.range, 'aria-label', label);
    this.range.value = String(current);
  }
}

// ── Stepper ─────────────────────────────────────────────────────────────────

class StepperComponent extends InputField {
  private readonly labelEl = el('span', { class: `${BLOCK}__label` });
  private readonly minus = el('button', {
    class: `${BLOCK}__stepper-button`, text: '−', attrs: { type: 'button', ...FOCUSABLE },
  });
  private readonly plus = el('button', {
    class: `${BLOCK}__stepper-button`, text: '+', attrs: { type: 'button', ...FOCUSABLE },
  });
  private readonly readout = el('span', {
    class: `${BLOCK}__value ${BLOCK}__readout`,
    attrs: { role: 'spinbutton', tabindex: 0, ...FOCUSABLE },
  });

  constructor(host: HTMLElement) {
    super(host, 'stepper');
    const group = el('span', { class: `${BLOCK}__stepper` }, this.minus, this.readout, this.plus);
    host.append(this.labelEl, group);
    this.bag.listen(this.minus, 'click', () => this.step(-1));
    this.bag.listen(this.plus, 'click', () => this.step(1));
    this.bag.listen(group, 'keydown', (event: Event) => {
      if (!(event instanceof KeyboardEvent)) return;
      if (event.key !== 'ArrowUp' && event.key !== 'ArrowDown') return;
      event.preventDefault();
      this.step(event.key === 'ArrowUp' ? 1 : -1);
    });
  }

  private step(direction: number): void {
    const next = this.props;
    if (next === null) return;
    const p = next.node.props;
    const min = asNumber(p.min, Number.NEGATIVE_INFINITY);
    const max = asNumber(p.max, Number.POSITIVE_INFINITY);
    const size = asNumber(p.step, 1);
    const current = clamp(asNumber(this.stateValue(next), 0), min, max);
    const moved = clamp(current + direction * size, min, max);
    if (moved !== current) this.write(moved);
  }

  protected readDeps(next: GenUiProps): readonly unknown[] {
    const p = next.node.props;
    return [
      this.bindingName(next),
      this.stateValue(next),
      asNumber(p.min, Number.NEGATIVE_INFINITY),
      asNumber(p.max, Number.POSITIVE_INFINITY),
      asNumber(p.step, 1),
      this.labelText(next),
    ];
  }

  protected paint(next: GenUiProps): void {
    const p = next.node.props;
    const min = asNumber(p.min, Number.NEGATIVE_INFINITY);
    const max = asNumber(p.max, Number.POSITIVE_INFINITY);
    const label = this.labelText(next);
    const current = clamp(asNumber(this.stateValue(next), 0), min, max);
    this.labelEl.textContent = label;
    this.readout.textContent = String(current);
    setAttr(this.readout, 'aria-label', label);
    setAttr(this.readout, 'aria-valuenow', current);
    setAttr(this.readout, 'aria-valuemin', Number.isFinite(min) && min);
    setAttr(this.readout, 'aria-valuemax', Number.isFinite(max) && max);
    setAttr(this.minus, 'disabled', current <= min);
    setAttr(this.plus, 'disabled', current >= max);
    setAttr(this.minus, 'aria-label', `${label} minus`);
    setAttr(this.plus, 'aria-label', `${label} plus`);
  }
}

// ── Toggle ──────────────────────────────────────────────────────────────────

class ToggleComponent extends InputField {
  private readonly labelEl = el('span', { class: `${BLOCK}__label` });
  private readonly track = el('span', { class: `${BLOCK}__switch-track` }, el('span', { class: `${BLOCK}__switch-knob` }));
  private readonly button = el('button', {
    class: `${BLOCK}__switch`,
    attrs: { type: 'button', role: 'switch', ...FOCUSABLE },
  });

  constructor(host: HTMLElement) {
    super(host, 'toggle');
    this.button.append(this.track, this.labelEl);
    host.append(this.button);
    this.bag.listen(this.button, 'click', () => this.toggle());
    // Space and Enter are handled here rather than left to the UA's synthetic
    // click: `preventDefault` suppresses that click, so this fires exactly once.
    this.bag.listen(this.button, 'keydown', (event: Event) => {
      if (!(event instanceof KeyboardEvent)) return;
      if (event.key !== ' ' && event.key !== 'Enter' && event.key !== 'Spacebar') return;
      event.preventDefault();
      this.toggle();
    });
  }

  private toggle(): void {
    const next = this.props;
    if (next === null) return;
    this.write(this.stateValue(next) !== true);
  }

  protected readDeps(next: GenUiProps): readonly unknown[] {
    return [this.bindingName(next), this.stateValue(next), this.labelText(next)];
  }

  protected paint(next: GenUiProps): void {
    const on = this.stateValue(next) === true;
    this.labelEl.textContent = this.labelText(next);
    this.button.className = on ? `${BLOCK}__switch ${BLOCK}__switch--on` : `${BLOCK}__switch`;
    setAttr(this.button, 'aria-checked', String(on));
  }
}

// ── Choice ──────────────────────────────────────────────────────────────────

class ChoiceComponent extends InputField {
  private readonly labelEl = el('span', { class: `${BLOCK}__label` });
  private readonly group = el('span', { class: `${BLOCK}__segments`, attrs: { role: 'radiogroup' } });
  private buttons: HTMLButtonElement[] = [];
  private key = '\u0000';

  constructor(host: HTMLElement) {
    super(host, 'choice');
    host.append(this.labelEl, this.group);
    this.bag.listen(this.group, 'click', (event: Event) => {
      const index = segmentIndex(event);
      if (index >= 0) this.select(index, false);
    });
    this.bag.listen(this.group, 'keydown', (event: Event) => {
      if (!(event instanceof KeyboardEvent)) return;
      if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
      const next = this.props;
      if (next === null || this.buttons.length === 0) return;
      event.preventDefault();
      const options = readOptions(next.node.props.options);
      const at = indexOfOption(options, this.stateValue(next));
      const step = event.key === 'ArrowRight' ? 1 : -1;
      const from = at < 0 ? (step === 1 ? -1 : 0) : at;
      this.select((from + step + this.buttons.length) % this.buttons.length, true);
    });
  }

  private select(index: number, moveFocus: boolean): void {
    const next = this.props;
    if (next === null) return;
    const options = readOptions(next.node.props.options);
    const option = options[index];
    if (option === undefined) return;
    this.write(option.value);
    // The buttons survive the repaint (they are rebuilt only when the option
    // set changes), so focus can follow the selection straight away.
    if (moveFocus) this.buttons[index]?.focus();
  }

  protected readDeps(next: GenUiProps): readonly unknown[] {
    return [
      this.bindingName(next),
      this.stateValue(next),
      optionsKey(readOptions(next.node.props.options)),
      this.labelText(next),
    ];
  }

  protected paint(next: GenUiProps): void {
    const label = this.labelText(next);
    const options = readOptions(next.node.props.options);
    const key = optionsKey(options);
    this.labelEl.textContent = label;
    setAttr(this.group, 'aria-label', label);
    if (key !== this.key) {
      this.key = key;
      this.buttons = options.map((option, index) =>
        el('button', {
          class: `${BLOCK}__segment`,
          text: option.label,
          title: option.detail === '' ? undefined : option.detail,
          attrs: { type: 'button', role: 'radio', ...FOCUSABLE },
          data: { index },
        }),
      );
      this.group.replaceChildren(...this.buttons);
    }
    const active = indexOfOption(options, this.stateValue(next));
    this.buttons.forEach((button, index) => {
      const on = index === active;
      button.className = on ? `${BLOCK}__segment ${BLOCK}__segment--on` : `${BLOCK}__segment`;
      setAttr(button, 'aria-checked', String(on));
      setAttr(button, 'tabindex', on || (active < 0 && index === 0) ? 0 : -1);
    });
  }
}

/** Index carried by the `[data-index]` ancestor of an event's target, else -1. */
function segmentIndex(event: Event): number {
  if (!(event.target instanceof Element)) return -1;
  const node = event.target.closest<HTMLElement>('[data-index]');
  const raw = node?.dataset.index;
  return raw === undefined ? -1 : Number(raw);
}

// ── Radio ───────────────────────────────────────────────────────────────────

let radioGroupSeq = 0;

class RadioComponent extends InputField {
  private readonly labelEl = el('span', { class: `${BLOCK}__label` });
  private readonly group = el('span', { class: `${BLOCK}__radios`, attrs: { role: 'radiogroup' } });
  private readonly name = `acp-genui-radio-${(radioGroupSeq += 1)}`;
  private inputs: HTMLInputElement[] = [];
  private key = '\u0000';

  constructor(host: HTMLElement) {
    super(host, 'radio');
    host.append(this.labelEl, this.group);
    this.bag.listen(this.group, 'change', (event: Event) => {
      const next = this.props;
      if (next === null || !(event.target instanceof HTMLInputElement)) return;
      const option = readOptions(next.node.props.options)[Number(event.target.value)];
      if (option !== undefined) this.write(option.value);
    });
  }

  protected readDeps(next: GenUiProps): readonly unknown[] {
    return [
      this.bindingName(next),
      this.stateValue(next),
      optionsKey(readOptions(next.node.props.options)),
      this.labelText(next),
    ];
  }

  protected paint(next: GenUiProps): void {
    const label = this.labelText(next);
    const options = readOptions(next.node.props.options);
    const key = optionsKey(options);
    this.labelEl.textContent = label;
    setAttr(this.group, 'aria-label', label);
    if (key !== this.key) {
      this.key = key;
      this.inputs = options.map((option, index) =>
        el('input', {
          class: `${BLOCK}__radio-input`,
          attrs: { type: 'radio', name: this.name, value: index, ...FOCUSABLE },
        }),
      );
      this.group.replaceChildren(
        ...options.map((option, index) =>
          el(
            'label',
            { class: `${BLOCK}__radio` },
            this.inputs[index],
            el('span', { class: `${BLOCK}__radio-label`, text: option.label }),
            option.detail === '' ? null : el('span', { class: `${BLOCK}__option-detail`, text: option.detail }),
          ),
        ),
      );
    }
    const active = indexOfOption(options, this.stateValue(next));
    this.inputs.forEach((input, index) => {
      input.checked = index === active;
    });
  }
}

// ── Select ──────────────────────────────────────────────────────────────────

class SelectComponent extends InputField {
  private readonly labelEl = el('span', { class: `${BLOCK}__label` });
  private readonly select = el('select', { class: `${BLOCK}__select`, attrs: { ...FOCUSABLE } });
  private key = '\u0000';

  constructor(host: HTMLElement) {
    super(host, 'select');
    host.append(this.labelEl, this.select);
    this.bag.listen(this.select, 'change', () => {
      const next = this.props;
      if (next === null) return;
      const option = readOptions(next.node.props.options)[Number(this.select.value)];
      if (option !== undefined) this.write(option.value);
    });
  }

  protected readDeps(next: GenUiProps): readonly unknown[] {
    return [
      this.bindingName(next),
      this.stateValue(next),
      optionsKey(readOptions(next.node.props.options)),
      this.labelText(next),
    ];
  }

  protected paint(next: GenUiProps): void {
    const label = this.labelText(next);
    const options = readOptions(next.node.props.options);
    const key = optionsKey(options);
    this.labelEl.textContent = label;
    setAttr(this.select, 'aria-label', label);
    if (key !== this.key) {
      this.key = key;
      this.select.replaceChildren(
        ...options.map((option, index) =>
          el('option', { text: option.label, attrs: { value: index }, title: option.detail === '' ? undefined : option.detail }),
        ),
      );
    }
    const active = indexOfOption(options, this.stateValue(next));
    this.select.value = active < 0 ? '' : String(active);
  }
}

// ── Checklist ───────────────────────────────────────────────────────────────

class ChecklistComponent extends InputField {
  private readonly labelEl = el('span', { class: `${BLOCK}__label` });
  private readonly group = el('span', { class: `${BLOCK}__checks`, attrs: { role: 'group' } });
  private boxes: HTMLInputElement[] = [];
  private key = '\u0000';

  constructor(host: HTMLElement) {
    super(host, 'checklist');
    host.append(this.labelEl, this.group);
    this.bag.listen(this.group, 'change', () => this.commit());
  }

  /** Write the whole list, in option order — not in the order they were ticked. */
  private commit(): void {
    const next = this.props;
    if (next === null) return;
    const options = readOptions(next.node.props.options);
    const picked: (string | number)[] = [];
    options.forEach((option, index) => {
      if (this.boxes[index]?.checked === true) picked.push(option.value);
    });
    this.write(picked);
  }

  protected readDeps(next: GenUiProps): readonly unknown[] {
    const current = this.stateValue(next);
    return [
      this.bindingName(next),
      Array.isArray(current) ? current.join('\u0001') : String(current),
      optionsKey(readOptions(next.node.props.options)),
      this.labelText(next),
    ];
  }

  protected paint(next: GenUiProps): void {
    const label = this.labelText(next);
    const options = readOptions(next.node.props.options);
    const key = optionsKey(options);
    this.labelEl.textContent = label;
    setAttr(this.group, 'aria-label', label);
    if (key !== this.key) {
      this.key = key;
      this.boxes = options.map((option, index) =>
        el('input', {
          class: `${BLOCK}__check-input`,
          attrs: { type: 'checkbox', value: index, ...FOCUSABLE },
        }),
      );
      this.group.replaceChildren(
        ...options.map((option, index) =>
          el(
            'label',
            { class: `${BLOCK}__check` },
            this.boxes[index],
            el('span', { class: `${BLOCK}__check-label`, text: option.label }),
          ),
        ),
      );
    }
    const current = this.stateValue(next);
    const selected: readonly UiStateValue[] = Array.isArray(current) ? current : [];
    this.boxes.forEach((box, index) => {
      const option = options[index];
      box.checked = selected.some(
        (value) => value === option.value || (typeof value !== 'object' && String(value) === String(option.value)),
      );
    });
  }
}

// ── Input / TextArea ────────────────────────────────────────────────────────

class TextFieldComponent extends InputField {
  private readonly labelEl = el('span', { class: `${BLOCK}__label` });
  private readonly field: HTMLInputElement | HTMLTextAreaElement;

  constructor(host: HTMLElement, multiline: boolean) {
    super(host, multiline ? 'textarea' : 'input');
    this.field = multiline
      ? el('textarea', { class: `${BLOCK}__textarea`, attrs: { rows: 3, ...FOCUSABLE } })
      : el('input', { class: `${BLOCK}__text`, attrs: { type: 'text', ...FOCUSABLE } });
    host.append(this.labelEl, this.field);
    // No keydown handler at all: a printable key must reach the field, and the
    // panel's own key swallowing stops at a focusable control.
    this.bag.listen(this.field, 'input', () => this.write(this.field.value));
  }

  protected readDeps(next: GenUiProps): readonly unknown[] {
    return [
      this.bindingName(next),
      this.stateValue(next),
      this.labelText(next),
      asString(next.node.props.placeholder),
    ];
  }

  protected paint(next: GenUiProps): void {
    const label = this.labelText(next);
    const text = asString(this.stateValue(next));
    this.labelEl.textContent = label;
    setAttr(this.field, 'aria-label', label);
    setAttr(this.field, 'placeholder', asString(next.node.props.placeholder));
    // Writing an identical value would still move the caret to the end in some
    // engines, so the assignment is guarded.
    if (this.field.value !== text) this.field.value = text;
  }
}

// ── Rating ──────────────────────────────────────────────────────────────────

const RATING_DEFAULT_MAX = 5;

class RatingComponent extends InputField {
  private readonly labelEl = el('span', { class: `${BLOCK}__label` });
  private readonly stars = el('span', {
    class: `${BLOCK}__stars`,
    attrs: { role: 'slider', tabindex: 0, 'aria-valuemin': 0, ...FOCUSABLE },
  });
  private cells: HTMLElement[] = [];

  constructor(host: HTMLElement) {
    super(host, 'rating');
    host.append(this.labelEl, this.stars);
    this.bag.listen(this.stars, 'click', (event: Event) => {
      const index = segmentIndex(event);
      if (index >= 0) this.write(index + 1);
    });
    this.bag.listen(this.stars, 'keydown', (event: Event) => {
      if (!(event instanceof KeyboardEvent)) return;
      const next = this.props;
      if (next === null) return;
      const max = Math.max(1, Math.round(asNumber(next.node.props.max, RATING_DEFAULT_MAX)));
      const current = clamp(Math.round(asNumber(this.stateValue(next), 0)), 0, max);
      const moved = ratingKey(event.key, current, max);
      if (moved === null) return;
      event.preventDefault();
      if (moved !== current) this.write(moved);
    });
  }

  protected readDeps(next: GenUiProps): readonly unknown[] {
    return [
      this.bindingName(next),
      this.stateValue(next),
      Math.max(1, Math.round(asNumber(next.node.props.max, RATING_DEFAULT_MAX))),
      this.labelText(next),
    ];
  }

  protected paint(next: GenUiProps): void {
    const label = this.labelText(next);
    const max = Math.max(1, Math.round(asNumber(next.node.props.max, RATING_DEFAULT_MAX)));
    const current = clamp(Math.round(asNumber(this.stateValue(next), 0)), 0, max);
    this.labelEl.textContent = label;
    setAttr(this.stars, 'aria-label', label);
    setAttr(this.stars, 'aria-valuemax', max);
    setAttr(this.stars, 'aria-valuenow', current);
    setAttr(this.stars, 'aria-valuetext', current === 0 ? 'unrated' : `${current} of ${max}`);
    if (this.cells.length !== max) {
      this.cells = Array.from({ length: max }, (_unused, index) =>
        el('span', { class: `${BLOCK}__star`, text: '★', data: { index } }),
      );
      this.stars.replaceChildren(...this.cells);
    }
    this.cells.forEach((cell, index) => {
      cell.className = index < current ? `${BLOCK}__star ${BLOCK}__star--on` : `${BLOCK}__star`;
    });
  }
}

/** The rating a key implies, or `null` when the key is not ours to swallow. */
function ratingKey(key: string, current: number, max: number): number | null {
  if (key === 'ArrowRight' || key === 'ArrowUp') return Math.min(current + 1, max);
  if (key === 'ArrowLeft' || key === 'ArrowDown') return Math.max(current - 1, 0);
  if (key === 'Home') return 0;
  if (key === 'End') return max;
  return null;
}

// ── EditableTable ───────────────────────────────────────────────────────────

type ColumnType = 'text' | 'number' | 'boolean';

interface Column {
  readonly key: string;
  readonly label: string;
  readonly type: ColumnType;
}

const COLUMN_TYPES: Readonly<Record<string, true>> = { text: true, number: true, boolean: true };

/** `"name"` or `{ key, label?, type? }`. */
function readColumns(value: Value): Column[] {
  const out: Column[] = [];
  for (const item of asList(value)) {
    if (isPlainObject(item)) {
      const key = asString(item.key);
      if (key === '') continue;
      const type = asString(item.type);
      out.push({
        key,
        label: asString(item.label, key),
        type: Object.prototype.hasOwnProperty.call(COLUMN_TYPES, type) ? (type as ColumnType) : 'text',
      });
      continue;
    }
    const key = asString(item);
    if (key !== '') out.push({ key, label: key, type: 'text' });
  }
  return out;
}

class EditableTableComponent extends InputField {
  private readonly labelEl = el('span', { class: `${BLOCK}__label` });
  private readonly head = el('tr');
  private readonly body = el('tbody', { class: `${BLOCK}__grid-body` });
  private readonly add = el('button', {
    class: `${BLOCK}__grid-add`,
    text: '+ Row',
    attrs: { type: 'button', ...FOCUSABLE },
  });
  private cells: HTMLInputElement[][] = [];
  private key = '\u0000';

  constructor(host: HTMLElement) {
    super(host, 'table');
    const table = el('table', { class: `${BLOCK}__grid` }, el('thead', {}, this.head), this.body);
    host.append(this.labelEl, table, this.add);
    this.bag.listen(this.body, 'input', (event: Event) => this.edit(event));
    this.bag.listen(this.body, 'change', (event: Event) => this.edit(event));
    this.bag.listen(this.body, 'click', (event: Event) => {
      if (!(event.target instanceof Element)) return;
      const button = event.target.closest<HTMLElement>(`.${BLOCK}__grid-remove`);
      if (button === null) return;
      const row = Number(button.dataset.row);
      const rows = this.rows();
      if (!Number.isInteger(row) || row < 0 || row >= rows.length) return;
      this.write(rows.filter((_unused, index) => index !== row));
    });
    this.bag.listen(this.add, 'click', () => {
      const next = this.props;
      if (next === null) return;
      const blank: Record<string, UiStateValue> = {};
      for (const column of readColumns(next.node.props.columns)) {
        blank[column.key] = column.type === 'number' ? 0 : column.type === 'boolean' ? false : '';
      }
      this.write([...this.rows(), blank]);
    });
  }

  /** The bound list as plain row records. */
  private rows(): Record<string, UiStateValue>[] {
    const next = this.props;
    if (next === null) return [];
    const current = this.stateValue(next);
    if (!Array.isArray(current)) return [];
    const list: readonly UiStateValue[] = current;
    return list.map((row) => {
      const out: Record<string, UiStateValue> = {};
      if (row !== null && typeof row === 'object' && !Array.isArray(row)) {
        for (const [key, value] of Object.entries(row)) out[key] = value;
      }
      return out;
    });
  }

  /** Every edit writes the WHOLE list back; the panel owns the value, not the grid. */
  private edit(event: Event): void {
    const next = this.props;
    if (next === null || !(event.target instanceof HTMLInputElement)) return;
    const field = event.target;
    const rowIndex = Number(field.dataset.row);
    const key = field.dataset.key;
    if (key === undefined || !Number.isInteger(rowIndex)) return;
    const columns = readColumns(next.node.props.columns);
    const column = columns.find((entry) => entry.key === key);
    if (column === undefined) return;
    // A checkbox reports through `change` and a text field through `input`;
    // letting both run would write the checkbox twice, so each takes one.
    if ((column.type === 'boolean') !== (event.type === 'change')) return;
    const rows = this.rows();
    const row = rows[rowIndex];
    if (row === undefined) return;
    rows[rowIndex] = { ...row, [key]: readCell(column.type, field) };
    this.write(rows);
  }

  protected readDeps(next: GenUiProps): readonly unknown[] {
    return [
      this.bindingName(next),
      JSON.stringify(this.stateValue(next)),
      JSON.stringify(readColumns(next.node.props.columns)),
      this.labelText(next),
    ];
  }

  protected paint(next: GenUiProps): void {
    const label = this.labelText(next);
    const columns = readColumns(next.node.props.columns);
    const rows = this.rows();
    const key = `${JSON.stringify(columns)}\u0002${rows.length}`;
    this.labelEl.textContent = label;
    setAttr(this.add, 'aria-label', `${label}: add row`);
    if (key !== this.key) {
      this.key = key;
      this.head.replaceChildren(
        ...columns.map((column) => el('th', { text: column.label, attrs: { scope: 'col' } })),
        el('th', { attrs: { scope: 'col', 'aria-label': 'remove' } }),
      );
      this.cells = rows.map((_unused, rowIndex) =>
        columns.map((column) =>
          el('input', {
            class: `${BLOCK}__cell`,
            attrs: {
              type: column.type === 'boolean' ? 'checkbox' : column.type === 'number' ? 'number' : 'text',
              'aria-label': `${column.label} ${rowIndex + 1}`,
              ...FOCUSABLE,
            },
            data: { row: rowIndex, key: column.key },
          }),
        ),
      );
      this.body.replaceChildren(
        ...rows.map((_unused, rowIndex) =>
          el(
            'tr',
            { class: `${BLOCK}__grid-row` },
            ...columns.map((_column, columnIndex) => el('td', {}, this.cells[rowIndex][columnIndex])),
            el(
              'td',
              {},
              el('button', {
                class: `${BLOCK}__grid-remove`,
                text: '×',
                attrs: { type: 'button', 'aria-label': `remove row ${rowIndex + 1}`, ...FOCUSABLE },
                data: { row: rowIndex },
              }),
            ),
          ),
        ),
      );
    }
    rows.forEach((row, rowIndex) => {
      columns.forEach((column, columnIndex) => {
        const field = this.cells[rowIndex][columnIndex];
        const value = row[column.key];
        if (column.type === 'boolean') {
          field.checked = value === true;
          return;
        }
        const text = value === null || value === undefined || typeof value === 'object' ? '' : String(value);
        if (field.value !== text) field.value = text;
      });
    });
  }
}

function readCell(type: ColumnType, field: HTMLInputElement): UiStateValue {
  if (type === 'boolean') return field.checked;
  if (type !== 'number') return field.value;
  const parsed = Number(field.value);
  return field.value.trim() === '' || !Number.isFinite(parsed) ? 0 : parsed;
}

// ── Button ──────────────────────────────────────────────────────────────────

const VARIANTS: Readonly<Record<string, true>> = { primary: true, secondary: true, destructive: true };

class ButtonComponent extends InputField {
  private readonly button = el('button', { class: `${BLOCK}__button`, attrs: { type: 'button', ...FOCUSABLE } });

  constructor(host: HTMLElement) {
    super(host, 'button');
    host.append(this.button);
    this.bag.listen(this.button, 'click', () => {
      const next = this.props;
      if (next === null) return;
      const actions = readActions(next.node.props.action);
      // No action: the button drafts its own label, which is the only way a
      // control can reach the composer without the spec naming an action.
      next.ctx.run(
        actions.length > 0
          ? actions
          : [{ kind: 'action', type: 'draft', text: asString(next.node.props.label) }],
      );
    });
  }

  protected readDeps(next: GenUiProps): readonly unknown[] {
    return [asString(next.node.props.label), asString(next.node.props.variant)];
  }

  protected paint(next: GenUiProps): void {
    const variant = asString(next.node.props.variant);
    const known = Object.prototype.hasOwnProperty.call(VARIANTS, variant);
    this.button.textContent = asString(next.node.props.label);
    this.button.className = known ? `${BLOCK}__button ${BLOCK}__button--${variant}` : `${BLOCK}__button`;
  }
}

export const INPUT_RENDERERS: Record<string, GenUiFactory> = {
  Slider: (host) => new SliderComponent(host),
  Stepper: (host) => new StepperComponent(host),
  Toggle: (host) => new ToggleComponent(host),
  Choice: (host) => new ChoiceComponent(host),
  Radio: (host) => new RadioComponent(host),
  Select: (host) => new SelectComponent(host),
  Checklist: (host) => new ChecklistComponent(host),
  Input: (host) => new TextFieldComponent(host, false),
  TextArea: (host) => new TextFieldComponent(host, true),
  Rating: (host) => new RatingComponent(host),
  EditableTable: (host) => new EditableTableComponent(host),
  Button: (host) => new ButtonComponent(host),
};
