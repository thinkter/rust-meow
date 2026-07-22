use std::{
    collections::VecDeque,
    sync::{
        Arc, Mutex,
        atomic::{AtomicUsize, Ordering},
    },
    thread,
};

use serde::{Deserialize, Serialize};
use tauri::{Emitter as _, Manager as _};

const MAX_PENDING_ACTIVATIONS: usize = 32;
const MAX_ACTIVE_WAITERS: usize = 64;

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct NotificationTarget {
    pub(crate) chat_id: String,
    pub(crate) message_id: String,
}

impl NotificationTarget {
    pub(crate) fn is_valid(&self) -> bool {
        !self.chat_id.trim().is_empty()
            && !self.message_id.trim().is_empty()
            && self.chat_id.len() <= 512
            && self.message_id.len() <= 512
    }
}

#[derive(Default)]
pub(crate) struct NotificationActivationStore(Mutex<VecDeque<NotificationTarget>>);

impl NotificationActivationStore {
    pub(crate) fn from_args(args: &[String]) -> Self {
        let store = Self::default();
        if let Some(target) = target_from_args(args) {
            store.push(target);
        }
        store
    }

    pub(crate) fn push(&self, target: NotificationTarget) {
        if !target.is_valid() {
            return;
        }
        let mut pending = self
            .0
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        if pending.contains(&target) {
            return;
        }
        while pending.len() >= MAX_PENDING_ACTIVATIONS {
            pending.pop_front();
        }
        pending.push_back(target);
    }

    pub(crate) fn take(&self) -> Vec<NotificationTarget> {
        self.0
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .drain(..)
            .collect()
    }
}

#[derive(Clone, Default)]
pub(crate) struct NativeNotificationService {
    active_waiters: Arc<AtomicUsize>,
}

impl NativeNotificationService {
    pub(crate) async fn show(
        &self,
        app: tauri::AppHandle,
        title: String,
        body: String,
        target: NotificationTarget,
    ) -> Result<(), String> {
        if !target.is_valid() {
            return Err("notification target is empty or too long".into());
        }
        if self.active_waiters.fetch_add(1, Ordering::AcqRel) >= MAX_ACTIVE_WAITERS {
            self.active_waiters.fetch_sub(1, Ordering::AcqRel);
            return Err("too many active desktop notifications".into());
        }

        let active_waiters = self.active_waiters.clone();
        let (shown_tx, shown_rx) = tokio::sync::oneshot::channel();
        let worker = thread::Builder::new()
            .name("notification-action".into())
            .spawn(move || {
                #[cfg(target_os = "macos")]
                let _ = notify_rust::set_application(if tauri::is_dev() {
                    "com.apple.Terminal"
                } else {
                    &app.config().identifier
                });
                let mut notification = notify_rust::Notification::new();
                notification
                    .summary(&title)
                    .body(&body)
                    .id(stable_chat_id(&target.chat_id));
                #[cfg(all(unix, not(target_os = "macos")))]
                notification.appname("Rust Meow").action("default", "Open");
                #[cfg(target_os = "macos")]
                notification.action("default", "Open");
                #[cfg(target_os = "windows")]
                notification.app_id(&app.config().identifier);

                match notification.show() {
                    Ok(handle) => {
                        let _ = shown_tx.send(Ok(()));
                        handle.wait_for_action(|action| {
                            if action == "__closed" {
                                return;
                            }
                            let store = app.state::<NotificationActivationStore>();
                            store.push(target.clone());
                            let _ = app.emit("notification-activated", &target);
                            if let Some(window) = app.get_webview_window("main") {
                                let _ = window.show();
                                let _ = window.set_focus();
                            }
                        });
                    }
                    Err(error) => {
                        let _ = shown_tx.send(Err(error.to_string()));
                    }
                }
                active_waiters.fetch_sub(1, Ordering::AcqRel);
            });
        if let Err(error) = worker {
            self.active_waiters.fetch_sub(1, Ordering::AcqRel);
            return Err(format!("start native notification worker: {error}"));
        }

        shown_rx
            .await
            .map_err(|_| "native notification worker stopped before showing".to_string())?
    }
}

pub(crate) fn target_from_args(args: &[String]) -> Option<NotificationTarget> {
    let chat_id = args
        .iter()
        .find_map(|arg| arg.strip_prefix("--notification-chat-id="))?;
    let message_id = args
        .iter()
        .find_map(|arg| arg.strip_prefix("--notification-message-id="))?;
    let target = NotificationTarget {
        chat_id: chat_id.to_owned(),
        message_id: message_id.to_owned(),
    };
    target.is_valid().then_some(target)
}

fn stable_chat_id(chat_id: &str) -> u32 {
    // FNV-1a provides deterministic replacement/grouping without leaking a
    // WhatsApp JID into platform notification identifiers.
    chat_id.bytes().fold(2_166_136_261_u32, |hash, byte| {
        (hash ^ u32::from(byte)).wrapping_mul(16_777_619)
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_order_independent_activation_arguments() {
        let target = target_from_args(&[
            "rust-meow".into(),
            "--notification-message-id=m1".into(),
            "--notification-chat-id=c1".into(),
        ]);
        assert_eq!(
            target,
            Some(NotificationTarget {
                chat_id: "c1".into(),
                message_id: "m1".into(),
            })
        );
    }

    #[test]
    fn activation_store_deduplicates_and_is_bounded() {
        let store = NotificationActivationStore::default();
        for index in 0..(MAX_PENDING_ACTIVATIONS + 5) {
            store.push(NotificationTarget {
                chat_id: format!("chat-{index}"),
                message_id: "message".into(),
            });
        }
        store.push(NotificationTarget {
            chat_id: format!("chat-{}", MAX_PENDING_ACTIVATIONS + 4),
            message_id: "message".into(),
        });
        let pending = store.take();
        assert_eq!(pending.len(), MAX_PENDING_ACTIVATIONS);
        assert_eq!(pending[0].chat_id, "chat-5");
    }

    #[test]
    fn replacement_identifier_is_stable_and_chat_specific() {
        assert_eq!(stable_chat_id("a"), stable_chat_id("a"));
        assert_ne!(stable_chat_id("a"), stable_chat_id("b"));
    }
}
