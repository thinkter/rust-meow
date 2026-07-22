import {
  createMemo,
  createEffect,
  createSignal,
  For,
  on,
  Show,
} from "solid-js";
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
  X,
} from "lucide-solid";
import type { AppModel } from "../state/app";
import { ChatKind, ConnectionState, type Message } from "../lib/types";
import { connectionLabel, dayKey, formatDay, messageText } from "../lib/format";
import { Avatar } from "./Avatar";
import { Composer } from "./Composer";
import { MessageBubble } from "./MessageBubble";
import { IconButton, Spinner } from "./Primitives";

export function Conversation(props: { model: AppModel }) {
  const { state, actions } = props.model;
  let scrollRef: HTMLDivElement | undefined;
  let inChatSearchInput: HTMLInputElement | undefined;
  let initializedChat = "";
  const [newMessages, setNewMessages] = createSignal(0);
  const [searchOpen, setSearchOpen] = createSignal(false);
  const [searchQuery, setSearchQuery] = createSignal("");
  const [searchMatch, setSearchMatch] = createSignal(0);
  const [searchHighlight, setSearchHighlight] = createSignal("");
  const chat = () => actions.selectedChat();
  const messages = () => state.messages;
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
        state.uiScale,
        state.firstUnreadMessageId,
      ),
    overscan: 10,
    getItemKey: (index) => messages()[index]?.id ?? index,
    measureElement: (element) => element.getBoundingClientRect().height,
    onChange: (instance, sync) => {
      if (!sync) return;
      const items = instance.getVirtualItems();
      if (items[0]?.index === 0 && state.hasOlder && !state.loadingOlder) void loadOlderAnchored();
      const last = items.at(-1);
      if (last && last.index >= messages().length - 2 && state.hasNewer && !state.loadingNewer) {
        void actions.loadNewer();
      }
    },
  });

  createEffect(
    on(
      () => [state.selectedChatId, state.loadingMessages] as const,
      ([chatId, loading]) => {
        setSearchOpen(false);
        setSearchQuery("");
        setSearchHighlight("");
        if (!chatId || loading || messages().length === 0 || initializedChat === chatId) return;
        initializedChat = chatId;
        setNewMessages(0);
        requestAnimationFrame(() => {
          const unreadIndex = state.firstUnreadMessageId
            ? messages().findIndex((message) => message.id === state.firstUnreadMessageId)
            : -1;
          virtualizer.scrollToIndex(unreadIndex >= 0 ? unreadIndex : messages().length - 1, {
            align: unreadIndex >= 0 ? "start" : "end",
          });
        });
      },
    ),
  );

  createEffect(
    on(
      () => state.liveMessageVersion,
      () => {
        if (!scrollRef || messages().length === 0) return;
        const distance = scrollRef.scrollHeight - scrollRef.scrollTop - scrollRef.clientHeight;
        const latest = messages().at(-1);
        if (latest?.fromMe || distance < 180) {
          requestAnimationFrame(() => scrollToLatest("smooth"));
          setNewMessages(0);
        } else {
          setNewMessages((count) => count + 1);
        }
      },
      { defer: true },
    ),
  );

  return (
    <section class="conversation-shell" aria-label={chat()?.title || "Conversation"}>
      <header class="conversation-header">
        <IconButton label="Back to chats" class="compact-back" onClick={actions.closeChat}>
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
                        size={41 * state.uiScale}
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

      <div
        ref={scrollRef}
        class="message-scroller"
        aria-live="polite"
        onScroll={() => {
          if (!scrollRef) return;
          const distance = scrollRef.scrollHeight - scrollRef.scrollTop - scrollRef.clientHeight;
          if (distance < 80) setNewMessages(0);
        }}
      >
        <Show when={state.loadingMessages}>
          <div class="empty-state"><Spinner label="Loading messages" /></div>
        </Show>
        <Show when={!state.loadingMessages && state.messages.length === 0}>
          <div class="empty-state">
            <MessageCircleMore size={25} />
            <strong>No messages here yet. Say hello.</strong>
          </div>
        </Show>
        <Show when={!state.loadingMessages && state.messages.length > 0}>
          <div class="message-canvas" style={{ height: `${virtualizer.getTotalSize()}px` }}>
            <For each={virtualizer.getVirtualItems()}>
              {(virtualRow) => {
                const message = () => messages()[virtualRow.index];
                const previous = () => messages()[virtualRow.index - 1];
                const dateChanged = () =>
                  !previous() || dayKey(previous()!.timestampMs) !== dayKey(message()?.timestampMs ?? 0);
                const firstUnread = () => message()?.id === state.firstUnreadMessageId;
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
                    <Show when={message()}>
                      {(value) => (
                        <MessageBubble
                          message={value()}
                          model={props.model}
                          highlighted={
                            state.highlightedMessageId === value().id ||
                            searchHighlight() === value().id
                          }
                          onScrollToMessage={scrollToMessage}
                        />
                      )}
                    </Show>
                  </div>
                );
              }}
            </For>
          </div>
        </Show>
        <Show when={state.loadingOlder}>
          <div style={{ position: "sticky", top: "8px", display: "flex", "justify-content": "center", "z-index": 5 }}>
            <span class="date-separator" style={{ position: "static", transform: "none" }}><Spinner small label="Loading older messages" /></span>
          </div>
        </Show>
      </div>

      <Show when={newMessages() > 0 || state.hasNewer}>
        <button type="button" class="floating-jump" onClick={() => {
          if (state.hasNewer) void actions.jumpToLatest();
          else scrollToLatest("smooth");
          setNewMessages(0);
        }}>
          <ArrowDown size={17} />
          <span>{state.hasNewer ? "Jump to latest" : "New messages"}</span>
          <Show when={newMessages() > 0}><span class="count">{newMessages()}</span></Show>
        </button>
      </Show>

      <Composer model={props.model} />
    </section>
  );

  async function loadOlderAnchored() {
    if (!scrollRef) return;
    const previousHeight = scrollRef.scrollHeight;
    const previousTop = scrollRef.scrollTop;
    await actions.loadOlder();
    requestAnimationFrame(() => {
      if (scrollRef) scrollRef.scrollTop = previousTop + scrollRef.scrollHeight - previousHeight;
    });
  }

  function scrollToLatest(behavior: ScrollBehavior = "auto") {
    if (!scrollRef) return;
    scrollRef.scrollTo({ top: scrollRef.scrollHeight, behavior });
  }

  function scrollToMessage(messageId: string) {
    const index = messages().findIndex((message) => message.id === messageId);
    if (index >= 0) {
      virtualizer.scrollToIndex(index, { align: "center" });
      return;
    }
    showNotYet("That message is outside the loaded history. Use global search to jump to it.");
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

  function showNotYet(message: string) {
    // Keep unsupported actions honest without interrupting the current chat.
    console.info(message);
  }
}

function estimateMessageHeight(
  message: Message | undefined,
  index: number,
  messages: readonly Message[],
  scale: number,
  firstUnreadMessageId: string,
): number {
  if (!message) return 68 * scale;
  let height = 48;
  if (message.senderName && !message.fromMe) height += 18;
  if (message.replyToMessageId) height += 55;
  if (message.content) {
    if ("text" in message.content) height += Math.min(170, message.content.text.text.length * 0.32);
    else if ("image" in message.content) height += message.content.image.sticker ? 200 : 285;
    else if ("attachment" in message.content) height += 62;
    else if ("contacts" in message.content) height += message.content.contacts.contacts.length * 60;
    else height += 58;
  }
  if (message.reactions.length > 0) height += 28;
  if (index === 0 || dayKey(messages[index - 1]?.timestampMs ?? 0) !== dayKey(message.timestampMs)) {
    height += 42;
  }
  if (message.id === firstUnreadMessageId) height += 35;
  return height * scale;
}

function conversationSubtitle(kind: number, phoneNumber: string): string {
  if (kind === ChatKind.Group) return "Tap for group info";
  return phoneNumber || "Tap for contact info";
}
