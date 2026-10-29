// Spec 341 — how every loopback entry starts: the token sheet first (its layer
// statement must precede every other sheet), then the shell, then the surface.

import './styles/base.css';

import { mountShell } from './kit/shell';
import type { AppShell } from './kit/shell';
import type { SurfaceId } from './surfaces';

export interface PageContext {
  readonly shell: AppShell;
  /** `#lb-main`. Rust-rendered readers arrive with their body already in it. */
  readonly main: HTMLElement;
}

export interface BootOptions {
  /** Overrides the surface title in the shell and the tab. */
  readonly title?: string;
}

export function bootPage(
  surface: SurfaceId,
  mount: (page: PageContext) => void | Promise<void>,
  options: BootOptions = {},
): void {
  const main = document.getElementById('lb-main') ?? document.body.appendChild(document.createElement('main'));
  main.querySelector(':scope > .lb-boot')?.remove();
  const shell = mountShell({ surface, title: options.title });
  Promise.resolve()
    .then(() => mount({ shell, main }))
    .catch((error: unknown) => {
      console.error(`[loopback] ${surface} failed to start`, error);
      const note = document.createElement('p');
      note.className = 'lb-boot';
      note.textContent = `This page failed to start: ${error instanceof Error ? error.message : String(error)}`;
      main.prepend(note);
    });
}
