# Screen Capture to Prompt Dialog — Implementation Spec

> Status: Approved
> Date: 2026-04-16
> Milestone: Post-M2 — productivity layer

## Problem

Users want to capture a screenshot from any app and send it to the Claude prompt dialog without switching to Krypton first. Today they must use a separate tool, save to disk, switch to Krypton, open the dialog, and type `@path` manually.

## Solution

Two global OS-level shortcuts registered via `tauri-plugin-globalshortcut`:

- **`Ctrl+Shift+K`** — open/close the prompt dialog from anywhere; brings Krypton to front
- **`Ctrl+Shift+S`** — silent screen capture from anywhere; Krypton stays in background

`Ctrl+Shift+S` invokes `screencapture -x -i` (macOS native crosshair), which overlays on top of everything including Krypton. No window hide/show — Krypton state is never touched during capture. Captures made while the dialog is closed queue silently on `PromptDialog.captureQueue` and are drained automatically when the dialog next opens.

Inside Krypton, `Cmd+Shift+K` continues to work unchanged (existing in-app binding).

## Research

**Krypton internals:**
- `tauri-plugin-globalshortcut` (Tauri v2) — registers OS-level hotkeys via `app.handle().plugin(tauri_plugin_globalshortcut::Builder::new().build())`. Callbacks fire on a Rust thread; emit a Tauri event to the frontend to trigger JS.
- `imageThumbs: Map<string, string>` — `path → dataUrl`. Existing map; already used by paste/drop flow.
- `open()` clears `imageThumbs` — queue drain must happen *after* `imageThumbs.clear()`, inside `open()`.
- `base64 = "0.22"` and `tokio` (with `rt-multi-thread`) already in `Cargo.toml`. Use `tokio::task::spawn_blocking` for the blocking `screencapture` call — no new tokio features needed.
- `Cmd+Shift+K` toggle at `input-router.ts:437` — `Ctrl+Shift+K` global matches same toggle semantics.
- `Ctrl+Shift+K` and `Ctrl+Shift+S` — confirmed free. OS-level global shortcuts are consumed before xterm sees them; no `customKeyHandler` changes needed.

**macOS `screencapture`:**
- `screencapture -x -i -t png <path>` — system crosshair overlay appears above all windows. `-x` suppresses shutter sound. Exits when user confirms or presses Esc. No file written on cancel.
- Cancellation: file absent or zero-byte after return.
- Screen Recording TCC permission required in bundled app — add `NSScreenRecordingUsageDescription` to `tauri.conf.json` `bundle.macOS.info`.

## Prior Art

| App | Implementation |
|-----|----------------|
| Flameshot | Global hotkey → hides itself → crosshair → annotate → save. **We skip hide and annotate.** |
| Shottr / CleanShot X | Global hotkey → crosshair on top of everything → auto-copies/saves |
| macOS `Cmd+Shift+4` | Same `screencapture -i` under the hood |
| Warp / iTerm2 | No capture — paste from clipboard only |

**Krypton delta:** No window hide. No annotation. Capture goes directly to the staging queue — silent, non-disruptive. No terminal emulator does this.

## Affected Files

| File | Change |
|------|--------|
| `src-tauri/Cargo.toml` | Add `tauri-plugin-globalshortcut = "2"` |
| `src-tauri/src/lib.rs` | Register plugin; register `Ctrl+Shift+K` and `Ctrl+Shift+S` shortcuts; emit events |
| `src-tauri/src/commands.rs` | Add `capture_screen()` async command (no window param) |
| `src-tauri/tauri.conf.json` | Add `bundle.macOS.info.NSScreenRecordingUsageDescription`; add global shortcut capability |
| `src/prompt-dialog.ts` | Add `captureQueue`; drain in `open()`; add `captureAndStage()` and `stageDiskImage()` |
| `src/main.ts` | Listen for `capture-requested` and `prompt-dialog-requested` events |

## Design

### Data Structures

```typescript
// src/prompt-dialog.ts — new field
private captureQueue: Array<{ path: string; dataUrl: string }> = [];
// Accumulates captures made while the dialog is closed.
// Drained into imageThumbs when open() is called.
```

```rust
// src-tauri/src/commands.rs
#[derive(serde::Serialize)]
pub struct CaptureResult {
    pub path: String,   // "/tmp/krypton-prompt-images/<ts>.png"
    pub data: String,   // base64-encoded PNG
}
```

### API / Commands

```rust
#[tauri::command]
pub async fn capture_screen() -> Result<Option<CaptureResult>, String>
// Returns None if user cancels (no file written). No window parameter — Krypton state untouched.
```

