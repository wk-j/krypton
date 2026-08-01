// Shared git working-tree helpers (spec 155).
//
// Owns the [[Working diff]] definition (CONTEXT.md): tracked changes plus
// untracked, non-ignored files rendered as pure additions. Both the Diff
// Window (`collect_working_diff`) and the `#review` git-state collection in
// `hook_server.rs` build on these primitives so the two surfaces can never
// drift apart on root resolution, git invocation, or binary detection.

use serde::Serialize;
use std::collections::{HashMap, HashSet};
use std::path::{Component, Path, PathBuf};
use std::process::Command;

/// Skip synthesizing an addition diff for untracked files larger than this —
/// the Diff Window lists them by name instead of rendering megabytes.
const UNTRACKED_MAX_BYTES: u64 = 1_048_576;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkingDiff {
    /// Canonical `--show-toplevel` of the repo — the matching key the
    /// frontend compares against a harness's resolved project root.
    pub repo_root: String,
    /// Unified diff: `git diff -M` (or `--staged`) with untracked files
    /// appended as synthesized new-file additions.
    pub diff: String,
    /// Untracked files whose content was deliberately not rendered.
    pub skipped: Vec<SkippedFile>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SkippedFile {
    pub path: String,
    /// "binary" | "too_large" | "unreadable"
    pub reason: String,
}

/// Live Git metadata for the file references rendered beneath an assistant
/// response (spec 207). This payload deliberately contains no diff content.
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ReferenceGitSnapshot {
    pub repo_root: String,
    pub changes: Vec<ReferenceGitChange>,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ReferenceGitChange {
    /// Original absolute target supplied by the deterministic reference model.
    pub target: String,
    /// Compact UI status: M | A | D | R | ? | !.
    pub status: String,
    pub added: Option<u64>,
    pub removed: Option<u64>,
    /// "lines" | "binary" | "unavailable".
    pub count_kind: String,
}

/// Run a git command in `cwd`, returning stdout on success and `None` on
/// spawn failure or non-zero exit. Pager/external-diff machinery is the
/// caller's responsibility (pass `--no-pager` / `--no-ext-diff` in `args`).
pub fn run_git(cwd: &Path, args: &[&str]) -> Option<String> {
    let out = Command::new("git")
        .args(args)
        .current_dir(cwd)
        .output()
        .ok()?;
    if !out.status.success() {
        return None;
    }
    String::from_utf8(out.stdout).ok()
}

/// Canonical repo toplevel for `cwd`, or `None` when outside a work tree.
pub fn repo_root(cwd: &Path) -> Option<String> {
    let root = run_git(cwd, &["rev-parse", "--show-toplevel"])?;
    let trimmed = root.trim();
    if trimmed.is_empty() {
        None
    } else {
        Some(trimmed.to_string())
    }
}

/// Null-byte sniff over the first 2 KiB — the same heuristic git itself uses
/// to classify a blob as binary for diff purposes.
pub fn looks_binary(bytes: &[u8]) -> bool {
    bytes.iter().take(2048).any(|b| *b == 0)
}

/// Collect the working diff for the repo containing `cwd`.
///
/// `staged: false` → `git diff -M` (unstaged) plus untracked files as
/// synthesized additions. `staged: true` → `git diff -M --staged` only (a
/// staged view by definition contains no untracked files). All git commands
/// run from the repo root so paths are root-relative regardless of how deep
/// `cwd` sits.
pub fn collect_working_diff(cwd: &str, staged: bool) -> Result<WorkingDiff, String> {
    if cwd.is_empty() {
        return Err("no working directory".to_string());
    }
    let root = repo_root(Path::new(cwd)).ok_or_else(|| "not a git repository".to_string())?;
    let root_path = Path::new(&root).to_path_buf();

    let mut args: Vec<&str> = vec!["--no-pager", "diff", "--no-ext-diff", "--no-textconv", "-M"];
    if staged {
        args.push("--staged");
    }
    let mut diff = run_git(&root_path, &args).ok_or_else(|| "git diff failed".to_string())?;

    let mut skipped: Vec<SkippedFile> = Vec::new();
    if !staged {
        let untracked = run_git(
            &root_path,
            &["ls-files", "--others", "--exclude-standard", "-z"],
        )
        .unwrap_or_default();
        for path in untracked.split('\0').filter(|p| !p.is_empty()) {
            let full = root_path.join(path);
            let too_large = std::fs::metadata(&full)
                .map(|m| m.len() > UNTRACKED_MAX_BYTES)
                .unwrap_or(false);
            if too_large {
                skipped.push(SkippedFile {
                    path: path.to_string(),
                    reason: "too_large".to_string(),
                });
                continue;
            }
            let bytes = match std::fs::read(&full) {
                Ok(b) => b,
                Err(_) => {
                    skipped.push(SkippedFile {
                        path: path.to_string(),
                        reason: "unreadable".to_string(),
                    });
                    continue;
                }
            };
            if looks_binary(&bytes) {
                skipped.push(SkippedFile {
                    path: path.to_string(),
                    reason: "binary".to_string(),
                });
                continue;
            }
            if !diff.is_empty() && !diff.ends_with('\n') {
                diff.push('\n');
            }
            diff.push_str(&untracked_addition_diff(path, &bytes));
        }
    }

    Ok(WorkingDiff {
        repo_root: root,
        diff,
        skipped,
    })
}

/// Collect current working-tree status and line counts only for assistant file
/// references. All counts are derived from Git/local bytes; assistant output is
/// used solely to identify normalized absolute targets (spec 207).
pub fn collect_reference_git_state(
    cwd: &str,
    paths: Vec<String>,
) -> Result<ReferenceGitSnapshot, String> {
    if cwd.is_empty() {
        return Err("no working directory".to_string());
    }
    let root = repo_root(Path::new(cwd)).ok_or_else(|| "not a git repository".to_string())?;
    let root_path = normalize_lexical(Path::new(&root));
    let input_cwd = normalize_lexical(Path::new(cwd));
    let canonical_cwd = std::fs::canonicalize(cwd)
        .map(|path| normalize_lexical(&path))
        .unwrap_or_else(|_| input_cwd.clone());
    let mut input_root = input_cwd.clone();
    if let Ok(relative_cwd) = canonical_cwd.strip_prefix(&root_path) {
        for component in relative_cwd.components() {
            if matches!(component, Component::Normal(_)) {
                input_root.pop();
            }
        }
    } else {
        input_root = root_path.clone();
    }

    let mut requested: Vec<(String, String)> = Vec::new();
    let mut seen_targets = HashSet::new();
    for target in paths {
        if !seen_targets.insert(target.clone()) {
            continue;
        }
        let absolute = Path::new(&target);
        if !absolute.is_absolute() {
            continue;
        }
        let normalized = normalize_lexical(absolute);
        let relative = normalized
            .strip_prefix(&root_path)
            .or_else(|_| normalized.strip_prefix(&input_root));
        let Ok(relative) = relative else {
            continue;
        };
        if relative.as_os_str().is_empty()
            || relative
                .components()
                .any(|component| !matches!(component, Component::Normal(_)))
        {
            continue;
        }
        requested.push((target, git_path(relative)));
    }

    if requested.is_empty() {
        return Ok(ReferenceGitSnapshot {
            repo_root: root,
            changes: Vec::new(),
        });
    }

    let status_bytes = run_git_bytes(
        &root_path,
        &[
            "status",
            "--porcelain=v1",
            "-z",
            "--untracked-files=all",
            "--renames",
        ],
    )
    .ok_or_else(|| "git status failed".to_string())?;
    let statuses = parse_status_porcelain_z(&status_bytes);

    let base = if run_git(&root_path, &["rev-parse", "--verify", "HEAD"]).is_some() {
        "HEAD".to_string()
    } else {
        run_git(&root_path, &["hash-object", "-t", "tree", "--stdin"])
            .map(|value| value.trim().to_string())
            .filter(|value| !value.is_empty())
            .ok_or_else(|| "could not derive empty Git tree".to_string())?
    };
    let numstat_bytes = run_git_bytes(
        &root_path,
        &[
            "--no-pager",
            "diff",
            "--no-ext-diff",
            "--no-textconv",
            "-M",
            "--numstat",
            "-z",
            &base,
            "--",
        ],
    )
    .ok_or_else(|| "git numstat failed".to_string())?;
    let numstat = parse_numstat_z(&numstat_bytes);

    let status_by_path: HashMap<String, String> = statuses.into_iter().collect();
    let mut changes = Vec::new();
    for (target, relative) in requested {
        let Some(status) = status_by_path.get(&relative) else {
            continue;
        };
        if status == "?" {
            let (added, removed, count_kind) = count_untracked_lines(&root_path.join(&relative));
            changes.push(ReferenceGitChange {
                target,
                status: status.clone(),
                added,
                removed,
                count_kind,
            });
            continue;
        }
        let (added, removed, count_kind) = match numstat.get(&relative) {
            Some((Some(added), Some(removed))) => {
                (Some(*added), Some(*removed), "lines".to_string())
            }
            Some(_) => (None, None, "binary".to_string()),
            None => (None, None, "unavailable".to_string()),
        };
        changes.push(ReferenceGitChange {
            target,
            status: status.clone(),
            added,
            removed,
            count_kind,
        });
    }

    Ok(ReferenceGitSnapshot {
        repo_root: root,
        changes,
    })
}

fn run_git_bytes(cwd: &Path, args: &[&str]) -> Option<Vec<u8>> {
    let output = Command::new("git")
        .args(args)
        .current_dir(cwd)
        .output()
        .ok()?;
    output.status.success().then_some(output.stdout)
}

fn parse_status_porcelain_z(bytes: &[u8]) -> Vec<(String, String)> {
    let fields: Vec<&[u8]> = bytes.split(|byte| *byte == 0).collect();
    let mut entries = Vec::new();
    let mut index = 0;
    while index < fields.len() {
        let record = fields[index];
        index += 1;
        if record.len() < 3 || record[2] != b' ' {
            continue;
        }
        let x = record[0] as char;
        let y = record[1] as char;
        let path = String::from_utf8_lossy(&record[3..]).into_owned();
        if x == 'R' || y == 'R' || x == 'C' || y == 'C' {
            // Porcelain v1 -z emits destination first, then the original path.
            index = index.saturating_add(1);
        }
        entries.push((path, compact_status(x, y).to_string()));
    }
    entries
}

fn compact_status(x: char, y: char) -> char {
    if x == '?' && y == '?' {
        return '?';
    }
    if matches!(
        (x, y),
        ('D', 'D') | ('A', 'U') | ('U', 'D') | ('U', 'A') | ('D', 'U') | ('A', 'A') | ('U', 'U')
    ) {
        return '!';
    }
    if x == 'R' || y == 'R' {
        return 'R';
    }
    if x == 'D' || y == 'D' {
        return 'D';
    }
    if x == 'A' || y == 'A' || x == 'C' || y == 'C' {
        return 'A';
    }
    'M'
}

fn parse_numstat_z(bytes: &[u8]) -> HashMap<String, (Option<u64>, Option<u64>)> {
    let fields: Vec<&[u8]> = bytes.split(|byte| *byte == 0).collect();
    let mut entries = HashMap::new();
    let mut index = 0;
    while index < fields.len() {
        let record = fields[index];
        index += 1;
        if record.is_empty() {
            continue;
        }
        let mut parts = record.splitn(3, |byte| *byte == b'\t');
        let Some(added_raw) = parts.next() else {
            continue;
        };
        let Some(removed_raw) = parts.next() else {
            continue;
        };
        let Some(path_raw) = parts.next() else {
            continue;
        };
        let path = if path_raw.is_empty() {
            // Rename/copy record: the header is followed by old and new path.
            if index + 1 >= fields.len() {
                break;
            }
            index += 1; // original path
            let destination = fields[index];
            index += 1;
            destination
        } else {
            path_raw
        };
        entries.insert(
            String::from_utf8_lossy(path).into_owned(),
            (
                parse_numstat_count(added_raw),
                parse_numstat_count(removed_raw),
            ),
        );
    }
    entries
}

fn parse_numstat_count(value: &[u8]) -> Option<u64> {
    if value == b"-" {
        return None;
    }
    std::str::from_utf8(value).ok()?.parse().ok()
}

fn count_untracked_lines(path: &Path) -> (Option<u64>, Option<u64>, String) {
    let Ok(metadata) = std::fs::metadata(path) else {
        return (None, None, "unavailable".to_string());
    };
    if metadata.len() > UNTRACKED_MAX_BYTES {
        return (None, None, "unavailable".to_string());
    }
    let Ok(bytes) = std::fs::read(path) else {
        return (None, None, "unavailable".to_string());
    };
    if looks_binary(&bytes) {
        return (None, None, "binary".to_string());
    }
    let newlines = bytes.iter().filter(|byte| **byte == b'\n').count() as u64;
    let final_line = u64::from(!bytes.is_empty() && !bytes.ends_with(b"\n"));
    (Some(newlines + final_line), Some(0), "lines".to_string())
}

fn normalize_lexical(path: &Path) -> PathBuf {
    let mut normalized = PathBuf::new();
    for component in path.components() {
        match component {
            Component::CurDir => {}
            Component::ParentDir => {
                normalized.pop();
            }
            other => normalized.push(other.as_os_str()),
        }
    }
    normalized
}

fn git_path(path: &Path) -> String {
    path.to_string_lossy().replace('\\', "/")
}

/// Synthesize the unified diff git would print for `path` as a brand-new
/// file — equivalent to `git diff --no-index /dev/null <path>` without
/// spawning a process per file.
fn untracked_addition_diff(path: &str, bytes: &[u8]) -> String {
    let mut out = format!(
        "diff --git a/{path} b/{path}\nnew file mode 100644\n--- /dev/null\n+++ b/{path}\n"
    );
    if bytes.is_empty() {
        // Git emits a header-only diff for an empty new file.
        return out;
    }
    let text = String::from_utf8_lossy(bytes);
    let ends_with_newline = text.ends_with('\n');
    let lines: Vec<&str> = if ends_with_newline {
        let mut v: Vec<&str> = text.split('\n').collect();
        v.pop(); // trailing "" from the final newline
        v
    } else {
        text.split('\n').collect()
    };
    out.push_str(&format!("@@ -0,0 +1,{} @@\n", lines.len()));
    for line in &lines {
        out.push('+');
        out.push_str(line);
        out.push('\n');
    }
    if !ends_with_newline {
        out.push_str("\\ No newline at end of file\n");
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::{SystemTime, UNIX_EPOCH};

    fn test_repo(label: &str) -> PathBuf {
        let suffix = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("clock after epoch")
            .as_nanos();
        let dir = std::env::temp_dir().join(format!(
            "krypton-reference-git-{label}-{}-{suffix}",
            std::process::id()
        ));
        std::fs::create_dir_all(&dir).expect("create temp repo");
        git_ok(&dir, &["init", "-q"]);
        git_ok(&dir, &["config", "user.email", "t@t"]);
        git_ok(&dir, &["config", "user.name", "t"]);
        dir
    }

    fn git_ok(dir: &Path, args: &[&str]) {
        let output = Command::new("git")
            .args(args)
            .current_dir(dir)
            .output()
            .expect("run git");
        assert!(
            output.status.success(),
            "git {args:?} failed: {}",
            String::from_utf8_lossy(&output.stderr)
        );
    }

    #[test]
    fn addition_diff_counts_lines_with_trailing_newline() {
        let d = untracked_addition_diff("a.txt", b"one\ntwo\n");
        assert!(d.contains("@@ -0,0 +1,2 @@"));
        assert!(d.contains("+one\n+two\n"));
        assert!(!d.contains("No newline"));
    }

    #[test]
    fn addition_diff_marks_missing_trailing_newline() {
        let d = untracked_addition_diff("a.txt", b"one\ntwo");
        assert!(d.contains("@@ -0,0 +1,2 @@"));
        assert!(d.ends_with("\\ No newline at end of file\n"));
    }

    #[test]
    fn addition_diff_empty_file_is_header_only() {
        let d = untracked_addition_diff("a.txt", b"");
        assert!(d.contains("new file mode 100644"));
        assert!(!d.contains("@@"));
    }

    #[test]
    fn binary_sniff_finds_null_byte() {
        assert!(looks_binary(b"abc\0def"));
        assert!(!looks_binary(
            "plain text \u{0e44}\u{0e17}\u{0e22}".as_bytes()
        ));
    }

    #[test]
    fn working_diff_includes_tracked_and_untracked() {
        let dir = std::env::temp_dir().join(format!("krypton-git-test-{}", std::process::id()));
        std::fs::create_dir_all(&dir).expect("create temp dir");
        let git = |args: &[&str]| {
            let ok = Command::new("git")
                .args(args)
                .current_dir(&dir)
                .output()
                .expect("run git")
                .status
                .success();
            assert!(ok, "git {args:?} failed");
        };
        git(&["init", "-q"]);
        git(&["config", "user.email", "t@t"]);
        git(&["config", "user.name", "t"]);
        std::fs::write(dir.join("tracked.txt"), "old\n").expect("write tracked");
        git(&["add", "."]);
        git(&["commit", "-qm", "init"]);
        std::fs::write(dir.join("tracked.txt"), "new\n").expect("modify tracked");
        std::fs::write(dir.join("fresh.txt"), "hello\n").expect("write untracked");
        std::fs::write(dir.join("blob.bin"), b"\x00\x01\x02").expect("write binary");

        let wd = collect_working_diff(dir.to_str().expect("utf8 path"), false)
            .expect("collect working diff");
        assert!(wd.diff.contains("tracked.txt"), "tracked change missing");
        assert!(wd.diff.contains("+new"), "modified content missing");
        assert!(
            wd.diff.contains("+++ b/fresh.txt") && wd.diff.contains("+hello"),
            "untracked addition missing"
        );
        assert_eq!(wd.skipped.len(), 1, "binary should be skipped");
        assert_eq!(wd.skipped[0].path, "blob.bin");
        assert_eq!(wd.skipped[0].reason, "binary");

        let staged = collect_working_diff(dir.to_str().expect("utf8 path"), true)
            .expect("collect staged diff");
        assert!(
            !staged.diff.contains("fresh.txt"),
            "staged view must not synthesize untracked files"
        );

        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn reference_git_state_counts_tracked_untracked_and_binary_files() {
        let dir = test_repo("counts");
        std::fs::write(dir.join("modified.txt"), "old\n").expect("write tracked");
        std::fs::write(dir.join("deleted.txt"), "gone\n").expect("write deleted base");
        git_ok(&dir, &["add", "."]);
        git_ok(&dir, &["commit", "-qm", "base"]);

        std::fs::write(dir.join("modified.txt"), "new\nsecond\n").expect("modify tracked");
        std::fs::remove_file(dir.join("deleted.txt")).expect("delete tracked");
        std::fs::write(dir.join("untracked.txt"), "one\ntwo").expect("write untracked");
        std::fs::write(dir.join("blob.bin"), b"abc\0def").expect("write binary");

        let targets = [
            "modified.txt",
            "deleted.txt",
            "untracked.txt",
            "blob.bin",
            "clean.txt",
        ]
        .into_iter()
        .map(|name| dir.join(name).to_string_lossy().to_string())
        .collect();
        let snapshot = collect_reference_git_state(dir.to_str().expect("utf8 dir"), targets)
            .expect("collect reference state");
        let by_name: HashMap<String, ReferenceGitChange> = snapshot
            .changes
            .into_iter()
            .map(|change| {
                let name = Path::new(&change.target)
                    .file_name()
                    .expect("file name")
                    .to_string_lossy()
                    .to_string();
                (name, change)
            })
            .collect();

        assert_eq!(by_name["modified.txt"].status, "M");
        assert_eq!(by_name["modified.txt"].added, Some(2));
        assert_eq!(by_name["modified.txt"].removed, Some(1));
        assert_eq!(by_name["deleted.txt"].status, "D");
        assert_eq!(by_name["deleted.txt"].removed, Some(1));
        assert_eq!(by_name["untracked.txt"].status, "?");
        assert_eq!(by_name["untracked.txt"].added, Some(2));
        assert_eq!(by_name["untracked.txt"].removed, Some(0));
        assert_eq!(by_name["blob.bin"].count_kind, "binary");
        assert!(!by_name.contains_key("clean.txt"));

        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn reference_git_state_handles_unborn_rename_and_outside_paths() {
        let unborn = test_repo("unborn");
        std::fs::write(unborn.join("first.txt"), "first\n").expect("write first");
        git_ok(&unborn, &["add", "first.txt"]);
        let unborn_snapshot = collect_reference_git_state(
            unborn.to_str().expect("utf8 dir"),
            vec![unborn.join("first.txt").to_string_lossy().to_string()],
        )
        .expect("collect unborn state");
        assert_eq!(unborn_snapshot.changes[0].status, "A");
        assert_eq!(unborn_snapshot.changes[0].added, Some(1));
        std::fs::remove_dir_all(&unborn).ok();

        let dir = test_repo("rename");
        std::fs::write(dir.join("old name.txt"), "same\n").expect("write old");
        git_ok(&dir, &["add", "."]);
        git_ok(&dir, &["commit", "-qm", "base"]);
        git_ok(&dir, &["mv", "old name.txt", "new name.txt"]);
        let snapshot = collect_reference_git_state(
            dir.to_str().expect("utf8 dir"),
            vec![
                dir.join("new name.txt").to_string_lossy().to_string(),
                dir.parent()
                    .expect("temp parent")
                    .join("outside.txt")
                    .to_string_lossy()
                    .to_string(),
            ],
        )
        .expect("collect rename state");
        assert_eq!(snapshot.changes.len(), 1);
        assert_eq!(snapshot.changes[0].status, "R");
        assert_eq!(snapshot.changes[0].count_kind, "lines");
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn nul_parsers_preserve_unusual_paths_and_binary_counts() {
        let status = b" M tab\tline\nname.txt\0R  renamed.txt\0old.txt\0UU conflict.txt\0";
        assert_eq!(
            parse_status_porcelain_z(status),
            vec![
                ("tab\tline\nname.txt".to_string(), "M".to_string()),
                ("renamed.txt".to_string(), "R".to_string()),
                ("conflict.txt".to_string(), "!".to_string()),
            ]
        );

        let numstat = b"3\t2\ttab\tline\nname.txt\0-\t-\tblob.bin\00\t0\t\0old.txt\0renamed.txt\0";
        let parsed = parse_numstat_z(numstat);
        assert_eq!(parsed["tab\tline\nname.txt"], (Some(3), Some(2)));
        assert_eq!(parsed["blob.bin"], (None, None));
        assert_eq!(parsed["renamed.txt"], (Some(0), Some(0)));
    }

    #[test]
    fn oversized_untracked_file_reports_unavailable() {
        let dir = test_repo("oversized");
        let path = dir.join("large.txt");
        std::fs::write(&path, vec![b'x'; UNTRACKED_MAX_BYTES as usize + 1])
            .expect("write oversized file");
        let snapshot = collect_reference_git_state(
            dir.to_str().expect("utf8 dir"),
            vec![path.to_string_lossy().to_string()],
        )
        .expect("collect oversized state");
        assert_eq!(snapshot.changes[0].status, "?");
        assert_eq!(snapshot.changes[0].count_kind, "unavailable");
        assert_eq!(snapshot.changes[0].added, None);
        std::fs::remove_dir_all(&dir).ok();
    }
}
