// Compositor focus vs DOM focus helpers.
// Native paste (Cmd+V) is delivered to document.activeElement. Keyboard
// typing goes through InputRouter to the compositor-focused pane. These
// must stay aligned, and misdirected paste events must be retargeted.

export function isTextEntryTarget(target: unknown): boolean {
  if (target == null || typeof target !== 'object') return false;
  const rec = target as {
    tagName?: string;
    isContentEditable?: boolean;
    readOnly?: boolean;
    disabled?: boolean;
  };
  const tag = typeof rec.tagName === 'string' ? rec.tagName.toUpperCase() : '';
  if (tag === 'INPUT' || tag === 'TEXTAREA') {
    return rec.readOnly !== true && rec.disabled !== true;
  }
  return rec.isContentEditable === true;
}

export function paneContentHoldsFocus(
  root: { contains(node: unknown): boolean },
  active: unknown,
): boolean {
  return active != null && root.contains(active);
}

export function contentRootIsInFocusedWindow(root: { closest(selector: string): unknown }): boolean {
  return root.closest('.krypton-window--focused') != null;
}

/** A summon overlay owns keyboard routing until it closes. The document-level
 *  overlay listener still receives the event after InputRouter returns. */
export function summonOverlayOwnsKeyboard(
  root: { querySelector(selector: string): unknown },
): boolean {
  return root.querySelector('.krypton-review-picker') != null;
}

export function shouldRetargetContentPaste(opts: {
  modeIsNormal: boolean;
  quickTerminalVisible: boolean;
  focusedViewRoot: { contains(node: unknown): boolean } | null;
  eventTarget: unknown;
}): boolean {
  if (!opts.modeIsNormal || opts.quickTerminalVisible || !opts.focusedViewRoot) return false;
  if (isTextEntryTarget(opts.eventTarget)) return false;
  if (opts.eventTarget != null && opts.focusedViewRoot.contains(opts.eventTarget)) return false;
  return true;
}
