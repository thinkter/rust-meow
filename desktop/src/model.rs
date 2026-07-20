use std::{collections::HashMap, rc::Rc};

use gpui::{Pixels, Size, px, size};

use crate::proto;

pub const CHAT_PAGE_SIZE: u32 = 100;
pub const MESSAGE_PAGE_SIZE: u32 = 50;
pub const MAX_ACTIVE_MESSAGES: usize = 2_000;

#[derive(Clone, Copy, Debug, Default, Eq, PartialEq)]
pub enum ChatView {
    #[default]
    Inbox,
    Archived,
}

impl ChatView {
    fn includes(self, chat: &proto::Chat) -> bool {
        chat.archived == matches!(self, Self::Archived)
    }
}

#[derive(Clone, Copy, Debug, Default, Eq, PartialEq)]
pub enum Screen {
    #[default]
    Starting,
    Pairing,
    Syncing,
    Chats,
    Fatal,
}

#[derive(Default)]
pub struct Store {
    pub screen: Screen,
    pub connection: proto::ConnectionState,
    pub connection_detail: String,
    pub sync_chats: u64,
    pub sync_messages: u64,
    pub sync_active: bool,
    pub sync_complete: bool,
    pub qr_code: Option<String>,
    pub qr_expires_at_ms: i64,
    pub chats: Vec<proto::Chat>,
    pub total_chats: u64,
    pub next_chat_cursor: String,
    pub selected_chat_id: Option<String>,
    pub messages: Vec<proto::Message>,
    pub has_older_messages: bool,
    pub has_newer_messages: bool,
    pub newer_activity: bool,
    pub fatal_error: Option<String>,
    pub toast_error: Option<String>,
    pub last_mark_read_id: Option<String>,
    pub pending: HashMap<u64, PendingRequest>,
    chat_index: HashMap<String, usize>,
    message_index: HashMap<String, usize>,
    message_sizes: Rc<Vec<Size<Pixels>>>,
    measured_width_bucket: Option<i32>,
    message_height_cache: HashMap<i32, HashMap<String, Pixels>>,
    participant_avatar_paths: HashMap<String, String>,
}

