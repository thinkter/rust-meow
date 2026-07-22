mod bridge;
mod emoji_picker;
mod model;
mod paths;
mod proto;
mod rpc;
mod settings;
mod sticker;

use std::{
    collections::{HashMap, HashSet},
    fs,
    io::Read as _,
    ops::Range,
    path::PathBuf,
    rc::Rc,
    sync::Arc,
    time::{Duration, Instant},
};

use gpui::prelude::FluentBuilder as _;
use gpui::{
    AnyWindowHandle, App, AppContext as _, Context, Entity, FocusHandle, Focusable as _,
    InteractiveElement as _, IntoElement, KeyBinding, KeyDownEvent, ModifiersChangedEvent,
    ObjectFit, ParentElement as _, PathPromptOptions, Pixels, Point, Render, ScrollDelta,
    ScrollHandle, ScrollStrategy, ScrollWheelEvent, SharedString, StatefulInteractiveElement as _,
    Styled as _, StyledImage as _, Subscription, UniformListScrollHandle, WeakEntity, Window,
    WindowBounds, WindowOptions, actions, canvas, div, img, point, px, rgb, rgba, size,
    uniform_list,
};
use gpui_component::{
    ActiveTheme as _, Colorize as _, Disableable as _, Icon, IconName, Root, Sizable as _, Theme,
    ThemeMode, VirtualListScrollHandle,
    button::{Button, ButtonVariants as _},
    h_flex,
    input::{Input, InputEvent, InputState},
    scroll::{ScrollableElement as _, ScrollbarAxis},
    v_flex, v_virtual_list,
};
use gpui_component_assets::Assets;
use qrcode::{Color, QrCode};
use smol::Timer;
use uuid::Uuid;

use emoji_picker::{EmojiCategory, filtered as filter_emojis};
use model::{
    CHAT_PAGE_SIZE, ChatView, MESSAGE_PAGE_SIZE, Screen, Store, image_row_path, image_viewer_path,
    message_text, reaction_counts, reaction_sender_detail, reaction_sender_name,
    reactions_for_emoji,
};
use proto::{backend_event, rpc_request, rpc_response};
use rpc::{
    BridgeMessage, PROTOCOL_VERSION, PendingRequest, REACTION_REPAIR_RETRY, RpcClient, RpcIncoming,
    TIMEOUT_SWEEP_INTERVAL, avatar_retry, reaction_retry,
};

const DARK_GREEN: u32 = 0x075e54;
const PANEL: u32 = 0xf7faf9;
const EMOJI_COLUMNS: usize = 9;
const PARTICIPANT_AVATAR_REFRESH: Duration = Duration::from_secs(15 * 60);
const MAX_TEXT_BYTES: usize = 65_536;
const MAX_CAPTION_BYTES: usize = 4_096;
const MAX_IMAGE_BYTES: u64 = 32 * 1024 * 1024;
const MIN_UI_SCALE: f32 = 1.0;
const MAX_UI_SCALE: f32 = 1.5;
const UI_SCALE_STEP: f32 = 0.1;
const BASE_UI_FONT_SIZE: f32 = 16.0;
const BASE_MONO_FONT_SIZE: f32 = 13.0;
const MAX_RECENT_CHATS: usize = 10;
const SMOOTH_SCROLL_INPUT_RESET: Duration = Duration::from_millis(180);
const SMOOTH_SCROLL_FRAME: Duration = Duration::from_millis(16);
const SMOOTH_SCROLL_IMPULSE: f32 = 900.0;
const SMOOTH_SCROLL_MAX_VELOCITY: f32 = 3_600.0;
const SMOOTH_SCROLL_FRICTION: f32 = 10.0;
const SMOOTH_SCROLL_STOP_VELOCITY: f32 = 18.0;

actions!(rust_meow, [CycleRecentChat, CycleRecentChatReverse]);

#[derive(Clone, Copy)]
enum ScrollSurface {
    ChatList,
    Search,
    Messages,
    ChatInfo,
}

/// Adds a short inertial tail to discrete mouse-wheel input. Precise pixel
/// input is left alone because touchpads already provide their own gesture
/// phases and momentum through the window system.
#[derive(Default)]
struct SmoothScrollState {
    velocity_y: f32,
    last_input: Option<Instant>,
    running: bool,
    generation: u64,
}

impl SmoothScrollState {
    fn push_wheel(&mut self, delta_y: f32, now: Instant) -> Option<u64> {
        let direction = delta_y.signum();
        if direction == 0.0 {
            return None;
        }
        let continues_gesture = self.velocity_y.signum() == direction
            && self
                .last_input
                .is_some_and(|last| now.duration_since(last) <= SMOOTH_SCROLL_INPUT_RESET);
        if !continues_gesture {
            self.velocity_y = 0.0;
        }
        self.velocity_y = (self.velocity_y + direction * SMOOTH_SCROLL_IMPULSE)
            .clamp(-SMOOTH_SCROLL_MAX_VELOCITY, SMOOTH_SCROLL_MAX_VELOCITY);
        self.last_input = Some(now);
        if self.running {
            None
        } else {
            self.running = true;
            self.generation = self.generation.wrapping_add(1);
            Some(self.generation)
        }
    }

    fn advance(&mut self, generation: u64, elapsed_seconds: f32) -> Option<f32> {
        if !self.running || self.generation != generation {
            return None;
        }
        if self.velocity_y.abs() < SMOOTH_SCROLL_STOP_VELOCITY {
            self.finish();
            return None;
        }
        let distance = self.velocity_y * elapsed_seconds;
        self.velocity_y *= (-SMOOTH_SCROLL_FRICTION * elapsed_seconds).exp();
        Some(distance)
    }

    fn finish(&mut self) {
        self.velocity_y = 0.0;
        self.running = false;
        self.generation = self.generation.wrapping_add(1);
    }
}

fn is_safe_web_url(url: &str) -> bool {
    let remainder = url
        .strip_prefix("https://")
        .or_else(|| url.strip_prefix("http://"));
    remainder.is_some_and(|value| {
        !value.is_empty() && !value.starts_with('/') && !value.chars().any(char::is_whitespace)
    })
}

/// Splits one whitespace-delimited token around its first HTTP(S) URL. Common
/// sentence punctuation is kept outside the clickable target.
fn split_url_token(token: &str) -> Option<(&str, &str, &str)> {
    let start = match (token.find("https://"), token.find("http://")) {
        (Some(https), Some(http)) => https.min(http),
        (Some(https), None) => https,
        (None, Some(http)) => http,
        (None, None) => return None,
    };
    let candidate = &token[start..];
    let url =
        candidate.trim_end_matches(['.', ',', '!', '?', ';', ':', ')', ']', '}', '>', '"', '\'']);
    if !is_safe_web_url(url) {
        return None;
    }
    Some((&token[..start], url, &candidate[url.len()..]))
}

fn link_preview_host(url: &str) -> &str {
    url.strip_prefix("https://")
        .or_else(|| url.strip_prefix("http://"))
        .unwrap_or(url)
        .split('/')
        .next()
        .unwrap_or(url)
}

/// Returns the byte offset of the `@` opening an in-progress mention token
/// that ends at `cursor`. The `@` must start the text or follow whitespace,
/// and the partial query may not contain whitespace or another `@`.
fn mention_token_start(text: &str, cursor: usize) -> Option<usize> {
    if !text.is_char_boundary(cursor) {
        return None;
    }
    let before = &text[..cursor];
    for (offset, character) in before.char_indices().rev() {
        if character == '@' {
            let preceded_ok = before[..offset]
                .chars()
                .next_back()
                .is_none_or(char::is_whitespace);
            return preceded_ok.then_some(offset);
        }
        if character.is_whitespace() {
            return None;
        }
    }
    None
}

fn mention_display_name(participant: &proto::ChatParticipant) -> String {
    if !participant.display_name.is_empty() {
        participant.display_name.clone()
    } else if !participant.phone_number.is_empty() {
        participant.phone_number.clone()
    } else {
        participant
            .participant_id
            .split('@')
            .next()
            .unwrap_or_default()
            .to_string()
    }
}

/// Rewrites `@Name` tokens to the `@<jid-user>` wire form WhatsApp clients
/// expect, returning the rewritten text and the JIDs it still references.
/// Mentions whose token the user deleted are dropped.
fn encode_mentions(text: &str, mentions: &[MentionEntry]) -> (String, Vec<String>) {
    let mut wire = text.to_string();
    let mut jids = Vec::new();
    let mut ordered: Vec<&MentionEntry> = mentions.iter().collect();
    // Longest names first so "@Ann" can never clobber part of "@Anna Lee".
    ordered.sort_by_key(|entry| std::cmp::Reverse(entry.display_name.len()));
    for entry in ordered {
        if entry.display_name.is_empty() {
            continue;
        }
        let Some(user) = entry.jid.split('@').next().filter(|user| !user.is_empty()) else {
            continue;
        };
        let token = format!("@{}", entry.display_name);
        if wire.contains(&token) {
            wire = wire.replace(&token, &format!("@{user}"));
            if !jids.contains(&entry.jid) {
                jids.push(entry.jid.clone());
            }
        }
    }
    (wire, jids)
}

fn validate_text_message(text: &str) -> Result<(), String> {
    if text.trim().is_empty() {
        return Err("Type a message before sending".into());
    }
    if text.len() > MAX_TEXT_BYTES {
        return Err(format!(
            "Message is too long ({} of {MAX_TEXT_BYTES} bytes)",
            text.len()
        ));
    }
    Ok(())
}

fn validate_image_message(path: &std::path::Path, caption: &str) -> Result<(), String> {
    if caption.len() > MAX_CAPTION_BYTES {
        return Err(format!(
            "Caption is too long ({} of {MAX_CAPTION_BYTES} bytes)",
            caption.len()
        ));
    }
    let metadata =
        fs::metadata(path).map_err(|_| "The selected image cannot be read".to_string())?;
    if !metadata.is_file() || metadata.len() == 0 {
        return Err("The selected image is not a non-empty file".into());
    }
    if metadata.len() > MAX_IMAGE_BYTES {
        return Err("Image is larger than the 32 MiB limit".into());
    }
    let mut file =
        fs::File::open(path).map_err(|_| "The selected image cannot be opened".to_string())?;
    let mut header = [0_u8; 12];
    let read = file
        .read(&mut header)
        .map_err(|_| "The selected image cannot be read".to_string())?;
    let supported = (read >= 3 && header[..3] == [0xff, 0xd8, 0xff])
        || (read >= 8 && header[..8] == [0x89, b'P', b'N', b'G', 0x0d, 0x0a, 0x1a, 0x0a])
        || (read >= 6 && matches!(&header[..6], b"GIF87a" | b"GIF89a"))
        || (read >= 12 && &header[..4] == b"RIFF" && &header[8..12] == b"WEBP");
    if !supported {
        return Err("Choose a JPEG, PNG, GIF, or WebP image".into());
    }
    Ok(())
}

fn normalized_ui_scale(scale: f32) -> f32 {
    ((scale.clamp(MIN_UI_SCALE, MAX_UI_SCALE) * 10.0).round()) / 10.0
}

fn load_ui_scale() -> f32 {
    settings::load_ui_scale()
        .filter(|value| value.is_finite())
        .map(normalized_ui_scale)
        .unwrap_or(1.0)
}

fn save_ui_scale(scale: f32) -> std::io::Result<()> {
    settings::save_ui_scale(scale)
}

fn apply_theme_scale(scale: f32, window: &mut Window, cx: &mut gpui::App) {
    let theme = Theme::global_mut(cx);
    theme.font_size = px(BASE_UI_FONT_SIZE * scale);
    theme.mono_font_size = px(BASE_MONO_FONT_SIZE * scale);
    window.set_rem_size(theme.font_size);
    window.refresh();
}

#[derive(Clone, Debug)]
enum EmojiTarget {
    Composer,
    Reaction { chat_id: String, message_id: String },
}

#[derive(Clone)]
struct ReactionDetails {
    chat_id: String,
    message_id: String,
    emoji: String,
    reactions: Rc<Vec<proto::Reaction>>,
}

#[derive(Clone, Debug)]
struct ImageViewer {
    chat_id: String,
    message_id: String,
    path: String,
    caption: String,
    sticker: bool,
}

#[derive(Clone, Debug, Default, Eq, PartialEq)]
struct ChatDraft {
    text: String,
    reply_to_message_id: Option<String>,
    /// Participants tagged via the @ picker. Each entry backs an `@Name`
    /// token in `text`; tokens the user has since deleted are dropped at send.
    mentions: Vec<MentionEntry>,
}

#[derive(Clone, Debug, Eq, PartialEq)]
struct MentionEntry {
    display_name: String,
    jid: String,
}

#[derive(Clone, Debug, Eq, PartialEq)]
struct MentionPicker {
    chat_id: String,
    /// Byte offset of the `@` that opened the picker in the composer text.
    token_start: usize,
    query: String,
    highlighted: usize,
}

const MAX_MENTION_ROWS: usize = 8;

