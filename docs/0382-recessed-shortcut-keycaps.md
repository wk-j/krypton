# Recessed Shortcut Keycaps — Implementation Spec

> Status: Implemented (approved and implemented 2026-11-11)
> Date: 2026-11-11
> Builds on: [369](./0369-keycap-shortcuts.md), [366](./0366-console-faceplate-ui.md), DESIGN.md

## Problem

Raised keyboard shortcut caps give hint bars and help text the visual weight of action buttons. The user wants every shortcut cap to use the existing pressed appearance instead.

## Solution

Use `--mat-key-down` and `--mat-key-sunk` for shortcut caps at rest. This is presentation only: no key is logically held or selected, and no keybinding changes. Keep cap geometry, labels, ink and accessibility semantics unchanged.

## Research

- `src/styles/kbd.css` is shared by the main app and Live Assist. Before this change its cap used `--mat-key` and `--mat-key-raise`.
- The Harness gallery copies that recipe under `.lb-harness__stage kbd`; importing the bare global rule would restyle unrelated loopback pages in the merged bundle.
- Terminal hint labels, image/SVG hint labels, question hotkeys and Live Assist header shortcuts also had raised recipes without using `<kbd>`.
- `materials.css` already supplies pressed gradients and inset shadows for dark and light schemes. No token or theme schema change is needed.
- Ticket action shortcut readouts are already recessed. Which-key labels and generic loopback caps already have no raised shadow.
- Input routing belongs to `InputRouter` (architecture §5.6; data-flow Keyboard Input Routing). This change touches no event path.

## Prior Art

Spec 369 documents Zed, VS Code and GitHub using recognizable keycaps for shortcuts. This change preserves that convention and Krypton's existing cap geometry, but chooses Krypton's existing recessed material instead of a raised face. No new external implementation is needed.

## Affected Files

| File | Change |
| --- | --- |
| `src/styles/kbd.css` | Pressed background and shadow for all semantic shortcut caps |
| `src/loopback/surfaces/harness/harness.css` | Match the scoped production-cap recipe |
| `src/styles/overlays.css` | Recess `.krypton-hint__label` |
| `src/styles/harness-shared.css` | Recess `.acp-harness__image-hint` and `.acp-harness__svg-card-hint` |
| `src/acp/components/question-row/question-row.css` | Recess hotkeys at rest; preserve selected-state ink |
| `src/styles/live-assist.css` | Recess `.live-assist__hide` and `.live-assist__cancel` |
| `DESIGN.md`, `docs/0369-keycap-shortcuts.md` | Update the shortcut appearance contract |
| `docs/README.md` | Index this spec |

## Design

Replace only the background and shadow on the listed shortcut recipes:

```css
background: var(--mat-key-down);
box-shadow: var(--mat-key-sunk);
```

Do not apply `transform: translateY(1px)`: these caps have a permanent recessed appearance, not a keypress animation. Do not add `aria-pressed`, selection classes, JavaScript state or another rendering helper. Leave the question option's selected ink and its actual selection state intact.

Ordinary buttons remain raised, even when their label contains a shortcut. Only the shortcut cap inside them changes. The MIC control in the supplied screenshot is an action button, not a shortcut cap; its current idle/listening/pressed states stay unchanged.

No API, data structure, configuration or keybinding changes.

## Verification

Open production shortcut surfaces in a browser with dark and light material tokens. Check the footer examples from the screenshot (`j`/`k`, `Home`/`End`, brackets and `Esc`), the Harness gallery key-hint bar, question hotkeys and custom hint labels. Compare computed background/shadow with pressed tokens and confirm unchanged cap/row geometry. Confirm a selected question option keeps its distinct ink, and an ordinary action button retains its raised state. Generic loopback caps remain unchanged.

Browser smoke verification used the production `KeyHintBar`, production question fixtures through `HarnessStage`, and the production styles for custom hint labels and Live Assist shortcuts. Dark and light material tokens both produce the pressed face/shadow; measured cap and footer geometry, ink and transforms match the pre-change baseline. Selected-question ink remains distinct, and the MIC action button keeps its raised face. The actual Harness gallery page also passes with its scoped cap recipe; generic loopback caps are unchanged. This verifies browser rendering, not a relaunched native Tauri window or a live theme fetched from the app.

## Edge Cases

- Light scheme uses its existing pressed tokens; no dark-only colors.
- Theme token overrides continue to work through the existing material properties.
- Sealed transcript DOM is not rewritten: the stylesheet changes presentation only.
- Existing recessed ticket shortcut readouts and flat which-key/loopback labels require no conversion.

## Open Questions

None. Approval covers all raised shortcut-cap recipes above, not action-button faces.

## Out of Scope

- Changing keybindings, input routing or logical pressed/selected state.
- Restyling action buttons, dictation controls or lane selectors.
- Adding cap faces to flat which-key labels or changing the loopback design system.
- The ghost-hands keyboard overlay, which visualizes actual keypresses rather than shortcut hints.

## Resources

- `docs/0369-keycap-shortcuts.md` — existing inventory, shared primitive and prior-art research.
- `src/styles/materials.css` — existing dark/light pressed material tokens.
- `DESIGN.md` — distinction between action keys, shortcut caps and flat which-key labels.
- External research: N/A — existing internal material recipes and presentation only.
