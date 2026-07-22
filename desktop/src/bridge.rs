use std::{
    env,
    io::{BufRead, BufReader, Read, Write},
    path::{Path, PathBuf},
    process::{Child, Command, Stdio},
    sync::{
        Arc, Mutex,
        atomic::{AtomicBool, Ordering},
    },
    thread,
};

use anyhow::{Context as _, Result, bail};
use prost::Message as _;

use crate::proto::{self, envelope, rpc_request, rpc_response};

pub const PROTOCOL_VERSION: u32 = 14;
const MAX_FRAME_BYTES: usize = 8 * 1024 * 1024;

#[derive(Debug)]
pub enum BridgeMessage {
    Envelope(Box<proto::Envelope>),
    Exited(BridgeExit),
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum BridgeExitKind {
    Transient,
    Fatal,
}

#[derive(Clone, Debug)]
pub struct BridgeExit {
    pub kind: BridgeExitKind,
    pub message: String,
}

const MAX_EXIT_DIAGNOSTIC_BYTES: usize = 8 * 1024;

pub struct BackendClient {
    outgoing: async_channel::Sender<proto::Envelope>,
    pub incoming: async_channel::Receiver<BridgeMessage>,
    child: Option<Arc<Mutex<Child>>>,
}

impl BackendClient {
    pub fn start(fake: bool) -> Result<Self> {
        if fake {
            return Ok(Self::fake());
        }
        let executable = backend_executable()?;
        let data_dir = crate::paths::data_dir();
        std::fs::create_dir_all(&data_dir)
            .with_context(|| format!("create app data directory {}", data_dir.display()))?;
        let log_file = data_dir.join("backend.log");
        let mut child = Command::new(&executable)
            .arg("--stdio")
            .arg("--data-dir")
            .arg(&data_dir)
            .arg("--log-file")
            .arg(log_file)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .with_context(|| format!("start backend {}", executable.display()))?;

        let stdin = child.stdin.take().context("backend stdin unavailable")?;
        let stdout = child.stdout.take().context("backend stdout unavailable")?;
        let stderr = child.stderr.take().context("backend stderr unavailable")?;
        let child = Arc::new(Mutex::new(child));
        let diagnostics = Arc::new(Mutex::new(String::new()));
        let (outgoing, outgoing_rx) = async_channel::bounded(256);
        let (incoming_tx, incoming) = async_channel::bounded(1024);

        thread::Builder::new()
            .name("bridge-writer".into())
            .spawn(move || writer_loop(stdin, outgoing_rx))?;
        let stderr_thread = thread::Builder::new().name("bridge-stderr".into()).spawn({
            let diagnostics = diagnostics.clone();
            move || capture_stderr(stderr, diagnostics)
        })?;
        let reader_child = child.clone();
        thread::Builder::new()
            .name("bridge-reader".into())
            .spawn(move || {
                if let Err(error) = reader_loop(stdout, &incoming_tx) {
                    let status = reader_child
                        .lock()
                        .ok()
                        .and_then(|mut child| child.wait().ok())
                        .map(|status| status.to_string());
                    let _ = stderr_thread.join();
                    let diagnostic = diagnostics
                        .lock()
                        .map(|value| value.clone())
                        .unwrap_or_default();
                    let message = match (diagnostic.trim(), status) {
                        ("", Some(status)) => format!("{error}; backend {status}"),
                        ("", None) => error.to_string(),
                        (diagnostic, Some(status)) => format!("{diagnostic}; backend {status}"),
                        (diagnostic, None) => diagnostic.to_owned(),
                    };
                    let _ = incoming_tx.send_blocking(BridgeMessage::Exited(BridgeExit {
                        kind: classify_exit(&message),
                        message,
                    }));
                }
            })?;

        Ok(Self {
            outgoing,
            incoming,
            child: Some(child),
        })
    }

    pub fn send(&self, request_id: u64, request: rpc_request::Request) -> Result<()> {
        self.outgoing
            .try_send(proto::Envelope {
                protocol_version: PROTOCOL_VERSION,
                request_id,
                body: Some(envelope::Body::Request(proto::RpcRequest {
                    request: Some(request),
                })),
            })
            .context("backend writer unavailable or backpressured")
    }

    pub fn disconnected() -> Self {
        let (outgoing, _) = async_channel::bounded(1);
        let (_, incoming) = async_channel::bounded(1);
        outgoing.close();
        Self {
            outgoing,
            incoming,
            child: None,
        }
    }

    /// Stop accepting new work, request a graceful backend shutdown, and
    /// independently guarantee the child is reaped after the grace period.
    pub fn shutdown(&self) {
        let _ = self.send(
            u64::MAX,
            rpc_request::Request::Shutdown(proto::ShutdownRequest {}),
        );
        self.outgoing.close();
        if let Some(child) = &self.child {
            spawn_reaper(child.clone());
        }
    }

