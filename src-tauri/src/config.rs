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
    pub hints: HintsConfig,
    pub tabs: TabsConfig,
    pub shader: ShaderConfig,
    pub visual: VisualConfig,
    pub extensions: ExtensionsConfig,
    pub ssh: SshConfig,
    pub hooks: HooksConfig,
    pub music: MusicConfig,
    pub agent: AgentConfig,
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
    pub default_layout: String,
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
            pack: "deep-glyph".to_string(),
            keyboard_type: "cherry-mx-brown".to_string(),
            keyboard_volume: 1.0,
            events: std::collections::HashMap::new(),
        }
    }
}

// ─── Hints ─────────────────────────────────────────────────────────

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(default)]
pub struct HintsConfig {
    pub alphabet: String,
    pub rules: Vec<HintRule>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct HintRule {
    pub name: String,
    pub regex: String,
    pub action: HintAction,
    #[serde(default = "default_true")]
    pub enabled: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub enum HintAction {
    Copy,
    Open,
    Paste,
}

fn default_true() -> bool {
    true
}

impl Default for HintsConfig {
    fn default() -> Self {
        Self {
            alphabet: "asdfghjklqweruiop".to_string(),
            rules: vec![
                HintRule {
                    name: "url".to_string(),
                    regex: r#"https?://[^\s<>"\x60{}()\[\]]+(?:\([^\s<>"\x60{}()\[\]]*\))*[^\s<>"\x60{}()\[\]]*"#.to_string(),
                    action: HintAction::Open,
                    enabled: true,
                },
                HintRule {
                    name: "filepath".to_string(),
                    regex: r"~?/?(?:[\w@.\-]+/)+[\w@.\-]+".to_string(),
                    action: HintAction::Copy,
                    enabled: true,
                },
                HintRule {
                    name: "email".to_string(),
                    regex: r"[\w.+\-]+@[\w.\-]+\.[a-zA-Z]{2,}".to_string(),
                    action: HintAction::Copy,
                    enabled: true,
                },
            ],
        }
    }
}

// ─── Shader ─────────────────────────────────────────────────────────

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(default)]
pub struct ShaderConfig {
    pub enabled: bool,
    pub preset: String,
    pub intensity: f64,
    pub animate: bool,
    pub fps_cap: u32,
}

impl Default for ShaderConfig {
    fn default() -> Self {
        Self {
            enabled: false,
            preset: "none".to_string(),
            intensity: 0.5,
            animate: true,
            fps_cap: 30,
        }
    }
}

// ─── Tabs ──────────────────────────────────────────────────────────

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(default)]
pub struct TabsConfig {
    /// Show the tab bar even when there is only one tab
    pub always_show_tabbar: bool,
    /// Default direction for pane splits ("vertical" or "horizontal")
    pub default_split: String,
    /// Close window when the last tab is closed
    pub close_window_on_last_tab: bool,
}

impl Default for TabsConfig {
    fn default() -> Self {
        Self {
            always_show_tabbar: false,
            default_split: "vertical".to_string(),
            close_window_on_last_tab: true,
        }
    }
}

// ─── Visual ────────────────────────────────────────────────────────

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(default)]
pub struct VisualConfig {
    /// 3D perspective depth in pixels. Higher = subtler effect. 0 = disabled.
    pub perspective_depth: u16,
    /// X-axis tilt angle in degrees (top/bottom). 0 = no tilt.
    #[serde(alias = "perspective_tilt")]
    pub perspective_tilt_x: f64,
    /// Y-axis tilt angle in degrees (left/right). 0 = no tilt.
    pub perspective_tilt_y: f64,
    /// Window backdrop opacity (0.0 = fully transparent, 1.0 = fully opaque).
    /// Controls the alpha channel of terminal window backgrounds.
    pub opacity: f64,
    /// Window backdrop blur radius in pixels. 0 = no blur.
    /// Controls the CSS backdrop-filter blur on terminal windows.
    pub blur: u32,
    /// Top-line glow brightness boost. 0.0 = off, 0.8 = default, higher = stronger.
    /// Controls the brightness() filter on the glow overlay (added to 1.0).
    pub glow_intensity: f64,
}

impl Default for VisualConfig {
    fn default() -> Self {
        Self {
            perspective_depth: 800,
            perspective_tilt_x: 2.0,
            perspective_tilt_y: 0.0,
            opacity: 0.5,
            blur: 12,
            glow_intensity: 0.8,
        }
    }
}

// ─── Extensions ────────────────────────────────────────────────────

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(default)]
pub struct ExtensionsConfig {
    /// Master toggle for context-aware extensions
    pub enabled: bool,
    /// How often to poll the foreground process of each PTY session (milliseconds)
    pub poll_interval_ms: u64,
}

impl Default for ExtensionsConfig {
    fn default() -> Self {
        Self {
            enabled: true,
            poll_interval_ms: 500,
        }
    }
}

// ─── SSH ───────────────────────────────────────────────────────────

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(default)]
pub struct SshConfig {
    /// Master toggle for SSH session multiplexing
    pub enabled: bool,
    /// Seconds to keep a ControlMaster alive after the last client disconnects
    pub control_persist: u64,
    /// Default target for clone action: "tab" or "window"
    pub clone_target: String,
}

