import { describe, expect, it } from 'vitest';

import type { UiAction, UiNode, UiState, UiStateValue, Value } from '../../genui/types';

import { INPUT_RENDERERS } from './inputs';
import { FOCUSABLE_ATTR, type GenUiComponent, type GenUiContext } from './renderer';

interface Write {
  readonly name: string;
  readonly value: UiStateValue;
}

interface Harness {
  readonly host: HTMLElement;
  readonly cmp: GenUiComponent;
  readonly writes: Write[];
  readonly runs: UiAction[];
  /** Re-render with new props and/or a new state value, as the panel does. */
  update(props?: Record<string, Value>, state?: UiState): void;
}

const bind = (name: string): Value => ({ kind: 'binding', name });

function mount(component: string, props: Record<string, Value>, state: UiState = {}): Harness {
  const writes: Write[] = [];
  const runs: UiAction[] = [];
  const live: UiState = { ...state };
  const views = new Map<string, Record<string, unknown>>();
  const ctx: GenUiContext = {
    run: (actions) => {
      runs.push(...actions);
    },
    setInput: (name, value) => {
      writes.push({ name, value });
    },
    state: live,
    view: (key) => {
      const existing = views.get(key);
      if (existing !== undefined) return existing;
      const fresh: Record<string, unknown> = {};
      views.set(key, fresh);
      return fresh;
    },
    repaint: () => undefined,
  };

  const host = document.createElement('div');
  document.body.append(host);
  const node = (current: Record<string, Value>): UiNode => ({ kind: 'node', component, props: current, key: 'r0' });
  const cmp = INPUT_RENDERERS[component](host);
  cmp.update({ node: node(props), ctx });

  let current = props;
  return {
    host,
    cmp,
    writes,
    runs,
    update: (nextProps?: Record<string, Value>, nextState?: UiState) => {
      if (nextState !== undefined) {
        for (const key of Object.keys(live)) delete live[key];
        Object.assign(live, nextState);
      }
      current = nextProps ?? current;
      cmp.update({ node: node(current), ctx });
    },
  };
}

function find<T extends HTMLElement>(host: HTMLElement, selector: string): T {
  const node = host.querySelector<T>(selector);
  if (node === null) throw new Error(`no ${selector} in ${host.innerHTML}`);
  return node;
}

function all<T extends HTMLElement>(host: HTMLElement, selector: string): T[] {
  return [...host.querySelectorAll<T>(selector)];
}

function press(target: HTMLElement, key: string): KeyboardEvent {
  const event = new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true });
  target.dispatchEvent(event);
  return event;
}

function fire(target: HTMLElement, type: 'input' | 'change' | 'click'): void {
  target.dispatchEvent(new Event(type, { bubbles: true, cancelable: true }));
}

describe('Inputs — the group contract', () => {
  it('exposes one renderer per catalog entry', () => {
    expect(Object.keys(INPUT_RENDERERS).sort()).toEqual([
      'Button', 'Checklist', 'Choice', 'EditableTable', 'Input', 'Radio',
      'Rating', 'Select', 'Slider', 'Stepper', 'TextArea', 'Toggle',
    ]);
  });

  it('marks at least one focusable per control', () => {
    const props: Record<string, Record<string, Value>> = {
      Slider: { value: bind('n'), min: 0, max: 10 },
      Stepper: { value: bind('n') },
      Toggle: { value: bind('b'), label: 'On' },
      Choice: { value: bind('s'), options: ['a', 'b'] },
      Radio: { value: bind('s'), options: ['a', 'b'] },
      Select: { value: bind('s'), options: ['a', 'b'] },
      Checklist: { value: bind('l'), options: ['a', 'b'] },
      Input: { value: bind('t') },
      TextArea: { value: bind('t') },
      Rating: { value: bind('n') },
      EditableTable: { value: bind('l'), columns: ['name'] },
      Button: { label: 'Go' },
    };
    for (const [name, nodeProps] of Object.entries(props)) {
      const ui = mount(name, nodeProps, { n: 1, b: false, s: 'a', l: [], t: '' });
      expect(all(ui.host, `[${FOCUSABLE_ATTR}]`).length, name).toBeGreaterThan(0);
    }
  });
});

