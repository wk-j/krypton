# Workspace Backgrounds — Implementation Spec

> Status: Implemented — native smoke verification pending
> Date: 2026-11-13
> Milestone: Workspace — appearance management

## Problem

Krypton has no dedicated place to choose, import, preview, or manage the background behind its windows. Users currently see the OS desktop through the transparent native shell. A background preference must not change the OS wallpaper, terminal colours, or window transparency.

## Solution

Add a keyboard-first **Backgrounds** content view, opened with **Leader A** or the command palette's **Open Backgrounds**. It contains a background library beside a preview and appearance controls. Selection and adjustment preview locally; **Apply** saves the base background. **Restore Desktop** restores today's appearance and disables the event override.

Add exactly one opt-in event rule as the pilot: **Needs permission**. A real ACP permission request awaiting the human temporarily crossfades to a user-selected background; when the last such request clears, fade back to the saved base. No working, completion, error, question, or focus-change rules ship in the pilot. The earlier three-rule mockup is illustrative, not the pilot's scope.

V1 targets the one workspace surface currently implemented by `Compositor`. Preferences are app-wide and survive restarts, not per project, Git worktree, terminal window, or layout. The pilot watches **all live Harness lanes**, including hidden tabs; there is no scope selector or priority editor. Do not introduce named-workspace management merely to store backgrounds.

## Research

- `src/styles/window.css` paints `.krypton-workspace` transparent; `index.html` keeps both document roots transparent. Windows use `--mat-screen` and xterm's background is transparent. A background behind the workspace can therefore show through existing screens without changing their opacity.
- `src/theme.ts` and `src-tauri/src/theme.rs` expose only `workspace.background` and `blur`; neither is consumed by the workspace renderer. Spec 0010 additionally documents `image` / `image_opacity`, but those fields do not exist. Treat that section as historical/unimplemented, not an existing wallpaper pipeline.
- `WorkspacesConfig`, `workspace-recovery.ts`, and `workspace_state.rs` contain no persistent named-workspace identity. The workspace snapshot is backend memory for WebContent recovery, not restart persistence. Some older architecture/data-flow sections describe planned workspace switching, not callable commands in the current tree.
- `ConnectedComputersContentView` provides a useful precedent: a lazy-loaded, app-owned management tab, opened or focused rather than duplicated. `ContentView`, `createContentTab`, `Component`, and `reconcile()` already provide the required host and DOM lifetimes.
- Fire and the music visualizer independently prepend canvases inside the workspace. A background must not depend on remaining its first child. Mount its renderer immediately **before** `#krypton-workspace` as a body sibling instead.
- The asset protocol already allows `$HOME/**`; owned background files under `~/.config/krypton/` can use `convertFileSrc()` without expanding that scope. No loopback routes, network fetches, or native child webviews are necessary.
- A browser file input supplies `File` bytes, not a dependable absolute path. Its `accept` attribute is only a hint; Rust must validate imports. Existing `save_temp_image` demonstrates base64 IPC but its temporary storage and validation are insufficient for this library.
- The `image` crate supports bounded dimensions and thumbnails. Its allocation limit is best-effort, not a hard process-memory guarantee: also bound encoded input, dimensions and pixel count, and serialize imports. Use only the required codecs; verify the chosen release and lockfile against the project's declared MSRV.
- DESIGN.md mandates faceplate controls, no backdrop blur, no decorative ambient animation, and transparent document roots. This feature needs a narrow amendment allowing user background content beneath the faceplate and a one-shot event crossfade, not raster textures or ambient animation in chrome.
- `AcpHarnessView.addPermission()` queues requests after built-in auto-policy checks, but some mode/turn policies immediately drain that queue. `needs_permission` also covers questions and remote-command approvals, so it is not an exact permission trigger. `view:program-status` currently describes terminal OSC records, not ACP approval queues. Add a small read-only content-view subscription instead of guessing from status words or parsing transcript rows.
- WAAPI `Animation.cancel()` removes its keyframe effects, clears animation time and rejects a pending `finished` promise with `AbortError`. Capture presentation opacity before cancelling, explicitly preserve that value and handle cancelled promises; cancellation alone is not a seamless reverse.

## Prior Art

| App | Implementation | Notes |
|-----|----------------|-------|
| iTerm2 | Settings → Profiles → Window → Background Image; Stretch, Tile, Scale to Fill, Scale to Fit, and a blending slider. Can also rotate a folder of images. | GUI image selection and readable blending are familiar; profile/pane placement is different from a Krypton workspace. |
| WezTerm | Lua `background` lists image, solid-colour and gradient layers; supports Cover/Contain, alignment, opacity and brightness. | Broad configuration API, not a background-library management view; animated/parallax layers are deliberately excluded here. |

**Krypton delta:** a first-class in-app manager, keyboard entry and navigation, a saved static base with one temporary permission override, explicit Apply, and a transparent-desktop escape hatch. Keep familiar fill/fit/position controls, not a general multi-layer compositor. Neither consulted guide documents this approval-triggered background rule or a dedicated background-manager keyboard shortcut.

## Affected Files

