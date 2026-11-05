// Spec 341 — how every loopback entry starts: the token sheet first (its layer
// statement must precede every other sheet), then the shell, then the surface.
//
// Spec 361: one React root on `#lb-shell` renders the shell and portals the
// page. A page without a Rust body portals into `#lb-main`; a reader's
// `#lb-main` holds the Rust-rendered body React must never own, so its page
// portals into a separate `#lb-page-root` and attaches to that markup instead.

import './styles/base.css';

import { Component, StrictMode } from 'react';
import type { ComponentType, ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { createRoot } from 'react-dom/client';

import { AppShell, ShellProvider } from './kit/shell';
import type { SurfaceId } from './surfaces';

export interface PageProps {
  /** `#lb-main`. Readers: holds the Rust body; React never owns its children. */
  readonly main: HTMLElement;
}

export interface BootOptions {
  /** Overrides the surface title in the shell and the tab. */
  readonly title?: string;
}

interface BoundaryProps {
  readonly surface: SurfaceId;
  readonly main: HTMLElement;
  readonly children?: ReactNode;
}

/** A page that throws while rendering shows the boot note; the shell keeps working. */
class PageBoundary extends Component<BoundaryProps, { failed: boolean }> {
  override state = { failed: false };

  static getDerivedStateFromError(): { failed: boolean } {
    return { failed: true };
  }

  override componentDidCatch(error: unknown): void {
    console.error(`[loopback] ${this.props.surface} failed to start`, error);
    const note = document.createElement('p');
    note.className = 'lb-boot';
    note.textContent = `This page failed to start: ${error instanceof Error ? error.message : String(error)}`;
    this.props.main.prepend(note);
  }

  override render(): ReactNode {
    return this.state.failed ? null : this.props.children;
  }
}

export function bootPage(surface: SurfaceId, Page: ComponentType<PageProps>, options: BootOptions = {}): void {
  const main = document.getElementById('lb-main') ?? document.body.appendChild(document.createElement('main'));
  main.querySelector(':scope > .lb-boot')?.remove();
  let target: HTMLElement = main;
  if (main.childElementCount > 0) {
    target = document.createElement('div');
    target.id = 'lb-page-root';
    document.body.append(target);
  }
  let header = document.getElementById('lb-shell');
  if (!header) {
    header = document.createElement('header');
    header.id = 'lb-shell';
    header.className = 'lb-shell';
    document.body.prepend(header);
  }
  createRoot(header).render(
    <StrictMode>
      <ShellProvider surface={surface} title={options.title}>
        <AppShell />
        <PageBoundary surface={surface} main={main}>
          {createPortal(<Page main={main} />, target)}
        </PageBoundary>
      </ShellProvider>
    </StrictMode>,
  );
}
