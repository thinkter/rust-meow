import { For, Show } from "solid-js";
import { Plus, X } from "lucide-solid";
import type { AppModel, Pane } from "../state/app";
import { tabKeyboardCommand } from "../state/tab-keyboard";
import { samePaneDropIndex } from "../state/workspace";
import { ChatKind } from "../lib/types";
import { Avatar } from "./Avatar";

interface TabDragPayload {
  chatId: string;
  fromPaneId: string;
}

const DRAG_MIME = "application/x-rust-meow-tab";

function focusSidebarSearch() {
  document.querySelector<HTMLInputElement>(".search-field input")?.focus();
}

/** One accessible tab strip with pointer and keyboard movement parity. */
export function Tabs(props: { model: AppModel; pane: Pane }) {
  const { state, preferences, actions } = props.model;

  function chatFor(chatId: string) {
    return state.chats.find((candidate) => candidate.id === chatId);
  }

  function chatName(chatId: string) {
    const chat = chatFor(chatId);
    return chat?.title || chat?.phoneNumber || "Chat";
  }

  function dropIndexFor(event: DragEvent, targetChatId: string): number {
    const targetIndex = props.pane.tabChatIds.indexOf(targetChatId);
    const bounds = (event.currentTarget as HTMLElement).getBoundingClientRect();
    return event.clientX - bounds.left > bounds.width / 2 ? targetIndex + 1 : targetIndex;
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
      // Ignore non-tab drops.
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

  function focusTab(paneId: string, chatId: string) {
    requestAnimationFrame(() => document.getElementById(`tab-${paneId}-${chatId}`)?.focus());
  }

  function closeAndRestoreFocus(chatId: string) {
    const title = chatName(chatId);
    actions.closeTab(chatId, props.pane.id);
    const remainingPane = state.panes.find((candidate) => candidate.id === props.pane.id)
      ?? state.panes.find((candidate) => candidate.id === state.focusedPaneId)
      ?? state.panes[0];
    if (remainingPane?.activeChatId) focusTab(remainingPane.id, remainingPane.activeChatId);
    else requestAnimationFrame(focusSidebarSearch);
    actions.announceTabAction(`${title} closed`);
  }

  function moveSelection(event: KeyboardEvent, currentChatId: string) {
    if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return false;
    const tabs = props.pane.tabChatIds;
    if (tabs.length === 0) return true;
    const current = Math.max(0, tabs.indexOf(currentChatId));
    const nextIndex = event.key === "Home"
      ? 0
      : event.key === "End"
        ? tabs.length - 1
        : (current + (event.key === "ArrowRight" ? 1 : -1) + tabs.length) % tabs.length;
    const nextChatId = tabs[nextIndex];
    if (nextChatId) {
      void actions.selectChat(nextChatId, "", props.pane.id);
      focusTab(props.pane.id, nextChatId);
    }
    event.preventDefault();
    return true;
  }

  function handleAccessibleCommand(event: KeyboardEvent, chatId: string) {
    const command = tabKeyboardCommand(
      {
        key: event.key,
        altKey: event.altKey,
        shiftKey: event.shiftKey,
        platformModifier: event.ctrlKey || event.metaKey,
      },
      state.panes,
      props.pane.id,
      chatId,
    );
    if (!command) return false;
    event.preventDefault();
    const title = chatName(chatId);
    if (command.kind === "close") {
      closeAndRestoreFocus(chatId);
    } else if (command.kind === "boundary") {
      actions.announceTabAction(command.message);
    } else if (command.kind === "reorder") {
      actions.moveTab(chatId, props.pane.id, props.pane.id, command.index);
      focusTab(props.pane.id, chatId);
      actions.announceTabAction(`${title} moved ${command.direction} to position ${command.index + 1}`);
    } else {
      actions.moveTab(chatId, props.pane.id, command.paneId, command.index);
      focusTab(command.paneId, chatId);
      actions.announceTabAction(`${title} moved to the ${command.direction} pane, position ${command.index + 1}`);
    }
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
            return (
              <div
                class={`tab-slot ${active() ? "active" : ""}`}
                data-chat-id={chatId}
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
                onAuxClick={(event) => {
                  if (event.button !== 1) return;
                  event.preventDefault();
                  closeAndRestoreFocus(chatId);
                }}
              >
                <button
                  type="button"
                  id={`tab-${props.pane.id}-${chatId}`}
                  class={`tab ${active() ? "active" : ""}`}
                  role="tab"
                  tabIndex={active() ? 0 : -1}
                  aria-selected={active()}
                  aria-controls={`tabpanel-${props.pane.id}-${chatId}`}
                  aria-label={`${chatName(chatId)}${(chat()?.unreadCount ?? 0) > 0 ? `, ${chat()!.unreadCount} unread` : ""}`}
                  aria-keyshortcuts="Delete Alt+Shift+ArrowLeft Alt+Shift+ArrowRight Control+Shift+ArrowLeft Control+Shift+ArrowRight"
                  onClick={() => void actions.selectChat(chatId, "", props.pane.id)}
                  onKeyDown={(event) => {
                    if (!handleAccessibleCommand(event, chatId)) moveSelection(event, chatId);
                  }}
                >
                  <Avatar
                    class="tab-avatar"
                    name={chatName(chatId)}
                    path={chat()?.avatarPath}
                    size={16 * preferences.uiScale}
                    group={chat()?.kind === ChatKind.Group}
                  />
                  <span class="tab-title">{chatName(chatId)}</span>
                  <Show when={(chat()?.unreadCount ?? 0) > 0}>
                    <span class="tab-badge" aria-hidden="true">{Math.min(chat()!.unreadCount, 99)}</span>
                  </Show>
                </button>
                <button
                  type="button"
                  class="tab-close"
                  aria-label={`Close ${chatName(chatId)}`}
                  onClick={(event) => {
                    event.stopPropagation();
                    closeAndRestoreFocus(chatId);
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