| File | Change |
|------|--------|
| `src/backgrounds/types.ts`, `model.ts`, `model.test.ts` (new) | Shared shapes, preset definitions, validation, dirty-state and render-style helpers. |
| `src/backgrounds/store.ts`, `store.test.ts` (new) | Single frontend authority for loading, serial mutations and persisted state. |
| `src/backgrounds/renderer.ts`, `renderer.test.ts` (new) | Two-slot base/permission backdrop, cancel-safe one-shot fades and reusable local preview. |
| `src/backgrounds/permission-controller.ts`, `permission-controller.test.ts` (new) | Aggregate exact pending-permission counts, stable activation and temporary override lifetime. |
| `src/backgrounds/view.ts`, `view.test.ts`, `backgrounds.css` (new) | Dedicated `ContentView`, keyed library entries, preview, controls, import and delete confirmation. |
| `src/types.ts`, `src/compositor.ts` | Add `backgrounds` content type and optional pending-permission read/subscribe hooks; own store/renderer/controller; register every mounted view and dispose subscriptions on removal. Open or focus the manager, including its pane in a split. |
| `src/acp/acp-harness-view.ts` and relevant tests | Expose exact ACP permission-queue counts and notify on queue/lane lifecycle changes, without changing policy, wire adapters, or transcript rendering. |
| `src/main.ts` | Initialize background state before creating/restoring terminal windows; failure cannot block startup. |
| `src/command-palette.ts`, `src/input-router.ts`, `src/which-key.ts` and relevant tests | Global `backgrounds.open` action, Leader A routing and Apps legend (`images` icon already exists). |
| `src/workspace-recovery.ts`, `src/workspace-recovery.test.ts` | Recognize `backgrounds` leaves so one cannot invalidate the entire saved layout. |
| `src-tauri/src/backgrounds.rs`, `backgrounds_tests.rs` (new), `src-tauri/src/lib.rs` | Bounded library IO, image import, atomic persistence, managed state and IPC registration. |
| `src-tauri/Cargo.toml`, `src-tauri/Cargo.lock` | Add minimal `image` codec/thumbnail support; pin the compatible WebP decoder; no dialog plugin. |
| `docs/0002-functional-requirements.md`, `0004-architecture.md`, `0005-data-flow.md`, `0006-configuration.md`, `0010-theme-specification.md`, `0072-acp-harness-view.md`, `DESIGN.md`, `docs/README.md` | Document actual scope, permission subscription, persistence, layering, keys and image/crossfade exceptions; correct related unimplemented theme claims. |

## Design

### View and interaction

- Tab title: `BACKGROUNDS // workspace`; `PaneContentType = 'backgrounds'`. One manager at a time; reopening focuses its actual hosting window, tab and pane. No native window or browser page.
- Header: **Backgrounds**, **Your workspace. A quieter canvas.**, and **Import image** with its shared `i` keycap.
- Follow the approved reference hierarchy: a narrow **Library** sidebar on the left; a broad **Preview** on the right, with **Appearance** directly beneath it and a compact **Event Rules** section below that. There are no equal-sized dashboard columns or Base/Needs permission editing modes. The library column is `clamp(11em, 19cqw, 16em)`; its rows scroll independently, so 100 imported images cannot stretch the view.
- The view is a flex child with explicit zero minimum dimensions inside the real `.krypton-pane`. The main details region is labelled, focusable and independently scrollable; the outer editor is also keyboard-focusable for the stacked layout. **Apply**, **Return to base**, **Restore Desktop**, conditional **Remove image** and **Refresh** occupy a bottom strip aligned with the editor; Apply is always the normal-background action. **Save rule** belongs to the Event Rules header, not a mode-dependent bottom action. Status/keyboard hints remain below the strip. An 8em editor minimum and outer-scroll fallback keep controls reachable when configured text and native chrome leave insufficient height.
- Manager body, headings, labels, selector legends, readouts, hints and preview sample inherit `--krypton-font-size` from `[font] size` (14px fallback), with the configured font family. Do not reintroduce fixed 10–13px text or use the smaller chrome-font size for these controls. Shared shortcut caps retain the standard `kbd` recipe.
- Library: searchable thumbnail list, grouped **Built-in** / **Your images**. A selected row and an **Applied** text/LED indicator are separate states. Preserve row identities with `reconcile()`; selecting updates only the old/new selection and detail pane.
- Built-ins, in order: **Desktop / Transparent**; **Graphite** (`#101218`); **Midnight** (`#060a12`); **Paper** (`#e6eff6`); **Custom colour**; **Dusk** (`#101828` → `#302338`, 135°); **Ocean** (`#06131e` → `#12383b`, 135°). No bundled photographic assets or licensing dependency.
- Custom colour accepts validated `#RRGGBB` text with a swatch. Gradient presets are fixed in v1, not a general gradient editor. These colours are user-content swatches, never chrome tokens.
- Preview: fill the main editor width, with height bounded by `clamp(11em, 32cqh, 22em)` against the management pane. Do not constrain it to the full webview's aspect ratio or shrink it into a small dashboard card. Show the selected name, image dimensions when applicable, and **Base background**, **Preview only** or **Permission preview** state. A static sample terminal uses current screen/material tokens and configured text; it is not a real terminal, screenshot or live Harness. Desktop remains transparent, with explanatory text rather than a fake desktop image.
- Controls directly beneath the preview: **Fill / Fit / Stretch** (`cover` / `contain` / stretched `100% 100%`); a position disclosure showing the current anchor and a nine-position selector; opacity 0–100%; dimming 0–90%. Choosing an anchor closes its disclosure. Image-only fit/anchor controls are hidden and disabled for non-images; Desktop and gradients explicitly direct the user to **Custom colour** in the library rather than silently losing colour editing. Directional anchor glyphs retain full position names through accessible labels/tooltips, avoiding tiny text or wrapped multi-line keys. Numeric readouts use content-box sizing, three digit widths plus 1.5em for native steppers, and separate padding/borders, so the app's global border-box reset cannot clip `100`. The hex field reserves 8ch of content space for the full `#RRGGBB` and breathing room. Neither field shrinks as a flex item; both keep the configured font. Defaults: Fill, centre, 100% opacity, 20% dimming for images; opaque, undimmed colour/gradient presets. Desktop disables all appearance controls and renders nothing.
- Fit letterboxing and transparent image pixels reveal the actual desktop; there is no implicit opaque underlay. Dimming is a black scrim over the chosen content; opacity applies to content and scrim together. It never dims terminal text, fire, music, or chrome.
- Sliders include numeric inputs/readouts and native arrow-key operation. Fit and anchor are keyboard-operable selector keys, not native select menus. All controls have labels, visible focus and `<kbd>` hints from `src/ui/kbd.ts`.
- Adjustment is an unsaved local draft, visibly **Not applied**. Navigating to another library item discards the previous draft; nothing changes on the actual workspace until Apply. Closing the view discards drafts; no rollback state or hidden live-preview lease is needed.
- Apply is explicit and remains in the view. It is disabled for invalid values or while saving. Success marks the base Applied only after disk persistence; failure leaves existing state and the draft intact. Saving a new base while permission is pending keeps the override visible; append **Needs permission active** to the saved-base readout.
- **Restore Desktop** atomically saves the transparent base and disables the permission rule; it preserves the library and configured target. **Remove image** requires inline confirmation; built-ins cannot be removed. Removing the base image resets the base to Desktop; removing a rule target clears/disables that rule in the same manifest transaction. Confirmation states either or both consequences. Never touch the source file.
- Below 700px of pane width, stack the bounded 20em Library above the same Preview → Appearance → Event Rules hierarchy. The outer editor scrolls, and the bottom actions use full width. Long names wrap outside the clamped library/menu rows; never shrink configured text to force fit. All operations remain reachable without maximizing, with outer-view scrolling as the short-pane fallback.