describe('Slider', () => {
  const props = { value: bind('seats'), min: 1, max: 50, step: 1, label: 'Seats' };

  it('renders the bound value with a live readout', () => {
    const ui = mount('Slider', props, { seats: 10 });
    const range = find<HTMLInputElement>(ui.host, 'input[type="range"]');
    expect(find(ui.host, '.acp-genui__label').textContent).toBe('Seats');
    expect(find(ui.host, '.acp-genui__readout').textContent).toBe('10');
    expect(range.getAttribute('min')).toBe('1');
    expect(range.getAttribute('max')).toBe('50');
    expect(range.value).toBe('10');
  });

  it('falls back to the binding name for its label', () => {
    const ui = mount('Slider', { value: bind('seats'), min: 1, max: 50 }, { seats: 4 });
    expect(find(ui.host, '.acp-genui__label').textContent).toBe('seats');
  });

  it('writes the number the range reports', () => {
    const ui = mount('Slider', props, { seats: 10 });
    const range = find<HTMLInputElement>(ui.host, 'input[type="range"]');
    range.value = '22';
    fire(range, 'input');
    expect(ui.writes).toEqual([{ name: 'seats', value: 22 }]);
  });

  it('repaints from a new state value', () => {
    const ui = mount('Slider', props, { seats: 10 });
    ui.update(undefined, { seats: 31 });
    expect(find<HTMLInputElement>(ui.host, 'input[type="range"]').value).toBe('31');
    expect(find(ui.host, '.acp-genui__readout').textContent).toBe('31');
  });
});

describe('Stepper', () => {
  const props = { value: bind('n'), min: 0, max: 3, label: 'Count' };
  const steppers = (host: HTMLElement): HTMLButtonElement[] =>
    all<HTMLButtonElement>(host, '.acp-genui__stepper-button');

  it('steps down and up by one', () => {
    const ui = mount('Stepper', props, { n: 2 });
    const [minus, plus] = steppers(ui.host);
    fire(minus, 'click');
    fire(plus, 'click');
    expect(ui.writes).toEqual([{ name: 'n', value: 1 }, { name: 'n', value: 3 }]);
  });

  it('honours an explicit step', () => {
    const ui = mount('Stepper', { value: bind('n'), min: 0, max: 100, step: 5 }, { n: 10 });
    fire(steppers(ui.host)[1], 'click');
    expect(ui.writes).toEqual([{ name: 'n', value: 15 }]);
  });

  it('clamps at both bounds and writes nothing there', () => {
    const atMax = mount('Stepper', props, { n: 3 });
    fire(steppers(atMax.host)[1], 'click');
    expect(atMax.writes).toEqual([]);
    const atMin = mount('Stepper', props, { n: 0 });
    fire(steppers(atMin.host)[0], 'click');
    expect(atMin.writes).toEqual([]);
  });

  it('steps with ArrowUp and ArrowDown', () => {
    const ui = mount('Stepper', props, { n: 1 });
    const readout = find(ui.host, '.acp-genui__readout');
    expect(press(readout, 'ArrowUp').defaultPrevented).toBe(true);
    press(readout, 'ArrowDown');
    expect(ui.writes).toEqual([{ name: 'n', value: 2 }, { name: 'n', value: 0 }]);
  });

  it('repaints the readout from a new state value', () => {
    const ui = mount('Stepper', props, { n: 1 });
    ui.update(undefined, { n: 3 });
    const readout = find(ui.host, '.acp-genui__readout');
    expect(readout.textContent).toBe('3');
    expect(readout.getAttribute('aria-valuenow')).toBe('3');
    expect(steppers(ui.host)[1].hasAttribute('disabled')).toBe(true);
  });
});

