import { createEffect, createMemo, createSignal, For, Show } from "solid-js";
import { createVirtualizer } from "@tanstack/solid-virtual";
import {
  Archive,
  CheckCheck,
  LoaderCircle,
  MessageSquarePlus,
  Pin,
  Search,
  VolumeX,
  X,
} from "lucide-solid";
import type { AppModel, ChatFilter } from "../state/app";
import type {
  Chat,
  ContactSearchResult,
  MessageSearchResult,
} from "../lib/types";
import { ChatKind } from "../lib/types";
import { chatSubtitle, formatChatTime } from "../lib/format";
import { Avatar } from "./Avatar";
import { EmptyState, IconButton, Spinner } from "./Primitives";

interface SidebarProps {
  model: AppModel;
  searchInputRef?: (element: HTMLInputElement) => void;
}

export function Sidebar(props: SidebarProps) {
  const { state, actions } = props.model;
  let listRef: HTMLDivElement | undefined;
  let searchResultsRef: HTMLDivElement | undefined;
  const chats = createMemo(() => actions.filteredChats());
  const virtualizer = createVirtualizer<HTMLDivElement, HTMLDivElement>({
    get count() {
      return chats().length;
    },
    getScrollElement: () => listRef ?? null,
    estimateSize: () => 72 * state.uiScale,
    overscan: 8,
    getItemKey: (index) => chats()[index]?.id ?? index,
    onChange: (instance) => {
      const items = instance.getVirtualItems();
      const last = items.at(-1);
      if (last && last.index >= chats().length - 8) void actions.loadChats(false);
    },
  });

  const searchActive = () => state.searchQuery.trim().length >= 2;

  createEffect(() => {
    if (searchActive()) return;
    requestAnimationFrame(() => virtualizer.measure());
  });

  return (
    <aside class="sidebar" aria-label="Chats">
      <header class="sidebar-header">
        <h1 class="sidebar-title">Chats</h1>
        <IconButton label="New chat" onClick={() => focusSearch()}>
          <MessageSquarePlus size={20} />
        </IconButton>
      </header>

      <div class="sidebar-search-wrap">
        <label class="search-field">
          <Search size={17} />
          <input
            ref={props.searchInputRef}
            type="search"
            value={state.searchQuery}
            placeholder="Search or start a new chat"
            aria-label="Search contacts, groups, and messages"
            onInput={(event) => actions.updateSearch(event.currentTarget.value)}
            onKeyDown={(event) => {
              if (event.key === "Escape") {
                actions.clearSearch();
                event.currentTarget.blur();
              } else if (
                (event.key === "ArrowDown" || event.key === "ArrowUp") &&
                searchActive()
              ) {
                searchResultsRef?.focus();
                event.preventDefault();
              }
            }}
          />
          <Show when={state.searchQuery}>
            <IconButton label="Clear search" class="clear-search" onClick={actions.clearSearch}>
              <X size={16} />
            </IconButton>
          </Show>
        </label>
      </div>

      <Show when={!searchActive()}>
        <div class="chat-filters" role="tablist" aria-label="Chat filters">
          <FilterButton filter="all" label="All" model={props.model} />
          <FilterButton filter="unread" label="Unread" model={props.model} />
          <FilterButton filter="groups" label="Groups" model={props.model} />
          <FilterButton filter="archived" label="Archived" model={props.model} />
        </div>
      </Show>

      <div ref={listRef} class="chat-list" aria-label="Conversation list" hidden={searchActive()}>
        <Show
          when={chats().length > 0}
          fallback={
            <Show when={!state.loadingChats} fallback={<EmptyState title="Loading chats…"><Spinner /></EmptyState>}>
              <EmptyState title={emptyLabel(state.chatFilter)}>
                {state.chatFilter === "archived" ? <Archive size={22} /> : <CheckCheck size={22} />}
              </EmptyState>
            </Show>
          }
        >
          <div class="virtual-canvas" style={{ height: `${virtualizer.getTotalSize()}px` }}>
            <For each={virtualizer.getVirtualItems()}>
              {(virtualRow) => {
                const chat = () => chats()[virtualRow.index];
                return (
                  <div
                    class="virtual-row"
                    data-index={virtualRow.index}
                    style={{ transform: `translateY(${virtualRow.start}px)`, height: `${virtualRow.size}px` }}
                  >
                    <Show when={chat()}>{(value) => <ChatRow chat={value()} model={props.model} />}</Show>
                  </div>
                );
              }}
            </For>
          </div>
          <Show when={state.loadingChats && chats().length > 0}>
            <div class="sync-strip"><Spinner small label="Loading more chats" /></div>
          </Show>
        </Show>
      </div>

      <Show when={searchActive()}>
        <SearchResults model={props.model} ref={(element) => (searchResultsRef = element)} />
      </Show>

      <Show when={state.syncActive}>
        <div class="sync-strip">
          <span>Syncing {state.syncMessages.toLocaleString()} messages</span>
          <span class="progress-track" />
        </div>
      </Show>
    </aside>
  );

  function focusSearch() {
    const input = document.querySelector<HTMLInputElement>('.search-field input');
    input?.focus();
  }
}

