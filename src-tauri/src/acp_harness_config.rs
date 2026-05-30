// ACP Harness Directive Management — Krypton-owned config file.
//
// Stores reusable, backend/task-scoped "directives" (system-style prompt
// blocks) in `~/.config/krypton/acp-harness.toml`. Unlike `krypton.toml`
// (hand-edited, never written by Krypton), this file is Krypton-managed: it is
// created on first load and rewritten atomically when an agent mutates a
// directive through the harness MCP surface. See
// `docs/124-acp-harness-directive-management.md`.

use std::fs;
use std::path::PathBuf;

use serde::{Deserialize, Serialize};

use crate::config::config_dir;

/// Hard cap on a directive's system prompt (16 KiB) to avoid accidental huge
/// context injection.
pub const DIRECTIVE_SYSTEM_PROMPT_MAX: usize = 16 * 1024;

/// Built-in ACP backend ids a directive may target. An empty `backend` means
/// "all backends". Mirrors the frontend `BACKEND_LABELS` keys.
pub const BUILTIN_BACKEND_IDS: &[&str] = &[
    "codex", "claude", "gemini", "opencode", "pi-acp", "droid", "cursor", "junie", "omp",
];

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(default)]
pub struct AcpHarnessUserConfig {
    pub version: u32,
    pub directives: Vec<HarnessDirective>,
}

// Hand-written, NOT `#[derive(Default)]`: derive would resolve `version` to 0,
// which under `#[serde(default)]` would misread a file missing `version`.
impl Default for AcpHarnessUserConfig {
    fn default() -> Self {
        Self {
            version: 1,
            directives: Vec::new(),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(default)]
pub struct HarnessDirective {
    pub id: String,
    pub title: String,
    /// Short glyph or 1-2 character label for picker scanning.
    pub icon: String,
    pub description: String,
    /// Empty = all backends.
    pub backend: String,
    /// Free-form task key, e.g. implementation/review/research.
    pub task: String,
    /// Reusable system-style prompt block.
    pub system_prompt: String,
    pub enabled: bool,
    /// Legacy spec-129 metadata. Since spec 130, `attention_flag` is default-on
    /// for every harness-memory-capable lane and this no longer controls tool
    /// visibility. Retained for config compatibility and visible badges.
    pub triage_equipped: bool,
}

// Hand-written, NOT `#[derive(Default)]`: derive would resolve `enabled` to
// `false`, so a hand-written directive omitting `enabled` would silently
// deserialize as disabled under `#[serde(default)]`.
impl Default for HarnessDirective {
    fn default() -> Self {
        Self {
            id: String::new(),
            title: String::new(),
            icon: String::new(),
            description: String::new(),
            backend: String::new(),
            task: String::new(),
            system_prompt: String::new(),
            enabled: true,
            triage_equipped: false,
        }
    }
}

/// `~/.config/krypton/acp-harness.toml`.
pub fn acp_harness_config_path() -> Option<PathBuf> {
    config_dir().map(|d| d.join("acp-harness.toml"))
}

/// Load the directive config from disk. Returns in-memory defaults when the
/// file is missing (without creating it) or when it fails to parse — callers
/// that mutate will persist on save. Every loaded directive is normalized
/// (trimmed + icon fallback) so the frontend always receives display-ready
/// values.
pub fn load() -> Result<AcpHarnessUserConfig, String> {
    let path = acp_harness_config_path()
        .ok_or_else(|| "Could not determine config directory".to_string())?;
    if !path.exists() {
        return Ok(AcpHarnessUserConfig::default());
    }
    let contents =
        fs::read_to_string(&path).map_err(|e| format!("Failed to read {}: {e}", path.display()))?;
    let mut cfg: AcpHarnessUserConfig = toml::from_str(&contents)
        .map_err(|e| format!("Failed to parse {}: {e}", path.display()))?;
    for d in &mut cfg.directives {
        normalize(d);
    }
    Ok(cfg)
}

/// Load, creating an empty default file if it does not yet exist. Used by the
/// Tauri command so the user has a file to hand-edit after first opening the
/// harness.
pub fn load_or_create() -> Result<AcpHarnessUserConfig, String> {
    let path = acp_harness_config_path()
        .ok_or_else(|| "Could not determine config directory".to_string())?;
    if !path.exists() {
        let cfg = AcpHarnessUserConfig::default();
        save(&cfg)?;
        return Ok(cfg);
    }
    load()
}

/// Atomic save: write `<path>.tmp`, then rename over the target.
pub fn save(cfg: &AcpHarnessUserConfig) -> Result<(), String> {
    let path = acp_harness_config_path()
        .ok_or_else(|| "Could not determine config directory".to_string())?;
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)
            .map_err(|e| format!("Failed to create {}: {e}", parent.display()))?;
    }
    let serialized =
        toml::to_string_pretty(cfg).map_err(|e| format!("Failed to serialize directives: {e}"))?;
    let tmp = path.with_extension("toml.tmp");
    fs::write(&tmp, serialized).map_err(|e| format!("Failed to write {}: {e}", tmp.display()))?;
    fs::rename(&tmp, &path).map_err(|e| format!("Failed to commit {}: {e}", path.display()))?;
    Ok(())
}

