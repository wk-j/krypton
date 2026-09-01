// Krypton — developer daily note: capture and compose (spec 223).
//
// Two halves that never call each other.
//
// CAPTURE is `append()`: the harness tees events it already routes — a handoff
// written, an attention flag raised, a review synthesized — into an append-only
// `.krypton/journal/<YYYY-MM-DD>.jsonl`. It is deliberately dumb. One row, one
// line, one `O_APPEND` write, no reads, no locks. A failure here must never cost
// a turn, so callers log and swallow.
//
// COMPOSE is `build_digest()`: a pure read that joins that journal with the
// stores that already exist — `usage_log` day files, `git log`, `.krypton/reviews/`,
// `.krypton/artifacts/` — into one `DayDigest`. It does not render, summarise, or
// interpret; the markdown is the frontend's job and stays deterministic there.
//
// DAY BOUNDARIES: `usage_log::day_stamp` names its files by UTC, which is the
// right answer for a file whose rows ship to a server. It is the wrong answer for
// a human's day — at UTC+7 a note built at 09:00 "today" would silently begin at
// 07:00 and drop the morning. So everything here works in the caller's local day:
// the frontend passes its UTC offset, `local_day_range` turns a `YYYY-MM-DD` into
// an epoch-ms window, and every source is filtered by that window. Only the
// *selection* of usage files stays UTC, because that is how they are named — a
// local day straddles at most two of them and we read both.

use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

use crate::git;
use crate::hook_server::{civil_from_days, days_from_civil};
use crate::usage_log::{self, TurnRecord, UsageGroup};

const JOURNAL_DIR: &str = "journal";
/// Per-section cap in the digest. The jsonl keeps everything; a note nobody can
/// scroll to the end of is not a note.
const SECTION_MAX: usize = 50;
/// Artifact `<title>` lives in the first few hundred bytes; never read more.
const ARTIFACT_HEAD_BYTES: usize = 4096;

