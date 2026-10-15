import { describe, expect, it } from 'vitest';

import type { KeyHint } from '../key-hint-bar';
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
        '<div class="acp-harness__permission-options">a accept · A all · r reject · R all</div>' +
        '</div>',
    );
  });

  it('takes the question hint as the pre-joined string it already is', () => {
    const row = mount({ label: 'ask', hint: '1-3 select · Enter send · Tab other · Esc cancel' });

    expect(row.el.outerHTML).toBe(
      '<div class="acp-harness__permission-row">' +
        '<div class="acp-harness__composer-meta">ask</div>' +
        '<div class="acp-harness__permission-options">1-3 select · Enter send · Tab other · Esc cancel</div>' +
        '</div>',
    );
  });

  it('keeps both nodes when only the hint changes', () => {
    const row = mount({ label: 'ask', hint: '1-3 select · Esc cancel' });
    const label = row.el.querySelector('.acp-harness__composer-meta');
    const options = row.el.querySelector('.acp-harness__permission-options');

    row.update({ label: 'ask', hint: '1-3 select · Tab other · Esc cancel' });

    expect(row.el.querySelector('.acp-harness__composer-meta')).toBe(label);
    expect(row.el.querySelector('.acp-harness__permission-options')).toBe(options);
    expect(options?.textContent).toBe('1-3 select · Tab other · Esc cancel');
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
