// Spec 361 — mounting React in the DOM test project without a testing library.
// Importing this module marks the environment for `act()`.

import { act, StrictMode } from 'react';
import type { ReactNode } from 'react';
import { createRoot } from 'react-dom/client';

import { surfaceById } from '../surfaces';
import type { SurfaceId } from '../surfaces';
import { EMPTY_CONTEXT } from './lib/nav';
import { ShellContext } from './shell/context';
import type { ShellApi } from './shell/context';

Reflect.set(globalThis, 'IS_REACT_ACT_ENVIRONMENT', true);

export { act };

export interface Rendered {
  readonly container: HTMLElement;
  rerender(node: ReactNode): void;
  unmount(): void;
}

export interface RenderOptions {
  /** Mount into this node instead of a fresh `<div>` appended to `<body>`. */
  readonly container?: HTMLElement;
  /** Wrap in `<StrictMode>` (double effects) to prove a component cleans up. */
  readonly strict?: boolean;
  /** Provide a shell: `true` for a static default, or overrides of it. */
  readonly shell?: boolean | (Partial<ShellApi> & { surfaceId?: SurfaceId });
}

/** A static shell for page tests; every method is a no-op unless overridden. */
export function testShell(overrides: Partial<ShellApi> & { surfaceId?: SurfaceId } = {}): ShellApi {
  const { surfaceId = 'home', ...rest } = overrides;
  const surface = surfaceById(surfaceId);
  return {
    surface,
    title: surface.title,
    context: EMPTY_CONTEXT,
    contextLoaded: true,
    setTitle: () => {},
    selectProject: () => {},
    refresh: async () => {},
    ...rest,
  };
}

export function render(node: ReactNode, options: RenderOptions = {}): Rendered {
  const container = options.container ?? document.body.appendChild(document.createElement('div'));
  const root = createRoot(container);
  const wrap = (child: ReactNode): ReactNode => {
    let out = child;
    if (options.shell) {
      const value = testShell(options.shell === true ? {} : options.shell);
      out = <ShellContext.Provider value={value}>{out}</ShellContext.Provider>;
    }
    return options.strict ? <StrictMode>{out}</StrictMode> : out;
  };
  act(() => root.render(wrap(node)));
  return {
    container,
    rerender: (next) => act(() => root.render(wrap(next))),
    unmount: () => {
      act(() => root.unmount());
      if (!options.container) container.remove();
    },
  };
}

/** Let pending promises (stubbed `fetch`, `poll()` loads) settle and their renders commit. */
export async function flush(times = 3): Promise<void> {
  for (let i = 0; i < times; i++) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }
}

/** Dispatch a `keydown` the way the page keymap listens for it. */
export function press(key: string, init: KeyboardEventInit = {}, target: EventTarget = document.body): KeyboardEvent {
  const event = new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...init });
  act(() => {
    target.dispatchEvent(event);
  });
  return event;
}
