//! Telegram remote controller for the running ACP harness (spec 200).
//!
//! Rust owns transport, credentials, admission, pairing, and per-chat targets.
//! Harness state and operations remain frontend-owned: every mutation travels
//! through `ControlServer::dispatch`, and output consumes the same typed stream
//! that backs the controller SSE endpoint.

mod rich;

use crate::config;
use crate::control::{
    ControlCaller, ControlReply, ControlRequest, ControlServer, ControlStreamEvent, TelegramCaller,
};
use crate::util::emit::EmitExt;
use getrandom::getrandom;
use keyring::Entry;
use rich::{render_rich_chunks, render_rich_preview, TelegramOutputChunk};
use serde::{de::DeserializeOwned, Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::{BTreeSet, HashMap};
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex, RwLock};
use std::time::{Duration, SystemTime, UNIX_EPOCH};
use tauri::{AppHandle, State};

const KEYRING_SERVICE: &str = "com.krypton.telegram";
const KEYRING_ACCOUNT: &str = "bot-token";
const TELEGRAM_API: &str = "https://api.telegram.org";
const SETTINGS_VERSION: u8 = 1;
const STATE_VERSION: u8 = 1;
const POLL_TIMEOUT_SECS: u64 = 25;
const PAIRING_TTL_SECS: u64 = 300;
const MESSAGE_LIMIT: usize = 4000;
const TELEGRAM_ACTION_TTL_SECS: u64 = 300;
const TELEGRAM_ACTION_CAP: usize = 512;
const LANE_PICKER_PAGE_SIZE: usize = 8;
static NEXT_DRAFT_ID: AtomicU64 = AtomicU64::new(1);

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(default)]
pub struct TelegramSettings {
    pub schema_version: u8,
    pub enabled: bool,
    pub rich_messages: bool,
    pub authorized_user_ids: BTreeSet<String>,
    pub authorized_group_chat_ids: BTreeSet<String>,
}