#[derive(Clone, Debug)]
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
    SendText {
        chat_id: String,
        draft_text: String,
        reply_to_message_id: Option<String>,
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

impl Store {
    pub fn clear_account_state(&mut self) {
        *self = Self::default();
    }

    pub fn logout_pending(&self) -> bool {
        self.pending
            .values()
            .any(|pending| matches!(pending, PendingRequest::Logout))
    }

    pub fn selected_chat(&self) -> Option<&proto::Chat> {
        let id = self.selected_chat_id.as_deref()?;
        self.chats.iter().find(|chat| chat.id == id)
    }

    pub fn chat(&self, id: &str) -> Option<&proto::Chat> {
        self.chat_index
            .get(id)
            .and_then(|index| self.chats.get(*index))
    }

    pub fn chat_ids(&self, view: ChatView) -> Vec<String> {
        self.chats
            .iter()
            .filter(|chat| view.includes(chat))
            .map(|chat| chat.id.clone())
            .collect()
    }

    pub fn apply_sync_progress(&mut self, chats: u64, messages: u64, complete: bool) {
        self.sync_chats = self.sync_chats.saturating_add(chats);
        self.sync_messages = self.sync_messages.saturating_add(messages);
        self.sync_active = !complete;
        self.sync_complete = complete;
    }

    pub fn message(&self, id: &str) -> Option<&proto::Message> {
        self.message_index
            .get(id)
            .and_then(|index| self.messages.get(*index))
    }

    pub fn reply_count(&self, message_id: &str) -> usize {
        self.messages
            .iter()
            .filter(|message| message.reply_to_message_id == message_id)
            .count()
    }

    pub fn select_chat(&mut self, id: String) {
        self.selected_chat_id = Some(id);
        self.messages.clear();
        self.has_older_messages = false;
        self.has_newer_messages = false;
        self.newer_activity = false;
        self.message_index.clear();
        self.message_sizes = Rc::new(Vec::new());
        self.measured_width_bucket = None;
        self.last_mark_read_id = None;
    }

    pub fn merge_chat_id(&mut self, old_id: &str, new_id: &str) -> bool {
        self.chats.retain(|chat| chat.id != old_id);
        self.reindex_chats();
        if self.selected_chat_id.as_deref() == Some(old_id) {
            self.selected_chat_id = Some(new_id.to_owned());
            return true;
        }
        false
    }

    pub fn upsert_chat(&mut self, chat: proto::Chat) {
        let old_index = self.chat_index.remove(&chat.id);
        if let Some(index) = old_index {
            self.chats.remove(index);
        }
        let index = self
            .chats
            .binary_search_by(|existing| compare_chats(existing, &chat))
            .unwrap_or_else(|index| index);
        self.chats.insert(index, chat);
        let start = old_index.map_or(index, |old| old.min(index));
        let end = old_index.map_or(self.chats.len(), |old| old.max(index).saturating_add(1));
        for item_index in start..end.min(self.chats.len()) {
            self.chat_index
                .insert(self.chats[item_index].id.clone(), item_index);
        }
    }

    pub fn upsert_message(&mut self, mut message: proto::Message) {
        if self.selected_chat_id.as_deref() != Some(message.chat_id.as_str()) {
            return;
        }
        for heights in self.message_height_cache.values_mut() {
            heights.remove(&message.id);
        }
        if let Some(index) = self.message_index.get(&message.id).copied() {
            preserve_local_image_path(&mut message, &self.messages[index]);
            self.messages[index] = message;
        } else {
            self.messages.push(message);
        }
        self.messages
            .sort_by_key(|message| (message.timestamp_ms, message.id.clone()));
        self.trim_after_live_append();
        self.reindex_messages();
        self.rebuild_message_sizes();
    }

    pub fn prepend_messages(&mut self, incoming: Vec<proto::Message>) {
        let mut by_id: HashMap<String, proto::Message> = self
            .messages
            .drain(..)
            .map(|message| (message.id.clone(), message))
            .collect();
        for mut message in incoming {
            for heights in self.message_height_cache.values_mut() {
                heights.remove(&message.id);
            }
            if let Some(existing) = by_id.get(&message.id) {
                preserve_local_image_path(&mut message, existing);
            }
            by_id.insert(message.id.clone(), message);
        }
        self.messages = by_id.into_values().collect();
        self.messages
            .sort_by_key(|message| (message.timestamp_ms, message.id.clone()));
        if self.messages.len() > MAX_ACTIVE_MESSAGES {
            self.messages.truncate(MAX_ACTIVE_MESSAGES);
            self.has_newer_messages = true;
        }
        self.reindex_messages();
        self.rebuild_message_sizes();
    }

    pub fn append_newer_messages(&mut self, incoming: Vec<proto::Message>, has_more: bool) {
        let mut by_id: HashMap<String, proto::Message> = self
            .messages
            .drain(..)
            .map(|message| (message.id.clone(), message))
            .collect();
        for mut message in incoming {
            for heights in self.message_height_cache.values_mut() {
                heights.remove(&message.id);
            }
            if let Some(existing) = by_id.get(&message.id) {
                preserve_local_image_path(&mut message, existing);
            }
            by_id.insert(message.id.clone(), message);
        }
        self.messages = by_id.into_values().collect();
        self.messages
            .sort_by_key(|message| (message.timestamp_ms, message.id.clone()));
        if self.messages.len() > MAX_ACTIVE_MESSAGES {
            let excess = self.messages.len() - MAX_ACTIVE_MESSAGES;
            self.messages.drain(..excess);
            self.has_older_messages = true;
        }
        self.has_newer_messages = has_more || self.newer_activity;
        self.reindex_messages();
        self.rebuild_message_sizes();
    }

    pub fn replace_message_window(
        &mut self,
        mut messages: Vec<proto::Message>,
        has_older: bool,
        has_newer: bool,
    ) {
        messages.sort_by(|left, right| {
            (left.timestamp_ms, left.id.as_str()).cmp(&(right.timestamp_ms, right.id.as_str()))
        });
        if messages.len() > MAX_ACTIVE_MESSAGES {
            messages.drain(..messages.len() - MAX_ACTIVE_MESSAGES);
        }
        self.messages = messages;
        self.has_older_messages = has_older;
        self.has_newer_messages = has_newer;
        self.newer_activity = false;
        self.reindex_messages();
        self.rebuild_message_sizes();
    }

    pub fn update_receipt(&mut self, receipt: proto::ReceiptUpdated) {
        if let Some(message) = self
            .messages
            .iter_mut()
            .find(|message| message.id == receipt.message_id && message.chat_id == receipt.chat_id)
        {
            message.status = receipt.status;
        }
    }

    pub fn mark_selected_chat_read_locally(&mut self) -> Option<u32> {
        let id = self.selected_chat_id.as_deref()?;
        if let Some(chat) = self.chats.iter_mut().find(|chat| chat.id == id) {
            let previous = chat.unread_count;
            chat.unread_count = 0;
            return Some(previous);
        }
        None
    }

    pub fn restore_unread(&mut self, chat_id: &str, unread: u32) {
        if let Some(chat) = self.chats.iter_mut().find(|chat| chat.id == chat_id) {
            chat.unread_count = unread;
        }
    }

    pub fn set_chat_avatar(&mut self, chat_id: &str, avatar_path: String) {
        if let Some(chat) = self
            .chat_index
            .get(chat_id)
            .and_then(|index| self.chats.get_mut(*index))
        {
            chat.avatar_path = avatar_path;
        }
    }

    pub fn set_participant_avatar(&mut self, participant_id: String, avatar_path: String) {
        self.participant_avatar_paths
            .insert(participant_id, avatar_path);
    }

    pub fn set_message_image_path(
        &mut self,
        chat_id: &str,
        message_id: &str,
        image_path: String,
    ) -> bool {
        let Some(message) = self
            .message_index
            .get(message_id)
            .and_then(|index| self.messages.get_mut(*index))
            .filter(|message| message.chat_id == chat_id)
        else {
            return false;
        };
        let Some(proto::message::Content::Image(image)) = message.content.as_mut() else {
            return false;
        };
        if image.local_path == image_path {
            return false;
        }
        image.local_path = image_path;
        true
    }

    pub fn participant_avatar_path(&self, participant_id: &str) -> Option<&str> {
        self.participant_avatar_paths
            .get(participant_id)
            .map(String::as_str)
            .filter(|path| !path.is_empty())
    }

    pub fn apply_reaction(&mut self, reaction: proto::Reaction, removed: bool) {
        let Some(index) = self.message_index.get(&reaction.message_id).copied() else {
            return;
        };
        let message = &mut self.messages[index];
        if message.chat_id != reaction.chat_id {
            return;
        }
        if message.reactions.iter().any(|existing| {
            existing.sender_id == reaction.sender_id
                && existing.timestamp_ms > reaction.timestamp_ms
        }) {
            return;
        }
        message
            .reactions
            .retain(|existing| existing.sender_id != reaction.sender_id);
        if !removed && !reaction.emoji.is_empty() {
            message.reactions.push(reaction);
            message
                .reactions
                .sort_by_key(|reaction| (reaction.timestamp_ms, reaction.sender_id.clone()));
        }
        for heights in self.message_height_cache.values_mut() {
            heights.remove(&message.id);
        }
        self.measured_width_bucket = None;
    }

    pub fn message_sizes(&self) -> Rc<Vec<Size<Pixels>>> {
        self.message_sizes.clone()
    }

    pub fn message_sizes_need_measurement(&self, width_bucket: i32) -> bool {
        self.measured_width_bucket != Some(width_bucket)
            || self.message_sizes.len() != self.messages.len()
    }

    pub fn set_measured_message_sizes(&mut self, width_bucket: i32, sizes: Vec<Size<Pixels>>) {
        debug_assert_eq!(sizes.len(), self.messages.len());
        self.message_sizes = Rc::new(sizes);
        self.measured_width_bucket = Some(width_bucket);
        self.message_height_cache
            .retain(|bucket, _| *bucket == width_bucket);
    }

    pub fn cached_message_height(&self, id: &str, width_bucket: i32) -> Option<Pixels> {
        self.message_height_cache
            .get(&width_bucket)
            .and_then(|heights| heights.get(id))
            .copied()
    }

    pub fn cache_message_height(&mut self, id: String, width_bucket: i32, height: Pixels) {
        self.message_height_cache
            .entry(width_bucket)
            .or_default()
            .insert(id, height);
    }

    pub fn invalidate_all_message_heights(&mut self) {
        self.message_height_cache.clear();
        self.measured_width_bucket = None;
    }

    pub fn replace_chat_page(
        &mut self,
        cursor: &str,
        chats: Vec<proto::Chat>,
        total_count: u64,
        next_cursor: String,
    ) {
        let mut by_id: HashMap<String, proto::Chat> = if cursor.is_empty() {
            HashMap::with_capacity(chats.len())
        } else {
            self.chats
                .drain(..)
                .map(|chat| (chat.id.clone(), chat))
                .collect()
        };
        by_id.extend(chats.into_iter().map(|chat| (chat.id.clone(), chat)));
        self.chats = by_id.into_values().collect();
        self.chats.sort_by(compare_chats);
        self.reindex_chats();
        self.total_chats = total_count;
        self.next_chat_cursor = next_cursor;
    }

    fn trim_after_live_append(&mut self) {
        if self.messages.len() > MAX_ACTIVE_MESSAGES {
            let excess = self.messages.len() - MAX_ACTIVE_MESSAGES;
            self.messages.drain(..excess);
            self.has_older_messages = true;
        }
    }

    fn reindex_chats(&mut self) {
        self.chat_index = self
            .chats
            .iter()
            .enumerate()
            .map(|(index, chat)| (chat.id.clone(), index))
            .collect();
    }

    fn reindex_messages(&mut self) {
        self.message_index = self
            .messages
            .iter()
            .enumerate()
            .map(|(index, message)| (message.id.clone(), index))
            .collect();
    }

    fn rebuild_message_sizes(&mut self) {
        self.message_sizes = Rc::new(
            self.messages
                .iter()
                .map(|message| size(px(1.), estimate_message_height(message)))
                .collect(),
        );
        self.measured_width_bucket = None;
    }
}

pub fn message_text(message: &proto::Message) -> &str {
    if message.revoked {
        return "This message was deleted";
    }
    match &message.content {
        Some(proto::message::Content::Text(text)) => text.text.as_str(),
        Some(proto::message::Content::Image(image)) => image.caption.as_str(),
        Some(proto::message::Content::Attachment(attachment)) => {
            if !attachment.caption.is_empty() {
                attachment.caption.as_str()
            } else if !attachment.file_name.is_empty() {
                attachment.file_name.as_str()
            } else {
                attachment.kind.as_str()
            }
        }
        Some(proto::message::Content::Contacts(contacts)) => contacts
            .contacts
            .first()
            .map(|contact| contact.display_name.as_str())
            .filter(|name| !name.is_empty())
            .unwrap_or("Contact"),
        Some(proto::message::Content::Location(location)) => {
            if !location.name.is_empty() {
                location.name.as_str()
            } else if !location.address.is_empty() {
                location.address.as_str()
            } else {
                "Location"
            }
        }
        Some(proto::message::Content::Unsupported(unsupported)) => {
            unsupported.fallback_text.as_str()
        }
        None => "Unsupported message",
    }
}

fn preserve_local_image_path(incoming: &mut proto::Message, existing: &proto::Message) {
    let Some(proto::message::Content::Image(incoming_image)) = incoming.content.as_mut() else {
        return;
    };
    if !incoming_image.local_path.is_empty() {
        return;
    }
    if let Some(proto::message::Content::Image(existing_image)) = existing.content.as_ref() {
        incoming_image
            .local_path
            .clone_from(&existing_image.local_path);
    }
}

#[derive(Debug, Eq, PartialEq)]
pub struct ReactionCount<'a> {
    pub emoji: &'a str,
    pub count: usize,
    pub from_me: bool,
}

