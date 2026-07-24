import { createEffect, createMemo, createSignal, For, Match, on, onCleanup, Show, Switch } from "solid-js";
import { createVirtualizer } from "@tanstack/solid-virtual";
import {
  ArrowDown,
  ArrowLeft,
  ChevronDown,
  ChevronUp,
  CircleAlert,
  MessageCircleMore,
  MoreVertical,
  Search,
  UsersRound,
  X,
  Pin,
} from "lucide-solid";
import type { AppModel } from "../state/app";
import type { Density } from "../state/preferences";
import { ChatKind, ConnectionState, type Message } from "../lib/types";
import { connectionLabel, dayKey, formatDay, formatTime, messageText } from "../lib/format";
import { indexMessages } from "../lib/performance";
import {
  captureScrollSnapshot,
  resolveScrollRestore,
  type ScrollSnapshot,
} from "../state/scroll-restoration";
import { Avatar } from "./Avatar";
import { Composer } from "./Composer";
import { MessageBubble } from "./MessageBubble";
import { EmptyState, IconButton, Spinner } from "./Primitives";

/**
 * One conversation pane's worth of chrome: header, message list, jump-to-
 * latest floater, composer. Everything here is scoped to `props.chatId`
 * (never `state.selectedChatId`) because two panes can each host one of
 * these at the same time — see `actions.conversation(chatId)` in
 * `state/app.ts`. The one deliberate exception is `actions.showChatInfo`,
 * `actions.closeChat` and the `Composer`, which the current `AppModel`/
 * `Composer` API only expose against the *focused* pane; see the BUBBLE
 * agent report for that residual gap.
 */