    fn fake() -> Self {
        let (outgoing, outgoing_rx) = async_channel::bounded(256);
        let (incoming_tx, incoming) = async_channel::bounded(1024);
        let event_sequence = Arc::new(Mutex::new(1_u64));
        let handshaken = Arc::new(AtomicBool::new(false));
        let live_incoming = incoming_tx.clone();
        let live_sequence = event_sequence.clone();
        let live_handshaken = handshaken.clone();
        thread::Builder::new()
            .name("fake-live-events".into())
            .spawn(move || fake_live_loop(live_incoming, live_sequence, live_handshaken))
            .expect("spawn fake live events");
        thread::Builder::new()
            .name("fake-backend".into())
            .spawn(move || fake_loop(outgoing_rx, incoming_tx, event_sequence, handshaken))
            .expect("spawn fake backend");
        Self {
            outgoing,
            incoming,
            child: None,
        }
    }
}

fn capture_stderr(stderr: impl Read, diagnostics: Arc<Mutex<String>>) {
    for line in BufReader::new(stderr).lines().map_while(Result::ok) {
        eprintln!("rust-meow-backend: {line}");
        if let Ok(mut captured) = diagnostics.lock() {
            if captured.len() + line.len() + 1 > MAX_EXIT_DIAGNOSTIC_BYTES {
                let remove = (captured.len() + line.len() + 1 - MAX_EXIT_DIAGNOSTIC_BYTES)
                    .min(captured.len());
                captured.drain(..remove);
            }
            captured.push_str(&line);
            captured.push('\n');
        }
    }
}

pub fn classify_exit(message: &str) -> BridgeExitKind {
    let message = message.to_ascii_lowercase();
    if [
        "unsupported_protocol",
        "protocol version",
        "profile is already in use",
        "database disk image is malformed",
        "file is not a database",
        "database corruption",
    ]
    .iter()
    .any(|needle| message.contains(needle))
    {
        BridgeExitKind::Fatal
    } else {
        BridgeExitKind::Transient
    }
}

impl Drop for BackendClient {
    fn drop(&mut self) {
        self.shutdown();
    }
}

fn spawn_reaper(child: Arc<Mutex<Child>>) {
    let _ = thread::Builder::new()
        .name("backend-reaper".into())
        .spawn(move || {
            if let Ok(mut child) = child.lock() {
                let deadline = std::time::Instant::now() + std::time::Duration::from_secs(3);
                while std::time::Instant::now() < deadline {
                    if child.try_wait().ok().flatten().is_some() {
                        return;
                    }
                    thread::sleep(std::time::Duration::from_millis(25));
                }
                let _ = child.kill();
                let _ = child.wait();
            }
        });
}

fn writer_loop(mut writer: impl Write, outgoing: async_channel::Receiver<proto::Envelope>) {
    while let Ok(envelope) = outgoing.recv_blocking() {
        if write_frame(&mut writer, &envelope).is_err() {
            break;
        }
    }
}

fn reader_loop(
    mut reader: impl Read,
    incoming: &async_channel::Sender<BridgeMessage>,
) -> Result<()> {
    loop {
        let envelope = read_frame(&mut reader)?;
        if envelope.protocol_version != PROTOCOL_VERSION {
            bail!(
                "backend sent protocol version {} after v{PROTOCOL_VERSION} handshake",
                envelope.protocol_version
            );
        }
        if envelope.body.is_none() {
            bail!("backend sent envelope without a body");
        }
        incoming
            .send_blocking(BridgeMessage::Envelope(Box::new(envelope)))
            .context("desktop receiver stopped")?;
    }
}

fn write_frame(writer: &mut impl Write, envelope: &proto::Envelope) -> Result<()> {
    let bytes = envelope.encode_to_vec();
    if bytes.len() > MAX_FRAME_BYTES {
        bail!("outgoing frame exceeds {MAX_FRAME_BYTES} bytes");
    }
    writer.write_all(&(bytes.len() as u32).to_be_bytes())?;
    writer.write_all(&bytes)?;
    writer.flush()?;
    Ok(())
}

fn read_frame(reader: &mut impl Read) -> Result<proto::Envelope> {
    let mut prefix = [0_u8; 4];
    reader.read_exact(&mut prefix)?;
    let length = u32::from_be_bytes(prefix) as usize;
    if length == 0 || length > MAX_FRAME_BYTES {
        bail!("invalid bridge frame length {length}");
    }
    let mut payload = vec![0; length];
    reader.read_exact(&mut payload)?;
    proto::Envelope::decode(payload.as_slice()).context("decode bridge envelope")
}

fn backend_executable() -> Result<PathBuf> {
    if let Some(path) = env::var_os("RUST_MEOW_BACKEND") {
        return Ok(path.into());
    }
    let current = env::current_exe().context("resolve desktop executable")?;
    let name = if cfg!(windows) {
        "rust-meow-backend.exe"
    } else {
        "rust-meow-backend"
    };
    Ok(current.parent().unwrap_or(Path::new(".")).join(name))
}

fn fake_loop(
    outgoing: async_channel::Receiver<proto::Envelope>,
    incoming: async_channel::Sender<BridgeMessage>,
    event_sequence: Arc<Mutex<u64>>,
    handshaken: Arc<AtomicBool>,
) {
    let pairing = env::var_os("RUST_MEOW_FAKE_PAIRING").is_some();
    while let Ok(envelope) = outgoing.recv_blocking() {
        let request_id = envelope.request_id;
        let Some(envelope::Body::Request(request)) = envelope.body else {
            continue;
        };
        let is_hello = matches!(
            request.request.as_ref(),
            Some(rpc_request::Request::Hello(_))
        );
        let result = match request.request {
            Some(rpc_request::Request::Hello(_)) => {
                rpc_response::Result::Hello(proto::HelloResponse {
                    backend_version: "fake-0.1".into(),
                    protocol_version: PROTOCOL_VERSION,
                })
            }
            Some(rpc_request::Request::GetAuthState(_)) => {
                rpc_response::Result::AuthState(proto::AuthStateResponse {
                    paired: !pairing,
                    logged_in: !pairing,
                    own_user_id: "me@s.whatsapp.net".into(),
                    connection_state: if pairing {
                        proto::ConnectionState::Pairing as i32
                    } else {
                        proto::ConnectionState::Connected as i32
                    },
                })
            }
            Some(rpc_request::Request::StartPairing(_)) => {
                emit_fake_event(
                    &incoming,
                    &event_sequence,
                    proto::backend_event::Event::PairingQr(proto::PairingQr {
                        code: "2@RUST-MEOW-FAKE-PAIRING-CODE".into(),
                        expires_at_ms: 4_102_444_800_000,
                    }),
                );
                rpc_response::Result::StartPairing(proto::StartPairingResponse { started: true })
            }
            Some(rpc_request::Request::ListChats(request)) => {
                let start = request.cursor.parse::<usize>().unwrap_or(0);
                let limit = request.limit.min(100) as usize;
                let total = 10_000_usize;
                let chats = (start..(start + limit).min(total)).map(fake_chat).collect();
                let next = if start + limit < total {
                    (start + limit).to_string()
                } else {
                    String::new()
                };
                rpc_response::Result::ListChats(proto::ListChatsResponse {
                    chats,
                    total_count: total as u64,
                    next_cursor: next,
                })
            }
            Some(rpc_request::Request::ListMessages(request)) => {
                let end = if request.before_timestamp_ms == 0 {
                    1_000
                } else {
                    request.before_timestamp_ms as usize
                };
                let start = end.saturating_sub(request.limit as usize);
                let messages = (start..end)
                    .map(|id| fake_message(&request.chat_id, id))
                    .collect();
                rpc_response::Result::ListMessages(proto::ListMessagesResponse {
                    messages,
                    has_more: start > 0,
                })
            }
            Some(rpc_request::Request::OpenMessageWindow(request)) => {
                let anchor = 950_usize;
                let start = anchor.saturating_sub(25);
                let end = (anchor + 26).min(1_000);
                rpc_response::Result::OpenMessageWindow(proto::OpenMessageWindowResponse {
                    messages: (start..end)
                        .map(|id| fake_message(&request.chat_id, id))
                        .collect(),
                    has_older: start > 0,
                    has_newer: end < 1_000,
                    first_unread_message_id: format!("message-{anchor}"),
                })
            }
            Some(rpc_request::Request::ListMessagesAfter(request)) => {
                let start = request
                    .after_message_id
                    .strip_prefix("message-")
                    .and_then(|value| value.parse::<usize>().ok())
                    .map_or(0, |id| id + 1);
                let end = (start + request.limit as usize).min(1_000);
                rpc_response::Result::ListMessagesAfter(proto::ListMessagesAfterResponse {
                    messages: (start..end)
                        .map(|id| fake_message(&request.chat_id, id))
                        .collect(),
                    has_more: end < 1_000,
                })
            }
            Some(rpc_request::Request::SearchLocal(request)) => {
                let query = request.query.to_lowercase();
                let contacts = (0..8)
                    .filter_map(|id| {
                        let chat = fake_chat(id);
                        (chat.title.to_lowercase().contains(&query)
                            || chat.phone_number.contains(&query))
                        .then_some(proto::ContactSearchResult {
                            contact_jid: format!("1555{id:07}@s.whatsapp.net"),
                            chat_id: chat.id,
                            display_name: chat.title,
                            secondary_name: chat.push_name,
                            phone_number: chat.phone_number,
                        })
                    })
                    .take(8)
                    .collect();
                let groups = (0..40)
                    .filter(|id| *id % 5 == 0)
                    .map(fake_chat)
                    .filter(|chat| chat.title.to_lowercase().contains(&query))
                    .take(6)
                    .collect();
                let messages = if query.chars().count() >= 3 {
                    (975..1_000)
                        .map(|id| {
                            let chat = fake_chat(id % 20);
                            proto::MessageSearchResult {
                                chat_id: chat.id.clone(),
                                message_id: format!("message-{id}"),
                                chat_title: chat.title.clone(),
                                sender_name: if id.is_multiple_of(2) {
                                    "You"
                                } else {
                                    "Meow friend"
                                }
                                .into(),
                                timestamp_ms: id as i64,
                                snippet: format!("Fast native message {id} matching {query}"),
                                kind: "text".into(),
                                archived: chat.archived,
                                chat: Some(chat),
                            }
                        })
                        .take(20)
                        .collect()
                } else {
                    Vec::new()
                };
                rpc_response::Result::SearchLocal(proto::SearchLocalResponse {
                    contacts,
                    groups,
                    messages,
                })
            }
            Some(rpc_request::Request::OpenContact(_request)) => {
                let mut chat = fake_chat(10_001);
                chat.title = "New WhatsApp contact".into();
                rpc_response::Result::OpenContact(proto::OpenContactResponse { chat: Some(chat) })
            }
            Some(rpc_request::Request::ListMessagesAround(request)) => {
                let anchor = request
                    .message_id
                    .strip_prefix("message-")
                    .and_then(|value| value.parse::<usize>().ok())
                    .unwrap_or(500);
                let start = anchor.saturating_sub(25);
                let end = (anchor + 26).min(1_000);
                rpc_response::Result::ListMessagesAround(proto::ListMessagesAroundResponse {
                    messages: (start..end)
                        .map(|id| fake_message(&request.chat_id, id))
                        .collect(),
                    has_older: start > 0,
                    has_newer: end < 1_000,
                    anchor_message_id: request.message_id,
                })
            }
            Some(rpc_request::Request::GetChatAvatar(request)) => {
                rpc_response::Result::GetChatAvatar(proto::GetChatAvatarResponse {
                    chat_id: request.chat_id,
                    avatar_path: String::new(),
                })
            }
            Some(rpc_request::Request::GetParticipantAvatar(request)) => {
                rpc_response::Result::GetParticipantAvatar(proto::GetParticipantAvatarResponse {
                    participant_id: request.participant_id,
                    avatar_path: String::new(),
                })
            }
            Some(rpc_request::Request::GetChatInfo(request)) => {
                let id = request
                    .chat_id
                    .strip_prefix("chat-")
                    .and_then(|value| value.parse::<usize>().ok())
                    .unwrap_or(0);
                let chat = fake_chat(id);
                let group = chat.kind == proto::ChatKind::Group as i32;
                let participants: Vec<proto::ChatParticipant> = if group {
                    (0..12)
                        .map(|index| proto::ChatParticipant {
                            participant_id: format!("1555{index:07}@s.whatsapp.net"),
                            display_name: format!("Meow friend {index}"),
                            phone_number: format!("+1555{index:07}"),
                            is_admin: index < 2,
                            is_super_admin: index == 0,
                            is_me: index == 3,
                        })
                        .collect()
                } else {
                    Vec::new()
                };
                rpc_response::Result::GetChatInfo(proto::GetChatInfoResponse {
                    address: if group {
                        format!("1234567890-{id}@g.us")
                    } else {
                        format!("1555{id:07}@s.whatsapp.net")
                    },
                    about: if group {
                        String::new()
                    } else {
                        "Hey there! I am using Rust Meow.".into()
                    },
                    verified_name: if !group && id.is_multiple_of(3) {
                        format!("Meow Business {id}")
                    } else {
                        String::new()
                    },
                    description: if group {
                        format!("Planning the weekend, one message at a time. Group {id}.")
                    } else {
                        String::new()
                    },
                    created_at_ms: if group { 1_712_345_678_000 } else { 0 },
                    created_by: if group {
                        "Meow friend 0".into()
                    } else {
                        String::new()
                    },
                    participant_count: participants.len() as u32,
                    participants,
                    announce_only: group && id.is_multiple_of(10),
                    locked: group && id.is_multiple_of(15),
                    disappearing_timer_seconds: if group && id.is_multiple_of(20) {
                        7 * 24 * 3600
                    } else {
                        0
                    },
                    is_community: false,
                    join_approval_required: group && id.is_multiple_of(25),
                    chat: Some(chat),
                })
            }
            Some(rpc_request::Request::SendText(request)) => {
                rpc_response::Result::SendText(proto::SendTextResponse {
                    message: Some(proto::Message {
                        id: request.client_message_id,
                        chat_id: request.chat_id,
                        sender_id: "me@s.whatsapp.net".into(),
                        sender_name: "You".into(),
                        from_me: true,
                        timestamp_ms: 1_900_000_000_000,
                        status: proto::MessageStatus::Sent as i32,
                        content: Some(proto::message::Content::Text(proto::TextContent {
                            text: request.text,
                            link_preview: None,
                        })),
                        reply_to_message_id: request.reply_to_message_id,
                        ..Default::default()
                    }),
                })
            }
            Some(rpc_request::Request::SendImage(request)) => {
                rpc_response::Result::SendImage(proto::SendImageResponse {
                    message: Some(proto::Message {
                        id: request.client_message_id,
                        chat_id: request.chat_id,
                        sender_id: "me@s.whatsapp.net".into(),
                        sender_name: "You".into(),
                        from_me: true,
                        timestamp_ms: 1_900_000_000_000,
                        status: proto::MessageStatus::Sent as i32,
                        content: Some(proto::message::Content::Image(proto::ImageContent {
                            caption: request.caption,
                            mime_type: String::new(),
                            local_path: request.image_path.clone(),
                            thumbnail_path: request.image_path,
                            downloadable: true,
                            ..Default::default()
                        })),
                        reply_to_message_id: request.reply_to_message_id,
                        ..Default::default()
                    }),
                })
            }
            Some(rpc_request::Request::SendSticker(request)) => {
                rpc_response::Result::SendSticker(proto::SendStickerResponse {
                    message: Some(proto::Message {
                        id: request.client_message_id,
                        chat_id: request.chat_id,
                        sender_id: "me@s.whatsapp.net".into(),
                        sender_name: "You".into(),
                        from_me: true,
                        timestamp_ms: 1_900_000_000_000,
                        status: proto::MessageStatus::Sent as i32,
                        content: Some(proto::message::Content::Image(proto::ImageContent {
                            mime_type: "image/webp".into(),
                            sticker: true,
                            width: 512,
                            height: 512,
                            ..Default::default()
                        })),
                        reply_to_message_id: request.reply_to_message_id,
                        ..Default::default()
                    }),
                })
            }
            Some(rpc_request::Request::GetMessageImage(request)) => {
                rpc_response::Result::GetMessageImage(proto::GetMessageImageResponse {
                    chat_id: request.chat_id,
                    message_id: request.message_id,
                    image_path: String::new(),
                    thumbnail_path: String::new(),
                })
            }
            Some(rpc_request::Request::GetMessageAttachment(request)) => {
                rpc_response::Result::GetMessageAttachment(proto::GetMessageAttachmentResponse {
                    chat_id: request.chat_id,
                    message_id: request.message_id,
                    local_path: String::new(),
                })
            }
            Some(rpc_request::Request::SendAttachment(request)) => fake_send_attachment(request),
            Some(rpc_request::Request::ListStickers(_)) => {
                rpc_response::Result::ListStickers(proto::ListStickersResponse {
                    packs: vec![
                        proto::StickerPack {
                            id: "favorites".into(),
                            name: "Favourites".into(),
                            stickers: vec![
                                fake_sticker("fav-1", true),
                                fake_sticker("fav-2", true),
                            ],
                        },
                        proto::StickerPack {
                            id: "recent".into(),
                            name: "Recently used".into(),
                            stickers: vec![fake_sticker("recent-1", false)],
                        },
                    ],
                })
            }
            Some(rpc_request::Request::SendStickerFromLibrary(request)) => {
                rpc_response::Result::SendStickerFromLibrary(
                    proto::SendStickerFromLibraryResponse {
                        message: Some(proto::Message {
                            id: request.client_message_id,
                            chat_id: request.chat_id,
                            sender_id: "me@s.whatsapp.net".into(),
                            sender_name: "You".into(),
                            from_me: true,
                            timestamp_ms: 1_900_000_000_000,
                            status: proto::MessageStatus::Sent as i32,
                            content: Some(proto::message::Content::Image(proto::ImageContent {
                                mime_type: "image/webp".into(),
                                sticker: true,
                                width: 512,
                                height: 512,
                                ..Default::default()
                            })),
                            reply_to_message_id: request.reply_to_message_id,
                            ..Default::default()
                        }),
                    },
                )
            }
            Some(rpc_request::Request::SendReaction(request)) => {
                let removed = request.emoji.is_empty();
                rpc_response::Result::SendReaction(proto::SendReactionResponse {
                    reaction: Some(proto::Reaction {
                        chat_id: request.chat_id,
                        message_id: request.message_id,
                        sender_id: "me@s.whatsapp.net".into(),
                        emoji: request.emoji,
                        timestamp_ms: 1_900_000_000_000,
                        from_me: true,
                        sender_name: "You".into(),
                        ..Default::default()
                    }),
                    removed,
                })
            }
            Some(rpc_request::Request::RepairRecentReactions(request)) => {
                rpc_response::Result::RepairRecentReactions(proto::RepairRecentReactionsResponse {
                    chat_id: request.chat_id,
                    requested: false,
                    attempts: 0,
                })
            }
            Some(rpc_request::Request::MarkRead(_)) => {
                rpc_response::Result::MarkRead(proto::MarkReadResponse {})
            }
            Some(rpc_request::Request::SetTyping(_)) => {
                rpc_response::Result::SetTyping(proto::SetTypingResponse {})
            }
            Some(rpc_request::Request::Logout(_)) => {
                rpc_response::Result::Logout(proto::LogoutResponse {})
            }
            Some(rpc_request::Request::Shutdown(_)) => {
                rpc_response::Result::Shutdown(proto::ShutdownResponse {})
            }
            None => continue,
        };
        if incoming
            .send_blocking(BridgeMessage::Envelope(Box::new(proto::Envelope {
                protocol_version: PROTOCOL_VERSION,
                request_id,
                body: Some(envelope::Body::Response(proto::RpcResponse {
                    result: Some(result),
                })),
            })))
            .is_err()
        {
            return;
        }
        if is_hello {
            // The real backend only exposes events after the Hello response has
            // been written, so the deterministic backend must keep the same
            // subscription boundary.
            handshaken.store(true, Ordering::Release);
        }
    }
}

fn fake_invalid_argument(message: impl Into<String>) -> rpc_response::Result {
    rpc_response::Result::Error(proto::RpcError {
        code: "invalid_argument".into(),
        message: message.into(),
        retryable: false,
    })
}

fn fake_sticker(id: &str, favorite: bool) -> proto::Sticker {
    proto::Sticker {
        id: id.into(),
        local_path: String::new(),
        mime_type: "image/webp".into(),
        animated: false,
        width: 512,
        height: 512,
        favorite,
        last_used_ms: 1_900_000_000_000,
        source_chat_id: String::new(),
        source_message_id: String::new(),
    }
}

fn fake_send_attachment(request: proto::SendAttachmentRequest) -> rpc_response::Result {
    let Ok(kind) = proto::AttachmentKind::try_from(request.kind) else {
        return fake_invalid_argument("unknown attachment kind");
    };
    if kind == proto::AttachmentKind::Unspecified {
        return fake_invalid_argument("attachment kind is required");
    }
    if request.voice_note && kind != proto::AttachmentKind::Audio {
        return fake_invalid_argument("voice_note is only valid for audio attachments");
    }
    if kind == proto::AttachmentKind::Audio && !request.caption.is_empty() {
        return fake_invalid_argument("audio messages do not support captions");
    }
    let (kind_name, mime_type, file_name) = match kind {
        proto::AttachmentKind::Document => (
            "document",
            "application/octet-stream",
            Path::new(&request.file_path)
                .file_name()
                .and_then(|name| name.to_str())
                .unwrap_or("attachment")
                .to_owned(),
        ),
        proto::AttachmentKind::Video => ("video", "video/mp4", String::new()),
        proto::AttachmentKind::Audio => (
            "audio",
            if request.voice_note {
                "audio/ogg; codecs=opus"
            } else {
                "audio/ogg"
            },
            String::new(),
        ),
        proto::AttachmentKind::Unspecified => unreachable!("validated above"),
    };
    rpc_response::Result::SendAttachment(proto::SendAttachmentResponse {
        message: Some(proto::Message {
            id: request.client_message_id,
            chat_id: request.chat_id,
            sender_id: "me@s.whatsapp.net".into(),
            sender_name: "You".into(),
            from_me: true,
            timestamp_ms: 1_900_000_000_000,
            status: proto::MessageStatus::Sent as i32,
            content: Some(proto::message::Content::Attachment(
                proto::AttachmentContent {
                    kind: kind_name.into(),
                    caption: request.caption,
                    mime_type: mime_type.into(),
                    file_name,
                    // Match the real backend's ownership boundary: a selected
                    // source path is never exposed as a renderable cache asset.
                    local_path: String::new(),
                    voice_note: request.voice_note,
                    downloadable: true,
                    ..Default::default()
                },
            )),
            reply_to_message_id: request.reply_to_message_id,
            ..Default::default()
        }),
    })
}

fn emit_fake_event(
    incoming: &async_channel::Sender<BridgeMessage>,
    sequence: &Mutex<u64>,
    event: proto::backend_event::Event,
) -> bool {
    let mut sequence = sequence.lock().expect("fake event sequence poisoned");
    let envelope = proto::Envelope {
        protocol_version: PROTOCOL_VERSION,
        request_id: 0,
        body: Some(envelope::Body::Event(proto::BackendEvent {
            sequence: *sequence,
            event: Some(event),
        })),
    };
    *sequence = sequence.saturating_add(1);
    incoming
        .send_blocking(BridgeMessage::Envelope(Box::new(envelope)))
        .is_ok()
}

fn fake_live_loop(
    incoming: async_channel::Sender<BridgeMessage>,
    sequence: Arc<Mutex<u64>>,
    handshaken: Arc<AtomicBool>,
) {
    while !handshaken.load(Ordering::Acquire) {
        if incoming.is_closed() {
            return;
        }
        thread::sleep(std::time::Duration::from_millis(10));
    }
    // The deterministic fixture also exercises the real-time path: incoming
    // messages appear at the bottom while the chat row moves to the top.
    thread::sleep(std::time::Duration::from_secs(3));
    for counter in 1_u64.. {
        let timestamp_ms = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map_or(0, |duration| duration.as_millis() as i64);
        let (message_event, chat_event) = fake_live_event_pair(counter, timestamp_ms);
        // Match the real backend: publish the stored message before its derived
        // chat preview/unread-count update.
        if !emit_fake_event(&incoming, &sequence, message_event)
            || !emit_fake_event(&incoming, &sequence, chat_event)
        {
            return;
        }
        thread::sleep(std::time::Duration::from_secs(4));
    }
}

fn fake_live_event_pair(
    counter: u64,
    timestamp_ms: i64,
) -> (proto::backend_event::Event, proto::backend_event::Event) {
    let message = proto::Message {
        id: format!("live-{counter}"),
        chat_id: "chat-0".into(),
        sender_id: "friend@s.whatsapp.net".into(),
        sender_name: "Meow friend".into(),
        sender_phone_number: "+15551234567".into(),
        timestamp_ms,
        status: proto::MessageStatus::Delivered as i32,
        content: Some(proto::message::Content::Text(proto::TextContent {
            text: format!("Live message {counter} streamed into the bottom of the chat"),
            link_preview: None,
        })),
        ..Default::default()
    };
    let mut chat = fake_chat(0);
    chat.last_message_preview = message
        .content
        .as_ref()
        .and_then(|content| match content {
            proto::message::Content::Text(text) => Some(text.text.clone()),
            _ => None,
        })
        .unwrap_or_default();
    chat.last_message_timestamp_ms = timestamp_ms;
    chat.unread_count = 1;
    (
        proto::backend_event::Event::MessageUpserted(proto::MessageUpserted {
            message: Some(message),
        }),
        proto::backend_event::Event::ChatUpserted(proto::ChatUpserted { chat: Some(chat) }),
    )
}

fn fake_chat(id: usize) -> proto::Chat {
    proto::Chat {
        id: format!("chat-{id}"),
        kind: if id.is_multiple_of(5) {
            proto::ChatKind::Group as i32
        } else {
            proto::ChatKind::Direct as i32
        },
        title: if id.is_multiple_of(5) {
            format!("Weekend plans {id}")
        } else {
            format!("Meow friend {id}")
        },
        last_message_preview: format!("This is virtualized conversation number {id}"),
        last_message_timestamp_ms: 1_900_000_000_000 - id as i64,
        unread_count: id.is_multiple_of(7) as u32 * ((id % 4) + 1) as u32,
        pinned: id < 3,
        phone_number: if !id.is_multiple_of(5) {
            format!("+1555{id:07}")
        } else {
            String::new()
        },
        contact_name: if !id.is_multiple_of(5) {
            format!("Meow friend {id}")
        } else {
            String::new()
        },
        push_name: if !id.is_multiple_of(5) {
            format!("Friend {id}")
        } else {
            String::new()
        },
        ..Default::default()
    }
}

fn fake_message(chat_id: &str, id: usize) -> proto::Message {
    proto::Message {
        id: format!("message-{id}"),
        chat_id: chat_id.into(),
        sender_id: if id.is_multiple_of(2) {
            "me@s.whatsapp.net"
        } else {
            "friend@s.whatsapp.net"
        }
        .into(),
        sender_name: if id.is_multiple_of(2) {
            "You"
        } else {
            "Meow friend"
        }
        .into(),
        sender_phone_number: if id.is_multiple_of(2) {
            String::new()
        } else {
            "+15551234567".into()
        },
        from_me: id.is_multiple_of(2),
        timestamp_ms: id as i64,
        status: proto::MessageStatus::Read as i32,
        content: Some(proto::message::Content::Text(proto::TextContent {
            text: if id.is_multiple_of(9) {
                format!(
                    "A longer message {id}\nwith a second line to exercise variable-height virtualization 🐈"
                )
            } else {
                format!("Fast native message {id}")
            },
            link_preview: id.is_multiple_of(13).then(|| proto::LinkPreview {
                url: "https://example.com/rust-meow".into(),
                title: "Rust Meow link preview".into(),
                description: "OpenGraph metadata supplied by the fake backend".into(),
                ..Default::default()
            }),
        })),
        reactions: if id.is_multiple_of(11) {
            vec![proto::Reaction {
                chat_id: chat_id.into(),
                message_id: format!("message-{id}"),
                sender_id: "friend@s.whatsapp.net".into(),
                emoji: "🐈".into(),
                timestamp_ms: id as i64,
                sender_name: "Meow friend".into(),
                sender_phone_number: "+15551234567".into(),
                ..Default::default()
            }]
        } else {
            Vec::new()
        },
        reply_to_message_id: if id > 0 && id.is_multiple_of(13) {
            format!("message-{}", id - 1)
        } else {
            String::new()
        },
        ..Default::default()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn frames_round_trip() {
        let value = proto::Envelope {
            protocol_version: PROTOCOL_VERSION,
            request_id: 42,
            body: None,
        };
        let mut bytes = Vec::new();
        write_frame(&mut bytes, &value).unwrap();
        let decoded = read_frame(&mut bytes.as_slice()).unwrap();
        assert_eq!(decoded.request_id, 42);
    }

    #[test]
    fn oversized_prefix_is_rejected_before_allocation() {
        let bytes = ((MAX_FRAME_BYTES + 1) as u32).to_be_bytes();
        assert!(read_frame(&mut bytes.as_slice()).is_err());
    }

    #[test]
    fn fake_handshake_opens_event_boundary_after_response() {
        let (outgoing, outgoing_rx) = async_channel::bounded(2);
        let (incoming_tx, incoming) = async_channel::bounded(2);
        let handshaken = Arc::new(AtomicBool::new(false));
        let worker_handshaken = handshaken.clone();
        let worker = thread::spawn(move || {
            fake_loop(
                outgoing_rx,
                incoming_tx,
                Arc::new(Mutex::new(1)),
                worker_handshaken,
            );
        });
        let request = |request_id, request| proto::Envelope {
            protocol_version: PROTOCOL_VERSION,
            request_id,
            body: Some(envelope::Body::Request(proto::RpcRequest {
                request: Some(request),
            })),
        };
        outgoing
            .send_blocking(request(
                1,
                rpc_request::Request::GetAuthState(proto::GetAuthStateRequest {}),
            ))
            .unwrap();
        let _ = incoming.recv_blocking().unwrap();
        assert!(!handshaken.load(Ordering::Acquire));

        outgoing
            .send_blocking(request(
                2,
                rpc_request::Request::Hello(proto::HelloRequest::default()),
            ))
            .unwrap();
        let response = incoming.recv_blocking().unwrap();
        assert!(matches!(response, BridgeMessage::Envelope(_)));
        for _ in 0..100 {
            if handshaken.load(Ordering::Acquire) {
                break;
            }
            thread::sleep(std::time::Duration::from_millis(1));
        }
        assert!(handshaken.load(Ordering::Acquire));
        drop(outgoing);
        worker.join().unwrap();
    }

    #[test]
    fn fake_attachment_responses_match_v14_contract() {
        let request = |kind, caption: &str, voice_note| proto::SendAttachmentRequest {
            client_message_id: "request-id".into(),
            chat_id: "chat-id".into(),
            file_path: "/tmp/voice.ogg".into(),
            kind: kind as i32,
            caption: caption.into(),
            reply_to_message_id: "reply-id".into(),
            voice_note,
        };
        let rpc_response::Result::SendAttachment(response) =
            fake_send_attachment(request(proto::AttachmentKind::Audio, "", true))
        else {
            panic!("valid voice note did not return send_attachment");
        };
        let message = response.message.unwrap();
        let Some(proto::message::Content::Attachment(attachment)) = message.content else {
            panic!("fake response did not contain attachment content");
        };
        assert_eq!(attachment.kind, "audio");
        assert_eq!(attachment.mime_type, "audio/ogg; codecs=opus");
        assert!(attachment.voice_note);
        assert!(attachment.local_path.is_empty());
        assert_eq!(message.reply_to_message_id, "reply-id");

        assert!(matches!(
            fake_send_attachment(request(proto::AttachmentKind::Unspecified, "", false)),
            rpc_response::Result::Error(_)
        ));
        assert!(matches!(
            fake_send_attachment(request(proto::AttachmentKind::Video, "", true)),
            rpc_response::Result::Error(_)
        ));
        assert!(matches!(
            fake_send_attachment(request(proto::AttachmentKind::Audio, "caption", false)),
            rpc_response::Result::Error(_)
        ));
    }

    #[test]
    fn fake_live_pair_matches_backend_event_order() {
        let (message_event, chat_event) = fake_live_event_pair(7, 1234);
        let proto::backend_event::Event::MessageUpserted(message) = message_event else {
            panic!("first event was not the message upsert");
        };
        let proto::backend_event::Event::ChatUpserted(chat) = chat_event else {
            panic!("second event was not the derived chat upsert");
        };
        let message = message.message.unwrap();
        let chat = chat.chat.unwrap();
        assert_eq!(message.timestamp_ms, chat.last_message_timestamp_ms);
        assert_eq!(chat.unread_count, 1);
        assert!(chat.last_message_preview.contains("Live message 7"));
    }

    #[test]
    fn fake_event_emission_is_monotonic() {
        let (incoming, received) = async_channel::bounded(2);
        let sequence = Mutex::new(41);
        for detail in ["first", "second"] {
            assert!(emit_fake_event(
                &incoming,
                &sequence,
                proto::backend_event::Event::ConnectionChanged(proto::ConnectionChanged {
                    detail: detail.into(),
                    ..Default::default()
                }),
            ));
        }
        let sequences: Vec<_> = (0..2)
            .map(|_| match received.recv_blocking().unwrap() {
                BridgeMessage::Envelope(envelope) => match envelope.body {
                    Some(envelope::Body::Event(event)) => event.sequence,
                    _ => panic!("fake event used the wrong envelope body"),
                },
                BridgeMessage::Exited(_) => panic!("fake bridge exited"),
            })
            .collect();
        assert_eq!(sequences, [41, 42]);
    }

    #[test]
    fn exit_classification_never_retries_terminal_profile_protocol_or_data_failures() {
        for message in [
            "Rust Meow profile is already in use",
            "unsupported_protocol",
            "backend sent protocol version 99",
            "database disk image is malformed",
            "file is not a database",
        ] {
            assert_eq!(classify_exit(message), BridgeExitKind::Fatal, "{message}");
        }
        assert_eq!(
            classify_exit("failed to fill whole buffer; backend signal: 9"),
            BridgeExitKind::Transient
        );
    }
}
