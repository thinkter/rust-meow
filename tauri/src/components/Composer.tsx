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
import { discardStagedImage, normalizeBridgeError, openFile, readClipboardText, stageClipboardImage } from "../lib/bridge";
import { applyEmojiSuggestion, getEmojiAutocomplete } from "../lib/emoji-autocomplete";
import { AttachmentKind, ChatKind, ConnectionState, type ChatParticipant } from "../lib/types";
import { messageText } from "../lib/format";
import { IconButton } from "./Primitives";
import { EMOJI_ENTRIES, EmojiPicker } from "./EmojiPicker";
import { StickerTray } from "./StickerTray";
import { ThemeIcon } from "./ThemeIcon";

type PopoverKind = "emoji" | "sticker" | "attachment" | "poll" | null;

export function Composer(props: { model: AppModel; chatId: string }) {
  const { state, actions } = props.model;
  const [openPopover, setOpenPopover] = createSignal<PopoverKind>(null);
  const [mentionRange, setMentionRange] = createSignal<{ start: number; end: number; query: string } | null>(null);
  const [mentionIndex, setMentionIndex] = createSignal(0);
  const [composerCaret, setComposerCaret] = createSignal(0);
  const [emojiIndex, setEmojiIndex] = createSignal(0);
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
  const replySourceChatId = () => draft().replyToChatId || props.chatId;
  const reply = () =>
    state.conversations[replySourceChatId()]?.messages.find(
      (message) => message.id === draft().replyToMessageId,
    );
  const privateReply = () =>
    Boolean(draft().replyToMessageId) && replySourceChatId() !== props.chatId;
  const editing = () => conversation().messages.find((message) => message.id === draft().editingMessageId);
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
  const emojiAutocomplete = createMemo(() =>
    getEmojiAutocomplete(draft().text, composerCaret(), EMOJI_ENTRIES),
  );
  const emojiSuggestions = () => emojiAutocomplete()?.suggestions ?? [];

  createEffect(() => {
    const autocomplete = emojiAutocomplete();
    // Reset selection whenever the active token/query changes.
    autocomplete?.match.token;
    autocomplete?.match.query;
    setEmojiIndex(0);
  });

  createEffect(() => {
    // Only steal focus into this composer when its chat is the focused
    // one — otherwise a reply/selection change in another pane would yank
    // keyboard focus away from whatever the user is actually looking at.
    const focused = isFocusedChat();
    const replyId = draft().replyToMessageId;
    const editingId = draft().editingMessageId;
    if (focused && (props.chatId || replyId || editingId)) requestAnimationFrame(() => textarea?.focus());
  });

  createEffect(() => {
    // Input events resize while typing, but sends, edits, chat switches, and
    // restored drafts change the controlled value programmatically. Track the
    // draft so clearing a long message also collapses the textarea immediately.
    draft().text;
    if (textarea) resizeTextarea(textarea);
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
      <Show when={draft().replyToMessageId}>
        <div class="reply-composer">
          <div class="reply-composer-card">
            <strong>
              {privateReply()
                ? `Privately replying to ${reply()?.senderName || draft().replySenderName || chat()?.title || "sender"}`
                : reply()?.fromMe
                  ? "You"
                  : reply()?.senderName || draft().replySenderName || chat()?.title}
            </strong>
            <span>{reply() ? messageText(reply()!) : draft().replyPreviewText || "Message outside the loaded history"}</span>
          </div>
          <IconButton label="Cancel reply" onClick={() => actions.cancelReply(props.chatId)}><X size={18} /></IconButton>
        </div>
      </Show>
      <Show when={editing()}>
        {(message) => (
          <div class="reply-composer edit-composer">
            <div class="reply-composer-card">
              <strong>Edit message</strong>
              <span>{messageText(message())}</span>
            </div>
            <IconButton label="Cancel edit" onClick={() => actions.cancelEdit(props.chatId)}><X size={18} /></IconButton>
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
          <ThemeIcon icon={Smile} name="smile" size={22} />
        </IconButton>
        <IconButton
          label="Stickers"
          active={openPopover() === "sticker"}
          disabled={!connected()}
          onClick={() => togglePopover("sticker")}
        >
          <ThemeIcon icon={Sticker} name="sticker" size={22} />
        </IconButton>
        <IconButton
          label="Attach"
          active={openPopover() === "attachment"}
          disabled={!connected()}
          onClick={() => togglePopover("attachment")}
        >
          <ThemeIcon icon={Paperclip} name="attach" size={22} />
        </IconButton>
        <IconButton label="Create poll" active={openPopover() === "poll"} disabled={!connected()} onClick={() => togglePopover("poll")}>
          <ThemeIcon icon={ListChecks} name="poll" size={22} />
        </IconButton>

        <div class="composer-input-wrap">
          <textarea
            ref={textarea}
            class="composer-input"
            rows={1}
            value={draft().text}
            disabled={!connected()}
            placeholder={connected() ? (draft().editingMessageId ? "Edit message" : "Type a message") : "Waiting for connection…"}
            aria-label="Message"
            onInput={(event) => {
              actions.setDraftText(event.currentTarget.value, props.chatId);
              setComposerCaret(event.currentTarget.selectionStart ?? event.currentTarget.value.length);
              resizeTextarea(event.currentTarget);
              updateMention(event.currentTarget);
            }}
            onClick={(event) => updateComposerContext(event.currentTarget)}
            onSelect={(event) => updateComposerContext(event.currentTarget)}
            onKeyUp={(event) => {
              if (event.key !== "Escape") updateComposerContext(event.currentTarget);
            }}
            onBlur={() => actions.stopTyping()}
            onKeyDown={(event) => {
              if (
                event.key.toLocaleLowerCase() === "v"
                && (event.ctrlKey || event.metaKey)
                && !event.altKey
              ) {
                event.preventDefault();
                void pasteClipboard();
                return;
              }
              // Mention autocomplete always wins, regardless of enterToSend.
              if (openPopover() === null && mentionMatches().length > 0) {
                if (event.key === "ArrowDown" || event.key === "ArrowUp") {
                  const direction = event.key === "ArrowDown" ? 1 : -1;
                  setMentionIndex((index) =>
                    (index + direction + mentionMatches().length) % mentionMatches().length,
                  );
                  event.preventDefault();
                  return;
                }
                if (
                  (event.key === "Tab" || event.key === "Enter")
                  && !event.altKey
                  && !event.ctrlKey
                  && !event.metaKey
                  && !event.shiftKey
                ) {
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
              if (openPopover() === null && emojiSuggestions().length > 0) {
                if (event.key === "ArrowDown" || event.key === "ArrowUp") {
                  const direction = event.key === "ArrowDown" ? 1 : -1;
                  setEmojiIndex((index) =>
                    (index + direction + emojiSuggestions().length) % emojiSuggestions().length,
                  );
                  event.preventDefault();
                  return;
                }
                if (
                  (event.key === "Tab" || event.key === "Enter")
                  && !event.altKey
                  && !event.ctrlKey
                  && !event.metaKey
                  && !event.shiftKey
                ) {
                  const suggestion = emojiSuggestions()[emojiIndex()];
                  if (suggestion) selectEmojiSuggestion(suggestion.emoji);
                  event.preventDefault();
                  return;
                }
                if (event.key === "Escape") {
                  setComposerCaret(-1);
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
          label={draft().editingMessageId ? "Save edit" : "Send"}
          class="send-button"
          disabled={!connected() || state.sending || !draft().text.trim()}
        >
          <ThemeIcon icon={Send} name="send" size={20} />
        </IconButton>

        <Show when={openPopover() === null && mentionRange() && mentionMatches().length > 0}>
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

        <Show when={openPopover() === null && !mentionRange() && emojiAutocomplete() && emojiSuggestions().length > 0}>
          <div class="popover emoji-autocomplete" role="listbox" aria-label="Emoji suggestions">
            <For each={emojiSuggestions()}>
              {(suggestion, index) => (
                <button
                  type="button"
                  class={`emoji-autocomplete-row ${index() === emojiIndex() ? "active" : ""}`}
                  role="option"
                  aria-selected={index() === emojiIndex()}
                  onMouseDown={(event) => event.preventDefault()}
                  onClick={() => selectEmojiSuggestion(suggestion.emoji)}
                >
                  <span class="emoji-autocomplete-glyph" aria-hidden="true">{suggestion.emoji}</span>
                  <span>:{suggestion.label}:</span>
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

  function updateComposerContext(element: HTMLTextAreaElement) {
    setComposerCaret(element.selectionStart ?? element.value.length);
    updateMention(element);
  }

  function selectMention(participant: ChatParticipant) {
    const range = mentionRange();
    if (!range) return;
    const displayName = participant.displayName || participant.phoneNumber;
    const caret = range.start + displayName.length + 2;
    actions.addMention(participant, range.start, range.end, props.chatId);
    setMentionRange(null);
    setComposerCaret(caret);
    queueMicrotask(() => {
      if (!textarea) return;
      textarea.focus();
      textarea.selectionStart = textarea.selectionEnd = caret;
      resizeTextarea(textarea);
    });
  }

  function insertEmoji(emoji: string) {
    const element = textarea;
    const draftText = draft().text;
    const start = element?.selectionStart ?? draftText.length;
    const end = element?.selectionEnd ?? start;
    actions.setDraftText(`${draftText.slice(0, start)}${emoji}${draftText.slice(end)}`, props.chatId);
    const caret = start + emoji.length;
    setComposerCaret(caret);
    queueMicrotask(() => {
      if (!textarea) return;
      textarea.focus();
      textarea.selectionStart = textarea.selectionEnd = caret;
      resizeTextarea(textarea);
    });
  }

  function insertClipboardText(text: string) {
    if (!text) return;
    const element = textarea;
    const draftText = draft().text;
    const start = element?.selectionStart ?? draftText.length;
    const end = element?.selectionEnd ?? start;
    actions.setDraftText(`${draftText.slice(0, start)}${text}${draftText.slice(end)}`, props.chatId);
    const caret = start + text.length;
    setComposerCaret(caret);
    queueMicrotask(() => {
      if (!textarea) return;
      textarea.focus();
      textarea.selectionStart = textarea.selectionEnd = caret;
      resizeTextarea(textarea);
      updateMention(textarea);
    });
  }

  function selectEmojiSuggestion(emoji: string) {
    const autocomplete = emojiAutocomplete();
    if (!autocomplete) return;
    const replacement = applyEmojiSuggestion(draft().text, autocomplete.match, emoji);
    actions.setDraftText(replacement.text, props.chatId);
    setComposerCaret(replacement.caret);
    queueMicrotask(() => {
      if (!textarea) return;
      textarea.focus();
      textarea.selectionStart = textarea.selectionEnd = replacement.caret;
      resizeTextarea(textarea);
    });
  }

  async function pasteClipboard() {
    let stagedPath = "";
    try {
      stagedPath = await stageClipboardImage();
      await actions.sendImage(stagedPath, props.chatId);
      return;
    } catch (error) {
      const clipboardError = normalizeBridgeError(error);
      if (clipboardError.code !== "clipboard_no_image") {
        actions.notifyError(clipboardError);
        return;
      }
      try {
        insertClipboardText(await readClipboardText());
      } catch (textError) {
        actions.notifyError(textError);
      }
    } finally {
      if (stagedPath) {
        void discardStagedImage(stagedPath).catch((error) => {
          console.warn("Could not remove staged clipboard image", error);
        });
      }
    }
  }

  async function chooseImage() {
    await chooseFiles(
      "Choose photos",
      "image",
      AttachmentKind.Document,
      [{ name: "Images", extensions: ["jpg", "jpeg", "png", "gif", "webp"] }],
    );
  }

  async function chooseSticker() {
    await chooseFiles(
      "Choose images to turn into stickers",
      "sticker",
      AttachmentKind.Document,
      [{ name: "Images", extensions: ["jpg", "jpeg", "png", "gif", "webp"] }],
    );
  }

  async function chooseAttachment(kind: number) {
    const filters =
      kind === AttachmentKind.Video
        ? [{ name: "Videos", extensions: ["mp4", "mkv", "mov", "webm"] }]
        : kind === AttachmentKind.Audio
          ? [{ name: "Audio", extensions: ["ogg", "opus", "mp3", "m4a", "wav", "aac"] }]
          : undefined;
    await chooseFiles(
      kind === AttachmentKind.Document ? "Choose documents" : kind === AttachmentKind.Video ? "Choose videos" : "Choose audio files",
      "attachment",
      kind as AttachmentKind,
      filters,
    );
  }

  async function chooseFiles(
    title: string,
    mode: "image" | "sticker" | "attachment",
    attachmentKind: AttachmentKind,
    filters?: Array<{ name: string; extensions: string[] }>,
  ) {
    setOpenPopover(null);
    const paths = await openFile({
      multiple: true,
      directory: false,
      title,
      filters,
    });
    if (paths?.length) actions.requestFileSend(paths, mode, attachmentKind, false, props.chatId);
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