// --------------------------------------------------------------------- types

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum JournalKind {
    /// Lane opened, `#new`, or a resumed session.
    Session,
    /// Historical only — written by the removed lane-goal feature (spec 148).
    /// Kept so journal files from before the removal still deserialize.
    Goal,
    /// `handoff_set` — the lane's own summary of where it stands.
    Handoff,
    /// `attention_flag` or `attention_resolve`.
    Attention,
    /// `review_outcome` — one synthesized review round.
    Review,
    /// `artifact_register`.
    Artifact,
    /// `#ticket`, or an issue binding changing phase.
    Ticket,
    /// `#daily note <text>` — the human's own line, the only hand-written kind.
    Note,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct JournalEvent {
    #[serde(default = "one")]
    pub v: u32,
    pub at: i64,
    pub kind: JournalKind,
    #[serde(default)]
    pub harness_id: String,
    #[serde(default)]
    pub lane: String,
    #[serde(default)]
    pub backend: String,
    #[serde(default)]
    pub model: Option<String>,
    /// One line, already human-readable. The renderer never reformats it.
    #[serde(default)]
    pub summary: String,
    /// Kind-specific extras (issueKey, blockers, artifactId, itemId …).
    #[serde(default)]
    pub meta: serde_json::Value,
}

fn one() -> u32 {
    1
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CommitEntry {
    pub hash: String,
    pub at: i64,
    pub subject: String,
    pub files: u64,
    pub added: u64,
    pub removed: u64,
    /// Stems of `docs/<NNN>-<slug>.md` files this commit touched, e.g.
    /// `221-harness-status-line-density`. Collected from the diff rather than
    /// guessed from the subject line, so a stem the note names is a file that
    /// was really edited. The note prints these as text, never as links.
    pub specs: Vec<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ReviewEntry {
    /// Bundle directory name, which carries its own date prefix.
    pub slug: String,
    /// Project-relative path to the bundle directory.
    pub path: String,
    pub at: i64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ArtifactEntry {
    pub id: String,
    pub title: String,
    pub lane: String,
    pub harness_id: String,
    pub path: String,
    pub at: i64,
}

#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectDigest {
    /// Directory name, used as the display label.
    pub name: String,
    pub path: String,
    /// Set when the path could not be read or is not a directory. Everything
    /// else is empty and the note says so rather than omitting the project.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub unavailable: Option<String>,

    pub turns: i64,
    pub cancelled_turns: i64,
    pub user_origin_turns: i64,
    pub system_origin_turns: i64,
    pub input_tokens: i64,
    pub output_tokens: i64,
    pub cached_read_tokens: i64,
    pub cached_write_tokens: i64,
    pub reported_cost: f64,
    pub first_turn_at: Option<i64>,
    pub last_turn_at: Option<i64>,
    pub max_context_used: Option<i64>,
    pub by_lane: Vec<UsageGroup>,
    pub by_model: Vec<UsageGroup>,
    /// Lane wall-clock per lane, keyed the same as `by_lane`. NOT time worked —
    /// `duration_ms` runs from prompt to turn end and includes the human's
    /// thinking time, so it is reported under its own name.
    pub lane_wall_clock_ms: Vec<(String, i64)>,

    pub commits: Vec<CommitEntry>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub uncommitted: Option<git::WorkingDiffStat>,
    pub reviews: Vec<ReviewEntry>,
    pub artifacts: Vec<ArtifactEntry>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DayDigest {
    pub date: String,
    /// Minutes to ADD to UTC to get the caller's local time (the negation of
    /// JavaScript's `getTimezoneOffset()`).
    pub tz_offset_minutes: i32,
    pub project: ProjectDigest,
    pub extra: Vec<ProjectDigest>,
    /// The primary project's journal, time-ordered.
    pub events: Vec<JournalEvent>,
    /// True when a section hit `SECTION_MAX` and the digest is a prefix.
    pub truncated: bool,
    pub generated_at: i64,
}

// ---------------------------------------------------------------- day arithmetic

fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

/// `YYYY-MM-DD` of an instant in the caller's local zone.
pub fn local_day_stamp(at_ms: i64, tz_offset_minutes: i32) -> String {
    let shifted = at_ms + (tz_offset_minutes as i64) * 60_000;
    let (y, m, d) = civil_from_days(shifted.div_euclid(1000).div_euclid(86_400));
    format!("{y:04}-{m:02}-{d:02}")
}

/// Half-open epoch-ms window `[start, end)` covering `date` in the caller's zone.
pub fn local_day_range(date: &str, tz_offset_minutes: i32) -> Result<(i64, i64), String> {
    let parts: Vec<&str> = date.split('-').collect();
    if parts.len() != 3 {
        return Err(format!("bad date {date:?}, expected YYYY-MM-DD"));
    }
    let y: i64 = parts[0]
        .parse()
        .map_err(|_| format!("bad year in {date:?}"))?;
    let m: i64 = parts[1]
        .parse()
        .map_err(|_| format!("bad month in {date:?}"))?;
    let d: i64 = parts[2]
        .parse()
        .map_err(|_| format!("bad day in {date:?}"))?;
    if !(1..=12).contains(&m) || !(1..=31).contains(&d) {
        return Err(format!("bad date {date:?}"));
    }
    let start = days_from_civil(y, m, d) * 86_400_000 - (tz_offset_minutes as i64) * 60_000;
    Ok((start, start + 86_400_000))
}

pub fn today_local(tz_offset_minutes: i32) -> String {
    local_day_stamp(now_ms(), tz_offset_minutes)
}

// ------------------------------------------------------------------- on disk

fn journal_dir(cwd: &Path) -> PathBuf {
    cwd.join(".krypton").join(JOURNAL_DIR)
}

/// Append one event. Opens with `O_APPEND` and writes the line in a single call,
/// so two harnesses sharing a project cannot interleave halves of a row.
pub fn append(cwd: &Path, event: &JournalEvent, tz_offset_minutes: i32) -> Result<(), String> {
    use std::io::Write;

    let dir = journal_dir(cwd);
    std::fs::create_dir_all(&dir).map_err(|e| format!("create .krypton/journal: {e}"))?;
    let path = dir.join(format!(
        "{}.jsonl",
        local_day_stamp(event.at, tz_offset_minutes)
    ));

    let mut normalized = event.clone();
    normalized.v = 1;
    // One row, one line — a summary with newlines would corrupt the file for
    // every later reader, so it is collapsed here rather than at every caller.
    normalized.summary = collapse(&normalized.summary);

    let mut line =
        serde_json::to_string(&normalized).map_err(|e| format!("serialize journal event: {e}"))?;
    line.push('\n');

    let mut file = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(&path)
        .map_err(|e| format!("open journal day file: {e}"))?;
    file.write_all(line.as_bytes())
        .map_err(|e| format!("append journal event: {e}"))
}

fn collapse(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    let mut pending_space = false;
    for ch in text.chars() {
        if ch == '\n' || ch == '\r' || ch == '\t' {
            pending_space = !out.is_empty();
            continue;
        }
        if pending_space {
            out.push(' ');
            pending_space = false;
        }
        out.push(ch);
    }
    out
}

/// Every event recorded for `date`, oldest first. A missing file is not an
/// error — it is a day before the feature shipped, or a quiet one.
pub fn read_day(cwd: &Path, date: &str) -> Vec<JournalEvent> {
    let path = journal_dir(cwd).join(format!("{date}.jsonl"));
    let Ok(text) = std::fs::read_to_string(path) else {
        return Vec::new();
    };
    let mut events: Vec<JournalEvent> = text
        .lines()
        .filter(|l| !l.trim().is_empty())
        .filter_map(|l| serde_json::from_str(l).ok())
        .collect();
    events.sort_by_key(|e| e.at);
    events
}

/// Delete journal day files older than `retain_days`. Rendered `.md` notes are
/// never touched — they are the durable record; the jsonl is only its input.
pub fn prune(cwd: &Path, retain_days: u64, tz_offset_minutes: i32) -> usize {
    if retain_days == 0 {
        return 0;
    }
    let cutoff = local_day_stamp(
        now_ms() - (retain_days as i64) * 86_400_000,
        tz_offset_minutes,
    );
    let dir = journal_dir(cwd);
    let Ok(entries) = std::fs::read_dir(&dir) else {
        return 0;
    };
    let mut removed = 0;
    for entry in entries.flatten() {
        let name = entry.file_name().to_string_lossy().to_string();
        let Some(stem) = name.strip_suffix(".jsonl") else {
            continue;
        };
        if stem < cutoff.as_str() && std::fs::remove_file(dir.join(&name)).is_ok() {
            removed += 1;
        }
    }
    removed
}

static PRUNED: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);

/// Run the retention pass once per app run, the first time a project appends.
///
/// Piggybacked on capture rather than startup because the journal directory is
/// per-project and there is no project until something is written to it.
pub fn prune_once(cwd: &Path, retain_days: u64, tz_offset_minutes: i32) -> usize {
    if PRUNED.swap(true, std::sync::atomic::Ordering::Relaxed) {
        return 0;
    }
    let removed = prune(cwd, retain_days, tz_offset_minutes);
    if removed > 0 {
        log::info!("journal: pruned {removed} day file(s) past {retain_days} days");
    }
    removed
}

/// Where rendered notes live. `output_dir` is a project-relative path unless it
/// is already absolute, which is how a note lands in a real Obsidian vault.
pub fn notes_dir(cwd: &Path, output_dir: &str) -> PathBuf {
    if output_dir.is_empty() {
        journal_dir(cwd)
    } else {
        let raw = Path::new(output_dir);
        if raw.is_absolute() {
            raw.to_path_buf()
        } else {
            cwd.join(raw)
        }
    }
}

/// Where a rendered note goes.
pub fn note_path(cwd: &Path, output_dir: &str, date: &str) -> PathBuf {
    notes_dir(cwd, output_dir).join(format!("{date}.md"))
}

/// spec 225: where a lane should write its brief of `date`, refusing a path the
/// human owns.
///
/// The lane writes the file with its own edit tool, so `write_note`'s
/// step-aside guard never runs. This is the last point Krypton still controls
/// the decision: a file whose frontmatter carries no `generated:` marker was
/// written by hand, and the answer is to refuse the path rather than hand a
/// lane something it will overwrite.
pub fn daily_write_path(cwd: &Path, output_dir: &str, date: &str) -> Result<String, String> {
    let path = note_path(cwd, output_dir, date);
    if let Ok(existing) = std::fs::read_to_string(&path) {
        if !is_generated(&existing) {
            return Err(format!("{date}.md was written by hand — leaving it alone"));
        }
    }
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| format!("create daily directory: {e}"))?;
    }
    Ok(path.to_string_lossy().to_string())
}

/// Every day that has a written file, newest first.
///
/// A day is named by its `<date>.md`. Both suffixed forms are legacy shapes
/// spec 225 stopped producing but did not delete: `<date>.brief.md` was the
/// separate narration, and `<date>.generated.md` the step-aside copy. Neither
/// is a day of its own, so both stay folded into `<date>.md` rather than
/// inventing a phantom entry. Takes the resolved directory rather than
/// `(cwd, output_dir)` because its only caller (the Xenon collector) holds one.
pub fn note_dates_in(dir: &Path) -> Vec<String> {
    let Ok(entries) = std::fs::read_dir(dir) else {
        return Vec::new();
    };
    let mut dates: Vec<String> = entries
        .flatten()
        .filter(|e| e.path().is_file())
        .filter_map(|e| {
            let name = e.file_name().to_string_lossy().to_string();
            let stem = name.strip_suffix(".md")?;
            let date = stem.strip_suffix(".generated").unwrap_or(stem);
            is_date(date).then(|| date.to_string())
        })
        .collect();
    dates.sort();
    dates.dedup();
    dates.reverse();
    dates
}

/// `YYYY-MM-DD` and nothing else — the shape every dated path here uses.
fn is_date(s: &str) -> bool {
    s.len() == 10
        && s.as_bytes()[4] == b'-'
        && s.as_bytes()[7] == b'-'
        && s.bytes().enumerate().all(|(i, b)| {
            if i == 4 || i == 7 {
                b == b'-'
            } else {
                b.is_ascii_digit()
            }
        })
}

/// spec 225: the day's file as it exists, for reading.
///
/// Deliberately unguarded where [`daily_write_path`] is strict: opening a day
/// someone wrote by hand is exactly right, and only overwriting it is not. The
/// legacy `<date>.generated.md` is the fallback so days written before spec 225
/// still open.
pub fn daily_read_path(cwd: &Path, output_dir: &str, date: &str) -> Result<String, String> {
    let dir = notes_dir(cwd, output_dir);
    for name in [format!("{date}.md"), format!("{date}.generated.md")] {
        let path = dir.join(name);
        if path.is_file() {
            return Ok(path.to_string_lossy().to_string());
        }
    }
    Err(format!("no daily for {date} yet — run #daily to write one"))
}

/// A file we commissioned carries `generated:` in its frontmatter block.
fn is_generated(text: &str) -> bool {
    let Some(rest) = text.strip_prefix("---\n") else {
        return false;
    };
    let Some(end) = rest.find("\n---") else {
        return false;
    };
    rest[..end].lines().any(|l| l.starts_with("generated:"))
}

// -------------------------------------------------------------------- compose

/// Join every source for one local day into a single read-only view.
pub fn build_digest(
    cwd: &Path,
    date: &str,
    tz_offset_minutes: i32,
    extra_projects: &[String],
) -> Result<DayDigest, String> {
    let (start, end) = local_day_range(date, tz_offset_minutes)?;

    let mut truncated = false;
    let project = project_digest(cwd, start, end, &mut truncated);

    let extra = extra_projects
        .iter()
        .filter(|p| !p.trim().is_empty())
        .map(|p| {
            let path = PathBuf::from(p);
            if !path.is_dir() {
                log::warn!("daily note: extra project {p:?} is not a readable directory");
                return ProjectDigest {
                    name: display_name(&path),
                    path: p.clone(),
                    unavailable: Some("not a readable directory".to_string()),
                    ..Default::default()
                };
            }
            project_digest(&path, start, end, &mut truncated)
        })
        .collect();

    let mut events = read_day(cwd, date);
    if events.len() > SECTION_MAX {
        truncated = true;
        events.truncate(SECTION_MAX);
    }

    Ok(DayDigest {
        date: date.to_string(),
        tz_offset_minutes,
        project,
        extra,
        events,
        truncated,
        generated_at: now_ms(),
    })
}

fn display_name(path: &Path) -> String {
    path.file_name()
        .map(|n| n.to_string_lossy().to_string())
        .unwrap_or_else(|| path.to_string_lossy().to_string())
}

fn project_digest(cwd: &Path, start: i64, end: i64, truncated: &mut bool) -> ProjectDigest {
    let mut digest = ProjectDigest {
        name: display_name(cwd),
        path: cwd.to_string_lossy().to_string(),
        ..Default::default()
    };

    apply_usage(&mut digest, &collect_turns(cwd, start, end));

    digest.commits = collect_commits(cwd, start, end);
    if digest.commits.len() > SECTION_MAX {
        *truncated = true;
        digest.commits.truncate(SECTION_MAX);
    }

    // Uncommitted work is a property of *now*, not of the day — it only belongs
    // to a note for a day that is still running.
    if end > now_ms() {
        digest.uncommitted = git::working_diff_stat(&digest.path).ok();
    }

    digest.reviews = collect_reviews(cwd, start, end);
    digest.artifacts = collect_artifacts(cwd, start, end);
    if digest.reviews.len() > SECTION_MAX || digest.artifacts.len() > SECTION_MAX {
        *truncated = true;
        digest.reviews.truncate(SECTION_MAX);
        digest.artifacts.truncate(SECTION_MAX);
    }

    digest
}

/// Usage rows whose instant falls inside the local day.
///
/// Day files are named in UTC, so a local day straddles at most two of them.
/// Reading both and filtering by instant is what keeps a UTC+7 morning from
/// vanishing into the previous file.
fn collect_turns(cwd: &Path, start: i64, end: i64) -> Vec<TurnRecord> {
    let mut files = vec![usage_log::day_stamp(start)];
    let last = usage_log::day_stamp(end - 1);
    if last != files[0] {
        files.push(last);
    }
    let mut rows: Vec<TurnRecord> = files
        .iter()
        .flat_map(|d| usage_log::read_day(cwd, d))
        .filter(|r| r.at >= start && r.at < end)
        .collect();
    rows.sort_by_key(|r| r.at);
    rows
}

fn apply_usage(digest: &mut ProjectDigest, rows: &[TurnRecord]) {
    use std::collections::BTreeMap;

    let mut by_lane: BTreeMap<String, UsageGroup> = BTreeMap::new();
    let mut by_model: BTreeMap<String, UsageGroup> = BTreeMap::new();
    let mut wall_clock: BTreeMap<String, i64> = BTreeMap::new();

    for row in rows {
        digest.turns += 1;
        if row.stop_reason == "cancelled" {
            digest.cancelled_turns += 1;
        }
        match row.origin.as_str() {
            "user" => digest.user_origin_turns += 1,
            _ => digest.system_origin_turns += 1,
        }
        digest.first_turn_at = Some(digest.first_turn_at.map_or(row.at, |v| v.min(row.at)));
        digest.last_turn_at = Some(digest.last_turn_at.map_or(row.at, |v| v.max(row.at)));
        if let Some(ctx) = row.context.as_ref().and_then(|c| c.used) {
            digest.max_context_used = Some(digest.max_context_used.map_or(ctx, |v| v.max(ctx)));
        }
        *wall_clock.entry(row.lane.clone()).or_default() += row.duration_ms.unwrap_or(0);

        let model = row.model.clone().unwrap_or_else(|| "unknown".to_string());
        for (map, key) in [(&mut by_lane, row.lane.clone()), (&mut by_model, model)] {
            let group = map.entry(key.clone()).or_insert_with(|| UsageGroup {
                key,
                ..Default::default()
            });
            group.turns += 1;
            if let Some(t) = row.tokens.as_ref() {
                group.input_tokens += t.input;
                group.output_tokens += t.output;
                group.cached_read_tokens += t.cached_read.unwrap_or(0);
                group.cached_write_tokens += t.cached_write.unwrap_or(0);
            }
            if let Some(c) = row.cost.as_ref() {
                group.reported_cost += c.amount;
            }
        }
    }

    for group in by_lane.values() {
        digest.input_tokens += group.input_tokens;
        digest.output_tokens += group.output_tokens;
        digest.cached_read_tokens += group.cached_read_tokens;
        digest.cached_write_tokens += group.cached_write_tokens;
        digest.reported_cost += group.reported_cost;
    }

    digest.by_lane = sorted_groups(by_lane);
    digest.by_model = sorted_groups(by_model);
    digest.lane_wall_clock_ms = {
        let mut v: Vec<(String, i64)> = wall_clock.into_iter().collect();
        v.sort_by_key(|(_, ms)| std::cmp::Reverse(*ms));
        v
    };
}

fn sorted_groups(map: std::collections::BTreeMap<String, UsageGroup>) -> Vec<UsageGroup> {
    let mut v: Vec<UsageGroup> = map.into_values().collect();
    v.sort_by(|a, b| b.turns.cmp(&a.turns).then_with(|| a.key.cmp(&b.key)));
    v
}

/// Commits authored inside the window.
///
/// Filtered to `user.email` when git knows it: on a repo that pulls other
/// people's work, an unfiltered `git log` turns their day into yours. Agent
/// commits still carry the user as author, so nothing of ours is lost.
fn collect_commits(cwd: &Path, start: i64, end: i64) -> Vec<CommitEntry> {
    let since = format!("@{}", start / 1000);
    let until = format!("@{}", end / 1000);
    let author = git::run_git(cwd, &["config", "user.email"])
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty());

    let mut args: Vec<String> = vec![
        "--no-pager".into(),
        "log".into(),
        "--no-merges".into(),
        format!("--since={since}"),
        format!("--until={until}"),
        "--numstat".into(),
        // `%ct`, not `%at`: `--since/--until` filter on the COMMITTER date, so
        // showing the author date would put an amended or rebased commit at a
        // time outside the very window that selected it.
        "--pretty=format:\u{1e}%H\u{1f}%ct\u{1f}%s".into(),
    ];
    if let Some(email) = author {
        args.push(format!("--author={email}"));
    }
    let borrowed: Vec<&str> = args.iter().map(|s| s.as_str()).collect();
    let Some(out) = git::run_git(cwd, &borrowed) else {
        return Vec::new();
    };

    let mut commits = Vec::new();
    for block in out.split('\u{1e}') {
        let block = block.trim_start_matches('\n');
        if block.trim().is_empty() {
            continue;
        }
        let mut lines = block.lines();
        let Some(header) = lines.next() else { continue };
        let mut fields = header.split('\u{1f}');
        let (Some(hash), Some(at), Some(subject)) = (fields.next(), fields.next(), fields.next())
        else {
            continue;
        };
        let mut entry = CommitEntry {
            hash: hash.chars().take(7).collect(),
            at: at.trim().parse::<i64>().unwrap_or(0) * 1000,
            subject: subject.trim().to_string(),
            files: 0,
            added: 0,
            removed: 0,
            specs: Vec::new(),
        };
        for line in lines {
            let line = line.trim();
            if line.is_empty() {
                continue;
            }
            let mut cols = line.split('\t');
            let (Some(add), Some(del), Some(path)) = (cols.next(), cols.next(), cols.next()) else {
                continue;
            };
            entry.files += 1;
            // "-" is git's marker for a binary file: countable as touched, not
            // as lines.
            entry.added += add.parse::<u64>().unwrap_or(0);
            entry.removed += del.parse::<u64>().unwrap_or(0);
            if let Some(stem) = spec_stem(path) {
                if !entry.specs.contains(&stem) {
                    entry.specs.push(stem);
                }
            }
        }
        commits.push(entry);
    }
    commits.sort_by_key(|c| c.at);
    commits
}