impl ChatDraft {
    fn is_empty(&self) -> bool {
        self.text.is_empty() && self.reply_to_message_id.is_none()
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
struct ChatSwitcher {
    chat_ids: Vec<String>,
    highlighted: usize,
}

struct ChatInfoState {
    chat_id: String,
    loading: bool,
    error: Option<String>,
    info: Option<proto::GetChatInfoResponse>,
}

/// Transient state for one peer. Each chat keeps a sender-keyed collection so
/// concurrent group participants do not overwrite one another.
struct TypingIndicator {
    sender_name: String,
    recording: bool,
    expires_at: Instant,
}

const TYPING_INDICATOR_TTL: Duration = Duration::from_secs(10);
/// How often the composer re-broadcasts "still typing" while text keeps
/// changing. WhatsApp peers expire remote composing state after ~10 seconds.
const TYPING_RESIGNAL: Duration = Duration::from_secs(8);

fn format_typing_label(
    indicators: &HashMap<String, TypingIndicator>,
    group: bool,
    now: Instant,
) -> Option<String> {
    let mut indicators = indicators
        .values()
        .filter(|indicator| indicator.expires_at > now)
        .collect::<Vec<_>>();
    if indicators.is_empty() {
        return None;
    }
    indicators.sort_by_key(|indicator| indicator.sender_name.to_lowercase());
    let action = if indicators.iter().all(|indicator| indicator.recording) {
        "recording audio…"
    } else {
        "typing…"
    };
    if !group {
        return Some(action.to_string());
    }
    let names = indicators
        .iter()
        .map(|indicator| {
            let name = indicator.sender_name.trim();
            if name.is_empty() { "Someone" } else { name }
        })
        .collect::<Vec<_>>();
    match names.as_slice() {
        [name] => Some(format!("{name} is {action}")),
        [first, second] => Some(format!("{first} and {second} are {action}")),
        [first, second, rest @ ..] => {
            let others = if rest.len() == 1 { "other" } else { "others" };
            Some(format!(
                "{first}, {second} and {} {others} are {action}",
                rest.len()
            ))
        }
        [] => None,
    }
}

#[derive(Clone, Debug, Default)]
struct SearchResults {
    contacts: Vec<proto::ContactSearchResult>,
    groups: Vec<proto::Chat>,
    messages: Vec<proto::MessageSearchResult>,
}

#[derive(Clone, Debug)]
enum SearchResultRow {
    Header {
        title: &'static str,
        count: usize,
    },
    Contact {
        result_index: usize,
        source_index: usize,
    },
    Group {
        result_index: usize,
        source_index: usize,
    },
    Message {
        result_index: usize,
        source_index: usize,
    },
}

#[derive(Clone, Debug)]
enum SearchTarget {
    Contact(String),
    Group(proto::Chat),
    Message {
        chat: Option<proto::Chat>,
        chat_id: String,
        message_id: String,
    },
}

impl SearchResults {
    fn len(&self) -> usize {
        self.contacts.len() + self.groups.len() + self.messages.len()
    }

    fn target(&self, mut index: usize) -> Option<SearchTarget> {
        if let Some(contact) = self.contacts.get(index) {
            return Some(SearchTarget::Contact(contact.contact_jid.clone()));
        }
        index = index.checked_sub(self.contacts.len())?;
        if let Some(group) = self.groups.get(index) {
            return Some(SearchTarget::Group(group.clone()));
        }
        index = index.checked_sub(self.groups.len())?;
        self.messages
            .get(index)
            .map(|message| SearchTarget::Message {
                chat: message.chat.clone(),
                chat_id: message.chat_id.clone(),
                message_id: message.message_id.clone(),
            })
    }

    fn rows(&self) -> Vec<SearchResultRow> {
        let mut rows = Vec::with_capacity(self.len() + 3);
        if !self.contacts.is_empty() {
            rows.push(SearchResultRow::Header {
                title: "Contacts",
                count: self.contacts.len(),
            });
            rows.extend(self.contacts.iter().enumerate().map(|(result_index, _)| {
                SearchResultRow::Contact {
                    result_index,
                    source_index: result_index,
                }
            }));
        }
        if !self.groups.is_empty() {
            rows.push(SearchResultRow::Header {
                title: "Groups",
                count: self.groups.len(),
            });
            rows.extend(
                self.groups
                    .iter()
                    .enumerate()
                    .map(|(offset, _)| SearchResultRow::Group {
                        result_index: self.contacts.len() + offset,
                        source_index: offset,
                    }),
            );
        }
        if !self.messages.is_empty() {
            rows.push(SearchResultRow::Header {
                title: "Messages",
                count: self.messages.len(),
            });
            rows.extend(self.messages.iter().enumerate().map(|(offset, _)| {
                SearchResultRow::Message {
                    result_index: self.contacts.len() + self.groups.len() + offset,
                    source_index: offset,
                }
            }));
        }
        rows
    }

    fn row_index_for_result(&self, result_index: usize) -> Option<usize> {
        let mut row_start = 0;
        let mut result_start = 0;
        for count in [self.contacts.len(), self.groups.len(), self.messages.len()] {
            if count == 0 {
                continue;
            }
            row_start += 1; // section header
            if result_index < result_start + count {
                return Some(row_start + result_index - result_start);
            }
            row_start += count;
            result_start += count;
        }
        None
    }
}

impl ChatSwitcher {
    fn new(chat_ids: Vec<String>, reverse: bool, selected_is_first: bool) -> Option<Self> {
        // With the active chat at the front there must be something else to
        // switch to; without one, any single candidate is a valid target.
        let min_len = if selected_is_first { 2 } else { 1 };
        if chat_ids.len() < min_len {
            return None;
        }
        let highlighted = match (reverse, selected_is_first) {
            (true, _) => chat_ids.len() - 1,
            (false, true) => 1,
            (false, false) => 0,
        };
        Some(Self {
            chat_ids,
            highlighted,
        })
    }

    fn cycle(&mut self, reverse: bool) {
        if reverse {
            self.highlighted = self
                .highlighted
                .checked_sub(1)
                .unwrap_or(self.chat_ids.len() - 1);
        } else {
            self.highlighted = (self.highlighted + 1) % self.chat_ids.len();
        }
    }

    fn selected_chat_id(&self) -> Option<&str> {
        self.chat_ids.get(self.highlighted).map(String::as_str)
    }
}

fn record_recent_chat(history: &mut Vec<String>, chat_id: &str) {
    history.retain(|existing| existing != chat_id);
    history.insert(0, chat_id.to_owned());
    history.truncate(MAX_RECENT_CHATS);
}

fn remap_recent_chat_ids(history: &mut Vec<String>, old_id: &str, new_id: &str) {
    for chat_id in history.iter_mut() {
        if chat_id == old_id {
            *chat_id = new_id.to_owned();
        }
    }
    let mut seen = HashSet::new();
    history.retain(|chat_id| seen.insert(chat_id.clone()));
    history.truncate(MAX_RECENT_CHATS);
}

fn remap_chat_draft(
    drafts: &mut HashMap<String, ChatDraft>,
    old_id: &str,
    new_id: &str,
    old_was_selected: bool,
) {
    let Some(old_draft) = drafts.remove(old_id) else {
        return;
    };
    if old_was_selected {
        drafts.insert(new_id.to_owned(), old_draft);
    } else {
        drafts.entry(new_id.to_owned()).or_insert(old_draft);
    }
}

impl ReactionDetails {
    fn new(chat_id: String, message: &proto::Message, emoji: String) -> Option<Self> {
        let reactions = reactions_for_emoji(message, &emoji);
        (!reactions.is_empty()).then(|| Self {
            chat_id,
            message_id: message.id.clone(),
            emoji,
            reactions: Rc::new(reactions),
        })
    }
}

struct RustMeow {
    rpc: RpcClient,
    store: Store,
    composer: Entity<InputState>,
    search_input: Entity<InputState>,
    search_query: String,
    search_results: SearchResults,
    search_generation: u64,
    search_highlighted: usize,
    search_error: Option<String>,
    search_scroll: VirtualListScrollHandle,
    search_smooth_scroll: SmoothScrollState,
    search_target_message_id: Option<String>,
    pending_search_scroll_id: Option<String>,
    pending_top_scroll_id: Option<String>,
    emoji_search: Entity<InputState>,
    emoji_query: String,
    emoji_category: EmojiCategory,
    emoji_results: Rc<Vec<&'static emojis::Emoji>>,
    emoji_target: Option<EmojiTarget>,
    reaction_details: Option<ReactionDetails>,
    image_viewer: Option<ImageViewer>,
    replying_to_message_id: Option<String>,
    chat_drafts: HashMap<String, ChatDraft>,
    recent_chat_ids: Vec<String>,
    chat_switcher: Option<ChatSwitcher>,
    chat_info: Option<ChatInfoState>,
    mention_picker: Option<MentionPicker>,
    mention_directories: HashMap<String, Vec<proto::ChatParticipant>>,
    mention_directory_pending: HashSet<String>,
    typing_indicators: HashMap<String, HashMap<String, TypingIndicator>>,
    typing_signal: Option<(String, Instant)>,
    focus_handle: FocusHandle,
    settings_open: bool,
    ui_scale: f32,
    chat_view: ChatView,
    chat_scroll: UniformListScrollHandle,
    chat_smooth_scroll: SmoothScrollState,
    message_scroll: VirtualListScrollHandle,
    message_smooth_scroll: SmoothScrollState,
    chat_info_scroll: ScrollHandle,
    chat_info_smooth_scroll: SmoothScrollState,
    scroll_to_bottom_generation: Option<u64>,
    last_event_sequence: u64,
    pending_prepend_anchor: Option<(String, Point<Pixels>)>,
    newer_load_failed: bool,
    message_generation: u64,
    sync_complete_reloaded: bool,
    confirming_logout: bool,
    avatar_attempted: HashSet<String>,
    avatar_retries: HashMap<String, u8>,
    participant_avatar_attempted: HashSet<String>,
    image_download_attempted: HashSet<(String, String)>,
    image_failures: HashMap<(String, String), String>,
    sticker_preparing: bool,
    reaction_repair_attempted: HashSet<String>,
    latest_reaction_intents: HashMap<(String, String), String>,
    _subscriptions: Vec<Subscription>,
}

impl RustMeow {
    fn new(window: &mut Window, cx: &mut Context<Self>) -> Self {
        let ui_scale = load_ui_scale();
        apply_theme_scale(ui_scale, window, cx);
        let fake = std::env::args().any(|arg| arg == "--fake-backend")
            || std::env::var_os("RUST_MEOW_FAKE").is_some();
        let (rpc, startup_error) = match RpcClient::start(fake) {
            Ok(rpc) => (rpc, None),
            Err(error) => (RpcClient::disconnected(), Some(error.to_string())),
        };
        let receiver = rpc.incoming();
        let composer = cx.new(|cx| {
            InputState::new(window, cx)
                .placeholder("Type a message")
                .clean_on_escape()
        });
        let emoji_search = cx.new(|cx| InputState::new(window, cx).placeholder("Search emoji"));
        let search_input = cx.new(|cx| {
            InputState::new(window, cx)
                .placeholder("Search contacts, groups, messages")
                .clean_on_escape()
        });
        let focus_handle = cx.focus_handle();
        // GPUI only routes key events along the focused path. Anchor focus to
        // the app root from the start so shortcuts work before (and after) any
        // text input holds focus.
        focus_handle.focus(window, cx);
        let _subscriptions = vec![
            cx.subscribe_in(&composer, window, {
                let composer = composer.clone();
                move |this, _, event, window, cx| {
                    if matches!(event, InputEvent::Change) {
                        let text = composer.read(cx).value().to_string();
                        let composing = !text.trim().is_empty();
                        this.update_active_draft_text(text);
                        this.refresh_mention_picker(cx);
                        this.signal_typing(composing);
                        cx.notify();
                    }
                    if matches!(event, InputEvent::PressEnter { shift: false, .. }) {
                        this.send_text(window, cx);
                    }
                }
            }),
            cx.subscribe_in(&emoji_search, window, {
                let emoji_search = emoji_search.clone();
                move |this, _, event, _, cx| {
                    if matches!(event, InputEvent::Change) {
                        this.emoji_query = emoji_search.read(cx).value().to_string();
                        this.rebuild_emoji_results();
                        cx.notify();
                    }
                }
            }),
            cx.subscribe_in(&search_input, window, {
                let search_input = search_input.clone();
                move |this, _, event, _, cx| {
                    if matches!(event, InputEvent::Change) {
                        let query = search_input.read(cx).value().to_string();
                        this.set_search_query(query, cx);
                    }
                }
            }),
        ];
        let view = cx.entity();
        cx.spawn_in(window, async move |_, window| {
            while let Ok(message) = receiver.recv().await {
                if window
                    .update(|window, cx| {
                        view.update(cx, |this, cx| {
                            this.handle_bridge(message, window, cx);
                            cx.notify();
                        })
                    })
                    .is_err()
                {
                    break;
                }
            }
        })
        .detach();
        let timeout_view = cx.entity();
        cx.spawn_in(window, async move |_, window| {
            loop {
                Timer::after(TIMEOUT_SWEEP_INTERVAL).await;
                if window
                    .update(|window, cx| {
                        timeout_view.update(cx, |this, cx| {
                            this.expire_stalled_requests(window, cx);
                            cx.notify();
                        })
                    })
                    .is_err()
                {
                    break;
                }
            }
        })
        .detach();

        let mut this = Self {
            rpc,
            store: Store::default(),
            composer,
            search_input,
            search_query: String::new(),
            search_results: SearchResults::default(),
            search_generation: 0,
            search_highlighted: 0,
            search_error: None,
            search_scroll: VirtualListScrollHandle::new(),
            search_smooth_scroll: SmoothScrollState::default(),
            search_target_message_id: None,
            pending_search_scroll_id: None,
            pending_top_scroll_id: None,
            emoji_search,
            emoji_query: String::new(),
            emoji_category: EmojiCategory::All,
            emoji_results: Rc::new(filter_emojis(EmojiCategory::All, "")),
            emoji_target: None,
            reaction_details: None,
            image_viewer: None,
            replying_to_message_id: None,
            chat_drafts: HashMap::new(),
            recent_chat_ids: Vec::new(),
            chat_switcher: None,
            chat_info: None,
            mention_picker: None,
            mention_directories: HashMap::new(),
            mention_directory_pending: HashSet::new(),
            typing_indicators: HashMap::new(),
            typing_signal: None,
            focus_handle,
            settings_open: false,
            ui_scale,
            chat_view: ChatView::Inbox,
            chat_scroll: UniformListScrollHandle::new(),
            chat_smooth_scroll: SmoothScrollState::default(),
            message_scroll: VirtualListScrollHandle::new(),
            message_smooth_scroll: SmoothScrollState::default(),
            chat_info_scroll: ScrollHandle::new(),
            chat_info_smooth_scroll: SmoothScrollState::default(),
            scroll_to_bottom_generation: None,
            last_event_sequence: 0,
            pending_prepend_anchor: None,
            newer_load_failed: false,
            message_generation: 0,
            sync_complete_reloaded: false,
            confirming_logout: false,
            avatar_attempted: HashSet::new(),
            avatar_retries: HashMap::new(),
            participant_avatar_attempted: HashSet::new(),
            image_download_attempted: HashSet::new(),
            image_failures: HashMap::new(),
            sticker_preparing: false,
            reaction_repair_attempted: HashSet::new(),
            latest_reaction_intents: HashMap::new(),
            _subscriptions,
        };
        if let Some(error) = startup_error {
            this.store.screen = Screen::Fatal;
            this.store.fatal_error = Some(format!("Could not start the local backend: {error}"));
            return this;
        }
        this.request(
            rpc_request::Request::Hello(proto::HelloRequest {
                desktop_version: env!("CARGO_PKG_VERSION").into(),
                minimum_protocol_version: PROTOCOL_VERSION,
                maximum_protocol_version: PROTOCOL_VERSION,
            }),
            PendingRequest::Hello,
        );
        this
    }

    fn smooth_scroll_state_mut(&mut self, surface: ScrollSurface) -> &mut SmoothScrollState {
        match surface {
            ScrollSurface::ChatList => &mut self.chat_smooth_scroll,
            ScrollSurface::Search => &mut self.search_smooth_scroll,
            ScrollSurface::Messages => &mut self.message_smooth_scroll,
            ScrollSurface::ChatInfo => &mut self.chat_info_smooth_scroll,
        }
    }

    fn smooth_scroll_handle(&self, surface: ScrollSurface) -> ScrollHandle {
        match surface {
            ScrollSurface::ChatList => self.chat_scroll.0.borrow().base_handle.clone(),
            ScrollSurface::Search => self.search_scroll.base_handle().clone(),
            ScrollSurface::Messages => self.message_scroll.base_handle().clone(),
            ScrollSurface::ChatInfo => self.chat_info_scroll.clone(),
        }
    }

    fn stop_smooth_scroll(&mut self, surface: ScrollSurface) {
        self.smooth_scroll_state_mut(surface).finish();
    }

    fn handle_smooth_scroll_input(
        &mut self,
        surface: ScrollSurface,
        event: &ScrollWheelEvent,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        let ScrollDelta::Lines(delta) = event.delta else {
            // A touchpad gesture should take over immediately from any
            // mouse-wheel animation still in flight.
            self.stop_smooth_scroll(surface);
            return;
        };
        let Some(generation) = self
            .smooth_scroll_state_mut(surface)
            .push_wheel(delta.y, Instant::now())
        else {
            return;
        };

        let view = cx.entity();
        cx.spawn_in(window, async move |_, window| {
            let mut last_frame = Instant::now();
            loop {
                Timer::after(SMOOTH_SCROLL_FRAME).await;
                let now = Instant::now();
                let elapsed = now
                    .duration_since(last_frame)
                    .as_secs_f32()
                    .clamp(0.001, 0.05);
                last_frame = now;
                let keep_running = window
                    .update(|_, cx| {
                        view.update(cx, |this, cx| {
                            let Some(distance) = this
                                .smooth_scroll_state_mut(surface)
                                .advance(generation, elapsed)
                            else {
                                return false;
                            };
                            let handle = this.smooth_scroll_handle(surface);
                            let offset = handle.offset();
                            let maximum = handle.max_offset().y;
                            let target_y = (offset.y + px(distance)).clamp(-maximum, px(0.));
                            if maximum <= px(0.) || target_y == offset.y {
                                this.stop_smooth_scroll(surface);
                                return false;
                            }
                            handle.set_offset(point(offset.x, target_y));
                            cx.notify();
                            true
                        })
                    })
                    .unwrap_or(false);
                if !keep_running {
                    break;
                }
            }
        })
        .detach();
    }

    fn request(&mut self, request: rpc_request::Request, pending: PendingRequest) {
        if let Err(error) = self.rpc.send(request, pending) {
            self.store.screen = Screen::Fatal;
            self.store.fatal_error = Some(error.to_string());
        }
    }

    fn expire_stalled_requests(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        // Piggyback on the 1s sweep: typing indicators expire locally because
        // the peer's terminal "paused" update can be lost.
        let now = Instant::now();
        self.typing_indicators.retain(|_, indicators| {
            indicators.retain(|_, indicator| indicator.expires_at > now);
            !indicators.is_empty()
        });
        for (_, pending) in self.rpc.expire() {
            match pending {
                PendingRequest::Hello | PendingRequest::Auth => {
                    self.store.screen = Screen::Fatal;
                    self.store.fatal_error = Some(
                        "The local backend stopped responding during startup. Restart Rust Meow to reconnect."
                            .into(),
                    );
                }
                PendingRequest::Avatar { chat_id } => {
                    self.avatar_attempted.remove(&chat_id);
                }
                PendingRequest::ParticipantAvatar { participant_id } => {
                    self.participant_avatar_attempted.remove(&participant_id);
                }
                PendingRequest::ChatInfo { chat_id } => {
                    if let Some(state) = self.chat_info.as_mut()
                        && state.chat_id == chat_id
                    {
                        state.loading = false;
                        state.error = Some("Loading chat info timed out. Try again.".into());
                    }
                }
                PendingRequest::MentionDirectory { chat_id } => {
                    self.mention_directory_pending.remove(&chat_id);
                }
                PendingRequest::MessageImage {
                    chat_id,
                    message_id,
                } => {
                    let sticker = self
                        .store
                        .message(&message_id)
                        .and_then(|message| message.content.as_ref())
                        .is_some_and(|content| {
                            matches!(content, proto::message::Content::Image(image) if image.sticker)
                        });
                    self.image_failures.insert(
                        (chat_id, message_id),
                        if sticker {
                            "Sticker download timed out · Click to retry".into()
                        } else {
                            "Photo download timed out · Click to retry".into()
                        },
                    );
                }
                PendingRequest::Search { generation, .. }
                    if generation == self.search_generation =>
                {
                    self.search_error = Some("Search timed out. Try again.".into());
                }
                PendingRequest::SendText {
                    chat_id,
                    draft_text,
                    reply_to_message_id,
                    mentions,
                } => {
                    self.restore_failed_draft(
                        &chat_id,
                        &draft_text,
                        reply_to_message_id,
                        &mentions,
                        window,
                        cx,
                    );
                    self.store.toast_error =
                        Some("Sending timed out. Your draft was restored; try again.".into());
                }
                PendingRequest::SendImage {
                    chat_id,
                    draft_text,
                    reply_to_message_id,
                } => {
                    self.restore_failed_draft(
                        &chat_id,
                        &draft_text,
                        reply_to_message_id,
                        &[],
                        window,
                        cx,
                    );
                    self.store.toast_error =
                        Some("Sending timed out. Your draft was restored; try again.".into());
                }
                PendingRequest::SendReaction {
                    chat_id,
                    message_id,
                    client_reaction_id,
                    ..
                } => {
                    self.clear_reaction_intent_if_current(
                        &chat_id,
                        &message_id,
                        &client_reaction_id,
                    );
                    self.store.toast_error = Some("Reaction timed out. Try again.".into());
                }
                PendingRequest::MarkRead {
                    chat_id,
                    previous_unread,
                } => {
                    self.store.restore_unread(&chat_id, previous_unread);
                    self.store.last_mark_read_id = None;
                    self.store.toast_error = Some("Mark as read timed out. Try again.".into());
                }
                PendingRequest::Messages { prepend: true, .. } => {
                    self.pending_prepend_anchor = None;
                    self.store.toast_error = Some("Loading messages timed out. Try again.".into());
                }
                PendingRequest::MessagesAfter { .. } => {
                    self.newer_load_failed = true;
                    self.store.toast_error =
                        Some("Loading newer messages timed out. Try again.".into());
                }
                PendingRequest::Logout => {
                    self.confirming_logout = false;
                    self.store.toast_error = Some("Logout timed out. Try again.".into());
                }
                PendingRequest::Search { .. } => {}
                // Best-effort presence broadcast; peers expire it on their own.
                PendingRequest::SetTyping => {}
                _ => {
                    self.store.toast_error = Some("Backend request timed out. Try again.".into());
                }
            }
        }
    }

    fn set_search_query(&mut self, query: String, cx: &mut Context<Self>) {
        self.search_query = query;
        self.search_generation = self.search_generation.wrapping_add(1);
        self.search_results = SearchResults::default();
        self.search_highlighted = 0;
        self.search_error = None;
        self.stop_smooth_scroll(ScrollSurface::Search);
        self.search_scroll.scroll_to_item(0, ScrollStrategy::Top);
        let trimmed = self.search_query.trim().to_owned();
        let generation = self.search_generation;
        if trimmed.chars().count() < 2 {
            cx.notify();
            return;
        }
        cx.spawn(async move |this, cx| {
            Timer::after(Duration::from_millis(150)).await;
            let _ = this.update(cx, |this, cx| {
                if this.search_generation != generation || this.search_query.trim() != trimmed {
                    return;
                }
                this.request(
                    rpc_request::Request::SearchLocal(proto::SearchLocalRequest {
                        query: trimmed.clone(),
                    }),
                    PendingRequest::Search {
                        query: trimmed,
                        generation,
                    },
                );
                cx.notify();
            });
        })
        .detach();
        cx.notify();
    }

    fn focus_search(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        if self.store.screen != Screen::Chats {
            return;
        }
        self.settings_open = false;
        self.chat_switcher = None;
        self.reaction_details = None;
        self.image_viewer = None;
        self.chat_info = None;
        self.search_input
            .update(cx, |input, cx| input.focus(window, cx));
    }

    fn clear_search(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        self.search_generation = self.search_generation.wrapping_add(1);
        self.search_query.clear();
        self.search_results = SearchResults::default();
        self.search_highlighted = 0;
        self.search_error = None;
        self.stop_smooth_scroll(ScrollSurface::Search);
        self.search_scroll.scroll_to_item(0, ScrollStrategy::Top);
        self.search_input
            .update(cx, |input, cx| input.set_value("", window, cx));
    }

    fn move_search_selection(&mut self, reverse: bool) {
        let count = self.search_results.len();
        if count == 0 {
            self.search_highlighted = 0;
        } else if reverse {
            self.search_highlighted = self.search_highlighted.checked_sub(1).unwrap_or(count - 1);
        } else {
            self.search_highlighted = (self.search_highlighted + 1) % count;
        }
        if let Some(row_index) = self
            .search_results
            .row_index_for_result(self.search_highlighted)
        {
            self.stop_smooth_scroll(ScrollSurface::Search);
            self.search_scroll
                .scroll_to_item(row_index, ScrollStrategy::Center);
        }
    }

    fn activate_search_result(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let Some(target) = self.search_results.target(self.search_highlighted) else {
            return;
        };
        match target {
            SearchTarget::Contact(contact_jid) => {
                self.request(
                    rpc_request::Request::OpenContact(proto::OpenContactRequest {
                        contact_jid: contact_jid.clone(),
                    }),
                    PendingRequest::OpenContact,
                );
            }
            SearchTarget::Group(chat) => {
                let chat_id = chat.id.clone();
                self.store.upsert_chat(chat);
                self.clear_search(window, cx);
                self.open_chat(chat_id, window, cx);
            }
            SearchTarget::Message {
                chat,
                chat_id,
                message_id,
            } => {
                if let Some(chat) = chat {
                    self.store.upsert_chat(chat);
                }
                self.clear_search(window, cx);
                self.message_generation = self.message_generation.wrapping_add(1);
                self.store.select_chat(chat_id.clone());
                self.chat_view = if self.store.chat(&chat_id).is_some_and(|chat| chat.archived) {
                    ChatView::Archived
                } else {
                    ChatView::Inbox
                };
                record_recent_chat(&mut self.recent_chat_ids, &chat_id);
                let draft = self.chat_drafts.get(&chat_id).cloned().unwrap_or_default();
                self.replying_to_message_id = draft.reply_to_message_id;
                self.composer.update(cx, |input, cx| {
                    input.set_value(draft.text, window, cx);
                    input.focus(window, cx);
                });
                self.emoji_target = None;
                self.reaction_details = None;
                self.image_viewer = None;
                self.scroll_to_bottom_generation = None;
                self.pending_top_scroll_id = None;
                self.newer_load_failed = false;
                self.image_download_attempted.clear();
                self.image_failures.clear();
                self.search_target_message_id = Some(message_id.clone());
                self.request(
                    rpc_request::Request::ListMessagesAround(proto::ListMessagesAroundRequest {
                        chat_id: chat_id.clone(),
                        message_id: message_id.clone(),
                    }),
                    PendingRequest::MessagesAround {
                        chat_id,
                        message_id,
                        generation: self.message_generation,
                    },
                );
            }
        }
        cx.notify();
    }

    fn handle_bridge(
        &mut self,
        message: BridgeMessage,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        match self.rpc.handle_incoming(message) {
            RpcIncoming::Response { pending, response } => {
                self.handle_response(pending, response, window, cx)
            }
            RpcIncoming::Event(event) => self.handle_event(event),
            RpcIncoming::Exited(error) => {
                self.store.connection = proto::ConnectionState::Failed;
                self.store.connection_detail = error;
                self.store.toast_error =
                    Some("Backend stopped. Restart Rust Meow to reconnect.".into());
            }
            RpcIncoming::Invalid => {
                self.store.toast_error = Some("Ignored an invalid backend envelope".into())
            }
            RpcIncoming::Ignore => {}
        }
    }

    fn handle_response(
        &mut self,
        pending: PendingRequest,
        response: proto::RpcResponse,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        let Some(result) = response.result else {
            self.store.toast_error = Some("Backend returned an empty response".into());
            return;
        };
        if let rpc_response::Result::Error(error) = result {
            if let PendingRequest::Search { generation, .. } = &pending {
                if *generation == self.search_generation {
                    self.search_error = Some(error.message);
                }
                return;
            }
            if let PendingRequest::MessagesAround {
                chat_id,
                generation,
                ..
            } = &pending
                && *generation == self.message_generation
            {
                self.search_target_message_id = None;
                self.pending_search_scroll_id = None;
                self.load_selected_chat(chat_id.clone());
                self.store.toast_error = Some(format!("{}: {}", error.code, error.message));
                return;
            }
            if matches!(&pending, PendingRequest::MessagesAfter { .. }) {
                self.newer_load_failed = true;
            }
            match &pending {
                PendingRequest::SendText {
                    chat_id,
                    draft_text,
                    reply_to_message_id,
                    mentions,
                } => self.restore_failed_draft(
                    chat_id,
                    draft_text,
                    reply_to_message_id.clone(),
                    mentions,
                    window,
                    cx,
                ),
                PendingRequest::SendImage {
                    chat_id,
                    draft_text,
                    reply_to_message_id,
                } => self.restore_failed_draft(
                    chat_id,
                    draft_text,
                    reply_to_message_id.clone(),
                    &[],
                    window,
                    cx,
                ),
                _ => {}
            }
            if matches!(&pending, PendingRequest::RepairRecentReactions { .. })
                && error.code == "not_found"
            {
                return;
            }
            if let PendingRequest::RepairRecentReactions { chat_id } = &pending
                && error.retryable
            {
                self.schedule_reaction_repair_retry(chat_id.clone(), cx);
                return;
            }
            if let PendingRequest::SendReaction {
                chat_id,
                message_id,
                emoji,
                client_reaction_id,
                attempt,
            } = &pending
                && let Some(retry) = reaction_retry(error.retryable, *attempt)
            {
                let chat_id = chat_id.clone();
                let message_id = message_id.clone();
                let emoji = emoji.clone();
                let client_reaction_id = client_reaction_id.clone();
                cx.spawn(async move |this, cx| {
                    Timer::after(retry.delay).await;
                    let _ = this.update(cx, |this, _| {
                        if !this.reaction_intent_is_current(
                            &chat_id,
                            &message_id,
                            &client_reaction_id,
                        ) {
                            return;
                        }
                        this.send_reaction_request(
                            chat_id,
                            message_id,
                            emoji,
                            client_reaction_id,
                            retry.attempt,
                        );
                    });
                })
                .detach();
                return;
            }
            if let PendingRequest::SendReaction {
                chat_id,
                message_id,
                client_reaction_id,
                ..
            } = &pending
            {
                self.clear_reaction_intent_if_current(chat_id, message_id, client_reaction_id);
            }
            if matches!(&pending, PendingRequest::SetTyping) {
                return;
            }
            if let PendingRequest::ChatInfo { chat_id } = &pending {
                if let Some(state) = self.chat_info.as_mut()
                    && state.chat_id == *chat_id
                {
                    state.loading = false;
                    state.error = Some(error.message);
                }
                return;
            }
            if let PendingRequest::MentionDirectory { chat_id } = &pending {
                self.mention_directory_pending.remove(chat_id);
                return;
            }
            if let PendingRequest::Avatar { chat_id } = &pending {
                let retries = self
                    .avatar_retries
                    .get(chat_id)
                    .copied()
                    .unwrap_or_default();
                if let Some(retry) = avatar_retry(error.retryable, retries) {
                    self.avatar_retries.insert(chat_id.clone(), retry.attempt);
                    let retry_chat_id = chat_id.clone();
                    cx.spawn(async move |this, cx| {
                        Timer::after(retry.delay).await;
                        let _ = this.update(cx, |this, cx| {
                            this.avatar_attempted.remove(&retry_chat_id);
                            cx.notify();
                        });
                    })
                    .detach();
                }
                return;
            }
            if let PendingRequest::ParticipantAvatar { participant_id } = &pending {
                let retry_key = format!("participant:{participant_id}");
                let retries = self
                    .avatar_retries
                    .get(&retry_key)
                    .copied()
                    .unwrap_or_default();
                if let Some(retry) = avatar_retry(error.retryable, retries) {
                    self.avatar_retries.insert(retry_key, retry.attempt);
                    let retry_participant_id = participant_id.clone();
                    cx.spawn(async move |this, cx| {
                        Timer::after(retry.delay).await;
                        let _ = this.update(cx, |this, cx| {
                            this.participant_avatar_attempted
                                .remove(&retry_participant_id);
                            cx.notify();
                        });
                    })
                    .detach();
                }
                return;
            }
            if let PendingRequest::MessageImage {
                chat_id,
                message_id,
            } = &pending
            {
                // Keep the attempt latched so virtualization does not create a
                // retry storm. The row now exposes an explicit retry action.
                let sticker = self
                    .store
                    .message(message_id)
                    .and_then(|message| message.content.as_ref())
                    .is_some_and(|content| {
                        matches!(content, proto::message::Content::Image(image) if image.sticker)
                    });
                self.image_failures.insert(
                    (chat_id.clone(), message_id.clone()),
                    if sticker && error.retryable {
                        "Couldn't load sticker · Click to retry".into()
                    } else if sticker {
                        "Sticker is no longer available".into()
                    } else if error.retryable {
                        "Couldn't load photo · Click to retry".into()
                    } else {
                        "Photo is no longer available".into()
                    },
                );
                return;
            }
            if let PendingRequest::MarkRead {
                chat_id,
                previous_unread,
            } = &pending
            {
                self.store.restore_unread(chat_id, *previous_unread);
                self.store.last_mark_read_id = None;
            }
            if matches!(&pending, PendingRequest::Logout) {
                self.confirming_logout = false;
                self.store.screen = Screen::Fatal;
                self.store.fatal_error = Some(format!(
                    "Logout stopped because local account data could not be safely cleared ({}: {}). Rust Meow will not re-pair until this is resolved.",
                    error.code, error.message
                ));
                return;
            }
            if matches!(&pending, PendingRequest::Messages { prepend: true, .. }) {
                self.pending_prepend_anchor = None;
            }
            let message = format!("{}: {}", error.code, error.message);
            if matches!(pending, PendingRequest::Hello) {
                self.store.fatal_error = Some(message);
                self.store.screen = Screen::Fatal;
            } else {
                self.store.toast_error = Some(message);
            }
            return;
        }
        match (pending, result) {
            (PendingRequest::Hello, rpc_response::Result::Hello(hello)) => {
                if hello.protocol_version != PROTOCOL_VERSION {
                    self.store.screen = Screen::Fatal;
                    self.store.fatal_error = Some(format!(
                        "Protocol mismatch: desktop v{PROTOCOL_VERSION}, backend v{}",
                        hello.protocol_version
                    ));
                } else {
                    self.request(
                        rpc_request::Request::GetAuthState(proto::GetAuthStateRequest {}),
                        PendingRequest::Auth,
                    );
                }
            }
            (PendingRequest::Auth, rpc_response::Result::AuthState(auth)) => {
                self.store.connection = auth.connection_state();
                if auth.paired {
                    self.store.screen = Screen::Syncing;
                    self.load_chats(String::new());
                } else {
                    self.begin_pairing();
                }
            }
            (PendingRequest::Chats { cursor }, rpc_response::Result::ListChats(page)) => {
                let newest_chat_id = if cursor.is_empty() {
                    page.chats.first().map(|chat| chat.id.clone())
                } else {
                    None
                };
                self.store.replace_chat_page(
                    &cursor,
                    page.chats,
                    page.total_count,
                    page.next_cursor,
                );
                self.store.screen = Screen::Chats;
                // Repair the newest chat proactively so legacy reactions are
                // restored even before the user clicks back into it after an
                // upgrade. Other affected chats remain lazy-on-open.
                if let Some(chat_id) = newest_chat_id {
                    self.repair_recent_reactions(chat_id);
                }
            }
            (
                PendingRequest::Search { query, generation },
                rpc_response::Result::SearchLocal(results),
            ) if generation == self.search_generation && self.search_query.trim() == query => {
                self.search_results = SearchResults {
                    contacts: results.contacts,
                    groups: results.groups,
                    messages: results.messages,
                };
                self.search_highlighted = 0;
                self.search_error = None;
                self.search_scroll.scroll_to_item(0, ScrollStrategy::Top);
            }
            (PendingRequest::OpenContact, rpc_response::Result::OpenContact(opened)) => {
                if let Some(chat) = opened.chat {
                    let chat_id = chat.id.clone();
                    self.store.upsert_chat(chat);
                    self.clear_search(window, cx);
                    self.open_chat(chat_id, window, cx);
                }
            }
            (
                PendingRequest::MessagesAround {
                    chat_id,
                    message_id,
                    generation,
                },
                rpc_response::Result::ListMessagesAround(page),
            ) if self.store.selected_chat_id.as_deref() == Some(chat_id.as_str())
                && generation == self.message_generation
                && page.anchor_message_id == message_id =>
            {
                self.store
                    .replace_message_window(page.messages, page.has_older, page.has_newer);
                self.pending_search_scroll_id = Some(message_id.clone());
                self.search_target_message_id = Some(message_id.clone());
                cx.spawn(async move |this, cx| {
                    Timer::after(Duration::from_secs(3)).await;
                    let _ = this.update(cx, |this, cx| {
                        if this.search_target_message_id.as_deref() == Some(message_id.as_str()) {
                            this.search_target_message_id = None;
                            cx.notify();
                        }
                    });
                })
                .detach();
            }
            (
                PendingRequest::OpenMessageWindow {
                    chat_id,
                    generation,
                },
                rpc_response::Result::OpenMessageWindow(page),
            ) if self.store.selected_chat_id.as_deref() == Some(chat_id.as_str())
                && generation == self.message_generation =>
            {
                self.store
                    .replace_message_window(page.messages, page.has_older, page.has_newer);
                if page.first_unread_message_id.is_empty() {
                    self.scroll_to_bottom_generation = Some(generation);
                } else {
                    self.pending_top_scroll_id = Some(page.first_unread_message_id);
                }
            }
            (
                PendingRequest::MessagesAfter {
                    chat_id,
                    generation,
                },
                rpc_response::Result::ListMessagesAfter(page),
            ) if self.store.selected_chat_id.as_deref() == Some(chat_id.as_str())
                && generation == self.message_generation =>
            {
                self.store
                    .append_newer_messages(page.messages, page.has_more);
            }
            (PendingRequest::Avatar { chat_id }, rpc_response::Result::GetChatAvatar(avatar))
                if avatar.chat_id == chat_id =>
            {
                self.store.set_chat_avatar(&chat_id, avatar.avatar_path);
                self.avatar_retries.remove(&chat_id);
            }
            (
                PendingRequest::ParticipantAvatar { participant_id },
                rpc_response::Result::GetParticipantAvatar(avatar),
            ) if avatar.participant_id == participant_id => {
                self.store
                    .set_participant_avatar(participant_id.clone(), avatar.avatar_path);
                self.avatar_retries
                    .remove(&format!("participant:{participant_id}"));
                cx.spawn(async move |this, cx| {
                    Timer::after(PARTICIPANT_AVATAR_REFRESH).await;
                    let _ = this.update(cx, |this, cx| {
                        this.participant_avatar_attempted.remove(&participant_id);
                        cx.notify();
                    });
                })
                .detach();
            }
            (
                PendingRequest::Messages {
                    chat_id,
                    prepend,
                    generation,
                },
                rpc_response::Result::ListMessages(page),
            ) if self.store.selected_chat_id.as_deref() == Some(chat_id.as_str())
                && generation == self.message_generation =>
            {
                self.store.has_older_messages = page.has_more;
                if prepend {
                    self.store.prepend_messages(page.messages);
                } else {
                    for message in page.messages {
                        self.store.upsert_message(message);
                    }
                    self.scroll_to_bottom_generation = Some(generation);
                }
            }
            (PendingRequest::SendText { .. }, rpc_response::Result::SendText(sent)) => {
                if let Some(message) = sent.message {
                    self.store.upsert_message(message);
                    self.scroll_to_bottom_generation = Some(self.message_generation);
                }
            }
            (PendingRequest::SendImage { .. }, rpc_response::Result::SendImage(sent)) => {
                if let Some(message) = sent.message {
                    self.store.upsert_message(message);
                    self.scroll_to_bottom_generation = Some(self.message_generation);
                }
            }
            (PendingRequest::SetTyping, rpc_response::Result::SetTyping(_)) => {}
            (PendingRequest::ChatInfo { chat_id }, rpc_response::Result::GetChatInfo(info)) => {
                if let Some(chat) = info.chat.clone() {
                    self.store.upsert_chat(chat);
                }
                self.mention_directories
                    .insert(chat_id.clone(), info.participants.clone());
                if let Some(state) = self.chat_info.as_mut()
                    && state.chat_id == chat_id
                {
                    state.loading = false;
                    state.error = None;
                    state.info = Some(info);
                }
            }
            (
                PendingRequest::MentionDirectory { chat_id },
                rpc_response::Result::GetChatInfo(info),
            ) => {
                self.mention_directory_pending.remove(&chat_id);
                if let Some(chat) = info.chat.clone() {
                    self.store.upsert_chat(chat);
                }
                self.mention_directories.insert(chat_id, info.participants);
            }
            (PendingRequest::SendSticker, rpc_response::Result::SendSticker(sent)) => {
                if let Some(message) = sent.message {
                    let sent_to_selected_chat =
                        self.store.selected_chat_id.as_deref() == Some(message.chat_id.as_str());
                    self.store.upsert_message(message);
                    if sent_to_selected_chat {
                        self.scroll_to_bottom_generation = Some(self.message_generation);
                    }
                }
            }
            (
                PendingRequest::MessageImage {
                    chat_id,
                    message_id,
                },
                rpc_response::Result::GetMessageImage(image),
            ) if image.chat_id == chat_id && image.message_id == message_id => {
                let key = (chat_id.clone(), message_id.clone());
                if image.image_path.is_empty() {
                    let sticker = self
                        .store
                        .message(&message_id)
                        .and_then(|message| message.content.as_ref())
                        .is_some_and(|content| {
                            matches!(content, proto::message::Content::Image(image) if image.sticker)
                        });
                    let label = if sticker {
                        "Sticker is no longer available"
                    } else {
                        "Photo is no longer available"
                    };
                    self.image_failures.insert(key, label.into());
                } else {
                    self.image_failures.remove(&key);
                    self.store.set_message_image_paths(
                        &chat_id,
                        &message_id,
                        image.image_path,
                        image.thumbnail_path,
                    );
                }
            }
            (
                PendingRequest::SendReaction {
                    chat_id,
                    message_id,
                    client_reaction_id,
                    ..
                },
                rpc_response::Result::SendReaction(sent),
            ) => {
                if let Some(reaction) = sent.reaction
                    && reaction.chat_id == chat_id
                    && reaction.message_id == message_id
                {
                    self.store.apply_reaction(reaction, sent.removed);
                    self.refresh_reaction_details();
                }
                self.clear_reaction_intent_if_current(&chat_id, &message_id, &client_reaction_id);
            }
            (
                PendingRequest::RepairRecentReactions { chat_id },
                rpc_response::Result::RepairRecentReactions(repair),
            ) if repair.chat_id == chat_id => {
                // A peer history request can be accepted without a response
                // ever arriving (for example if the primary goes offline).
                // Keep a bounded fallback retry armed in both the requested
                // and rate-limited cases; completed jobs become a silent
                // not_found on the harmless later probe.
                self.schedule_reaction_repair_retry(chat_id, cx);
            }
            (PendingRequest::Logout, rpc_response::Result::Logout(_)) => {
                self.begin_pairing();
            }
            _ => {}
        }
    }

    fn handle_event(&mut self, event: proto::BackendEvent) {
        if event.sequence == 0 || event.sequence <= self.last_event_sequence {
            return;
        }
        if self.last_event_sequence != 0
            && event.sequence > self.last_event_sequence.saturating_add(1)
        {
            self.store.toast_error = Some(format!(
                "Backend event gap ({} → {}); refreshing local state",
                self.last_event_sequence, event.sequence
            ));
            self.load_chats(String::new());
            if self.store.selected_chat_id.is_some() {
                self.refresh_latest();
            }
        }
        self.last_event_sequence = event.sequence;
        match event.event {
            Some(backend_event::Event::ConnectionChanged(connection)) => {
                let state = connection.state();
                self.store.connection = state;
                self.store.connection_detail = connection.detail;
                if state == proto::ConnectionState::LoggedOut {
                    if self.rpc.logout_pending() {
                        self.store.connection_detail =
                            "Logged out; securely clearing local account data…".into();
                    } else {
                        self.begin_pairing();
                    }
                } else if state == proto::ConnectionState::Connected {
                    if self.store.screen == Screen::Pairing {
                        self.request(
                            rpc_request::Request::GetAuthState(proto::GetAuthStateRequest {}),
                            PendingRequest::Auth,
                        );
                    }
                    if let Some(chat_id) = self.store.selected_chat_id.clone() {
                        self.repair_recent_reactions(chat_id);
                    }
                }
            }
            Some(backend_event::Event::PairingQr(qr)) => {
                self.store.qr_code = Some(qr.code);
                self.store.qr_expires_at_ms = qr.expires_at_ms;
                self.store.screen = Screen::Pairing;
            }
            Some(backend_event::Event::SyncProgress(sync)) => {
                self.store.apply_sync_progress(
                    sync.chats_processed,
                    sync.messages_processed,
                    sync.complete,
                );

                // WhatsApp may deliver a large initial history in many chunks.
                // Do not lock the user behind a modal syncing screen while
                // already-persisted chats are usable. Refresh the newest chat
                // page after each chunk and let the remaining import continue
                // in the local backend.
                self.store.screen = Screen::Chats;
                if sync.complete {
                    self.store.connection_detail.clear();
                    if !self.sync_complete_reloaded {
                        self.sync_complete_reloaded = true;
                        self.load_chats(String::new());
                    }
                } else {
                    self.store.connection_detail = format!(
                        "Importing older history… {} chats · {} messages",
                        self.store.sync_chats, self.store.sync_messages
                    );
                    self.load_chats(String::new());
                }
            }
            Some(backend_event::Event::ChatUpserted(upsert)) => {
                if let Some(chat) = upsert.chat {
                    self.store.upsert_chat(chat);
                }
            }
            Some(backend_event::Event::ChatMerged(merge)) => {
                let old_was_selected =
                    self.store.selected_chat_id.as_deref() == Some(merge.old_chat_id.as_str());
                let selected = self
                    .store
                    .merge_chat_id(&merge.old_chat_id, &merge.new_chat_id);
                remap_recent_chat_ids(
                    &mut self.recent_chat_ids,
                    &merge.old_chat_id,
                    &merge.new_chat_id,
                );
                if let Some(switcher) = self.chat_switcher.as_mut() {
                    remap_recent_chat_ids(
                        &mut switcher.chat_ids,
                        &merge.old_chat_id,
                        &merge.new_chat_id,
                    );
                    switcher.highlighted = switcher
                        .highlighted
                        .min(switcher.chat_ids.len().saturating_sub(1));
                }
                remap_chat_draft(
                    &mut self.chat_drafts,
                    &merge.old_chat_id,
                    &merge.new_chat_id,
                    old_was_selected,
                );
                self.avatar_attempted.remove(&merge.old_chat_id);
                self.reaction_repair_attempted.remove(&merge.old_chat_id);
                self.latest_reaction_intents
                    .retain(|(chat_id, _), _| chat_id != &merge.old_chat_id);
                self.load_chats(String::new());
                if selected {
                    self.load_selected_chat(merge.new_chat_id);
                }
            }
            Some(backend_event::Event::MessageUpserted(upsert)) => {
                if let Some(message) = upsert.message {
                    // The typed-out message arrived; drop the indicator now
                    // rather than waiting for the paused update or the TTL.
                    if !message.from_me
                        && let Some(indicators) = self.typing_indicators.get_mut(&message.chat_id)
                    {
                        indicators.remove(&message.sender_id);
                        if indicators.is_empty() {
                            self.typing_indicators.remove(&message.chat_id);
                        }
                    }
                    if self.store.has_newer_messages
                        && self.store.selected_chat_id.as_deref() == Some(message.chat_id.as_str())
                    {
                        self.store.newer_activity = true;
                    } else {
                        self.store.upsert_message(message);
                        self.refresh_reaction_details();
                    }
                }
            }
            Some(backend_event::Event::TypingChanged(update)) => {
                let sender_key = if update.sender_id.is_empty() {
                    update.sender_name.clone()
                } else {
                    update.sender_id.clone()
                };
                if update.typing {
                    self.typing_indicators
                        .entry(update.chat_id)
                        .or_default()
                        .insert(
                            sender_key,
                            TypingIndicator {
                                sender_name: update.sender_name,
                                recording: update.recording,
                                expires_at: Instant::now() + TYPING_INDICATOR_TTL,
                            },
                        );
                } else if let Some(indicators) = self.typing_indicators.get_mut(&update.chat_id) {
                    indicators.remove(&sender_key);
                    if indicators.is_empty() {
                        self.typing_indicators.remove(&update.chat_id);
                    }
                }
            }
            Some(backend_event::Event::ReceiptUpdated(receipt)) => {
                self.store.update_receipt(receipt)
            }
            Some(backend_event::Event::ReactionUpdated(update)) => {
                if let Some(reaction) = update.reaction {
                    self.store.apply_reaction(reaction, update.removed);
                    self.refresh_reaction_details();
                }
            }
            Some(backend_event::Event::RecentReactionsRepaired(repair))
                if self.store.selected_chat_id.as_deref() == Some(repair.chat_id.as_str()) =>
            {
                self.refresh_latest();
            }
            Some(backend_event::Event::RecentReactionsRepaired(_)) => {}
            // The sticker tray lives only in the Tauri desktop shell; this
            // legacy GPUI reference has nothing to refresh in response.
            Some(backend_event::Event::StickersChanged(_)) => {}
            Some(backend_event::Event::Problem(problem)) => {
                if problem.fatal {
                    self.store.screen = Screen::Fatal;
                    self.store.fatal_error = Some(problem.message);
                } else {
                    self.store.toast_error = Some(problem.message);
                }
            }
            None => {}
        }
    }

    fn load_chats(&mut self, cursor: String) {
        if self.rpc.pending_requests().any(|pending| {
            matches!(pending, PendingRequest::Chats { cursor: pending_cursor } if pending_cursor == &cursor)
        }) {
            return;
        }
        self.request(
            rpc_request::Request::ListChats(proto::ListChatsRequest {
                cursor: cursor.clone(),
                limit: CHAT_PAGE_SIZE,
            }),
            PendingRequest::Chats { cursor },
        );
    }

    fn load_avatar(&mut self, chat_id: String) {
        if self.avatar_attempted.contains(&chat_id) || self.rpc.pending_media_count() >= 4 {
            return;
        }
        self.avatar_attempted.insert(chat_id.clone());
        self.request(
            rpc_request::Request::GetChatAvatar(proto::GetChatAvatarRequest {
                chat_id: chat_id.clone(),
            }),
            PendingRequest::Avatar { chat_id },
        );
    }

    fn load_participant_avatar(&mut self, participant_id: String) {
        if participant_id.is_empty()
            || self.participant_avatar_attempted.contains(&participant_id)
            || self.rpc.pending_media_count() >= 4
        {
            return;
        }
        self.participant_avatar_attempted
            .insert(participant_id.clone());
        self.request(
            rpc_request::Request::GetParticipantAvatar(proto::GetParticipantAvatarRequest {
                participant_id: participant_id.clone(),
            }),
            PendingRequest::ParticipantAvatar { participant_id },
        );
    }

    fn load_message_image(&mut self, chat_id: String, message_id: String) {
        let key = (chat_id.clone(), message_id.clone());
        if self.image_download_attempted.contains(&key) || self.rpc.pending_media_count() >= 4 {
            return;
        }
        self.image_download_attempted.insert(key);
        self.request(
            rpc_request::Request::GetMessageImage(proto::GetMessageImageRequest {
                chat_id: chat_id.clone(),
                message_id: message_id.clone(),
            }),
            PendingRequest::MessageImage {
                chat_id,
                message_id,
            },
        );
    }

    fn retry_message_image(&mut self, chat_id: String, message_id: String) {
        let key = (chat_id.clone(), message_id.clone());
        self.image_failures.remove(&key);
        self.image_download_attempted.remove(&key);
        self.store
            .set_message_image_paths(&chat_id, &message_id, String::new(), String::new());
        self.image_viewer = None;
        self.load_message_image(chat_id, message_id);
    }

    fn open_image_viewer(
        &mut self,
        chat_id: String,
        message_id: String,
        path: String,
        caption: String,
        sticker: bool,
    ) {
        self.image_viewer = Some(ImageViewer {
            chat_id,
            message_id,
            path,
            caption,
            sticker,
        });
        self.emoji_target = None;
        self.reaction_details = None;
    }

    fn repair_recent_reactions(&mut self, chat_id: String) {
        if self.store.connection != proto::ConnectionState::Connected
            || !self.reaction_repair_attempted.insert(chat_id.clone())
        {
            return;
        }
        self.request(
            rpc_request::Request::RepairRecentReactions(proto::RepairRecentReactionsRequest {
                chat_id: chat_id.clone(),
            }),
            PendingRequest::RepairRecentReactions { chat_id },
        );
    }

    fn schedule_reaction_repair_retry(&mut self, chat_id: String, cx: &mut Context<Self>) {
        cx.spawn(async move |this, cx| {
            Timer::after(REACTION_REPAIR_RETRY).await;
            let _ = this.update(cx, |this, _| {
                this.reaction_repair_attempted.remove(&chat_id);
                if this.store.selected_chat_id.as_deref() == Some(chat_id.as_str()) {
                    this.repair_recent_reactions(chat_id);
                }
            });
        })
        .detach();
    }

    fn rebuild_emoji_results(&mut self) {
        self.emoji_results = Rc::new(filter_emojis(self.emoji_category, &self.emoji_query));
    }

    fn set_emoji_category(&mut self, category: EmojiCategory) {
        self.emoji_category = category;
        self.rebuild_emoji_results();
    }

    fn toggle_composer_emoji(&mut self) {
        self.emoji_target = match self.emoji_target {
            Some(EmojiTarget::Composer) => None,
            _ => Some(EmojiTarget::Composer),
        };
    }

    fn open_reaction_picker(&mut self, chat_id: String, message_id: String) {
        self.reaction_details = None;
        self.emoji_target = Some(EmojiTarget::Reaction {
            chat_id,
            message_id,
        });
    }

    fn update_active_draft_text(&mut self, text: String) {
        let Some(chat_id) = self.store.selected_chat_id.clone() else {
            return;
        };
        let draft = self.chat_drafts.entry(chat_id.clone()).or_default();
        draft.text = text;
        if draft.is_empty() {
            self.chat_drafts.remove(&chat_id);
        }
    }

    fn update_active_draft_reply(&mut self, reply_to_message_id: Option<String>) {
        let Some(chat_id) = self.store.selected_chat_id.clone() else {
            return;
        };
        let draft = self.chat_drafts.entry(chat_id.clone()).or_default();
        draft.reply_to_message_id = reply_to_message_id;
        if draft.is_empty() {
            self.chat_drafts.remove(&chat_id);
        }
    }

    fn clear_active_draft(&mut self) {
        if let Some(chat_id) = self.store.selected_chat_id.as_ref() {
            self.chat_drafts.remove(chat_id);
        }
        self.replying_to_message_id = None;
    }

    /// Re-evaluates the composer text around the cursor and opens or closes
    /// the @ mention picker accordingly. Only group chats can tag members.
    fn refresh_mention_picker(&mut self, cx: &mut Context<Self>) {
        let Some(chat_id) = self.store.selected_chat_id.clone() else {
            self.mention_picker = None;
            return;
        };
        let is_group = self
            .store
            .chat(&chat_id)
            .is_some_and(|chat| chat.kind() == proto::ChatKind::Group);
        if !is_group {
            self.mention_picker = None;
            return;
        }
        let state = self.composer.read(cx);
        let text = state.value().to_string();
        let cursor = state.cursor().min(text.len());
        let Some(token_start) = mention_token_start(&text, cursor) else {
            self.mention_picker = None;
            return;
        };
        let query = text[token_start + 1..cursor].to_string();
        let highlighted = match &self.mention_picker {
            Some(picker) if picker.chat_id == chat_id && picker.token_start == token_start => {
                picker.highlighted
            }
            _ => 0,
        };
        self.mention_picker = Some(MentionPicker {
            chat_id: chat_id.clone(),
            token_start,
            query,
            highlighted,
        });
        self.ensure_mention_directory(chat_id);
    }

    fn ensure_mention_directory(&mut self, chat_id: String) {
        if self.mention_directories.contains_key(&chat_id)
            || self.mention_directory_pending.contains(&chat_id)
            || self.store.connection != proto::ConnectionState::Connected
        {
            return;
        }
        self.mention_directory_pending.insert(chat_id.clone());
        self.request(
            rpc_request::Request::GetChatInfo(proto::GetChatInfoRequest {
                chat_id: chat_id.clone(),
            }),
            PendingRequest::MentionDirectory { chat_id },
        );
    }

    fn mention_matches(&self) -> Vec<proto::ChatParticipant> {
        let Some(picker) = &self.mention_picker else {
            return Vec::new();
        };
        let Some(participants) = self.mention_directories.get(&picker.chat_id) else {
            return Vec::new();
        };
        let query = picker.query.to_lowercase();
        let digits = query.trim_start_matches('+');
        participants
            .iter()
            .filter(|participant| !participant.is_me)
            .filter(|participant| {
                query.is_empty()
                    || participant.display_name.to_lowercase().contains(&query)
                    || (!digits.is_empty()
                        && participant
                            .phone_number
                            .trim_start_matches('+')
                            .contains(digits))
            })
            .take(MAX_MENTION_ROWS)
            .cloned()
            .collect()
    }

    fn mention_popup_visible(&self) -> bool {
        let Some(picker) = &self.mention_picker else {
            return false;
        };
        if self.store.selected_chat_id.as_deref() != Some(picker.chat_id.as_str()) {
            return false;
        }
        self.mention_directory_pending.contains(&picker.chat_id)
            || !self.mention_matches().is_empty()
    }

    /// Replaces the in-progress `@query` token with `@Name ` and records the
    /// participant so send_text can attach the real WhatsApp mention.
    fn apply_mention(&mut self, index: usize, window: &mut Window, cx: &mut Context<Self>) {
        let Some(picker) = self.mention_picker.clone() else {
            return;
        };
        let Some(participant) = self.mention_matches().get(index).cloned() else {
            return;
        };
        let name = mention_display_name(&participant);
        let state = self.composer.read(cx);
        let text = state.value().to_string();
        let cursor = state.cursor().min(text.len());
        self.mention_picker = None;
        // The cursor may have moved since the picker opened (e.g. arrow keys
        // don't emit Change). Only rewrite when the same token is still there.
        if mention_token_start(&text, cursor) != Some(picker.token_start) {
            return;
        }
        let new_text = format!(
            "{}@{} {}",
            &text[..picker.token_start],
            name,
            text[cursor..].trim_start()
        );
        let draft = self.chat_drafts.entry(picker.chat_id.clone()).or_default();
        if !draft
            .mentions
            .iter()
            .any(|entry| entry.jid == participant.participant_id)
        {
            draft.mentions.push(MentionEntry {
                display_name: name,
                jid: participant.participant_id.clone(),
            });
        }
        self.composer.update(cx, |input, cx| {
            input.set_value(new_text, window, cx);
            input.focus(window, cx);
        });
    }

    fn restore_failed_draft(
        &mut self,
        chat_id: &str,
        draft_text: &str,
        reply_to_message_id: Option<String>,
        mentions: &[(String, String)],
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        let failed_draft = ChatDraft {
            text: draft_text.to_owned(),
            reply_to_message_id,
            mentions: mentions
                .iter()
                .map(|(display_name, jid)| MentionEntry {
                    display_name: display_name.clone(),
                    jid: jid.clone(),
                })
                .collect(),
        };
        let should_restore = self
            .chat_drafts
            .get(chat_id)
            .is_none_or(ChatDraft::is_empty);
        if !should_restore {
            return;
        }
        self.chat_drafts
            .insert(chat_id.to_owned(), failed_draft.clone());
        if self.store.selected_chat_id.as_deref() == Some(chat_id)
            && self.composer.read(cx).value().is_empty()
        {
            self.replying_to_message_id = failed_draft.reply_to_message_id;
            self.composer.update(cx, |input, cx| {
                input.set_value(failed_draft.text, window, cx)
            });
        }
    }

    fn start_reply(&mut self, message_id: String) {
        if self.store.message(&message_id).is_none() {
            return;
        }
        self.replying_to_message_id = Some(message_id.clone());
        self.update_active_draft_reply(Some(message_id));
        self.emoji_target = None;
        self.reaction_details = None;
    }

    fn cancel_reply(&mut self) {
        self.replying_to_message_id = None;
        self.update_active_draft_reply(None);
    }

    fn scroll_to_message(&mut self, message_id: &str) {
        if let Some(index) = self
            .store
            .messages
            .iter()
            .position(|message| message.id == message_id)
        {
            self.stop_smooth_scroll(ScrollSurface::Messages);
            self.message_scroll
                .scroll_to_item(index, ScrollStrategy::Center);
        }
    }

    fn open_reaction_details(&mut self, chat_id: String, message_id: String, emoji: String) {
        if self.store.selected_chat_id.as_deref() != Some(chat_id.as_str()) {
            return;
        }
        let Some(message) = self.store.message(&message_id) else {
            return;
        };
        let Some(details) = ReactionDetails::new(chat_id, message, emoji) else {
            return;
        };
        self.emoji_target = None;
        self.reaction_details = Some(details);
    }

    fn refresh_reaction_details(&mut self) {
        let Some(details) = self.reaction_details.as_ref() else {
            return;
        };
        if self.store.selected_chat_id.as_deref() != Some(details.chat_id.as_str()) {
            self.reaction_details = None;
            return;
        }
        let Some(message) = self.store.message(&details.message_id) else {
            self.reaction_details = None;
            return;
        };
        let reactions = reactions_for_emoji(message, &details.emoji);
        if reactions.is_empty() {
            self.reaction_details = None;
        } else if let Some(details) = self.reaction_details.as_mut() {
            details.reactions = Rc::new(reactions);
        }
    }

    fn choose_emoji(&mut self, emoji: &str, window: &mut Window, cx: &mut Context<Self>) {
        match self.emoji_target.clone() {
            Some(EmojiTarget::Composer) => {
                self.composer
                    .update(cx, |input, cx| input.insert(emoji, window, cx));
            }
            Some(EmojiTarget::Reaction {
                chat_id,
                message_id,
            }) => {
                self.send_reaction_request(
                    chat_id,
                    message_id,
                    emoji.to_string(),
                    Uuid::new_v4().to_string(),
                    0,
                );
                self.emoji_target = None;
            }
            None => {}
        }
    }

    fn remove_reaction(&mut self) {
        let Some(EmojiTarget::Reaction {
            chat_id,
            message_id,
        }) = self.emoji_target.clone()
        else {
            return;
        };
        self.send_reaction_request(
            chat_id,
            message_id,
            String::new(),
            Uuid::new_v4().to_string(),
            0,
        );
        self.emoji_target = None;
    }

    fn send_reaction_request(
        &mut self,
        chat_id: String,
        message_id: String,
        emoji: String,
        client_reaction_id: String,
        attempt: u8,
    ) {
        let intent_key = (chat_id.clone(), message_id.clone());
        if attempt == 0 {
            self.latest_reaction_intents
                .insert(intent_key, client_reaction_id.clone());
        } else if !self.reaction_intent_is_current(&chat_id, &message_id, &client_reaction_id) {
            return;
        }
        self.request(
            rpc_request::Request::SendReaction(proto::SendReactionRequest {
                chat_id: chat_id.clone(),
                message_id: message_id.clone(),
                emoji: emoji.clone(),
                client_reaction_id: client_reaction_id.clone(),
            }),
            PendingRequest::SendReaction {
                chat_id,
                message_id,
                emoji,
                client_reaction_id,
                attempt,
            },
        );
    }

    fn reaction_intent_is_current(
        &self,
        chat_id: &str,
        message_id: &str,
        client_reaction_id: &str,
    ) -> bool {
        self.latest_reaction_intents
            .get(&(chat_id.to_owned(), message_id.to_owned()))
            .is_some_and(|latest| latest == client_reaction_id)
    }

    fn clear_reaction_intent_if_current(
        &mut self,
        chat_id: &str,
        message_id: &str,
        client_reaction_id: &str,
    ) {
        let key = (chat_id.to_owned(), message_id.to_owned());
        if self
            .latest_reaction_intents
            .get(&key)
            .is_some_and(|latest| latest == client_reaction_id)
        {
            self.latest_reaction_intents.remove(&key);
        }
    }

    fn toggle_theme(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let mode = if cx.theme().is_dark() {
            ThemeMode::Light
        } else {
            ThemeMode::Dark
        };
        Theme::change(mode, Some(window), cx);
        apply_theme_scale(self.ui_scale, window, cx);
        cx.notify();
    }

    fn set_ui_scale(&mut self, scale: f32, window: &mut Window, cx: &mut Context<Self>) {
        self.ui_scale = normalized_ui_scale(scale);
        apply_theme_scale(self.ui_scale, window, cx);
        self.store.invalidate_all_message_heights();
        if let Err(error) = save_ui_scale(self.ui_scale) {
            self.store.toast_error = Some(format!("Could not save UI scale: {error}"));
        }
        cx.notify();
    }

    fn adjust_ui_scale(&mut self, delta: f32, window: &mut Window, cx: &mut Context<Self>) {
        self.set_ui_scale(self.ui_scale + delta, window, cx);
    }

    fn toggle_chat_view(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        self.chat_view = match self.chat_view {
            ChatView::Inbox => ChatView::Archived,
            ChatView::Archived => ChatView::Inbox,
        };
        self.message_generation = self.message_generation.wrapping_add(1);
        self.store.selected_chat_id = None;
        self.emoji_target = None;
        self.reaction_details = None;
        self.image_viewer = None;
        self.replying_to_message_id = None;
        self.chat_switcher = None;
        self.chat_info = None;
        // This unmounts the composer (and emoji popup); if either held focus
        // the root would fall off the key dispatch path, deadening shortcuts.
        // The sidebar search input is the only input that survives the toggle.
        if !self
            .search_input
            .read(cx)
            .focus_handle(cx)
            .is_focused(window)
        {
            self.focus_handle.focus(window, cx);
        }
    }

    fn recent_chat_candidates(&self) -> Vec<String> {
        let mut candidates = self
            .recent_chat_ids
            .iter()
            .filter(|chat_id| self.store.chat(chat_id).is_some())
            .cloned()
            .collect::<Vec<_>>();
        // The recency history only exists within a session, so seed from the
        // visible chat list (already recency-ordered) until enough history has
        // accumulated to cycle.
        if candidates.len() < 2 {
            for chat_id in self.store.chat_ids(self.chat_view).iter() {
                if !candidates.contains(chat_id) {
                    candidates.push(chat_id.clone());
                }
                if candidates.len() >= MAX_RECENT_CHATS {
                    break;
                }
            }
        }
        if let Some(selected_chat_id) = self.store.selected_chat_id.as_deref() {
            if let Some(selected_index) = candidates
                .iter()
                .position(|chat_id| chat_id == selected_chat_id)
            {
                candidates.swap(0, selected_index);
            } else if self.store.chat(selected_chat_id).is_some() {
                candidates.insert(0, selected_chat_id.to_owned());
            }
        }
        candidates.truncate(MAX_RECENT_CHATS);
        candidates
    }

    /// The "typing…" line for a chat, or None when nobody is typing there.
    /// `group` picks the phrasing that names the member.
    fn typing_label(&self, chat_id: &str, group: bool) -> Option<String> {
        format_typing_label(self.typing_indicators.get(chat_id)?, group, Instant::now())
    }

    /// Broadcasts the local composing state, re-signalling at most once per
    /// TYPING_RESIGNAL window while the draft keeps changing.
    fn signal_typing(&mut self, composing: bool) {
        if self.store.connection != proto::ConnectionState::Connected {
            return;
        }
        let Some(chat_id) = self.store.selected_chat_id.clone() else {
            return;
        };
        match (&self.typing_signal, composing) {
            (Some((signaled, at)), true)
                if *signaled == chat_id && at.elapsed() < TYPING_RESIGNAL =>
            {
                return;
            }
            (None, false) => return,
            (Some((signaled, _)), false) if *signaled != chat_id => {
                self.typing_signal = None;
                return;
            }
            _ => {}
        }
        self.typing_signal = composing.then(|| (chat_id.clone(), Instant::now()));
        self.request(
            rpc_request::Request::SetTyping(proto::SetTypingRequest {
                chat_id,
                typing: composing,
            }),
            PendingRequest::SetTyping,
        );
    }

    fn open_chat_info(&mut self, chat_id: String) {
        self.settings_open = false;
        self.emoji_target = None;
        self.reaction_details = None;
        self.image_viewer = None;
        self.chat_switcher = None;
        self.stop_smooth_scroll(ScrollSurface::ChatInfo);
        self.chat_info_scroll.set_offset(point(px(0.), px(0.)));
        self.chat_info = Some(ChatInfoState {
            chat_id: chat_id.clone(),
            loading: true,
            error: None,
            info: None,
        });
        self.request(
            rpc_request::Request::GetChatInfo(proto::GetChatInfoRequest {
                chat_id: chat_id.clone(),
            }),
            PendingRequest::ChatInfo { chat_id },
        );
    }

    fn cycle_recent_chat(&mut self, reverse: bool, window: &mut Window, cx: &mut Context<Self>) {
        if self.store.screen != Screen::Chats {
            return;
        }
        if let Some(switcher) = self.chat_switcher.as_mut() {
            switcher.cycle(reverse);
            return;
        }
        let candidates = self.recent_chat_candidates();
        let selected_is_first = self
            .store
            .selected_chat_id
            .as_deref()
            .is_some_and(|selected| candidates.first().is_some_and(|first| first == selected));
        let Some(switcher) = ChatSwitcher::new(candidates, reverse, selected_is_first) else {
            return;
        };
        self.emoji_target = None;
        self.reaction_details = None;
        self.image_viewer = None;
        self.chat_info = None;
        self.settings_open = false;
        self.chat_switcher = Some(switcher);
        // The commit-on-ctrl-release and escape handlers live on the root div,
        // which only sees events while focus is somewhere inside it. Opening
        // the switcher may unmount the focused input (emoji search), so anchor
        // focus to the root for the switcher's lifetime.
        self.focus_handle.focus(window, cx);
    }

    fn cycle_recent_chat_from_global(
        this: &WeakEntity<Self>,
        window: AnyWindowHandle,
        reverse: bool,
        cx: &mut App,
    ) {
        let Some(this) = this.upgrade() else {
            return;
        };
        // Global action handlers fire while the window is mid-dispatch, so
        // defer until its lease is released before updating it again.
        cx.defer(move |cx| {
            window
                .update(cx, |_, window, cx| {
                    this.update(cx, |app, cx| {
                        app.cycle_recent_chat(reverse, window, cx);
                        cx.notify();
                    });
                })
                .ok();
        });
    }

    fn cancel_chat_switcher(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        self.chat_switcher = None;
        if self.store.selected_chat_id.is_some() {
            self.composer
                .update(cx, |input, cx| input.focus(window, cx));
        }
    }

    fn commit_chat_switcher(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let selected_chat_id = self
            .chat_switcher
            .take()
            .and_then(|switcher| switcher.selected_chat_id().map(str::to_owned));
        if let Some(chat_id) = selected_chat_id {
            self.open_chat(chat_id, window, cx);
        }
    }

    fn commit_chat_switcher_to(
        &mut self,
        chat_id: String,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        self.chat_switcher = None;
        self.open_chat(chat_id, window, cx);
    }

    fn open_chat(&mut self, chat_id: String, window: &mut Window, cx: &mut Context<Self>) {
        if self.store.chat(&chat_id).is_none() {
            return;
        }
        self.chat_view = if self.store.chat(&chat_id).is_some_and(|chat| chat.archived) {
            ChatView::Archived
        } else {
            ChatView::Inbox
        };
        record_recent_chat(&mut self.recent_chat_ids, &chat_id);
        self.load_selected_chat(chat_id.clone());
        let draft = self.chat_drafts.get(&chat_id).cloned().unwrap_or_default();
        self.replying_to_message_id = draft.reply_to_message_id;
        self.composer.update(cx, |input, cx| {
            input.set_value(draft.text, window, cx);
            input.focus(window, cx);
        });
    }

    fn load_selected_chat(&mut self, chat_id: String) {
        if let Some((signaled_chat_id, _)) = self.typing_signal.take()
            && signaled_chat_id != chat_id
        {
            self.request(
                rpc_request::Request::SetTyping(proto::SetTypingRequest {
                    chat_id: signaled_chat_id,
                    typing: false,
                }),
                PendingRequest::SetTyping,
            );
        }
        self.message_generation = self.message_generation.wrapping_add(1);
        self.stop_smooth_scroll(ScrollSurface::Messages);
        self.store.select_chat(chat_id.clone());
        self.emoji_target = None;
        self.reaction_details = None;
        self.image_viewer = None;
        self.chat_info = None;
        self.mention_picker = None;
        self.scroll_to_bottom_generation = None;
        self.search_target_message_id = None;
        self.pending_search_scroll_id = None;
        self.pending_top_scroll_id = None;
        self.newer_load_failed = false;
        self.image_download_attempted.clear();
        self.image_failures.clear();
        self.request(
            rpc_request::Request::OpenMessageWindow(proto::OpenMessageWindowRequest {
                chat_id: chat_id.clone(),
            }),
            PendingRequest::OpenMessageWindow {
                chat_id: chat_id.clone(),
                generation: self.message_generation,
            },
        );
        self.repair_recent_reactions(chat_id);
    }

    fn load_older_messages(&mut self) {
        let Some(chat_id) = self.store.selected_chat_id.clone() else {
            return;
        };
        if self.rpc.pending_requests().any(|pending| {
            matches!(pending, PendingRequest::Messages {
                chat_id: pending_chat,
                prepend: true,
                generation,
            } if pending_chat == &chat_id && *generation == self.message_generation)
        }) {
            return;
        }
        let Some(first) = self.store.messages.first() else {
            return;
        };
        self.pending_prepend_anchor = Some((first.id.clone(), self.message_scroll.offset()));
        self.request(
            rpc_request::Request::ListMessages(proto::ListMessagesRequest {
                chat_id: chat_id.clone(),
                before_timestamp_ms: first.timestamp_ms,
                before_message_id: first.id.clone(),
                limit: MESSAGE_PAGE_SIZE,
            }),
            PendingRequest::Messages {
                chat_id,
                prepend: true,
                generation: self.message_generation,
            },
        );
    }

    fn load_newer_messages(&mut self) {
        let Some(chat_id) = self.store.selected_chat_id.clone() else {
            return;
        };
        if self.newer_load_failed
            || (!self.store.has_newer_messages && !self.store.newer_activity)
            || self.rpc.pending_requests().any(|pending| {
                matches!(pending, PendingRequest::MessagesAfter {
                    chat_id: pending_chat,
                    generation,
                } if pending_chat == &chat_id && *generation == self.message_generation)
            })
        {
            return;
        }
        let Some(last) = self.store.messages.last() else {
            return;
        };
        let after_timestamp_ms = last.timestamp_ms;
        let after_message_id = last.id.clone();
        // Any event arriving after this point sets newer_activity again, so a
        // response can distinguish activity included in its query from a race.
        self.store.newer_activity = false;
        self.request(
            rpc_request::Request::ListMessagesAfter(proto::ListMessagesAfterRequest {
                chat_id: chat_id.clone(),
                after_timestamp_ms,
                after_message_id,
                limit: MESSAGE_PAGE_SIZE,
            }),
            PendingRequest::MessagesAfter {
                chat_id,
                generation: self.message_generation,
            },
        );
    }

    fn refresh_latest(&mut self) {
        let Some(chat_id) = self.store.selected_chat_id.clone() else {
            return;
        };
        self.load_selected_chat(chat_id);
    }

    fn begin_pairing(&mut self) {
        if self.store.screen == Screen::Pairing
            && self
                .rpc
                .pending_requests()
                .any(|pending| matches!(pending, PendingRequest::Pairing))
        {
            return;
        }
        self.store.clear_account_state();
        self.rpc.clear_pending();
        self.store.screen = Screen::Pairing;
        self.store.connection = proto::ConnectionState::Pairing;
        self.message_generation = self.message_generation.wrapping_add(1);
        self.pending_prepend_anchor = None;
        self.sync_complete_reloaded = false;
        self.last_event_sequence = 0;
        self.confirming_logout = false;
        self.avatar_attempted.clear();
        self.avatar_retries.clear();
        self.participant_avatar_attempted.clear();
        self.image_download_attempted.clear();
        self.image_failures.clear();
        self.reaction_repair_attempted.clear();
        self.latest_reaction_intents.clear();
        self.emoji_target = None;
        self.reaction_details = None;
        self.image_viewer = None;
        self.replying_to_message_id = None;
        self.chat_drafts.clear();
        self.recent_chat_ids.clear();
        self.chat_switcher = None;
        self.chat_info = None;
        self.chat_view = ChatView::Inbox;
        self.request(
            rpc_request::Request::StartPairing(proto::StartPairingRequest {}),
            PendingRequest::Pairing,
        );
    }

    fn request_logout(&mut self) {
        if self.rpc.logout_pending() {
            return;
        }
        self.request(
            rpc_request::Request::Logout(proto::LogoutRequest {}),
            PendingRequest::Logout,
        );
    }

    fn send_text(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let draft_text = self.composer.read(cx).value().to_string();
        let text = draft_text.trim().to_string();
        let Some(chat_id) = self.store.selected_chat_id.clone() else {
            self.store.toast_error = Some("Choose a conversation before sending".into());
            return;
        };
        if self.store.connection != proto::ConnectionState::Connected {
            self.store.toast_error = Some("Reconnect to WhatsApp before sending".into());
            return;
        }
        if let Err(error) = validate_text_message(&text) {
            self.store.toast_error = Some(error);
            return;
        }
        self.store.toast_error = None;
        let reply_to_message_id = self.replying_to_message_id.clone();
        let draft_mentions = self
            .chat_drafts
            .get(&chat_id)
            .map(|draft| draft.mentions.clone())
            .unwrap_or_default();
        let (wire_text, mentioned_jids) = encode_mentions(&text, &draft_mentions);
        self.mention_picker = None;
        // Delivering the message clears the composing indicator for peers.
        self.typing_signal = None;
        self.clear_active_draft();
        self.composer
            .update(cx, |input, cx| input.set_value("", window, cx));
        let client_message_id = Uuid::new_v4().to_string();
        self.request(
            rpc_request::Request::SendText(proto::SendTextRequest {
                client_message_id: client_message_id.clone(),
                chat_id,
                text: wire_text,
                reply_to_message_id: reply_to_message_id.clone().unwrap_or_default(),
                mentioned_jids,
            }),
            PendingRequest::SendText {
                chat_id: self.store.selected_chat_id.clone().unwrap_or_default(),
                draft_text,
                reply_to_message_id,
                mentions: draft_mentions
                    .iter()
                    .map(|entry| (entry.display_name.clone(), entry.jid.clone()))
                    .collect(),
            },
        );
    }

    fn choose_image(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        if self.store.connection != proto::ConnectionState::Connected
            || self.store.selected_chat_id.is_none()
        {
            return;
        }
        let selected = cx.prompt_for_paths(PathPromptOptions {
            files: true,
            directories: false,
            multiple: false,
            prompt: Some("Choose an image to send".into()),
        });
        let view = cx.entity();
        cx.spawn_in(window, async move |_, window| {
            let path = selected.await.ok()?.ok()??.into_iter().next()?;
            window
                .update(|window, cx| view.update(cx, |this, cx| this.send_image(path, window, cx)))
                .ok()
        })
        .detach();
    }

    fn choose_sticker(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let Some(chat_id) = self.store.selected_chat_id.clone() else {
            return;
        };
        if self.store.connection != proto::ConnectionState::Connected || self.sticker_preparing {
            return;
        }
        let reply_to_message_id = self.replying_to_message_id.clone();
        let selected = cx.prompt_for_paths(PathPromptOptions {
            files: true,
            directories: false,
            multiple: false,
            prompt: Some("Choose an image to turn into a sticker".into()),
        });
        let view = cx.entity();
        cx.spawn_in(window, async move |_, window| {
            let path = selected.await.ok()?.ok()??.into_iter().next()?;
            window
                .update(|_, cx| {
                    view.update(cx, |this, cx| {
                        this.sticker_preparing = true;
                        this.store.toast_error = None;
                        cx.notify();
                    })
                })
                .ok()?;
            let prepared = smol::unblock(move || sticker::prepare(&path)).await;
            window
                .update(|_, cx| {
                    view.update(cx, |this, cx| {
                        this.sticker_preparing = false;
                        match prepared {
                            Ok(prepared) => this.send_sticker(
                                prepared,
                                chat_id.clone(),
                                reply_to_message_id.clone(),
                            ),
                            Err(error) => this.store.toast_error = Some(error),
                        }
                        cx.notify();
                    })
                })
                .ok()
        })
        .detach();
    }

    fn send_image(&mut self, path: PathBuf, window: &mut Window, cx: &mut Context<Self>) {
        let Some(chat_id) = self.store.selected_chat_id.clone() else {
            self.store.toast_error = Some("Choose a conversation before sending".into());
            return;
        };
        if self.store.connection != proto::ConnectionState::Connected {
            self.store.toast_error = Some("Reconnect to WhatsApp before sending".into());
            return;
        }
        let draft_text = self.composer.read(cx).value().to_string();
        let caption = draft_text.trim().to_string();
        if let Err(error) = validate_image_message(&path, &caption) {
            self.store.toast_error = Some(error);
            return;
        }
        self.store.toast_error = None;
        let reply_to_message_id = self.replying_to_message_id.clone();
        self.clear_active_draft();
        self.composer
            .update(cx, |input, cx| input.set_value("", window, cx));
        self.request(
            rpc_request::Request::SendImage(proto::SendImageRequest {
                client_message_id: Uuid::new_v4().to_string(),
                chat_id,
                image_path: path.to_string_lossy().into_owned(),
                caption,
                reply_to_message_id: reply_to_message_id.clone().unwrap_or_default(),
            }),
            PendingRequest::SendImage {
                chat_id: self.store.selected_chat_id.clone().unwrap_or_default(),
                draft_text,
                reply_to_message_id,
            },
        );
    }

    fn send_sticker(
        &mut self,
        prepared: sticker::PreparedSticker,
        chat_id: String,
        reply_to_message_id: Option<String>,
    ) {
        if self.store.connection != proto::ConnectionState::Connected {
            self.store.toast_error = Some("Reconnect to WhatsApp before sending".into());
            return;
        }
        self.store.toast_error = None;
        self.request(
            rpc_request::Request::SendSticker(proto::SendStickerRequest {
                client_message_id: Uuid::new_v4().to_string(),
                chat_id: chat_id.clone(),
                webp_data: prepared.webp_data,
                reply_to_message_id: reply_to_message_id.clone().unwrap_or_default(),
            }),
            PendingRequest::SendSticker,
        );
        if let Some(draft) = self.chat_drafts.get_mut(&chat_id) {
            draft.reply_to_message_id = None;
            if draft.is_empty() {
                self.chat_drafts.remove(&chat_id);
            }
        }
        if self.store.selected_chat_id.as_deref() == Some(chat_id.as_str())
            && self.replying_to_message_id == reply_to_message_id
        {
            self.replying_to_message_id = None;
        }
    }

    fn mark_read(&mut self) {
        let Some(chat_id) = self.store.selected_chat_id.clone() else {
            return;
        };
        let Some(last) = self
            .store
            .messages
            .iter()
            .rev()
            .find(|message| !message.from_me)
        else {
            return;
        };
        let through_message_id = last.id.clone();
        if self.store.last_mark_read_id.as_deref() == Some(through_message_id.as_str()) {
            return;
        }
        self.store.last_mark_read_id = Some(through_message_id.clone());
        let previous_unread = self.store.mark_selected_chat_read_locally().unwrap_or(0);
        self.request(
            rpc_request::Request::MarkRead(proto::MarkReadRequest {
                chat_id,
                through_message_id,
            }),
            PendingRequest::MarkRead {
                chat_id: self.store.selected_chat_id.clone().unwrap_or_default(),
                previous_unread,
            },
        );
    }

    fn render_pairing(&self, cx: &mut Context<Self>) -> gpui::Div {
        let qr = self
            .store
            .qr_code
            .as_deref()
            .and_then(|code| QrCode::new(code.as_bytes()).ok());
        v_flex()
            .size_full()
            .items_center()
            .justify_center()
            .gap_4()
            .child(
                div()
                    .text_2xl()
                    .font_weight(gpui::FontWeight::BOLD)
                    .child("Link Rust Meow"),
            )
            .child("WhatsApp → Linked devices → Link a device")
            .child(match qr {
                Some(qr) => qr_canvas(qr),
                None => div()
                    .size(px(240.))
                    .rounded_lg()
                    .bg(if cx.theme().is_dark() {
                        cx.theme().secondary
                    } else {
                        rgb(PANEL).into()
                    })
                    .flex()
                    .items_center()
                    .justify_center()
                    .child("Waiting for QR…"),
            })
            .child(
                div()
                    .text_sm()
                    .text_color(cx.theme().muted_foreground)
                    .child("The code refreshes automatically."),
            )
            .child(
                Button::new("retry-pairing")
                    .label("Refresh pairing code")
                    .on_click(cx.listener(|this, _, _, cx| {
                        this.begin_pairing();
                        cx.notify();
                    })),
            )
    }

    fn render_center(
        &self,
        title: impl Into<SharedString>,
        detail: impl Into<SharedString>,
    ) -> gpui::Div {
        v_flex()
            .size_full()
            .items_center()
            .justify_center()
            .gap_3()
            .child(
                div()
                    .text_xl()
                    .font_weight(gpui::FontWeight::BOLD)
                    .child(title.into()),
            )
            .child(div().text_sm().child(detail.into()))
    }

    fn render_chats(&mut self, window: &mut Window, cx: &mut Context<Self>) -> gpui::Div {
        let selected = self.store.selected_chat_id.clone();
        let compact = window.viewport_size().width < px(800. * self.ui_scale);
        let show_sidebar = !compact || selected.is_none();
        let show_conversation = !compact || selected.is_some();
        h_flex()
            .size_full()
            .when(show_sidebar, |root| root.child(self.render_sidebar(cx)))
            .when(show_conversation, |root| {
                root.child(self.render_conversation(compact, window, cx))
            })
    }

    fn render_sidebar(&mut self, cx: &mut Context<Self>) -> gpui::Div {
        let ui_scale = self.ui_scale;
        let total = self.store.total_chats;
        let logout_pending = self.rpc.logout_pending();
        let dark = cx.theme().is_dark();
        let chat_view = self.chat_view;
        let visible_chat_ids = self.store.chat_ids(chat_view);
        let search_active = self.search_query.trim().chars().count() >= 2;
        let visible_count = visible_chat_ids.len();
        let has_more = !self.store.next_chat_cursor.is_empty();
        let virtual_count = visible_count + usize::from(has_more);
        let list_id = if chat_view == ChatView::Archived {
            "archived-chat-list"
        } else {
            "inbox-chat-list"
        };
        let view_title = if chat_view == ChatView::Archived {
            "Archived"
        } else {
            "Rust Meow"
        };
        let local_status = if self.store.sync_active {
            format!(
                "{} chats · scanned {} chats · {} messages",
                total, self.store.sync_chats, self.store.sync_messages
            )
        } else if chat_view == ChatView::Archived {
            format!(
                "{}{} archived · {} chats",
                visible_count,
                if has_more { "+" } else { "" },
                total
            )
        } else {
            format!("{} chats", total)
        };
        let selected_background = if dark { rgb(0x173a35) } else { rgb(0xe7f5ef) };
        let hover_background = if dark { rgb(0x152f2c) } else { rgb(0xeff5f2) };
        let visible_for_list = visible_chat_ids.clone();
        v_flex()
            .h_full()
            .w(px(340. * ui_scale))
            .min_w(px(280. * ui_scale))
            .border_r_1()
            .border_color(cx.theme().border)
            .child(
                v_flex()
                    .h(px(132. * ui_scale))
                    .px_3()
                    .py_2()
                    .gap_1()
                    .child(
                        h_flex()
                            .items_center()
                            .justify_between()
                            .child(
                                div()
                                    .text_lg()
                                    .font_weight(gpui::FontWeight::BOLD)
                                    .child(view_title),
                            )
                            .child(
                                h_flex()
                                    .gap_1()
                                    .child(
                                        Button::new("theme")
                                            .small()
                                            .label(if dark { "Light" } else { "Dark" })
                                            .on_click(cx.listener(|this, _, window, cx| {
                                                this.toggle_theme(window, cx);
                                            })),
                                    )
                                    .child(
                                        Button::new("archived")
                                            .small()
                                            .label(if chat_view == ChatView::Archived {
                                                "Chats"
                                            } else {
                                                "Archived"
                                            })
                                            .on_click(cx.listener(|this, _, window, cx| {
                                                this.toggle_chat_view(window, cx);
                                                cx.notify();
                                            })),
                                    )
                                    .child(Button::new("settings").small().label("⚙").on_click(
                                        cx.listener(|this, _, _, cx| {
                                            this.settings_open = !this.settings_open;
                                            this.reaction_details = None;
                                            this.image_viewer = None;
                                            cx.notify();
                                        }),
                                    ))
                                    .child(
                                        Button::new("logout")
                                            .small()
                                            .label(if logout_pending {
                                                "Clearing…"
                                            } else if self.confirming_logout {
                                                "Confirm"
                                            } else {
                                                "Log out"
                                            })
                                            .disabled(logout_pending)
                                            .on_click(cx.listener(|this, _, _, cx| {
                                                if this.confirming_logout {
                                                    this.request_logout();
                                                } else {
                                                    this.confirming_logout = true;
                                                }
                                                cx.notify();
                                            })),
                                    ),
                            ),
                    )
                    .child(
                        div()
                            .truncate()
                            .text_xs()
                            .text_color(cx.theme().muted_foreground)
                            .child(local_status),
                    )
                    .child(
                        div()
                            .w_full()
                            .h(px(3.))
                            .rounded_full()
                            .overflow_hidden()
                            .bg(cx.theme().secondary)
                            .when(self.store.sync_active, |track| {
                                track.flex().justify_center().child(
                                    div().h_full().w(px(72.)).rounded_full().bg(rgb(0x25d366)),
                                )
                            })
                            .when(self.store.sync_complete, |track| {
                                track
                                    .child(div().h_full().w_full().rounded_full().bg(rgb(0x25d366)))
                            }),
                    )
                    .child(div().pt_1().child(Input::new(&self.search_input).w_full())),
            )
            .child(
                div()
                    .relative()
                    .flex_1()
                    .min_h_0()
                    .when(!search_active, |list| {
                        list.child(
                            uniform_list(
                                list_id,
                                virtual_count,
                                cx.processor(move |this, range: Range<usize>, _, cx| {
                                    let loaded = visible_for_list.len();
                                    if range.end >= loaded
                                        && !this.store.next_chat_cursor.is_empty()
                                    {
                                        this.load_chats(this.store.next_chat_cursor.clone());
                                    }
                                    if this.store.connection == proto::ConnectionState::Connected
                                        && this.rpc.pending_media_count() < 4
                                        && let Some(chat_id) = range.clone().find_map(|index| {
                                            visible_for_list.get(index).and_then(|chat_id| {
                                                this.store.chat(chat_id).and_then(|chat| {
                                                    (chat.avatar_path.is_empty()
                                                        && chat.kind() != proto::ChatKind::Other
                                                        && !this
                                                            .avatar_attempted
                                                            .contains(&chat.id))
                                                    .then(|| chat.id.clone())
                                                })
                                            })
                                        })
                                    {
                                        this.load_avatar(chat_id);
                                    }
                                    range
                                        .map(|index| {
                                            let Some(chat) = visible_for_list
                                                .get(index)
                                                .and_then(|id| this.store.chat(id))
                                                .cloned()
                                            else {
                                                return div()
                                                    .id(("loading-chat", index))
                                                    .h(px(72.))
                                                    .px_4()
                                                    .flex()
                                                    .items_center()
                                                    .text_sm()
                                                    .text_color(cx.theme().muted_foreground)
                                                    .child("Loading more chats…");
                                            };
                                            let selected = this.store.selected_chat_id.as_deref()
                                                == Some(chat.id.as_str());
                                            let avatar = avatar_element(
                                                &chat.title,
                                                &chat.avatar_path,
                                                px(42. * ui_scale),
                                                cx,
                                            );
                                            let typing_preview = this.typing_label(
                                                &chat.id,
                                                chat.kind() == proto::ChatKind::Group,
                                            );
                                            let row_typing = typing_preview.is_some();
                                            let preview = typing_preview.unwrap_or_else(|| {
                                                if chat.phone_number.is_empty() {
                                                    chat.last_message_preview.clone()
                                                } else if chat.last_message_preview.is_empty() {
                                                    chat.phone_number.clone()
                                                } else {
                                                    format!(
                                                        "{} · {}",
                                                        chat.phone_number,
                                                        chat.last_message_preview
                                                    )
                                                }
                                            });
                                            div()
                                            .id(("chat", index))
                                            .h(px(72. * ui_scale))
                                            .px_3()
                                            .flex()
                                            .items_center()
                                            .gap_3()
                                            .overflow_hidden()
                                            .when(selected, |row| row.bg(selected_background))
                                            .hover(move |style| style.bg(hover_background))
                                            .on_click(cx.listener(move |this, _, window, cx| {
                                                this.open_chat(chat.id.clone(), window, cx);
                                                cx.notify();
                                            }))
                                            .child(avatar)
                                            .child(
                                                v_flex()
                                                    .flex_1()
                                                    .min_w_0()
                                                    .gap_1()
                                                    .child(
                                                        h_flex()
                                                            .w_full()
                                                            .items_center()
                                                            .gap_2()
                                                            .child(
                                                                div()
                                                                    .flex_1()
                                                                    .min_w_0()
                                                                    .truncate()
                                                                    .font_weight(
                                                                        gpui::FontWeight::SEMIBOLD,
                                                                    )
                                                                    .child(one_line(&chat.title)),
                                                            )
                                                            .when(chat.unread_count > 0, |line| {
                                                                line.child(
                                                                    div()
                                                                        .flex_shrink_0()
                                                                        .min_w(px(18.))
                                                                        .h(px(18.))
                                                                        .px_1()
                                                                        .rounded_full()
                                                                        .flex()
                                                                        .items_center()
                                                                        .justify_center()
                                                                        .bg(rgb(0x25d366))
                                                                        .text_xs()
                                                                        .font_weight(
                                                                            gpui::FontWeight::SEMIBOLD,
                                                                        )
                                                                        .text_color(rgb(0x0b141a))
                                                                        .child(
                                                                            chat.unread_count
                                                                                .to_string(),
                                                                        ),
                                                                )
                                                            }),
                                                    )
                                                    .child(
                                                        div()
                                                            .w_full()
                                                            .min_w_0()
                                                            .truncate()
                                                            .text_sm()
                                                            .text_color(if row_typing {
                                                                if dark {
                                                                    gpui::Hsla::from(rgb(0x25d366))
                                                                } else {
                                                                    gpui::Hsla::from(rgb(
                                                                        DARK_GREEN,
                                                                    ))
                                                                }
                                                            } else {
                                                                cx.theme().muted_foreground
                                                            })
                                                            .child(one_line(&preview)),
                                                    ),
                                            )
                                        })
                                        .collect::<Vec<_>>()
                                }),
                            )
                            .h_full()
                            .track_scroll(&self.chat_scroll)
                            .on_scroll_wheel(cx.listener(
                                |this, event, window, cx| {
                                    this.handle_smooth_scroll_input(
                                        ScrollSurface::ChatList,
                                        event,
                                        window,
                                        cx,
                                    );
                                },
                            )),
                        )
                    })
                    .when(!search_active && visible_count == 0 && !has_more, |list| {
                        list.child(
                            div()
                                .absolute()
                                .inset_0()
                                .flex()
                                .items_center()
                                .justify_center()
                                .px_4()
                                .text_sm()
                                .text_color(cx.theme().muted_foreground)
                                .child(if chat_view == ChatView::Archived {
                                    "No archived chats"
                                } else {
                                    "No chats yet"
                                }),
                        )
                    })
                    .when(search_active, |list| {
                        list.child(self.render_search_results(cx))
                    }),
            )
    }

    fn render_search_results(&self, cx: &mut Context<Self>) -> impl IntoElement {
        let pending = self.rpc.pending_requests().any(|pending| {
            matches!(pending, PendingRequest::Search { generation, .. } if *generation == self.search_generation)
        });
        let total = self.search_results.len();
        let query_len = self.search_query.trim().chars().count();
        let mut content = v_flex().absolute().inset_0().bg(cx.theme().background);
        if pending && total == 0 {
            return content.child(
                div()
                    .p_4()
                    .text_sm()
                    .text_color(cx.theme().muted_foreground)
                    .child("Searching local data…"),
            );
        }
        if let Some(error) = self.search_error.clone() {
            return content.child(div().p_4().text_sm().text_color(rgb(0xb91c1c)).child(error));
        }
        if total == 0 {
            return content.child(
                div()
                    .p_4()
                    .text_sm()
                    .text_color(cx.theme().muted_foreground)
                    .child(if query_len < 3 {
                        "No contacts or groups found · type 3 characters to search messages"
                    } else {
                        "No local results"
                    }),
            );
        }

        let rows = Rc::new(self.search_results.rows());
        let row_sizes = Rc::new(
            rows.iter()
                .map(|row| {
                    let height = match row {
                        SearchResultRow::Header { .. } => 30.,
                        SearchResultRow::Contact { .. } | SearchResultRow::Group { .. } => 58.,
                        SearchResultRow::Message { .. } => 68.,
                    };
                    size(px(1.), px(height * self.ui_scale))
                })
                .collect::<Vec<_>>(),
        );
        let rows_for_list = rows.clone();
        content = content.child(
            v_flex()
                .relative()
                .flex_1()
                .min_h_0()
                .on_scroll_wheel(cx.listener(|this, event, window, cx| {
                    this.handle_smooth_scroll_input(ScrollSurface::Search, event, window, cx);
                }))
                .child(
                    v_virtual_list(
                        cx.entity().clone(),
                        "search-result-list",
                        row_sizes,
                        move |this, visible_range, _, cx| {
                            visible_range
                                .filter_map(|row_index| rows_for_list.get(row_index).cloned())
                                .filter_map(|row| this.render_search_result_row(row, cx))
                                .collect::<Vec<_>>()
                        },
                    )
                    .track_scroll(&self.search_scroll),
                )
                .scrollbar(&self.search_scroll, ScrollbarAxis::Vertical),
        );
        if query_len < 3 {
            content = content.child(
                div()
                    .flex_none()
                    .px_3()
                    .py_2()
                    .text_xs()
                    .text_color(cx.theme().muted_foreground)
                    .child("Type 3 characters to include messages"),
            );
        }
        content
    }

    fn render_search_result_row(
        &self,
        row: SearchResultRow,
        cx: &mut Context<Self>,
    ) -> Option<gpui::AnyElement> {
        let selected_background = if cx.theme().is_dark() {
            rgb(0x173f35)
        } else {
            rgb(0xd9fdd3)
        };
        let hover_background = if cx.theme().is_dark() {
            rgb(0x202c33)
        } else {
            rgb(0xf0f2f5)
        };
        match row {
            SearchResultRow::Header { title, count } => Some(
                h_flex()
                    .h(px(30. * self.ui_scale))
                    .px_3()
                    .items_center()
                    .justify_between()
                    .bg(cx.theme().secondary)
                    .text_xs()
                    .font_weight(gpui::FontWeight::SEMIBOLD)
                    .child(title)
                    .child(count.to_string())
                    .into_any_element(),
            ),
            SearchResultRow::Contact {
                result_index,
                source_index,
            } => {
                let contact = self.search_results.contacts.get(source_index)?.clone();
                let subtitle = match (
                    contact.secondary_name.is_empty(),
                    contact.phone_number.is_empty(),
                ) {
                    (false, false) => {
                        format!("{} · {}", contact.secondary_name, contact.phone_number)
                    }
                    (false, true) => contact.secondary_name.clone(),
                    (true, false) => contact.phone_number.clone(),
                    (true, true) => "WhatsApp contact".into(),
                };
                Some(
                    h_flex()
                        .id(("search-contact", result_index))
                        .h(px(58. * self.ui_scale))
                        .overflow_hidden()
                        .px_3()
                        .gap_3()
                        .items_center()
                        .cursor_pointer()
                        .when(result_index == self.search_highlighted, |row| {
                            row.bg(selected_background)
                        })
                        .hover(move |style| style.bg(hover_background))
                        .on_click(cx.listener(move |this, _, window, cx| {
                            this.search_highlighted = result_index;
                            this.activate_search_result(window, cx);
                        }))
                        .child(avatar_element(&contact.display_name, "", px(38.), cx))
                        .child(
                            v_flex()
                                .min_w_0()
                                .flex_1()
                                .child(
                                    div()
                                        .w_full()
                                        .min_w_0()
                                        .truncate()
                                        .font_weight(gpui::FontWeight::SEMIBOLD)
                                        .child(one_line(&contact.display_name)),
                                )
                                .child(
                                    div()
                                        .w_full()
                                        .min_w_0()
                                        .truncate()
                                        .text_sm()
                                        .text_color(cx.theme().muted_foreground)
                                        .child(one_line(&subtitle)),
                                ),
                        )
                        .into_any_element(),
                )
            }
            SearchResultRow::Group {
                result_index,
                source_index,
            } => {
                let chat = self.search_results.groups.get(source_index)?.clone();
                let preview = if chat.last_message_preview.is_empty() {
                    "No messages yet".to_string()
                } else {
                    chat.last_message_preview.clone()
                };
                Some(
                    h_flex()
                        .id(("search-group", result_index))
                        .h(px(58. * self.ui_scale))
                        .overflow_hidden()
                        .px_3()
                        .gap_3()
                        .items_center()
                        .cursor_pointer()
                        .when(result_index == self.search_highlighted, |row| {
                            row.bg(selected_background)
                        })
                        .hover(move |style| style.bg(hover_background))
                        .on_click(cx.listener(move |this, _, window, cx| {
                            this.search_highlighted = result_index;
                            this.activate_search_result(window, cx);
                        }))
                        .child(avatar_element(&chat.title, "", px(38.), cx))
                        .child(
                            v_flex()
                                .min_w_0()
                                .flex_1()
                                .child(
                                    div()
                                        .w_full()
                                        .min_w_0()
                                        .truncate()
                                        .font_weight(gpui::FontWeight::SEMIBOLD)
                                        .child(one_line(&chat.title)),
                                )
                                .child(
                                    div()
                                        .w_full()
                                        .min_w_0()
                                        .truncate()
                                        .text_sm()
                                        .text_color(cx.theme().muted_foreground)
                                        .child(one_line(&preview)),
                                ),
                        )
                        .child(
                            div()
                                .flex_none()
                                .text_xs()
                                .text_color(cx.theme().muted_foreground)
                                .child(if chat.archived { "Archived" } else { "Group" }),
                        )
                        .into_any_element(),
                )
            }
            SearchResultRow::Message {
                result_index,
                source_index,
            } => {
                let message = self.search_results.messages.get(source_index)?.clone();
                let meta = if message.archived {
                    format!("{} · Archived", message.sender_name)
                } else {
                    message.sender_name.clone()
                };
                Some(
                    v_flex()
                        .id(("search-message", result_index))
                        .h(px(68. * self.ui_scale))
                        .overflow_hidden()
                        .px_3()
                        .py_2()
                        .cursor_pointer()
                        .when(result_index == self.search_highlighted, |row| {
                            row.bg(selected_background)
                        })
                        .hover(move |style| style.bg(hover_background))
                        .on_click(cx.listener(move |this, _, window, cx| {
                            this.search_highlighted = result_index;
                            this.activate_search_result(window, cx);
                        }))
                        .child(
                            h_flex()
                                .justify_between()
                                .gap_2()
                                .child(
                                    div()
                                        .min_w_0()
                                        .flex_1()
                                        .truncate()
                                        .font_weight(gpui::FontWeight::SEMIBOLD)
                                        .child(one_line(&message.chat_title)),
                                )
                                .child(
                                    div()
                                        .flex_none()
                                        .text_xs()
                                        .text_color(cx.theme().muted_foreground)
                                        .child(one_line(&meta)),
                                ),
                        )
                        .child(
                            div()
                                .w_full()
                                .min_w_0()
                                .truncate()
                                .text_sm()
                                .text_color(cx.theme().muted_foreground)
                                .child(one_line(&message.snippet)),
                        )
                        .into_any_element(),
                )
            }
        }
    }

    fn render_conversation(
        &mut self,
        compact: bool,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> gpui::Div {
        let Some(chat) = self.store.selected_chat().cloned() else {
            return self
                .render_center("Rust Meow", "Choose a conversation to start messaging")
                .flex_1();
        };
        if chat.avatar_path.is_empty()
            && chat.kind() != proto::ChatKind::Other
            && self.store.connection == proto::ConnectionState::Connected
        {
            self.load_avatar(chat.id.clone());
        }
        let available = window.viewport_size().width - if compact { px(56.) } else { px(396.) };
        let wrap_width = if available < px(160.) {
            px(160.)
        } else if available > px(536.) {
            px(536.)
        } else {
            available
        };
        self.measure_message_heights(wrap_width, cx.theme().font_size, window);
        let sizes = self.store.message_sizes();
        if let Some(generation) = self.scroll_to_bottom_generation.take() {
            self.stop_smooth_scroll(ScrollSurface::Messages);
            let item_count = sizes.len();
            cx.on_next_frame(window, move |this, _, cx| {
                if item_count > 0
                    && this.message_generation == generation
                    && this.store.messages.len() == item_count
                {
                    this.message_scroll
                        .scroll_to_item(item_count.saturating_sub(1), ScrollStrategy::Bottom);
                    cx.notify();
                }
            });
        }
        if let Some((anchor_id, old_offset)) = self.pending_prepend_anchor.take()
            && let Some(anchor_index) = self
                .store
                .messages
                .iter()
                .position(|message| message.id == anchor_id)
        {
            self.stop_smooth_scroll(ScrollSurface::Messages);
            let inserted_height = sizes[..anchor_index]
                .iter()
                .fold(px(0.), |height, size| height + size.height + px(8.));
            self.message_scroll
                .set_offset(point(old_offset.x, old_offset.y - inserted_height));
        }
        if let Some(target_id) = self.pending_search_scroll_id.take()
            && let Some(index) = self
                .store
                .messages
                .iter()
                .position(|message| message.id == target_id)
        {
            self.stop_smooth_scroll(ScrollSurface::Messages);
            self.message_scroll
                .scroll_to_item(index, ScrollStrategy::Center);
        }
        if let Some(target_id) = self.pending_top_scroll_id.take()
            && let Some(index) = self
                .store
                .messages
                .iter()
                .position(|message| message.id == target_id)
        {
            self.stop_smooth_scroll(ScrollSurface::Messages);
            self.message_scroll
                .scroll_to_item(index, ScrollStrategy::Top);
        }
        let connected = self.store.connection == proto::ConnectionState::Connected;
        let has_older = self.store.has_older_messages;
        let has_newer = self.store.has_newer_messages || self.store.newer_activity;
        let dark = cx.theme().is_dark();
        let conversation_background = if dark { rgb(0x0d1715) } else { rgb(0xf4f0e8) };
        let connection_detail = if self.store.connection_detail.is_empty() {
            connection_label(self.store.connection).to_string()
        } else {
            self.store.connection_detail.clone()
        };
        let mut identity_parts = Vec::new();
        if !chat.phone_number.is_empty() {
            identity_parts.push(chat.phone_number.clone());
        }
        if !chat.business_name.is_empty() && chat.business_name != chat.title {
            identity_parts.push(chat.business_name.clone());
        }
        if !chat.push_name.is_empty()
            && chat.push_name != chat.title
            && chat.push_name != chat.business_name
        {
            identity_parts.push(chat.push_name.clone());
        }
        identity_parts.push(connection_detail);
        let typing_line = self.typing_label(&chat.id, chat.kind() == proto::ChatKind::Group);
        let header_typing = typing_line.is_some();
        let composer_typing_line = typing_line.clone();
        let identity_line = typing_line.unwrap_or_else(|| identity_parts.join(" · "));
        let reply_context = self.replying_to_message_id.as_deref().map(|message_id| {
            self.store.message(message_id).map_or_else(
                || {
                    (
                        "Original message".to_string(),
                        "Message unavailable".to_string(),
                    )
                },
                |message| {
                    let sender = if message.from_me {
                        "You".to_string()
                    } else if message.sender_name.trim().is_empty() {
                        "Unknown contact".to_string()
                    } else {
                        message.sender_name.trim().to_string()
                    };
                    (sender, message_preview(message))
                },
            )
        });
        let header_avatar =
            avatar_element(&chat.title, &chat.avatar_path, px(38. * self.ui_scale), cx);
        v_flex()
            .flex_1()
            .h_full()
            .min_w_0()
            .child(
                h_flex()
                    .h(px(64. * self.ui_scale))
                    .px_4()
                    .gap_3()
                    .items_center()
                    .border_b_1()
                    .border_color(cx.theme().border)
                    .when(compact, |header| {
                        header.child(Button::new("back").label("‹").on_click(cx.listener(
                            |this, _, _, cx| {
                                this.store.selected_chat_id = None;
                                this.reaction_details = None;
                                this.cancel_reply();
                                cx.notify();
                            },
                        )))
                    })
                    .child(
                        h_flex()
                            .id("chat-info-open")
                            .flex_1()
                            .min_w_0()
                            .gap_3()
                            .items_center()
                            .cursor_pointer()
                            .on_click(cx.listener({
                                let chat_id = chat.id.clone();
                                move |this, _, _, cx| {
                                    this.open_chat_info(chat_id.clone());
                                    cx.notify();
                                }
                            }))
                            .child(header_avatar)
                            .child(
                                v_flex()
                                    .min_w_0()
                                    .child(
                                        div()
                                            .truncate()
                                            .font_weight(gpui::FontWeight::SEMIBOLD)
                                            .child(chat.title),
                                    )
                                    .child(
                                        div()
                                            .truncate()
                                            .text_xs()
                                            .text_color(if header_typing {
                                                if dark {
                                                    gpui::Hsla::from(rgb(0x25d366))
                                                } else {
                                                    gpui::Hsla::from(rgb(DARK_GREEN))
                                                }
                                            } else {
                                                cx.theme().muted_foreground
                                            })
                                            .child(identity_line),
                                    ),
                            ),
                    ),
            )
            .child(
                div()
                    .flex_1()
                    .min_h_0()
                    .bg(conversation_background)
                    .on_scroll_wheel(cx.listener(|this, event, window, cx| {
                        this.handle_smooth_scroll_input(ScrollSurface::Messages, event, window, cx);
                    }))
                    .child(
                        v_virtual_list(
                            cx.entity().clone(),
                            "messages",
                            sizes,
                            |this, range: Range<usize>, window, cx| {
                                let visible_images = range
                                    .clone()
                                    .filter_map(|index| this.store.messages.get(index))
                                    .filter_map(|message| match message.content.as_ref() {
                                        Some(proto::message::Content::Image(image))
                                            if image.thumbnail_path.is_empty()
                                                && image.downloadable =>
                                        {
                                            Some((message.chat_id.clone(), message.id.clone()))
                                        }
                                        _ => None,
                                    })
                                    .collect::<Vec<_>>();
                                for (chat_id, message_id) in visible_images {
                                    this.load_message_image(chat_id, message_id);
                                }
                                if this
                                    .store
                                    .selected_chat()
                                    .is_some_and(|chat| chat.kind() == proto::ChatKind::Group)
                                {
                                    let participants = range
                                        .clone()
                                        .filter_map(|index| this.store.messages.get(index))
                                        .filter(|message| {
                                            !message.from_me
                                                && message.sender_avatar_path.is_empty()
                                                && this
                                                    .store
                                                    .participant_avatar_path(&message.sender_id)
                                                    .is_none()
                                                && !message.sender_id.is_empty()
                                        })
                                        .map(|message| message.sender_id.clone())
                                        .collect::<HashSet<_>>();
                                    for participant_id in participants {
                                        this.load_participant_avatar(participant_id);
                                    }
                                }
                                if range.end == this.store.messages.len()
                                    && (this.store.has_newer_messages || this.store.newer_activity)
                                {
                                    this.load_newer_messages();
                                } else if window.is_window_active()
                                    && range.end == this.store.messages.len()
                                {
                                    this.mark_read();
                                }
                                range.map(|index| this.render_message(index, cx)).collect()
                            },
                        )
                        .track_scroll(&self.message_scroll)
                        .p_4()
                        .gap_2(),
                    ),
            )
            .when(has_older, |column| {
                column.child(Button::new("older").label("Load older messages").on_click(
                    cx.listener(|this, _, _, cx| {
                        this.load_older_messages();
                        cx.notify();
                    }),
                ))
            })
            .when(has_newer, |column| {
                column.child(
                    Button::new("jump-latest")
                        .primary()
                        .label("Jump to latest messages")
                        .on_click(cx.listener(|this, _, _, cx| {
                            this.refresh_latest();
                            cx.notify();
                        })),
                )
            })
            .when(!connected, |column| {
                column.child(
                    div()
                        .px_4()
                        .py_2()
                        .bg(if dark { rgb(0x594918) } else { rgb(0xffe9b5) })
                        .child("Offline — messages will be available after reconnection"),
                )
            })
            .when(self.emoji_target.is_some(), |column| {
                column.child(self.render_emoji_picker(cx))
            })
            .when(self.mention_popup_visible(), |column| {
                column.child(self.render_mention_picker(cx))
            })
            .child(
                v_flex()
                    .border_t_1()
                    .border_color(cx.theme().border)
                    .when_some(composer_typing_line, |composer, typing| {
                        composer.child(
                            div()
                                .h(px(24. * self.ui_scale))
                                .px_4()
                                .pt_1()
                                .text_xs()
                                .text_color(if dark {
                                    gpui::Hsla::from(rgb(0x25d366))
                                } else {
                                    gpui::Hsla::from(rgb(DARK_GREEN))
                                })
                                .child(typing),
                        )
                    })
                    .when_some(reply_context, |composer, (sender, preview)| {
                        composer.child(
                            h_flex()
                                .mx_3()
                                .mt_2()
                                .px_3()
                                .py_2()
                                .gap_3()
                                .rounded_md()
                                .bg(cx.theme().secondary)
                                .child(
                                    v_flex()
                                        .min_w_0()
                                        .flex_1()
                                        .child(
                                            div()
                                                .text_xs()
                                                .font_weight(gpui::FontWeight::SEMIBOLD)
                                                .text_color(rgb(0x25d366))
                                                .child(format!("Replying to {sender}")),
                                        )
                                        .child(
                                            div()
                                                .truncate()
                                                .text_sm()
                                                .text_color(cx.theme().muted_foreground)
                                                .child(preview),
                                        ),
                                )
                                .child(Button::new("cancel-reply").small().label("×").on_click(
                                    cx.listener(|this, _, _, cx| {
                                        this.cancel_reply();
                                        cx.notify();
                                    }),
                                )),
                        )
                    })
                    .child(
                        h_flex()
                            .p_3()
                            .gap_2()
                            .child(
                                Button::new("emoji-picker")
                                    .label("😀")
                                    .disabled(!connected)
                                    .on_click(cx.listener(|this, _, _, cx| {
                                        this.toggle_composer_emoji();
                                        cx.notify();
                                    })),
                            )
                            .child(
                                Button::new("send-image")
                                    .label("📷")
                                    .disabled(!connected)
                                    .on_click(cx.listener(|this, _, window, cx| {
                                        this.choose_image(window, cx)
                                    })),
                            )
                            .child(
                                Button::new("send-sticker")
                                    .small()
                                    .label(if self.sticker_preparing {
                                        "Preparing…"
                                    } else {
                                        "Sticker"
                                    })
                                    .disabled(!connected || self.sticker_preparing)
                                    .on_click(cx.listener(|this, _, window, cx| {
                                        this.choose_sticker(window, cx)
                                    })),
                            )
                            .child(Input::new(&self.composer).disabled(!connected).flex_1())
                            .child(
                                Button::new("send")
                                    .primary()
                                    .label("Send")
                                    .disabled(!connected)
                                    .on_click(cx.listener(|this, _, window, cx| {
                                        this.send_text(window, cx)
                                    })),
                            ),
                    ),
            )
    }

    fn render_mention_picker(&self, cx: &mut Context<Self>) -> gpui::Div {
        let matches = self.mention_matches();
        let highlighted = self
            .mention_picker
            .as_ref()
            .map_or(0, |picker| picker.highlighted);
        let selected_background = cx.theme().secondary;
        let dark = cx.theme().mode.is_dark();
        let hover_background = if dark { rgb(0x2a3942) } else { rgb(0xf0f2f5) };
        v_flex()
            .mx_3()
            .mt_2()
            .rounded_md()
            .border_1()
            .border_color(cx.theme().border)
            .bg(cx.theme().background)
            .when(matches.is_empty(), |column| {
                column.child(
                    div()
                        .px_3()
                        .py_2()
                        .text_sm()
                        .text_color(cx.theme().muted_foreground)
                        .child("Loading group members…"),
                )
            })
            .children(matches.into_iter().enumerate().map(|(index, participant)| {
                let name = mention_display_name(&participant);
                let phone = participant.phone_number.clone();
                h_flex()
                    .id(("mention-row", index))
                    .px_3()
                    .py_2()
                    .gap_3()
                    .items_center()
                    .cursor_pointer()
                    .when(index == highlighted, |row| row.bg(selected_background))
                    .hover(move |style| style.bg(hover_background))
                    .on_click(cx.listener(move |this, _, window, cx| {
                        this.apply_mention(index, window, cx);
                        cx.notify();
                    }))
                    .child(
                        div()
                            .text_sm()
                            .font_weight(gpui::FontWeight::SEMIBOLD)
                            .child(name),
                    )
                    .when(!phone.is_empty(), |row| {
                        row.child(
                            div()
                                .text_sm()
                                .text_color(cx.theme().muted_foreground)
                                .child(phone),
                        )
                    })
            }))
    }

    fn render_emoji_picker(&self, cx: &mut Context<Self>) -> gpui::Div {
        let row_count = self.emoji_results.len().div_ceil(EMOJI_COLUMNS);
        let selected = self.emoji_category;
        let reaction_mode = matches!(self.emoji_target, Some(EmojiTarget::Reaction { .. }));
        let has_own_reaction = match &self.emoji_target {
            Some(EmojiTarget::Reaction { message_id, .. }) => self
                .store
                .messages
                .iter()
                .find(|message| &message.id == message_id)
                .is_some_and(|message| message.reactions.iter().any(|reaction| reaction.from_me)),
            _ => false,
        };
        v_flex()
            .h(px(300.))
            .border_t_1()
            .border_color(cx.theme().border)
            .bg(cx.theme().background)
            .child(
                h_flex()
                    .px_3()
                    .py_2()
                    .gap_2()
                    .child(Input::new(&self.emoji_search).flex_1())
                    .when(has_own_reaction, |row| {
                        row.child(
                            Button::new("remove-reaction")
                                .label("Remove mine")
                                .on_click(cx.listener(|this, _, _, cx| {
                                    this.remove_reaction();
                                    cx.notify();
                                })),
                        )
                    })
                    .child(Button::new("close-emoji").label("×").on_click(cx.listener(
                        |this, _, _, cx| {
                            this.emoji_target = None;
                            cx.notify();
                        },
                    ))),
            )
            .child(
                h_flex()
                    .px_3()
                    .gap_1()
                    .children(EmojiCategory::ALL.into_iter().enumerate().map(
                        |(index, category)| {
                            let button =
                                Button::new(("emoji-category", index)).label(category.label());
                            let button = if category == selected {
                                button.primary()
                            } else {
                                button
                            };
                            button.on_click(cx.listener(move |this, _, _, cx| {
                                this.set_emoji_category(category);
                                cx.notify();
                            }))
                        },
                    )),
            )
            .child(
                div()
                    .flex_1()
                    .min_h_0()
                    .child(
                        uniform_list(
                            "emoji-results",
                            row_count,
                            cx.processor(|this, rows: Range<usize>, _, cx| {
                                rows.map(|row| {
                                    h_flex().h(px(42.)).px_3().gap_1().children(
                                        (0..EMOJI_COLUMNS).filter_map(|column| {
                                            let index = row * EMOJI_COLUMNS + column;
                                            let emoji = this.emoji_results.get(index)?;
                                            let value = emoji.as_str().to_string();
                                            Some(
                                                Button::new(("emoji", index))
                                                    .label(value.clone())
                                                    .on_click(cx.listener(
                                                        move |this, _, window, cx| {
                                                            this.choose_emoji(&value, window, cx);
                                                            cx.notify();
                                                        },
                                                    )),
                                            )
                                        }),
                                    )
                                })
                                .collect::<Vec<_>>()
                            }),
                        )
                        .h_full(),
                    )
                    .when(row_count == 0, |panel| {
                        panel.child(
                            div()
                                .absolute()
                                .inset_0()
                                .flex()
                                .items_center()
                                .justify_center()
                                .text_color(cx.theme().muted_foreground)
                                .child("No emoji found"),
                        )
                    }),
            )
            .when(reaction_mode, |panel| {
                panel.child(
                    div()
                        .px_3()
                        .pb_1()
                        .text_xs()
                        .text_color(cx.theme().muted_foreground)
                        .child("Choose one emoji to react"),
                )
            })
    }

    fn render_reaction_details(&mut self, cx: &mut Context<Self>) -> gpui::Div {
        let Some(details) = self.reaction_details.as_ref() else {
            return div();
        };
        let emoji = details.emoji.clone();
        let count = details.reactions.len();
        let list_height = px((count.clamp(1, 7) as f32) * 58.);
        div()
            .absolute()
            .inset_0()
            .flex()
            .items_center()
            .justify_center()
            .p_4()
            .bg(rgba(0x00000088))
            .child(
                v_flex()
                    .w(px(420.))
                    .max_w_full()
                    .rounded_lg()
                    .border_1()
                    .border_color(cx.theme().border)
                    .bg(cx.theme().background)
                    .child(
                        h_flex()
                            .h(px(58.))
                            .px_4()
                            .items_center()
                            .justify_between()
                            .border_b_1()
                            .border_color(cx.theme().border)
                            .child(
                                v_flex()
                                    .child(
                                        div()
                                            .font_weight(gpui::FontWeight::SEMIBOLD)
                                            .child(format!("{emoji} Reactions")),
                                    )
                                    .child(
                                        div()
                                            .text_xs()
                                            .text_color(cx.theme().muted_foreground)
                                            .child(format!(
                                                "{count} {}",
                                                if count == 1 { "person" } else { "people" }
                                            )),
                                    ),
                            )
                            .child(Button::new("close-reaction-details").label("×").on_click(
                                cx.listener(|this, _, _, cx| {
                                    this.reaction_details = None;
                                    cx.notify();
                                }),
                            )),
                    )
                    .child(
                        uniform_list(
                            "reaction-details-reactors",
                            count,
                            cx.processor(|this, range: Range<usize>, _, cx| {
                                let reactions = this
                                    .reaction_details
                                    .as_ref()
                                    .map(|details| details.reactions.clone())
                                    .unwrap_or_default();
                                let visible = range
                                    .filter_map(|index| {
                                        reactions
                                            .get(index)
                                            .cloned()
                                            .map(|reaction| (index, reaction))
                                    })
                                    .collect::<Vec<_>>();
                                for (_, reaction) in &visible {
                                    if reaction.sender_avatar_path.is_empty()
                                        && this
                                            .store
                                            .participant_avatar_path(&reaction.sender_id)
                                            .is_none()
                                    {
                                        this.load_participant_avatar(reaction.sender_id.clone());
                                    }
                                }
                                visible
                                    .into_iter()
                                    .map(|(index, reaction)| {
                                        let name = reaction_sender_name(&reaction).to_string();
                                        let detail = reaction_sender_detail(&reaction).to_string();
                                        let cached_avatar = this
                                            .store
                                            .participant_avatar_path(&reaction.sender_id)
                                            .unwrap_or_default();
                                        let avatar_path = if reaction.sender_avatar_path.is_empty()
                                        {
                                            cached_avatar
                                        } else {
                                            reaction.sender_avatar_path.as_str()
                                        };
                                        let avatar =
                                            avatar_element(&name, avatar_path, px(38.), cx);
                                        h_flex()
                                            .id(("reaction-detail-row", index))
                                            .h(px(58.))
                                            .px_4()
                                            .gap_3()
                                            .items_center()
                                            .child(avatar)
                                            .child(
                                                v_flex()
                                                    .min_w_0()
                                                    .child(
                                                        div()
                                                            .truncate()
                                                            .font_weight(if reaction.from_me {
                                                                gpui::FontWeight::SEMIBOLD
                                                            } else {
                                                                gpui::FontWeight::NORMAL
                                                            })
                                                            .child(name),
                                                    )
                                                    .child(
                                                        div()
                                                            .truncate()
                                                            .text_xs()
                                                            .text_color(cx.theme().muted_foreground)
                                                            .child(detail),
                                                    ),
                                            )
                                    })
                                    .collect::<Vec<_>>()
                            }),
                        )
                        .h(list_height),
                    ),
            )
    }

    fn render_settings(&self, cx: &mut Context<Self>) -> gpui::Div {
        let scale_percent = (self.ui_scale * 100.0).round() as u32;
        div()
            .absolute()
            .inset_0()
            .flex()
            .items_center()
            .justify_center()
            .p_4()
            .bg(rgba(0x00000088))
            .child(
                v_flex()
                    .w(px(420.))
                    .max_w_full()
                    .rounded_lg()
                    .border_1()
                    .border_color(cx.theme().border)
                    .bg(cx.theme().background)
                    .child(
                        h_flex()
                            .h(px(58.))
                            .px_4()
                            .items_center()
                            .justify_between()
                            .border_b_1()
                            .border_color(cx.theme().border)
                            .child(
                                div()
                                    .font_weight(gpui::FontWeight::SEMIBOLD)
                                    .child("Settings"),
                            )
                            .child(
                                Button::new("close-settings")
                                    .label("×")
                                    .on_click(cx.listener(|this, _, _, cx| {
                                        this.settings_open = false;
                                        cx.notify();
                                    })),
                            ),
                    )
                    .child(
                        v_flex()
                            .p_4()
                            .gap_3()
                            .child(
                                v_flex()
                                    .gap_1()
                                    .child(
                                        div()
                                            .font_weight(gpui::FontWeight::SEMIBOLD)
                                            .child("UI scale"),
                                    )
                                    .child(
                                        div()
                                            .text_sm()
                                            .text_color(cx.theme().muted_foreground)
                                            .child(
                                                "Increase text, controls, and interface spacing.",
                                            ),
                                    ),
                            )
                            .child(
                                h_flex()
                                    .items_center()
                                    .gap_2()
                                    .child(
                                        Button::new("decrease-ui-scale")
                                            .label("−")
                                            .disabled(self.ui_scale <= MIN_UI_SCALE)
                                            .on_click(cx.listener(|this, _, window, cx| {
                                                this.adjust_ui_scale(-UI_SCALE_STEP, window, cx);
                                            })),
                                    )
                                    .child(
                                        div()
                                            .w(px(84.))
                                            .text_center()
                                            .font_weight(gpui::FontWeight::SEMIBOLD)
                                            .child(format!("{scale_percent}%")),
                                    )
                                    .child(
                                        Button::new("increase-ui-scale")
                                            .label("+")
                                            .disabled(self.ui_scale >= MAX_UI_SCALE)
                                            .on_click(cx.listener(|this, _, window, cx| {
                                                this.adjust_ui_scale(UI_SCALE_STEP, window, cx);
                                            })),
                                    )
                                    .child(
                                        Button::new("reset-ui-scale")
                                            .small()
                                            .label("Reset")
                                            .disabled(self.ui_scale == 1.0)
                                            .on_click(cx.listener(|this, _, window, cx| {
                                                this.set_ui_scale(1.0, window, cx);
                                            })),
                                    ),
                            )
                            .child(
                                div()
                                    .text_xs()
                                    .text_color(cx.theme().muted_foreground)
                                    .child("Saved automatically for future launches."),
                            ),
                    ),
            )
    }

    fn render_chat_info(&mut self, cx: &mut Context<Self>) -> gpui::Stateful<gpui::Div> {
        let Some(state) = self.chat_info.as_ref() else {
            return div().id("chat-info-backdrop");
        };
        let chat_id = state.chat_id.clone();
        let loading = state.loading;
        let error = state.error.clone();
        let info = state.info.clone();
        let chat = self.store.chat(&chat_id).cloned();
        let is_group = chat
            .as_ref()
            .is_some_and(|chat| chat.kind() == proto::ChatKind::Group);
        let title = chat
            .as_ref()
            .map(|chat| chat.title.clone())
            .unwrap_or_else(|| "Conversation".into());
        let avatar_path = chat
            .as_ref()
            .map(|chat| chat.avatar_path.clone())
            .unwrap_or_default();

        // Warm the avatars for the members that are about to be shown; the
        // media budget in the RPC layer keeps this from flooding the backend.
        if let Some(info) = info.as_ref() {
            let pending: Vec<String> = info
                .participants
                .iter()
                .take(24)
                .filter(|participant| {
                    self.store
                        .participant_avatar_path(&participant.participant_id)
                        .is_none()
                })
                .map(|participant| participant.participant_id.clone())
                .collect();
            for participant_id in pending {
                self.load_participant_avatar(participant_id);
            }
        }

        let muted = cx.theme().muted_foreground;
        let border = cx.theme().border;
        let hover_background = cx.theme().muted;
        let section = |label: &'static str, value: String| {
            v_flex()
                .gap_1()
                .child(div().text_xs().text_color(muted).child(label))
                .child(div().text_sm().child(value))
        };

        let subtitle = if let Some(info) = info.as_ref().filter(|_| is_group) {
            format!("Group · {} members", info.participant_count)
        } else if is_group {
            "Group".to_string()
        } else {
            chat.as_ref()
                .map(|chat| chat.phone_number.clone())
                .unwrap_or_default()
        };
        let identity_avatar = avatar_element(&title, &avatar_path, px(96.), cx);

        let mut body = v_flex()
            .id("chat-info-body")
            .flex_1()
            .min_h_0()
            .overflow_y_scroll()
            .track_scroll(&self.chat_info_scroll)
            .on_scroll_wheel(cx.listener(|this, event, window, cx| {
                this.handle_smooth_scroll_input(ScrollSurface::ChatInfo, event, window, cx);
            }))
            .p_4()
            .gap_4()
            .child(
                v_flex()
                    .items_center()
                    .gap_2()
                    .child(identity_avatar)
                    .child(
                        div()
                            .text_xl()
                            .font_weight(gpui::FontWeight::SEMIBOLD)
                            .text_center()
                            .child(title.clone()),
                    )
                    .when(!subtitle.is_empty(), |identity| {
                        identity.child(
                            div()
                                .text_sm()
                                .text_color(muted)
                                .text_center()
                                .child(subtitle),
                        )
                    }),
            );
        if loading {
            body = body.child(
                div()
                    .text_sm()
                    .text_color(muted)
                    .text_center()
                    .child("Loading chat details…"),
            );
        }
        if let Some(error) = error {
            body = body.child(
                v_flex()
                    .items_center()
                    .gap_2()
                    .child(div().text_sm().text_color(rgb(0xef4444)).child(error))
                    .child(
                        Button::new("chat-info-retry")
                            .small()
                            .label("Retry")
                            .on_click(cx.listener({
                                let chat_id = chat_id.clone();
                                move |this, _, _, cx| {
                                    this.open_chat_info(chat_id.clone());
                                    cx.notify();
                                }
                            })),
                    ),
            );
        }
        if let Some(info) = info {
            if !is_group {
                if !info.about.is_empty() {
                    body = body.child(section("About", info.about.clone()));
                }
                if let Some(chat) = chat.as_ref() {
                    if !chat.phone_number.is_empty() {
                        body = body.child(section("Phone", chat.phone_number.clone()));
                    }
                    if !info.verified_name.is_empty() {
                        body = body.child(section("Verified business", info.verified_name.clone()));
                    }
                    if !chat.business_name.is_empty() && chat.business_name != chat.title {
                        body = body.child(section("Business name", chat.business_name.clone()));
                    }
                    if !chat.push_name.is_empty() && chat.push_name != chat.title {
                        body = body.child(section("Profile name", format!("~{}", chat.push_name)));
                    }
                }
            } else {
                let description = if info.description.is_empty() {
                    "No description".to_string()
                } else {
                    info.description.clone()
                };
                body = body.child(section("Description", description));
                if info.created_at_ms > 0 {
                    let mut created = format!("Created {}", format_epoch_date(info.created_at_ms));
                    if !info.created_by.is_empty() {
                        created.push_str(&format!(" by {}", info.created_by));
                    }
                    body = body.child(div().text_xs().text_color(muted).child(created));
                }
                if info.disappearing_timer_seconds > 0 {
                    body = body.child(section(
                        "Disappearing messages",
                        format_disappearing_timer(info.disappearing_timer_seconds),
                    ));
                }
                let mut notes: Vec<&'static str> = Vec::new();
                if info.is_community {
                    notes.push("Community group");
                }
                if info.announce_only {
                    notes.push("Only admins can send messages");
                }
                if info.locked {
                    notes.push("Only admins can edit group info");
                }
                if info.join_approval_required {
                    notes.push("Admins approve new members");
                }
                if !notes.is_empty() {
                    body =
                        body.child(v_flex().gap_1().children(notes.into_iter().map(|note| {
                            div().text_xs().text_color(muted).child(format!("• {note}"))
                        })));
                }
                if !info.participants.is_empty() {
                    const MAX_MEMBER_ROWS: usize = 200;
                    let mut members = v_flex().gap_1().child(
                        div()
                            .text_xs()
                            .text_color(muted)
                            .child(format!("{} members", info.participant_count)),
                    );
                    for (index, participant) in
                        info.participants.iter().take(MAX_MEMBER_ROWS).enumerate()
                    {
                        let display_name = if participant.is_me {
                            "You".to_string()
                        } else if participant.display_name.is_empty() {
                            participant.phone_number.clone()
                        } else {
                            participant.display_name.clone()
                        };
                        let member_avatar_path = self
                            .store
                            .participant_avatar_path(&participant.participant_id)
                            .filter(|path| !path.is_empty())
                            .unwrap_or_default();
                        let member_avatar =
                            avatar_element(&display_name, member_avatar_path, px(32.), cx);
                        let badge = if participant.is_super_admin {
                            Some("Owner")
                        } else if participant.is_admin {
                            Some("Admin")
                        } else {
                            None
                        };
                        let clickable =
                            !participant.is_me && !participant.participant_id.is_empty();
                        let mut row = h_flex()
                            .id(index)
                            .px_2()
                            .py_1()
                            .gap_2()
                            .items_center()
                            .rounded_md()
                            .child(member_avatar)
                            .child(
                                v_flex()
                                    .flex_1()
                                    .min_w_0()
                                    .child(div().text_sm().truncate().child(display_name))
                                    .when(
                                        !participant.phone_number.is_empty() && !participant.is_me,
                                        |details| {
                                            details.child(
                                                div()
                                                    .text_xs()
                                                    .text_color(muted)
                                                    .truncate()
                                                    .child(participant.phone_number.clone()),
                                            )
                                        },
                                    ),
                            )
                            .when_some(badge, |row, badge| {
                                row.child(
                                    div()
                                        .px_2()
                                        .py_0p5()
                                        .rounded_sm()
                                        .border_1()
                                        .border_color(border)
                                        .text_xs()
                                        .text_color(muted)
                                        .child(badge),
                                )
                            });
                        if clickable {
                            row = row
                                .cursor_pointer()
                                .hover(move |style| style.bg(hover_background))
                                .on_click(cx.listener({
                                    let contact_jid = participant.participant_id.clone();
                                    move |this, _, _, cx| {
                                        this.chat_info = None;
                                        this.request(
                                            rpc_request::Request::OpenContact(
                                                proto::OpenContactRequest {
                                                    contact_jid: contact_jid.clone(),
                                                },
                                            ),
                                            PendingRequest::OpenContact,
                                        );
                                        cx.notify();
                                    }
                                }));
                        }
                        members = members.child(row);
                    }
                    if info.participants.len() > MAX_MEMBER_ROWS {
                        members = members.child(div().text_xs().text_color(muted).child(format!(
                            "…and {} more",
                            info.participants.len() - MAX_MEMBER_ROWS
                        )));
                    }
                    body = body.child(members);
                }
            }
            let mut flags = Vec::new();
            if let Some(chat) = chat.as_ref() {
                if chat.pinned {
                    flags.push("Pinned");
                }
                if chat.muted {
                    flags.push("Muted");
                }
                if chat.archived {
                    flags.push("Archived");
                }
            }
            if !flags.is_empty() {
                body = body.child(h_flex().gap_2().children(flags.into_iter().map(|flag| {
                    div()
                        .px_2()
                        .py_0p5()
                        .rounded_sm()
                        .border_1()
                        .border_color(border)
                        .text_xs()
                        .text_color(muted)
                        .child(flag)
                })));
            }
            if !info.address.is_empty() {
                body = body.child(section("WhatsApp address", info.address.clone()));
            }
        }

        div()
            .id("chat-info-backdrop")
            .absolute()
            .inset_0()
            // Without occlusion, clicks fall through to the conversation
            // header below, whose click target immediately reopens the pane.
            .occlude()
            .bg(rgba(0x00000066))
            .flex()
            .justify_end()
            .on_click(cx.listener(|this, _, _, cx| {
                this.chat_info = None;
                cx.notify();
            }))
            .child(
                v_flex()
                    .w(px(400.))
                    .max_w_full()
                    .h_full()
                    // Occlude the backdrop so clicks inside the pane don't hit
                    // its close-on-click handler.
                    .occlude()
                    .bg(cx.theme().background)
                    .border_l_1()
                    .border_color(border)
                    .child(
                        h_flex()
                            .h(px(58.))
                            .px_4()
                            .items_center()
                            .justify_between()
                            .border_b_1()
                            .border_color(border)
                            .child(div().font_weight(gpui::FontWeight::SEMIBOLD).child(
                                if is_group {
                                    "Group info"
                                } else {
                                    "Contact info"
                                },
                            ))
                            .child(Button::new("close-chat-info").label("×").on_click(
                                cx.listener(|this, _, _, cx| {
                                    this.chat_info = None;
                                    cx.notify();
                                }),
                            )),
                    )
                    .child(body),
            )
    }

    fn render_chat_switcher(&self, cx: &mut Context<Self>) -> gpui::Div {
        let Some(switcher) = self.chat_switcher.as_ref() else {
            return div();
        };
        let highlighted = switcher.highlighted;
        let chats = switcher
            .chat_ids
            .iter()
            .filter_map(|chat_id| self.store.chat(chat_id).cloned())
            .collect::<Vec<_>>();
        let selected_background = if cx.theme().is_dark() {
            rgb(0x173f35)
        } else {
            rgb(0xd9fdd3)
        };
        let hover_background = if cx.theme().is_dark() {
            rgb(0x202c33)
        } else {
            rgb(0xf0f2f5)
        };
        div()
            .absolute()
            .inset_0()
            .flex()
            .items_center()
            .justify_center()
            .p_4()
            .bg(rgba(0x00000088))
            .child(
                v_flex()
                    .w(px(500. * self.ui_scale))
                    .max_w_full()
                    .rounded_lg()
                    .border_1()
                    .border_color(cx.theme().border)
                    .bg(cx.theme().background)
                    .overflow_hidden()
                    .child(
                        h_flex()
                            .h(px(52. * self.ui_scale))
                            .px_4()
                            .items_center()
                            .justify_between()
                            .border_b_1()
                            .border_color(cx.theme().border)
                            .child(
                                div()
                                    .font_weight(gpui::FontWeight::SEMIBOLD)
                                    .child("Recent chats"),
                            )
                            .child(
                                div()
                                    .text_xs()
                                    .text_color(cx.theme().muted_foreground)
                                    .child(format!("{} of {}", highlighted + 1, chats.len())),
                            ),
                    )
                    .children(chats.into_iter().enumerate().map(|(index, chat)| {
                        let chat_id = chat.id.clone();
                        let preview = if chat.last_message_preview.trim().is_empty() {
                            if chat.phone_number.trim().is_empty() {
                                "No messages yet".to_string()
                            } else {
                                chat.phone_number.clone()
                            }
                        } else {
                            chat.last_message_preview.clone()
                        };
                        let avatar = avatar_element(
                            &chat.title,
                            &chat.avatar_path,
                            px(40. * self.ui_scale),
                            cx,
                        );
                        h_flex()
                            .id(("recent-chat", index))
                            .h(px(64. * self.ui_scale))
                            .px_4()
                            .gap_3()
                            .items_center()
                            .overflow_hidden()
                            .cursor_pointer()
                            .when(index == highlighted, |row| row.bg(selected_background))
                            .hover(move |style| style.bg(hover_background))
                            .on_click(cx.listener(move |this, _, window, cx| {
                                this.commit_chat_switcher_to(chat_id.clone(), window, cx);
                                cx.notify();
                            }))
                            .child(avatar)
                            .child(
                                v_flex()
                                    .min_w_0()
                                    .flex_1()
                                    .child(
                                        div()
                                            .w_full()
                                            .min_w_0()
                                            .truncate()
                                            .font_weight(gpui::FontWeight::SEMIBOLD)
                                            .child(one_line(&chat.title)),
                                    )
                                    .child(
                                        div()
                                            .w_full()
                                            .min_w_0()
                                            .truncate()
                                            .text_sm()
                                            .text_color(cx.theme().muted_foreground)
                                            .child(one_line(&preview)),
                                    ),
                            )
                            .when(chat.archived, |row| {
                                row.child(
                                    div()
                                        .text_xs()
                                        .text_color(cx.theme().muted_foreground)
                                        .child("Archived"),
                                )
                            })
                    }))
                    .child(
                        div()
                            .px_4()
                            .py_3()
                            .border_t_1()
                            .border_color(cx.theme().border)
                            .text_xs()
                            .text_color(cx.theme().muted_foreground)
                            .child("Release Ctrl to switch · Esc to cancel"),
                    ),
            )
    }

    fn render_image_viewer(&self, cx: &mut Context<Self>) -> gpui::Div {
        let Some(viewer) = self.image_viewer.as_ref() else {
            return div();
        };
        let chat_id = viewer.chat_id.clone();
        let message_id = viewer.message_id.clone();
        let path = viewer.path.clone();
        let caption = viewer.caption.trim().to_string();
        let media_name = if viewer.sticker { "Sticker" } else { "Photo" };
        let opening_label = if viewer.sticker {
            "Opening sticker…"
        } else {
            "Opening photo…"
        };
        let fallback_label = if viewer.sticker {
            "This sticker couldn't be decoded. Try Reload."
        } else {
            "This photo couldn't be decoded. Try Reload."
        };
        div()
            .absolute()
            .inset_0()
            .occlude()
            .flex()
            .flex_col()
            .p_4()
            .bg(rgba(0x050807f2))
            .text_color(rgb(0xffffff))
            .child(
                h_flex()
                    .w_full()
                    .items_center()
                    .justify_between()
                    .child(
                        div()
                            .font_weight(gpui::FontWeight::SEMIBOLD)
                            .child(media_name),
                    )
                    .child(
                        h_flex()
                            .gap_2()
                            .child(Button::new("reload-viewed-image").label("Reload").on_click(
                                cx.listener(move |this, _, _, cx| {
                                    this.retry_message_image(chat_id.clone(), message_id.clone());
                                    cx.notify();
                                }),
                            ))
                            .child(Button::new("close-image-viewer").label("×").on_click(
                                cx.listener(|this, _, _, cx| {
                                    this.image_viewer = None;
                                    cx.notify();
                                }),
                            )),
                    ),
            )
            .child(
                div().flex_1().min_h_0().min_w_0().p_4().child(
                    img(PathBuf::from(path))
                        .size_full()
                        .object_fit(ObjectFit::Contain)
                        .with_loading(move || {
                            div()
                                .size_full()
                                .flex()
                                .items_center()
                                .justify_center()
                                .child(opening_label)
                                .into_any_element()
                        })
                        .with_fallback(move || {
                            div()
                                .size_full()
                                .flex()
                                .items_center()
                                .justify_center()
                                .child(fallback_label)
                                .into_any_element()
                        }),
                ),
            )
            .when(!caption.is_empty(), |viewer| {
                viewer.child(
                    div()
                        .w_full()
                        .max_h(px(96.))
                        .overflow_hidden()
                        .px_4()
                        .py_2()
                        .text_sm()
                        .child(caption),
                )
            })
    }

    fn render_linkified_text(
        &self,
        message_id: &str,
        text: &str,
        cx: &mut Context<Self>,
    ) -> gpui::Div {
        let mut lines = Vec::new();
        for (line_index, line) in text.split('\n').enumerate() {
            let mut row = h_flex().flex_wrap();
            if line.is_empty() {
                row = row.child(div().child(" "));
            }
            for (token_index, token) in line.split_whitespace().enumerate() {
                if let Some((prefix, url, suffix)) = split_url_token(token) {
                    if !prefix.is_empty() {
                        row = row.child(div().child(prefix.to_string()));
                    }
                    let target = url.to_string();
                    row = row.child(
                        div()
                            .id(format!(
                                "message-link-{message_id}-{line_index}-{token_index}"
                            ))
                            .cursor_pointer()
                            .text_color(rgb(0x0b57d0))
                            .underline()
                            .child(url.to_string())
                            .on_click(cx.listener(move |_, _, _, cx| cx.open_url(&target))),
                    );
                    row = row.child(div().child(format!("{suffix} ")));
                } else {
                    row = row.child(div().child(format!("{token} ")));
                }
            }
            lines.push(row.into_any_element());
        }
        div().child(v_flex().children(lines))
    }

    fn render_link_preview(
        &self,
        index: usize,
        preview: proto::LinkPreview,
        cx: &mut Context<Self>,
    ) -> gpui::Stateful<gpui::Div> {
        let target = is_safe_web_url(&preview.url).then(|| preview.url.clone());
        let host = link_preview_host(&preview.url).to_string();
        let title = if preview.title.trim().is_empty() {
            host.clone()
        } else {
            preview.title.clone()
        };
        let thumbnail = (!preview.jpeg_thumbnail.is_empty()).then(|| {
            Arc::new(gpui::Image::from_bytes(
                gpui::ImageFormat::Jpeg,
                preview.jpeg_thumbnail,
            ))
        });
        v_flex()
            .id(("link-preview", index))
            .w(px(320.))
            .max_w_full()
            .overflow_hidden()
            .rounded_md()
            .border_1()
            .border_color(cx.theme().border)
            .bg(cx.theme().secondary)
            .when_some(thumbnail, |card, thumbnail| {
                card.child(
                    img(thumbnail)
                        .w_full()
                        .h(px(144.))
                        .object_fit(ObjectFit::Cover),
                )
            })
            .child(
                v_flex()
                    .p_2()
                    .gap_1()
                    .child(
                        div()
                            .truncate()
                            .text_sm()
                            .font_weight(gpui::FontWeight::SEMIBOLD)
                            .child(title),
                    )
                    .when(!preview.description.trim().is_empty(), |details| {
                        details.child(
                            div()
                                .truncate()
                                .text_xs()
                                .text_color(cx.theme().muted_foreground)
                                .child(preview.description),
                        )
                    })
                    .child(
                        div()
                            .truncate()
                            .text_xs()
                            .text_color(cx.theme().muted_foreground)
                            .child(host),
                    ),
            )
            .when_some(target, |card, target| {
                card.cursor_pointer()
                    .on_click(cx.listener(move |_, _, _, cx| cx.open_url(&target)))
            })
    }

    fn render_message(&self, index: usize, cx: &mut Context<Self>) -> gpui::Div {
        let message = &self.store.messages[index];
        let text_content = match message.content.as_ref() {
            Some(proto::message::Content::Text(text)) => Some(text.clone()),
            _ => None,
        };
        let image_content = match message.content.as_ref() {
            Some(proto::message::Content::Image(image)) => Some(image.clone()),
            _ => None,
        };
        let sticker = image_content.as_ref().is_some_and(|image| image.sticker);
        let text = if sticker {
            String::new()
        } else {
            message_text(message).to_string()
        };
        let reaction_chips = reaction_counts(message);
        let reply_target_id = message.reply_to_message_id.clone();
        let reply_target = self.store.message(&reply_target_id).cloned();
        let reply_count = self.store.reply_count(&message.id);
        let first_reply_id = self.store.first_reply_id(&message.id).map(str::to_owned);
        let chat_id = message.chat_id.clone();
        let message_id = message.id.clone();
        let body_message_id = message.id.clone();
        let search_target = self.search_target_message_id.as_deref() == Some(message.id.as_str());
        let reply_action_message_id = message_id.clone();
        let message_image_chat_id = chat_id.clone();
        let message_image_id = message_id.clone();
        let image_failure = self
            .image_failures
            .get(&(chat_id.clone(), message_id.clone()))
            .cloned();
        let reaction_chat_id = chat_id.clone();
        let reaction_message_id = message_id.clone();
        let own_reaction_background: gpui::Hsla = if cx.theme().is_dark() {
            rgb(0x164e3d).into()
        } else {
            rgb(0xd9fdd3).into()
        };
        let reaction_hover = if cx.theme().is_dark() {
            rgb(0x245c4e)
        } else {
            rgb(0xc8f4c1)
        };
        let group_incoming = !message.from_me
            && self
                .store
                .selected_chat()
                .is_some_and(|chat| chat.kind() == proto::ChatKind::Group);
        let meta_text = {
            let mut segments: Vec<&str> = Vec::new();
            if message.edited {
                segments.push("edited");
            }
            if message.from_me {
                let status = message_status(message.status());
                if !status.is_empty() {
                    segments.push(status);
                }
            }
            segments.join(" · ")
        };
        h_flex()
            .w_full()
            .items_start()
            .gap_2()
            .when(message.from_me, |row| row.justify_end())
            .when(group_incoming, |row| {
                let avatar_path = if message.sender_avatar_path.is_empty() {
                    self.store
                        .participant_avatar_path(&message.sender_id)
                        .unwrap_or_default()
                } else {
                    message.sender_avatar_path.as_str()
                };
                row.child(avatar_element(
                    &message.sender_name,
                    avatar_path,
                    px(34.),
                    cx,
                ))
            })
            .child(
                v_flex()
                    .max_w(px(560.))
                    .when(!sticker, |bubble| bubble.px_3().py_2())
                    .rounded_lg()
                    .when(search_target, |bubble| {
                        bubble.border_2().border_color(rgb(0x25d366))
                    })
                    .gap_1()
                    .bg(if sticker {
                        gpui::transparent_black()
                    } else if message.from_me {
                        if cx.theme().is_dark() {
                            rgb(0x173f35).into()
                        } else {
                            gpui::hsla(0.31, 0.87, 0.91, 1.0)
                        }
                    } else {
                        cx.theme().background
                    })
                    .when(group_incoming, |bubble| {
                        let name_color = cx.theme().blue.hue(identity_hue(&message.sender_name));
                        let show_number = !message.sender_phone_number.is_empty()
                            && message.sender_phone_number != message.sender_name;
                        bubble.child(
                            h_flex()
                                .items_baseline()
                                .gap_2()
                                .child(
                                    div()
                                        .text_sm()
                                        .font_weight(gpui::FontWeight::SEMIBOLD)
                                        .text_color(name_color)
                                        .child(message.sender_name.clone()),
                                )
                                .when(show_number, |header| {
                                    header.child(
                                        div()
                                            .text_xs()
                                            .text_color(cx.theme().muted_foreground)
                                            .child(message.sender_phone_number.clone()),
                                    )
                                }),
                        )
                    })
                    .when(!reply_target_id.is_empty(), |bubble| {
                        let target_id = reply_target_id.clone();
                        let (sender, preview) = reply_target.as_ref().map_or_else(
                            || {
                                (
                                    "Original message".to_string(),
                                    "Message unavailable".to_string(),
                                )
                            },
                            |target| {
                                let sender = if target.from_me {
                                    "You".to_string()
                                } else if !target.sender_name.trim().is_empty() {
                                    target.sender_name.trim().to_string()
                                } else {
                                    "Unknown contact".to_string()
                                };
                                (sender, message_preview(target))
                            },
                        );
                        bubble.child(
                            v_flex()
                                .id(("quoted-message", index))
                                .w_full()
                                .min_w(px(180.))
                                .px_3()
                                .py_2()
                                .rounded_md()
                                .border_l_2()
                                .border_color(rgb(0x25d366))
                                .bg(cx.theme().secondary)
                                .cursor_pointer()
                                .child(
                                    div()
                                        .text_xs()
                                        .font_weight(gpui::FontWeight::SEMIBOLD)
                                        .text_color(rgb(0x25d366))
                                        .child(sender),
                                )
                                .child(
                                    div()
                                        .truncate()
                                        .text_sm()
                                        .text_color(cx.theme().muted_foreground)
                                        .child(preview),
                                )
                                .on_click(cx.listener(move |this, _, _, cx| {
                                    this.scroll_to_message(&target_id);
                                    cx.notify();
                                })),
                        )
                    })
                    .when_some(image_content, |bubble, image| {
                        let media_name = if image.sticker { "sticker" } else { "photo" };
                        let (image_width, image_height) = image_render_size(&image);
                        let image_path = image_row_path(&image).to_string();
                        let viewer_path = image_viewer_path(&image).to_string();
                        let image_is_cached = !image_path.is_empty()
                            && !viewer_path.is_empty()
                            && PathBuf::from(&image_path).is_file()
                            && PathBuf::from(&viewer_path).is_file();
                        let cached_path_missing =
                            (!image_path.is_empty() || !viewer_path.is_empty()) && !image_is_cached;
                        let retryable =
                            image.downloadable && (image_failure.is_some() || cached_path_missing);
                        let placeholder = if cached_path_missing {
                            format!("Cached {media_name} missing · Click to reload")
                        } else if let Some(failure) = image_failure.clone() {
                            failure
                        } else if image.downloadable {
                            format!("Loading {media_name}…")
                        } else if image.sticker {
                            "Sticker unavailable".to_string()
                        } else {
                            "Photo unavailable".to_string()
                        };
                        let viewer_chat_id = message_image_chat_id.clone();
                        let viewer_message_id = message_image_id.clone();
                        let viewer_caption = image.caption.clone();
                        let viewer_sticker = image.sticker;
                        let retry_chat_id = message_image_chat_id.clone();
                        let retry_message_id = message_image_id.clone();
                        let loading_color = cx.theme().muted_foreground;
                        let fallback_color = cx.theme().muted_foreground;
                        let decoding_label = format!("Decoding {media_name}…");
                        let decode_failure_label =
                            format!("Couldn't display {media_name} · Open to retry");
                        bubble.child(
                            div()
                                .id(("message-image", index))
                                .w(image_width)
                                .h(image_height)
                                .max_w_full()
                                .overflow_hidden()
                                .rounded_md()
                                .when(!image.sticker, |container| {
                                    container
                                        .border_1()
                                        .border_color(cx.theme().border)
                                        .bg(cx.theme().secondary)
                                })
                                .when(image_is_cached, |container| {
                                    container.child(
                                        img(PathBuf::from(image_path.clone()))
                                            .size_full()
                                            .object_fit(ObjectFit::Contain)
                                            .with_loading(move || {
                                                div()
                                                    .size_full()
                                                    .flex()
                                                    .items_center()
                                                    .justify_center()
                                                    .text_sm()
                                                    .text_color(loading_color)
                                                    .child(decoding_label.clone())
                                                    .into_any_element()
                                            })
                                            .with_fallback(move || {
                                                div()
                                                    .size_full()
                                                    .flex()
                                                    .items_center()
                                                    .justify_center()
                                                    .px_3()
                                                    .text_sm()
                                                    .text_color(fallback_color)
                                                    .child(decode_failure_label.clone())
                                                    .into_any_element()
                                            }),
                                    )
                                })
                                .when(image_is_cached, |container| {
                                    container.cursor_pointer().on_click(cx.listener(
                                        move |this, _, _, cx| {
                                            this.open_image_viewer(
                                                viewer_chat_id.clone(),
                                                viewer_message_id.clone(),
                                                viewer_path.clone(),
                                                viewer_caption.clone(),
                                                viewer_sticker,
                                            );
                                            cx.notify();
                                        },
                                    ))
                                })
                                .when(!image_is_cached, |container| {
                                    container.child(
                                        div()
                                            .size_full()
                                            .flex()
                                            .items_center()
                                            .justify_center()
                                            .px_3()
                                            .text_sm()
                                            .text_color(cx.theme().muted_foreground)
                                            .child(placeholder),
                                    )
                                })
                                .when(retryable, |container| {
                                    container.cursor_pointer().on_click(cx.listener(
                                        move |this, _, _, cx| {
                                            this.retry_message_image(
                                                retry_chat_id.clone(),
                                                retry_message_id.clone(),
                                            );
                                            cx.notify();
                                        },
                                    ))
                                }),
                        )
                    })
                    .when_some(
                        text_content.and_then(|text| text.link_preview),
                        |bubble, preview| {
                            bubble.child(self.render_link_preview(index, preview, cx))
                        },
                    )
                    .when(!text.is_empty(), |bubble| {
                        bubble.child(self.render_linkified_text(&body_message_id, &text, cx))
                    })
                    .when(!reaction_chips.is_empty(), |bubble| {
                        bubble.child(
                            h_flex()
                                .gap_1()
                                .children(reaction_chips.into_iter().enumerate().map(
                                    |(chip_index, reaction)| {
                                        let emoji = reaction.emoji.to_string();
                                        let clicked_emoji = emoji.clone();
                                        let clicked_chat_id = reaction_chat_id.clone();
                                        let clicked_message_id = reaction_message_id.clone();
                                        div()
                                            .id(format!("reaction-chip-{index}-{chip_index}"))
                                            .px_2()
                                            .py_1()
                                            .rounded_lg()
                                            .border_1()
                                            .border_color(if reaction.from_me {
                                                rgb(0x25d366).into()
                                            } else {
                                                cx.theme().border
                                            })
                                            .bg(if reaction.from_me {
                                                own_reaction_background
                                            } else {
                                                cx.theme().secondary
                                            })
                                            .hover(move |style| style.bg(reaction_hover))
                                            .cursor_pointer()
                                            .text_xs()
                                            .child(format!("{emoji} {}", reaction.count))
                                            .on_click(cx.listener(move |this, _, _, cx| {
                                                this.open_reaction_details(
                                                    clicked_chat_id.clone(),
                                                    clicked_message_id.clone(),
                                                    clicked_emoji.clone(),
                                                );
                                                cx.notify();
                                            }))
                                    },
                                )),
                        )
                    })
                    .child(
                        h_flex()
                            .items_center()
                            .gap_1()
                            .when(!meta_text.is_empty(), |footer| {
                                footer.child(
                                    div()
                                        .text_xs()
                                        .text_color(cx.theme().muted_foreground)
                                        .child(meta_text.clone()),
                                )
                            })
                            .when(reply_count > 0, |footer| {
                                let reply_id = first_reply_id.clone().unwrap_or_default();
                                footer.child(
                                    Button::new(("view-replies", index))
                                        .ghost()
                                        .small()
                                        .label(if reply_count == 1 {
                                            "1 reply".to_string()
                                        } else {
                                            format!("{reply_count} replies")
                                        })
                                        .on_click(cx.listener(move |this, _, _, cx| {
                                            this.scroll_to_message(&reply_id);
                                            cx.notify();
                                        })),
                                )
                            })
                            .child(
                                Button::new(("reply-message", index))
                                    .ghost()
                                    .small()
                                    .icon(IconName::Undo)
                                    .tooltip("Reply")
                                    .on_click(cx.listener(move |this, _, _, cx| {
                                        this.start_reply(reply_action_message_id.clone());
                                        cx.notify();
                                    })),
                            )
                            .child(
                                Button::new(("react-message", index))
                                    .ghost()
                                    .small()
                                    .icon(IconName::Heart)
                                    .tooltip("React")
                                    .on_click(cx.listener(move |this, _, _, cx| {
                                        this.open_reaction_picker(
                                            chat_id.clone(),
                                            message_id.clone(),
                                        );
                                        cx.notify();
                                    })),
                            ),
                    ),
            )
    }

    fn measure_message_heights(
        &mut self,
        wrap_width: Pixels,
        font_size: Pixels,
        window: &mut Window,
    ) {
        let width_bucket = (wrap_width / px(8.)).round() as i32;
        if !self.store.message_sizes_need_measurement(width_bucket) {
            return;
        }
        let line_height = window.line_height();
        let mut sizes = Vec::with_capacity(self.store.messages.len());
        for index in 0..self.store.messages.len() {
            let height = if let Some(height) = {
                let message = &self.store.messages[index];
                self.store.cached_message_height(&message.id, width_bucket)
            } {
                height
            } else {
                let (id, text) = {
                    let message = &self.store.messages[index];
                    (message.id.clone(), message_text(message).to_string())
                };
                let text_height = if text.is_empty() {
                    px(0.)
                } else {
                    let text: SharedString = text.into();
                    let run = window.text_style().to_run(text.len());
                    window
                        .text_system()
                        .shape_text(text, font_size, &[run], Some(wrap_width), None)
                        .map(|lines| {
                            lines.iter().fold(px(0.), |height, line| {
                                height + line.size(line_height).height
                            })
                        })
                        .unwrap_or(line_height)
                };
                let image_height = match self.store.messages[index].content.as_ref() {
                    Some(proto::message::Content::Image(image)) => {
                        image_render_size(image).1
                            + if text_height > px(0.) { px(4.) } else { px(0.) }
                    }
                    _ => px(0.),
                };
                let link_preview_height = match self.store.messages[index].content.as_ref() {
                    Some(proto::message::Content::Text(text)) if text.link_preview.is_some() => {
                        let thumbnail = text
                            .link_preview
                            .as_ref()
                            .is_some_and(|preview| !preview.jpeg_thumbnail.is_empty());
                        px(if thumbnail { 210. } else { 70. } * self.ui_scale)
                    }
                    _ => px(0.),
                };
                let reaction_height = if reaction_counts(&self.store.messages[index]).is_empty() {
                    px(0.)
                } else {
                    px(30. * self.ui_scale)
                };
                let reply_height = if self.store.messages[index].reply_to_message_id.is_empty() {
                    px(0.)
                } else {
                    px(54. * self.ui_scale)
                };
                // Group messages carry a sender name/number line above the body.
                let sender_header_height = if !self.store.messages[index].from_me
                    && self
                        .store
                        .selected_chat()
                        .is_some_and(|chat| chat.kind() == proto::ChatKind::Group)
                {
                    px(22. * self.ui_scale)
                } else {
                    px(0.)
                };
                let height = text_height
                    + image_height
                    + link_preview_height
                    + px(40. * self.ui_scale)
                    + reaction_height
                    + reply_height
                    + sender_header_height;
                self.store.cache_message_height(id, width_bucket, height);
                height
            };
            sizes.push(size(px(1.), height));
        }
        self.store.set_measured_message_sizes(width_bucket, sizes);
    }
}

fn image_render_size(image: &proto::ImageContent) -> (Pixels, Pixels) {
    let max_edge = if image.sticker { 220. } else { 320. };
    if image.width == 0 || image.height == 0 {
        return if image.sticker {
            (px(max_edge), px(max_edge))
        } else {
            (px(300.), px(220.))
        };
    }
    let source_width = image.width as f32;
    let source_height = image.height as f32;
    let scale = (max_edge / source_width).min(max_edge / source_height);
    (px(source_width * scale), px(source_height * scale))
}

impl Render for RustMeow {
    fn render(&mut self, window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let content = match self.store.screen {
            Screen::Starting => self.render_center(
                "Starting Rust Meow",
                "Connecting to the local WhatsApp backend",
            ),
            Screen::Pairing => self.render_pairing(cx),
            Screen::Syncing => self.render_center(
                "Syncing your chats",
                format!(
                    "{} chats · {} messages",
                    self.store.sync_chats, self.store.sync_messages
                ),
            ),
            Screen::Chats => self.render_chats(window, cx),
            Screen::Fatal => self.render_center(
                "Rust Meow needs attention",
                self.store
                    .fatal_error
                    .clone()
                    .unwrap_or_else(|| "Unknown backend error".into()),
            ),
        };
        v_flex()
            .size_full()
            .bg(cx.theme().background)
            .track_focus(&self.focus_handle)
            .on_action(cx.listener(|this, _: &CycleRecentChat, window, cx| {
                this.cycle_recent_chat(false, window, cx);
                cx.stop_propagation();
                cx.notify();
            }))
            .on_action(cx.listener(|this, _: &CycleRecentChatReverse, window, cx| {
                this.cycle_recent_chat(true, window, cx);
                cx.stop_propagation();
                cx.notify();
            }))
            .on_modifiers_changed(
                cx.listener(|this, event: &ModifiersChangedEvent, window, cx| {
                    if this.chat_switcher.is_some() && !event.modifiers.control {
                        this.commit_chat_switcher(window, cx);
                        cx.notify();
                    }
                }),
            )
            .capture_key_down(cx.listener(|this, event: &KeyDownEvent, window, cx| {
                if event.keystroke.modifiers.secondary() && event.keystroke.key == "k" {
                    this.focus_search(window, cx);
                    cx.stop_propagation();
                    cx.notify();
                    return;
                }
                let composer_focused = this.composer.read(cx).focus_handle(cx).is_focused(window);
                let emoji_focused = this
                    .emoji_search
                    .read(cx)
                    .focus_handle(cx)
                    .is_focused(window);
                let search_focused = this
                    .search_input
                    .read(cx)
                    .focus_handle(cx)
                    .is_focused(window);
                if event.keystroke.key == "/"
                    && !event.keystroke.modifiers.modified()
                    && !composer_focused
                    && !emoji_focused
                    && !search_focused
                {
                    this.focus_search(window, cx);
                    cx.stop_propagation();
                    cx.notify();
                    return;
                }
                if composer_focused && this.mention_popup_visible() {
                    let matches_len = this.mention_matches().len();
                    let key = event.keystroke.key.as_str();
                    let handled = match key {
                        "down" | "up" if matches_len > 0 => {
                            if let Some(picker) = this.mention_picker.as_mut() {
                                picker.highlighted = if key == "down" {
                                    (picker.highlighted + 1) % matches_len
                                } else {
                                    (picker.highlighted + matches_len - 1) % matches_len
                                };
                            }
                            true
                        }
                        "enter" | "tab" if matches_len > 0 => {
                            let index = this
                                .mention_picker
                                .as_ref()
                                .map_or(0, |picker| picker.highlighted.min(matches_len - 1));
                            this.apply_mention(index, window, cx);
                            true
                        }
                        "escape" => {
                            this.mention_picker = None;
                            true
                        }
                        _ => false,
                    };
                    if handled {
                        cx.stop_propagation();
                        cx.notify();
                        return;
                    }
                }
                if search_focused && this.search_query.trim().chars().count() >= 2 {
                    match event.keystroke.key.as_str() {
                        "down" => this.move_search_selection(false),
                        "up" => this.move_search_selection(true),
                        "enter" => this.activate_search_result(window, cx),
                        "escape" => this.clear_search(window, cx),
                        _ => return,
                    }
                    cx.stop_propagation();
                    cx.notify();
                    return;
                }
                if this.chat_info.is_some() && event.keystroke.key == "escape" {
                    this.chat_info = None;
                    cx.stop_propagation();
                    cx.notify();
                    return;
                }
                if this.chat_switcher.is_some() && event.keystroke.key == "escape" {
                    this.cancel_chat_switcher(window, cx);
                    cx.stop_propagation();
                    cx.notify();
                }
            }))
            .child(content)
            .when_some(self.store.toast_error.clone(), |root, error| {
                root.child(
                    div()
                        .absolute()
                        .bottom_4()
                        .right_4()
                        .max_w(px(420.))
                        .p_3()
                        .rounded_lg()
                        .bg(rgb(0x7f1d1d))
                        .text_color(rgb(0xffffff))
                        .child(error),
                )
            })
            .when(self.reaction_details.is_some(), |root| {
                root.child(self.render_reaction_details(cx))
            })
            .when(self.image_viewer.is_some(), |root| {
                root.child(self.render_image_viewer(cx))
            })
            .when(self.settings_open, |root| {
                root.child(self.render_settings(cx))
            })
            .when(self.chat_info.is_some(), |root| {
                root.child(self.render_chat_info(cx))
            })
            .when(self.chat_switcher.is_some(), |root| {
                root.child(self.render_chat_switcher(cx))
            })
    }
}

// Civil-date conversion (Howard Hinnant's algorithm). Renders a UTC date like
// "12 Apr 2024" for the group "created" caption without a date dependency.
/// Collapses every run of whitespace — including the newlines carried by
/// multi-line messages — into single spaces, so a title or preview always
/// renders on one line. `truncate()` only sets `white-space: nowrap`, which
/// leaves hard `\n` breaks intact and would otherwise overflow fixed-height
/// rows and collide with the row below.
fn one_line(text: &str) -> String {
    text.split_whitespace().collect::<Vec<_>>().join(" ")
}

/// Up to two uppercase initials for an avatar, or `None` when the name has no
/// alphabetic characters to draw from (e.g. a bare phone number) — the caller
/// then falls back to a glyph so nothing renders off-centre or truncated.
fn avatar_initials(name: &str) -> Option<String> {
    let words: Vec<&str> = name.split_whitespace().collect();
    let mut initials: String = words
        .iter()
        .filter_map(|word| word.chars().find(|character| character.is_alphabetic()))
        .take(2)
        .collect();
    if initials.chars().count() < 2
        && let Some(word) = words
            .iter()
            .find(|word| word.chars().any(char::is_alphabetic))
    {
        initials = word
            .chars()
            .filter(|character| character.is_alphabetic())
            .take(2)
            .collect();
    }
    (!initials.is_empty()).then(|| initials.to_uppercase())
}

/// Stable hue in the 0..1 range derived from an identity key, so each
/// participant keeps the same colour across their avatar and name label.
fn identity_hue(key: &str) -> f32 {
    (gpui::hash(&key) % 24) as f32 * 15.0 / 360.0
}

/// A round avatar that always centres its content: the cached photo when we
/// have one, otherwise tinted initials, otherwise a person glyph. Replaces the
/// stock component so contactless senders no longer show off-centre initials.
fn avatar_element(name: &str, avatar_path: &str, size: Pixels, cx: &App) -> gpui::Div {
    let base = div()
        .flex_shrink_0()
        .size(size)
        .rounded_full()
        .overflow_hidden()
        .flex()
        .items_center()
        .justify_center();
    if !avatar_path.is_empty() {
        return base.child(
            img(PathBuf::from(avatar_path.to_owned()))
                .size(size)
                .rounded_full()
                .object_fit(ObjectFit::Cover),
        );
    }
    match avatar_initials(name) {
        Some(initials) => {
            let color = cx.theme().blue.hue(identity_hue(name));
            base.bg(color.opacity(0.18))
                .text_color(color)
                .text_size(size * 0.4)
                .line_height(size)
                .font_weight(gpui::FontWeight::SEMIBOLD)
                .child(initials)
        }
        None => base
            .bg(cx.theme().secondary)
            .text_color(cx.theme().muted_foreground)
            .child(
                Icon::new(IconName::User)
                    .with_size(size * 0.55)
                    .text_color(cx.theme().muted_foreground),
            ),
    }
}

fn format_epoch_date(timestamp_ms: i64) -> String {
    const MONTHS: [&str; 12] = [
        "Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
    ];
    let days = timestamp_ms.div_euclid(86_400_000);
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z.rem_euclid(146_097);
    let yoe = (doe - doe / 1_460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let day = doy - (153 * mp + 2) / 5 + 1;
    let month = if mp < 10 { mp + 3 } else { mp - 9 };
    let year = yoe + era * 400 + i64::from(month <= 2);
    format!("{day} {} {year}", MONTHS[(month - 1) as usize])
}

fn format_disappearing_timer(seconds: u32) -> String {
    match seconds {
        0 => "Off".into(),
        86_400 => "24 hours".into(),
        604_800 => "7 days".into(),
        7_776_000 => "90 days".into(),
        s if s % 86_400 == 0 => format!("{} days", s / 86_400),
        s if s % 3_600 == 0 => format!("{} hours", s / 3_600),
        s if s % 60 == 0 => format!("{} minutes", s / 60),
        s => format!("{s} seconds"),
    }
}

fn connection_label(connection: proto::ConnectionState) -> &'static str {
    match connection {
        proto::ConnectionState::Connected => "online",
        proto::ConnectionState::Reconnecting => "reconnecting…",
        proto::ConnectionState::Offline => "offline",
        proto::ConnectionState::Connecting => "connecting…",
        _ => "local client",
    }
}

fn message_status(status: proto::MessageStatus) -> &'static str {
    match status {
        proto::MessageStatus::Pending => "sending",
        proto::MessageStatus::Sent => "sent",
        proto::MessageStatus::Delivered => "delivered",
        proto::MessageStatus::Read => "read",
        proto::MessageStatus::Failed => "failed",
        _ => "",
    }
}

fn message_preview(message: &proto::Message) -> String {
    let flattened = message_text(message)
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ");
    if flattened.is_empty() {
        return "Media message".to_string();
    }
    let mut characters = flattened.chars();
    let preview = characters.by_ref().take(96).collect::<String>();
    if characters.next().is_some() {
        format!("{preview}…")
    } else {
        preview
    }
}

fn qr_canvas(code: QrCode) -> gpui::Div {
    let width = code.width();
    let modules = Rc::new(
        code.into_colors()
            .into_iter()
            .map(|color| color == Color::Dark)
            .collect::<Vec<_>>(),
    );
    div()
        .size(px(240.))
        .p_3()
        .rounded_lg()
        .bg(rgb(0xffffff))
        .child(
            canvas(
                move |bounds, _, _| bounds,
                move |bounds, _, window, _| {
                    let cell = bounds.size.width / width as f32;
                    for row in 0..width {
                        for col in 0..width {
                            if modules[row * width + col] {
                                window.paint_quad(gpui::PaintQuad {
                                    bounds: gpui::Bounds {
                                        origin: bounds.origin
                                            + point(cell * col as f32, cell * row as f32),
                                        size: size(cell, cell),
                                    },
                                    corner_radii: gpui::Corners::default(),
                                    background: rgb(0x111b21).into(),
                                    border_widths: gpui::Edges::default(),
                                    border_color: gpui::transparent_black(),
                                    border_style: gpui::BorderStyle::default(),
                                });
                            }
                        }
                    }
                },
            )
            .size_full(),
        )
}

fn main() {
    gpui_platform::application().with_assets(Assets).run(|cx| {
        gpui_component::init(cx);
        cx.bind_keys([
            KeyBinding::new("ctrl-tab", CycleRecentChat, None),
            KeyBinding::new("ctrl-shift-tab", CycleRecentChatReverse, None),
        ]);
        Theme::change(ThemeMode::Dark, None, cx);
        let options = WindowOptions {
            window_bounds: Some(WindowBounds::centered(size(px(1180.), px(760.)), cx)),
            window_min_size: Some(size(px(480.), px(560.))),
            ..Default::default()
        };
        cx.spawn(async move |cx| {
            cx.open_window(options, |window, cx| {
                let app = cx.new(|cx| RustMeow::new(window, cx));
                // Fallback for when focus is lost or points at an unmounted
                // element: in that state the root div is off the dispatch path
                // and its on_action handlers never run, so also handle the
                // switcher actions globally. When the root handlers do run
                // they stop propagation, which keeps these from firing twice.
                let window_handle = window.window_handle();
                let weak = app.downgrade();
                cx.on_action(move |_: &CycleRecentChat, cx| {
                    RustMeow::cycle_recent_chat_from_global(&weak, window_handle, false, cx);
                });
                let weak = app.downgrade();
                cx.on_action(move |_: &CycleRecentChatReverse, cx| {
                    RustMeow::cycle_recent_chat_from_global(&weak, window_handle, true, cx);
                });
                cx.new(|cx| Root::new(app, window, cx))
            })
            .expect("open Rust Meow window");
        })
        .detach();
    });
}

#[cfg(test)]
mod reaction_details_ui_tests {
    use super::*;

