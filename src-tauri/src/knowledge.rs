// Commit explainer library (spec 375).
//
// A lane writes one Markdown explainer per commit into a single global
// directory (`[knowledge] dir`), named `<repo>-<sha7>.md`. This module owns
// the directory resolution, the path a lane is handed, and the scan the
// Commit Browser uses to light its row lamps.

use crate::git;
use serde::Serialize;
use std::path::{Path, PathBuf};

/// One explainer on disk.
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct KnowledgeDoc {
    pub repo: String,
    pub short_sha: String,
    pub path: String,
}

/// Every explainer in the knowledge directory.
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct KnowledgeIndex {
    /// The resolved directory, so the frontend can root a Markdown Viewer there.
    pub dir: String,
    /// Sorted by repo, then short sha.
    pub docs: Vec<KnowledgeDoc>,
}

/// Resolve `[knowledge] dir`: `~` / `~/…` expand to the home directory, empty
/// means `~/.config/krypton/knowledge`, and any other relative path is refused
/// because there is no project it could be relative to.
pub fn resolve_dir(raw: &str) -> Result<PathBuf, String> {
    let raw = raw.trim();
    if raw.is_empty() {
        return crate::config::config_dir()
            .map(|dir| dir.join("knowledge"))
            .ok_or_else(|| "Cannot resolve the home directory".to_string());
    }
    let from_home = raw == "~" || raw.starts_with("~/");
    let path = crate::ssh_channel::expand_home(raw.to_string());
    if path.is_absolute() {
        Ok(path)
    } else if from_home {
        Err("Cannot resolve the home directory".to_string())
    } else {
        Err("[knowledge] dir must be absolute or start with ~/".to_string())
    }
}

/// Where a lane should write the explainer of commit `sha` from the repo at
/// `cwd`: `<dir>/<repo_name>-<sha7>.md`. Verifies the commit exists and
/// creates `dir`; the lane writes the file itself.
pub fn write_path(dir: &Path, cwd: &str, sha: &str) -> Result<String, String> {
    resolve_target(dir, cwd, sha).map(|t| t.path.to_string_lossy().into_owned())
}

/// Validated destination of one commit's explainer.
struct Target {
    repo: String,
    sha7: String,
    path: PathBuf,
}

/// Shared validation: commit id shape, repo root, commit exists; creates `dir`.
fn resolve_target(dir: &Path, cwd: &str, sha: &str) -> Result<Target, String> {
    if !git::is_commit_id(sha) {
        return Err("invalid commit id".to_string());
    }
    if cwd.is_empty() {
        return Err("no working directory".to_string());
    }
    let root = git::repo_root(Path::new(cwd)).ok_or_else(|| "not a git repository".to_string())?;
    let spec = format!("{sha}^{{commit}}");
    let full = git::run_git(
        Path::new(&root),
        &["rev-parse", "--verify", "--quiet", spec.as_str()],
    )
    .map(|out| out.trim().to_string())
    .filter(|out| !out.is_empty())
    .ok_or_else(|| format!("unknown commit {sha}"))?;
    let sha7: String = full.chars().take(7).collect();
    std::fs::create_dir_all(dir).map_err(|e| format!("create knowledge directory: {e}"))?;
    let repo = git::repo_name(&root).to_string();
    let path = dir.join(format!("{repo}-{sha7}.md"));
    Ok(Target { repo, sha7, path })
}

/// Paths for one background explainer job (spec 376).
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct KnowledgeJob {
    pub scratch: String,
    pub draft: String,
    pub path: String,
    pub repo: String,
}

const DRAFT_NAME: &str = "explainer.md";
const MAX_DRAFT_BYTES: u64 = 1_048_576;

fn scratch_dir(temp_root: &Path, t: &Target) -> PathBuf {
    temp_root
        .join("krypton-learn")
        .join(format!("{}-{}", t.repo, t.sha7))
}

/// Validate the commit and hand out a fresh, empty scratch dir for the agent.
pub fn job_prepare(dir: &Path, cwd: &str, sha: &str) -> Result<KnowledgeJob, String> {
    job_prepare_in(&std::env::temp_dir(), dir, cwd, sha)
}

