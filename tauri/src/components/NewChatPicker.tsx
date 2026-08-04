import { createMemo, createSignal, For, onMount, Show } from "solid-js";
import { MessageCircleMore, Search } from "lucide-solid";
import type { AppModel } from "../state/app";
import type { Chat, ContactSearchResult } from "../lib/types";
import { ChatKind } from "../lib/types";
import { Avatar } from "./Avatar";
import { EmptyState, Spinner } from "./Primitives";
import { ThemeIcon } from "./ThemeIcon";

type PersonChoice =
  | { type: "chat"; chat: Chat }
  | { type: "contact"; contact: ContactSearchResult };

/** The default surface shown by a newly-created tab. */
export function NewChatPicker(props: { model: AppModel; paneId: string }) {
  const { state, actions, preferences } = props.model;
  const [opening, setOpening] = createSignal(false);
  let inputRef: HTMLInputElement | undefined;
  let resultsRef: HTMLDivElement | undefined;

  const query = () => state.searchQuery.trim().toLocaleLowerCase();
  const remoteSearch = () => query().length >= 2;
  const matches = (chat: Chat) => {
    const needle = query();
    if (!needle) return true;
    return [
      chat.title,
      chat.phoneNumber,
      chat.contactName,
      chat.pushName,
      chat.businessName,
    ].some((value) => value.toLocaleLowerCase().includes(needle));
  };

  const people = createMemo<PersonChoice[]>(() => {
    if (remoteSearch()) {
      return (state.searchResults?.contacts ?? []).map((contact) => ({
        type: "contact" as const,
        contact,
      }));
    }
    return state.chats
      .filter((chat) => chat.kind === ChatKind.Direct && matches(chat))
      .map((chat) => ({ type: "chat" as const, chat }));
  });

  const groups = createMemo(() => {
    if (remoteSearch()) return state.searchResults?.groups ?? [];
    return state.chats.filter((chat) => chat.kind === ChatKind.Group && matches(chat));
  });

  const noResults = () =>
    !state.searchLoading && !state.searchError && people().length === 0 && groups().length === 0;

  onMount(() => {
    requestAnimationFrame(() => inputRef?.focus());
  });

  async function choosePerson(choice: PersonChoice) {
    if (opening()) return;
    setOpening(true);
    try {
      if (choice.type === "chat") {
        await actions.selectChat(choice.chat.id, "", props.paneId);
      } else {
        await actions.openContact(choice.contact, props.paneId);
      }
    } finally {
      setOpening(false);
    }
  }

  async function chooseGroup(group: Chat) {
    if (opening()) return;
    setOpening(true);
    try {
      await actions.selectChat(group.id, "", props.paneId);
    } finally {
      setOpening(false);
    }
  }

  function personName(choice: PersonChoice) {
    return choice.type === "chat"
      ? choice.chat.title || choice.chat.phoneNumber || "Unknown contact"
      : choice.contact.displayName || choice.contact.phoneNumber || "Unknown contact";
  }

  function personDetail(choice: PersonChoice) {
    if (choice.type === "chat") {
      return choice.chat.phoneNumber || choice.chat.lastMessagePreview || "Contact";
    }
    return choice.contact.secondaryName || choice.contact.phoneNumber || "Contact";
  }

  function personAvatar(choice: PersonChoice) {
    if (choice.type === "chat") return choice.chat.avatarPath;
    return state.chats.find((chat) => chat.id === choice.contact.chatId)?.avatarPath ?? "";
  }

  return (
    <section
      id={`tabpanel-${props.paneId}-new-chat`}
      class="new-chat-picker"
      role="tabpanel"
      aria-labelledby={`tab-${props.paneId}-new-chat`}
    >
      <div class="new-chat-picker-header">
        <div class="new-chat-picker-title">
          <span class="new-chat-picker-icon">
            <ThemeIcon icon={MessageCircleMore} name="messages" size={24} />
          </span>
          <div>
            <h2>New chat</h2>
            <p>Choose a person or group to open in this tab.</p>
          </div>
        </div>
        <label class="search-field new-chat-search">
          <ThemeIcon icon={Search} name="search" size={17} />
          <input
            ref={inputRef}
            type="search"
            value={state.searchQuery}
            placeholder="Search people and groups"
            aria-label="Search people and groups"
            onInput={(event) => actions.updateSearch(event.currentTarget.value)}
            onKeyDown={(event) => {
              if (event.key === "Escape") {
                if (state.searchQuery) actions.clearSearch();
                else actions.closeNewTab(props.paneId);
                event.preventDefault();
              } else if (event.key === "ArrowDown") {
                resultsRef?.querySelector<HTMLButtonElement>("button")?.focus();
                event.preventDefault();
              }
            }}
          />
        </label>
      </div>

      <div
        ref={resultsRef}
        class="new-chat-picker-results"
        aria-live="polite"
        aria-busy={state.searchLoading}
      >
        <Show when={state.searchLoading}>
          <EmptyState><Spinner label="Searching people and groups" /></EmptyState>
        </Show>
        <Show when={!state.searchLoading && state.searchError}>
          <EmptyState title={state.searchError}>
            <ThemeIcon icon={Search} name="search" size={22} />
          </EmptyState>
        </Show>
        <Show when={!state.searchLoading && !state.searchError}>
          <Show when={people().length > 0}>
            <section class="new-chat-picker-section" aria-labelledby={`people-${props.paneId}`}>
              <h3 id={`people-${props.paneId}`}>People</h3>
              <For each={people()}>
                {(choice) => (
                  <button
                    type="button"
                    class="new-chat-picker-row"
                    disabled={opening()}
                    onClick={() => void choosePerson(choice)}
                  >
                    <Avatar
                      name={personName(choice)}
                      path={personAvatar(choice)}
                      size={42 * preferences.uiScale}
                    />
                    <span class="new-chat-picker-copy">
                      <strong>{personName(choice)}</strong>
                      <span>{personDetail(choice)}</span>
                    </span>
                  </button>
                )}
              </For>
            </section>
          </Show>
          <Show when={groups().length > 0}>
            <section class="new-chat-picker-section" aria-labelledby={`groups-${props.paneId}`}>
              <h3 id={`groups-${props.paneId}`}>Groups</h3>
              <For each={groups()}>
                {(group) => (
                  <button
                    type="button"
                    class="new-chat-picker-row"
                    disabled={opening()}
                    onClick={() => void chooseGroup(group)}
                  >
                    <Avatar
                      name={group.title || "Group"}
                      path={group.avatarPath}
                      size={42 * preferences.uiScale}
                      group
                    />
                    <span class="new-chat-picker-copy">
                      <strong>{group.title || "Unnamed group"}</strong>
                      <span>{group.lastMessagePreview || "Group"}</span>
                    </span>
                  </button>
                )}
              </For>
            </section>
          </Show>
          <Show when={noResults()}>
            <EmptyState title={query() ? "No people or groups found" : "No chats loaded yet"}>
              <ThemeIcon icon={Search} name="search" size={22} />
            </EmptyState>
          </Show>
        </Show>
      </div>
    </section>
  );
}
