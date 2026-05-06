# Contextual Leader Keys — Implementation Spec

> Status: Draft
> Date: 2026-05-06
> Milestone: M4 — Keyboard System & Workspaces

## Problem

Krypton's leader key opens Compositor mode, but second-key dispatch is currently a fixed global switch in `InputRouter`. Content views can handle keys in Normal mode through `ContentView.onKeyDown()`, yet they cannot add focused-view leader actions without hard-coding each case into the global router.

The new system must support both global and focused-context leader actions while preventing global/local key conflicts during development.

## Solution

Add an optional leader-key registry contract to `ContentView`. When Compositor mode receives the second key, `InputRouter` checks the focused view's local leader bindings. If the key belongs to that view and is enabled, the local action runs; if disabled, the app shows unavailable feedback and exits to Normal. If no local binding owns the key, the existing global `handleCompositorKey()` switch runs unchanged.

Global and context keys share one leader layer, but they must never conflict. A new central `leader-keys.ts` module owns canonical key normalization, global reserved-key metadata, and validation helpers. Each view owns and exports its own static local key metadata beside the view implementation. A Vitest test imports global reserved keys plus all local metadata and fails on duplicate or unsupported local keys.

## Research

- Codebase: `ContentView.onKeyDown()` is already the focused-view keyboard extension point for Normal mode. `InputRouter.handleCompositorKey()` is the only second-key leader dispatcher. `WhichKey` already receives focused `PaneContentType`, but current display filtering does not validate or dispatch context keys.
- tmux uses named key tables: root bindings are global, prefix bindings run after the prefix key, and mode tables such as copy-mode override behavior while active. This validates a layered leader-table design.
- VS Code and Zed support context-aware keybindings. Zed uses context precedence, but Krypton v1 deliberately rejects global/local conflicts during development so leader behavior is not state-ambiguous.
- Helix uses minor modes like Space mode and Window mode for scoped command layers. Krypton's Compositor mode is already similar, so extending it with focused-view entries fits the app's modal style.

## Prior Art

| App | Implementation | Notes |
|-----|----------------|-------|
| tmux | Prefix key switches into a `prefix` key table; copy modes use separate mode tables. | Closest terminal prior art for global prefix plus mode-specific bindings. |
| VS Code | Keybindings may include `when` clauses; no clause means global. | Powerful context predicates are too large for this first step. |
| Zed | Keymap groups may include a `context`; focused/lower contexts win over broader contexts. | Krypton differs by rejecting conflicts instead of relying on precedence. |
| Helix | Minor modes such as Space, Window, Goto, and View expose scoped command layers. | Matches Krypton's modal, keyboard-first interaction model. |

**Krypton delta** — Krypton will not add user-configurable context expressions yet. It will expose a simple TypeScript registry interface that content views implement directly. Global/local conflicts are development errors caught by tests, not runtime precedence decisions.

## Affected Files

| File | Change |
|------|--------|
| `src/types.ts` | Add `LeaderKeySpec`, `LeaderKeyBinding`, and optional `getLeaderKeyBindings()` to `ContentView`. |
| `src/leader-keys.ts` | New helper module for canonical key ids, global reserved keys, event normalization, and validation. |
| `src/input-router.ts` | In Compositor mode, dispatch focused-view local bindings before falling back to the existing global switch only when the key is not locally reserved. |
| `src/which-key.ts` | Render enabled focused-view bindings alongside global compositor entries. |
| `src/main.ts` | Pass focused-view leader bindings from `InputRouter` to `WhichKey` through the existing mode-change path. |
| `src/markdown-view.ts` | Export static Markdown leader metadata and add a non-conflicting Markdown-local shortcut for link hint mode. |
| `src/leader-keys.test.ts` | Vitest coverage that fails if any exported local key conflicts with global reserved keys or another local key. |
| `docs/PROGRESS.md` | Add recent landing after implementation. |
| `docs/02-functional-requirements.md` | Document contextual leader support and dev-time conflict prevention. |
| `docs/04-architecture.md` | Update Input Router / mode system section. |
| `docs/05-data-flow.md` | Update Compositor mode flow. |

## Design

### Data Structures

```ts
export type LeaderKeyId = string;

export interface LeaderKeySpec {
  /** Canonical key id, e.g. "o", "O", "[", "Alt+h". */
  key: LeaderKeyId;
  label: string;
  group?: string;
  effect?: 'important' | 'danger';
}

export interface LeaderKeyBinding extends LeaderKeySpec {
  run(): void | Promise<void>;
  isEnabled?(): boolean;
  disabledReason?(): string;
}

export interface ContentView {
  // existing fields...
  getLeaderKeyBindings?(): LeaderKeyBinding[];
}
```

