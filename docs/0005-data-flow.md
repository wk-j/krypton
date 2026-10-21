# 6. Data Flow

```
 User Input                                                   Display
    |                                                            ^
    v                                                            |
+--------+    IPC invoke     +-----------+    PTY write    +----------+
| xterm  | ----------------> |   Rust    | --------------> |  Shell   |
|  .js   |                   |  Backend  |                 | Process  |
|        | <---------------- |           | <-------------- |          |
+--------+    Tauri event    +-----------+    PTY read     +----------+
```

## macOS Harness Live Assist Flow

```
1. Ctrl+Shift+I reaches the Rust global-shortcut handler while any app is active.
2. live_assist.rs resolves or lazily creates the `live-assist` WebviewWindow.
3. Rust places that auxiliary frame on the pointer monitor, applies topmost and
   full-screen-auxiliary Space behavior, then shows and focuses it.
4. The primary Krypton window is not resized, moved, focused, or sent a
   compositor/workspace/tab/pane action.
5. live-assist-main.ts invokes the allowlisted `live_assist.bootstrap` operation.
6. ControlServer::dispatch emits the normal `acp-control-request`; the primary
   webview's control-bridge selects the retained, focused-active, or first live lane.
7. Live Assist pulls lane.status, lane.transcript, and permission.list, then its
   purpose-built view renders a bounded transcript tail and local composer.
8. Send, cancel, and permission actions dispatch onto the owning AcpHarnessView;
   it remains the only ACP client and lane-state authority.
9. AcpHarnessView publishes its normal ordered control event once. Rust broadcasts
   it to existing subscribers and mirrors that same sequence-stamped envelope to
   the auxiliary webview.
10. Text chunks append incrementally; assistant chunks are written through the
    streaming-markdown parser so conversation formatting appears live.
    Status/permission/stop/lifecycle boundaries and sequence gaps trigger an
    authoritative snapshot refresh that seals or re-parses those rows.
11. Escape, Ctrl+Shift+I, or native close hides only `live-assist`; its local draft
    stays mounted for the next summon.
```

## Keyboard Input Routing (Step-by-step)

1. **User presses a key** -> webview captures `keydown` event
2. **Input Router checks mode**:
   - **Global hotkey?** (e.g., `Cmd+I`, `Cmd+Shift+H`) -> execute immediately (toggle Quick Terminal, enter hint mode, etc.)
   - **Normal mode?** -> forward to focused window's xterm.js -> xterm.js encodes and emits `onData`. Content views receive `onKeyDown`. Native `Cmd+V` is a `paste` event on `document.activeElement`; the compositor moves DOM focus with window/pane focus, and InputRouter retargets a paste that still lands on a background content view to the compositor-focused `handlePaste`.
   - **Compositor mode?** -> dispatch a focused content-view local leader action if the focused view owns the normalized key; otherwise execute the existing global compositor command (focus, resize, move, etc.)
   - **Resize/Move/Swap mode?** -> execute mode command (resize, move, swap, etc.)
   - **Selection mode?** -> navigate virtual cursor, expand/toggle selection, yank
   - **Hint mode?** -> filter/match labels, execute action on match (file path -> Helix tab, otherwise open/copy/paste)
   - **Dashboard mode?** -> delegate to active dashboard's `onKeyDown()` handler; Escape closes the dashboard
   - **Command palette / Search mode?** -> route to overlay's text input handler
3. **If forwarded to PTY**: Tauri `invoke("write_to_pty", { window_id, data })` via IPC
4. **Rust backend writes** -> Raw bytes written to PTY file descriptor
5. **Shell processes input** -> Shell sends output back through PTY
6. **Rust backend reads PTY** -> Raw bytes read from PTY fd
7. **Backend scans for OSC 9;4** -> Inline state machine detects `ESC ] 9 ; 4 ; <state> [; <progress>] ST` sequences. If found, emits Tauri event `pty-progress` with `{ session_id, state, progress }`. Raw bytes are NOT stripped — xterm.js will ignore the unknown OSC.
8. **Backend emits event** -> Tauri event `pty-output` pushes raw bytes to frontend (scoped by session_id)
9. **xterm.js renders** -> xterm.js parses VT sequences and updates the window's terminal canvas
9b. **Header oscilloscope** -> the same routed chunk feeds `win.headerScope?.pump(data.length)` (Quick Terminal: `qtHeaderScope`). The `HeaderScope` (`src/header-scope.ts`) bumps energy by `max(n/SCALE, MIN_KICK)` and (re)starts its rAF, stroking a scrolling waveform in the window head; the loop self-stops ~0.6 s after output ceases, so an idle window's band costs 0 CPU. `MIN_KICK` is required because model-token deltas are 1–8 chars — far below `SCALE` — and would otherwise never deflect the 6px band. Only when `chrome.header_accent.style = "oscilloscope"` (default); see `docs/0188-oscilloscope-header-band.md`. **Content windows** (agent/ACP/harness) drive the same band without PTY: the compositor injects `ContentView.onOutputPump`, which each view calls with the char length of every streamed model delta (assistant/thought text; harness pumps all lanes). See `docs/0189-oscilloscope-harness-band.md`.
10. **Progress UI** -> If `pty-progress` was emitted, the compositor updates the target window's content-area gauge (large translucent SVG arc centered behind terminal text) and titlebar scanline sweep animation
10b. **Program status (OSC 7501)** -> While parsing, xterm.js hands `ESC ] 7501 ; … ST` to the pane's handler. `parseProgramStatus` validates it: a `?` query is answered via `terminal.input` → `onData` → `write_to_pty`, and a report is applied to `ProgramStatusStore`. A changed summary makes the compositor repaint the tab, window and chip, publish `view:program-status` (the footer re-pulls counts), and, for an unfocused pane entering blocked/error/done, show one rate-limited rail message. OSC 133 `A` or a `process-changed` back to the shell drops working/blocked/idle. See `docs/0284-program-status-osc7501.md`
11. **PTY exits** -> Backend emits `pty-exit` when either the PTY reader hits EOF/error or the owning child process exits. Compositor clears progress and closes the matching pane/tab; if an exit arrives before the frontend has registered the new session, it is held briefly and replayed after registration.

## Quick File Search to Helix Flow

```
1. User presses Cmd+O -> Input Router enters QuickFileSearch mode.
2. QuickFileSearch resolves the focused cwd through the compositor and warms
   the backend quick-search picker for that root.
3. User selects a hit and presses Enter.
4. QuickFileSearch closes before awaiting editor spawn, so keyboard routing
   returns to Normal immediately.
5. Compositor creates a new terminal tab and spawns `hx` directly with the
   selected path as argv; grep hits append `:line:col`.
6. Editor tabs wire xterm input before spawn but disable pre-session input
   buffering. xterm.js capability replies emitted before `spawn_pty` returns
   are discarded rather than flushed into Helix as typed text.
7. Once the backend returns the session id, normal xterm `onData` writes go to
   `write_to_pty`; Helix output arrives through `pty-output`.
8. When Helix exits, backend child-process wait emits `pty-exit` and the
   compositor closes the editor tab.
```

## Keyboard Overlay Observe Flow (spec 271)

```
1. User presses a key anywhere while the overlay is shown (Leader Shift+K or
   [keyboard_overlay].enabled)
2. KeyboardOverlay's passive window-capture keydown listener runs first; it never
   calls preventDefault/stopPropagation, so InputRouter, xterm.js and content views
   receive the key unchanged
3. Skip e.repeat and Cmd combos (app shortcuts incl. the Cmd+P leader)
4. layout = "auto": a Thai e.key switches labels to Kedmanee, an ASCII letter back to
   QWERTY → post { type: 'config' }
5. resolveCode(e.code, e.key) → a drawn physical key, or skip (arrows, Tab, F-keys…)
6. mask_secure_input + focused pane has a PTY session:
   a. secure flag cached < 250 ms → reuse it
   b. else invoke('get_pty_secure_input', { sessionId }) → Rust tcgetattr on the PTY
      master: ECHO off && ICANON on → true (password prompt). The command is async
      (blocking pool), so waiting on the session lock never holds the main thread, and
      keys typed while a check is in flight share that one call
   c. secure → drop the key; error/None → treat as not secure
7. post { type: 'key', code } to the worker (or the main-thread fallback driver)
8. KeyboardOverlayDriver: finger reaches, key glows, rAF loop (re)starts
9. When every glow has faded and the hands settle (< 0.1 px/frame), the loop stops —
   an idle overlay draws 0 frames. idle_ghost re-arms a 5 s timer instead.

Pointer ([keyboard_overlay].mouse = true):
a. Passive window-capture pointermove/pointerdown/pointerup listeners (consume nothing)
b. pointermove → post { type: 'pointer', x, y } (0–1 of the workspace), at most once per
   animation frame; a left/right pointerdown/up posts { pointer } then { type: 'button' }
c. Worker: pointer moved < 1.5 s ago and no key for 0.7 s → the right hand eases onto the
   drawn mouse, which then mirrors the pointer inside its pad; a right-hand key or Space
   returns the hand to the keys
d. The loop stops once the grip, the mouse and the button fades settle
```

## Quick Terminal Toggle Flow (e.g., user presses Cmd+I)

```
1. User presses Cmd+I (global hotkey, works from any mode)
2. Input Router intercepts the key before any mode-specific handling
3. If Quick Terminal is hidden:
   a. Compositor saves the currently focused workspace window ID
   b. Quick Terminal DOM element becomes visible (display: flex)
   c. Animation engine plays entrance animation (slide-down + fade-in)
   d. Quick Terminal's xterm.js instance receives focus
   e. Input Router stays in / returns to Normal mode
   f. All keyboard input now routes to the Quick Terminal's PTY
   g. If Quick Terminal has no PTY session yet, one is spawned on first show
4. If Quick Terminal is visible:
   a. Animation engine plays exit animation (slide-up + fade-out)
   b. Quick Terminal DOM element becomes hidden (display: none)
   c. Focus returns to the previously saved workspace window
   d. Input Router stays in / returns to Normal mode
5. The Quick Terminal's PTY session remains alive across show/hide cycles
6. Pressing Escape in Normal mode while Quick Terminal is focused also hides it
```

## Resize Flow

1. **Window resizes** (layout change, keyboard resize, workspace switch) -> `@xterm/addon-fit` calculates new rows/cols
2. **Frontend notifies backend** -> Tauri `invoke("resize_pty", { window_id, rows, cols })`
3. **Backend resizes PTY** -> `TIOCSWINSZ` ioctl (POSIX) / `ResizePseudoConsole` (Windows)
4. **Shell redraws** -> Shell receives `SIGWINCH`, redraws output

## Stage Layout Focus Flow

1. `Leader f`, `Layout: Stage`, or `default_layout = "stage"` enters Stage mode.
2. Compositor orders live windows with the focused window first and computes one shared active frame plus up to five shelf transforms.
3. Every Stage window keeps the same unscaled bounds. Shelf windows are visually reduced with CSS `translate(...) scale(...)`; they are not fitted to thumbnail dimensions.
4. `Leader h/k`, `Leader j/l`, `Cmd+Shift+</>`, `Leader 1-9`, or the first click on a shelf preview selects another stage.
5. Compositor updates focus and animates old-to-new visual rectangles with the Stage-specific WAAPI transition. It does **not** run xterm fit during an ordinary stage switch, so no `resize_pty` or `SIGWINCH` is emitted.
6. Creating, closing, resizing, resetting, entering, or leaving Stage may change the shared base frame; those structural changes run fit for visible windows after layout.
7. Hidden stages remain in the DOM with `visibility: hidden`, receive no pointer events, and keep their sessions alive.

## Wheel Layout Focus Flow

1. `Leader f`, `Layout: Wheel`, `default_layout = "wheel"`, or a restored Wheel workspace enters Wheel mode; the first relayout lazily creates the `WheelRail`.
2. `computeWheelFrame()` returns the rail bounds and one shared main frame. Every window receives the main frame. The focused window gets `data-wheel-role="active"`. Windows within 3 slots of it get `preview`: visible, no pointer events, webviews suspended, and `WheelRail` scales each one onto its card with an inline transform (spec 273). The rest get `hidden` (`visibility: hidden`).
3. `fitAll()` fits every window, hidden ones included, on entry, viewport resize, and maximize restore — `visibility: hidden` keeps layout, so hidden PTYs already have the frame's size.
4. `Leader h/k`, `Leader j/l`, `Cmd+Shift+</>`, `Leader 1-9`, a card click, or a settled mouse-wheel scroll over the rail focuses another window.
5. `syncWheelFocus()` flips the roles, refocuses the now-visible pane, and calls `setActive`. The rail rotates and runs the dock morph in its own rAF loop: the incoming window flies from its card into the main frame, then its transform is cleared; the outgoing one flies back onto its card. The focused window's card stays at the apex with the caret and big label, and the ghost eye (spec 274) moves onto it and opens: `WheelEye` follows the pointer, then output activity, on its own clock (rAF only while the pointer moves or the lids blink, 80 ms while watching, 420 ms when quiet). Input is not buffered, because the incoming pane already has focus. No fit runs, so no `resize_pty` or `SIGWINCH` is emitted.
6. PTY output and content-view output pumps feed both the window's header band and `WheelRail.pump()`; each busy window's activity dot on the arc decays with a 1.5 s half-life and the rail loop stops once all are below threshold.
7. Leaving Wheel disposes the rail, which releases every preview transform, then clears the Wheel class, role, visibility, pointer, z-index, transform, and opacity styles and resumes webviews. Entering Wheel morphs only the focused window with `animateRelayout`; previews start on their cards.

## Config Loading Flow (on app startup)

