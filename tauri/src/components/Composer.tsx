import { createEffect, createMemo, createSignal, For, onCleanup, onMount, Show, type JSX } from "solid-js";
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
  ListChecks,
} from "lucide-solid";
import type { AppModel } from "../state/app";
import { openFile } from "../lib/bridge";
import { AttachmentKind, ChatKind, ConnectionState, type ChatParticipant } from "../lib/types";
import { messageText } from "../lib/format";
import { IconButton } from "./Primitives";
import { EmojiPicker } from "./EmojiPicker";
import { StickerTray } from "./StickerTray";

type PopoverKind = "emoji" | "sticker" | "attachment" | "poll" | null;

export function Composer(props: { model: AppModel; chatId: string }) {
  const { state, actions } = props.model;
  const [openPopover, setOpenPopover] = createSignal<PopoverKind>(null);
  const [mentionRange, setMentionRange] = createSignal<{ start: number; end: number; query: string } | null>(null);
  const [mentionIndex, setMentionIndex] = createSignal(0);
  const [pollQuestion, setPollQuestion] = createSignal("");
  const [pollOptions, setPollOptions] = createSignal("Yes\nNo");
  const [pollMultiple, setPollMultiple] = createSignal(false);
  let textarea: HTMLTextAreaElement | undefined;
  let root: HTMLDivElement | undefined;

  // Every read below is scoped to props.chatId, never to the globally
  // selected chat — this composer may live in a pane that is not focused,
  // and must never read or write another chat's draft/reply/mentions.
  const draft = () => actions.activeDraft(props.chatId);
  const conversation = () => actions.conversation(props.chatId);
  const reply = () => conversation().messages.find((message) => message.id === draft().replyToMessageId);
  const chat = () => state.chats.find((candidate) => candidate.id === props.chatId);
  const connected = () => state.connection === ConnectionState.Connected;
  const togglePopover = (kind: Exclude<PopoverKind, null>) => setOpenPopover((open) => open === kind ? null : kind);
  // The mention directory (`state.chatInfo`) is a single global slot keyed
  // by whichever chat is currently focused (see `ensureMentionDirectory` in
  // state/app.ts, which always targets `state.selectedChatId`). A composer
  // in a background pane has no way to populate its own directory, so gate
  // suggestions on this pane actually being the focused one to avoid ever
  // showing a different chat's participants here.
  const isFocusedChat = () => state.selectedChatId === props.chatId;
  const mentionMatches = createMemo(() => {
    const range = mentionRange();
    if (!range || !isFocusedChat() || chat()?.kind !== ChatKind.Group) return [];
    const query = range.query.toLocaleLowerCase();
    return (state.chatInfo?.participants ?? [])
      .filter((participant) => !participant.isMe)
      .filter((participant) =>
        `${participant.displayName} ${participant.phoneNumber}`.toLocaleLowerCase().includes(query),
      )
      .slice(0, 8);
  });

  createEffect(() => {
    // Only steal focus into this composer when its chat is the focused
    // one — otherwise a reply/selection change in another pane would yank
    // keyboard focus away from whatever the user is actually looking at.
    const focused = isFocusedChat();
    const replyId = draft().replyToMessageId;
    if (focused && (props.chatId || replyId)) requestAnimationFrame(() => textarea?.focus());
  });

  onMount(() => {
    const onPointerDown = (event: PointerEvent) => {
      if (openPopover() === null) return;
      const target = event.target;
      if (root && target instanceof Node && root.contains(target)) return;
      setOpenPopover(null);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape" && openPopover() !== null) setOpenPopover(null);
    };
    document.addEventListener("pointerdown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    onCleanup(() => {
      document.removeEventListener("pointerdown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    });
  });

  return (
    <div class="composer-wrap" ref={root}>
      <Show when={reply()}>
        {(message) => (
          <div class="reply-composer">
            <div class="reply-composer-card">
              <strong>{message().fromMe ? "You" : message().senderName || chat()?.title}</strong>
              <span>{messageText(message())}</span>
            </div>
            <IconButton label="Cancel reply" onClick={() => actions.cancelReply(props.chatId)}><X size={18} /></IconButton>
          </div>
        )}
      </Show>

      <form
        class="composer"
        onSubmit={(event) => {
          event.preventDefault();
          void actions.sendCurrentText(props.chatId);
        }}
      >
        <IconButton
          label="Emoji"
          active={openPopover() === "emoji"}
          disabled={!connected()}
          onClick={() => togglePopover("emoji")}
        >
          <Smile size={22} />
        </IconButton>
        <IconButton
          label="Stickers"
          active={openPopover() === "sticker"}
          disabled={!connected()}
          onClick={() => togglePopover("sticker")}
        >
          <Sticker size={22} />
        </IconButton>
        <IconButton
          label="Attach"
          active={openPopover() === "attachment"}
          disabled={!connected()}
          onClick={() => togglePopover("attachment")}
        >
          <Paperclip size={22} />
        </IconButton>
        <IconButton label="Create poll" active={openPopover() === "poll"} disabled={!connected()} onClick={() => togglePopover("poll")}>
          <ListChecks size={22} />
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
              actions.setDraftText(event.currentTarget.value, props.chatId);
              resizeTextarea(event.currentTarget);
              updateMention(event.currentTarget);
            }}
            onBlur={() => actions.stopTyping()}
            onKeyDown={(event) => {
              // Mention autocomplete always wins, regardless of enterToSend.
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
              if (event.key !== "Enter") return;
              const enterToSend = props.model.preferences.enterToSend;
              if (enterToSend) {
                // Enter sends, Shift+Enter inserts a newline (default textarea behaviour).
                if (event.shiftKey) return;
                event.preventDefault();
                void actions.sendCurrentText(props.chatId);
              } else {
                // Plain Enter inserts a newline (default); Ctrl/Cmd+Enter sends.
                if (!event.ctrlKey && !event.metaKey) return;
                event.preventDefault();
                void actions.sendCurrentText(props.chatId);
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

        <Show when={openPopover() === "emoji"}>
          <EmojiPicker onPick={insertEmoji} />
        </Show>

        <Show when={openPopover() === "sticker"}>
          <div class="popover sticker-tray">
            <StickerTray model={props.model} chatId={props.chatId} onSent={() => setOpenPopover(null)} />
          </div>
        </Show>

        <Show when={openPopover() === "attachment"}>
          <div class="popover attachment-menu">
            <MenuItem icon={<FileImage size={20} />} label="Photos" onClick={() => void chooseImage()} />
            <MenuItem icon={<Sticker size={20} />} label="Create sticker" onClick={() => void chooseSticker()} />
            <MenuItem icon={<FileText size={20} />} label="Document" onClick={() => void chooseAttachment(AttachmentKind.Document)} />
            <MenuItem icon={<FileVideo size={20} />} label="Video" onClick={() => void chooseAttachment(AttachmentKind.Video)} />
            <MenuItem icon={<FileAudio size={20} />} label="Audio" onClick={() => void chooseAttachment(AttachmentKind.Audio)} />
          </div>
        </Show>
        <Show when={openPopover() === "poll"}>
          <div class="popover poll-composer" role="dialog" aria-label="Create poll">
            <strong>Create a poll</strong>
            <input value={pollQuestion()} onInput={(event) => setPollQuestion(event.currentTarget.value)} placeholder="Question" aria-label="Poll question" />
            <textarea value={pollOptions()} onInput={(event) => setPollOptions(event.currentTarget.value)} rows={5} aria-label="Poll options, one per line" />
            <label><input type="checkbox" checked={pollMultiple()} onChange={(event) => setPollMultiple(event.currentTarget.checked)} /> Allow multiple answers</label>
            <button type="button" class="primary-button" disabled={!pollQuestion().trim() || pollOptions().split("\n").filter((value) => value.trim()).length < 2} onClick={() => {
              const options = [...new Set(pollOptions().split("\n").map((value) => value.trim()).filter(Boolean))];
              void actions.createPoll(pollQuestion().trim(), options, pollMultiple() ? options.length : 1, props.chatId);
              setOpenPopover(null); setPollQuestion(""); setPollOptions("Yes\nNo"); setPollMultiple(false);
            }}>Create poll</button>
          </div>
        </Show>
      </form>
    </div>
  );

  function updateMention(element: HTMLTextAreaElement) {
    if (chat()?.kind !== ChatKind.Group) {
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
    actions.addMention(participant, range.start, range.end, props.chatId);
    setMentionRange(null);
    queueMicrotask(() => {
      if (!textarea) return;
      textarea.focus();
      textarea.selectionStart = textarea.selectionEnd = actions.activeDraft(props.chatId).text.length;
      resizeTextarea(textarea);
    });
  }

  function insertEmoji(emoji: string) {
    const element = textarea;
    const draftText = draft().text;
    const start = element?.selectionStart ?? draftText.length;
    const end = element?.selectionEnd ?? start;
    actions.setDraftText(`${draftText.slice(0, start)}${emoji}${draftText.slice(end)}`, props.chatId);
    queueMicrotask(() => {
      if (!textarea) return;
      textarea.focus();
      textarea.selectionStart = textarea.selectionEnd = start + emoji.length;
      resizeTextarea(textarea);
    });
  }

  async function chooseImage() {
    await chooseVisual("Choose a photo", (path) => actions.sendImage(path, props.chatId));
  }

  async function chooseSticker() {
    await chooseVisual("Choose an image to turn into a sticker", (path) => actions.sendSticker(path, props.chatId));
  }

  async function chooseVisual(title: string, send: (path: string) => Promise<void>) {
    setOpenPopover(null);
    const path = await openFile({
      multiple: false,
      directory: false,
      title,
      filters: [{ name: "Images", extensions: ["jpg", "jpeg", "png", "gif", "webp"] }],
    });
    if (typeof path === "string") await send(path);
  }

  async function chooseAttachment(kind: number) {
    setOpenPopover(null);
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
    if (typeof path === "string") await actions.sendAttachment(path, kind as 1 | 2 | 3, false, props.chatId);
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