fn job_prepare_in(
    temp_root: &Path,
    dir: &Path,
    cwd: &str,
    sha: &str,
) -> Result<KnowledgeJob, String> {
    let t = resolve_target(dir, cwd, sha)?;
    let scratch = scratch_dir(temp_root, &t);
    if scratch.exists() {
        std::fs::remove_dir_all(&scratch).map_err(|e| format!("clear scratch directory: {e}"))?;
    }
    std::fs::create_dir_all(&scratch).map_err(|e| format!("create scratch directory: {e}"))?;
    let scratch = scratch
        .canonicalize()
        .map_err(|e| format!("resolve scratch directory: {e}"))?;
    Ok(KnowledgeJob {
        draft: scratch.join(DRAFT_NAME).to_string_lossy().into_owned(),
        scratch: scratch.to_string_lossy().into_owned(),
        path: t.path.to_string_lossy().into_owned(),
        repo: t.repo,
    })
}

/// Copy the agent's `explainer.md` into the knowledge dir, then drop the
/// scratch dir. On error the scratch dir and the existing doc are untouched.
pub fn store(dir: &Path, cwd: &str, sha: &str) -> Result<String, String> {
    store_in(&std::env::temp_dir(), dir, cwd, sha)
}

fn store_in(temp_root: &Path, dir: &Path, cwd: &str, sha: &str) -> Result<String, String> {
    let t = resolve_target(dir, cwd, sha)?;
    let scratch = scratch_dir(temp_root, &t);
    let draft = scratch.join(DRAFT_NAME);
    let meta = match std::fs::metadata(&draft) {
        Ok(m) if m.is_file() => m,
        _ => return Err("finished without writing explainer.md".to_string()),
    };
    if meta.len() == 0 {
        return Err("explainer.md is empty".to_string());
    }
    if meta.len() > MAX_DRAFT_BYTES {
        return Err("explainer.md is over 1 MiB".to_string());
    }
    let bytes = std::fs::read(&draft).map_err(|e| format!("read explainer.md: {e}"))?;
    let text = String::from_utf8(bytes).map_err(|_| "explainer.md is not UTF-8".to_string())?;
    if text.is_empty() {
        return Err("explainer.md is empty".to_string());
    }
    let mut tmp = t.path.clone().into_os_string();
    tmp.push(".tmp");
    let tmp = PathBuf::from(tmp);
    std::fs::write(&tmp, text.as_bytes()).map_err(|e| format!("write explainer: {e}"))?;
    if let Err(e) = std::fs::rename(&tmp, &t.path) {
        let _ = std::fs::remove_file(&tmp);
        return Err(format!("store explainer: {e}"));
    }
    if let Err(e) = std::fs::remove_dir_all(&scratch) {
        log::warn!("remove scratch {}: {e}", scratch.display());
    }
    Ok(t.path.to_string_lossy().into_owned())
}

/// Every `<repo>-<7 lowercase hex>.md` regular file in `dir`. A missing
/// directory is an empty library, not an error.
pub fn list(dir: &Path) -> KnowledgeIndex {
    let mut docs = Vec::new();
    match std::fs::read_dir(dir) {
        Ok(entries) => {
            for entry in entries.flatten() {
                let path = entry.path();
                if !path.is_file() {
                    continue;
                }
                let file_name = entry.file_name();
                let Some((repo, short_sha)) = file_name.to_str().and_then(parse_doc_name) else {
                    continue;
                };
                docs.push(KnowledgeDoc {
                    repo: repo.to_string(),
                    short_sha: short_sha.to_string(),
                    path: path.to_string_lossy().into_owned(),
                });
            }
        }
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
        Err(e) => log::warn!("knowledge: read {}: {e}", dir.display()),
    }
    docs.sort_by(|a, b| {
        a.repo
            .cmp(&b.repo)
            .then_with(|| a.short_sha.cmp(&b.short_sha))
    });
    KnowledgeIndex {
        dir: dir.to_string_lossy().into_owned(),
        docs,
    }
}

