import { createEffect, onCleanup, Show } from "solid-js";
import type { AppModel } from "../state/app";
import type { ChatParticipant } from "../lib/types";
import { Avatar } from "./Avatar";

export function ParticipantRow(props: { participant: ChatParticipant; model: AppModel; rosterId: string }) {
  const { state, actions, preferences } = props.model;

  createEffect(() => {
    const participantId = props.participant.participantId;
    const cancel = actions.loadParticipantAvatar(participantId, props.rosterId);
    onCleanup(cancel);
  });

  return (
    <button
      type="button"
      class="participant-row"
      disabled={props.participant.isMe}
      onClick={() =>
        void actions.openContact({
          contactJid: props.participant.participantId,
          chatId: "",
          displayName: props.participant.displayName,
          secondaryName: "",
          phoneNumber: props.participant.phoneNumber,
        })
      }
    >
      <Avatar
        name={props.participant.displayName || props.participant.phoneNumber}
        path={state.participantAvatars[props.participant.participantId]}
        size={39 * preferences.uiScale}
      />
      <span class="participant-row-copy">
        <strong>{props.participant.isMe ? "You" : props.participant.displayName || props.participant.phoneNumber}</strong>
        <span>{props.participant.phoneNumber}</span>
      </span>
      <Show when={props.participant.isSuperAdmin}><span class="role-badge">Owner</span></Show>
      <Show when={!props.participant.isSuperAdmin && props.participant.isAdmin}><span class="role-badge">Admin</span></Show>
    </button>
  );
}
