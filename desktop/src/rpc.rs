use std::{
    collections::HashMap,
    time::{Duration, Instant},
};

use anyhow::Result;

use crate::{
    bridge::BackendClient,
    proto::{self, envelope, rpc_request},
};

pub use crate::bridge::{BridgeMessage, PROTOCOL_VERSION};

const CONTROL_REQUEST_TIMEOUT: Duration = Duration::from_secs(15);
const READ_REQUEST_TIMEOUT: Duration = Duration::from_secs(30);
const WRITE_REQUEST_TIMEOUT: Duration = Duration::from_secs(60);
pub const TIMEOUT_SWEEP_INTERVAL: Duration = Duration::from_secs(1);
pub const REACTION_REPAIR_RETRY: Duration = Duration::from_secs(10 * 60 + 1);
const MAX_RETRIES: u8 = 3;

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum PendingRequest {
    Hello,
    Auth,
    Pairing,
    Chats {
        cursor: String,
    },
    Messages {
        chat_id: String,
        prepend: bool,
        generation: u64,
    },
    Search {
        query: String,
        generation: u64,
    },
    OpenContact,
    MessagesAround {
        chat_id: String,
        message_id: String,
        generation: u64,
    },
    OpenMessageWindow {
        chat_id: String,
        generation: u64,
    },
    MessagesAfter {
        chat_id: String,
        generation: u64,
    },
    Avatar {
        chat_id: String,
    },
    ParticipantAvatar {
        participant_id: String,
    },
    ChatInfo {
        chat_id: String,
    },
    MentionDirectory {
        chat_id: String,
    },
    SetTyping,
    SendText {
        chat_id: String,
        draft_text: String,
        reply_to_message_id: Option<String>,
        /// (display name, JID) pairs backing `@Name` tokens in `draft_text`.
        mentions: Vec<(String, String)>,
    },
    SendImage {
        chat_id: String,
        draft_text: String,
        reply_to_message_id: Option<String>,
    },
    SendSticker,
    MessageImage {
        chat_id: String,
        message_id: String,
    },
    SendReaction {
        chat_id: String,
        message_id: String,
        emoji: String,
        client_reaction_id: String,
        attempt: u8,
    },
    RepairRecentReactions {
        chat_id: String,
    },
    MarkRead {
        chat_id: String,
        previous_unread: u32,
    },
    Logout,
}

impl PendingRequest {
    fn timeout(&self) -> Duration {
        match self {
            Self::Hello | Self::Auth => CONTROL_REQUEST_TIMEOUT,
            Self::Chats { .. }
            | Self::Messages { .. }
            | Self::Search { .. }
            | Self::OpenContact
            | Self::MessagesAround { .. }
            | Self::OpenMessageWindow { .. }
            | Self::MessagesAfter { .. }
            | Self::Avatar { .. }
            | Self::ParticipantAvatar { .. }
            | Self::ChatInfo { .. }
            | Self::MentionDirectory { .. }
            | Self::MessageImage { .. } => READ_REQUEST_TIMEOUT,
            Self::Pairing
            | Self::SetTyping
            | Self::SendText { .. }
            | Self::SendImage { .. }
            | Self::SendSticker
            | Self::SendReaction { .. }
            | Self::RepairRecentReactions { .. }
            | Self::MarkRead { .. }
            | Self::Logout => WRITE_REQUEST_TIMEOUT,
        }
    }

