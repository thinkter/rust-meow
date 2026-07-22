import { createEffect, createMemo, createSignal, For, Match, Show, Switch } from "solid-js";
import {
  Check,
  CheckCheck,
  Clock3,
  ContactRound,
  Download,
  FileAudio,
  FileText,
  FileVideo,
  FolderDown,
  MapPin,
  MessageSquareReply,
  Plus,
  RefreshCcw,
  SmilePlus,
  TriangleAlert,
} from "lucide-solid";
import type { AppModel } from "../state/app";
import type {
  AttachmentContent,
  ImageContent,
  LinkPreview,
  Message,
  Reaction,
  TextContent,
} from "../lib/types";
import { MessageStatus } from "../lib/types";
import {
  formatBytes,
  formatDuration,
  formatTime,
  hueFor,
  messageText,
  safeHttpUrl,
} from "../lib/format";
import { assetUrl, openUrl } from "../lib/bridge";
import { EmojiPicker } from "./EmojiPicker";
import { IconButton, Spinner } from "./Primitives";

const QUICK_REACTIONS = ["👍", "❤️", "😂", "😮", "😢", "🙏"];
const RECENT_REACTION_KEY = "rust-meow-recent-emoji";
/** Past this many characters a bare URL gets truncated in the middle — G13. */
const URL_TRUNCATE_LENGTH = 64;

interface MessageBubbleProps {
  message: Message;
  model: AppModel;
  /** The conversation this bubble belongs to — never derive this from
   * `state.selectedChatId`, since a second pane can be showing a different
   * chat at the same time. */
  chatId: string;
  highlighted?: boolean;
  /** Set by `Conversation` for grouped consecutive incoming messages (G1);
   * hides the repeated sender-name line so only the avatar row's spacing
   * changes, not the bubble's own layout. */
  suppressSender?: boolean;
  quotedMessage?: Message;
  replyCount?: number;
  firstReplyMessageId?: string;
  onScrollToMessage: (messageId: string) => void;
}

