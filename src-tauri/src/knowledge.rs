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
    let name = format!("{}-{sha7}.md", git::repo_name(&root));
    Ok(dir.join(name).to_string_lossy().into_owned())
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
}