describe('Toggle', () => {
  const props = { value: bind('on'), label: 'Verbose' };

  it('renders a switch carrying its state', () => {
    const ui = mount('Toggle', props, { on: false });
    const button = find(ui.host, '.acp-genui__switch');
    expect(button.getAttribute('role')).toBe('switch');
    expect(button.getAttribute('aria-checked')).toBe('false');
    expect(find(ui.host, '.acp-genui__label').textContent).toBe('Verbose');
  });

  it('flips on click', () => {
    const ui = mount('Toggle', props, { on: false });
    fire(find(ui.host, '.acp-genui__switch'), 'click');
    expect(ui.writes).toEqual([{ name: 'on', value: true }]);
  });

  it('flips on Space and Enter, swallowing the key', () => {
    const ui = mount('Toggle', props, { on: true });
    const button = find(ui.host, '.acp-genui__switch');
    expect(press(button, ' ').defaultPrevented).toBe(true);
    expect(press(button, 'Enter').defaultPrevented).toBe(true);
    expect(ui.writes).toEqual([{ name: 'on', value: false }, { name: 'on', value: false }]);
  });

  it('repaints from a new state value', () => {
    const ui = mount('Toggle', props, { on: false });
    ui.update(undefined, { on: true });
    const button = find(ui.host, '.acp-genui__switch');
    expect(button.getAttribute('aria-checked')).toBe('true');
    expect(button.className).toContain('acp-genui__switch--on');
  });
});

describe('Choice', () => {
  const props = { value: bind('plan'), options: ['Basic', 'Pro', 'Max'], label: 'Plan' };
  const segments = (host: HTMLElement): HTMLButtonElement[] => all<HTMLButtonElement>(host, '.acp-genui__segment');

  it('renders one segment per option with the selected one marked', () => {
    const ui = mount('Choice', props, { plan: 'Pro' });
    const buttons = segments(ui.host);
    expect(buttons.map((b) => b.textContent)).toEqual(['Basic', 'Pro', 'Max']);
    expect(buttons.map((b) => b.getAttribute('aria-checked'))).toEqual(['false', 'true', 'false']);
    expect(buttons.map((b) => b.getAttribute('tabindex'))).toEqual(['-1', '0', '-1']);
  });

  it('writes the option a click names', () => {
    const ui = mount('Choice', props, { plan: 'Basic' });
    fire(segments(ui.host)[2], 'click');
    expect(ui.writes).toEqual([{ name: 'plan', value: 'Max' }]);
  });

  it('keeps a numeric option numeric', () => {
    const ui = mount('Choice', { value: bind('n'), options: [1, 2, 3] }, { n: 1 });
    fire(segments(ui.host)[1], 'click');
    expect(ui.writes).toEqual([{ name: 'n', value: 2 }]);
  });

  it('moves the selection with ArrowRight and wraps with ArrowLeft', () => {
    const ui = mount('Choice', props, { plan: 'Basic' });
    const group = find(ui.host, '.acp-genui__segments');
    expect(press(group, 'ArrowRight').defaultPrevented).toBe(true);
    press(group, 'ArrowLeft');
    expect(ui.writes).toEqual([{ name: 'plan', value: 'Pro' }, { name: 'plan', value: 'Max' }]);
  });

  it('moves the roving tabindex when the state value changes', () => {
    const ui = mount('Choice', props, { plan: 'Basic' });
    const before = segments(ui.host);
    ui.update(undefined, { plan: 'Max' });
    const after = segments(ui.host);
    expect(after[0]).toBe(before[0]);
    expect(after.map((b) => b.getAttribute('tabindex'))).toEqual(['-1', '-1', '0']);
    expect(after[2].className).toContain('acp-genui__segment--on');
  });
});

describe('Radio', () => {
  const props = {
    value: bind('mode'),
    options: ['fast', { value: 'thorough', label: 'Thorough', detail: 'reads every file' }],
    label: 'Mode',
  };
  const inputs = (host: HTMLElement): HTMLInputElement[] => all<HTMLInputElement>(host, 'input[type="radio"]');

  it('renders a native group with details', () => {
    const ui = mount('Radio', props, { mode: 'fast' });
    expect(inputs(ui.host).map((i) => i.checked)).toEqual([true, false]);
    expect(find(ui.host, '.acp-genui__option-detail').textContent).toBe('reads every file');
    const names = new Set(inputs(ui.host).map((i) => i.getAttribute('name')));
    expect(names.size).toBe(1);
  });

  it('gives two mounted groups different names', () => {
    const first = mount('Radio', props, { mode: 'fast' });
    const second = mount('Radio', props, { mode: 'fast' });
    expect(inputs(first.host)[0].getAttribute('name')).not.toBe(inputs(second.host)[0].getAttribute('name'));
  });

  it('writes the chosen option', () => {
    const ui = mount('Radio', props, { mode: 'fast' });
    const second = inputs(ui.host)[1];
    second.checked = true;
    fire(second, 'change');
    expect(ui.writes).toEqual([{ name: 'mode', value: 'thorough' }]);
  });

  it('repaints from a new state value', () => {
    const ui = mount('Radio', props, { mode: 'fast' });
    ui.update(undefined, { mode: 'thorough' });
    expect(inputs(ui.host).map((i) => i.checked)).toEqual([false, true]);
  });
});

