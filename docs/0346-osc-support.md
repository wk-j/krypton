# OSC Support — Registry

> Status: Implemented — registry of shipped behavior (doc only, no code change)
> Date: 2026-10-29
> Covers: 2 (FR-VT-006, FR-VT-009, FR-VT-010) · 4 · 13 · 18 · 28 · 30 · 40 · 121 · 226 · 247 · 284 · 330 · 334 · 335 · 336

## Scope

Every Operating System Command (`ESC ] Ps ; Pt`, ended by `BEL` or `ESC \`) that changes what
Krypton does, and where it is handled. PTY output is read on three paths. None of them strips
bytes, so every sequence also reaches xterm.js:

1. **Rust PTY reader** (`src-tauri/src/pty.rs`): scans each chunk before emitting `pty-output`.
2. **Frontend raw-byte scan** (`src/pty-bridge.ts`, `src/ssh-session.ts`): reads the `pty-output`
   payload, outside the xterm.js parser.
3. **xterm.js 6.0.0 parser**: its built-in handlers, plus the handlers Krypton registers with
   `terminal.parser.registerOscHandler`.

xterm.js runs in two places only, both in `src/compositor.ts`: `createPane` (every terminal pane:
windows, tabs, splits, restore, SSH clone, editor tab) and the Quick Terminal. No other view
parses OSC.

## Registry

| OSC | Behavior in Krypton | Parsed by | Implemented in | Quick Terminal | Spec |
|-----|---------------------|-----------|----------------|----------------|------|
| `0`, `2` title | Window label and tab title. A burst is coalesced (120 ms debounce, a repeat is dropped). On a new window's first pane, Claude Code titles are rewritten to HUD labels (`formatTerminalTitle`). | xterm.js (`onTitleChange`) | `src/compositor.ts` (`wireTitleSync`, `paintWindowLabel`), `src/claude-hooks.ts`, `src/window-title-label.ts` | Yes | 2 (FR-VT-006), 13, 30, 226 |
| `4`, `104` palette color | Set, query or reset one ANSI color. A query (`4;<n>;?`) is answered with the current theme's color. | xterm.js built-in | `@xterm/xterm` (`InputHandler`, `CoreBrowserTerminal._handleColorEvent`); the theme is `terminalTheme` in `src/compositor.ts` | Yes | this doc |
| `10`, `11`, `12`, `110`–`112` fg / bg / cursor color | As `4`, for the foreground, background and cursor color. | xterm.js built-in | as `4` | Yes | this doc |
| `7` cwd | `file://<host>/<path>`, percent-decoded; the latest report in a chunk wins. Footer cwd changes at once on `cd` (`view:cwd`). A non-local host goes to the remote cwd cache used by SSH clone (`Leader c` / `Leader C`) and the remote harness picker (`Leader Shift+S`). The latest report per session feeds `Cmd+K` on an SSH host, kept only when its host matches. A sequence split across chunks is carried (≤ 4096 bytes). | Frontend raw-byte scan | `src/osc7.ts`, `src/pty-bridge.ts`, `src/main.ts`, `src/workspace-footer.ts`, `src/compositor.ts` (`noteOsc7`), `src-tauri/src/ssh.rs`, `src-tauri/src/commands.rs` (`set_ssh_remote_cwd`), `src-tauri/src/inline_remote.rs`, `src-tauri/src/remote_harness.rs` | Remote cwd cache only; the footer uses `get_pty_cwd` | 28, 121, 247, 336 |
| `8` hyperlink | xterm.js underlines the link text on hover, for `http`/`https` only. Krypton sets no `linkHandler`, so a click runs xterm.js's default: `confirm()`, then `window.open()`. wry 0.55.1's `WKUIDelegate` does not implement the JavaScript confirm panel, and WebKit then answers `confirm()` as Cancel, so the link does not open (read from code, not exercised in the app). Hint mode does not read OSC 8 targets. | xterm.js built-in (`OscLinkProvider`) | `@xterm/xterm`; no Krypton code | Yes | this doc |
| `9;4` progress | ConEmu progress: `0` hide, `1` normal, `2` error, `3` indeterminate, `4` paused, with a 0–100 percent. Arc gauge behind the terminal and a titlebar sweep; state kept per pane, the active tab's shown. | Rust PTY reader (`OscProgressParser`) → `pty-progress` event | `src-tauri/src/pty.rs`, `src/compositor.ts`, `src/progress-gauge.ts`, `src/types.ts`, `src/styles/progress.css` | Yes | 2 (FR-VT-009), 18 |
| `133` shell integration | `A` prompt, `C[;cmdline_url=…]` command start, `D[;<exit>]` command end; `B` is ignored. Observed, never consumed. `A` drops working/blocked/idle program-status records. `C`/`D` feed the last-five-commands log for `Cmd+K` context and the failure follow-up, which arms only when the last event is `A`. RIS clears the log. | xterm.js handler registered by Krypton | `src/compositor.ts` (`wireProgramStatus`), `src/terminal-context.ts` (`parseOsc133`, `ShellCommandLog`), `src/inline-ai-follow-up.ts` | No | 284, 334, 335, 336 |
| `1337` inline image | iTerm2 IIP `File=…;inline=1;size=<n>:<base64>`; needs `inline=1` and a size within the addon's limit. Painting is held during the transfer the way DEC mode 2026 holds it. Other `1337` commands (`SetUserVar`, `CurrentDir`, …) are ignored. | xterm.js handler (`@xterm/addon-image` 0.9.0) | `src/xterm-images.ts` (`installInlineImages`) | Yes | 4 (Inline images) |
| `7501` program status | Krypton's Program Status Protocol rev 0.3: per-pane records in `idle` / `working` / `done` / `blocked` / `error`. `OSC 7501;?` is answered with `ESC ] 7501 ; ? ESC \`. Shown on tab and window chrome and in the footer counts; `Leader !` focuses the next pane needing you. RIS clears; a keypress acknowledges done/error. | xterm.js handler registered by Krypton | `src/program-status.ts`, `src/compositor.ts` (`wireProgramStatus`), `src/workspace-footer-program-status.ts`, `src/workspace-footer-segments.ts`, `src/input-router.ts`, `src/styles/window.css` | No | 2 (FR-VT-010), 284 |
| `7337` Krypton-private | Not for programs. SSH clone probes the remote cwd by making the remote shell print `OSC 7337;<marker>;<cwd>` and reads it back from raw bytes; xterm.js drops it. | Frontend raw-byte scan | `src/ssh-session.ts` (`probeRemoteCwd`) | — | 28 |

## Not supported

- `52` clipboard: no handler in xterm.js core or in Krypton (no clipboard addon is installed). A
  program over SSH (tmux, Neovim) cannot set the macOS clipboard.
- `9;<text>`, `777;notify`, `99` (kitty) notifications: the handlers were removed with
  `src/notification.ts` on 2026-10-15 (spec 40). `9;4` still means progress.
- `1` icon name: xterm.js stores it; nothing shows it.
- `1337` commands other than `File=`.
- Every other number: xterm.js drops it.
- Kitty graphics is APC, not OSC; it is not supported either (spec 4).

## Other Readers of Raw OSC Bytes

- **Bell:** the `pty-output` listener in `Compositor.setupPtyListeners` plays `terminal.bell` for a
  lone `BEL` and skips a `BEL` that ends an OSC.
- **Terminal Control monitor:** `src/loopback/surfaces/termctrl/ansi-text.ts` drops every OSC,
  DCS, APC, PM and SOS string and keeps the text (spec 330).

## Keeping This Registry Current

A change that adds, removes or changes an OSC handler, or the path that parses one, updates this
table in the same change.