pub fn reaction_counts(message: &proto::Message) -> Vec<ReactionCount<'_>> {
    let mut counts: Vec<ReactionCount<'_>> = Vec::new();
    for reaction in message
        .reactions
        .iter()
        .filter(|reaction| !reaction.emoji.is_empty())
    {
        if let Some(existing) = counts
            .iter_mut()
            .find(|existing| existing.emoji == reaction.emoji.as_str())
        {
            existing.count += 1;
            existing.from_me |= reaction.from_me;
        } else {
            counts.push(ReactionCount {
                emoji: reaction.emoji.as_str(),
                count: 1,
                from_me: reaction.from_me,
            });
        }
    }
    counts
}

pub fn reactions_for_emoji(message: &proto::Message, emoji: &str) -> Vec<proto::Reaction> {
    let mut reactions: Vec<proto::Reaction> = Vec::new();
    for reaction in message
        .reactions
        .iter()
        .filter(|reaction| reaction.emoji == emoji)
    {
        let existing = reactions.iter().position(|candidate| {
            (reaction.from_me && candidate.from_me)
                || (!reaction.sender_id.is_empty() && reaction.sender_id == candidate.sender_id)
        });
        if let Some(index) = existing {
            if reaction.timestamp_ms >= reactions[index].timestamp_ms {
                reactions[index] = reaction.clone();
            }
        } else {
            reactions.push(reaction.clone());
        }
    }
    reactions.sort_by(|left, right| {
        right.from_me.cmp(&left.from_me).then_with(|| {
            reaction_sender_name(left)
                .to_lowercase()
                .cmp(&reaction_sender_name(right).to_lowercase())
        })
    });
    reactions
}

