//! Chrome Native Messaging host manifest installer (doc 176).
//!
//! For the browser extension to launch `krypton-bridge`, each browser needs a
//! host manifest in its per-user `NativeMessagingHosts` directory naming the
//! binary and the allowed extension ID. Krypton writes these on launch (gated by
//! `[acp_controller].install_native_host`) so the bridge is zero-config: install
//! Krypton + the extension and it works. macOS only in v1; a no-op elsewhere.

use std::path::{Path, PathBuf};

/// Native Messaging host name; must match the extension's `sendNativeMessage`.
pub const HOST_NAME: &str = "com.krypton.bridge";

/// Pinned extension ID, derived from the public `key` baked into the extension
/// manifest (`extension/manifest.json`). Changing the extension key requires
/// regenerating this. See doc 176.
pub const EXTENSION_ID: &str = "gcgnbbdlipnfmdbdakblfakbandhgdom";

/// Write the host manifest into each requested browser's manifest directory.
/// Best-effort: failures are logged, never fatal to app launch.
pub fn install_manifests(browsers: &[String]) {
    let bridge = resolve_bridge_path();
    let manifest = manifest_json(&bridge);
    for browser in browsers {
        let Some(dir) = manifest_dir(browser) else {
            log::warn!("native host: unknown browser {browser:?}, skipping");
            continue;
        };
        let path = dir.join(format!("{HOST_NAME}.json"));
        if let Err(e) = std::fs::create_dir_all(&dir) {
            log::warn!("native host: create {}: {e}", dir.display());
            continue;
        }
        match std::fs::write(&path, &manifest) {
            Ok(()) => log::info!("native host manifest written: {}", path.display()),
            Err(e) => log::warn!("native host: write {}: {e}", path.display()),
        }
    }
}

/// Remove the host manifest from each requested browser (uninstall path).
pub fn remove_manifests(browsers: &[String]) {
    for browser in browsers {
        let Some(dir) = manifest_dir(browser) else {
            continue;
        };
        let path = dir.join(format!("{HOST_NAME}.json"));
        if let Err(e) = std::fs::remove_file(&path) {
            if e.kind() != std::io::ErrorKind::NotFound {
                log::warn!("native host: remove {}: {e}", path.display());
            }
        }
    }
}

/// The manifest JSON, pretty-printed. Anchored on an absolute bridge path so
/// Chrome can launch it regardless of the user's `PATH`.
fn manifest_json(bridge: &Path) -> String {
    let value = serde_json::json!({
        "name": HOST_NAME,
        "description": "Krypton harness bridge",
        "path": bridge.to_string_lossy(),
        "type": "stdio",
        "allowed_origins": [format!("chrome-extension://{EXTENSION_ID}/")],
    });
    serde_json::to_string_pretty(&value).unwrap_or_else(|_| "{}".to_string())
}

/// Resolve the absolute path to the `krypton-bridge` binary: prefer the
/// `make install` location, then a sibling of the running executable (dev /
/// bundled), then a bare best-guess.
fn resolve_bridge_path() -> PathBuf {
    if let Some(home) = dirs::home_dir() {
        let installed = home.join(".local").join("bin").join("krypton-bridge");
        if installed.exists() {
            return installed;
        }
    }
    if let Ok(exe) = std::env::current_exe() {
        if let Some(dir) = exe.parent() {
            let sibling = dir.join("krypton-bridge");
            if sibling.exists() {
                return sibling;
            }
        }
    }
    dirs::home_dir()
        .map(|h| h.join(".local").join("bin").join("krypton-bridge"))
        .unwrap_or_else(|| PathBuf::from("krypton-bridge"))
}

/// Per-user `NativeMessagingHosts` directory for a supported browser (macOS).
#[cfg(target_os = "macos")]
fn manifest_dir(browser: &str) -> Option<PathBuf> {
    let base = dirs::home_dir()?
        .join("Library")
        .join("Application Support");
    let sub = match browser {
        "chrome" => "Google/Chrome",
        "chromium" => "Chromium",
        "edge" => "Microsoft Edge",
        "brave" => "BraveSoftware/Brave-Browser",
        // Opera (incl. GX) does NOT read native-messaging manifests from its own
        // `com.operasoftware.*` profile dir on macOS — it reads Google Chrome's
        // `NativeMessagingHosts` dir. Writing to the Opera profile dir yields a
        // "Specified native messaging host not found" error. See doc 176.
        "opera" | "opera-gx" => "Google/Chrome",
        _ => return None,
    };
    Some(base.join(sub).join("NativeMessagingHosts"))
}

#[cfg(not(target_os = "macos"))]
fn manifest_dir(_browser: &str) -> Option<PathBuf> {
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn manifest_has_pinned_origin_and_stdio() {
        let json = manifest_json(&PathBuf::from("/abs/krypton-bridge"));
        let value: serde_json::Value = serde_json::from_str(&json).unwrap();
        assert_eq!(value["name"], HOST_NAME);
        assert_eq!(value["type"], "stdio");
        assert_eq!(value["path"], "/abs/krypton-bridge");
        assert_eq!(
            value["allowed_origins"][0],
            format!("chrome-extension://{EXTENSION_ID}/")
        );
    }

    #[test]
    fn extension_id_is_32_lowercase_a_to_p() {
        assert_eq!(EXTENSION_ID.len(), 32);
        assert!(EXTENSION_ID.bytes().all(|b| (b'a'..=b'p').contains(&b)));
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn known_browsers_resolve_unknown_does_not() {
        assert!(manifest_dir("chrome").is_some());
        assert!(manifest_dir("brave").is_some());
        assert!(manifest_dir("opera-gx").is_some());
        assert!(manifest_dir("opera").is_some());
        assert!(manifest_dir("nope").is_none());
    }
}