impl Default for TelegramSettings {
    fn default() -> Self {
        Self {
            schema_version: SETTINGS_VERSION,
            enabled: false,
            rich_messages: false,
            authorized_user_ids: BTreeSet::new(),
            authorized_group_chat_ids: BTreeSet::new(),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
struct TelegramRuntimeState {
    schema_version: u8,
    bot_id: Option<String>,
    last_handled_update_id: Option<i64>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TelegramBotIdentity {
    pub id: String,
    pub username: String,
    pub display_name: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TelegramHealth {
    pub state: String,
    pub detail: String,
    pub last_poll_at: Option<u64>,
    pub backoff_seconds: Option<u64>,
}

impl Default for TelegramHealth {
    fn default() -> Self {
        Self {
            state: "disabled".to_string(),
            detail: "Telegram Controller is disabled".to_string(),
            last_poll_at: None,
            backoff_seconds: None,
        }
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PairingCodeView {
    pub code: String,
    pub expires_at: u64,
}

#[derive(Debug, Clone)]
struct PairingCode {
    code: String,
    expires_at: u64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PendingPairing {
    pub request_id: String,
    pub user_id: String,
    pub display_name: String,
    pub chat_id: String,
    pub chat_kind: String,
    pub chat_title: String,
    pub expires_at: u64,
}

#[derive(Debug, Clone)]
struct TelegramTarget {
    harness_id: String,
    lane: String,
    session_id: Option<String>,
    private_chat: bool,
}

#[derive(Debug, Clone)]
struct TelegramAction {
    chat_id: String,
    expires_at: u64,
    claimed_by_update: Option<i64>,
    kind: TelegramActionKind,
}

#[derive(Debug, Clone)]
enum TelegramActionKind {
    SelectLane {
        harness_id: String,
        lane: String,
        session_id: Option<String>,
    },
    ShowLanePage {
        page: usize,
    },
}

struct LanePickerMessage {
    text: String,
    keyboard: Option<Value>,
    tokens: Vec<String>,
}

#[derive(Clone, Copy)]
struct TelegramDelivery<'a> {
    api: &'a BotApi,
    chat_id: &'a str,
    message_id: Option<i64>,
}

#[derive(Clone, Copy)]
struct LaneSelection<'a> {
    chat_kind: &'a str,
    harness_id: &'a str,
    lane_name: &'a str,
    session_id: Option<&'a str>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TelegramStatus {
    pub enabled: bool,
    pub rich_messages: bool,
    pub credential_state: String,
    pub authorized_user_ids: Vec<String>,
    pub authorized_group_chat_ids: Vec<String>,
    pub bot: Option<TelegramBotIdentity>,
    pub health: TelegramHealth,
    pub pairing: Option<PairingCodeView>,
    pub pending_pairing: Option<PendingPairing>,
}

struct TelegramInner {
    control: Arc<ControlServer>,
    app: Mutex<Option<AppHandle>>,
    settings: RwLock<TelegramSettings>,
    settings_mutation: Mutex<()>,
    health: RwLock<TelegramHealth>,
    bot: RwLock<Option<TelegramBotIdentity>>,
    targets: Mutex<HashMap<String, TelegramTarget>>,
    actions: Mutex<HashMap<String, TelegramAction>>,
    pairing: Mutex<Option<PairingCode>>,
    pending_pairing: Mutex<Option<PendingPairing>>,
    retryable_updates: Mutex<BTreeSet<i64>>,
    generation: AtomicU64,
}

#[derive(Clone)]
pub struct TelegramService {
    inner: Arc<TelegramInner>,
}

impl TelegramService {
    pub fn new(control: Arc<ControlServer>) -> Self {
        let settings = load_settings().unwrap_or_else(|error| {
            log::warn!("telegram settings: {error}; using disabled defaults");
            TelegramSettings::default()
        });
        Self {
            inner: Arc::new(TelegramInner {
                control,
                app: Mutex::new(None),
                settings: RwLock::new(settings),
                settings_mutation: Mutex::new(()),
                health: RwLock::new(TelegramHealth::default()),
                bot: RwLock::new(None),
                targets: Mutex::new(HashMap::new()),
                actions: Mutex::new(HashMap::new()),
                pairing: Mutex::new(None),
                pending_pairing: Mutex::new(None),
                retryable_updates: Mutex::new(BTreeSet::new()),
                generation: AtomicU64::new(0),
            }),
        }
    }

    pub fn attach(&self, app: AppHandle) {
        *lock(&self.inner.app) = Some(app);
        self.restart();
    }

    pub fn shutdown(&self) {
        self.inner.generation.fetch_add(1, Ordering::SeqCst);
        lock(&self.inner.targets).clear();
        lock(&self.inner.actions).clear();
        lock(&self.inner.retryable_updates).clear();
        self.set_health("stopped", "Krypton is shutting down", None);
    }

    pub fn status(&self) -> TelegramStatus {
        let settings = read(&self.inner.settings).clone();
        TelegramStatus {
            enabled: settings.enabled,
            rich_messages: settings.rich_messages,
            credential_state: credential_state(),
            authorized_user_ids: settings.authorized_user_ids.into_iter().collect(),
            authorized_group_chat_ids: settings.authorized_group_chat_ids.into_iter().collect(),
            bot: read(&self.inner.bot).clone(),
            health: read(&self.inner.health).clone(),
            pairing: lock(&self.inner.pairing)
                .as_ref()
                .filter(|pairing| pairing.expires_at > now_secs())
                .map(|pairing| PairingCodeView {
                    code: pairing.code.clone(),
                    expires_at: pairing.expires_at,
                }),
            pending_pairing: lock(&self.inner.pending_pairing)
                .as_ref()
                .filter(|pairing| pairing.expires_at > now_secs())
                .cloned(),
        }
    }

    pub fn set_enabled(&self, enabled: bool) -> Result<TelegramStatus, String> {
        self.mutate_settings(|settings| settings.enabled = enabled)?;
        self.restart();
        Ok(self.status())
    }

    pub fn set_rich_messages(&self, enabled: bool) -> Result<TelegramStatus, String> {
        self.mutate_settings(|settings| settings.rich_messages = enabled)?;
        Ok(self.status())
    }

    pub fn set_token(&self, token: String) -> Result<TelegramStatus, String> {
        let token = token.trim();
        if !valid_bot_token(token) {
            return Err("Bot token has an invalid shape".to_string());
        }
        credential_entry()?
            .set_password(token)
            .map_err(|error| format!("store Telegram credential: {error}"))?;
        self.restart();
        Ok(self.status())
    }

    pub fn remove_token(&self) -> Result<TelegramStatus, String> {
        match credential_entry()?.delete_credential() {
            Ok(()) | Err(keyring::Error::NoEntry) => {}
            Err(error) => return Err(format!("remove Telegram credential: {error}")),
        }
        self.restart();
        Ok(self.status())
    }

    pub fn add_user(&self, id: String) -> Result<TelegramStatus, String> {
        let id = canonical_id(&id, IdKind::User)?;
        self.mutate_settings(|settings| {
            settings.authorized_user_ids.insert(id);
        })?;
        Ok(self.status())
    }

    pub fn remove_user(&self, id: String) -> Result<TelegramStatus, String> {
        let id = canonical_id(&id, IdKind::User)?;
        self.mutate_settings(|settings| {
            settings.authorized_user_ids.remove(&id);
        })?;
        self.drop_unauthorized_targets();
        Ok(self.status())
    }

    pub fn add_group(&self, id: String) -> Result<TelegramStatus, String> {
        let id = canonical_id(&id, IdKind::Group)?;
        self.mutate_settings(|settings| {
            settings.authorized_group_chat_ids.insert(id);
        })?;
        Ok(self.status())
    }

    pub fn remove_group(&self, id: String) -> Result<TelegramStatus, String> {
        let id = canonical_id(&id, IdKind::Group)?;
        self.mutate_settings(|settings| {
            settings.authorized_group_chat_ids.remove(&id);
        })?;
        lock(&self.inner.targets).remove(&id);
        lock(&self.inner.actions).retain(|_, action| action.chat_id != id);
        Ok(self.status())
    }

    pub fn start_pairing(&self) -> Result<TelegramStatus, String> {
        let code = random_pair_code()?;
        *lock(&self.inner.pairing) = Some(PairingCode {
            code,
            expires_at: now_secs() + PAIRING_TTL_SECS,
        });
        *lock(&self.inner.pending_pairing) = None;
        self.emit_pairing();
        Ok(self.status())
    }

    pub fn cancel_pairing(&self) -> TelegramStatus {
        *lock(&self.inner.pairing) = None;
        *lock(&self.inner.pending_pairing) = None;
        self.emit_pairing();
        self.status()
    }

    pub fn accept_pairing(&self, request_id: String) -> Result<TelegramStatus, String> {
        let pending = lock(&self.inner.pending_pairing)
            .clone()
            .filter(|pending| pending.request_id == request_id)
            .ok_or_else(|| "Pairing request is missing or expired".to_string())?;
        if pending.expires_at <= now_secs() {
            return Err("Pairing request expired".to_string());
        }
        self.mutate_settings(|settings| {
            settings.authorized_user_ids.insert(pending.user_id.clone());
            if pending.chat_kind != "private" {
                settings
                    .authorized_group_chat_ids
                    .insert(pending.chat_id.clone());
            }
        })?;
        *lock(&self.inner.pending_pairing) = None;
        self.emit_pairing();
        Ok(self.status())
    }

    pub fn reject_pairing(&self, request_id: String) -> Result<TelegramStatus, String> {
        let mut pending = lock(&self.inner.pending_pairing);
        if pending
            .as_ref()
            .is_some_and(|pairing| pairing.request_id == request_id)
        {
            *pending = None;
            drop(pending);
            self.emit_pairing();
            Ok(self.status())
        } else {
            Err("Pairing request is missing or expired".to_string())
        }
    }

    pub fn test_connection(&self) -> Result<TelegramStatus, String> {
        let token = load_token()?.ok_or_else(|| "Telegram credential is missing".to_string())?;
        self.set_health("testing", "Testing Telegram Bot API connection", None);
        let service = self.clone();
        let app = lock(&self.inner.app).clone();
        std::thread::spawn(move || {
            let runtime = tokio::runtime::Builder::new_current_thread()
                .enable_all()
                .build();
            let result = runtime
                .map_err(|error| error.to_string())
                .and_then(|runtime| runtime.block_on(BotApi::new(token).get_me()));
            match result {
                Ok(bot) => {
                    *write(&service.inner.bot) = Some(bot);
                    service.set_health("connected", "Bot API test succeeded", None);
                }
                Err(error) => service.set_health("error", &sanitize_error(&error), None),
            }
            if let Some(app) = app {
                app.emit_or_log("telegram-status-changed", service.status());
            }
        });
        Ok(self.status())
    }

    fn mutate_settings(&self, mutate: impl FnOnce(&mut TelegramSettings)) -> Result<(), String> {
        let _mutation = lock(&self.inner.settings_mutation);
        let mut next = read(&self.inner.settings).clone();
        mutate(&mut next);
        save_settings(&next)?;
        *write(&self.inner.settings) = next;
        self.emit_status();
        Ok(())
    }

    fn drop_unauthorized_targets(&self) {
        // Private-chat bindings do not retain a sender ID, so they cannot be
        // selectively proven safe after a user is removed. Clear every target
        // and require an authorized sender to select a lane again.
        lock(&self.inner.targets).clear();
        lock(&self.inner.actions).clear();
    }

    fn restart(&self) {
        let generation = self.inner.generation.fetch_add(1, Ordering::SeqCst) + 1;
        *write(&self.inner.bot) = None;
        lock(&self.inner.targets).clear();
        lock(&self.inner.actions).clear();
        let settings = read(&self.inner.settings).clone();
        if !settings.enabled {
            self.set_health("disabled", "Telegram Controller is disabled", None);
            return;
        }
        let token = match load_token() {
            Ok(Some(token)) => token,
            Ok(None) => {
                self.set_health("credential_missing", "Telegram credential is missing", None);
                return;
            }
            Err(error) => {
                self.set_health("vault_unavailable", &sanitize_error(&error), None);
                return;
            }
        };
        let Some(app) = lock(&self.inner.app).clone() else {
            self.set_health("starting", "Waiting for application setup", None);
            return;
        };
        self.set_health("starting", "Verifying Telegram bot", None);
        let service = self.clone();
        std::thread::spawn(move || service.run_generation(app, token, generation));
    }

    fn run_generation(&self, app: AppHandle, token: String, generation: u64) {
        let runtime = match tokio::runtime::Builder::new_multi_thread()
            .worker_threads(2)
            .enable_all()
            .build()
        {
            Ok(runtime) => runtime,
            Err(error) => {
                self.set_health("error", &format!("Telegram runtime: {error}"), None);
                return;
            }
        };
        let service = self.clone();
        runtime.block_on(async move {
            let api = BotApi::new(token);
            let bot = match api.get_me().await {
                Ok(bot) => bot,
                Err(error) => {
                    service.set_health("error", &sanitize_error(&error), None);
                    return;
                }
            };
            if !service.is_generation(generation) {
                return;
            }
            if let Err(error) = api.set_commands().await {
                log::warn!("telegram command menu: {}", sanitize_error(&error));
            }
            *write(&service.inner.bot) = Some(bot.clone());
            service.prepare_runtime_state(&bot.id);
            service.set_health("connected", "Long polling active", None);
            let poll =
                service
                    .clone()
                    .poll_updates(app.clone(), api.clone(), bot.clone(), generation);
            let stream = service.clone().stream_events(api, bot, generation);
            tokio::join!(poll, stream);
        });
    }

    async fn poll_updates(
        self,
        app: AppHandle,
        api: BotApi,
        bot: TelegramBotIdentity,
        generation: u64,
    ) {
        let mut backoff = 1_u64;
        loop {
            if !self.is_generation(generation) {
                return;
            }
            let offset = load_runtime_state()
                .ok()
                .flatten()
                .and_then(|state| {
                    (state.bot_id.as_deref() == Some(bot.id.as_str()))
                        .then_some(state.last_handled_update_id)
                        .flatten()
                })
                .map(|id| id + 1);
            match api.get_updates(offset).await {
                Ok(updates) => {
                    backoff = 1;
                    self.set_health("connected", "Long polling active", None);
                    for update in updates {
                        if !self.is_generation(generation) {
                            return;
                        }
                        let update_id = update.update_id;
                        let handled = self.handle_update(&app, &api, &bot, update).await;
                        if handled {
                            let state = TelegramRuntimeState {
                                schema_version: STATE_VERSION,
                                bot_id: Some(bot.id.clone()),
                                last_handled_update_id: Some(update_id),
                            };
                            if let Err(error) = save_runtime_state(&state) {
                                log::warn!("telegram watermark: {error}");
                            }
                        } else {
                            // Preserve update order: a later update must not
                            // advance the watermark past a retryable control
                            // timeout.
                            break;
                        }
                    }
                }
                Err(error) => {
                    if let Some(retry_after) = parse_retry_after(&error) {
                        self.set_health(
                            "rate_limited",
                            "Telegram requested delivery backoff",
                            Some(retry_after),
                        );
                        tokio::time::sleep(Duration::from_secs(retry_after)).await;
                        continue;
                    }
                    let state = if error.contains("401") {
                        "invalid_token"
                    } else if error.contains("409") {
                        "another_poller_active"
                    } else {
                        "backoff"
                    };
                    self.set_health(state, &sanitize_error(&error), Some(backoff));
                    if state == "invalid_token" || state == "another_poller_active" {
                        return;
                    }
                    tokio::time::sleep(Duration::from_secs(backoff)).await;
                    backoff = (backoff * 2).min(60);
                }
            }
        }
    }

    async fn stream_events(self, api: BotApi, _bot: TelegramBotIdentity, generation: u64) {
        let mut events = self.inner.control.subscribe();
        let mut drafts: HashMap<String, DigestDraft> = HashMap::new();
        let mut tool_statuses: HashMap<String, ToolStatusDraft> = HashMap::new();
        let mut tick = tokio::time::interval(Duration::from_secs(1));
        loop {
            if !self.is_generation(generation) {
                return;
            }
            tokio::select! {
                _ = tick.tick() => {
                    let chats: BTreeSet<String> = drafts
                        .keys()
                        .chain(tool_statuses.keys())
                        .cloned()
                        .collect();
                    for chat_id in chats {
                        if !self.is_subscribed(&chat_id) {
                            drafts.remove(&chat_id);
                            tool_statuses.remove(&chat_id);
                            continue;
                        }
                        flush_conversation_surfaces(
                            &api,
                            &chat_id,
                            tool_statuses.get_mut(&chat_id),
                            drafts.get_mut(&chat_id),
                        ).await;
                    }
                }
                event = events.recv() => {
                    match event {
                        Ok(event) => self.handle_stream_event(
                            &api,
                            event,
                            &mut drafts,
                            &mut tool_statuses,
                        ).await,
                        Err(tokio::sync::broadcast::error::RecvError::Lagged(_)) => {
                            for chat_id in self.subscribed_chats() {
                                let _ = api.send_text(&chat_id, "Krypton event stream resynchronized. Use /transcript for details.").await;
                            }
                            drafts.clear();
                            tool_statuses.clear();
                        }
                        Err(tokio::sync::broadcast::error::RecvError::Closed) => return,
                    }
                }
            }
        }
    }

    async fn handle_stream_event(
        &self,
        api: &BotApi,
        event: ControlStreamEvent,
        drafts: &mut HashMap<String, DigestDraft>,
        tool_statuses: &mut HashMap<String, ToolStatusDraft>,
    ) {
        if event.kind == "thought_chunk" || event.kind == "user_message_chunk" {
            return;
        }
        let chats = self.chats_for_event(&event);
        if chats.is_empty() {
            return;
        }
        match event.kind.as_str() {
            "message_chunk" => {
                let text = event
                    .payload
                    .get("text")
                    .and_then(Value::as_str)
                    .unwrap_or_default();
                let rich_messages = read(&self.inner.settings).rich_messages;
                for chat in chats {
                    let private_chat = self.is_private_chat(&chat);
                    drafts
                        .entry(chat)
                        .or_insert_with(|| DigestDraft::new(private_chat, rich_messages))
                        .text
                        .push_str(text);
                }
            }
            "stop" | "error" => {
                for chat in chats {
                    let label = if event.kind == "stop" {
                        format!("{} · idle", event.lane.as_deref().unwrap_or("lane"))
                    } else {
                        format!("{} · error", event.lane.as_deref().unwrap_or("lane"))
                    };
                    if let Some(mut status) = tool_statuses.remove(&chat) {
                        status.finish(label);
                        let _ = status.flush(api, &chat).await;
                    } else {
                        let _ = api.send_text(&chat, &label).await;
                    }
                    if let Some(mut draft) = drafts.remove(&chat) {
                        let _ = draft.finalize(api, &chat).await;
                    }
                }
            }
            "tool_call" | "tool_call_update" => {
                let payload = event
                    .payload
                    .get("call")
                    .or_else(|| event.payload.get("update"))
                    .unwrap_or(&event.payload);
                let tool_call_id = payload
                    .get("toolCallId")
                    .and_then(Value::as_str)
                    .unwrap_or("unknown");
                let title = payload.get("title").and_then(Value::as_str);
                let kind = payload.get("kind").and_then(Value::as_str);
                let label = telegram_tool_label(title, kind, payload.get("rawInput"));
                let status = payload
                    .get("status")
                    .and_then(Value::as_str)
                    .unwrap_or("in_progress");
                for chat in chats {
                    tool_statuses.entry(chat).or_default().record(
                        event.lane.as_deref().unwrap_or("lane"),
                        tool_call_id,
                        &label,
                        status,
                    );
                }
            }
            "permission_resolved" => {
                let reason = event
                    .payload
                    .get("reason")
                    .and_then(Value::as_str)
                    .unwrap_or("resolved");
                for chat in chats {
                    let _ = api
                        .send_text(
                            &chat,
                            &format!(
                                "{} · permission {}",
                                event.lane.as_deref().unwrap_or("lane"),
                                bounded_line(reason, 80)
                            ),
                        )
                        .await;
                }
            }
            "lane_closed" | "harness_closed" | "lane_session_changed" => {
                let invalidated = self.invalidate_targets(&event);
                for chat in invalidated {
                    drafts.remove(&chat);
                    tool_statuses.remove(&chat);
                    let _ = api
                        .send_text(
                            &chat,
                            "Selected lane changed or closed. Use /use to choose again.",
                        )
                        .await;
                }
            }
            _ => {}
        }
    }

    async fn handle_update(
        &self,
        app: &AppHandle,
        api: &BotApi,
        bot: &TelegramBotIdentity,
        update: TelegramUpdate,
    ) -> bool {
        let update_id = update.update_id;
        if let Some(callback) = update.callback_query {
            self.handle_callback(app, api, update_id, callback).await;
            return !lock(&self.inner.retryable_updates).remove(&update_id);
        }
        let Some(message) = update.message else {
            return true;
        };
        let Some(sender) = message.from.as_ref() else {
            return true;
        };
        if sender.is_bot {
            return true;
        }
        let text = message.text.clone().unwrap_or_default();
        if let Some(code) = command_argument(&text, "pair", &bot.username) {
            self.handle_pair_command(api, &message, code).await;
            return true;
        }
        let settings = read(&self.inner.settings).clone();
        let user_id = sender.id.to_string();
        let chat_id = message.chat.id.to_string();
        let user_allowed = settings.authorized_user_ids.contains(&user_id);
        let group = message.chat.kind != "private";
        let chat_allowed = !group || settings.authorized_group_chat_ids.contains(&chat_id);
        if !user_allowed || !chat_allowed {
            if user_allowed && group && is_explicit_command(&text) {
                let _ = api
                    .send_text(&chat_id, "This group is not authorized in Krypton.")
                    .await;
            }
            return true;
        }
        let intentional = !group || group_intentional(&message, &bot.username, &bot.id);
        if !intentional {
            return true;
        }
        let display_name = sender.display_name();
        let caller = ControlCaller::telegram(TelegramCaller {
            update_id: update_id.to_string(),
            user_id,
            display_name,
            chat_id: chat_id.clone(),
            chat_kind: message.chat.kind.clone(),
        });
        let input = strip_group_trigger(&text, &bot.username);
        self.handle_admitted_message(app, api, &chat_id, input, caller)
            .await;
        !lock(&self.inner.retryable_updates).remove(&update_id)
    }

    async fn handle_callback(
        &self,
        app: &AppHandle,
        api: &BotApi,
        update_id: i64,
        callback: TelegramCallbackQuery,
    ) {
        if let Err(error) = api.answer_callback(&callback.id, None).await {
            log::warn!(
                "telegram callback acknowledgement: {}",
                sanitize_error(&error)
            );
        }
        if callback.from.is_bot {
            return;
        }
        let Some(message) = callback.message else {
            return;
        };
        let user_id = callback.from.id.to_string();
        let chat_id = message.chat.id.to_string();
        let settings = read(&self.inner.settings).clone();
        if !callback_authorized(&settings, &user_id, &message.chat) {
            return;
        }
        let Some(token) = callback.data.as_deref() else {
            return;
        };
        let Some(action) = self.claim_action(token, &chat_id, update_id) else {
            let _ = api
                .send_text(&chat_id, "Picker expired. Send /use again.")
                .await;
            return;
        };
        let caller = ControlCaller::telegram(TelegramCaller {
            update_id: update_id.to_string(),
            user_id,
            display_name: callback.from.display_name(),
            chat_id: chat_id.clone(),
            chat_kind: message.chat.kind.clone(),
        });
        let retryable = match action.kind {
            TelegramActionKind::ShowLanePage { page } => {
                self.load_lane_picker(
                    app,
                    TelegramDelivery {
                        api,
                        chat_id: &chat_id,
                        message_id: Some(message.message_id),
                    },
                    page,
                    caller,
                    None,
                )
                .await
            }
            TelegramActionKind::SelectLane {
                harness_id,
                lane,
                session_id,
            } => {
                self.select_lane_callback(
                    app,
                    TelegramDelivery {
                        api,
                        chat_id: &chat_id,
                        message_id: Some(message.message_id),
                    },
                    LaneSelection {
                        chat_kind: &message.chat.kind,
                        harness_id: &harness_id,
                        lane_name: &lane,
                        session_id: session_id.as_deref(),
                    },
                    caller,
                )
                .await
            }
        };
        if !retryable {
            self.finish_action(token, update_id);
        }
    }

    async fn handle_admitted_message(
        &self,
        app: &AppHandle,
        api: &BotApi,
        chat_id: &str,
        input: String,
        caller: ControlCaller,
    ) {
        let trimmed = input.trim();
        let (command, rest) = split_command(trimmed);
        match command.as_deref() {
            Some("start" | "help") => {
                let _ = api.send_text(chat_id, HELP).await;
            }
            Some("harnesses") => {
                self.dispatch_and_report(app, api, chat_id, "harness.list", json!({}), caller)
                    .await;
            }
            Some("lanes") => {
                self.report_lanes(app, api, chat_id, caller).await;
            }
            Some("use") => {
                self.select_lane(app, api, chat_id, rest, caller).await;
            }
            Some("status") => {
                self.report_status(app, api, chat_id, caller).await;
            }
            Some("ask") => {
                self.send_prompt(app, api, chat_id, rest, caller).await;
            }
            Some("cancel") => {
                self.target_operation(app, api, chat_id, "lane.cancel", json!({}), caller)
                    .await;
            }
            Some("restart") => {
                self.target_operation(app, api, chat_id, "lane.restart", json!({}), caller)
                    .await;
            }
            Some("new") => {
                self.target_operation(
                    app,
                    api,
                    chat_id,
                    "lane.new",
                    json!({"clearMemory": rest.contains("--clear-memory")}),
                    caller,
                )
                .await;
            }
            Some("close") => {
                self.target_operation(app, api, chat_id, "lane.close", json!({}), caller)
                    .await;
            }
            Some("transcript") => {
                self.target_operation(app, api, chat_id, "lane.transcript", json!({}), caller)
                    .await;
            }
            Some("mode") => {
                self.target_operation(
                    app,
                    api,
                    chat_id,
                    "lane.permission_mode",
                    json!({"mode": rest}),
                    caller,
                )
                .await;
            }
            Some("ctl") => {
                self.handle_ctl(app, api, chat_id, rest, caller).await;
            }
            Some(other) => {
                let _ = api
                    .send_text(chat_id, &format!("Unknown command /{other}. Use /help."))
                    .await;
            }
            None if !trimmed.is_empty() => {
                self.send_prompt(app, api, chat_id, trimmed, caller).await;
            }
            None => {}
        }
    }

    async fn report_lanes(
        &self,
        app: &AppHandle,
        api: &BotApi,
        chat_id: &str,
        caller: ControlCaller,
    ) {
        self.load_lane_picker(
            app,
            TelegramDelivery {
                api,
                chat_id,
                message_id: None,
            },
            0,
            caller,
            None,
        )
        .await;
    }

    async fn load_lane_picker(
        &self,
        app: &AppHandle,
        delivery: TelegramDelivery<'_>,
        page: usize,
        caller: ControlCaller,
        notice: Option<&str>,
    ) -> bool {
        let reply = self.dispatch(app, "lane.list", json!({}), caller).await;
        if reply.error.as_ref().is_some_and(|error| error.retryable) {
            return true;
        }
        let Some(lanes) = reply.result.as_ref().and_then(Value::as_array) else {
            let text = reply
                .error
                .as_ref()
                .map(|error| format!("{}: {}", error.code, bounded_line(&error.message, 320)))
                .unwrap_or_else(|| "lane.list returned no result".to_string());
            self.deliver_plain_control_message(
                delivery.api,
                delivery.chat_id,
                delivery.message_id,
                &text,
            )
            .await;
            return false;
        };
        match self.build_lane_picker(delivery.chat_id, lanes, page, notice) {
            Ok(picker) => {
                self.deliver_lane_picker(
                    delivery.api,
                    delivery.chat_id,
                    delivery.message_id,
                    picker,
                )
                .await
            }
            Err(error) => {
                self.deliver_plain_control_message(
                    delivery.api,
                    delivery.chat_id,
                    delivery.message_id,
                    &sanitize_error(&error),
                )
                .await;
            }
        }
        false
    }

    fn build_lane_picker(
        &self,
        chat_id: &str,
        lanes: &[Value],
        requested_page: usize,
        notice: Option<&str>,
    ) -> Result<LanePickerMessage, String> {
        let selectable = lanes
            .iter()
            .filter(|lane| {
                lane.get("harnessId").and_then(Value::as_str).is_some()
                    && lane.get("displayName").and_then(Value::as_str).is_some()
            })
            .collect::<Vec<_>>();
        if selectable.is_empty() {
            return Ok(LanePickerMessage {
                text: notice
                    .map(|notice| format!("{notice}\n\nNo live lanes."))
                    .unwrap_or_else(|| "No live lanes.".to_string()),
                keyboard: None,
                tokens: Vec::new(),
            });
        }

        let total_pages = selectable.len().div_ceil(LANE_PICKER_PAGE_SIZE);
        let page = requested_page.min(total_pages - 1);
        let start = page * LANE_PICKER_PAGE_SIZE;
        let end = (start + LANE_PICKER_PAGE_SIZE).min(selectable.len());
        let visible = &selectable[start..end];
        let target = lock(&self.inner.targets).get(chat_id).cloned();
        let current = target.as_ref().and_then(|target| {
            selectable
                .iter()
                .find(|lane| lane_matches_target(lane, target))
                .and_then(|lane| lane.get("displayName"))
                .and_then(Value::as_str)
        });

        let mut lines = Vec::new();
        if let Some(notice) = notice {
            lines.push(notice.to_string());
            lines.push(String::new());
        }
        lines.push(if total_pages > 1 {
            format!("Choose a target lane · {}/{}", page + 1, total_pages)
        } else {
            "Choose a target lane".to_string()
        });
        lines.push(format!("Current: {}", current.unwrap_or("none")));
        lines.push(String::new());
        for lane in visible {
            let cwd = lane.get("cwd").and_then(Value::as_str);
            lines.push(format!(
                "{} · {} · {}",
                lane.get("displayName")
                    .and_then(Value::as_str)
                    .unwrap_or("?"),
                lane.get("status").and_then(Value::as_str).unwrap_or("?"),
                lane.get("modelName")
                    .and_then(Value::as_str)
                    .unwrap_or("default")
            ));
            if let Some(cwd) = cwd {
                lines.push(format!("  {cwd}"));
            }
        }
        lines.push(String::new());
        lines.push("Tap a lane, or type /use <lane>.".to_string());

        let mut rows = Vec::<Vec<Value>>::new();
        let mut tokens = Vec::new();
        for lane in visible {
            let harness_id = lane
                .get("harnessId")
                .and_then(Value::as_str)
                .expect("filtered harnessId");
            let lane_name = lane
                .get("displayName")
                .and_then(Value::as_str)
                .expect("filtered displayName");
            let session_id = lane
                .get("sessionId")
                .and_then(Value::as_str)
                .map(ToString::to_string);
            let token = self.issue_picker_action(
                chat_id,
                TelegramActionKind::SelectLane {
                    harness_id: harness_id.to_string(),
                    lane: lane_name.to_string(),
                    session_id,
                },
                &mut tokens,
            )?;
            let selected = target
                .as_ref()
                .is_some_and(|target| lane_matches_target(lane, target));
            let cwd = lane.get("cwd").and_then(Value::as_str);
            let label = match cwd {
                Some(cwd) => format!("{lane_name} · {cwd}"),
                None => lane_name.to_string(),
            };
            rows.push(vec![json!({
                "text": if selected {
                    format!("✓ {label}")
                } else {
                    label
                },
                "callback_data": token,
            })]);
        }
        if total_pages > 1 {
            let mut navigation = Vec::new();
            if page > 0 {
                let token = self.issue_picker_action(
                    chat_id,
                    TelegramActionKind::ShowLanePage { page: page - 1 },
                    &mut tokens,
                )?;
                navigation.push(json!({"text": "‹ Previous", "callback_data": token}));
            }
            let refresh = self.issue_picker_action(
                chat_id,
                TelegramActionKind::ShowLanePage { page },
                &mut tokens,
            )?;
            navigation
                .push(json!({"text": format!("↻ {}/{}", page + 1, total_pages), "callback_data": refresh}));
            if page + 1 < total_pages {
                let token = self.issue_picker_action(
                    chat_id,
                    TelegramActionKind::ShowLanePage { page: page + 1 },
                    &mut tokens,
                )?;
                navigation.push(json!({"text": "Next ›", "callback_data": token}));
            }
            rows.push(navigation);
        }

        Ok(LanePickerMessage {
            text: lines.join("\n"),
            keyboard: Some(json!({"inline_keyboard": rows})),
            tokens,
        })
    }

    async fn deliver_lane_picker(
        &self,
        api: &BotApi,
        chat_id: &str,
        message_id: Option<i64>,
        picker: LanePickerMessage,
    ) {
        let LanePickerMessage {
            text,
            keyboard,
            tokens,
        } = picker;
        let Some(keyboard) = keyboard else {
            self.deliver_plain_control_message(api, chat_id, message_id, &text)
                .await;
            return;
        };
        let delivered = match message_id {
            Some(message_id) => api
                .edit_keyboard(chat_id, message_id, &text, Some(keyboard.clone()))
                .await
                .is_ok(),
            None => api
                .send_keyboard(chat_id, &text, keyboard.clone())
                .await
                .is_ok(),
        };
        if delivered {
            return;
        }
        if message_id.is_some() && api.send_keyboard(chat_id, &text, keyboard).await.is_ok() {
            return;
        }
        self.remove_actions(&tokens);
        let _ = api
            .send_text(chat_id, &format!("{text}\n\nType /use <lane> to select."))
            .await;
    }

    async fn deliver_plain_control_message(
        &self,
        api: &BotApi,
        chat_id: &str,
        message_id: Option<i64>,
        text: &str,
    ) {
        if let Some(message_id) = message_id {
            if api
                .edit_keyboard(chat_id, message_id, text, None)
                .await
                .is_ok()
            {
                return;
            }
        }
        let _ = api.send_text(chat_id, text).await;
    }

    async fn select_lane_callback(
        &self,
        app: &AppHandle,
        delivery: TelegramDelivery<'_>,
        selection: LaneSelection<'_>,
        caller: ControlCaller,
    ) -> bool {
        let reply = self.dispatch(app, "lane.list", json!({}), caller).await;
        if reply.error.as_ref().is_some_and(|error| error.retryable) {
            return true;
        }
        let Some(lanes) = reply.result.as_ref().and_then(Value::as_array) else {
            let text = reply
                .error
                .as_ref()
                .map(|error| format!("{}: {}", error.code, bounded_line(&error.message, 320)))
                .unwrap_or_else(|| "lane.list returned no result".to_string());
            self.deliver_plain_control_message(
                delivery.api,
                delivery.chat_id,
                delivery.message_id,
                &text,
            )
            .await;
            return false;
        };
        let lane = lanes.iter().find(|lane| {
            lane_snapshot_matches(
                lane,
                selection.harness_id,
                selection.lane_name,
                selection.session_id,
            )
        });
        if let Some(lane) = lane {
            let target = TelegramTarget {
                harness_id: selection.harness_id.to_string(),
                lane: selection.lane_name.to_string(),
                session_id: selection.session_id.map(ToString::to_string),
                private_chat: selection.chat_kind == "private",
            };
            lock(&self.inner.targets).insert(delivery.chat_id.to_string(), target);
            let confirmation = format!(
                "Target selected: {}\nState: {}\nTelegram turns: BYPASS ALL",
                selection.lane_name,
                lane.get("status").and_then(Value::as_str).unwrap_or("?")
            );
            self.deliver_plain_control_message(
                delivery.api,
                delivery.chat_id,
                delivery.message_id,
                &confirmation,
            )
            .await;
            return false;
        }
        match self.build_lane_picker(
            delivery.chat_id,
            lanes,
            0,
            Some("That lane changed. Choose a current target."),
        ) {
            Ok(picker) => {
                self.deliver_lane_picker(
                    delivery.api,
                    delivery.chat_id,
                    delivery.message_id,
                    picker,
                )
                .await;
            }
            Err(error) => {
                self.deliver_plain_control_message(
                    delivery.api,
                    delivery.chat_id,
                    delivery.message_id,
                    &sanitize_error(&error),
                )
                .await;
            }
        }
        false
    }

    async fn select_lane(
        &self,
        app: &AppHandle,
        api: &BotApi,
        chat_id: &str,
        lane_name: &str,
        caller: ControlCaller,
    ) {
        if lane_name.trim().is_empty() {
            self.report_lanes(app, api, chat_id, caller).await;
            return;
        }
        let private_chat = caller
            .telegram
            .as_ref()
            .is_some_and(|telegram| telegram.chat_kind == "private");
        let reply = self.dispatch(app, "lane.list", json!({}), caller).await;
        let lane = reply
            .result
            .as_ref()
            .and_then(Value::as_array)
            .and_then(|lanes| {
                lanes.iter().find(|lane| {
                    lane.get("displayName").and_then(Value::as_str) == Some(lane_name.trim())
                })
            });
        let Some(lane) = lane else {
            self.send_reply_error_or(api, chat_id, reply, "Unknown lane. Use /lanes.")
                .await;
            return;
        };
        let target = TelegramTarget {
            harness_id: lane
                .get("harnessId")
                .and_then(Value::as_str)
                .unwrap_or_default()
                .to_string(),
            lane: lane_name.trim().to_string(),
            session_id: lane
                .get("sessionId")
                .and_then(Value::as_str)
                .map(ToString::to_string),
            private_chat,
        };
        lock(&self.inner.targets).insert(chat_id.to_string(), target);
        let _ = api
            .send_text(
                chat_id,
                &format!(
                    "Target selected: {}\nState: {}\nTelegram turns: BYPASS ALL",
                    lane_name.trim(),
                    lane.get("status").and_then(Value::as_str).unwrap_or("?")
                ),
            )
            .await;
    }

    async fn report_status(
        &self,
        app: &AppHandle,
        api: &BotApi,
        chat_id: &str,
        caller: ControlCaller,
    ) {
        let target = lock(&self.inner.targets).get(chat_id).cloned();
        let Some(target) = target else {
            let _ = api
                .send_text(
                    chat_id,
                    "Krypton connected\nTarget: none\nUse /use to choose a lane",
                )
                .await;
            return;
        };
        let reply = self.dispatch(app, "lane.list", json!({}), caller).await;
        let lane = reply
            .result
            .as_ref()
            .and_then(Value::as_array)
            .and_then(|lanes| {
                lanes.iter().find(|lane| {
                    lane.get("displayName").and_then(Value::as_str) == Some(target.lane.as_str())
                })
            });
        if let Some(lane) = lane {
            let _ = api
                .send_text(
                    chat_id,
                    &format!(
                        "Krypton · connected\nTarget: {}\nSession: {}\nState: {} · queue {}\nMode: {}\nTELEGRAM TURN: BYPASS ALL",
                        target.lane,
                        target.session_id.as_deref().unwrap_or("pending"),
                        lane.get("status").and_then(Value::as_str).unwrap_or("?"),
                        lane.get("queueDepth").and_then(Value::as_u64).unwrap_or(0),
                        lane.get("permissionMode").and_then(Value::as_str).unwrap_or("normal"),
                    ),
                )
                .await;
        } else {
            lock(&self.inner.targets).remove(chat_id);
            let _ = api
                .send_text(
                    chat_id,
                    "Selected lane is no longer available. Use /use again.",
                )
                .await;
        }
    }

    async fn send_prompt(
        &self,
        app: &AppHandle,
        api: &BotApi,
        chat_id: &str,
        text: &str,
        caller: ControlCaller,
    ) {
        if text.trim().is_empty() {
            let _ = api.send_text(chat_id, "Prompt text is empty.").await;
            return;
        }
        self.target_operation(
            app,
            api,
            chat_id,
            "lane.send",
            json!({"text": text.trim()}),
            caller,
        )
        .await;
    }

    async fn target_operation(
        &self,
        app: &AppHandle,
        api: &BotApi,
        chat_id: &str,
        operation: &str,
        mut params: Value,
        caller: ControlCaller,
    ) {
        let Some(target) = lock(&self.inner.targets).get(chat_id).cloned() else {
            let _ = api
                .send_text(chat_id, "No target lane. Use /use to choose one.")
                .await;
            return;
        };
        if let Some(object) = params.as_object_mut() {
            object.insert("lane".to_string(), Value::String(target.lane));
        }
        let reply = self.dispatch(app, operation, params, caller).await;
        self.send_control_reply(api, chat_id, reply).await;
    }

    async fn handle_ctl(
        &self,
        app: &AppHandle,
        api: &BotApi,
        chat_id: &str,
        rest: &str,
        caller: ControlCaller,
    ) {
        let mut parts = rest.trim().splitn(2, char::is_whitespace);
        let operation = parts.next().unwrap_or_default();
        if !advertised_operation(operation) {
            let _ = api
                .send_text(chat_id, "Unsupported controller operation.")
                .await;
            return;
        }
        let mut params: Value = match parts.next() {
            Some(raw) if !raw.trim().is_empty() => match serde_json::from_str(raw) {
                Ok(Value::Object(map)) => Value::Object(map),
                _ => {
                    let _ = api
                        .send_text(chat_id, "/ctl params must be one JSON object.")
                        .await;
                    return;
                }
            },
            _ => json!({}),
        };
        if (operation.starts_with("lane.")
            || operation.starts_with("permission.")
            || operation.starts_with("memory."))
            && params.get("lane").is_none()
        {
            let Some(target) = lock(&self.inner.targets).get(chat_id).cloned() else {
                let _ = api
                    .send_text(chat_id, "No target lane. Use /use first.")
                    .await;
                return;
            };
            params
                .as_object_mut()
                .expect("params object")
                .insert("lane".to_string(), Value::String(target.lane));
        }
        let reply = self.dispatch(app, operation, params, caller).await;
        self.send_control_reply(api, chat_id, reply).await;
    }

    async fn dispatch_and_report(
        &self,
        app: &AppHandle,
        api: &BotApi,
        chat_id: &str,
        operation: &str,
        params: Value,
        caller: ControlCaller,
    ) {
        let reply = self.dispatch(app, operation, params, caller).await;
        self.send_control_reply(api, chat_id, reply).await;
    }

    async fn dispatch(
        &self,
        app: &AppHandle,
        operation: &str,
        params: Value,
        caller: ControlCaller,
    ) -> ControlReply {
        let update_id = caller
            .telegram
            .as_ref()
            .map(|telegram| telegram.update_id.as_str())
            .unwrap_or("internal");
        let update_id_number = caller
            .telegram
            .as_ref()
            .and_then(|telegram| telegram.update_id.parse::<i64>().ok());
        let bot_id = read(&self.inner.bot)
            .as_ref()
            .map(|bot| bot.id.as_str())
            .unwrap_or("unknown")
            .to_string();
        let reply = self
            .inner
            .control
            .dispatch(
                app,
                ControlRequest {
                    operation_id: format!("telegram:{bot_id}:{update_id}:{operation}"),
                    operation: operation.to_string(),
                    params,
                },
                caller,
            )
            .await;
        if reply.error.as_ref().is_some_and(|error| error.retryable) {
            if let Some(update_id) = update_id_number {
                lock(&self.inner.retryable_updates).insert(update_id);
            }
        }
        reply
    }

    async fn send_control_reply(&self, api: &BotApi, chat_id: &str, reply: ControlReply) {
        if let Some(error) = reply.error {
            let _ = api
                .send_text(
                    chat_id,
                    &format!("{}: {}", error.code, bounded_line(&error.message, 320)),
                )
                .await;
            return;
        }
        let Some(result) = reply.result else {
            let _ = api.send_text(chat_id, "Operation completed.").await;
            return;
        };
        if let Some(status) = result.get("status").and_then(Value::as_str) {
            let text = if status == "queued" {
                format!(
                    "queued #{} · {}",
                    result
                        .get("queueDepth")
                        .and_then(Value::as_u64)
                        .unwrap_or(0),
                    result.get("lane").and_then(Value::as_str).unwrap_or("lane")
                )
            } else {
                format!(
                    "{} · {}",
                    status,
                    result
                        .get("lane")
                        .and_then(Value::as_str)
                        .unwrap_or("Krypton")
                )
            };
            let _ = api.send_text(chat_id, &text).await;
            return;
        }
        let rendered = serde_json::to_string_pretty(&result).unwrap_or_else(|_| "{}".to_string());
        let _ = api.send_text(chat_id, &rendered).await;
    }

    async fn send_reply_error_or(
        &self,
        api: &BotApi,
        chat_id: &str,
        reply: ControlReply,
        fallback: &str,
    ) {
        let message = reply
            .error
            .map(|error| format!("{}: {}", error.code, error.message))
            .unwrap_or_else(|| fallback.to_string());
        let _ = api.send_text(chat_id, &message).await;
    }

    async fn handle_pair_command(&self, api: &BotApi, message: &TelegramMessage, code: &str) {
        let now = now_secs();
        let matched = lock(&self.inner.pairing).as_ref().is_some_and(|pairing| {
            pairing.expires_at > now && pairing.code.eq_ignore_ascii_case(code.trim())
        });
        if !matched {
            return;
        }
        *lock(&self.inner.pairing) = None;
        let Some(sender) = message.from.as_ref() else {
            return;
        };
        let request = PendingPairing {
            request_id: random_hex(12).unwrap_or_else(|_| now.to_string()),
            user_id: sender.id.to_string(),
            display_name: sender.display_name(),
            chat_id: message.chat.id.to_string(),
            chat_kind: message.chat.kind.clone(),
            chat_title: message
                .chat
                .title
                .clone()
                .unwrap_or_else(|| sender.display_name()),
            expires_at: now + PAIRING_TTL_SECS,
        };
        *lock(&self.inner.pending_pairing) = Some(request);
        self.emit_pairing();
        let _ = api
            .send_text(
                &message.chat.id.to_string(),
                "Pairing request received. Approve it locally in Krypton Telegram Settings.",
            )
            .await;
    }

    fn chats_for_event(&self, event: &ControlStreamEvent) -> Vec<String> {
        let Some(lane) = event.lane.as_deref() else {
            return Vec::new();
        };
        lock(&self.inner.targets)
            .iter()
            .filter(|(_, target)| target.harness_id == event.harness_id && target.lane == lane)
            .map(|(chat, _)| chat.clone())
            .collect()
    }

    fn subscribed_chats(&self) -> Vec<String> {
        lock(&self.inner.targets).keys().cloned().collect()
    }

    fn is_subscribed(&self, chat_id: &str) -> bool {
        lock(&self.inner.targets).contains_key(chat_id)
    }

    fn is_private_chat(&self, chat_id: &str) -> bool {
        lock(&self.inner.targets)
            .get(chat_id)
            .is_some_and(|target| target.private_chat)
    }

    fn invalidate_targets(&self, event: &ControlStreamEvent) -> Vec<String> {
        let lane = event.lane.as_deref();
        let new_session = event.payload.get("sessionId").and_then(Value::as_str);
        let mut targets = lock(&self.inner.targets);
        let invalid: Vec<String> = targets
            .iter()
            .filter(|(_, target)| {
                if target.harness_id != event.harness_id {
                    return false;
                }
                if event.kind == "harness_closed" {
                    return true;
                }
                if lane != Some(target.lane.as_str()) {
                    return false;
                }
                if event.kind == "lane_session_changed" {
                    target.session_id.as_deref() != new_session
                } else {
                    true
                }
            })
            .map(|(chat, _)| chat.clone())
            .collect();
        for chat in &invalid {
            targets.remove(chat);
        }
        invalid
    }

    fn prepare_runtime_state(&self, bot_id: &str) {
        let mut state = load_runtime_state().ok().flatten().unwrap_or_default();
        if state.bot_id.as_deref() != Some(bot_id) {
            state = TelegramRuntimeState {
                schema_version: STATE_VERSION,
                bot_id: Some(bot_id.to_string()),
                last_handled_update_id: None,
            };
            if let Err(error) = save_runtime_state(&state) {
                log::warn!("telegram state reset: {error}");
            }
        }
    }

    fn is_generation(&self, generation: u64) -> bool {
        self.inner.generation.load(Ordering::SeqCst) == generation
    }

    fn set_health(&self, state: &str, detail: &str, backoff_seconds: Option<u64>) {
        *write(&self.inner.health) = TelegramHealth {
            state: state.to_string(),
            detail: detail.to_string(),
            last_poll_at: (state == "connected").then(now_secs),
            backoff_seconds,
        };
        self.emit_status();
    }

    fn emit_status(&self) {
        if let Some(app) = lock(&self.inner.app).as_ref() {
            app.emit_or_log("telegram-status-changed", self.status());
        }
    }

    fn emit_pairing(&self) {
        if let Some(app) = lock(&self.inner.app).as_ref() {
            app.emit_or_log("telegram-pairing-changed", self.status());
        }
    }

    fn issue_action(&self, chat_id: &str, kind: TelegramActionKind) -> Result<String, String> {
        for _ in 0..4 {
            let token = format!("lp:{}", random_hex(12)?);
            let now = now_secs();
            let mut actions = lock(&self.inner.actions);
            actions.retain(|_, action| action.expires_at > now);
            if actions.contains_key(&token) {
                continue;
            }
            if actions.len() >= TELEGRAM_ACTION_CAP {
                if let Some(oldest) = actions
                    .iter()
                    .min_by_key(|(_, action)| action.expires_at)
                    .map(|(token, _)| token.clone())
                {
                    actions.remove(&oldest);
                }
            }
            actions.insert(
                token.clone(),
                TelegramAction {
                    chat_id: chat_id.to_string(),
                    expires_at: now + TELEGRAM_ACTION_TTL_SECS,
                    claimed_by_update: None,
                    kind: kind.clone(),
                },
            );
            return Ok(token);
        }
        Err("generate unique Telegram action".to_string())
    }

    fn issue_picker_action(
        &self,
        chat_id: &str,
        kind: TelegramActionKind,
        issued: &mut Vec<String>,
    ) -> Result<String, String> {
        match self.issue_action(chat_id, kind) {
            Ok(token) => {
                issued.push(token.clone());
                Ok(token)
            }
            Err(error) => {
                self.remove_actions(issued);
                Err(error)
            }
        }
    }

    fn claim_action(&self, token: &str, chat_id: &str, update_id: i64) -> Option<TelegramAction> {
        let now = now_secs();
        let mut actions = lock(&self.inner.actions);
        if actions
            .get(token)
            .is_some_and(|action| action.expires_at <= now)
        {
            actions.remove(token);
            return None;
        }
        let action = actions.get_mut(token)?;
        if action.chat_id != chat_id {
            return None;
        }
        match action.claimed_by_update {
            Some(claimed) if claimed != update_id => return None,
            Some(_) => {}
            None => action.claimed_by_update = Some(update_id),
        }
        Some(action.clone())
    }

    fn finish_action(&self, token: &str, update_id: i64) {
        let mut actions = lock(&self.inner.actions);
        if actions
            .get(token)
            .is_some_and(|action| action.claimed_by_update == Some(update_id))
        {
            actions.remove(token);
        }
    }

    fn remove_actions(&self, tokens: &[String]) {
        let mut actions = lock(&self.inner.actions);
        for token in tokens {
            actions.remove(token);
        }
    }
}

async fn flush_conversation_surfaces(
    api: &BotApi,
    chat_id: &str,
    status: Option<&mut ToolStatusDraft>,
    mut draft: Option<&mut DigestDraft>,
) {
    if status.is_some() {
        if let Some(draft) = draft.as_deref_mut() {
            draft.promote_to_persistent();
        }
    }
    if let Some(status) = status {
        if let Err(error) = status.flush(api, chat_id).await {
            log::warn!("telegram status delivery: {}", sanitize_error(&error));
        }
    }
    if let Some(draft) = draft {
        if let Err(error) = draft.flush(api, chat_id).await {
            log::warn!("telegram digest delivery: {}", sanitize_error(&error));
        }
    }
}

#[tauri::command]
pub fn telegram_get_status(service: State<'_, TelegramService>) -> TelegramStatus {
    service.status()
}

#[tauri::command]
pub fn telegram_set_enabled(
    service: State<'_, TelegramService>,
    enabled: bool,
) -> Result<TelegramStatus, String> {
    service.set_enabled(enabled)
}

#[tauri::command]
pub fn telegram_set_rich_messages(
    service: State<'_, TelegramService>,
    enabled: bool,
) -> Result<TelegramStatus, String> {
    service.set_rich_messages(enabled)
}

#[tauri::command]
pub fn telegram_set_token(
    service: State<'_, TelegramService>,
    token: String,
) -> Result<TelegramStatus, String> {
    service.set_token(token)
}

#[tauri::command]
pub fn telegram_remove_token(
    service: State<'_, TelegramService>,
) -> Result<TelegramStatus, String> {
    service.remove_token()
}

#[tauri::command]
pub fn telegram_test_connection(
    service: State<'_, TelegramService>,
) -> Result<TelegramStatus, String> {
    service.test_connection()
}

#[tauri::command]
pub fn telegram_add_user(
    service: State<'_, TelegramService>,
    id: String,
) -> Result<TelegramStatus, String> {
    service.add_user(id)
}

#[tauri::command]
pub fn telegram_remove_user(
    service: State<'_, TelegramService>,
    id: String,
) -> Result<TelegramStatus, String> {
    service.remove_user(id)
}

#[tauri::command]
pub fn telegram_add_group(
    service: State<'_, TelegramService>,
    id: String,
) -> Result<TelegramStatus, String> {
    service.add_group(id)
}

#[tauri::command]
pub fn telegram_remove_group(
    service: State<'_, TelegramService>,
    id: String,
) -> Result<TelegramStatus, String> {
    service.remove_group(id)
}

#[tauri::command]
pub fn telegram_start_pairing(
    service: State<'_, TelegramService>,
) -> Result<TelegramStatus, String> {
    service.start_pairing()
}

#[tauri::command]
pub fn telegram_cancel_pairing(service: State<'_, TelegramService>) -> TelegramStatus {
    service.cancel_pairing()
}

#[tauri::command]
pub fn telegram_accept_pairing(
    service: State<'_, TelegramService>,
    request_id: String,
) -> Result<TelegramStatus, String> {
    service.accept_pairing(request_id)
}

#[tauri::command]
pub fn telegram_reject_pairing(
    service: State<'_, TelegramService>,
    request_id: String,
) -> Result<TelegramStatus, String> {
    service.reject_pairing(request_id)
}

#[derive(Clone)]
struct BotApi {
    client: reqwest::Client,
    base: String,
}

impl BotApi {
    fn new(token: String) -> Self {
        Self {
            client: reqwest::Client::new(),
            base: format!("{TELEGRAM_API}/bot{token}"),
        }
    }

    async fn get_me(&self) -> Result<TelegramBotIdentity, String> {
        let user: TelegramUser = self.call("getMe", json!({})).await?;
        let display_name = user.display_name();
        Ok(TelegramBotIdentity {
            id: user.id.to_string(),
            username: user.username.unwrap_or_default(),
            display_name,
        })
    }

    async fn set_commands(&self) -> Result<(), String> {
        let _: bool = self.call("setMyCommands", command_menu_body()).await?;
        Ok(())
    }

    async fn get_updates(&self, offset: Option<i64>) -> Result<Vec<TelegramUpdate>, String> {
        self.call(
            "getUpdates",
            json!({
                "offset": offset,
                "timeout": POLL_TIMEOUT_SECS,
                "allowed_updates": ["message", "callback_query"],
            }),
        )
        .await
    }

    async fn send_text(&self, chat_id: &str, text: &str) -> Result<(), String> {
        for part in split_message(text, MESSAGE_LIMIT) {
            let _: TelegramSentMessage = self
                .call("sendMessage", plain_message_body(chat_id, &part))
                .await?;
        }
        Ok(())
    }

    async fn send_message(&self, chat_id: &str, text: &str) -> Result<i64, String> {
        let message: TelegramSentMessage = self
            .call("sendMessage", plain_message_body(chat_id, text))
            .await?;
        Ok(message.message_id)
    }

    async fn send_keyboard(
        &self,
        chat_id: &str,
        text: &str,
        keyboard: Value,
    ) -> Result<i64, String> {
        let message: TelegramSentMessage = self
            .call(
                "sendMessage",
                keyboard_message_body(chat_id, text, keyboard),
            )
            .await?;
        Ok(message.message_id)
    }

    async fn send_rich_message(&self, chat_id: &str, html: &str) -> Result<i64, String> {
        let message: TelegramSentMessage = self
            .call("sendRichMessage", rich_message_body(chat_id, html))
            .await?;
        Ok(message.message_id)
    }

    async fn send_draft(&self, chat_id: &str, draft_id: i64, text: &str) -> Result<(), String> {
        let numeric_chat_id = chat_id
            .parse::<i64>()
            .map_err(|_| "Telegram private chat ID is invalid".to_string())?;
        let _: bool = self
            .call(
                "sendMessageDraft",
                plain_draft_body(numeric_chat_id, draft_id, text),
            )
            .await?;
        Ok(())
    }

    async fn send_rich_draft(
        &self,
        chat_id: &str,
        draft_id: i64,
        html: &str,
    ) -> Result<(), String> {
        let numeric_chat_id = chat_id
            .parse::<i64>()
            .map_err(|_| "Telegram private chat ID is invalid".to_string())?;
        let _: bool = self
            .call(
                "sendRichMessageDraft",
                rich_draft_body(numeric_chat_id, draft_id, html),
            )
            .await?;
        Ok(())
    }

    async fn edit_message(&self, chat_id: &str, message_id: i64, text: &str) -> Result<(), String> {
        let _: Value = self
            .call(
                "editMessageText",
                plain_edit_body(chat_id, message_id, text),
            )
            .await?;
        Ok(())
    }

    async fn edit_keyboard(
        &self,
        chat_id: &str,
        message_id: i64,
        text: &str,
        keyboard: Option<Value>,
    ) -> Result<(), String> {
        let _: Value = self
            .call(
                "editMessageText",
                keyboard_edit_body(chat_id, message_id, text, keyboard),
            )
            .await?;
        Ok(())
    }

    async fn edit_rich_message(
        &self,
        chat_id: &str,
        message_id: i64,
        html: &str,
    ) -> Result<(), String> {
        let _: Value = self
            .call("editMessageText", rich_edit_body(chat_id, message_id, html))
            .await?;
        Ok(())
    }

    async fn answer_callback(
        &self,
        callback_query_id: &str,
        text: Option<&str>,
    ) -> Result<(), String> {
        let _: bool = self
            .call(
                "answerCallbackQuery",
                answer_callback_body(callback_query_id, text),
            )
            .await?;
        Ok(())
    }

    async fn call<T: DeserializeOwned>(&self, method: &str, body: Value) -> Result<T, String> {
        let response = self
            .client
            .post(format!("{}/{method}", self.base))
            .timeout(Duration::from_secs(POLL_TIMEOUT_SECS + 10))
            .json(&body)
            .send()
            .await
            .map_err(|error| format!("Telegram network error: {error}"))?;
        let status = response.status();
        let envelope: TelegramApiResponse<T> = response
            .json()
            .await
            .map_err(|error| format!("Telegram response parse error ({status}): {error}"))?;
        if envelope.ok {
            envelope
                .result
                .ok_or_else(|| "Telegram response omitted result".to_string())
        } else {
            Err(format!(
                "{} {}{}",
                envelope.error_code.unwrap_or(status.as_u16()),
                envelope
                    .description
                    .unwrap_or_else(|| "Telegram API error".to_string()),
                envelope
                    .parameters
                    .and_then(|parameters| parameters.retry_after)
                    .map(|seconds| format!(" retry_after={seconds}"))
                    .unwrap_or_default(),
            ))
        }
    }
}

fn plain_message_body(chat_id: &str, text: &str) -> Value {
    json!({"chat_id": chat_id, "text": text})
}

fn command_menu_body() -> Value {
    json!({
        "commands": [
            {"command": "use", "description": "Choose a target lane"},
            {"command": "lanes", "description": "Show live lanes"},
            {"command": "status", "description": "Show selected lane status"},
            {"command": "ask", "description": "Send a prompt"},
            {"command": "cancel", "description": "Cancel the active turn"},
            {"command": "new", "description": "Start a fresh lane session"},
            {"command": "restart", "description": "Restart an errored lane"},
            {"command": "transcript", "description": "Show recent lane activity"},
            {"command": "help", "description": "Show controller help"},
        ]
    })
}

fn keyboard_message_body(chat_id: &str, text: &str, keyboard: Value) -> Value {
    json!({"chat_id": chat_id, "text": text, "reply_markup": keyboard})
}

fn keyboard_edit_body(
    chat_id: &str,
    message_id: i64,
    text: &str,
    keyboard: Option<Value>,
) -> Value {
    json!({
        "chat_id": chat_id,
        "message_id": message_id,
        "text": text,
        "reply_markup": keyboard.unwrap_or_else(|| json!({"inline_keyboard": []})),
    })
}

fn answer_callback_body(callback_query_id: &str, text: Option<&str>) -> Value {
    let mut body = json!({"callback_query_id": callback_query_id});
    if let Some(text) = text {
        body.as_object_mut()
            .expect("callback body object")
            .insert("text".to_string(), Value::String(text.to_string()));
    }
    body
}

fn plain_draft_body(chat_id: i64, draft_id: i64, text: &str) -> Value {
    json!({"chat_id": chat_id, "draft_id": draft_id, "text": text})
}

fn plain_edit_body(chat_id: &str, message_id: i64, text: &str) -> Value {
    json!({"chat_id": chat_id, "message_id": message_id, "text": text})
}

fn rich_content(html: &str) -> Value {
    json!({"html": html, "skip_entity_detection": true})
}

fn rich_message_body(chat_id: &str, html: &str) -> Value {
    json!({"chat_id": chat_id, "rich_message": rich_content(html)})
}

fn rich_draft_body(chat_id: i64, draft_id: i64, html: &str) -> Value {
    json!({
        "chat_id": chat_id,
        "draft_id": draft_id,
        "rich_message": rich_content(html),
    })
}

fn rich_edit_body(chat_id: &str, message_id: i64, html: &str) -> Value {
    json!({
        "chat_id": chat_id,
        "message_id": message_id,
        "rich_message": rich_content(html),
    })
}

#[derive(Debug, Deserialize)]
struct TelegramApiResponse<T> {
    ok: bool,
    result: Option<T>,
    description: Option<String>,
    error_code: Option<u16>,
    parameters: Option<TelegramResponseParameters>,
}

#[derive(Debug, Deserialize)]
struct TelegramResponseParameters {
    retry_after: Option<u64>,
}

#[derive(Debug, Clone, Deserialize)]
struct TelegramUpdate {
    update_id: i64,
    message: Option<TelegramMessage>,
    callback_query: Option<TelegramCallbackQuery>,
}

#[derive(Debug, Clone, Deserialize)]
struct TelegramCallbackQuery {
    id: String,
    from: TelegramUser,
    message: Option<TelegramCallbackMessage>,
    data: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
struct TelegramCallbackMessage {
    message_id: i64,
    chat: TelegramChat,
}

#[derive(Debug, Clone, Deserialize)]
struct TelegramMessage {
    from: Option<TelegramUser>,
    chat: TelegramChat,
    text: Option<String>,
    reply_to_message: Option<Box<TelegramMessage>>,
}

#[derive(Debug, Clone, Deserialize)]
struct TelegramChat {
    id: i64,
    #[serde(rename = "type")]
    kind: String,
    title: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
struct TelegramUser {
    id: i64,
    is_bot: bool,
    first_name: String,
    last_name: Option<String>,
    username: Option<String>,
}

impl TelegramUser {
    fn display_name(&self) -> String {
        bounded_line(
            &match &self.last_name {
                Some(last) if !last.trim().is_empty() => format!("{} {}", self.first_name, last),
                _ => self.first_name.clone(),
            },
            96,
        )
    }
}

#[derive(Debug, Deserialize)]
struct TelegramSentMessage {
    message_id: i64,
}

struct DigestDraft {
    text: String,
    message_id: Option<i64>,
    sent_text: String,
    ephemeral: bool,
    draft_id: i64,
    rich_requested: bool,
    rich_active: bool,
}

impl DigestDraft {
    fn new(private_chat: bool, rich_messages: bool) -> Self {
        Self {
            text: String::new(),
            message_id: None,
            sent_text: String::new(),
            ephemeral: private_chat,
            draft_id: next_draft_id(),
            rich_requested: rich_messages,
            rich_active: rich_messages,
        }
    }

    async fn flush(&mut self, api: &BotApi, chat_id: &str) -> Result<(), String> {
        if self.text.is_empty() || self.text == self.sent_text {
            return Ok(());
        }
        if self.rich_requested && self.rich_active {
            match self.flush_rich_preview(api, chat_id).await {
                Ok(()) => {
                    self.sent_text = self.text.clone();
                    return Ok(());
                }
                Err(error) => {
                    log::debug!(
                        "telegram rich preview unavailable, using plain text: {}",
                        sanitize_error(&error)
                    );
                    self.degrade_to_plain();
                }
            }
        }
        let preview = self.plain_preview();
        self.flush_plain_preview(api, chat_id, &preview).await?;
        self.sent_text = self.text.clone();
        Ok(())
    }

    async fn flush_rich_preview(&mut self, api: &BotApi, chat_id: &str) -> Result<(), String> {
        let html = render_rich_preview(&self.text)?;
        if self.ephemeral {
            return api.send_rich_draft(chat_id, self.draft_id, &html).await;
        }
        match self.message_id {
            Some(message_id) => match api.edit_rich_message(chat_id, message_id, &html).await {
                Ok(()) => Ok(()),
                Err(error) if error.contains("message is not modified") => Ok(()),
                Err(error) => Err(error),
            },
            None => {
                self.message_id = Some(api.send_rich_message(chat_id, &html).await?);
                Ok(())
            }
        }
    }

    async fn flush_plain_preview(
        &mut self,
        api: &BotApi,
        chat_id: &str,
        preview: &str,
    ) -> Result<(), String> {
        if self.ephemeral {
            match api.send_draft(chat_id, self.draft_id, preview).await {
                Ok(()) => return Ok(()),
                Err(error) => {
                    log::debug!(
                        "telegram sendMessageDraft unavailable, using persistent preview: {}",
                        sanitize_error(&error)
                    );
                    self.ephemeral = false;
                }
            }
        }
        match self.message_id {
            Some(message_id) => {
                if let Err(error) = api.edit_message(chat_id, message_id, preview).await {
                    if !error.contains("message is not modified") {
                        self.message_id = Some(api.send_message(chat_id, preview).await?);
                    }
                }
            }
            None => self.message_id = Some(api.send_message(chat_id, preview).await?),
        }
        Ok(())
    }

    async fn finalize(&mut self, api: &BotApi, chat_id: &str) -> Result<(), String> {
        if self.text.is_empty() {
            return Ok(());
        }
        if self.rich_requested && self.rich_active {
            let chunks = render_rich_chunks(&self.text);
            if !chunks.is_empty() {
                self.finalize_rich(api, chat_id, &chunks).await?;
                self.sent_text = self.text.clone();
                return Ok(());
            }
            self.degrade_to_plain();
        }
        self.finalize_plain(api, chat_id).await?;
        self.sent_text = self.text.clone();
        Ok(())
    }

    async fn finalize_rich(
        &mut self,
        api: &BotApi,
        chat_id: &str,
        chunks: &[TelegramOutputChunk],
    ) -> Result<(), String> {
        let mut rich_failed = false;
        for (index, chunk) in chunks.iter().enumerate() {
            if index == 0 {
                match chunk {
                    TelegramOutputChunk::Rich { html, plain } if !rich_failed => {
                        if let Err(error) = self.deliver_first_rich(api, chat_id, html).await {
                            log::debug!(
                                "telegram rich final unavailable, using plain text: {}",
                                sanitize_error(&error)
                            );
                            rich_failed = true;
                            self.degrade_to_plain();
                            self.deliver_first_plain(api, chat_id, plain).await?;
                        }
                    }
                    _ => {
                        self.deliver_first_plain(api, chat_id, chunk.plain())
                            .await?
                    }
                }
                continue;
            }
            match chunk {
                TelegramOutputChunk::Rich { html, plain } if !rich_failed => {
                    if let Err(error) = api.send_rich_message(chat_id, html).await {
                        log::debug!(
                            "telegram rich final chunk unavailable, using plain text: {}",
                            sanitize_error(&error)
                        );
                        rich_failed = true;
                        self.degrade_to_plain();
                        api.send_message(chat_id, plain).await?;
                    }
                }
                _ => {
                    api.send_message(chat_id, chunk.plain()).await?;
                }
            }
        }
        Ok(())
    }

    async fn deliver_first_rich(
        &mut self,
        api: &BotApi,
        chat_id: &str,
        html: &str,
    ) -> Result<(), String> {
        if self.ephemeral {
            self.message_id = Some(api.send_rich_message(chat_id, html).await?);
            return Ok(());
        }
        match self.message_id {
            Some(message_id) => match api.edit_rich_message(chat_id, message_id, html).await {
                Ok(()) => Ok(()),
                Err(error) if error.contains("message is not modified") => Ok(()),
                Err(error) => Err(error),
            },
            None => {
                self.message_id = Some(api.send_rich_message(chat_id, html).await?);
                Ok(())
            }
        }
    }

    async fn deliver_first_plain(
        &mut self,
        api: &BotApi,
        chat_id: &str,
        text: &str,
    ) -> Result<(), String> {
        if self.ephemeral {
            self.message_id = Some(api.send_message(chat_id, text).await?);
            return Ok(());
        }
        match self.message_id {
            Some(message_id) => {
                if let Err(error) = api.edit_message(chat_id, message_id, text).await {
                    if !error.contains("message is not modified") {
                        self.message_id = Some(api.send_message(chat_id, text).await?);
                    }
                }
            }
            None => self.message_id = Some(api.send_message(chat_id, text).await?),
        }
        Ok(())
    }

    async fn finalize_plain(&mut self, api: &BotApi, chat_id: &str) -> Result<(), String> {
        let parts = split_message(&self.text, MESSAGE_LIMIT);
        let Some(first) = parts.first() else {
            return Ok(());
        };
        self.deliver_first_plain(api, chat_id, first).await?;
        for part in parts.iter().skip(1) {
            api.send_text(chat_id, part).await?;
        }
        Ok(())
    }

    fn degrade_to_plain(&mut self) {
        self.rich_active = false;
        self.sent_text.clear();
    }

    fn promote_to_persistent(&mut self) {
        if self.ephemeral {
            self.ephemeral = false;
            self.sent_text.clear();
        }
    }

    fn plain_preview(&self) -> String {
        let count = self.text.chars().count();
        if count > MESSAGE_LIMIT {
            self.text.chars().skip(count - MESSAGE_LIMIT).collect()
        } else {
            self.text.clone()
        }
    }
}

#[derive(Default)]
struct ToolStatusDraft {
    lane: String,
    calls: HashMap<String, ToolStatusItem>,
    order: Vec<String>,
    final_label: Option<String>,
    message_id: Option<i64>,
    sent_text: String,
}

struct ToolStatusItem {
    label: String,
    status: String,
}

impl ToolStatusDraft {
    fn record(&mut self, lane: &str, tool_call_id: &str, label: &str, status: &str) {
        self.lane = lane.to_string();
        if !self.calls.contains_key(tool_call_id) {
            self.order.push(tool_call_id.to_string());
            self.calls.insert(
                tool_call_id.to_string(),
                ToolStatusItem {
                    label: label.to_string(),
                    status: status.to_string(),
                },
            );
        }
        let Some(entry) = self.calls.get_mut(tool_call_id) else {
            return;
        };
        if entry.label == "tool" && label != "tool" {
            entry.label = label.to_string();
        }
        entry.status = status.to_string();
    }

    fn finish(&mut self, label: String) {
        self.final_label = Some(label);
    }

    fn render(&self) -> String {
        const VISIBLE_TOOLS: usize = 6;
        let completed = self
            .calls
            .values()
            .filter(|call| call.status == "completed")
            .count();
        let failed = self
            .calls
            .values()
            .filter(|call| call.status == "failed")
            .count();
        let running = self.calls.len().saturating_sub(completed + failed);
        let mut counts = vec![format!("✓ {completed}")];
        if failed > 0 {
            counts.push(format!("✗ {failed}"));
        }
        if running > 0 {
            counts.push(format!("⟳ {running}"));
        }
        let mut lines = vec![
            format!("{} · {} tools", self.lane, self.calls.len()),
            counts.join(" · "),
        ];
        let hidden = self.order.len().saturating_sub(VISIBLE_TOOLS);
        if hidden > 0 {
            lines.push(format!("… {hidden} earlier"));
        }
        for tool_call_id in self.order.iter().skip(hidden) {
            if let Some(call) = self.calls.get(tool_call_id) {
                lines.push(format!(
                    "{} {}",
                    telegram_tool_status_glyph(&call.status),
                    call.label
                ));
            }
        }
        if let Some(label) = &self.final_label {
            lines.push(label.clone());
        }
        lines.join("\n")
    }

    async fn flush(&mut self, api: &BotApi, chat_id: &str) -> Result<(), String> {
        let text = self.render();
        if text == self.sent_text {
            return Ok(());
        }
        match self.message_id {
            Some(message_id) => {
                if let Err(error) = api.edit_message(chat_id, message_id, &text).await {
                    if !error.contains("message is not modified") {
                        self.message_id = Some(api.send_message(chat_id, &text).await?);
                    }
                }
            }
            None => self.message_id = Some(api.send_message(chat_id, &text).await?),
        }
        self.sent_text = text;
        Ok(())
    }
}

fn telegram_tool_label(
    title: Option<&str>,
    kind: Option<&str>,
    raw_input: Option<&Value>,
) -> String {
    if let Some(raw_input) = raw_input.and_then(Value::as_object) {
        if let (Some(server), Some(tool)) = (
            raw_input.get("server").and_then(Value::as_str),
            raw_input.get("tool").and_then(Value::as_str),
        ) {
            return bounded_line(&format!("{server} · {tool}"), 96);
        }
        for key in ["name", "toolName", "tool_name", "tool"] {
            if let Some(name) = raw_input.get(key).and_then(Value::as_str) {
                return bounded_line(&friendly_tool_name(name), 96);
            }
        }
    }
    let kind = kind.unwrap_or("other");
    let title = title
        .map(str::trim)
        .filter(|title| !title.is_empty() && !title.eq_ignore_ascii_case("tool"));
    if kind == "execute" {
        return "execute command".to_string();
    }
    title
        .map(|title| bounded_line(title, 96))
        .unwrap_or_else(|| {
            if kind == "other" {
                "tool".to_string()
            } else {
                kind.to_string()
            }
        })
}

fn friendly_tool_name(name: &str) -> String {
    if let Some(tool) = name
        .strip_prefix("mcp__")
        .and_then(|name| name.rsplit("__").next())
    {
        return tool.to_string();
    }
    name.replace("__", ".")
}

fn telegram_tool_status_glyph(status: &str) -> &'static str {
    match status {
        "completed" => "✓",
        "failed" => "✗",
        _ => "⟳",
    }
}

#[derive(Copy, Clone)]
enum IdKind {
    User,
    Group,
}

fn callback_authorized(settings: &TelegramSettings, user_id: &str, chat: &TelegramChat) -> bool {
    if !settings.authorized_user_ids.contains(user_id) {
        return false;
    }
    match chat.kind.as_str() {
        "private" => true,
        "group" | "supergroup" => settings
            .authorized_group_chat_ids
            .contains(&chat.id.to_string()),
        _ => false,
    }
}

fn lane_snapshot_matches(
    lane: &Value,
    harness_id: &str,
    lane_name: &str,
    session_id: Option<&str>,
) -> bool {
    lane.get("harnessId").and_then(Value::as_str) == Some(harness_id)
        && lane.get("displayName").and_then(Value::as_str) == Some(lane_name)
        && lane.get("sessionId").and_then(Value::as_str) == session_id
}

fn lane_matches_target(lane: &Value, target: &TelegramTarget) -> bool {
    lane_snapshot_matches(
        lane,
        &target.harness_id,
        &target.lane,
        target.session_id.as_deref(),
    )
}

fn canonical_id(raw: &str, kind: IdKind) -> Result<String, String> {
    let trimmed = raw.trim();
    let parsed = trimmed
        .parse::<i64>()
        .map_err(|_| "Telegram ID must be a signed 64-bit decimal integer".to_string())?;
    match kind {
        IdKind::User if parsed > 0 => Ok(parsed.to_string()),
        IdKind::Group if parsed < 0 => Ok(parsed.to_string()),
        IdKind::User => Err("Telegram user ID must be positive".to_string()),
        IdKind::Group => Err("Telegram group chat ID must be negative".to_string()),
    }
}

fn valid_bot_token(token: &str) -> bool {
    let Some((prefix, secret)) = token.split_once(':') else {
        return false;
    };
    prefix.len() >= 6
        && prefix.bytes().all(|byte| byte.is_ascii_digit())
        && secret.len() >= 20
        && secret
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || byte == b'_' || byte == b'-')
}

fn group_intentional(message: &TelegramMessage, username: &str, bot_id: &str) -> bool {
    let text = message.text.as_deref().unwrap_or_default();
    is_explicit_command(text)
        || text
            .to_lowercase()
            .contains(&format!("@{}", username.to_lowercase()))
        || message
            .reply_to_message
            .as_ref()
            .and_then(|reply| reply.from.as_ref())
            .is_some_and(|user| user.id.to_string() == bot_id)
}

fn is_explicit_command(text: &str) -> bool {
    text.trim_start().starts_with('/')
}

fn strip_group_trigger(text: &str, username: &str) -> String {
    let trimmed = text.trim();
    if let Some(argument) = command_argument(trimmed, "ask", username) {
        return argument.to_string();
    }
    let mention = format!("@{username}");
    trimmed.replace(&mention, "").trim().to_string()
}

fn command_argument<'a>(text: &'a str, command: &str, username: &str) -> Option<&'a str> {
    let trimmed = text.trim();
    let token = trimmed.split_whitespace().next()?;
    let normalized = token.trim_start_matches('/');
    let command_name = normalized.split('@').next()?;
    if command_name.eq_ignore_ascii_case(command)
        && normalized
            .split_once('@')
            .map_or(true, |(_, target)| target.eq_ignore_ascii_case(username))
    {
        Some(trimmed[token.len()..].trim())
    } else {
        None
    }
}

fn split_command(input: &str) -> (Option<String>, &str) {
    if !input.starts_with('/') {
        return (None, input);
    }
    let token = input.split_whitespace().next().unwrap_or(input);
    let command = token
        .trim_start_matches('/')
        .split('@')
        .next()
        .unwrap_or_default()
        .to_ascii_lowercase();
    (Some(command), input[token.len()..].trim())
}

fn split_message(text: &str, max_chars: usize) -> Vec<String> {
    if text.is_empty() {
        return vec![" ".to_string()];
    }
    let mut remaining = text.trim().to_string();
    let mut parts = Vec::new();
    while remaining.chars().count() > max_chars {
        let byte_limit = remaining
            .char_indices()
            .nth(max_chars)
            .map(|(index, _)| index)
            .unwrap_or(remaining.len());
        let prefix = &remaining[..byte_limit];
        let split = prefix
            .rfind("\n\n")
            .or_else(|| prefix.rfind('\n'))
            .or_else(|| prefix.rfind(' '))
            .filter(|index| *index > max_chars / 2)
            .unwrap_or(byte_limit);
        parts.push(remaining[..split].trim().to_string());
        remaining = remaining[split..].trim().to_string();
    }
    if !remaining.is_empty() {
        parts.push(remaining);
    }
    parts
}

fn bounded_line(text: &str, max_chars: usize) -> String {
    let normalized = text.split_whitespace().collect::<Vec<_>>().join(" ");
    normalized.chars().take(max_chars).collect()
}

fn advertised_operation(operation: &str) -> bool {
    crate::control::ADVERTISED_OPERATIONS.contains(&operation)
}

fn next_draft_id() -> i64 {
    let id = NEXT_DRAFT_ID.fetch_add(1, Ordering::Relaxed) & i64::MAX as u64;
    i64::try_from(id.max(1)).unwrap_or(1)
}

fn random_pair_code() -> Result<String, String> {
    const ALPHABET: &[u8] = b"ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
    let mut bytes = [0_u8; 8];
    getrandom(&mut bytes).map_err(|error| format!("generate pairing code: {error}"))?;
    Ok(bytes
        .iter()
        .enumerate()
        .flat_map(|(index, byte)| {
            let ch = ALPHABET[*byte as usize % ALPHABET.len()] as char;
            if index == 4 {
                vec!['-', ch]
            } else {
                vec![ch]
            }
        })
        .collect())
}

fn random_hex(bytes: usize) -> Result<String, String> {
    let mut data = vec![0_u8; bytes];
    getrandom(&mut data).map_err(|error| format!("generate random id: {error}"))?;
    Ok(data.iter().map(|byte| format!("{byte:02x}")).collect())
}

fn credential_entry() -> Result<Entry, String> {
    Entry::new(KEYRING_SERVICE, KEYRING_ACCOUNT)
        .map_err(|error| format!("open operating-system credential vault: {error}"))
}

fn credential_state() -> String {
    match load_token() {
        Ok(Some(_)) => "configured".to_string(),
        Ok(None) => "missing".to_string(),
        Err(_) => "unavailable".to_string(),
    }
}

fn load_token() -> Result<Option<String>, String> {
    match credential_entry()?.get_password() {
        Ok(token) => Ok(Some(token)),
        Err(keyring::Error::NoEntry) => Ok(None),
        Err(error) => Err(format!("read Telegram credential: {error}")),
    }
}

fn telegram_settings_path() -> Result<PathBuf, String> {
    config::config_dir()
        .map(|dir| dir.join("telegram.toml"))
        .ok_or_else(|| "Could not determine Krypton config directory".to_string())
}

fn telegram_state_path() -> Result<PathBuf, String> {
    config::config_dir()
        .map(|dir| dir.join("runtime").join("telegram-state.json"))
        .ok_or_else(|| "Could not determine Krypton config directory".to_string())
}

fn load_settings() -> Result<TelegramSettings, String> {
    let path = telegram_settings_path()?;
    if !path.exists() {
        return Ok(TelegramSettings::default());
    }
    let contents =
        fs::read_to_string(&path).map_err(|error| format!("read {}: {error}", path.display()))?;
    let settings: TelegramSettings =
        toml::from_str(&contents).map_err(|error| format!("parse {}: {error}", path.display()))?;
    if settings.schema_version != SETTINGS_VERSION {
        return Err(format!(
            "unsupported Telegram settings schema {}",
            settings.schema_version
        ));
    }
    Ok(settings)
}

fn save_settings(settings: &TelegramSettings) -> Result<(), String> {
    let contents = toml::to_string_pretty(settings)
        .map_err(|error| format!("serialize Telegram settings: {error}"))?;
    atomic_write(&telegram_settings_path()?, contents.as_bytes())
}

fn load_runtime_state() -> Result<Option<TelegramRuntimeState>, String> {
    let path = telegram_state_path()?;
    if !path.exists() {
        return Ok(None);
    }
    let contents =
        fs::read_to_string(&path).map_err(|error| format!("read {}: {error}", path.display()))?;
    let state: TelegramRuntimeState = serde_json::from_str(&contents)
        .map_err(|error| format!("parse {}: {error}", path.display()))?;
    if state.schema_version != STATE_VERSION {
        return Ok(None);
    }
    Ok(Some(state))
}

fn save_runtime_state(state: &TelegramRuntimeState) -> Result<(), String> {
    let contents = serde_json::to_vec_pretty(state)
        .map_err(|error| format!("serialize Telegram runtime state: {error}"))?;
    atomic_write(&telegram_state_path()?, &contents)
}

fn atomic_write(path: &Path, contents: &[u8]) -> Result<(), String> {
    let parent = path
        .parent()
        .ok_or_else(|| format!("{} has no parent directory", path.display()))?;
    fs::create_dir_all(parent).map_err(|error| format!("create {}: {error}", parent.display()))?;
    let temp = parent.join(format!(
        ".{}.{}.tmp",
        path.file_name()
            .and_then(|name| name.to_str())
            .unwrap_or("telegram"),
        std::process::id()
    ));
    fs::write(&temp, contents).map_err(|error| format!("write {}: {error}", temp.display()))?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(&temp, fs::Permissions::from_mode(0o600))
            .map_err(|error| format!("chmod {}: {error}", temp.display()))?;
    }
    fs::rename(&temp, path)
        .map_err(|error| format!("rename {} to {}: {error}", temp.display(), path.display()))
}

fn now_secs() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs()
}

fn sanitize_error(error: &str) -> String {
    let without_url = error
        .split_whitespace()
        .filter(|part| !part.contains("/bot") && !part.contains("api.telegram.org"))
        .collect::<Vec<_>>()
        .join(" ");
    bounded_line(&without_url, 300)
}

fn parse_retry_after(error: &str) -> Option<u64> {
    error
        .split_whitespace()
        .find_map(|part| part.strip_prefix("retry_after=")?.parse().ok())
}

fn lock<T>(mutex: &Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    mutex
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
}

fn read<T>(lock: &RwLock<T>) -> std::sync::RwLockReadGuard<'_, T> {
    lock.read().unwrap_or_else(|poisoned| poisoned.into_inner())
}

fn write<T>(lock: &RwLock<T>) -> std::sync::RwLockWriteGuard<'_, T> {
    lock.write()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
}