pub fn reaction_sender_name(reaction: &proto::Reaction) -> &str {
    if reaction.from_me {
        "You"
    } else if !reaction.sender_name.trim().is_empty() {
        reaction.sender_name.trim()
    } else if !reaction.sender_phone_number.trim().is_empty() {
        reaction.sender_phone_number.trim()
    } else if !reaction.sender_id.trim().is_empty() {
        reaction.sender_id.trim()
    } else {
        "Unknown contact"
    }
}

pub fn reaction_sender_detail(reaction: &proto::Reaction) -> &str {
    let phone = reaction.sender_phone_number.trim();
    if !phone.is_empty() && phone != reaction_sender_name(reaction) {
        phone
    } else if reaction.from_me {
        "Your reaction"
    } else {
        let sender_id = reaction.sender_id.trim();
        if !sender_id.is_empty() && sender_id != reaction_sender_name(reaction) {
            sender_id
        } else {
            "WhatsApp contact"
        }
    }
}

fn compare_chats(left: &proto::Chat, right: &proto::Chat) -> std::cmp::Ordering {
    right
        .pinned
        .cmp(&left.pinned)
        .then_with(|| {
            right
                .last_message_timestamp_ms
                .cmp(&left.last_message_timestamp_ms)
        })
        .then_with(|| left.id.cmp(&right.id))
}