    fn is_media(&self) -> bool {
        matches!(
            self,
            Self::Avatar { .. } | Self::ParticipantAvatar { .. } | Self::MessageImage { .. }
        )
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct Retry {
    pub attempt: u8,
    pub delay: Duration,
}

pub fn reaction_retry(retryable: bool, attempt: u8) -> Option<Retry> {
    if !retryable || attempt >= MAX_RETRIES {
        return None;
    }
    let attempt = attempt + 1;
    Some(Retry {
        attempt,
        delay: Duration::from_secs(u64::from(attempt)),
    })
}

pub fn avatar_retry(retryable: bool, retries_completed: u8) -> Option<Retry> {
    if !retryable || retries_completed >= MAX_RETRIES {
        return None;
    }
    let attempt = retries_completed + 1;
    Some(Retry {
        attempt,
        delay: Duration::from_secs(5 * u64::from(attempt)),
    })
}

#[derive(Debug)]
struct PendingRpc {
    request: PendingRequest,
    expires_at: Duration,
}

#[derive(Debug)]
struct RequestTracker {
    next_request_id: u64,
    pending: HashMap<u64, PendingRpc>,
}

impl Default for RequestTracker {
    fn default() -> Self {
        Self {
            next_request_id: 1,
            pending: HashMap::new(),
        }
    }
}

impl RequestTracker {
    fn begin(&mut self, request: PendingRequest, now: Duration) -> u64 {
        let request_id = self.next_request_id;
        self.next_request_id = self
            .next_request_id
            .checked_add(1)
            .expect("RPC request IDs exhausted");
        let expires_at = now.saturating_add(request.timeout());
        self.pending.insert(
            request_id,
            PendingRpc {
                request,
                expires_at,
            },
        );
        request_id
    }

    fn complete(&mut self, request_id: u64) -> Option<PendingRequest> {
        self.pending
            .remove(&request_id)
            .map(|pending| pending.request)
    }

    fn requests(&self) -> impl Iterator<Item = &PendingRequest> {
        self.pending.values().map(|pending| &pending.request)
    }

    fn expire(&mut self, now: Duration) -> Vec<(u64, PendingRequest)> {
        let mut expired_ids = self
            .pending
            .iter()
            .filter_map(|(request_id, pending)| (pending.expires_at <= now).then_some(*request_id))
            .collect::<Vec<_>>();
        expired_ids.sort_unstable();
        expired_ids
            .into_iter()
            .filter_map(|request_id| {
                self.complete(request_id)
                    .map(|request| (request_id, request))
            })
            .collect()
    }

    fn clear(&mut self) {
        self.pending.clear();
    }
}

pub struct RpcClient {
    bridge: BackendClient,
    tracker: RequestTracker,
    epoch: Instant,
}

pub enum RpcIncoming {
    Response {
        pending: PendingRequest,
        response: proto::RpcResponse,
    },
    Event(proto::BackendEvent),
    Exited(String),
    Invalid,
    Ignore,
}

impl RpcClient {
    pub fn start(fake: bool) -> Result<Self> {
        BackendClient::start(fake).map(Self::new)
    }

    pub fn disconnected() -> Self {
        Self::new(BackendClient::disconnected())
    }

    fn new(bridge: BackendClient) -> Self {
        Self {
            bridge,
            tracker: RequestTracker::default(),
            epoch: Instant::now(),
        }
    }

    pub fn incoming(&self) -> async_channel::Receiver<BridgeMessage> {
        self.bridge.incoming.clone()
    }

    pub fn send(&mut self, request: rpc_request::Request, pending: PendingRequest) -> Result<u64> {
        let request_id = self.tracker.begin(pending, self.epoch.elapsed());
        if let Err(error) = self.bridge.send(request_id, request) {
            self.tracker.complete(request_id);
            return Err(error);
        }
        Ok(request_id)
    }

    fn complete(&mut self, request_id: u64) -> Option<PendingRequest> {
        self.tracker.complete(request_id)
    }

    pub fn handle_incoming(&mut self, message: BridgeMessage) -> RpcIncoming {
        let envelope = match message {
            BridgeMessage::Envelope(envelope) => envelope,
            BridgeMessage::Exited(error) => {
                self.tracker.clear();
                // The GPUI client is a behavioral reference without the Tauri
                // restart supervisor, so both exit classes share its existing
                // terminal UI while still consuming the structured result.
                let _legacy_exit_kind = error.kind;
                return RpcIncoming::Exited(error.message);
            }
        };
        match envelope.body {
            Some(envelope::Body::Response(response)) => {
                self.complete(envelope.request_id)
                    .map_or(RpcIncoming::Ignore, |pending| RpcIncoming::Response {
                        pending,
                        response,
                    })
            }
            Some(envelope::Body::Event(event)) if envelope.request_id == 0 => {
                RpcIncoming::Event(event)
            }
            _ => RpcIncoming::Invalid,
        }
    }

    pub fn expire(&mut self) -> Vec<(u64, PendingRequest)> {
        self.tracker.expire(self.epoch.elapsed())
    }

    pub fn pending_requests(&self) -> impl Iterator<Item = &PendingRequest> {
        self.tracker.requests()
    }

    pub fn pending_media_count(&self) -> usize {
        self.pending_requests()
            .filter(|request| request.is_media())
            .count()
    }

    pub fn logout_pending(&self) -> bool {
        self.pending_requests()
            .any(|request| matches!(request, PendingRequest::Logout))
    }

    pub fn clear_pending(&mut self) {
        self.tracker.clear();
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::proto;

    #[test]
    fn lifecycle_assigns_monotonic_ids_and_completes_once() {
        let mut tracker = RequestTracker::default();
        let first = tracker.begin(PendingRequest::Hello, Duration::ZERO);
        let second = tracker.begin(PendingRequest::Logout, Duration::ZERO);

        assert_eq!((first, second), (1, 2));
        assert_eq!(tracker.complete(first), Some(PendingRequest::Hello));
        assert_eq!(tracker.complete(first), None);
        assert_eq!(tracker.requests().count(), 1);

        tracker.clear();
        assert_eq!(tracker.requests().count(), 0);
        assert_eq!(tracker.begin(PendingRequest::Auth, Duration::ZERO), 3);
    }

    #[test]
    fn request_classes_expire_at_exact_deterministic_deadlines() {
        let mut tracker = RequestTracker::default();
        tracker.begin(PendingRequest::Logout, Duration::ZERO);
        tracker.begin(PendingRequest::Hello, Duration::ZERO);

        assert_eq!(
            tracker.expire(CONTROL_REQUEST_TIMEOUT),
            vec![(2, PendingRequest::Hello)]
        );
        assert_eq!(tracker.requests().count(), 1);
        assert_eq!(
            tracker.expire(WRITE_REQUEST_TIMEOUT),
            vec![(1, PendingRequest::Logout)]
        );
    }

    #[test]
    fn expired_media_releases_capacity_for_following_requests() {
        let mut tracker = RequestTracker::default();
        for request_id in 1..=4 {
            tracker.begin(
                PendingRequest::MessageImage {
                    chat_id: "chat".into(),
                    message_id: format!("message-{request_id}"),
                },
                Duration::from_secs(10),
            );
        }
        assert_eq!(
            tracker
                .requests()
                .filter(|request| request.is_media())
                .count(),
            4
        );

        assert_eq!(tracker.expire(Duration::from_secs(40)).len(), 4);
        tracker.begin(
            PendingRequest::Avatar {
                chat_id: "next-chat".into(),
            },
            Duration::from_secs(40),
        );
        assert_eq!(
            tracker
                .requests()
                .filter(|request| request.is_media())
                .count(),
            1
        );
    }

    #[test]
    fn retry_policy_preserves_reaction_and_avatar_backoff() {
        assert_eq!(
            reaction_retry(true, 1),
            Some(Retry {
                attempt: 2,
                delay: Duration::from_secs(2),
            })
        );
        assert_eq!(reaction_retry(true, 3), None);
        assert_eq!(reaction_retry(false, 0), None);
        assert_eq!(
            avatar_retry(true, 1),
            Some(Retry {
                attempt: 2,
                delay: Duration::from_secs(10),
            })
        );
        assert_eq!(avatar_retry(true, 3), None);
    }

    #[test]
    fn failed_transport_send_rolls_back_pending_entry() {
        let mut rpc = RpcClient::disconnected();
        let result = rpc.send(
            rpc_request::Request::Hello(proto::HelloRequest::default()),
            PendingRequest::Hello,
        );
        assert!(result.is_err());
        assert_eq!(rpc.pending_requests().count(), 0);
    }

    #[test]
    fn inbound_policy_correlates_responses_once_and_ignores_late_duplicates() {
        let mut rpc = RpcClient::disconnected();
        let request_id = rpc.tracker.begin(PendingRequest::Hello, Duration::ZERO);
        let response = proto::RpcResponse::default();
        let message = || {
            BridgeMessage::Envelope(Box::new(proto::Envelope {
                protocol_version: PROTOCOL_VERSION,
                request_id,
                body: Some(envelope::Body::Response(response.clone())),
            }))
        };

        assert!(matches!(
            rpc.handle_incoming(message()),
            RpcIncoming::Response {
                pending: PendingRequest::Hello,
                ..
            }
        ));
        assert!(matches!(
            rpc.handle_incoming(message()),
            RpcIncoming::Ignore
        ));
    }
}