const HELP: &str = "\
Krypton Telegram Controller

/lanes · list live lanes
/use [lane] · tap or type this chat's target
/status · selected lane status
/ask <text> · send a prompt
/cancel · cancel active turn
/restart · restart errored lane
/new [--clear-memory] · fresh ACP session
/close · close selected lane
/transcript · recent transcript
/ctl <operation> <json> · typed controller operation

Private chats accept ordinary text. Groups require /ask, @mention, or a reply.
Telegram-originated turns bypass all permissions.";

#[cfg(test)]
mod tests {
    use super::*;

    fn service() -> TelegramService {
        TelegramService::new(Arc::new(ControlServer::default()))
    }

    fn message(text: &str, kind: &str, reply_from: Option<i64>) -> TelegramMessage {
        TelegramMessage {
            from: Some(TelegramUser {
                id: 42,
                is_bot: false,
                first_name: "Niran".to_string(),
                last_name: None,
                username: None,
            }),
            chat: TelegramChat {
                id: if kind == "private" { 42 } else { -1001 },
                kind: kind.to_string(),
                title: None,
            },
            text: Some(text.to_string()),
            reply_to_message: reply_from.map(|id| {
                Box::new(TelegramMessage {
                    from: Some(TelegramUser {
                        id,
                        is_bot: true,
                        first_name: "Krypton".to_string(),
                        last_name: None,
                        username: Some("krypton_bot".to_string()),
                    }),
                    chat: TelegramChat {
                        id: -1001,
                        kind: "group".to_string(),
                        title: None,
                    },
                    text: Some("reply".to_string()),
                    reply_to_message: None,
                })
            }),
        }
    }

