// Uncommitted line volume for a repo — the window rail's diff stat (spec 220).
//
// Lives in the protocol crate because both ends compute it: the app for a local
// project (`working_diff_stat` command) and the remote companion for an SSH
// Harness (`RemoteMethod::WorkspaceDiffStat`, spec 247). One implementation
// keeps the two readouts counting the same way. The app's `git.rs` builds its
// [[Working diff]] surfaces on the primitives exported here (binary sniff,
// untracked size cap, numstat parser, diff base).

use serde::Serialize;
use std::collections::HashMap;
use std::path::Path;
use std::process::Command;

/// Untracked files larger than this are not read: the Diff Window lists them by
/// name instead of rendering megabytes, and the stat cannot count their lines.
pub const UNTRACKED_MAX_BYTES: u64 = 1_048_576;

/// Stop reading untracked files after this many in `working_diff_stat` — the
/// window rail polls it every few seconds, so its cost has to be bounded even
/// on a tree carrying a large unignored scratch directory. Hitting the cap sets
/// `truncated`, which is how the readout admits its counts are a lower bound.
const UNTRACKED_SCAN_MAX: usize = 500;

/// Uncommitted line volume for one repo — the window status bar's readout
/// (spec 220). Deliberately carries no diff text: it is polled, and the whole
/// point is that answering "how much changed" costs two integers, not megabytes.
///
/// Counts run against `HEAD` (staged *and* unstaged) plus untracked additions,
/// unlike the Diff Window, whose unstaged mode excludes the index because it
/// offers staged as a separate view. A rail has no second view to switch to, so
/// staging work must not make it vanish from the total.
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct WorkingDiffStat {
    pub repo_root: String,
    /// Files with any change vs `HEAD`, including untracked and binary ones.
    pub files: u64,
    pub added: u64,
    pub removed: u64,
    /// A file's lines could not be counted (binary, over `UNTRACKED_MAX_BYTES`,
    /// unreadable) or the untracked walk hit `UNTRACKED_SCAN_MAX`, so `added`
    /// and `removed` are a lower bound.
    pub truncated: bool,
}

