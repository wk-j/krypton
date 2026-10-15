//! Krypton — ACP wire profiler tap (spec 288).
//!
//! `acp.rs` calls `record_out` / `record_in` / `record_ui` at the three choke
//! points every ACP message passes through. With capture `off` each call is a
//! single atomic load; otherwise the event is classified outside the lock and
//! pushed into a bounded ring under a short `std::sync::Mutex` hold — no
//! awaiting and no disk I/O on the ACP hot path. The loopback page
//! (`/acp-wire/{token}`, served by `hook_server.rs`) reads the ring.

use std::collections::{BTreeMap, HashMap, VecDeque};
use std::sync::atomic::{AtomicU8, Ordering};
use std::sync::{Arc, Mutex, MutexGuard};
use std::time::{Instant, SystemTime, UNIX_EPOCH};

use serde::{Serialize, Serializer};
use serde_json::{json, Value};

use crate::config::{AcpWireCapture, AcpWireConfig};

/// Per-event payload cap in `full` mode; longer bodies are cut and flagged.
const MAX_PAYLOAD_BYTES: usize = 1 << 20;
/// Unanswered requests remembered for correlation; oldest evicted beyond this.
const MAX_PENDING: usize = 4096;
/// Largest page `/events` returns.
pub const MAX_EVENTS_PAGE: usize = 2000;
const RING_MIN: usize = 1_000;
const RING_MAX: usize = 200_000;
const PAYLOAD_MB_MIN: usize = 8;
const PAYLOAD_MB_MAX: usize = 512;

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum WireDir {
    ToAgent,
    FromAgent,
    ToUi,
}