fn estimate_message_height(message: &proto::Message) -> Pixels {
    let text = message_text(message);
    let lines = text
        .lines()
        .map(|line| (line.chars().count().max(1) as f32 / 46.0).ceil())
        .sum::<f32>()
        .max(1.0);
    let image_height = match message.content.as_ref() {
        Some(proto::message::Content::Image(image)) => estimated_image_height(image),
        _ => 0.0,
    };
    let reply_height = if message.reply_to_message_id.is_empty() {
        0.0
    } else {
        54.0
    };
    px(48.0 + (lines - 1.0) * 18.0 + image_height + reply_height)
}

fn estimated_image_height(image: &proto::ImageContent) -> f32 {
    if image.width == 0 || image.height == 0 {
        return 220.0;
    }
    let max_edge = if image.sticker { 220.0 } else { 320.0 };
    let source_width = image.width as f32;
    let source_height = image.height as f32;
    let scale = (max_edge / source_width).min(max_edge / source_height);
    source_height * scale
}

#[cfg(test)]
mod tests {
    use super::*;

    fn message(id: usize) -> proto::Message {
        proto::Message {
            id: id.to_string(),
            chat_id: "chat".into(),
            timestamp_ms: id as i64,
            ..Default::default()
        }
    }

    #[test]
    fn message_window_is_bounded_and_sorted() {
        let mut store = Store {
            selected_chat_id: Some("chat".into()),
            ..Default::default()
        };
        for id in (0..MAX_ACTIVE_MESSAGES + 50).rev() {
            store.upsert_message(message(id));
        }
        assert_eq!(store.messages.len(), MAX_ACTIVE_MESSAGES);
        assert_eq!(store.messages.first().unwrap().id, "50");
        assert!(store.has_older_messages);
    }

    #[test]
    fn upserts_are_idempotent() {
        let mut store = Store {
            selected_chat_id: Some("chat".into()),
            ..Default::default()
        };
        store.upsert_message(message(1));
        store.upsert_message(message(1));
        assert_eq!(store.messages.len(), 1);
    }

    #[test]
    fn reply_count_tracks_messages_pointing_at_the_same_target() {
        let mut store = Store {
            selected_chat_id: Some("chat".into()),
            ..Default::default()
        };
        store.upsert_message(message(1));
        let mut first_reply = message(2);
        first_reply.reply_to_message_id = "1".into();
        store.upsert_message(first_reply);
        let mut second_reply = message(3);
        second_reply.reply_to_message_id = "1".into();
        store.upsert_message(second_reply);

        assert_eq!(store.reply_count("1"), 2);
        assert_eq!(store.reply_count("2"), 0);
    }