export function MessageBubble(props: MessageBubbleProps) {
  const { actions } = props.model;
  const [reactionOpen, setReactionOpen] = createSignal(false);
  const [reactionExpanded, setReactionExpanded] = createSignal(false);
  const [popoverAbove, setPopoverAbove] = createSignal(true);
  let popoverRef: HTMLDivElement | undefined;

  const quoted = () => props.quotedMessage;
  const replyCount = () => props.replyCount ?? 0;
  const reactionGroups = createMemo(() => groupReactions(props.message.reactions));
  const savableMedia = createMemo(() => savableMediaInfo(props.message));

  createEffect(() => {
    const message = props.message;
    if (message.content && "image" in message.content) void actions.hydrateImage(message, false, false, props.chatId);
  });

  // The popover is clipped to `.message-scroller` (it uses layout/paint
  // containment), so a row near the top of the pane must flip its picker to
  // open downward instead of the default upward placement — G2.
  createEffect(() => {
    if (!reactionOpen()) {
      setPopoverAbove(true);
      return;
    }
    requestAnimationFrame(() => {
      if (!popoverRef) return;
      const scroller = popoverRef.closest<HTMLElement>(".message-scroller");
      if (!scroller) return;
      const popoverRect = popoverRef.getBoundingClientRect();
      const scrollerRect = scroller.getBoundingClientRect();
      setPopoverAbove(popoverRect.top >= scrollerRect.top);
    });
  });

  function toggleReactionPopover() {
    setReactionOpen((open) => {
      const next = !open;
      if (!next) setReactionExpanded(false);
      return next;
    });
  }

  function pickReaction(emoji: string) {
    setReactionOpen(false);
    setReactionExpanded(false);
    void actions.react(props.message.id, emoji, props.chatId);
  }

  return (
    <div
      class={`message-bubble ${props.highlighted ? "highlight" : ""}`}
      style={{ "--sender-hue": `${hueFor(props.message.senderId || props.message.senderName)}` }}
      data-message-id={props.message.id}
    >
      <Show when={!props.message.fromMe && props.message.senderName && !props.suppressSender}>
        <div class="message-sender">
          <span>{props.message.senderName}</span>
          <Show when={props.message.senderPhoneNumber}>
            <span>· {props.message.senderPhoneNumber}</span>
          </Show>
        </div>
      </Show>

      <Show when={props.message.replyToMessageId}>
        <button
          type="button"
          class="quoted-message"
          onClick={() => props.onScrollToMessage(props.message.replyToMessageId)}
        >
          <strong>{quoted()?.fromMe ? "You" : quoted()?.senderName || "Original message"}</strong>
          <span>{quoted() ? messageText(quoted()!) : "Message outside the loaded history"}</span>
        </button>
      </Show>

      <MessageContent message={props.message} model={props.model} chatId={props.chatId} />

      <div class="message-meta">
        <Show when={props.message.edited}><span>edited</span></Show>
        <span>{formatTime(props.message.timestampMs)}</span>
        <Show when={props.message.fromMe}><MessageStatusIcon status={props.message.status} /></Show>
      </div>

      <Show when={reactionGroups().length > 0}>
        <div class="reaction-row" aria-label="Reactions">
          <For each={reactionGroups()}>
            {(group) => (
              <button
                type="button"
                class={`reaction-chip ${group.reactions.some((reaction) => reaction.fromMe) ? "mine" : ""}`}
                title={group.reactions.map(reactionName).join(", ")}
                onClick={() => {
                  const mine = group.reactions.some((reaction) => reaction.fromMe);
                  void actions.react(props.message.id, mine ? "" : group.emoji, props.chatId);
                }}
              >
                <span>{group.emoji}</span>
                <Show when={group.reactions.length > 1}><span>{group.reactions.length}</span></Show>
              </button>
            )}
          </For>
        </div>
      </Show>

      <Show when={replyCount() > 0}>
        <button
          type="button"
          class="reply-count"
          onClick={() => {
            if (props.firstReplyMessageId) props.onScrollToMessage(props.firstReplyMessageId);
          }}
        >
          {replyCount()} {replyCount() === 1 ? "reply" : "replies"}
        </button>
      </Show>

      <div class="message-actions" aria-label="Message actions">
        <IconButton label="React" active={reactionOpen()} onClick={toggleReactionPopover}>
          <SmilePlus size={15} />
        </IconButton>
        <IconButton label="Reply" onClick={() => actions.replyTo(props.message.id, props.chatId)}>
          <MessageSquareReply size={15} />
        </IconButton>
        <Show when={savableMedia()}>
          {(media) => (
            <IconButton label="Save to folder" onClick={() => void actions.saveMediaAs(media().path, media().name)}>
              <FolderDown size={15} />
            </IconButton>
          )}
        </Show>
      </div>

      <Show when={reactionOpen()}>
        <div
          ref={popoverRef}
          class={`popover ${reactionExpanded() ? "emoji-picker" : "reaction-picker"}`}
          style={popoverAbove() ? undefined : { bottom: "auto", top: "calc(100% + 8px)" }}
        >
          <Show
            when={reactionExpanded()}
            fallback={
              <>
                <div class="reaction-quick-row">
                  <For each={QUICK_REACTIONS}>
                    {(emoji) => (
                      <button
                        type="button"
                        class="emoji-button"
                        style={{ width: "35px", height: "35px" }}
                        onClick={() => pickReaction(emoji)}
                      >
                        {emoji}
                      </button>
                    )}
                  </For>
                </div>
                <button
                  type="button"
                  class="reaction-picker-expand"
                  aria-label="More reactions"
                  onClick={() => setReactionExpanded(true)}
                >
                  <Plus size={16} />
                </button>
              </>
            }
          >
            <EmojiPicker onPick={pickReaction} recentKey={RECENT_REACTION_KEY} />
          </Show>
        </div>
      </Show>
    </div>
  );
}

