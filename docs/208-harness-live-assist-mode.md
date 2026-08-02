# Harness Live Assist Window — Implementation Spec

> Status: Implemented
> Date: 2026-08-01
> Milestone: M-ACP — Harness convergence

## Problem

The ACP Harness is available only inside Krypton's fullscreen workspace. A user
working in another macOS application must switch back to Krypton before reading
or prompting a lane. Summoning a compact assistant must not resize, move,
reparent content from, focus a tab in, or otherwise disturb the main Krypton
window.

The assistant also must not be a squeezed copy of the Harness view. It needs a
purpose-built, compact interaction surface while preserving the running Harness
as the only owner of ACP clients, lanes, transcripts, permissions, and drafts.

## Solution

Add a macOS-only auxiliary Tauri window named `live-assist`, toggled globally
with `Ctrl+Shift+A`. It has its own HTML entry point, TypeScript controller,
transcript projection, composer, keyboard handling, and CSS. It is created
lazily, hidden rather than destroyed, placed near the top of the pointer's
current display, and raised to AppKit's popup window level on the active
Space, including beside a full-screen application.

The existing `AcpHarnessView` remains mounted and unchanged in the main window.
Live Assist talks to that view through a trusted in-process request/event bridge
that reuses the typed Harness Control operations and stream. It never creates an
ACP client, duplicates a lane, reparents Harness DOM, or changes main-window
geometry or focus.

This is a narrow exception to Krypton's single-native-window rule: the main
workspace remains the sole native terminal/compositor window; `live-assist` is
the only auxiliary application window and cannot host terminals, tabs, panes,
or a full Harness view.

## Research

- The current main window is a transparent, borderless, manually sized
  fullscreen webview. Raising it while another app is frontmost would create a
  screen-sized input surface; resizing it would visibly disrupt the workspace.
- `AcpHarnessView` is the frontend state authority. Its existing Control layer
  already exposes `lane.list`, `lane.status`, `lane.transcript`, `lane.send`,
  `lane.cancel`, `permission.list`, and `permission.resolve`.
- `ControlServer::dispatch()` already provides a typed Rust-to-main-webview
  request/reply path, and its broadcast stream already carries ordered lane
  chunks, status, permissions, lifecycle events, stops, and errors. An internal
  Live Assist adapter can reuse both without loopback HTTP, bearer tokens, or a
  second observer implementation.
- Tauri supports independent `WebviewWindow` instances, always-on-top, focus,
  visibility, position, size, and all-workspaces behavior. A dedicated
  `live-assist.html` Vite entry isolates the assistant from `main.ts`.
- Tauri's macOS always-on-top maps to a floating level. `CanJoinAllSpaces` alone
  does not guarantee presence beside another app's native full-screen window;
  AppKit's `FullScreenAuxiliary` supplies that behavior. Zed combines these flags
  with popup level 101 for topmost popup windows, which Live Assist adopts.
- The active display is not reliably Krypton's current monitor while another app
  is frontmost. The pointer's display is the deterministic target, with current,
  primary, and first-available fallbacks.
- ChatGPT's companion window and Raycast AI Chat establish a global summon,
  independent compact window, conversation continuity, and always-on-top
  precedent. Neither requires mutating its main application window.

### Alternatives Rejected

- **Resize the main Krypton window:** explicitly violates the product contract
  and disrupts the user's workspace.
- **Reparent `AcpHarnessView`:** couples two presentation modes, moves existing
  focus/DOM state, and is not a separate assistant UI.
- **Instantiate another `AcpHarnessView` or ACP client:** duplicates runtime
  ownership and risks conflicting prompts, permissions, and session lifecycle.
- **Call loopback HTTP/SSE from the auxiliary webview:** adds token/CORS and
  server-configuration failure modes to a trusted in-process feature.
- **Keep the fullscreen window and draw a small overlay:** visually compact but
  still intercepts input across the display.
- **Create a harness automatically when none is open:** would mutate the main
  Krypton workspace, contrary to the non-interference requirement.
- **Use `Option+Space`:** likely to collide with ChatGPT; `Ctrl+Shift+A` follows
  Krypton's existing global shortcut family.

## Prior Art

| App | Relevant behavior | Krypton adoption |
|-----|-------------------|------------------|
| ChatGPT for macOS | Global shortcut opens/refocuses a companion window that stays in front | Global summon, independent window, focus, continuity |
| Raycast AI Chat | Separate multi-turn chat with optional Always on Top and background streaming | Compact keyboard-first chat and persistent stream |
| Zed | Popup windows use floating level plus all-Spaces/full-screen auxiliary behavior | AppKit Space and level behavior |
| Krypton Control API | Typed commands and one frontend-authored ordered event stream | Single state authority and shared operation contract |