/// Review bundles whose directory was last written inside the window.
///
/// Matched on mtime, not on the date prefix in the slug: the prefix is a naming
/// convention, mtime is when the round actually closed.
fn collect_reviews(cwd: &Path, start: i64, end: i64) -> Vec<ReviewEntry> {
    let root = cwd.join(".krypton").join("reviews");
    let Ok(entries) = std::fs::read_dir(&root) else {
        return Vec::new();
    };
    let mut out = Vec::new();
    for entry in entries.flatten() {
        let path = entry.path();
        if !path.is_dir() {
            continue;
        }
        let Some(at) = mtime_ms(&path) else { continue };
        if at < start || at >= end {
            continue;
        }
        let slug = display_name(&path);
        out.push(ReviewEntry {
            path: format!(".krypton/reviews/{slug}"),
            slug,
            at,
        });
    }
    out.sort_by_key(|r| r.at);
    out
}

/// Artifacts written inside the window, across every harness and lane.
fn collect_artifacts(cwd: &Path, start: i64, end: i64) -> Vec<ArtifactEntry> {
    let root = cwd.join(".krypton").join("artifacts");
    let Ok(harnesses) = std::fs::read_dir(&root) else {
        return Vec::new();
    };
    let mut out = Vec::new();
    for harness in harnesses.flatten() {
        if !harness.path().is_dir() {
            continue;
        }
        let harness_id = display_name(&harness.path());
        let Ok(lanes) = std::fs::read_dir(harness.path()) else {
            continue;
        };
        for lane in lanes.flatten() {
            if !lane.path().is_dir() {
                continue;
            }
            let lane_name = display_name(&lane.path());
            let Ok(files) = std::fs::read_dir(lane.path()) else {
                continue;
            };
            for file in files.flatten() {
                let path = file.path();
                if path.extension().and_then(|e| e.to_str()) != Some("html") {
                    continue;
                }
                let Some(at) = mtime_ms(&path) else { continue };
                if at < start || at >= end {
                    continue;
                }
                let id = path
                    .file_stem()
                    .map(|s| s.to_string_lossy().to_string())
                    .unwrap_or_default();
                out.push(ArtifactEntry {
                    title: artifact_title(&path).unwrap_or_else(|| id.clone()),
                    path: format!(".krypton/artifacts/{harness_id}/{lane_name}/{id}.html"),
                    id,
                    lane: lane_name.clone(),
                    harness_id: harness_id.clone(),
                    at,
                });
            }
        }
    }
    out.sort_by_key(|a| a.at);
    out
}

