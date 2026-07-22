mod proto;

#[allow(dead_code)]
#[path = "../../../desktop/src/bridge.rs"]
mod bridge;
#[allow(dead_code)]
#[path = "../../../desktop/src/paths.rs"]
mod paths;
#[path = "../../../desktop/src/sticker.rs"]
mod sticker;

use std::{
    collections::HashMap,
    path::{Path, PathBuf},
    sync::{
        Arc,
        atomic::{AtomicU64, Ordering},
    },
    time::Duration,
};

use proto::{rpc_request, rpc_response};
use serde::Serialize;
use tauri::{Manager as _, ipc::Channel};
use tauri_plugin_opener::OpenerExt as _;
use tokio::sync::{Mutex, oneshot};

const CONTROL_TIMEOUT: Duration = Duration::from_secs(15);
const READ_TIMEOUT: Duration = Duration::from_secs(30);
const WRITE_TIMEOUT: Duration = Duration::from_secs(60);
// A descriptor refresh can precede one retry, and each backend transfer is
// bounded at ten minutes. Keep the shell alive long enough to receive the
// backend's authoritative result instead of orphaning an in-flight media RPC.
const ATTACHMENT_TIMEOUT: Duration = Duration::from_secs(22 * 60);

type PendingMap = Arc<Mutex<HashMap<u64, oneshot::Sender<proto::RpcResponse>>>>;

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct FrontendEvent {
    /// Monotonic sequence supplied by the Go backend. Shell-generated events
    /// use zero and never advance the backend sequence tracker.
    sequence: u64,
    #[serde(flatten)]
    event: FrontendEventKind,
}

#[derive(Clone, Debug, Serialize)]
#[serde(tag = "type", content = "payload", rename_all = "camelCase")]
enum FrontendEventKind {
    ConnectionChanged(proto::ConnectionChanged),
    PairingQr(proto::PairingQr),
    SyncProgress(proto::SyncProgress),
    ChatUpserted(proto::ChatUpserted),
    MessageUpserted(proto::MessageUpserted),
    ReceiptUpdated(proto::ReceiptUpdated),
    Problem(proto::BackendProblem),
    ReactionUpdated(proto::ReactionUpdated),
    RecentReactionsRepaired(proto::RecentReactionsRepaired),
    ChatMerged(proto::ChatMerged),
    TypingChanged(proto::TypingChanged),
    BridgeExited(BridgeExited),
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct BridgeExited {
    message: String,
}

impl FrontendEvent {
    fn local(event: FrontendEventKind) -> Self {
        Self { sequence: 0, event }
    }

    fn problem(code: &str, message: String) -> Self {
        Self::local(FrontendEventKind::Problem(proto::BackendProblem {
            code: code.into(),
            message,
            fatal: false,
        }))
    }
}

impl From<proto::BackendEvent> for Option<FrontendEvent> {
    fn from(event: proto::BackendEvent) -> Self {
        use proto::backend_event::Event;
        let sequence = event.sequence;
        let event = match event.event? {
            Event::ConnectionChanged(value) => FrontendEventKind::ConnectionChanged(value),
            Event::PairingQr(value) => FrontendEventKind::PairingQr(value),
            Event::SyncProgress(value) => FrontendEventKind::SyncProgress(value),
            Event::ChatUpserted(value) => FrontendEventKind::ChatUpserted(value),
            Event::MessageUpserted(value) => FrontendEventKind::MessageUpserted(value),
            Event::ReceiptUpdated(value) => FrontendEventKind::ReceiptUpdated(value),
            Event::Problem(value) => FrontendEventKind::Problem(value),
            Event::ReactionUpdated(value) => FrontendEventKind::ReactionUpdated(value),
            Event::RecentReactionsRepaired(value) => {
                FrontendEventKind::RecentReactionsRepaired(value)
            }
            Event::ChatMerged(value) => FrontendEventKind::ChatMerged(value),
            Event::TypingChanged(value) => FrontendEventKind::TypingChanged(value),
        };
        Some(FrontendEvent { sequence, event })
    }
}

#[derive(Debug, Default)]
struct EventSequence {
    last: u64,
}

#[derive(Debug, PartialEq, Eq)]
enum SequenceObservation {
    Accept,
    Gap { expected: u64, received: u64 },
    Invalid,
    Stale,
}

impl EventSequence {
    fn observe(&mut self, received: u64) -> SequenceObservation {
        if received == 0 {
            return SequenceObservation::Invalid;
        }
        if received <= self.last {
            return SequenceObservation::Stale;
        }
        let expected = self.last.saturating_add(1);
        let observation = if received > expected {
            SequenceObservation::Gap { expected, received }
        } else {
            SequenceObservation::Accept
        };
        self.last = received;
        observation
    }
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct CommandError {
    code: String,
    message: String,
    retryable: bool,
}

impl CommandError {
    fn transport(message: impl Into<String>) -> Self {
        Self {
            code: "transport".into(),
            message: message.into(),
            retryable: true,
        }
    }

