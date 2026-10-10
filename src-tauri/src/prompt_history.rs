// Krypton — ACP Harness prompt history (spec 285)
//
// One SQLite store for every prompt submitted from the harness composer, from
// any lane / backend / Harness view, at `~/.config/krypton/harness-prompt-history.db`.
// It feeds the composer's word-autocomplete model together with read-only
// seed corpora the user already has (Claude Code, Codex, OMP prompt history).

use crate::util::lock::lock_mutex;
use rusqlite::{params, Connection, OpenFlags, OptionalExtension};
use std::io::{BufRead, BufReader};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

/// Rows kept in the Krypton store; older rows (by last use) are trimmed.
const MAX_ROWS: i64 = 20_000;
/// Prompts above this size are pastes, not vocabulary.
const MAX_PROMPT_BYTES: usize = 8 * 1024;
/// Newest text kept in the corpus handed to the frontend model.
const MAX_CORPUS_BYTES: usize = 4 * 1024 * 1024;

const SCHEMA: &str = "
CREATE TABLE IF NOT EXISTS prompt_history (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    prompt TEXT NOT NULL UNIQUE,
    created_at INTEGER NOT NULL,
    use_count INTEGER NOT NULL DEFAULT 1,
    backend_id TEXT,
    cwd TEXT
);
CREATE INDEX IF NOT EXISTS idx_prompt_history_created_at ON prompt_history(created_at DESC);
PRAGMA user_version = 1;
";

pub struct PromptHistoryStore {
    path: Option<PathBuf>,
    conn: Mutex<Option<Connection>>,
}

impl PromptHistoryStore {
    pub fn new() -> Self {
        Self::at(crate::config::config_dir().map(|d| d.join("harness-prompt-history.db")))
    }

    fn at(path: Option<PathBuf>) -> Self {
        Self {
            path,
            conn: Mutex::new(None),
        }
    }

    /// Record a submitted prompt. Returns `true` when it is a new row (the
    /// frontend model observes only new rows, mirroring OMP's once-per-row ingest).
    fn log(&self, text: &str, backend_id: Option<&str>, cwd: Option<&str>) -> Result<bool, String> {
        let Some(prompt) = loggable_prompt(text) else {
            return Ok(false);
        };
        let mut guard = lock_mutex(&self.conn, "PromptHistoryStore")?;
        if guard.is_none() {
            let path = self
                .path
                .as_deref()
                .ok_or_else(|| "no home directory for prompt history".to_string())?;
            *guard = Some(open_store(path)?);
        }
        let conn = guard
            .as_mut()
            .ok_or_else(|| "prompt history store unavailable".to_string())?;
        insert_prompt(conn, prompt, backend_id, cwd, unix_now(), MAX_ROWS)
            .map_err(|e| e.to_string())
    }

    fn krypton_prompts(&self) -> Vec<String> {
        let Some(path) = self.path.as_deref() else {
            return Vec::new();
        };
        // Prefer the live connection so a just-created store is readable even
        // before the WAL checkpoints; fall back to a read-only open.
        if let Ok(guard) = lock_mutex(&self.conn, "PromptHistoryStore") {
            if let Some(conn) = guard.as_ref() {
                return read_prompts(conn, "SELECT prompt FROM prompt_history ORDER BY id")
                    .unwrap_or_default();
            }
        }
        read_sqlite_prompts(path, "SELECT prompt FROM prompt_history ORDER BY id")
    }
}

impl Default for PromptHistoryStore {
    fn default() -> Self {
        Self::new()
    }
}

fn unix_now() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0)
}

/// Commands (`/`), harness commands (`#`), shell escapes (`!`), and pastes are
/// not vocabulary.
fn loggable_prompt(text: &str) -> Option<&str> {
    let prompt = text.trim();
    if prompt.is_empty() || prompt.len() > MAX_PROMPT_BYTES {
        return None;
    }
    if prompt.starts_with('/') || prompt.starts_with('#') || prompt.starts_with('!') {
        return None;
    }
    Some(prompt)
}