impl Default for SshConfig {
    fn default() -> Self {
        Self {
            enabled: true,
            control_persist: 600,
            clone_target: "tab".to_string(),
        }
    }
}

// ─── Hooks ──────────────────────────────────────────────────────────

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(default)]
pub struct HooksConfig {
    /// Enable the HTTP hook server for Claude Code integration
    pub enabled: bool,
    /// Port to listen on (0 = auto-assign available port)
    pub port: u16,
    /// Show toast notifications for hook events
    pub show_toasts: bool,
    /// Maximum number of visible toasts (oldest dismissed when exceeded)
    pub max_toasts: usize,
    /// Background animation style: "flame", "brainwave", "matrix", or "none"
    pub animation: String,
}

impl Default for HooksConfig {
    fn default() -> Self {
        Self {
            enabled: true,
            port: 0,
            show_toasts: false,
            max_toasts: 20,
            animation: "brainwave".to_string(),
        }
    }
}

// ─── Music ─────────────────────────────────────────────────────────

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(default)]
pub struct MusicConfig {
    /// Master toggle for the music player
    pub enabled: bool,
    /// Default volume (0.0–1.0)
    pub volume: f64,
    /// Default directory to scan for MP3 files
    pub directory: String,
    /// Enable Circuit Trace background visualizer
    pub visualizer: bool,
    /// Background canvas opacity (0.0–1.0)
    pub visualizer_opacity: f64,
}

impl Default for MusicConfig {
    fn default() -> Self {
        Self {
            enabled: true,
            volume: 0.7,
            directory: "~/Music".to_string(),
            visualizer: true,
            visualizer_opacity: 0.18,
        }
    }
}

// ─── Agent ────────────────────────────────────────────────────────

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(default)]
pub struct AgentConfig {
    /// Name of the active model preset
    pub active: String,
    /// Named model presets
    pub models: Vec<AgentModelConfig>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AgentModelConfig {
    /// Unique preset name, e.g. "zai", "ollama-gemma4"
    pub name: String,
    /// Provider identifier: "zai", "ollama", "openai", "anthropic", etc.
    pub provider: String,
    /// Model identifier: "glm-4.7", "gemma4:latest", "gpt-4o", etc.
    pub model: String,
    /// API endpoint URL
    pub base_url: String,
    /// Environment variable name for the API key (empty = no key needed)
    pub api_key_env: String,
    /// Model's context window size in tokens
    pub context_window: u32,
    /// Maximum output tokens
    pub max_tokens: u32,
}

impl Default for AgentConfig {
    fn default() -> Self {
        Self {
            active: "zai".to_string(),
            models: vec![
                AgentModelConfig {
                    name: "zai".to_string(),
                    provider: "zai".to_string(),
                    model: "glm-5.1".to_string(),
                    base_url: "https://api.z.ai/api/coding/paas/v4".to_string(),
                    api_key_env: "ZAI_API_KEY".to_string(),
                    context_window: 128000,
                    max_tokens: 8192,
                },
                AgentModelConfig {
                    name: "ollama-qwen3.5".to_string(),
                    provider: "ollama".to_string(),
                    model: "qwen3.5:latest".to_string(),
                    base_url: "http://localhost:11434/v1".to_string(),
                    api_key_env: "".to_string(),
                    context_window: 32768,
                    max_tokens: 8192,
                },
                AgentModelConfig {
                    name: "ollama-gemma4".to_string(),
                    provider: "ollama".to_string(),
                    model: "gemma4:latest".to_string(),
                    base_url: "http://localhost:11434/v1".to_string(),
                    api_key_env: "".to_string(),
                    context_window: 128000,
                    max_tokens: 8192,
                },
            ],
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
            default_layout: "focus".to_string(),
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
/// On first load (startup), flushes new fields back to disk.
pub fn load_config() -> KryptonConfig {
    load_config_inner(true)
}

fn load_config_inner(flush: bool) -> KryptonConfig {
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

    let config = match fs::read_to_string(&path) {
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
    };

    if flush {
        // Flush the fully-populated config back to disk so that any new
        // fields added since the file was last written appear with their defaults.
        flush_config(&path, &config);
    }

    config
}

/// Write the fully-populated config back to disk, adding any new
/// fields that were missing from the user's file.
pub fn flush_config(path: &PathBuf, config: &KryptonConfig) {
    match toml::to_string_pretty(config) {
        Ok(toml_str) => {
            let content = format!(
                "# Krypton configuration\n\
                 # See docs/06-configuration.md for full reference\n\n\
                 {toml_str}"
            );
            // Only write if content differs to avoid triggering the filesystem watcher loop
            if let Ok(existing) = fs::read_to_string(path) {
                if existing == content {
                    log::debug!("Config file already up to date, skipping flush");
                    return;
                }
            }
            if let Err(e) = fs::write(path, &content) {
                log::error!("Failed to flush config to {}: {e}", path.display());
            } else {
                log::debug!("Flushed config to {}", path.display());
            }
        }
        Err(e) => {
            log::error!("Failed to serialize config for flush: {e}");
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
