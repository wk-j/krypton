// Krypton — Configuration
// TOML config parser with serde. Loads from ~/.config/krypton/krypton.toml,
// falls back to built-in defaults for any missing fields.

use serde::{Deserialize, Serialize};
use std::fs;
use std::path::PathBuf;

/// Top-level configuration.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(default)]
pub struct KryptonConfig {
    pub shell: ShellConfig,
    pub font: FontConfig,
    pub terminal: TerminalConfig,
    pub theme: ThemeConfig,
    pub quick_terminal: QuickTerminalConfig,
    pub workspaces: WorkspacesConfig,
    pub sound: SoundConfig,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(default)]
pub struct ShellConfig {
    pub program: String,
    pub args: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(default)]
pub struct FontConfig {
    pub family: String,
    pub size: f64,
    pub line_height: f64,
    pub ligatures: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(default)]
pub struct TerminalConfig {
    pub scrollback_lines: u32,
    pub cursor_style: String,
    pub cursor_blink: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(default)]
pub struct ThemeConfig {
    pub name: String,
    pub colors: ThemeColors,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(default)]
pub struct ThemeColors {
    pub foreground: Option<String>,
    pub background: Option<String>,
    pub cursor: Option<String>,
    pub selection: Option<String>,
    pub black: Option<String>,
    pub red: Option<String>,
    pub green: Option<String>,
    pub yellow: Option<String>,
    pub blue: Option<String>,
    pub magenta: Option<String>,
    pub cyan: Option<String>,
    pub white: Option<String>,
    pub bright_black: Option<String>,
    pub bright_red: Option<String>,
    pub bright_green: Option<String>,
    pub bright_yellow: Option<String>,
    pub bright_blue: Option<String>,
    pub bright_magenta: Option<String>,
    pub bright_cyan: Option<String>,
    pub bright_white: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(default)]
pub struct QuickTerminalConfig {
    pub width_ratio: f64,
    pub height_ratio: f64,
    pub backdrop_blur: u32,
    pub animation: String,
    pub shell: String,
    pub cwd: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(default)]
pub struct WorkspacesConfig {
    pub startup: String,
    pub gap: u32,
    pub padding: u32,
    pub resize_step: u32,
    pub move_step: u32,
    pub resize_step_large: u32,
    pub move_step_large: u32,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(default)]
pub struct SoundConfig {
    pub enabled: bool,
    pub volume: f64,
    pub pack: String,
    /// Keyboard type for keypress sounds.
    /// Options: "cherry-mx-blue", "cherry-mx-red", "cherry-mx-brown",
    /// "topre", "buckling-spring", "membrane", "none"
    pub keyboard_type: String,
    /// Volume multiplier for keypress sounds (0.0–1.0)
    pub keyboard_volume: f64,
    /// Per-event overrides. Values can be:
    /// - boolean (true = use master volume, false = disabled)
    /// - float (0.0–1.0 = custom volume for this event)
    ///
    /// Represented as `serde_json::Value` to support both bool and float.
    pub events: std::collections::HashMap<String, serde_json::Value>,
}

impl Default for SoundConfig {
    fn default() -> Self {
        Self {
            enabled: true,
            volume: 0.5,
            pack: "krypton-cyber".to_string(),
            keyboard_type: "cherry-mx-brown".to_string(),
            keyboard_volume: 1.0,
            events: std::collections::HashMap::new(),
        }
    }
}

// ─── Defaults ──────────────────────────────────────────────────────

impl Default for ShellConfig {
    fn default() -> Self {
        let program = std::env::var("SHELL").unwrap_or_else(|_| "/bin/sh".to_string());
        Self {
            program,
            args: vec!["--login".to_string()],
        }
    }
}

impl Default for FontConfig {
    fn default() -> Self {
        Self {
            family: "Mononoki Nerd Font Mono".to_string(),
            size: 14.0,
            line_height: 1.2,
            ligatures: true,
        }
    }
}

impl Default for TerminalConfig {
    fn default() -> Self {
        Self {
            scrollback_lines: 10000,
            cursor_style: "block".to_string(),
            cursor_blink: true,
        }
    }
}

impl Default for ThemeConfig {
    fn default() -> Self {
        Self {
            name: "krypton-dark".to_string(),
            colors: ThemeColors::default(),
        }
    }
}

impl Default for QuickTerminalConfig {
    fn default() -> Self {
        Self {
            width_ratio: 0.6,
            height_ratio: 0.5,
            backdrop_blur: 20,
            animation: "slide".to_string(),
            shell: String::new(),
            cwd: String::new(),
        }
    }
}

impl Default for WorkspacesConfig {
    fn default() -> Self {
        Self {
            startup: "single".to_string(),
            gap: 6,
            padding: 0,
            resize_step: 20,
            move_step: 20,
            resize_step_large: 100,
            move_step_large: 100,
        }
    }
}

// ─── Config Path ───────────────────────────────────────────────────

/// Get the config directory path: ~/.config/krypton/
/// We always use ~/.config/krypton/ regardless of platform (matching the spec),
/// rather than the platform-specific dirs::config_dir() which on macOS returns
/// ~/Library/Application Support.
pub fn config_dir() -> Option<PathBuf> {
    dirs::home_dir().map(|d| d.join(".config").join("krypton"))
}

/// Get the config file path: ~/.config/krypton/krypton.toml
pub fn config_path() -> Option<PathBuf> {
    config_dir().map(|d| d.join("krypton.toml"))
}

// ─── Load / Save ───────────────────────────────────────────────────

/// Load config from disk, merging with defaults for any missing fields.
/// If the file doesn't exist, returns defaults and creates it.
pub fn load_config() -> KryptonConfig {
    let path = match config_path() {
        Some(p) => p,
        None => {
            log::warn!("Could not determine config directory; using defaults");
            return KryptonConfig::default();
        }
    };

    if !path.exists() {
        log::info!(
            "Config file not found at {}, creating with defaults",
            path.display()
        );
        let config = KryptonConfig::default();
        write_default_config(&path, &config);
        return config;
    }

    match fs::read_to_string(&path) {
        Ok(contents) => match toml::from_str::<KryptonConfig>(&contents) {
            Ok(config) => {
                log::info!("Loaded config from {}", path.display());
                config
            }
            Err(e) => {
                log::error!("Failed to parse config at {}: {e}", path.display());
                log::warn!("Using default configuration");
                KryptonConfig::default()
            }
        },
        Err(e) => {
            log::error!("Failed to read config at {}: {e}", path.display());
            KryptonConfig::default()
        }
    }
}

/// Write the default config to disk.
fn write_default_config(path: &PathBuf, config: &KryptonConfig) {
    // Ensure the parent directory exists
    if let Some(parent) = path.parent() {
        if let Err(e) = fs::create_dir_all(parent) {
            log::error!(
                "Failed to create config directory {}: {e}",
                parent.display()
            );
            return;
        }
    }

    match toml::to_string_pretty(config) {
        Ok(toml_str) => {
            // Prepend a header comment
            let content = format!(
                "# Krypton configuration\n\
                 # See docs/06-configuration.md for full reference\n\n\
                 {toml_str}"
            );
            if let Err(e) = fs::write(path, content) {
                log::error!("Failed to write default config to {}: {e}", path.display());
            } else {
                log::info!("Wrote default config to {}", path.display());
            }
        }
        Err(e) => {
            log::error!("Failed to serialize default config: {e}");
        }
    }
}
