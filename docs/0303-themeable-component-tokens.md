# 303. Themeable Component Tokens

> Status: Draft
> Date: 2026-10-15
> Scope: one additive field on the theme schema (Rust) + its application in `theme.ts` + docs.
> Depends on: [301 — Harness UI Components](./0301-harness-ui-components.md), which gives every component
> a `--acp-*` hook. This spec is what lets a theme file set one.

## Problem

A theme can recolour the whole app but cannot touch one component. `FullTheme`
(`src-tauri/src/theme.rs:21-30`) is a closed struct — `colors`, `chrome`, `focused`, `workspace`, `ui` — so
a custom theme in `~/.config/krypton/themes/*.toml` has no way to say "make the tool card's head amber".
Every component-level appearance decision therefore has to be hard-coded in a stylesheet shipped with the
app, which is why `src/styles/theme-scheme.css` grew **54 selectors reaching into harness internals**
(`:139` onward) just to make light mode work.

## Solution

Add one optional free-form table to the theme TOML:

```toml
[tokens]
"acp-tool-head-fg"      = "#ffd27f"
"acp-tool-output-max-h" = "420px"
"acp-peek-accent"       = "var(--agent-cyan)"
```

Each entry becomes a `--<key>` custom property on `document.documentElement`, applied **after** the ~120
built-in properties so it wins, and resolved by the component that declares the matching
`var(--acp-…, var(--agent-…, <literal>))` chain from spec 301. Overriding one reaches that component's
subtree and nothing else, because custom properties inherit downward only.

No new command, no new keybinding: themes already apply live through the existing palette **Color Theme**
(`set_theme`) and **Reload Config** paths.

## Research

