import { useState } from 'react';
import type { JSX } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { usePoll, useKeymap } from './hooks';
import { keymap } from './lib/keymap';
import { act, flush, press, render } from './test-utils';
import type { Rendered } from './test-utils';

describe('useKeymap', () => {
  let view: Rendered | null = null;
  afterEach(() => {
    view?.unmount();
    view = null;
  });

  function Counter({ onRun }: { onRun: (count: number) => void }): JSX.Element {
    const [count, setCount] = useState(0);
    useKeymap([{ key: 'j', label: 'Report the count', run: () => onRun(count) }]);
    return (
      <button type="button" onClick={() => setCount((n) => n + 1)}>
        {count}
      </button>
    );
  }

  it('runs the latest render handler without rebinding, and StrictMode leaves one binding', () => {
    const seen: number[] = [];
    view = render(<Counter onRun={(n) => seen.push(n)} />, { strict: true });
    // One binding after StrictMode's mount → unmount → mount: a second one would
    // have thrown on the duplicate chord, and `?` help lists it once.
    expect(keymap().help().filter((entry) => entry.label === 'Report the count')).toHaveLength(1);

    act(() => view?.container.querySelector('button')?.click());
    act(() => view?.container.querySelector('button')?.click());
    press('j');
    expect(seen).toEqual([2]);
  });

  it('unbinds on unmount', () => {
    const run = vi.fn();
    view = render(<Counter onRun={run} />);
    view.unmount();
    view = null;
    press('j');
    expect(run).not.toHaveBeenCalled();
    expect(keymap().help().some((entry) => entry.label === 'Report the count')).toBe(false);
  });
});

describe('usePoll', () => {
  it('does not re-render when the payload signature has not moved', async () => {
    let payload = { n: 1 };
    const load = vi.fn(async () => payload);
    let renders = 0;
    let refresh: () => Promise<void> = async () => {};
    function Probe(): JSX.Element {
      const state = usePoll({ load, signature: (value) => String(value.n) });
      renders++;
      refresh = state.refresh;
      return <span>{state.value?.n ?? '-'}</span>;
    }
    const view = render(<Probe />);
    await flush();
    expect(view.container.textContent).toBe('1');
    const settled = renders;

    payload = { n: 1 };
    await act(() => refresh());
    expect(load).toHaveBeenCalledTimes(2);
    expect(renders).toBe(settled);

    payload = { n: 2 };
    await act(() => refresh());
    expect(view.container.textContent).toBe('2');
    view.unmount();
  });
});