/// `docs/221-harness-status-line-density.md` → `221-harness-status-line-density`.
///
/// Only numbered spec files qualify. `docs/README.md` and `docs/adr/…` are
/// touched by nearly every commit and would link the note to noise.
fn spec_stem(path: &str) -> Option<String> {
    // A rename shows as `old => new`; the new path is what still exists.
    let path = path.rsplit(" => ").next().unwrap_or(path).trim();
    let rest = path.strip_prefix("docs/")?;
    if rest.contains('/') {
        return None;
    }
    let stem = rest.strip_suffix(".md")?;
    let digits = stem.split('-').next()?;
    if digits.is_empty() || !digits.chars().all(|c| c.is_ascii_digit()) {
        return None;
    }
    Some(stem.to_string())
}

fn mtime_ms(path: &Path) -> Option<i64> {
    std::fs::metadata(path)
        .ok()?
        .modified()
        .ok()?
        .duration_since(std::time::UNIX_EPOCH)
        .ok()
        .map(|d| d.as_millis() as i64)
}

fn artifact_title(path: &Path) -> Option<String> {
    use std::io::Read;

    let mut file = std::fs::File::open(path).ok()?;
    let mut buf = vec![0u8; ARTIFACT_HEAD_BYTES];
    let read = file.read(&mut buf).ok()?;
    let head = String::from_utf8_lossy(&buf[..read]);
    let open = head.find("<title>")? + "<title>".len();
    let close = head[open..].find("</title>")?;
    let title = head[open..open + close].trim().to_string();
    if title.is_empty() {
        None
    } else {
        Some(title)
    }
}