### Pilot event rule — Needs permission

- Why first: an approval request requires the human before work can continue. Working/completion cosmetics can wait. Ship one fixed rule, not a rules engine, generic trigger registry, arbitrary conditions, or rule creation/deletion UI.
- **Event Rules** has one compact **Needs permission → background → 280ms fade → Try it** row, with an enabled checkbox, explicit **On/Off** (and **Unsaved** when dirty), and **Save rule** in the section header. Before a valid target is chosen, enabled and Try it are disabled. Default is off with no target; selecting/importing a background never enables it automatically.
- The rule owns a target picker offering **Use current preview** and the library choices. A choice copies its full appearance settings into the rule draft; later library selections/adjustments do not change that snapshot. To customise a rule target, adjust the main preview, then choose Use current preview. Opening this picker ends an active simulation so that “current preview” means the visible normal draft. It never changes what the main library is editing. Show the actual background name/colour and swatch, not an invented effect name.
- Normal-background and rule drafts/save actions are independent. Apply saves only the normal background; Save rule saves only its target/enabled state. A base save preserves dirty rule edits; a rule save preserves normal edits, including an incomplete colour being typed. Return to base restores only the saved normal background while preserving unsaved rule edits. Refresh, Restore Desktop and successful removal explicitly reload both drafts; choosing another library item replaces only the normal draft. Clean rule drafts follow newer committed state; removed asset references are repaired.
- Try it runs the enter/return transition **inside the preview only**, even when the saved rule is disabled. A **Return to base** preview key clears the simulation. Neither publishes a real permission, changes the live backdrop, calls ACP, nor persists anything. Escape clears a simulation before leaving a control or closing the view.
- Scope is fixed and labelled **All Harness lanes**: all mounted ACP Harness views in the primary webview, including hidden tabs and remote Harnesses hosted there. This only observes permission queues already held locally; it runs no remote command. Pi-agent, terminal OSC reports, questions/elicitation, filesystem write-review cards, connected-computer command approvals, and Live Assist's mirrored copy do not count in this pilot.
- Predicate: sum `lane.pendingPermissions.length` across non-disposed Harness views **after synchronous auto-policy dispatch**. Coalesce notifications in one microtask and require a positive total to remain for **150ms** before activating. An auto-approval that never waits does not flash. A question sharing the `needs_permission` label must not activate it. Do not infer from logs, text, generic view state, or model output.
- Multiple qualifying requests still produce one override. Resolving one does not restore the base while another remains. Approve/reject/cancel, failed-response requeue, turn cleanup, lane close/restart, and view disposal all re-publish the real count. Status equality must not suppress queue notifications. The background observer never resolves a request or changes permission policy.
- When the total becomes zero, cancel pending activation and fade back immediately (no minimum display hold or completion timer). Disabling the saved rule also returns to base. Focus/tab/layout changes alone do not alter the result. Opening/closing Backgrounds cannot acknowledge a permission.
- Runtime selection is simply `enabled && eligiblePermissions ? target : base`. Only configuration is persistent; counts, activation timers and effective overrides are not. Startup/WebContent recovery re-derives them from live views. There is no event priority because the pilot has one trigger.
- The rule is presentation-only. Existing permission cards, keyboard resolution, footer attention and fire remain authoritative and unchanged; a missing target/renderer failure must not hide or block those controls.

