// Krypton — Command Palette shared types
// Consumed by command-palette.ts and by ContentView implementations that
// contribute contextual actions via ContentView.getPaletteActions?.

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
  section?: PaletteSection;
}

export interface PaletteContext {
  focusedViewId: string | null;
  /** null = terminal pane or no focused view. */
  focusedContentType: PaneContentType | null;
}
