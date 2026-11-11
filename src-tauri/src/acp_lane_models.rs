// ACP lane model and effort memory — Krypton-owned state file (spec 388).
//
// Remembers, per backend, the model and reasoning effort the user last confirmed
// in the harness model picker, in `~/.config/krypton/acp-lane-models.toml`.
// `krypton.toml` stays hand-edited and is never written. Fresh harness lanes
// read this file at spawn; only the picker writes it (`remember`). See
// `docs/0388-acp-lane-model-effort-memory.md`.

use std::collections::BTreeMap;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

use serde::{Deserialize, Serialize};

use crate::config::config_dir;

const FILE_NAME: &str = "acp-lane-models.toml";

/// Rewritten on every save: `toml` cannot round-trip comments.
const HEADER: &str = "\
# Managed by Krypton (spec 388): the model and effort last picked per ACP
# backend in the harness model picker (Cmd+P then ,). Delete a line to fall
# back to krypton.toml / the agent's default. Effort values are the agent's own.
";

/// Serializes load → modify → save so two lanes saving at once lose nothing.
static WRITE_LOCK: Mutex<()> = Mutex::new(());

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(default)]
pub struct LaneModelMemory {
    pub version: u32,
    /// backend id → an advertised model id.
    pub model: BTreeMap<String, String>,
    /// backend id → a value of the agent's `thought_level` config option.
    pub effort: BTreeMap<String, String>,
}

// Hand-written, NOT `#[derive(Default)]`: derive would resolve `version` to 0.
impl Default for LaneModelMemory {
    fn default() -> Self {
        Self {
            version: 1,
            model: BTreeMap::new(),
            effort: BTreeMap::new(),
        }
    }
}

/// `~/.config/krypton/acp-lane-models.toml`.
pub fn memory_path() -> Option<PathBuf> {
    config_dir().map(|d| d.join(FILE_NAME))
}

/// Spawn-side read. A missing file is empty memory; an unreadable or
/// unparseable one is logged and ignored, so the lane falls back to
/// `krypton.toml` and the agent default.
pub fn load() -> LaneModelMemory {
    let Some(path) = memory_path() else {
        return LaneModelMemory::default();
    };
    match read_at(&path) {
        Ok(memory) => memory,
        Err(e) => {
            log::warn!("{e}; ignoring remembered lane models");
            LaneModelMemory::default()
        }
    }
}

/// Record a confirmed picker choice for `backend_id`. `None` (or empty) leaves
/// that half untouched. Never overwrites a file it could not parse — that
/// would destroy the user's hand edits.
pub fn remember(
    backend_id: &str,
    model_id: Option<&str>,
    effort: Option<&str>,
) -> Result<(), String> {
    let path = memory_path().ok_or_else(|| "Could not determine config directory".to_string())?;
    remember_at(&path, backend_id, model_id, effort)
}

fn remember_at(
    path: &Path,
    backend_id: &str,
    model_id: Option<&str>,
    effort: Option<&str>,
) -> Result<(), String> {
    let model_id = model_id.map(str::trim).filter(|s| !s.is_empty());
    let effort = effort.map(str::trim).filter(|s| !s.is_empty());
    if model_id.is_none() && effort.is_none() {
        return Ok(());
    }
    let _guard = WRITE_LOCK.lock().unwrap_or_else(|p| p.into_inner());
    let mut memory = read_at(path)?;
    memory.version = memory.version.max(1);
    if let Some(model_id) = model_id {
        memory
            .model
            .insert(backend_id.to_string(), model_id.to_string());
    }
    if let Some(effort) = effort {
        memory
            .effort
            .insert(backend_id.to_string(), effort.to_string());
    }
    save_at(path, &memory)
}

fn read_at(path: &Path) -> Result<LaneModelMemory, String> {
    let contents = match fs::read_to_string(path) {
        Ok(contents) => contents,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
            return Ok(LaneModelMemory::default());
        }
        Err(e) => return Err(format!("Failed to read {}: {e}", path.display())),
    };
    toml::from_str(&contents).map_err(|e| format!("Failed to parse {}: {e}", path.display()))
}

