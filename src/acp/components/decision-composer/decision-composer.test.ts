import { describe, expect, it } from 'vitest';

import type { KeyHint } from '../../../ui/kbd';
import { DecisionComposer, type DecisionComposerProps } from './index';

const PERM_HINTS: readonly KeyHint[] = [
  { keys: ['a'], label: 'accept' },
  { keys: ['A'], label: 'all' },
  { keys: ['r'], label: 'reject' },
  { keys: ['R'], label: 'all' },
];

const PERM: DecisionComposerProps = { label: 'perm', hint: PERM_HINTS };

const writes = (el: HTMLElement, run: () => void): number => {
  const observer = new MutationObserver(() => {});
  observer.observe(el, { subtree: true, childList: true, attributes: true, characterData: true });
  run();
  const records = observer.takeRecords();
  observer.disconnect();
  return records.length;
};

const mount = (props: DecisionComposerProps = PERM): DecisionComposer => {
  const row = new DecisionComposer();
  row.update(props);
  return row;
};

describe('DecisionComposer', () => {
  it('emits the permission row from structured hints', () => {
    const row = mount();

    expect(row.el.outerHTML).toBe(
      '<div class="acp-harness__permission-row">' +
        '<div class="acp-harness__composer-meta">perm</div>' +
        '<div class="acp-harness__permission-options">' +
          '<span class="krypton-key-hint"><kbd>a</kbd> accept</span> · ' +
          '<span class="krypton-key-hint"><kbd>A</kbd> all</span> · ' +
          '<span class="krypton-key-hint"><kbd>r</kbd> reject</span> · ' +
          '<span class="krypton-key-hint"><kbd>R</kbd> all</span>' +
        '</div>' +
        '</div>',
    );
  });

  it('keeps both nodes when only the hint changes', () => {
    const select: KeyHint = { keys: ['1–9'], label: 'pick' };
    const cancel: KeyHint = { keys: ['Esc'], label: 'cancel' };
    const row = mount({ label: 'ask', hint: [select, cancel] });
    const label = row.el.querySelector('.acp-harness__composer-meta');
    const options = row.el.querySelector('.acp-harness__permission-options');

    row.update({ label: 'ask', hint: [select, { keys: ['z'], label: 'other' }, cancel] });

    expect(row.el.querySelector('.acp-harness__composer-meta')).toBe(label);
    expect(row.el.querySelector('.acp-harness__permission-options')).toBe(options);
    expect(options?.textContent).toBe('1–9 pick · z other · Esc cancel');
    expect(label?.textContent).toBe('ask');
  });

  it('writes nothing when the decision has not changed', () => {
    const row = mount();
    const count = writes(row.el, () => {
      row.update({ label: 'perm', hint: [...PERM_HINTS] });
    });
    expect(count).toBe(0);
  });
});
