import { createEffect, createMemo, createSignal, For, Match, onCleanup, Show, Switch } from "solid-js";
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
  FolderOpen,
  Forward,
  ListChecks,
  MapPin,
  MessageSquareReply,
  Pencil,
  Plus,
  Pin,
  RefreshCcw,
  SmilePlus,
  TriangleAlert,
} from "lucide-solid";
import type { AppModel } from "../state/app";
import {
  ChatKind,
  MessageStatus,
  type AttachmentContent,
  type ImageContent,
  type LinkPreview,
  type Message,
  type PollContent,
  type PollVoter,
  type Reaction,
  type TextContent,
} from "../lib/types";
import {
  formatBytes,
  formatDuration,
  formatTime,
  hueFor,
  messageText,
  safeHttpUrl,
} from "../lib/format";
import { assetUrl } from "../lib/bridge";
import { parsePollFallback } from "../lib/unsupported";
import {
  parseWhatsAppText,
  type WhatsAppInlineSegment,
  type WhatsAppInlineStyle,
  type WhatsAppTextBlock,
} from "../lib/whatsapp-formatting";
import { EmojiPicker } from "./EmojiPicker";
import { Avatar } from "./Avatar";
import { IconButton, Spinner } from "./Primitives";
import { ThemeIcon } from "./ThemeIcon";

const QUICK_REACTIONS = ["👍", "❤️", "😂", "😮", "😢", "🙏"];
const RECENT_REACTION_KEY = "rust-meow-recent-emoji";
const EDIT_WINDOW_MS = 20 * 60_000;
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
  const replySourceTitle = () =>
    props.model.state.chats.find((chat) => chat.id === props.message.replyToChatId)?.title;
  const groupChat = () =>
    props.model.state.chats.find((chat) => chat.id === props.chatId)?.kind === ChatKind.Group;
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
          <Show when={props.message.senderPhoneNumber}><span>· {props.message.senderPhoneNumber}</span></Show>
        </div>
      </Show>

      <Show when={props.message.forwardingScore > 0}>
        <div class="forwarded-label">
          <Forward size={13} />
          <span>{props.message.forwardingScore >= 5 ? "Forwarded many times" : props.message.forwardingScore > 1 ? `Forwarded ${props.message.forwardingScore} times` : "Forwarded"}</span>
        </div>
      </Show>

      <Show when={props.message.replyToMessageId}>
        <button
          type="button"
          class="quoted-message"
          onClick={() => {
            if (props.message.replyToChatId && props.message.replyToChatId !== props.chatId) {
              void actions.selectChat(props.message.replyToChatId, props.message.replyToMessageId);
            } else {
              props.onScrollToMessage(props.message.replyToMessageId);
            }
          }}
        >
          <strong>{quoted()?.fromMe ? "You" : quoted()?.senderName || replySourceTitle() || "Original message"}</strong>
          <span>
            {quoted()
              ? messageText(quoted()!)
              : replySourceTitle()
                ? `Quoted message in ${replySourceTitle()}`
                : "Message outside the loaded history"}
          </span>
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
          <ThemeIcon icon={SmilePlus} name="smile" size={15} />
        </IconButton>
        <IconButton label="Reply" onClick={() => actions.replyTo(props.message.id, props.chatId)}>
          <ThemeIcon icon={MessageSquareReply} name="reply" size={15} />
        </IconButton>
        <Show when={groupChat() && !props.message.fromMe && !props.message.revoked && props.message.senderId}>
          <IconButton label="Reply privately" onClick={() => void actions.replyPrivately(props.message, props.chatId)}>
            <ThemeIcon icon={MessageSquareReply} name="reply" size={15} />
          </IconButton>
        </Show>
        <Show when={props.message.content && !props.message.revoked}>
          <IconButton label="Forward" onClick={() => actions.startForward(props.message.id, props.chatId)}>
            <ThemeIcon icon={Forward} name="reply" size={15} />
          </IconButton>
        </Show>
        <Show when={
          props.message.fromMe &&
          !props.message.revoked &&
          props.message.content &&
          "text" in props.message.content &&
          Date.now() - props.message.timestampMs <= EDIT_WINDOW_MS
        }>
          <IconButton label="Edit" onClick={() => actions.editMessage(props.message.id, props.chatId)}>
            <ThemeIcon icon={Pencil} name="edit" size={15} />
          </IconButton>
        </Show>
        <Show when={props.message.content && !props.message.revoked}>
          <IconButton
            label={props.model.state.pinnedMessages[props.chatId]?.some((pin) => pin.messageId === props.message.id) ? "Unpin message" : "Pin message"}
            onClick={() => void actions.setMessagePin(props.message.id, !props.model.state.pinnedMessages[props.chatId]?.some((pin) => pin.messageId === props.message.id), props.chatId)}
          ><ThemeIcon icon={Pin} name="pin" size={15} /></IconButton>
        </Show>
        <Show when={savableMedia()}>
          {(media) => (
            <>
              <IconButton label="Show in file manager" onClick={() => void actions.revealMedia(media().path)}>
                <FolderOpen size={15} />
              </IconButton>
              <IconButton label="Save to folder" onClick={() => void actions.saveMediaAs(media().path, media().name)}>
                <FolderDown size={15} />
              </IconButton>
            </>
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
              <TextMessage
                content={(value() as { text: TextContent }).text}
                mentions={props.message.mentionTexts}
                onOpenLink={props.model.actions.openExternalLink}
              />
            </Show>
            <Show when={"image" in value()}><ImageMessage message={props.message} model={props.model} chatId={props.chatId} /></Show>
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
                  <button
                    type="button"
                    class="location-card"
                    onClick={() => void props.model.actions.openExternalLink(target)}
                  >
                    <span class="location-icon"><MapPin size={22} /></span>
                    <span class="location-meta">
                      <strong>{location.name || (location.live ? "Live location" : "Location")}</strong>
                      <span>{location.address || `${location.latitude.toFixed(5)}, ${location.longitude.toFixed(5)}`}</span>
                    </span>
                  </button>
                );
              })()}
            </Show>
            <Show when={"poll" in value()}><PollMessage message={props.message} poll={(value() as { poll: PollContent }).poll} model={props.model} chatId={props.chatId} /></Show>
            <Show when={"unsupported" in value()}><UnsupportedMessage content={(value() as { unsupported: { fallbackText: string; typeName: string } }).unsupported} /></Show>
          </>
        )}
      </Show>
    </Show>
  );
}