**Krypton delta:** Live Assist is not the Harness in another layout. It is a
small client of the running Harness, with a deliberately reduced interface.

## Product Contract

- “Active workspace” means the current macOS Space on the display containing the
  pointer, not a Krypton virtual workspace.
- “Topmost” means popup-level above normal application windows and ordinary
  floating palettes. System UI, security prompts, the menu bar, and
  screen-saver-level windows may remain above it.
- The assistant takes keyboard focus while visible. `Esc` or the global shortcut
  hides it and macOS returns focus according to normal window ordering.
- Opening, using, and hiding Live Assist never changes the main Krypton window's
  position, size, Space membership, selected workspace, tab, pane, or DOM.
- The full Harness remains the sole owner of ACP state. Live Assist holds only a
  selected lane id, rendered snapshots, a local draft, scroll state, and pending
  request ids.
- A local assistant draft is intentionally independent from the full Harness
  composer draft. Sending clears only the Live Assist draft.
- If no Harness is open, the window still appears but shows a read-only empty
  state. It does not create or focus a Harness behind the user.

## Affected Files

| File | Change |
|------|--------|
| `src-tauri/src/live_assist.rs` | Create/show/hide/place the auxiliary window, apply AppKit flags, internal dispatch, event forwarding, and tests |
| `src-tauri/src/control.rs` | Add trusted `live_assist` caller and return the stamped event used by the internal mirror |
| `src-tauri/src/commands.rs` | Register the internal Live Assist dispatch command |
| `src-tauri/src/lib.rs` | Manage window state, register `Ctrl+Shift+A`, route panic recovery, and prevent auxiliary close from exiting the app |
| `src-tauri/Cargo.toml` | Add macOS-targeted direct `objc2` / `objc2-app-kit` dependencies already present transitively |
| `live-assist.html` | Minimal standalone DOM entry for the auxiliary webview |
| `src/live-assist-main.ts` | Initialize theme, controller, listeners, and keyboard handling only for `live-assist` |
| `src/acp/live-assist-client.ts` | Typed internal operations, snapshot refresh, ordered stream reduction, reconnect/resync |
| `src/acp/live-assist-view.ts` | Purpose-built header, lane switcher, transcript, permission prompt, composer, and empty/error states |
| `src/acp/live-assist-types.ts` | Narrow snapshot, transcript, permission, stream, and error contracts |
| `src/styles/live-assist.css` | Independent assistant layout, responsive states, focus, motion, and reduced motion |
| `vite.config.ts` | Build `index.html` and `live-assist.html` as explicit inputs |
| `src/acp/control-bridge.ts` | Add non-mutating `live_assist.bootstrap` selection/snapshot operation |
| `src/acp/control-types.ts` | Accept the trusted `live_assist` caller source |
| `src/acp/acp-harness-view.ts` | Expose the minimal bootstrap fields; no presentation or DOM changes |
| `AGENTS.md`, `CLAUDE.md` | Document the one narrow auxiliary-window exception |
| `docs/02-functional-requirements.md` | Add macOS Live Assist requirements |
| `docs/04-architecture.md` | Record the auxiliary window boundary and one-state-authority rule |
| `docs/05-data-flow.md` | Document summon, command, stream, resync, and dismissal flows |
| `docs/72-acp-harness-view.md` | Document the Harness-side projection contract |
| `docs/175-harness-web-control-api.md` | Document internal reuse without expanding the public HTTP API |
| `docs/PROGRESS.md` | Record completion after implementation and validation |

## Design

### Native Window

`LiveAssistState` tracks the last valid physical frame. All native lifecycle
operations execute on AppKit's main thread, which serializes competing shortcut
and command-palette toggles. Rust creates the window on first summon with:

- label `live-assist`, URL `live-assist.html`
- `840 × 620` logical px, minimum `560 × 420`, resizable
- decorations off, transparent background, shadow on, hidden initially
- no taskbar/Dock entry beyond Krypton's existing application identity
- close request converted to hide; destruction occurs only at app shutdown

Showing performs one serialized transaction:

1. Resolve the pointer monitor, then current, primary, first available.
2. Reuse the last frame if it intersects that monitor; otherwise center it
   horizontally and vertically in the work area and cap it inside 16 px margins.
3. Add `CanJoinAllSpaces | FullScreenAuxiliary`, set popup level, show,
   unminimize, and focus.
4. Emit `live-assist-shown` to its webview after page readiness.
5. On failure, hide the auxiliary window and leave the main window untouched.

Hiding records the assistant frame, hides it, and retains its DOM/draft. It does
not clear always-on-top or Space flags while hidden because they affect no visible
surface. Panic recovery hides Live Assist first, then runs the existing main
window recovery unchanged.

