import { createEffect, createMemo, Show } from "solid-js";
import { UsersRound } from "lucide-solid";
import type { AppModel } from "../state/app";
import type { ChatParticipant } from "../lib/types";
import { ChatKind } from "../lib/types";
import { ParticipantList } from "./ParticipantList";
import { Spinner } from "./Primitives";

/**
 * Discord-style member list, docked open beside group conversations (goal
 * G8). Info loads through `actions.ensureMentionDirectory()` — the same
 * fetch the mention autocomplete uses — so opening this panel never flips
 * on `state.chatInfoOpen` and pops the full chat-info sheet on top of it.
 *
 * WhatsApp groups run into the thousands of members, so this reuses the same
 * virtual roster as the full info sheet. Only visible rows plus a small
 * overscan mount and subscribe to the shared avatar queue.
 */
export function MemberPanel(props: { model: AppModel }) {
  const { state, actions, preferences } = props.model;
  const chat = () => actions.selectedChat();
  const isGroup = () => chat()?.kind === ChatKind.Group;
  const visible = () => isGroup() && preferences.memberPanelOpen;

  // Load (or refresh) the group roster whenever the focused chat changes,
  // without opening the full chat-info sheet.
  createEffect(() => {
    if (visible()) void actions.ensureMentionDirectory();
  });

  const infoReady = () => state.chatInfo?.chat?.id === state.selectedChatId;
  const memberCountLabel = () => {
    const count = infoReady() ? state.chatInfo?.participantCount || participants().length : 0;
    return count > 0 ? `${count} members` : "Members";
  };
  const participants = createMemo<ChatParticipant[]>(() => (infoReady() ? state.chatInfo?.participants ?? [] : []));
  return (
    <Show when={visible()}>
      <aside class="member-panel" aria-label="Group members">
        <header class="member-panel-header">
          <UsersRound size={17} />
          <h2>{memberCountLabel()}</h2>
        </header>
        <div class="right-panel-scroll member-panel-scroll">
          <Show when={infoReady()} fallback={<div class="empty-state" style={{ height: "160px" }}><Spinner label="Loading members" /></div>}>
            <ParticipantList model={props.model} participants={participants()} sectioned fill label="Group members" />
          </Show>
        </div>
      </aside>
    </Show>
  );
}
