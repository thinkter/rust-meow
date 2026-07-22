import { For, Show } from "solid-js";
import {
  Archive,
  BadgeCheck,
  BellOff,
  CalendarDays,
  Clock3,
  LockKeyhole,
  LogOut,
  ShieldCheck,
  SunMoon,
  UsersRound,
  X,
} from "lucide-solid";
import type { AppModel } from "../state/app";
import type { ChatParticipant } from "../lib/types";
import { ChatKind } from "../lib/types";
import { formatDay } from "../lib/format";
import { Avatar } from "./Avatar";
import { IconButton, Spinner } from "./Primitives";

export function ChatInfoPanel(props: { model: AppModel }) {
  const { state, actions } = props.model;
  const chat = () => actions.selectedChat();
  const info = () => state.chatInfo;

  return (
    <aside class="right-panel" aria-label="Chat information">
      <header class="right-panel-header">
        <IconButton label="Close info" onClick={actions.hideChatInfo}><X size={20} /></IconButton>
        <h2>{chat()?.kind === ChatKind.Group ? "Group info" : "Contact info"}</h2>
      </header>
      <div class="right-panel-scroll">
        <div class="profile-hero">
          <Avatar
            name={chat()?.title || chat()?.phoneNumber || "Chat"}
            path={chat()?.avatarPath}
            size={116 * state.uiScale}
            group={chat()?.kind === ChatKind.Group}
          />
          <h2>{chat()?.title || chat()?.phoneNumber}</h2>
          <p>{chat()?.kind === ChatKind.Group ? `${info()?.participantCount || ""} participants` : chat()?.phoneNumber}</p>
        </div>

        <Show when={state.chatInfoLoading}>
          <div class="empty-state" style={{ height: "180px" }}><Spinner label="Loading details" /></div>
        </Show>
        <Show when={state.chatInfoError}>
          <div class="info-section">
            <p>{state.chatInfoError}</p>
            <button type="button" class="secondary-button" style={{ "margin-top": "12px" }} onClick={() => void actions.showChatInfo()}>
              Try again
            </button>
          </div>
        </Show>
        <Show when={!state.chatInfoLoading && info()}>
          {(value) => (
            <>
              <Show when={value().about || value().description}>
                <section class="info-section">
                  <h3>{chat()?.kind === ChatKind.Group ? "Description" : "About"}</h3>
                  <p>{value().description || value().about}</p>
                </section>
              </Show>

              <Show when={chat()?.kind !== ChatKind.Group}>
                <section class="info-section">
                  <Show when={value().verifiedName}>
                    <div class="info-row"><BadgeCheck size={19} /><span>{value().verifiedName}</span><span class="role-badge">Verified</span></div>
                  </Show>
                  <Show when={chat()?.businessName}>
                    <div class="info-row"><ShieldCheck size={19} /><span>{chat()?.businessName}</span></div>
                  </Show>
                  <div class="info-row"><span>{chat()?.phoneNumber || value().address}</span></div>
                </section>
              </Show>

              <Show when={chat()?.kind === ChatKind.Group}>
                <section class="info-section">
                  <h3>Group settings</h3>
                  <Show when={value().createdAtMs > 0}>
                    <div class="info-row"><CalendarDays size={18} /><span>Created {formatDay(value().createdAtMs)}{value().createdBy ? ` by ${value().createdBy}` : ""}</span></div>
                  </Show>
                  <Show when={value().disappearingTimerSeconds > 0}>
                    <div class="info-row"><Clock3 size={18} /><span>Disappearing messages: {formatTimer(value().disappearingTimerSeconds)}</span></div>
                  </Show>
                  <Show when={value().announceOnly}>
                    <div class="info-row"><LockKeyhole size={18} /><span>Only admins can send messages</span></div>
                  </Show>
                  <Show when={value().locked}>
                    <div class="info-row"><ShieldCheck size={18} /><span>Only admins can edit group info</span></div>
                  </Show>
                  <Show when={value().isCommunity}>
                    <div class="info-row"><UsersRound size={18} /><span>Community group</span></div>
                  </Show>
                  <Show when={value().joinApprovalRequired}>
                    <div class="info-row"><BadgeCheck size={18} /><span>New members require approval</span></div>
                  </Show>
                </section>

                <section class="info-section">
                  <h3>{value().participantCount || value().participants.length} participants</h3>
                  <div class="participant-list">
                    <For each={value().participants}>
                      {(participant) => <ParticipantRow participant={participant} model={props.model} />}
                    </For>
                  </div>
                </section>
              </Show>

              <section class="info-section">
                <Show when={chat()?.muted}><div class="info-row"><BellOff size={18} /><span>Notifications muted</span></div></Show>
                <Show when={chat()?.archived}><div class="info-row"><Archive size={18} /><span>Archived</span></div></Show>
                <Show when={chat()?.pinned}><div class="info-row"><ShieldCheck size={18} /><span>Pinned chat</span></div></Show>
                <Show when={!chat()?.muted && !chat()?.archived && !chat()?.pinned}>
                  <p>No special chat settings are active.</p>
                </Show>
              </section>
            </>
          )}
        </Show>
      </div>
    </aside>
  );
}