    #[test]
    fn discrete_scroll_accelerates_then_resets_when_direction_changes() {
        let now = Instant::now();
        let mut scroll = SmoothScrollState::default();
        let generation = scroll.push_wheel(-3.0, now).unwrap();
        assert_eq!(scroll.velocity_y, -SMOOTH_SCROLL_IMPULSE);

        assert!(
            scroll
                .push_wheel(-3.0, now + Duration::from_millis(50))
                .is_none()
        );
        assert_eq!(scroll.velocity_y, -2.0 * SMOOTH_SCROLL_IMPULSE);
        let distance = scroll.advance(generation, 0.016).unwrap();
        assert!(distance < 0.0);
        assert!(scroll.velocity_y.abs() < 2.0 * SMOOTH_SCROLL_IMPULSE);

        assert!(
            scroll
                .push_wheel(3.0, now + Duration::from_millis(100))
                .is_none()
        );
        assert_eq!(scroll.velocity_y, SMOOTH_SCROLL_IMPULSE);
    }

    #[test]
    fn stopping_scroll_invalidates_the_running_animation() {
        let mut scroll = SmoothScrollState::default();
        let generation = scroll.push_wheel(3.0, Instant::now()).unwrap();
        scroll.finish();
        assert!(scroll.advance(generation, 0.016).is_none());
        assert!(!scroll.running);
    }