- **The token layer already exists and is already themed.** `theme.ts:329-493` builds the property record,
  including **36 `--agent-*` tokens** derived from the active theme ("DESIGN.amber structure, color from the
  active theme", `:455`), and `setCssProperties` (`:608-617`) writes every entry onto
  `document.documentElement` with `root.setProperty(name, value)`. Appending a user map to that record is a
  three-line change on the frontend.
- **The schema is the blocker, not the pipeline.** `FullTheme` has no `HashMap`; serde rejects nothing but
  also surfaces nothing. `#[serde(default)]` on a new field keeps all existing themes valid — the three
  built-ins (`krypton-dark`, `krypton-light`, `legacy-radiance`) and any user file simply omit it.
- **Per-element overrides already work.** The view sets `--acp-lane-accent` per lane with
  `style.setProperty` (`acp-harness-view.ts:12019,12036,13034`). This spec is the same mechanism one level
  up, at the document root, sourced from a file.
- **`setProperty` is not an injection vector by itself** — it parses a declaration value, never script. The
  residual risk is a value that *fetches*, e.g. `url(http://…)` as a `background-image`, which would leak
  that a theme was loaded. That is cheap to reject outright (see Edge Cases), and the file is already
  user-owned and locally authored.
- **Alternatives considered.** (a) Extend `UiConfig` with a typed `acp_harness` sub-struct: every new
  component token needs a Rust field, a serde rename, and a `theme.ts` line — the same coupling this spec
  exists to remove. (b) A separate `~/.config/krypton/tokens.toml`: a second file to keep in sync with the
  theme that it only makes sense alongside. (c) Let themes ship raw CSS: unbounded, unreviewable, and it
  would let a theme reach into component internals again — exactly the thing spec 301 is undoing.

## Prior Art

| App | Implementation | Notes |
|-----|---------------|-------|
| VS Code | `workbench.colorCustomizations` — a free-form map of ~600 documented keys like `"editorCursor.foreground"`, settable globally or per theme. | Closest model: flat namespaced keys, no schema change per key. Adopted. |
| Zed | `theme.overrides` in `settings.json` patches a named theme's tokens without forking it. | Confirms "override, don't fork" as the right verb. |
| Ghostty | `config` sets a fixed, documented key set; per-widget theming is not exposed. | The closed-schema model Krypton has today, and its ceiling. |
| Neovim | `:highlight` groups — every UI element is a named, user-settable group. | The most granular; the naming discipline is the lesson, not the API. |

**Krypton delta** — one table instead of VS Code's 600 enumerated keys, because the key set is the set of
`--acp-*` hooks the components already declare (spec 302 catalogues them). Unknown keys are accepted and
inert: a theme written for a newer Krypton must not fail to load on an older one.

## Affected Files

| File | Change |
|------|--------|
| `src-tauri/src/theme.rs` | `pub tokens: HashMap<String, String>` on `FullTheme`, `#[serde(default)]`; validate and drop bad entries at load with a `warn!`. |
| `src/theme.ts` | After `themeCssProperties()` builds the record, merge `theme.tokens` with the `--` prefix; `setCssProperties` is unchanged. |
| `src/types.ts` (frontend `FullTheme`) | Mirror the optional `tokens` field. |
| `docs/0006-configuration.md` | Document `[tokens]`, the naming rule, and the rejection list. |
| `docs/0010-theme-specification.md` | Add `[tokens]` to the theme file reference. |
| `src/theme.test.ts` | Known key applied; unknown key applied and inert; rejected value dropped without affecting siblings. |
| `src-tauri/src/theme.rs` tests | Missing table defaults to empty; invalid key/value dropped, rest of the theme loads. |

## Design

### Schema

```rust
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FullTheme {
    pub name: String,
    pub meta: ThemeMeta,
    pub colors: ThemeColors,
    pub chrome: ChromeConfig,
    pub focused: FocusedConfig,
    pub workspace: WorkspaceConfig,
    pub ui: UiConfig,
    /// Spec 303 — free-form component tokens. Key becomes `--<key>`.
    #[serde(default)]
    pub tokens: HashMap<String, String>,
}
```

### Validation (Rust, at load)

A key is kept only if it matches `^[a-z][a-z0-9-]{0,63}$`.
A value is kept only if it is ≤ 256 chars and contains none of `;` `}` `{` `<` `@import` `url(`
`expression(` `image-set(` `--import`.
Rejected entries are dropped individually with `warn!("theme token rejected: {key}")`; the theme still
loads. A theme can therefore never break startup, and never cause a network fetch.

### Application (frontend)

```ts
// theme.ts, after the built-in record is built
for (const [key, value] of Object.entries(theme.tokens ?? {})) {
  props[`--${key}`] = value;
}
```

Order matters and is deliberate: user tokens are merged **last**, so `--agent-text` set in `[tokens]` beats
the derived one. `setCssProperties` (`:608-617`) then writes the merged record unchanged.

### Data Flow

```
1. User edits ~/.config/krypton/themes/amber-tools.toml, adds [tokens]
2. Palette → Color Theme (set_theme) or Reload Config
3. Rust loads the TOML, drops invalid token entries with a warn!, returns FullTheme
4. theme.ts merges tokens into the property record (last wins)
5. setCssProperties writes every --* onto document.documentElement
6. .acp-harness__tool resolves --tool-head-fg → --acp-tool-head-fg (now set) and repaints
7. No restart, no re-render call: the change is pure CSS custom-property invalidation
```

Step 7 is why this is cheap: no component is told anything. The browser re-resolves `var()` and repaints
only the subtrees that reference the changed property — which is exactly the isolation spec 301 bought.

### Configuration

```toml
# ~/.config/krypton/themes/amber-tools.toml
[tokens]
"acp-tool-head-fg" = "#ffd27f"
"acp-peek-accent"  = "var(--agent-cyan)"
```

| Rule | Value |
|---|---|
| Key charset | `^[a-z][a-z0-9-]{0,63}$`; rendered as `--<key>` |
| Namespace convention | `acp-*` harness components, `vault-*` vault, `krypton-*` global; unenforced, documented |
| Unknown key | Applied, inert. Forward-compatible by design. |
| Precedence | After all built-in properties; before per-element `style.setProperty` (which still wins) |

## Edge Cases

- **Key collides with a built-in** (`"krypton-accent"`) — allowed, and it wins. That is the documented way
  to override a derived colour, and it is why the merge is last.
- **Value references a property that does not exist** — `var()` falls through to the component's literal
  fallback, which spec 301 requires every chain to have.
- **Circular reference** (`a: var(--b)`, `b: var(--a)`) — CSS resolves both to the guaranteed-invalid value
  and the fallback applies. No loop, no crash.
- **Value tries to fetch** (`url(http://…)`) — rejected at load by the value filter, with a `warn!`.
- **Theme file from a newer Krypton** — unknown keys are inert; the theme loads.
- **Theme switched at runtime** — `setCssProperties` rewrites the whole record, so a token present in the
  old theme and absent in the new one is not left behind only if the record is *replaced*, not merged.
  `setCssProperties` must therefore clear previously-applied user token names before writing the new set;
  the built-in names are always present so they need no clearing.
- **Remote (ssh) harness** — themes are local presentation state; unchanged.

## Open Questions

None blocking. The one judgement call is accepting unknown keys instead of validating against a manifest of
known `--acp-*` hooks. Decided: accept. A manifest would have to be regenerated whenever a component adds a
tunable, and a theme that names a token a future version introduces should not fail today.

## Out of Scope

- A settings UI or theme editor. Tokens are edited in the TOML file, like every other theme value.
- Per-lane, per-window, or per-project token overrides.
- Letting a theme ship raw CSS, selectors, fonts, or assets.
- Enumerating and documenting every `--acp-*` hook. Spec 302 is the component catalogue; the hooks live
  with their components.
- Any change to how components are built, placed, or rendered — that is spec 301.

## Resources

- [VS Code `workbench.colorCustomizations`](https://code.visualstudio.com/api/references/theme-color) — flat namespaced override map; the model for `[tokens]`.
- [Zed theme overrides](https://zed.dev/docs/themes) — override a named theme without forking it.
- [MDN — Using CSS custom properties](https://developer.mozilla.org/en-US/docs/Web/CSS/CSS_cascading_variables/Using_CSS_custom_properties) — inheritance, `var()` fallback chains, and invalid-at-computed-value-time behaviour used in Edge Cases.
- [CSS Custom Properties for Cascading Variables Level 1 — §Syntax](https://drafts.csswg.org/css-variables/#syntax) — custom-property values are an arbitrary token stream, which is why the filter has to sit at load time and `setProperty` alone is not the control.