    fn protocol(message: impl Into<String>) -> Self {
        Self {
            code: "protocol".into(),
            message: message.into(),
            retryable: false,
        }
    }

    fn invalid_argument(message: impl Into<String>) -> Self {
        Self {
            code: "invalid_argument".into(),
            message: message.into(),
            retryable: false,
        }
    }

    fn open_failed(message: impl Into<String>) -> Self {
        Self {
            code: "open_failed".into(),
            message: message.into(),
            retryable: false,
        }
    }
}

impl From<proto::RpcError> for CommandError {
    fn from(error: proto::RpcError) -> Self {
        Self {
            code: error.code,
            message: error.message,
            retryable: error.retryable,
        }
    }
}

struct BridgeService {
    client: bridge::BackendClient,
    next_request_id: AtomicU64,
    pending: PendingMap,
    subscribers: Arc<Mutex<Vec<Channel<FrontendEvent>>>>,
}

impl BridgeService {
    fn start(fake: bool) -> anyhow::Result<Self> {
        let client = bridge::BackendClient::start(fake)?;
        let incoming = client.incoming.clone();
        let pending: PendingMap = Arc::new(Mutex::new(HashMap::new()));
        let subscribers = Arc::new(Mutex::new(Vec::<Channel<FrontendEvent>>::new()));
        let listener_pending = pending.clone();
        let listener_subscribers = subscribers.clone();

        tauri::async_runtime::spawn(async move {
            let mut event_sequence = EventSequence::default();
            while let Ok(message) = incoming.recv().await {
                match message {
                    bridge::BridgeMessage::Envelope(envelope) => match envelope.body {
                        Some(proto::envelope::Body::Response(response)) => {
                            if let Some(sender) =
                                listener_pending.lock().await.remove(&envelope.request_id)
                            {
                                let _ = sender.send(response);
                            }
                        }
                        Some(proto::envelope::Body::Event(event)) if envelope.request_id == 0 => {
                            match event_sequence.observe(event.sequence) {
                                SequenceObservation::Invalid => {
                                    send_event(
                                        &listener_subscribers,
                                        FrontendEvent::problem(
                                            "event_sequence_invalid",
                                            "Backend emitted an unsequenced event; refresh may be required"
                                                .into(),
                                        ),
                                    )
                                    .await;
                                    continue;
                                }
                                SequenceObservation::Stale => continue,
                                SequenceObservation::Gap { expected, received } => {
                                    send_event(
                                        &listener_subscribers,
                                        FrontendEvent::problem(
                                            "event_sequence_gap",
                                            format!(
                                                "Backend event gap (expected {expected}, received {received}); refresh may be required"
                                            ),
                                        ),
                                    )
                                    .await;
                                }
                                SequenceObservation::Accept => {}
                            }
                            if let Some(event) = Option::<FrontendEvent>::from(event) {
                                send_event(&listener_subscribers, event).await;
                            }
                        }
                        _ => {}
                    },
                    bridge::BridgeMessage::Exited(message) => {
                        listener_pending.lock().await.clear();
                        send_event(
                            &listener_subscribers,
                            FrontendEvent::local(FrontendEventKind::BridgeExited(BridgeExited {
                                message,
                            })),
                        )
                        .await;
                        break;
                    }
                }
            }
        });

        Ok(Self {
            client,
            next_request_id: AtomicU64::new(1),
            pending,
            subscribers,
        })
    }