```
1. Rust backend starts, calls config::load_config()
2. load_config() resolves path: ~/.config/krypton/krypton.toml
3. If file doesn't exist:
   a. Create directory ~/.config/krypton/
   b. Serialize KryptonConfig::default() to TOML
   c. Write default config file to disk
   d. Return default config
4. If file exists:
   a. Read file contents
   b. Parse TOML into KryptonConfig (missing fields filled by #[serde(default)])
   c. If parse fails, log error and return defaults
5. Config stored as Arc<KryptonConfig> in Tauri managed state
6. Frontend calls invoke("get_config") during initialization
7. Compositor.applyConfig() applies settings:
   - Font family, size, line height
   - Terminal scrollback, cursor style, cursor blink
   - Theme color overrides (merged on top of built-in theme)
   - Quick Terminal width/height ratio, backdrop blur
   - Workspace gap, resize/move step sizes
8. If [shader] enabled, ShaderEngine initialized; shaders attached to each pane after terminal.open()
9. First terminal window created with config-backed settings
10. PTY spawned with config shell program and args
```

## Compositor Mode Flow (e.g., user presses Leader key)

```
1. User presses Leader key (Cmd+P)
2. Input Router enters Compositor mode
3. Input Router gathers focused content-view leader bindings, if the pane has a content view
4. UI shows mode indicator / which-key entries. Enabled local view entries are appended under their view group.
5. User presses next key:
   - Leader key owned by focused view -> run local binding, then return to Normal; for example, focused Pencil view owns `/` to replace the current tab with an existing drawing from the current directory, and `?` to prompt for a new `.excalidraw` file in that directory
   - H/J/K/L -> focus window in that direction
   - 1/2/3   -> focus window by index
   - N       -> create new window
   - X       -> close focused window
   - R       -> enter Resize mode
   - M       -> enter Move mode
   - S       -> enter Swap mode (select target window)
   - F       -> maximize/restore focused window
   - ?       -> toggle WorkspaceFooter compact/detail density
   - G       -> cycle shader preset on focused pane (none → crt → hologram → ...)
   - Shift+G -> toggle shaders on/off globally
   - Shift+Y -> open ACP Harness for the focused working directory
   - Escape  -> cancel, return to Normal mode
6. After action executes, Input Router returns to Normal mode
```

## Workspace Footer Flow

```
1. main.ts creates ViewBus, Compositor, InputRouter, and WorkspaceFooter.
2. WorkspaceFooter mounts one fixed 28px bottom rail under #krypton-workspace.
3. InputRouter.onModeChange() updates the footer mode chip and contextual hint.
4. Compositor focus/relayout callbacks provide focused role/title, CWD, and window/tab/pane counts.
5. pty-bridge translates existing Tauri events into ViewBus signals:
   - view:metrics -> foreground process name/pid
   - view:throughput -> activity bytes/s
   - view:progress -> progress state/percentage
   - view:state / view:exit -> focused-view state cleanup
6. WorkspaceFooter accepts bus fields only when signal.source.viewId matches
   compositor.getFocusedViewId().
7. On focused CWD change, WorkspaceFooter debounces git probes through run_command
   (branch, detached HEAD fallback, porcelain dirty marker) and caches the result.
8. MusicPlayer no longer owns a fixed mini-player DOM node; it calls
   WorkspaceFooter.setMusicSegment() with track/time/progress/visualizer state.
9. Footer renders through requestAnimationFrame so focus, mode, music, and bus
   updates coalesce into one DOM patch.
```

## Pencil Picker Rename Flow

```
1. User opens a Pencil picker via Leader e or focused Pencil Leader /
2. User highlights an existing .excalidraw row and presses r
3. Picker swaps the list for an inline rename prompt
4. Enter invokes rename_pencil_file({ fromPath, toPath })
5. Rust validates source/destination extensions, rejects missing source or existing destination, then renames the file
6. Frontend updates the picker row in place; Enter opens the renamed file, Escape returns to the picker
```

## Pi Agent Write Approval Flow

```
1. User prompts the pi-agent view to change a file.
2. AgentController runs the embedded pi-agent turn with CWD-aware tools from createKryptonTools().
3. The model calls write_file({ path, content }).
4. tools.ts resolves the path against projectDir, reads current file content, and computes a unified diff when old+new content is under the preview cap.
5. tools.ts awaits the WriteApprovalHandler registered by AgentView instead of invoking write_file immediately.
6. AgentView appends a WRITE REVIEW row to the transcript:
   a. diff preview when available;
   b. `a` / `r` actions for this write;
   c. `A` / `R` actions for later writes in the same turn.
7. If accepted, tools.ts invokes the backend write_file command and returns the normal tool result with diff metadata.
8. If rejected, tools.ts throws a tool error and does not write to disk.
9. pi-agent-core emits tool_execution_end; AgentView finalizes the tool row as success or error.
10. Ctrl+C while a write is pending rejects pending writes before aborting the agent run.
```

## Pi Agent Bash Approval Flow

```
1. User prompts the pi-agent view to run a shell command.
2. AgentController runs the embedded pi-agent turn with CWD-aware tools from createKryptonTools().
3. The model calls bash({ command, cwd? }).
4. tools.ts classifies the command before invoking run_command:
   a. read-only allowlisted commands run immediately;
   b. shell redirection/heredocs require approval;
   c. known mutators, Git state changes, package/network tools, script runners, and unknown commands require approval.
5. If approval is required, tools.ts awaits the BashApprovalHandler registered by AgentView.
6. AgentView appends a COMMAND REVIEW row with the command, cwd, risk class, and reason.
7. `a` runs this command, `r` blocks it, `A` runs all later risky commands in the turn, and `R` blocks all later risky commands in the turn.
8. If accepted, tools.ts invokes run_command with the user's default shell and the chosen cwd.
9. If rejected, tools.ts throws a tool error and does not execute the command.
10. Ctrl+C while a command is pending rejects pending commands before aborting the agent run.
```

## Pi Agent Check Command Flow

```
1. User types /check in AgentView.
2. AgentView reads project marker files via read_file:
   a. package.json;
   b. Cargo.toml;
   c. go.mod.
3. AgentView selects the first matching narrow command:
   a. package.json scripts.check -> npm run check;
   b. scripts.typecheck -> npm run typecheck;
   c. scripts.test -> npm test;
   d. Cargo.toml -> cargo check;
   e. go.mod -> go test ./...
4. AgentView invokes run_command(program, args, cwd = projectDir) directly.
5. Success renders shell-style output in the AgentView transcript.
6. Failure renders shell-style error output and stores a follow-up prompt containing command + output.
7. User presses f or runs /fixcheck while the agent is idle.
8. AgentView sends the stored failure prompt to AgentController as a normal user prompt.
```

## ACP Harness Flow

```
1. User opens ACP Harness via Leader Y or the command palette.
2. Compositor resolves the focused working directory with getFocusedCwd().
3. AcpHarnessView invokes get_app_cwd() to get the canonical project path.
4. AcpHarnessView resolves the current Git branch for the composer status line with
   run_command("git", ["branch", "--show-current"], cwd). If the branch is
   empty, it tries run_command("git", ["rev-parse", "--short", "HEAD"], cwd)
   and displays detached state as `HEAD <sha>`. Non-Git directories omit the
   branch segment.
5. AcpHarnessView creates a tab-local memory store through
   create_harness_memory(projectDir). The Rust backend:
   a. Resolves a persistence path: ~/.config/krypton/acp-harness-memory/<hash>.json.
   b. Hash is first 16 chars of SHA-256 over canonical project path.
   c. If file exists, loads the project's handoffs into RAM (continuity); a
      second tab on the same project shares the already-loaded store.
   d. Returns harnessId and hook server port to frontend.
6. AcpHarnessView lists ACP backends and starts with an empty roster. The user
   opens `Cmd+P → +` to spawn installed harness backends such as Codex, Claude,
   OpenCode, Pi, Droid, Cursor, Junie, or OMP with the same cwd. After `session/new`,
   a configured `lane_models.<backend>.active` is applied via `session/set_model`
   (`models` advertised) or `session/set_config_option` (`configOptions` model
   select, e.g. OpenCode v2); failure is non-fatal.
   a. Lane add/restore/close recomputes the deduplicated set of supported usage
      providers (Claude, Codex, Copilot, Cursor) and notifies the compositor.
7. Each lane owns one AcpClient, receives an HTTP MCP memory server descriptor
   in session/new.mcpServers, and listens to its own acp-event-<session> stream.
   Lanes render into a shared dashboard, but prompts are dispatched only to the
   active tab in the command center.
   a. OMP lanes skip Krypton's project `.mcp.json` bridge because OMP native-loads
      root `.mcp.json` in ACP mode; they still receive the per-lane
      `krypton-harness-memory` MCP server.
   b. In composer text mode, `Cmd+D` or the `MIC` control starts one frontend
      Web Speech recognition session in English (`en-US`); `Cmd+Shift+D` starts
      the same session in Thai (`th-TH`) when the host webview exposes it.
      Interim results patch dedicated composer spans without rebuilding the lane
      or mutating its draft. Stop inserts the latest text at the saved cursor;
      `Esc`, lane/view teardown, composer pre-emption, or focus leaving the
      Harness aborts capture and restores the saved draft. Dictation never calls
      ACP and never submits automatically.
   c. Printable keys, `Shift+Enter`, plain-text paste, and `Ctrl+Y` converge on
      `insertDraft()`. It arms a lane-scoped `{ laneId, inserted }` marker only
      around the synchronous `setDraft()` → `renderComposer()` call, so the real
      text and inline caret update immediately. After that HTML rebuild the view
      reattaches an overlay and spawns at most `composer_bloom_trail` letter
      afterimages at the inserted visible graphemes. Each copy ignites, drifts
      upward 3px, and dissolves. `finally` clears
      the marker so a later status tick cannot spawn again. Reduce Motion or
      `composer_bloom = false` skips the overlay. Deletes, cursor movement,
      programmatic draft rewrites, and dictation never arm it (spec 252).
   d. Word autocomplete (spec 285): every `setDraft()` checks the current
      ghost. If the user typed the ghost's next characters it shrinks;
      otherwise it is dropped. When the cursor is at a line end right after a
      word, the view posts `complete` to the shared word-predict worker. The
      reply is applied only if the request sequence, draft, and cursor are
      unchanged, and it renders as `.acp-harness__ghost` after the caret.
      `Tab`/`→` accept it through `setDraft()` (no bloom). The worker is
      spawned on first use and loaded from `harness_word_corpus` (Claude/Codex
      JSONL, OMP `history.db`, and the Krypton store, read-only, newest 4 MB).
   e. On submit, `harness_prompt_log` upserts the prompt into
      `~/.config/krypton/harness-prompt-history.db` with the lane's
      `backendId` and cwd. A new row is also posted to the worker as
      `observe`, so a word typed in any lane is predictable at once in every lane.
7. On Enter, the active lane's draft is sent through acp_prompt behind one
   leading lane-context block (spec 289). A turn header goes every turn: the
   lane's label plus one line naming the Krypton tools that lane may call.
   The lane policy goes only when the current agent session has not seen its
   exact text. It holds the ticket pin, the roster and peering rule (when there
   are peers), the tool index, the global lessons block (spec 298), the SVG
   line, and the role/directive block. The
   policy goes on the first turn after `spawnLane`, when its hash changes, after
   a `usage_update` drop of at least 40% or a `/compact`, after a failed prompt,
   and every 20 turns. Each tool's full contract lives in its MCP description,
   and the timeline conflict rule rides on the `timeline_record` ack. Memory
   bodies (summary + detail) are not injected — a handoff reaches a lane only
   through `#resume` (Specs 98, 293). Exception (Spec 279): a draft whose first
   token is one of the lane's advertised `available_commands` (`/review`,
   `/$skill …`) is sent bare — no stub, no directive — because adapters such
   as OMP join all prompt blocks and only parse a command at the start of the
   joined text. A one-shot directive override waits for the next normal turn.
   a. Prompt queue (Spec 136): if the active lane is busy / needs_permission,
      Enter does NOT discard the prompt — it captures {text, frozen image
      snapshot, mention targets} into the lane's FIFO queuedPrompts (cap 10).
      finishTurn schedules maybeDrainPromptQueue via queueMicrotask on each
      idle transition; it drains ONE item (gated on status === 'idle', so a
      synchronous peer-mail drain wins). sendUserPrompt is the shared dispatch
      core (immediate + drain) and never clears the live draft. A drained
      mention whose target vanished re-arms the drain so the queue can't stall.
   b. Mid-turn steering (Spec 278): when the busy lane's adapter advertised
      `_meta.steering.supported` at initialize (claude-agent-acp, codex-acp),
      plain Enter steers instead of queueing; Cmd+Enter still queues. The
      steer controller seals the streaming row, appends a `steer…` user row,
      and sends only the user's image/text blocks through acp_steer
      (`_session/steering`, idleBehavior `promptRequired`).
      - injected → the row reads `steer`; the agent answers inside the turn.
      - promptRequired / failed / JSON-RPC error → the row is removed and the
        text goes to the HEAD of queuedPrompts (after a cancel: a
        `steer not delivered` line instead).
      - startedNewTurn (Codex: the turn ended first) → a turn no
        session/prompt resolves. After a cancel it is cancelled at once.
      Ordering: invoke results reach the frontend in no fixed order relative
      to events, so acp_prompt / acp_steer mark their request ids and the Rust
      reader emits a `turn_marker` event for those replies in stdout order with
      codex-acp's session_info_update `_meta.codex.threadStatus` (`turn_state`
      events). After the prompt marker, the controller counts startedNewTurn
      markers and active → idle pairs; the steer-started turns are over when
      the pairs catch up.
      Missed steers re-queue in typing order. The `stop` event goes to
      steerCtl.onStop: while a steer is in flight or a steer-started turn
      runs, the stop is held and finishTurn runs whole only after both end,
      so turn-end cleanup never hits the newer turn and no peer-mail or queue
      drain can send a colliding session/prompt.
   c. Live voice (Specs 280, 314): `#live [voice]` or Cmd+Shift+L on a lane.
      1. HarnessLiveVoiceController starts muted and installs release/safety
         listeners before awaiting getUserMedia (echo cancellation). Set
         track.enabled = !session.muted before attaching capture tracks to
         RTCPeerConnection; startup tracks are disabled unless a valid hold
         began while capture was pending. Create `oai-events` channel → offer.
      2. invoke live_voice_signal(offerSdp, instructions, voice): Rust reads
         ~/.codex/auth.json, POSTs the offer with Codex Desktop headers, keeps
         the token, returns {generation, answerSdp, callId}.
      3. setRemoteDescription(answer) → data channel open →
         invoke live_voice_open_sideband(generation). Rust forwards each
         sideband text frame as `live-voice-event` {generation, payload};
         an unexpected socket end emits `live-voice-closed`.
      4. Transcript frames update the composer's live strip only.
         `delegation.created` → deliverLivePrompt: idle lane → sendUserPrompt
         (row tagged `voice`); busy lane → steer (spec 278), else queue with
         `liveDelegationId` (spec 136) and `"Agent Queued"` goes back to the
         model; a missed steer re-queues the same way. A queued delegation
         binds when its turn starts.
      5. Lane message_chunk text accumulates; each tool_call sends it as a
         `commentary` append; a permission that waits for the human (not
         auto-accepted by mode, turn-wide accept, peer/Telegram rules) sends an
         `"Agent Permission Request"`, and resolving it sends
         `"Agent Permission Resolved"`; finishTurn sends
         `"Agent Final Message"` (or `"Agent Turn Cancelled"`) — all via
         live_voice_send, serialized per session — and the model speaks it.
         Bare Left Option (AltLeft) held in the focused Harness opens the
         microphone; release closes it immediately. Any other key cancels
         the hold until Left Option is released. Right Option is untouched.
         Blur, document hidden, or focus leaving Harness mutes without
         ending playback, delegation, or the session; refocus requires a
         fresh press. Gate changes patch the strip only and zero the muted
         input meter. A hold released before capture resolves stays muted.
      6. Stop (Cmd+Shift+L, `#live stop`, lane closed/error/restart/new):
         send `session.close`, then live_voice_close(generation); release
         the mic, peer, and audio context, and remove release/safety listeners.