/// Total uncommitted line volume for the repo containing `cwd` (spec 220).
///
/// One `--numstat` over everything tracked that differs from `HEAD`, plus a
/// bounded walk of untracked files counted as pure additions — the same
/// [[Working diff]] membership the Diff Window renders, reduced to totals and
/// without ever materializing a diff.
pub fn working_diff_stat(cwd: &str) -> Result<WorkingDiffStat, String> {
    if cwd.is_empty() {
        return Err("no working directory".to_string());
    }
    let root = git_stdout(Path::new(cwd), &["rev-parse", "--show-toplevel"])
        .map(|out| out.trim().to_string())
        .filter(|root| !root.is_empty())
        .ok_or_else(|| "not a git repository".to_string())?;
    let root_path = Path::new(&root).to_path_buf();
    let base = diff_base(&root_path)?;

    let numstat_bytes = git_bytes(
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

    let mut stat = WorkingDiffStat {
        repo_root: root,
        files: 0,
        added: 0,
        removed: 0,
        truncated: false,
    };
    for (added, removed) in parse_numstat_z(&numstat_bytes).values() {
        stat.files += 1;
        match (added, removed) {
            (Some(added), Some(removed)) => {
                stat.added += added;
                stat.removed += removed;
            }
            // A binary change reports `-`/`-`: the file changed, but it has no
            // line count to contribute, so the totals understate it.
            _ => stat.truncated = true,
        }
    }

    let untracked = git_stdout(
        &root_path,
        &["ls-files", "--others", "--exclude-standard", "-z"],
    )
    .unwrap_or_default();
    for (index, path) in untracked.split('\0').filter(|p| !p.is_empty()).enumerate() {
        if index >= UNTRACKED_SCAN_MAX {
            stat.truncated = true;
            break;
        }
        stat.files += 1;
        match count_untracked_lines(&root_path.join(path)).0 {
            Some(added) => stat.added += added,
            None => stat.truncated = true,
        }
    }

    Ok(stat)
}

/// The left side of a working-tree diff: `HEAD`, or git's empty tree when the
/// branch is unborn (a fresh `git init`, where `HEAD` does not resolve and
/// `git diff HEAD` therefore fails). Against the empty tree every tracked file
/// reads as a pure addition, which is what a repo with no commits should show.
pub fn diff_base(root: &Path) -> Result<String, String> {
    if git_stdout(root, &["rev-parse", "--verify", "HEAD"]).is_some() {
        return Ok("HEAD".to_string());
    }
    git_stdout(root, &["hash-object", "-t", "tree", "--stdin"])
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
        .ok_or_else(|| "could not derive empty Git tree".to_string())
}

/// Null-byte sniff over the first 2 KiB — the same heuristic git itself uses
/// to classify a blob as binary for diff purposes.
pub fn looks_binary(bytes: &[u8]) -> bool {
    bytes.iter().take(2048).any(|b| *b == 0)
}

/// `git diff --numstat -z` → path → (added, removed); `None` for a binary side.
/// A rename/copy record is keyed by its destination path.
pub fn parse_numstat_z(bytes: &[u8]) -> HashMap<String, (Option<u64>, Option<u64>)> {
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

/// Lines an untracked file adds: `(added, removed, kind)` where `kind` is
/// `"lines"`, `"binary"` or `"unavailable"` (missing, unreadable or over
/// `UNTRACKED_MAX_BYTES`), and both counts are `None` unless it is `"lines"`.
pub fn count_untracked_lines(path: &Path) -> (Option<u64>, Option<u64>, String) {
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

fn git_bytes(cwd: &Path, args: &[&str]) -> Option<Vec<u8>> {
    let output = Command::new("git")
        .args(args)
        .current_dir(cwd)
        .output()
        .ok()?;
    output.status.success().then_some(output.stdout)
}

fn git_stdout(cwd: &Path, args: &[&str]) -> Option<String> {
    String::from_utf8(git_bytes(cwd, args)?).ok()
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;
    use std::time::{SystemTime, UNIX_EPOCH};

    fn test_repo(label: &str) -> PathBuf {
        let suffix = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("clock after epoch")
            .as_nanos();
        let dir = std::env::temp_dir().join(format!(
            "krypton-diff-stat-{label}-{}-{suffix}",
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
    fn binary_sniff_finds_null_byte() {
        assert!(looks_binary(b"abc\0def"));
        assert!(!looks_binary(
            "plain text \u{0e44}\u{0e17}\u{0e22}".as_bytes()
        ));
    }

    #[test]
    fn numstat_parser_preserves_unusual_paths_and_binary_counts() {
        let numstat =
            b"3\t2\ttab\tline\nname.txt\0-\t-\tblob.bin\x000\t0\t\0old.txt\0renamed.txt\0";
        let parsed = parse_numstat_z(numstat);
        assert_eq!(parsed["tab\tline\nname.txt"], (Some(3), Some(2)));
        assert_eq!(parsed["blob.bin"], (None, None));
        assert_eq!(parsed["renamed.txt"], (Some(0), Some(0)));
    }

    #[test]
    fn diff_stat_counts_staged_unstaged_and_untracked() {
        let dir = test_repo("stat");
        std::fs::write(dir.join("tracked.txt"), "a\nb\nc\n").expect("write tracked");
        git_ok(&dir, &["add", "."]);
        git_ok(&dir, &["commit", "-qm", "init"]);

        // Staged: one line replaced. Unstaged: two lines appended to a second
        // file. Untracked: one new text file and one binary blob.
        std::fs::write(dir.join("tracked.txt"), "a\nB\nc\n").expect("modify tracked");
        git_ok(&dir, &["add", "tracked.txt"]);
        std::fs::write(dir.join("tracked.txt"), "a\nB\nc\nd\n").expect("append tracked");
        std::fs::write(dir.join("fresh.txt"), "one\ntwo\n").expect("write untracked");
        std::fs::write(dir.join("blob.bin"), b"\x00\x01\x02").expect("write binary");

        let stat = working_diff_stat(dir.to_str().expect("utf8 dir")).expect("collect stat");
        assert_eq!(stat.files, 3, "tracked + untracked text + binary");
        // Staged and unstaged both count: 2 changed/added lines in tracked.txt
        // plus 2 from the untracked file.
        assert_eq!(stat.added, 4);
        assert_eq!(stat.removed, 1);
        assert!(stat.truncated, "binary untracked file has no line count");
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn diff_stat_is_zero_on_a_clean_tree() {
        let dir = test_repo("stat-clean");
        std::fs::write(dir.join("tracked.txt"), "a\n").expect("write tracked");
        git_ok(&dir, &["add", "."]);
        git_ok(&dir, &["commit", "-qm", "init"]);

        let stat = working_diff_stat(dir.to_str().expect("utf8 dir")).expect("collect stat");
        assert_eq!((stat.files, stat.added, stat.removed), (0, 0, 0));
        assert!(!stat.truncated);
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn diff_stat_counts_index_on_an_unborn_branch() {
        // A fresh `git init` has no HEAD to diff against; the empty-tree base
        // makes everything staged read as a pure addition.
        let dir = test_repo("stat-unborn");
        std::fs::write(dir.join("first.txt"), "a\nb\n").expect("write file");
        git_ok(&dir, &["add", "."]);

        let stat = working_diff_stat(dir.to_str().expect("utf8 dir")).expect("collect stat");
        assert_eq!((stat.files, stat.added, stat.removed), (1, 2, 0));
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn diff_stat_rejects_a_path_outside_a_repo() {
        let dir =
            std::env::temp_dir().join(format!("krypton-diff-stat-nonrepo-{}", std::process::id()));
        std::fs::create_dir_all(&dir).expect("create temp dir");
        assert!(working_diff_stat(dir.to_str().expect("utf8 dir")).is_err());
        assert!(working_diff_stat("").is_err());
        std::fs::remove_dir_all(&dir).ok();
    }
}