describe('Select', () => {
  const props = { value: bind('env'), options: ['dev', 'prod'], label: 'Env' };

  it('renders a native select on the bound value', () => {
    const ui = mount('Select', props, { env: 'prod' });
    const select = find<HTMLSelectElement>(ui.host, 'select');
    expect([...select.options].map((o) => o.textContent)).toEqual(['dev', 'prod']);
    expect(select.value).toBe('1');
  });

  it('writes the option the index names', () => {
    const ui = mount('Select', props, { env: 'dev' });
    const select = find<HTMLSelectElement>(ui.host, 'select');
    select.value = '1';
    fire(select, 'change');
    expect(ui.writes).toEqual([{ name: 'env', value: 'prod' }]);
  });

  it('repaints from a new state value', () => {
    const ui = mount('Select', props, { env: 'dev' });
    ui.update(undefined, { env: 'prod' });
    expect(find<HTMLSelectElement>(ui.host, 'select').value).toBe('1');
  });
});

describe('Checklist', () => {
  const props = { value: bind('tags'), options: ['alpha', 'beta', 'gamma'], label: 'Tags' };
  const boxes = (host: HTMLElement): HTMLInputElement[] => all<HTMLInputElement>(host, 'input[type="checkbox"]');

  it('ticks the options the list holds', () => {
    const ui = mount('Checklist', props, { tags: ['gamma'] });
    expect(boxes(ui.host).map((b) => b.checked)).toEqual([false, false, true]);
  });

  it('writes the whole list in option order, not in click order', () => {
    const ui = mount('Checklist', props, { tags: ['gamma'] });
    const [alpha] = boxes(ui.host);
    alpha.checked = true;
    fire(alpha, 'change');
    expect(ui.writes).toEqual([{ name: 'tags', value: ['alpha', 'gamma'] }]);
  });

  it('writes the remainder when an option is unticked', () => {
    const ui = mount('Checklist', props, { tags: ['alpha', 'beta'] });
    const beta = boxes(ui.host)[1];
    beta.checked = false;
    fire(beta, 'change');
    expect(ui.writes).toEqual([{ name: 'tags', value: ['alpha'] }]);
  });

  it('repaints from a new state value', () => {
    const ui = mount('Checklist', props, { tags: [] });
    ui.update(undefined, { tags: ['beta', 'gamma'] });
    expect(boxes(ui.host).map((b) => b.checked)).toEqual([false, true, true]);
  });
});

describe('Input / TextArea', () => {
  it('renders the bound text with its placeholder', () => {
    const ui = mount('Input', { value: bind('name'), label: 'Name', placeholder: 'who?' }, { name: 'ada' });
    const field = find<HTMLInputElement>(ui.host, 'input[type="text"]');
    expect(field.value).toBe('ada');
    expect(field.getAttribute('placeholder')).toBe('who?');
    expect(find(ui.host, '.acp-genui__label').textContent).toBe('Name');
  });

  it('writes on every input event', () => {
    const ui = mount('Input', { value: bind('name') }, { name: '' });
    const field = find<HTMLInputElement>(ui.host, 'input[type="text"]');
    field.value = 'ad';
    fire(field, 'input');
    expect(ui.writes).toEqual([{ name: 'name', value: 'ad' }]);
  });

  it('never swallows a printable key', () => {
    const ui = mount('Input', { value: bind('name') }, { name: '' });
    const field = find<HTMLInputElement>(ui.host, 'input[type="text"]');
    expect(press(field, 'a').defaultPrevented).toBe(false);
    expect(press(field, ' ').defaultPrevented).toBe(false);
    expect(press(field, 'Enter').defaultPrevented).toBe(false);
  });

  it('repaints a field whose value changed elsewhere', () => {
    const ui = mount('Input', { value: bind('name') }, { name: 'ada' });
    ui.update(undefined, { name: 'grace' });
    expect(find<HTMLInputElement>(ui.host, 'input[type="text"]').value).toBe('grace');
  });

  it('renders TextArea as a textarea and writes from it', () => {
    const ui = mount('TextArea', { value: bind('body'), label: 'Body' }, { body: 'one' });
    const field = find<HTMLTextAreaElement>(ui.host, 'textarea');
    expect(field.value).toBe('one');
    field.value = 'one\ntwo';
    fire(field, 'input');
    expect(ui.writes).toEqual([{ name: 'body', value: 'one\ntwo' }]);
    ui.update(undefined, { body: 'three' });
    expect(field.value).toBe('three');
  });
});