    fn lanes(count: usize) -> Vec<Value> {
        (0..count)
            .map(|index| {
                json!({
                    "harnessId": "hm-1",
                    "displayName": format!("Claude-{}", index + 1),
                    "sessionId": format!("session-{}", index + 1),
                    "status": if index == 0 { "idle" } else { "busy" },
                    "modelName": "sonnet",
                    "cwd": "/Users/wk/Source/krypton",
                })
            })
            .collect()
    }

    #[test]
    fn canonical_ids_preserve_64_bit_values() {
        assert_eq!(
            canonical_id("9223372036854775807", IdKind::User).unwrap(),
            "9223372036854775807"
        );
        assert_eq!(
            canonical_id("-1002039441782", IdKind::Group).unwrap(),
            "-1002039441782"
        );
        assert!(canonical_id("-1", IdKind::User).is_err());
        assert!(canonical_id("1", IdKind::Group).is_err());
    }

    #[test]
    fn command_menu_descriptors_fit_telegram_contract() {
        let body = command_menu_body();
        let commands = body
            .get("commands")
            .and_then(Value::as_array)
            .expect("commands");
        assert!(commands.len() <= 100);
        assert!(commands
            .iter()
            .any(|entry| entry.get("command") == Some(&json!("use"))));
        for entry in commands {
            let command = entry
                .get("command")
                .and_then(Value::as_str)
                .expect("command");
            let description = entry
                .get("description")
                .and_then(Value::as_str)
                .expect("description");
            assert!((1..=32).contains(&command.len()));
            assert!(command
                .bytes()
                .all(|byte| byte.is_ascii_lowercase() || byte.is_ascii_digit() || byte == b'_'));
            assert!((1..=256).contains(&description.chars().count()));
        }
    }

