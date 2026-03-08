// Krypton — Theme Engine
// Loads built-in themes (embedded TOML), custom themes from ~/.config/krypton/themes/,
// resolves themes by name, and provides the full theme data for the frontend.

use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::fs;
use std::path::PathBuf;

// ─── Built-in theme TOML files (embedded at compile time) ─────────
const BUILTIN_KRYPTON_DARK: &str = include_str!("../themes/krypton-dark.toml");
const BUILTIN_LEGACY_RADIANCE: &str = include_str!("../themes/legacy-radiance.toml");

// ─── Full Theme Data ──────────────────────────────────────────────
// This mirrors the TOML structure of theme files and is sent to the
// frontend in full so it can set CSS custom properties.

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(default)]
pub struct FullTheme {
    pub meta: ThemeMeta,
    pub colors: ThemeColors,
    pub chrome: ChromeConfig,
    pub focused: FocusedConfig,
    pub workspace: WorkspaceConfig,
    pub ui: UiConfig,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(default)]
pub struct ThemeMeta {
    pub display_name: String,
    pub author: String,
    pub version: String,
    pub description: String,
    pub license: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(default)]
pub struct ThemeColors {
    pub foreground: String,
    pub background: String,
    pub cursor: String,
    pub selection: String,
    pub black: String,
    pub red: String,
    pub green: String,
    pub yellow: String,
    pub blue: String,
    pub magenta: String,
    pub cyan: String,
    pub white: String,
    pub bright_black: String,
    pub bright_red: String,
    pub bright_green: String,
    pub bright_yellow: String,
    pub bright_blue: String,
    pub bright_magenta: String,
    pub bright_cyan: String,
    pub bright_white: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(default)]
pub struct ChromeConfig {
    pub style: String,
    pub border: ChromeBorder,
    pub shadow: ChromeShadow,
    pub backdrop: ChromeBackdrop,
    pub titlebar: ChromeTitlebar,
    pub status_dot: ChromeStatusDot,
    pub header_accent: ChromeHeaderAccent,
    pub corner_accents: ChromeCornerAccents,
    pub tabs: ChromeTabs,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(default)]
pub struct ChromeBorder {
    pub width: u32,
    pub color: String,
    pub radius: u32,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(default)]
pub struct ChromeShadow {
    pub color: String,
    pub blur: u32,
    pub spread: u32,
    pub offset_x: i32,
    pub offset_y: i32,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(default)]
pub struct ChromeBackdrop {
    pub color: String,
    pub blur: u32,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(default)]
pub struct ChromeTitlebar {
    pub height: u32,
    pub background: String,
    pub text_color: String,
    pub font_size: u32,
    pub font_weight: u32,
    pub letter_spacing: f64,
    pub text_transform: String,
    pub alignment: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(default)]
pub struct ChromeStatusDot {
    pub size: u32,
    pub color: String,
    pub shape: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(default)]
pub struct ChromeHeaderAccent {
    pub enabled: bool,
    pub height: u32,
    pub color: String,
    pub margin_horizontal: u32,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(default)]
pub struct ChromeCornerAccents {
    pub enabled: bool,
    pub size: u32,
    pub thickness: u32,
    pub color: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(default)]
pub struct ChromeTabs {
    pub height: u32,
    pub background: String,
    pub active_color: String,
    pub inactive_color: String,
    pub font_size: u32,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(default)]
pub struct FocusedConfig {
    pub border_color: String,
    pub shadow_color: String,
    pub shadow_blur: u32,
    pub titlebar_text_color: String,
    pub status_dot_color: String,
    pub header_accent_color: String,
    pub corner_accent_color: String,
    pub corner_accent_glow: String,
    pub label_color: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(default)]
pub struct WorkspaceConfig {
    pub background: String,
    pub blur: u32,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(default)]