/// Split `<repo>-<sha7>.md` at its last `-`; the repo name may itself hold `-`.
fn parse_doc_name(name: &str) -> Option<(&str, &str)> {
    let (repo, short_sha) = name.strip_suffix(".md")?.rsplit_once('-')?;
    let is_sha7 = short_sha.len() == 7
        && short_sha
            .bytes()
            .all(|b| matches!(b, b'0'..=b'9' | b'a'..=b'f'));
    (!repo.is_empty() && is_sha7).then_some((repo, short_sha))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::process::Command;
    use std::time::{SystemTime, UNIX_EPOCH};

    struct Scratch(PathBuf);

    impl Scratch {
        fn new(tag: &str) -> Self {
            let suffix = SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .expect("clock after epoch")
                .as_nanos();
            let dir = std::env::temp_dir().join(format!(
                "krypton-knowledge-{tag}-{}-{suffix}",
                std::process::id()
            ));
            std::fs::create_dir_all(&dir).expect("scratch dir");
            Self(dir)
        }
        fn path(&self) -> &Path {
            &self.0
        }
    }

    impl Drop for Scratch {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
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

    /// A repo named `my-repo` with one commit; returns its path and full sha.
    fn repo_with_commit(scratch: &Scratch) -> (PathBuf, String) {
        let repo = scratch.path().join("my-repo");
        std::fs::create_dir_all(&repo).expect("repo dir");
        git_ok(&repo, &["init", "-q"]);
        git_ok(&repo, &["config", "user.email", "t@t"]);
        git_ok(&repo, &["config", "user.name", "t"]);
        std::fs::write(repo.join("a.txt"), "a\n").expect("seed");
        git_ok(&repo, &["add", "."]);
        git_ok(&repo, &["commit", "-qm", "seed"]);
        let sha = git::run_git(&repo, &["rev-parse", "HEAD"]).expect("rev-parse");
        (repo, sha.trim().to_string())
    }

    #[test]
    fn write_path_names_the_doc_and_creates_the_dir() {
        let scratch = Scratch::new("write");
        let (repo, sha) = repo_with_commit(&scratch);
        let dir = scratch.path().join("out").join("knowledge");
        let cwd = repo.to_str().expect("utf8");

        let path = write_path(&dir, cwd, &sha[..10]).expect("write path");
        assert_eq!(
            path,
            dir.join(format!("my-repo-{}.md", &sha[..7]))
                .to_string_lossy()
        );
        assert!(dir.is_dir());

        std::fs::write(&path, "# explainer\n").expect("write doc");
        let index = list(&dir);
        assert_eq!(index.docs.len(), 1);
        assert_eq!(index.docs[0].repo, "my-repo");
        assert_eq!(index.docs[0].short_sha, &sha[..7]);
        assert_eq!(index.docs[0].path, path);
    }

    #[test]
    fn write_path_rejects_bad_ids_unknown_commits_and_non_repos() {
        let scratch = Scratch::new("write-reject");
        let (repo, _) = repo_with_commit(&scratch);
        let dir = scratch.path().join("knowledge");
        let cwd = repo.to_str().expect("utf8");

        assert_eq!(
            write_path(&dir, cwd, "--output=x"),
            Err("invalid commit id".to_string())
        );
        assert_eq!(
            write_path(&dir, cwd, "deadbeef"),
            Err("unknown commit deadbeef".to_string())
        );
        let plain = scratch.path().join("plain");
        std::fs::create_dir_all(&plain).expect("plain dir");
        assert_eq!(
            write_path(&dir, plain.to_str().expect("utf8"), "deadbeef"),
            Err("not a git repository".to_string())
        );
        assert!(!dir.exists());
    }

    #[test]
    fn list_keeps_only_doc_names_sorted() {
        let scratch = Scratch::new("list");
        let dir = scratch.path();
        for name in [
            "zeta-abcdef0.md",
            "my-repo-0123456.md",
            "krypton-abc1234.md",
            "notes.md",
            "x-1234567.txt",
            "x-ABCDEFG.md",
            "x-12345678.md",
            "-1234567.md",
        ] {
            std::fs::write(dir.join(name), "").expect("seed file");
        }
        std::fs::create_dir_all(dir.join("folder-1234567.md")).expect("seed dir");

        let index = list(dir);
        assert_eq!(index.dir, dir.to_string_lossy());
        let names: Vec<(&str, &str)> = index
            .docs
            .iter()
            .map(|doc| (doc.repo.as_str(), doc.short_sha.as_str()))
            .collect();
        assert_eq!(
            names,
            [
                ("krypton", "abc1234"),
                ("my-repo", "0123456"),
                ("zeta", "abcdef0")
            ]
        );
    }

    #[test]
    fn list_of_a_missing_dir_is_empty() {
        let scratch = Scratch::new("list-missing");
        let dir = scratch.path().join("absent");
        let index = list(&dir);
        assert_eq!(index.dir, dir.to_string_lossy());
        assert!(index.docs.is_empty());
    }

    #[test]
    fn resolve_dir_expands_home_and_refuses_relative_paths() {
        let home = dirs::home_dir().expect("home dir");
        assert_eq!(
            resolve_dir("/abs/knowledge"),
            Ok(PathBuf::from("/abs/knowledge"))
        );
        assert_eq!(resolve_dir("~/notes/k"), Ok(home.join("notes/k")));
        assert_eq!(resolve_dir("~"), Ok(home.clone()));
        assert_eq!(
            resolve_dir(""),
            Ok(home.join(".config").join("krypton").join("knowledge"))
        );
        for relative in ["notes/k", "~user/k", "./k"] {
            assert_eq!(
                resolve_dir(relative),
                Err("[knowledge] dir must be absolute or start with ~/".to_string()),
                "{relative}"
            );
        }
    }

    #[test]
    fn job_prepare_makes_a_fresh_scratch_dir() {
        let scratch = Scratch::new("prepare");
        let (repo, sha) = repo_with_commit(&scratch);
        let dir = scratch.path().join("knowledge");
        let tmp = scratch.path().join("tmp");
        let cwd = repo.to_str().expect("utf8");
        let sha7 = &sha[..7];

        let stale = tmp.join("krypton-learn").join(format!("my-repo-{sha7}"));
        std::fs::create_dir_all(&stale).expect("stale dir");
        std::fs::write(stale.join("explainer.md"), "old").expect("stale draft");

        let job = job_prepare_in(&tmp, &dir, cwd, &sha[..10]).expect("prepare");
        let canon = stale.canonicalize().expect("canon");
        assert_eq!(job.scratch, canon.to_string_lossy());
        assert_eq!(job.draft, canon.join("explainer.md").to_string_lossy());
        assert_eq!(
            job.path,
            dir.join(format!("my-repo-{sha7}.md")).to_string_lossy()
        );
        assert_eq!(job.repo, "my-repo");
        assert_eq!(std::fs::read_dir(&canon).expect("read").count(), 0);
        assert!(dir.is_dir());
    }

    #[test]
    fn store_copies_the_draft_and_removes_the_scratch() {
        let scratch = Scratch::new("store");
        let (repo, sha) = repo_with_commit(&scratch);
        let dir = scratch.path().join("knowledge");
        let tmp = scratch.path().join("tmp");
        let cwd = repo.to_str().expect("utf8");

        let job = job_prepare_in(&tmp, &dir, cwd, &sha).expect("prepare");
        std::fs::write(&job.path, "old doc").expect("existing doc");
        std::fs::write(&job.draft, "# new\n").expect("draft");

        let path = store_in(&tmp, &dir, cwd, &sha).expect("store");
        assert_eq!(path, job.path);
        assert_eq!(std::fs::read_to_string(&path).expect("doc"), "# new\n");
        assert!(!Path::new(&job.scratch).exists());
        assert!(!Path::new(&format!("{path}.tmp")).exists());
    }

    #[test]
    fn store_rejects_bad_drafts_and_keeps_the_doc() {
        let scratch = Scratch::new("store-bad");
        let (repo, sha) = repo_with_commit(&scratch);
        let dir = scratch.path().join("knowledge");
        let tmp = scratch.path().join("tmp");
        let cwd = repo.to_str().expect("utf8");

        let job = job_prepare_in(&tmp, &dir, cwd, &sha).expect("prepare");
        std::fs::write(&job.path, "old doc").expect("existing doc");

        assert_eq!(
            store_in(&tmp, &dir, cwd, &sha),
            Err("finished without writing explainer.md".to_string())
        );
        std::fs::write(&job.draft, "").expect("empty");
        assert_eq!(
            store_in(&tmp, &dir, cwd, &sha),
            Err("explainer.md is empty".to_string())
        );
        std::fs::write(&job.draft, vec![b'a'; 1_048_577]).expect("big");
        assert_eq!(
            store_in(&tmp, &dir, cwd, &sha),
            Err("explainer.md is over 1 MiB".to_string())
        );
        std::fs::write(&job.draft, [0xff, 0xfe, 0x00]).expect("binary");
        assert_eq!(
            store_in(&tmp, &dir, cwd, &sha),
            Err("explainer.md is not UTF-8".to_string())
        );
        assert_eq!(std::fs::read_to_string(&job.path).expect("doc"), "old doc");
        assert!(Path::new(&job.scratch).is_dir());
    }

    #[test]
    fn job_rejects_bad_sha_and_unknown_commit() {
        let scratch = Scratch::new("job-bad");
        let (repo, _) = repo_with_commit(&scratch);
        let dir = scratch.path().join("knowledge");
        let tmp = scratch.path().join("tmp");
        let cwd = repo.to_str().expect("utf8");

        assert_eq!(
            job_prepare_in(&tmp, &dir, cwd, "not-a-sha"),
            Err("invalid commit id".to_string())
        );
        assert_eq!(
            store_in(&tmp, &dir, cwd, "not-a-sha"),
            Err("invalid commit id".to_string())
        );
        assert_eq!(
            job_prepare_in(&tmp, &dir, cwd, "deadbeef"),
            Err("unknown commit deadbeef".to_string())
        );
        assert_eq!(
            store_in(&tmp, &dir, cwd, "deadbeef"),
            Err("unknown commit deadbeef".to_string())
        );
    }
}