### Trusted Internal Bridge

The assistant never imports `AcpHarnessView` or `harness-directory`; those
objects exist only in the main webview JavaScript context.

`live_assist_dispatch(operationId, operation, params)` calls the same
`ControlServer::dispatch()` used by authenticated external controllers, with a
Rust-authored `ControlCaller { source: "live_assist" }`. The existing main-window
`control-bridge.ts` receives the request and routes it to the owning Harness.
Only the allowlisted Live Assist operations are accepted by the Rust command:

- reads: `live_assist.bootstrap`, `lane.status`, `lane.transcript`,
  `permission.list`
- writes: `lane.send`, `lane.cancel`, `permission.resolve`

The public `/control/v1` capabilities and authorization do not change.

`ControlServer::publish()` returns its sequence-stamped event after broadcasting
it. While `live-assist` is visible, Rust also emits that exact envelope to the
window as `live-assist-stream`; hidden windows receive no stream work and
re-bootstrap when shown. There is no second Harness observer. The assistant
tracks `seq`; a gap, window re-show, lane change, lifecycle event, stop, or error
triggers snapshot refresh. High-frequency chunks update the projection
immediately, while the next snapshot remains authoritative.

### Bootstrap and Selection

`live_assist.bootstrap` returns all live lane summaries plus a suggested lane:

1. Keep the assistant's last selected globally unique display name if live.
2. Otherwise use the active lane of the most recently focused Harness.
3. Otherwise use the first non-stopped lane in stable Harness/lane order.
4. Return `suggestedLane: null` and an empty list when no Harness is open.

The operation reads compositor/Harness state and never changes focus or active
lane in the full Harness. Switching lanes in Live Assist changes only its local
selection, then pulls that lane's status, transcript, and permissions.

### Data Flow

1. macOS receives `Ctrl+Shift+A` while any application is focused.
2. Rust lazily creates or retrieves `live-assist`, positions and shows it.
3. The assistant invokes `live_assist.bootstrap`, selects a lane, and pulls its
   status, transcript, and permission queue.
4. A submitted prompt invokes `lane.send`; busy lanes use the Harness's existing
   bounded queue semantics. Cancel and permission actions use their existing
   authoritative operations.
5. The owning `AcpHarnessView` updates as normal and publishes its normal stream.
6. Rust forwards the same stamped events to the assistant; it reduces matching
   lane events and re-snapshots at authoritative boundaries.
7. `Esc`, a second shortcut, or a close request hides only `live-assist`.

### Keybindings

| Key | Action |
|-----|--------|
| `Ctrl+Shift+A` | Globally toggle Live Assist |
| `Esc` | Close child surface first; otherwise hide Live Assist |
| `Cmd+Enter` | Send the local draft; queue when the lane is busy |
| `Cmd+.` | Cancel the selected lane's current turn |
| `Cmd+1…9` | Select a visible lane |
| `Cmd+[` / `Cmd+]` | Select previous/next lane |
| `A` / `R` | Accept/reject the oldest permission when its prompt has focus |

The main command palette gains `Toggle Harness Live Assist` for use while
Krypton is focused if global shortcut registration conflicts.

### Purpose-Built UI

The assistant is a compact command surface, not a full Harness replica:

- **Header (36 px):** `LIVE ASSIST`, project basename, selected lane/backend,
  text status, queue count, and `⌃⇧A hide`.
- **Lane strip (optional):** compact text tabs only when more than one live lane
  exists; overflow is keyboard-scrollable and never becomes the Harness lane rail.
- **Transcript:** a simple bounded tail projection that keeps user and assistant
  conversation visible while grouping consecutive thought, tool, and file
  activity into collapsed `ACTIVITY · N steps` disclosures. The original rows
  remain available through native keyboard-expandable details; system, error,
  permission, shell, artifact, and lane-mail rows stay visible by default. It
  owns its DOM and rendering.
- **Permission dock:** oldest request, tool label, explicit Accept/Reject actions;
  no permission-mode or policy editing in v1.
- **Composer:** independent multiline draft, busy/queued state, send and cancel.
  No images, mentions, command palette, memory, orchestration, review, artifact
  gallery, plan rail, lane creation, model selection, or settings.
- **Empty state:** `NO LIVE HARNESS` and concise guidance to open one in Krypton;
  no action that focuses or mutates the main window.

The shell uses a flat near-opaque `rgba(6, 10, 18, 0.96)` background, one full
1 px themed border plus inset hairline, 4 px geometry, no blur/glass, and no
left accent rails. Color never carries status alone. Entrance is 180 ms opacity
plus `translateY(-8px)` with a reduced-motion crossfade. Focus indicators are
visible, text meets 4.5:1 contrast, and continuous ambient animation is absent.

