# 1. Introduction

## 1.1 Purpose

This document defines the software requirements for **Krypton**, a modern terminal emulator built with Rust and Tauri. Krypton aims to deliver a fast, lightweight, and cross-platform terminal experience with a built-in **workspace system** — each workspace acts as a virtual desktop containing multiple terminal windows with fully custom chrome and animated layout transitions, similar to how macOS manages Spaces.

## 1.2 Scope

Krypton is a desktop terminal emulator targeting macOS, Linux, and Windows. It leverages:

- **Rust** for the backend (PTY management, shell integration, and core logic)
- **Tauri** as the application framework (fullscreen transparent native shell, IPC, system integration)
- **xterm.js** for terminal rendering (WebGL/Canvas-based) with TypeScript for the compositor UI

Krypton's defining feature is its **workspace system**: the application runs as a single fullscreen, borderless, transparent Tauri window that acts like a virtual desktop. Each **workspace** is a desktop — a named arrangement of terminal **windows** laid out on the screen. Each window has its own custom-drawn chrome (title bar, borders, shadow, controls) and contains tabs/panes with independent shell sessions. Users can define named workspaces (e.g., "coding", "monitoring", "debug") and switch between them with hotkeys. Transitions are animated with configurable effects (slide, crossfade, morph), giving the experience of switching between macOS desktops — but entirely within Krypton.

### Keyboard-First Design Principle

**Every feature in Krypton must be fully operable via keyboard.** The mouse is a secondary, optional input method. All actions — window focus, window creation/close, window resize, window move, workspace switching, tab management, command palette, and search — have dedicated keybindings. Users should never need to reach for the mouse to accomplish any task.

## 1.3 Definitions & Acronyms

| Term | Definition |
|------|------------|
| PTY | Pseudo-terminal — OS-level interface for terminal I/O |
| IPC | Inter-process communication between Tauri backend and frontend |
| VT | Virtual terminal — refers to VT100/VT220/xterm escape sequence standards |
| CSI | Control Sequence Introducer — ANSI escape sequence prefix |
| OSC | Operating System Command — escape sequence category |
| Shell | The command-line interpreter (e.g., bash, zsh, fish, PowerShell) |
| Workspace | A virtual desktop — the full-screen working area that contains and arranges multiple terminal windows. Analogous to a macOS Space/Desktop. |
| Window | A single terminal instance rendered inside a workspace — has its own chrome, xterm.js instance, tabs, and PTY sessions. Not a native OS window. |
| Layout | The spatial arrangement (grid cells or absolute positions) of windows within a workspace |
| Compositor | The Krypton rendering layer that manages workspaces, window placement, chrome drawing, z-order, and animations within a single Tauri native shell |
| Chrome | The decorative border, title bar, shadow, and control buttons rendered around each window |

---

# 2. Overall Description

## 2.1 Product Perspective

Krypton is a standalone desktop application. It is not a plugin or extension to another product. It communicates with the host operating system's PTY subsystem to spawn and manage shell sessions.

Krypton runs as a **single native Tauri window** that is always **fullscreen, borderless, and fully transparent** — acting as an invisible shell, much like macOS's desktop layer itself. The active **workspace** fills this transparent surface. Terminal **windows** float on the workspace with their own custom chrome and shadows. The OS desktop wallpaper and other applications are visible through the gaps between windows.

This approach enables:

- **Workspace-as-desktop** — each workspace is a full-screen virtual desktop containing arranged terminal windows
- **Pixel-perfect custom chrome** — window borders, shadows, and controls are fully themed and consistent across platforms
- **Animated workspace transitions** — windows smoothly animate between positions when switching workspaces
- **Unified compositing** — z-order, overlap, and focus are managed by Krypton's compositor, not the OS window manager
- **Full customization via themes** — every visual element (window chrome, colors, shadows, transparency, animations) is user-themeable

## 2.2 User Classes

| User Class | Description |
|------------|-------------|
| Software Developers | Primary users. Expect fast rendering, proper escape sequence support, and keyboard-driven workflows. |
| System Administrators | Require reliable SSH passthrough, Unicode support, and multi-session management. |
| Power Users | Want customization — themes, keybindings, splits, scripting. |

## 2.3 Design Constraints

- Must use **Tauri v2** as the application shell (no Electron).
- Core logic must be written in **Rust**.
- Frontend must render terminal output at 60 FPS with no perceptible input lag (<16ms keypress-to-render).
- Application binary size should stay under **15 MB** on all platforms.
- Memory usage for a single idle session should remain under **50 MB**.
- The Tauri native shell must be **always fullscreen, borderless (no native decorations), and fully transparent**.
- Terminal windows are DOM elements rendered on the workspace — not native OS windows.
- Window chrome (borders, title bar, controls) must be fully custom-rendered in the frontend.
- **Every visual element must be themeable** via user-defined custom themes.
- **Every feature must be fully keyboard-accessible.** No functionality shall require the mouse. Mouse interactions are optional enhancements only.

## 2.4 Assumptions