    #[test]
    fn lane_picker_pages_buttons_and_marks_the_current_target() {
        let service = service();
        lock(&service.inner.targets).insert(
            "42".to_string(),
            TelegramTarget {
                harness_id: "hm-1".to_string(),
                lane: "Claude-1".to_string(),
                session_id: Some("session-1".to_string()),
                private_chat: true,
            },
        );
        let picker = service
            .build_lane_picker("42", &lanes(10), 0, None)
            .expect("picker");
        assert!(picker.text.contains("Choose a target lane · 1/2"));
        assert!(picker.text.contains("Current: Claude-1"));
        assert!(picker.text.contains("/Users/wk/Source/krypton"));
        let rows = picker
            .keyboard
            .as_ref()
            .and_then(|keyboard| keyboard.get("inline_keyboard"))
            .and_then(Value::as_array)
            .expect("keyboard rows");
        assert_eq!(rows.len(), 9);
        assert_eq!(
            rows[0][0].get("text"),
            Some(&json!("✓ Claude-1 · /Users/wk/Source/krypton"))
        );
        assert_eq!(rows[0].as_array().map(Vec::len), Some(1));
        assert_eq!(rows[8].as_array().map(Vec::len), Some(2));
        assert_eq!(picker.tokens.len(), 10);
    }