    #[test]
    fn url_tokens_keep_sentence_punctuation_outside_the_target() {
        assert_eq!(
            split_url_token("(https://example.com/docs?q=meow)."),
            Some(("(", "https://example.com/docs?q=meow", ")."))
        );
        assert_eq!(
            split_url_token("see:https://example.com"),
            Some(("see:", "https://example.com", ""))
        );
        assert!(split_url_token("javascript:alert(1)").is_none());
        assert!(split_url_token("https://").is_none());
    }

    #[test]
    fn group_typing_summary_names_multiple_active_people() {
        let now = Instant::now();
        let indicators = HashMap::from([
            (
                "alice".into(),
                TypingIndicator {
                    sender_name: "Alice".into(),
                    recording: false,
                    expires_at: now + Duration::from_secs(5),
                },
            ),
            (
                "bob".into(),
                TypingIndicator {
                    sender_name: "Bob".into(),
                    recording: false,
                    expires_at: now + Duration::from_secs(5),
                },
            ),
            (
                "expired".into(),
                TypingIndicator {
                    sender_name: "Old".into(),
                    recording: false,
                    expires_at: now - Duration::from_secs(1),
                },
            ),
        ]);
        assert_eq!(
            format_typing_label(&indicators, true, now).as_deref(),
            Some("Alice and Bob are typing…")
        );
    }