function FilterButton(props: { filter: ChatFilter; label: string; model: AppModel }) {
  return (
    <button
      type="button"
      class={`filter-chip ${props.model.state.chatFilter === props.filter ? "active" : ""}`}
      role="tab"
      aria-selected={props.model.state.chatFilter === props.filter}
      onClick={() => props.model.actions.setFilter(props.filter)}
    >
      {props.label}
    </button>
  );
}

function ChatRow(props: { chat: Chat; model: AppModel }) {
  const { state, actions } = props.model;
  const typing = () => actions.typingLabel(props.chat.id);
  queueMicrotask(() => void actions.loadAvatar(props.chat.id));

  return (
    <button
      type="button"
      class={`chat-row ${state.selectedChatId === props.chat.id ? "selected" : ""} ${props.chat.unreadCount > 0 ? "unread" : ""}`}
      aria-current={state.selectedChatId === props.chat.id ? "page" : undefined}
      onClick={() => void actions.selectChat(props.chat.id)}
    >
      <Avatar
        name={props.chat.title || props.chat.phoneNumber}
        path={props.chat.avatarPath}
        size={49 * state.uiScale}
        group={props.chat.kind === ChatKind.Group}
      />
      <span class="chat-row-body">
        <span class="chat-row-line">
          <span class="chat-title">{props.chat.title || props.chat.phoneNumber || "Unknown contact"}</span>
          <span class="chat-time">{formatChatTime(props.chat.lastMessageTimestampMs)}</span>
        </span>
        <span class="chat-row-line">
          <span class={`chat-preview ${typing() ? "typing" : ""}`}>
            {typing() || chatSubtitle(props.chat)}
          </span>
          <span class="chat-flags">
            <Show when={props.chat.muted}><VolumeX size={14} /></Show>
            <Show when={props.chat.pinned}><Pin size={13} /></Show>
            <Show when={props.chat.unreadCount > 0}>
              <span class="chat-badge">{props.chat.unreadCount > 99 ? "99+" : props.chat.unreadCount}</span>
            </Show>
          </span>
        </span>
      </span>
    </button>
  );
}

type SearchRow =
  | { type: "heading"; label: string }
  | { type: "contact"; result: ContactSearchResult }
  | { type: "group"; result: Chat }
  | { type: "message"; result: MessageSearchResult };

