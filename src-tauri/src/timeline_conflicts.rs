//! Timeline decision trace and conflict review (spec 266, reworked by spec 267).
//!
//! Confirmed timeline events stay untouched. `supersedes` links project into
//! chains; pairs that may conflict live in append-only sidecar files under
//! `.krypton/timeline/conflicts/`, always keyed by event ID so topic renames
//! and merges never orphan them. Spec 267: the lane agent finds, judges, and
//! closes pairs through MCP tools; each call appends a review and the newest
//! review of a pair is its current state. Per-topic checkpoints record which
//! events an agent has already compared, so a later check only reads new ones.

use std::collections::{HashMap, HashSet};
use std::fs::{self, OpenOptions};
use std::io::Write;
use std::path::{Path, PathBuf};

use chrono::{SecondsFormat, Utc};
use serde::de::DeserializeOwned;
use serde::{Deserialize, Serialize};

use crate::timeline::{
    existing_confined_root, random_hex, relative_path, scan_project, validate_event_id,
    validate_optional_single_line, writable_confined_root, TimelineDiagnostic, TimelineEvent,
    TimelineListResponse, TimelineRelation, TIMELINE_MUTATION_LOCK,
};

const SIDECAR_SCHEMA: u8 = 1;
const MAX_SIDECAR_BYTES: u64 = 16 * 1024;
const MAX_CHECKPOINT_BYTES: u64 = 64 * 1024;
const MAX_PROPOSALS: usize = 500;
const MAX_REVIEWS: usize = 2_000;
const MAX_CHECKPOINTS: usize = 500;
const MAX_CHECKPOINT_EVENTS: usize = 1_000;
const MAX_RATIONALE_CHARS: usize = 1_000;
const MAX_SOURCE_CHARS: usize = 2 * 1024;
const MAX_UNCHECKED_TOPICS: usize = 20;
const MAX_LIST_PAIRS: usize = 50;

