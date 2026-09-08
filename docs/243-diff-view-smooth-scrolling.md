# Diff View Smooth Keyboard Scrolling — Implementation Spec

> Status: Implemented
> Date: 2026-09-08
> Milestone: Diff View — keyboard navigation polish

## Problem

The Diff view moves its main reading canvas instantly for every keyboard command.
Repeated `j`/`k` input therefore looks stepped, while hunk and long-distance jumps
provide little visual continuity between the old and new reading positions.

## Solution

Give the main Diff canvas one `requestAnimationFrame`-driven vertical scroll path,
matching the proven Vault Viewer behavior. Repeated same-direction keys extend one
mutable target instead of restarting browser smooth scrolling; reversing direction
starts from the currently visible position. Wheel and pointer input remain native,
and reduced-motion users keep the current instant behavior.

## Research

- The main scroll seam is `.krypton-diff__content`. `j`/`k`, `f`/`b`, and `g`/`G`
  currently call `scrollBy` or `scrollTo` with `behavior: 'auto'`; hunk and line
  navigation call `scrollIntoView` with the same behavior.
- CSSOM View requires a new programmatic smooth scroll to abort the one already in
  progress. Repeated keypresses would therefore restart user-agent easing and can
  feel stop-start instead of continuous.
- Vault Viewer already solves this locally with a mutable target, 24% per-frame
  interpolation, a 0.5 px snap threshold, cancellation on wheel/pointer input, and
  an instant `prefers-reduced-motion` branch. Its pure step/target helpers have
  deterministic unit tests.
- Diff's existing scroll-event RAF only updates the focused-hunk marker. It does
  not animate position, and its cached arithmetic is cheap enough to run beside a
  short scroll animation.
- Native CSS `scroll-behavior: smooth` was ruled out because timing is user-agent
  defined and repeated calls abort earlier motion. A new shared utility was also
  ruled out for now: two consumers do not justify refactoring the stable Vault
  implementation during a Diff-only change.

## Prior Art

| App | Implementation | Relevance |
|-----|----------------|-----------|
| VS Code | Optional `editor.smoothScrolling` animates page, find-result, definition, and wheel movement | Smooth movement helps retain location across both short and structural jumps |
| IntelliJ IDEA | Smooth scrolling moves UI pixel-by-pixel and exposes animation duration/easing controls | Confirms precision and animation are valid alternative reading modes |
| Krypton Vault Viewer | Coalesced RAF target for keyboard navigation; native wheel/trackpad; instant reduced-motion fallback | Direct codebase precedent and motion contract |

**Krypton delta:** Diff scrolling is always smooth for main-canvas keyboard
navigation rather than adding configuration. It keeps pointer scrolling and
fast-moving picker/priority previews native so animation never competes with
direct manipulation or selection feedback.

## Affected Files

| File | Change |
|------|--------|
| `src/diff-view.ts` | Add the controlled vertical scroll target/RAF and route main-canvas navigation through it |
| `src/diff-view.test.ts` | Test convergence, exact landing, coalescing, reversal, and clamping |
| `docs/38-diff-view-window.md` | Document smooth keyboard behavior and intentional instant paths |
| `docs/05-data-flow.md` | Record Diff input-to-scroll animation and cancellation flow |
| `docs/README.md` | Index this spec |

## Design

### Data Structures

```ts
private verticalScrollRaf = 0;
private verticalScrollTarget: number | null = null;

export function smoothDiffScrollStep(
  scrollTop: number,
  target: number,
): { scrollTop: number; done: boolean };

export function nextDiffScrollTarget(
  scrollTop: number,
  activeTarget: number | null,
  delta: number,
  max: number,
): number;
```

The motion constants match Vault: interpolation factor `0.24` and snap threshold
`0.5px`. The RAF self-stops after exact landing, so idle CPU remains unchanged.

### API / Commands

No new IPC, public command, configuration, or dependency.

### Data Flow

```text
1. A main-canvas keyboard command resolves a clamped vertical target.
2. Same-direction repeated input extends the active target; reversal uses scrollTop.
3. Reduced motion writes scrollTop immediately and schedules no RAF.
4. Otherwise one RAF advances scrollTop toward the latest target each frame.
5. Exact landing clears the target; no idle animation remains.
6. Wheel/pointer input, content replacement, or disposal cancels the RAF and target.
```

Element jumps calculate their target once from the element and container bounding
rectangles, then use the same animation path. No layout reads occur inside the RAF
step itself.

### Keybindings

| Key | Behavior |
|-----|----------|
| `j` / `k` | Smooth 40 px vertical movement; repeated keys coalesce |
| `f` / `b` | Smooth 90% viewport page movement |
| `g` / `G` | Smooth jump to top / bottom |
| `n` / `N` | Smooth jump to next / previous hunk |
| `}` / `{` | Smooth jump to next / previous high-priority hunk |

Line reveals used by review comments and Review Board navigation center smoothly
when staying in the current file. Switching files first resets the new file to its
restored/top position, then animates only if a line target was requested.

### UI Changes

No DOM or CSS changes. The existing scrollbar and focus marker remain unchanged.

### Configuration

None. The behavior follows the existing Vault convention and the OS-level
`prefers-reduced-motion` setting.

## Edge Cases

- **Rapid same-direction input:** extend the pending target without another RAF.
- **Direction reversal:** discard the old target and move from visible `scrollTop`.
- **Target beyond bounds:** clamp to `0..scrollHeight - clientHeight`.
- **Wheel or pointer input:** cancel keyboard animation before native interaction.
- **Content refresh/file switch:** cancel before replacing DOM or restoring scroll.
- **Reduced motion:** land immediately with no animation.
- **Dispose during animation:** cancel the RAF and remove input listeners.
- **Priority-list live preview:** remain instant so rapid `j`/`k` selection stays
  synchronized with the highlighted range.

## Open Questions

None.

## Out of Scope

- Horizontal `h`/`l` animation across side-by-side panels.
- Changing wheel/trackpad momentum or scrollbar dragging.
- Smooth scrolling inside file, comment, help, or priority overlays.
- A new smooth-scrolling configuration key.
- Refactoring Vault and Diff into a shared scrolling module.

## Resources

- [CSSOM View Module](https://www.w3.org/TR/cssom-view/#scrolling) — specifies that a new smooth scroll aborts an ongoing one and leaves timing user-agent-defined.
- [W3C SCR40](https://www.w3.org/WAI/WCAG21/Techniques/client-side-script/SCR40) — JavaScript animation must honor the user's reduced-motion preference.
- [VS Code 1.16: Smooth scrolling](https://code.visualstudio.com/updates/v1_16#_smooth-scrolling) — editor navigation prior art.
- [IntelliJ IDEA Appearance](https://www.jetbrains.com/help/idea/settings-appearance.html) — pixel-level smooth scrolling and precision-mode prior art.
- [Vault Viewer](../src/vault-view.ts) — Krypton's coalesced keyboard-scroll implementation.
