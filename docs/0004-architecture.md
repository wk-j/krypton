# 5. Architecture Overview

```
+-------------------------------------------------------------------------+
|  Tauri Native Shell (Fullscreen, Borderless, Transparent)               |
|  +-------------------------------------------------------------------+  |
|  |     Webview — Active Workspace (Transparent Virtual Desktop)       |  |
|  |                                                                   |  |
|  |  +--Window 0 (focused)----+  +--Window 1--------------+          |  |
|  |  | [Title Bar] [x][-][+]  |  | [Title Bar] [x][-][+]  |          |  |
|  |  | [Tab 0 | Tab 1]        |  | [Tab 0]                |          |  |
|  |  | +--------------------+ |  | +--------------------+  |          |  |
|  |  | |   xterm.js #0      | |  | |   xterm.js #1      |  |          |  |
|  |  | |                    | |  | |                    |  |          |  |
|  |  | +--------------------+ |  | +--------------------+  |          |  |
|  |  +------------------------+  +--------------------------+          |  |
|  |                                                                   |  |
|  |  (Window 2, Window 3... hidden — belong to other workspaces)      |  |
|  |                                                                   |  |
|  |  [ Compositor: z-order, focus, move, resize, animations ]         |  |
|  |  [ Mode Indicator ]  [ Command Palette ]  [ Sound Engine ]        |  |
|  +-------------------------------------------------------------------+  |
|                          |  IPC (Tauri Commands & Events)               |
+--------------------------|----------------------------------------------+
                           v
+-------------------------------------------------------------------------+
|                       Rust Backend                                      |
|                                                                         |
|  +---------------+ +------------+ +-----------+ +--------------------+  |
|  | Workspace     | | Session    | | PTY       | | Config             |  |
|  | Manager       | | Pool       | | Manager   | | Manager            |  |
|  | (workspace    | | (window-to-| | (portable | | (TOML)             |  |
|  |  definitions, | |  session   | |  -pty)    | |                    |  |
|  |  switching,   | |  mapping)  | |           | |                    |  |
|  |  presets)     | |            | |           | |                    |  |
|  +---------------+ +------------+ +-----------+ +--------------------+  |
|                                                                         |
|  +---------------+ +------------+ +-------------------+ +--------------+  |
|  | Theme         | | VT Parser  | | Process Poller    | | Sound        |  |
|  | Engine        | | (vte)      | | (tcgetpgrp,       | | Engine       |  |
|  +---------------+ +------------+ |  process-changed) | | (rodio/cpal) |  |
|                                   +-------------------+ +--------------+  |
|  +---------------+                                                        |
|  | SSH Manager   |                                                        |
|  | (detect,      |                                                        |
|  |  clone, ctrl  |                                                        |
|  |  sockets)     |                                                        |
|  +---------------+                                                        |
+-------------------------------------------------------------------------+
              |
              v
    +-------------------+
    |  OS PTY / Shell(s) |
    +-------------------+
```

### Key Architectural Principle: Workspace as Desktop

Krypton uses **one primary native Tauri shell** that is always **fullscreen, borderless, and fully transparent**. The webview background is `transparent` — the OS desktop wallpaper shows through. The active **workspace** fills this surface as a virtual desktop. Terminal **windows** are DOM elements floating on the workspace with their own opaque (or semi-transparent) backgrounds, chrome, and shadows.

The sole exception is the macOS `live-assist` auxiliary webview (spec 208). It is
a compact, topmost projection of an already-running ACP Harness, not a second
workspace. It has no compositor, terminal, tab, pane, Harness view, or ACP client.
Its trusted command/event adapter routes onto the `AcpHarnessView` in the primary
webview, which remains the only lane-state authority. Showing or hiding the
auxiliary window never changes the primary window's frame, Space, DOM, or
compositor state, and never focuses or raises that primary window.

Each window has:
- Cyberpunk/sci-fi **chrome** — titlebar with session label, status dot, PTY status, and a session-identity mark on the right that zooms to 2.9× only on the focused window (spec 226); right sidebar with telemetry decoration; bottom bar with line indicators; glowing cyan border on focused window
- Its own **xterm.js instance** for terminal rendering
- **Keyboard-driven move and resize** as the primary interaction, with optional mouse as secondary

This model enables:
- **Workspace = desktop** — switching workspaces feels like switching macOS Spaces; each workspace is a full-screen arrangement of windows
- **Fully custom chrome** — window borders, title bars, controls, and shadows are all theme-driven via custom theme TOML files
- **Animated workspace transitions** — windows animate between positions using CSS/JS transitions on the transparent surface
- **Low workspace overhead** — switching workspaces shows/hides/repositions DOM elements; the optional Live Assist window is created lazily and hidden rather than recreated
- **Unified focus management** — the compositor controls which window receives keyboard input. Window/pane focus also moves DOM focus onto that pane's surface (`terminal.focus()` or the content view host). Native paste (`Cmd+V`) is delivered to `document.activeElement`, so compositor focus and DOM focus must stay aligned; InputRouter retargets a paste that still lands on a background content view.
- **Consistent behavior** — no platform-specific window manager quirks

### macOS Live Assist Auxiliary Window

`src-tauri/src/live_assist.rs` owns the only native auxiliary window. The
decorationless transparent webview loads `live-assist.html`, is resizable from
`840 × 620` down to `560 × 420` logical pixels, and is hidden on close. On show,
Rust resolves the pointer monitor, caps/restores the frame inside its work area,
adds `CanJoinAllSpaces | FullScreenAuxiliary`, raises the AppKit level, shows,
and focuses only that window. `Cmd+Ctrl+Shift+0` hides it before running the
unchanged primary-window recovery.

The auxiliary frontend lives in `src/live-assist-main.ts` and
`src/acp/live-assist-{client,view,types}.ts`. Its command allowlist is limited to
bootstrap, status/transcript/permission reads, prompt send, cancel, and oldest
permission resolution. Rust stamps and broadcasts each Harness stream event once,
then mirrors the same envelope to the auxiliary webview. Sequence gaps and
lifecycle boundaries cause a fresh authoritative snapshot.

### Tauri Native Shell Configuration

```rust
// src-tauri/src/main.rs (conceptual)
tauri::Builder::default()
    .setup(|app| {
        let window = tauri::WebviewWindowBuilder::new(app, "main", tauri::WebviewUrl::default())
            .fullscreen(true)           // always fullscreen
            .decorations(false)         // no native title bar or borders
            .transparent(true)          // transparent background
            .always_on_top(false)       // sits at normal z-level
            .skip_taskbar(false)        // visible in OS taskbar/dock
            .build()?;
        Ok(())
    })
```

The webview's `<html>` and `<body>` have `background: transparent`. Windows are the only visible elements — they float on the invisible workspace surface with their own chrome and shadows.

## 5.1 Key Rust Crates

| Crate | Purpose | Status |
|-------|---------|--------|
| `tauri` | Application framework, fullscreen transparent borderless shell, IPC | Implemented |
| `portable-pty` | Cross-platform PTY allocation and management | Implemented |
| `serde` / `serde_json` | Serialization framework for IPC and config | Implemented |
| `toml` | TOML config file parsing | Implemented |
| `dirs` | Cross-platform home directory resolution for config path | Implemented |
| `log` / `tauri-plugin-log` | Logging framework | Implemented |
| `vte` | VT escape sequence parser (backend validation/processing) | Planned |
| `open` | Open URLs/files with system default handler (hint mode) | Implemented |
| `libc` | Unix FFI for `tcgetpgrp()` (foreground process detection) | Implemented |
| `unicode-width` | Character width calculation for CJK / emoji | Planned |
| `display-info` | Query monitor geometry for fullscreen dimensions | Planned |
| `rusqlite` | Read-only SQLite database access for dashboard overlays | Implemented |
| `rodio` | Audio playback for sound engine (WAV decoding + OS audio output via cpal) | Implemented |
| `hostname` | Local hostname detection for SSH remote CWD filtering (OSC 7 hostname comparison) | Implemented |
| `reqwest` | HTTPS client for the subscription credit usage view (Claude OAuth usage endpoint, Copilot quota API, Cursor dashboard usage RPC) | Implemented |

## 5.2 Key Frontend Packages (npm)

| Package | Purpose |
|---------|---------|
| `@xterm/xterm` | Core terminal emulator library |
| `@xterm/addon-webgl` | WebGL-based renderer for GPU-accelerated drawing |
| `@xterm/addon-fit` | Auto-fit terminal dimensions to container |
| `@xterm/addon-image` | Inline images in terminal panes: Sixel and iTerm2 inline image protocol (IIP) |
| `@xterm/addon-search` | In-terminal text search |
| `@xterm/addon-web-links` | Clickable URL detection |
| `@xterm/addon-unicode11` | Proper Unicode width handling |
| `@excalidraw/excalidraw` | Drawing canvas for the Pencil window (lazy-loaded with React 19 — only mounted when Pencil opens) |

## 5.3 Frontend Technology

- **xterm.js** — The terminal rendering library. Krypton terminals use xterm.js 6's **DOM renderer** (only `FitAddon` and `ImageAddon` are loaded; the WebGL addon was dropped for window transparency in `a706487`). xterm.js handles VT escape sequence parsing on the frontend, cursor rendering, selection, search, and link detection.
- **Combining-mark / wide-glyph fix** — `src/xterm-cluster-cells.ts` (`installClusterCellRendering`, called right after each `terminal.open()`) wraps the DOM renderer's private row factory (`_core._renderService._renderer.value._rowFactory`, pinned to xterm 6.x; warns and no-ops if the shape changes). Stock per-span `letter-spacing` is applied after every code point, sliding Thai marks off their base, and the next cell's background paints over glyphs wider than their cell. The wrapper moves mark-bearing cells into an inline-block sized to the exact cell advance with `letter-spacing: 0`, and lifts overflowing text into `position: relative` children so it paints above cell backgrounds (still under the selection layer). Children of a bold span get `xterm-bold` too: xterm's `span:not(.xterm-bold) { font-weight: normal }` rule would otherwise paint them regular while their spacing was measured bold, and a fallback glyph whose regular advance differs (btop's bold `■` meters, box lines, arrows) pushes the rest of the row off the grid. `terminal.css` sets rows to `overflow: visible` so stacked marks (`ที่`, `ตั้ง`) are not clipped at the cell top. Known limits: SARA AM (`ำ`) is its own terminal cell, so it cannot shape together with a preceding tone mark; selected cells are separate `z-index` stacking contexts (`xterm-decoration-top`), so while text is selected the next cell's selection background can still cover a right-side tone mark.
- **DOM cell measurement** — `src/xterm-char-measure.ts` (`installDomCharMeasure`, called right after each `terminal.open()`, before the cluster fix) replaces the private `_core._charSizeService._measureStrategy` (pinned to xterm 6.x; warns and no-ops if the shape changes) with a hidden DOM span of 32 `W`s. Stock xterm 6 sizes cells with `OffscreenCanvas.measureText`, but WKWebView's OffscreenCanvas cannot resolve user-installed fonts (`~/Library/Fonts`): the `[font] family` list collapses to the generic `monospace` fallback (16px → 9.6 × 22) while the DOM rows paint the real font (Share Tech Mono → 8.64 × 18). Rows taller than the box-drawing glyphs leave gaps in every `│` of TUIs such as btop, and text gains extra tracking. The DOM span resolves fonts exactly like the rows. The initial canvas size seeds the result until the first DOM measure succeeds. It also swaps the DOM renderer's `_widthCache._measure` (integer `offsetWidth / 32`, off by up to 1/64 px per glyph) for fractional `getBoundingClientRect().width / 32`, then clears the cache and re-derives the row container's default spacing; without it each cell's `letter-spacing` carries the rounding error and a 160-column btop row ends 2–3 px off the grid, by a different amount per row. Both the cell span and the WidthCache's measure container live in one shared `.krypton-xterm-measure-host` on `<body>`, outside every window transform: `getBoundingClientRect()` returns the visual (post-transform) box, and xterm re-measures the cell on every `resize()`, so measuring inside a scaled window (Wheel card dock, Stage shelf, FLIP morph, entrance scale) stored a shrunken cell — too many columns plus a negative `letter-spacing` against glyph widths cached at a different scale, which piled text on top of itself. The cell span is removed by a terminal addon's `dispose`; the WidthCache removes its own container.
- **xterm.js addons** — `@xterm/addon-fit` (auto-resize) and `@xterm/addon-image` (inline images) are loaded on every pane terminal and the Quick Terminal. `@xterm/addon-webgl`, `@xterm/addon-search`, `@xterm/addon-web-links`, `@xterm/addon-unicode11` are installed but not loaded by the terminal panes.
- **Inline images** — `src/xterm-images.ts` (`installInlineImages`, called before `terminal.open()` on every pane terminal and the Quick Terminal) loads `ImageAddon` with its defaults. The addon decodes Sixel (`DCS … q`) and iTerm2 IIP (`OSC 1337;File=`) into a lazily created `canvas.xterm-image-layer` over the DOM rows; nothing is allocated until a program sends an image. It also answers DA1 (`CSI c`) with `CSI ?62;4;9;22c` (the `4` advertises Sixel) and turns on xterm's `windowOptions` pixel reports (`CSI 14 t`, `CSI 16 t`, `CSI 18 t`). Image TUIs probe exactly these: `ratatui-image` (used by e.g. `leaf`) sends a Kitty query, `CSI c` and `CSI 16 t`, and without a Sixel bit and a cell size it falls back to colored half blocks.
  - **Device pixels.** Stock, the addon sizes its layer canvas and its cells in CSS pixels, so on a 2× display a program is told a cell is 8 × 21 px and its image is upscaled — half the detail of Ghostty, which reports device pixels. Every size the addon uses (layer canvas, tile coordinates, cells an image covers, IIP sizing, XTSMGRAPHICS geometry) goes through its renderer's `dimensions` getter, so `installInlineImages` redefines that getter on the private `ImageAddon._renderer` to return the CSS dimensions × `devicePixelRatio` (layer canvas rounded to whole pixels — the addon resizes, and so clears, the canvas whenever its size differs). `terminal.css` displays `canvas.xterm-image-layer` at 100 % of `.xterm-screen`, i.e. its CSS size. One image pixel is one device pixel; a DPR change rescales placed images through the addon's own cell-size rescale. The getter refills one object per call (the addon reads it per drawn tile).
  - **Whole-pixel size reports.** xterm answers `CSI 16 t` with `toFixed(0)` of the cell, but the DOM-measured cell is fractional (Share Tech Mono 16px at line height 1.2 → 8.64 × 21.6 CSS px; × 2 → 17.28 × 43.2 device px). A program sizes an image to `cells × reported px` and the addon covers `ceil(px / real cell)` cells, so a rounded-up report spilled the image one column and one row past the area the program reserved. ratatui repaints only cells it changed, so it never rewrote those cells and the spill stayed on screen after a page turn or scroll in `leaf`. `installInlineImages` registers a `CSI t` handler that answers `CSI 16 t` with the device-pixel cell rounded **down** (17 × 43 on a 2× screen) and `CSI 14 t` with `cols × rows` of that same cell, so both reports agree and every image fits inside its cells. It only answers when the matching `windowOptions` flag is on, and leaves `CSI 14 ; 2 t` and every other `CSI t` to xterm. The reply goes through `terminal.input(…, false)` → `onData`, the same queue as xterm's reports. Cost: an image comes out up to 1 device px per cell narrower/shorter than its area, never larger.
  - **No blank frames while an image arrives.** A program redraws an image by erasing its cells (`ECH`) and re-sending it. A Sixel page figure is hundreds of KB to over 1 MB at 2× (the PTY reader emits 4 KB `pty-output` events, one `terminal.write` each), and xterm painted the erased area between writes: replaying `leaf` page turns through 4 KB writes (~1 MB/s), each turn showed the figure area blank for 24–31 frames before the new figure appeared. `installInlineImages` registers `DCS q` (Sixel) and `OSC 1337` (IIP) handlers on the private `_core._inputHandler._parser` **before** loading the addon. At the sequence start they set the private `_core.coreService.decPrivateModes.synchronizedOutput` (what `DECSET 2026` sets), so xterm buffers row paints. The parser calls `unhook`/`end` newest-first but still calls the older handlers after one has handled the sequence — including after an async IIP decode — so the release runs once the addon has placed the image; it clears the flag and calls `terminal.refresh` (what `DECRST 2026` does). xterm drops a synchronized-output hold after 1 s and queues a paint; a `requestAnimationFrame` guard requested a frame ahead re-asserts the hold before that paint while image data keeps arriving, and releases it when none has arrived for `IMAGE_STALL_MS` (1 s), so a program that stalls mid-image cannot freeze the pane. A program that set mode 2026 itself keeps sole control of it. Effect: the old frame stays on screen until the new one is complete (0 blank frames in the same replay), so a large image appears later instead of flashing.
  - Limits: no Kitty graphics protocol (the addon only gains it in 0.10, which requires xterm 6.1), so Kitty-only programs still fall back. Sixel carries at most 256 colors per image, and encoders such as `icy_sixel` (used by `ratatui-image`) dither the rest, so gradients and photos show dither noise that Kitty's full-color images (Ghostty) do not. Device-pixel images are 4× the bytes of CSS-pixel ones on a 2× screen, so a large figure takes longer to arrive through the 4 KB `pty-output` events.
- **Vanilla TypeScript / lightweight framework** — For the compositor (workspace management, window chrome, animations, command palette).

Since xterm.js handles VT parsing and rendering on the frontend, the Rust backend's primary role is PTY management, workspace state, theme loading, and raw byte forwarding.

## 5.4 Compositor Layer (Frontend)

The compositor is a TypeScript module running in the webview that manages workspace and window lifecycle:

### Responsibilities