/// Trim all string fields and fill an icon fallback when empty.
fn normalize(d: &mut HarnessDirective) {
    d.id = d.id.trim().to_string();
    d.title = d.title.trim().to_string();
    d.icon = d.icon.trim().to_string();
    d.description = d.description.trim().to_string();
    d.backend = d.backend.trim().to_string();
    d.task = d.task.trim().to_string();
    d.system_prompt = d.system_prompt.trim().to_string();
    if d.icon.is_empty() {
        d.icon = fallback_icon(d);
    }
}

/// Deterministic single-glyph fallback derived from task, then backend, then id.
fn fallback_icon(d: &HarnessDirective) -> String {
    for source in [&d.task, &d.backend, &d.id, &d.title] {
        if let Some(c) = source.chars().next() {
            return c.to_uppercase().to_string();
        }
    }
    "·".to_string()
}

fn is_kebab_case(s: &str) -> bool {
    let mut chars = s.chars();
    match chars.next() {
        Some(c) if c.is_ascii_lowercase() || c.is_ascii_digit() => {}
        _ => return false,
    }
    s.chars()
        .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-')
}

/// Validate a directive payload for `upsert`. `existing` is the current
/// directive list (used for uniqueness; an upsert replacing the same id is
/// allowed).
pub fn validate_directive(
    d: &HarnessDirective,
    existing: &[HarnessDirective],
) -> Result<(), String> {
    let id = d.id.trim();
    if id.is_empty() {
        return Err("directive id must be non-empty".to_string());
    }
    if !is_kebab_case(id) {
        return Err(format!(
            "directive id '{id}' must be lowercase kebab-case ([a-z0-9][a-z0-9-]*)"
        ));
    }
    // Uniqueness is resolved by `upsert_directive` matching on id (replace vs
    // add), so an id already in `existing` is not an error here.
    let _ = existing;
    let backend = d.backend.trim();
    if !backend.is_empty() && !BUILTIN_BACKEND_IDS.contains(&backend) {
        return Err(format!("unknown backend '{backend}'"));
    }
    let task = d.task.trim();
    if !task.is_empty() && !is_kebab_case(task) {
        return Err(format!("task '{task}' must be lowercase kebab-case"));
    }
    if d.system_prompt.trim().len() > DIRECTIVE_SYSTEM_PROMPT_MAX {
        return Err(format!(
            "system_prompt exceeds {DIRECTIVE_SYSTEM_PROMPT_MAX} byte cap"
        ));
    }
    Ok(())
}

/// Insert or replace a directive by id. Returns the normalized stored value.
pub fn upsert_directive(
    cfg: &mut AcpHarnessUserConfig,
    mut directive: HarnessDirective,
) -> Result<HarnessDirective, String> {
    normalize(&mut directive);
    validate_directive(&directive, &cfg.directives)?;
    if let Some(slot) = cfg.directives.iter_mut().find(|e| e.id == directive.id) {
        *slot = directive.clone();
    } else {
        cfg.directives.push(directive.clone());
    }
    Ok(directive)
}

/// Delete a directive by id. Returns true when a directive was removed.
pub fn delete_directive(cfg: &mut AcpHarnessUserConfig, id: &str) -> bool {
    let id = id.trim();
    let before = cfg.directives.len();
    cfg.directives.retain(|d| d.id != id);
    cfg.directives.len() != before
}

#[cfg(test)]
mod tests {
    use super::*;

    fn directive(id: &str) -> HarnessDirective {
        HarnessDirective {
            id: id.to_string(),
            title: "T".to_string(),
            system_prompt: "do work".to_string(),
            ..Default::default()
        }
    }

    #[test]
    fn default_enabled_is_true() {
        assert!(HarnessDirective::default().enabled);
        assert_eq!(AcpHarnessUserConfig::default().version, 1);
    }

    #[test]
    fn default_triage_grant_is_off() {
        // spec 129: triage is opt-in — a directive grants it only when the user
        // sets it. A config omitting the field must deserialize to no grant.
        assert!(!HarnessDirective::default().triage_equipped);
        let cfg: AcpHarnessUserConfig =
            toml::from_str("version = 1\n[[directives]]\nid = \"x\"\ntitle = \"X\"\n").unwrap();
        assert!(!cfg.directives[0].triage_equipped);
    }

    #[test]
    fn icon_fallback_from_task() {
        let mut d = directive("x");
        d.task = "review".to_string();
        d.icon = String::new();
        normalize(&mut d);
        assert_eq!(d.icon, "R");
    }

    #[test]
    fn rejects_bad_id() {
        let mut d = directive("Bad_Id");
        d.id = "Bad_Id".to_string();
        assert!(validate_directive(&d, &[]).is_err());
    }

    #[test]
    fn rejects_unknown_backend() {
        let mut d = directive("ok");
        d.backend = "nope".to_string();
        assert!(validate_directive(&d, &[]).is_err());
    }

    #[test]
    fn upsert_then_delete() {
        let mut cfg = AcpHarnessUserConfig::default();
        upsert_directive(&mut cfg, directive("a")).unwrap();
        upsert_directive(&mut cfg, directive("a")).unwrap();
        assert_eq!(cfg.directives.len(), 1);
        assert!(delete_directive(&mut cfg, "a"));
        assert!(!delete_directive(&mut cfg, "a"));
    }

    #[test]
    fn rejects_oversize_prompt() {
        let mut d = directive("big");
        d.system_prompt = "x".repeat(DIRECTIVE_SYSTEM_PROMPT_MAX + 1);
        assert!(validate_directive(&d, &[]).is_err());
    }
}
