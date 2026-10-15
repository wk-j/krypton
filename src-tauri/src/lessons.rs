//! Global lane lessons (spec 298).
//!
//! A lesson is a short behavioural rule a harness lane records after it is
//! corrected. Lessons are global — one store under `~/.config/krypton/lessons/`
//! shared by every lane of every backend in every project — and the frontend
//! injects the active set into each lane's policy packet.
//!
//! One markdown file per lesson (`<slug>.md`, `key: value` frontmatter + body)
//! so a human can read, edit, or delete any lesson with a plain editor.
//! `INDEX.md` is a generated, read-only digest for the in-app Markdown Viewer.
//! Retired lessons move to `retired/` and are never injected.

use std::path::{Path, PathBuf};
use std::sync::Mutex;

use serde::Serialize;

/// Hard cap on active lessons. A new slug past the cap is refused so the lane
/// consolidates (update or retire) instead of growing the policy packet.
pub const MAX_ACTIVE_LESSONS: usize = 30;
/// Active count at which lesson_record starts asking the lane to consolidate
/// (spec 299). 80% of `MAX_ACTIVE_LESSONS`.
pub const PRESSURE_WATERMARK: usize = 24;
pub const MAX_TITLE_CHARS: usize = 80;
pub const MAX_RULE_CHARS: usize = 240;
pub const MAX_NOTE_CHARS: usize = 600;

const INDEX_FILE: &str = "INDEX.md";
const RETIRED_DIR: &str = "retired";

/// Serializes every read-modify-write on the store. Lanes in different harness
/// tabs (and the `list_lessons` command) share the same directory.
static STORE_LOCK: Mutex<()> = Mutex::new(());

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum LessonSource {
    Redirect,
    Review,
    Correction,
    Manual,
}

impl LessonSource {
    pub fn parse(raw: &str) -> Option<Self> {
        match raw.trim() {
            "redirect" => Some(Self::Redirect),
            "review" => Some(Self::Review),
            "correction" => Some(Self::Correction),
            "manual" => Some(Self::Manual),
            _ => None,
        }
    }

    pub fn as_str(self) -> &'static str {
        match self {
            Self::Redirect => "redirect",
            Self::Review => "review",
            Self::Correction => "correction",
            Self::Manual => "manual",
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Lesson {
    pub slug: String,
    pub title: String,
    pub rule: String,
    pub why: String,
    pub how_to_apply: String,
    pub source: LessonSource,
    pub origin: String,
    pub author: String,
    pub created: String,
    pub updated: String,
}

/// What a lane submits through `lesson_record`, after validation.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LessonInput {
    pub slug: String,
    pub title: String,
    pub rule: String,
    pub why: String,
    pub how_to_apply: String,
    pub source: LessonSource,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RecordAction {
    Created,
    Updated,
}

impl RecordAction {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Created => "created",
            Self::Updated => "updated",
        }
    }
}

/// How full the store is after a write (spec 299). `crowded` is set only when
/// the write *raised* the count into `PRESSURE_WATERMARK`, so re-recording onto
/// an existing slug — the consolidation the notice asks for — never nags again.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Pressure {
    pub active: usize,
    pub crowded: bool,
}

/// The injected view of one lesson. `why` / `how_to_apply` stay in the file
/// and `INDEX.md`; the policy packet carries only the rule.
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct LessonEntry {
    pub slug: String,
    pub title: String,
    pub rule: String,
    pub source: String,
    pub origin: String,
    pub updated: String,
    /// spec 299: a hand-edited rule past `MAX_RULE_CHARS` is held out of the
    /// policy rather than truncated — half a rule can invert its meaning.
    pub oversized: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LessonsSnapshot {
    pub entries: Vec<LessonEntry>,
    pub index_path: String,
    pub cap: usize,
}

/// `~/.config/krypton/lessons`.
pub fn default_dir() -> Option<PathBuf> {
    crate::config::config_dir().map(|dir| dir.join("lessons"))
}

/// Today's local date as `YYYY-MM-DD`.
pub fn today() -> String {
    chrono::Local::now().format("%Y-%m-%d").to_string()
}

fn valid_slug(slug: &str) -> bool {
    let bytes = slug.as_bytes();
    (3..=48).contains(&bytes.len())
        && bytes[0].is_ascii_alphanumeric()
        && bytes
            .iter()
            .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || *b == b'-')
}

