// Spec 361 — the one boundary to DOM React does not own: the GenUI catalog
// renderer and the cell grid (which must render exactly as in the harness),
// Mermaid/SVG fences, canvas drawing. React renders an empty host and never
// touches its children; `mount` fills it and returns what undoes that.

import { useLayoutEffect, useRef } from 'react';
import type { JSX } from 'react';

import type { Disposer } from '../../../ui/component';
import { useLatest } from '../hooks';

export interface IslandProps {
  /** Fill `host`; return a disposer if anything must be undone beyond emptying it. */
  mount(host: HTMLDivElement): Disposer | void;
  /** Remount when any of these change (compared like hook dependencies). */
  readonly deps: readonly unknown[];
  readonly className?: string;
}

export function Island({ mount, deps, className }: IslandProps): JSX.Element {
  const host = useRef<HTMLDivElement>(null);
  const latest = useLatest(mount);
  useLayoutEffect(() => {
    const node = host.current;
    if (!node) return undefined;
    const dispose = latest.current(node);
    return () => {
      dispose?.();
      node.replaceChildren();
    };
    // `deps` is the caller's remount key, spread like a hook dependency list.
  }, [latest, ...deps]);
  return <div ref={host} className={className} />;
}
