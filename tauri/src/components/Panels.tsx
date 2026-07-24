import { createSignal, For, onMount, Show } from "solid-js";
import type { JSX } from "solid-js";
import {
  Archive,
  BadgeCheck,
  BellOff,
  BellRing,
  CalendarDays,
  ClipboardCopy,
  Clock3,
  Copy,
  Download,
  Globe,
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
import { ChatKind } from "../lib/types";
import { formatDay } from "../lib/format";
import {
  listDesktopApplications,
  normalizeBridgeError,
  openFile,
  type DesktopApplications,
} from "../lib/bridge";
import { exportTheme, THEME_TOKENS, type Theme, type ThemeToken } from "../lib/theme";
import { Avatar } from "./Avatar";
import { ParticipantList } from "./ParticipantList";
import { EmptyState, IconButton, Spinner } from "./Primitives";
import { ThemeIcon, type ThemeIconName } from "./ThemeIcon";

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
          <EmptyState style={{ height: "180px" }}><Spinner label="Loading details" /></EmptyState>
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
                  <ParticipantList
                    model={props.model}
                    participants={value().participants}
                    rosterId={value().chat?.id ?? chat()?.id ?? ""}
                    label="Group participants"
                  />
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

function SettingRow(props: { title: string; description: string; children: JSX.Element }) {
  return <div class="setting-row">
    <span class="setting-copy"><strong>{props.title}</strong><span>{props.description}</span></span>
    {props.children}
  </div>;
}

type SettingsSection = "appearance" | "chats" | "notifications" | "storage" | "desktop" | "about";

const SETTINGS_SECTIONS: ReadonlyArray<{
  id: SettingsSection;
  label: string;
  icon: (props: { size?: number; class?: string }) => JSX.Element;
  iconName: ThemeIconName;
}> = [
  { id: "appearance", label: "Appearance", icon: Palette, iconName: "palette" },
  { id: "chats", label: "Chats", icon: MessagesSquare, iconName: "messages" },
  { id: "notifications", label: "Notifications", icon: BellRing, iconName: "bell" },
  { id: "storage", label: "Storage", icon: HardDrive, iconName: "storage" },
  { id: "desktop", label: "Desktop apps", icon: Globe, iconName: "globe" },
  { id: "about", label: "About & privacy", icon: ShieldCheck, iconName: "shield" },
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
  const [desktopApplications, setDesktopApplications] = createSignal<DesktopApplications | null>(null);
  const [desktopApplicationsError, setDesktopApplicationsError] = createSignal("");
  const linuxDesktopHost = navigator.userAgent.includes("Linux");

  const editingTheme = () => preferences.customThemes.find((theme) => theme.id === editingThemeId());
  const visibleSettingsSections = () =>
    SETTINGS_SECTIONS.filter((section) => section.id !== "desktop" || linuxDesktopHost);
  const browserSelectionMissing = () =>
    Boolean(
      preferences.linuxBrowserApp &&
      !desktopApplications()?.browsers.some((application) => application.id === preferences.linuxBrowserApp),
    );
  const fileManagerSelectionMissing = () =>
    Boolean(
      preferences.linuxFileManagerApp &&
      !desktopApplications()?.fileManagers.some(
        (application) => application.id === preferences.linuxFileManagerApp,
      ),
    );

  onMount(() => {
    if (!linuxDesktopHost) return;
    void listDesktopApplications()
      .then(setDesktopApplications)
      .catch((error: unknown) => {
        setDesktopApplicationsError(normalizeBridgeError(error).message);
      });
  });

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

  function updateVisualStyle(theme: Theme, visualStyle: Theme["visualStyle"]) {
    prefActions.saveCustomTheme({ ...theme, visualStyle });
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
        <IconButton label="Close settings" onClick={() => actions.toggleSettings(false)}>
          <ThemeIcon icon={X} name="close" size={20} />
        </IconButton>
        <h2>Settings</h2>
      </header>
      <div class="right-panel-scroll">
        <nav class="settings-nav" aria-label="Settings sections">
          <For each={visibleSettingsSections()}>
            {(section) => (
              <button
                type="button"
                class={`settings-nav-item ${activeSection() === section.id ? "active" : ""}`}
                aria-current={activeSection() === section.id ? "page" : undefined}
                onClick={() => selectSection(section.id)}
              >
                <ThemeIcon icon={section.icon} name={section.iconName} size={17} />
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
                      <button class="theme-card-select" type="button" onClick={() => prefActions.selectTheme(theme.id)}>
                        <span
                          class={`theme-material-preview ${theme.visualStyle}`}
                          style={{
                            "--preview-bg": theme.tokens["bg-app"],
                            "--preview-panel": theme.tokens["bg-panel"],
                            "--preview-border": theme.tokens.border,
                            "--preview-in": theme.tokens["bubble-in-bg"],
                            "--preview-out": theme.tokens["bubble-out-bg"],
                            "--preview-accent": theme.tokens.accent,
                          }}
                          aria-hidden="true"
                        >
                          <span class="theme-preview-bar" />
                          <span class="theme-preview-sidebar">
                            <i /><i class="active" /><i />
                          </span>
                          <span class="theme-preview-chat">
                            <i class="incoming" /><i class="outgoing" /><i class="incoming short" />
                          </span>
                        </span>
                        <span class="theme-card-name">
                          <span>{theme.name}</span>
                          <small>{theme.visualStyle === "skeuomorphic" ? "Skeuomorphic" : theme.appearance}</small>
                        </span>
                      </button>
                      <div style={{ display: "flex", gap: "2px" }}>
                        <IconButton label={`Duplicate ${theme.name}`} onClick={() => duplicate(theme, false)}>
                          <ThemeIcon icon={Copy} name="copy" size={15} />
                        </IconButton>
                        <Show when={!theme.builtin}>
                          <IconButton label={`Edit ${theme.name}`} onClick={() => setEditingThemeId(theme.id)}>
                            <ThemeIcon icon={Pencil} name="edit" size={15} />
                          </IconButton>
                          <IconButton label={`Delete ${theme.name}`} onClick={() => deleteTheme(theme)}>
                            <ThemeIcon icon={Trash2} name="trash" size={15} />
                          </IconButton>
                        </Show>
                        <IconButton label={`Copy ${theme.name} as JSON`} onClick={() => void copyThemeJson(theme)}>
                          <ThemeIcon icon={ClipboardCopy} name="copy" size={15} />
                        </IconButton>
                        <IconButton label={`Download ${theme.name}`} onClick={() => downloadThemeJson(theme)}>
                          <ThemeIcon icon={Download} name="download" size={15} />
                        </IconButton>
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
                    <div class="setting-row">
                      <span class="setting-copy">
                        <strong>Component style</strong>
                        <span>Modern stays flat; skeuomorphic adds bundled tactile materials.</span>
                      </span>
                      <div class="segmented-control">
                        <button
                          type="button"
                          class={theme().visualStyle === "modern" ? "active" : ""}
                          onClick={() => updateVisualStyle(theme(), "modern")}
                        >
                          Modern
                        </button>
                        <button
                          type="button"
                          class={theme().visualStyle === "skeuomorphic" ? "active" : ""}
                          onClick={() => updateVisualStyle(theme(), "skeuomorphic")}
                        >
                          Skeuomorphic
                        </button>
                      </div>
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
              <SettingRow title="Interface size" description={`${Math.round(preferences.uiScale * 100)}%`}>
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
              </SettingRow>
              <SettingRow title="Density" description="Compact tightens spacing for more messages on screen">
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
              </SettingRow>
              <SettingRow title="Battery saver" description="Reduce animation and off-screen rendering work">
                <Toggle
                  checked={preferences.batterySaver}
                  label="Battery saver"
                  onChange={(value) => prefActions.update("batterySaver", value)}
                />
              </SettingRow>
            </section>
          </Show>

          <Show when={activeSection() === "chats"}>
            <section class="settings-section">
              <SettingRow title="Send with Enter" description="Enter sends the message; Shift+Enter inserts a new line">
                <Toggle
                  checked={preferences.enterToSend}
                  label="Send with Enter"
                  onChange={(value) => prefActions.update("enterToSend", value)}
                />
              </SettingRow>
              <SettingRow title="Show chat list" description="Keep the chat list docked beside the workspace">
                <Toggle
                  checked={!preferences.sidebarCollapsed}
                  label="Show chat list"
                  onChange={(value) => prefActions.update("sidebarCollapsed", !value)}
                />
              </SettingRow>
              <SettingRow title="Show member list" description="Dock the optional member list beside group chats">
                <Toggle
                  checked={preferences.memberPanelOpen}
                  label="Show member list"
                  onChange={(value) => prefActions.update("memberPanelOpen", value)}
                />
              </SettingRow>
              <SettingRow title="Show tab bar" description="Keep open chats as tabs in the title bar">
                <Toggle
                  checked={preferences.showTabBar}
                  label="Show tab bar"
                  onChange={(value) => prefActions.update("showTabBar", value)}
                />
              </SettingRow>
              <SettingRow title="Split view" description="Show two conversation panes side by side">
                <Toggle
                  checked={preferences.splitView}
                  label="Split view"
                  onChange={(value) => {
                    if (value && state.panes.length < 2) actions.splitPane();
                    if (!value && state.panes.length >= 2) {
                      const secondary = state.panes.find((pane) => pane.id !== state.focusedPaneId);
                      if (secondary) actions.closePane(secondary.id);
                    }
                    prefActions.update("splitView", value);
                  }}
                />
              </SettingRow>
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

          <Show when={activeSection() === "notifications"}>
            <section class="settings-section">
              <SettingRow title="Desktop notifications" description="Notify for background messages from unmuted chats">
                <Toggle
                  checked={preferences.notificationsEnabled}
                  label="Desktop notifications"
                  onChange={(value) => void actions.setNotificationsEnabled(value)}
                />
              </SettingRow>
              <SettingRow title="Message previews" description="Include message text in operating system notifications">
                <Toggle
                  checked={preferences.notificationPreviews}
                  label="Message previews"
                  disabled={!preferences.notificationsEnabled}
                  onChange={(value) => prefActions.update("notificationPreviews", value)}
                />
              </SettingRow>
              <p>Notifications are suppressed while the conversation is visible and when a chat is muted. Opening one routes to the exact message.</p>
            </section>
          </Show>

          <Show when={activeSection() === "desktop" && linuxDesktopHost}>
            <section class="settings-section">
              <h3>Linux application handlers</h3>
              <p>
                Choose which installed desktop applications Rust Meow launches.
                System default uses your XDG associations.
              </p>
              <SettingRow title="Open links with" description="Used for HTTP and HTTPS links in messages">
                <select
                  class="setting-select"
                  aria-label="Browser used to open links"
                  value={preferences.linuxBrowserApp}
                  disabled={!desktopApplications()}
                  onChange={(event) => prefActions.update("linuxBrowserApp", event.currentTarget.value)}
                >
                  <option value="">System default (xdg-open)</option>
                  <Show when={browserSelectionMissing()}>
                    <option value={preferences.linuxBrowserApp}>
                      Unavailable ({preferences.linuxBrowserApp})
                    </option>
                  </Show>
                  <For each={desktopApplications()?.browsers ?? []}>
                    {(application) => <option value={application.id}>{application.name}</option>}
                  </For>
                </select>
              </SettingRow>
              <SettingRow
                title="Show files with"
                description="Used by Show in file manager on downloaded media"
              >
                <select
                  class="setting-select"
                  aria-label="File manager used to reveal downloaded files"
                  value={preferences.linuxFileManagerApp}
                  disabled={!desktopApplications()}
                  onChange={(event) =>
                    prefActions.update("linuxFileManagerApp", event.currentTarget.value)
                  }
                >
                  <option value="">System default (xdg-open)</option>
                  <Show when={fileManagerSelectionMissing()}>
                    <option value={preferences.linuxFileManagerApp}>
                      Unavailable ({preferences.linuxFileManagerApp})
                    </option>
                  </Show>
                  <For each={desktopApplications()?.fileManagers ?? []}>
                    {(application) => <option value={application.id}>{application.name}</option>}
                  </For>
                </select>
              </SettingRow>
              <Show when={!desktopApplications() && !desktopApplicationsError()}>
                <p>Finding installed desktop applications…</p>
              </Show>
              <Show when={desktopApplicationsError()}>
                {(error) => <p>{error()}</p>}
              </Show>
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
