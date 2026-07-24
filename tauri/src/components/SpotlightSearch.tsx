import {
  createEffect,
  createMemo,
  createSignal,
  For,
  Match,
  onCleanup,
  Show,
  Switch,
} from "solid-js";
import {
  ArrowDown,
  ArrowUp,
  Command,
  CornerDownLeft,
  MessageSquareText,
  Search,
  X,
} from "lucide-solid";
import type { AppModel } from "../state/app";
import { bridge, normalizeBridgeError } from "../lib/bridge";
import { formatChatTime } from "../lib/format";
import {
  rankSpotlightChats,
  readSpotlightUsage,
  type SpotlightChatMatch,
} from "../lib/spotlight";
import {
  ChatKind,
  type Chat,
  type ContactSearchResult,
  type MessageSearchResult,
  type SearchResults,
} from "../lib/types";
import { Avatar } from "./Avatar";
import { EmptyState, Spinner } from "./Primitives";
import { ThemeIcon } from "./ThemeIcon";

type SpotlightRow =
  | { type: "chat"; match: SpotlightChatMatch }
  | { type: "contact"; result: ContactSearchResult }
  | { type: "group"; result: Chat }
  | { type: "message"; result: MessageSearchResult };

interface SpotlightSection {
  label: string;
  rows: SpotlightRow[];
}

export function SpotlightSearch(props: {
  model: AppModel;
  open: boolean;
  onClose: () => void;
}) {
  const { state, actions, preferences } = props.model;
  const [query, setQuery] = createSignal("");
  const [selected, setSelected] = createSignal(0);
  const [remoteResults, setRemoteResults] = createSignal<SearchResults | null>(null);
  const [loading, setLoading] = createSignal(false);
  const [error, setError] = createSignal("");
  const [usageRevision, setUsageRevision] = createSignal(0);
  let input: HTMLInputElement | undefined;
  let resultsElement: HTMLDivElement | undefined;
  let searchTimer: number | undefined;
  let searchGeneration = 0;

  const localMatches = createMemo(() => {
    usageRevision();
    return rankSpotlightChats(state.chats, query(), readSpotlightUsage(), Date.now(), 10);
  });

  const sections = createMemo<SpotlightSection[]>(() => {
    const local = localMatches();
    const loadedIds = new Set(local.map((match) => match.chat.id));
    const remote = remoteResults();
    const next: SpotlightSection[] = [];

    if (local.length > 0) {
      next.push({
        label: query().trim() ? "Chats" : "Frequently contacted & recent",
        rows: local.map((match) => ({ type: "chat" as const, match })),
      });
    }
    if (!remote) return next;

    const contacts = remote.contacts.filter((result) => !result.chatId || !loadedIds.has(result.chatId));
    if (contacts.length > 0) {
      next.push({
        label: "Contacts",
        rows: contacts.map((result) => ({ type: "contact" as const, result })),
      });
    }
    const groups = remote.groups.filter((result) => !loadedIds.has(result.id));
    if (groups.length > 0) {
      next.push({
        label: "Groups",
        rows: groups.map((result) => ({ type: "group" as const, result })),
      });
    }
    if (remote.messages.length > 0) {
      next.push({
        label: "Messages",
        rows: remote.messages.map((result) => ({ type: "message" as const, result })),
      });
    }
    return next;
  });

  const selectableRows = createMemo(() => sections().flatMap((section) => section.rows));

  createEffect(() => {
    if (!props.open) return;
    setQuery("");
    setSelected(0);
    setRemoteResults(null);
    setError("");
    setUsageRevision((value) => value + 1);
    queueMicrotask(() => {
      input?.focus();
      input?.select();
    });
  });

  createEffect(() => {
    const active = props.open;
    const trimmed = query().trim();
    if (searchTimer !== undefined) window.clearTimeout(searchTimer);
    const generation = ++searchGeneration;
    setSelected(0);
    setError("");

    if (!active || trimmed.length < 2) {
      setRemoteResults(null);
      setLoading(false);
      return;
    }

    setLoading(true);
    searchTimer = window.setTimeout(async () => {
      try {
        const results = await bridge.searchLocal(trimmed);
        if (generation === searchGeneration) setRemoteResults(results);
      } catch (cause) {
        if (generation === searchGeneration) {
          setError(normalizeBridgeError(cause).message);
          setRemoteResults(null);
        }
      } finally {
        if (generation === searchGeneration) setLoading(false);
      }
    }, 120);
  });

  createEffect(() => {
    if (!props.open) return;
    const index = Math.min(selected(), Math.max(0, selectableRows().length - 1));
    if (index !== selected()) setSelected(index);
    requestAnimationFrame(() => {
      resultsElement
        ?.querySelector<HTMLElement>(`[data-spotlight-index="${index}"]`)
        ?.scrollIntoView({ block: "nearest" });
    });
  });

  onCleanup(() => {
    searchGeneration += 1;
    if (searchTimer !== undefined) window.clearTimeout(searchTimer);
  });

  return (
    <Show when={props.open}>
      <div
        class="spotlight-overlay"
        role="presentation"
        onPointerDown={(event) => {
          if (event.target === event.currentTarget) props.onClose();
        }}
      >
        <section
          class="spotlight"
          role="dialog"
          aria-modal="true"
          aria-label="Quick search"
          onPointerDown={(event) => event.stopPropagation()}
        >
          <label class="spotlight-input">
            <ThemeIcon icon={Search} name="search" size={22} />
            <input
              ref={input}
              type="search"
              value={query()}
              placeholder="Search chats and messages"
              aria-label="Search people, groups, and messages"
              autocomplete="off"
              onInput={(event) => setQuery(event.currentTarget.value)}
              onKeyDown={handleKeyDown}
            />
            <Show when={loading()} fallback={<kbd>{shortcutLabel()}</kbd>}>
              <Spinner small label="Searching" />
            </Show>
          </label>

          <div ref={resultsElement} class="spotlight-results" role="listbox" aria-label="Search results">
            <Switch>
              <Match when={error()}>
                <EmptyState title={error()}><ThemeIcon icon={X} name="close" size={22} /></EmptyState>
              </Match>
              <Match when={!loading() && selectableRows().length === 0}>
                <EmptyState
                  title={query().trim() ? "No people, groups, or messages found" : "No chats loaded yet"}
                >
                  <ThemeIcon icon={Search} name="search" size={24} />
                </EmptyState>
              </Match>
            </Switch>

            <For each={sections()}>
              {(section) => (
                <div class="spotlight-section">
                  <div class="spotlight-section-label">{section.label}</div>
                  <For each={section.rows}>
                    {(row) => {
                      const index = () => selectableRows().indexOf(row);
                      return (
                        <SpotlightResult
                          row={row}
                          active={selected() === index()}
                          index={index()}
                          scale={preferences.uiScale}
                          onHover={() => setSelected(index())}
                          onActivate={() => void activate(row)}
                        />
                      );
                    }}
                  </For>
                </div>
              )}
            </For>
          </div>

          <footer class="spotlight-footer">
            <span><ArrowUp size={13} /><ArrowDown size={13} /> navigate</span>
            <span><CornerDownLeft size={13} /> open</span>
            <span><kbd>esc</kbd> close</span>
            <span class="spotlight-footer-spacer" />
            <span><Command size={13} /> Quick search</span>
          </footer>
        </section>
      </div>
    </Show>
  );

  function handleKeyDown(event: KeyboardEvent) {
    const rows = selectableRows();
    if (event.key === "Escape") {
      props.onClose();
      event.preventDefault();
      return;
    }
    if (event.key === "ArrowDown" || event.key === "ArrowUp" || event.key === "Tab") {
      if (rows.length > 0) {
        const backwards = event.key === "ArrowUp" || (event.key === "Tab" && event.shiftKey);
        setSelected((value) => (value + (backwards ? -1 : 1) + rows.length) % rows.length);
      }
      event.preventDefault();
      return;
    }
    if (event.key === "Enter") {
      const row = rows[selected()];
      if (row) void activate(row);
      event.preventDefault();
    }
  }

  async function activate(row: SpotlightRow) {
    if (row.type === "chat") await actions.selectChat(row.match.chat.id);
    else if (row.type === "contact") await actions.openContact(row.result);
    else if (row.type === "group") await actions.selectChat(row.result.id);
    else await actions.openMessageResult(row.result);
    props.onClose();
  }
}

