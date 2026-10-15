// Krypton — Theme Engine
// Loads built-in themes (embedded TOML), custom themes from ~/.config/krypton/themes/,
// resolves themes by name, and provides the full theme data for the frontend.

use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::fs;
use std::path::PathBuf;

// ─── Built-in theme TOML files (embedded at compile time) ─────────
const BUILTIN_KRYPTON_DARK: &str = include_str!("../themes/krypton-dark.toml");
const BUILTIN_KRYPTON_LIGHT: &str = include_str!("../themes/krypton-light.toml");
const BUILTIN_LEGACY_RADIANCE: &str = include_str!("../themes/legacy-radiance.toml");

// ─── Full Theme Data ──────────────────────────────────────────────
// This mirrors the TOML structure of theme files and is sent to the
// frontend in full so it can set CSS custom properties.

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(default)]
pub struct FullTheme {
    /// File/id name (`legacy-radiance`). Set after resolve; not read from TOML.
    #[serde(skip_deserializing)]
    pub name: String,
    pub meta: ThemeMeta,
    pub colors: ThemeColors,
    pub chrome: ChromeConfig,
    pub focused: FocusedConfig,
    pub workspace: WorkspaceConfig,
    pub ui: UiConfig,
    /// Spec 303 — free-form component tokens. Key becomes `--<key>` on `:root`.
    /// Entries that fail [`sanitize_tokens`] are dropped at load.
    #[serde(default)]
    pub tokens: HashMap<String, String>,
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
    /// Band rendering: "oscilloscope" (live canvas trace fed by PTY throughput)
    /// or "ticks" (static striped gradient). See docs/0188-oscilloscope-header-band.md.
    pub style: String,
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
            radius: 8,
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
            style: "oscilloscope".to_string(),
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

// ─── Component Tokens (spec 303) ──────────────────────────────────

/// Longest accepted token key (`^[a-z][a-z0-9-]{0,63}$`).
const TOKEN_KEY_MAX_LEN: usize = 64;

/// Longest accepted token value.
const TOKEN_VALUE_MAX_LEN: usize = 256;

/// CSS functions a token value may call. Everything else — `url`, `image`,
/// `image-set`, `-webkit-image-set`, `cross-fade`, `element`, `expression`,
/// `attr`, … — is rejected, because the fetch surface is wider than `url()`.
const TOKEN_FN_ALLOWLIST: [&str; 14] = [
    "var",
    "rgb",
    "rgba",
    "hsl",
    "hsla",
    "color-mix",
    "color",
    "oklch",
    "lab",
    "calc",
    "clamp",
    "min",
    "max",
    "env",
];

/// `^[a-z][a-z0-9-]{0,63}$` — the key is rendered as `--<key>`, so it stays in
/// the lowercase kebab charset every built-in property already uses.
fn token_key_is_valid(key: &str) -> bool {
    if key.len() > TOKEN_KEY_MAX_LEN {
        return false;
    }
    let mut chars = key.chars();
    match chars.next() {
        Some(first) if first.is_ascii_lowercase() => {}
        _ => return false,
    }
    chars.all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-')
}

/// Resolve CSS escapes (`\75 ` → `u`, `\-` → `-`) so the function allowlist
/// sees real identifiers. CSS identifiers accept escapes, so `\75 rl(…)` is a
/// perfectly valid `url()` call that contains none of the obvious substrings.
fn css_unescape(value: &str) -> String {
    let mut out = String::with_capacity(value.len());
    let mut chars = value.chars().peekable();
    while let Some(c) = chars.next() {
        if c != '\\' {
            out.push(c);
            continue;
        }
        let mut hex = String::new();
        while hex.len() < 6 {
            match chars.peek() {
                Some(h) if h.is_ascii_hexdigit() => {
                    hex.push(*h);
                    chars.next();
                }
                _ => break,
            }
        }
        if hex.is_empty() {
            // `\<char>` escapes the character itself; a trailing `\` is dropped.
            if let Some(escaped) = chars.next() {
                out.push(escaped);
            }
            continue;
        }
        // A single whitespace character terminates a hex escape.
        if chars.peek().is_some_and(|w| w.is_whitespace()) {
            chars.next();
        }
        let code = u32::from_str_radix(&hex, 16).unwrap_or(0);
        out.push(char::from_u32(code).unwrap_or(char::REPLACEMENT_CHARACTER));
    }
    out
}

/// A character that can appear in a CSS identifier.
fn is_ident_char(c: char) -> bool {
    c.is_ascii_alphanumeric() || c == '-' || c == '_' || !c.is_ascii()
}

/// Allowlist check, applied to the unescaped + lowercased value: every function
/// token has to be one Krypton knows cannot fetch. `setProperty` parses one
/// declaration value and cannot be broken out of, so `;` `}` `{` `@import` are
/// deliberately not filtered — the fetch surface is the whole control here.
fn token_value_is_valid(value: &str) -> bool {
    if value.len() > TOKEN_VALUE_MAX_LEN {
        return false;
    }
    let normalized = css_unescape(value).to_lowercase();
    let mut ident = String::new();
    for c in normalized.chars() {
        if c == '(' {
            if !ident.is_empty() && !TOKEN_FN_ALLOWLIST.contains(&ident.as_str()) {
                return false;
            }
            ident.clear();
        } else if is_ident_char(c) {
            ident.push(c);
        } else {
            ident.clear();
        }
    }
    true
}

/// Drop `[tokens]` entries that fail validation, individually. The rest of the
/// theme still loads: a theme can never break startup, and never fetch.
fn sanitize_tokens(theme: &mut FullTheme) {
    theme.tokens.retain(|key, value| {
        let keep = token_key_is_valid(key) && token_value_is_valid(value);
        if !keep {
            log::warn!("theme token rejected: {key}");
        }
        keep
    });
}

/// Parse theme TOML and sanitize its `[tokens]` table. Every path that turns
/// TOML into a [`FullTheme`] goes through here.
fn parse_theme_toml(contents: &str) -> Result<FullTheme, toml::de::Error> {
    let mut theme: FullTheme = toml::from_str(contents)?;
    sanitize_tokens(&mut theme);
    Ok(theme)
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
        match parse_theme_toml(BUILTIN_KRYPTON_DARK) {
            Ok(theme) => {
                builtins.insert("krypton-dark".to_string(), theme);
            }
            Err(e) => log::error!("Failed to parse built-in krypton-dark theme: {e}"),
        }

        match parse_theme_toml(BUILTIN_KRYPTON_LIGHT) {
            Ok(theme) => {
                builtins.insert("krypton-light".to_string(), theme);
            }
            Err(e) => log::error!("Failed to parse built-in krypton-light theme: {e}"),
        }

        match parse_theme_toml(BUILTIN_LEGACY_RADIANCE) {
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

    /// Resolve `config.theme.name` and apply `[theme.colors]` overrides.
    pub fn resolve_for_config(
        &self,
        config: &crate::config::KryptonConfig,
    ) -> Result<FullTheme, String> {
        let mut theme = self.resolve(&config.theme.name)?;
        theme.name = config.theme.name.to_lowercase();
        self.apply_config_overrides(&mut theme, &config.theme.colors);
        Ok(theme)
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
            Ok(contents) => match parse_theme_toml(&contents) {
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
pub(crate) fn custom_themes_dir() -> Option<PathBuf> {
    crate::config::config_dir().map(|d| d.join("themes"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn resolves_legacy_radiance_green() {
        let engine = ThemeEngine::new();
        let theme = engine.resolve("legacy-radiance").expect("builtin");
        assert_eq!(theme.colors.green.to_lowercase(), "#00c840");
        assert_eq!(theme.focused.corner_accent_color.to_lowercase(), "#00c840");
    }

    #[test]
    fn resolves_krypton_dark() {
        let engine = ThemeEngine::new();
        let theme = engine.resolve("krypton-dark").expect("builtin");
        assert_eq!(theme.colors.cyan.to_lowercase(), "#0cf");
    }

    #[test]
    fn resolves_krypton_light() {
        // Parse the bundled file directly — `resolve()` prefers
        // ~/.config/krypton/themes/krypton-light.toml when present.
        let theme: FullTheme =
            toml::from_str(BUILTIN_KRYPTON_LIGHT).expect("bundled krypton-light");
        assert_eq!(theme.meta.display_name, "Krypton Light");
        assert_eq!(theme.colors.foreground, "#1c2c3c");
        assert_eq!(theme.focused.corner_accent_color, "#007799");
        assert_eq!(theme.chrome.titlebar.text_color, "#3a5568");
        assert!(theme.colors.background.contains("248, 251, 253"));
        assert!(theme.chrome.backdrop.color.contains("230, 239, 246"));
    }

    #[test]
    fn unknown_theme_errors() {
        let engine = ThemeEngine::new();
        assert!(engine.resolve("does-not-exist").is_err());
    }

    /// Minimal theme TOML; every section defaults, so `[tokens]` is the subject.
    fn theme_with(tokens: &str) -> FullTheme {
        let toml = format!("[colors]\nforeground = \"#abcdef\"\n\n{tokens}");
        parse_theme_toml(&toml).expect("theme fixture parses")
    }

    #[test]
    fn missing_tokens_table_defaults_to_empty() {
        let theme = theme_with("");
        assert!(theme.tokens.is_empty());
        assert_eq!(theme.colors.foreground, "#abcdef");
    }

    #[test]
    fn valid_token_survives() {
        let theme = theme_with(
            "[tokens]\n\
             \"acp-tool-head-fg\" = \"#ffd27f\"\n\
             \"acp-peek-accent\" = \"var(--agent-cyan)\"\n\
             \"acp-tool-output-max-h\" = \"calc(100vh - clamp(2px, 1vw, 8px))\"\n",
        );
        assert_eq!(theme.tokens.len(), 3);
        assert_eq!(
            theme.tokens.get("acp-tool-head-fg").map(String::as_str),
            Some("#ffd27f")
        );
        assert_eq!(
            theme.tokens.get("acp-peek-accent").map(String::as_str),
            Some("var(--agent-cyan)")
        );
    }

    #[test]
    fn invalid_keys_are_dropped_and_siblings_survive() {
        let theme = theme_with(
            "[tokens]\n\
             \"Acp-Upper\" = \"#fff\"\n\
             \"9-leading-digit\" = \"#fff\"\n\
             \"-leading-dash\" = \"#fff\"\n\
             \"has_underscore\" = \"#fff\"\n\
             \"has space\" = \"#fff\"\n\
             \"\" = \"#fff\"\n\
             \"acp-good\" = \"#fff\"\n",
        );
        assert_eq!(theme.tokens.len(), 1);
        assert!(theme.tokens.contains_key("acp-good"));
    }

    #[test]
    fn over_long_key_is_dropped() {
        let long = "a".repeat(65);
        let theme = theme_with(&format!("[tokens]\n\"{long}\" = \"#fff\"\n"));
        assert!(theme.tokens.is_empty());

        let at_limit = "a".repeat(64);
        let theme = theme_with(&format!("[tokens]\n\"{at_limit}\" = \"#fff\"\n"));
        assert_eq!(theme.tokens.len(), 1);
    }

    #[test]
    fn fetching_values_are_dropped() {
        let theme = theme_with(
            "[tokens]\n\
             \"acp-a\" = \"url(http://example.com/x.png)\"\n\
             \"acp-b\" = \"URL(HTTP://EXAMPLE.COM/x.png)\"\n\
             \"acp-c\" = \"\\\\75 rl(https://example.com/x.png)\"\n\
             \"acp-d\" = \"image-set(url(a.png) 1x)\"\n\
             \"acp-e\" = \"-webkit-image-set(url(a.png) 1x)\"\n\
             \"acp-f\" = \"cross-fade(url(a.png), url(b.png))\"\n\
             \"acp-g\" = \"element(#sheet)\"\n\
             \"acp-h\" = \"expression(alert(1))\"\n\
             \"acp-i\" = \"attr(href)\"\n\
             \"acp-j\" = \"image(url(a.png))\"\n\
             \"acp-ok\" = \"var(--agent-cyan)\"\n",
        );
        assert_eq!(
            theme.tokens.keys().map(String::as_str).collect::<Vec<_>>(),
            vec!["acp-ok"]
        );
    }

    #[test]
    fn escaped_url_is_unescaped_before_the_allowlist() {
        // `\75 rl(` is a valid url() token containing none of the substrings.
        assert_eq!(css_unescape("\\75 rl(https://x)"), "url(https://x)");
        assert!(!token_value_is_valid("\\75 rl(https://x)"));
        assert!(!token_value_is_valid("\\55 RL(https://x)"));
        assert!(!token_value_is_valid("u\\72l(https://x)"));
        assert!(token_value_is_valid("c\\61 lc(1px + 2px)"));
    }

    #[test]
    fn over_long_value_is_dropped() {
        let long = format!("#{}", "a".repeat(256));
        assert_eq!(long.len(), 257);
        let theme = theme_with(&format!(
            "[tokens]\n\"acp-long\" = \"{long}\"\n\"acp-short\" = \"#fff\"\n"
        ));
        assert_eq!(
            theme.tokens.keys().map(String::as_str).collect::<Vec<_>>(),
            vec!["acp-short"]
        );
    }

    #[test]
    fn unknown_keys_are_accepted_for_forward_compatibility() {
        let theme = theme_with("[tokens]\n\"not-a-real-hook-yet\" = \"7px\"\n");
        assert_eq!(
            theme.tokens.get("not-a-real-hook-yet").map(String::as_str),
            Some("7px")
        );
    }

    #[test]
    fn builtin_themes_carry_no_tokens() {
        let engine = ThemeEngine::new();
        let theme = engine.resolve("krypton-dark").expect("builtin");
        assert!(theme.tokens.is_empty());
    }
}