    #[test]
    fn search_results_keep_contacts_groups_and_messages_in_priority_order() {
        let results = SearchResults {
            contacts: vec![proto::ContactSearchResult {
                contact_jid: "alice@s.whatsapp.net".into(),
                ..Default::default()
            }],
            groups: vec![proto::Chat {
                id: "group".into(),
                ..Default::default()
            }],
            messages: vec![proto::MessageSearchResult {
                chat_id: "chat".into(),
                message_id: "message".into(),
                ..Default::default()
            }],
        };
        assert!(matches!(results.target(0), Some(SearchTarget::Contact(_))));
        assert!(matches!(results.target(1), Some(SearchTarget::Group(_))));
        assert!(matches!(
            results.target(2),
            Some(SearchTarget::Message { .. })
        ));
        assert!(results.target(3).is_none());
        let rows = results.rows();
        assert_eq!(rows.len(), 6);
        assert!(matches!(
            rows[0],
            SearchResultRow::Header {
                title: "Contacts",
                ..
            }
        ));
        assert!(matches!(
            rows[1],
            SearchResultRow::Contact {
                result_index: 0,
                ..
            }
        ));
        assert!(matches!(
            rows[2],
            SearchResultRow::Header {
                title: "Groups",
                ..
            }
        ));
        assert!(matches!(
            rows[3],
            SearchResultRow::Group {
                result_index: 1,
                ..
            }
        ));
        assert!(matches!(
            rows[4],
            SearchResultRow::Header {
                title: "Messages",
                ..
            }
        ));
        assert!(matches!(
            rows[5],
            SearchResultRow::Message {
                result_index: 2,
                ..
            }
        ));
        assert_eq!(results.row_index_for_result(0), Some(1));
        assert_eq!(results.row_index_for_result(1), Some(3));
        assert_eq!(results.row_index_for_result(2), Some(5));
        assert_eq!(results.row_index_for_result(3), None);
    }