describe('Rating', () => {
  const props = { value: bind('stars'), max: 4, label: 'Quality' };
  const cells = (host: HTMLElement): HTMLElement[] => all(host, '.acp-genui__star');

  it('renders max stars with the rated ones filled', () => {
    const ui = mount('Rating', props, { stars: 2 });
    const stars = cells(ui.host);
    expect(stars).toHaveLength(4);
    expect(stars.map((s) => s.className.includes('--on'))).toEqual([true, true, false, false]);
    expect(find(ui.host, '.acp-genui__stars').getAttribute('aria-valuenow')).toBe('2');
  });

  it('calls 0 unrated', () => {
    const ui = mount('Rating', props, { stars: 0 });
    expect(cells(ui.host).every((s) => !s.className.includes('--on'))).toBe(true);
    expect(find(ui.host, '.acp-genui__stars').getAttribute('aria-valuetext')).toBe('unrated');
  });

  it('writes the star a click names', () => {
    const ui = mount('Rating', props, { stars: 0 });
    fire(cells(ui.host)[2], 'click');
    expect(ui.writes).toEqual([{ name: 'stars', value: 3 }]);
  });

  it('moves with the arrows and jumps with Home/End', () => {
    const ui = mount('Rating', props, { stars: 2 });
    const strip = find(ui.host, '.acp-genui__stars');
    expect(press(strip, 'ArrowRight').defaultPrevented).toBe(true);
    press(strip, 'ArrowLeft');
    press(strip, 'Home');
    press(strip, 'End');
    expect(ui.writes).toEqual([
      { name: 'stars', value: 3 },
      { name: 'stars', value: 1 },
      { name: 'stars', value: 0 },
      { name: 'stars', value: 4 },
    ]);
  });

  it('leaves an unhandled key alone', () => {
    const ui = mount('Rating', props, { stars: 2 });
    expect(press(find(ui.host, '.acp-genui__stars'), 'Escape').defaultPrevented).toBe(false);
    expect(ui.writes).toEqual([]);
  });

  it('repaints from a new state value', () => {
    const ui = mount('Rating', props, { stars: 1 });
    ui.update(undefined, { stars: 4 });
    expect(cells(ui.host).every((s) => s.className.includes('--on'))).toBe(true);
  });
});

