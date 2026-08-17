// Shared review-anchor excerpt extraction (specs 217 + 230).
//
// The `#reviews` archive reads the live working tree while rendering. Xenon
// has no checkout, so `#push` runs the same guards here and ships the result
// as `excerpts.json` on the published revision.

use std::collections::{BTreeMap, HashMap};
use std::path::{Path, PathBuf};
use std::time::UNIX_EPOCH;

use ignore::gitignore::{Gitignore, GitignoreBuilder};
use serde::{Deserialize, Serialize};

/// Extensions an excerpt may be read from. Text and source only.
pub const EXCERPT_EXTS: &[&str] = &[
    "rs", "ts", "tsx", "js", "jsx", "mjs", "cjs", "css", "scss", "html", "md", "toml", "json",
    "yaml", "yml", "py", "sh", "bash", "fish", "zsh", "go", "java", "kt", "swift", "rb", "php",
    "c", "h", "cpp", "hpp", "sql", "txt", "lua", "conf", "ini", "xml", "svelte", "vue",
];
const EXCERPT_CONTEXT: usize = 6;
const EXCERPT_RANGE_MAX: usize = 40;
const EXCERPT_COL_MAX: usize = 400;
const EXCERPT_FILE_BYTES: u64 = 2 * 1024 * 1024;
const EXCERPT_PER_PAGE: usize = 60;

/// A `path`, `path:line`, or `path:start-end` anchor written by a lane.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RvAnchor {
    pub rel: String,
    pub start: Option<usize>,
    pub end: Option<usize>,
}

/// Why an anchor produced no excerpt.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum RvSkip {
    Rejected,
    Missing,
    Drifted { lines: usize },
    Budget,
}

/// The window of source an anchor points at, ready to render or serialise.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RvExcerpt {
    pub label: String,
    pub first_line: usize,
    pub lines: Vec<String>,
    pub anchor_line: Option<usize>,
    pub omitted: usize,
    pub stale: bool,
}

struct RvFile {
    lines: Vec<String>,
    mtime_ms: i64,
}

/// Everything the excerpt pass needs. Absent (`None`) on renderers that have
/// no project context — they then behave as they did before excerpts existed.
pub struct RvSrcCtx {
    project_dir: PathBuf,
    root: PathBuf,
    created_ms: i64,
    ignore: Option<Gitignore>,
    used: usize,
    pub overflowed: bool,
    cache: HashMap<PathBuf, Option<RvFile>>,
}

impl RvSrcCtx {
    pub fn new(project_dir: &str, created_ms: i64) -> Self {
        let project_dir = PathBuf::from(project_dir);
        let root = project_dir
            .canonicalize()
            .unwrap_or_else(|_| project_dir.clone());
        let ignore = {
            let mut builder = GitignoreBuilder::new(&root);
            let _ = builder.add(root.join(".gitignore"));
            let _ = builder.add(root.join(".git/info/exclude"));
            builder.build().ok()
        };
        Self {
            project_dir,
            root,
            created_ms,
            ignore,
            used: 0,
            overflowed: false,
            cache: HashMap::new(),
        }
    }

    fn ignored(&self, path: &Path) -> bool {
        let rel = path.strip_prefix(&self.root).unwrap_or(path);
        if rel.components().any(|c| c.as_os_str() == ".krypton") {
            return true;
        }
        let Some(ignore) = &self.ignore else {
            return false;
        };
        ignore.matched_path_or_any_parents(rel, false).is_ignore()
    }

