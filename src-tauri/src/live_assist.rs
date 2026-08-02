use std::sync::Mutex;

use tauri::{
    AppHandle, Emitter, Manager, Monitor, PhysicalPosition, PhysicalSize, WebviewUrl,
    WebviewWindow, WebviewWindowBuilder,
};

use crate::control::ControlStreamEvent;

pub const WINDOW_LABEL: &str = "live-assist";
const DEFAULT_WIDTH: f64 = 840.0;
const DEFAULT_HEIGHT: f64 = 620.0;
const MIN_WIDTH: f64 = 560.0;
const MIN_HEIGHT: f64 = 420.0;
const MARGIN: f64 = 16.0;

const ALLOWED_OPERATIONS: &[&str] = &[
    "live_assist.bootstrap",
    "lane.status",
    "lane.transcript",
    "lane.send",
    "lane.cancel",
    "permission.list",
    "permission.resolve",
];

#[derive(Clone, Copy, Debug)]
struct SavedFrame {
    position: PhysicalPosition<i32>,
    size: PhysicalSize<u32>,
}

#[derive(Default)]
pub struct LiveAssistState {
    saved_frame: Mutex<Option<SavedFrame>>,
    previous_frontmost_pid: Mutex<Option<i32>>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
struct Frame {
    position: PhysicalPosition<i32>,
    size: PhysicalSize<u32>,
}

pub fn operation_allowed(operation: &str) -> bool {
    ALLOWED_OPERATIONS.contains(&operation)
}

pub fn forward_stream_event(app: &AppHandle, event: &ControlStreamEvent) {
    let Some(window) = app.get_webview_window(WINDOW_LABEL) else {
        return;
    };
    if !window.is_visible().unwrap_or(false) {
        return;
    }
    if let Err(error) = app.emit_to(WINDOW_LABEL, "live-assist-stream", event) {
        log::warn!("Live Assist stream forward failed: {error}");
    }
}

pub async fn toggle(app: AppHandle) -> Result<(), String> {
    run_on_main_thread(app, |app| toggle_on_main(&app)).await
}

pub async fn hide(app: AppHandle) -> Result<(), String> {
    run_on_main_thread(app, |app| hide_on_main(&app)).await
}

async fn run_on_main_thread<F>(app: AppHandle, action: F) -> Result<(), String>
where
    F: FnOnce(AppHandle) -> Result<(), String> + Send + 'static,
{
    let (tx, rx) = tokio::sync::oneshot::channel();
    let scheduled_app = app.clone();
    app.run_on_main_thread(move || {
        let _ = tx.send(action(scheduled_app));
    })
    .map_err(|error| format!("schedule Live Assist window action: {error}"))?;
    rx.await
        .map_err(|_| "Live Assist window action was dropped".to_string())?
}

pub fn toggle_on_main(app: &AppHandle) -> Result<(), String> {
    let visible = app
        .get_webview_window(WINDOW_LABEL)
        .and_then(|window| window.is_visible().ok())
        .unwrap_or(false);
    if visible {
        hide_on_main(app)
    } else {
        show_on_main(app)
    }
}

pub fn hide_on_main(app: &AppHandle) -> Result<(), String> {
    let Some(window) = app.get_webview_window(WINDOW_LABEL) else {
        return Ok(());
    };
    let release_app_focus = window.is_focused().unwrap_or(false);
    let state = app.state::<LiveAssistState>();
    if let (Ok(position), Ok(size)) = (window.outer_position(), window.outer_size()) {
        let mut saved = state
            .saved_frame
            .lock()
            .map_err(|_| "Live Assist state lock poisoned".to_string())?;
        *saved = Some(SavedFrame { position, size });
    }
    let previous_pid = state
        .previous_frontmost_pid
        .lock()
        .map_err(|_| "Live Assist state lock poisoned".to_string())?
        .take();
    window
        .hide()
        .map_err(|error| format!("hide Live Assist window: {error}"))?;
    if release_app_focus {
        release_macos_app_focus(previous_pid)?;
    }
    Ok(())
}

#[cfg(target_os = "macos")]
fn release_macos_app_focus(previous_pid: Option<i32>) -> Result<(), String> {
    use objc2::MainThreadMarker;
    use objc2_app_kit::{NSApplication, NSApplicationActivationOptions, NSRunningApplication};

    let marker = MainThreadMarker::new()
        .ok_or_else(|| "release Live Assist focus outside the main thread".to_string())?;
    if let Some(pid) = previous_pid {
        if pid == std::process::id() as i32 {
            // Krypton itself was frontmost before Live Assist opened; staying
            // active hands key focus back to the main window.
            return Ok(());
        }
        // Re-activate the previous app while Krypton is still the active app:
        // under macOS 14 cooperative activation the system only honors the
        // request from the yielding (active) app, and deactivate() alone does
        // not restore the previous app while our main window stays visible.
        if let Some(previous) = NSRunningApplication::runningApplicationWithProcessIdentifier(pid) {
            if !previous.isTerminated() {
                // No effect on macOS 14+, still needed on earlier releases.
                #[allow(deprecated)]
                let options = NSApplicationActivationOptions::ActivateIgnoringOtherApps;
                if previous.activateWithOptions(options) {
                    return Ok(());
                }
            }
        }
    }
    NSApplication::sharedApplication(marker).deactivate();
    Ok(())
}

#[cfg(not(target_os = "macos"))]
fn release_macos_app_focus(_previous_pid: Option<i32>) -> Result<(), String> {
    Ok(())
}

#[cfg(target_os = "macos")]
fn frontmost_application_pid() -> Option<i32> {
    use objc2_app_kit::NSWorkspace;

    let frontmost = NSWorkspace::sharedWorkspace().frontmostApplication()?;
    let pid = frontmost.processIdentifier();
    // Applications without a pid report -1.
    (pid >= 0).then_some(pid)
}

#[cfg(target_os = "macos")]
fn show_on_main(app: &AppHandle) -> Result<(), String> {
    let monitor = target_monitor(app)?;
    let window = match app.get_webview_window(WINDOW_LABEL) {
        Some(window) => window,
        None => create_window(app)?,
    };
    let state = app.state::<LiveAssistState>();
    let saved = state
        .saved_frame
        .lock()
        .map_err(|_| "Live Assist state lock poisoned".to_string())?
        .to_owned();
    // Capture before set_focus() activates Krypton, so hide can hand focus
    // back to whichever app the user was in.
    *state
        .previous_frontmost_pid
        .lock()
        .map_err(|_| "Live Assist state lock poisoned".to_string())? = frontmost_application_pid();
    let frame = frame_for_monitor(&monitor, saved);
    let result = (|| {
        window
            .set_size(frame.size)
            .map_err(|error| format!("size Live Assist window: {error}"))?;
        window
            .set_position(frame.position)
            .map_err(|error| format!("position Live Assist window: {error}"))?;
        window
            .set_visible_on_all_workspaces(true)
            .map_err(|error| format!("set Live Assist workspace behavior: {error}"))?;
        window
            .set_always_on_top(true)
            .map_err(|error| format!("raise Live Assist window: {error}"))?;
        apply_macos_window_behavior(&window)?;
        window
            .show()
            .map_err(|error| format!("show Live Assist window: {error}"))?;
        let _ = window.unminimize();
        window
            .set_focus()
            .map_err(|error| format!("focus Live Assist window: {error}"))
    })();
    if let Err(error) = result {
        let _ = window.hide();
        return Err(error);
    }
    if let Err(error) = app.emit_to(WINDOW_LABEL, "live-assist-shown", ()) {
        log::warn!("Live Assist shown event failed: {error}");
    }
    Ok(())
}

#[cfg(not(target_os = "macos"))]
fn show_on_main(_app: &AppHandle) -> Result<(), String> {
    Err("Live Assist is available on macOS".to_string())
}

fn create_window(app: &AppHandle) -> Result<WebviewWindow, String> {
    WebviewWindowBuilder::new(
        app,
        WINDOW_LABEL,
        WebviewUrl::App("live-assist.html".into()),
    )
    .title("Krypton Live Assist")
    .inner_size(DEFAULT_WIDTH, DEFAULT_HEIGHT)
    .min_inner_size(MIN_WIDTH, MIN_HEIGHT)
    .decorations(false)
    .transparent(true)
    .shadow(true)
    .resizable(true)
    .skip_taskbar(true)
    .visible_on_all_workspaces(true)
    .always_on_top(true)
    .focused(false)
    .visible(false)
    .build()
    .map_err(|error| format!("create Live Assist window: {error}"))
}

fn target_monitor(app: &AppHandle) -> Result<Monitor, String> {
    let main = app
        .get_webview_window("main")
        .ok_or_else(|| "main Krypton window is unavailable".to_string())?;
    let monitors = main
        .available_monitors()
        .map_err(|error| format!("list monitors for Live Assist: {error}"))?;
    if let Ok(cursor) = main.cursor_position() {
        if let Some(monitor) = monitors.iter().find(|monitor| {
            let position = monitor.position();
            let size = monitor.size();
            cursor.x >= f64::from(position.x)
                && cursor.x < f64::from(position.x) + f64::from(size.width)
                && cursor.y >= f64::from(position.y)
                && cursor.y < f64::from(position.y) + f64::from(size.height)
        }) {
            return Ok(monitor.clone());
        }
    }
    main.current_monitor()
        .ok()
        .flatten()
        .or_else(|| main.primary_monitor().ok().flatten())
        .or_else(|| monitors.into_iter().next())
        .ok_or_else(|| "no monitor is available for Live Assist".to_string())
}

fn frame_for_monitor(monitor: &Monitor, saved: Option<SavedFrame>) -> Frame {
    let work = monitor.work_area();
    let scale = monitor.scale_factor();
    let margin = (MARGIN * scale).round() as i32;
    let maximum = PhysicalSize::new(
        work.size.width.saturating_sub((margin.max(0) as u32) * 2),
        work.size.height.saturating_sub((margin.max(0) as u32) * 2),
    );
    if let Some(saved) = saved {
        let size = PhysicalSize::new(
            saved.size.width.min(maximum.width),
            saved.size.height.min(maximum.height),
        );
        if intersects(saved.position, size, work.position, work.size) {
            return Frame {
                position: clamp_position(saved.position, size, work.position, work.size, margin),
                size,
            };
        }
    }
    let size = PhysicalSize::new(
        ((DEFAULT_WIDTH * scale).round() as u32).min(maximum.width),
        ((DEFAULT_HEIGHT * scale).round() as u32).min(maximum.height),
    );
    Frame {
        position: PhysicalPosition::new(
            work.position.x + (work.size.width.saturating_sub(size.width) / 2) as i32,
            work.position.y + (work.size.height.saturating_sub(size.height) / 2) as i32,
        ),
        size,
    }
}

fn intersects(
    position: PhysicalPosition<i32>,
    size: PhysicalSize<u32>,
    work_position: PhysicalPosition<i32>,
    work_size: PhysicalSize<u32>,
) -> bool {
    let right = i64::from(position.x) + i64::from(size.width);
    let bottom = i64::from(position.y) + i64::from(size.height);
    let work_right = i64::from(work_position.x) + i64::from(work_size.width);
    let work_bottom = i64::from(work_position.y) + i64::from(work_size.height);
    i64::from(position.x) < work_right
        && i64::from(work_position.x) < right
        && i64::from(position.y) < work_bottom
        && i64::from(work_position.y) < bottom
}

fn clamp_position(
    position: PhysicalPosition<i32>,
    size: PhysicalSize<u32>,
    work_position: PhysicalPosition<i32>,
    work_size: PhysicalSize<u32>,
    margin: i32,
) -> PhysicalPosition<i32> {
    let min_x = work_position.x + margin;
    let min_y = work_position.y + margin;
    let max_x = work_position.x + work_size.width as i32 - size.width as i32 - margin;
    let max_y = work_position.y + work_size.height as i32 - size.height as i32 - margin;
    PhysicalPosition::new(
        position.x.clamp(min_x, max_x.max(min_x)),
        position.y.clamp(min_y, max_y.max(min_y)),
    )
}

#[cfg(target_os = "macos")]
fn apply_macos_window_behavior(window: &WebviewWindow) -> Result<(), String> {
    use objc2_app_kit::{NSPopUpMenuWindowLevel, NSWindow, NSWindowCollectionBehavior};

    let pointer = window
        .ns_window()
        .map_err(|error| format!("get Live Assist NSWindow: {error}"))?;
    if pointer.is_null() {
        return Err("Live Assist NSWindow pointer is null".to_string());
    }
    // Tauri owns the NSWindow for the lifetime of `window`; this is a borrowed
    // main-thread reference used only for synchronous AppKit configuration.
    let native = unsafe { &*pointer.cast::<NSWindow>() };
    let behavior = native.collectionBehavior();
    native.setCollectionBehavior(
        behavior
            | NSWindowCollectionBehavior::CanJoinAllSpaces
            | NSWindowCollectionBehavior::FullScreenAuxiliary,
    );
    native.setLevel(NSPopUpMenuWindowLevel);
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn frame(
        work_position: PhysicalPosition<i32>,
        work_size: PhysicalSize<u32>,
        scale: f64,
        saved: Option<SavedFrame>,
    ) -> Frame {
        let margin = (MARGIN * scale).round() as i32;
        let maximum = PhysicalSize::new(
            work_size.width.saturating_sub((margin as u32) * 2),
            work_size.height.saturating_sub((margin as u32) * 2),
        );
        if let Some(saved) = saved {
            let size = PhysicalSize::new(
                saved.size.width.min(maximum.width),
                saved.size.height.min(maximum.height),
            );
            if intersects(saved.position, size, work_position, work_size) {
                return Frame {
                    position: clamp_position(
                        saved.position,
                        size,
                        work_position,
                        work_size,
                        margin,
                    ),
                    size,
                };
            }
        }
        let size = PhysicalSize::new(
            ((DEFAULT_WIDTH * scale).round() as u32).min(maximum.width),
            ((DEFAULT_HEIGHT * scale).round() as u32).min(maximum.height),
        );
        Frame {
            position: PhysicalPosition::new(
                work_position.x + (work_size.width - size.width) as i32 / 2,
                work_position.y + (work_size.height - size.height) as i32 / 2,
            ),
            size,
        }
    }

    #[test]
    fn centers_default_frame_with_negative_monitor_coordinates() {
        let result = frame(
            PhysicalPosition::new(-1920, 0),
            PhysicalSize::new(1920, 1080),
            1.0,
            None,
        );
        assert_eq!(result.size, PhysicalSize::new(840, 620));
        assert_eq!(result.position, PhysicalPosition::new(-1380, 230));
    }

    #[test]
    fn caps_frame_to_small_retina_work_area() {
        let result = frame(
            PhysicalPosition::new(0, 0),
            PhysicalSize::new(1100, 800),
            2.0,
            None,
        );
        assert_eq!(result.size, PhysicalSize::new(1036, 736));
        assert_eq!(result.position, PhysicalPosition::new(32, 32));
    }

    #[test]
    fn restores_and_clamps_saved_frame_on_same_monitor() {
        let result = frame(
            PhysicalPosition::new(0, 0),
            PhysicalSize::new(1440, 900),
            1.0,
            Some(SavedFrame {
                position: PhysicalPosition::new(1300, 820),
                size: PhysicalSize::new(800, 600),
            }),
        );
        assert_eq!(result.position, PhysicalPosition::new(624, 284));
        assert_eq!(result.size, PhysicalSize::new(800, 600));
    }

    #[test]
    fn rejects_operations_outside_minimal_assistant_surface() {
        assert!(operation_allowed("lane.send"));
        assert!(operation_allowed("permission.resolve"));
        assert!(!operation_allowed("lane.close"));
        assert!(!operation_allowed("harness.create"));
    }
}