8. MCP-capable agents call handoff_set against
   /mcp/harness/<harnessId>/lane/<laneLabel> (Spec 293).
   a. The project store (shared by every tab of the project, ref-counted by
      harness id) holds handoffs with ids (`ho-…`), newest first, cap 50.
   b. handoff_set overwrites the handoff bound to (harnessId, lane), or mints
      a new one and binds the lane to it. Empty summary + detail deletes the
      bound handoff and drops the binding. Bindings are memory-only.
   c. On every change, the hook server schedules a debounced (500ms) save.
   d. Save is atomic: serialize -> write .tmp -> rename to final .json (v2;
      a v1 lane-slot file migrates to one handoff per slot on load).
9. The hook server emits acp-harness-memory-changed once per harness sharing the
   store so each tab refreshes the read-only board; the writer's event carries
   `handoffId`, and with `[xenon].auto_push = ["handoff"]` the frontend pushes
   that one handoff.
10. session/update notifications append transcript rows and maintain
    file-touch warnings for permission context. Memory is not inferred from
    tool observations or assistant footers.
    a. Short provider/API failures that adapters stringify into
       `agent_message_chunk` are classified when the assistant stream seals.
       Matching rows become `provider_error` transcript cards, set the lane
       error headline, and preserve the raw provider text in collapsed details.
       Generic structured ACP errors still render as system rows unless they
       match the same provider-error classifier.
    b. Assistant `agent_message_chunk` events preserve their original ACP
       `ContentBlock` and optional `messageId`. Text keeps the append-only
       streaming path; typed resources attach to the current assistant item but
       remain hidden until that item seals. Seal scans the final Markdown DOM's
       explicit anchors once, normalizes and deduplicates both sources, caps the
       row at 32 references, and caches Markdown without the generated rail.
       Clicking a rail URL opens the OS handler; clicking a file delegates to
       `Compositor.openHelixTab(path, line, column)`. In transcript command mode,
       `f` assigns one shared hint sequence across references and live artifacts.
    c. When a sealed row contains file references, after successful ACP writes,
       and when a lane returns to `idle`, the harness schedules one debounced
       `collect_reference_git_state(cwd, uniqueTargets)` call. Rust parses
       NUL-delimited porcelain status and `git diff -M --numstat -z HEAD`, counts
       bounded untracked text files locally, and returns no diff content. A
       generation token drops stale replies; the view applies exact-target
       metadata and, for changed rows in the active lane, replaces only the
       REFERENCES rail and restamps the row signature (no lane-chrome rebuild,
       no reply remount). Bare `r` in transcript command mode performs the same
       refresh immediately.
11. Permission requests pre-empt only the affected lane's composer. The user
    switches to that tab and resolves with a/A/r/R/Esc; responses call the
    existing acp_permission_response command.
12. Hash commands are handled locally by the harness before prompt dispatch:
    a. #cancel sends acp_cancel for the active lane. If the turn is still
       busy/needs_permission 10s later (spec 199, issue #13: the agent CLI hung
       and never signalled turn-end), the lane is flagged and a transcript
       system row offers "Ctrl+C again to force-restart"; the next Ctrl+C /
       #cancel kills the lane's process group and respawns it resuming the same
       agent session, so the hung lane is recoverable without killing a PID from
       an external terminal. There is no lane-head cancel chip.
    b. #restart respawns an error/stopped active lane without clearing transcript.
    c. #new awaits disposal of the active lane client, clears lane UI state,
       increments a spawn epoch, and spawns the same backend in the same cwd.
    d. #new! first clears that lane's persisted memory document through
       clear_harness_memory_lane, then follows the #new flow.
    e. #polly <task> (spec 164) runs from any lane: the active lane is the
       Polly orchestrator; ensurePollyWorkers auto-spawns cursor/claude/codex
       worker lanes (if installed), applies built-in role overlays, re-activates
       the orchestrator, and dispatchTurn injects pollyRequestPrompt (peer_send
       fan-out orchestration — sibling of #review). (spec 160 — push out, pull on render)
    f. #debby <question> (spec 167) runs from any lane: the active lane is the
       Debby orchestrator; ensureDebbyHeads finds or auto-spawns separate claude
       and codex head lanes (excluding the orchestrator lane id even when the
       backend matches), applies built-in Debby role overlays, re-activates the
       orchestrator, and dispatchTurn injects debbyRequestPrompt for peer_send
       fan-out. Debby heads are plain responders and do not receive a bypass
       permission mode.
    g. #draw <request> (specs 196/197) injects one version-aware tldraw Offline
       workflow into the active lane. The lane discovers the app's loopback
       server, reads its runtime /readme, picks the target document (focused,
       or uniquely named via the docs-listing filter; ambiguous name matches
       stop for user disambiguation), inspects it, then edits along two
       branches: static content batches through /api/doc/:id/exec; durable or
       interactive behavior goes through the app's script-workspace (recipes
       read first, existing scripts extended, success gated on script-status
       state "applied"). Verification is records plus a screenshot, all under
       the lane's normal tools and permission flow. Krypton never receives or
       persists the bearer token; the packed .tldraw archive and appOwned files
       are never written — only app-declared editable script files are, and the
       app's watcher embeds them; tldraw Offline remains the sole document owner.
    h. #ticket is local-first (spec 238). With no arguments it renders
       `.krypton/tickets/` immediately, then adds unlinked GitHub issues when
       `gh issue list` completes. The picker splits Open (live local tickets
       plus open GitHub issues) from Closed (local `done`, and GitHub `closed`
       if present). Tab toggles the tab; the live filter applies only to the
       visible tab. Creating or selecting a ticket persists only a
       version-2 active pointer; Rust owns `ticket.json`, `ticket.md`, resource
       copy/validation, and the derived `.krypton/analyses/<owner>/<repo>/<id>/`
       summary. `#ticket work`, Analyze, and Fix here bind the active ticket to
       the visible active lane and set local status to `in_progress`; Post
       comment does not rebind. Lanes also write the active ticket directly
       (spec 239): any lane may append via `ticket_note` / `ticket_add_resource`;
       `ticket_progress` / `ticket_link` require the runtime-bound worker, and
       when the active ticket is unassigned the first successful call claims the
       binding (hook server emits `acp-ticket-worker`; the view reconciles the
       real lane id). Each write emits `acp-ticket-progress` with the fresh
       bundle detail, and an agent-set GitHub link triggers the existing `gh`
       snapshot enrichment. A GitHub-linked work prompt reports `issue_progress`
       separately, so the injected GitHub issue card remains GitHub-status-only
       while the docked Ticket Panel shows local status and resources.
       The browser extension popup now also reads that local Ticket Panel state
       via `ticket.active` for its selected lane (spec 268). The control bridge
       resolves the lane's harness; `AcpHarnessView` returns only a bounded
       display snapshot. The popup refetches on open, lane change, focus, and
       every three seconds while open. This read does not change ticket state;
       the injected GitHub issue card continues to show `issue_progress`.
    i. #timeline is local-first (specs 253/316). Bare/open and topic shorthand
       launch the read-only `/timeline` browser for the registered project.
       `/timeline.json` groups schema-1 events by stable `topic_id`, derives
       supersession and exposes evidence/provenance without a persisted index.
       Keyboard context/audit disclosures and focus refresh remain read-only.
       `trace <topic>` asks the lane to inspect older Git/docs/issue evidence
       without mutation or treating code authorship as decision authority.
       Final grammar is open/trace/conflicts/auto/topic; add, review and native
       merge commands and their forms/badge have no aliases. Remote/Pi lanes
       without project-backed MCP tools cannot mutate local Timeline.
    j. Autonomous evidence-first intake runs inside the working local
       MCP-capable lane, with no sidecar or extra turn (spec 316). Before
       `timeline_record`, it reads `timeline_list` to reuse topic IDs and
       inspect relevant events; `event_id` returns full evidence and provenance.
       Required record fields are `topic_title`, `summary`, `made_by`,
       `evidence_kind` (user_statement/observed_outcome/agent_decision) and
       `evidence_excerpt`; optional fields are `topic_id`, `occurred_at`,
       `rationale`, `impact`, `source_ref`, `relation` and `related_event`.
       `instruction_excerpt` is removed, not aliased. HookServer supplies
       project and lane; Rust validates, deduplicates and writes an append-only
       event under `.krypton/timeline/events/`. Recorder is Agent; agent_decision
       also uses the lane as made_by. Old human/authorizing provenance remains
       readable. The result returns event ID/topic ID/path/disposition plus
       conflict_check. There is no human persistence request, permission queue,
       form, pending creation or one-item-per-turn cap. Agent prose uses Thai;
       supporting quotes/actors/source references remain exact, without secrets.
    k. Initialization reads `timeline_settings` and `timeline_pending_count`.
       The default-on automaticRecording setting is stored as schema 2 in
       `.krypton/timeline/settings.json`; schema 1 automaticSuggestions migrates
       atomically, preserving false. `#timeline auto [on|off]` uses
       `timeline_set_enabled`; off rejects new record calls but not legacy
       resolution. Nonvisual pending count affects the ordinary-turn policy
       hash. In a writable working turn the agent reads
       `timeline_list({pending:true})` (default 5/max 20) and evaluates each
       candidate through `timeline_pending_resolve` with pending_id, outcome
       (record/duplicate/discard) and rationale, plus record or event_id only
       for the matching outcome. Normal record never implicitly promotes one.
       Under the storage lock, validation precedes mutation; record writes the
       reserved event first, then an atomic `resolutions/<pending_id>.json`
       receipt preserves original_candidate verbatim, outcome, event reference,
       rationale, resolved_by_lane and resolved_at. Pending removal is last.
       Retries recover the terminal result instead of duplicating events.
       `remaining_pending` includes malformed files with diagnostics; the lane
       keeps reading until exhausted without a per-turn/five-topic migration cap.
       `acp-timeline-changed` carries harnessId/pendingCount to nonvisual policy
       state, never a startup/event/finishTurn-triggered model request.
       Read-only turns defer all mutations. Rollout needs a rebuilt host and
       normally reconnected MCP session before an ordinary turn can process
       existing backlog; fixture success does not mean the real queue migrated.
    l. The agent repairs shared-topic grouping through `timeline_merge` with
       from/into or undo:true and a required rationale. The transport supplies
       lane audit provenance. Unique selectors and same-topic refusal precede
       backup/manifest persistence; only topic_id changes. No human quote or
       permission gate is involved. The retired semantic topic-choice service,
       TypeSafe transport/configuration and footer/Profiler metrics have no
       remaining runtime path. History publication remains explicit #push.
    m2. Timeline conflict review (spec 266, agent-run since spec 267).
       `/timeline.json` calls `timeline_conflicts::trace_project`, which runs
       `scan_project`, builds `supersedes` chains, and joins the proposal and
       review sidecars by event ID; nothing is written. The lane agent does the
       review through MCP tools: after each `timeline_record` it compares only
       the new event with its topic's live events, calls
       `timeline_conflict_record` for a real finding (Rust validates IDs, refuses
       pairs on one `supersedes` chain, writes the proposal with `create_new` if
       new, then appends a review attributed to the calling lane), and calls
       `timeline_conflict_checked` to add the compared IDs to
       `checked/<topic_id>.json`. `#timeline conflicts [<topic>]` enqueues
       `timelineConflictsPrompt`: the agent reads `timeline_conflict_list`
       (open pairs plus `unchecked` topics with `new_event_ids`), works through
       one topic or at most five unchecked topics, and compares only unchecked
       events, so reruns never rescan the project. A refresh of the browser
       page then shows the new state.