    pub fn excerpt(&mut self, anchor: &RvAnchor) -> Result<RvExcerpt, RvSkip> {
        if self.used >= EXCERPT_PER_PAGE {
            self.overflowed = true;
            return Err(RvSkip::Budget);
        }
        let path =
            validate_doc_path(&self.project_dir, &anchor.rel, EXCERPT_EXTS).map_err(|e| {
                if e.starts_with("not_found") {
                    RvSkip::Missing
                } else {
                    RvSkip::Rejected
                }
            })?;
        if self.ignored(&path) {
            return Err(RvSkip::Rejected);
        }

        let created_ms = self.created_ms;
        let entry = self.cache.entry(path.clone()).or_insert_with(|| {
            let meta = std::fs::metadata(&path).ok()?;
            if meta.len() > EXCERPT_FILE_BYTES {
                return None;
            }
            let text = std::fs::read_to_string(&path).ok()?;
            let mtime_ms = meta
                .modified()
                .ok()
                .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
                .map(|d| d.as_millis() as i64)
                .unwrap_or(0);
            Some(RvFile {
                lines: text.lines().map(str::to_string).collect(),
                mtime_ms,
            })
        });
        let file = entry.as_ref().ok_or(RvSkip::Rejected)?;
        let total = file.lines.len();

        let (first, last, anchor_line) = match (anchor.start, anchor.end) {
            (None, _) => (1, total.min(EXCERPT_CONTEXT * 2 + 1), None),
            (Some(start), None) => {
                if start > total {
                    return Err(RvSkip::Drifted { lines: total });
                }
                (
                    start.saturating_sub(EXCERPT_CONTEXT).max(1),
                    (start + EXCERPT_CONTEXT).min(total),
                    Some(start),
                )
            }
            (Some(start), Some(end)) => {
                if start > total {
                    return Err(RvSkip::Drifted { lines: total });
                }
                (start.max(1), end.min(total).max(start), None)
            }
        };
        if total == 0 {
            return Err(RvSkip::Drifted { lines: 0 });
        }

        let shown_last = last.min(first + EXCERPT_RANGE_MAX - 1);
        let lines: Vec<String> = file.lines[first - 1..shown_last]
            .iter()
            .map(|line| clamp_chars(line, EXCERPT_COL_MAX))
            .collect();
        let stale = created_ms > 0 && file.mtime_ms > created_ms;

        self.used += 1;
        Ok(RvExcerpt {
            label: format!("{}:{first}-{shown_last}", anchor.rel),
            first_line: first,
            lines,
            anchor_line,
            omitted: last.saturating_sub(shown_last),
            stale,
        })
    }
}

fn clamp_chars(s: &str, max: usize) -> String {
    if s.chars().count() <= max {
        return s.to_string();
    }
    let mut out: String = s.chars().take(max).collect();
    out.push('…');
    out
}

/// `src/x.ts` · `src/x.ts:835` · `src/x.ts:812-840`. `None` when not path-shaped.
pub fn rv_anchor(at: &str) -> Option<RvAnchor> {
    let raw = at.trim().trim_matches('`').trim_matches('"').trim();
    if raw.is_empty() || raw.contains(char::is_whitespace) {
        return None;
    }
    let (path, span) = match raw.rsplit_once(':') {
        Some((path, span)) if !path.is_empty() && rv_is_span(span) => (path, Some(span)),
        Some(_) => return None,
        None => (raw, None),
    };
    let rel = path.trim_start_matches("./").to_string();
    if rel.is_empty() {
        return None;
    }
    let (start, end) = match span {
        None => (None, None),
        Some(span) => match span.split_once('-') {
            Some((a, b)) => (a.parse().ok(), b.parse().ok()),
            None => (span.parse().ok(), None),
        },
    };
    if span.is_some() && start.is_none() {
        return None;
    }
    Some(RvAnchor { rel, start, end })
}

fn rv_is_span(s: &str) -> bool {
    if s.is_empty() {
        return false;
    }
    match s.split_once('-') {
        Some((a, b)) => {
            !a.is_empty()
                && !b.is_empty()
                && a.chars().all(|c| c.is_ascii_digit())
                && b.chars().all(|c| c.is_ascii_digit())
        }
        None => s.chars().all(|c| c.is_ascii_digit()),
    }
}