function SearchResults(props: { model: AppModel; ref?: (element: HTMLDivElement) => void }) {
  const { state, actions } = props.model;
  const [selected, setSelected] = createSignal(0);
  const rows = createMemo<SearchRow[]>(() => {
    const results = state.searchResults;
    if (!results) return [];
    const next: SearchRow[] = [];
    if (results.contacts.length > 0) {
      next.push({ type: "heading", label: "Contacts" });
      next.push(...results.contacts.map((result) => ({ type: "contact" as const, result })));
    }
    if (results.groups.length > 0) {
      next.push({ type: "heading", label: "Groups" });
      next.push(...results.groups.map((result) => ({ type: "group" as const, result })));
    }
    if (results.messages.length > 0) {
      next.push({ type: "heading", label: "Messages" });
      next.push(...results.messages.map((result) => ({ type: "message" as const, result })));
    }
    return next;
  });
  const selectable = createMemo(() => rows().filter((row) => row.type !== "heading"));

  return (
    <div
      ref={props.ref}
      class="search-results"
      tabIndex={-1}
      onKeyDown={(event) => {
        if (event.key === "ArrowDown" || event.key === "ArrowUp") {
          const direction = event.key === "ArrowDown" ? 1 : -1;
          setSelected((value) => (value + direction + selectable().length) % Math.max(1, selectable().length));
          event.preventDefault();
        } else if (event.key === "Enter") {
          const row = selectable()[selected()];
          if (row) void activate(row);
        }
      }}
    >
      <Show when={state.searchLoading}>
        <EmptyState title="Searching…"><LoaderCircle class="spinner" size={22} /></EmptyState>
      </Show>
      <Show when={!state.searchLoading && state.searchError}>
        <EmptyState title={state.searchError}><X size={22} /></EmptyState>
      </Show>
      <Show when={!state.searchLoading && !state.searchError && state.searchResults && rows().length === 0}>
        <EmptyState title="No contacts, groups, or messages found"><Search size={22} /></EmptyState>
      </Show>
      <Show when={!state.searchLoading && rows().length > 0}>
        <For each={rows()}>
          {(row) => (
            <Show
              when={row.type !== "heading"}
              fallback={<div class="search-section-label">{row.type === "heading" ? row.label : ""}</div>}
            >
              <SearchResultRow
                row={row as Exclude<SearchRow, { type: "heading" }>}
                active={selectable()[selected()] === row}
                model={props.model}
                onActivate={() => void activate(row as Exclude<SearchRow, { type: "heading" }>)}
              />
            </Show>
          )}
        </For>
      </Show>
    </div>
  );

  async function activate(row: Exclude<SearchRow, { type: "heading" }>) {
    if (row.type === "contact") await actions.openContact(row.result);
    else if (row.type === "group") await actions.selectChat(row.result.id);
    else await actions.openMessageResult(row.result);
  }
}

function SearchResultRow(props: {
  row: Exclude<SearchRow, { type: "heading" }>;
  active: boolean;
  model: AppModel;
  onActivate: () => void;
}) {
  const title = () =>
    props.row.type === "contact"
      ? props.row.result.displayName
      : props.row.type === "group"
        ? props.row.result.title
        : props.row.result.chatTitle;
  const subtitle = () =>
    props.row.type === "contact"
      ? props.row.result.phoneNumber || props.row.result.secondaryName
      : props.row.type === "group"
        ? props.row.result.lastMessagePreview
        : `${props.row.result.senderName ? `${props.row.result.senderName}: ` : ""}${props.row.result.snippet}`;
  const avatarPath = () =>
    props.row.type === "group" ? props.row.result.avatarPath : "";

  return (
    <button
      type="button"
      class={`search-result-row ${props.active ? "selected" : ""}`}
      onClick={props.onActivate}
    >
      <Avatar
        name={title()}
        path={avatarPath()}
        size={42 * props.model.state.uiScale}
        group={props.row.type === "group"}
      />
      <span class="search-result-copy">
        <strong>{title()}</strong>
        <span>{subtitle()}</span>
      </span>
      <Show when={props.row.type === "message"}>
        <span class="chat-time">{formatChatTime((props.row as { type: "message"; result: MessageSearchResult }).result.timestampMs)}</span>
      </Show>
    </button>
  );
}

function emptyLabel(filter: ChatFilter): string {
  switch (filter) {
    case "unread":
      return "You're all caught up";
    case "groups":
      return "No groups loaded";
    case "archived":
      return "No archived chats";
    default:
      return "No chats yet";
  }
}
