import { afterEach, describe, expect, it } from 'vitest';

import { el } from '../../../ui/dom';
import type { UiAction, UiNode, UiState, UiStateValue, Value } from '../../genui/types';
import { CONTENT_RENDERERS } from './content';
import { FORM_RENDERERS } from './form';
import { LAYOUT_RENDERERS } from './layout';
import { registerRenderers } from './renderer';
import type { GenUiComponent, GenUiContext, GenUiFactory, GenUiProps } from './renderer';

registerRenderers(LAYOUT_RENDERERS);
registerRenderers(CONTENT_RENDERERS);
registerRenderers(FORM_RENDERERS);

const mounted: GenUiComponent[] = [];

afterEach(() => {
  for (const component of mounted.splice(0)) {
    component.dispose();
    component.el.remove();
  }
});

function node(component: string, props: Readonly<Record<string, Value>>, key = component): UiNode {
  return { kind: 'node', component, props, key };
}

/** The panel's contract, reduced to what a renderer can observe. */
class TestContext implements GenUiContext {
  readonly runs: (readonly UiAction[])[] = [];
  readonly state: UiState;
  private readonly views = new Map<string, Record<string, unknown>>();
  /** The panel re-`update()`s after `repaint()`; a test wires that here. */
  onRepaint: () => void = () => undefined;

  constructor(state: UiState = {}) {
    this.state = state;
  }

  run(actions: readonly UiAction[]): void {
    this.runs.push(actions);
  }

  setInput(name: string, value: UiStateValue): void {
    this.state[name] = value;
  }

  view(key: string): Record<string, unknown> {
    const existing = this.views.get(key);
    if (existing !== undefined) return existing;
    const created: Record<string, unknown> = {};
    this.views.set(key, created);
    return created;
  }

  repaint(): void {
    this.onRepaint();
  }
}

function mount(factory: GenUiFactory, target: UiNode, ctx = new TestContext()): {
  readonly component: GenUiComponent;
  readonly ctx: TestContext;
  readonly props: GenUiProps;
} {
  const host = el('div');
  document.body.appendChild(host);
  const component = factory(host);
  mounted.push(component);
  const props: GenUiProps = { node: target, ctx };
  ctx.onRepaint = () => component.update(props);
  component.update(props);
  return { component, ctx, props };
}

describe('Layout renderers', () => {
  it('paints a Card title and mounts its children through the catalog registry', () => {
    const { component } = mount(LAYOUT_RENDERERS.Card, node('Card', {
      title: 'Estimate',
      children: [node('Metric', { label: 'Total', value: '$290' }, 'Card/0')],
    }));

    expect(component.el.querySelector('.acp-genui__card-title')?.textContent).toBe('Estimate');
    expect(component.el.querySelector('.acp-genui__metric-label')?.textContent).toBe('Total');
    expect(component.el.querySelector('.acp-genui__metric-value')?.textContent).toBe('$290');
  });

  it('shows one Tabs pane, switches on click and keeps the choice in ctx.view', () => {
    const target = node('Tabs', {
      labels: ['Plan', 'Cost'],
      children: [
        node('Text', { text: 'the plan' }, 'Tabs/0'),
        node('Text', { text: 'the cost' }, 'Tabs/1'),
      ],
    }, 'tabs');
    const { component, ctx } = mount(LAYOUT_RENDERERS.Tabs, target);
    const pane = component.el.querySelector('.acp-genui__tabs-pane');
    const tabs = [...component.el.querySelectorAll<HTMLButtonElement>('.acp-genui__tab')];

    expect(tabs.map((tab) => tab.textContent)).toEqual(['Plan', 'Cost']);
    expect(pane?.textContent).toBe('the plan');
    expect(tabs[0].tabIndex).toBe(0);
    expect(tabs[1].tabIndex).toBe(-1);

    tabs[1].click();

    expect(pane?.textContent).toBe('the cost');
    expect(ctx.view('tabs').tab).toBe(1);
    expect(tabs[1].tabIndex).toBe(0);
    expect(tabs[0].tabIndex).toBe(-1);
    // The strip is reused, not rebuilt: the roving tabindex must survive.
    expect(component.el.querySelector('.acp-genui__tab')).toBe(tabs[0]);
  });

  it('opens Details from its prop and records the user toggle in ctx.view', () => {
    const { component, ctx } = mount(LAYOUT_RENDERERS.Details, node('Details', {
      title: 'Assumptions',
      children: [node('Text', { text: 'one' }, 'Details/0')],
      open: true,
    }, 'details'));
    const details = component.el.querySelector<HTMLDetailsElement>('details');

    expect(details?.open).toBe(true);
    expect(component.el.querySelector('.acp-genui__details-summary')?.textContent).toBe('Assumptions');

    details!.open = false;
    details!.dispatchEvent(new Event('toggle'));

    expect(ctx.view('details').open).toBe(false);
  });

  it('lays a Grid out with a clamped column count', () => {
    const { component } = mount(LAYOUT_RENDERERS.Grid, node('Grid', {
      children: [node('Badge', { text: 'a' }, 'Grid/0')],
      columns: 99,
    }));

    expect(component.el.querySelector<HTMLElement>('.acp-genui__tiles')
      ?.style.getPropertyValue('--acp-genui-columns')).toBe('6');
  });
});

