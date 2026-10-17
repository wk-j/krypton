// Krypton — generative UI limits (spec 309 §Limits).
// Every cap is a diagnostic or a runtime stop, never a crash.

export const LIMITS = {
  /** Fence source length. */
  sourceChars: 20_000,
  /** Parser nesting depth. */
  parseDepth: 100,
  /** Interpreter recursion depth. */
  evalDepth: 1_000,
  /** Interpreter steps per evaluation. */
  steps: 200_000,
  /** `UiNode`s produced per evaluation. */
  nodes: 2_000,
  /** Any list a spec produces or iterates. */
  listLength: 1_000,
  /** Any list inside a loaded file (spec 309 phase 2). */
  loadedListLength: 20_000,
  /** Any string a spec produces. */
  stringLength: 100_000,
  /** Declared inputs per spec. */
  inputs: 24,
  /** Composer draft an action may load. */
  draftChars: 4_000,
} as const;

/** Candidate `krypton-ui` fences decorated per assistant transcript item. */
export const UI_MAX_PER_ITEM = 2;

/** Retained panel states per Harness view, LRU. */
export const UI_MAX_PANEL_STATES = 32;