1. **Workspace rendering** — display the active workspace; show/hide windows when switching workspaces
2. **Window rendering** — create/destroy window DOM containers, each hosting an xterm.js instance with custom chrome
3. **Layout engine** — compute window positions relative to the full-screen workspace. Supports six modes: **Grid** (balanced auto-tile), **Focus** (focused window on left at full height, remaining windows stacked on right), **Depth** (Z-stack card deck), **Scroll** (niri-style columns on a horizontal strip; spec 241), **Stage** (one large active window plus up to five scaled live previews on a left shelf; spec 245), and **Wheel** (an arc navigation rail of window cards beside the active window; specs 272, 273, 274). Stage gives every window the same unscaled base bounds and changes only visual transforms during focus switching, so xterm/PTY dimensions remain stable. Wheel shares one base frame the same way. The six cards nearest the active one carry their real window, scaled onto the card by `WheelRail` (`src/wheel-rail.ts`, geometry in `src/wheel-layout.ts`). Farther windows are hidden (`visibility: hidden`) behind schematic cards, and native webviews in non-active windows are suspended. The rail draws the hairline arc, its card orbit, and per-window throughput dots on a canvas, owns preview transforms and the card ↔ main-frame dock morph, and its rAF loop stops once rotation, docking, and activity dots have settled. The active card carries the ghost eye (`WheelEye`, `src/wheel-eye.ts`, spec 274): one canvas of streaming text whose pupil follows the pointer, then the busiest window's output. It runs its own clock (rAF only while the pointer moves or the lids blink, 80 ms while watching, 420 ms when quiet) and redraws only when its grid changes. Each live preview keeps a full-resolution backing store (WebKit never rasterizes a scaled-down layer below 1×), about 23 MB at 2× DPR, which is why only ±3 slots are live.
4. **Input routing & mode management** — manage keyboard modes (normal, compositor, resize, move) and route keys accordingly
5. **Focus management** — track which window is focused; route keyboard events to the focused window's PTY in normal mode
6. **Keyboard-driven window control** — handle window move, resize, swap, maximize, and focus cycling via keybindings
7. **Command palette** — overlay for fuzzy-searching and executing all available actions by name
8. **Animation engine** — orchestrate workspace transition animations (slide, crossfade, morph) and window entrance/exit effects
9. **Quick Terminal** — manage a persistent overlay terminal (toggled via `Cmd+I`) that floats centered on screen above all workspace windows; separate from the tiling layout
10. **Z-order** — manage window stacking within a workspace; focused window rises to top
11. **Chrome rendering** — cyberpunk/sci-fi window chrome with glowing cyan borders, session label with status dot, PTY status indicator, right sidebar with telemetry decoration, and bottom bar
12. **Per-window accent colors** — each window gets a unique color from a 10-color cyberpunk palette (cyan, magenta, amber, green, violet, orange, pink, teal, gold, red) applied to chrome, borders, corners, tabs; colors recycled on window close. **Spec 142:** an ACP harness view overrides its host window's accent to track the *active lane's* identity color via a `data-lane-accent` slot attribute + `!important` CSS in `window.css`, layered beneath the `data-signal` status override (spec 105); removed on dispose so the window reverts to its allocated color. **Spec 304:** the palette's `Window Color` group paints the focused window from the same 10-color palette through `data-accent-pick` + `--krypton-accent-pick`, declared after the lane rule so an explicit pick beats both the allocated color and the active lane; `Window Color: Auto` drops the attribute and the window falls back to whichever layer is underneath. The pick rides the workspace snapshot (`accent`), so it survives a WebContent reload
13. **Shader engine** — manage per-pane CSS/SVG post-processing effects (CRT, hologram, glitch, bloom, matrix); cycle presets via `Leader g`, toggle globally via `Leader G`
14. **Progress indicator** — listen for `pty-progress` events (ConEmu `OSC 9;4`); render a large translucent SVG arc gauge centered in the window's content area (behind terminal text) and a titlebar scanline sweep; per-pane state tracking with active-tab display; accent-color-aware theming
14b. **Program status (OSC 7501)** — each terminal pane registers xterm.js parser handlers (`Compositor.wireProgramStatus`): OSC 7501 reports go to `ProgramStatusStore` (`src/program-status.ts`, per-pane records, validation/limits, lifetime). The `OSC 7501;?` query is answered through `terminal.input` → `onData`. OSC 133 `A`, and `process-changed` returning to the shell, drop working/blocked/idle. RIS clears; a keypress acknowledges done/error. The compositor paints `data-program-status` on tabs and windows plus a titlebar chip and publishes `view:program-status`. The workspace footer counts panes needing the user; `Leader !` focuses the next one. Quick Terminal and content views do not participate. See `docs/0284-program-status-osc7501.md`
15. **Context extensions** — `ExtensionManager` listens for `process-changed` Tauri events from a backend poller (500ms, using `tcgetpgrp()` on PTY master fd). When a matching foreground process is detected (e.g., `java`), the corresponding built-in extension activates and renders widget bars (top/bottom horizontal strips inside the pane). Bars are real flex children that push the xterm terminal inward — `addon-fit` recalculates and `resize_pty` fires. First extension: Java Resource Monitor (JVM heap, GC, CPU%, RSS via `jstat` + `ps`).
16. **Backend logging** — Tauri logging writes to the platform app log directory only. The stdout target is deliberately disabled so backend logs from watchers, quick search, and PTY lifecycle events cannot spill into the terminal that launched Krypton, especially during nested development sessions.
17. **Overlay dashboards** — `DashboardManager` provides a generic framework for full-screen overlay panels. Modules register dashboards with an ID, title, optional keyboard shortcut, and `onOpen`/`onClose`/`onKeyDown` lifecycle hooks. The manager handles DOM creation (backdrop + panel + header + scrollable content area at z-index 9500), show/hide transitions (CSS opacity + scale), `Mode.Dashboard` integration with the InputRouter, and focus restoration. Built-in dashboards: **Git Status** (`Cmd+Shift+G`) — branch, file counts, changed file list via `run_command`; **OpenCode** (`Cmd+Shift+O`) — session history, token usage, model/tool distribution from local SQLite database via `query_sqlite`.
18. **Workspace footer** — `WorkspaceFooter` (`src/workspace-footer.ts`) owns the single fixed 28px bottom rail for workspace-level status. It subscribes to `InputRouter` mode changes, `Compositor` focus/summary helpers, and focused-view `ViewBus` signals (`view:state`, `view:metrics`, `view:throughput`, `view:progress`, `view:exit`) to render mode, focused role/title, CWD/git, counts, process/activity, and contextual hints. The music mini-player no longer owns its own fixed footer; `MusicPlayer` registers a music segment with the footer. `Leader ?` toggles compact/detail density and command palette actions can show/hide or toggle detail. See `docs/0121-workspace-status-bar.md`.
19. **Window AI credit status** — `src/usage-store.ts` is the shared, ref-counted frontend owner for Claude/Codex/Copilot/Cursor subscription usage polling. A visible content view optionally declares its providers through `ContentView.getUsageProviders()`; ACP Harness publishes the deduplicated union of its lanes and signals membership changes. The compositor subscribes only the active tab's focused pane and renders quota windows into the left side of that window's `.krypton-window__footer`; the project badge, diff stat and lane strip hold its right end. See `docs/0153-window-ai-credit-status.md`.
20. **Window status bar lane strip** — the same per-window footer also carries one two-letter drop cap per lane of the ACP Harness in that window's focused pane, with the active lane magnified and showing a small trailing number (`CL²` next to `KR ypton`). Its full name remains in the tooltip and accessible label. It reuses the spec-153 contract exactly: `ContentView.getLaneMarks()` + `onLaneMarksChange()`, followed through one `syncWindowChrome(win)` that drives both readouts and is torn down in `closeWindow()`. Per-window by design — each window answers for its own harness, so the workspace footer stays out of it. Cap, drop-cap split, repaint key, and a11y label are pure functions in `src/window-footer-lanes.ts`. See `docs/0218-window-lane-strip.md`. Immediately **left of the strip** sits the spec-219 project badge — the focused view's project name with its first two characters magnified (a drop cap) so tiled windows are told apart while scanning, paired with the lane drop cap so project and active lane read as one glance target at the rail's right end, derived from the already-existing `ContentView.getWorkingDirectory()` and rendered by the same `syncWindowChrome(win)`. Name extraction, `~`-abbreviation and the head/tail split are pure functions in `src/window-footer-project.ts`. See `docs/0219-window-project-badge.md`. **Between the two** sits the spec-220 diff stat — the repo's uncommitted `+added -removed` against `HEAD`, magnified to the same level so project, volume and lane read as one oversized phrase. It is the rail's one *subscribing* readout of the three: `src/diff-stat-store.ts` polls per **repo root** (ref-counted, single-flight, stopped while the app is hidden), so several windows on one project share one git call, and `attachToBus` pushes it at `harness:lane-idle` so the number lands the moment a lane's turn ends. Totals come from `git.rs::working_diff_stat()` in one `--numstat` — never a diff — and the formatting is a pure function in `src/window-footer-diff-stat.ts`. See `docs/0220-window-diff-stat.md` and `docs/adr/0020-diff-stat-polls-diff-window-does-not.md`.
20. **Window titlebar view toggles (spec 320)** — a content view may contribute icon toggles to the titlebar of the window hosting it through `ContentView.getTitlebarToggles()` + `onTitlebarTogglesChange()` + `activateTitlebarToggle(id)`. The compositor follows the active tab's focused pane exactly as the footer readouts do (`syncWindowChrome(win)` → `syncWindowTitlebarToggles(win)`, torn down in `closeWindow()`) and renders the list with `src/titlebar-toggles.ts` as the first child of `.krypton-window__titlebar-end`; buttons are `tabindex=-1` and the cluster's mousedown keeps DOM focus where it was. A toggle without `pressed` is a one-shot action button (no `aria-pressed`); `attention` draws it in the warning colour. The titlebar is an inline-size container: below 480px only the `all` toggle and the `backend-update` action stay. The ACP Harness is the only contributor: six panel toggles (plan, lane peek, thought, grammar, queue, ticket) plus `all`, backed by per-project per-panel flags beneath the spec-251 `#panels` master switch and reachable from the keyboard as `#panels [hide | show | toggle] <panel>`; local Harness views append the spec 322 `backend-update` action while Grok or OMP is behind. Icons are `krypton-icon-panel-*` / `krypton-icon-backend-update` symbols from the document-level harness defs. See `docs/0320-harness-titlebar-panel-toggles.md` and `docs/0322-acp-backend-update-check.md`.
20. **Optional mouse handling** — secondary drag/resize/click interactions for users who prefer mouse
21. **Editor opener** — `src/editor-open.ts` provides the shared "open in Helix" path used by Quick File Search and the built-in file path hint rule. It asks the compositor to create a terminal tab whose PTY process is `hx` with the selected path argument; relative paths inherit the focused pane's cwd, and the normal `pty-exit` flow closes the tab when Helix exits. Backend PTY sessions inject the user's login-shell `PATH` before spawning so GUI launches can still resolve tools such as `hx`. Backend PTY sessions emit `pty-exit` from both reader EOF/error and a direct child-process wait, so direct editor tabs close even when the PTY master does not report EOF immediately.
21. **Pi agent view** — `src/agent/` implements the embedded pi-agent content tab opened via `Leader a`. `AgentController` lazily builds a browser-compatible `@mariozechner/pi-agent-core` agent with CWD-aware `read_file`, `write_file`, `bash`, and skill tools. `AgentView` owns the keyboard-driven chat surface, image staging, slash commands, context-window callback, inline diff previews, validation checks, and the `write_file` / risky-`bash` approval handlers. Before a pi-agent write reaches the backend `write_file` IPC, `src/agent/tools.ts` reads the old file, computes a diff when under the preview cap, awaits AgentView's approval promise, and only writes after `a`/`A`; `r`/`R` rejects with a tool error and leaves disk untouched. Before a pi-agent shell command reaches `run_command`, `tools.ts` classifies it with a conservative allowlist: read-only commands run immediately, while redirection, mutators, Git state changes, package/network tools, script runners, and unknown commands render a command review and wait for the same `a`/`r`/`A`/`R` keys. `/check` is a user-owned validation path, not an agent tool call: AgentView reads project marker files, selects a narrow command (`npm run check`, `npm run typecheck`, `npm test`, `cargo check`, or `go test ./...`), runs it directly through `run_command`, and stores failing output for `f`/`/fixcheck`. See `docs/0042-pi-agent-integration.md`, `docs/0099-agent-write-approval.md`, `docs/0100-agent-bash-approval.md`, and `docs/0101-agent-check-command.md`.