function ParticipantRow(props: { participant: ChatParticipant; model: AppModel }) {
  const { state, actions } = props.model;
  queueMicrotask(() => void actions.loadParticipantAvatar(props.participant.participantId));
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
        size={39 * state.uiScale}
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

export function SettingsPanel(props: { model: AppModel }) {
  const { state, actions } = props.model;
  return (
    <aside class="right-panel settings-panel" aria-label="Settings">
      <header class="right-panel-header">
        <IconButton label="Close settings" onClick={() => actions.toggleSettings(false)}><X size={20} /></IconButton>
        <h2>Settings</h2>
      </header>
      <div class="right-panel-scroll">
        <div class="profile-hero">
          <div class="brand-mark" style={{ width: "76px", height: "76px", "border-radius": "24px" }}>
            <span style={{ "font-size": "34px", "font-weight": 800 }}>M</span>
          </div>
          <h2>Rust Meow</h2>
          <p>Backend {state.backendVersion || "starting"}</p>
        </div>
        <div class="setting-row">
          <span class="setting-copy"><strong>Appearance</strong><span>Light or dark interface</span></span>
          <div class="segmented-control">
            <button type="button" class={state.theme === "dark" ? "active" : ""} onClick={() => actions.setTheme("dark")}>Dark</button>
            <button type="button" class={state.theme === "light" ? "active" : ""} onClick={() => actions.setTheme("light")}>Light</button>
          </div>
        </div>
        <div class="setting-row">
          <span class="setting-copy"><strong>Interface size</strong><span>{Math.round(state.uiScale * 100)}%</span></span>
          <div class="segmented-control">
            {[1, 1.1, 1.2, 1.3, 1.4, 1.5].map((scale) => (
              <button type="button" class={state.uiScale === scale ? "active" : ""} onClick={() => actions.setScale(scale)}>
                {Math.round(scale * 100)}
              </button>
            ))}
          </div>
        </div>
        <div class="setting-row">
          <span class="setting-copy"><strong>Theme follows this device</strong><span>Stored locally; your messages are unaffected</span></span>
          <SunMoon size={20} />
        </div>
        <div class="info-section">
          <button type="button" class="danger-button" onClick={() => actions.setLogoutConfirmation(true)}>
            <LogOut size={17} style={{ "vertical-align": "middle", "margin-right": "7px" }} />
            Log out and remove local account data
          </button>
        </div>
      </div>
    </aside>
  );
}

function formatTimer(seconds: number): string {
  if (seconds % 86_400 === 0) {
    const days = seconds / 86_400;
    return `${days} ${days === 1 ? "day" : "days"}`;
  }
  if (seconds % 3_600 === 0) return `${seconds / 3_600} hours`;
  return `${seconds} seconds`;
}
