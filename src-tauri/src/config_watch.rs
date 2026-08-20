// Watch ~/.config/krypton/krypton.toml and ~/.config/krypton/themes/*.toml
// and hot-reload config + theme (300ms debounce). Does NOT recurse into
// sessions/, runtime/, or acp-harness-memory/.

use crate::config::KryptonConfig;
use crate::theme::ThemeEngine;
use crate::util::emit::EmitExt;
use crate::util::lock::lock_write;
use notify::{Event, RecommendedWatcher, RecursiveMode, Watcher};
use std::path::{Path, PathBuf};
use std::sync::{mpsc, Arc, RwLock};
use std::time::Duration;
use tauri::{AppHandle, Manager};

const DEBOUNCE: Duration = Duration::from_millis(300);

pub fn start(app: AppHandle, config: Arc<RwLock<KryptonConfig>>, theme_engine: Arc<ThemeEngine>) {
    if let Err(e) = std::thread::Builder::new()
        .name("krypton-config-watch".into())
        .spawn(move || watch_loop(app, config, theme_engine))
    {
        log::error!("Failed to start config watcher: {e}");
    }
}

/// Re-read krypton.toml, apply sound, emit `theme-changed` + `config-changed`.
pub fn reload_from_disk(
    app: &AppHandle,
    config: &Arc<RwLock<KryptonConfig>>,
    theme_engine: &ThemeEngine,
) -> Result<(), String> {
    let new_config = crate::config::load_config_result()?;

    let sound_state = app.state::<crate::sound::SoundEngineState>();
    if let Ok(mut engine) = sound_state.lock() {
        engine.apply_config(new_config.sound.clone());
    }

    let theme_result = theme_engine.resolve_for_config(&new_config);
    {
        let mut cfg = lock_write(config, "Config")?;
        *cfg = new_config.clone();
    }

    match theme_result {
        Ok(theme) => app.emit_or_log("theme-changed", theme),
        Err(e) => log::error!("Theme resolve after config reload failed: {e}"),
    }
    app.emit_or_log("config-changed", new_config);
    log::info!("Config reloaded from disk");
    Ok(())
}

fn watch_loop(app: AppHandle, config: Arc<RwLock<KryptonConfig>>, theme_engine: Arc<ThemeEngine>) {
    let (tx, rx) = mpsc::channel::<notify::Result<Event>>();
    let mut watcher = match RecommendedWatcher::new(
        tx,
        notify::Config::default().with_poll_interval(Duration::from_secs(2)),
    ) {
        Ok(w) => w,
        Err(e) => {
            log::error!("Config watcher init failed: {e}");
            return;
        }
    };

    let mut watching: Vec<PathBuf> = Vec::new();
    if let Some(dir) = crate::config::config_dir() {
        if watch_path(&mut watcher, &dir, RecursiveMode::NonRecursive) {
            watching.push(dir);
        }
    }
    if let Some(themes) = crate::theme::custom_themes_dir() {
        if themes.is_dir() && watch_path(&mut watcher, &themes, RecursiveMode::NonRecursive) {
            watching.push(themes);
        }
    }
    if watching.is_empty() {
        log::warn!("Config watcher: nothing to watch");
        return;
    }
    log::info!(
        "Config watcher watching {}",
        watching
            .iter()
            .map(|p| p.display().to_string())
            .collect::<Vec<_>>()
            .join(", ")
    );

    while let Ok(first) = rx.recv() {
        let mut relevant = event_is_relevant(&first);
        loop {
            match rx.recv_timeout(DEBOUNCE) {
                Ok(ev) => {
                    if event_is_relevant(&ev) {
                        relevant = true;
                    }
                }
                Err(mpsc::RecvTimeoutError::Timeout) => break,
                Err(mpsc::RecvTimeoutError::Disconnected) => return,
            }
        }
        if !relevant {
            continue;
        }
        if let Err(e) = reload_from_disk(&app, &config, &theme_engine) {
            log::error!("Config hot-reload failed: {e}");
        }
    }
}

fn watch_path(watcher: &mut RecommendedWatcher, path: &Path, mode: RecursiveMode) -> bool {
    match watcher.watch(path, mode) {
        Ok(()) => true,
        Err(e) => {
            log::warn!("Failed to watch {}: {e}", path.display());
            false
        }
    }
}

fn event_is_relevant(event: &notify::Result<Event>) -> bool {
    let Ok(event) = event else { return false };
    event.paths.iter().any(|p| is_watched_toml(p))
}

fn is_watched_toml(path: &Path) -> bool {
    let Some(name) = path.file_name().and_then(|n| n.to_str()) else {
        return false;
    };
    if name.starts_with('.') || !name.ends_with(".toml") {
        return false;
    }
    if name == "krypton.toml" {
        return true;
    }
    path.parent()
        .and_then(|p| p.file_name())
        .and_then(|n| n.to_str())
        == Some("themes")
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    #[test]
    fn watches_krypton_toml_and_theme_files() {
        assert!(is_watched_toml(&PathBuf::from(
            "/Users/x/.config/krypton/krypton.toml"
        )));
        assert!(is_watched_toml(&PathBuf::from(
            "/Users/x/.config/krypton/themes/nord.toml"
        )));
        assert!(!is_watched_toml(&PathBuf::from(
            "/Users/x/.config/krypton/acp-harness.toml"
        )));
        assert!(!is_watched_toml(&PathBuf::from(
            "/Users/x/.config/krypton/runtime/foo.toml"
        )));
        assert!(!is_watched_toml(&PathBuf::from(
            "/Users/x/.config/krypton/.krypton.toml"
        )));
    }
}
