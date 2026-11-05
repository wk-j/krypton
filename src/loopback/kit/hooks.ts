// Spec 361 — React hooks over the framework-free kit libraries (`Keymap`,
// `poll()`). The libraries keep their behaviour; these hooks only tie their
// lifetime to a component and route every call to the latest render's closures.

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { RefObject } from 'react';

import { keymap } from './lib/keymap';
import type { KeyBinding } from './lib/keymap';
import { poll } from './lib/poll';
import type { Poller, PollOptions, PollStatus } from './lib/poll';

/** A ref that always holds the latest render's value (synced before effects run). */
export function useLatest<T>(value: T): RefObject<T> {
  const ref = useRef(value);
  useLayoutEffect(() => {
    ref.current = value;
  });
  return ref;
}

/**
 * Bind `bindings` for the component's lifetime. They are bound once, on mount,
 * so the page's `?` help order and the keymap's duplicate check see one stable
 * set; `run` and `when` always call the latest render's functions. Everything
 * else (keys, labels, groups, which bindings carry a `when`) is read from the
 * first render: a component whose key set changes must remount instead.
 */
export function useKeymap(bindings: readonly KeyBinding[]): void {
  const latest = useLatest(bindings);
  useEffect(() => {
    const stable = latest.current.map(
      (binding, index): KeyBinding => ({
        ...binding,
        when: binding.when ? () => latest.current[index]?.when?.() ?? false : undefined,
        run: (event) => latest.current[index]?.run(event),
      }),
    );
    return keymap().bindAll(stable);
  }, [latest]);
}

/** The keymap's fallback (runs after every binding declined) for the component's lifetime. */
export function useKeyFallback(handler: (event: KeyboardEvent) => void | boolean): void {
  const latest = useLatest(handler);
  useEffect(() => keymap().setFallback((event) => latest.current(event)), [latest]);
}

/** Register an overlay with the keymap: while `open`, only `modal` bindings fire. */
export function useModal(open: boolean): void {
  const latest = useLatest(open);
  useEffect(() => keymap().addModal(() => latest.current), [latest]);
}

export type UsePollOptions<T> = Omit<PollOptions<T>, 'apply' | 'onStatus'>;

export interface PollState<T> {
  /** The last applied value; `undefined` until the first successful load. */
  readonly value: T | undefined;
  readonly status: PollStatus;
  /** The error that put the poll into `reconnecting`, else `undefined`. */
  readonly error: unknown;
  /** Load now (no-op while a load is in flight). Stable across renders. */
  refresh(): Promise<void>;
}

/**
 * `poll()` as component state. The loop restarts when `deps` change; `load`
 * and `signature` always come from the latest render. With a `signature`, an
 * unchanged payload is never applied, so a quiet poll causes no render.
 */
export function usePoll<T>(options: UsePollOptions<T>, deps: readonly unknown[] = []): PollState<T> {
  const latest = useLatest(options);
  const poller = useRef<Poller | null>(null);
  const [value, setValue] = useState<T | undefined>(undefined);
  const [status, setStatus] = useState<PollStatus>('loading');
  const [error, setError] = useState<unknown>(undefined);

  useEffect(() => {
    const first = latest.current;
    const current = poll<T>({
      intervalMs: first.intervalMs,
      pauseWhenHidden: first.pauseWhenHidden,
      refreshOnFocus: first.refreshOnFocus,
      minGapMs: first.minGapMs,
      load: (signal) => latest.current.load(signal),
      signature: first.signature ? (next) => latest.current.signature?.(next) ?? '' : undefined,
      apply: (next) => setValue(() => next),
      onStatus: (next, cause) => {
        setStatus(next);
        setError(next === 'reconnecting' ? cause : undefined);
      },
    });
    poller.current = current;
    return () => {
      current.dispose();
      if (poller.current === current) poller.current = null;
    };
    // `deps` is the caller's restart key, spread like a hook dependency list.
  }, [latest, ...deps]);

  const refresh = useCallback((): Promise<void> => poller.current?.refresh() ?? Promise.resolve(), []);
  return { value, status, error, refresh };
}
