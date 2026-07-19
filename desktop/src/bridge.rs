use std::{
    env,
    io::{Read, Write},
    path::{Path, PathBuf},
    process::{Child, Command, Stdio},
    sync::{Arc, Mutex},
    thread,
};

use anyhow::{Context as _, Result, bail};
use prost::Message as _;

use crate::proto::{self, envelope, rpc_request, rpc_response};

pub const PROTOCOL_VERSION: u32 = 9;
const MAX_FRAME_BYTES: usize = 8 * 1024 * 1024;

#[derive(Debug)]
pub enum BridgeMessage {
    Envelope(Box<proto::Envelope>),
    Exited(String),
}

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
        let data_dir = data_dir();
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
            .stderr(Stdio::inherit())
            .spawn()
            .with_context(|| format!("start backend {}", executable.display()))?;

        let stdin = child.stdin.take().context("backend stdin unavailable")?;
        let stdout = child.stdout.take().context("backend stdout unavailable")?;
        let child = Arc::new(Mutex::new(child));
        let (outgoing, outgoing_rx) = async_channel::bounded(256);
        let (incoming_tx, incoming) = async_channel::bounded(1024);

        thread::Builder::new()
            .name("bridge-writer".into())
            .spawn(move || writer_loop(stdin, outgoing_rx))?;
        thread::Builder::new()
            .name("bridge-reader".into())
            .spawn(move || {
                if let Err(error) = reader_loop(stdout, &incoming_tx) {
                    let _ = incoming_tx.send_blocking(BridgeMessage::Exited(error.to_string()));
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
            .send_blocking(proto::Envelope {
                protocol_version: PROTOCOL_VERSION,
                request_id,
                body: Some(envelope::Body::Request(proto::RpcRequest {
                    request: Some(request),
                })),
            })
            .context("backend writer stopped")
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

    fn fake() -> Self {
        let (outgoing, outgoing_rx) = async_channel::bounded(256);
        let (incoming_tx, incoming) = async_channel::bounded(1024);
        thread::Builder::new()
            .name("fake-backend".into())
            .spawn(move || fake_loop(outgoing_rx, incoming_tx))
            .expect("spawn fake backend");
        Self {
            outgoing,
            incoming,
            child: None,
        }
    }
}

impl Drop for BackendClient {
    fn drop(&mut self) {
        let _ = self.send(
            u64::MAX,
            rpc_request::Request::Shutdown(proto::ShutdownRequest {}),
        );
        self.outgoing.close();
        if let Some(child) = &self.child {
            let child = child.clone();
            let _ = thread::Builder::new()
                .name("backend-reaper".into())
                .spawn(move || {
                    if let Ok(mut child) = child.lock() {
                        let deadline =
                            std::time::Instant::now() + std::time::Duration::from_secs(3);
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
    }
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

fn data_dir() -> PathBuf {
    if let Some(path) = env::var_os("RUST_MEOW_DATA_DIR") {
        return path.into();
    }
    #[cfg(target_os = "windows")]
    let base = env::var_os("LOCALAPPDATA").map(PathBuf::from);
    #[cfg(target_os = "macos")]
    let base = env::var_os("HOME")
        .map(PathBuf::from)
        .map(|path| path.join("Library/Application Support"));
    #[cfg(all(not(target_os = "windows"), not(target_os = "macos")))]
    let base = env::var_os("XDG_DATA_HOME").map(PathBuf::from).or_else(|| {
        env::var_os("HOME")
            .map(PathBuf::from)
            .map(|path| path.join(".local/share"))
    });
    base.unwrap_or_else(env::temp_dir).join("rust-meow")
}

fn fake_loop(
    outgoing: async_channel::Receiver<proto::Envelope>,
    incoming: async_channel::Sender<BridgeMessage>,
) {
    let pairing = env::var_os("RUST_MEOW_FAKE_PAIRING").is_some();
    while let Ok(envelope) = outgoing.recv_blocking() {
        let request_id = envelope.request_id;
        let Some(envelope::Body::Request(request)) = envelope.body else {
            continue;
        };
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
                let event = proto::BackendEvent {
                    sequence: 1,
                    event: Some(proto::backend_event::Event::PairingQr(proto::PairingQr {
                        code: "2@RUST-MEOW-FAKE-PAIRING-CODE".into(),
                        expires_at_ms: 4_102_444_800_000,
                    })),
                };
                let _ =
                    incoming.send_blocking(BridgeMessage::Envelope(Box::new(proto::Envelope {
                        protocol_version: PROTOCOL_VERSION,
                        request_id: 0,
                        body: Some(envelope::Body::Event(event)),
                    })));
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
                            local_path: request.image_path,
                            downloadable: true,
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
                })
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
            Some(rpc_request::Request::Logout(_)) => {
                rpc_response::Result::Logout(proto::LogoutResponse {})
            }
            Some(rpc_request::Request::Shutdown(_)) => {
                rpc_response::Result::Shutdown(proto::ShutdownResponse {})
            }
            None => continue,
        };
        let _ = incoming.send_blocking(BridgeMessage::Envelope(Box::new(proto::Envelope {
            protocol_version: PROTOCOL_VERSION,
            request_id,
            body: Some(envelope::Body::Response(proto::RpcResponse {
                result: Some(result),
            })),
        })));
    }
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
}
