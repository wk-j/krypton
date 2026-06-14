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

## Keyboard Input Routing (Step-by-step)

1. **User presses a key** -> webview captures `keydown` event
2. **Input Router checks mode**:
   - **Global hotkey?** (e.g., `Cmd+I`, `Cmd+Shift+H`) -> execute immediately (toggle Quick Terminal, enter hint mode, etc.)
   - **Normal mode?** -> forward to focused window's xterm.js -> xterm.js encodes and emits `onData`
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
10. **Progress UI** -> If `pty-progress` was emitted, the compositor updates the target window's content-area gauge (large translucent SVG arc centered behind terminal text) and titlebar scanline sweep animation
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
   c. If file exists, loads lane memory documents into RAM (continuity).
   d. Returns harnessId and hook server port to frontend.
6. AcpHarnessView lists ACP backends and starts with an empty roster. The user
   opens `Cmd+P → +` to spawn installed harness backends such as Codex, Claude,
   OpenCode, Pi, Droid, Cursor, Junie, or OMP with the same cwd. After `session/new`,
   OpenCode lanes receive `session/set_config_option` to select
   `zai-coding-plan/glm-5.1`.
   a. Lane add/restore/close recomputes the deduplicated set of supported usage
      providers (Claude, Codex, Copilot, Cursor) and notifies the compositor.
7. Each lane owns one AcpClient, receives an HTTP MCP memory server descriptor
   in session/new.mcpServers, and listens to its own acp-event-<session> stream.
   Lanes render into a shared dashboard, but prompts are dispatched only to the
   active tab in the command center.
   a. OMP lanes skip Krypton's project `.mcp.json` bridge because OMP native-loads
      root `.mcp.json` in ACP mode; they still receive the per-lane
      `krypton-harness-memory` MCP server.
7. On Enter, the active lane's draft is sent through acp_prompt with a short
   lane-context stub: the lane's own label, the full lane roster, and a
   one-line nudge describing the krypton-harness-memory MCP tools. Memory
   bodies (summary + detail) are not injected — agents call memory_list /
   memory_get on demand (Spec 98).
   a. Prompt queue (Spec 136): if the active lane is busy / needs_permission,
      Enter does NOT discard the prompt — it captures {text, frozen image
      snapshot, mention targets} into the lane's FIFO queuedPrompts (cap 10).
      finishTurn schedules maybeDrainPromptQueue via queueMicrotask on each
      idle transition; it drains ONE item (gated on status === 'idle', so a
      synchronous peer-mail drain wins). sendUserPrompt is the shared dispatch
      core (immediate + drain) and never clears the live draft. A drained
      mention whose target vanished re-arms the drain so the queue can't stall.
8. MCP-capable agents call memory_set, memory_get, and memory_list against
   /mcp/harness/<harnessId>/lane/<laneLabel>.
   a. memory_set overwrites the caller's own document in RAM.
   b. On every set/clear, the hook server schedules a debounced (500ms) save.
   c. Save is atomic: serialize -> write .tmp -> rename to final .json.
   d. memory_get reads any lane's document by label from RAM.
   e. memory_list lists all lanes' summaries from RAM.
9. The hook server emits a memory-changed event so the harness refreshes the read-only board.
10. session/update notifications append transcript rows and maintain
    file-touch warnings for permission context. Memory is not inferred from
    tool observations or assistant footers.
    a. Short provider/API failures that adapters stringify into
       `agent_message_chunk` are classified when the assistant stream seals.
       Matching rows become `provider_error` transcript cards, set the lane
       error headline, and preserve the raw provider text in collapsed details.
       Generic structured ACP errors still render as system rows unless they
       match the same provider-error classifier.
11. Permission requests pre-empt only the affected lane's composer. The user
    switches to that tab and resolves with a/A/r/R/Esc; responses call the
    existing acp_permission_response command.
12. Hash commands are handled locally by the harness before prompt dispatch:
    a. #cancel sends acp_cancel for the active lane.
    b. #restart respawns an error/stopped active lane without clearing transcript.
    c. #new awaits disposal of the active lane client, clears lane UI state,
       increments a spawn epoch, and spawns the same backend in the same cwd.
    d. #new! first clears that lane's persisted memory document through
       clear_harness_memory_lane, then follows the #new flow.

## Diff Review Priority Flow (spec 160 — push out, pull on render)

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
   of the visible window's .krypton-window__footer.
6. CSS shows all quota windows at normal width and hides secondary quotas at
   constrained widths; the provider's most-used quota remains.
7. Tab/pane focus changes or Harness provider-membership changes replace the
   window subscription. Closing the final subscriber stops that provider timer.
8. UsageContentView subscribes to the same store for full gauges, reset times,
   spend, and freshness; it no longer owns separate polling loops.