fn open_store(path: &Path) -> Result<Connection, String> {
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir).map_err(|e| format!("create {}: {e}", dir.display()))?;
    }
    // Create the file 0600 up front: prompts can contain anything the user
    // typed. SQLite gives the -wal/-shm files the database file's mode.
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        std::fs::OpenOptions::new()
            .create(true)
            .append(true)
            .mode(0o600)
            .open(path)
            .map_err(|e| format!("create {}: {e}", path.display()))?;
    }
    let conn = Connection::open(path).map_err(|e| format!("open {}: {e}", path.display()))?;
    conn.busy_timeout(Duration::from_millis(2000))
        .map_err(|e| e.to_string())?;
    conn.pragma_update(None, "journal_mode", "WAL")
        .map_err(|e| e.to_string())?;
    conn.execute_batch(SCHEMA).map_err(|e| e.to_string())?;
    Ok(conn)
}

fn insert_prompt(
    conn: &mut Connection,
    prompt: &str,
    backend_id: Option<&str>,
    cwd: Option<&str>,
    now: i64,
    max_rows: i64,
) -> rusqlite::Result<bool> {
    let tx = conn.transaction()?;
    let existed = tx
        .query_row(
            "SELECT id FROM prompt_history WHERE prompt = ?1",
            params![prompt],
            |row| row.get::<_, i64>(0),
        )
        .optional()?
        .is_some();
    tx.execute(
        "INSERT INTO prompt_history (prompt, created_at, use_count, backend_id, cwd)
         VALUES (?1, ?2, 1, ?3, ?4)
         ON CONFLICT(prompt) DO UPDATE SET
           use_count = use_count + 1,
           created_at = excluded.created_at,
           backend_id = excluded.backend_id,
           cwd = excluded.cwd",
        params![prompt, now, backend_id, cwd],
    )?;
    tx.execute(
        "DELETE FROM prompt_history WHERE id IN (
           SELECT id FROM prompt_history ORDER BY created_at DESC, id DESC LIMIT -1 OFFSET ?1
         )",
        params![max_rows],
    )?;
    tx.commit()?;
    Ok(!existed)
}

fn read_prompts(conn: &Connection, sql: &str) -> rusqlite::Result<Vec<String>> {
    let mut stmt = conn.prepare(sql)?;
    let rows = stmt.query_map([], |row| row.get::<_, String>(0))?;
    rows.collect()
}

fn read_sqlite_prompts(path: &Path, sql: &str) -> Vec<String> {
    if !path.exists() {
        return Vec::new();
    }
    let result = Connection::open_with_flags(
        path,
        OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_NO_MUTEX,
    )
    .and_then(|conn| {
        conn.busy_timeout(Duration::from_millis(200))?;
        read_prompts(&conn, sql)
    });
    match result {
        Ok(rows) => rows,
        Err(e) => {
            log::debug!("prompt corpus: skipping {}: {e}", path.display());
            Vec::new()
        }
    }
}

/// Read `field` from each line of a JSONL prompt-history file (Claude Code
/// `display`, Codex `text`).
fn read_jsonl_prompts(path: &Path, field: &str) -> Vec<String> {
    let file = match std::fs::File::open(path) {
        Ok(file) => file,
        Err(e) => {
            if e.kind() != std::io::ErrorKind::NotFound {
                log::debug!("prompt corpus: skipping {}: {e}", path.display());
            }
            return Vec::new();
        }
    };
    BufReader::new(file)
        .lines()
        .map_while(Result::ok)
        .filter_map(|line| {
            let value: serde_json::Value = serde_json::from_str(&line).ok()?;
            value.get(field)?.as_str().map(str::to_owned)
        })
        .collect()
}

/// Drop `[Pasted text #n …]` / `[Image #n …]` placeholders (Claude Code / OMP
/// paste markers) and command lines; `None` when nothing word-like is left.
fn clean_corpus_text(text: &str) -> Option<String> {
    let trimmed = text.trim();
    if trimmed.is_empty() || trimmed.starts_with('/') {
        return None;
    }
    let mut out = String::with_capacity(trimmed.len());
    let mut rest = trimmed;
    while let Some(start) = rest.find('[') {
        let tail = &rest[start..];
        let is_marker = tail.starts_with("[Pasted text #") || tail.starts_with("[Image #");
        match (is_marker, tail.find(']')) {
            (true, Some(end)) => {
                out.push_str(&rest[..start]);
                out.push(' ');
                rest = &tail[end + 1..];
            }
            _ => {
                out.push_str(&rest[..=start]);
                rest = &rest[start + 1..];
            }
        }
    }
    out.push_str(rest);
    let cleaned = out.trim();
    (!cleaned.is_empty()).then(|| cleaned.to_string())
}

