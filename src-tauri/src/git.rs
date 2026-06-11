// Shared git working-tree helpers (spec 155).
//
// Owns the [[Working diff]] definition (CONTEXT.md): tracked changes plus
// untracked, non-ignored files rendered as pure additions. Both the Diff
// Window (`collect_working_diff`) and the `#review` git-state collection in
// `hook_server.rs` build on these primitives so the two surfaces can never
// drift apart on root resolution, git invocation, or binary detection.

use serde::Serialize;
use std::path::Path;
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
}