    #[test]
    fn picker_actions_are_short_chat_bound_single_use_capabilities() {
        let service = service();
        let token = service
            .issue_action("42", TelegramActionKind::ShowLanePage { page: 1 })
            .expect("action");
        assert_eq!(token.len(), 27);
        assert!(token.starts_with("lp:"));
        assert!(token[3..].bytes().all(|byte| byte.is_ascii_hexdigit()));
        assert!(service.claim_action(&token, "99", 7).is_none());
        assert!(service.claim_action(&token, "42", 7).is_some());
        assert!(service.claim_action(&token, "42", 7).is_some());
        assert!(service.claim_action(&token, "42", 8).is_none());
        service.finish_action(&token, 7);
        assert!(service.claim_action(&token, "42", 7).is_none());

        let expired = service
            .issue_action("42", TelegramActionKind::ShowLanePage { page: 0 })
            .expect("expired action");
        lock(&service.inner.actions)
            .get_mut(&expired)
            .expect("stored action")
            .expires_at = 0;
        assert!(service.claim_action(&expired, "42", 9).is_none());
    }

    #[test]
    fn picker_action_claim_is_atomic_across_updates() {
        let service = service();
        let token = service
            .issue_action("42", TelegramActionKind::ShowLanePage { page: 0 })
            .expect("action");
        let barrier = Arc::new(std::sync::Barrier::new(3));
        let handles = [10_i64, 11_i64].map(|update_id| {
            let service = service.clone();
            let token = token.clone();
            let barrier = barrier.clone();
            std::thread::spawn(move || {
                barrier.wait();
                service.claim_action(&token, "42", update_id).is_some()
            })
        });
        barrier.wait();
        let claimed = handles
            .into_iter()
            .map(|handle| handle.join().expect("claim thread"))
            .filter(|claimed| *claimed)
            .count();
        assert_eq!(claimed, 1);
    }