    #[test]
    fn chat_views_keep_archived_conversations_out_of_the_inbox() {
        let mut store = Store::default();
        store.upsert_chat(proto::Chat {
            id: "inbox".into(),
            title: "Inbox".into(),
            ..Default::default()
        });
        store.upsert_chat(proto::Chat {
            id: "archived".into(),
            title: "Archived".into(),
            archived: true,
            ..Default::default()
        });

        assert_eq!(store.chat_ids(ChatView::Inbox), vec!["inbox"]);
        assert_eq!(store.chat_ids(ChatView::Archived), vec!["archived"]);
    }

    #[test]
    fn sync_progress_is_cumulative_and_records_completion() {
        let mut store = Store::default();
        store.apply_sync_progress(8, 120, false);
        store.apply_sync_progress(3, 40, true);

        assert_eq!(store.sync_chats, 11);
        assert_eq!(store.sync_messages, 160);
        assert!(!store.sync_active);
        assert!(store.sync_complete);
    }

    #[test]
    fn new_message_kinds_have_readable_timeline_text() {
        let with_content = |content| proto::Message {
            content: Some(content),
            ..Default::default()
        };
        let attachment = with_content(proto::message::Content::Attachment(
            proto::AttachmentContent {
                file_name: "agenda.pdf".into(),
                kind: "document".into(),
                ..Default::default()
            },
        ));
        let contacts = with_content(proto::message::Content::Contacts(proto::ContactsContent {
            contacts: vec![proto::ContactContent {
                display_name: "Meow Friend".into(),
                ..Default::default()
            }],
        }));
        let location = with_content(proto::message::Content::Location(proto::LocationContent {
            address: "Cat Street".into(),
            ..Default::default()
        }));

        assert_eq!(message_text(&attachment), "agenda.pdf");
        assert_eq!(message_text(&contacts), "Meow Friend");
        assert_eq!(message_text(&location), "Cat Street");
    }

    #[test]
    fn reactions_replace_by_sender_remove_and_invalidate_height() {
        let mut store = Store {
            selected_chat_id: Some("chat".into()),
            ..Default::default()
        };
        store.upsert_message(message(1));
        store.set_measured_message_sizes(42, vec![size(px(1.), px(48.))]);
        let reaction = |emoji: &str| proto::Reaction {
            chat_id: "chat".into(),
            message_id: "1".into(),
            sender_id: "participant".into(),
            emoji: emoji.into(),
            ..Default::default()
        };

        store.apply_reaction(reaction("👍"), false);
        assert_eq!(store.messages[0].reactions[0].emoji, "👍");
        assert!(store.message_sizes_need_measurement(42));

        store.apply_reaction(reaction("❤️"), false);
        assert_eq!(store.messages[0].reactions.len(), 1);
        assert_eq!(store.messages[0].reactions[0].emoji, "❤️");

        let mut stale_removal = reaction("");
        stale_removal.timestamp_ms = -1;
        store.apply_reaction(stale_removal, true);
        assert_eq!(store.messages[0].reactions[0].emoji, "❤️");

        store.apply_reaction(reaction(""), true);
        assert!(store.messages[0].reactions.is_empty());
    }

    #[test]
    fn historical_reactions_survive_message_upsert_and_group_into_chips() {
        let mut store = Store {
            selected_chat_id: Some("chat".into()),
            ..Default::default()
        };
        let mut historical = message(1);
        historical.reactions = vec![
            proto::Reaction {
                emoji: "👍".into(),
                sender_id: "one".into(),
                ..Default::default()
            },
            proto::Reaction {
                emoji: "❤️".into(),
                sender_id: "two".into(),
                ..Default::default()
            },
            proto::Reaction {
                emoji: "👍".into(),
                sender_id: "three".into(),
                from_me: true,
                ..Default::default()
            },
            proto::Reaction::default(),
        ];
        store.upsert_message(historical);

        assert_eq!(
            reaction_counts(&store.messages[0]),
            vec![
                ReactionCount {
                    emoji: "👍",
                    count: 2,
                    from_me: true,
                },
                ReactionCount {
                    emoji: "❤️",
                    count: 1,
                    from_me: false,
                },
            ]
        );
    }