function MessageContent(props: { message: Message; model: AppModel; chatId: string }) {
  const content = () => props.message.content;
  return (
    <Show when={!props.message.revoked} fallback={<p class="message-text"><em>This message was deleted</em></p>}>
      <Show when={content()} fallback={<p class="message-text">Message</p>}>
        {(value) => (
          <>
            <Show when={"text" in value()}>
              <TextMessage content={(value() as { text: TextContent }).text} />
            </Show>
            <Show when={"image" in value()}>
              <ImageMessage message={props.message} model={props.model} chatId={props.chatId} />
            </Show>
            <Show when={"attachment" in value()}>
              <AttachmentMessage
                message={props.message}
                attachment={(value() as { attachment: AttachmentContent }).attachment}
                model={props.model}
                chatId={props.chatId}
              />
            </Show>
            <Show when={"contacts" in value()}>
              <For each={(value() as { contacts: { contacts: { displayName: string; vcard: string }[] } }).contacts.contacts}>
                {(contact) => (
                  <div class="contact-card">
                    <span class="contact-icon"><ContactRound size={22} /></span>
                    <span class="contact-meta">
                      <strong>{contact.displayName || "Contact"}</strong>
                      <span>Shared contact</span>
                    </span>
                  </div>
                )}
              </For>
            </Show>
            <Show when={"location" in value()}>
              {(() => {
                const location = (value() as { location: { latitude: number; longitude: number; name: string; address: string; url: string; live: boolean } }).location;
                const target =
                  safeHttpUrl(location.url) ||
                  `https://www.openstreetmap.org/?mlat=${encodeURIComponent(location.latitude)}&mlon=${encodeURIComponent(location.longitude)}`;
                return (
                  <button type="button" class="location-card" onClick={() => void openUrl(target)}>
                    <span class="location-icon"><MapPin size={22} /></span>
                    <span class="location-meta">
                      <strong>{location.name || (location.live ? "Live location" : "Location")}</strong>
                      <span>{location.address || `${location.latitude.toFixed(5)}, ${location.longitude.toFixed(5)}`}</span>
                    </span>
                  </button>
                );
              })()}
            </Show>
            <Show when={"unsupported" in value()}>
              <div class="attachment-card">
                <span class="attachment-icon"><TriangleAlert size={21} /></span>
                <span class="attachment-meta">
                  <strong>{(value() as { unsupported: { fallbackText: string; typeName: string } }).unsupported.fallbackText || "Unsupported message"}</strong>
                  <span>{(value() as { unsupported: { fallbackText: string; typeName: string } }).unsupported.typeName}</span>
                </span>
              </div>
            </Show>
          </>
        )}
      </Show>
    </Show>
  );
}

function TextMessage(props: { content: TextContent }) {
  return (
    <>
      <Show when={props.content.linkPreview}>
        {(preview) => <LinkPreviewCard preview={preview()} />}
      </Show>
      <p class="message-text"><LinkifiedText text={props.content.text} /></p>
    </>
  );
}

function LinkifiedText(props: { text: string }) {
  const tokens = () => props.text.split(/(https?:\/\/[^\s]+)/gi);
  return (
    <For each={tokens()}>
      {(token) => {
        const visibleUrl = token.replace(/[),.!?;:]+$/, "");
        const url = safeHttpUrl(visibleUrl);
        const suffix = url ? token.slice(visibleUrl.length) : "";
        return url ? (
          <>
            <a href={url} title={visibleUrl} onClick={(event) => { event.preventDefault(); void openUrl(url); }}>
              {truncateMiddle(visibleUrl, URL_TRUNCATE_LENGTH)}
            </a>
            {suffix}
          </>
        ) : token;
      }}
    </For>
  );
}

function LinkPreviewCard(props: { preview: LinkPreview }) {
  const target = () => safeHttpUrl(props.preview.url);
  const thumbnail = () => jpegDataUrl(props.preview.jpegThumbnail);
  return (
    <button
      type="button"
      class="link-preview"
      disabled={!target()}
      onClick={() => { const url = target(); if (url) void openUrl(url); }}
    >
      <Show when={thumbnail()}>{(source) => <img src={source()} alt="" />}</Show>
      <span class="link-preview-meta">
        <strong>{props.preview.title || props.preview.url}</strong>
        <span>{props.preview.description}</span>
        <span>{linkHost(props.preview.url)}</span>
      </span>
    </button>
  );
}