function PollMessage(props: { message: Message; poll: PollContent; model: AppModel; chatId: string }) {
  const [showVotes, setShowVotes] = createSignal(false);
  const selected = () => props.poll.options.filter((option) => option.selectedByMe).map((option) => option.name);
  const hasVotes = () => props.poll.options.some((option) => option.voteCount > 0);
  function choose(name: string) {
    if (props.poll.selectableOptionsCount === 0) return;
    const current = new Set(selected());
    if (props.poll.selectableOptionsCount === 1) {
      void props.model.actions.votePoll(props.message, current.has(name) ? [] : [name], props.chatId);
    } else {
      current.has(name) ? current.delete(name) : current.add(name);
      if (current.size <= props.poll.selectableOptionsCount) void props.model.actions.votePoll(props.message, [...current], props.chatId);
    }
  }
  const pending = () => props.model.state.pendingPollVotes[`${props.chatId}:${props.message.id}`] ?? false;
  return <section class={`poll-card ${pending() ? "pending" : ""}`} aria-label="Poll" aria-busy={pending()}>
    <header><ListChecks size={20} /><strong>{props.poll.question}</strong></header>
    <For each={props.poll.options}>{(option) =>
      <div class="poll-option-group">
        <button type="button" disabled={props.poll.selectableOptionsCount === 0 || pending()} class={`poll-option ${option.selectedByMe ? "selected" : ""}`} aria-pressed={option.selectedByMe} onClick={() => choose(option.name)}>
          <span aria-hidden="true" />
          <span class="poll-option-label">{option.name}</span>
          <Show when={option.voters.length > 0}>
            <span class="poll-voter-thumbnails" aria-label={`${option.voters.length} known voters`}>
              <For each={option.voters.slice(0, 4)}>{(voter) => <PollVoterAvatar voter={voter} model={props.model} chatId={props.chatId} size={22} />}</For>
              <Show when={option.voters.length > 4}><span class="poll-voter-overflow">+{option.voters.length - 4}</span></Show>
            </span>
          </Show>
          <strong>{option.voteCount}</strong>
        </button>
      </div>
    }</For>
    <Show when={hasVotes()}>
      <button type="button" class="poll-view-votes" aria-expanded={showVotes()} onClick={() => setShowVotes((shown) => !shown)}>
        {showVotes() ? "Hide votes" : "View votes"}
      </button>
    </Show>
    <Show when={showVotes()}>
      <div class="poll-vote-details">
        <For each={props.poll.options}>{(option) => (
          <Show when={option.voteCount > 0}>
            <section>
              <strong>{option.name}</strong>
              <For each={option.voters}>{(voter) => (
                <div class="poll-voter-row">
                  <PollVoterAvatar voter={voter} model={props.model} chatId={props.chatId} size={28} />
                  <span>{voter.fromMe ? "You" : voter.displayName || voter.userId.split("@")[0]}</span>
                </div>
              )}</For>
              <Show when={option.voteCount > option.voters.length}>
                <small>{option.voteCount - option.voters.length} older {option.voteCount - option.voters.length === 1 ? "vote" : "votes"} without identity data</small>
              </Show>
            </section>
          </Show>
        )}</For>
      </div>
    </Show>
    <small>{pending() ? "Saving vote…" : props.poll.selectableOptionsCount === 0 ? "Poll results snapshot" : `${props.poll.totalVoters} ${props.poll.totalVoters === 1 ? "voter" : "voters"} · choose up to ${props.poll.selectableOptionsCount}`}</small>
  </section>;
}