    #[test]
    fn reactor_details_filter_one_emoji_put_you_first_and_resolve_identity() {
        let mut historical = message(1);
        historical.reactions = vec![
            proto::Reaction {
                emoji: "👍".into(),
                sender_id: "lid-one".into(),
                sender_name: "Saved Contact".into(),
                sender_phone_number: "+10000000001".into(),
                ..Default::default()
            },
            proto::Reaction {
                emoji: "❤️".into(),
                sender_name: "Other Emoji".into(),
                ..Default::default()
            },
            proto::Reaction {
                emoji: "👍".into(),
                sender_id: "me".into(),
                from_me: true,
                ..Default::default()
            },
            proto::Reaction {
                emoji: "👍".into(),
                sender_id: "lid-phone".into(),
                sender_phone_number: "+10000000002".into(),
                ..Default::default()
            },
        ];

        let reactors = reactions_for_emoji(&historical, "👍");
        assert_eq!(reactors.len(), 3);
        assert_eq!(reaction_sender_name(&reactors[0]), "You");
        assert_eq!(reaction_sender_detail(&reactors[0]), "Your reaction");
        assert_eq!(reaction_sender_name(&reactors[1]), "+10000000002");
        assert_eq!(reaction_sender_name(&reactors[2]), "Saved Contact");
        assert_eq!(reaction_sender_detail(&reactors[2]), "+10000000001");
    }

    #[test]
    fn reaction_events_never_create_message_bubbles() {
        let mut store = Store {
            selected_chat_id: Some("chat".into()),
            ..Default::default()
        };
        store.apply_reaction(
            proto::Reaction {
                chat_id: "chat".into(),
                message_id: "missing-message".into(),
                sender_id: "participant".into(),
                emoji: "👍".into(),
                ..Default::default()
            },
            false,
        );
        assert!(store.messages.is_empty());
    }

    #[test]
    fn participant_avatars_are_cached_by_sender() {
        let mut store = Store::default();
        store.set_participant_avatar("participant".into(), "/tmp/avatar.jpg".into());
        assert_eq!(
            store.participant_avatar_path("participant"),
            Some("/tmp/avatar.jpg")
        );
        assert_eq!(store.participant_avatar_path("unknown"), None);
    }

    #[test]
    fn image_download_path_survives_message_replay() {
        let mut store = Store {
            selected_chat_id: Some("chat".into()),
            ..Default::default()
        };
        let mut image_message = message(1);
        image_message.content = Some(proto::message::Content::Image(proto::ImageContent {
            mime_type: "image/jpeg".into(),
            downloadable: true,
            ..Default::default()
        }));
        store.upsert_message(image_message.clone());
        assert!(store.set_message_image_path("chat", "1", "/cache/photo.jpg".into()));
        store.upsert_message(image_message);
        let Some(proto::message::Content::Image(image)) = store.messages[0].content.as_ref() else {
            panic!("image content missing");
        };
        assert_eq!(image.local_path, "/cache/photo.jpg");
        assert_eq!(message_text(&store.messages[0]), "");
    }

    #[test]
    fn chat_pages_bulk_merge_to_ten_thousand_without_duplicates() {
        let mut store = Store::default();
        for page in 0..100 {
            let cursor = if page == 0 {
                String::new()
            } else {
                (page * 100).to_string()
            };
            let chats = (page * 100..(page + 1) * 100)
                .map(|id| proto::Chat {
                    id: format!("chat-{id}"),
                    last_message_timestamp_ms: 10_000 - id as i64,
                    ..Default::default()
                })
                .collect();
            store.replace_chat_page(&cursor, chats, 10_000, ((page + 1) * 100).to_string());
        }
        assert_eq!(store.chats.len(), 10_000);
        assert_eq!(store.chat_index.len(), 10_000);
        assert_eq!(store.chats.first().unwrap().id, "chat-0");
    }

    #[test]
    fn prepend_at_capacity_keeps_older_window_and_exposes_newer_navigation() {
        let mut store = Store {
            selected_chat_id: Some("chat".into()),
            ..Default::default()
        };
        for id in 100..100 + MAX_ACTIVE_MESSAGES {
            store.upsert_message(message(id));
        }
        store.prepend_messages((0..100).map(message).collect());
        assert_eq!(store.messages.len(), MAX_ACTIVE_MESSAGES);
        assert_eq!(store.messages.first().unwrap().id, "0");
        assert_eq!(store.messages.last().unwrap().id, "1999");
        assert!(store.has_newer_messages);
    }

