import { createEffect, createMemo, createSignal, For, Show, type JSX } from "solid-js";
import {
  FileAudio,
  FileImage,
  FileText,
  FileVideo,
  Paperclip,
  Send,
  Smile,
  Sticker,
  X,
} from "lucide-solid";
import type { AppModel } from "../state/app";
import { openFile } from "../lib/bridge";
import { AttachmentKind, ChatKind, ConnectionState, type ChatParticipant } from "../lib/types";
import { messageText } from "../lib/format";
import { IconButton } from "./Primitives";

const EMOJI = Array.from(
  "😀 😃 😄 😁 😆 😅 😂 🤣 😊 😇 🙂 🙃 😉 😌 😍 🥰 😘 😗 😙 😚 😋 😛 😝 😜 🤪 🤨 🧐 🤓 😎 🤩 🥳 😏 😒 😞 😔 😟 😕 🙁 ☹️ 😣 😖 😫 😩 🥺 😢 😭 😤 😠 😡 🤬 🤯 😳 🥵 🥶 😱 😨 😰 😥 😓 🤗 🤔 🫣 🤭 🤫 🤥 😶 🫥 😐 🫤 😑 😬 🙄 😯 😦 😧 😮 😲 🥱 😴 🤤 😪 😵 🤐 🥴 🤢 🤮 🤧 😷 🤒 🤕 🤑 🤠 😈 👿 👹 👺 🤡 💩 👻 💀 ☠️ 👽 🤖 🎃 😺 😸 😹 😻 😼 😽 🙀 😿 😾 👋 🤚 🖐️ ✋ 🖖 🫱 🫲 🫳 🫴 👌 🤌 🤏 ✌️ 🤞 🫰 🤟 🤘 🤙 👈 👉 👆 👇 ☝️ 👍 👎 ✊ 👊 🤛 🤜 👏 🙌 🫶 👐 🤲 🤝 🙏 ✍️ 💅 🤳 💪 🦾 🦿 🦵 🦶 👂 👃 🧠 🫀 🫁 🦷 👀 👁️ 👅 👄 🫦 ❤️ 🧡 💛 💚 💙 💜 🖤 🤍 🤎 💔 ❤️‍🔥 ❤️‍🩹 ❣️ 💕 💞 💓 💗 💖 💘 💝 💟 💯 💢 💥 💫 💦 💨 🕳️ 💣 💬 👁️‍🗨️ 🗨️ 🗯️ 💭 💤 🎉 🎊 ✨ ⭐ 🌟 🔥 🌈 ☀️ 🌙 ⚡ ❄️ ☕ 🍕 🍔 🍟 🌮 🍿 🎂 🍰 🍺 🍻 🥂 ⚽ 🏀 🏈 ⚾ 🎾 🏐 🎮 🎧 🎵 🎶 🚗 ✈️ 🚀 🏠 📱 💻 ⌚ 📷 💡 🎁 ✅ ❌ ⚠️ ❓ ❗".split(" ").filter(Boolean),
);