export function Conversation(props: { model: AppModel; chatId: string; paneId: string }) {
  const { state, actions, preferences } = props.model;
  let scrollRef: HTMLDivElement | undefined;
  let inChatSearchInput: HTMLInputElement | undefined;
  let initializedViewportKey = "";
  let restoringViewport = false;
  let captureFrame: number | undefined;
  const viewportSnapshots = new Map<string, ScrollSnapshot>();
  const [newMessages, setNewMessages] = createSignal(0);
  const [farFromBottom, setFarFromBottom] = createSignal(false);
  const [searchOpen, setSearchOpen] = createSignal(false);
  const [searchQuery, setSearchQuery] = createSignal("");
  const [searchMatch, setSearchMatch] = createSignal(0);
  const [searchHighlight, setSearchHighlight] = createSignal("");
  const [activePinIndex, setActivePinIndex] = createSignal(0);
  const [pinsExpanded, setPinsExpanded] = createSignal(false);

  const conversation = () => actions.conversation(props.chatId);
  const chat = () => state.chats.find((candidate) => candidate.id === props.chatId);
  const messages = () => conversation().messages;
  const isGroup = () => chat()?.kind === ChatKind.Group;
  const messageIndex = createMemo(() => indexMessages(messages()));
  const pins = createMemo(() => state.pinnedMessages[props.chatId] ?? []);
  const activePin = () => pins()[activePinIndex()];

  createEffect(on(() => props.chatId, () => {
    setActivePinIndex(0);
    setPinsExpanded(false);
  }));
  createEffect(() => {
    const count = pins().length;
    setActivePinIndex((index) => Math.min(index, Math.max(0, count - 1)));
  });

  const searchMatches = createMemo(() => {
    const query = searchQuery().trim().toLocaleLowerCase();
    if (!query) return [];
    return messages()
      .map((message, index) => ({ message, index }))
      .filter(({ message }) => messageText(message).toLocaleLowerCase().includes(query));
  });

  const virtualizer = createVirtualizer<HTMLDivElement, HTMLDivElement>({
    get count() {
      return messages().length;
    },
    getScrollElement: () => scrollRef ?? null,
    estimateSize: (index) =>
      estimateMessageHeight(
        messages()[index],
        index,
        messages(),
        preferences.uiScale,
        conversation().firstUnreadMessageId,
        isGroup(),
        preferences.density,
      ),
    get overscan() {
      return preferences.batterySaver ? 4 : 10;
    },
    getItemKey: (index) => messages()[index]?.id ?? index,
    measureElement: (element) => element.getBoundingClientRect().height,
    onChange: (instance, sync) => {
      if (!sync) return;
      const items = instance.getVirtualItems();
      const conv = conversation();
      if (items[0]?.index === 0 && conv.hasOlder && !conv.loadingOlder) void loadOlderAnchored();
      const last = items.at(-1);
      if (last && last.index >= messages().length - 2 && conv.hasNewer && !conv.loadingNewer) {
        void actions.loadNewer(props.chatId);
      }
    },
  });

  // Chat switched within this pane (tab click, `selectChat`, …) — drop any
  // state that belonged to the previous chat immediately, independent of
  // whether the new chat's window has finished loading yet. Without this a
  // pane could briefly show "Jump to latest" left over from the chat it was
  // just showing.
  createEffect(
    on(
      () => props.chatId,
      () => {
        restoringViewport = true;
        if (captureFrame !== undefined) cancelAnimationFrame(captureFrame);
        setNewMessages(0);
        setFarFromBottom(false);
      },
    ),
  );

  createEffect(
    on(
      () => [props.chatId, conversation().loading, conversation().highlightedMessageId] as const,
      ([currentChatId, loading, highlightedMessageId]) => {
        setSearchOpen(false);
        setSearchQuery("");
        setSearchHighlight("");
        const viewportKey = `${props.paneId}:${currentChatId}`;
        if (!currentChatId || loading || messages().length === 0) return;
        if (highlightedMessageId) {
          const highlightedIndex = messages().findIndex((message) => message.id === highlightedMessageId);
          if (highlightedIndex >= 0) {
            initializedViewportKey = viewportKey;
            requestAnimationFrame(() => {
              virtualizer.scrollToIndex(highlightedIndex, { align: "center" });
              restoringViewport = false;
            });
          }
          return;
        }
        if (initializedViewportKey === viewportKey) return;
        initializedViewportKey = viewportKey;
        setNewMessages(0);
        setFarFromBottom(false);
        requestAnimationFrame(() => {
          const target = resolveScrollRestore(
            messages().map((message) => message.id),
            viewportSnapshots.get(viewportKey),
            conversation().firstUnreadMessageId,
          );
          if (target.kind === "anchor") {
            virtualizer.scrollToIndex(target.index, { align: "start" });
            requestAnimationFrame(() => {
              if (scrollRef) scrollRef.scrollTop -= target.offset;
              restoringViewport = false;
            });
          } else if (target.kind === "unread") {
            virtualizer.scrollToIndex(target.index, { align: "start" });
            requestAnimationFrame(() => { restoringViewport = false; });
          } else if (target.kind === "latest") {
            virtualizer.scrollToIndex(target.index, { align: "end" });
            requestAnimationFrame(() => {
              scrollToLatest();
              restoringViewport = false;
            });
          } else {
            restoringViewport = false;
          }
        });
      },
    ),
  );

  createEffect(
    on(
      () => conversation().liveMessageVersion,
      () => {
        if (!scrollRef || messages().length === 0) return;
        const distance = scrollRef.scrollHeight - scrollRef.scrollTop - scrollRef.clientHeight;
        const latest = messages().at(-1);
        if (latest?.fromMe || distance < 180) {
          requestAnimationFrame(() => scrollToLatest(preferredScrollBehavior()));
          setNewMessages(0);
        } else {
          setNewMessages((count) => count + 1);
        }
      },
      { defer: true },
    ),
  );

  return (
    <section
      class="conversation-shell"
      id={`tabpanel-${props.paneId}-${props.chatId}`}
      role="tabpanel"
      aria-labelledby={preferences.showTabBar ? `tab-${props.paneId}-${props.chatId}` : undefined}
      aria-label={preferences.showTabBar ? undefined : (chat()?.title || "Conversation")}
    >
      <header class="conversation-header">
        <IconButton
          label="Back to chats"
          class="compact-back"
          onClick={() => props.model.prefActions.update("sidebarCollapsed", false)}
        >
          <ArrowLeft size={21} />
        </IconButton>
        <Show
          when={searchOpen()}
          fallback={
            <>
              <button type="button" class="conversation-contact" onClick={() => void actions.showChatInfo()}>
                <Show when={chat()}>
                  {(value) => (
                    <>
                      <Avatar
                        name={value().title || value().phoneNumber}
                        path={value().avatarPath}
                        size={41 * preferences.uiScale}
                        group={value().kind === ChatKind.Group}
                      />
                      <span class="conversation-heading">
                        <strong>{value().title || value().phoneNumber}</strong>
                        <span class={actions.typingLabel(value().id) ? "typing" : ""}>
                          {actions.typingLabel(value().id) || conversationSubtitle(value().kind, value().phoneNumber)}
                        </span>
                      </span>
                    </>
                  )}
                </Show>
              </button>
              <IconButton label="Search in chat" onClick={openSearch}>
                <Search size={19} />
              </IconButton>
              <Show when={chat()?.kind === ChatKind.Group}>
                <IconButton
                  label={preferences.memberPanelOpen ? "Hide members" : "Show members"}
                  active={preferences.memberPanelOpen}
                  onClick={() => props.model.prefActions.update("memberPanelOpen", !preferences.memberPanelOpen)}
                >
                  <UsersRound size={19} />
                </IconButton>
              </Show>
              <IconButton label="Conversation menu" onClick={() => void actions.showChatInfo()}>
                <MoreVertical size={20} />
              </IconButton>
            </>
          }
        >
          <label class="conversation-search">
            <Search size={17} />
            <input
              ref={inChatSearchInput}
              type="search"
              value={searchQuery()}
              placeholder="Search loaded messages"
              aria-label="Search loaded messages in this chat"
              onInput={(event) => updateInChatSearch(event.currentTarget.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter") {
                  navigateSearch(event.shiftKey ? -1 : 1);
                  event.preventDefault();
                } else if (event.key === "Escape") {
                  closeSearch();
                  event.preventDefault();
                }
              }}
            />
            <span aria-live="polite">
              {searchQuery().trim()
                ? searchMatches().length > 0
                  ? `${searchMatch() + 1} of ${searchMatches().length}`
                  : "No matches"
                : ""}
            </span>
          </label>
          <IconButton label="Previous match" disabled={searchMatches().length === 0} onClick={() => navigateSearch(-1)}>
            <ChevronUp size={19} />
          </IconButton>
          <IconButton label="Next match" disabled={searchMatches().length === 0} onClick={() => navigateSearch(1)}>
            <ChevronDown size={19} />
          </IconButton>
          <IconButton label="Close search" onClick={closeSearch}><X size={19} /></IconButton>
        </Show>
      </header>

      <Show when={state.connection !== ConnectionState.Connected}>
        <div class="connection-banner">
          <CircleAlert size={15} />
          <span>{connectionLabel(state.connection)}{state.connectionDetail ? ` · ${state.connectionDetail}` : ""}</span>
        </div>
      </Show>

      <Show when={activePin()}>
        {(pin) => <div class="pinned-messages" aria-label="Pinned messages">
          <div class="pinned-message-banner">
            <span class="pinned-message-marker"><Pin size={16} /></span>
            <button
              type="button"
              class="pinned-message-current"
              disabled={!pin().available}
              title={pin().available ? "Open pinned message" : "Pinned message is unavailable"}
              onClick={() => scrollToMessage(pin().messageId)}
            >
              <strong>{pins().length === 1 ? "Pinned message" : `${pins().length} pinned messages`}</strong>
              <span>{pin().message ? messageText(pin().message!).slice(0, 110) || "Media message" : "Pinned message is unavailable"}</span>
              <small>{pin().pinnedAtMs > 0 ? formatTime(pin().pinnedAtMs) : ""}</small>
            </button>
            <Show when={pins().length > 1}>
              <span class="pinned-message-position">{activePinIndex() + 1}/{pins().length}</span>
              <IconButton label="Previous pinned message" disabled={activePinIndex() === 0} onClick={() => setActivePinIndex((index) => Math.max(0, index - 1))}><ChevronUp size={17} /></IconButton>
              <IconButton label="Next pinned message" disabled={activePinIndex() >= pins().length - 1} onClick={() => setActivePinIndex((index) => Math.min(pins().length - 1, index + 1))}><ChevronDown size={17} /></IconButton>
              <IconButton label={pinsExpanded() ? "Hide all pinned messages" : "Show all pinned messages"} active={pinsExpanded()} onClick={() => setPinsExpanded((expanded) => !expanded)}><MoreVertical size={17} /></IconButton>
            </Show>
            <IconButton label="Unpin message" onClick={() => void actions.setMessagePin(pin().messageId, false, props.chatId)}><X size={17} /></IconButton>
          </div>
          <Show when={pinsExpanded() && pins().length > 1}>
            <div class="pinned-message-list">
              <For each={pins()}>{(item, index) => (
                <button
                  type="button"
                  class={index() === activePinIndex() ? "active" : ""}
                  disabled={!item.available}
                  onClick={() => {
                    setActivePinIndex(index());
                    scrollToMessage(item.messageId);
                  }}
                >
                  <Pin size={13} />
                  <span>{item.message ? messageText(item.message).slice(0, 90) || "Media message" : "Pinned message is unavailable"}</span>
                  <small>{item.pinnedAtMs > 0 ? formatTime(item.pinnedAtMs) : ""}</small>
                </button>
              )}</For>
            </div>
          </Show>
        </div>
        }</Show>

      <div
        ref={scrollRef}
        class="message-scroller"
        aria-live="polite"
        onScroll={scheduleScrollStateUpdate}
      >
        <Switch>
          <Match when={conversation().loading}>
          <EmptyState><Spinner label="Loading messages" /></EmptyState>
          </Match>
          <Match when={messages().length === 0}>
            <EmptyState title="No messages here yet. Say hello."><MessageCircleMore size={25} /></EmptyState>
          </Match>
          <Match when={true}>
          <div class="message-canvas" style={{ height: `${virtualizer.getTotalSize()}px` }}>
            <For each={virtualizer.getVirtualItems()}>
              {(virtualRow) => {
                const message = () => messages()[virtualRow.index];
                const previous = () => messages()[virtualRow.index - 1];
                const dateChanged = () =>
                  !previous() || dayKey(previous()!.timestampMs) !== dayKey(message()?.timestampMs ?? 0);
                const firstUnread = () => message()?.id === conversation().firstUnreadMessageId;
                // Consecutive incoming group messages from the same sender
                // within 5 minutes share one avatar/sender line — G1.
                const grouped = () =>
                  isGroupedWithPrevious(message(), previous(), isGroup()) && !firstUnread();
                const showAvatarGutter = () => isGroup() && Boolean(message()) && !message()!.fromMe;
                return (
                  <div
                    class={`message-row ${message()?.fromMe ? "from-me" : ""} ${dateChanged() ? "with-date" : ""} ${firstUnread() ? "with-unread" : ""}`}
                    data-index={virtualRow.index}
                    ref={(element) => {
                      element.dataset.index = String(virtualRow.index);
                      requestAnimationFrame(() => {
                        if (element.isConnected) virtualizer.measureElement(element);
                      });
                    }}
                    style={{ transform: `translateY(${virtualRow.start}px)` }}
                  >
                    <Show when={dateChanged() && message()}>
                      <div class="date-separator">{formatDay(message()!.timestampMs)}</div>
                    </Show>
                    <Show when={firstUnread()}>
                      <div class="unread-separator"><span>Unread messages</span></div>
                    </Show>
                    <Show when={showAvatarGutter()}>
                      <Show when={!grouped()} fallback={<div class="message-avatar-spacer" aria-hidden="true" />}>
                        <GroupAvatar model={props.model} message={message()!} scale={preferences.uiScale} />
                      </Show>
                    </Show>
                    <Show when={message()}>
                      {(value) => (
                        <MessageBubble
                          message={value()}
                          model={props.model}
                          chatId={props.chatId}
                          highlighted={
                            conversation().highlightedMessageId === value().id ||
                            searchHighlight() === value().id
                          }
                          suppressSender={grouped()}
                          quotedMessage={
                            value().replyToMessageId
                              ? (value().replyToChatId && value().replyToChatId !== props.chatId
                                  ? state.conversations[value().replyToChatId]?.messages.find(
                                      (candidate) => candidate.id === value().replyToMessageId,
                                    )
                                  : messageIndex().byId.get(value().replyToMessageId))
                              : undefined
                          }
                          replyCount={messageIndex().replyCountById.get(value().id) ?? 0}
                          firstReplyMessageId={messageIndex().firstReplyIdById.get(value().id)}
                          onScrollToMessage={scrollToMessage}
                        />
                      )}
                    </Show>
                  </div>
                );
              }}
            </For>
          </div>
          </Match>
        </Switch>
        <Show when={conversation().loadingOlder}>
          <div style={{ position: "sticky", top: "8px", display: "flex", "justify-content": "center", "z-index": 5 }}>
            <span class="date-separator" style={{ position: "static", transform: "none" }}><Spinner small label="Loading older messages" /></span>
          </div>
        </Show>
      </div>

      <Show when={newMessages() > 0 || conversation().hasNewer || farFromBottom()}>
        <button
          type="button"
          class="floating-jump"
          onClick={() => {
            if (conversation().hasNewer) {
              void actions.jumpToLatest(props.chatId).then(() => {
                requestAnimationFrame(() => scrollToLatest(preferredScrollBehavior()));
              });
            } else scrollToLatest(preferredScrollBehavior());
            setNewMessages(0);
            setFarFromBottom(false);
          }}
        >
          <ArrowDown size={17} />
          <span>Jump to latest</span>
          <Show when={newMessages() > 0}><span class="count">{newMessages()}</span></Show>
        </button>
      </Show>

      <Composer model={props.model} chatId={props.chatId} />
    </section>
  );

  async function loadOlderAnchored() {
    if (!scrollRef) return;
    const previousHeight = scrollRef.scrollHeight;
    const previousTop = scrollRef.scrollTop;
    await actions.loadOlder(props.chatId);
    requestAnimationFrame(() => {
      if (scrollRef) scrollRef.scrollTop = previousTop + scrollRef.scrollHeight - previousHeight;
    });
  }

  function scrollToLatest(behavior: ScrollBehavior = "auto") {
    if (!scrollRef) return;
    scrollRef.scrollTo({ top: scrollRef.scrollHeight, behavior });
  }

  function preferredScrollBehavior(): ScrollBehavior {
    return preferences.batterySaver ? "auto" : "smooth";
  }

  function scheduleScrollStateUpdate() {
    if (captureFrame !== undefined) return;
    captureFrame = window.requestAnimationFrame(() => {
      captureFrame = undefined;
      if (!scrollRef) return;
      const distance = scrollRef.scrollHeight - scrollRef.scrollTop - scrollRef.clientHeight;
      if (distance < 80) setNewMessages(0);
      setFarFromBottom(distance > scrollRef.clientHeight * 1.5);
      if (restoringViewport) return;
      const snapshot = captureScrollSnapshot(
        messages().map((message) => message.id),
        virtualizer.getVirtualItems(),
        scrollRef.scrollTop,
        scrollRef.scrollHeight,
        scrollRef.clientHeight,
      );
      if (snapshot) viewportSnapshots.set(`${props.paneId}:${props.chatId}`, snapshot);
    });
  }

  onCleanup(() => {
    if (captureFrame !== undefined) window.cancelAnimationFrame(captureFrame);
  });

  function scrollToMessage(messageId: string) {
    const index = messages().findIndex((message) => message.id === messageId);
    if (index >= 0) {
      virtualizer.scrollToIndex(index, { align: "center" });
      return;
    }
    void actions.selectChat(props.chatId, messageId, props.paneId);
  }

  function openSearch() {
    setSearchOpen(true);
    requestAnimationFrame(() => inChatSearchInput?.focus());
  }

  function closeSearch() {
    setSearchOpen(false);
    setSearchQuery("");
    setSearchMatch(0);
    setSearchHighlight("");
  }

  function updateInChatSearch(query: string) {
    setSearchQuery(query);
    setSearchMatch(0);
    queueMicrotask(() => revealSearchMatch(0));
  }

  function navigateSearch(direction: -1 | 1) {
    const matches = searchMatches();
    if (matches.length === 0) return;
    const next = (searchMatch() + direction + matches.length) % matches.length;
    setSearchMatch(next);
    revealSearchMatch(next);
  }

  function revealSearchMatch(position: number) {
    const match = searchMatches()[position];
    if (!match) {
      setSearchHighlight("");
      return;
    }
    setSearchHighlight(match.message.id);
    virtualizer.scrollToIndex(match.index, { align: "center" });
  }

}