21. **ACP backends** — `src/acp/` (`AcpClient`, `AcpHarnessView`) and `src-tauri/src/acp.rs` (`AcpRegistry`, `AcpClient`) drive external [Agent Client Protocol](https://agentclientprotocol.com) adapters (Claude Code, Codex, OpenCode, Cursor Agent, pi via `pi-acp`, OMP, …) over newline-delimited JSON-RPC on the subprocess's stdio. ACP agents run only as ACP Harness lanes; the former single-lane ACP agent tab (`AcpView`) and the Gemini backend were removed. The harness boots empty (no auto-spawn); on first open it auto-presents the lane picker so the user selects which backend to start, and thereafter the user adds more lanes on demand via the local leader-key picker (`Cmd+P → +`); supported backends are Codex, Claude, OpenCode, Pi, Droid, Cursor, Junie, OMP, Grok, Copilot, MiMo, Cline, and Antigravity (local harnesses only). Lane picker, close-active-lane (`Cmd+P → _`), metrics overlay (`Cmd+P → =`), and session resume picker (`Cmd+P → 0`) are exposed as `ACP_HARNESS_LEADER_KEYS`. See `docs/0092-acp-lane-picker.md` and `docs/0097-acp-harness-session-resume.md`. Pi-1 deliberately skips the `.mcp.json` bridge and the per-lane memory MCP server because pi has no MCP host (by design), and it bypasses the permission rail because pi has no permission gate (by design) — the Pi-1 lane chip surfaces a `⚠ unsandboxed` marker so this safety delta is visible. Pi-1 prerequisites: `npm install -g @mariozechner/pi-coding-agent pi-acp`, then either set a provider API key env var or run `pi /login` once outside Krypton (the harness does not provide a TTY for pi's interactive OAuth flow). See `docs/0084-acp-pi-lane.md`. Droid-1 spawns Factory's official `droid` CLI in native ACP mode (`droid exec --output-format acp`); it is a "regular" lane (full `.mcp.json` bridge, full per-lane memory MCP, permission rail engaged) — opposite archetype from Pi-1. Auth via `FACTORY_API_KEY` env var; the device-code OAuth flow needs a TTY and must be completed outside Krypton. Default model is Factory's `claude-opus-4-7`; override via `acp_harness.lane_models["droid"]` (passed to `droid` as `-m <id>` at spawn). See `docs/0086-acp-droid-lane.md`. Cursor-1 spawns Cursor Agent's native ACP server (`cursor-agent acp`) as a regular lane with the `.mcp.json` bridge and per-lane memory MCP enabled. Cursor auth/install remains outside Krypton (`cursor-agent login` or `CURSOR_API_KEY`), startup errors include Cursor-specific Keychain/login/install hints, and the lane uses the normal permission rail (no extra safety chip since 2026-07; see `docs/0113-acp-cursor-lane.md` for probe caveat). See `docs/0113-acp-cursor-lane.md`. Junie-1 spawns JetBrains Junie CLI in native ACP mode (`junie --acp true`) as a regular lane with the `.mcp.json` bridge and per-lane memory MCP enabled. Junie auth/install remains outside Krypton (`junie` first-run for JetBrains Account, or `JUNIE_API_KEY` / `--auth <token>` / BYOK provider keys in the login shell), startup errors include Junie-specific install / unknown-ACP-flag / auth / subscription / config-corruption hints, and the lane chip shows `⚠ permissions unverified` until Junie ACP write-permission behavior is manually probed. Junie's native MCP loaders (`--mcp-default-locations`, `~/.junie/config.json`) may overlap with the Krypton-bridged `.mcp.json`; this duplication risk is tracked as a post-implementation verification step rather than a launch blocker. See `docs/0119-acp-junie-lane.md`. OMP-1 spawns Oh My Pi's native ACP server (`omp acp`) as a regular permission-gated lane. OMP native-loads project root `.mcp.json`, so Krypton skips only the project `.mcp.json` bridge for OMP while still injecting the per-lane `krypton-harness-memory` MCP server through `session/new.mcpServers`. OMP auth/install remains outside Krypton (`omp` first-run/auth-broker or provider keys in the login shell), and startup errors include OMP-specific install / old-CLI / auth / API-key / empty-stderr hints. See `docs/0122-acp-omp-lane.md`. Grok-1 spawns xAI Grok Build's native ACP server (`grok --trust agent stdio`) as a regular permission-gated lane with the `.mcp.json` bridge and per-lane memory MCP enabled. `--trust` is a global grok flag (must precede `agent`) so repo-local MCP servers start in folders that have never been trusted in the Grok TUI; ACP has no `/hooks-trust` prompt and Grok otherwise returns an empty `search_tool` catalog. Grok auth/install remains outside Krypton (`grok` first-run browser login, or `XAI_API_KEY` in the login shell), and startup errors include Grok-specific install / old-CLI-without-ACP / auth / API-key / empty-stderr hints. No CLI `-m` model flag is passed at spawn in v1: `acp_harness.lane_models["grok"].active` drives the chip and applies through the generic `session/set_model` path if Grok advertises model state at `session/new`. Initialize advertises `writeTextFile` but not `readTextFile` so Grok's native `read_file` can embed screenshots (spec 228). See `docs/0135-acp-grok-lane.md`. Copilot-1 spawns GitHub Copilot CLI's native ACP server (`copilot --acp --stdio`, public preview) as a regular permission-gated lane with the `.mcp.json` bridge and per-lane memory MCP enabled. Copilot auth/install remains outside Krypton (`copilot` `/login` device flow, or a fine-grained PAT with the Copilot Requests permission exported as `COPILOT_GITHUB_TOKEN` / `GH_TOKEN` / `GITHUB_TOKEN`), and startup errors include Copilot-specific install / old-CLI-without-ACP / auth / token / empty-stderr hints. Verified against Copilot CLI 1.0.60: `initialize` advertises `mcpCapabilities {http, sse}` and `promptCapabilities.image`, so the per-lane HTTP `krypton-harness-memory` MCP passes `filterByCapability`. Whether Copilot actually *honors* `session/new.mcpServers` is still unverified (advertising a capability is not proof — Cursor advertised and regressed, spec 113); this needs a live `session/new` + tool call to confirm. Copilot's ACP server documents no model flag and advertised no model state at `initialize`, so `acp_harness.lane_models["copilot"].active` is chip-only unless Copilot later advertises model state at `session/new` (then the generic `session/set_model` path applies). See `docs/0150-acp-copilot-lane.md`. Cline-1 spawns the Cline CLI's native ACP server (`cline --acp`, stdio) as a regular permission-gated lane with the `.mcp.json` bridge and per-lane memory MCP enabled, delivered through a **native-config overlay** rather than `session/new`: verified against cline 3.0.24, `initialize` advertises **no `mcpCapabilities`**, so an http/sse server passed through `session/new.mcpServers` is dropped and never connects (the regression-free analogue of Cursor's "advertises then ignores"). Instead Krypton writes a per-lane `cline_mcp_settings.json` (memory server tagged `streamableHttp`, plus the spec-83 project bridge) under `~/.config/krypton/runtime/cline/<harness>/<lane>/` and points `CLINE_MCP_SETTINGS_PATH` at it at spawn — leaving the global `~/.cline` auth/providers untouched. Cline auth/install remains outside Krypton (`npm i -g cline`, then `cline auth`), and startup errors include Cline-specific install / old-CLI-without-ACP / auth / token / empty-stderr hints. Cline does expose `-m`/`--provider` CLI flags, but v1 leaves the model to `cline auth`/config: `acp_harness.lane_models["cline"].active` is chip-only unless Cline advertises model state at `session/new` (then the generic `session/set_model` path applies). See `docs/0159-acp-cline-lane.md`. Antigravity-1 is the one backend Krypton installs itself: `src-tauri/src/acp_install.rs` downloads Google's `antigravity-acp` server from the ACP Registry into `app_cache_dir()` (~110 MB download, ~400 MB per version), records it in an install manifest, and launches the `.par` from its install directory because the server resolves its harness binary relative to it. Registry checks are throttled to 1 h, archive hosts are allowlisted, and old versions are removed only before the process's first Antigravity spawn. The lane is local-only (remote harnesses hide it and `acp_spawn` rejects it). On an "Authentication required" error from `session/new`/resume/load, Krypton calls `authenticate` with `oauth-personal` and retries; the server persists the choice to `~/.gemini/antigravity-acp/settings.json`. Models come from `session/new` through the generic model picker. See `docs/0287-acp-antigravity-lane.md`. The built-in OpenCode backend launches `opencode acp`; its model list comes from the `configOptions` model select, and a configured `lane_models.opencode.active` is applied via `session/set_config_option` (non-fatal) without writing OpenCode config files. The reader task dispatches by message shape: responses resolve `pending[id]` oneshots, inbound `fs/read_text_file` and `fs/write_text_file` requests are answered locally, `session/request_permission` is bridged to the frontend through a per-id oneshot, Grok `_x.ai/ask_user_question` is parked the same way as a permission (spec 229; not auto-answered), ACP `elicitation/create` form requests from any backend are parked in `elicit_pending` and answered through the same question card (spec 279; `initialize` advertises `clientCapabilities.elicitation.form` to every lane), and `session/update` notifications are emitted on `acp-event-<session>`. ACP spawn can also carry HTTP MCP server descriptors into `session/new.mcpServers`, `session/load`, and `session/resume`. The pi-agent opens on `Leader a`; the ACP Harness opens on `Leader Y`. See `docs/0069-acp-agent-support.md` (backend protocol; its single-lane window is removed) and `docs/0072-acp-harness-view.md`.

22. **ACP extended session updates** — beyond `agent_message_chunk`, `agent_thought_chunk`, `tool_call(_update)`, `plan`, and `usage_update`, the harness also consumes `available_commands_update` (per-lane slash-command catalog) and `current_mode_update` (e.g. Claude plan-mode ↔ edit-mode). Each lane stores its own command list and current mode in `HarnessLane.availableCommands` / `currentMode` (with `modesById` looked up from `agentCapabilities.availableModes`). The lane head paints a purple mode chip via `renderModeChip()`, and the composer pops a slash-command palette when the draft matches `/^\/[a-zA-Z0-9_-]*$/` — `↑↓` selects, `Enter`/`Tab` inserts `/<name> ` at the cursor, `Esc` dismisses for the current draft. The Rust forwarder already whitelists both kinds in `handle_notification`; the gap was purely on the TS dispatcher side. Pi-1 emits neither so both surfaces stay quiet for it. See `docs/0087-acp-extended-session-updates.md`.

23. **ACP fs activity surface** — Krypton's Rust ACP backend implements `fs/read_text_file` and `fs/write_text_file` as inbound JSON-RPC requests (declared via `clientCapabilities.fs`) so agents that prefer ACP file primitives over their internal tools route reads/writes through the harness. Grok and OMP are the exceptions on reads: initialize sets `readTextFile: false` so Grok screenshots stay on its native image embed (spec 228) and OMP reads go straight to disk instead of an ACP attempt that fails with `Path outside project root` before OMP falls back (spec 122). Grok and OMP writes still go through ACP. Every ACP read and write emits an `fs_activity` event (success and failure), and the lane transcript renders a `📖 read` / `✏️ wrote` / `✗ failed` chip with the affected path. Non-UTF-8 reads fail with `binary file (<kind>, N bytes); fs/read_text_file is text-only` instead of Rust's UTF-8 IO string. This is visibility-only — the writes still go through immediately and there is no diff preview yet. Pi-1 stays N/A because pi-acp does not request the fs capability. See `docs/0088-acp-fs-activity-surface.md`.

24. **ACP Harness inline images (spec 281)** — `src/acp/harness-images.ts` turns ACP image bytes and local image paths into per-row `HarnessImage`s backed by Blob object URLs (never `data:` in markdown HTML). Path images go through the `read_image_file` Tauri command (`commands.rs`), which expands `~/`, caps files at 10 MiB, and returns raw bytes as an `ArrayBuffer` (`tauri::ipc::Response`) only when the magic bytes say png/jpeg/gif/webp. This is how `/tmp` downloads render even though they are outside the `$HOME/**` asset scope. `HarnessLane.imageState` holds the 64 MiB live-byte budget, the per-turn path dedupe, and a serial load queue. `harness-image-viewer.ts` is the keyboard viewer overlay.

24. **ACP diff preview & gated writes** — `tool_call.content[].type === 'diff'` payloads (sent by Codex/Claude with `oldText`+`newText`) render in the harness as inline +/- hunks with line numbers via `src/acp/diff-render.ts`. For `fs/write_text_file`, the Rust handler holds the JSON-RPC reply on a `oneshot` channel (mirroring `session/request_permission`), reads the current disk content as `oldText`, emits a `fs_write_pending` event, and waits for the user's accept/reject decision through the new `acp_fs_write_response` Tauri command before writing or replying with a JSON-RPC error. `fs/write_text_file` goes through `validate_fs_path` (write), which canonicalizes the requested path and rejects anything outside the lane's project root (Grok session scratch under `~/.grok/sessions/<encoded-cwd>/` is allowlisted for every file in that tree). Grok ACP writes (and leftover reads) are not project-scoped — Grok's grep/list/bash already reach those paths, and scoping ACP I/O broke sibling-repo specs, `~/.agents` skills, and hid the write-review card for out-of-root edits. Grok file reads are native after spec 228. OMP writes are not project-scoped either: OMP has no disk fallback for writes, so scoping failed its `edit`/`write` on sibling repos and `/tmp` scratch outright (spec 122). Grok and OMP writes still wait on that card. Other ACP lanes keep Spec 89 scoping. Keys: `a` accept, `r` reject, `A` accept-all-this-turn, `R` reject-all-this-turn — reusing the `acceptAllForTurn`/`rejectAllForTurn` flags introduced for permissions. See `docs/0089-acp-diff-preview.md`.

25. **ACP Harness view** — `AcpHarnessView` (`src/acp/acp-harness-view.ts`) opens multiple `AcpClient` lanes in one content tab for the focused working directory. It renders a read-only lane dashboard plus an input-only command center, shows the project cwd and current Git branch in the composer status line, routes prompts only to the active lane, handles per-lane permission prompts, stages pasted/dropped/global-captured images in the active lane composer, sends staged images as ACP image blocks with base64 data and local file URIs, and creates an MCP memory store on the existing localhost hook server. Direct composer insertions spawn a phosphor afterimage of the inserted graphemes that ignites, drifts upward 3px, and dissolves (spec 252): overlay copies of the letters themselves, not an expanding ellipse. The overlay survives composer HTML rebuilds so fast typing trails; the existing inline caret is unchanged. `[acp_harness] composer_bloom`, `composer_bloom_ms`, and `composer_bloom_trail` configure it; Reduce Motion or `composer_bloom = false` drops it. This acknowledgement has no ACP, PTY, persisted lane-state, or custom-cursor role. The command center also owns one opt-in Web Speech recognition session: `src/acp/harness-dictation.ts` probes the host webview, reconstructs final/interim results, and inserts recognized text into the saved active-lane draft without changing ACP transport or submitting automatically. `Cmd+D` / the `MIC` control listen in English (`en-US`); `Cmd+Shift+D` listens in Thai (`th-TH`). Capture is aborted on cancel, lane/view teardown, composer pre-emption, or focus leaving the Harness; macOS packaging declares microphone/speech purpose strings and the audio-input entitlement. Each lane receives a lane-scoped HTTP memory endpoint; agents create/update/delete/search/get memory through MCP tools while the human observes the current board. Harness hash commands provide lane lifecycle controls including `#cancel`, `#restart`, `#new`, `#new!`, `#mem clear`, and `#mcp`; `#panels [hide | show | toggle]` independently hides persistent auxiliary rails/docks without hiding transcript content, the composer, or inline approval surfaces. Fresh-session commands use client disposal and a lane spawn epoch to ignore late events from replaced subprocesses. Memory and panel visibility persist per project directory. Open via `Leader Y` or command palette. The active lane **right rail** can show a contextual **lane peek** for one inferred non-active lane plus optional **lane-pair activity heat** (active vs peeked; palette-controlled metric/window/detail). See `docs/0072-acp-harness-view.md`, `docs/0073-acp-harness-mcp-memory.md`, `docs/0109-acp-contextual-lane-peek.md`, `docs/0246-harness-dictation.md`, `docs/0251-harness-panel-visibility-command.md`, and `docs/0252-harness-composer-soft-bloom.md`.

    **Module layout (spec 204).** `acp-harness-view.ts` holds the `AcpHarnessView` class; everything
    that is not the class lives in focused sibling modules with a strictly one-way dependency direction:
    `harness-view-types.ts` (state shapes), `harness-format.ts` (formatting/parsing leaves),
    `harness-icons.ts` (inline `<symbol>` defs), `harness-lane-identity.ts` (backend label/logo,
    directive role, lane accent), `harness-markdown.ts` (shared `marked` instance + streaming-markdown
    plumbing + URL allowlist), `cell-grid.ts` (spec 324: code blocks laid out by columns — box drawing,
    ASCII frames around Thai — on a character-cell grid, used by `harness-markdown.ts` and `AssistantRow`; spec 326:
    `gridifyText` / `gridifyLines` / `CellGridText` put every tool, diff, grep, peer and program output block on the
    same grid, and `sliceCells` cuts tool-card lines by cells), `message-resources.ts` (deterministic typed/Markdown reference
    classification, normalization, merge, and cap), `harness-permission-scan.ts` (harness-bus auto-allow, args preview,
    artifact path matching), `harness-tool-render.ts` (ToolCall inspection + tool row rendering),
    `harness-lane-chrome.ts` (lane head/chips/metrics/stats/status vocabulary),
    `harness-transcript-render.ts` (transcript row → DOM), and `lane-peek.ts` (heat, candidate ranking,
    peek card). The view re-exports every previously-public symbol, so old import sites still resolve;
    new code should import from the owning module. See `docs/0204-harness-view-split.md`.

    **Feature controllers (spec 275).** Three features' state and behavior moved out of the class into
    per-feature controllers: `harness-dictation-controller.ts` (spec 246 speech session),
    `harness-timeline-controller.ts` (`#timeline`, settings and nonvisual legacy-pending count) and
    `harness-ticket-controller.ts` (active ticket, worker binding, `#ticket` picker, ticket dock), with
    pure ticket helpers in `harness-ticket-helpers.ts`. A controller owns its state and reaches the view
    only through a narrow host contract from `harness-view-host.ts`, which the view builds from
    getters/closures so its own members stay private. Controllers that listen to backend events expose
    `subscribe()`/`dispose()`; ones that own DOM expose `mount*()`. Orchestrator console, review, lane
    lifecycle and composer are still in the class. See `docs/0275-harness-view-controllers.md`.

    **UI components (specs 301/302).** The harness no longer paints with string builders and a
    hand-maintained render signature. `src/ui/` is a generic, harness-free kernel —
    `Component`/`LiveComponent`, `reconcile()`, `RenderScheduler`, `el()`, `LayoutHost` — and every
    harness surface is a directory under `src/acp/components/<name>/` holding its class, its own
    stylesheet (`@layer krypton.component` + `@layer krypton.scheme`) and its test, listed once in
    `components/registry.ts`. Three things follow structurally rather than by convention: a component
    repaints only when its declared dependency tuple moves (so `transcriptRenderSignature` is gone);
    `LiveComponent.seal()` is the one live→static transition and re-derives every class from state (so
    `acp-harness__msg--streaming` cannot be stranded); and a mutation names the region it dirtied
    (`rail · laneChrome · transcript · rightRail · composer · overlay`) instead of calling `render()`.
    `LaneShell` is constructed once, so the transcript body is never reparented and the scroll-restore
    dance around the old `dashboardEl.innerHTML = ''` is deleted. Panel placement is one table,
    `HARNESS_LAYOUT_DEFAULT` in `harness-layout.ts`, type-checked against the slot union.

    **Execution Inspector (specs 315/319).** `harness-execution.ts` validates and bounds current OMP
    code-cell snapshots before wire retention compacts them. `ToolRow` owns an `ExecutionCard` that
    replaces the generic source/output dump. `AcpHarnessView` owns one `ExecutionDialog`, an
    `OverlayShell` modal mounted once in `.acp-harness__body` beside the image viewer. It shows a
    head, a status/time/exit/job summary and Code / Output / Activity tabs, and owns the keyboard
    while open. It never writes row DOM, so it needs no card slot and stays open when its row leaves
    the mounted tail window. Existing transcript hints open retained code/output/activity without new
    execution, protocol, storage or native-window paths. Generic tools, artifact redaction, subagent
    cards, diffs and image strips keep their owners.

    **Generative UI (specs 308/309/310/312).** A sealed assistant reply can contain
    a `krypton-ui` fence. `src/acp/genui/` compiles a bounded expression
    language and evaluates it locally. An explicit `#ui` turn stages assistant
    text, validates it with that compiler, and allows two repair turns before
    publishing a final result. For ordinary replies, while the reply streams the fence is
    collapsed to a one-line strip instead of painting its source; at seal
    `AssistantRow` drops the strips, caches pure markdown, then replaces valid
    fences with static `GenUiCard` pointers, each carrying an empty slot.
    `AcpHarnessView` owns one `GenUiPanel` node and
    seats it in the slot of the card being used, so the panel expands inline in
    the sealed row (spec 310 replaced the `OverlayShell` host). The seal expands
    the row's last fence itself — without focus or a reveal scroll, so it never
    takes the keys of someone typing — and the card head, `f` + label or a click
    opens any other; it re-seats the same node after every transcript commit and
    collapses when no mounted row
    claims it. Generated actions can only load a visible composer draft. There
    is no new Rust IPC, ACP protocol message, file reader, or executable agent
    HTML.

    **Word autocomplete (spec 285).** `word-predict.ts` (main-thread client, ghost helpers),
    `word-predict-model.ts` (pure unigram/bigram model over `Intl.Segmenter` words) and
    `word-predict-worker.ts` (one shared Web Worker). The Rust `prompt_history.rs` owns Krypton's
    first self-owned SQLite store, `~/.config/krypton/harness-prompt-history.db`, that every lane
    writes on submit (`harness_prompt_log`). `harness_word_corpus` returns that store plus read-only
    Claude/Codex/OMP prompt histories. See `docs/0285-harness-word-autocomplete.md`.

    **Assistant response resources (spec 206).** ACP `resource_link` and embedded-resource
    chunks remain typed through `AcpClient` instead of being collapsed to empty text. At each
    assistant-message seal, the harness merges those blocks with explicit anchors from the final
    Markdown DOM, deduplicates and caps the result, then renders a flat reference rail beneath the
    prose. The rail is excluded from the Markdown cache. Files open in a new Helix tab through a
    compositor callback; HTTP(S)/mailto targets open externally. Transcript `f` hint mode covers
    both these references and available HTML artifacts. See
    `docs/0206-assistant-response-resources.md`.

    **Reference Git state (spec 207).** File references carry optional volatile
    Git decoration populated by the Rust `collect_reference_git_state` command.
    The command receives only normalized absolute targets, resolves them beneath
    the repository root, and derives compact status plus combined working-tree
    `--numstat` counts against `HEAD` (empty tree for an unborn repository).
    Untracked text files are counted locally under a 1 MiB bound; binary and
    unavailable counts remain explicit. One debounced collection covers every
    referenced file, stale responses are token-rejected, and metadata changes
    invalidate only transcript rows through the existing render signature. No
    assistant-provided status/count value enters this path. See
    `docs/0207-assistant-reference-git-state.md`.
26. **Cursor trail** — `CursorTrail` (`src/cursor-trail.ts`) renders a rainbow flame particle effect on both the mouse cursor and the terminal text cursor. Spawns burst particles on `mousemove` (document-level capture) and polls the focused terminal's `buffer.active.cursorX/Y` each frame. Particles drift upward with turbulence, cycle through rainbow hues, and fade with quadratic falloff. Appended to `document.body` at z-index 99999. Togglable at runtime via `toggle()`

27. **ACP Harness plan tracking** — `session/update { sessionUpdate: 'plan' }` notifications are no longer rendered as transcript items. Each lane stores the latest `entries[]` on `HarnessLane.plan`, and a per-active-lane floating panel (`.acp-harness__plan`, top-right of `.acp-harness__body`, z-index below the memory/help overlays) renders a `// plan` header with a `done/total` progress count and one row per entry. Status drives color (pending = dim, in_progress = amber, completed = green strikethrough); priority drives a 2px left border accent (high/medium/low). The panel auto-hides when a lane has no plan and clears on `#new`/`#new!`/`#restart`. Toggle collapse with `p` in transcript focus. See `docs/0090-acp-plan-tracking.md`.

28. **ACP Harness render performance** — high-volume ACP event streams are batched in `AcpHarnessView` with a `requestAnimationFrame`-backed `scheduleLaneRender()` / `scheduleStreamingBodyOnly()` so repeated message/tool chunks coalesce into one active-lane pass per frame. Lightweight `available_commands` and `mode_update` events patch only their affected composer/header surfaces. `stop` and MCP-stat refreshes do not rebuild the dashboard. Assistant transcript items cache parsed/highlighted markdown on the row object. Plain-text rows (user, system, sealed thought) are one text node wrapped natively by CSS `pre-wrap`; there is no text-measurement pass after render or resize. Composer key edits pin a stuck transcript in the same turn so a swallowed scroll event cannot paint the 14px per-keystroke jump (spec 114 rev 14). Streaming tool-output updates do not replay a smooth-follow glide when the transcript bottom did not move (spec 114 rev 15). See `docs/0094-acp-harness-render-performance.md` and `docs/0114-acp-harness-streaming-perf.md`.

29. **ACP Harness Peering (inter-lane messaging)** — `LaneBus` (`src/acp/lane-bus.ts`), `LaneInbox` (`src/acp/lane-inbox.ts`), and `InterLaneCoordinator` (`src/acp/inter-lane.ts`) let any two lanes in the same harness exchange messages for user-directed peer review. `AcpHarnessView` centralizes status mutations through `setLaneStatus()` which emits `lane:status` events on the bus; the coordinator subscribes and drains target inboxes whenever a lane returns to `idle`. The Rust MCP server (`krypton-harness-bus`) exposes two extra tools alongside the memory tools: `peer_send` emits an `acp-inter-lane-message` Tauri event with a JSON envelope, and `peer_list` returns naming guidance. Memory and peer tools are split into separate frontend taxonomy sets and combined only for harness auto-allow detection; auto-allowed requests still render structured permission cards with the matched rule. A lane that ends a turn with outstanding sends transitions to a new `awaiting_peer` status; the composer rejects new user prompts in that state with pending-peer guidance such as `awaiting Claude-1 · <1m · #cancel`, and `#cancel` releases the lane via `InterLaneCoordinator.cancelConversationsFor()`, notifying peers with a synthesized inbox notice. The coordinator injects programmatic user-turns via `enqueueSystemPrompt()`, bypassing the UI composer. **Cross-harness (spec 141):** a module-level `HarnessDirectory` singleton (`src/acp/harness-directory.ts`) makes peering reach every open harness view, even across projects. It vends globally-unique, never-recycled lane numbers (`nextLaneNumber(labelPrefix)`) so a bare `displayName` permanently identifies one lane, and routes a cross-view `peer_send` in-process by splitting `deliver()` into `acceptInbound()` (run on the *target* coordinator, where the pending state that classifies initiator-vs-replier lives) and `recordOutbound()` (run on the sender's). Pending is keyed by the foreign `displayName` so the reply-clear matches on both legs; `#cancel` against a foreign peer routes `acceptForeignCancellation` onto the target view, and a disposing view flips `alive=false` then fans `onForeignHarnessClosed` snapshots out so waiting senders are notified. `peer_list` folds in `peersFor(harnessId)` (foreign peers tagged `local:false`, carrying `cwd`). The `#review` command (spec 145) rides this same `peer_send` path — agent-orchestrated multi-reviewer fan-out, same-project (the diff subject needs a shared worktree). See `docs/0106-inter-lane-messaging.md`, `docs/0141-cross-harness-peering.md`, `docs/0145-harness-design-review-panel.md`, and `docs/0107-acp-harness-transcript-readability.md`.

30. **ACP Harness Attention Triage (specs 128/130)** — A default-on router that distils *the decisions needing the human* (vs `lane peek heat`, which ranks activity). `AttentionTriageStore` (`src/acp/attention-triage.ts`) owns a **demand queue** of self-reported `JudgementItem`s ranked by reversibility (ties oldest-first) plus per-lane `LaneTriageStats` (flagged vs silent turns, counted at busy→idle in `finishTurn`). Any lane that receives the `krypton-harness-memory` MCP server is advertised `attention_flag` / `attention_resolve`; `hook_server.rs` validates the presence floor and round-trips to the frontend (`acp-attention-flag` → frontend assembles git blast-radius from the shared `acp_collect_review_git_state` collector's `diffstat`, inserts the item, replies `{ item_id }`). `attention_resolve` demotes a lane's own item to the silent pile (never deleted). The old `triage_equipped` directive field remains legacy metadata and visible as a badge, but no longer gates tool visibility. The view renders a static **backpressure gauge** (`N attention`, weight-dynamic since spec 138 — coloured by the heaviest open reversibility tier with a count pip strip, still motionless) in the global workspace footer and a summon-on-demand overlay (`Leader ;`); acknowledge is pure bookkeeping, redirect injects on the lane's next idle via `InterLaneCoordinator.deliverRedirect()`, dig opens the lane transcript. See `docs/0128-attention-triage.md`, `docs/0130-default-attention-triage.md`, and `docs/adr/0001-attention-triage-self-reported-router.md`.

31. **ACP Harness Review Quality Matrix (spec 146)** — A summary-only, session-only history of `#review` rounds per authoring lane, mirroring attention triage's surfaces. `ReviewQualityStore` (`src/acp/review-quality.ts`) keeps a per-lane `ReviewOutcome[]` (newest-first; `{ subjectLabel, reviewerCount, blockers, warnings, at }`) in memory, dropped on dispose. After synthesizing a `#review`, the convening lane self-reports via the default-on `review_outcome` MCP tool (`{ blockers, warnings, reviewer_count, subject_label }`); `hook_server.rs` round-trips it to the frontend (`acp-review-outcome` → `store.record()`, bare ack) — **no git collection and no retained review-session state** (the deliberate simplification that resolved the design-review blockers). It is an **observation, not a score** (ADR-0004): raw counts only, no verdict, no stored diff size, no jump-to-transcript anchor, no ranking. The view publishes a neutral `N reviews` depth indicator on the global footer via the `review:quality` ViewBus signal (distinct from the attention gauge — depth, not demand; never coloured by badness) and a summon-on-demand read-only overlay (`Leader '`, `j/k` switch lane). See `docs/0146-review-quality-matrix.md` and `docs/adr/0004-review-matrix-observation-not-score.md`.

32. **Diff review priority (spec 160)** — The authoring lane self-reports a per-change *reading-order hint* over the working diff via the default-on `mark_review_priority { ranges }` MCP tool (new-side line anchors; `high` / `routine` only — `normal` is the unreported default, so silence yields today's full diff). `hook_server.rs` validates and round-trips it (`acp-review-priority` → `AcpHarnessView.handleReviewPriority`, which stores the latest report per authoring lane in `reviewPriorityReports`, replies `{ recorded }`). The **Diff Window** (`src/diff-view.ts`) pulls a merged snapshot on open and on each auto-refresh through the compositor broker (`resolveDiffReviewPriority` → `diff.review-priority` control op on every harness owning the repo — a pull, no ViewBus broadcast), then maps each diff2html hunk to the overlapping ranges (highest level wins): `routine` hunks **collapse in place** to a one-line summary (`Enter`/click expands, remembered for the session via `expandedHunks`), `high` hunks get a full-cell gutter tint + a `◆ high` header badge and a dedicated `}`/`{` navigation (plain `n`/`N` still walk all hunks). The diff **always stays in file order — nothing is hidden or reordered**, and a range that maps to no hunk reverts to `normal` (under-collapse, never over-collapse). The nav header carries a static `N high · N routine` depth count. A **cross-file priority panel** (`p`, `.krypton-diff__priority`) docks right of the diff inside a flex `krypton-diff__content-row` (collapses via `[hidden]` so the diff reflows to full width — never covers it) and lists every reported range, `high` grouped first then `routine`. It is **live-preview** (variant B): `j`/`k` move the selection *and* scroll+tint the region immediately (`.krypton-diff__preview-row`), no `Enter` — same-file scroll is instant, cross-file switches debounced ~80ms (`priorityPreviewTimer`) to coalesce fast runs; `Esc` restores the pre-open file+scroll, `Enter`/`q`/`p` keep the previewed position. Re-maps on auto-refresh. Purely advisory; the human keeps the lock (ADR-0009 — the silent-pile principle applied to a diff). Complements spec 158 (carries the *human's notes in*; 160 carries the *lane's hints out*) and reuses its line-range anchor concept. See `docs/0160-diff-review-priority.md` and `docs/adr/0009-diff-review-priority-is-lane-self-reported.md`.

33. **Quick Overview dialog (spec 210)** — `QuickOverview` (`src/quick-overview.ts`) is the one global *read-only* modal for showing content, as opposed to the pickers/composers (command palette, quick file search, prompt dialog). It renders a pluggable `OverviewSource` — `{ title, meta, load(signal), actions }` returning an `OverviewBody` of `code` / `markdown` / `notice` / `element` — and owns the shell, the single scroll container, cancellation (`AbortController` per open), and the keyboard (`j`/`k`, `Ctrl+D`/`Ctrl+U`, `g`/`G`, `y`, `Esc`; source actions are dispatched first so a source can override a key). Editing is never inline: a source action escalates (`Enter`). The first consumer is hint mode's `filepath` rule via `createFilePeekSource()` (`src/file-peek-source.ts`), which resolves the path as written (absolute / `~` / `file://` / relative to `getFocusedWorkingDirectory()`), reads it with `read_file`, classifies it with the shared helpers in `src/file-preview.ts` (also used by the file manager preview), and maps `Enter` back to the pre-210 openers — Helix tab, markdown viewer, or OS browser. `[hints] file_action = "editor"` restores direct opening. `InputRouter` owns the `Mode.QuickOverview` transition, including the hint→overview handoff. See `docs/0210-quick-overview-dialog.md`.

34. **Review Board (spec 211)** — The surface where a lane *explains code* to the human and the human works through it. A `PaneContentType = 'review'` content window (`src/review-board/view.ts`) over a **lane-authored Markdown document plus typed fenced blocks** (`walkthrough`, `diff`, `finding`, `decision`, `chart`, `metrics`, `svg`), parsed by `src/review-board/parse.ts` (one `ReviewBlock` per top-level `marked` lexer token; a malformed or unknown `review:*` fence degrades to a diagnostic-carrying `markdown` block and is **never dropped**) and built into DOM by `src/review-board/render.ts` (markdown via the Markdown Viewer's `marked`+`highlight.js` stack, `diff` via `diff2html`, single-series accent-hued inline SVG for charts, allowlist-sanitized `svg`). Blocks are addressed by **stable content-addressed id** (`b<ordinal>-<fnv1a(raw)>`, `data-block-id`), never by CSS selector into rendered content — that is what lets a comment re-attach after the lane rewrites the document (`reattachBlockId` falls back from an exact id to a *unique* hash match). **Comprehension is the job, not defect-hunting**: prose plus a `walkthrough` is the required spine, findings/decisions are optional additions, and a Board with neither reads as `reference` rather than "0 unanswered" — never a score (ADR-0004). Keyboard: `n`/`N` block cursor, `}`/`{` next unanswered, `Tab`/`Shift+Tab` the guided walkthrough read (each step jumping the Diff Window via `DiffContentView.revealLocation`, falling back to a reader when the path is not in the diff), `a`/`x` triage, `1`…`9` decisions, `c` comment, `o` Review Map, `O` Overview, `[`/`]` chapter, `/` search, `s` send, `r` reload. **Spec 244 made it a chaptered reader**: chapters are derived from the document's own `H1`/`H2` headings (`ReviewDocument.sections`, derived state that is never serialized), the body renders one chapter at a time, and a 272px **Review Map** — `Overview`, the chapters with block/unanswered counts, `Open items`, `Full document` — is a permanent column at ≥1180px pane width and an on-demand overlay below it (driven by the view's own `ResizeObserver`, because `ContentView.onResize` is declared but never called). `Overview` renders no authored block and reports raw counts only, never a score. Render paths are split so a cursor move inside a chapter re-classes one element instead of rebuilding the document. **The result is a file, not session state**: `review_new`/`review_register`/`review_cancel` (`hook_server.rs`) clone spec 133's path-handoff into a durable gitignored bundle at `.krypton/reviews/<date>-<slug>/` (`review.md` + `response.md` + `assets/`), with issued-path write auto-approval widened from one file to the whole directory (`reviewWritePathMatches`, trailing-slash bounded so a sibling `-2` bundle cannot match). Answers **autosave** (debounced 400 ms → `write_review_response`; frontmatter is the source of truth, the body a generated rendering), so closing loses nothing and `s` is a separate act that routes `review.response` → `ReviewResponseQueue` (a third drain-on-idle queue beside specs 149/158) → a system turn. Bundles are **never swept** and are rediscovered by a directory walk (`list_review_bundles`), so `Leader Shift+R` → picker reopens a review from a previous app run intact; `#reviews` opens the read-only `/reviews` archive (spec 192's template, typed blocks re-rendered by a fence-aware post-pass over comrak). `#review`'s synthesis step now composes a Board instead of ending in turn text. See `docs/0211-review-board.md`.

35. **Xenon publisher (specs 212/259)** — The one path by which harness-generated resources leave this machine. `src-tauri/src/xenon.rs` collects review/analysis bundles, artifact HTML, repo docs, daily notes, attention flags and recorded Timeline events. Timeline uses `timeline::scan_project()`, exporting each `event.md` with bounded chronology/provenance metadata, excluding pending/dismissed candidates and resolution receipts; malformed events are non-retryable per-item failures. All families use the same content-addressed resource/blob/commit protocol against Xenon (`~/Source/xenon`), with unchanged re-push short-circuiting. `#push [--force] [<kind> [<slug>]]` drives publication; `#xenon timeline [<topic>]` opens hosted chronology while local `#timeline` remains authoritative. Publishing is explicit by default, with existing configured automatic triggers unchanged (ADR-0016/spec 269). Secret scanning, artifact feedback-capability removal, `.krypton/xenon-queue.json` retries and OS-vault bearer-token storage remain unchanged. Xenon is a sink and never creates a Krypton Timeline event. See `docs/0212-xenon-resource-server.md`, `docs/0259-timeline-xenon-publishing.md`, and ADR-0016.

36. **Backend link indicator (spec 213)** — The workspace footer's answer to "is the off-machine backend actually alive?". `xenon_status` reports *configuration* (it reads the TOML and asks the credential vault whether a token exists) and never touches the network, so a server that is down, a revoked token, and a healthy link were indistinguishable until a `#push` failed. `src/backend-link.ts` schedules a periodic `xenon_probe` — one authenticated `GET /v1/projects`, which distinguishes *unreachable* (transport error), *unauthorized* (401/403), and *linked* (2xx) in a single request; the server's `/healthz` cannot see the bearer token, so probing it would report green while a revoked credential blocked every push. The result is published as `system:backend-link` on the ViewBus and rendered by `WorkspaceFooter.renderLink()` as a fourth `sourceId`-keyed segment at the outer edge of the right cluster. Ticks are skipped while the document is hidden and fire once on re-show; `⌘P X` re-probes on demand; a completed manual or automatic push publishes the same signal (stronger evidence, no extra request). The probe path caches the token and the derived project slug for the process lifetime — the uncached `load_token` stays on the push path so a publish never acts on a stale credential. Coloured only when faulted, and hidden entirely when `[xenon].enabled = false` (ADR-0017). See `docs/0213-backend-link-indicator.md`.
37. **LLM usage log (spec 214)** — The project's answer to "what did this cost, on which model, in which lane?". At every turn end `finishTurn` builds one **numeric** row — tokens in/out/cached, model (with a flag for agent-confirmed vs configured intent), lane, backend, stop reason, duration, context level, and the adapter's own cost when it reports one — and hands it to Rust without awaiting. The unit is a *turn* because that is the unit ACP reports: the `session/prompt` response carries `usage` for that turn (`client.ts:196`), and the `usage_update` notification carries only the context *level*, so presence of a token field is the sole discriminator between the two (`isTurnUsage`). `usage_log.rs` appends the row to `.krypton/usage/<YYYY-MM-DD>.jsonl` **before** any network call and only then wakes a long-lived sender task, which POSTs it to `POST /v1/projects/{p}/usage/turns` — normally within a second. An ack cursor (`.krypton/usage/.cursor.json`) advances only on a 2xx, so a crash, a dead link, or a closed laptop costs nothing, and the row's client-generated `id` makes a retry after an ambiguous timeout a server-side duplicate rather than a second charge. Xenon stores rows in a dedicated `usage_turn` table and prices them **at read time** from `prices.json`, so correcting a rate corrects history; reported and estimated cost stay in separate columns and an unmatched model renders blank and is named, never zeroed (ADR-0018). Unlike every other thing that leaves this machine, usage is **not** a spec-212 resource and needs no `#push`: a row carries no prompt or response text, which is exactly what earns it an exemption from ADR-0016's explicit-publish rule (ADR-0019). `#usage` reads the local log (so it answers offline), `#usage open` opens the server ledger, `#usage flush` skips the retry backoff. A turn whose adapter reports no counters still produces a row with `tokens: null` — an unmeasured lane must not look like an idle one. Spec 249 derives prompt-cache hit rate as `cachedRead / (input + cachedRead + cachedWrite)`: the live stats cell uses a separate coherent last-turn tuple, while `#usage` and `#daily` use recorded day totals; missing counters never become a guessed percentage. Spec 250 carries a non-empty `#usage` rollup on its system transcript item and renders it as a bounded telemetry card; the existing summary text stays on the same item as the Live Assist and generic-renderer fallback. See `docs/0214-llm-usage-statistics.md`.


38. **Project-grouped Artifact Gallery (spec 265)** — The loopback `GET /artifacts` projection groups the in-memory `HarnessArtifactStore` registry by an opaque hash of each canonical project path, not by transient harness or lane. Stores for the same project are unioned and artifacts are deduplicated by ID (`RegisteredLive` over `Pending`, then non-empty hash, then lowest harness ID), so disk rehydration from multiple live harnesses cannot duplicate cards. The response exposes `projectId`, basename `projectName`, and artifact rows without absolute paths or harness IDs. `src/acp/artifact-gallery.html` uses those projects for its `all` + project tabs and section headings; lane labels remain visible on every card as provenance. See `docs/0265-artifact-gallery-project-grouping.md`.

39. **Keyboard overlay (spec 271)** — `KeyboardOverlay` (`src/keyboard-overlay.ts`) is a read-only ghost-hands keyboard: a transparent `<canvas class="krypton-keyboard-overlay">` fixed at the center-bottom of the workspace screen (flush on the 28px workspace footer, or on the screen edge when the footer is hidden), `pointer-events: none`, z-index 7900 — above windows and the Quick Terminal, below inline AI prompts and every modal overlay. A passive `window` capture `keydown` listener observes keys (never `preventDefault`/`stopPropagation`), resolves them to physical keys by `e.code`, switches labels to Kedmanee on Thai input in `auto` layout, and drops keys while `get_pty_secure_input` reports the focused PTY at a password prompt (`ECHO` off + `ICANON` on, cached 250ms). Rendering lives in `src/keyboard-overlay-model.ts` (geometry, finger map, 21-point hand pose, `KeyboardOverlayRenderer`, `KeyboardOverlayDriver`), run in `keyboard-overlay-worker.ts` on an OffscreenCanvas or on the main thread as a fallback. The rAF loop stops once glow fades and the hands settle, so an idle overlay draws 0 frames. Lazy-imported by `Compositor.toggleKeyboardOverlay()` (`Leader Shift+K`, palette **Toggle Keyboard Overlay**) or `[keyboard_overlay].enabled`. Theme/font changes are picked up by a `MutationObserver` on `<html>`'s inline style. With `[keyboard_overlay].mouse` (default on) the canvas widens from 15.4U to 21.6U for a drawn mouse: passive `window` capture pointer listeners post the pointer position (normalized, at most once per frame) and left/right button state, and the right hand grips the mouse after a pointer move with no key for 0.7 s.

40. **Review till pass (spec 276)** — `#review pass [N] [<lane>…] [-- <doc|note>]` repeats review → fix → re-review on the authoring lane until every reviewer returns `VERDICT: PASS` or N rounds (default 3, max 8) run out. Unlike plain `#review` (agent-orchestrated, spec 145), the **harness sequences the rounds** (ADR-0021): `HarnessReviewLoopController` (`src/acp/harness-review-loop-controller.ts`, spec 275 controller pattern) fans each round out via `deliverMentionFanOut(…, { replyConsumer: 'harness' })`, and `InterLaneCoordinator.drain()` routes those replies to `LaneHost.onHarnessReply` instead of composing a turn for the requester. The pure half (`src/acp/review-loop.ts`) parses replies (`### Blockers/Warnings/Suggestions` + the last `VERDICT:` line; any Blocker makes it FAIL), evaluates the round (`pass`, `max_rounds`, `no_change` by subject fingerprint, `no_progress`, `no_findings`, `inconclusive`, `no_structure`), and builds the request, fix, and summary prompts. Each round records a harness-parsed spec 146 matrix row; a loop with a completed round ends in one summary Board. `#review stop` is graceful; `#cancel` / Ctrl+C is hard. See `docs/0276-review-till-pass.md`. Spec 277 projects the loop onto the browser lane monitor: `HarnessReviewLoopController.telemetry(laneId)` feeds `TelemetryLane.reviewLoop` (telemetry schema v4) through the publisher's `reviewLoopFor` option, the controller calls `loopChanged()` → `telemetryPublisher.schedule()` on every state change, and the last ended loop stays on the lane card until the next loop or a lane close. See `docs/0277-review-pass-dashboard.md`.

41. **Mid-turn steering (spec 278)** — On a busy ACP harness lane whose adapter advertises the `_session/steering` vendor extension (top-level initialize `_meta.steering.supported`; claude-agent-acp and codex-acp), `Enter` sends the prompt into the running turn instead of queueing it; `Cmd+Enter` keeps the spec 136 queue. Rust `acp_steer` issues the `_session/steering` request (with `idleBehavior: "promptRequired"`), and `HarnessSteerController` (`src/acp/harness-steer-controller.ts`, spec 275 controller pattern) owns the outcome: `injected` marks the `steer` row; `promptRequired`, `failed` and errors move the text to the head of the queue. The `stop` event goes through the controller: while a steer is in flight or a turn it started still runs, the stop is held and `finishTurn` runs whole only afterwards, so turn-end cleanup never hits the newer turn and no peer-mail or queue drain can collide with it. A Codex `startedNewTurn` turn is followed to its `session_info_update` thread-status idle (`AcpClient` maps it to a `turn_state` event). Because invoke results are not ordered with events, `acp_prompt` / `acp_steer` mark their request ids and the Rust reader emits a `turn_marker` event for those replies in stdout order; the controller counts started turns and active → idle pairs after the prompt marker. See `docs/0278-acp-harness-steering.md`.

42. **Live voice (spec 280)** — `#live [voice]` / `Cmd+Shift+L` binds one realtime voice session (Codex `gpt-live-1-codex`, the private endpoint OMP `/live` uses, billed to the ChatGPT subscription) to one harness lane. Media stays in WebKit: `HarnessLiveVoiceController` (`src/acp/harness-live-voice-controller.ts`, spec 275 controller pattern) captures the mic with `getUserMedia` (echo cancellation on), runs an `RTCPeerConnection` with the `oai-events` data channel, and plays the remote track. Rust `live_voice.rs` owns the two steps that need the OAuth token read from `~/.codex/auth.json` (read-only, never refreshed): `live_voice_signal` POSTs the SDP offer to `chatgpt.com/backend-api/codex/realtime/calls` with Codex Desktop headers (no attestation), and `live_voice_open_sideband` opens `wss://api.openai.com/v1/live/<rtc_id>`, forwarding server frames as `live-voice-event` and client frames from `live_voice_send`. One call app-wide; every command carries a generation, and a new signal supersedes the old call. A `delegation.created` frame becomes a lane prompt through `deliverLivePrompt`: an idle lane starts it, a busy lane is steered, and a busy lane that cannot be steered queues it (spec 136) carrying `QueuedPrompt.liveDelegationId`, with `"Agent Queued"` sent back to the model; a missed steer re-queues the same way. `LiveDelegationLedger` (`src/acp/live-voice.ts`) binds the running turn to its delegation; assistant text before each `tool_call` goes back as `commentary`, and `finishTurn` sends `"Agent Final Message"` for the model to speak. See `docs/0280-harness-live-voice.md`.

    **Microphone gate (spec 314).** Sessions start muted. After capture resolves, the controller sets `track.enabled = !session.muted` before peer attachment, so startup sends silence unless a valid hold began while permission was pending. Only a fresh bare `AltLeft` press routed through the focused Harness opens the microphone; Right Option is untouched. Window-capture release closes it, and another key cancels the hold until Left Option is released. Blur, document hidden, or focus leaving the Harness closes the gate without stopping the session, playback, or delegation; returning focus does not reopen it. Muted input meters reset to zero and only the live strip is patched. Stop/dispose removes the release and safety listeners. The authoritative interaction contract is [spec 314](./0314-harness-live-push-to-talk.md).

43. **Assist sidecar (spec 306)** — A second, cheap model post-processes a finished harness turn, reached **through an ACP backend subprocess** like a lane, so it needs no API key. `src/acp/assist/` is the task-agnostic half: `acp-completion.ts` owns one warm, fenced session (`mcpServers: []`, permissions declined, writes refused, questions cancelled — an unanswered request would park `session/prompt` forever), `engine.ts` owns the guards (abort + deadline, byte caps, per-task circuit breaker) over an injected transport, `types.ts` is the `AssistTask<T>` contract, `config.ts` merges `task.defaults ← [acp_harness.assist] ← [acp_harness.assist.tasks.<id>]` and clamps it, and `registry.ts` lists the tasks: `[followUp, grammar]`. `HarnessAssistController` (`src/acp/harness-assist-controller.ts`, spec 275 controller pattern) is called from `finishTurn` and from the prompt send path, applies the trigger gates (active lane, `end_turn`, no pending decision, not a system turn, one run per `turnSeq`, no cooldown), runs eligible tasks sequentially, and publishes each result on its surface: `'panel'` (the grammar review in the right rail) or `'transcript'` (follow-ups on the reply). `Cmd+/` re-asks the first registered task (`follow-up`). Off by default (`mode = "off"`): the call spends the same subscription quota the lanes spend. The v1 `next-prompt` task and its composer `AssistStrip` (`Cmd+1..3`) were removed on 2026-10-23: follow-up prompts (spec 327) cover the steps a reply offers.

    **Follow-up actions (specs 323, 327).** `tasks/follow-up.ts` uses the `'transcript'` surface: Krypton extracts candidate shell commands and http(s) URLs from the last reply, the model only picks and labels them, and it may also write a `prompt` for the lane itself (spec 327; dropped if it starts with `#`/`!`/`/`/`@` or carries `{{#`). The controller stores the result on that reply (`HarnessTranscriptItem.followUps`) and calls `host.patchFollowUps`. `FollowUpRail` (`src/acp/components/follow-up-rail/`), owned by `AssistantRow` outside its body deps, paints the buttons; click or `f` hint runs `open` through `openExternalUrl`, `run` in a terminal tab via `src/acp/follow-up-run.ts`, and `prompt` through `submitLanePrompt(…, 'queue')`; a prompt card's paste icon or `Shift`+hint inserts it into the composer instead (`insertDraft`). See `docs/0323-harness-follow-up-actions.md` and `docs/0327-harness-follow-up-prompts.md`.

44. **File Manager (`src/file-manager/`, specs 052, 317)** — `FileManagerView` (the `file_manager` `ContentView`, lazy-imported by the compositor as `./file-manager`, which resolves to the directory's `index.ts`) is a thin orchestrator on the `src/ui/` kernel. Module map: `types.ts` (shared types), `state.ts` (one mutable `FileManagerState` + pure helpers and selectors that produce component props), pure `sort.ts` / `filter.ts` (the `/` subsequence filter) / `fuzzy.ts` (the `f` scored search + match runs) / `skill.ts` (frontmatter + skill cards) / `file-type.ts` / `decorations.ts`, `keymap.ts` (normal-mode `NORMAL_KEYMAP` + `dispatchNormalKey`, `gg` chord), `modes.ts` (confirm / prompt / filter / search handlers), `ops.ts` (every Tauri `invoke`), `preview/` (`registry.ts` ordered renderers, `controller.ts` 80 ms debounce + generation guard, `renderers/<id>.ts`), and `components/` (`Breadcrumb`, `FileList` + `FileRow`, `SearchList` + `SearchRow`, `PreviewPane`, `StatusBar`; the lists `reconcile()` keyed rows over the virtual window on the one shared `__list` node). Styles stay in the unlayered `src/styles/file-manager.css`. Extension recipes: **preview type** — add `preview/renderers/<id>.ts` and insert it into `PREVIEW_RENDERERS` (order is priority; a renderer may decline with `null`); **key** — append a `KeyBinding` to `NORMAL_KEYMAP` (add a `KeyCtx` method if the action is new); **row decoration** — append a `RowClassDecorator` to `ROW_CLASS_DECORATORS` and add its CSS rule. `src/file-manager/view.parity.test.ts` pins DOM, `invoke` traffic, keys and timers against snapshots recorded from the pre-317 class.

45. **E2E commands (spec 328)** — `#e2e` in the ACP Harness runs and tracks the project's end-to-end tests with no in-app view. `HarnessE2eController` (`src/acp/harness-e2e-controller.ts`, spec 275 controller pattern) dispatches the subcommands; the pure half `src/acp/e2e-command.ts` parses the grammar, derives the marks (`uncommitted`, `edited`, `unreported`, `no case`) and lays results out as `shell`-row text on the cell grid. `status`, `run`, `run all`, `rerun` and `cancel` call Rust `e2e.rs` and answer in one `shell` row filled once when the work ends (the `!shell` life cycle); `init`, `case` and `report` are prompt verbs for the current lane (`e2eInitPrompt`, and the manifest's `create_prompt` / `report_prompt` via `renderE2ePrompt`). `open [<case>]` (spec 329) opens the read-only browser explorer through `get_e2e_web_url` + `open_url`. Unavailable in a remote Harness.

46. **Inline AI transport (spec 333)** — The terminal's `Cmd+K` overlay (`src/inline-ai.ts`, spec 50) gets its model **through an ACP backend subprocess**, so the backend CLI's login is the credential and no API key is involved. `InlineAcpSession` (`src/inline-ai-session.ts`) is owned by the compositor. It keeps one warm process per `[inline_ai] backend` + pane cwd and opens a fresh `session/new` per `Cmd+K`. After that it applies `model` (`acp_set_lane_model`) and `mode` (`acp_set_session_mode` → `session/set_mode`, default `"default"`, so a user's Claude `auto` mode cannot approve commands on its own). Setup and turns go through one serial queue, so a cancelled turn's late chunks never reach the next overlay. A turn that ignores `session/cancel` for 5 s gets its process killed. The fence (`src/acp/headless-fence.ts`, shared with the assist sidecar) declines every permission, write and question.

47. **Inline AI terminal context (spec 334)** — `src/terminal-context.ts` gives `Cmd+K` the user's terminal state. The existing OSC 133 handler in `Compositor.wireProgramStatus` also feeds a per-terminal `ShellCommandLog` (held in a `WeakMap<Terminal, …>` and reset on RIS). fish 4 sends `133;C;cmdline_url=…` and `133;D;<exit>` by default; the log keeps the last 5 commands with their exit codes. Only the newest finished record and a running one keep xterm markers for their output rows. `openInlineAI()` snapshots the pane right after `get_pty_cwd`, before the lazy imports. `buildTerminalContext` builds one `<terminal_context>` block from cwd, shell, foreground process, the SSH target (`detect_ssh_session`, only when the foreground is `ssh`), the selection, recent commands, and then either the newest output or the screen tail. The block is capped at 8 000 chars and passed through `redactSecrets`. The overlay sends it with the conversation's first completed turn only and shows its label (`.krypton-inline-ai__context`).

48. **Inline AI failure follow-up (spec 335)** — `src/inline-ai-follow-up.ts`. Accepting a `Cmd+K` command (`↵` / `⇧↵`) no longer ends its conversation: `InlineAIOverlay` calls `hooks.onAccept`, and `Compositor.acceptInlineAI` detaches the overlay and builds one `InlineFollowUp` for the focused pane — only when `[inline_ai] follow_up` is on, the Quick Terminal is hidden, and that terminal's latest OSC 133 event is a prompt (`osc133Last`, spec 336: a shell that sends OSC 133 is in front, which is not so while a local fish runs `ssh` into a host that sends none). Its `CommandWatch` reads the same OSC 133 handler (after `ShellCommandLog.apply`) and the pane's `onData` (Enter): `C`…`D` with an exit other than 0/130 is a failure, and Enter followed by a bare `A` is a line the shell rejected (fish sends no `C`/`D` for a syntax error). The controller builds a `<command_result>` (`buildCommandResult`, 0334 caps and redaction; output only with `context = true`), runs `overlay.runFix()` on the same ACP session while detached, and paints an `AI FIX` chip (`.krypton-inline-followup`) on the `.krypton-pane`. `Cmd+K` in that pane re-attaches the overlay (`resume()`); an accept from a fix prefixes `Ctrl+E Ctrl+U` so fish's kept line is replaced. One follow-up at a time (one ACP session per backend process): the next `Cmd+K` elsewhere, the next command in that pane, RIS or pane close ends it and closes the conversation.

49. **Inline AI on the pane's host (spec 336)** — Both modes' instructions carry a verify-first rule (check facts with read-only commands before answering). In an SSH pane (`processBySession` says `ssh`) with `[inline_ai] remote_checks` on, `openInlineAI` calls `openInlineRemote` (`src/inline-ai-remote.ts` → Tauri `inline_remote_open`) without awaiting. Rust (`src-tauri/src/inline_remote.rs`) resolves the pane through `SshManager::detect` (re-parsed when the `ssh` pid changes) and `ssh_channel.rs` (`ssh -G`, borrow the pane's ControlMaster after `-O check`, else own one with `BatchMode=yes`), probes `$SHELL` and `hostname -s` over `sh -s`, keeps the OSC 7 cwd only when its host matches, and issues a token. The session's MCP list (`setMcpServers` before every `session/new`) then holds `krypton_inline` → `POST /mcp/inline` on the hook server with header `x-krypton-inline-capability`; its one tool `host_exec` runs a command on the host only when `read_only_script` (spec 318) accepts it, via `ssh … sh -s` with the script on stdin, 15 s default timeout, 2 per token, 8 KiB head + tail per stream. The inline fence approves `mcp__krypton_inline__host_exec` by exact identity (`isExactMcpTool`) with `allow_once`. The overlay sends a `<pane_host>` block with the first turn, labels `checks on <host>` / `no remote checks`, and shows `host $ cmd`; the token is closed with the conversation (the compositor wraps its `close`).

### Window DOM Structure

Krypton uses a cyberpunk/sci-fi chrome style. Each window has a titlebar with session label and PTY status, a **tab bar** inside the titlebar row (auto-shown when multiple tabs exist; while visible the label text hides and the tabs take its width), and a **content area** containing the active tab's pane tree. Pane trees are binary splits — each leaf is a `.krypton-pane` hosting an xterm.js instance, and splits are `.krypton-split` containers with a `.krypton-split__divider` between two children.

```html
<html style="background: transparent">
<body style="background: transparent">
  <div class="krypton-workspace"
       style="background: transparent; width: 100vw; height: 100vh;">

    <div class="krypton-window krypton-window--focused" id="win-0"
         style="position: absolute;">
      <div class="krypton-window__chrome">
        <div class="krypton-window__titlebar">
          <div class="krypton-window__label-group">
            <div class="krypton-window__status-dot"></div>
            <span class="krypton-window__label" data-title="session_01">session_</span>
          </div>
          <!-- Tab bar: auto-shown when >1 tab or always_show_tabbar = true.
               Rounded pills; hides .krypton-window__label while visible. -->
          <div class="krypton-window__tabbar krypton-window__tabbar--visible">
            <div class="krypton-tab krypton-tab--active" data-tab-id="tab-0">
              <span class="krypton-tab__index">01</span>
              <span class="krypton-tab__dot"></span>
              <span class="krypton-tab__title">Shell 1</span>
            </div>
            <div class="krypton-tab" data-tab-id="tab-1">
              <span class="krypton-tab__index">02</span>
              <span class="krypton-tab__dot"></span>
              <span class="krypton-tab__title">Shell 2</span>
            </div>
          </div>
          <div class="krypton-window__titlebar-end">
            <span class="krypton-window__pty-status">~/projects</span>
            <span class="krypton-window__label-tail">01</span>
          </div>
        </div>
        <!-- header-accent: a <canvas> oscilloscope (HeaderScope) by default, or a
             static striped <div> when chrome.header_accent.style = "ticks". Fed by
             PTY throughput on terminal windows, or streamed model output on content
             windows (agent/ACP/harness, via ContentView.onOutputPump); rAF stops at
             idle. See specs 188 and 189. -->
        <canvas class="krypton-window__header-accent krypton-window__header-accent--scope"></canvas>
      </div>
      <!-- Content area: hosts the active tab's pane tree -->
      <div class="krypton-window__content">
        <!-- Single pane (leaf node) -->
        <div class="krypton-pane krypton-pane--focused" data-pane-id="pane-0">
          <!-- xterm.js mounts here -->
        </div>

        <!-- OR a split with two panes -->
        <!--
        <div class="krypton-split krypton-split--vertical">
          <div class="krypton-pane krypton-pane--focused" data-pane-id="pane-0">
            xterm.js
          </div>
          <div class="krypton-split__divider"></div>
          <div class="krypton-pane" data-pane-id="pane-1">
            xterm.js
          </div>
        </div>
        -->
      </div>

      <div class="krypton-window__footer">
        <div class="krypton-window__usage-status">
          <span class="krypton-window__usage-provider">CODEX 5h 41% / week 34%</span>
          <span class="krypton-window__usage-provider">CURSOR month 19%</span>
        </div>
        <div class="krypton-window__lane-strip">...</div>
      </div>
    </div>

    <!-- More windows... -->

    <!-- Quick Terminal (overlay, toggled via Cmd+I) -->
    <div class="krypton-quick-terminal" id="quick-terminal"
         style="position: absolute; z-index: 5000; display: none;">
      <!-- Same chrome structure as regular windows (no tabs/panes) -->
      <div class="krypton-window__chrome">
        <div class="krypton-window__titlebar">
          <div class="krypton-window__label-group">
            <div class="krypton-window__status-dot"></div>
            <span class="krypton-window__label" data-title="QUICK_TERMINAL">QUICK_TERMINAL</span>
          </div>
          <div class="krypton-window__titlebar-end">
            <span class="krypton-window__pty-status">PTY_STREAMS // ACTIVE</span>
          </div>
        </div>
      </div>
      <div class="krypton-window__content">
        <div class="krypton-window__body">
          <!-- xterm.js mounts here (single terminal, no tab/pane structure) -->
        </div>
      </div>
    </div>

    <!-- Dashboard overlay (shown when a dashboard is active, z-index: 9500) -->
    <div class="krypton-dashboard krypton-dashboard--visible">
      <div class="krypton-dashboard__backdrop"></div>
      <div class="krypton-dashboard__panel">
        <div class="krypton-dashboard__header">
          <span class="krypton-dashboard__title">Git Status</span>
          <span class="krypton-dashboard__shortcut-hint">Cmd+Shift+G</span>
          <button class="krypton-dashboard__close">&times;</button>
        </div>
        <div class="krypton-dashboard__content">
          <!-- Dashboard-specific content rendered by onOpen() -->
        </div>
      </div>
    </div>

    <!-- Which-key popup (shown during compositor/resize/move/tab-move modes) -->
    <div class="krypton-whichkey">...</div>

    <!-- Workspace footer (single 28px bottom rail: status + music segment) -->
    <footer class="krypton-workspace-footer" role="status" aria-live="polite">
      <div class="krypton-workspace-footer__left">NORMAL · terminal Shell 1</div>
      <div class="krypton-workspace-footer__center">~/projects · main *</div>
      <div class="krypton-workspace-footer__right">
        <span class="krypton-workspace-footer__hint">Leader v select · Cmd+O files</span>
        <div class="krypton-workspace-footer__music"></div>
      </div>
    </footer>
  </div>
</body>
</html>
```

### Window Identity Model

Each window has a stable `window_id` (e.g., `"win-0"`, `"win-1"`). The workspace state is:

```
workspace_name -> [ WindowSlot { window_id, grid_position, abs_override?, session_ids } ]
```

When switching workspaces:
- Windows in both workspaces: **animate** from current to target position/size
- Windows only in target: **create** with entrance animation, assign idle session or spawn new shell
- Windows only in current: **hide** with exit animation (DOM hidden, PTY kept alive in session pool)

## 5.5 Config Manager (Backend)

The Config Manager (`src-tauri/src/config.rs`) handles loading and serving the TOML configuration:

- **Serde structs**: `KryptonConfig` with subsections `ShellConfig`, `FontConfig`, `TerminalConfig`, `ThemeConfig` (with `ThemeColors`), `QuickTerminalConfig`, `WorkspacesConfig`. All derive `Default` and use `#[serde(default)]` so missing fields fall back to built-in defaults.
- **Config path**: `~/.config/krypton/krypton.toml` on all platforms (resolved via `dirs::home_dir()`).
- **First-run behavior**: If the config file doesn't exist, the directory is created and a default config is written.
- **Parse errors**: Logged and silently fall back to defaults (app still starts).
- **IPC**: `get_config` Tauri command returns the full `KryptonConfig` to the frontend on startup. `run_command` Tauri command runs a short-lived process (non-PTY) and returns stdout, used by overlay dashboards to gather data (e.g., `git status --porcelain`, `git branch --show-current`). `query_sqlite` Tauri command executes read-only SQL queries against a specified SQLite database and returns rows as JSON objects, used by the OpenCode dashboard to read session/message/token data. Pencil uses dedicated file IPC (`read_pencil_file`, `write_pencil_file`, `rename_pencil_file`, `scan_pencil_dir`) so drawing IO and picker rename do not shell out.
- **Shell config**: `spawn_pty` command accepts optional `shell`/`shell_args` params from the frontend, falling back to config values, then `$SHELL`.
- **Exit detection**: each PTY session has a reader thread for output/progress events and a child wait thread for lifecycle events. Either PTY EOF/error or child exit emits `pty-exit`; the frontend de-duplicates duplicate exit events.

Frontend counterpart: `src/config.ts` defines matching TypeScript interfaces and a `loadConfig()` function. The compositor's `applyConfig()` method applies settings (font, terminal, theme colors, Quick Terminal sizing, workspace gap/step sizes) before the first window is created. It is also re-run on **Reload Config** / the `config-changed` event, after which `relayoutAfterConfig()` re-tiles so a changed `[workspaces] gap` lands without a restart (skipped while a window is maximized). `default_layout` is honored on the **first** apply only, so a reload never yanks the user out of the layout they cycled into with `Leader f`.

## 5.6 Workspace Manager (Backend)

The Workspace Manager lives in Rust and handles the data/logic side:

- Parse `[[workspaces.layouts]]` from TOML config
- Store built-in presets and user overrides
- Respond to `invoke("switch_workspace", { name })` — send target workspace layout to frontend compositor via Tauri event
- Track window-to-session mapping in the session pool
- Handle `invoke("get_workspace_list")` — return available workspace names for UI display

The actual window positioning and animation is **frontend-driven** (CSS/JS), not Rust-driven, because the compositor operates entirely within the DOM.

### Theme Engine (Backend — `src-tauri/src/theme.rs`)

The Theme Engine lives in Rust (`theme::ThemeEngine`) and manages theme loading:

- Embeds built-in themes at compile time via `include_str!` (krypton-dark, krypton-light, legacy-radiance)
- Scans `~/.config/krypton/themes/*.toml` for custom theme files
- Resolves themes by name (custom themes take precedence over built-in)
- Applies `[theme.colors]` config overrides on top of the resolved theme
- Serves full theme data (`FullTheme` struct — name, meta, colors, chrome, focused, workspace, ui) to the frontend via `invoke("get_theme")`
- Lists available themes via `invoke("list_themes")`
- Switches the active theme via `invoke("set_theme")` (resolves, persists `theme.name`, emits events)
- Supports `invoke("reload_config")` for an explicit re-read of `krypton.toml` (command palette **Reload Config**). There is no filesystem watcher.
- **Tauri commands**: `get_theme`, `list_themes`, `set_theme`, `reload_config`
- **Tauri events**: `theme-changed`, `config-changed` (emitted on `set_theme` and `reload_config`)

### Theme Engine (Frontend — `src/theme.ts`)

The Frontend Theme Engine (`FrontendThemeEngine`) receives theme data and applies it:

- Sets `--krypton-*`, `--agent-*`, and `--vault-*` CSS custom properties on `document.documentElement` so terminals, chrome, ACP Harness, Agent, and Vault follow the active color theme. Harness paint uses those tokens (ink, surfaces, accent RGB); `--agent-surface-solid` comes from the chrome backdrop, not ANSI black.
- Classifies the theme as `light` or `dark` from chrome-backdrop luminance and sets `html[data-theme-scheme]`. Light themes get a cooler rail vs paper canvas (so zen sidebar and transcript don't collapse into one frost slab) and `styles/theme-scheme.css` rewrites neon-on-void chrome (0.15–0.45 accent alpha, glow type). Under a light scheme the engine also emits the opaque text tiers `--krypton-ink-2/3/4`, solved to 7 / 4.5 / 3:1 on the rail. Stylesheets reference them with the dark value as the `var()` fallback, and accent text passes through an OKLCH lightness cap ([spec 321](./0321-light-scheme-legibility.md)). The engine removes any property the previous apply wrote and the new record lacks.
- Parses `#rgb`, `#rrggbb`, `rgb()`, and `rgba()` (3-digit hex like `#0cf` must not collapse to `0, 0, 0`)
- Builds xterm.js theme objects from theme colors for terminal instances
- Listens for `theme-changed` Tauri event from backend (command-palette switch and `reload_config`)
- Notifies the compositor to update all existing terminal instances and the index-0 window accent on theme change
- `styles.css` uses `var(--krypton-*)` throughout so theme changes cascade instantly

### Config load (Backend — `src-tauri/src/config.rs`, `commands.rs`)

- Config is read from `krypton.toml` at startup into `Arc<RwLock<KryptonConfig>>`
- Palette **Color Theme** calls `set_theme` (persists `theme.name`, emits `theme-changed` / `config-changed`)
- Palette **Reload Config** calls `reload_config` (re-reads the file, applies sound, emits the same events)
- Editing the file on disk does **not** auto-apply. There is no `notify` watcher on `~/.config/krypton/`

## 5.6 Input Router & Mode System (Frontend)

The input router is the central keyboard dispatcher. It determines what happens with each keypress based on the current **mode**:

### Modes

| Mode | Activated by | Behavior | Exit |
|------|-------------|----------|------|
| **Normal** | Default | Keypresses forwarded to focused window's PTY | Enter another mode via leader key |
| **Compositor** | Leader key (`Cmd+P`) | Keypresses interpreted as compositor commands, or as focused content-view leader actions when the view owns a non-conflicting local key | Auto-exits after one action, or `Escape` to cancel |
| **Resize** | `Leader` then `R` | Arrow keys resize the focused window; step size configurable | `Escape` or `Enter` to confirm |
| **Move** | `Leader` then `M` | Arrow keys reposition the focused window | `Escape` or `Enter` to confirm |
| **Selection** | `Leader` then `v` or `V` | Vim-like keyboard text selection — virtual cursor navigates buffer with h/j/k/l/w/b/e/0/$, `v` toggles char-wise selection, `V` toggles line-wise, `y` yanks to clipboard | `Escape` to cancel, `y` to yank and exit |
| **Hint** | `Leader` then `Shift+H` or `Cmd+Shift+H` (global) | Scans visible buffer for regex patterns (URLs, paths, emails), overlays keyboard labels on matches. Type a label to act (open/copy/paste). | `Escape` to cancel, or selecting a label |
| **QuickOverview** | Selecting a `filepath` hint (or any future source-based peek) | Read-only Quick Overview dialog renders an `OverviewSource` (code / markdown / notice / element). `j`/`k`, `Ctrl+D`/`Ctrl+U`, `g`/`G` scroll; `y` copies the path; `Enter` runs the source's escalation | `Escape`, or a source action that closes |
| **Dashboard** | Dashboard shortcut (e.g., `Cmd+Shift+G` for Git) | Displays a full-screen overlay panel. Keys delegated to the active dashboard's `onKeyDown` handler. | `Escape`, or re-pressing the dashboard's toggle shortcut |

**Compositor single-action keys (in Compositor mode):**

Focused content views may add local leader actions by implementing `ContentView.getLeaderKeyBindings()`. Each view exports static `LeaderKeySpec` metadata beside the view implementation; `src/leader-keys.ts` owns canonical key normalization and the global reserved-key list. `src/leader-keys.test.ts` imports all local metadata and fails if any local key conflicts with a global key or another local key. Disabled local bindings are hidden from which-key and never fall back to global behavior. Current local bindings include Markdown `;` for link hints, ACP Harness `+`/`_`/`=`/`0` for lane lifecycle, metrics, and project-scoped session resume, and Pencil `/` to open an existing drawing in the focused tab plus `?` for creating a new drawing beside the focused file.

| Key | Action |
|-----|--------|
| `g` | Cycle shader preset on focused pane (none → crt → hologram → glitch → bloom → matrix → none) |
| `G` (Shift+g) | Toggle shaders on/off globally |
| `c` | Clone SSH session from focused pane into a new tab (via ControlMaster multiplexing) |
| `C` (Shift+c) | Clone SSH session from focused pane into a new window |
| **Command Palette** | `CmdOrCtrl+Shift+P` | Text input filters the action list; Enter executes; Escape closes | `Escape` or action execution |
| **Search** | `CmdOrCtrl+F` | Text input searches scrollback in the focused window | `Escape` to close |

**Global hotkeys that work from any mode:**
- `Cmd+I` — Toggle Quick Terminal (show/hide centered overlay terminal)
- `Cmd+Shift+P` — Toggle Command Palette (fuzzy-searchable action list)
- `Leader Y` — Open ACP Harness, a multi-lane ACP content view sharing the focused CWD
- `Ctrl+Shift+S` — Global macOS screen capture; stages into the active ACP Harness lane when that view is focused, otherwise routes to the smart prompt dialog queue
- `Cmd+Shift+<` / `Cmd+Shift+>` — Cycle focus counterclockwise / clockwise through visible Grid and Focus windows; other layouts retain their native linear or stack order
- `Ctrl+Shift+U` / `Ctrl+Shift+D` — Scroll terminal buffer up/down by one page
- `Cmd+Shift+H` — Enter hint mode (scan terminal for URLs/paths/emails, overlay labels)
- `Cmd+Shift+G` — Toggle Git Dashboard (overlay showing git status for focused terminal's CWD)
- `Cmd+Shift+O` — Toggle OpenCode Dashboard (session history, token usage, model/tool stats from local SQLite DB)

### Key routing flow

```
Keypress
  |
  v
[Is Quick Terminal toggle?] --yes--> Show/hide Quick Terminal, transfer focus
  |
  no
  v
[Is a global hotkey?] --yes--> Execute global action (workspace switch, command palette, etc.)
  |
  no
  v
[Current mode?]
  |
  +-- Normal --------> Forward to focused window's xterm.js -> PTY (content views: onKeyDown)
  +-- Compositor ----> Dispatch focused-view local leader key if owned, otherwise interpret as global compositor command
  +-- Resize --------> Adjust focused window size
  +-- Move ----------> Adjust focused window position
  +-- Selection -----> Navigate virtual cursor / expand selection
  +-- Hint ----------> Filter/select hint labels -> execute action
  +-- QuickOverview -> Scroll the peeked content / run a source action
  +-- Cmd Palette ---> Filter/select action list
  +-- Dashboard -----> Delegate to active dashboard's onKeyDown handler
  +-- Search --------> Update search query
```

Native `Cmd+V` is a `paste` event on `document.activeElement`, not a key routed through `onKeyDown`. Switching windows moves DOM focus onto the newly focused pane so that event lands on the compositor-focused surface. If it still lands on a background content view, InputRouter retargets it to `ContentView.handlePaste`.

### Command Palette

The command palette is a fuzzy-searchable overlay listing **every action** in Krypton:

- Window actions: new, close, focus next/prev, focus by index, maximize, restore, swap, reset layout, toggle focus layout, toggle pin
- Tab actions: new, close, next/prev, move to window
- Workspace actions: switch by name, next/prev workspace
- Pane actions: split horizontal/vertical, close, navigate
- Theme actions: switch theme
- Clipboard: copy, paste
- Search: open search, next/prev match
- Config: reload config, open config file
- Dashboard actions: toggle registered dashboards (Git Status, etc.)
- SSH actions: clone session to new tab/window
- Application: quit

Each entry displays the action name and its current keybinding (if any).

## 5.7 Animation Engine (Frontend)

A dedicated module that handles all motion:

- **Workspace transitions** — on switch, compute start/end rects for each window, apply chosen animation (slide, crossfade, morph)
- **Entrance/exit effects** — windows appearing or disappearing
- **Keyboard-driven resize/move** — smooth real-time position updates as user holds arrow keys in resize/move mode
- **Spring physics** (optional) — for `spring` easing, implement a simple spring solver

Implementation options:
- **CSS transitions** — simplest, hardware-accelerated `transform` and `opacity`
- **Web Animations API** — more control, cancellable, reversible
- **requestAnimationFrame loop** — for spring physics or complex choreography

The animation engine must maintain **60 FPS** and avoid layout thrashing (use `transform: translate()` + `width`/`height`, not `top`/`left`).

## 5.8 Sound Engine (Rust Backend)

The sound engine runs entirely in the Rust backend (`src-tauri/src/sound.rs`) using the `rodio` crate for OS-native audio playback. The frontend `src/sound.ts` is a thin IPC wrapper — it contains no Web Audio API code. This eliminates all AudioContext degradation, suspended-state, and silence bugs that plagued the previous browser-based implementation.

### Architecture

```
App start (lib.rs setup)
  |
  v
SoundEngine::new() — spawns dedicated "krypton-audio" thread
  |                    (owns OutputStream + Sinks, receives AudioMsg via mpsc)
  |
  v
SoundEngine::init(resource_dir) — sends LoadPack message to audio thread
  |                                  audio thread reads 17 WAV files into HashMap<String, Vec<u8>>
  |
  v
[Ready — WAV bytes cached in audio thread memory]

---

Frontend action (compositor/input-router event)
  |
  v
SoundEngine.play('window.create')         [src/sound.ts — thin IPC wrapper]
  |
  v
invoke('sound_play', { event })            [Tauri IPC]
  |
  v
sound::sound_play() command                [src-tauri/src/sound.rs]
  |  - Check enabled, per-event override, cooldown dedup (50ms)
  |  - Map event -> WAV name
  |  - Calculate volume (master * per-event override)
  |
  v
mpsc::Sender::send(AudioMsg::Play { wav_name, volume })
  |
  v
Audio thread receives message
  |  - Prune finished Sinks
  |  - Check MAX_CONCURRENT (8)
  |  - Clone WAV bytes from buffer cache
  |  - Decoder::new(Cursor::new(bytes))
  |  - Sink::try_new() -> set_volume() -> append(source)
  |
  v
OS audio output (via cpal/CoreAudio)
```

### Key Design Decisions

- **Dedicated audio thread** — `rodio::OutputStream` is `!Send+!Sync` (platform audio handles), so all audio resources live on a dedicated named thread (`krypton-audio`). The Tauri-managed `SoundEngine` holds only an `mpsc::Sender<AudioMsg>` which is `Send+Sync`.
- **WAV-only** — no procedural synthesis. Each sound pack is a directory of 17 pre-rendered WAV files under `src-tauri/sounds/<pack>/`. Total ~1.4 MB for both packs.
- **In-memory buffers** — WAV file bytes are read into `Vec<u8>` at pack load time. Each playback clones the bytes into a `Cursor` for `rodio::Decoder`. This avoids filesystem I/O on the hot path.
- **Overlap management** — same constants as the previous frontend implementation: `MAX_CONCURRENT=8` (excess dropped), `KEYPRESS_THROTTLE_MS=25`, `EVENT_COOLDOWN_MS=50`. Enforced in the `SoundEngine` (Tauri command side) before sending to the audio thread.
- **Fire-and-forget IPC** — frontend `invoke()` calls don't await completion. The Tauri command acquires the mutex, checks throttle/cooldown, sends a channel message, and returns immediately. Actual audio playback is asynchronous on the audio thread.
- **Graceful degradation** — if no audio device is available, `OutputStream::try_default()` fails on the audio thread, which drains the channel and exits. All `play()` calls become silent no-ops.
- **Reload Config** — `reload_config` calls `engine.apply_config()` on the Rust side. If the pack changed, a `LoadPack` message is sent to the audio thread.

### macOS Backdrop-Filter Freeze (Platform Gotcha)

> Implemented: 2026-03-16

CSS `backdrop-filter: blur()` on macOS transparent WKWebView windows causes the native compositor to **snapshot** the content behind the blurred element rather than continuously compositing it live. When the Tauri window gains focus, macOS optimizes rendering by freezing this snapshot — dynamic desktop content (video wallpapers) behind terminal windows stops updating.

**Fix:** All `backdrop-filter` / `-webkit-backdrop-filter` declarations were removed from `src/styles.css`. Semi-transparent `background` colors (rgba with alpha) remain, providing a tinted overlay without triggering the snapshot. Affected elements: `.krypton-window`, `.krypton-quick-terminal`, `.krypton-whichkey__popup`, `.krypton-hint-toast`, `.krypton-palette__container`, `.krypton-dashboard__backdrop`.

### macOS Space Occlusion and WebContent Lifetime

The main window sets `backgroundThrottling: "disabled"` in
`src-tauri/tauri.conf.json`. On macOS 14+, Tauri/Wry maps this to WebKit's
inactive scheduling policy so moving Krypton to a hidden Space does not suspend
and jetsam WebContent solely because the native window became `NotVisible`.
Do not remove this setting or restore permanent full-window `will-change`
promotion without measuring WebContent physical footprint on a Retina display.

Compositor state is mirrored into `WorkspaceState` in the Rust process. A new
frontend calls `load_workspace_bootstrap`: `startup` creates the initial shell;
`reload` reconstructs the saved window/tab/pane topology and reattaches every
still-active PTY. This is crash containment, not cross-launch persistence.
Terminal scrollback and content-view JavaScript state remain frontend-owned, so
their recovery limitations are shown explicitly rather than hidden behind a new
shell. See `docs/0066-invisible-window-recovery.md`.

Additionally, xterm.js's internal color parser rejects alpha < 255, falling back to opaque `#000000` on `.xterm-scrollable-element`. A CSS `!important` override was added for that element.

Config/theme keys `blur`, `backdrop_blur` remain in parsers for forward compatibility but are currently **inert**.

See also: `docs/0016-terminal-shaders.md` for related visual rendering.

### Webview Panes (Platform Gotcha)

> Implemented: 2026-05-11

In-app webview panes (`PaneContentType = 'webview'`) embed a Tauri v2 child `Webview` via `Window::add_child` (gated behind the `unstable` Cargo feature). Native child webviews are `NSView` / `HWND` subviews and therefore **render above all host DOM unconditionally** on every platform. Three implications shape the implementation in `src-tauri/src/webview.rs` and `src/webview-view.ts`:

1. **Chrome insets rather than overlays.** The cyberpunk address bar / loading bar live in DOM at the top of the pane; the native webview is positioned to fill the area below them. Glow overlays surround the webview rect rather than covering it. No L-shaped corner brackets.
2. **Overlays must hide the webview.** Anything that needs to draw on top of the pane area (command palette, dashboard, hint mode, workspace transitions) calls `compositor.suspendAllWebviews()` to issue `set_webview_visible(false)` on every child webview, then `resumeAllWebviews()` afterwards. Pane rects that go to 0×0 (hidden tab, other workspace) auto-hide because the `ResizeObserver` pipeline reports a zero rect and emits `set_webview_visible(false)` instead of `resize_webview`.
3. **Keyboard escape via injected bridge.** When a child webview has focus, key events go to its renderer, not the host. The `WebviewBuilder::initialization_script` injects a capture-phase listener that catches Krypton leader chords (`Cmd+P`, `Cmd+L`, `Cmd+R`, `Cmd+[`/`]`, `Cmd+1..9`, `Cmd+W`) and forwards them via the `forward_chord` command. The Rust handler takes focus back to the main window and re-emits the chord as a `chord-from-webview` event that the input-router pipeline replays as a synthetic `KeyboardEvent`.

`WebviewBuilder::transparent` is documented as **"Not implemented" on macOS/iOS** — webview rects always render opaque. Pages cannot composite alpha with DOM behind them, which is why the chrome surrounds rather than overlays.

See `docs/0102-webview-windows.md` for the full spec.

### macOS GUI Bundle stdio Hijacks PTY Master (Platform Gotcha)

> Implemented: 2026-05-18

When Krypton is launched as a macOS `.app` bundle (Finder, Dock, `open -a`, launchd), the process starts with **fds 0/1/2 closed** — GUI apps don't have an inherited terminal. The kernel's `open(2)` always returns the lowest free fd, so the very first `posix_openpt()` inside `portable-pty::PtySystem::openpty()` (called from `pty.rs::PtyManager::spawn_pty`) returns master fds `0`, `1`, or `2`. That means the PTY **master** end occupies what Rust believes is stderr.

Any subsequent `log::info!`, `tracing::warn!`, `eprintln!`, panic message, or third-party diagnostic (e.g. `fff_search::background_watcher` failing to start an FSEvent stream, `tauri_plugin_log` falling back to stderr) writes to fd 2 — which is the master side of the freshly-spawned shell's PTY. Writes to the master flow into the slave as if they were keystrokes, so fish/zsh tries to execute each log line as a command and emits `Unknown command: '[2026-…][app_lib::hook_server][INFO] …'`.

**Fix:** `lib.rs::ensure_std_fds()` runs at the top of `run()` (Unix only) and `dup2(/dev/null)` into any of fds 0/1/2 that are not already open. With those slots reserved, `openpty()` allocates the master at fd ≥ 3 and standard streams stay harmless.

Symptoms that point at this bug recurring:
- Newly-opened terminal panes show pasted-in log lines on startup
- Shell complains `Unknown command: '[…][app_lib::…][…]'` or `Unsupported use of '='`
- Only the first one or two panes after launch are affected — once a master grabs fds 0/1/2, later `openpty()` calls land on fd ≥ 3

### WebKit Shapes Each Text Node Alone (Platform Gotcha)

WKWebView shapes every DOM `Text` node on its own. If a combining mark starts a new `Text` node, it loses its base letter: Thai tone marks and vowels (`่ ั ิ`) drift right and leave gaps (`ที่อนุมัติ` → `ที ่อนุมัต ิ`).

`streaming-markdown` creates this split. Its default `add_text` appends one new `Text` node per call, and token-sized stream chunks often cut between a base letter and its marks.

**Fix:** `harness-markdown.ts::makeSafeRenderer` extends the trailing `Text` node (`appendData`) instead of appending a sibling. Any incremental text writer must do the same, or `normalize()` the parent, so marks stay with their base. The xterm DOM renderer has a related letter-spacing issue, handled by `src/xterm-cluster-cells.ts`.

### Box-Drawing Characters Fall Back to a Wider Font (Platform Gotcha)

> Implemented: 2026-10-22 (spec 324)

A configured font without box-drawing glyphs (U+2500–U+257F) — `Share Tech Mono`, for example — makes the browser draw each `─ │ ╭` with a fallback font, one character at a time. On macOS the fallback is Menlo, 0.602em wide, against 0.54em for `Share Tech Mono`'s ASCII. A 49-column box's border row therefore ends about 46px right of its content rows. `pre` keeps the UA `monospace` font for its line strut while `code` uses the user font, so rows also grow past `line-height`, and the fallback `│` is shorter than the line box, which leaves gaps.

**Fix:** `cell-grid.ts` lays out on character cells any assistant code block that is laid out by columns: one that holds box or block characters, or that pads non-ASCII text with two or more spaces to line up what follows. All-ASCII `+--+`/`|` frames around Thai drift the same way, because Thai also comes from a proportional fallback. Every grapheme takes its terminal width in cells. Box characters are painted by CSS gradients in their cell, the way xterm.js `customGlyphs` draws them in terminals. Two details are load-bearing:

- Cell width, row height and stroke centres round to a device pixel (`round()` against a resolution-dependent step). Cells start at fractional pixels otherwise, are snapped one by one, and leave 1-device-pixel seams.
- Strokes overdraw 0.5px past the cell edge.

Any new surface that shows agent-drawn diagrams in the DOM needs the same treatment; font fallback cannot be fixed per character. Since spec 326 every output surface does: markdown through `gridifyCodeBlocks`, a raw-text block (`pre`, a text `div`) through `gridifyText`, and a block drawn one element per line (diff rows, grep rows) through `gridifyLines`. Two more details matter there:

- A sheet that is not in a `@layer` (the Agent view's `agent.css`, for example) outranks the grid's `krypton.base` rules. If it sets `line-height` on `pre code`, it needs a matching `code.acp-cellgrid` rule that rounds that value again.
- Rows of a per-line block take their `line-height` and `gap` from component-layer rules, which a base rule cannot override. The sheet that owns the rows rounds their pitch under `.acp-cellgrid-lines`, or vertical lines break between rows.

### Tauri Commands

| Command | Parameters | Purpose |
|---------|-----------|---------|
| `sound_play` | `event: String` | Play a UI sound event |
| `sound_play_keypress` | `key: String` | Play a keypress sound (routes by key name) |
| `sound_apply_config` | `config: SoundConfig` | Apply sound config from frontend |
| `sound_load_pack` | `pack: String` | Switch sound pack |
| `sound_get_packs` | — | Get available packs and current selection |

### Integration Points

The frontend `SoundEngine` class (`src/sound.ts`) exposes the same `play()` / `playKeypress()` API as before. Call sites in `compositor.ts`, `input-router.ts`, `command-palette.ts`, and `main.ts` are unchanged.

| Caller | Event | Sound |
|--------|-------|-------|
| `compositor.createWindow()` | After window DOM created | `window.create` |
| `compositor.closeWindow()` | Before exit animation | `window.close` |
| `compositor.focusWindow()` | On focus change | `window.focus` |
| `compositor.toggleMaximize()` | On maximize/restore | `window.maximize` / `window.restore` |
| `compositor.toggleQuickTerminal()` | On show/hide | `quick_terminal.show` / `quick_terminal.hide` |
| `compositor.toggleFocusLayout()` | On layout toggle | `layout.toggle` |
| `input-router` (mode change) | On enter/exit mode | `mode.enter` / `mode.exit` |
| `input-router` (compositor key) | On resize/move step | `resize.step` / `move.step` |
| `input-router` (swap) | On swap complete | `swap.complete` |
| `main.ts` (startup) | After first window rendered | `startup` |
| PTY event listener | On BEL character | `terminal.bell` |
| PTY event listener | On shell exit | `terminal.exit` |
| `terminal.onData()` (both regular + QT) | On each keystroke to PTY | `keypress` (press phase only via `playKeypress('press', key)`) |

### Sound Packs

Two built-in packs, each containing 17 WAV files:

| Pack | Directory | Description |
|------|-----------|-------------|
| `deep-glyph` (default) | `src-tauri/sounds/deep-glyph/` | Rich, deep UI sounds |
| `mach-line` | `src-tauri/sounds/mach-line/` | Sharp, mechanical interface tones |

Packs are bundled as Tauri resources (declared in `tauri.conf.json`) and loaded at runtime from the app's resource directory. The command palette lists all available packs for switching.

### Loopback HTTP Server

`src-tauri/src/hook_server.rs` is the one `127.0.0.1` HTTP host, started once in
`lib.rs::setup`. It serves the harness memory MCP endpoint
(`/mcp/harness/{id}/lane/{label}`), the read-only browser surfaces (`/dashboard`,
`/gallery`, `/artifacts`, `/genui-gallery` (with its `/genui-gallery/theme.json`
theme feed), `/timeline`, `/docs`, `/journal`, `/reviews`,
`/analyses`, `/commands`, `/tools`), the token-gated viewers (`/termctrl`,
`/acp-wire`, `/hurl`), artifact and doc feedback POSTs, and the Claude Code
`/hook` endpoint.

`[loopback_server] enabled` / `port` controls the server itself (load-time only);
`[hooks] enabled` gates `/hook` alone and is read per request. While the server
is down, `get_port()` stays `0`, every URL builder returns
`hook_server::SERVER_UNAVAILABLE`, and the harness runs with memory unavailable
(doc 0072). Splitting those two keys is why `[hooks]` no longer starts anything —
see doc 0006.

### Harness Controller CLI

### Terminal Control Session Monitor

`src-tauri/src/termctrl_monitor.rs` is a read-only adapter around the installed
`termctrl` CLI. It resolves an absolute executable from `TERMCTRL_BINARY`, the
process and login-shell `PATH`, and standard Cargo/Homebrew locations, then
invokes `list --json`, `show NAME`, `logs NAME --ansi`, `status NAME --json`,
and `--version` directly without a shell. Each invocation has a two-second
timeout and a one-MiB combined-output cap, except `logs`, which gets five
seconds and 32 MiB because the raw ring defaults to 16 MiB (spec 330).
Successful discovery is cached; failed discovery retries on the next browser
poll, and a cached path is invalidated if the executable later disappears.

The existing hook server owns the process-lifetime 128-bit capability and serves
the fixed Binance-dark page at `/termctrl/{token}`, normalized session JSON at
`/termctrl/api/{token}/sessions`, selected visible text at
`/termctrl/api/{token}/screen/{name}`, and the retained raw output at
`/termctrl/api/{token}/log/{name}`. All four routes require the token and use
no-store, no-referrer, and nosniff headers. The page has no input, lifecycle,
resize, or recording endpoints. `#termctrl` and the command palette obtain the
URL through `get_termctrl_monitor_url`; terminal text reaches the page only
through `textContent` and text nodes. Running screens poll every second; an
exited screen is read once and cached because its contents are final.

The Log view (spec 330) keeps its cursor in the page: the ring length it last
saw and its last 64 bytes. The log route answers `append` with only the bytes
after them or `reset` with the whole ring; Krypton keeps nothing between
requests. The page turns the raw bytes into plain text with a small stateful
decoder (the backend still does no VT parsing) and reads only while the Log
view is visible and the session has printed since the last read.

The Screen view lays the visible text on the harness cell grid (specs 324/326).
The page is inline HTML, so `vite.loopback.config.ts` bundles
`src/acp/loopback-cell-grid.ts` into `dist/loopback/`, and the tokenless
`/termctrl/assets/{cell-grid.js,cell-grid.css}` route serves it from the embedded
`dist` in release builds and redirects to the Vite dev server in debug builds.
See `docs/0198-termctrl-session-monitor.md` and
`docs/0330-termctrl-monitor-full-log.md`.

### ACP Wire Profiler

`src-tauri/src/acp_wire.rs` is an opt-in tap on the three ACP choke points in
`acp.rs`: `AcpClient::write_line` (every outbound request, notification, and
reply, recorded under the transport lock before the write), `dispatch_output_line`
(every inbound stdout line, local and remote lanes, including non-JSON lines),
and `emit_event` (every `acp-event-<session>` payload actually emitted). With
`[acp_wire].capture = "off"` each call is one atomic load. Otherwise the event
is classified outside the lock and pushed into a bounded ring under a short
`std::sync::Mutex` hold; requests and responses are paired on
`(session, direction, id)` to record latency. `full` mode also keeps message
bodies (1 MiB per event, `full_payload_mb` total). Nothing is written to disk.

One `Arc<AcpWire>` lives on `HookServer` and is also Tauri-managed for
`acp_spawn`, `reload_config`, and the `acp_wire_set_mode` / `acp_wire_clear` /
`get_acp_wire_url` commands. The hook server serves the fixed Binance-dark page
at `/acp-wire/{token}` plus `summary`, `events?since=`, `event/{seq}`, and
`export.jsonl` under the same process-lifetime capability token (constant-time
compare, no-store). The page is read-only and polls only while visible; it is
opened by `#profiler` or the palette (`ACP Wire: Open Profiler`, which turns on
`meta` capture when it is off), and capture mode changes come from the palette
(`ACP Wire: …`). See `docs/0288-acp-wire-profiler.md`.

### Hurl Web Client

`src-tauri/src/hurl.rs` already owns the short-lived `hurl` child process (not
a PTY). Spec 227 adds a token-gated loopback page at `/hurl/{token}` served by
the hook server. `get_hurl_web_url(cwd)` issues a 128-bit capability bound to
the focused terminal cwd (reused for that cwd until Krypton exits). The page
lists `*.hurl` / `*.env` files, streams run output over SSE, and reuses the
same on-disk cache and per-cwd sidebar state (`expanded` folder set,
selection, env, verbose) as the in-app `HurlContentView`. Path confinement keeps
every `path` / `variablesFile` under the session cwd. `#hurl` and the command
palette open the OS-browser page; `Leader q` still opens the in-app window.
See `docs/0227-hurl-web-client.md`.

`kryptonctl` is an external Harness Controller, not an ACP lane. The Rust
control server (`src-tauri/src/control.rs`) publishes an authenticated
loopback HTTP endpoint and a user-private runtime descriptor. Requests cross
the Tauri boundary through `acp-control-request` / `acp_control_reply`, then
`src/acp/control-bridge.ts` routes typed domain operations through the
process-wide `HarnessDirectory` to the owning `AcpHarnessView`.

The frontend remains the only authority for live harness state. Rust owns
discovery, authentication, protocol parsing, and request timeout handling; it
does not mirror lanes, queues, transcripts, or permissions. Core v1 uses
ordinary request/response operations, and `kryptonctl acp send --wait` polls
typed lane state. Prompt-specific IDs and prompt-specific cancellation are
deferred. See `docs/0154-harness-controller-cli.md`.

The same control server also exposes a one-way **event stream** for web-app
remote control (`GET /control/v1/events`, SSE — doc 175). Keeping the
authority split, the frontend *pushes* the harness events it already processes
(`acp-harness-view` event sink + status transitions) over `acp_control_publish`
into a per-server `broadcast` channel that Rust fans out to subscribers; Rust
still derives no state. Commands stay on `POST /operations`. A browser app
either proxies server-side (default; bearer token stays off-browser) or calls
directly when `[acp_controller].cors_origins` lists its exact origin. See
`docs/0175-harness-web-control-api.md`.

### Telegram Harness Controller

`src-tauri/src/telegram.rs` is a privileged remote adapter over that same
control boundary. It owns Bot API long polling, OS-vault credential access,
application-managed allowlists/pairing, the update watermark, per-chat targets,
compact outbound digests, and the spec-202 mobile lane picker. After `getMe`,
the service best-effort registers common commands with `setMyCommands`; bare
`/use` and `/lanes` render paged inline keyboards from a fresh `lane.list`;
each lane occupies one row labeled with its display name and harness working
directory so same-named project contexts remain distinguishable on Telegram.
Button payloads are random five-minute nonces resolved through a bounded,
process-local action registry. Callback handling acknowledges Telegram first,
then repeats numeric user/chat authorization and verifies the exact harness,
display-name, and session snapshot against another live `lane.list` before
changing the chat target. Rust still retains no authoritative lane catalog.

The optional spec-201 rich-answer path remains
backend-owned: `telegram/rich.rs` parses assistant Markdown with Comrak and emits
only a Telegram-safe HTML subset before `sendRichMessageDraft`,
`sendRichMessage`, or rich `editMessageText`; raw model HTML and media never
cross that boundary. Private-chat answers use an ephemeral draft only while no
tool-status surface exists. Once tool activity begins, the answer preview is
promoted to a persistent editable message after the status message; standard
message layout then prevents the two growing bubbles from overlapping. Any
render/API failure degrades only that response to the existing plain path.
`TelegramService` calls `ControlServer::dispatch` directly and subscribes to the
server's typed event broadcast; it does not loop back through HTTP and does not
know the control bearer token.

Rust attaches trusted numeric sender/chat provenance only after admission.
`control-bridge.ts` forwards that metadata separately from operation params, and
`AcpHarnessView` remains the sole lane authority. A Telegram `lane.send` carries
the provenance through the existing FIFO prompt queue and arms full permission
bypass only for that exact turn. It never changes the lane's persistent
permission mode. The dedicated DOM Settings view edits
`~/.config/krypton/telegram.toml` through sanitized Tauri commands; the bot token
never crosses into the frontend. See `docs/0200-telegram-harness-controller.md`
and `docs/0201-telegram-rich-responses.md`, plus ADR-0013 through ADR-0015.

A Chrome/Chromium **browser extension** (`extension/`) is a packaged client of
this control API (doc 176): it sends the current page selection into a lane as a
chosen action via `lane.send`. Token discovery is zero-config through a Native
Messaging host, `krypton-bridge` (`src-tauri/src/bin/krypton-bridge.rs`), which
reads the `0600` control descriptor as the user; Krypton writes the host
manifest into the browser's `NativeMessagingHosts` dir on launch
(`src-tauri/src/native_host.rs`). The control API binds a fixed loopback port
(default `8766`) so the extension needs no port discovery.

The popup reads the selected lane's harness-local active ticket through the
authenticated `ticket.active` control operation (spec 268). The frontend
projects only the Ticket Panel's bounded display fields: title, local status,
GitHub reference, worker, context excerpt, resource names and counts, analysis
counts, and latest progress. The extension refreshes this snapshot only while
the popup is open; it stores no ticket copy and receives no ticket file paths or
full Markdown. The GitHub issue page card still reports the separate
`github.issue-status` fixing binding.

When the popup is opened with **no text selected**, the extension extracts the
page's main content as Markdown client-side (doc 177): it injects a bundled
**Defuddle** (`extension/content-extract.src.js` → `dist/content.bundle.js`, built
by `make extension`) into the active tab on demand and sends the resulting
Markdown + metadata, so pages a lane cannot fetch server-side (Reddit, YouTube,
login-walled, JS-rendered) still work. A selection always takes precedence; the
injection stays on-demand (activeTab) rather than a declared content script.

**GitHub issue fixing** (doc 178) makes "fix this issue" a single surface-agnostic
operation. Any surface — Krypton's command palette / `#dispatch-github-issue` verb, the
extension popup, or a status card the extension injects onto the GitHub issue page
(a declared `github.com/*/issues/*` content script) — converges on the frontend
`dispatchIssue()` path (also the `github.dispatch-issue` control op), which records
an issue↔lane binding (harness-level map keyed by `owner/repo#123`) and prompts a
fresh lane. The lane self-reports progress via an `issue_progress` MCP tool; status
is snapshot-first (`github.issue-status`) plus an `issue_status` SSE event, so the
injected card is refresh-safe and survives a Krypton restart (bindings persist to
disk next to the per-harness memory file). The `issueKey`-addressed reads
(`github.issue-status / list-issues / unlink-issue`) fan out across harnesses in
`control-bridge`. Read-only overlay only — no write-back to GitHub.

The harness ticket surface is project-local-first (doc 238). Rust module
`ticket_bundle.rs` confines every bundle to `.krypton/tickets/<ticket-id>/`,
writes atomic `ticket.json`, keeps long context in `ticket.md`, and copies only
bounded regular files into `resources/` with executable bits removed. GitHub is
an optional reference; analysis stays in the existing `.krypton/analyses/`
bundle and is derived at read time. `AcpHarnessView` owns the active version-2
pointer and renders a 352px docked Ticket Panel beside Lane Peek, hidden through its spec 320 titlebar toggle (spec 331). HookServer
owns only the runtime ticket-worker binding. Lanes manage the active ticket
directly over MCP (doc 239): append-only `ticket_note` / `ticket_add_resource`
are open to every lane, while single-valued `ticket_progress` / `ticket_link`
are worker tools — a held binding is enforced, and an unassigned active ticket
is claimed atomically by the first successful writer (`acp-ticket-worker`
notifies the frontend, which reconciles the real lane id). Every agent write
re-emits `acp-ticket-progress` so the Ticket Panel refreshes without a
filesystem watcher. GitHub-facing `issue_progress` remains independent,
so the browser extension contract is unchanged.

The project timeline ([spec 316](0316-llm-managed-timeline.md), replacing the
human capture gates of specs 253–255 and 263) is an append-only provenance ledger.
`timeline.rs` confines bounded schema-1 Markdown records to the registered local
project's gitignored `.krypton/timeline/events/`; topic groups and superseded
state are derived at read time, without an index. The working lane selects
evidence-backed durable requirements, decisions and observed outcomes itself.
`timeline_record` requires `topic_title`, `summary`, `made_by`, `evidence_kind`
(`user_statement`, `observed_outcome`, `agent_decision`) and `evidence_excerpt`.
Optional fields are `topic_id`, `occurred_at`, `rationale`, `impact`, `source_ref`,
`relation` and `related_event`. Unknown fields, including the retired
`instruction_excerpt`, are rejected. New records attribute the recorder to
`Agent` and the transport lane; `agent_decision` also uses that lane as
`made_by`. Old Evidence/Authorizing instruction and human provenance remain
readable; event schema stays 1 and `evidenceKind` is additive.

Before recording, the lane discovers topics and relevant history through
`timeline_list`: default topic digests and `topic_id` event lists support
`query`/`limit` (default 20, maximum 50); exclusive `event_id` mode returns a full
event. It reuses stable topic IDs across titles/languages and deduplicates
retries. Recording returns event ID/topic ID/path/disposition and conflict
continuation; it never implicitly promotes a pending candidate.
`timeline_merge` takes `from`/`into` or `undo:true`, always with `rationale`.
Unique selectors, same-topic refusal, backups under `backups/<merge-id>/`,
and undo manifests protect the rewrite of only `topic_id`; manifests retain
acting lane/reason for merge and undo. No current-human instruction is required.

Legacy `pending/` files are an internal migration backlog, not a human queue.
`timeline_list({pending:true})` returns candidates, `remaining_pending`,
`diagnostics` and `truncated` (default 5, maximum 20); it cannot mix with
event/topic/query modes. `timeline_pending_resolve` requires `pending_id`,
`outcome` and `rationale`, plus nested `record` only for `record`, or `event_id`
only for `duplicate`; `discard` has neither. A recorded candidate uses its
reserved ID and original suggestion provenance. Terminal schema-1
`resolutions/<pending_id>.json` receipts retain `original_candidate` verbatim,
`resolved_by_lane`, `resolved_at`, rationale, outcome and event reference.
Under the mutation lock, validation precedes writes; event persistence precedes
atomic receipt replacement and pending removal happens last. Retries return
the terminal result, including recovery of saved-event/stale-pending state.
Malformed candidates remain present, diagnosed and counted. No API creates
new pending files; older dismissed files remain historical local data.

`harness-timeline-controller.ts` uses only `timeline_settings`,
`timeline_set_enabled` and `timeline_pending_count` native IPCs. The default-on
`TimelineSettings { automaticRecording }` is persisted in settings schema 2;
schema 1 `automaticSuggestions` migrates atomically, preserving false.
Off rejects new recording but not legacy resolution. Initialization/count
changes reach the lane through nonvisual state and `acp-timeline-changed`
(`harnessId`, `pendingCount`): the count rides the ordinary turn header while it
is above 0 and never the hashed lane policy (spec 332); no badge, form, permission
handoff or extra model turn is created. Local non-Pi MCP-capable lanes process
the backlog without a one-item or five-topic migration cap. Remote/Pi lanes
without project tools do not mutate local storage; explicit read-only work,
including trace, defers all Timeline mutations to a later writable turn.
Built-in Timeline tools are auto-handled only with exact tool/server identity;
third-party tools retain normal permissions. Missing accept options cancel
with a diagnostic, never enqueue a human Timeline decision.

`#timeline [open [topic] | trace topic | conflicts [topic] | auto [on|off] | topic]`
is the final grammar: no add/review/merge aliases. `/timeline` remains a
read-only keyboard-operated history page backed by `/timeline.json`, with
compact chronology and explicit context/audit disclosures, including old and
new provenance. `Start Review` and unrelated permission flows are unchanged.
Rollout requires the rebuilt app and normally reconnected lane to expose the
new MCP schemas before an ordinary working turn processes legacy intake;
implementation or fixture migration does not imply the real queue was drained.
Timeline data is not encrypted, committed, synced or published automatically.

Specs 266/267 add decision trace and agent-owned conflict review on the same
events without editing them. `timeline_conflicts.rs` projects verified
`supersedes` links into chains (branches kept, cycles reported as diagnostics)
and reads three bounded, append-only sidecar folders under
`.krypton/timeline/conflicts/`: `proposals/<event-a>--<event-b>.json` (canonical
pair ID, `create_new`), `reviews/<review-id>.json` (newest review is the pair's
state), and `checked/<topic_id>.json` (spec 267: event IDs an agent already
compared, rewritten atomically). Everything
keys on event IDs, so topic renames and merges never orphan a pair; a pair whose
side is later superseded becomes `historical`. `/timeline.json` returns this
trace additively and the page marks only the time cell of rows in an open pair.
Spec 267 hands the whole review to the lane agent: the MCP tools
`timeline_conflict_list` (read-only; open pairs plus unchecked topics),
`timeline_conflict_record` (pair + verdict in one call, `reviewed_by` = calling
lane) and `timeline_conflict_checked` (checkpoint) replace the in-app sheet and
the retired semantic scan. There is no human verdict UI.

Spec 259 adds explicit off-machine publication without changing Timeline authority.
`#push timeline [<event-id>]` turns recorded events into Xenon resources;
pending, dismissed and resolution audit data stay local. Each resource keeps
the original `event.md` and structured chronology/provenance metadata.
`#xenon timeline [<topic>]` opens that hosted read model. Recording does not
trigger publication.

The Timeline capture/topic-choice UI and all TypeSafe semantic consumers were
retired by spec 316. The unused transport, configuration, footer and Profiler
metrics plumbing are removed rather than retained as a hidden dependency.


## Remote ACP Harness runtime

Spec 247 adds a local-UI/remote-execution split for ACP Harnesses. The desktop
backend starts a separate, no-PTY OpenSSH channel whose only fixed remote command
is the versioned user-cache `krypton-remote serve --stdio`. Before launch it
probes that exact helper, detects the remote OS/architecture when missing, and
atomically uploads a bundled or SHA-256-verified release binary. A shared protocol crate defines bounded
newline-delimited JSON frames. The companion owns remote ACP child process groups
and workspace-confined file/process operations; `acp.rs` retains JSON-RPC request
correlation, permissions, lane state, and Tauri events locally.

One immutable `WorkspaceRef` belongs to the whole Harness. Local and SSH lanes
cannot mix. The SSH manager may borrow a verified ControlMaster discovered from
the focused terminal, but never writes commands into that interactive PTY. When
it cannot borrow a master, Krypton owns a dedicated socket and closes only that
socket during teardown. Project-backed local surfaces are disabled for SSH
workspaces until the hook server gains target-aware storage; they never receive
the remote path as a local filesystem path.

## Connected Computers (spec 311)

`ConnectedComputerManager` in Rust owns named SSH targets and app-owned
ControlMaster sockets independently of Remote Harness runtimes. A separate
`connected-computers.toml` sidecar stores profiles; the `connected_computers`
compositor content tab edits them and shows verified connection status. The
manager remains alive after that tab closes.

Each local Harness lane receives a revocable capability bound to its harness,
lane and ACP process session. The built-in Harness MCP server exposes
`computer_list` and `computer_exec` only for a valid local lane with an
in-process MCP descriptor. Pi, Cursor, Junie and Cline use bundled
`kryptonctl` over the authenticated loopback control API so their on-disk MCP
configs never contain the capability. Both routes enter one app-owned gate.
When the profile's `auto_approve_read_only` is on (default), the Rust
classifier `computer_read_only.rs::read_only_script` (spec 318) lets a command
that parses completely in its shell subset, uses only built-in read-only
commands and options, and passes its path guard run as its re-quoted argv
without a prompt. Every other command enters the per-command approval queue —
surfaced as a permission row in the requesting lane's transcript, resolved
only by an explicit `a`/`r`, never by a permission mode or a turn-wide
accept — before
Rust runs a no-PTY SSH channel. The command target is explicit; it does not
change the lane's `WorkspaceRef` or send bytes to an interactive terminal.

## E2E Commands (spec 328)

`src-tauri/src/e2e.rs` is the backend of `#e2e`. Krypton never reads a
project's native test output: each project provides `.krypton/e2e/project.toml`
and an adapter with `list`, `run <case> [--param k=v]…` and optional `history`,
and every run is one normalized Result JSON (Adapter Contract v1, written into
the project as `CONTRACT.md` with `BOOTSTRAP.md` by `e2e_write_guides`). The
Rust validator is the only judge of a manifest, case list or Result; lanes
reach it through the MCP tool `e2e_adapter_check` (project-backed, not
auto-allowed).

Commands: `e2e_write_guides`, `e2e_status`, `e2e_run`, `e2e_rerun`,
`e2e_cancel`, `e2e_find_run`. Adapter processes run from the repo root with the
login env (`pty::login_env_pairs`, shared with `PtyManager::spawn`), stdin
null and their own process group; `list` and `history` time out after 60 s.
A launch is refused while the root has an active one (`E2eState.active`, keyed
by canonical root, holding ids and the pgid but never the `Child`, so cancel
returns at once: SIGTERM to the group, SIGKILL after 5 s; the app-exit drain
signals every active group). Each launch appends `start` and `finish` lines to
`.krypton/e2e/launches.jsonl` (argv, git sha/branch/dirty, case hash, exit
code, cancelled) and writes `runs/<launchId>/{result.json,log}` (log capped at
5 MB, logs kept for the newest 100 launches). `e2e_status` merges Krypton
launches with the adapter's `history` by `(caseId, runId)`, hashes and
git-checks each case's `files`, and — when the manifest names an
`issue_label` — scans one `gh issue list --json …,comments` for known runIds.

**Browser explorer (spec 329).** `src-tauri/src/e2e_web.rs` serves a read-only
page, `src/acp/artifact-e2e.html`, at `/e2e/{token}` on the loopback server. It
has its own router and state (`E2eWebSessions` + the shared `E2eState`), which
`hook_server::start` merges into the loopback router. The token is per canonical
project root (128-bit, reused until exit, like Hurl's per-cwd capability), and an
unknown token is a bare `404`. The API routes are `status` (the same `gather`),
`active` (in-memory, no spawn), `run` (full Result), `log` (ledger-listed launch
only) and `artifact` (Result artifact index → `resolve_artifact`: repo-relative,
no `..`, canonical-root confinement against symlinks, regular file ≤ 25 MiB).
Raw content goes out with `nosniff`, `no-store` and `CSP: sandbox`; HTML and SVG
evidence goes out as `text/plain`. `gather` keeps the last `history` Results per
root in `E2eState.history`, so the page reads ext runs without re-spawning
`history` or writing `runs/ext-*`. Nothing on the page runs, cancels or writes.

## Review Threads (spec 270)

A human starts a fixed review round from an idle local ACP lane through
`#review-thread`, its lane-head action, or the Command Palette. Rust captures one
diff against the local upstream merge-base (or `HEAD`), including committed,
staged, unstaged, and untracked text changes. The private
`.krypton/review-threads/<id>/` directory keeps the immutable snapshot and
verdict history.

`ReviewThreadView` composes the existing Review Board Guide and
`DiffContentView` under one tab. Guide authoring uses an issued Review Board
bundle and `review_register`; a failed Guide turn cancels that pending write
grant, and Retry Guide issues a fresh bundle. Line comments remain drafts until
the human submits Approve or Request Changes. `AcpHarnessView` routes the saved
verdict to the exact backend/session ID at the next idle point, then records
whether dispatch began. The private thread directory is outside Xenon's
review-bundle collector; configured Review Board auto-push applies only to the
Guide bundle. No reviewer ACP lane or Git worktree is created. See
`docs/0270-review-threads-without-worktrees.md`.