describe('Content renderers', () => {
  it('renders inline markdown as elements and leaves everything else literal', () => {
    const { component } = mount(CONTENT_RENDERERS.Text, node('Text', {
      text: 'run `npm run check` for **all** of the *rules* <script>x</script>',
      tone: 'warn',
    }));
    const prose = component.el.querySelector('.acp-genui__prose');

    expect(prose?.className).toBe('acp-genui__prose acp-genui__prose--warn');
    expect(prose?.querySelector('.acp-genui__md-code')?.textContent).toBe('npm run check');
    expect(prose?.querySelector('.acp-genui__md-strong')?.textContent).toBe('all');
    expect(prose?.querySelector('.acp-genui__md-em')?.textContent).toBe('rules');
    expect(prose?.querySelector('script')).toBeNull();
    expect(prose?.textContent).toBe('run npm run check for all of the rules <script>x</script>');
  });

  it('accepts KeyValue as an object and as [[key, value]] pairs', () => {
    const asObject = mount(CONTENT_RENDERERS.KeyValue, node('KeyValue', {
      pairs: { Seats: 10, Plan: 'Pro', Tags: ['a', 'b'], Note: null },
    }));
    const asPairs = mount(CONTENT_RENDERERS.KeyValue, node('KeyValue', {
      pairs: [['Seats', 10], ['Plan', 'Pro'], ['Tags', ['a', 'b']], ['Note', null]],
    }));
    const read = (root: HTMLElement): string[] => [...root.querySelectorAll('dt, dd')]
      .map((cell) => cell.textContent ?? '');

    expect(read(asObject.component.el)).toEqual(['Seats', '10', 'Plan', 'Pro', 'Tags', 'a, b', 'Note', '—']);
    expect(read(asPairs.component.el)).toEqual(read(asObject.component.el));
  });

  it('turns a List row with an action into a button that calls ctx.run', () => {
    const copy: UiAction = { kind: 'action', type: 'copy', text: 'npm test' };
    const { component, ctx } = mount(CONTENT_RENDERERS.List, node('List', {
      items: [
        { title: 'Plain row', detail: 'no action' },
        { title: 'Copy command', value: '12', tone: 'good', action: copy },
      ],
    }));
    const buttons = component.el.querySelectorAll<HTMLButtonElement>('button');

    expect(component.el.querySelectorAll('.acp-genui__list-row').length).toBe(2);
    expect(buttons.length).toBe(1);
    expect(component.el.querySelector('.acp-genui__list-value')?.className)
      .toBe('acp-genui__list-value acp-genui__list-value--good');

    buttons[0].click();

    expect(ctx.runs).toEqual([[copy]]);
  });

  it('emits Sources as OpenUrl buttons and never as an anchor', () => {
    const { component, ctx } = mount(CONTENT_RENDERERS.Sources, node('Sources', {
      links: ['https://example.com/raw', { url: 'https://example.com/spec', title: 'Spec 309', note: 'draft' }],
    }));
    const buttons = [...component.el.querySelectorAll<HTMLButtonElement>('button')];

    expect(component.el.querySelector('a')).toBeNull();
    expect(buttons.length).toBe(2);
    expect(buttons[0].textContent).toBe('https://example.com/raw');
    expect(buttons[1].textContent).toBe('Spec 309draft');
    expect(buttons[1].getAttribute('data-genui-focusable')).toBe('');

    buttons[1].click();

    expect(ctx.runs).toEqual([[{ kind: 'action', type: 'openUrl', text: 'https://example.com/spec' }]]);
  });
});