    #[test]
    fn picker_action_registry_prunes_to_its_cap() {
        let service = service();
        {
            let mut actions = lock(&service.inner.actions);
            for index in 0..TELEGRAM_ACTION_CAP {
                actions.insert(
                    format!("old-{index}"),
                    TelegramAction {
                        chat_id: "42".to_string(),
                        expires_at: now_secs() + 1000 + index as u64,
                        claimed_by_update: None,
                        kind: TelegramActionKind::ShowLanePage { page: 0 },
                    },
                );
            }
        }
        service
            .issue_action("42", TelegramActionKind::ShowLanePage { page: 1 })
            .expect("new action");
        let actions = lock(&service.inner.actions);
        assert!(actions.len() <= TELEGRAM_ACTION_CAP);
        assert!(!actions.contains_key("old-0"));
    }

    #[test]
    fn callback_authorization_checks_both_user_and_group() {
        let mut settings = TelegramSettings::default();
        settings.authorized_user_ids.insert("42".to_string());
        settings
            .authorized_group_chat_ids
            .insert("-1001".to_string());
        let private = TelegramChat {
            id: 42,
            kind: "private".to_string(),
            title: None,
        };
        let group = TelegramChat {
            id: -1001,
            kind: "group".to_string(),
            title: None,
        };
        let other_group = TelegramChat {
            id: -1002,
            kind: "supergroup".to_string(),
            title: None,
        };
        assert!(callback_authorized(&settings, "42", &private));
        assert!(callback_authorized(&settings, "42", &group));
        assert!(!callback_authorized(&settings, "42", &other_group));
        assert!(!callback_authorized(&settings, "7", &private));
    }

