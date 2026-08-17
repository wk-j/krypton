import { describe, expect, it } from 'vitest';

import {
  contentRootIsInFocusedWindow,
  isTextEntryTarget,
  paneContentHoldsFocus,
  shouldRetargetContentPaste,
} from './content-focus';

describe('isTextEntryTarget', () => {
  it('accepts editable inputs and textareas', () => {
    expect(isTextEntryTarget({ tagName: 'INPUT' })).toBe(true);
    expect(isTextEntryTarget({ tagName: 'textarea' })).toBe(true);
  });

  it('rejects read-only or disabled fields', () => {
    expect(isTextEntryTarget({ tagName: 'INPUT', readOnly: true })).toBe(false);
    expect(isTextEntryTarget({ tagName: 'TEXTAREA', disabled: true })).toBe(false);
  });

  it('accepts contenteditable hosts', () => {
    expect(isTextEntryTarget({ isContentEditable: true })).toBe(true);
    expect(isTextEntryTarget({ tagName: 'DIV', isContentEditable: false })).toBe(false);
  });
});

describe('paneContentHoldsFocus', () => {
  it('is true only when active is inside the root', () => {
    const inside = {};
    const root = { contains: (node: unknown) => node === inside };
    expect(paneContentHoldsFocus(root, inside)).toBe(true);
    expect(paneContentHoldsFocus(root, {})).toBe(false);
    expect(paneContentHoldsFocus(root, null)).toBe(false);
  });
});

describe('contentRootIsInFocusedWindow', () => {
  it('follows the compositor focused-window class', () => {
    expect(contentRootIsInFocusedWindow({ closest: (sel) => (sel === '.krypton-window--focused' ? {} : null) })).toBe(true);
    expect(contentRootIsInFocusedWindow({ closest: () => null })).toBe(false);
  });
});

describe('shouldRetargetContentPaste', () => {
  const focused = { contains: (node: unknown) => node === 'in-view' };

  it('retargets paste that landed outside the compositor-focused view', () => {
    expect(shouldRetargetContentPaste({
      modeIsNormal: true,
      quickTerminalVisible: false,
      focusedViewRoot: focused,
      eventTarget: 'other-view',
    })).toBe(true);
  });

  it('leaves paste alone when it already landed in the focused view', () => {
    expect(shouldRetargetContentPaste({
      modeIsNormal: true,
      quickTerminalVisible: false,
      focusedViewRoot: focused,
      eventTarget: 'in-view',
    })).toBe(false);
  });

  it('does not steal from a real text field or overlay mode', () => {
    expect(shouldRetargetContentPaste({
      modeIsNormal: true,
      quickTerminalVisible: false,
      focusedViewRoot: focused,
      eventTarget: { tagName: 'INPUT' },
    })).toBe(false);
    expect(shouldRetargetContentPaste({
      modeIsNormal: false,
      quickTerminalVisible: false,
      focusedViewRoot: focused,
      eventTarget: 'other-view',
    })).toBe(false);
    expect(shouldRetargetContentPaste({
      modeIsNormal: true,
      quickTerminalVisible: true,
      focusedViewRoot: focused,
      eventTarget: 'other-view',
    })).toBe(false);
  });
});