describe('Form renderers', () => {
  it('drafts one message from every input descendant, in document order', () => {
    const target = node('Form', {
      submit: 'Send request',
      children: [
        node('Toggle', { value: { kind: 'binding', name: 'notify' }, label: 'Notify me' }, 'Form/0'),
        node('Row', {
          children: [
            node('Checklist', { value: { kind: 'binding', name: 'tags' }, label: 'Tags' }, 'Form/1/0'),
            node('Input', { value: { kind: 'binding', name: 'note' }, label: 'Note' }, 'Form/1/1'),
          ],
        }, 'Form/1'),
        node('Rating', { value: { kind: 'binding', name: 'stars' } }, 'Form/2'),
        node('Text', { text: 'not a field' }, 'Form/3'),
      ],
    }, 'form');
    const ctx = new TestContext({ notify: true, tags: ['api', 'ui'], note: '', stars: 0 });
    const { component } = mount(FORM_RENDERERS.Form, target, ctx);
    const submit = component.el.querySelector<HTMLButtonElement>('.acp-genui__form-submit');

    expect(submit?.textContent).toBe('Send request');

    submit!.click();

    expect(ctx.runs).toEqual([[{
      kind: 'action',
      type: 'draft',
      text: 'Notify me: Yes\nTags: api, ui\nNote: —\nstars: —',
    }]]);
    expect(submit?.textContent).toBe('Drafted');
    expect(submit?.disabled).toBe(true);
    expect(component.el.querySelector<HTMLFieldSetElement>('.acp-genui__form-fields')?.disabled).toBe(true);

    submit!.click();

    expect(ctx.runs.length).toBe(1);
  });

  it('drafts a FollowUp prompt verbatim', () => {
    const { component, ctx } = mount(FORM_RENDERERS.FollowUps, node('FollowUps', {
      prompts: ['Show me the slow tests', 'Why did coverage drop?'],
    }));
    const buttons = [...component.el.querySelectorAll<HTMLButtonElement>('.acp-genui__followup')];

    expect(buttons.map((button) => button.textContent)).toEqual([
      'Show me the slow tests',
      'Why did coverage drop?',
    ]);

    buttons[1].click();

    expect(ctx.runs).toEqual([[{ kind: 'action', type: 'draft', text: 'Why did coverage drop?' }]]);
  });
});

describe('repaint discipline', () => {
  it('keeps every node when update() is called again with identical props', () => {
    const target = node('Card', {
      title: 'Estimate',
      children: [
        node('Row', {
          children: [
            node('Metric', { label: 'Total', value: '$290' }, 'Card/0/0'),
            node('Badge', { text: 'Pro', tone: 'info' }, 'Card/0/1'),
          ],
        }, 'Card/0'),
      ],
    });
    const { component, props } = mount(LAYOUT_RENDERERS.Card, target);
    const before = [...component.el.querySelectorAll('*')];

    component.update(props);

    const after = [...component.el.querySelectorAll('*')];
    expect(after.length).toBe(before.length);
    for (let i = 0; i < before.length; i++) expect(after[i]).toBe(before[i]);
    expect(component.el.querySelector('.acp-genui__badge')?.className)
      .toBe('acp-genui__badge acp-genui__badge--info');
  });
});