    async fn subscribe(&self, channel: Channel<FrontendEvent>) {
        self.subscribers.lock().await.push(channel);
    }

    async fn request(
        &self,
        request: rpc_request::Request,
        timeout: Duration,
    ) -> Result<rpc_response::Result, CommandError> {
        let request_id = self.next_request_id.fetch_add(1, Ordering::Relaxed);
        if request_id == 0 || request_id == u64::MAX {
            return Err(CommandError::transport("request IDs exhausted"));
        }

        let (sender, receiver) = oneshot::channel();
        self.pending.lock().await.insert(request_id, sender);
        if let Err(error) = self.client.send(request_id, request) {
            self.pending.lock().await.remove(&request_id);
            return Err(CommandError::transport(error.to_string()));
        }

        let response = match tokio::time::timeout(timeout, receiver).await {
            Ok(Ok(response)) => response,
            Ok(Err(_)) => {
                return Err(CommandError::transport(
                    "the backend stopped before replying",
                ));
            }
            Err(_) => {
                self.pending.lock().await.remove(&request_id);
                return Err(CommandError::transport("the backend request timed out"));
            }
        };

        match response.result {
            Some(rpc_response::Result::Error(error)) => Err(error.into()),
            Some(result) => Ok(result),
            None => Err(CommandError::protocol("backend response had no result")),
        }
    }
}

async fn send_event(subscribers: &Mutex<Vec<Channel<FrontendEvent>>>, event: FrontendEvent) {
    subscribers
        .lock()
        .await
        .retain(|subscriber| subscriber.send(event.clone()).is_ok());
}

macro_rules! expect_response {
    ($result:expr, $variant:ident) => {
        match $result {
            rpc_response::Result::$variant(value) => Ok(value),
            _ => Err(CommandError::protocol(concat!(
                "backend returned the wrong response for ",
                stringify!($variant)
            ))),
        }
    };
}

fn validate_attachment_kind(
    kind: i32,
    caption: &str,
    voice_note: bool,
) -> Result<proto::AttachmentKind, CommandError> {
    let kind = proto::AttachmentKind::try_from(kind)
        .map_err(|_| CommandError::invalid_argument("unknown attachment kind"))?;
    match kind {
        proto::AttachmentKind::Unspecified => Err(CommandError::invalid_argument(
            "attachment kind is required",
        )),
        proto::AttachmentKind::Audio if !caption.is_empty() => Err(CommandError::invalid_argument(
            "audio messages do not support captions",
        )),
        proto::AttachmentKind::Audio => Ok(kind),
        proto::AttachmentKind::Document | proto::AttachmentKind::Video if voice_note => Err(
            CommandError::invalid_argument("voice_note is only valid for audio attachments"),
        ),
        proto::AttachmentKind::Document | proto::AttachmentKind::Video => Ok(kind),
    }
}

fn canonical_media_file(data_dir: &Path, requested: &Path) -> Result<PathBuf, CommandError> {
    let media_root = std::fs::canonicalize(data_dir.join("media")).map_err(|error| {
        CommandError::invalid_argument(format!("media cache is unavailable: {error}"))
    })?;
    let target = std::fs::canonicalize(requested).map_err(|error| {
        CommandError::invalid_argument(format!("media file is unavailable: {error}"))
    })?;
    if !target.starts_with(&media_root) {
        return Err(CommandError::invalid_argument(
            "media path is outside the managed cache",
        ));
    }
    let metadata = std::fs::metadata(&target)
        .map_err(|error| CommandError::invalid_argument(format!("inspect media file: {error}")))?;
    if !metadata.is_file() {
        return Err(CommandError::invalid_argument(
            "media path does not identify a file",
        ));
    }
    Ok(target)
}

fn configure_asset_protocol_scope(
    scope: &tauri::scope::fs::Scope,
    data_dir: &Path,
) -> tauri::Result<()> {
    // Media may contain managed subdirectories, while avatar cache files are
    // always written directly under `avatars`. Keep the avatar grant
    // non-recursive so a rendered profile photo does not broaden filesystem
    // access beyond the backend-owned cache.
    scope.allow_directory(data_dir.join("media"), true)?;
    scope.allow_directory(data_dir.join("avatars"), false)?;
    Ok(())
}

#[tauri::command]
async fn subscribe_backend(
    state: tauri::State<'_, BridgeService>,
    on_event: Channel<FrontendEvent>,
) -> Result<(), CommandError> {
    state.subscribe(on_event).await;
    Ok(())
}

#[tauri::command]
fn open_media_path(app: tauri::AppHandle, path: String) -> Result<(), CommandError> {
    let target = canonical_media_file(&paths::data_dir(), Path::new(&path))?;
    let target = target
        .to_str()
        .ok_or_else(|| CommandError::invalid_argument("media path must be valid UTF-8"))?
        .to_owned();
    app.opener()
        .open_path(target, None::<String>)
        .map_err(|error| CommandError::open_failed(format!("open media file: {error}")))
}

fn restart_app(app: tauri::AppHandle) -> ! {
    app.restart()
}

// Tauri's generated response adapter cannot serialize Rust's never type. Keep
// the divergent operation explicit, while exposing a unit-returning IPC shim
// under the public `restart_app` command name.
#[tauri::command(rename = "restart_app")]
fn restart_app_command(app: tauri::AppHandle) {
    restart_app(app)
}

#[tauri::command]
async fn hello(
    state: tauri::State<'_, BridgeService>,
) -> Result<proto::HelloResponse, CommandError> {
    let result = state
        .request(
            rpc_request::Request::Hello(proto::HelloRequest {
                desktop_version: env!("CARGO_PKG_VERSION").into(),
                minimum_protocol_version: bridge::PROTOCOL_VERSION,
                maximum_protocol_version: bridge::PROTOCOL_VERSION,
            }),
            CONTROL_TIMEOUT,
        )
        .await?;
    expect_response!(result, Hello)
}

#[tauri::command]
async fn get_auth_state(
    state: tauri::State<'_, BridgeService>,
) -> Result<proto::AuthStateResponse, CommandError> {
    let result = state
        .request(
            rpc_request::Request::GetAuthState(proto::GetAuthStateRequest {}),
            CONTROL_TIMEOUT,
        )
        .await?;
    expect_response!(result, AuthState)
}

#[tauri::command]
async fn start_pairing(
    state: tauri::State<'_, BridgeService>,
) -> Result<proto::StartPairingResponse, CommandError> {
    let result = state
        .request(
            rpc_request::Request::StartPairing(proto::StartPairingRequest {}),
            WRITE_TIMEOUT,
        )
        .await?;
    expect_response!(result, StartPairing)
}

#[tauri::command]
async fn list_chats(
    state: tauri::State<'_, BridgeService>,
    cursor: String,
    limit: u32,
) -> Result<proto::ListChatsResponse, CommandError> {
    let result = state
        .request(
            rpc_request::Request::ListChats(proto::ListChatsRequest { cursor, limit }),
            READ_TIMEOUT,
        )
        .await?;
    expect_response!(result, ListChats)
}

#[tauri::command]
async fn list_messages(
    state: tauri::State<'_, BridgeService>,
    chat_id: String,
    before_timestamp_ms: i64,
    before_message_id: String,
    limit: u32,
) -> Result<proto::ListMessagesResponse, CommandError> {
    let result = state
        .request(
            rpc_request::Request::ListMessages(proto::ListMessagesRequest {
                chat_id,
                before_timestamp_ms,
                before_message_id,
                limit,
            }),
            READ_TIMEOUT,
        )
        .await?;
    expect_response!(result, ListMessages)
}

#[tauri::command]
async fn open_message_window(
    state: tauri::State<'_, BridgeService>,
    chat_id: String,
) -> Result<proto::OpenMessageWindowResponse, CommandError> {
    let result = state
        .request(
            rpc_request::Request::OpenMessageWindow(proto::OpenMessageWindowRequest { chat_id }),
            READ_TIMEOUT,
        )
        .await?;
    expect_response!(result, OpenMessageWindow)
}

#[tauri::command]
async fn list_messages_after(
    state: tauri::State<'_, BridgeService>,
    chat_id: String,
    after_timestamp_ms: i64,
    after_message_id: String,
    limit: u32,
) -> Result<proto::ListMessagesAfterResponse, CommandError> {
    let result = state
        .request(
            rpc_request::Request::ListMessagesAfter(proto::ListMessagesAfterRequest {
                chat_id,
                after_timestamp_ms,
                after_message_id,
                limit,
            }),
            READ_TIMEOUT,
        )
        .await?;
    expect_response!(result, ListMessagesAfter)
}

#[tauri::command]
async fn search_local(
    state: tauri::State<'_, BridgeService>,
    query: String,
) -> Result<proto::SearchLocalResponse, CommandError> {
    let result = state
        .request(
            rpc_request::Request::SearchLocal(proto::SearchLocalRequest { query }),
            READ_TIMEOUT,
        )
        .await?;
    expect_response!(result, SearchLocal)
}

#[tauri::command]
async fn open_contact(
    state: tauri::State<'_, BridgeService>,
    contact_jid: String,
) -> Result<proto::OpenContactResponse, CommandError> {
    let result = state
        .request(
            rpc_request::Request::OpenContact(proto::OpenContactRequest { contact_jid }),
            READ_TIMEOUT,
        )
        .await?;
    expect_response!(result, OpenContact)
}

#[tauri::command]
async fn list_messages_around(
    state: tauri::State<'_, BridgeService>,
    chat_id: String,
    message_id: String,
) -> Result<proto::ListMessagesAroundResponse, CommandError> {
    let result = state
        .request(
            rpc_request::Request::ListMessagesAround(proto::ListMessagesAroundRequest {
                chat_id,
                message_id,
            }),
            READ_TIMEOUT,
        )
        .await?;
    expect_response!(result, ListMessagesAround)
}

#[tauri::command]
async fn send_text(
    state: tauri::State<'_, BridgeService>,
    chat_id: String,
    text: String,
    reply_to_message_id: String,
    mentioned_jids: Vec<String>,
) -> Result<proto::SendTextResponse, CommandError> {
    let result = state
        .request(
            rpc_request::Request::SendText(proto::SendTextRequest {
                client_message_id: uuid::Uuid::new_v4().to_string(),
                chat_id,
                text,
                reply_to_message_id,
                mentioned_jids,
            }),
            WRITE_TIMEOUT,
        )
        .await?;
    expect_response!(result, SendText)
}

#[tauri::command]
async fn send_image(
    state: tauri::State<'_, BridgeService>,
    chat_id: String,
    image_path: String,
    caption: String,
    reply_to_message_id: String,
) -> Result<proto::SendImageResponse, CommandError> {
    let result = state
        .request(
            rpc_request::Request::SendImage(proto::SendImageRequest {
                client_message_id: uuid::Uuid::new_v4().to_string(),
                chat_id,
                image_path,
                caption,
                reply_to_message_id,
            }),
            WRITE_TIMEOUT,
        )
        .await?;
    expect_response!(result, SendImage)
}

#[tauri::command]
async fn send_sticker(
    state: tauri::State<'_, BridgeService>,
    chat_id: String,
    image_path: String,
    reply_to_message_id: String,
) -> Result<proto::SendStickerResponse, CommandError> {
    let prepared = tauri::async_runtime::spawn_blocking(move || {
        sticker::prepare(std::path::Path::new(&image_path))
    })
    .await
    .map_err(|error| CommandError::transport(format!("sticker worker failed: {error}")))?
    .map_err(CommandError::protocol)?;

    let result = state
        .request(
            rpc_request::Request::SendSticker(proto::SendStickerRequest {
                client_message_id: uuid::Uuid::new_v4().to_string(),
                chat_id,
                webp_data: prepared.webp_data,
                reply_to_message_id,
            }),
            WRITE_TIMEOUT,
        )
        .await?;
    expect_response!(result, SendSticker)
}

#[tauri::command]
async fn get_message_image(
    state: tauri::State<'_, BridgeService>,
    chat_id: String,
    message_id: String,
) -> Result<proto::GetMessageImageResponse, CommandError> {
    let result = state
        .request(
            rpc_request::Request::GetMessageImage(proto::GetMessageImageRequest {
                chat_id,
                message_id,
            }),
            READ_TIMEOUT,
        )
        .await?;
    expect_response!(result, GetMessageImage)
}

#[tauri::command]
async fn get_message_attachment(
    state: tauri::State<'_, BridgeService>,
    chat_id: String,
    message_id: String,
) -> Result<proto::GetMessageAttachmentResponse, CommandError> {
    let result = state
        .request(
            rpc_request::Request::GetMessageAttachment(proto::GetMessageAttachmentRequest {
                chat_id,
                message_id,
            }),
            ATTACHMENT_TIMEOUT,
        )
        .await?;
    expect_response!(result, GetMessageAttachment)
}

#[tauri::command]
async fn send_attachment(
    state: tauri::State<'_, BridgeService>,
    chat_id: String,
    file_path: String,
    kind: i32,
    caption: String,
    reply_to_message_id: String,
    voice_note: bool,
) -> Result<proto::SendAttachmentResponse, CommandError> {
    let kind = validate_attachment_kind(kind, &caption, voice_note)?;
    let result = state
        .request(
            rpc_request::Request::SendAttachment(proto::SendAttachmentRequest {
                client_message_id: uuid::Uuid::new_v4().to_string(),
                chat_id,
                file_path,
                kind: kind as i32,
                caption,
                reply_to_message_id,
                voice_note,
            }),
            ATTACHMENT_TIMEOUT,
        )
        .await?;
    expect_response!(result, SendAttachment)
}

#[tauri::command]
async fn mark_read(
    state: tauri::State<'_, BridgeService>,
    chat_id: String,
    through_message_id: String,
) -> Result<proto::MarkReadResponse, CommandError> {
    let result = state
        .request(
            rpc_request::Request::MarkRead(proto::MarkReadRequest {
                chat_id,
                through_message_id,
            }),
            WRITE_TIMEOUT,
        )
        .await?;
    expect_response!(result, MarkRead)
}

#[tauri::command]
async fn get_chat_avatar(
    state: tauri::State<'_, BridgeService>,
    chat_id: String,
) -> Result<proto::GetChatAvatarResponse, CommandError> {
    let result = state
        .request(
            rpc_request::Request::GetChatAvatar(proto::GetChatAvatarRequest { chat_id }),
            READ_TIMEOUT,
        )
        .await?;
    expect_response!(result, GetChatAvatar)
}

#[tauri::command]
async fn send_reaction(
    state: tauri::State<'_, BridgeService>,
    chat_id: String,
    message_id: String,
    emoji: String,
) -> Result<proto::SendReactionResponse, CommandError> {
    let result = state
        .request(
            rpc_request::Request::SendReaction(proto::SendReactionRequest {
                chat_id,
                message_id,
                emoji,
                client_reaction_id: uuid::Uuid::new_v4().to_string(),
            }),
            WRITE_TIMEOUT,
        )
        .await?;
    expect_response!(result, SendReaction)
}

#[tauri::command]
async fn get_chat_info(
    state: tauri::State<'_, BridgeService>,
    chat_id: String,
) -> Result<proto::GetChatInfoResponse, CommandError> {
    let result = state
        .request(
            rpc_request::Request::GetChatInfo(proto::GetChatInfoRequest { chat_id }),
            READ_TIMEOUT,
        )
        .await?;
    expect_response!(result, GetChatInfo)
}

#[tauri::command]
async fn get_participant_avatar(
    state: tauri::State<'_, BridgeService>,
    participant_id: String,
) -> Result<proto::GetParticipantAvatarResponse, CommandError> {
    let result = state
        .request(
            rpc_request::Request::GetParticipantAvatar(proto::GetParticipantAvatarRequest {
                participant_id,
            }),
            READ_TIMEOUT,
        )
        .await?;
    expect_response!(result, GetParticipantAvatar)
}

#[tauri::command]
async fn repair_recent_reactions(
    state: tauri::State<'_, BridgeService>,
    chat_id: String,
) -> Result<proto::RepairRecentReactionsResponse, CommandError> {
    let result = state
        .request(
            rpc_request::Request::RepairRecentReactions(proto::RepairRecentReactionsRequest {
                chat_id,
            }),
            WRITE_TIMEOUT,
        )
        .await?;
    expect_response!(result, RepairRecentReactions)
}

#[tauri::command]
async fn set_typing(
    state: tauri::State<'_, BridgeService>,
    chat_id: String,
    composing: bool,
) -> Result<proto::SetTypingResponse, CommandError> {
    let result = state
        .request(
            rpc_request::Request::SetTyping(proto::SetTypingRequest {
                chat_id,
                typing: composing,
            }),
            WRITE_TIMEOUT,
        )
        .await?;
    expect_response!(result, SetTyping)
}

#[tauri::command]
async fn logout(
    state: tauri::State<'_, BridgeService>,
) -> Result<proto::LogoutResponse, CommandError> {
    let result = state
        .request(
            rpc_request::Request::Logout(proto::LogoutRequest {}),
            WRITE_TIMEOUT,
        )
        .await?;
    expect_response!(result, Logout)
}

pub fn run() {
    tauri::Builder::default()
        // This must be the first plugin: a second process must exit before the
        // setup hook starts another sidecar against the same data directory.
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.show();
                let _ = window.set_focus();
            }
        }))
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .setup(|app| {
            configure_asset_protocol_scope(&app.asset_protocol_scope(), &paths::data_dir())?;
            let fake = std::env::args().any(|argument| argument == "--fake-backend");
            app.manage(BridgeService::start(fake)?);
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            subscribe_backend,
            open_media_path,
            restart_app_command,
            hello,
            get_auth_state,
            start_pairing,
            list_chats,
            list_messages,
            open_message_window,
            list_messages_after,
            search_local,
            open_contact,
            list_messages_around,
            send_text,
            send_image,
            send_sticker,
            send_attachment,
            get_message_image,
            get_message_attachment,
            mark_read,
            get_chat_avatar,
            send_reaction,
            get_chat_info,
            get_participant_avatar,
            repair_recent_reactions,
            set_typing,
            logout,
        ])
        .run(tauri::generate_context!())
        .expect("error while running Rust Meow");
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn event_sequence_accepts_ordered_events_and_reports_gaps() {
        let mut sequence = EventSequence::default();
        assert_eq!(
            sequence.observe(5),
            SequenceObservation::Gap {
                expected: 1,
                received: 5,
            }
        );
        assert_eq!(sequence.observe(5), SequenceObservation::Stale);
        assert_eq!(sequence.observe(0), SequenceObservation::Invalid);
        assert_eq!(
            sequence.observe(7),
            SequenceObservation::Gap {
                expected: 6,
                received: 7,
            }
        );
        assert_eq!(sequence.observe(8), SequenceObservation::Accept);
    }

    #[test]
    fn canonical_media_file_enforces_the_managed_cache_boundary() {
        let root = tempfile::tempdir().unwrap();
        let media = root.path().join("media");
        let nested = media.join("attachments");
        std::fs::create_dir_all(&nested).unwrap();
        let inside = nested.join("message.bin");
        std::fs::write(&inside, b"managed media").unwrap();

        assert_eq!(
            canonical_media_file(root.path(), &inside).unwrap(),
            std::fs::canonicalize(&inside).unwrap()
        );
        assert!(canonical_media_file(root.path(), &media).is_err());

        let outside = root.path().join("outside.bin");
        std::fs::write(&outside, b"outside media").unwrap();
        assert!(canonical_media_file(root.path(), &outside).is_err());
    }

    #[cfg(unix)]
    #[test]
    fn canonical_media_file_rejects_symlinks_that_escape_the_cache() {
        use std::os::unix::fs::symlink;

        let root = tempfile::tempdir().unwrap();
        let media = root.path().join("media");
        std::fs::create_dir_all(&media).unwrap();
        let outside = root.path().join("outside.bin");
        std::fs::write(&outside, b"outside media").unwrap();
        let link = media.join("escaped.bin");
        symlink(&outside, &link).unwrap();

        assert!(canonical_media_file(root.path(), &link).is_err());
    }

    #[test]
    fn asset_protocol_scope_allows_only_managed_media_and_direct_avatar_files() {
        let root = tempfile::tempdir().unwrap();
        let media = root.path().join("media");
        let media_nested = media.join("attachments");
        let avatars = root.path().join("avatars");
        let avatar_nested = avatars.join("unexpected");
        std::fs::create_dir_all(&media_nested).unwrap();
        std::fs::create_dir_all(&avatar_nested).unwrap();

        let media_file = media_nested.join("message.bin");
        let avatar_file = avatars.join("profile.jpg");
        let nested_avatar_file = avatar_nested.join("profile.jpg");
        let unrelated_file = root.path().join("client.db");
        for path in [
            &media_file,
            &avatar_file,
            &nested_avatar_file,
            &unrelated_file,
        ] {
            std::fs::write(path, b"test").unwrap();
        }

        let app = tauri::test::mock_app();
        let scope = app.asset_protocol_scope();
        configure_asset_protocol_scope(&scope, root.path()).unwrap();

        assert!(scope.is_allowed(&media_file));
        assert!(scope.is_allowed(&avatar_file));
        assert!(!scope.is_allowed(&nested_avatar_file));
        assert!(!scope.is_allowed(&unrelated_file));
    }

    #[test]
    fn frontend_event_serialization_preserves_backend_sequence() {
        let event = Option::<FrontendEvent>::from(proto::BackendEvent {
            sequence: 42,
            event: Some(proto::backend_event::Event::ConnectionChanged(
                proto::ConnectionChanged {
                    detail: "connected".into(),
                    ..Default::default()
                },
            )),
        })
        .unwrap();
        let value = serde_json::to_value(event).unwrap();
        assert_eq!(value["sequence"], 42);
        assert_eq!(value["type"], "connectionChanged");
        assert_eq!(value["payload"]["detail"], "connected");

        let warning = serde_json::to_value(FrontendEvent::problem(
            "event_sequence_gap",
            "refresh required".into(),
        ))
        .unwrap();
        assert_eq!(warning["sequence"], 0);
        assert_eq!(warning["type"], "problem");
        assert_eq!(warning["payload"]["code"], "event_sequence_gap");
    }

    #[test]
    fn attachment_validation_matches_backend_contract() {
        assert!(
            validate_attachment_kind(proto::AttachmentKind::Document as i32, "caption", false)
                .is_ok()
        );
        assert!(
            validate_attachment_kind(proto::AttachmentKind::Video as i32, "caption", false).is_ok()
        );
        assert!(validate_attachment_kind(proto::AttachmentKind::Audio as i32, "", true).is_ok());
        for error in [
            validate_attachment_kind(proto::AttachmentKind::Unspecified as i32, "", false)
                .unwrap_err(),
            validate_attachment_kind(999, "", false).unwrap_err(),
            validate_attachment_kind(proto::AttachmentKind::Audio as i32, "caption", false)
                .unwrap_err(),
            validate_attachment_kind(proto::AttachmentKind::Document as i32, "", true).unwrap_err(),
        ] {
            assert_eq!(error.code, "invalid_argument");
            assert!(!error.retryable);
        }
    }
}
