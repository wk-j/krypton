//! Durable, local review rounds (spec 270). The diff is immutable; comments and
//! verdicts live outside publishable Review Board bundles.

use crate::git::{
    collect_review_snapshot, collect_review_snapshot_fixed, ReviewSnapshot, SkippedFile,
};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::{Mutex, OnceLock};

static WRITE_LOCK: OnceLock<Mutex<()>> = OnceLock::new();

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReviewLineComment {
    pub id: String,
    pub file: String,
    pub side: String,
    pub line_start: u32,
    pub line_end: u32,
    pub quote: String,
    pub body: String,
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReviewVerdict {
    pub id: String,
    pub kind: String,
    pub summary: String,
    pub snapshot_hash: String,
    pub submitted_at: i64,
    pub line_comments: Vec<ReviewLineComment>,
    pub board_response: Value,
    pub omitted: Vec<SkippedFileRecord>,
    pub delivery: String,
    pub handed_off_at: Option<i64>,
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SkippedFileRecord {
    pub path: String,
    pub reason: String,
}

impl From<SkippedFile> for SkippedFileRecord {
    fn from(value: SkippedFile) -> Self {
        Self {
            path: value.path,
            reason: value.reason,
        }
    }
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReviewThread {
    pub schema_version: u8,
    pub id: String,
    pub repo_root: String,
    pub parent_backend_id: String,
    pub parent_session_id: String,
    pub parent_lane_name: String,
    pub previous_thread_id: Option<String>,
    pub phase: String,
    pub review_id: Option<String>,
    pub review_slug: Option<String>,
    pub review_dir: Option<String>,
    pub base_ref: String,
    pub base_oid: String,
    pub head_oid: Option<String>,
    pub snapshot_hash: String,
    pub created_at: i64,
    pub omitted: Vec<SkippedFileRecord>,
    pub line_comments: Vec<ReviewLineComment>,
    pub verdicts: Vec<ReviewVerdict>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ThreadRead {
    pub thread: ReviewThread,
    pub diff: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ThreadCheck {
    pub stale: bool,
    pub current_hash: String,
    pub omitted: Vec<SkippedFileRecord>,
}

fn now_ms() -> i64 {
    chrono::Utc::now().timestamp_millis()
}

fn root_for(cwd: &str) -> Result<PathBuf, String> {
    let root =
        crate::git::repo_root(Path::new(cwd)).ok_or_else(|| "not a git repository".to_string())?;
    Path::new(&root)
        .canonicalize()
        .map_err(|e| format!("repo unavailable: {e}"))
}

fn thread_root(repo: &Path) -> PathBuf {
    repo.join(".krypton").join("review-threads")
}

fn valid_id(id: &str) -> bool {
    id.starts_with("rt-")
        && id.len() <= 80
        && id.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-')
}

fn thread_dir(repo: &Path, id: &str) -> Result<PathBuf, String> {
    if !valid_id(id) {
        return Err("invalid review thread id".to_string());
    }
    let root = thread_root(repo);
    let dir = root.join(id);
    let canonical_root = root
        .canonicalize()
        .map_err(|e| format!("thread root unavailable: {e}"))?;
    let canonical_dir = dir
        .canonicalize()
        .map_err(|e| format!("thread unavailable: {e}"))?;
    if canonical_dir.parent() != Some(canonical_root.as_path()) {
        return Err("thread path escaped review root".to_string());
    }
    Ok(canonical_dir)
}

fn ensure_root(repo: &Path) -> Result<PathBuf, String> {
    let root = thread_root(repo);
    fs::create_dir_all(&root).map_err(|e| format!("cannot create review root: {e}"))?;
    let canonical = root
        .canonicalize()
        .map_err(|e| format!("review root unavailable: {e}"))?;
    if !canonical.starts_with(repo) {
        return Err("review root escaped repository".to_string());
    }
    let ignore = canonical.join(".gitignore");
    if ignore
        .symlink_metadata()
        .is_ok_and(|m| m.file_type().is_symlink())
    {
        return Err("review ignore file is a symlink".to_string());
    }
    fs::write(ignore, "*\n").map_err(|e| format!("cannot ignore private review data: {e}"))?;
    Ok(canonical)
}

fn atomic_json(path: &Path, thread: &ReviewThread) -> Result<(), String> {
    let bytes = serde_json::to_vec_pretty(thread).map_err(|e| e.to_string())?;
    let mut random = [0_u8; 4];
    getrandom::getrandom(&mut random).map_err(|e| format!("cannot allocate temp file: {e}"))?;
    let tmp = path.with_extension(format!("json.{:08x}.tmp", u32::from_be_bytes(random)));
    let result = (|| {
        let mut file = fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&tmp)
            .map_err(|e| format!("cannot create thread temp file: {e}"))?;
        file.write_all(&bytes)
            .map_err(|e| format!("cannot write thread: {e}"))?;
        file.sync_all()
            .map_err(|e| format!("cannot sync thread: {e}"))?;
        fs::rename(&tmp, path).map_err(|e| format!("cannot replace thread: {e}"))
    })();
    if result.is_err() {
        let _ = fs::remove_file(&tmp);
    }
    result
}

fn read_at(dir: &Path) -> Result<ReviewThread, String> {
    let path = dir.join("thread.json");
    if path
        .symlink_metadata()
        .map_err(|e| e.to_string())?
        .file_type()
        .is_symlink()
    {
        return Err("thread metadata is a symlink".to_string());
    }
    let bytes = fs::read(path).map_err(|e| format!("cannot read thread: {e}"))?;
    let thread: ReviewThread =
        serde_json::from_slice(&bytes).map_err(|e| format!("invalid thread: {e}"))?;
    if thread.schema_version != 1 {
        return Err("unsupported thread schema".to_string());
    }
    Ok(thread)
}

fn load(cwd: &str, id: &str) -> Result<(PathBuf, ReviewThread), String> {
    let repo = root_for(cwd)?;
    let dir = thread_dir(&repo, id)?;
    let thread = read_at(&dir)?;
    if thread.id != id || thread.repo_root != repo.to_string_lossy() {
        return Err("thread identity does not match repository".to_string());
    }
    Ok((dir, thread))
}

fn stable_snapshot(cwd: &str, base: &str) -> Result<ReviewSnapshot, String> {
    for _ in 0..2 {
        let first = collect_review_snapshot(cwd, base)?;
        let second = collect_review_snapshot(cwd, base)?;
        if first.fingerprint == second.fingerprint {
            return Ok(second);
        }
    }
    Err("workspace changed while collecting review snapshot".to_string())
}

pub fn preview(cwd: &str, base: &str) -> Result<ReviewSnapshot, String> {
    stable_snapshot(cwd, base)
}

pub fn create(
    cwd: &str,
    base: &str,
    fingerprint: &str,
    backend_id: &str,
    session_id: &str,
    lane_name: &str,
) -> Result<ReviewThread, String> {
    if backend_id.is_empty() || session_id.is_empty() || lane_name.is_empty() {
        return Err("parent ACP session is required".to_string());
    }
    let _guard = WRITE_LOCK
        .get_or_init(|| Mutex::new(()))
        .lock()
        .map_err(|e| e.to_string())?;
    let snapshot = stable_snapshot(cwd, base)?;
    if snapshot.fingerprint != fingerprint {
        return Err("workspace changed since review preview; reopen preview".to_string());
    }
    let repo = root_for(cwd)?;
    let root = ensure_root(&repo)?;
    let previous_thread_id = list(cwd)?
        .into_iter()
        .find(|t| t.parent_session_id == session_id && t.parent_backend_id == backend_id)
        .map(|t| t.id);
    let mut random = [0_u8; 4];
    getrandom::getrandom(&mut random).map_err(|e| format!("cannot allocate thread ID: {e}"))?;
    let id = format!("rt-{}-{:08x}", now_ms(), u32::from_be_bytes(random));
    let dir = root.join(&id);
    fs::create_dir(&dir).map_err(|e| format!("cannot create thread: {e}"))?;
    let thread = ReviewThread {
        schema_version: 1,
        id,
        repo_root: repo.to_string_lossy().into_owned(),
        parent_backend_id: backend_id.to_string(),
        parent_session_id: session_id.to_string(),
        parent_lane_name: lane_name.to_string(),
        previous_thread_id,
        phase: "preparing".to_string(),
        review_id: None,
        review_slug: None,
        review_dir: None,
        base_ref: snapshot.base_ref,
        base_oid: snapshot.base_oid,
        head_oid: snapshot.head_oid,
        snapshot_hash: snapshot.fingerprint,
        created_at: now_ms(),
        omitted: snapshot.omitted.into_iter().map(Into::into).collect(),
        line_comments: Vec::new(),
        verdicts: Vec::new(),
    };
    let write_result = fs::write(dir.join("snapshot.diff"), snapshot.diff)
        .map_err(|e| format!("cannot write snapshot: {e}"))
        .and_then(|_| atomic_json(&dir.join("thread.json"), &thread));
    if let Err(error) = write_result {
        let _ = fs::remove_dir_all(&dir);
        return Err(error);
    }
    Ok(thread)
}

pub fn attach_board(
    cwd: &str,
    id: &str,
    review_id: &str,
    slug: &str,
    dir: &str,
) -> Result<(), String> {
    let _guard = WRITE_LOCK
        .get_or_init(|| Mutex::new(()))
        .lock()
        .map_err(|e| e.to_string())?;
    let (path, mut thread) = load(cwd, id)?;
    thread.review_id = Some(review_id.to_string());
    thread.review_slug = Some(slug.to_string());
    thread.review_dir = Some(dir.to_string());
    thread.phase = "preparing".to_string();
    atomic_json(&path.join("thread.json"), &thread)
}

pub fn remove(cwd: &str, id: &str) -> Result<(), String> {
    let (dir, _) = load(cwd, id)?;
    fs::remove_dir_all(dir).map_err(|e| e.to_string())
}

pub fn list(cwd: &str) -> Result<Vec<ReviewThread>, String> {
    let repo = root_for(cwd)?;
    let root = thread_root(&repo);
    if !root.exists() {
        return Ok(Vec::new());
    }
    let mut out = Vec::new();
    for entry in fs::read_dir(&root).map_err(|e| e.to_string())? {
        let entry = entry.map_err(|e| e.to_string())?;
        let id = entry.file_name().to_string_lossy().to_string();
        if !valid_id(&id) {
            continue;
        }
        if let Ok((_, thread)) = load(cwd, &id) {
            out.push(thread);
        }
    }
    out.sort_by_key(|thread| std::cmp::Reverse(thread.created_at));
    Ok(out)
}

pub fn read(cwd: &str, id: &str) -> Result<ThreadRead, String> {
    let (dir, thread) = load(cwd, id)?;
    let path = dir.join("snapshot.diff");
    if path
        .symlink_metadata()
        .map_err(|e| e.to_string())?
        .file_type()
        .is_symlink()
    {
        return Err("snapshot is a symlink".to_string());
    }
    let diff = fs::read_to_string(path).map_err(|e| format!("cannot read snapshot: {e}"))?;
    if diff.len() > 4 * 1024 * 1024 {
        return Err("review snapshot exceeds 4 MiB".to_string());
    }
    let mut hasher = Sha256::new();
    hasher.update(thread.base_oid.as_bytes());
    hasher.update(diff.as_bytes());
    for entry in &thread.omitted {
        hasher.update(entry.path.as_bytes());
        hasher.update(entry.reason.as_bytes());
    }
    if format!("{:x}", hasher.finalize()) != thread.snapshot_hash {
        return Err("review snapshot hash mismatch".to_string());
    }
    Ok(ThreadRead { thread, diff })
}

pub fn save_draft(cwd: &str, id: &str, comments: Vec<ReviewLineComment>) -> Result<(), String> {
    let _guard = WRITE_LOCK
        .get_or_init(|| Mutex::new(()))
        .lock()
        .map_err(|e| e.to_string())?;
    let (dir, mut thread) = load(cwd, id)?;
    if comments.len() > 500
        || comments.iter().any(|c| {
            c.body.len() > 16_384
                || c.quote.len() > 2_000
                || c.file.len() > 4_096
                || c.line_start == 0
                || c.line_end < c.line_start
                || (c.side != "old" && c.side != "new")
        })
    {
        return Err("invalid review comments".to_string());
    }
    thread.line_comments = comments;
    atomic_json(&dir.join("thread.json"), &thread)
}

pub fn check(cwd: &str, id: &str) -> Result<ThreadCheck, String> {
    let (_, thread) = load(cwd, id)?;
    let mut current = collect_review_snapshot_fixed(cwd, &thread.base_oid, &thread.base_ref)?;
    let mut settled = false;
    for _ in 0..2 {
        let next = collect_review_snapshot_fixed(cwd, &thread.base_oid, &thread.base_ref)?;
        if current.fingerprint == next.fingerprint {
            current = next;
            settled = true;
            break;
        }
        current = next;
    }
    if !settled {
        return Err("workspace changed while checking review snapshot".to_string());
    }
    Ok(ThreadCheck {
        stale: current.fingerprint != thread.snapshot_hash,
        current_hash: current.fingerprint,
        omitted: current.omitted.into_iter().map(Into::into).collect(),
    })
}

pub fn submit(
    cwd: &str,
    id: &str,
    kind: &str,
    summary: &str,
    response: Value,
    accept_omitted: bool,
) -> Result<ReviewVerdict, String> {
    if kind != "approve" && kind != "request_changes" {
        return Err("invalid verdict".to_string());
    }
    if summary.trim().is_empty() || summary.len() > 16_384 {
        return Err("verdict summary is required (max 16 KiB)".to_string());
    }
    if serde_json::to_vec(&response)
        .map_err(|e| e.to_string())?
        .len()
        > 1_048_576
    {
        return Err("Review Board response exceeds 1 MiB".to_string());
    }
    if kind == "approve" {
        let state = check(cwd, id)?;
        if state.stale {
            return Err("review snapshot is stale; start a new round".to_string());
        }
    }
    let _guard = WRITE_LOCK
        .get_or_init(|| Mutex::new(()))
        .lock()
        .map_err(|e| e.to_string())?;
    let (dir, mut thread) = load(cwd, id)?;
    if thread.phase != "ready" && kind == "approve" {
        return Err("Guide is not ready".to_string());
    }
    if kind == "approve" && !thread.omitted.is_empty() && !accept_omitted {
        return Err("confirm omitted files were checked separately".to_string());
    }
    let verdict = ReviewVerdict {
        id: format!("rv-{}-{}", now_ms(), thread.verdicts.len() + 1),
        kind: kind.to_string(),
        summary: summary.trim().to_string(),
        snapshot_hash: thread.snapshot_hash.clone(),
        submitted_at: now_ms(),
        line_comments: thread.line_comments.clone(),
        board_response: response,
        omitted: thread.omitted.clone(),
        delivery: "pending".to_string(),
        handed_off_at: None,
    };
    thread.verdicts.push(verdict.clone());
    atomic_json(&dir.join("thread.json"), &thread)?;
    Ok(verdict)
}

pub fn mark_delivery(cwd: &str, id: &str, verdict_id: &str, state: &str) -> Result<(), String> {
    if !matches!(state, "queued" | "handed_off" | "uncertain") {
        return Err("invalid delivery state".to_string());
    }
    let _guard = WRITE_LOCK
        .get_or_init(|| Mutex::new(()))
        .lock()
        .map_err(|e| e.to_string())?;
    let (dir, mut thread) = load(cwd, id)?;
    let verdict = thread
        .verdicts
        .iter_mut()
        .find(|v| v.id == verdict_id)
        .ok_or_else(|| "verdict not found".to_string())?;
    verdict.delivery = state.to_string();
    if state == "handed_off" {
        verdict.handed_off_at = Some(now_ms());
    }
    atomic_json(&dir.join("thread.json"), &thread)
}

pub fn mark_guide(cwd: &str, id: &str, ready: bool) -> Result<(), String> {
    let _guard = WRITE_LOCK
        .get_or_init(|| Mutex::new(()))
        .lock()
        .map_err(|e| e.to_string())?;
    let (dir, mut thread) = load(cwd, id)?;
    thread.phase = if ready { "ready" } else { "guide_failed" }.to_string();
    atomic_json(&dir.join("thread.json"), &thread)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::process::Command;
    use std::time::{SystemTime, UNIX_EPOCH};

    fn git(dir: &Path, args: &[&str]) {
        let output = Command::new("git")
            .args(args)
            .current_dir(dir)
            .output()
            .expect("git");
        assert!(
            output.status.success(),
            "git {args:?}: {}",
            String::from_utf8_lossy(&output.stderr)
        );
    }

    fn repo() -> PathBuf {
        let unique = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("clock")
            .as_nanos();
        let dir = std::env::temp_dir().join(format!(
            "krypton-review-thread-{}-{unique}",
            std::process::id()
        ));
        fs::create_dir_all(&dir).expect("create repo");
        git(&dir, &["init", "-q"]);
        git(&dir, &["config", "user.email", "t@t"]);
        git(&dir, &["config", "user.name", "t"]);
        fs::write(dir.join("file.txt"), "first\n").expect("seed");
        git(&dir, &["add", "."]);
        git(&dir, &["commit", "-qm", "base"]);
        dir
    }

    #[test]
    fn thread_keeps_snapshot_and_blocks_stale_approval() {
        let dir = repo();
        fs::write(dir.join("file.txt"), "second\n").expect("change");
        let cwd = dir.to_str().expect("utf8");
        let before = preview(cwd, "head").expect("preview");
        let thread = create(
            cwd,
            "head",
            &before.fingerprint,
            "backend",
            "session",
            "Codex-1",
        )
        .expect("create");
        attach_board(cwd, &thread.id, "rev-1", "slug", "/tmp/review").expect("attach");
        mark_guide(cwd, &thread.id, true).expect("guide ready");
        save_draft(
            cwd,
            &thread.id,
            vec![ReviewLineComment {
                id: "c-1".to_string(),
                file: "file.txt".to_string(),
                side: "new".to_string(),
                line_start: 1,
                line_end: 1,
                quote: "second".to_string(),
                body: "Please check".to_string(),
            }],
        )
        .expect("save draft");
        let verdict = submit(
            cwd,
            &thread.id,
            "request_changes",
            "Fix this",
            serde_json::json!({}),
            false,
        )
        .expect("submit request");
        assert_eq!(verdict.line_comments.len(), 1);
        let initial = read(cwd, &thread.id).expect("read");
        assert_eq!(initial.thread.verdicts.len(), 1);
        fs::write(dir.join("file.txt"), "third\n").expect("change again");
        assert!(check(cwd, &thread.id).expect("check").stale);
        assert!(submit(
            cwd,
            &thread.id,
            "approve",
            "Looks good",
            serde_json::json!({}),
            true
        )
        .is_err());
        assert_eq!(
            read(cwd, &thread.id).expect("read fixed diff").diff,
            initial.diff
        );
        fs::remove_dir_all(dir).expect("cleanup");
    }

    #[test]
    fn create_rejects_preview_that_changed() {
        let dir = repo();
        fs::write(dir.join("file.txt"), "second\n").expect("change");
        let cwd = dir.to_str().expect("utf8");
        let before = preview(cwd, "head").expect("preview");
        fs::write(dir.join("file.txt"), "third\n").expect("change again");
        assert!(create(
            cwd,
            "head",
            &before.fingerprint,
            "backend",
            "session",
            "Codex-1"
        )
        .is_err());
        assert!(!thread_root(&dir).exists());
        fs::remove_dir_all(dir).expect("cleanup");
    }

    #[test]
    fn omitted_binary_requires_confirmation_for_approval() {
        let dir = repo();
        fs::write(dir.join("binary.bin"), b"hello\0world").expect("binary");
        let cwd = dir.to_str().expect("utf8");
        let before = preview(cwd, "head").expect("preview");
        assert_eq!(before.omitted.len(), 1);
        assert_eq!(before.omitted[0].reason, "binary");
        let thread = create(
            cwd,
            "head",
            &before.fingerprint,
            "backend",
            "session",
            "Codex-1",
        )
        .expect("create");
        mark_guide(cwd, &thread.id, true).expect("guide ready");
        assert!(submit(
            cwd,
            &thread.id,
            "approve",
            "Reviewed",
            serde_json::json!({}),
            false,
        )
        .is_err());
        let verdict = submit(
            cwd,
            &thread.id,
            "approve",
            "Reviewed separately",
            serde_json::json!({}),
            true,
        )
        .expect("confirmed approval");
        assert_eq!(verdict.omitted.len(), 1);
        fs::remove_dir_all(dir).expect("cleanup");
    }

    #[test]
    fn oversized_tracked_diff_is_rejected_before_thread_creation() {
        let dir = repo();
        fs::write(dir.join("file.txt"), "x".repeat(4 * 1024 * 1024 + 1)).expect("large edit");
        let cwd = dir.to_str().expect("utf8");
        assert!(preview(cwd, "head")
            .err()
            .expect("oversized snapshot error")
            .contains("4 MiB"));
        assert!(!thread_root(&dir).exists());
        fs::remove_dir_all(dir).expect("cleanup");
    }

    #[test]
    fn moving_upstream_ref_does_not_stale_a_fixed_snapshot() {
        let dir = repo();
        git(&dir, &["branch", "review-base"]);
        git(&dir, &["checkout", "-qb", "feature"]);
        fs::write(dir.join("file.txt"), "feature\n").expect("feature");
        git(&dir, &["commit", "-qam", "feature"]);
        git(
            &dir,
            &["branch", "--set-upstream-to=review-base", "feature"],
        );
        let cwd = dir.to_str().expect("utf8");
        let before = preview(cwd, "upstream").expect("preview");
        let thread = create(
            cwd,
            "upstream",
            &before.fingerprint,
            "backend",
            "session",
            "Codex-1",
        )
        .expect("create");
        git(&dir, &["branch", "-f", "review-base", "HEAD"]);
        assert!(!check(cwd, &thread.id).expect("check original OID").stale);
        fs::remove_dir_all(dir).expect("cleanup");
    }
}