/// Atomic save: write `<path>.tmp`, then rename over the target. `rename`
/// replaces an existing file on every supported platform; the directory is not
/// opened to fsync it (POSIX-only).
fn save_at(path: &Path, memory: &LaneModelMemory) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)
            .map_err(|e| format!("Failed to create {}: {e}", parent.display()))?;
    }
    let body = toml::to_string_pretty(memory)
        .map_err(|e| format!("Failed to serialize lane models: {e}"))?;
    let tmp = path.with_extension("toml.tmp");
    fs::write(&tmp, format!("{HEADER}{body}"))
        .map_err(|e| format!("Failed to write {}: {e}", tmp.display()))?;
    fs::rename(&tmp, path).map_err(|e| format!("Failed to commit {}: {e}", path.display()))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_path(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "krypton-lane-models-{name}-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|d| d.as_nanos())
                .unwrap_or(0)
        ));
        fs::create_dir_all(&dir).unwrap();
        dir.join(FILE_NAME)
    }

    #[test]
    fn missing_file_reads_as_empty_memory() {
        let path = temp_path("missing");
        assert_eq!(read_at(&path).unwrap(), LaneModelMemory::default());
    }

    #[test]
    fn remember_creates_the_file_with_header_and_both_tables() {
        let path = temp_path("create");
        remember_at(&path, "claude", Some("opus"), Some("xhigh")).unwrap();

        let text = fs::read_to_string(&path).unwrap();
        assert!(text.starts_with("# Managed by Krypton (spec 388)"));
        let memory = read_at(&path).unwrap();
        assert_eq!(memory.version, 1);
        assert_eq!(memory.model.get("claude").map(String::as_str), Some("opus"));
        assert_eq!(
            memory.effort.get("claude").map(String::as_str),
            Some("xhigh")
        );
        assert!(!path.with_extension("toml.tmp").exists());
    }

    #[test]
    fn remember_keeps_other_backends_and_the_untouched_half() {
        let path = temp_path("merge");
        remember_at(&path, "claude", Some("opus"), Some("high")).unwrap();
        remember_at(&path, "cline", Some("gpt-5.6-terra"), None).unwrap();
        remember_at(&path, "claude", None, Some("max")).unwrap();

        let memory = read_at(&path).unwrap();
        assert_eq!(memory.model.get("claude").map(String::as_str), Some("opus"));
        assert_eq!(memory.effort.get("claude").map(String::as_str), Some("max"));
        assert_eq!(
            memory.model.get("cline").map(String::as_str),
            Some("gpt-5.6-terra")
        );
        assert!(!memory.effort.contains_key("cline"));
    }

    #[test]
    fn remember_with_nothing_to_record_does_not_create_the_file() {
        let path = temp_path("noop");
        remember_at(&path, "claude", None, Some("  ")).unwrap();
        assert!(!path.exists());
    }

    #[test]
    fn remember_refuses_to_overwrite_an_unparseable_file() {
        let path = temp_path("broken");
        let broken = "[model]\nclaude = \"opus\"\n[[[ hand edit gone wrong\n";
        fs::write(&path, broken).unwrap();

        assert!(remember_at(&path, "claude", Some("sonnet"), None).is_err());
        assert_eq!(fs::read_to_string(&path).unwrap(), broken);
    }

    #[test]
    fn a_wrong_value_type_is_unparseable_too() {
        let path = temp_path("type");
        fs::write(&path, "[effort]\nclaude = 3\n").unwrap();
        assert!(read_at(&path).is_err());
    }

    #[test]
    fn hand_written_file_without_version_or_effort_parses() {
        let path = temp_path("hand");
        fs::write(&path, "[model]\nomp = \"anthropic/claude-opus-5-5\"\n").unwrap();
        let memory = read_at(&path).unwrap();
        assert_eq!(memory.version, 1);
        assert_eq!(
            memory.model.get("omp").map(String::as_str),
            Some("anthropic/claude-opus-5-5")
        );
        assert!(memory.effort.is_empty());
    }
}