struct CorpusSources {
    claude_history: Option<PathBuf>,
    codex_history: Option<PathBuf>,
    omp_history: Option<PathBuf>,
}

impl CorpusSources {
    fn from_home() -> Self {
        let home = dirs::home_dir();
        Self {
            claude_history: home
                .as_ref()
                .map(|h| h.join(".claude").join("history.jsonl")),
            codex_history: home
                .as_ref()
                .map(|h| h.join(".codex").join("history.jsonl")),
            omp_history: home
                .as_ref()
                .map(|h| h.join(".omp").join("agent").join("history.db")),
        }
    }
}

/// Oldest-first corpus: seed sources first, the Krypton store last, capped to
/// the newest `MAX_CORPUS_BYTES`.
fn load_corpus(sources: &CorpusSources, krypton: Vec<String>) -> Vec<String> {
    let mut texts: Vec<String> = Vec::new();
    if let Some(path) = &sources.claude_history {
        texts.extend(read_jsonl_prompts(path, "display"));
    }
    if let Some(path) = &sources.codex_history {
        texts.extend(read_jsonl_prompts(path, "text"));
    }
    if let Some(path) = &sources.omp_history {
        texts.extend(read_sqlite_prompts(
            path,
            "SELECT prompt FROM history ORDER BY id",
        ));
    }
    texts.extend(krypton);
    let mut cleaned: Vec<String> = texts.iter().filter_map(|t| clean_corpus_text(t)).collect();
    let mut total: usize = cleaned.iter().map(String::len).sum();
    let mut drop = 0;
    while total > MAX_CORPUS_BYTES && drop < cleaned.len() {
        total -= cleaned[drop].len();
        drop += 1;
    }
    cleaned.drain(..drop);
    cleaned
}

#[tauri::command]
pub async fn harness_prompt_log(
    state: tauri::State<'_, Arc<PromptHistoryStore>>,
    text: String,
    backend_id: Option<String>,
    cwd: Option<String>,
) -> Result<bool, String> {
    let store = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        store.log(&text, backend_id.as_deref(), cwd.as_deref())
    })
    .await
    .map_err(|e| format!("prompt history task failed: {e}"))?
}