```
PUSH (lane → harness), at end of an editing turn:
1. The authoring lane calls the default-on MCP tool
   mark_review_priority { ranges: [{ file, lineStart, lineEnd, level }] },
   reporting only the non-default (high/routine) new-side ranges it just wrote.
2. hook_server.rs validates (positive integer lines, level in high|routine,
   <= 500 ranges), emits the acp-review-priority Tauri event, and awaits the
   frontend reply (BUS_REPLY_TIMEOUT).
3. AcpHarnessView.handleReviewPriority finds the lane by displayName and stores
   the report in reviewPriorityReports keyed by laneId (latest call REPLACES the
   prior report; an empty ranges array clears it). Replies { recorded: true }.
   The report is dropped when the lane closes/#new's and on view dispose.

PULL (window ← harness), on open and on every auto-refresh:
4. openDiffView wires reviewPriority.resolve →
   compositor.resolveDiffReviewPriority(repoRoot): walk listHarnessEntries(),
   keep harnesses whose cwd resolves to repoRoot, call each one's
   control('diff.review-priority') (returns its lanes' merged ranges), concat.
   A pull (no ViewBus broadcast), exactly like resolveDiffReviewTargets.
5. DiffContentView stores priorityRanges and, after diff2html draws the current
   file, applyReviewPriority() splits each panel tbody into hunks (by .d2h-info
   block-header rows), computes each hunk's priority = highest level of any range
   overlapping its new-side lines, then:
     - routine (not user-expanded) -> foldHunk(): hide the content rows, insert a
       single "▸ N routine lines — Enter to expand" summary row in place (paired
       blank spacer in the side-by-side old panel to keep rows aligned).
     - high -> markHigh(): full-cell gutter tint + a ◆ high header badge; the
       header row is recorded in highHunkAnchors for }/{ navigation.
6. On a lane-idle auto-refresh (spec 155), doRefresh re-pulls the report in the
   SAME round-trip as the new diff so folds/markers land in one render (no
   full-then-folded flash); expandedHunks (session-remembered) keeps the human's
   expanded folds open. A range that maps to no hunk is dropped -> normal
   (under-collapse, never over-collapse; ADR-0009).
```

### Generative UI reply (specs 308/309/310/312)

`#ui <request>` sends one-turn catalog guidance, then stages the lane's
assistant text outside the transcript and SSE stream. At final stop the Harness
checks the complete reply with `compile()`; invalid syntax or fence format
produces a diagnostic for up to two same-lane repair turns. The lane stays busy
between attempts, so queued prompts and peer mail cannot take its place.
Passing UI or a prose opt-out becomes one completed assistant row. A second
failed repair shows one diagnostic with the bounded source; cancel discards the
staged text. Live Assist refreshes only after a final result.

Outside `#ui`, a reply streams as before: each of the first two
` ```krypton-ui ` fences is collapsed to a one-line strip
(`interactive UI · receiving spec · N lines`) with its `pre` hidden. At seal,
`AssistantRow` drops the strips, caches pure markdown, compiles up to two
fences and places static cards. A passing `#ui` row instead compiles during
its first completed paint. Either route expands the last card automatically:
the view seats its single `GenUiPanel` node in that card's
slot without taking focus or scrolling, so the UI is on screen while the keys
of a user already typing still reach the composer. A card click or transcript
`f` hint seats the node in any other card; clicking or hinting the open card
again collapses it. Entering the panel — a `user` open, or a pointer press on a
control — is what hands it the keyboard (`Escape` closes, `Tab` rides the
ring). Inputs update local panel state and dependent text, tables, and
bars in place; the transcript row itself does not repaint. After every
transcript commit the view re-seats the node (a repaint rebuilds the card) and
collapses the panel when no mounted row claims the open fence — a row that left
the tail window, a lane switch, or a re-streamed source. A draft action checks
that its lane and fence are current and that the composer is empty, then loads a
visible draft. Only a later user Enter submits it through normal lane routing.
Panel state is retained for up to 32 fences per Harness view and discarded on
lane reset/close or Harness disposal.

### GenUI component gallery (spec 313)

The command palette's `genui-gallery.open` entry or the Harness's `#ui-gallery`
reads `get_hook_server_port`, then uses `open_url` to open
`http://127.0.0.1:<port>/genui-gallery` in the OS browser. The loopback server
serves the separate Vite-built page and its assets from Tauri's `frontendDist`
in release builds; debug builds redirect to the local Vite page. The gallery
enumerates the shipped catalog into an index rail and opens **one component at a
time**: the fragment (`#<ComponentName>`) is the route, so only the open
component is compiled through `compile()` and rendered with the same GenUI
components as the inline panel, and leaving it disposes its renderers while its
input state is kept for a return visit. Inputs change only each example's
in-page state. Draft and OpenUrl actions display demo feedback and never contact
a lane; no project data is requested.

Before the first component mounts, the page fetches `/genui-gallery/theme.json`
— the app's `ThemeEngine::resolve_for_config` result plus `[font]` — and writes
`themeCssProperties()` and the `--krypton-font-*` properties onto its own
`:root`, the same values the Krypton window carries, so a preview is the
component as the user's theme draws it. It re-fetches on window `focus`, so a
palette switch or Reload Config lands on the next look. A debug build's Vite
page is a different origin, cannot reach the route, and falls back to the
built-in krypton-dark values in `gallery.css`.

## Global Lane Lessons Flow (spec 298)

```
1. A lane is corrected:
   - the human redirects a flagged decision (`r`); the envelope carries the
     lesson_record nudge;
   - `review_outcome` reports blockers; the tool result carries a `notice`;
   - the `#review pass` fix prompt ends with the same nudge;
   - or the user runs `#lesson [hint]`.
2. The lane calls lesson_record { slug, title, rule, why, how_to_apply, source }
   (or lesson_retire { slug, reason }) on its krypton-harness-bus endpoint.
   Both tools are auto-allowed.
3. The hook server checks `[acp_harness] lessons`, then validates the call:
   slug shape, single-line rule ≤ 240 chars, cap of 30 active lessons for a
   new slug. Under the store mutex it writes
   ~/.config/krypton/lessons/<slug>.md atomically (or moves the file to
   retired/), regenerates INDEX.md, and emits
   `acp-lessons-changed { harnessId, laneLabel, action, slug, title }`.
4. The app-wide lessons cache (src/acp/lessons.ts) re-invokes `list_lessons`.
   The writing harness appends `[lesson] <action>: <slug> — <title>` to the
   lane and flashes a chip.
5. The next sendUserPrompt on any lane in any Harness renders the lessons
   block into the lane policy. The policy hash changes, so that turn resends
   the policy (spec 289). A Harness opened later calls `list_lessons` at start,
   so its first policy already carries the set.
6. `#lessons` / palette "Open Lessons" calls `list_lessons` and opens INDEX.md
   in the Markdown Viewer. Hand edits to lesson files apply on the next
   refresh; there is no filesystem watcher.
```

## Artifact Gallery Project Grouping Flow (spec 265)

```text
1. Each live harness keeps its project_dir plus pending and registered ArtifactEntry rows.
2. GET /artifacts locks the registry for one snapshot and skips stores with no project or artifacts.
3. Rust canonicalizes each project path, hashes it to project-<16 hex>, and groups stores by that
   opaque ID; only the directory basename becomes projectName.
4. Within a project, duplicate artifact IDs collapse deterministically: registered/live beats
   pending, a non-empty hash beats an empty hash, then the lowest harness ID breaks a tie.
5. Rust sorts projects case-insensitively by name then ID, sorts artifacts newest-first by parsed
   art-<seq>-<hex>, and returns { projects } without raw project paths or harness IDs.
6. The browser polls once per second. A JSON signature guard redraws only when the project snapshot
   changes; the active project survives redraws and falls back to all only if it disappears.
7. The all view renders one section per project. A project tab renders its card grid directly;
   every card retains laneLabel as provenance, and [ / ], 1-9, and 0 navigate the project tabs.