fn one_line(field: &str, value: &str, max: usize) -> Result<String, String> {
    let value = value.trim();
    if value.is_empty() {
        return Err(format!("{field} must be non-empty"));
    }
    if value.contains('\n') || value.contains('\r') {
        return Err(format!("{field} must be a single line"));
    }
    if value.chars().count() > max {
        return Err(format!("{field} must be at most {max} characters"));
    }
    Ok(value.to_string())
}

fn note(field: &str, value: &str) -> Result<String, String> {
    let value = value.trim();
    if value.is_empty() {
        return Err(format!("{field} must be non-empty"));
    }
    if value.chars().count() > MAX_NOTE_CHARS {
        return Err(format!(
            "{field} must be at most {MAX_NOTE_CHARS} characters"
        ));
    }
    // A line starting with `## ` would be read back as a section heading.
    Ok(value
        .lines()
        .map(|line| line.strip_prefix("## ").unwrap_or(line))
        .collect::<Vec<_>>()
        .join("\n"))
}

/// Validate raw `lesson_record` arguments.
pub fn validate_input(
    slug: &str,
    title: &str,
    rule: &str,
    why: &str,
    how_to_apply: &str,
    source: &str,
) -> Result<LessonInput, String> {
    let slug = slug.trim();
    if !valid_slug(slug) {
        return Err(
            "slug must be 3-48 chars of lowercase a-z, 0-9 and '-', starting with a letter or digit"
                .to_string(),
        );
    }
    let source = LessonSource::parse(source)
        .ok_or_else(|| "source must be one of: redirect, review, correction, manual".to_string())?;
    Ok(LessonInput {
        slug: slug.to_string(),
        title: one_line("title", title, MAX_TITLE_CHARS)?,
        rule: one_line("rule", rule, MAX_RULE_CHARS)?,
        why: note("why", why)?,
        how_to_apply: note("how_to_apply", how_to_apply)?,
        source,
    })
}

/// Collapse a system-supplied frontmatter value (origin, author, reason) onto
/// one line so it cannot break the block.
fn frontmatter_value(value: &str) -> String {
    let flat = value.split_whitespace().collect::<Vec<_>>().join(" ");
    if flat.is_empty() {
        "-".to_string()
    } else {
        flat
    }
}

pub fn render_lesson(lesson: &Lesson, extra: &[(&str, &str)]) -> String {
    let mut out = String::from("---\n");
    out.push_str(&format!("title: {}\n", frontmatter_value(&lesson.title)));
    out.push_str(&format!("source: {}\n", lesson.source.as_str()));
    out.push_str(&format!("origin: {}\n", frontmatter_value(&lesson.origin)));
    out.push_str(&format!("author: {}\n", frontmatter_value(&lesson.author)));
    out.push_str(&format!(
        "created: {}\n",
        frontmatter_value(&lesson.created)
    ));
    out.push_str(&format!(
        "updated: {}\n",
        frontmatter_value(&lesson.updated)
    ));
    for (key, value) in extra {
        out.push_str(&format!("{key}: {}\n", frontmatter_value(value)));
    }
    out.push_str("---\n");
    out.push_str(lesson.rule.trim());
    out.push_str("\n\n## Why\n");
    out.push_str(lesson.why.trim());
    out.push_str("\n\n## How to apply\n");
    out.push_str(lesson.how_to_apply.trim());
    out.push('\n');
    out
}