- Users have a shell installed on their system.
- The host OS supports PTY allocation (POSIX `openpty` / Windows ConPTY).
- Users have a GPU capable of basic hardware-accelerated compositing (via the OS webview).

---

# 9. Open Questions

| # | Question | Context | Status |
|---|----------|---------|--------|
| 1 | **xterm.js renderer fallback** | Use `@xterm/addon-webgl` by default with automatic fallback to canvas renderer if WebGL is unavailable in the webview. Validate during M1. | To validate |
| 2 | **Session persistence** | Should Krypton support saving/restoring sessions across application restarts? This would require serializing scrollback buffer and shell state. | Open |
| 3 | **Plugin system** | Is a plugin/extension API in scope for v1, or deferred to a later release? If included, what should the API surface look like? | Open |

---

# 10. Glossary

| Term | Definition |
|------|------------|
| Krypton | The terminal emulator application described in this specification |
| Workspace | A virtual desktop — the full-screen working area that contains and arranges multiple terminal windows. Analogous to a macOS Space/Desktop. Only one workspace is visible at a time. |
| Window | A single terminal instance rendered inside a workspace. Has its own chrome, xterm.js, tabs, and PTY sessions. Not a native OS window — it is a DOM element managed by the compositor. |
| Chrome | The decorative border, title bar, shadow, and control buttons rendered around each window |
| Compositor | The frontend rendering layer that manages workspaces, window placement, chrome, z-order, focus, animations, and input routing |
| Layout | The spatial arrangement of windows within a workspace — defined as a grid or absolute pixel positions |
| Grid | A tile-based positioning model where the workspace is divided into N columns x M rows |
| Cell | A single character position in the terminal grid (row, column) |
| Scrollback | The buffer of lines that have scrolled off the top of the visible viewport |
| Alternate Screen | A secondary screen buffer used by full-screen TUI applications |
| SGR | Select Graphic Rendition — ANSI escape codes that control text styling |
| PTY | Pseudo-terminal — OS-level abstraction that emulates a hardware terminal |
| ConPTY | Windows Pseudo Console API — Microsoft's PTY implementation |
| IPC | Inter-process communication — the bridge between Rust backend and webview frontend |
| VT100/VT220 | DEC video terminal standards that define escape sequence behavior |
| xterm.js | JavaScript terminal emulator library used for rendering in the frontend |
| Tauri | Rust-based framework for building desktop apps with web frontends |
| WebGL | Web Graphics Library — GPU-accelerated rendering API used by xterm.js addon |
| TOML | Tom's Obvious Minimal Language — configuration file format used by Krypton |
| OSC | Operating System Command — category of escape sequences for OS-level features |
| CSI | Control Sequence Introducer — prefix byte sequence for ANSI escape codes |
| IME | Input Method Editor — system component for composing CJK and other complex text |
| Session Pool | The set of all active PTY sessions managed by the Rust backend, shared across windows and workspaces |
| Window Slot | A position within a workspace layout that a window occupies |
| Gap | Pixel spacing between tiled windows in a grid layout |
| Padding | Inner margin of the workspace — space between the screen edge and the nearest window |
| Leader Key | A configurable key (default: `Ctrl+Space`) that activates compositor mode for window/workspace management |
| Compositor Mode | Input mode where keypresses control windows/workspaces instead of being sent to the PTY |
| Normal Mode | Default input mode where keypresses are forwarded to the focused window's shell |
| Resize Mode | Input mode where arrow keys resize the focused window |
| Move Mode | Input mode where arrow keys reposition the focused window |
| Command Palette | A keyboard-driven overlay that lists all available actions, filterable by typing |
| Input Router | The frontend module that dispatches keypresses based on the current mode |
| Quick Terminal | A persistent overlay terminal window that floats centered on screen above all workspace windows, toggled via `Cmd+I`. It has its own independent PTY session, does not participate in tiling layout, and is designed for quick command execution without disrupting the workspace arrangement. |
| Step Size | The number of pixels a window moves or resizes per keypress in move/resize mode |
| Theme | A TOML file defining all visual properties: terminal colors, window chrome, workspace background, UI elements |
| Custom Theme | A user-created `.toml` file placed in the themes directory to define a personalized visual style |
| Sound Engine | The Rust backend module that plays WAV-based sound effects via the `rodio` crate on a dedicated audio thread. The frontend is a thin IPC wrapper. |
| Sound Pack | A directory of 17 WAV files defining the audio character of the application. Built-in packs: `deep-glyph`, `mach-line`, `holo-dash`. |
| Context Extension | A built-in system-level module that activates when a specific process (e.g., `java`) is detected running in a terminal pane. Renders widget bars (top/bottom) with process-specific information. |
| Extension Bar | A horizontal UI strip rendered at the top or bottom of a pane's content area by a context extension. Takes real layout space — the terminal resizes to accommodate it. |
| Foreground Process Group | The Unix process group that currently "owns" a terminal — the process receiving keyboard input. Detected via `tcgetpgrp()` on the PTY master fd. |
| Process Poller | A background Rust thread that polls all active PTY sessions every 500ms (configurable) to detect foreground process changes, emitting `process-changed` Tauri events. |