    #[test]
    fn callback_update_deserializes_without_a_message_update() {
        let update: TelegramUpdate = serde_json::from_value(json!({
            "update_id": 91,
            "callback_query": {
                "id": "callback-1",
                "from": {
                    "id": 42,
                    "is_bot": false,
                    "first_name": "Niran"
                },
                "message": {
                    "message_id": 7,
                    "chat": {"id": 42, "type": "private"}
                },
                "data": "lp:0123456789abcdef01234567"
            }
        }))
        .expect("callback update");
        assert!(update.message.is_none());
        let callback = update.callback_query.expect("callback");
        assert_eq!(callback.message.expect("message").message_id, 7);
    }

    #[test]
    fn lane_snapshot_requires_harness_name_and_session_match() {
        let lane = json!({
            "harnessId": "hm-1",
            "displayName": "Claude-1",
            "sessionId": "session-1",
        });
        assert!(lane_snapshot_matches(
            &lane,
            "hm-1",
            "Claude-1",
            Some("session-1")
        ));
        assert!(!lane_snapshot_matches(
            &lane,
            "hm-2",
            "Claude-1",
            Some("session-1")
        ));
        assert!(!lane_snapshot_matches(
            &lane,
            "hm-1",
            "Claude-1",
            Some("session-2")
        ));
        assert!(lane_snapshot_matches(
            &json!({"harnessId": "hm-1", "displayName": "Claude-1", "sessionId": null}),
            "hm-1",
            "Claude-1",
            None
        ));
    }

    #[test]
    fn keyboard_payloads_add_and_remove_inline_buttons() {
        let keyboard = json!({
            "inline_keyboard": [[{"text": "Claude-1", "callback_data": "lp:token"}]]
        });
        let sent = keyboard_message_body("42", "Choose", keyboard.clone());
        let edited = keyboard_edit_body("42", 7, "Choose", Some(keyboard));
        let removed = keyboard_edit_body("42", 7, "Selected", None);
        assert!(sent.pointer("/reply_markup/inline_keyboard/0/0").is_some());
        assert!(edited
            .pointer("/reply_markup/inline_keyboard/0/0")
            .is_some());
        assert_eq!(
            removed.pointer("/reply_markup/inline_keyboard"),
            Some(&json!([]))
        );
        assert_eq!(
            answer_callback_body("callback-1", None),
            json!({"callback_query_id": "callback-1"})
        );
    }

    #[tokio::test]
    async fn bot_api_methods_and_stream_order_match_the_wire_contract() {
        use tokio::io::{AsyncReadExt, AsyncWriteExt};

        let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
            .await
            .expect("fake Telegram listener");
        let address = listener.local_addr().expect("listener address");
        let server = tokio::spawn(async move {
            let responses = [
                json!(true),
                json!([]),
                json!({"message_id": 7}),
                json!({"message_id": 7}),
                json!(true),
                json!(true),
                json!({"message_id": 8}),
                json!({"message_id": 9}),
            ];
            let mut requests = Vec::new();
            for result in responses {
                let (mut stream, _) = listener.accept().await.expect("fake accept");
                let mut request = Vec::new();
                let header_end = loop {
                    let mut chunk = [0_u8; 4096];
                    let read = stream.read(&mut chunk).await.expect("fake read");
                    assert!(read > 0);
                    request.extend_from_slice(&chunk[..read]);
                    if let Some(index) = request.windows(4).position(|window| window == b"\r\n\r\n")
                    {
                        break index + 4;
                    }
                };
                let headers = String::from_utf8_lossy(&request[..header_end]).into_owned();
                let content_length = headers
                    .lines()
                    .find_map(|line| {
                        let (name, value) = line.split_once(':')?;
                        name.eq_ignore_ascii_case("content-length")
                            .then(|| value.trim().parse::<usize>().ok())
                            .flatten()
                    })
                    .expect("content length");
                while request.len() < header_end + content_length {
                    let mut chunk = [0_u8; 4096];
                    let read = stream.read(&mut chunk).await.expect("fake body read");
                    assert!(read > 0);
                    request.extend_from_slice(&chunk[..read]);
                }
                let path = headers
                    .lines()
                    .next()
                    .and_then(|line| line.split_whitespace().nth(1))
                    .expect("request path")
                    .to_string();
                let body: Value =
                    serde_json::from_slice(&request[header_end..header_end + content_length])
                        .expect("request JSON");
                requests.push((path, body));
                let response_body = json!({"ok": true, "result": result}).to_string();
                let response = format!(
                    "HTTP/1.1 200 OK\r\ncontent-type: application/json\r\ncontent-length: {}\r\nconnection: close\r\n\r\n{}",
                    response_body.len(),
                    response_body
                );
                stream
                    .write_all(response.as_bytes())
                    .await
                    .expect("fake response");
            }
            requests
        });

        let api = BotApi {
            client: reqwest::Client::new(),
            base: format!("http://{address}/botTEST"),
        };
        api.set_commands().await.expect("set commands");
        api.get_updates(Some(3)).await.expect("get updates");
        let keyboard =
            json!({"inline_keyboard": [[{"text": "Claude-1", "callback_data": "lp:token"}]]});
        api.send_keyboard("42", "Choose", keyboard.clone())
            .await
            .expect("send keyboard");
        api.edit_keyboard("42", 7, "Choose", Some(keyboard))
            .await
            .expect("edit keyboard");
        api.answer_callback("callback-1", None)
            .await
            .expect("answer callback");
        let mut draft = DigestDraft::new(true, true);
        draft.text = "Work".to_string();
        draft.flush(&api, "42").await.expect("initial rich draft");
        draft.text.push_str("ing");
        let mut status = ToolStatusDraft::default();
        status.record("Codex-1", "call-1", "execute command", "in_progress");
        flush_conversation_surfaces(&api, "42", Some(&mut status), Some(&mut draft)).await;

        let requests = server.await.expect("fake Telegram server");
        assert!(requests[0].0.ends_with("/setMyCommands"));
        assert_eq!(requests[0].1, command_menu_body());
        assert!(requests[1].0.ends_with("/getUpdates"));
        assert_eq!(
            requests[1].1.get("allowed_updates"),
            Some(&json!(["message", "callback_query"]))
        );
        assert!(requests[2].0.ends_with("/sendMessage"));
        assert!(requests[2]
            .1
            .pointer("/reply_markup/inline_keyboard/0/0")
            .is_some());
        assert!(requests[3].0.ends_with("/editMessageText"));
        assert!(requests[4].0.ends_with("/answerCallbackQuery"));
        assert_eq!(requests[4].1, json!({"callback_query_id": "callback-1"}));
        assert!(requests[5].0.ends_with("/sendRichMessageDraft"));
        assert!(requests[6].0.ends_with("/sendMessage"));
        assert!(requests[7].0.ends_with("/sendRichMessage"));
    }

    #[test]
    fn bot_token_shape_is_checked_without_logging_it() {
        assert!(valid_bot_token(
            "123456789:ABCDEFGHIJKLMNOPQRSTUVWXYZ_abcdef-123456"
        ));
        assert!(!valid_bot_token("short"));
        assert!(!valid_bot_token("123456:spaces are invalid"));
    }

    #[test]
    fn group_requires_command_mention_or_bot_reply() {
        assert!(!group_intentional(
            &message("ordinary chatter", "group", None),
            "krypton_bot",
            "99"
        ));
        assert!(group_intentional(
            &message("/ask run tests", "group", None),
            "krypton_bot",
            "99"
        ));
        assert!(group_intentional(
            &message("@krypton_bot run tests", "group", None),
            "krypton_bot",
            "99"
        ));
        assert!(group_intentional(
            &message("run tests", "group", Some(99)),
            "krypton_bot",
            "99"
        ));
    }

    #[test]
    fn group_trigger_is_removed_before_prompt() {
        assert_eq!(
            strip_group_trigger("/ask run tests", "krypton_bot"),
            "run tests"
        );
        assert_eq!(
            strip_group_trigger("@krypton_bot run tests", "krypton_bot"),
            "run tests"
        );
    }

    #[test]
    fn message_split_respects_unicode_character_limit() {
        let text = format!("{}\n\n{}", "ก".repeat(2500), "ข".repeat(2500));
        let parts = split_message(&text, 4000);
        assert_eq!(parts.len(), 2);
        assert!(parts.iter().all(|part| part.chars().count() <= 4000));
        assert_eq!(parts.concat().chars().count(), 5000);
    }

    #[test]
    fn caller_facing_errors_drop_bot_urls() {
        let clean =
            sanitize_error("network https://api.telegram.org/bot123:SECRET/getUpdates failed");
        assert!(!clean.contains("SECRET"));
        assert!(!clean.contains("api.telegram.org"));
    }

    #[test]
    fn ctl_parity_uses_the_control_api_capability_registry() {
        assert!(advertised_operation("lane.send"));
        assert!(advertised_operation("github.dispatch-issue"));
        assert!(!advertised_operation("peer.send"));
    }

    #[test]
    fn retry_after_is_parsed_for_exact_telegram_backoff() {
        assert_eq!(
            parse_retry_after("429 Too Many Requests retry_after=17"),
            Some(17)
        );
        assert_eq!(parse_retry_after("500 unavailable"), None);
    }

    #[test]
    fn private_chat_digest_uses_ephemeral_draft_until_finalize() {
        let private = DigestDraft::new(true, true);
        let group = DigestDraft::new(false, false);

        assert!(private.ephemeral);
        assert!(private.draft_id > 0);
        assert!(private.rich_requested);
        assert!(private.rich_active);
        assert!(!group.ephemeral);
        assert!(!group.rich_requested);
        assert!(!group.rich_active);
    }

    #[test]
    fn rich_fallback_resets_dedup_without_changing_requested_mode() {
        let mut draft = DigestDraft::new(false, true);
        draft.sent_text = "already sent".to_string();
        draft.degrade_to_plain();

        assert!(draft.rich_requested);
        assert!(!draft.rich_active);
        assert!(draft.sent_text.is_empty());
    }

    #[test]
    fn old_telegram_settings_default_to_plain_messages() {
        let settings: TelegramSettings = toml::from_str(
            "schema_version = 1\nenabled = true\nauthorized_user_ids = []\nauthorized_group_chat_ids = []\n",
        )
        .expect("settings parse");

        assert!(!settings.rich_messages);
    }

    #[test]
    fn rich_payloads_never_mix_text_and_rich_message() {
        let message = rich_message_body("42", "<h1>Ready</h1>");
        let draft = rich_draft_body(42, 7, "<p>Working</p>");
        let edit = rich_edit_body("42", 9, "<p>Done</p>");
        for body in [&message, &draft, &edit] {
            assert!(body.get("rich_message").is_some());
            assert!(body.get("text").is_none());
            assert_eq!(
                body.pointer("/rich_message/skip_entity_detection"),
                Some(&Value::Bool(true))
            );
        }

        let plain = plain_message_body("42", "Ready");
        assert_eq!(plain.get("text"), Some(&Value::String("Ready".to_string())));
        assert!(plain.get("rich_message").is_none());
    }

    #[test]
    fn tool_status_compacts_updates_into_one_summary() {
        let mut status = ToolStatusDraft::default();
        status.record("Codex-1", "call-1", "read telegram.rs", "in_progress");
        status.record("Codex-1", "call-2", "cargo clippy", "failed");
        status.record("Codex-1", "call-1", "tool", "completed");
        status.finish("Codex-1 · error".to_string());

        assert_eq!(
            status.render(),
            "Codex-1 · 2 tools\n✓ 1 · ✗ 1\n✓ read telegram.rs\n✗ cargo clippy\nCodex-1 · error"
        );
    }

    #[test]
    fn telegram_tool_labels_are_useful_without_exposing_shell_commands() {
        assert_eq!(
            telegram_tool_label(
                Some("tool"),
                Some("other"),
                Some(&json!({"name": "web__run"}))
            ),
            "web.run"
        );
        assert_eq!(
            telegram_tool_label(
                Some("rm -rf sensitive-path"),
                Some("execute"),
                Some(&json!({"command": "rm -rf sensitive-path"}))
            ),
            "execute command"
        );
        assert_eq!(
            telegram_tool_label(
                Some("tool"),
                Some("other"),
                Some(&json!({"server": "krypton-harness-memory", "tool": "attention_flag"}))
            ),
            "krypton-harness-memory · attention_flag"
        );
    }
}