function PollVoterAvatar(props: { voter: PollVoter; model: AppModel; chatId: string; size: number }) {
  createEffect(() => {
    if (props.voter.avatarPath) return;
    const cancel = props.model.actions.loadParticipantAvatar(props.voter.userId, props.chatId);
    onCleanup(cancel);
  });
  const name = () => props.voter.fromMe ? "You" : props.voter.displayName || props.voter.userId.split("@")[0] || "Voter";
  return (
    <Avatar
      class="poll-voter-avatar"
      name={name()}
      path={props.voter.avatarPath || props.model.state.participantAvatars[props.voter.userId]}
      size={props.size}
    />
  );
}

function UnsupportedMessage(props: { content: { fallbackText: string; typeName: string } }) {
  const poll = () => parsePollFallback(props.content.fallbackText);
  return (
    <Switch>
      <Match when={props.content.typeName === "poll"}>
        <section class="poll-card" aria-label={poll().results ? "Poll results" : "Poll"}>
          <header><ListChecks size={20} /><strong>{poll().title}</strong></header>
          <For each={poll().options}>
            {(option) => <div class="poll-option"><span aria-hidden="true" />{option}</div>}
          </For>
          <small>{poll().results ? "Poll results snapshot" : "Voting is not available in this build"}</small>
        </section>
      </Match>
      <Match when={props.content.typeName === "pin"}>
        <div class="system-message-card"><Pin size={17} /><span>{props.content.fallbackText || "Pinned message updated"}</span></div>
      </Match>
      <Match when={true}>
        <div class="attachment-card">
          <span class="attachment-icon"><TriangleAlert size={21} /></span>
          <span class="attachment-meta">
            <strong>{props.content.fallbackText || "Unsupported message"}</strong>
            <span>{props.content.typeName}</span>
          </span>
        </div>
      </Match>
    </Switch>
  );
}

function TextMessage(props: { content: TextContent; mentions: string[]; onOpenLink: (url: string) => Promise<void> }) {
  return (
    <>
      <Show when={props.content.linkPreview}>
        {(preview) => (
          <LinkPreviewCard preview={preview()} onOpenLink={props.onOpenLink} />
        )}
      </Show>
      <div class="message-text whatsapp-text">
        <LinkifiedText text={props.content.text} mentions={props.mentions} onOpenLink={props.onOpenLink} />
      </div>
    </>
  );
}

function LinkifiedText(props: { text: string; mentions?: string[]; onOpenLink: (url: string) => Promise<void> }) {
  const blocks = () => parseWhatsAppText(props.text, { mentions: props.mentions });
  return (
    <For each={blocks()}>
      {(block) => <WhatsAppBlock block={block} onOpenLink={props.onOpenLink} />}
    </For>
  );
}

function WhatsAppBlock(props: {
  block: WhatsAppTextBlock;
  onOpenLink: (url: string) => Promise<void>;
}) {
  const segments = () => "segments" in props.block ? props.block.segments : [];
  const content = () => (
    <For each={segments()}>
      {(segment) => <WhatsAppSegment segment={segment} onOpenLink={props.onOpenLink} />}
    </For>
  );
  return (
    <Switch>
      <Match when={props.block.kind === "paragraph"}>
        <span class="whatsapp-line">{content()}</span>
      </Match>
      <Match when={props.block.kind === "blank-line"}>
        <span class="whatsapp-blank-line" aria-hidden="true" />
      </Match>
      <Match when={props.block.kind === "quote"}>
        <span class="whatsapp-line whatsapp-quote">{content()}</span>
      </Match>
      <Match when={props.block.kind === "bullet-list-item"}>
        <span class="whatsapp-line whatsapp-list-item">
          <span class="whatsapp-list-marker" aria-hidden="true">•</span>
          <span>{content()}</span>
        </span>
      </Match>
      <Match when={props.block.kind === "numbered-list-item"}>
        <span class="whatsapp-line whatsapp-list-item">
          <span class="whatsapp-list-marker">
            {props.block.kind === "numbered-list-item" ? `${props.block.number}.` : ""}
          </span>
          <span>{content()}</span>
        </span>
      </Match>
      <Match when={props.block.kind === "code-block"}>
        <code class="whatsapp-code-block">
          {props.block.kind === "code-block" ? props.block.text : ""}
        </code>
      </Match>
    </Switch>
  );
}