    #[test]
    fn virtual_search_row_mapping_skips_empty_sections() {
        let results = SearchResults {
            groups: vec![proto::Chat::default(), proto::Chat::default()],
            ..Default::default()
        };
        assert_eq!(results.rows().len(), 3);
        assert_eq!(results.row_index_for_result(0), Some(1));
        assert_eq!(results.row_index_for_result(1), Some(2));
    }

    #[test]
    fn inspector_state_is_scoped_to_exact_message_and_emoji() {
        let message = proto::Message {
            id: "message".into(),
            chat_id: "chat".into(),
            reactions: vec![
                proto::Reaction {
                    emoji: "👍".into(),
                    sender_id: "friend".into(),
                    ..Default::default()
                },
                proto::Reaction {
                    emoji: "❤️".into(),
                    sender_id: "other".into(),
                    ..Default::default()
                },
            ],
            ..Default::default()
        };
        let details = ReactionDetails::new("chat".into(), &message, "👍".into()).unwrap();
        assert_eq!(details.chat_id, "chat");
        assert_eq!(details.message_id, "message");
        assert_eq!(details.emoji, "👍");
        assert_eq!(details.reactions.len(), 1);
        assert_eq!(details.reactions[0].sender_id, "friend");
        assert!(ReactionDetails::new("chat".into(), &message, "😂".into()).is_none());
    }

