// Krypton — Search Palette shared types (spec 349)
// `PaletteAction` / `PaletteContext` are consumed by the Commands scope and by
// ContentView implementations that contribute contextual actions via
// ContentView.getPaletteActions?. The scope types are the contract between the
// SearchPalette overlay and its Commands / Files / Grep tabs.

import type { PaneContentType } from './types';

export type PaletteSection = 'context' | 'static';

export interface PaletteAction {
  /** Stable identity. Must NOT vary with state-dependent labels. Aliased
   *  contextual/static actions must share this id. */
  id: string;
  label: string;
  category: string;
  keybinding?: string;
  execute: () => unknown;
  /** CSS colour painted as a small square before the label (spec 304). */
  swatch?: string;
  section?: PaletteSection;
}

export interface PaletteContext {
  focusedViewId: string | null;
  /** null = terminal pane or no focused view. */
  focusedContentType: PaneContentType | null;
}

/** One tab of the Search Palette. Order on screen: commands, files, grep. */
export type ScopeId = 'commands' | 'files' | 'grep';

/** How a row is accepted: Enter (primary), Ctrl+E, Cmd+Enter. */
export type AcceptHow = 'primary' | 'copy-relative' | 'copy-absolute';

/** One result row. Built per query, so it captures the query it highlights. */
export interface ScopeRow {
  /** 'context' rows sit under the Context header on a zero query. */
  readonly section?: PaletteSection;
  /** Fill the palette-owned row element with this row's content. */
  render(el: HTMLElement): void;
}

export interface ScopeQueryResult {
  rows: ScopeRow[];
  status: string;
  /** The backend is still indexing: the palette queries again shortly. */
  pending: boolean;
}

/** A hint-bar entry. `kind` lets AcceptControl.flash light it up. */
export interface ScopeHint {
  text: string;
  kind?: string;
}

/** What a scope may do to the palette while it accepts a row. */
export interface AcceptControl {
  /** Close without the close sound (the scope plays `execute`). */
  close(): void;
  setStatus(text: string): void;
  /** Flash the selected row and the hint of `kind`; resolves when done. */
  flash(kind: string): Promise<void>;
  playExecute(): void;
}

export interface SearchScope {
  readonly id: ScopeId;
  readonly label: string;
  /** Shortcut shown on the tab ('' when the tab has none). */
  readonly shortcut: string;
  readonly prompt: string;
  readonly placeholder: string;
  readonly hints: readonly ScopeHint[];
  /** Right side of the input row, e.g. the project root. */
  aside(): string;
  /** Forget per-open state; called on every scope each time the palette opens. */
  reset(): void;
  /** Called when the tab becomes active. */
  activate(): Promise<void>;
  query(q: string): Promise<ScopeQueryResult>;
  accept(row: ScopeRow, how: AcceptHow, ctl: AcceptControl): Promise<void>;
  /** The palette registers a callback the scope calls when its data changes. */
  setInvalidate?(cb: () => void): void;
}
