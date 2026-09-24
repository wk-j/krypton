//! Shared TypeSafe System One client for optional semantic suggestions.
//!
//! Credentials and request bodies stay in Rust. Callers receive only bounded,
//! validated decisions and non-sensitive failure categories.

use std::collections::{HashMap, HashSet};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use reqwest::{Client, StatusCode};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use tauri::{AppHandle, Emitter};
use tokio::sync::oneshot;

use crate::config::TypeSafeConfig;

const MAX_REQUEST_BYTES: usize = 8 * 1024;
const MAX_RESPONSE_BYTES: usize = 64 * 1024;
const MAX_TOPIC_CHARS: usize = 120;
const MAX_SUMMARY_CHARS: usize = 500;
const MAX_RECENT_SUMMARY_CHARS: usize = 240;
const MAX_REQUEST_ID_CHARS: usize = 96;

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct TimelineTopicCandidate {
    pub topic_id: String,
    pub title: String,
    pub occurred_at: String,
    pub recent_summaries: Vec<String>,
    pub lexical_score: u16,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct TimelineTopicSemanticRequest {
    pub request_id: String,
    pub draft: TimelineTopicDraft,
    pub candidates: Vec<TimelineTopicCandidate>,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct TimelineTopicDraft {
    pub title: String,
    pub summary: String,
}

#[derive(Debug, Clone, Copy, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum TimelineTopicFallbackReason {
    CreateNew,
    LowConfidence,
    Disabled,
    Shadow,
    MissingKey,
    Cooldown,
    Cancelled,
    Timeout,
    Unavailable,
    InvalidResponse,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum TimelineTopicSemanticResult {
    Suggestion {
        #[serde(rename = "requestId")]
        request_id: String,
        #[serde(rename = "topicId")]
        topic_id: String,
        title: String,
        confidence: f64,
        probability: f64,
        model: String,
        #[serde(rename = "latencyMs")]
        latency_ms: u64,
    },
    Fallback {
        #[serde(rename = "requestId")]
        request_id: String,
        reason: TimelineTopicFallbackReason,
        #[serde(rename = "latencyMs")]
        latency_ms: u64,
    },
}

/// spec 266: one side of a pair sent for conflict screening. Only the event ID,
/// topic title, and a truncated summary ever leave the app.
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct TimelineConflictSide {
    pub id: String,
    pub topic: String,
    pub summary: String,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct TimelineConflictCandidate {
    pub pair_id: String,
    pub a: TimelineConflictSide,
    pub b: TimelineConflictSide,
}

/// Screening outcome for one pair. Only `PossibleConflict` becomes a proposal;
/// it is never a verdict.
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum TimelineConflictOutcome {
    PossibleConflict,
    CompatibleOrDuplicate,
    Unrelated,
    InsufficientEvidence,
    Inconclusive,
    InvalidResponse,
}

#[derive(Debug, Clone, PartialEq)]
pub struct TimelineConflictJudgement {
    pub pair_id: String,
    pub outcome: TimelineConflictOutcome,
    pub probability: Option<f64>,
}

/// Pairs without a judgement were not checked; `failure` says why the scan
/// stopped early.
#[derive(Debug, Clone, PartialEq)]
pub struct TimelineConflictClassification {
    pub model: String,
    pub judgements: Vec<TimelineConflictJudgement>,
    pub failure: Option<TimelineTopicFallbackReason>,
}

const CONFLICT_OPTIONS: [&str; 4] = [
    "possible_conflict",
    "compatible_or_duplicate",
    "unrelated",
    "insufficient_evidence",
];

#[derive(Default)]
struct TypeSafeHealth {
    fingerprint: String,
    consecutive_failures: u32,
    open_until: Option<Instant>,
}

#[derive(Debug, Clone, Copy, Default)]
struct TypeSafeMetrics {
    api_requests: u64,
    logical_operations: u64,
    retries: u64,
    suggestions: u64,
    fallbacks: u64,
    latency_ms_total: u64,
}

#[derive(Debug, Clone, Copy, Default, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct TypeSafeMetricsSnapshot {
    pub api_requests: u64,
    pub logical_operations: u64,
    pub retries: u64,
    pub suggestions: u64,
    pub fallbacks: u64,
    pub average_latency_ms: Option<u64>,
}

impl From<TypeSafeMetrics> for TypeSafeMetricsSnapshot {
    fn from(metrics: TypeSafeMetrics) -> Self {
        let completed = metrics.suggestions.saturating_add(metrics.fallbacks);
        Self {
            api_requests: metrics.api_requests,
            logical_operations: metrics.logical_operations,
            retries: metrics.retries,
            suggestions: metrics.suggestions,
            fallbacks: metrics.fallbacks,
            average_latency_ms: (completed > 0).then(|| metrics.latency_ms_total / completed),
        }
    }
}

pub struct TypeSafeState {
    client: Mutex<Option<(u64, Client)>>,
    pending: Mutex<HashMap<String, oneshot::Sender<()>>>,
    health: Mutex<TypeSafeHealth>,
    metrics: Mutex<TypeSafeMetrics>,
    event_app: OnceLock<AppHandle>,
}

impl Default for TypeSafeState {
    fn default() -> Self {
        Self {
            client: Mutex::new(None),
            pending: Mutex::new(HashMap::new()),
            health: Mutex::new(TypeSafeHealth::default()),
            metrics: Mutex::new(TypeSafeMetrics::default()),
            event_app: OnceLock::new(),
        }
    }
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct SystemOneResponse {
    model: String,
    answers: HashMap<String, ChoiceAnswer>,
    usage: Value,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct ChoiceAnswer {
    #[serde(rename = "type")]
    answer_type: String,
    choice: String,
    probabilities: HashMap<String, f64>,
    confidence: f64,
}

#[derive(Debug)]
struct CallFailure {
    reason: TimelineTopicFallbackReason,
    retryable: bool,
    retry_after: Option<Duration>,
}

impl TypeSafeState {
    pub fn bind_app_handle(&self, app: AppHandle) {
        let _ = self.event_app.set(app);
    }

    pub fn metrics_snapshot(&self) -> Result<TypeSafeMetricsSnapshot, String> {
        self.metrics
            .lock()
            .map(|metrics| TypeSafeMetricsSnapshot::from(*metrics))
            .map_err(|_| "TypeSafe metrics lock is unavailable".to_string())
    }

    pub fn cancel(&self, request_id: &str) -> bool {
        self.pending
            .lock()
            .ok()
            .and_then(|mut pending| pending.remove(request_id))
            .is_some_and(|sender| sender.send(()).is_ok())
    }

    pub async fn suggest_timeline_topic(
        &self,
        config: TypeSafeConfig,
        request: TimelineTopicSemanticRequest,
    ) -> Result<TimelineTopicSemanticResult, String> {
        let started = Instant::now();
        let request_id = validate_request(&config, &request)?;
        let mode = config.timeline_topics.mode.as_str();
        if !config.enabled || mode == "off" || !matches!(mode, "shadow" | "suggest") {
            return Ok(fallback(
                request_id,
                TimelineTopicFallbackReason::Disabled,
                started,
            ));
        }

        let fingerprint = format!(
            "{}\0{}\0{}",
            config.base_url, config.model, config.api_key_env
        );
        if self.in_cooldown(&fingerprint) {
            return Ok(fallback(
                request_id,
                TimelineTopicFallbackReason::Cooldown,
                started,
            ));
        }

        let key_name = config.api_key_env.clone();
        let api_key = tokio::task::spawn_blocking(move || crate::commands::get_env_var(key_name))
            .await
            .map_err(|error| format!("TypeSafe credential lookup failed: {error}"))?;
        let Some(api_key) = api_key.filter(|value| !value.trim().is_empty()) else {
            return Ok(fallback(
                request_id,
                TimelineTopicFallbackReason::MissingKey,
                started,
            ));
        };

        let body = build_request_body(&config, &request)?;
        let client = self.client(config.connect_timeout_ms.clamp(100, 5_000))?;
        let (cancel_tx, cancel_rx) = oneshot::channel();
        if let Ok(mut pending) = self.pending.lock() {
            if let Some(previous) = pending.insert(request_id.clone(), cancel_tx) {
                let _ = previous.send(());
            }
        }

        let overall = Duration::from_millis(config.overall_deadline_ms.clamp(100, 5_000));
        let call = self.call_with_retries(&client, &config, &api_key, body);
        let outcome = tokio::time::timeout(overall, async {
            tokio::select! {
                result = call => result,
                _ = cancel_rx => Err(CallFailure {
                    reason: TimelineTopicFallbackReason::Cancelled,
                    retryable: false,
                    retry_after: None,
                }),
            }
        })
        .await
        .unwrap_or({
            Err(CallFailure {
                reason: TimelineTopicFallbackReason::Timeout,
                retryable: true,
                retry_after: None,
            })
        });

        if let Ok(mut pending) = self.pending.lock() {
            pending.remove(&request_id);
        }

        let result = match outcome {
            Ok(response) => {
                self.note_success(&fingerprint);
                let gated = gate_response(&config, &request, response, started)?;
                if mode == "shadow" {
                    fallback(request_id, TimelineTopicFallbackReason::Shadow, started)
                } else {
                    gated
                }
            }
            Err(failure) => {
                if failure.retryable {
                    self.note_failure(&fingerprint, &config);
                }
                log::debug!(
                    "TypeSafe timeline topic request {} ended as {:?} after {} ms",
                    request_id,
                    failure.reason,
                    elapsed_ms(started),
                );
                fallback(request_id, failure.reason, started)
            }
        };
        self.record_metrics(&result);
        Ok(result)
    }

    /// spec 266: user-started screening of timeline pairs. Pairs are packed
    /// into System One requests of at most 8 KiB; the first failure stops the
    /// scan so the caller reports it as partial instead of "no conflicts".
    pub async fn classify_timeline_conflicts(
        &self,
        config: TypeSafeConfig,
        pairs: Vec<TimelineConflictCandidate>,
    ) -> Result<TimelineConflictClassification, String> {
        let mut result = TimelineConflictClassification {
            model: config.model.clone(),
            judgements: Vec::new(),
            failure: None,
        };
        if !config.timeline_conflict_scan_enabled() {
            result.failure = Some(TimelineTopicFallbackReason::Disabled);
            return Ok(result);
        }
        if pairs.is_empty() {
            return Ok(result);
        }
        let batches = pack_conflict_batches(&config, &pairs)?;
        let fingerprint = format!(
            "{}\0{}\0{}",
            config.base_url, config.model, config.api_key_env
        );
        if self.in_cooldown(&fingerprint) {
            result.failure = Some(TimelineTopicFallbackReason::Cooldown);
            return Ok(result);
        }
        let key_name = config.api_key_env.clone();
        let api_key = tokio::task::spawn_blocking(move || crate::commands::get_env_var(key_name))
            .await
            .map_err(|error| format!("TypeSafe credential lookup failed: {error}"))?;
        let Some(api_key) = api_key.filter(|value| !value.trim().is_empty()) else {
            result.failure = Some(TimelineTopicFallbackReason::MissingKey);
            return Ok(result);
        };

        // A scan is an explicit batch action, not an interactive keystroke
        // path, so it gets a longer budget than topic suggestions.
        let mut scan_config = config.clone();
        scan_config.attempt_timeout_ms = scan_config.attempt_timeout_ms.max(4_000);
        let overall = Duration::from_millis(config.overall_deadline_ms.clamp(10_000, 15_000));
        let client = self.client(config.connect_timeout_ms.clamp(100, 5_000))?;
        for range in batches {
            let batch = &pairs[range];
            let body = build_conflict_body(&config, batch)?;
            let outcome = tokio::time::timeout(
                overall,
                self.call_with_retries(&client, &scan_config, &api_key, body),
            )
            .await
            .unwrap_or({
                Err(CallFailure {
                    reason: TimelineTopicFallbackReason::Timeout,
                    retryable: true,
                    retry_after: None,
                })
            });
            match outcome {
                Ok(response) => {
                    self.note_success(&fingerprint);
                    result.model = response.model.clone();
                    result
                        .judgements
                        .extend(gate_conflict_response(&config, batch, &response));
                }
                Err(failure) => {
                    if failure.retryable {
                        self.note_failure(&fingerprint, &config);
                    }
                    result.failure = Some(failure.reason);
                    break;
                }
            }
        }
        Ok(result)
    }

    fn client(&self, connect_timeout_ms: u64) -> Result<Client, String> {
        let mut cached = self
            .client
            .lock()
            .map_err(|_| "TypeSafe client lock is unavailable".to_string())?;
        if let Some((timeout, client)) = cached.as_ref() {
            if *timeout == connect_timeout_ms {
                return Ok(client.clone());
            }
        }
        let client = Client::builder()
            .connect_timeout(Duration::from_millis(connect_timeout_ms))
            .build()
            .map_err(|error| format!("failed to build TypeSafe client: {error}"))?;
        *cached = Some((connect_timeout_ms, client.clone()));
        Ok(client)
    }

    async fn call_with_retries(
        &self,
        client: &Client,
        config: &TypeSafeConfig,
        api_key: &str,
        body: Value,
    ) -> Result<SystemOneResponse, CallFailure> {
        let max_retries = config.max_retries.min(2);
        for attempt in 0..=max_retries {
            self.record_attempt(attempt > 0);
            match call_once(client, config, api_key, &body).await {
                Ok(response) => return Ok(response),
                Err(failure) if failure.retryable && attempt < max_retries => {
                    let delay = failure.retry_after.unwrap_or_else(|| retry_delay(attempt));
                    tokio::time::sleep(delay).await;
                }
                Err(failure) => return Err(failure),
            }
        }
        unreachable!("retry loop always returns")
    }

    fn in_cooldown(&self, fingerprint: &str) -> bool {
        let Ok(mut health) = self.health.lock() else {
            return false;
        };
        if health.fingerprint != fingerprint {
            *health = TypeSafeHealth {
                fingerprint: fingerprint.to_string(),
                ..TypeSafeHealth::default()
            };
        }
        health
            .open_until
            .is_some_and(|until| until > Instant::now())
    }

    fn note_success(&self, fingerprint: &str) {
        if let Ok(mut health) = self.health.lock() {
            health.fingerprint = fingerprint.to_string();
            health.consecutive_failures = 0;
            health.open_until = None;
        }
    }

    fn note_failure(&self, fingerprint: &str, config: &TypeSafeConfig) {
        let Ok(mut health) = self.health.lock() else {
            return;
        };
        if health.fingerprint != fingerprint {
            health.fingerprint = fingerprint.to_string();
            health.consecutive_failures = 0;
        }
        health.consecutive_failures = health.consecutive_failures.saturating_add(1);
        let threshold = config.failure_threshold.max(1);
        if health.consecutive_failures >= threshold {
            health.open_until = Some(Instant::now() + Duration::from_secs(config.cooldown_secs));
        }
    }

    fn record_metrics(&self, result: &TimelineTopicSemanticResult) {
        self.update_metrics(|metrics| match result {
            TimelineTopicSemanticResult::Suggestion { latency_ms, .. } => {
                metrics.suggestions = metrics.suggestions.saturating_add(1);
                metrics.latency_ms_total = metrics.latency_ms_total.saturating_add(*latency_ms);
            }
            TimelineTopicSemanticResult::Fallback { latency_ms, .. } => {
                metrics.fallbacks = metrics.fallbacks.saturating_add(1);
                metrics.latency_ms_total = metrics.latency_ms_total.saturating_add(*latency_ms);
            }
        });
    }

    fn record_attempt(&self, is_retry: bool) {
        self.update_metrics(|metrics| {
            metrics.api_requests = metrics.api_requests.saturating_add(1);
            if is_retry {
                metrics.retries = metrics.retries.saturating_add(1);
            } else {
                metrics.logical_operations = metrics.logical_operations.saturating_add(1);
            }
        });
    }

    fn update_metrics(&self, update: impl FnOnce(&mut TypeSafeMetrics)) {
        let snapshot = {
            let Ok(mut metrics) = self.metrics.lock() else {
                log::warn!("TypeSafe metrics update skipped because the lock is unavailable");
                return;
            };
            update(&mut metrics);
            TypeSafeMetricsSnapshot::from(*metrics)
        };
        if let Some(app) = self.event_app.get() {
            if let Err(error) = app.emit("typesafe-metrics-changed", snapshot) {
                log::debug!("failed to emit TypeSafe metrics update: {error}");
            }
        }
    }
}

#[tauri::command]
pub fn typesafe_metrics(
    typesafe: tauri::State<'_, Arc<TypeSafeState>>,
) -> Result<TypeSafeMetricsSnapshot, String> {
    typesafe.metrics_snapshot()
}

async fn call_once(
    client: &Client,
    config: &TypeSafeConfig,
    api_key: &str,
    body: &Value,
) -> Result<SystemOneResponse, CallFailure> {
    let endpoint = format!("{}/v1/systemone", config.base_url.trim_end_matches('/'));
    let timeout = Duration::from_millis(config.attempt_timeout_ms.clamp(100, 5_000));
    let response = tokio::time::timeout(timeout, async {
        let response = client
            .post(endpoint)
            .bearer_auth(api_key)
            .json(body)
            .send()
            .await
            .map_err(|_| unavailable(true))?;
        let status = response.status();
        let retry_after = parse_retry_after(response.headers().get("retry-after"));
        if !status.is_success() {
            return Err(status_failure(status, retry_after));
        }
        let bytes = response.bytes().await.map_err(|_| unavailable(true))?;
        if bytes.len() > MAX_RESPONSE_BYTES {
            return Err(invalid_response());
        }
        serde_json::from_slice::<SystemOneResponse>(&bytes).map_err(|_| invalid_response())
    })
    .await;
    response.unwrap_or({
        Err(CallFailure {
            reason: TimelineTopicFallbackReason::Timeout,
            retryable: true,
            retry_after: None,
        })
    })
}

fn build_request_body(
    config: &TypeSafeConfig,
    request: &TimelineTopicSemanticRequest,
) -> Result<Value, String> {
    let topics: Vec<Value> = request
        .candidates
        .iter()
        .map(|candidate| {
            json!({
                "id": candidate.topic_id,
                "title": candidate.title,
                "recent_summaries": candidate.recent_summaries,
            })
        })
        .collect();
    let mut criteria = serde_json::Map::new();
    for candidate in &request.candidates {
        criteria.insert(
            candidate.topic_id.clone(),
            Value::String(format!(
                "The candidate named {} in candidate_topics",
                candidate.topic_id
            )),
        );
    }
    criteria.insert(
        "create_new".to_string(),
        Value::String("No candidate represents the same continuing project topic".to_string()),
    );
    let body = json!({
        "model": config.model,
        "state": {
            "draft": { "title": request.draft.title, "summary": request.draft.summary },
            "candidate_topics": topics,
        },
        "questions": {
            "topic": {
                "type": "choice",
                "instructions": {
                    "question": "Which existing topic has the same project meaning as the draft?",
                    "rule": "Choose create_new when none is the same subject; related is not the same."
                },
                "criteria": criteria,
            }
        }
    });
    let size = serde_json::to_vec(&body)
        .map_err(|error| format!("failed to encode TypeSafe request: {error}"))?
        .len();
    if size > MAX_REQUEST_BYTES {
        return Err("TypeSafe timeline topic request exceeds 8 KiB".to_string());
    }
    Ok(body)
}

fn gate_response(
    config: &TypeSafeConfig,
    request: &TimelineTopicSemanticRequest,
    response: SystemOneResponse,
    started: Instant,
) -> Result<TimelineTopicSemanticResult, String> {
    let Some(answer) = response.answers.get("topic") else {
        return Ok(fallback(
            request.request_id.clone(),
            TimelineTopicFallbackReason::InvalidResponse,
            started,
        ));
    };
    if answer.answer_type != "choice" {
        return Ok(fallback(
            request.request_id.clone(),
            TimelineTopicFallbackReason::InvalidResponse,
            started,
        ));
    }
    let expected: HashSet<&str> = request
        .candidates
        .iter()
        .map(|candidate| candidate.topic_id.as_str())
        .chain(std::iter::once("create_new"))
        .collect();
    let actual: HashSet<&str> = answer.probabilities.keys().map(String::as_str).collect();
    let finite = answer.confidence.is_finite()
        && (0.0..=1.0).contains(&answer.confidence)
        && answer
            .probabilities
            .values()
            .all(|value| value.is_finite() && (0.0..=1.0).contains(value));
    let sum: f64 = answer.probabilities.values().sum();
    if !finite
        || expected != actual
        || !expected.contains(answer.choice.as_str())
        || (sum - 1.0).abs() > 0.01
    {
        return Ok(fallback(
            request.request_id.clone(),
            TimelineTopicFallbackReason::InvalidResponse,
            started,
        ));
    }
    if answer.choice == "create_new" {
        return Ok(fallback(
            request.request_id.clone(),
            TimelineTopicFallbackReason::CreateNew,
            started,
        ));
    }
    let probability = answer.probabilities[&answer.choice];
    let runner_up = answer
        .probabilities
        .iter()
        .filter(|(key, _)| key.as_str() != answer.choice)
        .map(|(_, value)| *value)
        .fold(0.0_f64, f64::max);
    let settings = &config.timeline_topics;
    if answer.confidence < clamp_probability(settings.min_confidence)
        || probability < clamp_probability(settings.min_probability)
        || probability - runner_up < clamp_probability(settings.min_margin)
    {
        return Ok(fallback(
            request.request_id.clone(),
            TimelineTopicFallbackReason::LowConfidence,
            started,
        ));
    }
    let Some(candidate) = request
        .candidates
        .iter()
        .find(|candidate| candidate.topic_id == answer.choice)
    else {
        return Ok(fallback(
            request.request_id.clone(),
            TimelineTopicFallbackReason::InvalidResponse,
            started,
        ));
    };
    let _ = response.usage;
    Ok(TimelineTopicSemanticResult::Suggestion {
        request_id: request.request_id.clone(),
        topic_id: candidate.topic_id.clone(),
        title: candidate.title.clone(),
        confidence: answer.confidence,
        probability,
        model: response.model,
        latency_ms: elapsed_ms(started),
    })
}

fn conflict_question_key(index: usize) -> String {
    format!("p{index}")
}

fn build_conflict_body(
    config: &TypeSafeConfig,
    pairs: &[TimelineConflictCandidate],
) -> Result<Value, String> {
    let mut state_pairs = Vec::with_capacity(pairs.len());
    let mut questions = serde_json::Map::new();
    for (index, pair) in pairs.iter().enumerate() {
        let key = conflict_question_key(index);
        state_pairs.push(json!({
            "key": key,
            "a": { "id": pair.a.id, "topic": pair.a.topic, "summary": pair.a.summary },
            "b": { "id": pair.b.id, "topic": pair.b.topic, "summary": pair.b.summary },
        }));
        questions.insert(
            key.clone(),
            json!({
                "type": "choice",
                "instructions": {
                    "question": format!("For state.pairs entry {key}, do record a and record b give different directions for the same project subject?"),
                    "rule": "Different wording, translation, or restatement of one decision is compatible_or_duplicate. Records about different subjects are unrelated. Choose insufficient_evidence when the text is too short to tell."
                },
                "criteria": {
                    "possible_conflict": "Both records decide the same subject in incompatible directions",
                    "compatible_or_duplicate": "Both records agree, repeat, refine, or translate the same decision",
                    "unrelated": "The records are about different subjects",
                    "insufficient_evidence": "The text does not say enough to decide"
                }
            }),
        );
    }
    let body = json!({
        "model": config.model,
        "state": { "pairs": state_pairs },
        "questions": questions,
    });
    let size = serde_json::to_vec(&body)
        .map_err(|error| format!("failed to encode TypeSafe request: {error}"))?
        .len();
    if size > MAX_REQUEST_BYTES {
        return Err("TypeSafe timeline conflict request exceeds 8 KiB".to_string());
    }
    Ok(body)
}

/// Greedy, order-preserving packing so every request stays within 8 KiB.
fn pack_conflict_batches(
    config: &TypeSafeConfig,
    pairs: &[TimelineConflictCandidate],
) -> Result<Vec<std::ops::Range<usize>>, String> {
    let mut batches = Vec::new();
    let mut start = 0;
    while start < pairs.len() {
        build_conflict_body(config, &pairs[start..start + 1])?;
        let mut end = start + 1;
        while end < pairs.len() && build_conflict_body(config, &pairs[start..end + 1]).is_ok() {
            end += 1;
        }
        batches.push(start..end);
        start = end;
    }
    Ok(batches)
}

fn gate_conflict_response(
    config: &TypeSafeConfig,
    pairs: &[TimelineConflictCandidate],
    response: &SystemOneResponse,
) -> Vec<TimelineConflictJudgement> {
    pairs
        .iter()
        .enumerate()
        .map(|(index, pair)| {
            let (outcome, probability) =
                gate_conflict_answer(config, response.answers.get(&conflict_question_key(index)));
            TimelineConflictJudgement {
                pair_id: pair.pair_id.clone(),
                outcome,
                probability,
            }
        })
        .collect()
}

fn gate_conflict_answer(
    config: &TypeSafeConfig,
    answer: Option<&ChoiceAnswer>,
) -> (TimelineConflictOutcome, Option<f64>) {
    let Some(answer) = answer.filter(|answer| answer.answer_type == "choice") else {
        return (TimelineConflictOutcome::InvalidResponse, None);
    };
    let expected: HashSet<&str> = CONFLICT_OPTIONS.into_iter().collect();
    let actual: HashSet<&str> = answer.probabilities.keys().map(String::as_str).collect();
    let finite = answer.confidence.is_finite()
        && (0.0..=1.0).contains(&answer.confidence)
        && answer
            .probabilities
            .values()
            .all(|value| value.is_finite() && (0.0..=1.0).contains(value));
    let sum: f64 = answer.probabilities.values().sum();
    if !finite
        || expected != actual
        || !expected.contains(answer.choice.as_str())
        || (sum - 1.0).abs() > 0.01
    {
        return (TimelineConflictOutcome::InvalidResponse, None);
    }
    let probability = answer.probabilities[&answer.choice];
    let outcome = match answer.choice.as_str() {
        "possible_conflict" => {
            let runner_up = answer
                .probabilities
                .iter()
                .filter(|(key, _)| key.as_str() != answer.choice)
                .map(|(_, value)| *value)
                .fold(0.0_f64, f64::max);
            let settings = &config.timeline_conflicts;
            if answer.confidence >= clamp_probability(settings.min_confidence)
                && probability >= clamp_probability(settings.min_probability)
                && probability - runner_up >= clamp_probability(settings.min_margin)
            {
                TimelineConflictOutcome::PossibleConflict
            } else {
                TimelineConflictOutcome::Inconclusive
            }
        }
        "compatible_or_duplicate" => TimelineConflictOutcome::CompatibleOrDuplicate,
        "unrelated" => TimelineConflictOutcome::Unrelated,
        _ => TimelineConflictOutcome::InsufficientEvidence,
    };
    (outcome, Some(probability))
}

fn validate_request(
    config: &TypeSafeConfig,
    request: &TimelineTopicSemanticRequest,
) -> Result<String, String> {
    let request_id = request.request_id.trim();
    if request_id.is_empty()
        || request_id.chars().count() > MAX_REQUEST_ID_CHARS
        || !request_id
            .chars()
            .all(|ch| ch.is_ascii_alphanumeric() || ch == '-' || ch == '_')
    {
        return Err("invalid TypeSafe requestId".to_string());
    }
    validate_text("draft.title", &request.draft.title, MAX_TOPIC_CHARS, false)?;
    validate_text(
        "draft.summary",
        &request.draft.summary,
        MAX_SUMMARY_CHARS,
        true,
    )?;
    let max_candidates = config.timeline_topics.max_candidates.clamp(2, 20);
    if request.candidates.len() < 2 || request.candidates.len() > max_candidates {
        return Err(format!(
            "TypeSafe timeline topic candidates must contain 2..={max_candidates} entries"
        ));
    }
    let mut ids = HashSet::new();
    for candidate in &request.candidates {
        if !valid_topic_id(&candidate.topic_id) || !ids.insert(candidate.topic_id.as_str()) {
            return Err(
                "TypeSafe timeline topic candidates contain an invalid or duplicate topicId"
                    .to_string(),
            );
        }
        validate_text("candidate.title", &candidate.title, MAX_TOPIC_CHARS, false)?;
        if candidate.recent_summaries.len() > 2 {
            return Err(
                "TypeSafe timeline topic candidate has more than two summaries".to_string(),
            );
        }
        for summary in &candidate.recent_summaries {
            validate_text(
                "candidate.summary",
                summary,
                MAX_RECENT_SUMMARY_CHARS,
                false,
            )?;
        }
    }
    Ok(request_id.to_string())
}

fn validate_text(name: &str, value: &str, max_chars: usize, empty_ok: bool) -> Result<(), String> {
    let value = value.trim();
    if (!empty_ok && value.is_empty()) || value.chars().count() > max_chars || value.contains('\0')
    {
        return Err(format!("invalid TypeSafe {name}"));
    }
    Ok(())
}

fn valid_topic_id(value: &str) -> bool {
    value.starts_with("topic-")
        && value.len() <= 80
        && value
            .bytes()
            .all(|byte| byte.is_ascii_lowercase() || byte.is_ascii_digit() || byte == b'-')
}

fn clamp_probability(value: f64) -> f64 {
    if value.is_finite() {
        value.clamp(0.0, 1.0)
    } else {
        1.0
    }
}

fn fallback(
    request_id: String,
    reason: TimelineTopicFallbackReason,
    started: Instant,
) -> TimelineTopicSemanticResult {
    TimelineTopicSemanticResult::Fallback {
        request_id,
        reason,
        latency_ms: elapsed_ms(started),
    }
}

fn elapsed_ms(started: Instant) -> u64 {
    started.elapsed().as_millis().min(u128::from(u64::MAX)) as u64
}

fn unavailable(retryable: bool) -> CallFailure {
    CallFailure {
        reason: TimelineTopicFallbackReason::Unavailable,
        retryable,
        retry_after: None,
    }
}

fn status_failure(status: StatusCode, retry_after: Option<Duration>) -> CallFailure {
    let retryable = status == StatusCode::REQUEST_TIMEOUT
        || status == StatusCode::TOO_MANY_REQUESTS
        || status.as_u16() == 529
        || status.is_server_error();
    CallFailure {
        reason: TimelineTopicFallbackReason::Unavailable,
        retryable,
        retry_after,
    }
}

fn invalid_response() -> CallFailure {
    CallFailure {
        reason: TimelineTopicFallbackReason::InvalidResponse,
        retryable: false,
        retry_after: None,
    }
}

fn parse_retry_after(value: Option<&reqwest::header::HeaderValue>) -> Option<Duration> {
    let seconds = value?.to_str().ok()?.parse::<u64>().ok()?;
    Some(Duration::from_secs(seconds.min(5)))
}

fn retry_delay(attempt: u8) -> Duration {
    let base = 150_u64.saturating_mul(1_u64 << attempt.min(4));
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .subsec_nanos() as u64;
    let jitter = nanos % (base / 4 + 1);
    Duration::from_millis(base.saturating_sub(jitter))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::config::TypeSafeTimelineTopicsConfig;

    fn request() -> TimelineTopicSemanticRequest {
        TimelineTopicSemanticRequest {
            request_id: "timeline-1".to_string(),
            draft: TimelineTopicDraft {
                title: "ตรวจ metadata ก่อน upload".to_string(),
                summary: "ตรวจข้อมูลก่อนส่งเอกสาร".to_string(),
            },
            candidates: vec![
                TimelineTopicCandidate {
                    topic_id: "topic-upload-validation".to_string(),
                    title: "Upload validation".to_string(),
                    occurred_at: "2026-09-19T00:00:00Z".to_string(),
                    recent_summaries: vec!["Require metadata transfer".to_string()],
                    lexical_score: 20,
                },
                TimelineTopicCandidate {
                    topic_id: "topic-review".to_string(),
                    title: "Review workflow".to_string(),
                    occurred_at: "2026-09-18T00:00:00Z".to_string(),
                    recent_summaries: vec!["Review changes".to_string()],
                    lexical_score: 0,
                },
            ],
        }
    }

    fn response(
        choice: &str,
        confidence: f64,
        upload: f64,
        review: f64,
        new: f64,
    ) -> SystemOneResponse {
        SystemOneResponse {
            model: "jev-1.13.0".to_string(),
            answers: HashMap::from([(
                "topic".to_string(),
                ChoiceAnswer {
                    answer_type: "choice".to_string(),
                    choice: choice.to_string(),
                    probabilities: HashMap::from([
                        ("topic-upload-validation".to_string(), upload),
                        ("topic-review".to_string(), review),
                        ("create_new".to_string(), new),
                    ]),
                    confidence,
                },
            )]),
            usage: json!({"input_tokens": 10, "output_tokens": 3}),
        }
    }

    fn conflict_answer(choice: &str, confidence: f64, probs: [f64; 4]) -> ChoiceAnswer {
        ChoiceAnswer {
            answer_type: "choice".to_string(),
            choice: choice.to_string(),
            probabilities: CONFLICT_OPTIONS
                .iter()
                .zip(probs)
                .map(|(key, value)| (key.to_string(), value))
                .collect(),
            confidence,
        }
    }

    fn conflict_pair(index: usize, summary_len: usize) -> TimelineConflictCandidate {
        let side = |label: &str| TimelineConflictSide {
            id: format!("tl-20260920T103000Z-{label}{index:04}"),
            topic: "connection สำรอง".to_string(),
            summary: "ก".repeat(summary_len),
        };
        TimelineConflictCandidate {
            pair_id: format!("pair-{index}"),
            a: side("a"),
            b: side("b"),
        }
    }

    #[test]
    fn conflict_scan_is_off_by_default() {
        let mut config = TypeSafeConfig::default();
        assert_eq!(config.timeline_conflicts.mode, "off");
        assert!(!config.timeline_conflict_scan_enabled());
        config.timeline_conflicts.mode = "suggest".to_string();
        assert!(!config.timeline_conflict_scan_enabled());
        config.enabled = true;
        assert!(config.timeline_conflict_scan_enabled());
    }

    #[test]
    fn conflict_gate_proposes_only_strong_possible_conflicts() {
        let config = TypeSafeConfig::default();
        let strong = conflict_answer("possible_conflict", 0.8, [0.82, 0.08, 0.05, 0.05]);
        assert_eq!(
            gate_conflict_answer(&config, Some(&strong)),
            (TimelineConflictOutcome::PossibleConflict, Some(0.82))
        );
        let low_probability = conflict_answer("possible_conflict", 0.8, [0.6, 0.2, 0.1, 0.1]);
        assert_eq!(
            gate_conflict_answer(&config, Some(&low_probability)).0,
            TimelineConflictOutcome::Inconclusive
        );
        let low_confidence = conflict_answer("possible_conflict", 0.5, [0.8, 0.1, 0.05, 0.05]);
        assert_eq!(
            gate_conflict_answer(&config, Some(&low_confidence)).0,
            TimelineConflictOutcome::Inconclusive
        );
        let duplicate = conflict_answer("compatible_or_duplicate", 0.9, [0.1, 0.8, 0.05, 0.05]);
        assert_eq!(
            gate_conflict_answer(&config, Some(&duplicate)).0,
            TimelineConflictOutcome::CompatibleOrDuplicate
        );
        let bad_sum = conflict_answer("unrelated", 0.9, [0.5, 0.5, 0.5, 0.0]);
        assert_eq!(
            gate_conflict_answer(&config, Some(&bad_sum)).0,
            TimelineConflictOutcome::InvalidResponse
        );
        assert_eq!(
            gate_conflict_answer(&config, None).0,
            TimelineConflictOutcome::InvalidResponse
        );
    }

    #[test]
    fn conflict_batches_stay_under_8_kib_and_keep_order() {
        let config = TypeSafeConfig::default();
        let pairs: Vec<_> = (0..40).map(|index| conflict_pair(index, 240)).collect();
        let batches = pack_conflict_batches(&config, &pairs).unwrap();
        assert!(batches.len() > 1);
        let mut next = 0;
        for range in batches {
            assert_eq!(range.start, next);
            next = range.end;
            let body = build_conflict_body(&config, &pairs[range]).unwrap();
            assert!(serde_json::to_vec(&body).unwrap().len() <= MAX_REQUEST_BYTES);
            let text = body.to_string();
            assert!(!text.contains("source"));
        }
        assert_eq!(next, pairs.len());
    }

    #[test]
    fn default_config_is_opt_in_and_pinned() {
        let config = TypeSafeConfig::default();
        assert!(!config.enabled);
        assert_eq!(config.model, "jev-1.13.0");
        assert_eq!(config.timeline_topics.mode, "off");
    }

    #[test]
    fn request_body_contains_only_bounded_semantic_state() {
        let body = build_request_body(&TypeSafeConfig::default(), &request()).unwrap();
        let encoded = serde_json::to_string(&body).unwrap();
        assert!(encoded.contains("candidate_topics"));
        assert!(encoded.contains("create_new"));
        assert!(!encoded.contains("made_by"));
        assert!(!encoded.contains("evidence_excerpt"));
    }

    #[test]
    fn gate_accepts_only_a_strong_known_candidate() {
        let mut config = TypeSafeConfig::default();
        config.timeline_topics = TypeSafeTimelineTopicsConfig::default();
        let result = gate_response(
            &config,
            &request(),
            response("topic-upload-validation", 0.9, 0.8, 0.1, 0.1),
            Instant::now(),
        )
        .unwrap();
        assert!(matches!(
            result,
            TimelineTopicSemanticResult::Suggestion { ref topic_id, .. }
                if topic_id == "topic-upload-validation"
        ));
    }

    #[test]
    fn gate_falls_back_for_create_new_low_margin_and_bad_schema() {
        let config = TypeSafeConfig::default();
        let create_new = gate_response(
            &config,
            &request(),
            response("create_new", 0.9, 0.05, 0.05, 0.9),
            Instant::now(),
        )
        .unwrap();
        assert!(matches!(
            create_new,
            TimelineTopicSemanticResult::Fallback {
                reason: TimelineTopicFallbackReason::CreateNew,
                ..
            }
        ));

        let low_margin = gate_response(
            &config,
            &request(),
            response("topic-upload-validation", 0.9, 0.5, 0.4, 0.1),
            Instant::now(),
        )
        .unwrap();
        assert!(matches!(
            low_margin,
            TimelineTopicSemanticResult::Fallback {
                reason: TimelineTopicFallbackReason::LowConfidence,
                ..
            }
        ));

        let bad_sum = gate_response(
            &config,
            &request(),
            response("topic-upload-validation", 0.9, 0.8, 0.8, 0.8),
            Instant::now(),
        )
        .unwrap();
        assert!(matches!(
            bad_sum,
            TimelineTopicSemanticResult::Fallback {
                reason: TimelineTopicFallbackReason::InvalidResponse,
                ..
            }
        ));
    }

    #[test]
    fn validation_rejects_unbounded_or_duplicate_candidates() {
        let mut duplicate = request();
        duplicate.candidates[1].topic_id = duplicate.candidates[0].topic_id.clone();
        assert!(validate_request(&TypeSafeConfig::default(), &duplicate).is_err());

        let mut too_many = request();
        too_many
            .candidates
            .extend((0..20).map(|index| TimelineTopicCandidate {
                topic_id: format!("topic-{index}"),
                title: format!("Topic {index}"),
                occurred_at: "2026-09-19T00:00:00Z".to_string(),
                recent_summaries: Vec::new(),
                lexical_score: 0,
            }));
        assert!(validate_request(&TypeSafeConfig::default(), &too_many).is_err());
    }

    #[test]
    fn retry_policy_matches_only_transient_failures() {
        assert!(unavailable(true).retryable);
        assert!(!invalid_response().retryable);
        assert!(!status_failure(StatusCode::UNAUTHORIZED, None).retryable);
        assert!(!status_failure(StatusCode::UNPROCESSABLE_ENTITY, None).retryable);
        assert!(status_failure(StatusCode::TOO_MANY_REQUESTS, None).retryable);
        assert!(status_failure(StatusCode::from_u16(529).unwrap(), None).retryable);
        assert_eq!(parse_retry_after(None), None);
    }

    #[test]
    fn metrics_count_network_attempts_retries_and_completed_operations() {
        let state = TypeSafeState::default();
        state.record_attempt(false);
        state.record_attempt(true);
        state.record_metrics(&TimelineTopicSemanticResult::Suggestion {
            request_id: "timeline-1".to_string(),
            topic_id: "topic-upload-validation".to_string(),
            title: "Upload validation".to_string(),
            confidence: 0.9,
            probability: 0.8,
            model: "jev-1.13.0".to_string(),
            latency_ms: 412,
        });

        assert_eq!(
            state.metrics_snapshot().unwrap(),
            TypeSafeMetricsSnapshot {
                api_requests: 2,
                logical_operations: 1,
                retries: 1,
                suggestions: 1,
                fallbacks: 0,
                average_latency_ms: Some(412),
            }
        );
    }

    #[test]
    fn metrics_use_saturating_counters() {
        let state = TypeSafeState::default();
        {
            let mut metrics = state.metrics.lock().unwrap();
            metrics.api_requests = u64::MAX;
            metrics.logical_operations = u64::MAX;
            metrics.fallbacks = u64::MAX;
            metrics.latency_ms_total = u64::MAX;
        }

        state.record_attempt(false);
        state.record_metrics(&TimelineTopicSemanticResult::Fallback {
            request_id: "timeline-1".to_string(),
            reason: TimelineTopicFallbackReason::Timeout,
            latency_ms: 1,
        });

        let snapshot = state.metrics_snapshot().unwrap();
        assert_eq!(snapshot.api_requests, u64::MAX);
        assert_eq!(snapshot.logical_operations, u64::MAX);
        assert_eq!(snapshot.fallbacks, u64::MAX);
    }

    #[tokio::test]
    #[ignore = "requires TYPESAFE_API_KEY and live network access"]
    async fn live_system_one_accepts_the_timeline_choice_contract() {
        let mut config = TypeSafeConfig {
            enabled: true,
            connect_timeout_ms: 5_000,
            attempt_timeout_ms: 5_000,
            overall_deadline_ms: 5_000,
            max_retries: 0,
            ..TypeSafeConfig::default()
        };
        config.timeline_topics.mode = "suggest".to_string();
        let result = TypeSafeState::default()
            .suggest_timeline_topic(config, request())
            .await
            .expect("live TypeSafe request should preserve the command contract");
        assert!(matches!(
            result,
            TimelineTopicSemanticResult::Suggestion {
                ref topic_id,
                ref model,
                ..
            } if topic_id == "topic-upload-validation" && model == "jev-1.13.0"
        ));
    }
}