/// Parse one lesson file. Tolerant of hand edits: unknown `source` reads as
/// `manual`, missing sections read as empty. Only a missing frontmatter block,
/// title, or rule makes a file invalid.
pub fn parse_lesson(slug: &str, text: &str) -> Result<Lesson, String> {
    let text = text.replace("\r\n", "\n");
    let rest = text
        .strip_prefix("---\n")
        .ok_or("missing frontmatter (file must start with ---)")?;
    let (front, body) = rest
        .split_once("\n---\n")
        .or_else(|| rest.strip_suffix("\n---").map(|front| (front, "")))
        .ok_or("frontmatter is not closed with ---")?;

    let field = |key: &str| -> String {
        front
            .lines()
            .find_map(|line| {
                let (k, v) = line.split_once(':')?;
                (k.trim() == key).then(|| v.trim().to_string())
            })
            .unwrap_or_default()
    };
    let title = field("title");
    let source = LessonSource::parse(&field("source")).unwrap_or(LessonSource::Manual);
    let origin = field("origin");
    let author = field("author");
    let created = field("created");
    let updated = field("updated");

    let first_heading = if body.starts_with("## ") {
        Some(0)
    } else {
        body.find("\n## ").map(|at| at + 1)
    };
    let (rule_part, sections) = match first_heading {
        Some(at) => body.split_at(at),
        None => (body, ""),
    };
    let rule = rule_part.split_whitespace().collect::<Vec<_>>().join(" ");
    let mut why = String::new();
    let mut how_to_apply = String::new();
    for section in sections.split("\n## ") {
        let section = section.strip_prefix("## ").unwrap_or(section);
        let (heading, content) = section.split_once('\n').unwrap_or((section, ""));
        match heading.trim().to_ascii_lowercase().as_str() {
            "why" => why = content.trim().to_string(),
            "how to apply" => how_to_apply = content.trim().to_string(),
            _ => {}
        }
    }

    if title.is_empty() {
        return Err("missing title".to_string());
    }
    if rule.is_empty() {
        return Err("missing rule (the first paragraph after the frontmatter)".to_string());
    }
    Ok(Lesson {
        slug: slug.to_string(),
        title,
        rule,
        why,
        how_to_apply,
        source,
        origin,
        author,
        created,
        updated,
    })
}

struct Loaded {
    lessons: Vec<Lesson>,
    invalid: Vec<(String, String)>,
}

/// Read every active lesson. Sorted newest `updated` first, then by slug, so
/// the injected block (and therefore the policy hash) is stable.
fn load_active(dir: &Path) -> Loaded {
    let mut lessons = Vec::new();
    let mut invalid = Vec::new();
    let Ok(read) = std::fs::read_dir(dir) else {
        return Loaded { lessons, invalid };
    };
    for entry in read.flatten() {
        let path = entry.path();
        if !path.is_file() || path.extension().and_then(|e| e.to_str()) != Some("md") {
            continue;
        }
        let file_name = entry.file_name().to_string_lossy().into_owned();
        if file_name == INDEX_FILE {
            continue;
        }
        let slug = file_name.trim_end_matches(".md").to_string();
        if !valid_slug(&slug) {
            invalid.push((file_name, "file name is not a valid slug".to_string()));
            continue;
        }
        match std::fs::read_to_string(&path)
            .map_err(|e| e.to_string())
            .and_then(|text| parse_lesson(&slug, &text))
        {
            Ok(lesson) => lessons.push(lesson),
            Err(error) => {
                log::warn!("lessons: skipping {}: {error}", path.display());
                invalid.push((file_name, error));
            }
        }
    }
    lessons.sort_by(|a, b| b.updated.cmp(&a.updated).then(a.slug.cmp(&b.slug)));
    invalid.sort();
    Loaded { lessons, invalid }
}

fn write_atomic(path: &Path, contents: &str) -> Result<(), String> {
    let tmp = path.with_extension("md.tmp");
    let result = std::fs::write(&tmp, contents).and_then(|()| std::fs::rename(&tmp, path));
    if let Err(error) = result {
        let _ = std::fs::remove_file(&tmp);
        return Err(format!("failed to write {}: {error}", path.display()));
    }
    Ok(())
}

fn ensure_dir(dir: &Path) -> Result<(), String> {
    std::fs::create_dir_all(dir).map_err(|e| format!("failed to create {}: {e}", dir.display()))
}

/// spec 299: a rule past the cap is held out of the policy, never truncated.
fn is_oversized(rule: &str) -> bool {
    rule.chars().count() > MAX_RULE_CHARS
}

