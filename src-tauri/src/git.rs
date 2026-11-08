// Shared git working-tree helpers (spec 155).
//
// Owns the [[Working diff]] definition (CONTEXT.md): tracked changes plus
// untracked, non-ignored files rendered as pure additions. Both the Diff
// Window (`collect_working_diff`) and the `#review` git-state collection in
// `hook_server.rs` build on these primitives so the two surfaces can never
// drift apart on root resolution, git invocation, or binary detection. The
// rail's diff stat and the primitives it shares with this file (binary sniff,
// untracked size cap, numstat parser, diff base) live in
// `krypton_remote_protocol::diff_stat`, because the remote companion computes
// the same stat for an SSH Harness (spec 247).

use krypton_remote_protocol::diff_stat::{
    count_untracked_lines, diff_base, looks_binary, parse_numstat_z, UNTRACKED_MAX_BYTES,
};
use serde::Serialize;
use sha2::{Digest, Sha256};
use std::collections::{HashMap, HashSet};
use std::io::Read;
use std::path::{Component, Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::mpsc;
use std::time::{Duration, Instant};

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

/// One row of the Commit Browser (spec 375).
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct CommitSummary {
    pub sha: String,
    pub short_sha: String,
    pub author: String,
    /// Committer date, unix seconds.
    pub at: i64,
    pub subject: String,
    /// Message body with a trailing trailer block (`Co-Authored-By:` …) removed.
    pub body: String,
    pub is_merge: bool,
    /// Numstat against the first parent; binary files count as touched, 0 lines.
    pub files: u32,
    pub added: u32,
    pub removed: u32,
}

/// One page of `git log` for the Commit Browser (spec 375).
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct GitLogPage {
    pub repo_root: String,
    pub repo_name: String,
    /// Current branch; `None` when HEAD is detached.
    pub branch: Option<String>,
    pub commits: Vec<CommitSummary>,
    pub has_more: bool,
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

/// Characters that make a command line more than a plain git argv
/// (shell syntax, quoting, globbing, expansion, comments).
const RERUN_FORBIDDEN_CHARS: &[char] = &[
    '|', '&', ';', '<', '>', '(', ')', '$', '`', '\'', '"', '\\', '*', '?', '[', ']', '{', '}',
    '#', '\n', '\r',
];

/// Long options a re-run may not carry: they write files, run external
/// programs, or change the output away from a plain unified diff. Matched
/// in both prefix directions so git's unambiguous abbreviations (`--out=x`)
/// and longer spellings (`--color-words`, `--word-diff-regex`) are refused.
const RERUN_DENIED_OPTIONS: &[&str] = &[
    "--output",
    "--ext-diff",
    "--textconv",
    "--word-diff",
    "--color",
];

const NATIVE_GIT_TIMEOUT: Duration = Duration::from_secs(5);
const NATIVE_GIT_MAX_BYTES: usize = 2 * 1024 * 1024;

/// Shared gate of specs 351/352: the command line must be exactly
/// `git [--no-pager] <subcommand> <rest>` with no shell syntax; returns
/// the whitespace-split `<rest>`.
fn git_rerun_tokens(cmdline: &str, subcommand: &str) -> Result<Vec<String>, String> {
    let cmdline = cmdline.trim();
    if let Some(c) = cmdline.chars().find(|c| RERUN_FORBIDDEN_CHARS.contains(c)) {
        return Err(format!("command line contains {c:?}"));
    }
    // A shell expands `~` only at a word start or after `=` / `:`; mid-word
    // (`HEAD~1`) it reaches git verbatim, exactly as in this argv.
    if cmdline
        .split_whitespace()
        .any(|token| token.starts_with('~') || token.contains("=~") || token.contains(":~"))
    {
        return Err("command line contains a tilde expansion".to_string());
    }
    let mut tokens = cmdline.split_whitespace();
    if tokens.next() != Some("git") {
        return Err("not a git command".to_string());
    }
    let mut sub = tokens.next();
    if sub == Some("--no-pager") {
        sub = tokens.next();
    }
    if sub != Some(subcommand) {
        return Err(format!("not a plain `git {subcommand}`"));
    }
    Ok(tokens.map(str::to_string).collect())
}

/// spec 351: validate a shell command line for a native diff re-run. It
/// must be exactly `git [--no-pager] diff <rest>` with no shell syntax;
/// returns `<rest>`. This is the only gate on what `native_git_diff` runs.
pub fn git_diff_rerun_args(cmdline: &str) -> Result<Vec<String>, String> {
    let rest = git_rerun_tokens(cmdline, "diff")?;
    for token in &rest {
        if !token.starts_with("--") || token == "--" {
            continue;
        }
        let name = token.split_once('=').map_or(token.as_str(), |(n, _)| n);
        if RERUN_DENIED_OPTIONS
            .iter()
            .any(|denied| denied.starts_with(name) || name.starts_with(denied))
        {
            return Err(format!("option {name} is not allowed"));
        }
    }
    Ok(rest)
}

/// spec 351: run `git --no-pager diff --no-color --no-ext-diff --no-textconv
/// <rest>` in `cwd` and return its stdout. Killed after 5 s; stdout over
/// 2 MiB or an exit status other than 0/1 is an `Err`.
pub fn native_git_diff(cwd: &str, cmdline: &str) -> Result<String, String> {
    let rest = git_diff_rerun_args(cmdline)?;
    if cwd.is_empty() {
        return Err("no working directory".to_string());
    }
    let mut args = owned_args(&["diff", "--no-color", "--no-ext-diff", "--no-textconv"]);
    args.extend(rest);
    match run_git_capped(cwd, &args)? {
        (Some(0 | 1), stdout) => Ok(stdout),
        (Some(code), _) => Err(format!("git diff exited with status {code}")),
        (None, _) => Err("git diff was terminated by a signal".to_string()),
    }
}

/// spec 352: the parts of a user's `git status` that survive a native
/// re-run. Format flags are dropped (the re-run is always porcelain v2).
#[derive(Debug, Default, PartialEq, Eq)]
pub struct StatusRerun {
    /// `--untracked-files=<mode>`: `no` | `normal` | `all`.
    pub untracked: Option<String>,
    /// `--ignored=<mode>`: `traditional` | `no` | `matching`.
    pub ignored: Option<String>,
    /// Pathspecs, passed after `--`.
    pub paths: Vec<String>,
}

/// spec 352: validate a shell command line for a native status re-run. It
/// must be exactly `git [--no-pager] status <rest>` where `<rest>` holds
/// only format flags (dropped), untracked/ignored modes and pathspecs.
/// This is the only gate on what `native_git_status` runs.
pub fn git_status_rerun_args(cmdline: &str) -> Result<StatusRerun, String> {
    let mut rerun = StatusRerun::default();
    let mut tokens = git_rerun_tokens(cmdline, "status")?.into_iter();
    while let Some(token) = tokens.next() {
        match token.as_str() {
            "--" => {
                rerun.paths.extend(tokens.by_ref());
                break;
            }
            "-s" | "--short" | "-b" | "--branch" | "-sb" | "-bs" | "--long" => {}
            "-u" | "--untracked-files" => rerun.untracked = Some("all".to_string()),
            "--ignored" => rerun.ignored = Some("traditional".to_string()),
            path if !path.starts_with('-') => rerun.paths.push(path.to_string()),
            option => {
                if let Some(mode) = option
                    .strip_prefix("--untracked-files=")
                    .or_else(|| option.strip_prefix("-u"))
                    .filter(|mode| matches!(*mode, "no" | "normal" | "all"))
                {
                    rerun.untracked = Some(mode.to_string());
                } else if let Some(mode) = option
                    .strip_prefix("--ignored=")
                    .filter(|mode| matches!(*mode, "traditional" | "no" | "matching"))
                {
                    rerun.ignored = Some(mode.to_string());
                } else {
                    return Err(format!("option {option} is not allowed"));
                }
            }
        }
    }
    Ok(rerun)
}

/// spec 352: raw output of a native `git status` re-run; the frontend
/// parses all three fields.
#[derive(Debug, Serialize)]
pub struct NativeGitStatus {
    /// `git status --porcelain=v2 --branch -z` stdout.
    pub status: String,
    /// `git diff --cached --numstat -z` stdout; empty when it failed.
    pub staged_numstat: String,
    /// `git diff --numstat -z` stdout; empty when it failed.
    pub unstaged_numstat: String,
}

/// spec 352: re-run a validated `git status` in `cwd` as porcelain v2 plus
/// best-effort staged/unstaged numstats over the same pathspecs. The
/// status run must exit 0; a failed numstat run yields an empty string.
pub fn native_git_status(cwd: &str, cmdline: &str) -> Result<NativeGitStatus, String> {
    let rerun = git_status_rerun_args(cmdline)?;
    if cwd.is_empty() {
        return Err("no working directory".to_string());
    }
    let mut args = owned_args(&["status", "--porcelain=v2", "--branch", "-z"]);
    if let Some(mode) = &rerun.untracked {
        args.push(format!("--untracked-files={mode}"));
    }
    if let Some(mode) = &rerun.ignored {
        args.push(format!("--ignored={mode}"));
    }
    let mut pathspec = Vec::new();
    if !rerun.paths.is_empty() {
        pathspec.push("--".to_string());
        pathspec.extend(rerun.paths);
    }
    args.extend(pathspec.iter().cloned());
    let status = match run_git_capped(cwd, &args)? {
        (Some(0), stdout) => stdout,
        (Some(code), _) => return Err(format!("git status exited with status {code}")),
        (None, _) => return Err("git status was terminated by a signal".to_string()),
    };
    let numstat = |cached: bool| {
        let mut args = owned_args(&["diff"]);
        if cached {
            args.push("--cached".to_string());
        }
        args.extend(owned_args(&[
            "--numstat",
            "-z",
            "--no-color",
            "--no-ext-diff",
            "--no-textconv",
        ]));
        args.extend(pathspec.iter().cloned());
        match run_git_capped(cwd, &args) {
            Ok((Some(0), stdout)) => stdout,
            Ok((code, _)) => {
                log::debug!("native_git_status: numstat (cached={cached}) exited {code:?}");
                String::new()
            }
            Err(e) => {
                log::debug!("native_git_status: numstat (cached={cached}) failed: {e}");
                String::new()
            }
        }
    };
    Ok(NativeGitStatus {
        status,
        staged_numstat: numstat(true),
        unstaged_numstat: numstat(false),
    })
}

/// Most commits one `git_log_page` call returns (spec 375).
const LOG_PAGE_MAX: u32 = 500;

/// spec 375: whether `id` can only be a commit id — 4..=40 ASCII hex. This is
/// the gate that keeps a caller-supplied id from reaching git as an option.
pub fn is_commit_id(id: &str) -> bool {
    (4..=40).contains(&id.len()) && id.bytes().all(|b| b.is_ascii_hexdigit())
}

/// spec 375: the display name of a repo — its root directory's name.
pub fn repo_name(root: &str) -> String {
    Path::new(root)
        .file_name()
        .map(|name| name.to_string_lossy().into_owned())
        .unwrap_or_else(|| "repo".to_string())
}

/// spec 375: one page of history from HEAD for the Commit Browser, newest
/// first. `limit` is clamped to 1..=500 and `has_more` says whether a commit
/// exists past this page. Merge commits are measured against their first
/// parent. Runs from the repo root under the 5 s / 2 MiB cap.
pub fn git_log_page(cwd: &str, skip: u32, limit: u32) -> Result<GitLogPage, String> {
    if cwd.is_empty() {
        return Err("no working directory".to_string());
    }
    let root = repo_root(Path::new(cwd)).ok_or_else(|| "not a git repository".to_string())?;
    let root_path = Path::new(&root);
    if run_git(root_path, &["rev-parse", "--verify", "--quiet", "HEAD"]).is_none() {
        return Err("repository has no commits".to_string());
    }
    let limit = limit.clamp(1, LOG_PAGE_MAX) as usize;
    let args = vec![
        "log".to_string(),
        "--numstat".to_string(),
        // Measure the root commit even under `log.showRoot = false`.
        "--root".to_string(),
        "--diff-merges=first-parent".to_string(),
        "--no-show-signature".to_string(),
        "--format=%x1e%H%x1f%P%x1f%an%x1f%ct%x1f%s%x1f%b%x1d".to_string(),
        format!("--skip={skip}"),
        // One past the page: its presence is `has_more`.
        format!("--max-count={}", limit + 1),
    ];
    let stdout = match run_git_capped(&root, &args)? {
        (Some(0), stdout) => stdout,
        (Some(code), _) => return Err(format!("git log exited with status {code}")),
        (None, _) => return Err("git log was terminated by a signal".to_string()),
    };
    let mut commits = parse_log_page(&stdout);
    let has_more = commits.len() > limit;
    commits.truncate(limit);
    let branch = run_git(root_path, &["symbolic-ref", "--short", "-q", "HEAD"])
        .map(|branch| branch.trim().to_string())
        .filter(|branch| !branch.is_empty());
    let name = repo_name(&root);
    Ok(GitLogPage {
        repo_root: root,
        repo_name: name,
        branch,
        commits,
        has_more,
    })
}

/// Parse `git log --numstat` written with `git_log_page`'s format: each record
/// is `\x1e`, the header fields split by `\x1f` and closed by `\x1d` (the body
/// spans lines), then that commit's numstat lines.
fn parse_log_page(stdout: &str) -> Vec<CommitSummary> {
    let mut commits = Vec::new();
    for record in stdout.split('\u{1e}').skip(1) {
        let Some((header, numstat)) = record.split_once('\u{1d}') else {
            continue;
        };
        let fields: Vec<&str> = header.splitn(6, '\u{1f}').collect();
        let [sha, parents, author, at, subject, body] = fields.as_slice() else {
            continue;
        };
        let mut commit = CommitSummary {
            sha: sha.to_string(),
            short_sha: sha.chars().take(7).collect(),
            author: author.to_string(),
            at: at.trim().parse().unwrap_or(0),
            subject: subject.to_string(),
            body: strip_trailer_block(body),
            is_merge: parents.split_whitespace().count() > 1,
            files: 0,
            added: 0,
            removed: 0,
        };
        for line in numstat.lines() {
            let mut cols = line.splitn(3, '\t');
            let (Some(add), Some(del), Some(_path)) = (cols.next(), cols.next(), cols.next())
            else {
                continue;
            };
            commit.files = commit.files.saturating_add(1);
            // "-" is git's marker for a binary file: touched, but no lines.
            commit.added = commit.added.saturating_add(add.parse().unwrap_or(0));
            commit.removed = commit.removed.saturating_add(del.parse().unwrap_or(0));
        }
        commits.push(commit);
    }
    commits
}

/// Trim a commit body and drop its final paragraph when every line of it is a
/// git trailer (`Co-Authored-By: …`, `Signed-off-by: …`). Everything else,
/// including trailer-shaped lines inside the prose, is kept verbatim.
fn strip_trailer_block(body: &str) -> String {
    let body = body.trim();
    let mut last_paragraph = 0;
    let mut offset = 0;
    for line in body.split_inclusive('\n') {
        offset += line.len();
        if line.trim().is_empty() {
            last_paragraph = offset;
        }
    }
    if body[last_paragraph..].lines().all(is_trailer_line) {
        body[..last_paragraph].trim_end().to_string()
    } else {
        body.to_string()
    }
}

/// `Token: value` where the token is `[A-Za-z][A-Za-z0-9-]*`.
fn is_trailer_line(line: &str) -> bool {
    let Some((token, value)) = line.split_once(':') else {
        return false;
    };
    let mut chars = token.chars();
    chars.next().is_some_and(|c| c.is_ascii_alphabetic())
        && chars.all(|c| c.is_ascii_alphanumeric() || c == '-')
        && value.starts_with(' ')
        && !value.trim().is_empty()
}

/// spec 375: the diff of commit `sha` against its first parent, for the
/// Commit Browser's `d`. `sha` must be 4..=40 hex so it can never be read as
/// an option. Output over the 2 MiB cap is `Err("commit diff too large")`.
pub fn git_commit_diff(cwd: &str, sha: &str) -> Result<String, String> {
    if !is_commit_id(sha) {
        return Err("invalid commit id".to_string());
    }
    if cwd.is_empty() {
        return Err("no working directory".to_string());
    }
    let mut args = owned_args(&[
        "show",
        "--format=",
        "-M",
        "--no-ext-diff",
        "--no-color",
        "--no-textconv",
        "--no-show-signature",
        "--diff-merges=first-parent",
    ]);
    args.push(sha.to_string());
    args.push("--".to_string());
    match run_git_capped_raw(cwd, &args) {
        Ok((Some(0), stdout)) => Ok(stdout),
        Ok((Some(code), _)) => Err(format!("git show exited with status {code}")),
        Ok((None, _)) => Err("git show was terminated by a signal".to_string()),
        Err(CappedRunError::TooLarge) => Err("commit diff too large".to_string()),
        Err(CappedRunError::Failed(message)) => Err(message),
    }
}

fn owned_args(args: &[&str]) -> Vec<String> {
    args.iter().map(|arg| arg.to_string()).collect()
}

/// Why a `run_git_capped_raw` call failed. Over-cap output is its own case so
/// a caller can word it for its surface (spec 375 `commit diff too large`).
enum CappedRunError {
    TooLarge,
    Failed(String),
}

/// Run `git --no-pager <args>` in `cwd` for a native re-run (specs
/// 351/352): optional locks off, stdin/stderr null, killed after 5 s,
/// stdout over 2 MiB is an `Err`. `args[0]` is the subcommand. Returns the
/// exit code (`None` when terminated by a signal) and stdout.
fn run_git_capped(cwd: &str, args: &[String]) -> Result<(Option<i32>, String), String> {
    run_git_capped_raw(cwd, args).map_err(|e| match e {
        CappedRunError::TooLarge => format!(
            "git {} output exceeded 2 MiB",
            args.first().map_or("", String::as_str)
        ),
        CappedRunError::Failed(message) => message,
    })
}

/// `run_git_capped` with the over-cap case kept distinguishable.
fn run_git_capped_raw(cwd: &str, args: &[String]) -> Result<(Option<i32>, String), CappedRunError> {
    let what = format!("git {}", args.first().map_or("", String::as_str));
    let mut child = Command::new("git")
        .arg("--no-pager")
        .args(args)
        .current_dir(cwd)
        .env("GIT_OPTIONAL_LOCKS", "0")
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .map_err(|e| CappedRunError::Failed(format!("failed to run git: {e}")))?;
    let deadline = Instant::now() + NATIVE_GIT_TIMEOUT;

    let Some(stdout) = child.stdout.take() else {
        kill_child(&mut child);
        return Err(CappedRunError::Failed("git stdout unavailable".to_string()));
    };
    let (tx, rx) = mpsc::channel();
    std::thread::spawn(move || {
        let mut buf = Vec::new();
        let read = stdout
            .take(NATIVE_GIT_MAX_BYTES as u64 + 1)
            .read_to_end(&mut buf)
            .map(|_| buf);
        // The receiver is gone when the run already timed out.
        let _ = tx.send(read);
    });

    let remaining = deadline.saturating_duration_since(Instant::now());
    let bytes = match rx.recv_timeout(remaining) {
        Ok(Ok(bytes)) => bytes,
        Ok(Err(e)) => {
            kill_child(&mut child);
            return Err(CappedRunError::Failed(format!(
                "failed to read git output: {e}"
            )));
        }
        Err(_) => {
            kill_child(&mut child);
            log::warn!("native {what}: `{}` timed out in {cwd}", args.join(" "));
            return Err(CappedRunError::Failed(format!("{what} timed out")));
        }
    };
    if bytes.len() > NATIVE_GIT_MAX_BYTES {
        kill_child(&mut child);
        return Err(CappedRunError::TooLarge);
    }

    let status = loop {
        match child.try_wait() {
            Ok(Some(status)) => break status,
            Ok(None) if Instant::now() >= deadline => {
                kill_child(&mut child);
                log::warn!("native {what}: `{}` timed out in {cwd}", args.join(" "));
                return Err(CappedRunError::Failed(format!("{what} timed out")));
            }
            Ok(None) => std::thread::sleep(Duration::from_millis(10)),
            Err(e) => {
                kill_child(&mut child);
                return Err(CappedRunError::Failed(format!(
                    "failed to wait for git: {e}"
                )));
            }
        }
    };
    Ok((status.code(), String::from_utf8_lossy(&bytes).into_owned()))
}

/// Kill and reap a child; failures only mean it already exited.
fn kill_child(child: &mut std::process::Child) {
    if let Err(e) = child.kill() {
        log::debug!("kill git child: {e}");
    }
    if let Err(e) = child.wait() {
        log::debug!("reap git child: {e}");
    }
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

/// A fixed review round includes committed changes from the selected base and
/// all current index/worktree changes. The live Diff Window deliberately keeps
/// staged and unstaged views separate; review threads must not.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ReviewSnapshot {
    pub repo_root: String,
    pub base_ref: String,
    pub base_oid: String,
    pub head_oid: Option<String>,
    pub diff: String,
    pub omitted: Vec<SkippedFile>,
    pub files: usize,
    pub fingerprint: String,
}

pub fn collect_review_snapshot(cwd: &str, selected_base: &str) -> Result<ReviewSnapshot, String> {
    collect_review_snapshot_internal(cwd, selected_base, None, false)
}

pub fn collect_review_snapshot_fixed(
    cwd: &str,
    base_oid: &str,
    base_ref: &str,
) -> Result<ReviewSnapshot, String> {
    if !(base_oid.len() == 40 || base_oid.len() == 64)
        || !base_oid.bytes().all(|b| b.is_ascii_hexdigit())
    {
        return Err("invalid review base OID".to_string());
    }
    collect_review_snapshot_internal(cwd, "head", Some((base_ref, base_oid)), true)
}

fn collect_review_snapshot_internal(
    cwd: &str,
    selected_base: &str,
    fixed: Option<(&str, &str)>,
    allow_empty: bool,
) -> Result<ReviewSnapshot, String> {
    let root = repo_root(Path::new(cwd)).ok_or_else(|| "not a git repository".to_string())?;
    let root_path = Path::new(&root);
    let head = run_git(root_path, &["rev-parse", "--verify", "HEAD"]).map(|s| s.trim().to_string());
    let (base_ref, base_oid) = if let Some((label, oid)) = fixed {
        (label.to_string(), oid.to_string())
    } else if selected_base == "upstream" && head.is_some() {
        let upstream = run_git(
            root_path,
            &[
                "rev-parse",
                "--abbrev-ref",
                "--symbolic-full-name",
                "@{upstream}",
            ],
        )
        .map(|s| s.trim().to_string());
        if let Some(upstream) = upstream {
            let oid = run_git(root_path, &["merge-base", "HEAD", &upstream])
                .ok_or_else(|| "could not find upstream merge-base".to_string())?;
            (upstream, oid.trim().to_string())
        } else {
            ("HEAD".to_string(), head.clone().unwrap_or_default())
        }
    } else if selected_base == "head" || selected_base == "upstream" {
        (
            "HEAD".to_string(),
            head.clone().unwrap_or(diff_base(root_path)?),
        )
    } else {
        return Err("base must be upstream or head".to_string());
    };
    let mut diff = run_git(
        root_path,
        &[
            "--no-pager",
            "diff",
            "--no-ext-diff",
            "--no-textconv",
            "-M",
            &base_oid,
            "--",
        ],
    )
    .ok_or_else(|| "git review diff failed".to_string())?;
    let mut omitted = Vec::new();
    let untracked = run_git_bytes(
        root_path,
        &["ls-files", "--others", "--exclude-standard", "-z"],
    )
    .ok_or_else(|| "git untracked listing failed".to_string())?;
    for raw in untracked.split(|b| *b == 0).filter(|p| !p.is_empty()) {
        let path = String::from_utf8(raw.to_vec())
            .map_err(|_| "non-UTF-8 untracked path cannot be reviewed".to_string())?;
        if path.chars().any(|c| matches!(c, '\n' | '\r' | '\t')) {
            omitted.push(SkippedFile {
                path,
                reason: "unsupported_path".to_string(),
            });
            continue;
        }
        let full = root_path.join(&path);
        let meta = std::fs::symlink_metadata(&full);
        if meta.as_ref().is_ok_and(|m| m.file_type().is_symlink()) {
            omitted.push(SkippedFile {
                path,
                reason: "symlink".to_string(),
            });
            continue;
        }
        if meta.as_ref().is_ok_and(|m| m.len() > UNTRACKED_MAX_BYTES) {
            omitted.push(SkippedFile {
                path,
                reason: "too_large".to_string(),
            });
            continue;
        }
        let bytes = match std::fs::read(&full) {
            Ok(bytes) => bytes,
            Err(_) => {
                omitted.push(SkippedFile {
                    path,
                    reason: "unreadable".to_string(),
                });
                continue;
            }
        };
        if looks_binary(&bytes) {
            omitted.push(SkippedFile {
                path,
                reason: "binary".to_string(),
            });
            continue;
        }
        if !diff.is_empty() && !diff.ends_with('\n') {
            diff.push('\n');
        }
        diff.push_str(&untracked_addition_diff(&path, &bytes));
    }
    // Tracked binary files have name-only entries in git's regular diff. Keep
    // the metadata visible while making the missing content explicit.
    let numstat = run_git_bytes(
        root_path,
        &[
            "--no-pager",
            "diff",
            "--no-ext-diff",
            "--no-textconv",
            "--no-renames",
            "--numstat",
            "-z",
            &base_oid,
            "--",
        ],
    )
    .ok_or_else(|| "git review numstat failed".to_string())?;
    for row in numstat.split(|b| *b == 0).filter(|p| !p.is_empty()) {
        let Some(first_tab) = row.iter().position(|b| *b == b'\t') else {
            continue;
        };
        let rest = &row[first_tab + 1..];
        let Some(second_tab) = rest.iter().position(|b| *b == b'\t') else {
            continue;
        };
        if &row[..first_tab] == b"-" && &rest[..second_tab] == b"-" {
            omitted.push(SkippedFile {
                path: String::from_utf8_lossy(&rest[second_tab + 1..]).to_string(),
                reason: "binary".to_string(),
            });
        }
    }
    omitted.sort_by(|a, b| a.path.cmp(&b.path));
    if diff.len() > 4 * 1024 * 1024 {
        return Err("review snapshot exceeds 4 MiB".to_string());
    }
    if diff.is_empty() && omitted.is_empty() && !allow_empty {
        return Err("no changes to review".to_string());
    }
    let mut hasher = Sha256::new();
    hasher.update(base_oid.as_bytes());
    hasher.update(diff.as_bytes());
    for entry in &omitted {
        hasher.update(entry.path.as_bytes());
        hasher.update(entry.reason.as_bytes());
    }
    let fingerprint = format!("{:x}", hasher.finalize());
    let files = diff.matches("diff --git ").count()
        + omitted
            .iter()
            .filter(|item| !diff.contains(&format!("b/{}", item.path)))
            .count();
    Ok(ReviewSnapshot {
        repo_root: root,
        base_ref,
        base_oid,
        head_oid: head,
        diff,
        omitted,
        files,
        fingerprint,
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

    let base = diff_base(&root_path)?;
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
    fn review_snapshot_includes_committed_staged_unstaged_and_untracked() {
        let dir = test_repo("review-snapshot");
        std::fs::write(dir.join("committed.txt"), "before\n").expect("seed");
        std::fs::write(dir.join("staged.txt"), "before\n").expect("seed");
        std::fs::write(dir.join("unstaged.txt"), "before\n").expect("seed");
        git_ok(&dir, &["add", "."]);
        git_ok(&dir, &["commit", "-qm", "base"]);
        git_ok(&dir, &["branch", "review-base"]);
        git_ok(&dir, &["checkout", "-qb", "review-work"]);
        std::fs::write(dir.join("committed.txt"), "after\n").expect("committed change");
        git_ok(&dir, &["commit", "-qam", "committed"]);
        git_ok(
            &dir,
            &["branch", "--set-upstream-to=review-base", "review-work"],
        );
        std::fs::write(dir.join("staged.txt"), "staged\n").expect("staged change");
        git_ok(&dir, &["add", "staged.txt"]);
        std::fs::write(dir.join("unstaged.txt"), "unstaged\n").expect("unstaged change");
        std::fs::write(dir.join("new.txt"), "new\n").expect("untracked change");

        let snapshot = collect_review_snapshot(dir.to_str().expect("utf8"), "upstream")
            .expect("collect review");
        for path in ["committed.txt", "staged.txt", "unstaged.txt", "new.txt"] {
            assert!(
                snapshot.diff.contains(&format!("b/{path}")),
                "missing {path}"
            );
        }
        assert_eq!(snapshot.files, 4);
        assert_eq!(snapshot.base_ref, "review-base");
        let again = collect_review_snapshot(dir.to_str().expect("utf8"), "upstream")
            .expect("collect again");
        assert_eq!(snapshot.fingerprint, again.fingerprint);
        std::fs::remove_dir_all(dir).expect("cleanup");
    }

    #[test]
    fn review_snapshot_handles_unborn_head_and_lists_binary_omission() {
        let dir = test_repo("review-unborn");
        std::fs::write(dir.join("staged.txt"), "hello\n").expect("staged");
        git_ok(&dir, &["add", "staged.txt"]);
        std::fs::write(dir.join("binary.dat"), [0, 1, 2]).expect("binary");
        let snapshot = collect_review_snapshot(dir.to_str().expect("utf8"), "head")
            .expect("collect unborn review");
        assert!(snapshot.diff.contains("b/staged.txt"));
        assert!(snapshot
            .omitted
            .iter()
            .any(|x| x.path == "binary.dat" && x.reason == "binary"));
        std::fs::remove_dir_all(dir).expect("cleanup");
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
    fn git_diff_rerun_args_accepts_plain_git_diff() {
        assert_eq!(git_diff_rerun_args("git diff"), Ok(vec![]));
        assert_eq!(
            git_diff_rerun_args("  git --no-pager diff --staged -- src  "),
            Ok(vec!["--staged".into(), "--".into(), "src".into()])
        );
        assert_eq!(
            git_diff_rerun_args("git diff --no-color HEAD~1"),
            Ok(vec!["--no-color".into(), "HEAD~1".into()])
        );
        assert_eq!(
            git_diff_rerun_args("git diff --no-color --no-ext-diff --no-textconv HEAD^"),
            Ok(vec![
                "--no-color".into(),
                "--no-ext-diff".into(),
                "--no-textconv".into(),
                "HEAD^".into()
            ])
        );
    }

    #[test]
    fn git_diff_rerun_args_rejects_shell_syntax_other_commands_and_denied_options() {
        for cmdline in [
            "git diff | head",
            "git diff 'a b'",
            "git diff $X",
            "git diff\nrm x",
            "git -C x diff",
            "git -c a=b diff",
            "git show",
            "env X=1 git diff",
            "git diff --output=x",
            "git diff --out=x",
            "git diff --ext-diff",
            "git diff --textconv",
            "git diff --word-diff",
            "git diff --word-diff-regex=.",
            "git diff --color=always",
            "git diff --color-words",
            "git diff --color-moved",
            "git diff ~/x",
            "git diff --src-prefix=~/x",
        ] {
            assert!(
                git_diff_rerun_args(cmdline).is_err(),
                "{cmdline:?} must be rejected"
            );
        }
    }

    #[test]
    fn native_git_diff_ignores_pager_and_color_config() {
        let dir = test_repo("native-diff");
        git_ok(&dir, &["config", "core.pager", "less"]);
        git_ok(&dir, &["config", "color.ui", "always"]);
        std::fs::write(dir.join("tracked.txt"), "old\n").expect("write tracked");
        git_ok(&dir, &["add", "."]);
        git_ok(&dir, &["commit", "-qm", "init"]);
        std::fs::write(dir.join("tracked.txt"), "new\n").expect("modify tracked");

        let cwd = dir.to_str().expect("utf8 path");
        let diff = native_git_diff(cwd, "git diff").expect("native diff");
        assert!(diff.contains("diff --git"), "missing diff header: {diff}");
        assert!(diff.contains("+new"), "missing change: {diff}");
        assert!(!diff.contains('\x1b'), "diff must be plain: {diff:?}");
        assert_eq!(
            native_git_diff(cwd, "git diff --staged").expect("staged diff"),
            ""
        );
        assert!(native_git_diff(cwd, "git diff --color=always").is_err());
        assert!(native_git_diff("", "git diff").is_err());
        std::fs::remove_dir_all(dir).expect("cleanup");
    }

    #[test]
    fn git_status_rerun_args_accepts_plain_git_status() {
        assert_eq!(
            git_status_rerun_args("git status"),
            Ok(StatusRerun::default())
        );
        assert_eq!(
            git_status_rerun_args("git --no-pager status -sb"),
            Ok(StatusRerun::default())
        );
        assert_eq!(
            git_status_rerun_args("git status -uno -- src docs"),
            Ok(StatusRerun {
                untracked: Some("no".into()),
                ignored: None,
                paths: vec!["src".into(), "docs".into()],
            })
        );
        assert_eq!(
            git_status_rerun_args("git status --ignored=matching"),
            Ok(StatusRerun {
                ignored: Some("matching".into()),
                ..StatusRerun::default()
            })
        );
        assert_eq!(
            git_status_rerun_args("git status -s --long -u --ignored src -- -odd"),
            Ok(StatusRerun {
                untracked: Some("all".into()),
                ignored: Some("traditional".into()),
                paths: vec!["src".into(), "-odd".into()],
            })
        );
        assert_eq!(
            git_status_rerun_args("git status --untracked-files=normal"),
            Ok(StatusRerun {
                untracked: Some("normal".into()),
                ..StatusRerun::default()
            })
        );
    }

    #[test]
    fn git_status_rerun_args_rejects_shell_syntax_other_commands_and_options() {
        for cmdline in [
            "git status -v",
            "git status --porcelain",
            "git status --porcelain=v2",
            "git status -z",
            "git status --column",
            "git -C x status",
            "git status | cat",
            "git status 'a b'",
            "git stash",
            "git status -ufoo",
            "git status --untracked-files=",
            "git status --ignored=all",
            "git status ~/x",
            "git status -- a*",
        ] {
            assert!(
                git_status_rerun_args(cmdline).is_err(),
                "{cmdline:?} must be rejected"
            );
        }
    }

    #[test]
    fn native_git_status_returns_porcelain_v2_and_numstats() {
        let dir = test_repo("native-status");
        git_ok(&dir, &["config", "color.ui", "always"]);
        git_ok(&dir, &["config", "status.short", "true"]);
        std::fs::write(dir.join("staged.txt"), "old\n").expect("seed staged");
        std::fs::write(dir.join("unstaged.txt"), "old\n").expect("seed unstaged");
        git_ok(&dir, &["add", "."]);
        git_ok(&dir, &["commit", "-qm", "init"]);
        std::fs::write(dir.join("staged.txt"), "new\n").expect("modify staged");
        git_ok(&dir, &["add", "staged.txt"]);
        std::fs::write(dir.join("unstaged.txt"), "new\n").expect("modify unstaged");
        std::fs::write(dir.join("untracked.txt"), "new\n").expect("write untracked");

        let cwd = dir.to_str().expect("utf8 path");
        let out = native_git_status(cwd, "git status -sb").expect("native status");
        let entries: Vec<&str> = out.status.split('\0').collect();
        assert!(
            entries.iter().any(|e| e.starts_with("# branch.head ")),
            "missing branch header: {:?}",
            out.status
        );
        assert!(
            entries
                .iter()
                .any(|e| e.starts_with("1 M. ") && e.ends_with(" staged.txt")),
            "missing staged entry: {:?}",
            out.status
        );
        assert!(
            entries
                .iter()
                .any(|e| e.starts_with("1 .M ") && e.ends_with(" unstaged.txt")),
            "missing unstaged entry: {:?}",
            out.status
        );
        assert!(
            entries.contains(&"? untracked.txt"),
            "missing untracked entry: {:?}",
            out.status
        );
        assert!(!out.status.contains('\x1b'), "status must be plain");
        assert!(out.staged_numstat.contains("staged.txt"));
        assert!(!out.staged_numstat.contains("unstaged.txt"));
        assert!(out.unstaged_numstat.contains("unstaged.txt"));
        assert!(!out.unstaged_numstat.contains('\x1b'));

        let scoped = native_git_status(cwd, "git status -uno -- staged.txt").expect("scoped");
        assert!(scoped.status.contains("staged.txt"));
        assert!(!scoped.status.contains("unstaged.txt"));
        assert!(!scoped.status.contains("untracked.txt"));
        assert_eq!(scoped.unstaged_numstat, "");

        assert!(native_git_status(cwd, "git status -v").is_err());
        assert!(native_git_status("", "git status").is_err());
        std::fs::remove_dir_all(dir).expect("cleanup");
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
    fn status_parser_preserves_unusual_paths() {
        let status = b" M tab\tline\nname.txt\0R  renamed.txt\0old.txt\0UU conflict.txt\0";
        assert_eq!(
            parse_status_porcelain_z(status),
            vec![
                ("tab\tline\nname.txt".to_string(), "M".to_string()),
                ("renamed.txt".to_string(), "R".to_string()),
                ("conflict.txt".to_string(), "!".to_string()),
            ]
        );
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

    fn commit_file(dir: &Path, name: &str, content: &[u8], message: &str) {
        std::fs::write(dir.join(name), content).expect("write file");
        git_ok(dir, &["add", name]);
        git_ok(dir, &["commit", "-qm", message]);
    }

    fn subjects(page: &GitLogPage) -> Vec<&str> {
        page.commits.iter().map(|c| c.subject.as_str()).collect()
    }

    #[test]
    fn log_page_keeps_prose_drops_trailers_and_sums_numstat() {
        let dir = test_repo("log-body");
        std::fs::write(dir.join("a.txt"), "one\ntwo\n").expect("seed text");
        std::fs::write(dir.join("blob.bin"), [0u8, 1, 2, 0, 255]).expect("seed binary");
        git_ok(&dir, &["add", "."]);
        git_ok(
            &dir,
            &[
                "commit",
                "-q",
                "-m",
                "Add capsule",
                "-m",
                "Intro line.\ncapsule: the LED blinks on idle\nLast line.",
                "-m",
                "Co-Authored-By: Bot <bot@example.com>\nSigned-off-by: t <t@t>",
            ],
        );
        let page = git_log_page(dir.to_str().expect("utf8"), 0, 10).expect("log page");
        assert_eq!(page.commits.len(), 1);
        assert!(!page.has_more);
        assert!(page.branch.is_some());
        assert_eq!(page.repo_name, repo_name(&page.repo_root));
        let commit = &page.commits[0];
        let head = run_git(&dir, &["rev-parse", "HEAD"]).expect("rev-parse");
        assert_eq!(commit.sha, head.trim());
        assert_eq!(commit.short_sha, &commit.sha[..7]);
        assert_eq!(commit.author, "t");
        assert!(commit.at > 0);
        assert_eq!(commit.subject, "Add capsule");
        assert_eq!(
            commit.body,
            "Intro line.\ncapsule: the LED blinks on idle\nLast line."
        );
        assert!(!commit.is_merge);
        // The binary file counts as touched with 0 lines.
        assert_eq!((commit.files, commit.added, commit.removed), (2, 2, 0));
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn trailer_block_only_drops_a_final_all_trailer_paragraph() {
        assert_eq!(strip_trailer_block("Co-Authored-By: a <a@b>\n"), "");
        assert_eq!(
            strip_trailer_block("capsule: the LED\n\nmore prose\n"),
            "capsule: the LED\n\nmore prose"
        );
        assert_eq!(
            strip_trailer_block("prose\n\nSigned-off-by: t <t@t>\nnot a trailer"),
            "prose\n\nSigned-off-by: t <t@t>\nnot a trailer"
        );
        assert_eq!(
            strip_trailer_block("prose\n\nsee https://example.com"),
            "prose\n\nsee https://example.com"
        );
        assert_eq!(strip_trailer_block("  \n"), "");
    }

    #[test]
    fn log_page_reports_has_more_at_the_boundary_and_honours_skip() {
        let dir = test_repo("log-pages");
        commit_file(&dir, "one.txt", b"1\n", "c1");
        git_ok(&dir, &["commit", "-q", "--allow-empty", "-m", "c2"]);
        commit_file(&dir, "three.txt", b"3\n", "c3");
        let cwd = dir.to_str().expect("utf8");

        let all = git_log_page(cwd, 0, 3).expect("full page");
        assert_eq!(subjects(&all), ["c3", "c2", "c1"]);
        assert!(!all.has_more);
        assert_eq!(all.commits[1].files, 0);

        let first = git_log_page(cwd, 0, 2).expect("first page");
        assert_eq!(subjects(&first), ["c3", "c2"]);
        assert!(first.has_more);

        let rest = git_log_page(cwd, 2, 2).expect("second page");
        assert_eq!(subjects(&rest), ["c1"]);
        assert!(!rest.has_more);
        assert_eq!(rest.commits[0].files, 1);

        let clamped = git_log_page(cwd, 0, 0).expect("clamped page");
        assert_eq!(subjects(&clamped), ["c3"]);
        assert!(clamped.has_more);
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn log_page_measures_a_merge_against_its_first_parent() {
        let dir = test_repo("log-merge");
        commit_file(&dir, "base.txt", b"base\n", "base");
        git_ok(&dir, &["checkout", "-qb", "feature"]);
        commit_file(&dir, "f.txt", b"1\n2\n3\n", "feature work");
        git_ok(&dir, &["checkout", "-q", "-"]);
        commit_file(&dir, "m.txt", b"main\n", "main work");
        git_ok(
            &dir,
            &[
                "merge",
                "-q",
                "--no-ff",
                "--no-edit",
                "-m",
                "merge feature",
                "feature",
            ],
        );
        let cwd = dir.to_str().expect("utf8");

        let page = git_log_page(cwd, 0, 10).expect("log page");
        let merge = &page.commits[0];
        assert_eq!(merge.subject, "merge feature");
        assert!(merge.is_merge);
        assert_eq!((merge.files, merge.added, merge.removed), (1, 3, 0));
        assert!(page.commits[1..].iter().all(|c| !c.is_merge));

        git_ok(&dir, &["checkout", "-q", "--detach"]);
        assert_eq!(git_log_page(cwd, 0, 1).expect("detached").branch, None);
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn log_page_rejects_unborn_and_non_repositories() {
        let dir = test_repo("log-unborn");
        assert_eq!(
            git_log_page(dir.to_str().expect("utf8"), 0, 10),
            Err("repository has no commits".to_string())
        );
        std::fs::remove_dir_all(&dir).ok();

        let suffix = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("clock after epoch")
            .as_nanos();
        let plain =
            std::env::temp_dir().join(format!("krypton-log-plain-{}-{suffix}", std::process::id()));
        std::fs::create_dir_all(&plain).expect("create plain dir");
        assert_eq!(
            git_log_page(plain.to_str().expect("utf8"), 0, 10),
            Err("not a git repository".to_string())
        );
        std::fs::remove_dir_all(&plain).ok();

        assert_eq!(
            git_log_page("", 0, 10),
            Err("no working directory".to_string())
        );
    }

    #[test]
    fn commit_diff_rejects_non_hex_ids_and_shows_the_commit() {
        let dir = test_repo("commit-diff");
        commit_file(&dir, "hello.txt", b"hello\n", "hello");
        commit_file(&dir, "other.txt", b"other\n", "other");
        let cwd = dir.to_str().expect("utf8");

        let too_long = "a".repeat(41);
        for bad in ["--output=x", "zzzz", "abc", "HEAD", too_long.as_str()] {
            assert_eq!(
                git_commit_diff(cwd, bad),
                Err("invalid commit id".to_string()),
                "{bad}"
            );
        }

        let first = run_git(&dir, &["rev-parse", "HEAD~1"]).expect("rev-parse");
        let diff = git_commit_diff(cwd, first.trim()).expect("commit diff");
        assert!(diff.contains("b/hello.txt"), "{diff}");
        assert!(diff.contains("+hello"), "{diff}");
        assert!(!diff.contains("other.txt"), "{diff}");
        std::fs::remove_dir_all(&dir).ok();
    }
}
