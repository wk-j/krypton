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