```
    e. #mem clear clears the active lane memory document for future prompts only.
    f. #cancel also clears the lane's prompt queue. #unqueue [N] removes the
       last (or 1-indexed) queued prompt; #queue clear empties the queue without
       cancelling the running turn; #queue edit N pops item N into the composer
       to edit and re-send (Spec 136).
    g. #handoff / #resume (Spec 139) inject a one-shot instruction turn into the
       active lane via enqueueSystemPrompt (no acp_* command): #handoff tells the
       lane to write/refresh a resume-ready memory_set document; #resume tells it
       to memory_get its own lane and continue. Both no-op with a flashChip when
       memory is unavailable or the lane is mid-work (busy/needs_permission/
       starting); they are allowed while awaiting_peer (soft-awaiting, spec 116).
       Cross-session handoff is user-triggered only — no always-on stub, no
       per-turn cost.
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
    d. current_mode_update follows the same path; modes are looked up against
       agentCapabilities.availableModes captured during initialize, and the lane
       head paints `renderModeChip()` between the model and MCP chips.
17. fs/* activity surfacing:
    a. When the agent calls fs/read_text_file or fs/write_text_file as an inbound
       JSON-RPC request, src-tauri/src/acp.rs handles the I/O locally, then
       calls emit_fs_activity() before replying.
    b. emit_fs_activity emits an `fs_activity` payload on acp-event-<session>
       with method/path/ok/error fields.
    c. The TS dispatcher converts it into an `fs_activity` AcpEvent; the harness
       appends a transcript item rendered as a `📖 read` / `✏️ wrote` /
       `✗ failed` chip showing the path. NotFound reads still render as ok=true
       (returning empty content matches existing wire semantics).
18. fs/write_text_file gated review (Spec 89):
    a. validate_fs_path(client, path) canonicalizes the requested path against
       the lane's project root and rejects anything that escapes; the rejection
       still emits an fs_activity error chip.
    b. If the path passes scoping, the handler reads the current disk content
       as oldText, parks a oneshot::Sender<Result<Value, Value>> in
       fs_write_pending keyed by the JSON-RPC id, and emits an `fs_write_pending`
       event { requestId, path, oldText, newText }.
    c. The frontend appends a transcript item with kind 'fs_write_review';
       renderFsWriteReviewBody renders the unified diff via the shared
       renderDiffPreview helper plus an inline accept/reject action row.
    d. User presses 'a' (accept), 'r' (reject), 'A' (accept-all-this-turn), or
       'R' (reject-all-this-turn). The harness invokes acp_fs_write_response,
       which pops the parked sender; accept performs std::fs::write and replies
       Ok({}), reject replies an error with code -32000.
    e. The Rust handler then emits fs_activity (success or rejection) so the
       visibility log records the outcome.
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
    d. render() calls renderPlanPanel(activeLane()) every pass so lane switch
       repaints from the active lane's stored plan.
    e. `p` in transcript focus toggles lane.planCollapsed. #restart, #new,
       and #new! null lane.plan and reset planCollapsed.
21. Harness event render batching (Spec 94):
    a. ACP event handlers mutate lane state synchronously, but expensive
       transcript/dashboard refreshes call scheduleRender() instead of render().
    b. scheduleRender() keeps one pending requestAnimationFrame callback, so
       multiple message_chunk, thought_chunk, tool_call_update, and similar
       events arriving in one frame coalesce into one full render pass.
    c. available_commands does not rebuild the transcript; it updates the active
       composer so slash-command palette state can change immediately.
    d. mode_update does not rebuild the transcript; it refreshes lane heads via
       the existing lightweight header refresh path.
    e. Full renders still rebuild the active lane DOM, but assistant rows reuse
       cached markdown HTML and pretext rows reuse cached line layouts until
       their source text or layout metrics change.
```
## Resize Mode Flow (e.g., Leader then R)

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

## Workspace Lifecycle Flow

### Startup

```
1. Krypton process starts
2. Config Manager loads krypton.toml (including keybindings, themes) into Arc<RwLock<KryptonConfig>>
3. Theme Engine initializes — embeds built-in themes (krypton-dark, legacy-radiance)
4. Tauri creates fullscreen, borderless, transparent native shell
5. Filesystem watcher starts on ~/.config/krypton/ (notify crate, 300ms debounce)
6. Frontend: FrontendThemeEngine calls invoke("get_theme") — backend resolves theme.name, applies [theme.colors] overrides
7. Frontend sets 50+ --krypton-* CSS custom properties on document.documentElement
8. Frontend loads config via invoke("get_config"), applies to compositor
9. Compositor creates first terminal window with themed xterm.js instance
10. Input Router initializes in Normal mode, first window focused
11. User sees themed windows on transparent desktop, keyboard-ready
```

### Theme Hot-Reload (user edits a .toml file)

```
1. notify crate detects .toml file change in ~/.config/krypton/
2. 300ms debounce timer elapses
3. Backend: reload_and_emit() re-parses krypton.toml, resolves theme by name
4. Backend: applies [theme.colors] overrides on top of resolved FullTheme
5. Backend: updates Arc<RwLock<KryptonConfig>> with new config
6. Backend: emits "theme-changed" Tauri event (payload: FullTheme)
7. Backend: emits "config-changed" Tauri event (payload: KryptonConfig)
8. Frontend: FrontendThemeEngine receives "theme-changed" event
9. Frontend: sets all --krypton-* CSS custom properties (instant CSS cascade)
10. Frontend: notifies compositor which updates terminal.options.theme on all open terminals
11. Frontend: compositor re-applies shader settings to all active panes (if [shader] changed)
12. Result: window chrome + terminal colors + shader effects update instantly without restart
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