```

## Diff View Smooth Keyboard Scrolling Flow (spec 243)

```text
1. DiffContentView receives a main-canvas vertical navigation key: j/k, f/b,
   g/G, n/N, or }/{; comment and Review Board line reveals use the same path.
2. The view resolves and clamps the target once. Repeated input in the same
   direction extends the pending target; reversal starts from visible scrollTop.
3. With prefers-reduced-motion: reduce, the view writes scrollTop immediately.
4. Otherwise one requestAnimationFrame loop advances scrollTop 24% toward the
   latest target per frame and snaps the final 0.5 px exactly.
5. The ordinary passive scroll listener updates the cached focus-hunk marker at
   most once per frame; it performs no layout walk inside the animation.
6. Exact landing, wheel/pointer input, a content redraw, or dispose cancels the
   animation and clears its target, leaving no idle RAF.
7. Horizontal h/l, wheel/trackpad momentum, priority live preview, overlay-list
   movement, and restored scroll positions remain immediate.
```

## Harness Transcript Annotation Flow (spec 240)

```
1. User selects text in a sealed (or already-written streaming) assistant body.
   Mouseup arms a target and shows a `c annotate` pill. Any other composer
   letter disarms without consuming the key. Esc disarms.
2. `c` (armed, or transcript focus with no selection → nearest visible block)
   opens the annotate overlay. Enter adds an unsent note to that transcript
   item; the lane is not contacted. Repeat.
3. `s` (transcript) or the rail send control copies every unsent note into one
   envelope, marks them sent, TranscriptAnnotationQueue.accept().
4. If the lane is idle/awaiting_peer, the queue drains immediately; if busy,
   it waits for the next idle. Peer mail still wins a contested idle;
   annotations beat artifact/docs/diff/review-board drains.
5. composeAnnotationPrompt emits one trusted framing line plus a raw JSON
   array (no markdown fence) → enqueueSystemPrompt labelled `annotation`.
6. Sealed paint wraps the Nth quote occurrence in <mark> and appends the
   notes rail (before the spec-206 resource rail). Marks are not stored in
   markdownHtml. Unsent notes are in-memory only.
```

## Window AI Credit Status Flow

```
1. The active tab's focused ContentView declares zero or more providers through
   getUsageProviders(); ACP Harness returns the deduplicated union of its lanes.
2. Compositor subscribes that provider set to the shared UsageStore.
3. UsageStore serves its last snapshot immediately, starts one poll timer per
   provider on the first subscriber, and invokes the existing usage_fetch_*
   Tauri command at the provider cadence.
4. Rust usage.rs returns cached-or-live provider data; UsageStore keeps the last
   good payload on failure and marks it stale.
5. Compositor normalizes the snapshot into quota labels and renders the left side
   of the visible window's .krypton-window__footer. Codex chrome and the detailed
   Usage view both keep only the account-level 5-hour and weekly windows; named
   model buckets are not displayed.
6. CSS shows all quota windows at normal width and hides secondary quotas at
   constrained widths; the provider's most-used quota remains.
7. Tab/pane focus changes or Harness provider-membership changes replace the
   window subscription. Closing the final subscriber stops that provider timer.
8. UsageContentView subscribes to the same store for full gauges, reset times,
   spend, and freshness; it no longer owns separate polling loops.
```

## Window Status Bar Lane Strip Flow (spec 218)

```
1. A harness lane roster changes (lane added/removed/renamed, or ⌃1..9 / ⌘P moves
   the active lane); the harness's RAF render() calls notifyLaneMarksChanged().
2. That serializes id/backend/name/accent/active into a key and returns early when
   unchanged — status is NOT in the key, so a busy→idle churn never repaints.
3. On change it invokes the compositor's per-window onLaneMarksChange listener.
4. renderWindowLaneStrip() reads getLaneMarks(), caps at 8 (LANE_STRIP_MAX) with a
   +N tail, compares laneStripKey against the window's rendered key, and rebuilds
   the nodes only when it differs.
5. Each mark is a two-letter drop cap of the display name (`laneDropCap`, same
   split as spec 219), coloured by an inline --krypton-lane-accent. The active
   mark adds a small trailing number when its name ends in `-N`; it has no tab
   background or name tail. No footer logo.
6. Tab visibility changes, window creation, and pane focus changes all call
   syncWindowChrome(win), which re-runs the AI credit sync (spec 153) and
   syncWindowLaneStrip() together — the strip resubscribes to the newly focused
   view, and a focused terminal reports no lanes, so the strip is removed.
7. closeWindow() fires the lane unsubscribe and drops the cached strip key.
```

## Window Titlebar Panel Toggles Flow (spec 320)

```
1. syncWindowChrome(win) — the same four entry points — calls
   syncWindowTitlebarToggles(win): drop the window's previous subscription,
   resolve the active tab's focused pane's ContentView, and render
   getTitlebarToggles?.() into the window's own .krypton-window__titlebar-end
   (a focused terminal has none, so the cluster is removed).
2. syncTitlebarToggles() (src/titlebar-toggles.ts) keeps the cluster as the
   first child of -end and rebuilds its buttons only when an id/icon/label/
   pressed/disabled/separator key changes.
3. A click: the cluster's mousedown preventDefault keeps DOM focus in the
   composer (the window's own mousedown still focuses the window); the click
   handler resolves the focused view AT CLICK TIME and calls
   activateTitlebarToggle(id).
4. AcpHarnessView maps the id to the bare-toggle #panels command:
   applyPanelsCommand → setPanelHidden(panel) or setPanelsHidden() → persist to
   localStorage, notify titlebar listeners, render(), flash the chip.
5. render() → rightRail region: each renderer asks isPanelHidden(id)
   (= panelsHidden || hiddenPanels.has(id)) and empties or unmounts its slot;
   the ticket controller drops the --ticket-* root classes so the dashboard
   gives back the dock's width.
6. The listener re-runs syncTitlebarToggles() → aria-pressed / disabled update.
7. closeWindow() fires the titlebar unsubscribe.
```

## Window Project Badge Flow (spec 219)

```
1. A tab becomes visible / a window is created / pane focus moves — the same four
   entry points as above, all funnelling into syncWindowChrome(win).
2. syncWindowProjectBadge() resolves the active tab's focused pane's ContentView
   and reads getWorkingDirectory?.(). No subscription: a view's project directory
   is fixed for its lifetime, so these four moments are the only ones that matter.
3. projectBadge(dir, getHomeLikePrefix()) turns the path into
   { label, initials, rest, title } — last segment, ~-abbreviated title, head split
   off by code point — or null for a pane with no project (a terminal).
4. renderWindowProjectBadge() compares label+title against the window's cached key
   and returns early when unchanged; null removes the element and the cache entry.
5. The badge renders at the rail's right end, immediately left of the diff stat
   (order: 1, stat at 2, strip at 3): the first two characters at
   --krypton-window-project-zoom × the chrome font, the rest at chrome size on
   the same baseline, both anchored to the rail's floor so the magnified head
   overflows upward over the pane. The badge carries the right-pinning
   margin-left: auto; the stat and the strip trail it with fixed gaps.
6. closeWindow() drops the cached badge key.
```

## Window Diff Stat Flow (spec 220)

```
1. Same four entry points as above: syncWindowChrome(win) calls
   syncWindowDiffStat(win) just before the project badge, so the badge's prepend
   lands ahead of it and reading order is "project, then its counts".
2. It reads the focused pane's getWorkingDirectory?.() and resolves it through
   resolveRepoRoot(cwd) — the compositor's existing cwd → toplevel cache, so the
   git call happens once per directory, not once per sync.
3. Unchanged root: re-render only (the key compare below drops it before the DOM).
   New root: the previous subscription is dropped and the window subscribes to
   diffStatStore for the new one. No root (a terminal, a non-repo directory):
   the element is removed and nothing is subscribed.
4. diffStatStore is keyed by REPO ROOT, not by window: the first subscriber for a
   root fires invoke('working_diff_stat', { cwd }) and arms a 4 s interval; every
   further window on that project rides the same timer; the last unsubscribe
   clears it. Fetches are single-flight per root with one trailing re-fetch, and
   the timer stops while document.visibilityState is 'hidden' (with an immediate
   re-fetch on return).
5. Rust: git.rs::working_diff_stat() runs `diff --numstat -z -M HEAD` (empty-tree
   base on an unborn branch) plus a bounded untracked walk counted as additions,
   and returns totals only — { repoRoot, files, added, removed, truncated }.
6. Every store tick re-renders every subscribed window: diffStatBadge() turns the
   totals into { added, removed, title } — abbreviated past 1000, null on a clean
   tree — and renderWindowDiffStat() compares against the window's cached key, so
   a poll that finds no change writes no DOM at all.
7. In parallel, attachToBus subscribes ONCE to ViewBus `harness:lane-idle`,
   resolves the signal's cwd to a root and calls diffStatStore.refresh(root):
   the counts land at the turn boundary instead of up to 4 s later. The store
   ignores a root no window is watching, so this costs nothing off-screen.
8. closeWindow() unsubscribes (stopping the poll if it was the last window on
   that repo) and drops the cached root and counts.
```

## Developer Daily Note Flow (spec 223)

Capture and compose are separate paths that never call each other. Capture runs
all day at existing round-trips; compose runs only when a note is asked for.

```
CAPTURE
1. A lane calls attention_flag / attention_resolve / review_outcome /
   issue_progress / artifact_register, or the user runs #daily note.
2. The existing handler in AcpHarnessView replies on the bus FIRST (the 2.5 s
   timeout is unchanged), then calls recordJournal(laneLabel, kind, summary).
3. recordJournal resolves the lane for backend/model and hands off to
   journalAppend(), which never awaits and never throws — a capture failure
   costs one line of a note, never a turn.
4. Rust journal::append() writes one O_APPEND line to
   .krypton/journal/<local date>.jsonl. The first append of a run also runs
   prune_once() — the project directory is not known at startup, so retention
   piggybacks on capture rather than on the usage log's startup pass.

WRITE (spec 225 — a lane turn, not a render)
5. #daily [<date>] in a harness window (today when the date is omitted; a
   malformed date is refused, never silently treated as today).
6. daily_note_build runs with the browser's UTC offset. Rust turns <date> into a
   local [start, end) window and filters EVERY source by instant — usage rows
   (reading both UTC-named day files the local day straddles), the journal,
   git log --since/--until (author-filtered by user.email), .krypton/reviews/
   and .krypton/artifacts/ by mtime.
7. Uncommitted work is collected only when the requested day is still running:
   working_diff_stat is a property of now, not of a past day.
8. renderDigestForBrief(digest) produces markdown in TypeScript — pure, tested
   without a filesystem, deterministic. It is the PROMPT PAYLOAD and is never
   written to disk; the raw record turned out to be the half nobody read.
9. daily_write_path resolves <output_dir>/<date>.md and REFUSES it when a file
   is already there whose frontmatter lacks `generated:`. The lane writes the
   file with its own tools, so this is the last point the guard can run; on a
   refusal the brief still happens, reply-only, and nothing on disk is touched.
10. dailyBriefPrompt(date, payload, {path, lane}) is enqueued as a system prompt.
    The lane replies with the brief AND writes it to the path — frontmatter
    (type: daily, generated: lane-narration, lane), an H1 naming the day, ONE
    opening paragraph (figures inline), ONE flat bullet list of bold status
    prefixes (**DONE** → **DOING** → **BLOCKED** → **DROPPED** → **NEXT** →
    **NOTE**; no section headings, no checkboxes), then a footer
    `เขียนโดย AI · <MODEL>` naming the writer's model, not the lane. Before
    writing, the lane reads the previous day's note and carries every
    DOING/BLOCKED forward so no task silently disappears.

READ
10b. Leader J or the `daily.open` palette entry calls compositor.openDailyNote,
     which resolves daily_read_path and opens the file in the existing Markdown
     Viewer. Reading and commissioning are separate acts — the compositor has no
     lane, so a day that was never written says so rather than producing one.

BROWSE (loopback)
11. #daily open resolves the hook-server port and opens /journal?harness=<id>.
    #daily open <date> resolves daily_read_path instead and opens that day's
    /doc page directly — `open` always means the browser, with or without a
    date. A day that was never written, or one under an absolute output_dir
    outside the project (which /doc will not serve), is refused with a reason.
12. journal_index_page walks .krypton/journal/*.md for the selected harness's
    project with a plain read_dir — NOT collect_doc_files, whose standard
    filters drop .krypton/ for being both dot-prefixed and gitignored (which is
    right for /docs: lifting them would admit node_modules too).
13. Rows link to /doc?harness=<id>&path=.krypton/journal/<date>.md. /doc has no
    allowlist — validate_doc_path only checks "under cwd, .md, is a file" — so
    days reuse that reader, and with it live reload (/doc-state), inline
    feedback (spec 172), and artifact export (spec 174). No journal reader
    exists.

PUBLISH
14. #push daily collects one resource per day holding ONE file, keyed daily.md
    (spec 225). The pair of note.md + brief.md is gone, so a reader lands on
    prose instead of a file switcher.
15. #push timeline [event-id] asks timeline::scan_project for recorded events,
    converts each valid event to one Xenon resource (`event.md` plus bounded
    list metadata), and sends it through the existing secret scan and
    content-addressed publisher. Pending/dismissed suggestions are outside the
    scan. Invalid event files become non-retryable failed report items while
    other events and resource kinds continue. #xenon timeline [topic] opens the
    server-rendered project chronology; no Xenon route writes back locally.
```
    e. #mem clear deletes the handoff bound to the active lane (no-op if unbound).
    f. #cancel also clears the lane's prompt queue. #unqueue [N] removes the
       last (or 1-indexed) queued prompt; #queue clear empties the queue without
       cancelling the running turn; #queue edit N pops item N into the composer
       to edit and re-send (Spec 136).
    g. #handoff (Spec 139) injects a one-shot instruction turn via
       enqueueSystemPrompt telling the lane to write/refresh the handoff for
       this work with handoff_set.
       #resume / #resume list / #resume <id> (Specs 293, 307):
       1. local = list_harness_memory; remote = xenon_handoff_list (only when
          [xenon].enabled; 5 s budget; GET resources?kind=handoff, then
          GET /v1/resources/{id} for the first 10, concurrency 4).
       2. Merge by id, newer meta.updatedAt wins; pick newest / by id prefix.
          `list` opens the HandoffPicker overlay over the merged rows instead
          of printing them (no rows → flashChip, nothing opens); the picker
          re-merges on acp-harness-memory-changed and keeps the cursor on its
          id. Enter re-checks the lane (gone / busy → flashChip) and then runs
          the same tail with { mode: 'id' } and the collected snapshot;
          Esc / q closes without touching the lane.
       3. Remote pick → xenon_handoff_fetch reads handoff.md; never written
          locally (ADR-0022).
       4. handoff_bind(harnessId, lane, id) — the lane adopts the handoff.
       5. enqueueSystemPrompt(lane, handoffResumePrompt(doc)) + system line
          "resumed ho-… · author@host · age · source".
       Xenon unreachable / missing_scope / invalid_kind → local only plus a
       system line. #new / #new! / #restart / lane close → handoff_unbind.
       Both commands no-op with a flashChip when memory is unavailable or the
       lane is mid-work (busy/needs_permission/starting); they are allowed
       while awaiting_peer (soft-awaiting, spec 116). Cross-session handoff is
       user-triggered only — no always-on stub, no per-turn cost.
13. Session resume picker:
    a. `Cmd+P → 0` opens the session picker. If an active lane exists, the
       picker auto-selects that lane's backend; otherwise it opens backend
       selection first.
    b. The picker spawns a short-lived AcpClient probe for the selected backend,
       calls `acp_initialize`, and gates actions on
       `sessionCapabilities.list`, `sessionCapabilities.resume`, and
       top-level `loadSession`.
    c. If list is supported, the probe calls `session/list` with `cwd =
       projectDir`; the frontend filters returned sessions by cwd again when
       the agent includes cwd metadata.
    d. Selecting a session creates a new harness lane and attaches the probe
       client plus its event listener before calling `session/resume` or
       `session/load`. This ordering is required because `session/load` replays
       history as `session/update` notifications while the request is still
       pending.
    e. Resume/load sends the same capability-gated `.mcp.json` bridge and
       `krypton-harness-memory` MCP descriptors as fresh lanes. `session/load`
       replayed `user_message_chunk` and assistant/tool updates flow through
       the same transcript renderer as live turns.
14. Images stage in the active lane composer from paste, drop, or global
    Ctrl+Shift+S screen capture. For global capture, main.ts invokes
    capture_screen only when the focused content type is acp_harness, then
    routes the PNG through Compositor.stageCapturedImageOnFocusedContent().
    Pasted and dropped images are first saved through save_temp_image. The
    harness sends staged images as embedded ACP image blocks with base64 data
    plus a file:// URI to the saved path on the next prompt, then clears the
    transient composer thumbnails after dispatch.
15. Closing the harness disposes every lane client, calls dispose_harness_memory(),
    and drops transcripts and file-touch warnings. Persistent memory stays on
    disk for the next harness session in this directory.
16. Per-lane slash commands and mode chip:
    a. After session/new the agent sends an available_commands_update; Rust
       forwards it on acp-event-<session> with kind "available_commands_update".
    b. The TS dispatcher (src/acp/client.ts) emits an `available_commands` event;
       the harness stores it on `lane.availableCommands`. When the user's draft
       starts with `/` and matches `^\/[a-zA-Z0-9_-]*$`, the composer renders a
       palette popup filtered by the typed prefix.
    c. ↑/↓ moves selection, Enter/Tab inserts `/<name> ` at the cursor, Esc
       dismisses for the current draft.
    d. Built-in `#` commands (handled by the harness itself, not the agent) get a
       sibling palette from the static `HASH_COMMANDS` registry in
       `src/acp/hash-commands.ts`. When the draft is a bare `#token` at the line
       start (`^#[A-Za-z0-9!_-]*$`), the composer renders the same popup filtered
       by prefix. ↑/↓ (or ⌃n/⌃p) selects, Tab completes to `#<name> ` (the trailing
       space closes the palette), Esc dismisses. Enter is left to submit, so a
       fully-typed `#cancel` + Enter still fires immediately. The registry is the
       single source of truth and must stay in sync with `runHashCommand`.
    e. current_mode_update follows the same path; modes are looked up against
       agentCapabilities.availableModes captured during initialize, and the lane
       head paints `renderModeChip()` between the model and MCP chips.
17. fs/* activity surfacing:
    a. When the agent calls fs/read_text_file or fs/write_text_file as an inbound
       JSON-RPC request, src-tauri/src/acp.rs handles the I/O locally, then
       calls emit_fs_activity() before replying. Grok and OMP initialize set
       `readTextFile: false` (specs 228, 122) so their file reads stay on the
       native tool (Grok image embed; OMP no longer tries ACP then falls back
       to disk with a red out-of-root chip) and appear as tool_call chips, not
       FS chips. Grok and OMP writes still use fs/write_text_file.
    b. emit_fs_activity emits an `fs_activity` payload on acp-event-<session>
       with method/path/ok/error fields.
    c. The TS dispatcher converts it into an `fs_activity` AcpEvent; the harness
       appends a transcript item rendered as a `📖 read` / `✏️ wrote` /
       `✗ failed` chip showing the path. NotFound reads still render as ok=true
       (returning empty content matches existing wire semantics). Invalid UTF-8
       (PNG, zip, …) is ok=false with
       `binary file (<kind>, N bytes); fs/read_text_file is text-only`.
18. fs/write_text_file gated review (Spec 89):
    a. validate_fs_path(client, path, access) still canonicalizes. Writes
       for scoped backends must sit in the lane's project root or Grok
       session scratch under `~/.grok/sessions/<percent-encoded-cwd>/`
       (or `$GROK_HOME/sessions/...` — every file in that tree, not just
       plan.md); anything else is rejected with an fs_activity error chip.
       Grok fs/* is not scoped (native list/grep/bash already escape), so
       a sibling-repo write reaches the review card instead of dying as
       "Path outside project root". OMP writes are unscoped the same way
       (its `edit`/`write` to a sibling repo or `/tmp` scratch reaches the
       review card; see docs/122). Other lanes keep Spec 89 scoping so
       ACP fs is not an unprompted path (see docs/135).
    b. Paths under that Grok session tree auto-apply immediately (mkdir +
       write, no review card), matching Grok TUI plan-file auto-approve.
    c. For other allowed paths (in-project, or any Grok/OMP path), the handler
       reads the current disk content
       as oldText, parks a oneshot::Sender<Result<Value, Value>> in
       fs_write_pending keyed by the JSON-RPC id, and emits an `fs_write_pending`
       event { requestId, path, oldText, newText }.
    d. The frontend appends a transcript item with kind 'fs_write_review';
       renderFsWriteReviewBody renders the unified diff via the shared
       renderDiffPreview helper plus an inline accept/reject action row.
    e. User presses 'a' (accept), 'r' (reject), 'A' (accept-all-this-turn), or
       'R' (reject-all-this-turn). The harness invokes acp_fs_write_response,
       which pops the parked sender; accept performs std::fs::write and replies
       Ok({}), reject replies an error with code -32000.
    f. The Rust handler then emits fs_activity (success or rejection) so the
       visibility log records the outcome.
    g. Grok plan exit: when the agent calls `_x.ai/exit_plan_mode` (or
       `x.ai/exit_plan_mode`) with { sessionId, toolCallId, planContent },
       Krypton auto-replies { outcome: "approved", feedback: null } so plan
       mode can complete without a Grok TUI client (see docs/135).
    h. Grok question card (spec 229): `_x.ai/ask_user_question` /
       `x.ai/ask_user_question` parks a oneshot in `ask_pending` (empty
       `questions` → `-32602`). The frontend renders an inline transcript
       card; `1–9`/`Enter` replies `{ outcome: "accepted", answers, partial_answers: null }`,
       `x` replies `{ outcome: "skip_interview" }`. Permission modes do not
       auto-answer. A second request skip-interviews the previous oneshot.
       Disconnect / cancel / dispose also skip so Grok does not hang.
    i. ACP form elicitation (spec 279): `initialize` advertises
       `clientCapabilities.elicitation.form` to every backend. An inbound
       `elicitation/create` with `mode: "form"` parks a oneshot in
       `elicit_pending` keyed by a per-client sequence (other modes →
       `{ action: "decline" }`) and emits `elicitation_request`
       { requestId, message, requestedSchema, toolCallId }. `elicitation.ts`
       turns each schema property into a question-card question (enum /
       oneOf / boolean as closed pickers, array as multi-select, string /
       number / integer as typed answers). Enter replies `{ action: "accept",
       content }`, `x` replies `decline`, lane cancel / error / dispose
       reply `cancel`. Cards queue FIFO. OMP uses this for `/review`, plan
       approval and extension select / confirm / input / editor dialogs.
19. tool_call.content[].diff rendering (Spec 89):
    Whenever a tool_call or tool_call_update arrives with a content entry of
    type 'diff' (oldText + newText), buildToolPayload extracts it into
    ToolPayload.diffs; renderToolBody emits the unified +/- diff via the shared
    renderDiffPreview helper using the `acp-harness` CSS prefix.
20. Plan tracking pinned panel (Spec 90):
    a. session/update { sessionUpdate: 'plan' } already flows from Rust through
       client.ts as an AcpEvent { type: 'plan', entries }.
    b. The harness handler stores entries on lane.plan (replacing any prior
       plan) and calls renderPlanPanel(lane). It does NOT append a transcript
       item; the legacy inline `appendTranscript('plan', ...)` was removed.
    c. renderPlanPanel paints into a single floating `.acp-harness__plan`
       element mounted inside `.acp-harness__body` (top-right, z-index below
       memory/help overlays). Header shows `// plan` + `done/total`; rows
       render `[ ]/[~]/[x]` plus content with status colors and a left-border
       priority accent.
    d. The panel is a PlanPanel component mounted through LayoutHost at the
       slot HARNESS_LAYOUT_DEFAULT names for `plan` (today `rail.top`, order
       10). The 'rightRail' region commits it, so a lane switch repaints from
       the active lane's stored plan, and moving the panel is one line in that
       table rather than a CSS + buildDOM + renderer edit.
    e. `p` in transcript focus toggles lane.planCollapsed. #restart, #new,
       and #new! null lane.plan and reset planCollapsed.
21. Harness event render batching (Spec 94 / 114 / 301):
    a. ACP event handlers mutate lane state synchronously, then name the REGION
       they dirtied — invalidate('transcript'), invalidate('rightRail'), … —
       instead of calling a repaint function. Regions are
       rail · laneChrome · transcript · rightRail · composer · overlay.
    b. RenderScheduler coalesces every invalidation in a frame into one
       requestAnimationFrame and commits the dirty regions in that fixed order.
       It replaces the two hand-rolled RAF flags (renderRaf, streamingBodyRaf).
       A commit that dirties a region the sweep already passed books the next
       frame, so no invalidation is lost.
    c. flushSync(region) commits ONE region now and leaves the rest pending.
       The keystroke path uses it — setDraft() → flushSync('composer') →
       pinStickyAfterComposerKey() — so a pending 'transcript' commit (a full
       tail-window reconcile) is never dragged into the keypress frame.
    d. available_commands and mode_update dirty 'composer' and 'laneChrome'
       respectively; neither touches the transcript.
    e. The 'rail' region is the only one that rebuilds the lane roster. Lane
       shells are components: the active lane's `.acp-harness__lane-body` is
       created once and never reparented, so no scroll offset is discarded and
       the old capture/restore dance around the rebuild is gone.
    f. tool_call / tool_call_update dirty 'transcript' only. Row components
       hold their own dependency tuples, so pending and in_progress collapse
       into one status bucket and a status-only tick writes nothing. Generic
       streaming output swaps `.acp-harness__tool-output` alone and never the head;
       recognized OMP execution snapshots update their owning ExecutionCard and,
       when open, the view-owned ExecutionDialog instead (specs 315/319).
       Sticky follow on that pass (rev 15) idles or pins when the transcript
       bottom did not grow, so a bounded execute-output tail does not replay a
       glide over already-visible rows.
    g. stop seals the open rows through LiveComponent.seal(), which invalidates
       NO region (constraint 10). finishTurn patches lane chrome + composer via
       patchLaneTurnChrome; refreshMcpStats updates lane heads by updating their
       components, whose deps are the FORMATTED numbers — a poll whose displayed
       values did not move writes nothing.
    h. For current OMP code cells, renderTool decodes the incoming rawInput /
       rawOutput.details.cells snapshot before compactToolCallForRetention,
       keeping bounded typed data on the same transcript item. Omitted fields
       retain previous values; output snapshots replace, not append. Artifact
       redaction and subagent cards have precedence over this renderer.
    i. Transcript f-hints or an Inspector click open the view's one
       ExecutionDialog (spec 319) for that item: an OverlayShell modal in the
       Harness body that owns the keyboard while open (Cmd/Ctrl chords pass
       through) and never writes row DOM. Each transcript commit refreshes it
       from the item; a lane switch, reset, restart, hidden tab or the item
       leaving lane.transcript closes it without taking focus, while a
       tail-window shift does not. The shared tool ticker scans the Harness
       root so the dialog's live time advances. Source highlighting runs only
       when source changes; table/JSON output replaces only unambiguous
       backend-provided spans. No job polling or spilled-output fetch is
       introduced.
```
## Resize Mode Flow (e.g., Leader then r)

> Lowercase `r` only. `Leader Shift+R` opens the Review Board picker (spec 211) —
> see "Review Board Flow" below.

```
1. Input Router enters Resize mode
2. UI shows "RESIZE" indicator + edge highlight on focused window
3. User presses arrow keys repeatedly:
   - Right: grow width by step_size
   - Left:  shrink width by step_size
   - Down:  grow height by step_size
   - Up:    shrink height by step_size
   (step_size configurable, default 20px per keypress)
4. Window resizes in real-time, xterm.js addon-fit recalculates
5. Each resize step sends invoke("resize_pty", { window_id, rows, cols })
6. Enter or Escape exits Resize mode -> return to Normal mode
```

## Review Board Flow (spec 211)

The load-bearing property: **the file write and the lane delivery are separate.**
Answers are on disk continuously; `s` only hands them to the lane. A review whose
lane has died is still fully recorded.

```
Composing (lane → disk → card)
1. Lane calls review_new { title, subject? }
   → hook_server allocates `.krypton/reviews/<today>-<slug>/` (create_dir on the
     leaf, so a same-day title collision is caught by the filesystem itself and
     retried as `-2`, `-3`…), writes the `.gitignore`, seeds review.md with a
     frontmatter stamp, records a `pending` entry
   → emits `acp-harness-review` { state: 'pending', dir, tail }
   → frontend mirrors it; the tail opens write auto-approval for the WHOLE bundle
     (reviewWritePathMatches), so `assets/` works too
2. Lane writes review.md with its normal edit tool (iterating across turns is
   expected). Each observed write → acp_refresh_review → the card's counts update
   with no lane round-trip
3. Lane calls review_register { id }
   → validate_review_file (basename, bundle depth, symlink/hardlink, size cap)
   → count_review_blocks (fence-aware line scan) → `registered_live`
   → emits { state: 'registered' } → raiseReviewCard → a hintable REVIEW card
   → when `[xenon].auto_push` contains `review`, the first registration also
     starts `xenon_push` for that bundle's slug without delaying the card; the
     existing secret scan and retry report apply. Refresh registration and later
     `response.md` saves do not auto-publish (spec 269)

Reading and answering (card/picker → Board → disk)
4. Human opens it: the card's hint label (`f` then label), or `Leader Shift+R` →
   picker (list_review_bundles = a DIRECTORY WALK, so previous app runs appear;
   only the harnesses of the project holding the focused pane's cwd, else every
   open project with a project column; de-duplicated by bundle dir) →
   Enter. Compositor.openReviewBoard is idempotent on the slug — an open review is
   focused, never opened twice
5. read_review_bundle → parse.ts → ReviewBlock[] PLUS derived H1/H2 chapters
   (spec 244: `ReviewDocument.sections`, half-open block ranges; a single leading
   H1 is the title, not a chapter); response.md (if any) is parsed and its answers
   re-attached BY BLOCK ID; the block cursor starts at the first unanswered
   finding/decision, else block 1, and the ACTIVE CHAPTER is derived from that
   cursor; render.ts builds the DOM for the visible blocks only
6. Human walks it: n/N blocks (continuing into the adjacent chapter at a chapter
   edge), [ ] chapters, o the Review Map, O the Overview, }/{ unanswered, Tab
   steps (each → Diff Window revealLocation, falling back to a reader when the
   path is not in the diff), c comments, a/x triages, 1-9 answers decisions.
   }/{ and Tab are GLOBAL: they switch chapter to reveal their target. Cursor
   moves inside one chapter only re-class the cursor element — no rebuild
6b. / search renders the FULL document for the duration (DOM highlighting is
   whole-document by contract), then closing lands on the match in its chapter,
   or restores the prior view when there was no match
7. EVERY answer → debounced (400ms) write_review_response → response.md.
   Closing the window now loses nothing

Sending (Board → lane)
8. `s` → flush the pending save → send preview → Cmd+Enter
   → compositor.sendReviewResponse → resolveDisplayName finds the ONE owning
     harness → `review.response` control op → ReviewResponseQueue.accept()
   → stamp sentAt, re-save response.md
9. Queue drains on the lane's next idle (it re-checks status, and is constructed
   LAST so it defers when the coordinator or a sibling queue claimed the idle)
   → composeResponsePrompt: one trusted framing line, then ONE JSON value, no
     markdown fence → enqueueSystemPrompt as a system turn
10. `harness:lane-idle` (same-repo) → the Board re-reads review.md, re-parses,
    and restores the cursor + answers by block id (ADR-0008; manual `r` too).
    Chapters are re-derived, then the active chapter is recovered FROM the
    restored cursor — a renamed heading never costs the reader their place
10b. A pane resize crosses 1180px → the view's own ResizeObserver switches the
    Review Map between a persistent column and an on-demand overlay. This is
    presentation only; `ContentView.onResize` is never called by the compositor

Later
11. Days later: the picker's directory walk finds the bundle — no session state
    involved — and the Board reopens it with every answer intact. Lane close /
    `#new` drops the registry entry and the queue, but NOT the bundle: an open
    Board keeps working and keeps autosaving; only `s` reports `no-live-lane`
12. `#reviews` → GET /reviews (read-only archive; no browser→app write path)
```

## Review Thread Flow (spec 270)

1. `#review-thread`, the active lane-head action, or the Command Palette checks
   that a local ACP session is idle. A keyboard-operated preview chooses the
   upstream merge-base or `HEAD` and shows the file count and omitted files.
2. `review_thread_create` checks the preview fingerprint again, stores an
   immutable diff and thread metadata under `.krypton/review-threads/<id>/`,
   and issues a normal Review Board bundle. The thread tab opens immediately
   while the parent lane reads the snapshot and writes the Guide.
3. `review_register` makes the Guide ready. A failed turn cancels the pending
   bundle's write grant while keeping the snapshot; Retry Guide issues a new
   bundle for that thread. The fixed Diff view never receives live-refresh
   events. Line comments autosave to the private thread record, while Guide
   block comments continue to autosave to `response.md`.
4. Submit flushes both drafts and checks the current diff against the original
   base OID. Approve requires a ready Guide and a fresh snapshot; Request
   Changes may refer to a stale snapshot. The verdict is persisted before
   routing. Omitted files require explicit confirmation for Approve.
5. The compositor asks each live harness to deliver the verdict. Only the
   backend/session ID stored in the thread can receive it. A busy lane keeps
   the verdict queued until idle; a missing lane keeps it on disk for Send
   again. The prompt frames human text and quoted code as JSON data. A
   successful turn dispatch marks `handed_off`; an uncertain dispatch stays
   visible for manual retry.

## Review Till Pass Flow (spec 276)

The harness owns the rounds (ADR-0021); the lanes only review and fix. Reviewer
replies never wake the authoring lane — the controller reads them.

```
1. `#review pass [N] [<lane>…] [-- <doc|note>]` → runHashCommand → reviewLoopCtl.start(L, rest)
   (lane idle, no pending peer, ≥1 live reviewer; N default 3, max 8)
2. Round k: reserveCommandTurn(L, 'review pass k/N') → collectReviewSubject (shared with #review)
   → k ≥ 2 and fingerprint == round k−1's → stop `no_change`
3. coordinator.deliverMentionFanOut(L, reviewers, body, {replyConsumer:'harness'})
   → releaseReservedTurn(L, 'awaiting_peer'); the body asks for a final `VERDICT:` line
4. Each reviewer drains the [mention] request on idle and peer_sends its reply to L
5. L's drain(): the reply clears a pending entry whose consumer is 'harness'
   → `in` row rendered, LaneHost.onHarnessReply(L, reply), NO prompt composed for L
6. All replies in → parseReviewerReply ×N → matrix row (spec 146) + `round k/N` row
   → evaluateRound: pass | max_rounds | no_progress | no_findings | inconclusive | no_structure → stop
                    otherwise → fix turn ('fixing k/N': Blockers only, resolves at turn end) → round k+1
7. Stop with ≥1 completed round → summary turn ('review pass summary') → ONE Review Board
   Stop with none, `#cancel`/Ctrl+C, or the lane gone → system row only
```

`#review stop` is graceful: pending requests are cancelled and the loop goes to the
summary, or a running fix turn finishes first. Every wait for the lane checks its
status in a microtask, so a drain-on-idle queue (specs 136/158/211) that claims a
contested idle runs first.

Spec 277 mirrors the loop to the browser lane monitor: every loop state change (start,
phase change, reply, completed round, end) calls `loopChanged()` → the telemetry
publisher's 300 ms debounce → `TelemetryLane.reviewLoop` in the next snapshot. The page
polls `/telemetry`, renders the lane card's `review pass` section, and ticks elapsed
times itself between polls.

## Background Task Flow (spec 305)

A Claude lane's `run_in_background` shell work outlives the turn that launched it:
the launch tool call completes immediately, `finishTurn` sets the lane `idle`, and
the CLI later resumes itself with a `<task-notification>` that never crosses ACP.
Krypton therefore watches the output file the adapter named, not the process it
cannot see (`clientCapabilities.terminal` is `false` — `src-tauri/src/acp.rs`).

```
1. tool_call / tool_call_update → captureBackgroundLaunch(lane, call)
   → parseBackgroundLaunch: `Command running in background with ID: <id>. Output is
     being written to: <abs path>` → registerBackgroundTask (dedupes by id, cap 20)
2. Existing 2 s metrics tick: pollMetrics → refreshBackgroundTasks
   → invoke('acp_background_task_status', { queries: [{id, path}, …] })  — one round trip
3. Rust stats the file and reads at most 4 KiB from its END
   → `[exited with code N]` as the LAST non-empty line → exit_code; otherwise none
4. applyTaskStatus folds the answer in:
   exit marker       → state 'exited', endedAt = file mtime
   no marker + pid in the lane process tree (argv match) → 'running' + subtree CPU/RSS
   no marker + no pid, twice in a row                   → 'orphaned'
   file missing      → 'unknown' (last known bytes/line kept)
5. refreshMetricsRender → LaneHead `bg N` chip + the BackgroundTasks section inside
   the `=` Lane Metrics overlay; `#bg` prints the same table as a transcript row
```

The spinner ticker (`updateSpinnerTicker`) counts a running task as live, but only
while the metrics overlay is open — that is the one surface where a task spinner is
mounted, and the lane itself is `idle` the whole time.

## Assist Sidecar Flow (spec 306)

A cheap second model reads the turn that just ended and proposes the next prompt.
It reaches that model through an ACP backend subprocess — the same path the lanes
use, so there is no API key anywhere — and nothing is sent on the user's behalf:
a suggestion only ever lands in the draft.

```
1. finishTurn(lane, stopReason) → assistCtl.onTurnEnd — placed beside the live-voice
   hook, before this turn's pointers are cleared, so the transcript tail is intact.
2. For each registered task with onTurnEnd and a resolved mode of 'auto':
   gates = active lane · stopReason 'end_turn' · ≥40 chars of assistant text ·
           no pending permission/question · activeSystemLabel null ·
           this lane.turnSeq not already run for this task · no cooldown ·
           task.eligible(ctx) (next-prompt: nothing queued)
3. AssistContext is built from lane state (turn items from the last user row,
   plan, stop reason, model name, project dir) — never from the DOM.
4. state = 'pending' → host.invalidate('composer') → AssistStrip shows one dim row.
5. AssistEngine.run: task.payload (bounded by max_input_chars) → AcpAssistSession:
   reuse the warm session, else acp_spawn(backend, cwd, mcp=[], remoteRuntimeId) →
   initialize → session/new → session/set_model(model). Then ONE session/prompt
   carrying `system + payload`, under an AbortController a timeout_ms timer trips;
   the abort reaches the wire as session/cancel. Setup and the prompt each get a
   full timeout_ms window (the transport calls `ready()` between them), so a cold
   spawn never eats the model's budget. Single-flight harness-wide.
   Fence: permission → declined, fs write → refused, question → cancelled. An
   unanswered request would park session/prompt forever (acp.rs:1585-1621).
6. Assistant text accumulates from agent_message_chunk events; the session/prompt
   response IS the turn end. A stop reason other than end_turn ⇒ 'unavailable'.
7. task.parse(raw) → actions, or null ⇒ 'invalid'. Failures feed the per-task
   breaker: 3 soft in a row ⇒ 5 min cooldown; backend missing / model rejected ⇒ 10 min.
8. Stale answers are dropped on the controller epoch, lane.spawnEpoch and activeLaneId
   before state = 'ready'; host.invalidate('composer') paints the numbered strip.
9. Cmd+1..3 → accept → setDraft(lane, prompt, prompt.length) (refused when the draft
   is non-empty); Cmd+0 dismisses; Cmd+/ re-asks; #assist [task] off|manual|auto|now.
```

A lane switch, close or respawn cancels the in-flight turn — its answer was about
another lane — while the warm subprocess survives; only `dispose()` kills it, and
`mode = "off"` (the default) short-circuits step 2 entirely.

## Workspace Lifecycle Flow

### Startup

```
1. Krypton process starts
2. Config Manager loads krypton.toml (including keybindings, themes) into Arc<RwLock<KryptonConfig>>
3. Theme Engine initializes — embeds built-in themes (krypton-dark, krypton-light, legacy-radiance)
4. Tauri creates fullscreen, borderless, transparent native shell
5. Frontend: FrontendThemeEngine calls invoke("get_theme") — backend resolves theme.name, applies [theme.colors] overrides
6. Frontend sets 50+ --krypton-* CSS custom properties on document.documentElement
7. Frontend loads config via invoke("get_config"), applies to compositor
8. Compositor creates first terminal window with themed xterm.js instance
9. Input Router initializes in Normal mode, first window focused
10. User sees themed windows on transparent desktop, keyboard-ready
```

### Theme / config apply (palette Color Theme or Reload Config)

There is no filesystem watcher. Editing `krypton.toml` or `themes/*.toml` on disk does nothing until **Reload Config** or the next launch. Palette **Color Theme** calls `set_theme` without re-reading the rest of the file.

```
1. User picks Color Theme (set_theme) or Reload Config (reload_config)
2. Backend: set_theme persists theme.name; reload_config re-parses krypton.toml and applies sound
3. Backend: resolves FullTheme, updates Arc<RwLock<KryptonConfig>>
4. Backend: emits "theme-changed" (FullTheme) and "config-changed" (KryptonConfig)
5. Frontend: FrontendThemeEngine applies --krypton-*, --agent-*, --vault-* and `html[data-theme-scheme]`
6. Frontend: compositor updates terminal.options.theme, index-0 window accent, and shaders if [shader] changed
7. Result: chrome + terminals + harness/agent/vault colors update without restart
```

### Workspace Switch (e.g., user presses CmdOrCtrl+2)

```
1. Input Router intercepts global hotkey CmdOrCtrl+2
2. Frontend sends invoke("switch_workspace", { name: "monitoring" })
3. Workspace Manager returns target workspace layout definition
4. Compositor diffs current workspace vs. target workspace:
   - Windows in both: animate from current to target position/size
   - Windows only in target workspace: create with entrance animation, spawn shell
   - Windows only in current workspace: hide with exit animation (PTY stays alive)
5. Animation engine plays workspace transition (keyboard input buffered)
6. After animation completes:
   - All xterm.js instances trigger addon-fit recalculation
   - Each window sends resize_pty for new dimensions
   - Buffered keyboard input delivered to newly focused window
   - Input Router returns to Normal mode
```

### Window-Session Relationship

```
 Active Workspace ("coding")                   Hidden (other workspaces)
+--Window 0 (focused)--+  +--Window 1------+  +--Window 2 (hidden)--+
|  Tab 0: PTY #0       |  |  Tab 0: PTY #2 |  |  Tab 0: PTY #4      |
|  Tab 1: PTY #1       |  |  Tab 1: PTY #3 |  |                     |
+-----------------------+  +----------------+  +---------------------+
         |                          |                    |
         v                          v                    v
+--------------------------------------------------------------+
|              Session Pool (Rust Backend)                      |
|  PTY #0  PTY #1  PTY #2  PTY #3  PTY #4                     |
+--------------------------------------------------------------+
```

Sessions live in a shared pool. Windows reference sessions by ID. When a workspace switch hides a window, its sessions remain alive in the pool. When the workspace becomes active again, windows reconnect to their sessions.

## Context Extension Flow (e.g., user runs `java -jar app.jar`)

```
1. Rust process poller thread ticks every 500ms (configurable via [extensions] poll_interval_ms)
2. For each active PTY session: calls tcgetpgrp(master_fd) to get foreground process group
3. Resolves PGID to process name via ps (macOS) or /proc/{pid}/comm (Linux)
4. Compares with last_known process name for that session
5. If changed: emits Tauri event "process-changed" { session_id, process, previous }
6. Frontend: ExtensionManager receives event
7. Looks up pane via compositor.sessionMap.get(session_id)
8. Matches process.name against built-in EXTENSIONS registry
9. On match (e.g., "java" -> javaExtension):
   a. Calls extension.createWidgets(process)
   b. Top bar and bottom bar elements inserted into pane DOM
   c. addon-fit recalculates terminal dimensions (terminal shrinks)
   d. resize_pty IPC sent to backend (shell receives SIGWINCH)
   e. Java extension starts its own 2s setInterval polling invoke("get_java_stats")
   f. get_java_stats runs jstat -gc <pid> + ps -p <pid> -o %cpu=,rss=
   g. Bottom bar DOM updated with live HEAP/GC/CPU/RSS values
10. When process exits (e.g., user closes java):
    a. Next poller tick detects shell is foreground (no child process)
    b. Emits process-changed with process: null
    c. ExtensionManager calls deactivateExtension(pane)
    d. widget.dispose() clears the stats polling interval
    e. Bar elements removed from DOM
    f. addon-fit recalculates (terminal expands back)
     g. resize_pty IPC sent (shell receives SIGWINCH)
```

## Dashboard Toggle Flow (e.g., user presses Cmd+Shift+G)

```
1. User presses Cmd+Shift+G (dashboard shortcut)
2. xterm.js customKeyHandler returns false (InputRouter intercepts)
3. InputRouter: dashboardManager.matchShortcut(e) returns "git"
4. InputRouter: dashboardManager.toggle("git")
5. DashboardManager.open("git"):
   a. Creates overlay DOM: backdrop + panel + header + content container
   b. Appends to document.body
   c. Calls definition.onOpen(contentElement)
   d. Git Dashboard: invokes get_pty_cwd(sessionId) to get CWD
   e. Git Dashboard: invokes run_command("git", ["branch","--show-current"], cwd)
      and run_command("git", ["status","--porcelain=v1"], cwd) in parallel
   f. Rust backend: std::process::Command spawns git, captures stdout, returns
   g. Git Dashboard: parses output, renders branch/stats/file list into container
   h. CSS transition: opacity 0->1, scale 0.96->1 (150ms)
   i. Calls modeCallback(true) -> InputRouter.setMode(Mode.Dashboard)
6. User presses keys while dashboard is active:
   a. InputRouter dispatches to handleDashboardKey(e)
   b. DashboardManager.handleKey(e) calls definition.onKeyDown(e)
   c. If "r" pressed: Git Dashboard refreshes (re-runs git commands)
   d. If Escape pressed: DashboardManager.close()
7. DashboardManager.close():
   a. Calls definition.onClose()
   b. Calls cleanup function returned from onOpen() if any
   c. CSS transition: opacity 1->0 (120ms)
   d. Removes overlay DOM after transition
   e. Calls modeCallback(false) -> InputRouter.toNormal()
   f. Calls refocusCallback() -> compositor.refocusTerminal()
```

## SSH Session Clone Flow (e.g., user presses Leader then c)

```
1. User presses Leader key, then 'c' (or selects "Clone SSH Session" from command palette)
2. InputRouter: calls compositor.cloneSshSession()
3. Compositor: gets focused pane's sessionId via getFocusedSessionId()
4. Compositor: invoke('detect_ssh_session', { sessionId })
5. Rust SshManager.detect():
   a. Checks cache — returns immediately if this session was already detected
   b. Calls pty_manager.get_shell_pid(session_id) to get the PTY's shell PID
   c. Walks the process tree downward (sysinfo) looking for an "ssh" process
   d. Falls back to `ps -o ppid,pid,comm` if sysinfo doesn't find it (macOS)
   e. Reads SSH process's command line (sysinfo or ps fallback)
   f. Parses args: extracts user, host, port, identity files, jump hosts, extra args
   g. Assigns a control socket path: ~/.config/krypton/ssh-sockets/<user>@<host>:<port>
   h. Caches SshConnectionInfo (with extra_args) and returns it
6. Frontend receives SshConnectionInfo (or null → show "No SSH session" toast)
7. Compositor: probeRemoteCwd(sessionId) — invisible PTY probe:
   a. Generates unique marker string (__KR_<timestamp>_<random>__)
   b. Listens on raw 'pty-output' events for an OSC 7337 response
   c. Writes to PTY: \r\x1b[2K stty -echo; printf '\033]7337;<marker>;%s\007' "$(pwd)"; stty echo\n
   d. stty -echo suppresses all echo — command and output are invisible
   e. printf emits CWD inside a private-use OSC that xterm.js silently discards
   f. Raw bytes still arrive via pty-output event — frontend extracts the CWD
   g. Returns CWD string, or null on 3-second timeout
8. Compositor: creates new tab (DOM elements, pane, xterm.js instance)
9. Compositor: invoke('clone_ssh_session', { sessionId, cols, rows, remoteCwd })
10. Rust clone_ssh_session():
   a. Calls detect() to get/verify SshConnectionInfo
   b. Uses provided remote_cwd, or falls back to get_remote_cwd() (OSC 7 tracked)
   c. Builds ssh command: ssh -o ControlPath=<socket> -o ControlMaster=auto
      -o ControlPersist=600 [-p port] [extra_args...] [-t] user@host
      [cd '<cwd>' && exec $SHELL -l]
   d. Calls pty_manager.spawn() with this ssh command (not the default shell)
   e. Returns new session_id
11. Compositor: registers new session in sessionMap, wires input
12. xterm.js connects instantly (ControlMaster reuses existing TCP connection)
13. Shell starts in the same working directory as the source terminal
14. Titlebar updated to show "SSH: user@host"
```

### OSC 7 Remote CWD Tracking (passive background)

```
1. Remote shell (if configured) emits OSC 7: \033]7;file://<hostname>/<path>\007
2. Frontend parseOsc7(): extracts hostname and path from the URI
3. Frontend: invoke('set_ssh_remote_cwd', { sessionId, cwd, hostname })
4. Backend SshManager.set_remote_cwd():
   a. Compares hostname against local_hostname (cached at startup via `hostname` crate)
   b. If hostname matches local machine → ignored (local CWD, not remote)
   c. If hostname is different → stored as remote CWD for this session
5. On clone, get_remote_cwd() provides a fallback when probeRemoteCwd() times out
```

## OpenCode Dashboard Flow (e.g., user presses Cmd+Shift+O)

```
1. User presses Cmd+Shift+O (dashboard shortcut)
2. InputRouter -> DashboardManager.toggle('opencode')
3. DashboardManager.open('opencode') -> calls onOpen(container)
4. OpenCode Dashboard resolves DB path via run_command("sh", ["-c", "echo $HOME"])
5. Fires 4 queries in parallel via invoke('query_sqlite'):
   a. Overview: total sessions, messages, tokens, cost (aggregate query)
   b. Recent sessions: top 20 parent sessions with JOIN on message for counts
   c. Model usage: GROUP BY modelID/providerID with SUM of output tokens
   d. Tool usage: top 15 tools from part table WHERE type='tool'
6. Rust backend: rusqlite opens ~/.local/share/opencode/opencode.db read-only
7. Executes each query, maps rows to JSON objects, returns Vec<Map>
8. Frontend parses JSON rows into typed structs
9. Renders: overview stat cards, session table, model list, tool bar chart
10. User presses 'r' -> refreshes all 4 queries
11. User presses Escape -> DashboardManager.close() -> restores terminal focus
```

## Harness Controller CLI Flow

```text
1. kryptonctl reads ~/.config/krypton/runtime/controller.json and validates the PID.
2. kryptonctl sends an authenticated typed operation to the loopback control API.
3. Rust control server validates the bearer token and emits acp-control-request.
4. Frontend control bridge checks operationId replay state and routes via HarnessDirectory.
5. The owning AcpHarnessView executes the typed domain operation against live state.
6. Frontend invokes acp_control_reply with the typed result or error.
7. Rust completes the pending HTTP request and kryptonctl prints structured output.
8. For send --wait, kryptonctl polls lane.list until the lane is idle and queueDepth is zero.
```

The CLI never simulates keys, submits hash commands, or registers as a lane.

## Telegram Harness Controller Flow

```text
1. TelegramService verifies the vault token with getMe, best-effort registers
   common commands with setMyCommands, then long-polls getUpdates for message
   and callback_query updates.
2. Rust canonicalizes numeric IDs and checks the user allowlist; groups also
   require the chat allowlist plus an explicit command/mention/reply.
3. Bare /use or /lanes dispatches lane.list and returns paged inline buttons,
   one lane per row with its harness working directory visible in the label.
   A tap is acknowledged immediately, re-authorized by numeric user/chat IDs,
   resolved from a five-minute opaque nonce, and accepted only if a fresh
   lane.list still matches its harness ID, display name, and session ID.
   /use <display-name> remains the exact-name fallback.
4. The service dispatches the typed operation through ControlServer::dispatch
   with trusted ControlCaller::Telegram metadata.
5. control-bridge forwards caller metadata separately from params and routes
   through HarnessDirectory to the owning AcpHarnessView.
6. lane.send starts immediately or enters the existing FIFO queue. The queued
   item retains its Telegram caller and one-turn bypass policy.
7. During that turn, ACP permission and fs-write requests resolve automatically
   with reason telegram-bypass:<user-id>; the persistent lane mode is unchanged.
8. Frontend events use acp_control_publish. TelegramService consumes the same
   typed broadcast as SSE, filters thought/raw tool detail, and appends assistant
   Markdown to a per-chat DigestDraft. The draft captures rich/plain mode when
   the response starts, so a Settings change never mutates an in-flight answer.
9. With rich messages enabled, Comrak converts the answer to a strict Telegram
   HTML subset. Private chats stream through sendRichMessageDraft; groups edit
   one persistent rich preview. Nested-block/depth/byte overflow and rich API
   failures continue through the plain path, resetting dedup state and retaining
   already accepted chunks so content is neither lost nor duplicated.
   If tool activity appears during a private-chat draft, the answer preview is
   promoted to a persistent editable message. The coordinator writes the tool
   summary first, then the answer preview, so both surfaces participate in
   normal message layout instead of overlapping at the bottom of the chat.
10. stop/error finalizes the plain tool summary before the persistent answer,
   then clears the turn policy. Lane/session/harness lifecycle events
   invalidate stale chat targets instead of silently retargeting.
11. The handled update ID is persisted under
    ~/.config/krypton/runtime/telegram-state.json for restart-safe polling.
```

Pairing is the only pre-authorization command: `/pair CODE` consumes a
five-minute code and creates a pending identity record, but grants nothing until
the local Telegram Settings view accepts it.

## Terminal Control Monitor Flow

1. The user runs `#termctrl` or selects **Open Terminal Control Monitor** from
   the command palette.
2. The frontend invokes `get_termctrl_monitor_url`; Rust returns the hook-server
   port plus its process-lifetime capability token, then `open_url` launches the
   system browser.
3. While the page is visible, it requests the normalized session list every two
   seconds. `TermctrlMonitor` resolves the external binary if needed and runs
   the absolute path with `list --json` under a two-second timeout and one-MiB
   output cap.
4. The page retains selection by session name. It requests only the selected
   session's `show NAME` visible text and assigns the response with
   `textContent` to its `<pre>`. Running screens refresh every second; an exited
   screen is fetched once and cached because it can no longer change.
5. Stale and incompatible entries render their list diagnostics without a
   screen request. If a session disappears, selection moves to the first
   remaining row; zero sessions render startup guidance.
6. `visibilitychange` stops both timers when the tab is hidden. Returning to the
   tab triggers one immediate refresh before the timers resume. One list and one
   screen request may be in flight; slow cycles are skipped, never queued.
7. No route accepts terminal input or session lifecycle operations. The browser
   is an observer only. See `docs/0198-termctrl-session-monitor.md`.

## Hurl Web Client Flow

1. The user runs `#hurl`, or selects **Open Hurl Web Client** from the command
   palette. `Leader q` still opens the in-app Hurl window.
2. The frontend invokes `get_hurl_web_url` with the focused terminal cwd (or
   the harness project dir). Rust issues or reuses a 128-bit token bound to
   that canonical cwd and returns `http://127.0.0.1:<port>/hurl/<token>`.
3. `open_url` launches the OS browser. A bad token is a non-reflective 404.
4. The page loads `/listing`, then `/state` from the same
   `<app_cache_dir>/hurl/state/<sha256(cwd)>.json` file as the in-app
   client, applies the open-folder set as-is (missing = collapsed,
   including ancestors of the selected file — a collapse around the
   current file must survive refresh). If that file is hidden, the
   cursor lands on the collapsed ancestor. Then `/source` and `/cache`
   for a visible file. `j`/`k` walk **visible** rows (folders included);
   `/` filters. Folder click / `h` / `l` / `Enter` PUT immediately;
   other changes stay on a 300ms debounce, flushed on `pagehide`.
   File-list and source split sizes stay in the page's `localStorage`
   (`krypton-hurl-splits`); they are not written to that state file.
5. Enter / `r` POSTs `/run`. The hook server cancels any in-flight run for
   that session, spawns `hurl --color --pretty --include` via `hurl.rs`, and
   returns `{ runId }`. The page opens `EventSource` on `/events/{runId}`.
6. `stream_reader` fans chunks to a broadcast channel (SSE) and the existing
   Tauri `hurl-output` events (in-app view). On exit, Rust persists the same
   on-disk cache the in-app client uses and emits `finished` with stdout/stderr.
7. Pretty / Raw / Headers re-render from that snapshot. Path confinement
   rejects any `path` or `variablesFile` outside the session cwd.
8. `c` / the **curl** chip converts the selected `.hurl` source to POSIX curl
   in the page (no request is sent). `{{variables}}` are filled from the
   currently selected `*.env` map already loaded via `GET /env`. `H` / the
   **hurl** chip copies `hurl [--verbose] [--variables-file <env>] <file>`
   using listing relative paths (run from the session cwd). See
   `docs/0237-hurl-copy-curl.md`.
9. See `docs/0227-hurl-web-client.md`.

## Remote ACP Harness launch and reconnect

1. `Leader Shift+S` captures the focused terminal session id and requests remote
   choices. Rust detects SSH metadata and reads only passively cached OSC 7 CWD.
2. The picker returns either a configured profile or the focused SSH target plus
   an absolute project path. No probe command is injected into the terminal.
3. Rust resolves OpenSSH config and borrows a verified ControlMaster when possible.
   It probes the versioned remote user cache; on a miss, it detects the target,
   resolves a bundled or SHA-256-verified release helper, uploads it atomically,
   and verifies the installed version.
4. Rust starts the exact cached `krypton-remote serve --stdio` path and completes
   the protocol hello before the compositor replaces the launch tab.
5. Every lane spawn sends command/argv/cwd as JSON. Remote stdout events feed the
   existing local ACP dispatcher; `fs/read_text_file` and gated writes call the
   same runtime's workspace methods.
6. The local hook server opens a dynamic reverse forward. Remote agents use the
   allocated remote-loopback port for Harness memory MCP; no public listener is
   created.
7. On disconnect, in-flight work becomes outcome-unknown and is never replayed.
   Reconnect starts a fresh companion under the same runtime identity and tries
   ACP resume/load for each saved session before falling back to a warned fresh
   session.

## Connected Computer command flow (spec 311)

1. The user opens **Connected Computers…** from the command palette, saves a
   named SSH profile, and selects **Connect**. Rust resolves OpenSSH config,
   starts its own ControlMaster and reports `connected` only after `ssh -O check`.
2. A local Harness lane calls `computer_list` through its per-lane MCP server,
   or Pi/Cursor/Junie/Cline run `"$KRYPTONCTL_PATH" computer list --json`
   through a shell tool. The capability must
   still be bound to a live local ACP session; saved but disconnected profiles
   cannot execute commands.
3. `computer_exec` or `kryptonctl computer exec` names one connected ID. Rust
   validates the request. If the profile's `auto_approve_read_only` is on
   (default) and the command passes `read_only_script` (spec 318), Rust skips
   the approval event and the wait and uses the re-quoted argv it classified.
   Otherwise Rust emits the exact target, directory and command to the
   requesting Harness and waits for a one-time user decision. The Harness seats
   that request as a permission row in the requesting lane's transcript (`a`
   approves once, `r` declines) and keeps it in `pendingComputerCommands`, a
   queue no auto-accept path touches; unanswered, it expires after 120 seconds.
   The adapter's permission auto-allow covers only this built-in routing call.
4. After approval, or immediately for an auto-approved read-only command, Rust
   rechecks the lane and SSH master, then sends the script (the re-quoted argv
   or the approved original command) to remote `sh -s` over a fresh no-PTY
   channel. It returns bounded stdout,
   stderr and exit code. Timeout, lane close or disconnect cancels the local SSH
   child and reports the remote outcome as unknown; Krypton never retries it.