### Data structures

```ts
export type BackgroundSource =
  | { kind: 'desktop' }
  | { kind: 'solid'; color: string }
  | { kind: 'gradient'; from: string; to: string; angle: number }
  | { kind: 'image'; assetId: string };
export interface BackgroundChoice {
  source: BackgroundSource;
  fit: 'cover' | 'contain' | 'stretch';
  anchor: 'top-left' | 'top' | 'top-right' | 'left' | 'center'
    | 'right' | 'bottom-left' | 'bottom' | 'bottom-right';
  opacity: number; // 0–1
  dimming: number; // 0–0.9
}
export interface BackgroundAsset {
  id: string; // SHA-256 of imported source bytes, 64 lowercase hex characters
  name: string; // original basename only, plain text, max 120 characters
  imagePath: string; // read-only projection of the owned file, never a write target
  thumbnailPath: string;
  width: number;
  height: number;
  bytes: number;
}
export interface PermissionBackgroundRule {
  enabled: boolean;
  target: BackgroundChoice | null;
  // Fixed 280ms fade; no persisted duration, scope or trigger list in the pilot.
}
export interface BackgroundState {
  version: 1;
  revision: string; // hash of persisted manifest; empty-manifest hash on first run
  active: BackgroundChoice; // saved base, NEVER overwritten by an event
  permissionRule: PermissionBackgroundRule;
  assets: readonly BackgroundAsset[];
}
// Add these optional hooks to ContentView; other views contribute zero.
export interface ContentView {
  getPendingPermissionCount?(): number;
  onPendingPermissionCountChange?(cb: () => void): () => void;
}
```

Rust mirrors persisted shapes with tagged serde enums and camelCase serialization. Missing `permissionRule` defaults to `{ enabled: false, target: null }` without a write on read; an enabled rule requires a valid target. Validate enum values, strict hex colours, finite numbers and asset membership at the backend boundary. Gradient angles are limited to the shipped presets. Persist only relative owned filenames; derive absolute display paths in responses. Do not accept arbitrary CSS or URLs.

`AcpHarnessView` owns the two hooks, returning the sum of its lanes' ACP permission queues. Subscribe returns an unsubscribe function; controller registration subscribes **then** reads the initial count. Notify after queue mutations, queue replacement/clear and lane removal, not just lane status transitions. Coalescing reads final queue state after policy dispatch, without calling `render()` or mutating sealed transcript rows. `Compositor` registers hooks when any content view mounts and unregisters them on pane/tab/window close; no global Harness directory or wire-protocol change is needed.

### Persistence and imports

- App-owned root: `~/.config/krypton/backgrounds/`; `library.json` plus `images/<sha256>.<ext>` and `thumbnails/<sha256>.png`. No write to `krypton.toml`, theme files, repo files, or workspace recovery snapshots.
- Missing manifest means Desktop plus an empty imported library; reads do not create files. First explicit mutation creates the root. Preserve a malformed/unsupported manifest and show a repair error; do not silently overwrite it. In that case startup renders Desktop and the manager disables mutations until the file is repaired or moved aside externally.
- One image per import through an accessible `<input type="file">`, accepting PNG/JPEG/WebP. The input hands bytes to the dedicated import command, not an arbitrary filesystem path. Reset its value so selecting the same file again works. Cancellation does nothing; no drag/drop or paste path in v1.
- Rust bounds base64 text before decoding; decoded source cap **10 MiB**. Sniff bytes, use only the supported decoders, reject animated PNG/WebP (and all GIF/SVG/video), enforce nonzero dimensions at most **8192 per axis** and **16,777,216 pixels**, and use decoder allocation limits in addition. Perform decode/thumbnail/IO on `spawn_blocking`, one import at a time. Unsupported/corrupt/oversized files produce an actionable message without a library mutation.
- Preserve the validated original bytes as the owned image; generate a maximum-320px thumbnail with consistent EXIF orientation. Do not retain the original absolute source path. Dedupe by SHA-256; importing a duplicate selects the existing item. Cap imported entries at **100**; do not silently drop older images.
- Write asset/thumbnail temporary files then rename before committing a new manifest. Serialize mutations under one backend manager; check expected revision before committing. Atomically replace the manifest via a unique temporary sibling file, flush, then rename; only then update in-memory state. On failure keep the last committed state. Crash leftovers are unreferenced, never active; later explicit import may reuse verified matching content.
- Delete commits the new manifest first, then removes only its now-unreferenced owned files. Cleanup failure is reported as a warning, not a failed state commit. Resolve paths beneath the owned root, reject symlink escapes, and never derive delete paths from display names or frontend paths.
- Persist the base choice and permission-rule configuration only, not preview drafts, per-image editing history, pending-permission counts or the runtime override. Saved imported assets remain available after their original files are moved/deleted.

### API / commands

Every command returns `Result<T, String>`; frontend calls catch errors. Commands are local Tauri IPC only, not Harness/control tools. The frontend has one shared store; no polling or new backend event is needed.