## Edge Cases

- **Repeated toggle during transition:** AppKit's main-thread queue serializes
  each show/hide operation without mutating the main window.
- **No Harness:** show the empty state; never create or reveal one.
- **Harness closes:** lifecycle event clears selection and re-bootstrap chooses
  another live lane or empty state.
- **Selected lane closes/restarts:** re-bootstrap; never send to a stale session.
- **Event sequence gap or webview wake:** discard incremental assumptions and
  pull fresh status/transcript/permissions.
- **Permission resolves elsewhere:** a stale action returns a typed error, then
  refreshes the permission dock.
- **Main window minimized, hidden, or on another Space:** operations still route
  through its loaded webview; its geometry/focus remain unchanged.
- **Main window not ready:** show `Harness bridge unavailable` with retry; do not
  start another runtime.
- **Monitor removed:** move the assistant to the pointer/current/primary fallback;
  do not call main-window fullscreen recovery.
- **Native full-screen app:** `FullScreenAuxiliary` permits the assistant on that
  Space; popup level keeps it above ordinary and floating application windows.
- **Stage Manager:** verify the auxiliary window follows the active set without
  pulling the main Krypton window forward.
- **App shutdown:** destroy auxiliary webview after ACP teardown begins; hiding
  it never controls application lifetime.

## Validation

- Rust unit tests for monitor choice, frame capping/intersection, negative
  coordinates, Retina scaling, transition idempotence, operation allowlist,
  stamped event forwarding, and close-to-hide behavior.
- TypeScript tests for bootstrap precedence, empty state, lane-local selection,
  snapshot/event reduction, sequence-gap recovery, draft isolation, busy queue,
  permission staleness, and Escape precedence.
- Add a test proving show/hide/send never calls a main-window geometry, focus,
  compositor, workspace, tab, pane, or Harness presentation mutation.
- Run `cargo fmt -- --check`, `cargo test`,
  `cargo clippy --all-targets -- -D warnings`, `npm run check`, focused Live
  Assist/Control tests, full Vitest, `npm run build`, and `git diff --check`.
- Run `/perf-checklist live-assist-view`: bounded transcript DOM, listener
  cleanup, no hidden-window animation, no layout thrash, and idle CPU below 1%.
- Live macOS QA across ordinary Spaces, another app's full-screen Space, Stage
  Manager, mixed-scale monitors, monitor unplug, sleep/wake, active streaming,
  queued prompt, permission request, shortcut conflict, and panic recovery.
- Capture the main window frame, active Space/workspace/tab/pane, and Harness DOM
  before each scenario; assert every value is unchanged after summon and hide.

## Open Questions

None. Separate-window architecture, dedicated UI, state authority, shortcut,
pointer-display placement, frame, non-interference, and empty-state behavior are
fixed for approval.

## Out of Scope

- Resizing, moving, reparenting, or restyling the main Krypton/Harness window
- A second ACP client, Harness runtime, transcript authority, or session owner
- Full Harness feature parity inside Live Assist
- Reading selection/context from the frontmost external application
- Passive click-through operation while another app retains keyboard focus
- Persisting an open assistant across launches
- User-configurable shortcut or default size/position in v1
- Windows/Linux companion-window behavior

## Resources

- [Tauri Window API](https://v2.tauri.app/reference/javascript/api/namespacewindow/) — independent webview windows, always-on-top, focus, Space visibility, position, size, and show semantics.
- [Tauri Global Shortcut plugin](https://v2.tauri.app/plugin/global-shortcut/) — system-wide shortcut registration and failure behavior.
- [Apple NSWindow CollectionBehavior](https://developer.apple.com/documentation/appkit/nswindow/collectionbehavior-swift.struct) — Spaces, Stage Manager, and full-screen auxiliary contracts.
- [Apple NSWindow level](https://developer.apple.com/documentation/appkit/nswindow/level-swift.struct) — native ordering levels used for topmost behavior.
- [ChatGPT macOS companion window release notes](https://help.openai.com/en/articles/9703738-desktop-app-release-notes) — global summon, refocus, continuity, and always-in-front precedent.
- [Raycast AI Chat](https://manual.raycast.com/ai/chat) — separate chat window, background streaming, and optional Always on Top behavior.
- [Zed macOS popup window implementation](https://github.com/zed-industries/zed/blob/3d9852ae04/crates/gpui_macos/src/window.rs) — floating level plus `CanJoinAllSpaces | FullScreenAuxiliary` prior art.
- `docs/04-architecture.md`, `docs/05-data-flow.md`, `docs/72-acp-harness-view.md`, `docs/175-harness-web-control-api.md`, and `docs/200-telegram-rich-responses.md` — Krypton's window, Harness authority, control, and typed internal-stream precedents.
