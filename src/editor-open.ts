import type { Compositor } from './compositor';

export interface HelixOpenTarget {
  path: string;
  line?: number | null;
  col?: number | null;
}

export type HelixOpenResult = 'opened' | 'no-focused-window' | 'create-tab-failed';

/** Open a file in Helix inside a fresh terminal tab in the focused window. */
export async function openInHelixTab(
  compositor: Compositor,
  target: HelixOpenTarget,
): Promise<HelixOpenResult> {
  if (!compositor.hasFocusedWindow()) return 'no-focused-window';

  try {
    const opened = await compositor.openHelixTab(target.path, target.line, target.col);
    return opened ? 'opened' : 'create-tab-failed';
  } catch (e) {
    console.error('[editor-open] openHelixTab failed:', e);
    return 'create-tab-failed';
  }
}
