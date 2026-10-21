// Krypton — File Manager modal key handlers (spec 317): confirm, prompt,
// filter and search. Moved verbatim from the old view.

import type { FileManagerState } from './state';

export interface ModeCtx {
  readonly state: FileManagerState;
  /** applySort is not needed here; re-run the `/` filter over `state.entries`. */
  refilter(): void;
  renderList(): void;
  renderStatus(): void;
  renderBreadcrumb(): void;
  moveSearchCursor(delta: number): void;
  selectSearchResult(): void;
  scheduleSearchUpdate(): void;
  cancelSearchUpdate(): void;
}

/** Confirmation mode — any key ends it; only `y` runs the action (quirk P11). */
export function handleConfirmKey(ctx: ModeCtx, e: KeyboardEvent): boolean {
  const { state } = ctx;
  if (e.key === 'y') {
    const action = state.confirmAction;
    state.confirmAction = null;
    action?.();
  } else {
    state.confirmAction = null;
    ctx.renderStatus();
  }
  return true;
}

/** Prompt mode — typing into the status bar input. */
export function handlePromptKey(ctx: ModeCtx, e: KeyboardEvent): boolean {
  const { state } = ctx;
  if (!state.prompt) return false;

  if (e.key === 'Escape') {
    state.prompt = null;
    ctx.renderStatus();
    return true;
  }

  if (e.key === 'Enter') {
    const p = state.prompt;
    state.prompt = null;
    p.onSubmit(p.value);
    return true;
  }

  if (e.key === 'Backspace') {
    state.prompt.value = state.prompt.value.slice(0, -1);
  } else if (e.key.length === 1 && !e.ctrlKey && !e.metaKey) {
    state.prompt.value += e.key;
  }

  ctx.renderStatus();
  return true;
}

/** Filter mode — `/` typing. Enter keeps the filter, Escape clears it. */
export function handleFilterKey(ctx: ModeCtx, e: KeyboardEvent): boolean {
  const { state } = ctx;
  if (e.key === 'Escape') {
    state.filterMode = false;
    state.filterText = '';
    ctx.refilter();
    state.cursor = 0;
    state.scrollOffset = 0;
    ctx.renderList();
    ctx.renderStatus();
    return true;
  }

  if (e.key === 'Enter') {
    state.filterMode = false;
    ctx.renderStatus();
    return true;
  }

  if (e.key === 'Backspace') {
    state.filterText = state.filterText.slice(0, -1);
  } else if (e.key.length === 1 && !e.ctrlKey && !e.metaKey) {
    state.filterText += e.key;
  } else {
    return true;
  }

  ctx.refilter();
  state.cursor = 0;
  state.scrollOffset = 0;
  ctx.renderList();
  ctx.renderStatus();
  return true;
}

/** Drop the search pool and leave search mode (Escape and result select). */
export function resetSearch(ctx: ModeCtx): void {
  const { search } = ctx.state;
  search.active = false;
  search.text = '';
  search.pool = [];
  search.poolLower = [];
  search.results = [];
  ctx.cancelSearchUpdate();
}

/** Search mode — `f` fuzzy file search. */
export function handleSearchKey(ctx: ModeCtx, e: KeyboardEvent): boolean {
  const { search } = ctx.state;
  if (e.key === 'Escape') {
    resetSearch(ctx);
    ctx.renderBreadcrumb();
    ctx.renderList();
    ctx.renderStatus();
    return true;
  }

  if (e.key === 'Enter') {
    ctx.selectSearchResult();
    return true;
  }

  if (e.key === 'ArrowDown' || (e.key === 'j' && e.ctrlKey)) {
    ctx.moveSearchCursor(1);
    return true;
  }

  if (e.key === 'ArrowUp' || (e.key === 'k' && e.ctrlKey)) {
    ctx.moveSearchCursor(-1);
    return true;
  }

  if (e.key === 'u' && e.ctrlKey) {
    search.text = '';
    ctx.renderBreadcrumb();
    ctx.scheduleSearchUpdate();
    return true;
  }

  if (e.key === 'Backspace') {
    search.text = search.text.slice(0, -1);
  } else if (e.key.length === 1 && !e.ctrlKey && !e.metaKey) {
    search.text += e.key;
  } else {
    return true;
  }

  // Synchronous: render the typed character immediately so the user sees feedback.
  ctx.renderBreadcrumb();
  // Asynchronous: coalesce burst keystrokes into one filter+render per frame.
  ctx.scheduleSearchUpdate();
  return true;
}
