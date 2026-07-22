import { For, Show } from "solid-js";
import { Plus, X } from "lucide-solid";
import type { AppModel, Pane } from "../state/app";
import { tabKeyboardCommand } from "../state/tab-keyboard";
import { samePaneDropIndex } from "../state/workspace";
import { ChatKind } from "../lib/types";
import { Avatar } from "./Avatar";

/** Drag payload for reordering a tab within a pane or moving it across panes. */
interface TabDragPayload {
  chatId: string;
  fromPaneId: string;
}

const DRAG_MIME = "application/x-rust-meow-tab";

function focusSidebarSearch() {
  // Mirrors `Sidebar.tsx`'s own `focusSearch` helper — there is no ref path
  // from a tab strip up to the sidebar, so both reach for the same DOM node.
  document.querySelector<HTMLInputElement>(".search-field input")?.focus();
}

/**
 * One pane's tab strip (goal G9). Lives inside `.pane`, at the top, above
 * that pane's `Conversation` — see `App.tsx`. Tabs can be reordered within
 * the strip and dragged into the other pane via HTML5 drag-and-drop, both
 * landing on `actions.moveTab`.
 */
export function Tabs(props: { model: AppModel; pane: Pane }) {
  const { state, preferences, actions } = props.model;

  function chatFor(chatId: string) {
    return state.chats.find((candidate) => candidate.id === chatId);
  }

  function dropIndexFor(event: DragEvent, targetChatId: string): number {
    const ids = props.pane.tabChatIds;
    const targetIndex = ids.indexOf(targetChatId);
    const bounds = (event.currentTarget as HTMLElement).getBoundingClientRect();
    const droppedOnRightHalf = event.clientX - bounds.left > bounds.width / 2;
    return droppedOnRightHalf ? targetIndex + 1 : targetIndex;
  }

  function readDragPayload(event: DragEvent): TabDragPayload | undefined {
    try {
      const raw = event.dataTransfer?.getData(DRAG_MIME);
      if (!raw) return undefined;
      const parsed: unknown = JSON.parse(raw);
      if (
        typeof parsed === "object" &&
        parsed !== null &&
        typeof (parsed as TabDragPayload).chatId === "string" &&
        typeof (parsed as TabDragPayload).fromPaneId === "string"
      ) {
        return parsed as TabDragPayload;
      }
    } catch {
      // Not a tab drag (e.g. a stray file drop) — ignore it.
    }
    return undefined;
  }

  function handleDrop(event: DragEvent, index: number) {
    event.preventDefault();
    const payload = readDragPayload(event);
    if (!payload) return;
    if (payload.fromPaneId === props.pane.id) {
      index = samePaneDropIndex(props.pane.tabChatIds, payload.chatId, index);
    }
    actions.moveTab(payload.chatId, payload.fromPaneId, props.pane.id, index);
  }

  function moveKeyboardFocus(event: KeyboardEvent, currentChatId: string) {
    if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return false;
    const tabs = props.pane.tabChatIds;
    if (tabs.length === 0) return true;
    const current = Math.max(0, tabs.indexOf(currentChatId));
    const nextIndex =
      event.key === "Home"
        ? 0
        : event.key === "End"
          ? tabs.length - 1
          : (current + (event.key === "ArrowRight" ? 1 : -1) + tabs.length) % tabs.length;
    const nextChatId = tabs[nextIndex];
    if (nextChatId) {
      void actions.selectChat(nextChatId, "", props.pane.id);
      requestAnimationFrame(() => {
        (event.currentTarget as HTMLElement)
          .closest(".tab-strip")
          ?.querySelectorAll<HTMLElement>("[role=tab]")
          .item(nextIndex)
          ?.focus();
      });
    }
    event.preventDefault();
    return true;
  }

  return (
    <Show when={preferences.showTabBar}>
      <div
        class="tab-strip"
        role="tablist"
        aria-label={`Open chats in ${props.pane.id === state.focusedPaneId ? "focused" : "secondary"} pane`}
        onDragOver={(event) => event.preventDefault()}
        onDrop={(event) => handleDrop(event, props.pane.tabChatIds.length)}
      >
        <For each={props.pane.tabChatIds}>
          {(chatId) => {
            const chat = () => chatFor(chatId);
            const active = () => chatId === props.pane.activeChatId;
            // A `<div role="tab">` rather than a `<button>` — the close
            // control inside it is a real button, and buttons cannot nest.
            return (
              <div
                class={`tab ${active() ? "active" : ""}`}
                role="tab"
                tabIndex={active() ? 0 : -1}
                data-chat-id={chatId}
                aria-selected={active()}
                draggable
                onDragStart={(event) => {
                  event.dataTransfer?.setData(
                    DRAG_MIME,
                    JSON.stringify({ chatId, fromPaneId: props.pane.id } satisfies TabDragPayload),
                  );
                  if (event.dataTransfer) event.dataTransfer.effectAllowed = "move";
                }}
                onDragOver={(event) => {
                  event.preventDefault();
                  event.stopPropagation();
                }}
                onDrop={(event) => {
                  event.stopPropagation();
                  handleDrop(event, dropIndexFor(event, chatId));
                }}
                onClick={() => void actions.selectChat(chatId, "", props.pane.id)}
                onKeyDown={(event) => {
                  if (moveKeyboardFocus(event, chatId)) return;
                  if (event.key === "Enter" || event.key === " ") {
                    event.preventDefault();
                    void actions.selectChat(chatId, "", props.pane.id);
                  }
                }}
                onAuxClick={(event) => {
                  if (event.button !== 1) return;
                  event.preventDefault();
                  actions.closeTab(chatId, props.pane.id);
                }}
              >
                <Avatar
                  class="tab-avatar"
                  name={chat()?.title || chat()?.phoneNumber || "Chat"}
                  path={chat()?.avatarPath}
                  size={16 * preferences.uiScale}
                  group={chat()?.kind === ChatKind.Group}
                />
                <span class="tab-title">{chat()?.title || chat()?.phoneNumber || "Chat"}</span>
                <Show when={(chat()?.unreadCount ?? 0) > 0}>
                  <span class="tab-badge">{Math.min(chat()!.unreadCount, 99)}</span>
                </Show>
                <button
                  type="button"
                  class="tab-close"
                  aria-label="Close tab"
                  onClick={(event) => {
                    event.stopPropagation();
                    actions.closeTab(chatId, props.pane.id);
                  }}
                >
                  <X size={13} />
                </button>
              </div>
            );
          }}
        </For>
        <button type="button" class="tab-add" aria-label="Search chats to open a new tab" onClick={focusSidebarSearch}>
          <Plus size={15} />
        </button>
      </div>
    </Show>
  );
}
