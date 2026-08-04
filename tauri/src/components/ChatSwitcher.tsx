import { For, Show } from "solid-js";
import type { AppModel } from "../state/app";
import { ChatKind } from "../lib/types";
import { Avatar } from "./Avatar";

/**
 * The `Ctrl+Tab` alt-tab-style overlay (goal G4). This component is purely
 * presentational — `state.switcher`'s existence, its highlight index, and
 * committing/cancelling all live in `state/app.ts` and `state/workspace.ts`.
 * The keys that drive it (`Ctrl+Tab` to open/cycle, releasing `Ctrl` to
 * commit, `Escape`/blur to cancel) are handled in `App.tsx` at the `window`
 * level in capture phase — see that file's comment for why: the release of
 * `Ctrl` must commit even when the overlay was opened while a composer or
 * search input had focus, and a component-scoped listener would miss that.
 */
export function ChatSwitcher(props: { model: AppModel }) {
  const { state, actions, preferences } = props.model;
  const switcher = () => state.switcher;

  function chatTitle(chatId: string): string {
    const chat = state.chats.find((candidate) => candidate.id === chatId);
    return chat?.title || chat?.phoneNumber || "Unknown chat";
  }

  function commit(chatId: string) {
    void actions.selectChat(chatId);
    actions.cancelSwitcher();
  }

  return (
    <Show when={switcher()}>
      {(value) => (
        <div class="chat-switcher-overlay" role="presentation" onClick={() => actions.cancelSwitcher()}>
          <div
            class="chat-switcher"
            role="listbox"
            aria-label="Switch chat"
            onClick={(event) => event.stopPropagation()}
          >
            <For each={value().chatIds}>
              {(chatId, index) => {
                const chat = () => state.chats.find((candidate) => candidate.id === chatId);
                return (
                  <button
                    type="button"
                    class={`switcher-row ${index() === value().highlighted ? "active" : ""}`}
                    role="option"
                    aria-selected={index() === value().highlighted}
                    onClick={() => commit(chatId)}
                  >
                    <Avatar
                      name={chatTitle(chatId)}
                      path={chat()?.avatarPath}
                      size={32 * preferences.uiScale}
                      group={chat()?.kind === ChatKind.Group}
                    />
                    <span>{chatTitle(chatId)}</span>
                  </button>
                );
              }}
            </For>
            <div class="switcher-hint">Release Ctrl to switch · Esc to cancel</div>
          </div>
        </div>
      )}
    </Show>
  );
}