function SpotlightResult(props: {
  row: SpotlightRow;
  active: boolean;
  index: number;
  scale: number;
  onHover: () => void;
  onActivate: () => void;
}) {
  const title = () => {
    if (props.row.type === "chat") return props.row.match.chat.title || props.row.match.chat.phoneNumber;
    if (props.row.type === "contact") return props.row.result.displayName;
    if (props.row.type === "group") return props.row.result.title;
    return props.row.result.chatTitle;
  };
  const subtitle = () => {
    if (props.row.type === "chat") {
      return props.row.match.chat.lastMessagePreview || props.row.match.chat.phoneNumber || "No messages yet";
    }
    if (props.row.type === "contact") {
      return props.row.result.phoneNumber || props.row.result.secondaryName || "Contact";
    }
    if (props.row.type === "group") return props.row.result.lastMessagePreview || "Group";
    return `${props.row.result.senderName ? `${props.row.result.senderName}: ` : ""}${props.row.result.snippet}`;
  };
  const frequent = () => props.row.type === "chat" && (props.row.match.usage?.opens ?? 0) >= 3;
  const avatarPath = () => {
    if (props.row.type === "chat") return props.row.match.chat.avatarPath;
    if (props.row.type === "group") return props.row.result.avatarPath;
    return "";
  };
  const isGroup = () => {
    if (props.row.type === "chat") return props.row.match.chat.kind === ChatKind.Group;
    return props.row.type === "group";
  };
  const timestamp = () => {
    if (props.row.type === "chat") return props.row.match.chat.lastMessageTimestampMs;
    if (props.row.type === "group") return props.row.result.lastMessageTimestampMs;
    if (props.row.type === "message") return props.row.result.timestampMs;
    return 0;
  };

  return (
    <button
      type="button"
      class={`spotlight-row ${props.active ? "active" : ""}`}
      role="option"
      aria-selected={props.active}
      data-spotlight-index={props.index}
      onMouseMove={props.onHover}
      onFocus={props.onHover}
      onClick={props.onActivate}
    >
      <Avatar
        name={title() || "Unknown contact"}
        path={avatarPath()}
        size={42 * props.scale}
        group={isGroup()}
      />
      <span class="spotlight-row-copy">
        <strong>{title() || "Unknown contact"}</strong>
        <span>{subtitle()}</span>
      </span>
      <Show when={frequent()}>
        <span class="spotlight-frequency">Frequent</span>
      </Show>
      <Show when={timestamp()}>
        <time>{formatChatTime(timestamp())}</time>
      </Show>
      <Show when={props.row.type === "message"}>
        <ThemeIcon icon={MessageSquareText} name="messages" class="spotlight-message-icon" size={15} />
      </Show>
    </button>
  );
}

function shortcutLabel(): string {
  return /Mac|iPhone|iPad/u.test(navigator.platform) ? "⌘ K" : "Ctrl K";
}