    #[test]
    fn stickers_are_sized_smaller_without_distorting_their_aspect_ratio() {
        let sticker = proto::ImageContent {
            width: 512,
            height: 256,
            sticker: true,
            ..Default::default()
        };
        assert_eq!(image_render_size(&sticker), (px(220.), px(110.)));
    }

    #[test]
    fn one_line_flattens_newlines_and_collapses_whitespace() {
        assert_eq!(
            one_line("Paid using Google Pay! ✅\nCrores of Indians trust"),
            "Paid using Google Pay! ✅ Crores of Indians trust"
        );
        assert_eq!(one_line("  spaced   out \t line  "), "spaced out line");
        assert_eq!(one_line("single"), "single");
    }

    #[test]
    fn avatar_initials_prefer_word_boundaries_and_skip_number_only_names() {
        assert_eq!(avatar_initials("Jason Lee").as_deref(), Some("JL"));
        assert_eq!(avatar_initials("diya").as_deref(), Some("DI"));
        assert_eq!(avatar_initials("  ashman  ").as_deref(), Some("AS"));
        assert_eq!(avatar_initials("+91 93104 78203"), None);
        assert_eq!(avatar_initials(""), None);
    }

    #[test]
    fn outgoing_text_validation_rejects_blank_and_oversized_messages() {
        assert_eq!(
            validate_text_message("   ").unwrap_err(),
            "Type a message before sending"
        );
        assert!(validate_text_message(&"a".repeat(MAX_TEXT_BYTES)).is_ok());
        assert!(validate_text_message(&"a".repeat(MAX_TEXT_BYTES + 1)).is_err());
    }

