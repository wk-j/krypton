import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { ModelInfo } from '../../types';
import { ModelPicker, type ModelPickerProps } from './index';

const MODELS: readonly ModelInfo[] = [
  { model_id: 'sonnet-4-6', name: 'Claude Sonnet 4.6', description: 'balanced' },
  { model_id: 'opus-4-1', name: 'Claude Opus 4.1', description: null },
  { model_id: 'haiku-4', name: 'Claude Haiku 4', description: 'fast' },
];

const pickers: ModelPicker[] = [];
const scrolled: Element[] = [];

const base = (over: Partial<ModelPickerProps> = {}): ModelPickerProps => ({
  open: true,
  laneName: 'claude-1',
  models: MODELS,
  currentModelId: 'sonnet-4-6',
  cursor: 0,
  ...over,
});

const mount = (props: ModelPickerProps): ModelPicker => {
  const picker = new ModelPicker();
  pickers.push(picker);
  picker.update(props);
  return picker;
};

const watch = (node: Node): MutationObserver => {
  const observer = new MutationObserver(() => {
    /* read synchronously through takeRecords() */
  });
  observer.observe(node, { subtree: true, childList: true, attributes: true, characterData: true });
  return observer;
};

beforeEach(() => {
  scrolled.length = 0;
  // happy-dom has no layout; record which node was asked to scroll.
  Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', {
    configurable: true,
    writable: true,
    value(this: HTMLElement): void {
      scrolled.push(this);
    },
  });
});

afterEach(() => {
  for (const picker of pickers.splice(0)) picker.dispose();
});

describe('ModelPicker', () => {
  it('emits the head and one row per advertised model', () => {
    const picker = mount(base({ cursor: 1 }));

    expect(picker.el.outerHTML).toBe(
      '<aside class="acp-harness__model-picker">' +
        '<header class="acp-harness__model-head">' +
        '<span>// model · claude-1</span>' +
        '<span>j/k move · enter switch · esc cancel</span>' +
        '</header>' +
        '<ul class="acp-harness__model-list">' +
        '<li class="acp-harness__model-row" data-model-index="0">' +
        '<span class="acp-harness__model-name">Claude Sonnet 4.6' +
        '<span class="acp-harness__model-current">✓</span></span>' +
        '<span class="acp-harness__model-desc">balanced</span>' +
        '</li>' +
        '<li class="acp-harness__model-row acp-harness__model-row--active" data-model-index="1">' +
        '<span class="acp-harness__model-name">Claude Opus 4.1</span>' +
        '</li>' +
        '<li class="acp-harness__model-row" data-model-index="2">' +
        '<span class="acp-harness__model-name">Claude Haiku 4</span>' +
        '<span class="acp-harness__model-desc">fast</span>' +
        '</li>' +
        '</ul>' +
        '</aside>',
    );
  });

  it('moves the tick when the lane switches model', () => {
    const picker = mount(base());
    const rows = [...picker.el.querySelectorAll('li')];

    picker.update(base({ currentModelId: 'haiku-4' }));

    expect([...picker.el.querySelectorAll('li')]).toStrictEqual(rows);
    expect(rows[0].querySelector('.acp-harness__model-current')).toBeNull();
    expect(rows[2].querySelector('.acp-harness__model-current')?.textContent).toBe('✓');
  });

  it('keeps the cursor visible — the one behaviour this picker always had', () => {
    const picker = mount(base({ cursor: 2 }));

    expect(scrolled).toStrictEqual([picker.el.querySelectorAll('li')[2]]);
  });

  it('moves --active without rebuilding a row', () => {
    const picker = mount(base({ cursor: 0 }));
    const rows = [...picker.el.querySelectorAll('li')];
    const untouchedChild = rows[2].firstChild;

    picker.update(base({ cursor: 1 }));

    expect([...picker.el.querySelectorAll('li')]).toStrictEqual(rows);
    expect(rows[0].className).toBe('acp-harness__model-row');
    expect(rows[1].className).toBe('acp-harness__model-row acp-harness__model-row--active');
    expect(rows[2].firstChild).toBe(untouchedChild);
  });

  it('re-derives the row class after the cursor comes back', () => {
    const picker = mount(base({ cursor: 2 }));
    picker.update(base({ cursor: 0 }));
    picker.update(base({ cursor: 2 }));

    const rows = [...picker.el.querySelectorAll('li')];
    expect(rows[2].className).toBe('acp-harness__model-row acp-harness__model-row--active');
    expect(rows[0].className).toBe('acp-harness__model-row');
  });

  it('shuts when the lane it was switching went away', () => {
    const picker = mount(base());
    expect(picker.el.hidden).toBe(false);

    picker.update(base({ laneName: null }));
    expect(picker.el.hidden).toBe(true);
  });

  it('renders an empty list rather than a stale one when no model is advertised', () => {
    const picker = mount(base());
    picker.update(base({ models: [] }));

    expect(picker.el.querySelector('ul')?.children.length).toBe(0);
  });

  it('writes nothing to the DOM when the props say the same thing', () => {
    const picker = mount(base({ cursor: 1 }));
    const observer = watch(picker.el);

    picker.update(base({ cursor: 1 }));

    expect(observer.takeRecords()).toStrictEqual([]);
    observer.disconnect();
  });

  it('leaves the single open slot on dispose', () => {
    const picker = new ModelPicker();
    picker.update(base());
    picker.dispose();

    const other = new ModelPicker();
    other.update(base());
    expect(other.el.hidden).toBe(false);
    other.dispose();
  });
});