function ImageMessage(props: { message: Message; model: AppModel; chatId: string }) {
  const image = () => {
    const content = props.message.content;
    return content && "image" in content ? content.image : undefined;
  };
  const path = () => image()?.thumbnailPath || image()?.localPath || "";
  const source = () => assetUrl(path());
  const error = () => props.model.state.imageFailures[`${props.chatId}\u0000${props.message.id}`];
  return (
    <>
      <button
        type="button"
        class={`message-image ${image()?.sticker ? "sticker" : ""}`}
        style={imageAspectStyle(image()?.width ?? 0, image()?.height ?? 0, Boolean(image()?.sticker), props.model.preferences.uiScale)}
        onClick={() => {
          const media = image();
          if (!media) return;
          if (media.localPath) {
            props.model.actions.openImage(media.localPath, media.caption, media.sticker);
            return;
          }
          if (media.downloadable) {
            void props.model.actions
              .hydrateImage(props.message, true, true, props.chatId)
              .then((downloadedPath) => {
                if (downloadedPath) {
                  props.model.actions.openImage(downloadedPath, media.caption, media.sticker);
                }
              });
            return;
          }
          if (media.thumbnailPath) {
            props.model.actions.openImage(media.thumbnailPath, media.caption, media.sticker);
          }
        }}
      >
        <Show
          when={source()}
          fallback={
            <span class="media-placeholder">
              <Show when={!error()} fallback={<><RefreshCcw size={23} /><span>{error()}</span></>}>
                <Spinner small label={image()?.sticker ? "Loading sticker" : "Loading photo"} />
              </Show>
            </span>
          }
        >
          {(url) => <img src={url()} alt={image()?.caption || (image()?.sticker ? "Sticker" : "Photo")} draggable={false} />}
        </Show>
      </button>
      <Show when={image()?.caption}><p class="message-text">{image()?.caption}</p></Show>
    </>
  );
}

function AttachmentMessage(props: {
  message: Message;
  attachment: AttachmentContent;
  model: AppModel;
  chatId: string;
}) {
  const [playbackFailed, setPlaybackFailed] = createSignal(false);
  const source = () => assetUrl(props.attachment.localPath);
  const isAudio = () => props.attachment.kind === "audio" || props.attachment.voiceNote;
  const isVideo = () => props.attachment.kind === "video";
  const isGif = () => isVideo() && props.attachment.animated;
  const failure = () => props.model.state.attachmentFailures[`${props.chatId}\u0000${props.message.id}`];
  const icon = () => (isAudio() ? <FileAudio size={23} /> : isVideo() ? <FileVideo size={23} /> : <FileText size={23} />);

  return (
    <>
      <Show when={isVideo() && !playbackFailed() ? source() : undefined}>
        {(url) => (
          <video
            class={`message-image ${isGif() ? "gif" : ""}`}
            controls={!isGif()}
            autoplay={isGif()}
            loop={isGif()}
            muted={isGif()}
            playsinline
            preload={isGif() ? "auto" : "metadata"}
            src={url()}
            aria-label={props.attachment.fileName || (isGif() ? "Animated GIF" : "Video")}
            onError={() => setPlaybackFailed(true)}
          />
        )}
      </Show>
      <Show when={isAudio() && source()}>
        {(url) => <audio controls preload="metadata" src={url()} aria-label={props.attachment.fileName || "Audio message"} />}
      </Show>
      <Show when={!(isVideo() && source() && !playbackFailed()) && !(isAudio() && source())}>
        <button
          type="button"
          class="attachment-card"
          onClick={() => void props.model.actions.openAttachment(props.message, props.chatId)}
        >
          <span class="attachment-icon">{icon()}</span>
          <span class="attachment-meta">
            <strong>{props.attachment.fileName || attachmentLabel(props.attachment)}</strong>
            <span>
              {[formatBytes(props.attachment.fileSize), formatDuration(props.attachment.durationSeconds), props.attachment.mimeType]
                .filter(Boolean)
                .join(" · ")}
            </span>
          </span>
          <Show when={props.attachment.downloadable && !props.attachment.localPath}>
            <Download size={20} />
          </Show>
        </button>
      </Show>
      <Show when={failure()}>
        {(error) => (
          <button
            type="button"
            class="media-download-error"
            onClick={() => void props.model.actions.openAttachment(props.message, props.chatId)}
          >
            <RefreshCcw size={14} />
            <span>{error()}</span>
          </button>
        )}
      </Show>
      <Show when={props.attachment.caption}><p class="message-text">{props.attachment.caption}</p></Show>
    </>
  );
}