/// Relative, canonicalized, inside `cwd`, no symlink escape, allowlisted ext.
pub fn validate_doc_path(cwd: &Path, rel: &str, exts: &[&str]) -> Result<PathBuf, String> {
    if rel.is_empty() {
        return Err("path_invalid: empty path".to_string());
    }
    let rel_path = Path::new(rel);
    if rel_path.is_absolute() {
        return Err("path_invalid: absolute path rejected".to_string());
    }
    let cwd_canon = cwd
        .canonicalize()
        .map_err(|e| format!("not_found: cwd unavailable ({e})"))?;
    let candidate = cwd.join(rel_path);
    let candidate_canon = candidate
        .canonicalize()
        .map_err(|e| format!("not_found: file unavailable ({e})"))?;
    candidate_canon
        .strip_prefix(&cwd_canon)
        .map_err(|_| "path_invalid: outside cwd".to_string())?;
    let ext = candidate_canon
        .extension()
        .and_then(|ext| ext.to_str())
        .map(|ext| ext.to_ascii_lowercase())
        .ok_or_else(|| "path_invalid: missing extension".to_string())?;
    if !exts.iter().any(|allowed| *allowed == ext) {
        return Err("path_invalid: extension rejected".to_string());
    }
    let meta = std::fs::metadata(&candidate_canon)
        .map_err(|e| format!("not_found: metadata failed ({e})"))?;
    if !meta.is_file() {
        return Err("path_invalid: not a regular file".to_string());
    }
    Ok(candidate_canon)
}