// ─── Sidecar files (snake_case on disk) ──────────────────────────────

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum TimelineConflictOrigin {
    /// Spec 267: recorded by a lane agent through `timeline_conflict_record`.
    Agent,
    /// Spec 266 sidecars (in-app sheet / TypeSafe scan); still readable.
    Manual,
    Typesafe,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum TimelineConflictVerdict {
    Confirmed,
    Dismissed,
    InsufficientEvidence,
    Resolved,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct ProposalFile {
    schema: u8,
    pair_id: String,
    event_a: String,
    event_b: String,
    origin: TimelineConflictOrigin,
    suggested_at: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    model: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    probability: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    input_hash: Option<String>,
    basis: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct ReviewFile {
    schema: u8,
    id: String,
    pair_id: String,
    verdict: TimelineConflictVerdict,
    rationale: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    source_ref: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    resolution_event_id: Option<String>,
    reviewed_at: String,
    reviewed_by: String,
}

/// One topic's checkpoint: event IDs a lane agent has already compared.
/// Rewritten (not appended) on every `timeline_conflict_checked` call.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct CheckpointFile {
    schema: u8,
    topic_id: String,
    checked_event_ids: Vec<String>,
    checked_by: String,
    checked_at: String,
}

// ─── Read model (camelCase over IPC and /timeline.json) ──────────────

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct TimelineChainLink {
    pub from: String,
    pub to: String,
    pub kind: &'static str,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct TimelineChain {
    pub topic_id: String,
    pub event_ids: Vec<String>,
    pub links: Vec<TimelineChainLink>,
}

#[derive(Debug, Clone, Copy, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum TimelineConflictState {
    Unreviewed,
    Confirmed,
    Dismissed,
    InsufficientEvidence,
    Resolved,
    Historical,
}

impl TimelineConflictState {
    fn needs_review(self) -> bool {
        matches!(self, Self::Unreviewed | Self::InsufficientEvidence)
    }
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct TimelineConflictReview {
    pub id: String,
    pub verdict: TimelineConflictVerdict,
    pub rationale: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub source_ref: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub resolution_event_id: Option<String>,
    pub reviewed_by: String,
    pub reviewed_at: String,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct TimelineConflictPair {
    pub pair_id: String,
    pub event_a: String,
    pub event_b: String,
    pub state: TimelineConflictState,
    pub origin: TimelineConflictOrigin,
    pub basis: String,
    pub suggested_at: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub model: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub probability: Option<f64>,
    pub reviews: Vec<TimelineConflictReview>,
}

/// Counts are project-wide and count each pair once; a cross-topic pair
/// appears in both topics' filtered views but not twice here.
#[derive(Debug, Clone, Copy, Default, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct TimelineConflictCounts {
    pub needs_review: u32,
    pub confirmed: u32,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct TimelineTraceResponse {
    #[serde(flatten)]
    pub listing: TimelineListResponse,
    pub chains: Vec<TimelineChain>,
    pub conflict_pairs: Vec<TimelineConflictPair>,
    pub conflict_counts: TimelineConflictCounts,
}

// ─── Paths and file IO ───────────────────────────────────────────────

fn conflicts_root(project_dir: &Path) -> PathBuf {
    project_dir
        .join(".krypton")
        .join("timeline")
        .join("conflicts")
}

fn proposals_dir(project_dir: &Path) -> PathBuf {
    conflicts_root(project_dir).join("proposals")
}

fn reviews_dir(project_dir: &Path) -> PathBuf {
    conflicts_root(project_dir).join("reviews")
}

fn checked_dir(project_dir: &Path) -> PathBuf {
    conflicts_root(project_dir).join("checked")
}

/// Canonical, order-independent pair ID so the same two events can never be
/// proposed twice under different names.
pub(crate) fn canonical_pair(event_a: &str, event_b: &str) -> (String, String, String) {
    let (a, b) = if event_a <= event_b {
        (event_a, event_b)
    } else {
        (event_b, event_a)
    };
    (a.to_string(), b.to_string(), format!("{a}--{b}"))
}

fn validate_pair_id(value: &str) -> Result<(String, String, String), String> {
    let value = value.trim();
    let Some((a, b)) = value.split_once("--") else {
        return Err("pairId is not a valid timeline conflict pair id".to_string());
    };
    let a = validate_event_id(a).map_err(|_| "pairId contains an invalid event id")?;
    let b = validate_event_id(b).map_err(|_| "pairId contains an invalid event id")?;
    let canonical = canonical_pair(&a, &b);
    if a == b || canonical.2 != value {
        return Err("pairId is not canonical".to_string());
    }
    Ok(canonical)
}

fn validate_sidecar_id(value: &str, prefix: &str) -> bool {
    value.starts_with(prefix)
        && value.len() <= 80
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || byte == b'-')
}

fn validate_rationale(value: &str) -> Result<String, String> {
    let value = value.trim();
    if value.is_empty() {
        return Err("rationale is required".to_string());
    }
    if value.chars().count() > MAX_RATIONALE_CHARS {
        return Err(format!(
            "rationale must be at most {MAX_RATIONALE_CHARS} Unicode characters"
        ));
    }
    if value.contains('\0') {
        return Err("rationale contains an invalid character".to_string());
    }
    Ok(value.to_string())
}

/// Bounded read of one sidecar directory: regular `.json` files only, each
/// capped in size, every failure surfaced as a diagnostic.
fn read_sidecars<T: DeserializeOwned>(
    project_dir: &Path,
    requested: PathBuf,
    label: &str,
    cap: usize,
    max_bytes: u64,
    diagnostics: &mut Vec<TimelineDiagnostic>,
) -> Vec<(T, String, String)> {
    let (project, root) = match existing_confined_root(project_dir, requested, label) {
        Ok(Some(roots)) => roots,
        Ok(None) => return Vec::new(),
        Err(error) => {
            diagnostics.push(TimelineDiagnostic {
                path: ".krypton/timeline/conflicts".to_string(),
                error,
            });
            return Vec::new();
        }
    };
    let entries = match fs::read_dir(&root) {
        Ok(entries) => entries,
        Err(error) => {
            diagnostics.push(TimelineDiagnostic {
                path: relative_path(&project, &root),
                error: format!("failed to list {label} files: {error}"),
            });
            return Vec::new();
        }
    };
    let mut out = Vec::new();
    for entry in entries.flatten() {
        if out.len() >= cap {
            diagnostics.push(TimelineDiagnostic {
                path: relative_path(&project, &root),
                error: format!("more than {cap} {label} files; the rest were not read"),
            });
            break;
        }
        let path = entry.path();
        let display = relative_path(&project, &path);
        let Ok(file_type) = entry.file_type() else {
            continue;
        };
        if !file_type.is_file()
            || file_type.is_symlink()
            || path.extension().and_then(|value| value.to_str()) != Some("json")
        {
            continue;
        }
        let Some(stem) = path
            .file_stem()
            .and_then(|value| value.to_str())
            .map(str::to_string)
        else {
            continue;
        };
        match entry.metadata() {
            Ok(metadata) if metadata.len() > max_bytes => {
                diagnostics.push(TimelineDiagnostic {
                    path: display,
                    error: format!("{label} file exceeds {max_bytes} bytes"),
                });
                continue;
            }
            Ok(_) => {}
            Err(error) => {
                diagnostics.push(TimelineDiagnostic {
                    path: display,
                    error: format!("failed to inspect {label} file: {error}"),
                });
                continue;
            }
        }
        match fs::read(&path)
            .map_err(|error| format!("failed to read {label} file: {error}"))
            .and_then(|bytes| {
                serde_json::from_slice::<T>(&bytes)
                    .map_err(|error| format!("malformed {label} file: {error}"))
            }) {
            Ok(value) => out.push((value, stem, display)),
            Err(error) => diagnostics.push(TimelineDiagnostic {
                path: display,
                error,
            }),
        }
    }
    out
}

fn write_new_json<T: Serialize>(path: &Path, value: &T) -> Result<bool, String> {
    let body = serde_json::to_vec_pretty(value)
        .map_err(|error| format!("failed to encode timeline conflict file: {error}"))?;
    match OpenOptions::new().write(true).create_new(true).open(path) {
        Ok(mut file) => {
            file.write_all(&body)
                .and_then(|()| file.write_all(b"\n"))
                .and_then(|()| file.sync_all())
                .map_err(|error| format!("failed to write timeline conflict file: {error}"))?;
            Ok(true)
        }
        Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => Ok(false),
        Err(error) => Err(format!("failed to create timeline conflict file: {error}")),
    }
}

fn now_millis() -> String {
    Utc::now().to_rfc3339_opts(SecondsFormat::Millis, true)
}

fn new_sidecar_id(prefix: &str) -> Result<String, String> {
    Ok(format!(
        "{prefix}{}-{}",
        Utc::now().format("%Y%m%dT%H%M%S%3fZ"),
        random_hex()?
    ))
}

// ─── Trace projection ────────────────────────────────────────────────

struct Components {
    /// event id -> component index, only for events that have a link.
    of: HashMap<String, usize>,
    cyclic: HashSet<usize>,
}

fn find(parent: &mut [usize], mut node: usize) -> usize {
    while parent[node] != node {
        parent[node] = parent[parent[node]];
        node = parent[node];
    }
    node
}

/// Project `supersedes` links into chains. Branches stay visible as extra
/// links; a directed cycle is a diagnostic and that part is not summarised.
fn build_chains(
    events: &[TimelineEvent],
    diagnostics: &mut Vec<TimelineDiagnostic>,
) -> (Vec<TimelineChain>, Components) {
    let index: HashMap<&str, usize> = events
        .iter()
        .enumerate()
        .map(|(position, event)| (event.id.as_str(), position))
        .collect();
    let mut links = Vec::new();
    for (position, event) in events.iter().enumerate() {
        if event.relation != Some(TimelineRelation::Supersedes) {
            continue;
        }
        if let Some(target) = event.related_event.as_deref().and_then(|id| index.get(id)) {
            if *target != position {
                links.push((position, *target));
            }
        }
    }
    let mut parent: Vec<usize> = (0..events.len()).collect();
    for (from, to) in &links {
        let (left, right) = (find(&mut parent, *from), find(&mut parent, *to));
        if left != right {
            parent[left] = right;
        }
    }
    let mut roots: Vec<usize> = Vec::new();
    let mut root_slot: HashMap<usize, usize> = HashMap::new();
    let mut of = HashMap::new();
    let mut members: Vec<Vec<usize>> = Vec::new();
    let mut component_links: Vec<Vec<(usize, usize)>> = Vec::new();
    for (from, to) in &links {
        let root = find(&mut parent, *from);
        let slot = *root_slot.entry(root).or_insert_with(|| {
            roots.push(root);
            members.push(Vec::new());
            component_links.push(Vec::new());
            roots.len() - 1
        });
        component_links[slot].push((*from, *to));
    }
    for (position, event) in events.iter().enumerate() {
        let root = find(&mut parent, position);
        if let Some(slot) = root_slot.get(&root) {
            members[*slot].push(position);
            of.insert(event.id.clone(), *slot);
        }
    }
    let mut cyclic = HashSet::new();
    let mut chains = Vec::new();
    for (slot, member_positions) in members.iter().enumerate() {
        if has_cycle(member_positions, &component_links[slot]) {
            cyclic.insert(slot);
            let first = &events[member_positions[0]];
            diagnostics.push(TimelineDiagnostic {
                path: first.path.clone(),
                error: "supersedes links form a cycle; this chain is not summarised".to_string(),
            });
            continue;
        }
        // `scan_project` already sorts events chronologically.
        let latest = &events[*member_positions.iter().max().unwrap_or(&0)];
        chains.push(TimelineChain {
            topic_id: latest.topic_id.clone(),
            event_ids: member_positions
                .iter()
                .map(|position| events[*position].id.clone())
                .collect(),
            links: component_links[slot]
                .iter()
                .map(|(from, to)| TimelineChainLink {
                    from: events[*from].id.clone(),
                    to: events[*to].id.clone(),
                    kind: "supersedes",
                })
                .collect(),
        });
    }
    (chains, Components { of, cyclic })
}

fn has_cycle(members: &[usize], links: &[(usize, usize)]) -> bool {
    let mut outgoing: HashMap<usize, Vec<usize>> = HashMap::new();
    for (from, to) in links {
        outgoing.entry(*from).or_default().push(*to);
    }
    // 0 = unvisited, 1 = on stack, 2 = done
    let mut state: HashMap<usize, u8> = HashMap::new();
    for start in members {
        if state.get(start).copied().unwrap_or(0) != 0 {
            continue;
        }
        let mut stack = vec![(*start, 0_usize)];
        state.insert(*start, 1);
        while let Some((node, next)) = stack.pop() {
            let children = outgoing.get(&node).map(Vec::as_slice).unwrap_or(&[]);
            if let Some(child) = children.get(next) {
                stack.push((node, next + 1));
                match state.get(child).copied().unwrap_or(0) {
                    1 => return true,
                    0 => {
                        state.insert(*child, 1);
                        stack.push((*child, 0));
                    }
                    _ => {}
                }
            } else {
                state.insert(node, 2);
            }
        }
    }
    false
}

fn same_chain(components: &Components, left: &str, right: &str) -> bool {
    matches!(
        (components.of.get(left), components.of.get(right)),
        (Some(a), Some(b)) if a == b
    )
}

fn in_cycle(components: &Components, id: &str) -> bool {
    components
        .of
        .get(id)
        .is_some_and(|slot| components.cyclic.contains(slot))
}

struct LoadedSidecars {
    proposals: Vec<ProposalFile>,
    reviews: HashMap<String, Vec<ReviewFile>>,
    checked: HashMap<String, HashSet<String>>,
}

fn load_sidecars(
    project_dir: &Path,
    event_ids: &HashSet<&str>,
    diagnostics: &mut Vec<TimelineDiagnostic>,
) -> LoadedSidecars {
    let mut proposals = Vec::new();
    let mut proposal_ids = HashSet::new();
    for (proposal, stem, display) in read_sidecars::<ProposalFile>(
        project_dir,
        proposals_dir(project_dir),
        "conflict proposal",
        MAX_PROPOSALS,
        MAX_SIDECAR_BYTES,
        diagnostics,
    ) {
        let valid = proposal.schema == SIDECAR_SCHEMA
            && stem == proposal.pair_id
            && validate_pair_id(&proposal.pair_id)
                .is_ok_and(|(a, b, _)| a == proposal.event_a && b == proposal.event_b);
        if !valid {
            diagnostics.push(TimelineDiagnostic {
                path: display,
                error: "conflict proposal has an invalid schema or pair id".to_string(),
            });
            continue;
        }
        if !event_ids.contains(proposal.event_a.as_str())
            || !event_ids.contains(proposal.event_b.as_str())
        {
            diagnostics.push(TimelineDiagnostic {
                path: display,
                error: "conflict proposal refers to a timeline event that does not exist"
                    .to_string(),
            });
            continue;
        }
        proposal_ids.insert(proposal.pair_id.clone());
        proposals.push(proposal);
    }
    proposals.sort_by(|left, right| left.pair_id.cmp(&right.pair_id));

    let mut reviews: HashMap<String, Vec<ReviewFile>> = HashMap::new();
    for (review, stem, display) in read_sidecars::<ReviewFile>(
        project_dir,
        reviews_dir(project_dir),
        "conflict review",
        MAX_REVIEWS,
        MAX_SIDECAR_BYTES,
        diagnostics,
    ) {
        if review.schema != SIDECAR_SCHEMA
            || stem != review.id
            || !validate_sidecar_id(&review.id, "cr-")
        {
            diagnostics.push(TimelineDiagnostic {
                path: display,
                error: "conflict review has an invalid schema or id".to_string(),
            });
            continue;
        }
        if !proposal_ids.contains(&review.pair_id) {
            diagnostics.push(TimelineDiagnostic {
                path: display,
                error: "conflict review refers to a pair without a proposal".to_string(),
            });
            continue;
        }
        reviews
            .entry(review.pair_id.clone())
            .or_default()
            .push(review);
    }
    for list in reviews.values_mut() {
        list.sort_by(|left, right| {
            left.reviewed_at
                .cmp(&right.reviewed_at)
                .then(left.id.cmp(&right.id))
        });
    }

    let mut checked = HashMap::new();
    for (checkpoint, stem, display) in read_sidecars::<CheckpointFile>(
        project_dir,
        checked_dir(project_dir),
        "conflict checkpoint",
        MAX_CHECKPOINTS,
        MAX_CHECKPOINT_BYTES,
        diagnostics,
    ) {
        if checkpoint.schema != SIDECAR_SCHEMA || stem != checkpoint.topic_id {
            diagnostics.push(TimelineDiagnostic {
                path: display,
                error: "conflict checkpoint has an invalid schema or topic id".to_string(),
            });
            continue;
        }
        checked.insert(
            checkpoint.topic_id,
            checkpoint.checked_event_ids.into_iter().collect(),
        );
    }
    LoadedSidecars {
        proposals,
        reviews,
        checked,
    }
}

fn pair_state(
    proposal: &ProposalFile,
    reviews: &[ReviewFile],
    by_id: &HashMap<&str, &TimelineEvent>,
    components: &Components,
) -> TimelineConflictState {
    let superseded = |id: &str| by_id.get(id).is_some_and(|event| event.superseded);
    if superseded(&proposal.event_a)
        || superseded(&proposal.event_b)
        || same_chain(components, &proposal.event_a, &proposal.event_b)
    {
        return TimelineConflictState::Historical;
    }
    match reviews.last().map(|review| review.verdict) {
        None => TimelineConflictState::Unreviewed,
        Some(TimelineConflictVerdict::Confirmed) => TimelineConflictState::Confirmed,
        Some(TimelineConflictVerdict::Dismissed) => TimelineConflictState::Dismissed,
        Some(TimelineConflictVerdict::InsufficientEvidence) => {
            TimelineConflictState::InsufficientEvidence
        }
        Some(TimelineConflictVerdict::Resolved) => TimelineConflictState::Resolved,
    }
}

struct TraceContext {
    response: TimelineTraceResponse,
    components: Components,
    checked: HashMap<String, HashSet<String>>,
}

fn build_trace_context(project_dir: &Path) -> Result<TraceContext, String> {
    let mut listing = scan_project(project_dir)?;
    let (chains, components) = build_chains(&listing.events, &mut listing.diagnostics);
    let event_ids: HashSet<&str> = listing
        .events
        .iter()
        .map(|event| event.id.as_str())
        .collect();
    let mut diagnostics = Vec::new();
    let sidecars = load_sidecars(project_dir, &event_ids, &mut diagnostics);
    let by_id: HashMap<&str, &TimelineEvent> = listing
        .events
        .iter()
        .map(|event| (event.id.as_str(), event))
        .collect();
    let mut counts = TimelineConflictCounts::default();
    let mut pairs = Vec::new();
    for proposal in &sidecars.proposals {
        if in_cycle(&components, &proposal.event_a) || in_cycle(&components, &proposal.event_b) {
            continue;
        }
        let reviews = sidecars
            .reviews
            .get(&proposal.pair_id)
            .map(Vec::as_slice)
            .unwrap_or(&[]);
        let state = pair_state(proposal, reviews, &by_id, &components);
        if state.needs_review() {
            counts.needs_review += 1;
        } else if state == TimelineConflictState::Confirmed {
            counts.confirmed += 1;
        }
        pairs.push(TimelineConflictPair {
            pair_id: proposal.pair_id.clone(),
            event_a: proposal.event_a.clone(),
            event_b: proposal.event_b.clone(),
            state,
            origin: proposal.origin,
            basis: proposal.basis.clone(),
            suggested_at: proposal.suggested_at.clone(),
            model: proposal.model.clone(),
            probability: proposal.probability,
            reviews: reviews
                .iter()
                .map(|review| TimelineConflictReview {
                    id: review.id.clone(),
                    verdict: review.verdict,
                    rationale: review.rationale.clone(),
                    source_ref: review.source_ref.clone(),
                    resolution_event_id: review.resolution_event_id.clone(),
                    reviewed_by: review.reviewed_by.clone(),
                    reviewed_at: review.reviewed_at.clone(),
                })
                .collect(),
        });
    }
    listing.diagnostics.extend(diagnostics);
    Ok(TraceContext {
        response: TimelineTraceResponse {
            listing,
            chains,
            conflict_pairs: pairs,
            conflict_counts: counts,
        },
        components,
        checked: sidecars.checked,
    })
}

pub(crate) fn trace_project(project_dir: &Path) -> Result<TimelineTraceResponse, String> {
    build_trace_context(project_dir).map(|context| context.response)
}

// ─── Agent-facing read (spec 267) ────────────────────────────────────

#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct AgentConflictPair {
    pub pair_id: String,
    pub event_a: String,
    pub event_b: String,
    pub state: TimelineConflictState,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub verdict_by: Option<String>,
    pub rationale: String,
    pub updated_at: String,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct UncheckedTopic {
    pub topic_id: String,
    pub topic_title: String,
    /// Live (not superseded) events no agent has compared yet, newest first.
    pub new_event_ids: Vec<String>,
    /// Live events already compared; the new ones are checked against these.
    pub checked_event_count: usize,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct AgentConflictList {
    pub pairs: Vec<AgentConflictPair>,
    pub pairs_truncated: bool,
    pub counts: TimelineConflictCounts,
    pub unchecked: Vec<UncheckedTopic>,
    pub unchecked_topic_total: usize,
    pub diagnostics: usize,
}

fn live_events(context: &TraceContext) -> impl Iterator<Item = &TimelineEvent> {
    context
        .response
        .listing
        .events
        .iter()
        .filter(|event| !event.superseded && !in_cycle(&context.components, &event.id))
}

fn unchecked_topics(context: &TraceContext, topic_id: Option<&str>) -> Vec<UncheckedTopic> {
    // topic_id -> (title, newest occurred_at, new ids, checked count)
    let mut topics: HashMap<&str, (&str, &str, Vec<&TimelineEvent>, usize)> = HashMap::new();
    for event in live_events(context) {
        if topic_id.is_some_and(|id| id != event.topic_id) {
            continue;
        }
        let entry = topics.entry(event.topic_id.as_str()).or_insert((
            event.topic_title.as_str(),
            "",
            Vec::new(),
            0,
        ));
        // Events are chronological, so the last title seen is the current one.
        entry.0 = event.topic_title.as_str();
        let done = context
            .checked
            .get(&event.topic_id)
            .is_some_and(|ids| ids.contains(&event.id));
        if done {
            entry.3 += 1;
        } else {
            entry.1 = entry.1.max(event.occurred_at.as_str());
            entry.2.push(event);
        }
    }
    let mut out: Vec<(&str, UncheckedTopic)> = topics
        .into_iter()
        .filter(|(_, (_, _, fresh, _))| !fresh.is_empty())
        .map(|(id, (title, newest, mut fresh, checked))| {
            fresh.sort_by(|left, right| right.occurred_at.cmp(&left.occurred_at));
            (
                newest,
                UncheckedTopic {
                    topic_id: id.to_string(),
                    topic_title: title.to_string(),
                    new_event_ids: fresh.iter().map(|event| event.id.clone()).collect(),
                    checked_event_count: checked,
                },
            )
        })
        .collect();
    out.sort_by(|left, right| {
        right
            .0
            .cmp(left.0)
            .then(left.1.topic_id.cmp(&right.1.topic_id))
    });
    out.into_iter().map(|(_, topic)| topic).collect()
}

/// `timeline_conflict_list`: open (or all) pairs plus the topics whose live
/// events have not been compared yet. `topic_id` narrows both halves.
pub(crate) fn agent_list_project(
    project_dir: &Path,
    topic_id: Option<&str>,
    include_closed: bool,
) -> Result<AgentConflictList, String> {
    let topic_id = topic_id
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(crate::timeline::validate_topic_id)
        .transpose()?;
    let context = build_trace_context(project_dir)?;
    let topic_of: HashMap<&str, &str> = context
        .response
        .listing
        .events
        .iter()
        .map(|event| (event.id.as_str(), event.topic_id.as_str()))
        .collect();
    let in_topic = |id: &str| match &topic_id {
        None => true,
        Some(topic) => topic_of
            .get(id)
            .is_some_and(|value| *value == topic.as_str()),
    };
    let mut pairs: Vec<AgentConflictPair> = context
        .response
        .conflict_pairs
        .iter()
        .filter(|pair| {
            include_closed
                || pair.state.needs_review()
                || pair.state == TimelineConflictState::Confirmed
        })
        .filter(|pair| in_topic(&pair.event_a) || in_topic(&pair.event_b))
        .map(|pair| {
            let latest = pair.reviews.last();
            AgentConflictPair {
                pair_id: pair.pair_id.clone(),
                event_a: pair.event_a.clone(),
                event_b: pair.event_b.clone(),
                state: pair.state,
                verdict_by: latest.map(|review| review.reviewed_by.clone()),
                rationale: latest
                    .map(|review| review.rationale.clone())
                    .unwrap_or_else(|| pair.basis.clone()),
                updated_at: latest
                    .map(|review| review.reviewed_at.clone())
                    .unwrap_or_else(|| pair.suggested_at.clone()),
            }
        })
        .collect();
    pairs.sort_by(|left, right| right.updated_at.cmp(&left.updated_at));
    let pairs_truncated = pairs.len() > MAX_LIST_PAIRS;
    pairs.truncate(MAX_LIST_PAIRS);
    let mut unchecked = unchecked_topics(&context, topic_id.as_deref());
    let unchecked_topic_total = unchecked.len();
    unchecked.truncate(MAX_UNCHECKED_TOPICS);
    Ok(AgentConflictList {
        pairs,
        pairs_truncated,
        counts: context.response.conflict_counts,
        unchecked,
        unchecked_topic_total,
        diagnostics: context.response.listing.diagnostics.len(),
    })
}

// ─── Writes ──────────────────────────────────────────────────────────

fn find_pair(project_dir: &Path, pair_id: &str) -> Result<TimelineConflictPair, String> {
    trace_project(project_dir)?
        .conflict_pairs
        .into_iter()
        .find(|pair| pair.pair_id == pair_id)
        .ok_or_else(|| format!("timeline conflict pair is not available: {pair_id}"))
}

#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct AgentConflictRecord {
    pub pair_id: String,
    pub state: TimelineConflictState,
    pub new_pair: bool,
}

pub(crate) struct ConflictRecordRequest {
    pub event_a: String,
    pub event_b: String,
    pub verdict: TimelineConflictVerdict,
    pub rationale: String,
    pub source_ref: Option<String>,
    pub resolution_event_id: Option<String>,
}

/// `timeline_conflict_record`: create the pair's proposal when missing, then
/// append the agent's verdict. `reviewer` is the lane label from the MCP
/// transport, never a payload field.
pub(crate) fn record_conflict_project(
    project_dir: &Path,
    request: ConflictRecordRequest,
    reviewer: &str,
) -> Result<AgentConflictRecord, String> {
    let event_a =
        validate_event_id(&request.event_a).map_err(|_| "event_a is not a valid event id")?;
    let event_b =
        validate_event_id(&request.event_b).map_err(|_| "event_b is not a valid event id")?;
    if event_a == event_b {
        return Err("a conflict pair needs two different events".to_string());
    }
    let rationale = validate_rationale(&request.rationale)?;
    let source_ref =
        validate_optional_single_line("source_ref", request.source_ref, MAX_SOURCE_CHARS)?;
    let resolution_event_id = match request.resolution_event_id.map(|id| id.trim().to_string()) {
        Some(id) if !id.is_empty() => Some(
            validate_event_id(&id).map_err(|_| "resolution_event_id is not a valid event id")?,
        ),
        _ => None,
    };
    let verdict = request.verdict;
    if verdict == TimelineConflictVerdict::Resolved
        && source_ref.is_none()
        && resolution_event_id.is_none()
    {
        return Err(
            "resolved needs resolution_event_id (the event that ended the conflict) or source_ref"
                .to_string(),
        );
    }
    let (event_a, event_b, pair_id) = canonical_pair(&event_a, &event_b);
    let new_pair;
    {
        let _guard = TIMELINE_MUTATION_LOCK
            .lock()
            .map_err(|_| "timeline lock is unavailable".to_string())?;
        let context = build_trace_context(project_dir)?;
        let events = &context.response.listing.events;
        for id in [Some(&event_a), Some(&event_b), resolution_event_id.as_ref()]
            .into_iter()
            .flatten()
        {
            if !events.iter().any(|event| &event.id == id) {
                return Err(format!(
                    "timeline event does not exist in this project: {id}"
                ));
            }
        }
        if same_chain(&context.components, &event_a, &event_b) {
            return Err(
                "these events are linked by supersedes: that is change history, not a conflict"
                    .to_string(),
            );
        }
        new_pair = !context
            .response
            .conflict_pairs
            .iter()
            .any(|pair| pair.pair_id == pair_id);
        if new_pair {
            let (_, root) = writable_confined_root(
                project_dir,
                proposals_dir(project_dir),
                "conflict proposal",
            )?;
            let proposal = ProposalFile {
                schema: SIDECAR_SCHEMA,
                pair_id: pair_id.clone(),
                event_a,
                event_b,
                origin: TimelineConflictOrigin::Agent,
                suggested_at: now_millis(),
                model: None,
                probability: None,
                input_hash: None,
                basis: rationale.clone(),
            };
            write_new_json(&root.join(format!("{pair_id}.json")), &proposal)?;
        }
        let (_, root) =
            writable_confined_root(project_dir, reviews_dir(project_dir), "conflict review")?;
        let mut written = false;
        for _ in 0..10 {
            let review = ReviewFile {
                schema: SIDECAR_SCHEMA,
                id: new_sidecar_id("cr-")?,
                pair_id: pair_id.clone(),
                verdict,
                rationale: rationale.clone(),
                source_ref: source_ref.clone(),
                resolution_event_id: resolution_event_id.clone(),
                reviewed_at: now_millis(),
                reviewed_by: reviewer.to_string(),
            };
            if write_new_json(&root.join(format!("{}.json", review.id)), &review)? {
                written = true;
                break;
            }
        }
        if !written {
            return Err("failed to allocate a unique conflict review id".to_string());
        }
    }
    let pair = find_pair(project_dir, &pair_id)?;
    Ok(AgentConflictRecord {
        pair_id: pair.pair_id,
        state: pair.state,
        new_pair,
    })
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct AgentConflictChecked {
    pub topic_id: String,
    pub checked_event_count: usize,
    pub remaining_unchecked: usize,
}

/// `timeline_conflict_checked`: add the compared event IDs to the topic's
/// checkpoint. Only IDs the caller names are marked, so an event recorded
/// while the agent was reading stays unchecked for the next pass.
pub(crate) fn mark_checked_project(
    project_dir: &Path,
    topic_id: &str,
    event_ids: &[String],
    checked_by: &str,
) -> Result<AgentConflictChecked, String> {
    let topic_id = crate::timeline::validate_topic_id(topic_id)?;
    if event_ids.is_empty() {
        return Err("event_ids must name at least one compared event".to_string());
    }
    let mut marked = Vec::new();
    for id in event_ids {
        marked.push(validate_event_id(id).map_err(|_| format!("not a valid event id: {id}"))?);
    }
    let _guard = TIMELINE_MUTATION_LOCK
        .lock()
        .map_err(|_| "timeline lock is unavailable".to_string())?;
    let context = build_trace_context(project_dir)?;
    let topic_events: HashSet<&str> = context
        .response
        .listing
        .events
        .iter()
        .filter(|event| event.topic_id == topic_id)
        .map(|event| event.id.as_str())
        .collect();
    if topic_events.is_empty() {
        return Err(format!(
            "timeline topic does not exist in this project: {topic_id}"
        ));
    }
    for id in &marked {
        if !topic_events.contains(id.as_str()) {
            return Err(format!("event {id} is not in topic {topic_id}"));
        }
    }
    // Keep only IDs still in the topic (merges move events out) plus the new ones.
    let mut ids: Vec<String> = context
        .checked
        .get(&topic_id)
        .into_iter()
        .flatten()
        .filter(|id| topic_events.contains(id.as_str()))
        .cloned()
        .chain(marked)
        .collect::<HashSet<_>>()
        .into_iter()
        .collect();
    ids.sort();
    if ids.len() > MAX_CHECKPOINT_EVENTS {
        return Err(format!(
            "topic checkpoint would exceed {MAX_CHECKPOINT_EVENTS} events"
        ));
    }
    let (_, root) =
        writable_confined_root(project_dir, checked_dir(project_dir), "conflict checkpoint")?;
    let checkpoint = CheckpointFile {
        schema: SIDECAR_SCHEMA,
        topic_id: topic_id.clone(),
        checked_event_ids: ids,
        checked_by: checked_by.to_string(),
        checked_at: now_millis(),
    };
    let body = serde_json::to_vec_pretty(&checkpoint)
        .map_err(|error| format!("failed to encode conflict checkpoint: {error}"))?;
    let path = root.join(format!("{topic_id}.json"));
    let temp = root.join(format!(".{topic_id}.{}.tmp", random_hex()?));
    fs::write(&temp, &body)
        .and_then(|()| fs::rename(&temp, &path))
        .map_err(|error| {
            let _ = fs::remove_file(&temp);
            format!("failed to write conflict checkpoint: {error}")
        })?;
    let checked_event_count = checkpoint.checked_event_ids.len();
    let remaining_unchecked = live_events(&context)
        .filter(|event| event.topic_id == topic_id)
        .filter(|event| !checkpoint.checked_event_ids.contains(&event.id))
        .count();
    Ok(AgentConflictChecked {
        topic_id,
        checked_event_count,
        remaining_unchecked,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::timeline::{record_project, TimelineRecordRequest};
    use std::time::{SystemTime, UNIX_EPOCH};

    struct TestDir(PathBuf);

    impl TestDir {
        fn new(label: &str) -> Self {
            let nonce = SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap()
                .as_nanos();
            let path =
                std::env::temp_dir().join(format!("krypton-timeline-conflict-{label}-{nonce}"));
            fs::create_dir_all(&path).unwrap();
            Self(path)
        }
    }

    impl Drop for TestDir {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    fn record(
        dir: &Path,
        topic: &str,
        summary: &str,
        occurred_at: &str,
        supersedes: Option<&str>,
    ) -> TimelineEvent {
        record_project(
            dir,
            TimelineRecordRequest {
                topic_id: format!("topic-{topic}"),
                topic_title: topic.to_string(),
                summary: summary.to_string(),
                occurred_at: occurred_at.to_string(),
                made_by: "Release lead".to_string(),
                rationale: String::new(),
                impact: String::new(),
                source_ref: None,
                relation: supersedes.map(|_| TimelineRelation::Supersedes),
                related_event: supersedes.map(str::to_string),
                recorder_lane: "Claude-1".to_string(),
            },
        )
        .unwrap()
    }

    #[test]
    fn a_b_a_with_supersedes_is_one_history_chain() {
        let dir = TestDir::new("aba");
        let a = record(
            &dir.0,
            "backup",
            "remove backup connection",
            "2026-09-20T10:00:00Z",
            None,
        );
        let b = record(
            &dir.0,
            "backup",
            "keep backup connection",
            "2026-09-21T10:00:00Z",
            Some(&a.id),
        );
        let c = record(
            &dir.0,
            "backup",
            "remove backup connection again",
            "2026-09-22T10:00:00Z",
            Some(&b.id),
        );
        let trace = trace_project(&dir.0).unwrap();
        assert_eq!(trace.chains.len(), 1);
        assert_eq!(
            trace.chains[0].event_ids,
            vec![a.id.clone(), b.id.clone(), c.id.clone()]
        );
        assert_eq!(trace.chains[0].links.len(), 2);
        assert_eq!(trace.conflict_counts, TimelineConflictCounts::default());
    }

    #[test]
    fn branches_keep_every_link() {
        let dir = TestDir::new("branch");
        let a = record(&dir.0, "api", "use REST", "2026-09-20T10:00:00Z", None);
        record(
            &dir.0,
            "api",
            "use gRPC",
            "2026-09-21T10:00:00Z",
            Some(&a.id),
        );
        record(
            &dir.0,
            "api",
            "use GraphQL",
            "2026-09-21T11:00:00Z",
            Some(&a.id),
        );
        let trace = trace_project(&dir.0).unwrap();
        assert_eq!(trace.chains.len(), 1);
        assert_eq!(trace.chains[0].event_ids.len(), 3);
        assert_eq!(trace.chains[0].links.len(), 2);
    }

    #[test]
    fn cycle_is_a_diagnostic_and_not_summarised() {
        let dir = TestDir::new("cycle");
        let a = record(&dir.0, "loop", "first", "2026-09-20T10:00:00Z", None);
        let b = record(
            &dir.0,
            "loop",
            "second",
            "2026-09-21T10:00:00Z",
            Some(&a.id),
        );
        // Point `a` back at `b` by editing the file (records are append-only in
        // the app; this simulates a hand-edited or corrupted pair).
        let path = dir.0.join(&a.path);
        let source = fs::read_to_string(&path).unwrap();
        let patched = source.replacen(
            "---\n",
            &format!(
                "---\nrelation: \"supersedes\"\nrelated_event: \"{}\"\n",
                b.id
            ),
            1,
        );
        fs::write(&path, patched).unwrap();
        let trace = trace_project(&dir.0).unwrap();
        assert!(trace.chains.is_empty());
        assert!(trace
            .listing
            .diagnostics
            .iter()
            .any(|item| item.error.contains("cycle")));
    }

    fn agent_record(
        dir: &Path,
        a: &str,
        b: &str,
        verdict: TimelineConflictVerdict,
        rationale: &str,
        resolution: Option<&str>,
    ) -> Result<AgentConflictRecord, String> {
        record_conflict_project(
            dir,
            ConflictRecordRequest {
                event_a: a.to_string(),
                event_b: b.to_string(),
                verdict,
                rationale: rationale.to_string(),
                source_ref: None,
                resolution_event_id: resolution.map(str::to_string),
            },
            "Claude-1",
        )
    }

    #[test]
    fn agent_record_creates_canonical_pair_and_appends_reviews() {
        let dir = TestDir::new("record");
        let a = record(
            &dir.0,
            "backup",
            "remove backup connection",
            "2026-09-20T10:30:00Z",
            None,
        );
        let b = record(
            &dir.0,
            "backup",
            "keep backup connection",
            "2026-09-21T16:05:00Z",
            None,
        );
        let first = agent_record(
            &dir.0,
            &b.id,
            &a.id,
            TimelineConflictVerdict::Confirmed,
            "same subject, opposite call",
            None,
        )
        .unwrap();
        let (x, y) = if a.id < b.id {
            (&a.id, &b.id)
        } else {
            (&b.id, &a.id)
        };
        assert_eq!(first.pair_id, format!("{x}--{y}"));
        assert!(first.new_pair);
        assert_eq!(first.state, TimelineConflictState::Confirmed);
        let trace = trace_project(&dir.0).unwrap();
        assert_eq!(
            trace.conflict_pairs[0].origin,
            TimelineConflictOrigin::Agent
        );
        assert_eq!(trace.conflict_pairs[0].reviews[0].reviewed_by, "Claude-1");
        assert_eq!(trace.conflict_counts.confirmed, 1);

        assert!(agent_record(
            &dir.0,
            &a.id,
            &b.id,
            TimelineConflictVerdict::Resolved,
            "fixed",
            None
        )
        .unwrap_err()
        .contains("resolved needs"));
        let c = record(
            &dir.0,
            "backup",
            "release lead keeps backup connection",
            "2026-09-22T09:00:00Z",
            None,
        );
        let second = agent_record(
            &dir.0,
            &a.id,
            &b.id,
            TimelineConflictVerdict::Resolved,
            "newer decision settles it",
            Some(&c.id),
        )
        .unwrap();
        assert!(!second.new_pair);
        assert_eq!(second.state, TimelineConflictState::Resolved);
        assert_eq!(fs::read_dir(reviews_dir(&dir.0)).unwrap().count(), 2);
        assert_eq!(fs::read_dir(proposals_dir(&dir.0)).unwrap().count(), 1);

        assert!(agent_record(
            &dir.0,
            &a.id,
            &a.id,
            TimelineConflictVerdict::Confirmed,
            "self",
            None
        )
        .is_err());
        assert!(agent_record(
            &dir.0,
            &a.id,
            "tl-20260101T000000Z-aaaaaa",
            TimelineConflictVerdict::Confirmed,
            "gone",
            None
        )
        .is_err());
    }

    #[test]
    fn agent_record_rejects_supersedes_history() {
        let dir = TestDir::new("record-chain");
        let a = record(&dir.0, "api", "use REST", "2026-09-20T10:00:00Z", None);
        let b = record(
            &dir.0,
            "api",
            "use gRPC",
            "2026-09-21T10:00:00Z",
            Some(&a.id),
        );
        let error = agent_record(
            &dir.0,
            &a.id,
            &b.id,
            TimelineConflictVerdict::Confirmed,
            "opposite",
            None,
        )
        .unwrap_err();
        assert!(error.contains("change history"));
        assert!(!proposals_dir(&dir.0).exists());
    }

    #[test]
    fn later_supersedes_turns_pair_historical() {
        let dir = TestDir::new("historical");
        let a = record(
            &dir.0,
            "backup",
            "remove backup connection",
            "2026-09-20T10:30:00Z",
            None,
        );
        let b = record(
            &dir.0,
            "backup",
            "keep backup connection",
            "2026-09-21T16:05:00Z",
            None,
        );
        agent_record(
            &dir.0,
            &a.id,
            &b.id,
            TimelineConflictVerdict::Confirmed,
            "yes",
            None,
        )
        .unwrap();
        record(
            &dir.0,
            "backup",
            "keep backup connection, final",
            "2026-09-22T09:00:00Z",
            Some(&a.id),
        );
        let trace = trace_project(&dir.0).unwrap();
        let pair = &trace.conflict_pairs[0];
        assert_eq!(pair.state, TimelineConflictState::Historical);
        assert_eq!(pair.reviews.len(), 1);
        assert_eq!(trace.conflict_counts.confirmed, 0);
    }

    #[test]
    fn cross_topic_pair_survives_topic_rename() {
        let dir = TestDir::new("cross-topic");
        let a = record(
            &dir.0,
            "database",
            "remove backup connection",
            "2026-09-20T10:30:00Z",
            None,
        );
        let b = record(
            &dir.0,
            "release",
            "keep backup connection",
            "2026-09-21T16:05:00Z",
            None,
        );
        let pair = agent_record(
            &dir.0,
            &a.id,
            &b.id,
            TimelineConflictVerdict::InsufficientEvidence,
            "cross topic",
            None,
        )
        .unwrap();
        crate::timeline::merge_topics_project(&dir.0, &a.topic_id, &b.topic_id, None).unwrap();
        let trace = trace_project(&dir.0).unwrap();
        assert_eq!(trace.conflict_pairs.len(), 1);
        assert_eq!(trace.conflict_pairs[0].pair_id, pair.pair_id);
        assert_eq!(trace.conflict_counts.needs_review, 1);
    }

    #[test]
    fn checkpoints_leave_only_new_events_unchecked() {
        let dir = TestDir::new("checkpoint");
        let a = record(
            &dir.0,
            "backup",
            "remove backup",
            "2026-09-20T10:30:00Z",
            None,
        );
        let b = record(
            &dir.0,
            "backup",
            "keep backup",
            "2026-09-21T10:30:00Z",
            None,
        );
        let other = record(
            &dir.0,
            "release",
            "ship Friday",
            "2026-09-22T10:30:00Z",
            None,
        );
        let list = agent_list_project(&dir.0, None, false).unwrap();
        assert_eq!(list.unchecked.len(), 2);
        assert_eq!(list.unchecked[0].topic_id, other.topic_id);
        assert_eq!(
            list.unchecked[1].new_event_ids,
            vec![b.id.clone(), a.id.clone()]
        );

        let checked = mark_checked_project(
            &dir.0,
            &a.topic_id,
            &[a.id.clone(), b.id.clone()],
            "Claude-1",
        )
        .unwrap();
        assert_eq!(checked.remaining_unchecked, 0);
        let c = record(
            &dir.0,
            "backup",
            "backup timeout 5s",
            "2026-09-23T10:30:00Z",
            None,
        );
        let list = agent_list_project(&dir.0, Some(&a.topic_id), false).unwrap();
        assert_eq!(list.unchecked.len(), 1);
        assert_eq!(list.unchecked[0].new_event_ids, vec![c.id.clone()]);
        assert_eq!(list.unchecked[0].checked_event_count, 2);

        assert!(mark_checked_project(
            &dir.0,
            &a.topic_id,
            std::slice::from_ref(&other.id),
            "Claude-1"
        )
        .unwrap_err()
        .contains("is not in topic"));
        assert!(mark_checked_project(
            &dir.0,
            "topic-missing",
            std::slice::from_ref(&a.id),
            "Claude-1"
        )
        .is_err());

        // Merged-in events were never compared against the target topic.
        crate::timeline::merge_topics_project(&dir.0, &other.topic_id, &a.topic_id, None).unwrap();
        let list = agent_list_project(&dir.0, Some(&a.topic_id), false).unwrap();
        assert!(list.unchecked[0].new_event_ids.contains(&other.id));
    }

    #[test]
    fn malformed_and_orphan_sidecars_are_diagnostics() {
        let dir = TestDir::new("malformed");
        let a = record(
            &dir.0,
            "backup",
            "remove backup connection",
            "2026-09-20T10:30:00Z",
            None,
        );
        let root = proposals_dir(&dir.0);
        fs::create_dir_all(&root).unwrap();
        fs::write(root.join("garbage.json"), "{not json").unwrap();
        let (x, y, orphan) = canonical_pair(&a.id, "tl-20260101T000000Z-aaaaaa");
        fs::write(
            root.join(format!("{orphan}.json")),
            serde_json::to_vec(&ProposalFile {
                schema: 1,
                pair_id: orphan.clone(),
                event_a: x,
                event_b: y,
                origin: TimelineConflictOrigin::Manual,
                suggested_at: now_millis(),
                model: None,
                probability: None,
                input_hash: None,
                basis: "orphan".to_string(),
            })
            .unwrap(),
        )
        .unwrap();
        let trace = trace_project(&dir.0).unwrap();
        assert!(trace.conflict_pairs.is_empty());
        assert_eq!(trace.listing.diagnostics.len(), 2);
    }

    #[test]
    fn pair_ids_reject_non_canonical_input() {
        assert!(validate_pair_id("tl-b--tl-a").is_err());
        assert!(validate_pair_id("tl-a--tl-a").is_err());
        assert!(validate_pair_id("nope").is_err());
        assert!(validate_pair_id("tl-a--tl-b").is_ok());
    }
}