// ----------------------------------------------------------------------- tests

#[cfg(test)]
mod tests {
    use super::*;

    struct Scratch(PathBuf);

    impl Scratch {
        fn new(tag: &str) -> Self {
            let dir = std::env::temp_dir().join(format!("krypton-journal-{tag}-{}", now_ms()));
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

    fn event(at: i64, kind: JournalKind, summary: &str) -> JournalEvent {
        JournalEvent {
            v: 1,
            at,
            kind,
            harness_id: "hm-1".into(),
            lane: "Claude-1".into(),
            backend: "claude".into(),
            model: Some("opus".into()),
            summary: summary.into(),
            meta: serde_json::Value::Null,
        }
    }

    #[test]
    fn local_day_range_shifts_by_offset() {
        // UTC+7: the local day starts 7h before the UTC day of the same name.
        let (start_utc, end_utc) = local_day_range("2026-08-15", 0).expect("utc range");
        let (start_bkk, _) = local_day_range("2026-08-15", 420).expect("bangkok range");
        assert_eq!(end_utc - start_utc, 86_400_000);
        assert_eq!(start_utc - start_bkk, 7 * 3_600_000);
    }

    #[test]
    fn local_day_stamp_rolls_at_local_midnight_not_utc() {
        // 2026-08-14T18:00Z is already the 15th in Bangkok.
        let (start, _) = local_day_range("2026-08-15", 0).expect("range");
        let evening_before = start - 6 * 3_600_000;
        assert_eq!(local_day_stamp(evening_before, 0), "2026-08-14");
        assert_eq!(local_day_stamp(evening_before, 420), "2026-08-15");
    }

    #[test]
    fn local_day_range_rejects_malformed_dates() {
        assert!(local_day_range("2026-8", 0).is_err());
        assert!(local_day_range("2026-13-01", 0).is_err());
        assert!(local_day_range("not-a-date", 0).is_err());
    }

    #[test]
    fn append_then_read_day_round_trips_in_order() {
        let scratch = Scratch::new("append");
        let (start, _) = local_day_range("2026-08-15", 420).expect("range");
        append(
            scratch.path(),
            &event(start + 7_200_000, JournalKind::Handoff, "second"),
            420,
        )
        .expect("append second");
        append(
            scratch.path(),
            &event(start + 3_600_000, JournalKind::Goal, "first"),
            420,
        )
        .expect("append first");

        let events = read_day(scratch.path(), "2026-08-15");
        assert_eq!(events.len(), 2);
        assert_eq!(events[0].summary, "first");
        assert_eq!(events[1].summary, "second");
    }

    #[test]
    fn append_collapses_newlines_so_one_row_stays_one_line() {
        let scratch = Scratch::new("collapse");
        let (start, _) = local_day_range("2026-08-15", 0).expect("range");
        append(
            scratch.path(),
            &event(
                start + 1000,
                JournalKind::Note,
                "line one\nline two\n\nline three",
            ),
            0,
        )
        .expect("append");

        let raw = std::fs::read_to_string(scratch.path().join(".krypton/journal/2026-08-15.jsonl"))
            .expect("read raw");
        assert_eq!(
            raw.lines().count(),
            1,
            "multi-line summary must stay one row"
        );
        assert_eq!(
            read_day(scratch.path(), "2026-08-15")[0].summary,
            "line one line two line three"
        );
    }

    #[test]
    fn append_files_by_local_day_not_utc_day() {
        let scratch = Scratch::new("boundary");
        let (start, _) = local_day_range("2026-08-15", 420).expect("range");
        // 00:30 Bangkok on the 15th is still 17:30 UTC on the 14th.
        append(
            scratch.path(),
            &event(start + 1_800_000, JournalKind::Session, "early"),
            420,
        )
        .expect("append");

        assert_eq!(read_day(scratch.path(), "2026-08-15").len(), 1);
        assert!(read_day(scratch.path(), "2026-08-14").is_empty());
    }

    #[test]
    fn read_day_skips_corrupt_lines_instead_of_failing() {
        let scratch = Scratch::new("corrupt");
        let dir = scratch.path().join(".krypton/journal");
        std::fs::create_dir_all(&dir).expect("mkdir");
        std::fs::write(
            dir.join("2026-08-15.jsonl"),
            "{\"v\":1,\"at\":1,\"kind\":\"note\",\"summary\":\"good\"}\nnot json\n\n",
        )
        .expect("write");

        let events = read_day(scratch.path(), "2026-08-15");
        assert_eq!(events.len(), 1);
        assert_eq!(events[0].summary, "good");
    }

    #[test]
    fn prune_removes_old_jsonl_and_never_touches_notes() {
        let scratch = Scratch::new("prune");
        let dir = scratch.path().join(".krypton/journal");
        std::fs::create_dir_all(&dir).expect("mkdir");
        let old = local_day_stamp(now_ms() - 40 * 86_400_000, 0);
        let recent = local_day_stamp(now_ms() - 86_400_000, 0);
        std::fs::write(dir.join(format!("{old}.jsonl")), "").expect("old");
        std::fs::write(dir.join(format!("{recent}.jsonl")), "").expect("recent");
        std::fs::write(dir.join(format!("{old}.md")), "# note").expect("note");

        assert_eq!(prune(scratch.path(), 30, 0), 1);
        assert!(!dir.join(format!("{old}.jsonl")).exists());
        assert!(dir.join(format!("{recent}.jsonl")).exists());
        assert!(
            dir.join(format!("{old}.md")).exists(),
            "rendered notes are durable"
        );
    }

    #[test]
    fn prune_disabled_at_zero() {
        let scratch = Scratch::new("prune-zero");
        let dir = scratch.path().join(".krypton/journal");
        std::fs::create_dir_all(&dir).expect("mkdir");
        std::fs::write(dir.join("2000-01-01.jsonl"), "").expect("ancient");
        assert_eq!(prune(scratch.path(), 0, 0), 0);
    }

    /// spec 225: the lane writes the file itself, so this is the only place a
    /// hand-written day can still be defended.
    #[test]
    fn daily_write_path_refuses_a_hand_written_file() {
        let scratch = Scratch::new("write");

        // Nothing there yet: the path is handed over and the directory made.
        let first = daily_write_path(scratch.path(), "", "2026-08-15").expect("fresh path");
        assert!(first.ends_with("2026-08-15.md"));

        // Our own output is replaceable — that is what `generated:` means.
        std::fs::write(
            &first,
            "---\ndate: 2026-08-15\ngenerated: lane-narration\n---\n\n# day\n",
        )
        .expect("write generated");
        assert_eq!(
            daily_write_path(scratch.path(), "", "2026-08-15").expect("regenerate"),
            first
        );

        // A file written by hand carries no marker, so the path is refused and
        // the caller falls back to reply-only.
        std::fs::write(&first, "# my own notes\n").expect("hand edit");
        assert!(daily_write_path(scratch.path(), "", "2026-08-15").is_err());
        assert_eq!(
            std::fs::read_to_string(&first).expect("hand-written file survives"),
            "# my own notes\n"
        );

        // Reading is the opposite rule: the hand-written day is the day, and
        // opening it is exactly right.
        assert_eq!(
            daily_read_path(scratch.path(), "", "2026-08-15").expect("read path"),
            first
        );
    }

    /// A day nobody wrote is an error, not an empty file — only a lane can
    /// commission one, and the caller has to be told to ask for it.
    #[test]
    fn daily_read_path_reports_a_day_that_was_never_written() {
        let scratch = Scratch::new("read");
        let err = daily_read_path(scratch.path(), "", "2026-08-15").unwrap_err();
        assert!(err.contains("#daily"), "{err}");

        // Days written before spec 225 stepped aside under a different name and
        // must still open.
        let dir = notes_dir(scratch.path(), "");
        std::fs::create_dir_all(&dir).unwrap();
        let legacy = dir.join("2026-08-15.generated.md");
        std::fs::write(&legacy, "# legacy\n").unwrap();
        assert_eq!(
            daily_read_path(scratch.path(), "", "2026-08-15").expect("legacy path"),
            legacy.to_string_lossy()
        );
    }

    #[test]
    fn note_path_honours_an_absolute_output_dir() {
        let vault = std::env::temp_dir().join("krypton-vault");
        let path = note_path(
            Path::new("/tmp/project"),
            &vault.to_string_lossy(),
            "2026-08-15",
        );
        assert_eq!(path, vault.join("2026-08-15.md"));
    }

    #[test]
    fn note_dates_names_days_not_files() {
        let scratch = Scratch::new("dates");
        let dir = scratch.path().join(".krypton").join("journal");
        std::fs::create_dir_all(&dir).unwrap();
        for name in [
            "2026-08-13.md",
            "2026-08-15.md",
            "2026-08-15.generated.md",
            "2026-08-15.brief.md",
            "2026-08-14.md",
            "2026-08-15.jsonl",
            "README.md",
        ] {
            std::fs::write(dir.join(name), "x").unwrap();
        }
        // Newest first; the generated copy and the brief are the same day, and
        // neither the capture log nor an undated file is one at all.
        assert_eq!(
            note_dates_in(&dir),
            vec!["2026-08-15", "2026-08-14", "2026-08-13"]
        );
        assert!(note_dates_in(&dir.join("missing")).is_empty());
    }

    #[test]
    fn build_digest_on_an_empty_project_reports_a_quiet_day() {
        let scratch = Scratch::new("empty");
        let digest = build_digest(scratch.path(), "2026-08-15", 420, &[]).expect("digest");
        assert_eq!(digest.date, "2026-08-15");
        assert_eq!(digest.project.turns, 0);
        assert!(digest.events.is_empty());
        assert!(digest.project.commits.is_empty());
        assert!(!digest.truncated);
    }

    #[test]
    fn build_digest_marks_an_unreadable_extra_project() {
        let scratch = Scratch::new("extra");
        let missing = scratch.path().join("nope").to_string_lossy().to_string();
        let digest = build_digest(
            scratch.path(),
            "2026-08-15",
            0,
            std::slice::from_ref(&missing),
        )
        .expect("digest");
        assert_eq!(digest.extra.len(), 1);
        assert_eq!(digest.extra[0].path, missing);
        assert!(digest.extra[0].unavailable.is_some());
    }

    #[test]
    fn build_digest_truncates_a_flood_of_events() {
        let scratch = Scratch::new("flood");
        let (start, _) = local_day_range("2026-08-15", 0).expect("range");
        for i in 0..(SECTION_MAX as i64 + 5) {
            append(
                scratch.path(),
                &event(start + i * 1000, JournalKind::Note, &format!("row {i}")),
                0,
            )
            .expect("append");
        }
        let digest = build_digest(scratch.path(), "2026-08-15", 0, &[]).expect("digest");
        assert_eq!(digest.events.len(), SECTION_MAX);
        assert!(digest.truncated);
    }

    /// Build a throwaway repo and commit `files` at a fixed instant.
    ///
    /// Dates are forced through the environment because `collect_commits`
    /// selects on the committer date — the test has to control the same clock
    /// the query filters on, or it proves nothing.
    fn git_commit(dir: &Path, when_secs: i64, subject: &str, files: &[(&str, &str)]) {
        for (path, body) in files {
            let full = dir.join(path);
            if let Some(parent) = full.parent() {
                std::fs::create_dir_all(parent).expect("mkdir");
            }
            std::fs::write(full, body).expect("write file");
        }
        let stamp = format!("{when_secs} +0000");
        let run = |args: &[&str]| {
            let out = std::process::Command::new("git")
                .args(args)
                .current_dir(dir)
                .env("GIT_AUTHOR_DATE", &stamp)
                .env("GIT_COMMITTER_DATE", &stamp)
                .env("GIT_AUTHOR_NAME", "Tester")
                .env("GIT_AUTHOR_EMAIL", "tester@example.com")
                .env("GIT_COMMITTER_NAME", "Tester")
                .env("GIT_COMMITTER_EMAIL", "tester@example.com")
                .output()
                .expect("run git");
            assert!(
                out.status.success(),
                "git {args:?}: {}",
                String::from_utf8_lossy(&out.stderr)
            );
        };
        run(&["add", "-A"]);
        run(&["commit", "-m", subject]);
    }

    fn git_repo(scratch: &Scratch) -> &Path {
        let dir = scratch.path();
        for args in [
            vec!["init", "-q"],
            vec!["config", "user.email", "tester@example.com"],
            vec!["config", "user.name", "Tester"],
            vec!["config", "commit.gpgsign", "false"],
        ] {
            let out = std::process::Command::new("git")
                .args(&args)
                .current_dir(dir)
                .output()
                .expect("run git");
            assert!(out.status.success(), "git {args:?}");
        }
        dir
    }

    #[test]
    fn collect_commits_reads_hash_time_subject_and_line_counts() {
        let scratch = Scratch::new("commits");
        let dir = git_repo(&scratch);
        let (start, end) = local_day_range("2026-08-15", 420).expect("range");
        let noon = start / 1000 + 12 * 3600;

        git_commit(
            dir,
            noon,
            "feat(harness): trim the status line (spec 221)",
            &[
                ("src/a.ts", "one\ntwo\nthree\n"),
                ("docs/221-harness-status-line-density.md", "# spec\n"),
            ],
        );

        let commits = collect_commits(dir, start, end);
        assert_eq!(commits.len(), 1);
        let c = &commits[0];
        assert_eq!(c.hash.len(), 7, "short hash");
        assert_eq!(c.subject, "feat(harness): trim the status line (spec 221)");
        assert_eq!(c.at, noon * 1000, "committer instant, in ms");
        assert_eq!(c.files, 2);
        assert_eq!(c.added, 4, "3 lines + 1 line");
        assert_eq!(c.removed, 0);
        assert_eq!(c.specs, vec!["221-harness-status-line-density"]);
    }

    #[test]
    fn collect_commits_excludes_commits_outside_the_local_day() {
        let scratch = Scratch::new("commit-window");
        let dir = git_repo(&scratch);
        let (start, end) = local_day_range("2026-08-15", 420).expect("range");

        git_commit(
            dir,
            start / 1000 - 60,
            "yesterday, one minute before",
            &[("a.txt", "a\n")],
        );
        git_commit(
            dir,
            start / 1000 + 60,
            "inside the day",
            &[("b.txt", "b\n")],
        );
        git_commit(dir, end / 1000 + 60, "tomorrow", &[("c.txt", "c\n")]);

        let subjects: Vec<String> = collect_commits(dir, start, end)
            .into_iter()
            .map(|c| c.subject)
            .collect();
        assert_eq!(subjects, vec!["inside the day"]);
    }

    #[test]
    fn collect_commits_counts_a_binary_file_as_touched_but_not_as_lines() {
        let scratch = Scratch::new("binary");
        let dir = git_repo(&scratch);
        let (start, end) = local_day_range("2026-08-15", 0).expect("range");
        let noon = start / 1000 + 12 * 3600;

        // A NUL makes git report "-\t-" in numstat rather than line counts.
        std::fs::write(dir.join("blob.bin"), [0u8, 1, 2, 3]).expect("write binary");
        git_commit(dir, noon, "add a blob", &[("text.txt", "line\n")]);

        let commits = collect_commits(dir, start, end);
        assert_eq!(commits.len(), 1);
        assert_eq!(
            commits[0].files, 2,
            "the blob still counts as a file touched"
        );
        assert_eq!(commits[0].added, 1, "only the text file contributes lines");
    }

    #[test]
    fn collect_commits_ignores_another_author() {
        let scratch = Scratch::new("author");
        let dir = git_repo(&scratch);
        let (start, end) = local_day_range("2026-08-15", 0).expect("range");
        let noon = start / 1000 + 12 * 3600;

        git_commit(dir, noon, "mine", &[("mine.txt", "m\n")]);
        // Someone else's commit, landed the same day by a pull.
        std::fs::write(dir.join("theirs.txt"), "t\n").expect("write");
        let stamp = format!("{noon} +0000");
        for args in [vec!["add", "-A"], vec!["commit", "-m", "theirs"]] {
            let out = std::process::Command::new("git")
                .args(&args)
                .current_dir(dir)
                .env("GIT_AUTHOR_DATE", &stamp)
                .env("GIT_COMMITTER_DATE", &stamp)
                .env("GIT_AUTHOR_NAME", "Someone")
                .env("GIT_AUTHOR_EMAIL", "someone@example.com")
                .env("GIT_COMMITTER_NAME", "Someone")
                .env("GIT_COMMITTER_EMAIL", "someone@example.com")
                .output()
                .expect("run git");
            assert!(out.status.success(), "git {args:?}");
        }

        let subjects: Vec<String> = collect_commits(dir, start, end)
            .into_iter()
            .map(|c| c.subject)
            .collect();
        assert_eq!(subjects, vec!["mine"], "a daily note is about your own day");
    }

    #[test]
    fn collect_commits_on_a_non_repo_is_empty_not_an_error() {
        let scratch = Scratch::new("norepo");
        let (start, end) = local_day_range("2026-08-15", 0).expect("range");
        assert!(collect_commits(scratch.path(), start, end).is_empty());
    }

    #[test]
    fn spec_stem_accepts_numbered_specs_only() {
        assert_eq!(
            spec_stem("docs/221-harness-status-line-density.md").as_deref(),
            Some("221-harness-status-line-density")
        );
        // A rename resolves to the path that still exists.
        assert_eq!(
            spec_stem("docs/220-old.md => docs/220-window-diff-stat.md").as_deref(),
            Some("220-window-diff-stat")
        );
        assert_eq!(
            spec_stem("docs/README.md"),
            None,
            "unnumbered docs are noise"
        );
        assert_eq!(
            spec_stem("docs/adr/0020-thing.md"),
            None,
            "ADRs are not specs"
        );
        assert_eq!(spec_stem("src/acp/daily-note.ts"), None);
        assert_eq!(spec_stem("docs/images/foo.png"), None);
    }

    #[test]
    fn artifact_title_is_read_from_the_html_head() {
        let scratch = Scratch::new("artifact");
        let file = scratch.path().join("art-1.html");
        std::fs::write(
            &file,
            "<html><head><title> Coach — UI mock </title></head></html>",
        )
        .expect("write");
        assert_eq!(artifact_title(&file).as_deref(), Some("Coach — UI mock"));
    }
}