pub fn render_index(lessons: &[Lesson], invalid: &[(String, String)]) -> String {
    let mut out = String::from(
        "<!-- Generated by Krypton (spec 298). Edit or delete the lesson files in this folder, not this index. -->\n",
    );
    out.push_str(&format!(
        "# Lessons ({}/{MAX_ACTIVE_LESSONS})\n\nGlobal rules every Krypton harness lane follows, learned from past corrections. One file per lesson in this folder; retired lessons live in `retired/`.\n",
        lessons.len()
    ));
    if lessons.is_empty() {
        out.push_str("\nNo lessons yet. Lanes record one when the human corrects them or a reviewer reports a blocker; `#lesson` asks a lane to distill its session.\n");
    }
    for lesson in lessons {
        out.push_str(&format!("\n## {}\n\n", lesson.title));
        out.push_str(&format!(
            "`{}.md` · {} · from {} · by {} · updated {}\n\n",
            lesson.slug,
            lesson.source.as_str(),
            frontmatter_value(&lesson.origin),
            frontmatter_value(&lesson.author),
            frontmatter_value(&lesson.updated),
        ));
        out.push_str(&format!("**Rule:** {}\n", lesson.rule));
        if !lesson.why.is_empty() {
            out.push_str(&format!("\n**Why:** {}\n", lesson.why));
        }
        if !lesson.how_to_apply.is_empty() {
            out.push_str(&format!("\n**How to apply:** {}\n", lesson.how_to_apply));
        }
    }
    let oversized: Vec<&Lesson> = lessons.iter().filter(|l| is_oversized(&l.rule)).collect();
    if !oversized.is_empty() {
        out.push_str(&format!(
            "\n## Oversized rules (not injected)\n\nThese still count toward the cap. Shorten the first paragraph to {MAX_RULE_CHARS} characters to put the lesson back in every lane's policy.\n\n"
        ));
        for lesson in oversized {
            out.push_str(&format!(
                "- `{}.md` — rule is {} characters\n",
                lesson.slug,
                lesson.rule.chars().count()
            ));
        }
    }
    if !invalid.is_empty() {
        out.push_str("\n## Invalid files\n\nNot injected into any lane until fixed.\n\n");
        for (file, error) in invalid {
            out.push_str(&format!("- `{file}` — {error}\n"));
        }
    }
    out
}

/// Rewrite `INDEX.md` when its content changed.
fn refresh_index(dir: &Path, loaded: &Loaded) -> Result<PathBuf, String> {
    let path = dir.join(INDEX_FILE);
    let next = render_index(&loaded.lessons, &loaded.invalid);
    if std::fs::read_to_string(&path).ok().as_deref() != Some(next.as_str()) {
        write_atomic(&path, &next)?;
    }
    Ok(path)
}

fn entry(lesson: &Lesson) -> LessonEntry {
    LessonEntry {
        slug: lesson.slug.clone(),
        title: lesson.title.clone(),
        rule: lesson.rule.clone(),
        source: lesson.source.as_str().to_string(),
        origin: lesson.origin.clone(),
        updated: lesson.updated.clone(),
        oversized: is_oversized(&lesson.rule),
    }
}

fn lock() -> std::sync::MutexGuard<'static, ()> {
    STORE_LOCK
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
}

/// List active lessons and regenerate `INDEX.md`.
pub fn snapshot(dir: &Path) -> Result<LessonsSnapshot, String> {
    let _guard = lock();
    ensure_dir(dir)?;
    let loaded = load_active(dir);
    let index_path = refresh_index(dir, &loaded)?;
    Ok(LessonsSnapshot {
        entries: loaded.lessons.iter().map(entry).collect(),
        index_path: index_path.to_string_lossy().into_owned(),
        cap: MAX_ACTIVE_LESSONS,
    })
}

/// Clamp a title for the full-store refusal: 30 rows stay near 2.5 KB.
fn clamp_title(title: &str) -> String {
    const MAX: usize = 60;
    let mut out: String = title.chars().take(MAX).collect();
    if title.chars().count() > MAX {
        out.push('…');
    }
    out
}

/// Every active lesson, newest first, listed in the full-store refusal so the
/// lane merges against the store as it is now, not the policy it was handed at
/// the start of the turn (another lane may have written since).
fn store_listing(lessons: &[Lesson]) -> String {
    lessons
        .iter()
        .map(|lesson| {
            let updated = if lesson.updated.is_empty() {
                "?"
            } else {
                lesson.updated.as_str()
            };
            format!(
                "\n  {} ({updated}) {}",
                lesson.slug,
                clamp_title(&lesson.title)
            )
        })
        .collect()
}