describe('EditableTable', () => {
  const columns: Value = ['name', { key: 'qty', label: 'Qty', type: 'number' }, { key: 'ok', type: 'boolean' }];
  const props = { value: bind('rows'), columns, label: 'Rows' };
  const rows = (): UiStateValue => [
    { name: 'alpha', qty: 2, ok: false },
    { name: 'beta', qty: 5, ok: true },
  ];
  const cells = (host: HTMLElement): HTMLInputElement[] => all<HTMLInputElement>(host, '.acp-genui__cell');

  it('renders a cell per column and row', () => {
    const ui = mount('EditableTable', props, { rows: rows() });
    expect(all(ui.host, 'th').map((th) => th.textContent)).toEqual(['name', 'Qty', 'ok', '']);
    expect(all(ui.host, '.acp-genui__grid-row')).toHaveLength(2);
    const fields = cells(ui.host);
    expect(fields.map((f) => f.getAttribute('type'))).toEqual(
      ['text', 'number', 'checkbox', 'text', 'number', 'checkbox'],
    );
    expect(fields[0].value).toBe('alpha');
    expect(fields[1].value).toBe('2');
    expect(fields[5].checked).toBe(true);
  });

  it('writes the whole list when one text cell changes', () => {
    const ui = mount('EditableTable', props, { rows: rows() });
    const field = cells(ui.host)[3];
    field.value = 'gamma';
    fire(field, 'input');
    expect(ui.writes).toEqual([
      { name: 'rows', value: [{ name: 'alpha', qty: 2, ok: false }, { name: 'gamma', qty: 5, ok: true }] },
    ]);
  });

  it('writes a number cell as a number', () => {
    const ui = mount('EditableTable', props, { rows: rows() });
    const field = cells(ui.host)[1];
    field.value = '7';
    fire(field, 'input');
    expect(ui.writes[0].value).toEqual([{ name: 'alpha', qty: 7, ok: false }, { name: 'beta', qty: 5, ok: true }]);
  });

  it('writes a boolean cell once, from change', () => {
    const ui = mount('EditableTable', props, { rows: rows() });
    const box = cells(ui.host)[2];
    box.checked = true;
    fire(box, 'input');
    fire(box, 'change');
    expect(ui.writes).toEqual([
      { name: 'rows', value: [{ name: 'alpha', qty: 2, ok: true }, { name: 'beta', qty: 5, ok: true }] },
    ]);
  });

  it('appends a blank row typed by its columns', () => {
    const ui = mount('EditableTable', props, { rows: [{ name: 'alpha', qty: 2, ok: false }] });
    fire(find(ui.host, '.acp-genui__grid-add'), 'click');
    expect(ui.writes).toEqual([
      { name: 'rows', value: [{ name: 'alpha', qty: 2, ok: false }, { name: '', qty: 0, ok: false }] },
    ]);
  });

  it('removes the row its control names', () => {
    const ui = mount('EditableTable', props, { rows: rows() });
    fire(all(ui.host, '.acp-genui__grid-remove')[0], 'click');
    expect(ui.writes).toEqual([{ name: 'rows', value: [{ name: 'beta', qty: 5, ok: true }] }]);
  });

  it('repaints cells from a new state value', () => {
    const ui = mount('EditableTable', props, { rows: rows() });
    ui.update(undefined, { rows: [{ name: 'alpha', qty: 9, ok: true }, { name: 'delta', qty: 5, ok: true }] });
    const fields = cells(ui.host);
    expect(fields[1].value).toBe('9');
    expect(fields[2].checked).toBe(true);
    expect(fields[3].value).toBe('delta');
  });

  it('rebuilds when a row is added to the state', () => {
    const ui = mount('EditableTable', props, { rows: [{ name: 'alpha', qty: 2, ok: false }] });
    ui.update(undefined, { rows: rows() });
    expect(all(ui.host, '.acp-genui__grid-row')).toHaveLength(2);
    expect(cells(ui.host)[3].value).toBe('beta');
  });
});

describe('Button', () => {
  it('runs its actions in order', () => {
    const copy: Value = { kind: 'action', type: 'copy', text: 'x' };
    const draft: Value = { kind: 'action', type: 'draft', text: 'Plan for 10 seats' };
    const ui = mount('Button', { label: 'Use this', action: [copy, draft], variant: 'primary' });
    fire(find(ui.host, '.acp-genui__button'), 'click');
    expect(ui.runs).toEqual([copy, draft]);
  });

  it('drafts its own label verbatim when it has no action', () => {
    const ui = mount('Button', { label: 'Ship it  now' });
    fire(find(ui.host, '.acp-genui__button'), 'click');
    expect(ui.runs).toEqual([{ kind: 'action', type: 'draft', text: 'Ship it  now' }]);
  });

  it('maps variant to a modifier', () => {
    for (const variant of ['primary', 'secondary', 'destructive']) {
      const ui = mount('Button', { label: 'Go', variant });
      expect(find(ui.host, '.acp-genui__button').className).toBe(`acp-genui__button acp-genui__button--${variant}`);
    }
    const plain = mount('Button', { label: 'Go' });
    expect(find(plain.host, '.acp-genui__button').className).toBe('acp-genui__button');
  });

  it('repaints its label', () => {
    const ui = mount('Button', { label: 'Go' });
    ui.update({ label: 'Stop', variant: 'destructive' });
    const button = find(ui.host, '.acp-genui__button');
    expect(button.textContent).toBe('Stop');
    expect(button.className).toContain('acp-genui__button--destructive');
  });
});