function MessageStatusIcon(props: { status: number }) {
  return (
    <Switch>
      <Match when={props.status === MessageStatus.Pending}><Clock3 size={12} /></Match>
      <Match when={props.status === MessageStatus.Sent}><Check size={13} /></Match>
      <Match when={props.status === MessageStatus.Delivered}><CheckCheck size={14} /></Match>
      <Match when={props.status === MessageStatus.Read}><CheckCheck class="read" size={14} /></Match>
      <Match when={props.status === MessageStatus.Failed}><TriangleAlert class="failed" size={13} /></Match>
    </Switch>
  );
}

function groupReactions(reactions: readonly Reaction[]) {
  const groups = new Map<string, Reaction[]>();
  for (const reaction of reactions) {
    if (!reaction.emoji) continue;
    groups.set(reaction.emoji, [...(groups.get(reaction.emoji) ?? []), reaction]);
  }
  return [...groups].map(([emoji, grouped]) => ({ emoji, reactions: grouped }));
}

function reactionName(reaction: Reaction): string {
  return reaction.fromMe ? "You" : reaction.senderName || reaction.senderPhoneNumber || "Unknown";
}

function jpegDataUrl(bytes: number[]): string | undefined {
  if (bytes.length === 0) return undefined;
  let binary = "";
  for (let index = 0; index < bytes.length; index += 0x8000) {
    binary += String.fromCharCode(...bytes.slice(index, index + 0x8000));
  }
  return `data:image/jpeg;base64,${btoa(binary)}`;
}

function linkHost(value: string): string {
  try {
    return new URL(value).host;
  } catch {
    return value;
  }
}

function attachmentLabel(attachment: AttachmentContent): string {
  if (attachment.voiceNote) return "Voice message";
  if (attachment.kind === "video" && attachment.animated) return "GIF";
  if (attachment.kind === "video") return "Video";
  if (attachment.kind === "audio") return "Audio";
  return "Document";
}

/** Keeps the start (scheme/host, usually the meaningful part) and a short
 * tail, so a truncated link is still recognisable — G13. `href`/the click
 * target always carry the untruncated URL; only the label is shortened. */
function truncateMiddle(text: string, max: number): string {
  if (text.length <= max) return text;
  const tailLength = 6;
  const headLength = Math.max(1, max - tailLength - 1);
  return `${text.slice(0, headLength)}…${text.slice(text.length - tailLength)}`;
}

function imageAspectStyle(width: number, height: number, sticker: boolean, uiScale: number) {
  if (width <= 0 || height <= 0) return {};
  const maxWidth = (sticker ? 210 : 320) * uiScale;
  const maxHeight = (sticker ? 210 : 360) * uiScale;
  const scale = Math.min(maxWidth / width, maxHeight / height, 1);
  return {
    width: `${Math.max(110 * uiScale, Math.round(width * scale))}px`,
    height: `${Math.max(90 * uiScale, Math.round(height * scale))}px`,
  };
}

/** Only images/attachments that are actually downloaded locally can be
 * "Saved to folder" — G7's `saveMediaAs`. */
function savableMediaInfo(message: Message): { path: string; name: string } | null {
  const content = message.content;
  if (!content) return null;
  if ("image" in content && content.image.localPath) {
    return { path: content.image.localPath, name: suggestedMediaName(content.image) };
  }
  if ("attachment" in content && content.attachment.localPath) {
    return {
      path: content.attachment.localPath,
      name: content.attachment.fileName || suggestedAttachmentName(content.attachment),
    };
  }
  return null;
}

function suggestedMediaName(image: ImageContent): string {
  const base = basename(image.localPath);
  if (base) return base;
  const extension = image.mimeType.split("/").pop();
  return `${image.sticker ? "sticker" : "photo"}${extension ? `.${extension}` : ""}`;
}

function suggestedAttachmentName(attachment: AttachmentContent): string {
  const base = basename(attachment.localPath);
  if (base) return base;
  const extension = attachment.mimeType.split("/").pop();
  return `${attachmentLabel(attachment).toLowerCase()}${extension ? `.${extension}` : ""}`;
}

function basename(path: string): string {
  return path.split(/[\\/]/).pop() ?? "";
}