    #[test]
    fn forward_pages_append_in_order_without_duplicates() {
        let mut store = Store {
            selected_chat_id: Some("chat".into()),
            ..Default::default()
        };
        store.replace_message_window(vec![message(1), message(2)], true, true);
        store.append_newer_messages(vec![message(2), message(3)], false);
        assert_eq!(
            store
                .messages
                .iter()
                .map(|message| message.id.as_str())
                .collect::<Vec<_>>(),
            ["1", "2", "3"]
        );
        assert!(!store.has_newer_messages);
        assert!(store.has_older_messages);
    }

    #[test]
    fn forward_page_keeps_activity_that_arrived_during_the_request() {
        let mut store = Store {
            selected_chat_id: Some("chat".into()),
            ..Default::default()
        };
        store.replace_message_window(vec![message(1)], false, true);
        store.newer_activity = true;
        store.append_newer_messages(vec![message(2)], false);
        assert!(store.has_newer_messages);
    }

    #[test]
    fn clearing_account_state_removes_cross_account_data() {
        let mut store = Store {
            selected_chat_id: Some("private-chat".into()),
            total_chats: 1,
            qr_code: Some("stale".into()),
            ..Default::default()
        };
        store.upsert_chat(proto::Chat {
            id: "private-chat".into(),
            ..Default::default()
        });
        store.upsert_message(message(1));
        store.clear_account_state();
        assert!(store.chats.is_empty());
        assert!(store.messages.is_empty());
        assert!(store.selected_chat_id.is_none());
        assert!(store.qr_code.is_none());
        assert_eq!(store.total_chats, 0);
    }

    #[test]
    fn live_chat_reorder_updates_only_affected_indices_correctly() {
        let mut store = Store::default();
        store.replace_chat_page(
            "",
            (0..1_000)
                .map(|id| proto::Chat {
                    id: format!("chat-{id}"),
                    last_message_timestamp_ms: 1_000 - id,
                    ..Default::default()
                })
                .collect(),
            1_000,
            String::new(),
        );
        let moved_id = store.chats[800].id.clone();
        store.upsert_chat(proto::Chat {
            id: moved_id.clone(),
            last_message_timestamp_ms: 50_000,
            ..Default::default()
        });
        assert_eq!(store.chats[0].id, moved_id);
        for (index, chat) in store.chats.iter().enumerate() {
            assert_eq!(store.chat_index.get(&chat.id), Some(&index));
        }
    }

    #[test]
    fn logout_pending_is_explicit_until_the_rpc_result_arrives() {
        let mut store = Store::default();
        store.pending.insert(42, PendingRequest::Logout);
        assert!(store.logout_pending());
        store.pending.remove(&42);
        assert!(!store.logout_pending());
    }

    #[test]
    fn chat_merge_redirects_the_active_selection_and_removes_the_loser() {
        let mut store = Store::default();
        store.upsert_chat(proto::Chat {
            id: "c:old".into(),
            title: "Old".into(),
            ..Default::default()
        });
        store.upsert_chat(proto::Chat {
            id: "c:new".into(),
            title: "New".into(),
            ..Default::default()
        });
        store.select_chat("c:old".into());

        assert!(store.merge_chat_id("c:old", "c:new"));
        assert_eq!(store.selected_chat_id.as_deref(), Some("c:new"));
        assert!(store.chats.iter().all(|chat| chat.id != "c:old"));
        assert_eq!(store.chat_index.get("c:new"), Some(&0));
    }

    #[test]
    fn centered_message_window_preserves_order_and_navigation_flags() {
        let mut store = Store {
            selected_chat_id: Some("chat".into()),
            ..Default::default()
        };
        store.replace_message_window(vec![message(3), message(1), message(2)], true, true);
        assert_eq!(
            store
                .messages
                .iter()
                .map(|message| message.id.as_str())
                .collect::<Vec<_>>(),
            ["1", "2", "3"]
        );
        assert!(store.has_older_messages);
        assert!(store.has_newer_messages);
        assert!(!store.newer_activity);
        assert_eq!(
            store.message("2").map(|message| message.id.as_str()),
            Some("2")
        );
    }
}
