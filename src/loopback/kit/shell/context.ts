// Spec 361 — what a page can ask of the shell. `ShellProvider` (./index.tsx)
// supplies it at runtime; tests supply a static value through `ShellContext`.

import { createContext, useContext } from 'react';

import type { NavContext, ProjectEntry, SurfaceDef } from '../../surfaces';

export interface ShellApi {
  readonly surface: SurfaceDef;
  /** The surface label in the bar (the surface title unless a page set one). */
  readonly title: string;
  /** The navigation context; `EMPTY_CONTEXT` until `contextLoaded`. */
  readonly context: NavContext;
  /** False until the first directory/capabilities load finished. */
  readonly contextLoaded: boolean;
  /** The surface label in the bar and the document title (`<title> · Krypton`). */
  setTitle(title: string): void;
  /** Pick a project: a project-scoped page moves to the same surface for it. */
  selectProject(project: ProjectEntry): void;
  /** Reload the navigation context now. */
  refresh(): Promise<void>;
}

export const ShellContext = createContext<ShellApi | null>(null);

export function useShell(): ShellApi {
  const shell = useContext(ShellContext);
  if (!shell) throw new Error('[loopback] useShell() outside ShellProvider');
  return shell;
}