#[tauri::command]
pub async fn harness_word_corpus(
    state: tauri::State<'_, Arc<PromptHistoryStore>>,
) -> Result<Vec<String>, String> {
    let store = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        load_corpus(&CorpusSources::from_home(), store.krypton_prompts())
    })
    .await
    .map_err(|e| format!("prompt corpus task failed: {e}"))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_dir(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "krypton-prompt-history-{name}-{}-{}",
            std::process::id(),
            unix_now()
        ));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).expect("temp dir");
        dir
    }

    fn no_sources() -> CorpusSources {
        CorpusSources {
            claude_history: None,
            codex_history: None,
            omp_history: None,
        }
    }

    #[test]
    fn repeated_prompt_is_one_row_and_only_first_is_new() {
        let dir = temp_dir("dedupe");
        let store = PromptHistoryStore::at(Some(dir.join("h.db")));
        assert!(store
            .log("fix the parser", Some("claude"), None)
            .expect("log"));
        assert!(store.log("other prompt", Some("codex"), None).expect("log"));
        assert!(!store
            .log("  fix the parser  ", Some("omp"), None)
            .expect("log"));
        assert_eq!(
            store.krypton_prompts(),
            vec!["fix the parser", "other prompt"]
        );
        let guard = store.conn.lock().expect("lock");
        let conn = guard.as_ref().expect("conn");
        let (count, backend): (i64, String) = conn
            .query_row(
                "SELECT use_count, backend_id FROM prompt_history WHERE prompt = 'fix the parser'",
                [],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .expect("row");
        assert_eq!(count, 2);
        assert_eq!(backend, "omp");
        drop(guard);
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn commands_shell_and_pastes_are_not_logged() {
        let dir = temp_dir("skip");
        let store = PromptHistoryStore::at(Some(dir.join("h.db")));
        for text in ["", "   ", "/model opus", "#review", "!ls -la"] {
            assert!(!store.log(text, None, None).expect("log"), "{text:?}");
        }
        assert!(!store
            .log(&"x".repeat(MAX_PROMPT_BYTES + 1), None, None)
            .expect("log"));
        assert!(store.krypton_prompts().is_empty());
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn store_keeps_newest_rows_at_cap() {
        let dir = temp_dir("cap");
        let mut conn = open_store(&dir.join("h.db")).expect("open");
        for i in 0..8 {
            insert_prompt(&mut conn, &format!("prompt {i}"), None, None, i, 5).expect("insert");
        }
        let rows: i64 = conn
            .query_row("SELECT COUNT(*) FROM prompt_history", [], |r| r.get(0))
            .expect("count");
        assert_eq!(rows, 5);
        let oldest: String = conn
            .query_row(
                "SELECT prompt FROM prompt_history ORDER BY created_at LIMIT 1",
                [],
                |r| r.get(0),
            )
            .expect("oldest");
        assert_eq!(oldest, "prompt 3");
        let _ = std::fs::remove_dir_all(dir);
    }

    #[cfg(unix)]
    #[test]
    fn store_file_is_private() {
        use std::os::unix::fs::PermissionsExt;
        let dir = temp_dir("mode");
        let path = dir.join("h.db");
        open_store(&path).expect("open");
        let mode = std::fs::metadata(&path).expect("meta").permissions().mode();
        assert_eq!(mode & 0o777, 0o600);
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn corpus_reads_every_source_oldest_first_and_strips_markers() {
        let dir = temp_dir("corpus");
        let claude = dir.join("claude.jsonl");
        std::fs::write(
            &claude,
            "{\"display\":\"render [Pasted text #1 +20 lines] please\"}\n{\"display\":\"/clear\"}\nnot json\n",
        )
        .expect("claude");
        let codex = dir.join("codex.jsonl");
        std::fs::write(&codex, "{\"text\":\"codex words\"}\n").expect("codex");
        let omp = dir.join("omp.db");
        {
            let conn = Connection::open(&omp).expect("omp");
            conn.execute_batch(
                "CREATE TABLE history (id INTEGER PRIMARY KEY, prompt TEXT);
                 INSERT INTO history (prompt) VALUES ('omp words [Image #2]');",
            )
            .expect("omp schema");
        }
        let sources = CorpusSources {
            claude_history: Some(claude),
            codex_history: Some(codex),
            omp_history: Some(omp),
        };
        let corpus = load_corpus(&sources, vec!["krypton words".to_string()]);
        assert_eq!(
            corpus,
            vec![
                "render   please",
                "codex words",
                "omp words",
                "krypton words"
            ]
        );
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn missing_sources_are_skipped() {
        let sources = CorpusSources {
            claude_history: Some(PathBuf::from("/nonexistent/krypton/claude.jsonl")),
            codex_history: None,
            omp_history: Some(PathBuf::from("/nonexistent/krypton/omp.db")),
        };
        assert_eq!(load_corpus(&sources, Vec::new()), Vec::<String>::new());
        assert_eq!(load_corpus(&no_sources(), vec!["a b".into()]), vec!["a b"]);
    }

    #[test]
    fn corpus_cap_drops_oldest_text() {
        // Each chunk is a quarter of the cap; five of them plus "newest" only
        // fit once the two oldest chunks are dropped.
        let chunk = "w ".repeat(MAX_CORPUS_BYTES / 8);
        let mut texts = vec![chunk; 5];
        texts.push("newest".into());
        let corpus = load_corpus(&no_sources(), texts);
        assert_eq!(corpus.last().map(String::as_str), Some("newest"));
        assert!(corpus.iter().map(String::len).sum::<usize>() <= MAX_CORPUS_BYTES);
        assert_eq!(corpus.len(), 4);
    }
}