export function Composer(props: { model: AppModel }) {
  const { state, actions } = props.model;
  const [emojiOpen, setEmojiOpen] = createSignal(false);
  const [attachmentOpen, setAttachmentOpen] = createSignal(false);
  const [emojiQuery, setEmojiQuery] = createSignal("");
  const [mentionRange, setMentionRange] = createSignal<{ start: number; end: number; query: string } | null>(null);
  const [mentionIndex, setMentionIndex] = createSignal(0);
  let textarea: HTMLTextAreaElement | undefined;

  const draft = () => actions.activeDraft();
  const reply = () => state.messages.find((message) => message.id === draft().replyToMessageId);
  const connected = () => state.connection === ConnectionState.Connected;
  const selectedChat = () => actions.selectedChat();
  const mentionMatches = createMemo(() => {
    const range = mentionRange();
    if (!range || selectedChat()?.kind !== ChatKind.Group) return [];
    const query = range.query.toLocaleLowerCase();
    return (state.chatInfo?.participants ?? [])
      .filter((participant) => !participant.isMe)
      .filter((participant) =>
        `${participant.displayName} ${participant.phoneNumber}`.toLocaleLowerCase().includes(query),
      )
      .slice(0, 8);
  });
  const filteredEmoji = createMemo(() => {
    const query = emojiQuery().trim();
    return query ? EMOJI.filter((emoji) => emoji.includes(query)) : EMOJI;
  });

  createEffect(() => {
    const chatId = state.selectedChatId;
    const replyId = draft().replyToMessageId;
    if (chatId || replyId) requestAnimationFrame(() => textarea?.focus());
  });

  return (
    <div class="composer-wrap">
      <Show when={reply()}>
        {(message) => (
          <div class="reply-composer">
            <div class="reply-composer-card">
              <strong>{message().fromMe ? "You" : message().senderName || selectedChat()?.title}</strong>
              <span>{messageText(message())}</span>
            </div>
            <IconButton label="Cancel reply" onClick={actions.cancelReply}><X size={18} /></IconButton>
          </div>
        )}
      </Show>

      <form
        class="composer"
        onSubmit={(event) => {
          event.preventDefault();
          void actions.sendCurrentText();
        }}
      >
        <IconButton
          label="Emoji"
          active={emojiOpen()}
          disabled={!connected()}
          onClick={() => {
            setEmojiOpen((open) => !open);
            setAttachmentOpen(false);
          }}
        >
          <Smile size={22} />
        </IconButton>
        <IconButton
          label="Attach"
          active={attachmentOpen()}
          disabled={!connected()}
          onClick={() => {
            setAttachmentOpen((open) => !open);
            setEmojiOpen(false);
          }}
        >
          <Paperclip size={22} />
        </IconButton>

        <div class="composer-input-wrap">
          <textarea
            ref={textarea}
            class="composer-input"
            rows={1}
            value={draft().text}
            disabled={!connected()}
            placeholder={connected() ? "Type a message" : "Waiting for connection…"}
            aria-label="Message"
            onInput={(event) => {
              actions.setDraftText(event.currentTarget.value);
              resizeTextarea(event.currentTarget);
              updateMention(event.currentTarget);
            }}
            onBlur={() => actions.stopTyping()}
            onKeyDown={(event) => {
              if (mentionMatches().length > 0) {
                if (event.key === "ArrowDown" || event.key === "ArrowUp") {
                  const direction = event.key === "ArrowDown" ? 1 : -1;
                  setMentionIndex((index) =>
                    (index + direction + mentionMatches().length) % mentionMatches().length,
                  );
                  event.preventDefault();
                  return;
                }
                if (event.key === "Tab" || event.key === "Enter") {
                  const participant = mentionMatches()[mentionIndex()];
                  if (participant) selectMention(participant);
                  event.preventDefault();
                  return;
                }
                if (event.key === "Escape") {
                  setMentionRange(null);
                  event.preventDefault();
                  return;
                }
              }
              if (event.key === "Enter" && !event.shiftKey) {
                event.preventDefault();
                void actions.sendCurrentText();
              }
            }}
          />
        </div>

        <IconButton
          type="submit"
          label="Send"
          class="send-button"
          disabled={!connected() || state.sending || !draft().text.trim()}
        >
          <Send size={20} />
        </IconButton>

        <Show when={mentionRange() && mentionMatches().length > 0}>
          <div class="popover mention-picker" role="listbox" aria-label="Mention a group member">
            <For each={mentionMatches()}>
              {(participant, index) => (
                <button
                  type="button"
                  class={`mention-row ${index() === mentionIndex() ? "active" : ""}`}
                  role="option"
                  aria-selected={index() === mentionIndex()}
                  onMouseDown={(event) => event.preventDefault()}
                  onClick={() => selectMention(participant)}
                >
                  <span class="avatar" style={{ width: "32px", height: "32px", "min-width": "32px", "--avatar-hue": "160" }}>
                    {(participant.displayName || participant.phoneNumber).slice(0, 1).toUpperCase()}
                  </span>
                  <span class="search-result-copy">
                    <strong>{participant.displayName || participant.phoneNumber}</strong>
                    <span>{participant.phoneNumber}</span>
                  </span>
                </button>
              )}
            </For>
          </div>
        </Show>

        <Show when={emojiOpen()}>
          <div class="popover emoji-picker">
            <div class="emoji-picker-header">
              <label class="search-field">
                <Smile size={16} />
                <input
                  value={emojiQuery()}
                  placeholder="Search emoji"
                  aria-label="Search emoji"
                  onInput={(event) => setEmojiQuery(event.currentTarget.value)}
                />
              </label>
            </div>
            <div class="emoji-grid">
              <For each={filteredEmoji()}>
                {(emoji) => (
                  <button
                    type="button"
                    class="emoji-button"
                    onClick={() => insertEmoji(emoji)}
                  >
                    {emoji}
                  </button>
                )}
              </For>
            </div>
          </div>
        </Show>

        <Show when={attachmentOpen()}>
          <div class="popover attachment-menu">
            <MenuItem icon={<FileImage size={20} />} label="Photos" onClick={() => void chooseImage()} />
            <MenuItem icon={<Sticker size={20} />} label="Create sticker" onClick={() => void chooseSticker()} />
            <MenuItem icon={<FileText size={20} />} label="Document" onClick={() => void chooseAttachment(AttachmentKind.Document)} />
            <MenuItem icon={<FileVideo size={20} />} label="Video" onClick={() => void chooseAttachment(AttachmentKind.Video)} />
            <MenuItem icon={<FileAudio size={20} />} label="Audio" onClick={() => void chooseAttachment(AttachmentKind.Audio)} />
          </div>
        </Show>
      </form>
    </div>
  );

  function updateMention(element: HTMLTextAreaElement) {
    if (selectedChat()?.kind !== ChatKind.Group) {
      setMentionRange(null);
      return;
    }
    const cursor = element.selectionStart ?? element.value.length;
    const prefix = element.value.slice(0, cursor);
    const match = /(?:^|\s)@([^\s@]*)$/u.exec(prefix);
    if (!match) {
      setMentionRange(null);
      return;
    }
    const at = prefix.lastIndexOf("@");
    setMentionRange({ start: at, end: cursor, query: match[1] ?? "" });
    setMentionIndex(0);
    void actions.ensureMentionDirectory();
  }

  function selectMention(participant: ChatParticipant) {
    const range = mentionRange();
    if (!range) return;
    actions.addMention(participant, range.start, range.end);
    setMentionRange(null);
    queueMicrotask(() => {
      if (!textarea) return;
      textarea.focus();
      textarea.selectionStart = textarea.selectionEnd = actions.activeDraft().text.length;
      resizeTextarea(textarea);
    });
  }

  function insertEmoji(emoji: string) {
    const element = textarea;
    const draftText = draft().text;
    const start = element?.selectionStart ?? draftText.length;
    const end = element?.selectionEnd ?? start;
    actions.setDraftText(`${draftText.slice(0, start)}${emoji}${draftText.slice(end)}`);
    queueMicrotask(() => {
      if (!textarea) return;
      textarea.focus();
      textarea.selectionStart = textarea.selectionEnd = start + emoji.length;
      resizeTextarea(textarea);
    });
  }

  async function chooseImage() {
    setAttachmentOpen(false);
    const path = await openFile({
      multiple: false,
      directory: false,
      title: "Choose a photo",
      filters: [{ name: "Images", extensions: ["jpg", "jpeg", "png", "gif", "webp"] }],
    });
    if (typeof path === "string") await actions.sendImage(path);
  }

  async function chooseSticker() {
    setAttachmentOpen(false);
    const path = await openFile({
      multiple: false,
      directory: false,
      title: "Choose an image to turn into a sticker",
      filters: [{ name: "Images", extensions: ["jpg", "jpeg", "png", "gif", "webp"] }],
    });
    if (typeof path === "string") await actions.sendSticker(path);
  }

  async function chooseAttachment(kind: number) {
    setAttachmentOpen(false);
    const filters =
      kind === AttachmentKind.Video
        ? [{ name: "Videos", extensions: ["mp4", "mkv", "mov", "webm"] }]
        : kind === AttachmentKind.Audio
          ? [{ name: "Audio", extensions: ["ogg", "opus", "mp3", "m4a", "wav", "aac"] }]
          : undefined;
    const path = await openFile({
      multiple: false,
      directory: false,
      title: kind === AttachmentKind.Document ? "Choose a document" : kind === AttachmentKind.Video ? "Choose a video" : "Choose audio",
      filters,
    });
    if (typeof path === "string") await actions.sendAttachment(path, kind as 1 | 2 | 3);
  }
}

function MenuItem(props: { icon: JSX.Element; label: string; onClick: () => void }) {
  return (
    <button type="button" class="popover-menu-item" onClick={props.onClick}>
      {props.icon}
      <span>{props.label}</span>
    </button>
  );
}

function resizeTextarea(element: HTMLTextAreaElement) {
  element.style.height = "auto";
  element.style.height = `${Math.min(element.scrollHeight, 140)}px`;
}