| Command | Arguments | Result |
|---------|-----------|--------|
| `background_list` | none | `BackgroundState` |
| `background_import` | `name: string, dataBase64: string, expectedRevision: string` | `{ state: BackgroundState, assetId: string }` |
| `background_apply` | `choice: BackgroundChoice, expectedRevision: string` | `BackgroundState` (base only; rule unchanged) |
| `background_rule_save` | `rule: PermissionBackgroundRule, expectedRevision: string` | `BackgroundState` |
| `background_reset` | `expectedRevision: string` | `BackgroundState` (Desktop base + rule disabled; target retained) |
| `background_remove` | `assetId: string, expectedRevision: string` | `{ state: BackgroundState, cleanupWarning: string \| null }` |

A stale revision returns an explicit conflict; refetch and ask the user to retry, never silently overwrite. No file watcher or automatic disk re-read on config reload. Provide a Refresh action in the manager to reload its manifest.

### Renderer and lifecycle

- `Compositor` owns one `BackgroundStore`, one `PermissionBackgroundController` and one `WorkspaceBackground`; closing the manager never disposes them. Store initialization is awaited before the first window opens, with a caught-error Desktop fallback. Subscribe before initial state application; teardown unsubscribes view hooks and removes only owned nodes.
- Mount `.krypton-workspace-background` immediately before `#krypton-workspace` in `<body>`, fixed/inset 0, z-index 0, `pointer-events: none`, `aria-hidden="true"`. It paints before the workspace's existing positioned windows and z-index-0 effect canvases. Do not add negative z-indices or change existing window/layout z-order. Verify this ordering in WKWebView, including Depth/Stage/Wheel transforms.
- Inside it, keep at most two presentation slots: saved base and permission target. Each slot has its own content/scrim and appearance-opacity group; a separate outer slot opacity performs the transition. Never set opacity/filter on the workspace ancestor. Desktop is an empty slot; hide the whole backdrop only when no slot has visible content.
- Use one shared style-mapping function for the real backdrop and the preview. Only image sources have sizing/anchor controls. Image Apply and Save rule preload/decode their owned assets before persistence; then update the appropriate slot. Generation guards include state revision and desired override state, so stale decodes cannot activate an already-cleared permission. A missing base falls back to Desktop; a missing permission target falls back to the current base and reports the problem without rewriting the manifest or retrying on every queue event. Recheck on explicit Refresh/Save or the next startup.
- Enter/exit use **280ms ease-out**, WAAPI opacity only: base weight `1 - w`, target weight `w`, where `w` moves between 0 and 1. Read the current presentation weight before cancelling/reversing an in-flight transition; reverse from that weight without flashing, restarting at an endpoint, stacking animations or allocating a third slot. Identical desired state is a no-op. Changing a saved target while already active atomically replaces its decoded content; do not momentarily expose the base. Saving a base during an override updates the base slot for the eventual return.
- Reduced motion switches instantly. When the document is hidden, cancel animations and settle to the latest desired endpoint; on return recompute, never replay historical events. Remove animation handlers and activation/preview timers on disposal; a late completion cannot restore stale state. A local Try it has a separate renderer/controller and never feeds the actual workspace.
- Theme changes update the preview's sample materials but never replace the active source. Window opacity remains `[visual] opacity`, including the light-scheme floor. No theme `url()` tokens or asset-scope expansion.
- Obsolete preview/source decodes are aborted on state replacement/disposal, clearing their image source and settling cancelled loads without waiting for decoder completion. Identical base/target choices settle without an unnecessary fade; an empty Desktop override hides the backdrop only after its fade completes.
- No perpetual rAF loop, WebGL/canvas background renderer, blur or automatic rotation. The permission rule's one-shot fade is the only background animation; static base selection remains an explicit swap. Decode selected images on demand, keep only the base and configured override ready, lazy-load small library thumbnails, and release preview references on selection/dispose. Cap list size at the backend's 100 imported entries, so no unbounded list or full-image-per-row decode.
- Add `backgrounds` to recovery's known content types. Like other management content views, a reloaded manager becomes the existing recovery notice; the independently persisted background reloads normally. Do not introduce generic content-view resurrection.
- New CSS stays inside `krypton.component` / `krypton.scheme`, scoped to owned blocks; use `--mat-*`, flat rows, full selection tint, no L-brackets or left-edge rails. Raster images are background content, never faceplate materials.

### Data flow

1. Startup → `background_list` → validated shared store → workspace renderer; missing preferences retain transparent Desktop.
2. Leader A / palette → open or focus Backgrounds → select preset/image → local preview and draft controls only.
3. Import key → file input → bounded base64 IPC → Rust validates/copies/thumbnails → atomic manifest → store updates → select new image without applying.
4. Apply base / Save rule → preload image if needed → `background_apply` / `background_rule_save` with revision → atomic save → store/controller update → mark the saved choice, without persisting the effective override.
5. A human-pending ACP permission queue changes → owning view notifies → microtask aggregate → positive for 150ms → enabled rule crossfades to target in 280ms. No request contents leave that view.
6. Approve/reject/cancel/cleanup → re-read counts → last request clears → reverse/fade to the current saved base. View removal unregisters its contribution; no model turn or filesystem write occurs.
7. Restore Desktop → `background_reset` → Desktop base and rule disabled atomically → immediate transparent escape hatch. Remove confirmation → `background_remove` → base/rule references repaired atomically → store/controller update → owned-file cleanup; source untouched.

