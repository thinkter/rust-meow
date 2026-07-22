import { createSignal, For, Show } from "solid-js";
import type { JSX } from "solid-js";
import {
  Archive,
  BadgeCheck,
  BellOff,
  CalendarDays,
  ClipboardCopy,
  Clock3,
  Copy,
  Download,
  HardDrive,
  LockKeyhole,
  LogOut,
  MessagesSquare,
  Palette,
  Pencil,
  Plus,
  ShieldCheck,
  Trash2,
  UsersRound,
  X,
} from "lucide-solid";
import type { AppModel } from "../state/app";
import type { ChatParticipant } from "../lib/types";
import { ChatKind } from "../lib/types";
import { formatDay } from "../lib/format";
import { normalizeBridgeError, openFile } from "../lib/bridge";
import { exportTheme, THEME_TOKENS, type Theme, type ThemeToken } from "../lib/theme";
import { Avatar } from "./Avatar";
import { IconButton, Spinner } from "./Primitives";

export function ChatInfoPanel(props: { model: AppModel }) {
  const { state, actions, preferences } = props.model;
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
            size={116 * preferences.uiScale}
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

/**
 * A single participant entry, shared between the on-demand chat info sheet
 * and the always-docked member list. It stays purely presentational and
 * prop-driven so both callers can render it identically.
 */
export function ParticipantRow(props: { participant: ChatParticipant; model: AppModel }) {
  const { state, actions, preferences } = props.model;
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

/**
 * A binary switch that follows the WAI-ARIA `switch` pattern. It renders as
 * a native `<button>` so Enter and Space already toggle it without any extra
 * key handling; `role="switch"` and `aria-checked` are what tell assistive
 * technology it is a switch rather than a push button.
 */
function Toggle(props: { checked: boolean; onChange: (value: boolean) => void; label: string; disabled?: boolean }) {
  return (
    <button
      type="button"
      class={`toggle-switch ${props.checked ? "on" : ""}`}
      role="switch"
      aria-checked={props.checked}
      aria-label={props.label}
      disabled={props.disabled}
      onClick={() => props.onChange(!props.checked)}
    >
      <span class="toggle-knob" />
    </button>
  );
}

type SettingsSection = "appearance" | "chats" | "storage" | "about";

const SETTINGS_SECTIONS: ReadonlyArray<{ id: SettingsSection; label: string; icon: (props: { size?: number }) => JSX.Element }> = [
  { id: "appearance", label: "Appearance", icon: Palette },
  { id: "chats", label: "Chats", icon: MessagesSquare },
  { id: "storage", label: "Storage", icon: HardDrive },
  { id: "about", label: "About & privacy", icon: ShieldCheck },
];

/** Human-readable labels for every themeable token, in `THEME_TOKENS` order. */
const TOKEN_LABELS: Record<ThemeToken, string> = {
  "bg-app": "App background",
  "bg-panel": "Panel background",
  "bg-elevated": "Elevated surface",
  "bg-hover": "Hover surface",
  "bg-active": "Active surface",
  "bg-input": "Input background",
  "bg-overlay": "Overlay backdrop",
  border: "Border",
  "border-strong": "Strong border",
  "border-focus": "Focus border",
  fg: "Text",
  "fg-muted": "Muted text",
  "fg-subtle": "Subtle text",
  "fg-inverted": "Inverted text",
  accent: "Accent",
  "accent-hover": "Accent hover",
  "accent-fg": "Accent text",
  "accent-soft": "Accent soft fill",
  "bubble-in-bg": "Incoming bubble",
  "bubble-in-fg": "Incoming bubble text",
  "bubble-out-bg": "Outgoing bubble",
  "bubble-out-fg": "Outgoing bubble text",
  "quote-bar": "Quote bar",
  success: "Success",
  warning: "Warning",
  danger: "Danger",
  info: "Info",
  "shadow-sm": "Small shadow",
  "shadow-md": "Medium shadow",
  "shadow-lg": "Large shadow",
};

const SCALE_STEPS = [0.8, 0.9, 1, 1.1, 1.2, 1.3, 1.4, 1.5, 1.6];

/** Six hex digits only: the one shape `<input type="color">` accepts. */
function isEditableHexColor(value: string): boolean {
  return /^#[0-9a-f]{6}$/i.test(value.trim());
}

function swatchStyle(token: ThemeToken, value: string): JSX.CSSProperties {
  if (token.startsWith("shadow")) return { background: "var(--bg-elevated)", "box-shadow": value };
  return { background: value };
}

function uniqueThemeName(base: string, existing: readonly Theme[]): string {
  const taken = new Set(existing.map((theme) => theme.name));
  let candidate = `${base} copy`;
  for (let suffix = 2; taken.has(candidate); suffix += 1) candidate = `${base} copy ${suffix}`;
  return candidate;
}

export function SettingsPanel(props: { model: AppModel }) {
  const { state, actions, preferences, prefActions } = props.model;
  const [activeSection, setActiveSection] = createSignal<SettingsSection>("appearance");
  const [editingThemeId, setEditingThemeId] = createSignal("");
  const [importText, setImportText] = createSignal("");
  const [importStatus, setImportStatus] = createSignal<{ kind: "error" | "success"; message: string } | null>(null);
  const [exportStatus, setExportStatus] = createSignal("");
  const [storageError, setStorageError] = createSignal("");

  const editingTheme = () => preferences.customThemes.find((theme) => theme.id === editingThemeId());

  function selectSection(section: SettingsSection) {
    setActiveSection(section);
  }

  function duplicate(theme: Theme, openEditor: boolean) {
    const copy = prefActions.duplicateTheme(theme, uniqueThemeName(theme.name, prefActions.availableThemes()));
    prefActions.selectTheme(copy.id);
    if (openEditor) setEditingThemeId(copy.id);
  }

  function deleteTheme(theme: Theme) {
    prefActions.deleteCustomTheme(theme.id);
    if (editingThemeId() === theme.id) setEditingThemeId("");
  }

  async function copyThemeJson(theme: Theme) {
    try {
      await navigator.clipboard.writeText(exportTheme(theme));
      setExportStatus(`Copied "${theme.name}" to the clipboard.`);
    } catch {
      setExportStatus("Could not use the clipboard; try the download instead.");
    }
  }

  function downloadThemeJson(theme: Theme) {
    const blob = new Blob([exportTheme(theme)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = `${theme.id}.json`;
    link.click();
    URL.revokeObjectURL(url);
  }

  function updateToken(theme: Theme, token: ThemeToken, value: string) {
    prefActions.saveCustomTheme({ ...theme, tokens: { ...theme.tokens, [token]: value } });
  }

  function renameEditingTheme(theme: Theme, name: string) {
    prefActions.saveCustomTheme({ ...theme, name });
  }

  function importPastedTheme() {
    const imported = prefActions.importTheme(importText());
    if (!imported) {
      setImportStatus({ kind: "error", message: "That JSON is not a usable theme. Make sure it was exported from Rust Meow." });
      return;
    }
    prefActions.selectTheme(imported.id);
    setImportText("");
    setImportStatus({ kind: "success", message: `Imported "${imported.name}" and switched to it.` });
  }

  async function browseForDownloadDir() {
    setStorageError("");
    try {
      // `directory: true` is what backs a folder picker rather than a file
      // picker; the bridge's `FilePickerOptions` type already allows it.
      const path = await openFile({ directory: true, title: "Choose where Rust Meow saves files" });
      if (path) prefActions.update("downloadDir", path);
    } catch (error) {
      setStorageError(normalizeBridgeError(error).message);
    }
  }

  return (
    <aside class="right-panel settings-panel" aria-label="Settings">
      <header class="right-panel-header">
        <IconButton label="Close settings" onClick={() => actions.toggleSettings(false)}><X size={20} /></IconButton>
        <h2>Settings</h2>
      </header>
      <div class="right-panel-scroll">
        <nav class="settings-nav" aria-label="Settings sections">
          <For each={SETTINGS_SECTIONS}>
            {(section) => (
              <button
                type="button"
                class={`settings-nav-item ${activeSection() === section.id ? "active" : ""}`}
                aria-current={activeSection() === section.id ? "page" : undefined}
                onClick={() => selectSection(section.id)}
              >
                <section.icon size={17} />
                <span>{section.label}</span>
              </button>
            )}
          </For>
        </nav>

        <div class="settings-page">
          <Show when={activeSection() === "appearance"}>
            <section class="settings-section">
              <h3>Theme</h3>
              <div class="theme-grid">
                <For each={prefActions.availableThemes()}>
                  {(theme) => (
                    <div class={`theme-card ${theme.id === preferences.themeId ? "active" : ""}`}>
                      <button type="button" onClick={() => prefActions.selectTheme(theme.id)}>
                        <span class="theme-swatch" style={{ background: theme.tokens["bg-app"] }} />
                        <span class="theme-swatch" style={{ background: theme.tokens["bubble-out-bg"] }} />
                        <span class="theme-swatch" style={{ background: theme.tokens["bubble-in-bg"] }} />
                        <span class="theme-swatch" style={{ background: theme.tokens.accent }} />
                        <span>{theme.name}</span>
                      </button>
                      <div style={{ display: "flex", gap: "2px" }}>
                        <IconButton label={`Duplicate ${theme.name}`} onClick={() => duplicate(theme, false)}><Copy size={15} /></IconButton>
                        <Show when={!theme.builtin}>
                          <IconButton label={`Edit ${theme.name}`} onClick={() => setEditingThemeId(theme.id)}><Pencil size={15} /></IconButton>
                          <IconButton label={`Delete ${theme.name}`} onClick={() => deleteTheme(theme)}><Trash2 size={15} /></IconButton>
                        </Show>
                        <IconButton label={`Copy ${theme.name} as JSON`} onClick={() => void copyThemeJson(theme)}><ClipboardCopy size={15} /></IconButton>
                        <IconButton label={`Download ${theme.name}`} onClick={() => downloadThemeJson(theme)}><Download size={15} /></IconButton>
                      </div>
                    </div>
                  )}
                </For>
              </div>
              <button
                type="button"
                class="secondary-button"
                style={{ "margin-top": "12px" }}
                onClick={() => duplicate(prefActions.activeTheme(), true)}
              >
                <Plus size={16} style={{ "vertical-align": "middle", "margin-right": "6px" }} />
                New theme
              </button>
              <Show when={exportStatus()}><p>{exportStatus()}</p></Show>
            </section>

            <Show when={editingTheme()}>
              {(theme) => (
                <section class="settings-section">
                  <h3>Edit theme</h3>
                  <div class="theme-editor">
                    <div class="setting-row">
                      <span class="setting-copy"><strong>Name</strong></span>
                      <input
                        type="text"
                        value={theme().name}
                        onChange={(event) => renameEditingTheme(theme(), event.currentTarget.value)}
                      />
                    </div>
                    <For each={THEME_TOKENS}>
                      {(token) => (
                        <div class="token-row">
                          <span>{TOKEN_LABELS[token]}</span>
                          <span class="token-swatch" style={swatchStyle(token, theme().tokens[token])} />
                          <Show
                            when={isEditableHexColor(theme().tokens[token])}
                            fallback={
                              <input
                                type="text"
                                value={theme().tokens[token]}
                                onChange={(event) => updateToken(theme(), token, event.currentTarget.value)}
                              />
                            }
                          >
                            <input
                              type="color"
                              value={theme().tokens[token]}
                              onInput={(event) => updateToken(theme(), token, event.currentTarget.value)}
                            />
                          </Show>
                        </div>
                      )}
                    </For>
                  </div>
                </section>
              )}
            </Show>

            <section class="settings-section">
              <h3>Import a theme</h3>
              <p>Paste theme JSON exported from Rust Meow, then import it as a new custom theme.</p>
              <textarea
                rows={6}
                value={importText()}
                placeholder='{"name": "My theme", "tokens": { "...": "..." } }'
                onInput={(event) => setImportText(event.currentTarget.value)}
              />
              <button type="button" class="secondary-button" style={{ "margin-top": "8px" }} onClick={importPastedTheme}>
                Import theme
              </button>
              <Show when={importStatus()}>{(status) => <p>{status().message}</p>}</Show>
            </section>

            <section class="settings-section">
              <h3>Interface</h3>
              <div class="setting-row">
                <span class="setting-copy"><strong>Interface size</strong><span>{Math.round(preferences.uiScale * 100)}%</span></span>
                <div class="segmented-control">
                  <For each={SCALE_STEPS}>
                    {(scale) => (
                      <button
                        type="button"
                        class={preferences.uiScale === scale ? "active" : ""}
                        onClick={() => prefActions.update("uiScale", scale)}
                      >
                        {Math.round(scale * 100)}
                      </button>
                    )}
                  </For>
                </div>
              </div>
              <div class="setting-row">
                <span class="setting-copy"><strong>Density</strong><span>Compact tightens spacing for more messages on screen</span></span>
                <div class="segmented-control">
                  <button
                    type="button"
                    class={preferences.density === "comfortable" ? "active" : ""}
                    onClick={() => prefActions.update("density", "comfortable")}
                  >
                    Comfortable
                  </button>
                  <button
                    type="button"
                    class={preferences.density === "compact" ? "active" : ""}
                    onClick={() => prefActions.update("density", "compact")}
                  >
                    Compact
                  </button>
                </div>
              </div>
              <div class="setting-row">
                <span class="setting-copy"><strong>Battery saver</strong><span>Reduce animation and off-screen rendering work</span></span>
                <Toggle
                  checked={preferences.batterySaver}
                  label="Battery saver"
                  onChange={(value) => prefActions.update("batterySaver", value)}
                />
              </div>
            </section>
          </Show>

          <Show when={activeSection() === "chats"}>
            <section class="settings-section">
              <div class="setting-row">
                <span class="setting-copy"><strong>Send with Enter</strong><span>Enter sends the message; Shift+Enter inserts a new line</span></span>
                <Toggle
                  checked={preferences.enterToSend}
                  label="Send with Enter"
                  onChange={(value) => prefActions.update("enterToSend", value)}
                />
              </div>
              <div class="setting-row">
                <span class="setting-copy"><strong>Always show member list</strong><span>Keep the member list docked open for group chats</span></span>
                <Toggle
                  checked={preferences.memberPanelOpen}
                  label="Always show member list"
                  onChange={(value) => prefActions.update("memberPanelOpen", value)}
                />
              </div>
              <div class="setting-row">
                <span class="setting-copy"><strong>Show tab bar</strong><span>Keep open chats as tabs in the title bar</span></span>
                <Toggle
                  checked={preferences.showTabBar}
                  label="Show tab bar"
                  onChange={(value) => prefActions.update("showTabBar", value)}
                />
              </div>
              <div class="setting-row">
                <span class="setting-copy"><strong>Split view</strong><span>Show two conversation panes side by side</span></span>
                <Toggle
                  checked={preferences.splitView}
                  label="Split view"
                  onChange={(value) => prefActions.update("splitView", value)}
                />
              </div>
            </section>
          </Show>

          <Show when={activeSection() === "storage"}>
            <section class="settings-section">
              <h3>Save location</h3>
              <div class="path-row">
                <span class="path-value">{preferences.downloadDir || "Ask every time"}</span>
                <button type="button" class="secondary-button" onClick={() => void browseForDownloadDir()}>Browse…</button>
                <Show when={preferences.downloadDir}>
                  <button type="button" class="secondary-button" onClick={() => prefActions.update("downloadDir", "")}>Clear</button>
                </Show>
              </div>
              <Show when={storageError()}><p>{storageError()}</p></Show>
              <p>This only affects files you explicitly save out of Rust Meow. The encrypted local message cache always stays in the app's own data directory.</p>
            </section>
          </Show>

          <Show when={activeSection() === "about"}>
            <section class="settings-section">
              <div class="profile-hero">
                <div class="brand-mark" style={{ width: "76px", height: "76px", "border-radius": "24px" }}>
                  <span style={{ "font-size": "34px", "font-weight": 800 }}>M</span>
                </div>
                <h2>Rust Meow</h2>
                <p>Backend {state.backendVersion || "starting"}</p>
              </div>
              <div class="info-row"><ShieldCheck size={18} /><span>Your linked-device credentials never enter this webview.</span></div>
              <div class="info-row"><LockKeyhole size={18} /><span>Your session and message cache stay on this computer, encrypted at rest.</span></div>
            </section>
            <div class="info-section">
              <button type="button" class="danger-button" onClick={() => actions.setLogoutConfirmation(true)}>
                <LogOut size={17} style={{ "vertical-align": "middle", "margin-right": "7px" }} />
                Log out and remove local account data
              </button>
            </div>
          </Show>
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