/// Create or update a lesson. Updating keeps `created` and `origin`.
/// Returns the action and the store pressure after the write.
pub fn record(
    dir: &Path,
    input: LessonInput,
    origin: &str,
    author: &str,
    today: &str,
) -> Result<(RecordAction, Pressure), String> {
    let _guard = lock();
    ensure_dir(dir)?;
    let loaded = load_active(dir);
    let path = dir.join(format!("{}.md", input.slug));
    let existing = loaded.lessons.iter().find(|l| l.slug == input.slug);
    // spec 299: derived from the parsed set the cap counts, not from
    // `path.exists()`. A file that fails to parse is not an active lesson, so
    // writing onto its slug is a create and must face the cap.
    let action = if existing.is_some() {
        RecordAction::Updated
    } else {
        RecordAction::Created
    };
    if action == RecordAction::Created && loaded.lessons.len() >= MAX_ACTIVE_LESSONS {
        return Err(format!(
            "lesson store is full ({MAX_ACTIVE_LESSONS} active) — update the listed lesson that covers this (lesson_record on its slug), or lesson_retire one first. Current store:{}",
            store_listing(&loaded.lessons)
        ));
    }
    let lesson = Lesson {
        slug: input.slug,
        title: input.title,
        rule: input.rule,
        why: input.why,
        how_to_apply: input.how_to_apply,
        source: input.source,
        origin: existing
            .map(|l| l.origin.clone())
            .unwrap_or_else(|| origin.to_string()),
        author: author.to_string(),
        created: existing
            .map(|l| l.created.clone())
            .filter(|c| !c.is_empty())
            .unwrap_or_else(|| today.to_string()),
        updated: today.to_string(),
    };
    write_atomic(&path, &render_lesson(&lesson, &[]))?;
    let after = load_active(dir);
    refresh_index(dir, &after)?;
    let active = after.lessons.len();
    Ok((
        action,
        Pressure {
            active,
            crowded: action == RecordAction::Created && active >= PRESSURE_WATERMARK,
        },
    ))
}

