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
| Sound Engine | The frontend module that synthesizes and plays procedural sound effects for user actions using the Web Audio API. No audio files — all sounds generated at runtime. |
| Sound Patch | A declarative data structure defining a synthesized sound: oscillators (waveform, frequency, amplitude), filters (type, cutoff, Q), ADSR envelope, and optional effects (reverb, delay, distortion). |
| Additive Synthesis | Sound synthesis technique that builds complex timbres by summing multiple simple oscillator waveforms (partials) at different frequencies and amplitudes. |
| Subtractive Synthesis | Sound synthesis technique that shapes a harmonically rich signal by removing frequency bands through filters (lowpass, highpass, bandpass, notch). |
| ADSR Envelope | Amplitude envelope with four phases: Attack (ramp to peak), Decay (fall to sustain), Sustain (hold level), Release (fade to silence). Controls how a sound's volume evolves over time. |
| Sound Pack | A named collection of sound patches (one per event) that defines the audio character of the application. The built-in pack is `krypton-cyber`. Custom packs are TOML files in `~/.config/krypton/sounds/`. |
| FM Synthesis | Frequency Modulation synthesis — one oscillator modulates another's frequency to produce metallic, bell-like, or complex harmonic timbres. |
| AudioContext | The Web Audio API's central object for creating and managing audio nodes. Krypton uses a single shared instance, lazily initialized on first user interaction. |
| Context Extension | A built-in system-level module that activates when a specific process (e.g., `java`) is detected running in a terminal pane. Renders widget bars (top/bottom) with process-specific information. |
| Extension Bar | A horizontal UI strip rendered at the top or bottom of a pane's content area by a context extension. Takes real layout space — the terminal resizes to accommodate it. |
| Foreground Process Group | The Unix process group that currently "owns" a terminal — the process receiving keyboard input. Detected via `tcgetpgrp()` on the PTY master fd. |
| Process Poller | A background Rust thread that polls all active PTY sessions every 500ms (configurable) to detect foreground process changes, emitting `process-changed` Tauri events. |