### Keybindings

| Key | Context | Action |
|-----|---------|--------|
| `Cmd+P`, then `Shift+A` | Global leader | Open/focus Backgrounds; bare `a` stays AI Agent. `A` is reserved but currently unbound. |
| `Cmd+Shift+P` → Open Backgrounds | Commands palette | Same opener. |
| `j` / `k`, `↑` / `↓` | Library | Previous/next item, preview only. |
| `/`, then `Esc` | Manager | Focus filter; Escape leaves the filter without closing. |
| `i` | Non-editable manager focus | Import one image. |
| `Enter` | Library | Apply the normal-background draft. |
| `Cmd+Enter` | Manager, including controls | Apply the valid normal-background draft; never implicitly save the rule. |
| `ArrowUp` / `ArrowDown`, `Home` / `End`, `Enter`, `Escape` | Open rule target picker | Navigate choices, select with Enter, or dismiss with Escape and restore target-button focus. Main-library navigation is suppressed while open. |
| `Tab` / `Shift+Tab`, arrows / Space | Controls | Native focus traversal, numeric adjustment and selector operation; Save rule is a separate button. PageDown remains native in the focusable details/editor scroll regions. |
| `p` | Non-editable manager focus | Try the draft permission target locally; disabled without a valid target. Escape / Return to base clears simulation first. |
| `r` | Non-editable manager focus | Refresh manifest; discard local draft. |
| `D` | Non-editable manager focus | Restore Desktop, retaining library. |
| `Delete` | Selected imported image | Open confirmation; `Enter` confirms, `Esc` cancels. |
| `q` / `Esc` | Non-editable manager focus | Close view; discard draft. Editable fields retain normal typing and Escape first returns focus to the library. |

Global shortcuts pass through; manager character keys never consume text-field input. Close routes through `closeContentViewHost`, preserving unrelated panes/tabs/PTys.

### Configuration

No new TOML keys. The UI owns `backgrounds/library.json`; manual theme/config reload does not reset it. Update spec 0010 to mark its old `[workspace] image`, `image_opacity`, `background` and `blur` description as unimplemented legacy design, with this manager as the supported route. Do not enable blur or silently migrate fields the app never parsed.

## Verification

- Pure tests: choice/rule validation, disabled/null defaults, presets, sizing/anchor/dimming mapping, independent base/rule dirty state, strict colour/ID validation and non-finite number rejection. Missing `permissionRule` stays backward-readable without a disk write.
- Rust tests with temporary directories: PNG/JPEG/WebP import, MIME/extension spoofing, animation rejection, corruption, input/dimension/pixel caps, orientation, duplicate and 100-entry limit, atomic failure, stale revision, malformed/unknown-version manifest preservation, restart persistence, active-image removal, path/symlink escape and source-file preservation.
- DOM tests: open/focus singleton including split panes; independent Selected/Applied states; preview never mutates backdrop; keyboard and editable-focus guards; Apply success/failure, import cancellation, delete confirmation, lazy thumbnails, stale async completion, row identity and listener/observer disposal.
- Pilot tests: single request activates only after 150ms; synchronous auto-approval and shorter waits never flash; two requests/two Harnesses cause one override; resolving one cannot clear another; questions, OSC state, fs-write cards and computer approvals do not trigger; hidden lanes count; closing/restarting/disposal drops contributions; failed permission replies requeue correctly. Assert queue changes notify even if lane status is unchanged and no observer repaints sealed rows or changes approval policy.
- Transition tests: reverse at partial opacity, repeated positive counts, pending clear during decode, rapid enter/leave, target/base save while active, identical target/base, transparent target, missing/deleted assets, disable/reset, reduced motion, hidden-document settling and dispose. No orphan animations/timers; neither real events nor local Try it write runtime state to disk.
- Integration tests: palette/leader/which-key agreement; recovery accepts the new content type without losing terminal layouts; config/theme reload leaves base/rule choices unchanged. Base save during an override preserves override; removing a target disables/clears only its rule; Restore Desktop disables the rule atomically.
- Native smoke: Desktop → image → colour → Desktop, app restart and WebContent reload; cancelled picker; moved source; missing owned asset; portrait/ultrawide/Retina viewport; dark/light schemes; all six layouts; fire/music above the background, text selectable and keys responsive; no macOS desktop change or blur/freeze regression. With two real Harness lanes, hold a permission open, approve/reject/cancel it, try a second pending request, close its view mid-fade, and verify return to the saved base. A browser fixture alone does not verify WKWebView/native picker or approval lifecycle behaviour.
- Run `npm run check`, targeted Vitest suites, `npm run build`, `cargo fmt -- --check`, relevant `cargo test`, `cargo clippy` with no new warnings, and DESIGN.md lint. Complete `/perf-checklist` for this view; target <16ms navigation, no idle background loop, and no retained full-image thumbnails after close.

## Implementation verification and performance audit

Implemented under `src/backgrounds/` and `src-tauri/src/backgrounds.rs`. The image dependency is pinned to `image 0.25.5` with only PNG/JPEG/WebP codecs; `image-webp 0.2.0` is pinned because 0.2.1+ declares Rust 1.80.1, above this app's 1.77.2 floor. The installed compiler used for checks was 1.95.0; a complete 1.77.2 toolchain build was not run. WebP RIFF ranges, metadata chunk lengths, extended canvas **and encoded frame** dimensions are checked before decoder allocation, including rejection of contradictory canvas/frame sizes.