/// Sidecar shipped on a published review revision (spec 230).
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct ExcerptSidecar {
    pub version: u32,
    pub anchors: BTreeMap<String, ExcerptRecord>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct ExcerptRecord {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub skip: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub file_lines: Option<usize>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub label: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub first_line: Option<usize>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub anchor_line: Option<usize>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub lines: Option<Vec<String>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub omitted: Option<usize>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub stale: Option<bool>,
}

impl ExcerptRecord {
    fn from_excerpt(excerpt: RvExcerpt) -> Self {
        Self {
            skip: None,
            file_lines: None,
            label: Some(excerpt.label),
            first_line: Some(excerpt.first_line),
            anchor_line: excerpt.anchor_line,
            lines: Some(excerpt.lines),
            omitted: Some(excerpt.omitted),
            stale: Some(excerpt.stale),
        }
    }

    fn missing() -> Self {
        Self {
            skip: Some("missing".into()),
            file_lines: None,
            label: None,
            first_line: None,
            anchor_line: None,
            lines: None,
            omitted: None,
            stale: None,
        }
    }

    fn drifted(lines: usize) -> Self {
        Self {
            skip: Some("drifted".into()),
            file_lines: Some(lines),
            label: None,
            first_line: None,
            anchor_line: None,
            lines: None,
            omitted: None,
            stale: None,
        }
    }
}

/// Walk `review.md` for walkthrough/finding anchors and resolve each one.
pub fn collect_review_excerpts(
    project_dir: &Path,
    review_md: &str,
    created_ms: i64,
) -> ExcerptSidecar {
    let mut ctx = RvSrcCtx::new(&project_dir.to_string_lossy(), created_ms);
    let mut anchors = BTreeMap::new();
    for (kind, body) in review_fences(review_md) {
        match kind.as_str() {
            "review:walkthrough" => {
                for key in walkthrough_anchor_keys(&body) {
                    insert_anchor(&mut anchors, &mut ctx, &key);
                }
            }
            "review:finding" => {
                if let Some(key) = finding_anchor_key(&body) {
                    insert_anchor(&mut anchors, &mut ctx, &key);
                }
            }
            _ => {}
        }
    }
    ExcerptSidecar {
        version: 1,
        anchors,
    }
}

fn insert_anchor(anchors: &mut BTreeMap<String, ExcerptRecord>, ctx: &mut RvSrcCtx, key: &str) {
    if anchors.contains_key(key) {
        return;
    }
    let Some(anchor) = rv_anchor(key) else {
        return;
    };
    match ctx.excerpt(&anchor) {
        Ok(excerpt) => {
            anchors.insert(key.to_string(), ExcerptRecord::from_excerpt(excerpt));
        }
        Err(RvSkip::Missing) => {
            anchors.insert(key.to_string(), ExcerptRecord::missing());
        }
        Err(RvSkip::Drifted { lines }) => {
            anchors.insert(key.to_string(), ExcerptRecord::drifted(lines));
        }
        Err(RvSkip::Rejected) | Err(RvSkip::Budget) => {}
    }
}

/// `created:` from YAML frontmatter, or 0 when absent / unparseable.
pub fn created_ms_from_review_md(text: &str) -> i64 {
    let mut in_front = false;
    for (i, line) in text.lines().enumerate() {
        let trimmed = line.trim();
        if i == 0 && trimmed == "---" {
            in_front = true;
            continue;
        }
        if !in_front {
            break;
        }
        if trimmed == "---" {
            break;
        }
        if let Some(rest) = trimmed.strip_prefix("created:") {
            let value = rest.trim().trim_matches(['"', '\'']);
            if let Some(ms) = parse_rfc3339_ms(value) {
                return ms;
            }
        }
    }
    0
}

fn parse_rfc3339_ms(value: &str) -> Option<i64> {
    let bytes = value.as_bytes();
    if bytes.len() < 10 {
        return None;
    }
    let year: i64 = value.get(0..4)?.parse().ok()?;
    let month: i64 = value.get(5..7)?.parse().ok()?;
    let day: i64 = value.get(8..10)?.parse().ok()?;
    let mut secs = days_from_civil(year, month, day) * 86_400;
    if bytes.len() >= 19 {
        let hour: i64 = value.get(11..13)?.parse().ok()?;
        let minute: i64 = value.get(14..16)?.parse().ok()?;
        let second: i64 = value.get(17..19)?.parse().ok()?;
        secs += hour * 3600 + minute * 60 + second;
        if bytes.len() >= 25 {
            let sign = match bytes[19] {
                b'+' => -1,
                b'-' => 1,
                _ => 0,
            };
            if sign != 0 {
                let oh: i64 = value.get(20..22).and_then(|s| s.parse().ok()).unwrap_or(0);
                let om: i64 = value.get(23..25).and_then(|s| s.parse().ok()).unwrap_or(0);
                secs += sign * (oh * 3600 + om * 60);
            }
        }
    }
    Some(secs * 1000)
}

fn days_from_civil(y: i64, m: i64, d: i64) -> i64 {
    let y = if m <= 2 { y - 1 } else { y };
    let era = if y >= 0 { y } else { y - 399 } / 400;
    let yoe = y - era * 400;
    let mp = (m + 9) % 12;
    let doy = (153 * mp + 2) / 5 + d - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    era * 146_097 + doe - 719_468
}

fn review_fences(md: &str) -> Vec<(String, String)> {
    let mut out = Vec::new();
    let lines: Vec<&str> = md.lines().collect();
    let mut i = 0;
    while i < lines.len() {
        let line = lines[i];
        let ticks = line.chars().take_while(|c| *c == '`').count();
        if ticks < 3 {
            i += 1;
            continue;
        }
        let info = line[ticks..].trim().to_ascii_lowercase();
        if !info.starts_with("review:") {
            i += 1;
            continue;
        }
        i += 1;
        let mut body = String::new();
        while i < lines.len() {
            let close = lines[i].chars().take_while(|c| *c == '`').count();
            if close >= ticks && lines[i][close..].trim().is_empty() {
                break;
            }
            if !body.is_empty() {
                body.push('\n');
            }
            body.push_str(lines[i]);
            i += 1;
        }
        out.push((info, body));
        i += 1;
    }
    out
}

fn walkthrough_anchor_keys(body: &str) -> Vec<String> {
    let mut keys = Vec::new();
    for line in rv_group(body, "steps") {
        if let Some(at) = line
            .strip_prefix("- at:")
            .or_else(|| line.strip_prefix("-at:"))
        {
            let key = rv_unquote(at);
            if !key.is_empty() {
                keys.push(key);
            }
        }
    }
    keys
}

fn finding_anchor_key(body: &str) -> Option<String> {
    let file = rv_unquote(&rv_scalar(body, "file")?);
    if file.is_empty() {
        return None;
    }
    match rv_scalar(body, "line") {
        Some(line) => Some(format!("{file}:{}", rv_unquote(&line))),
        None => Some(file),
    }
}

fn rv_scalar(body: &str, key: &str) -> Option<String> {
    for line in body.lines() {
        if line.starts_with(' ') || line.starts_with('\t') {
            continue;
        }
        let (k, v) = line.split_once(':')?;
        if !k.trim().eq_ignore_ascii_case(key) {
            continue;
        }
        let value = v.trim().trim_matches('"').trim_matches('\'').to_string();
        return if value.is_empty() { None } else { Some(value) };
    }
    None
}

fn rv_group(body: &str, key: &str) -> Vec<String> {
    let mut collecting = false;
    let mut out: Vec<String> = Vec::new();
    for line in body.lines() {
        let indented = line.starts_with(' ') || line.starts_with('\t');
        let trimmed = line.trim();
        if collecting {
            if trimmed.is_empty() {
                continue;
            }
            if !indented && !trimmed.starts_with('-') {
                break;
            }
            out.push(trimmed.to_string());
            continue;
        }
        if indented {
            continue;
        }
        if let Some((k, v)) = line.split_once(':') {
            if k.trim().eq_ignore_ascii_case(key) && v.trim().is_empty() {
                collecting = true;
            }
        }
    }
    out
}

fn rv_unquote(value: &str) -> String {
    let v = value.trim();
    if v.len() >= 2
        && ((v.starts_with('"') && v.ends_with('"')) || (v.starts_with('\'') && v.ends_with('\'')))
    {
        return v[1..v.len() - 1].to_string();
    }
    v.to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn write_tree(infix: &str) -> (PathBuf, PathBuf) {
        let root =
            std::env::temp_dir().join(format!("krypton-excerpt-{}-{}", infix, std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        let src = root.join("src");
        std::fs::create_dir_all(&src).unwrap();
        let lines: Vec<String> = (1..=20).map(|n| format!("const line{n} = {n};")).collect();
        std::fs::write(src.join("a.ts"), lines.join("\n")).unwrap();
        (root.clone(), root)
    }

    #[test]
    fn collect_resolves_walkthrough_and_finding() {
        let (tmp, cwd) = write_tree("ok");
        let md = "---\ncreated: 2020-01-01T00:00:00Z\n---\n\n\
            ```review:walkthrough\nsteps:\n  - at: src/a.ts:4\n    say: here\n```\n\n\
            ```review:finding\nfile: src/a.ts\nline: 10\ntitle: t\n```\n";
        let sidecar = collect_review_excerpts(&cwd, md, created_ms_from_review_md(md));
        assert_eq!(sidecar.version, 1);
        let step = sidecar.anchors.get("src/a.ts:4").unwrap();
        assert_eq!(step.skip, None);
        assert_eq!(step.first_line, Some(1));
        assert_eq!(step.anchor_line, Some(4));
        assert!(step
            .lines
            .as_ref()
            .unwrap()
            .iter()
            .any(|l| l.contains("line4")));
        let finding = sidecar.anchors.get("src/a.ts:10").unwrap();
        assert_eq!(finding.anchor_line, Some(10));
        let _ = std::fs::remove_dir_all(&tmp);
    }

    #[test]
    fn collect_records_missing_and_omits_rejected() {
        let (tmp, cwd) = write_tree("skip");
        std::fs::write(cwd.join(".gitignore"), "secret/\n").unwrap();
        std::fs::create_dir_all(cwd.join("secret")).unwrap();
        std::fs::write(cwd.join("secret/k.ts"), "export const K = 1;").unwrap();
        let md = "```review:walkthrough\nsteps:\n\
            - at: src/missing.ts:1\n  say: gone\n\
            - at: secret/k.ts:1\n  say: ignored\n```\n";
        let sidecar = collect_review_excerpts(&cwd, md, 0);
        assert_eq!(
            sidecar
                .anchors
                .get("src/missing.ts:1")
                .and_then(|r| r.skip.as_deref()),
            Some("missing")
        );
        assert!(!sidecar.anchors.contains_key("secret/k.ts:1"));
        let _ = std::fs::remove_dir_all(&tmp);
    }
}