pub struct UiConfig {
    pub command_palette: UiCommandPalette,
    pub search: UiSearch,
    pub mode_indicator: UiModeIndicator,
    pub which_key: UiWhichKey,
    pub quick_terminal: UiQuickTerminal,
    pub hints: UiHints,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct UiHints {
    pub background: String,
    pub foreground: String,
    pub matched_foreground: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct UiCommandPalette {
    pub background: String,
    pub border: String,
    pub text_color: String,
    pub highlight_color: String,
    pub input_background: String,
    pub input_text_color: String,
    pub backdrop_blur: u32,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct UiSearch {
    pub background: String,
    pub text_color: String,
    pub match_color: String,
    pub border: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct UiModeIndicator {
    pub background: String,
    pub text_color: String,
    pub font_size: u32,
    pub position: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct UiWhichKey {
    pub background: String,
    pub border: String,
    pub title_color: String,
    pub key_color: String,
    pub label_color: String,
    pub separator_color: String,
    pub backdrop_blur: u32,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct UiQuickTerminal {
    pub backdrop_blur: u32,
    pub background: String,
    pub shadow_color: String,
    pub shadow_blur: u32,
}

// ─── Defaults ─────────────────────────────────────────────────────
// These match the krypton-dark built-in theme values.

// NOTE: FullTheme derives Default, which delegates to each sub-struct's Default impl.
// Do NOT replace this with a manual impl that calls toml::from_str() — FullTheme
// uses #[serde(default)] which would cause infinite recursion.

impl Default for ThemeMeta {
    fn default() -> Self {
        Self {
            display_name: "Krypton Dark".to_string(),
            author: "Krypton".to_string(),
            version: "1.0.0".to_string(),
            description: String::new(),
            license: "MIT".to_string(),
        }
    }
}

impl Default for ThemeColors {
    fn default() -> Self {
        Self {
            foreground: "#b0c4d8".to_string(),
            background: "rgba(10, 10, 15, 0.5)".to_string(),
            cursor: "#0cf".to_string(),
            selection: "rgba(26, 58, 92, 0.6)".to_string(),
            black: "#0a0a0f".to_string(),
            red: "#ff3a5c".to_string(),
            green: "#0cf".to_string(),
            yellow: "#e8c547".to_string(),
            blue: "#4a9eff".to_string(),
            magenta: "#c77dff".to_string(),
            cyan: "#0cf".to_string(),
            white: "#b0c4d8".to_string(),
            bright_black: "#2a4a6c".to_string(),
            bright_red: "#ff5c7a".to_string(),
            bright_green: "#33ddff".to_string(),
            bright_yellow: "#ffd866".to_string(),
            bright_blue: "#6ab4ff".to_string(),
            bright_magenta: "#d9a0ff".to_string(),
            bright_cyan: "#33ddff".to_string(),
            bright_white: "#ffffff".to_string(),
        }
    }
}

impl Default for ChromeConfig {
    fn default() -> Self {
        Self {
            style: "cyberpunk".to_string(),
            border: ChromeBorder::default(),
            shadow: ChromeShadow::default(),
            backdrop: ChromeBackdrop::default(),
            titlebar: ChromeTitlebar::default(),
            status_dot: ChromeStatusDot::default(),
            header_accent: ChromeHeaderAccent::default(),
            corner_accents: ChromeCornerAccents::default(),
            tabs: ChromeTabs::default(),
        }
    }
}

impl Default for ChromeBorder {
    fn default() -> Self {
        Self {
            width: 1,
            color: "rgba(0, 200, 255, 0.3)".to_string(),
            radius: 0,
        }
    }
}

impl Default for ChromeShadow {
    fn default() -> Self {
        Self {
            color: "rgba(0, 200, 255, 0.07)".to_string(),
            blur: 15,
            spread: 0,
            offset_x: 0,
            offset_y: 0,
        }
    }
}

impl Default for ChromeBackdrop {
    fn default() -> Self {
        Self {
            color: "rgba(6, 10, 18, 0.5)".to_string(),
            blur: 12,
        }
    }
}

impl Default for ChromeTitlebar {
    fn default() -> Self {
        Self {
            height: 28,
            background: "transparent".to_string(),
            text_color: "rgba(0, 200, 255, 0.3)".to_string(),
            font_size: 11,
            font_weight: 600,
            letter_spacing: 0.08,
            text_transform: "uppercase".to_string(),
            alignment: "left".to_string(),
        }
    }
}

impl Default for ChromeStatusDot {
    fn default() -> Self {
        Self {
            size: 6,
            color: "rgba(0, 200, 255, 0.25)".to_string(),
            shape: "square".to_string(),
        }
    }
}

impl Default for ChromeHeaderAccent {
    fn default() -> Self {
        Self {
            enabled: true,
            height: 6,
            color: "rgba(0, 200, 255, 0.15)".to_string(),
            margin_horizontal: 20,
        }
    }
}

impl Default for ChromeCornerAccents {
    fn default() -> Self {
        Self {
            enabled: true,
            size: 14,
            thickness: 2,
            color: "rgba(0, 200, 255, 0.4)".to_string(),
        }
    }
}

impl Default for ChromeTabs {
    fn default() -> Self {
        Self {
            height: 28,
            background: "transparent".to_string(),
            active_color: "#0cf".to_string(),
            inactive_color: "rgba(0, 200, 255, 0.3)".to_string(),
            font_size: 11,
        }
    }
}

impl Default for FocusedConfig {
    fn default() -> Self {
        Self {
            border_color: "rgba(0, 200, 255, 0.5)".to_string(),
            shadow_color: "rgba(0, 200, 255, 0.12)".to_string(),
            shadow_blur: 20,
            titlebar_text_color: "#0cf".to_string(),
            status_dot_color: "#0cf".to_string(),
            header_accent_color: "rgba(0, 200, 255, 0.35)".to_string(),
            corner_accent_color: "#0cf".to_string(),
            corner_accent_glow: "rgba(0, 204, 255, 0.6)".to_string(),
            label_color: "#0cf".to_string(),
        }
    }
}

impl Default for WorkspaceConfig {
    fn default() -> Self {
        Self {
            background: "transparent".to_string(),
            blur: 0,
        }
    }
}

impl Default for UiCommandPalette {
    fn default() -> Self {
        Self {
            background: "rgba(6, 10, 18, 0.85)".to_string(),
            border: "rgba(0, 200, 255, 0.4)".to_string(),
            text_color: "#c0c5ce".to_string(),
            highlight_color: "#0cf".to_string(),
            input_background: "transparent".to_string(),
            input_text_color: "#c0c5ce".to_string(),
            backdrop_blur: 16,
        }
    }
}

impl Default for UiSearch {
    fn default() -> Self {
        Self {
            background: "rgba(6, 10, 18, 0.85)".to_string(),
            text_color: "#c0c5ce".to_string(),
            match_color: "#ebcb8b".to_string(),
            border: "rgba(0, 200, 255, 0.4)".to_string(),
        }
    }
}

impl Default for UiModeIndicator {
    fn default() -> Self {
        Self {
            background: "rgba(0, 200, 255, 0.15)".to_string(),
            text_color: "#0cf".to_string(),
            font_size: 11,
            position: "bottom-center".to_string(),
        }
    }
}

impl Default for UiWhichKey {
    fn default() -> Self {
        Self {
            background: "rgba(6, 10, 18, 0.85)".to_string(),
            border: "rgba(0, 200, 255, 0.4)".to_string(),
            title_color: "#0cf".to_string(),
            key_color: "#0cf".to_string(),
            label_color: "rgba(0, 200, 255, 0.4)".to_string(),
            separator_color: "rgba(0, 200, 255, 0.2)".to_string(),
            backdrop_blur: 16,
        }
    }
}

impl Default for UiQuickTerminal {
    fn default() -> Self {
        Self {
            backdrop_blur: 20,
            background: "rgba(6, 10, 18, 0.6)".to_string(),
            shadow_color: "rgba(0, 200, 255, 0.1)".to_string(),
            shadow_blur: 30,
        }
    }
}

impl Default for UiHints {
    fn default() -> Self {
        Self {
            background: "#f4bf75".to_string(),
            foreground: "#181818".to_string(),
            matched_foreground: "#8a7444".to_string(),
        }
    }
}

// ─── Theme Engine ─────────────────────────────────────────────────

pub struct ThemeEngine {
    /// Built-in themes, keyed by name (lowercase)
    builtins: HashMap<String, FullTheme>,
}

impl Default for ThemeEngine {
    fn default() -> Self {
        Self::new()
    }
}

impl ThemeEngine {
    /// Create a new theme engine with built-in themes loaded.
    pub fn new() -> Self {
        let mut builtins = HashMap::new();

        // Parse and register built-in themes
        match toml::from_str::<FullTheme>(BUILTIN_KRYPTON_DARK) {
            Ok(theme) => {
                builtins.insert("krypton-dark".to_string(), theme);
            }
            Err(e) => log::error!("Failed to parse built-in krypton-dark theme: {e}"),
        }

        match toml::from_str::<FullTheme>(BUILTIN_LEGACY_RADIANCE) {
            Ok(theme) => {
                builtins.insert("legacy-radiance".to_string(), theme);
            }
            Err(e) => log::error!("Failed to parse built-in legacy-radiance theme: {e}"),
        }

        log::info!(
            "Theme engine initialized with {} built-in theme(s)",
            builtins.len()
        );

        Self { builtins }
    }

    /// Resolve a theme by name. Checks custom themes directory first,
    /// then falls back to built-in themes.
    pub fn resolve(&self, name: &str) -> Result<FullTheme, String> {
        let normalized = name.to_lowercase();

        // 1. Try custom theme from ~/.config/krypton/themes/<name>.toml
        if let Some(theme) = self.load_custom_theme(&normalized) {
            return Ok(theme);
        }

        // 2. Try built-in theme
        if let Some(theme) = self.builtins.get(&normalized) {
            log::info!("Resolved built-in theme: {normalized}");
            return Ok(theme.clone());
        }

        Err(format!(
            "Theme '{name}' not found. Available built-in themes: {}",
            self.list_names().join(", ")
        ))
    }

    /// List all available theme names (built-in + custom).
    pub fn list_names(&self) -> Vec<String> {
        let mut names: Vec<String> = self.builtins.keys().cloned().collect();

        // Also scan custom themes directory
        if let Some(themes_dir) = custom_themes_dir() {
            if let Ok(entries) = fs::read_dir(&themes_dir) {
                for entry in entries.flatten() {
                    let path = entry.path();
                    if path.extension().is_some_and(|ext| ext == "toml") {
                        if let Some(stem) = path.file_stem().and_then(|s| s.to_str()) {
                            let name = stem.to_lowercase();
                            if !names.contains(&name) {
                                names.push(name);
                            }
                        }
                    }
                }
            }
        }

        names.sort();
        names
    }

    /// Apply config `[theme.colors]` overrides on top of a resolved theme.
    /// This allows users to set `theme.name = "legacy-radiance"` and also
    /// override individual colors via `[theme.colors]`.
    pub fn apply_config_overrides(
        &self,
        theme: &mut FullTheme,
        config_colors: &crate::config::ThemeColors,
    ) {
        macro_rules! override_if_set {
            ($field:ident) => {
                if let Some(ref v) = config_colors.$field {
                    theme.colors.$field = v.clone();
                }
            };
        }

        override_if_set!(foreground);
        override_if_set!(background);
        override_if_set!(cursor);
        override_if_set!(selection);
        override_if_set!(black);
        override_if_set!(red);
        override_if_set!(green);
        override_if_set!(yellow);
        override_if_set!(blue);
        override_if_set!(magenta);
        override_if_set!(cyan);
        override_if_set!(white);
        override_if_set!(bright_black);
        override_if_set!(bright_red);
        override_if_set!(bright_green);
        override_if_set!(bright_yellow);
        override_if_set!(bright_blue);
        override_if_set!(bright_magenta);
        override_if_set!(bright_cyan);
        override_if_set!(bright_white);
    }

    /// Load a custom theme from ~/.config/krypton/themes/<name>.toml
    fn load_custom_theme(&self, name: &str) -> Option<FullTheme> {
        let themes_dir = custom_themes_dir()?;
        let path = themes_dir.join(format!("{name}.toml"));

        if !path.exists() {
            return None;
        }

        match fs::read_to_string(&path) {
            Ok(contents) => match toml::from_str::<FullTheme>(&contents) {
                Ok(theme) => {
                    log::info!("Loaded custom theme from {}", path.display());
                    Some(theme)
                }
                Err(e) => {
                    log::error!("Failed to parse custom theme at {}: {e}", path.display());
                    None
                }
            },
            Err(e) => {
                log::error!("Failed to read custom theme at {}: {e}", path.display());
                None
            }
        }
    }
}

/// Get the custom themes directory: ~/.config/krypton/themes/
fn custom_themes_dir() -> Option<PathBuf> {
    crate::config::config_dir().map(|d| d.join("themes"))
}
