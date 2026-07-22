import { createEffect, createMemo, For, Show } from "solid-js";
import { createVirtualizer } from "@tanstack/solid-virtual";
import { UsersRound } from "lucide-solid";
import type { AppModel } from "../state/app";
import type { ChatParticipant } from "../lib/types";
import { ChatKind } from "../lib/types";
import { ParticipantRow } from "./Panels";
import { Spinner } from "./Primitives";

type MemberRow = { kind: "header"; label: string } | { kind: "participant"; participant: ChatParticipant };

/**
 * Discord-style member list, docked open beside group conversations (goal
 * G8). Info loads through `actions.ensureMentionDirectory()` — the same
 * fetch the mention autocomplete uses — so opening this panel never flips
 * on `state.chatInfoOpen` and pops the full chat-info sheet on top of it.
 *
 * WhatsApp groups run into the thousands of members, and each
 * `ParticipantRow` fires an avatar fetch on mount, so the row list is
 * virtualized exactly like `Sidebar.tsx`'s chat list rather than rendering
 * every member: only rows actually scrolled into view (plus overscan) ever
 * mount, which bounds the number of concurrent avatar requests regardless
 * of group size.
 */
export function MemberPanel(props: { model: AppModel }) {
  const { state, actions, preferences } = props.model;
  let scrollRef: HTMLDivElement | undefined;

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
  const admins = createMemo(() => participants().filter((participant) => participant.isAdmin || participant.isSuperAdmin));
  const members = createMemo(() => participants().filter((participant) => !participant.isAdmin && !participant.isSuperAdmin));

  const rows = createMemo<MemberRow[]>(() => {
    const result: MemberRow[] = [];
    if (admins().length > 0) {
      result.push({ kind: "header", label: `ADMINS — ${admins().length}` });
      for (const participant of admins()) result.push({ kind: "participant", participant });
    }
    if (members().length > 0) {
      result.push({ kind: "header", label: `MEMBERS — ${members().length}` });
      for (const participant of members()) result.push({ kind: "participant", participant });
    }
    return result;
  });

  const virtualizer = createVirtualizer<HTMLDivElement, HTMLDivElement>({
    get count() {
      return rows().length;
    },
    getScrollElement: () => scrollRef ?? null,
    estimateSize: (index) => (rows()[index]?.kind === "header" ? 30 : 54) * preferences.uiScale,
    overscan: 8,
    getItemKey: (index) => {
      const row = rows()[index];
      return row ? (row.kind === "header" ? row.label : row.participant.participantId) : index;
    },
  });

  return (
    <Show when={visible()}>
      <aside class="member-panel" aria-label="Group members">
        <header class="member-panel-header">
          <UsersRound size={17} />
          <h2>{memberCountLabel()}</h2>
        </header>
        <div ref={scrollRef} class="right-panel-scroll">
          <Show when={infoReady()} fallback={<div class="empty-state" style={{ height: "160px" }}><Spinner label="Loading members" /></div>}>
            <div class="virtual-canvas" style={{ height: `${virtualizer.getTotalSize()}px` }}>
              <For each={virtualizer.getVirtualItems()}>
                {(virtualRow) => {
                  const header = () => {
                    const row = rows()[virtualRow.index];
                    return row?.kind === "header" ? row.label : undefined;
                  };
                  const participant = () => {
                    const row = rows()[virtualRow.index];
                    return row?.kind === "participant" ? row.participant : undefined;
                  };
                  return (
                    <div class="virtual-row" style={{ transform: `translateY(${virtualRow.start}px)` }}>
                      <Show when={header()}>{(label) => <div class="member-section-label">{label()}</div>}</Show>
                      <Show when={participant()}>
                        {(value) => <ParticipantRow participant={value()} model={props.model} />}
                      </Show>
                    </div>
                  );
                }}
              </For>
            </div>
          </Show>
        </div>
      </aside>
    </Show>
  );
}