/** The left-gutter avatar for a group message — its own component so the
 * hydration effect gets a real Solid owner/cleanup scope as rows are
 * virtualized in and out, matching how `ImageMessage` hydrates in
 * `MessageBubble.tsx`. */
function GroupAvatar(props: { model: AppModel; message: Message; scale: number }) {
  const { state, actions } = props.model;
  createEffect(() => {
    const senderId = props.message.senderId;
    if (!senderId) return;
    const cancel = actions.loadParticipantAvatar(senderId, props.message.chatId);
    onCleanup(cancel);
  });
  return (
    <Avatar
      class="message-avatar"
      name={props.message.senderName || props.message.senderPhoneNumber}
      path={state.participantAvatars[props.message.senderId]}
      size={30 * props.scale}
    />
  );
}

/** Same 5-minute/same-sender/same-day rule the renderer and the virtualizer
 * estimator both need to agree on — G1's grouping and G11's height math. */
function isGroupedWithPrevious(
  message: Message | undefined,
  previous: Message | undefined,
  isGroup: boolean,
): boolean {
  if (!isGroup || !message || message.fromMe || !previous || previous.fromMe) return false;
  if (!message.senderId || previous.senderId !== message.senderId) return false;
  if (dayKey(previous.timestampMs) !== dayKey(message.timestampMs)) return false;
  return message.timestampMs - previous.timestampMs <= 5 * 60 * 1000;
}