function WhatsAppSegment(props: {
  segment: WhatsAppInlineSegment;
  onOpenLink: (url: string) => Promise<void>;
}) {
  const formatClass = () => formattingClass(props.segment.styles);
  return (
    <Switch>
      <Match when={props.segment.kind === "link"}>
        <a
          class={formatClass()}
          href={props.segment.kind === "link" ? props.segment.href : ""}
          title={props.segment.text}
          onClick={(event) => {
            event.preventDefault();
            if (props.segment.kind === "link") void props.onOpenLink(props.segment.href);
          }}
        >
          {props.segment.text}
        </a>
      </Match>
      <Match when={props.segment.kind === "mention"}>
        <span class={`message-mention ${formatClass()}`}>{props.segment.text}</span>
      </Match>
      <Match when={true}>
        <span class={formatClass()}>{props.segment.text}</span>
      </Match>
    </Switch>
  );
}

function formattingClass(styles: readonly WhatsAppInlineStyle[]) {
  return styles.map((style) => `whatsapp-format-${style}`).join(" ");
}

function LinkPreviewCard(props: {
  preview: LinkPreview;
  onOpenLink: (url: string) => Promise<void>;
}) {
  const target = () => safeHttpUrl(props.preview.url);
  const thumbnail = () => jpegDataUrl(props.preview.jpegThumbnail);
  return (
    <button
      type="button"
      class="link-preview"
      disabled={!target()}
      onClick={() => {
        const url = target();
        if (url) void props.onOpenLink(url);
      }}
    >
      <Show when={thumbnail()}>{(source) => <img src={source()} alt="" />}</Show>
      <span class="link-preview-meta">
        <strong>{props.preview.title || props.preview.url}</strong>
        <span>{props.preview.description}</span>
        <span class="link-preview-url" title={props.preview.url}>{props.preview.url}</span>
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
      <Show when={image()?.caption}>
        <div class="message-text whatsapp-text">
          <LinkifiedText text={image()?.caption ?? ""} mentions={props.message.mentionTexts} onOpenLink={props.model.actions.openExternalLink} />
        </div>
      </Show>
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
  let videoRef: HTMLVideoElement | undefined;
  const source = () => assetUrl(props.attachment.localPath);
  const isAudio = () => props.attachment.kind === "audio" || props.attachment.voiceNote;
  const isVideo = () => props.attachment.kind === "video";
  const isGif = () => isVideo() && props.attachment.animated;
  const failure = () => props.model.state.attachmentFailures[`${props.chatId}\u0000${props.message.id}`];
  const icon = () => (isAudio() ? <FileAudio size={23} /> : isVideo() ? <FileVideo size={23} /> : <FileText size={23} />);

  createEffect(() => {
    if (!videoRef || !isGif()) return;
    if (props.model.preferences.batterySaver) videoRef.pause();
    else void videoRef.play().catch(() => undefined);
  });

  return (
    <>
      <Show when={isVideo() && !playbackFailed() ? source() : undefined}>
        {(url) => (
          <video
            ref={videoRef}
            class={`message-image ${isGif() ? "gif" : ""}`}
            controls={!isGif() || props.model.preferences.batterySaver}
            autoplay={isGif() && !props.model.preferences.batterySaver}
            loop={isGif()}
            muted={isGif()}
            playsinline
            preload={isGif() && !props.model.preferences.batterySaver ? "auto" : "metadata"}
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
      <Show when={props.attachment.caption}>
        <div class="message-text whatsapp-text">
          <LinkifiedText text={props.attachment.caption} mentions={props.message.mentionTexts} onOpenLink={props.model.actions.openExternalLink} />
        </div>
      </Show>
    </>
  );
}

function MessageStatusIcon(props: { status: number }) {
  return (
    <Switch>
      <Match when={props.status === MessageStatus.Pending}><ThemeIcon icon={Clock3} name="clock" size={12} /></Match>
      <Match when={props.status === MessageStatus.Sent}><ThemeIcon icon={Check} name="check" size={13} /></Match>
      <Match when={props.status === MessageStatus.Delivered}><ThemeIcon icon={CheckCheck} name="check-double" size={14} /></Match>
      <Match when={props.status === MessageStatus.Read}><ThemeIcon icon={CheckCheck} name="check-double" class="read" size={14} /></Match>
      <Match when={props.status === MessageStatus.Failed}><ThemeIcon icon={TriangleAlert} name="warning" class="failed" size={13} /></Match>
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

function attachmentLabel(attachment: AttachmentContent): string {
  if (attachment.voiceNote) return "Voice message";
  if (attachment.kind === "video" && attachment.animated) return "GIF";
  if (attachment.kind === "video") return "Video";
  if (attachment.kind === "audio") return "Audio";
  return "Document";
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