`LeaderKeyId` is a canonical display-oriented key string. V1 supports literal one-key bindings and simple modifier chords already used by the leader table:

- lowercase letter: `o`
- shifted letter: `O`
- punctuation: `[`, `]`, `\`, `-`, `;`
- alt chord: `Alt+h`

Ranges such as `1-9` are display-only and are not allowed for local view bindings in v1.

Each view with local leader keys exports static metadata for test-time validation:

```ts
export const MARKDOWN_LEADER_KEYS: readonly LeaderKeySpec[] = [
  { key: ';', label: 'Link Hints', group: 'Markdown', effect: 'important' },
];
```

The view maps the static specs to executable bindings:

```ts
getLeaderKeyBindings(): LeaderKeyBinding[] {
  return MARKDOWN_LEADER_KEYS.map((spec) => ({
    ...spec,
    run: () => this.enterLinkHintMode(),
    isEnabled: () => this.hasVisibleLinks(),
    disabledReason: () => 'No visible links',
  }));
}
```

### Data Flow

```
1. User presses Leader (`Cmd+P`)
2. InputRouter enters Mode.Compositor
3. InputRouter gathers focused-view leader bindings, if any
4. WhichKey renders global compositor entries plus enabled focused-view entries
5. User presses the second key
6. InputRouter normalizes the KeyboardEvent to LeaderKeyId
7. If a focused-view binding owns the key:
   a. If enabled, run the binding and return to Normal
   b. If disabled, show disabledReason() or "Action unavailable" and return to Normal
8. If no local binding owns the key, existing global handleCompositorKey() runs
```

### Development-Time Conflict Check

```
1. `leader-keys.ts` exports `GLOBAL_LEADER_RESERVED_KEYS`
2. Each view with local leader keys exports `*_LEADER_KEYS`
3. `leader-keys.test.ts` imports all local leader metadata
4. Test fails if:
   - any local key appears in `GLOBAL_LEADER_RESERVED_KEYS`
   - any local key appears in another local view's exported metadata
   - any local metadata uses unsupported range syntax
```

The runtime may keep a defensive duplicate guard for console diagnostics, but correctness depends on the development-time test.

### Global Reserved Keys

Global reserved keys include every valid second key in Compositor mode, not only final actions. That includes:

```txt
h j k l
1 2 3 4 5 6 7 8 9
n x p P f z r s m M v V t T w [ ] \ - g G o d D a A e E i I y Y b u q c C
Alt+h Alt+j Alt+k Alt+l Alt+x
```

The existing global switch remains the dispatch implementation for this spec. Moving global actions into a registry is explicitly out of scope for v1.

### Precedence

There is no precedence rule in v1 because global and local leader keys must not conflict. A local key is owned by the focused view only after it passes development-time conflict validation. A local key never falls back to a global action based on runtime state.

### Keybindings

| Key | Context | Action |
|-----|---------|--------|
| Existing global leader key | Terminal / no content view | Existing global Compositor action |
| Existing global leader key | Content view with no matching local binding | Existing global Compositor action |
| View-declared non-conflicting key | Focused content view | View-owned action |

Initial view-owned binding:

| Key | Context | Action |
|-----|---------|--------|
| `Leader ;` | Markdown view | Enter Markdown link hint mode, matching the existing Normal-mode `o` action |

## Edge Cases

- Async view action rejects: log the error, show a notification if available through the view's existing notifier pattern, and return to Normal so the router does not get stuck.
- Disabled local action: hidden from which-key; if triggered anyway, show `disabledReason()` or a generic unavailable notification and return to Normal. It does not fall back to global.
- View is disposed while an async leader action is running: no special cancellation in this spec; views already own their lifecycle cleanup.
- Quick Terminal visible: unchanged. Quick Terminal owns Normal-mode key focus and does not expose a content view.
- Terminal panes: no content view exists, so global leader keys behave exactly as today.
- Conflicting keys: development-time test failure. Runtime conflict handling is defensive only and must not be relied on.

## Open Questions

None.

## Out of Scope

- Refactoring the existing global `handleCompositorKey()` switch into a registry.
- Full TOML keybinding customization or user-facing conflict detection.
- Multi-key leader sequences beyond the existing Leader + one key model.
- Command palette registration for every view-local command.

## Resources

- [tmux Getting Started — Key bindings](https://github.com/tmux/tmux/wiki/Getting-Started) — named key tables and prefix-table model.
- [VS Code Keyboard Shortcuts](https://code.visualstudio.com/docs/getstarted/keybindings) — `when` clause context model for shortcuts.
- [Zed Key Bindings](https://zed.dev/docs/key-bindings) — context-scoped bindings and precedence rules.
- [Helix Keymap](https://docs.helix-editor.com/keymap.html) — modal minor modes such as Space and Window mode.