Validation completed:
- `npm run check`, `npm run build`, and the full Vitest suite: **3,838 tests / 316 files**, including **44 background tests / 6 files**. Coverage includes reference hierarchy, absence of editing modes, independent saves/snapshots, failed save and Refresh behaviour, invalid in-progress colour preservation, picker keyboard handling/disposal, source-specific controls and bottom actions.
- Backend verification from the initial implementation (Rust unchanged by the reference-layout correction): `cargo test --lib` **679 passing**, including **11 background-library tests**; `cargo clippy -- -D warnings` passes.
- Changed Rust modules pass `rustfmt --check`. Repository-wide `cargo fmt -- --check` is blocked by existing formatting in `src-tauri/src/connected_computers.rs`; `cargo clippy --all-targets -- -D warnings` is blocked by the existing boolean-assert test warning at `src-tauri/src/timeline.rs:3244`. Neither unrelated file was changed.
- `npx @google/design.md lint DESIGN.md`: no errors/warnings. `git diff --check` passes.
- Earlier renderer coverage remains valid: preview isolation, opt-in rule saving, preview-only Try it, real partial WAAPI fade/reversal, base-save-during-override and atomic Desktop reset. The original isolated sizing fixture omitted the app's global reset and real pane/footer host; it did not establish screen fit. The intermediate equal-column layout was rejected and is not the approved design.

Reference-restoration checks use **`src/styles/index.css`**, the actual manager/store/renderer, and the window → perspective → content → tab → pane → footer host, with **memory-only mocked IPC**. **36 WebKit/Chromium cases** cover 2604×1000, 1440×1100, 1000×600, 600×600, 400×480 and 400×320 viewports at configured **14/18/24px**. They verify the narrow-sidebar/broad-preview hierarchy (stacked below 700px), Appearance then Event Rules, no editing modes or duplicate selection flow, configured computed text sizes, complete `100` plus stepper allowance and complete hex text, no horizontal overflow, focus-reachable Apply/Return/Restore Desktop/Save rule, and image fit/anchor disclosure operation. All cases include 100 long-name fixture images plus 7 presets: 107 keyed rows remain, with the selected image visible inside the bounded list. Navigation-handler plus forced-layout timing across the matrix was **2.0ms worst p95 / 9.0ms max**, with zero idle animations. Tiny generated images do not establish large-image decode performance or native full-frame latency.

Additional browser-delivered keyboard/click flows pass in **both WebKit and Chromium**: customise colour/opacity → copy current preview into rule → enable and Save rule without applying a base → Apply another base without changing the rule snapshot → preview-only Try it/Escape → Return to base without IPC → Restore Desktop retaining target/disabling rule. Native browser PageDown scrolls the actual focusable details region. Screenshots of the restored hierarchy at 14px and 18px were compared with the approved reference. Browser WebKit is **not** a native Tauri/WKWebView, OS-picker or real Harness-lifecycle verification.

`/perf-checklist backgrounds` source audit below; paths are relative to `src/backgrounds/`. **22 PASS / 11 N/A**, no source-audit failures. Native idle CPU, full-frame latency and 60fps scrolling remain unmeasured rather than claimed as passes.