Global shortcut events emitted from Rust → frontend:
- `"capture-requested"` — fired when `Ctrl+Shift+S` pressed
- `"prompt-dialog-requested"` — fired when `Ctrl+Shift+K` pressed

### Data Flow

**`Ctrl+Shift+S` (capture, any app):**
```
1. OS fires global shortcut → Rust callback → app.emit("capture-requested", ())
2. Frontend listener calls promptDialog.captureAndStage()
3. captureAndStage(): invoke<CaptureResult | null>('capture_screen')
4. Rust capture_screen():
   a. create_dir_all("/tmp/krypton-prompt-images")
   b. spawn_blocking: screencapture -x -i -t png <ts>.png   ← blocks until user done
   c. if file absent or empty → return Ok(None)
   d. fs::read → base64::encode → return Ok(Some(CaptureResult { path, data }))
5. Frontend receives result:
   a. if result === null → return  (user cancelled, Krypton untouched)
   b. const dataUrl = `data:image/png;base64,${result.data}`
   c. if dialog is open: stageDiskImage(path, dataUrl) → renderStaging(); autoGrow()
   d. if dialog is closed: captureQueue.push({ path, dataUrl })  ← silent, no focus
```

**`Ctrl+Shift+K` (open dialog, any app):**
```
1. OS fires global shortcut → Rust callback → app.emit("prompt-dialog-requested", ())
2. Frontend listener:
   a. if dialog is open: promptDialog.close() → return
   b. await getCurrentWindow().setFocus()   ← bring Krypton to front
   c. await promptDialog.open()
3. open() (modified):
   a. existing setup (clear textarea, imageThumbs, snapshot selection, show overlay...)
   b. drain captureQueue into imageThumbs (up to 4):
      for each item in captureQueue.splice(0, 4):
        imageThumbs.set(item.path, item.dataUrl)
      set textarea value to "@path1 @path2 ..." from drained items
      renderStaging()
   c. continue existing open() flow (refreshTargets, etc.)
```

### stageDiskImage() — new private method

```typescript
private stageDiskImage(path: string, dataUrl: string): void {
  if (this.imageThumbs.size >= 4) return;
  this.imageThumbs.set(path, dataUrl);
  this.insertAtCursor(`@${path} `);
}
```

Reuses existing `insertAtCursor` and `renderStaging` unchanged.

### Keybindings

| Key | Scope | Action |
|-----|-------|--------|
| `Ctrl+Shift+K` | Global (OS-level) | Toggle prompt dialog; brings Krypton to front |
| `Ctrl+Shift+S` | Global (OS-level) | Silent capture → stage or queue |
| `Cmd+Shift+K` | In-app only (unchanged) | Toggle prompt dialog (existing) |

### Configuration

```json
// tauri.conf.json
"bundle": {
  "macOS": {
    "info": {
      "NSScreenRecordingUsageDescription": "Krypton uses screen capture to attach screenshots to AI prompts."
    }
  }
}
```

## Edge Cases

- **Cancel capture (Esc):** `capture_screen` returns `null`. Krypton untouched, queue unchanged.
- **Capture while dialog open:** `stageDiskImage` fires immediately; thumbnail appears in strip.
- **Capture while dialog closed:** pushed to `captureQueue`; appears when dialog next opens via `Ctrl+Shift+K`.
- **Queue overflow (>4 captures before opening dialog):** only first 4 drained on open; excess discarded silently. Max 4 matches existing paste/drop limit.
- **`Ctrl+Shift+K` when dialog open:** dialog closes (toggle), matching `Cmd+Shift+K` behavior.
- **`Ctrl+Shift+K` with queued captures:** `open()` drains them — user sees screenshots immediately.
- **`screencapture` not found:** `spawn_blocking` returns `Err` → frontend logs, no-ops silently.
- **Dev mode:** Screen Recording TCC is held by the terminal running `cargo`, not Krypton. Works for development; release uses TCC with the plist description.
- **Double-trigger:** `Cmd+Shift+K` (in-app) and `Ctrl+Shift+K` (global) both call `open()` / `close()`. The `if (this.visible) return` guard in `open()` makes double-open safe.

## Out of Scope

- Annotation/markup before staging
- Specific-window capture (vs. user-selected region)
- Non-macOS platforms
- Clipboard-based capture
- Per-capture removal from queue (Ctrl+C clears all, consistent with agent view)

## Resources

- [tauri-plugin-globalshortcut](https://v2.tauri.app/plugin/global-shortcut/) — Tauri v2 global shortcut API
- macOS `screencapture` man page — `-x`, `-i`, `-t` flags