/// Move a lesson to `retired/`, stamped with the date and reason. Returns the
/// retired lesson's title and the active count after the move.
pub fn retire(
    dir: &Path,
    slug: &str,
    reason: &str,
    today: &str,
) -> Result<(String, usize), String> {
    let _guard = lock();
    let slug = slug.trim();
    if !valid_slug(slug) {
        return Err(format!("unknown lesson: {slug}"));
    }
    let reason = one_line("reason", reason, MAX_NOTE_CHARS)?;
    let path = dir.join(format!("{slug}.md"));
    let text = std::fs::read_to_string(&path).map_err(|_| format!("unknown lesson: {slug}"))?;
    let retired_dir = dir.join(RETIRED_DIR);
    ensure_dir(&retired_dir)?;
    let retired_path = retired_dir.join(format!("{slug}.md"));
    let title = match parse_lesson(slug, &text) {
        Ok(lesson) => {
            let stamped =
                render_lesson(&lesson, &[("retired", today), ("retired_reason", &reason)]);
            write_atomic(&retired_path, &stamped)?;
            std::fs::remove_file(&path)
                .map_err(|e| format!("failed to remove {}: {e}", path.display()))?;
            lesson.title
        }
        // An unparseable file is moved as-is so nothing is lost.
        Err(_) => {
            std::fs::rename(&path, &retired_path)
                .map_err(|e| format!("failed to move {}: {e}", path.display()))?;
            slug.to_string()
        }
    };
    let after = load_active(dir);
    refresh_index(dir, &after)?;
    Ok((title, after.lessons.len()))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_dir(name: &str) -> PathBuf {
        let nanos = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_nanos())
            .unwrap_or(0);
        std::env::temp_dir().join(format!("krypton-lessons-{name}-{nanos}"))
    }

    fn input(slug: &str) -> LessonInput {
        validate_input(
            slug,
            "ตรวจก่อนบอกว่าเสร็จ",
            "When you claim a fix, run the check yourself first.",
            "The user had to verify twice.",
            "Run tests or take a screenshot before saying done.",
            "redirect",
        )
        .expect("valid input")
    }

    #[test]
    fn validate_rejects_bad_slug_multiline_rule_and_unknown_source() {
        assert!(validate_input("A", "t", "r", "w", "h", "manual").is_err());
        assert!(validate_input("Bad_Slug", "t", "r", "w", "h", "manual").is_err());
        assert!(validate_input("-lead", "t", "r", "w", "h", "manual").is_err());
        assert!(validate_input("ok-slug", "t", "line\nbreak", "w", "h", "manual").is_err());
        assert!(validate_input("ok-slug", "t", "r", "w", "h", "vibes").is_err());
        let long_rule = "x".repeat(MAX_RULE_CHARS + 1);
        assert!(validate_input("ok-slug", "t", &long_rule, "w", "h", "manual").is_err());
        assert!(validate_input("ok-slug", "t", "r", "w", "h", "review").is_ok());
    }

    #[test]
    fn render_and_parse_round_trip() {
        let lesson = Lesson {
            slug: "verify-first".to_string(),
            title: "Verify: before claiming".to_string(),
            rule: "When done, verify.".to_string(),
            why: "Twice burned.\nSecond line.".to_string(),
            how_to_apply: "Run the tests.".to_string(),
            source: LessonSource::Review,
            origin: "krypton".to_string(),
            author: "Claude-1".to_string(),
            created: "2026-10-01".to_string(),
            updated: "2026-10-14".to_string(),
        };
        let text = render_lesson(&lesson, &[]);
        assert_eq!(parse_lesson("verify-first", &text), Ok(lesson));
    }

    #[test]
    fn parse_tolerates_hand_edits_and_rejects_missing_rule() {
        let text = "---\ntitle: Hand made\nsource: whatever\n---\nA rule\nwrapped over lines.\n";
        let lesson = parse_lesson("hand-made", text).expect("parses");
        assert_eq!(lesson.rule, "A rule wrapped over lines.");
        assert_eq!(lesson.source, LessonSource::Manual);
        assert!(lesson.why.is_empty());
        assert!(parse_lesson("x-y-z", "---\ntitle: T\n---\n\n## Why\nno rule\n").is_err());
        assert!(parse_lesson("x-y-z", "no frontmatter").is_err());
    }

    #[test]
    fn record_creates_then_updates_keeping_created_and_origin() {
        let dir = temp_dir("upsert");
        let (action, pressure) = record(
            &dir,
            input("verify-first"),
            "krypton",
            "Claude-1",
            "2026-10-01",
        )
        .unwrap();
        assert_eq!((action, pressure.active), (RecordAction::Created, 1));
        assert!(!pressure.crowded);

        let mut next = input("verify-first");
        next.rule = "Updated rule.".to_string();
        let (action, pressure) = record(&dir, next, "other-repo", "Codex-2", "2026-10-14").unwrap();
        assert_eq!((action, pressure.active), (RecordAction::Updated, 1));

        let text = std::fs::read_to_string(dir.join("verify-first.md")).unwrap();
        let lesson = parse_lesson("verify-first", &text).unwrap();
        assert_eq!(lesson.rule, "Updated rule.");
        assert_eq!(lesson.created, "2026-10-01");
        assert_eq!(lesson.updated, "2026-10-14");
        assert_eq!(lesson.origin, "krypton");
        assert_eq!(lesson.author, "Codex-2");
        let index = std::fs::read_to_string(dir.join(INDEX_FILE)).unwrap();
        assert!(index.contains("**Rule:** Updated rule."));
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// Fill the store to `count` lessons, one slug each.
    fn fill(dir: &Path, count: usize) {
        for i in 0..count {
            record(
                dir,
                input(&format!("lesson-{i:02}")),
                "p",
                "a",
                "2026-10-14",
            )
            .unwrap();
        }
    }

    #[test]
    fn record_refuses_a_new_slug_at_the_cap_and_lists_the_whole_store() {
        let dir = temp_dir("cap");
        fill(&dir, MAX_ACTIVE_LESSONS);
        let err = record(&dir, input("one-too-many"), "p", "a", "2026-10-14").unwrap_err();
        assert!(err.contains("full"));
        // Every active lesson is listed so the lane merges against the store as
        // it is now (spec 299).
        for i in 0..MAX_ACTIVE_LESSONS {
            assert!(
                err.contains(&format!("lesson-{i:02} (2026-10-14)")),
                "{err}"
            );
        }
        assert!(record(&dir, input("lesson-00"), "p", "a", "2026-10-15").is_ok());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn pressure_crowds_only_when_a_create_raises_the_count_into_the_watermark() {
        let dir = temp_dir("pressure");
        fill(&dir, PRESSURE_WATERMARK - 2);
        let (action, pressure) = record(&dir, input("below"), "p", "a", "2026-10-14").unwrap();
        assert_eq!(action, RecordAction::Created);
        assert_eq!(pressure.active, PRESSURE_WATERMARK - 1);
        assert!(!pressure.crowded, "below the watermark nothing nags");

        let (action, pressure) = record(&dir, input("crosses"), "p", "a", "2026-10-14").unwrap();
        assert_eq!(action, RecordAction::Created);
        assert_eq!(pressure.active, PRESSURE_WATERMARK);
        assert!(pressure.crowded);

        // The consolidation the notice asks for — re-recording onto an existing
        // slug — carries no second notice.
        let (action, pressure) = record(&dir, input("crosses"), "p", "a", "2026-10-15").unwrap();
        assert_eq!(action, RecordAction::Updated);
        assert!(!pressure.crowded);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_slug_whose_file_is_invalid_is_a_create_and_faces_the_cap() {
        let dir = temp_dir("cap-leak");
        fill(&dir, MAX_ACTIVE_LESSONS);
        std::fs::write(dir.join("broken.md"), "no frontmatter").unwrap();
        let err = record(&dir, input("broken"), "p", "a", "2026-10-15").unwrap_err();
        assert!(err.contains("full"), "{err}");
        // Retiring the broken file is the way through.
        retire(&dir, "lesson-00", "superseded", "2026-10-15").unwrap();
        let (action, pressure) = record(&dir, input("broken"), "p", "a", "2026-10-15").unwrap();
        assert_eq!(action, RecordAction::Created);
        assert_eq!(pressure.active, MAX_ACTIVE_LESSONS);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn an_oversized_hand_edited_rule_is_flagged_and_named_in_the_index() {
        let dir = temp_dir("oversized");
        record(&dir, input("fine"), "p", "a", "2026-10-14").unwrap();
        let long = "x".repeat(MAX_RULE_CHARS + 5);
        std::fs::write(
            dir.join("too-long.md"),
            format!("---\ntitle: Too long\nupdated: 2026-10-14\n---\n{long}\n"),
        )
        .unwrap();
        let snap = snapshot(&dir).unwrap();
        let flagged: Vec<_> = snap
            .entries
            .iter()
            .map(|e| (e.slug.as_str(), e.oversized))
            .collect();
        assert!(flagged.contains(&("too-long", true)));
        assert!(flagged.contains(&("fine", false)));
        let index = std::fs::read_to_string(&snap.index_path).unwrap();
        assert!(index.contains("## Oversized rules (not injected)"));
        assert!(index.contains(&format!(
            "`too-long.md` — rule is {} characters",
            MAX_RULE_CHARS + 5
        )));
        // Oversized lessons still count toward the cap.
        assert_eq!(snap.entries.len(), 2);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn retire_moves_the_file_and_stamps_it() {
        let dir = temp_dir("retire");
        record(&dir, input("verify-first"), "p", "a", "2026-10-14").unwrap();
        let (title, active) =
            retire(&dir, "verify-first", "Human contradicted it", "2026-10-15").unwrap();
        assert_eq!(title, "ตรวจก่อนบอกว่าเสร็จ");
        assert_eq!(active, 0);
        assert!(!dir.join("verify-first.md").exists());
        let retired = std::fs::read_to_string(dir.join("retired").join("verify-first.md")).unwrap();
        assert!(retired.contains("retired: 2026-10-15"));
        assert!(retired.contains("retired_reason: Human contradicted it"));
        assert!(retire(&dir, "verify-first", "again", "2026-10-15").is_err());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn snapshot_sorts_newest_first_and_lists_invalid_files() {
        let dir = temp_dir("snapshot");
        record(&dir, input("older"), "p", "a", "2026-10-01").unwrap();
        record(&dir, input("newer"), "p", "a", "2026-10-14").unwrap();
        std::fs::write(dir.join("broken.md"), "no frontmatter").unwrap();
        std::fs::write(dir.join("Bad Name.md"), "---\ntitle: x\n---\nrule\n").unwrap();
        let snap = snapshot(&dir).unwrap();
        let slugs: Vec<_> = snap.entries.iter().map(|e| e.slug.as_str()).collect();
        assert_eq!(slugs, vec!["newer", "older"]);
        assert_eq!(snap.cap, MAX_ACTIVE_LESSONS);
        let index = std::fs::read_to_string(&snap.index_path).unwrap();
        assert!(index.contains("## Invalid files"));
        assert!(index.contains("`broken.md`"));
        assert!(index.contains("`Bad Name.md`"));
        let _ = std::fs::remove_dir_all(&dir);
    }
}