function estimateMessageHeight(
  message: Message | undefined,
  index: number,
  messages: readonly Message[],
  scale: number,
  firstUnreadMessageId: string,
  isGroup: boolean,
  density: Density,
): number {
  const compact = density === "compact";
  if (!message) return (compact ? 42 : 68) * scale;
  const grouped =
    isGroupedWithPrevious(message, messages[index - 1], isGroup) && message.id !== firstUnreadMessageId;
  // Compact hides the avatar gutter entirely (styles.css), so only
  // comfortable density needs the avatar-row floor below.
  const showsAvatarGutter = isGroup && !message.fromMe && !compact;
  let height = compact ? 30 : 48;
  if (message.senderName && !message.fromMe && !grouped) height += compact ? 13 : 18;
  if (message.replyToMessageId) height += compact ? 42 : 55;
  if (message.content) {
    if ("text" in message.content) {
      height += Math.min(compact ? 130 : 170, message.content.text.text.length * (compact ? 0.26 : 0.32));
    } else if ("image" in message.content) {
      height += message.content.image.sticker ? (compact ? 165 : 200) : compact ? 230 : 285;
    } else if ("attachment" in message.content) {
      height += compact ? 50 : 62;
    } else if ("contacts" in message.content) {
      height += message.content.contacts.contacts.length * (compact ? 48 : 60);
    } else {
      height += compact ? 46 : 58;
    }
  }
  if (message.reactions.length > 0) height += compact ? 20 : 28;
  if (index === 0 || dayKey(messages[index - 1]?.timestampMs ?? 0) !== dayKey(message.timestampMs)) {
    height += compact ? 34 : 42;
  }
  if (message.id === firstUnreadMessageId) height += compact ? 28 : 35;
  // Avatar (30px) + its bottom margin (3px) sets a floor even for a very
  // short bubble, or the virtualizer under-sizes rows that are just an
  // avatar-height tall and scroll position drifts — G1 + G11.
  if (showsAvatarGutter) height = Math.max(height, 34);
  return height * scale;
}

function conversationSubtitle(kind: number, phoneNumber: string): string {
  if (kind === ChatKind.Group) return "Tap for group info";
  return phoneNumber || "Tap for contact info";
}