    #[test]
    fn outgoing_image_validation_checks_type_size_and_caption() {
        let directory = tempfile::tempdir().unwrap();
        let png = directory.path().join("photo.bin");
        fs::write(&png, [0x89, b'P', b'N', b'G', 0x0d, 0x0a, 0x1a, 0x0a]).unwrap();
        assert!(validate_image_message(&png, "caption").is_ok());

        let unsupported = directory.path().join("not-image.bin");
        fs::write(&unsupported, b"plain text").unwrap();
        assert!(validate_image_message(&unsupported, "").is_err());
        assert!(validate_image_message(&png, &"a".repeat(MAX_CAPTION_BYTES + 1)).is_err());
    }

    #[test]
    fn ui_scale_is_clamped_and_rounded_to_settings_steps() {
        assert_eq!(normalized_ui_scale(0.5), MIN_UI_SCALE);
        assert_eq!(normalized_ui_scale(1.26), 1.3);
        assert_eq!(normalized_ui_scale(9.0), MAX_UI_SCALE);
    }

    #[test]
    fn recent_chat_history_is_deduplicated_newest_first_and_bounded() {
        let mut history = Vec::new();
        for index in 0..12 {
            record_recent_chat(&mut history, &format!("chat-{index}"));
        }
        assert_eq!(history.len(), MAX_RECENT_CHATS);
        assert_eq!(history.first().map(String::as_str), Some("chat-11"));
        assert_eq!(history.last().map(String::as_str), Some("chat-2"));

        record_recent_chat(&mut history, "chat-5");
        assert_eq!(history.first().map(String::as_str), Some("chat-5"));
        assert_eq!(history.iter().filter(|id| *id == "chat-5").count(), 1);
    }

    #[test]
    fn recent_chat_switcher_cycles_in_both_directions_and_wraps() {
        let ids: Vec<String> = vec!["active".into(), "previous".into(), "older".into()];
        let mut forward = ChatSwitcher::new(ids.clone(), false, true).unwrap();
        assert_eq!(forward.selected_chat_id(), Some("previous"));
        forward.cycle(false);
        assert_eq!(forward.selected_chat_id(), Some("older"));
        forward.cycle(false);
        assert_eq!(forward.selected_chat_id(), Some("active"));

        let mut reverse = ChatSwitcher::new(ids.clone(), true, true).unwrap();
        assert_eq!(reverse.selected_chat_id(), Some("older"));
        reverse.cycle(true);
        assert_eq!(reverse.selected_chat_id(), Some("previous"));
        assert!(ChatSwitcher::new(vec!["only".into()], false, true).is_none());

        // Without an active chat at the front, the most recent candidate is
        // the immediate target and a single candidate is enough.
        let no_selection = ChatSwitcher::new(ids, false, false).unwrap();
        assert_eq!(no_selection.selected_chat_id(), Some("active"));
        let single = ChatSwitcher::new(vec!["only".into()], false, false).unwrap();
        assert_eq!(single.selected_chat_id(), Some("only"));
    }

    #[test]
    fn chat_info_dates_and_timers_render_human_readable_values() {
        assert_eq!(format_epoch_date(0), "1 Jan 1970");
        assert_eq!(format_epoch_date(1_000_000_000_000), "9 Sep 2001");
        assert_eq!(format_epoch_date(1_712_345_678_000), "5 Apr 2024");

        assert_eq!(format_disappearing_timer(0), "Off");
        assert_eq!(format_disappearing_timer(86_400), "24 hours");
        assert_eq!(format_disappearing_timer(604_800), "7 days");
        assert_eq!(format_disappearing_timer(7_776_000), "90 days");
        assert_eq!(format_disappearing_timer(3 * 86_400), "3 days");
        assert_eq!(format_disappearing_timer(2 * 3_600), "2 hours");
        assert_eq!(format_disappearing_timer(90), "90 seconds");
    }

    #[test]
    fn mention_token_start_detects_in_progress_tags() {
        assert_eq!(mention_token_start("@", 1), Some(0));
        assert_eq!(mention_token_start("hi @al", 6), Some(3));
        assert_eq!(mention_token_start("hi @al ", 7), None); // token closed by space
        assert_eq!(mention_token_start("email@host", 10), None); // mid-word @
        assert_eq!(mention_token_start("no tag here", 11), None);
        assert_eq!(
            mention_token_start("héllo @ñam", "héllo @ñam".len()),
            Some(7)
        );
    }

    #[test]
    fn encode_mentions_rewrites_tokens_and_drops_deleted_tags() {
        let mentions = vec![
            MentionEntry {
                display_name: "Ann".into(),
                jid: "15550001111@s.whatsapp.net".into(),
            },
            MentionEntry {
                display_name: "Anna Lee".into(),
                jid: "203635027103105@lid".into(),
            },
            MentionEntry {
                display_name: "Deleted".into(),
                jid: "15552223333@s.whatsapp.net".into(),
            },
        ];
        let (wire, jids) = encode_mentions("hey @Anna Lee and @Ann!", &mentions);
        assert_eq!(wire, "hey @203635027103105 and @15550001111!");
        assert_eq!(
            jids,
            vec![
                "203635027103105@lid".to_string(),
                "15550001111@s.whatsapp.net".to_string()
            ]
        );
    }

    #[test]
    fn chat_id_merges_keep_history_and_active_draft() {
        let mut history = vec!["new".into(), "old".into(), "other".into()];
        remap_recent_chat_ids(&mut history, "old", "new");
        assert_eq!(history, vec!["new", "other"]);

        let mut drafts = HashMap::from([
            (
                "old".into(),
                ChatDraft {
                    text: "active text".into(),
                    reply_to_message_id: Some("message".into()),
                    mentions: Vec::new(),
                },
            ),
            (
                "new".into(),
                ChatDraft {
                    text: "stale destination".into(),
                    reply_to_message_id: None,
                    mentions: Vec::new(),
                },
            ),
        ]);
        remap_chat_draft(&mut drafts, "old", "new", true);
        assert_eq!(drafts.len(), 1);
        assert_eq!(drafts["new"].text, "active text");
        assert_eq!(
            drafts["new"].reply_to_message_id.as_deref(),
            Some("message")
        );
    }
}