| Check | Status | Evidence |
|-------|--------|----------|
| 1.1 No hot-path innerHTML | PASS | `view.ts:LibraryRow`, `renderList()`, `renderControls()`: dependency-diffed rows and in-place controls. |
| 1.2 Bounded list | PASS | Maximum 107 small library rows; backend caps imports at 100, thumbnails are lazy. An open rule menu has at most 108 choices and is released on close. |
| 1.3 Minimal/batched DOM mutation | PASS | `view.ts:renderList()` uses the shared keyed reconciler; controls/nodes survive updates. |
| 1.4 No forced reflow loops | PASS | `view.ts:revealSelection()` scrolls only the selected node after updates/focus, not inside the row diff. Browser timing above includes forced layout. |
| 1.5 Static node queries | PASS | `view.ts:renderControls()`, `onKeyDown()` use bounded static queries, never live collections. |
| 2.1 Listener teardown | PASS | `view.ts:dispose()`, `renderer.ts:dispose()`: abort controllers, store unsubscribe, menu/image and DOM cleanup. |
| 2.2 Anonymous listener lifetime | PASS | Slider/filter/root click and document pointerdown/focusin callbacks all use the view's abort signal. |
| 2.3 Timer teardown | PASS | `permission-controller.ts:23–39,47–54`: one activation timer, cancelled at zero/dispose; preview has no timer. |
| 2.4 ResizeObserver teardown | N/A | No observer or resize listener; pane/container sizing is CSS-only. |
| 2.5 Event delegation | PASS | One root click handler routes library, rule menu and action clicks; no per-row/option listeners. |
| 3.1 No backdrop blur | PASS | `backgrounds.css` contains no blur/filter. |
| 3.2 No static layer promotion | PASS | `backgrounds.css` declares no will-change. |
| 3.3 WAAPI transitions | PASS | `renderer.ts:145–169`: at most two opacity effects, no rAF loop. |
| 3.4 Hidden state settles | PASS | `renderer.ts:85–88,145+`: cancel and settle on hidden/reduced motion. |
| 3.5 Interaction duration | PASS | Fixed 280ms; static selection swaps without animation. |
| 4.1 Detached node disposal | PASS | `view.ts:dispose()`: dispose both keyed lists and preview, close/clear menu and rule swatch, remove root. |
| 4.2 Large-data release | PASS | Row disposal clears thumbnail src; renderer aborts decodes/clears readiness on replacement and disposal. Shared metadata is bounded, no full-image list data. |
| 4.3 Late callback guards | PASS | Renderer generation/disposal guards; `view.ts:run()`, import continuation and `notice()` suppress late disposed-view UI. |
| 4.4 Tauri event unlisten | N/A | Store uses request/response IPC only; no Tauri event subscription. |
| 4.5 Worker termination | N/A | No worker; image decode is async and Rust IO/decode is blocking-pool work. |
| 5.1 Window positioning | N/A | Manager is ordinary pane content; no new window-positioning implementation. |
| 5.2 Resize read/write separation | PASS | No imperative resize measurement/writes. `backgrounds.css` sizes columns, broad preview and scrollports with CSS/container units. |
| 5.3 Contained scrolling | PASS | Bounded library and focusable details scrollports, stacked-editor scrolling, bottom commit strip and bounded shortcut foot; outer-scroll fallback for insufficient height. |
| 5.4 Layout containment | PASS | Root has layout/style containment and a size-query container; zero grid/flex minimums and overflow bound the library independently of its 107 rows. |
| 5.5 Font loading | N/A | Inherits the app's font tokens; adds no font request. |
| 6.1 Navigation budget | PASS | Actual WebKit/Chromium handler + forced layout: worst p95 2.0ms / max 9.0ms in the 36-case matrix; native full-frame latency remains unmeasured. |
| 6.2 Native idle CPU <1% | N/A | No native CPU measurement; structurally no polling/ambient loop and fixture idle has zero active animations. |
| 6.3 Native scrolling 60fps | N/A | Not measured in WKWebView; bounded native overflow verified in browser fixture. |
| 6.4 Non-blocking preview/import | PASS | `renderer.ts:8–38` async cancellable decode; `store.ts:67+` async FileReader base64; Rust import serialized off main thread. |
| 7.1 Streaming frame gating | N/A | Manager owns no streaming transcript. |
| 7.2 Streaming append | N/A | No streaming content; list diff is keyed. |
| 7.3 Conditional stream follow | N/A | No stream-follow behaviour; only explicit selection scrolls. |
| 7.4 Stream counters | N/A | No streamed counters; readouts update only on user/store changes. |

**Still required before a native verification claim:** run the native smoke checklist above, particularly two real Harness lanes, permission approve/reject/cancel/requeue and closing a lane mid-fade, OS image picker, all six layouts with fire/music, moved/missing source/owned assets, restart and WebContent recovery. Browser fixtures and unit tests cannot establish those platform behaviours.

## Edge Cases

Import/save failures leave applied state intact. Closing while an import completes may retain its successfully committed library item, never apply it or recreate disposed DOM. Repeated open requests share one in-flight opener. Repeated Apply/Remove/import requests are serialized, not double-committed. Unknown schema/corrupt state never blocks terminals. Disk-full cleanup failure never deletes a user source. Backgrounds are local-only even when the focused Harness/project is on SSH. Live Assist and browser-served pages do not inherit the main workspace backdrop.

## Open Questions

No unresolved design decisions. The implemented pilot is **ACP Needs permission**, with all-Harness scope, opt-in activation and a fixed 280ms fade. Native verification remains listed above; adding further event types requires a later spec revision.

## Out of Scope

OS wallpaper control; per-project/worktree/window or named-workspace assignment; changing terminal colours/opacity; remote images/download galleries; animated/video/HTML backgrounds; slideshows, parallax, blur; custom gradient editing; background sync/export; Harness agent tools; a second native window; generic view restoration or workspace management. Deferred event work: working/done/error/focus/music triggers; questions, terminal OSC and other approval surfaces; configurable scope, priorities/durations, multiple rules or a generic rule engine. The one permission crossfade is included, not ambient animation.

## Resources

- [iTerm2 Window Profile Preferences](https://iterm2.com/documentation-preferences-profiles-window.html) — image placement modes and blending; also documents folder rotation deliberately excluded here.
- [WezTerm `background`](https://wezterm.org/config/lua/config/background.html) — static colour/gradient/image sources, cover/contain, alignment, opacity and brightness; broader layer/parallax model not adopted.
- [MDN: file input](https://developer.mozilla.org/en-US/docs/Web/HTML/Reference/Elements/input/file) — file bytes vs fake paths, cancellation, and `accept` not being validation.
- [`image::Limits`](https://docs.rs/image/latest/image/struct.Limits.html) — strict dimension limits versus best-effort allocation accounting.
- [MDN: `Animation.cancel()`](https://developer.mozilla.org/en-US/docs/Web/API/Animation/cancel) — keyframe removal, time reset and `finished` promise rejection when reversing/discarding a fade.
- [`image` 0.25.5 manifest](https://github.com/image-rs/image/blob/v0.25.5/Cargo.toml) — evidence of minimal codec feature selection and an MSRV-compatible release; re-check transitive resolution during implementation rather than assume latest is compatible.