impl WireDir {
    fn opposite(self) -> Self {
        match self {
            WireDir::ToAgent => WireDir::FromAgent,
            WireDir::FromAgent => WireDir::ToAgent,
            WireDir::ToUi => WireDir::ToUi,
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum WireKind {
    Request,
    Response,
    Notification,
    Event,
    Invalid,
}

/// Lane identity stamped on every event; built once per `AcpClient`.
#[derive(Clone, Debug)]
pub struct WireLane {
    pub session: u64,
    pub lane: Arc<str>,
    pub backend: Arc<str>,
    pub remote: bool,
}

impl WireLane {
    pub fn new(session: u64, display_name: &str, backend: &str, remote: bool) -> Self {
        Self {
            session,
            lane: Arc::from(format!("{display_name} #{session}")),
            backend: Arc::from(backend),
            remote,
        }
    }
}

fn ser_arc_str<S: Serializer>(value: &Arc<str>, s: S) -> Result<S::Ok, S::Error> {
    s.serialize_str(value)
}

fn ser_opt_arc_str<S: Serializer>(value: &Option<Arc<str>>, s: S) -> Result<S::Ok, S::Error> {
    match value {
        Some(v) => s.serialize_str(v),
        None => s.serialize_none(),
    }
}

/// One captured message — JSON schema v1 (camelCase on the wire).
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WireEvent {
    pub seq: u64,
    pub ts_ms: u64,
    pub mono_us: u64,
    pub session: u64,
    #[serde(serialize_with = "ser_arc_str")]
    pub lane: Arc<str>,
    #[serde(serialize_with = "ser_arc_str")]
    pub backend: Arc<str>,
    pub remote: bool,
    pub dir: WireDir,
    pub kind: WireKind,
    #[serde(serialize_with = "ser_opt_arc_str")]
    pub method: Option<Arc<str>>,
    pub id: Option<String>,
    pub bytes: u64,
    pub latency_us: Option<u64>,
    /// Response → its request's seq; request → its response's seq once answered.
    pub pair_seq: Option<u64>,
    pub error: bool,
    pub truncated: bool,
    pub has_payload: bool,
    #[serde(skip)]
    pub payload: Option<Box<str>>,
}

/// `/event/{seq}` and export rows: the event plus its captured body.
#[derive(Serialize)]
pub struct WireEventWithPayload<'a> {
    #[serde(flatten)]
    pub event: &'a WireEvent,
    pub payload: Option<&'a str>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WireEventsPage {
    pub events: Vec<WireEvent>,
    pub next_seq: u64,
    pub oldest_seq: u64,
    pub gap: bool,
}

struct PendingRequest {
    seq: u64,
    mono_us: u64,
    method: Option<Arc<str>>,
}

#[derive(Default)]
struct WireInner {
    ring: VecDeque<WireEvent>,
    cap: usize,
    evicted: u64,
    payload_bytes: usize,
    payload_cap: usize,
    /// Seqs that still hold a payload, oldest first (payload-cap eviction order).
    payload_seqs: VecDeque<u64>,
    pending: HashMap<(u64, WireDir, String), PendingRequest>,
    next_seq: u64,
}

impl WireInner {
    fn index_of(&self, seq: u64) -> Option<usize> {
        let front = self.ring.front()?.seq;
        let idx = usize::try_from(seq.checked_sub(front)?).ok()?;
        (idx < self.ring.len()).then_some(idx)
    }

    fn oldest_seq(&self) -> u64 {
        self.ring.front().map_or(self.next_seq, |e| e.seq)
    }

    fn enforce_caps(&mut self) {
        while self.ring.len() > self.cap {
            if let Some(ev) = self.ring.pop_front() {
                if let Some(p) = ev.payload {
                    self.payload_bytes -= p.len();
                }
                self.evicted += 1;
            }
        }
        while self.payload_bytes > self.payload_cap {
            let Some(seq) = self.payload_seqs.pop_front() else {
                break;
            };
            if let Some(idx) = self.index_of(seq) {
                let ev = &mut self.ring[idx];
                if let Some(p) = ev.payload.take() {
                    self.payload_bytes -= p.len();
                    ev.has_payload = false;
                }
            }
        }
    }
}

pub struct AcpWire {
    mode: AtomicU8,
    token: String,
    origin: Instant,
    inner: Mutex<WireInner>,
}

fn mode_to_u8(mode: AcpWireCapture) -> u8 {
    match mode {
        AcpWireCapture::Off => 0,
        AcpWireCapture::Meta => 1,
        AcpWireCapture::Full => 2,
    }
}

fn u8_to_mode(v: u8) -> AcpWireCapture {
    match v {
        1 => AcpWireCapture::Meta,
        2 => AcpWireCapture::Full,
        _ => AcpWireCapture::Off,
    }
}

pub fn parse_mode(s: &str) -> Result<AcpWireCapture, String> {
    match s {
        "off" => Ok(AcpWireCapture::Off),
        "meta" => Ok(AcpWireCapture::Meta),
        "full" => Ok(AcpWireCapture::Full),
        other => Err(format!("unknown ACP wire capture mode: {other}")),
    }
}

pub fn mode_name(mode: AcpWireCapture) -> &'static str {
    match mode {
        AcpWireCapture::Off => "off",
        AcpWireCapture::Meta => "meta",
        AcpWireCapture::Full => "full",
    }
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

/// Cut at `MAX_PAYLOAD_BYTES` on a char boundary.
fn bounded_payload(raw: &str) -> (Box<str>, bool) {
    if raw.len() <= MAX_PAYLOAD_BYTES {
        return (raw.into(), false);
    }
    let mut end = MAX_PAYLOAD_BYTES;
    while !raw.is_char_boundary(end) {
        end -= 1;
    }
    (raw[..end].into(), true)
}

/// JSON-RPC id rendered compactly (`7`, `"abc"`), so ids of different JSON
/// types never collide in the correlation key.
fn render_id(id: &Value) -> String {
    id.to_string()
}

fn percentile(sorted: &[u64], p: f64) -> Option<u64> {
    if sorted.is_empty() {
        return None;
    }
    let idx = ((p * sorted.len() as f64) as usize).min(sorted.len() - 1);
    Some(sorted[idx])
}

impl Default for AcpWire {
    fn default() -> Self {
        Self::new()
    }
}

impl AcpWire {
    pub fn new() -> Self {
        let wire = Self {
            mode: AtomicU8::new(0),
            token: crate::termctrl_monitor::capability_token(),
            origin: Instant::now(),
            inner: Mutex::new(WireInner {
                next_seq: 1,
                ..WireInner::default()
            }),
        };
        wire.apply_config(&AcpWireConfig::default());
        wire
    }

    fn lock(&self) -> MutexGuard<'_, WireInner> {
        self.inner.lock().unwrap_or_else(|e| e.into_inner())
    }

    pub fn token(&self) -> &str {
        &self.token
    }

    pub fn url(&self, port: u16) -> Result<String, String> {
        if port == 0 {
            return Err(crate::hook_server::SERVER_UNAVAILABLE.to_string());
        }
        Ok(format!("http://127.0.0.1:{port}/acp-wire/{}", self.token))
    }

    pub fn mode(&self) -> AcpWireCapture {
        u8_to_mode(self.mode.load(Ordering::Relaxed))
    }

    pub fn set_mode(&self, mode: AcpWireCapture) {
        self.mode.store(mode_to_u8(mode), Ordering::Relaxed);
    }

    /// Apply `[acp_wire]`: mode plus clamped caps (shrinking evicts now).
    pub fn apply_config(&self, cfg: &AcpWireConfig) {
        {
            let mut inner = self.lock();
            inner.cap = cfg.ring_events.clamp(RING_MIN, RING_MAX);
            inner.payload_cap =
                cfg.full_payload_mb.clamp(PAYLOAD_MB_MIN, PAYLOAD_MB_MAX) * 1024 * 1024;
            inner.enforce_caps();
        }
        self.set_mode(cfg.capture);
    }

    #[inline]
    fn enabled(&self) -> bool {
        self.mode.load(Ordering::Relaxed) != 0
    }

    /// Outbound line written to the agent's stdin (`text` = serialized line).
    pub fn record_out(&self, lane: &WireLane, value: &Value, text: &str) {
        if self.enabled() {
            self.record(lane, WireDir::ToAgent, Some(value), text);
        }
    }

    /// Inbound stdout line; `value` is `None` when the line was not JSON.
    pub fn record_in(&self, lane: &WireLane, value: Option<&Value>, line: &str) {
        if self.enabled() {
            self.record(lane, WireDir::FromAgent, value, line);
        }
    }

    /// Rust→UI `acp-event-{session}` payload. Serializes only while capturing.
    pub fn record_ui(&self, lane: &WireLane, payload: &Value) {
        if self.enabled() {
            let text = payload.to_string();
            self.record(lane, WireDir::ToUi, Some(payload), &text);
        }
    }

    /// Drop a disposed lane's unanswered requests.
    pub fn forget_session(&self, session: u64) {
        self.lock().pending.retain(|key, _| key.0 != session);
    }

    pub fn clear(&self) {
        let mut inner = self.lock();
        inner.ring.clear();
        inner.pending.clear();
        inner.payload_seqs.clear();
        inner.payload_bytes = 0;
        inner.evicted = 0;
    }

    fn record(&self, lane: &WireLane, dir: WireDir, value: Option<&Value>, raw: &str) {
        let mode = self.mode();
        let mono_us = self.origin.elapsed().as_micros() as u64;
        let ts_ms = now_ms();
        let (kind, method, id, error) = classify(dir, value);
        let (payload, truncated) = if mode == AcpWireCapture::Full {
            let (p, t) = bounded_payload(raw.trim_end_matches(['\r', '\n']));
            (Some(p), t)
        } else {
            (None, false)
        };

        let mut inner = self.lock();
        let seq = inner.next_seq;
        inner.next_seq += 1;

        let mut event = WireEvent {
            seq,
            ts_ms,
            mono_us,
            session: lane.session,
            lane: lane.lane.clone(),
            backend: lane.backend.clone(),
            remote: lane.remote,
            dir,
            kind,
            method,
            id,
            bytes: raw.len() as u64,
            latency_us: None,
            pair_seq: None,
            error,
            truncated,
            has_payload: payload.is_some(),
            payload,
        };

        if let Some(id) = event.id.clone() {
            match kind {
                WireKind::Request => {
                    if inner.pending.len() >= MAX_PENDING {
                        let oldest = inner
                            .pending
                            .iter()
                            .min_by_key(|(_, p)| p.seq)
                            .map(|(k, _)| k.clone());
                        if let Some(k) = oldest {
                            inner.pending.remove(&k);
                        }
                    }
                    inner.pending.insert(
                        (lane.session, dir, id),
                        PendingRequest {
                            seq,
                            mono_us,
                            method: event.method.clone(),
                        },
                    );
                }
                WireKind::Response => {
                    if let Some(req) = inner.pending.remove(&(lane.session, dir.opposite(), id)) {
                        let latency = mono_us.saturating_sub(req.mono_us);
                        event.method = req.method;
                        event.latency_us = Some(latency);
                        event.pair_seq = Some(req.seq);
                        if let Some(idx) = inner.index_of(req.seq) {
                            let request = &mut inner.ring[idx];
                            request.latency_us = Some(latency);
                            request.pair_seq = Some(seq);
                            request.error = error;
                        }
                    }
                }
                _ => {}
            }
        }

        if let Some(p) = &event.payload {
            inner.payload_bytes += p.len();
            inner.payload_seqs.push_back(seq);
        }
        inner.ring.push_back(event);
        inner.enforce_caps();
    }

    /// Events with `seq >= since`, newest `limit` when more are available.
    /// `gap` marks a discontinuity for a caller that already holds events.
    pub fn events_since(&self, since: u64, limit: usize) -> WireEventsPage {
        let limit = limit.clamp(1, MAX_EVENTS_PAGE);
        let inner = self.lock();
        let next = inner.next_seq;
        let oldest = inner.oldest_seq();
        let mut start = since.max(oldest);
        let mut gap = since > 0 && since < oldest;
        if next.saturating_sub(start) > limit as u64 {
            start = next - limit as u64;
            gap |= since > 0;
        }
        let events = match inner.index_of(start) {
            Some(idx) => inner
                .ring
                .range(idx..)
                .map(|e| WireEvent {
                    payload: None,
                    ..e.clone()
                })
                .collect(),
            None => Vec::new(),
        };
        WireEventsPage {
            events,
            next_seq: next,
            oldest_seq: oldest,
            gap,
        }
    }

    /// One event with its payload, as a JSON value (`None` once evicted).
    pub fn event_json(&self, seq: u64) -> Option<Value> {
        let inner = self.lock();
        let ev = &inner.ring[inner.index_of(seq)?];
        serde_json::to_value(WireEventWithPayload {
            event: ev,
            payload: ev.payload.as_deref(),
        })
        .ok()
    }

    /// Whole ring as schema-v1 JSONL with a header line. Snapshots under the
    /// lock, serializes outside it so the hot path is not held for the export.
    pub fn export_jsonl(&self) -> String {
        let (events, evicted) = {
            let inner = self.lock();
            (
                inner.ring.iter().cloned().collect::<Vec<_>>(),
                inner.evicted,
            )
        };
        let mut out = json!({
            "v": 1,
            "kind": "header",
            "exportedAtMs": now_ms(),
            "mode": mode_name(self.mode()),
            "events": events.len(),
            "evicted": evicted,
        })
        .to_string();
        out.push('\n');
        for ev in &events {
            let row = WireEventWithPayload {
                event: ev,
                payload: ev.payload.as_deref(),
            };
            if let Ok(line) = serde_json::to_string(&row) {
                out.push_str(&line);
                out.push('\n');
            }
        }
        out
    }

    /// Aggregates for the page, computed by scanning the ring on request.
    pub fn summary(&self) -> Value {
        #[derive(Default)]
        struct Agg {
            count: u64,
            bytes: u64,
            errors: u64,
            lat: Vec<u64>,
        }
        let inner = self.lock();
        let mut dirs: [(u64, u64); 3] = [(0, 0); 3];
        let mut methods: HashMap<&str, Agg> = HashMap::new();
        let mut lanes: BTreeMap<u64, (&str, &str, bool)> = BTreeMap::new();
        for ev in &inner.ring {
            let d = match ev.dir {
                WireDir::ToAgent => 0,
                WireDir::FromAgent => 1,
                WireDir::ToUi => 2,
            };
            dirs[d].0 += 1;
            dirs[d].1 += ev.bytes;
            lanes
                .entry(ev.session)
                .or_insert((&ev.lane, &ev.backend, ev.remote));
            let name = match (&ev.method, ev.kind) {
                (Some(m), _) => m.as_ref(),
                (None, WireKind::Response) => "(unmatched response)",
                (None, _) => "(invalid)",
            };
            let agg = methods.entry(name).or_default();
            agg.count += 1;
            agg.bytes += ev.bytes;
            if ev.kind == WireKind::Response {
                if ev.error {
                    agg.errors += 1;
                }
                if let Some(l) = ev.latency_us {
                    agg.lat.push(l);
                }
            }
        }
        let mut method_rows: Vec<(&str, Agg)> = methods.into_iter().collect();
        method_rows.sort_by(|a, b| b.1.bytes.cmp(&a.1.bytes).then(a.0.cmp(b.0)));
        let method_rows: Vec<Value> = method_rows
            .into_iter()
            .map(|(name, mut agg)| {
                agg.lat.sort_unstable();
                json!({
                    "method": name,
                    "count": agg.count,
                    "bytes": agg.bytes,
                    "p50Us": percentile(&agg.lat, 0.5),
                    "p95Us": percentile(&agg.lat, 0.95),
                    "maxUs": agg.lat.last(),
                    "errors": agg.errors,
                })
            })
            .collect();
        let lane_rows: Vec<Value> = lanes
            .into_iter()
            .map(|(session, (lane, backend, remote))| {
                json!({ "session": session, "lane": lane, "backend": backend, "remote": remote })
            })
            .collect();
        let dir_json = |i: usize| json!({ "count": dirs[i].0, "bytes": dirs[i].1 });
        json!({
            "v": 1,
            "mode": mode_name(self.mode()),
            "events": inner.ring.len(),
            "evicted": inner.evicted,
            "oldestSeq": inner.oldest_seq(),
            "nextSeq": inner.next_seq,
            "nowMs": now_ms(),
            "nowMonoUs": self.origin.elapsed().as_micros() as u64,
            "payloadBytes": inner.payload_bytes,
            "payloadCapBytes": inner.payload_cap,
            "inFlight": inner.pending.len(),
            "lanes": lane_rows,
            "dirs": { "to_agent": dir_json(0), "from_agent": dir_json(1), "to_ui": dir_json(2) },
            "methods": method_rows,
        })
    }
}

/// (kind, method, id, error) for one message. Rust→UI payloads are named by
/// their `type`, plus `·kind` for `session_update`; agent `session/update`
/// notifications likewise get `·{params.update.sessionUpdate}`.
fn classify(
    dir: WireDir,
    value: Option<&Value>,
) -> (WireKind, Option<Arc<str>>, Option<String>, bool) {
    let Some(value) = value else {
        return (WireKind::Invalid, None, None, false);
    };
    if dir == WireDir::ToUi {
        let ty = value.get("type").and_then(Value::as_str).unwrap_or("?");
        let name = match value.get("kind").and_then(Value::as_str) {
            Some(kind) if ty == "session_update" => format!("{ty}·{kind}"),
            _ => ty.to_string(),
        };
        return (WireKind::Event, Some(Arc::from(name)), None, false);
    }
    let method = value.get("method").and_then(Value::as_str).map(|m| {
        match value
            .pointer("/params/update/sessionUpdate")
            .and_then(Value::as_str)
        {
            Some(update) if m == "session/update" => Arc::from(format!("{m}·{update}")),
            _ => Arc::from(m),
        }
    });
    let id = value.get("id").map(render_id);
    let error = value.get("error").is_some();
    let kind = match (&method, &id) {
        (Some(_), Some(_)) => WireKind::Request,
        (None, Some(_)) => WireKind::Response,
        (Some(_), None) => WireKind::Notification,
        (None, None) => WireKind::Invalid,
    };
    (kind, method, id, error)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn wire(mode: AcpWireCapture, ring: usize, payload_mb: usize) -> AcpWire {
        let w = AcpWire::new();
        w.apply_config(&AcpWireConfig {
            capture: mode,
            ring_events: ring,
            full_payload_mb: payload_mb,
        });
        w
    }

    fn lane(session: u64) -> WireLane {
        WireLane::new(session, "OMP", "omp", false)
    }

    fn out(w: &AcpWire, l: &WireLane, v: Value) {
        w.record_out(l, &v, &v.to_string());
    }

    fn inbound(w: &AcpWire, l: &WireLane, v: Value) {
        w.record_in(l, Some(&v), &v.to_string());
    }

    #[test]
    fn off_mode_records_nothing() {
        let w = wire(AcpWireCapture::Off, 1000, 8);
        out(
            &w,
            &lane(1),
            json!({"jsonrpc":"2.0","id":1,"method":"initialize"}),
        );
        assert!(w.events_since(0, 100).events.is_empty());
    }

    #[test]
    fn response_pairs_with_request_and_backfills_it() {
        let w = wire(AcpWireCapture::Meta, 1000, 8);
        let l = lane(1);
        out(
            &w,
            &l,
            json!({"jsonrpc":"2.0","id":7,"method":"session/prompt"}),
        );
        inbound(&w, &l, json!({"jsonrpc":"2.0","method":"session/update"}));
        inbound(&w, &l, json!({"jsonrpc":"2.0","id":7,"error":{"code":-1}}));
        let ev = w.events_since(0, 100).events;
        assert_eq!(ev.len(), 3);
        let (req, res) = (&ev[0], &ev[2]);
        assert_eq!(res.kind, WireKind::Response);
        assert_eq!(res.method.as_deref(), Some("session/prompt"));
        assert_eq!(res.pair_seq, Some(req.seq));
        assert_eq!(req.pair_seq, Some(res.seq));
        assert_eq!(req.latency_us, res.latency_us);
        assert!(req.error && res.error);
        assert_eq!(ev[1].kind, WireKind::Notification);
        assert!(!req.has_payload, "meta mode keeps no payload");
    }

    #[test]
    fn same_id_on_other_session_or_direction_does_not_pair() {
        let w = wire(AcpWireCapture::Meta, 1000, 8);
        // Agent-initiated request id 1 on session 1, Krypton request id 1 on session 2.
        inbound(&w, &lane(1), json!({"id":1,"method":"fs/read_text_file"}));
        out(&w, &lane(2), json!({"id":1,"method":"initialize"}));
        // An inbound response id 1 on session 1 answers nothing Krypton sent there.
        inbound(&w, &lane(1), json!({"id":1,"result":{}}));
        // Krypton's reply id 1 on session 1 answers the agent's request.
        out(&w, &lane(1), json!({"id":1,"result":{}}));
        let ev = w.events_since(0, 100).events;
        assert_eq!(ev[2].pair_seq, None);
        assert_eq!(ev[3].method.as_deref(), Some("fs/read_text_file"));
        assert_eq!(ev[3].pair_seq, Some(ev[0].seq));
        assert_eq!(ev[1].pair_seq, None, "session 2 request still in flight");
    }

    #[test]
    fn ring_evicts_oldest_and_reports_gap() {
        let w = wire(AcpWireCapture::Meta, 1000, 8);
        let l = lane(1);
        for _ in 0..1005 {
            inbound(&w, &l, json!({"method":"session/update"}));
        }
        let page = w.events_since(3, 10);
        assert!(page.gap);
        assert_eq!(page.oldest_seq, 6);
        assert_eq!(page.events.len(), 10);
        assert_eq!(page.events.last().unwrap().seq, 1005);
        assert_eq!(page.next_seq, 1006);
        assert!(!w.events_since(1000, 10).gap);
        assert!(w.events_since(1006, 10).events.is_empty());
    }

    #[test]
    fn full_mode_payload_cap_drops_oldest_bodies_only() {
        let w = wire(AcpWireCapture::Full, 1000, 8);
        let l = lane(1);
        let body = "x".repeat(MAX_PAYLOAD_BYTES + 10);
        for _ in 0..9 {
            w.record_in(&l, None, &body);
        }
        let ev = w.events_since(0, 100).events;
        assert_eq!(ev.len(), 9, "events survive payload eviction");
        assert!(ev
            .iter()
            .all(|e| e.truncated && e.kind == WireKind::Invalid));
        assert!(!ev[0].has_payload);
        assert!(ev[8].has_payload);
        let last = w.event_json(ev[8].seq).unwrap();
        assert_eq!(last["payload"].as_str().unwrap().len(), MAX_PAYLOAD_BYTES);
        assert!(w.event_json(ev[0].seq).unwrap()["payload"].is_null());
    }

    #[test]
    fn ui_events_are_named_by_type_and_kind() {
        let w = wire(AcpWireCapture::Meta, 1000, 8);
        w.record_ui(
            &lane(1),
            &json!({"type":"session_update","kind":"agent_message_chunk"}),
        );
        w.record_ui(&lane(1), &json!({"type":"turn_marker","kind":"prompt"}));
        let ev = w.events_since(0, 10).events;
        assert_eq!(
            ev[0].method.as_deref(),
            Some("session_update·agent_message_chunk")
        );
        assert_eq!(ev[1].method.as_deref(), Some("turn_marker"));
        assert_eq!(ev[0].dir, WireDir::ToUi);
    }

    #[test]
    fn agent_session_updates_are_named_by_update_kind() {
        let w = wire(AcpWireCapture::Meta, 1000, 8);
        let l = lane(1);
        inbound(
            &w,
            &l,
            json!({"method":"session/update","params":{"update":{"sessionUpdate":"tool_call_update"}}}),
        );
        inbound(&w, &l, json!({"method":"session/update","params":{}}));
        let ev = w.events_since(0, 10).events;
        assert_eq!(
            ev[0].method.as_deref(),
            Some("session/update·tool_call_update")
        );
        assert_eq!(ev[1].method.as_deref(), Some("session/update"));
    }
}
