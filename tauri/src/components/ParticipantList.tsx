import { createMemo, For, Show } from "solid-js";
import { createVirtualizer } from "@tanstack/solid-virtual";
import type { AppModel } from "../state/app";
import type { ChatParticipant } from "../lib/types";
import {
  PARTICIPANT_HEADER_HEIGHT,
  PARTICIPANT_OVERSCAN,
  PARTICIPANT_ROW_HEIGHT,
  participantRosterRows,
} from "../lib/participant-roster";
import { ParticipantRow } from "./ParticipantRow";

/** Shared bounded roster used by both the dock and the full info sheet. */
export function ParticipantList(props: {
  model: AppModel;
  participants: readonly ChatParticipant[];
  sectioned?: boolean;
  fill?: boolean;
  label: string;
}) {
  let scrollRef: HTMLDivElement | undefined;
  const rows = createMemo(() => participantRosterRows(props.participants, Boolean(props.sectioned)));
  const estimatedHeight = createMemo(() => rows().reduce(
    (height, row) => height + (row.kind === "header" ? PARTICIPANT_HEADER_HEIGHT : PARTICIPANT_ROW_HEIGHT),
    0,
  ) * props.model.preferences.uiScale);
  const virtualizer = createVirtualizer<HTMLDivElement, HTMLDivElement>({
    get count() {
      return rows().length;
    },
    getScrollElement: () => scrollRef ?? null,
    estimateSize: (index) => {
      const row = rows()[index];
      return (row?.kind === "header" ? PARTICIPANT_HEADER_HEIGHT : PARTICIPANT_ROW_HEIGHT)
        * props.model.preferences.uiScale;
    },
    overscan: PARTICIPANT_OVERSCAN,
    getItemKey: (index) => rows()[index]?.key ?? index,
  });

  return (
    <div
      ref={scrollRef}
      class={`participant-virtual-list ${props.fill ? "fill" : ""}`}
      style={{ height: props.fill ? "100%" : `${Math.min(420 * props.model.preferences.uiScale, estimatedHeight())}px` }}
      role="list"
      aria-label={props.label}
    >
      <div class="virtual-canvas" style={{ height: `${virtualizer.getTotalSize()}px` }}>
        <For each={virtualizer.getVirtualItems()}>
          {(virtualRow) => {
            const row = () => rows()[virtualRow.index];
            return (
              <div class="virtual-row" style={{ transform: `translateY(${virtualRow.start}px)` }}>
                <Show when={row()?.kind === "header" ? row() as Extract<ReturnType<typeof rows>[number], { kind: "header" }> : undefined}>
                  {(headerRow) => <div class="member-section-label" role="separator">{headerRow().label}</div>}
                </Show>
                <Show when={row()?.kind === "participant" ? row() as Extract<ReturnType<typeof rows>[number], { kind: "participant" }> : undefined}>
                  {(participantRow) => (
                  <div
                    role="listitem"
                    aria-posinset={participantRow().position}
                    aria-setsize={props.participants.length}
                  >
                    <ParticipantRow participant={participantRow().participant} model={props.model} />
                  </div>
                  )}
                </Show>
              </div>
            );
          }}
        </For>
      </div>
    </div>
  );
}
