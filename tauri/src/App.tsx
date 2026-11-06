import { createEffect, createSignal, For, onCleanup, onMount, Show } from "solid-js";
import {
  Files,
  MessageCircle,
  Search,
  Settings,
  ShieldCheck,
  Bot,
} from "lucide-solid";
import { createAppModel } from "./state/app";
import { Sidebar } from "./components/Sidebar";
import { Conversation } from "./components/Conversation";
import { TitleBar } from "./components/TitleBar";
import { MemberPanel } from "./components/MemberPanel";
import { ChatSwitcher } from "./components/ChatSwitcher";
import { SpotlightSearch } from "./components/SpotlightSearch";
import { ChatInfoPanel, SettingsPanel } from "./components/Panels";
import {
  EmptyConversation,
  FatalScreen,
  FileSendDialog,
  ForwardDialog,
  ImageViewer,
  LogoutDialog,
  PairingScreen,
  StartupScreen,
  Toasts,
} from "./components/Screens";
import { IconButton } from "./components/Primitives";
import { ThemeIcon } from "./components/ThemeIcon";
import { AgentControlPanel } from "./components/AgentControlPanel";
import { bridge, listenForFileDrops } from "./lib/bridge";
import { classifyDroppedFiles } from "./lib/file-drop";
import { disableAgentControlIfNeeded } from "./lib/agent-control-gate";
import { isEditableTarget, resolveVimCommand, type VimCommand } from "./lib/vim-navigation";

export default function App() {
  const model = createAppModel();
  const { state, actions, preferences, prefActions } = model;
  if (window.__RUST_MEOW_PERF_CONFIG__) {
    window.__RUST_MEOW_PERF_INSPECT__ = {
      chatCount: () => state.chats.length,
      messageCount: () => state.conversations[state.selectedChatId]?.messages.length ?? 0,
      participantCount: () => state.chatInfo?.participantCount ?? 0,
    };
  }
  let searchInput: HTMLInputElement | undefined;
  const [spotlightOpen, setSpotlightOpen] = createSignal(false);
  const [fileDropActive, setFileDropActive] = createSignal(false);
  const [agentControlOpen, setAgentControlOpen] = createSignal(false);
  const agentControlVisible = () =>
    preferences.agentControlExperimentEnabled && agentControlOpen();
  let unlistenFileDrops: (() => void) | undefined;
  let disposed = false;
  let vimPendingG = false;
  let vimPendingTimer: number | undefined;
  onMount(() => {
    void actions.bootstrap().then(async () => {
      if (!preferences.agentControlExperimentEnabled) {
        await disableAgentControlIfNeeded(bridge);
      }
    }).catch(actions.notifyError);
    // A restored session snapshot (see `state/workspace.ts`) already wins if
    // it has two panes; this only kicks in for a fresh session (no snapshot,
    // or a single-pane one) where "split view" was left on last time.
    if (preferences.splitView && state.panes.length < 2) actions.splitPane();
    window.addEventListener("keydown", handleGlobalKeyDown, true);
    // Capture-phase, same as keydown: the chat switcher must commit on
    // Ctrl-release even when the overlay was opened while a composer or
    // search input had focus, so this cannot be a component-scoped handler.
    window.addEventListener("keyup", handleGlobalKeyUp, true);
    window.addEventListener("blur", handleBlur);
    void listenForFileDrops((event) => {
      if (event.type === "enter") {
        setFileDropActive(state.screen === "chats" && Boolean(state.selectedChatId));
        return;
      }
      setFileDropActive(false);
      if (event.type !== "drop" || state.screen !== "chats" || event.paths.length === 0) return;
      if (!state.selectedChatId) {
        actions.notifyError(new Error("Select a chat before dropping files."));
        return;
      }
      const batch = classifyDroppedFiles(event.paths);
      actions.requestFileSend(
        event.paths,
        batch.mode,
        batch.attachmentKind,
        false,
        state.selectedChatId,
      );
    }).then((unlisten) => {
      if (disposed) unlisten();
      else unlistenFileDrops = unlisten;
    }).catch(actions.notifyError);
  });
  createEffect(() => {
    if (!preferences.agentControlExperimentEnabled) setAgentControlOpen(false);
  });
  onCleanup(() => {
    disposed = true;
    if (vimPendingTimer !== undefined) window.clearTimeout(vimPendingTimer);
    unlistenFileDrops?.();
    actions.dispose();
    window.removeEventListener("keydown", handleGlobalKeyDown, true);
    window.removeEventListener("keyup", handleGlobalKeyUp, true);
    window.removeEventListener("blur", handleBlur);
  });

  return (
    <>
      {/* `.app-shell`'s grid assigns the "titlebar" row via the
          `.app-shell > .titlebar` selector, so on the chats screen the title
          bar has to be app-shell's first child to land in that row; on every
          other screen (which render outside any grid) it is a plain flow
          sibling placed above the screen. Either way exactly one `TitleBar`
          is mounted at a time — no undecorated edge ever shows. */}
      <Show when={state.screen !== "chats"}>
        <TitleBar model={model} />
      </Show>
      <Show when={state.screen === "starting"}><StartupScreen /></Show>
      <Show when={state.screen === "pairing"}><PairingScreen model={model} /></Show>
      <Show when={state.screen === "fatal"}><FatalScreen model={model} /></Show>
      <Show when={state.screen === "chats"}>
        <main
          class={`app-shell ${preferences.sidebarCollapsed ? "sidebar-collapsed" : ""}`}
          inert={Boolean(spotlightOpen() || agentControlVisible() || state.logoutConfirmation || state.imageViewer || state.forwardDialog || state.fileSendConfirmation)}
          aria-hidden={spotlightOpen() || agentControlVisible() || state.logoutConfirmation || state.imageViewer || state.forwardDialog || state.fileSendConfirmation ? "true" : undefined}
        >
          <TitleBar model={model} />
          <nav class="nav-rail" aria-label="Primary navigation">
            <div class="brand-mark" aria-label="Rust Meow">
              <ThemeIcon icon={MessageCircle} name="chat" size={22} />
            </div>
            <IconButton
              label={preferences.sidebarCollapsed ? "Show chat list" : "Hide chat list"}
              active={!preferences.sidebarCollapsed}
              onClick={() => prefActions.update("sidebarCollapsed", !preferences.sidebarCollapsed)}
            >
              <ThemeIcon icon={MessageCircle} name="chat" size={21} />
            </IconButton>
            <Show when={preferences.agentControlExperimentEnabled}>
              <IconButton label="Agent Control" active={agentControlOpen()} onClick={() => setAgentControlOpen(true)}>
                <ThemeIcon icon={Bot} name="chat" size={20} />
              </IconButton>
            </Show>
            <IconButton label="Quick search (Ctrl+K)" onClick={toggleSpotlight}>
              <ThemeIcon icon={Search} name="search" size={20} />
            </IconButton>
            <div class="nav-spacer" />
            <IconButton label="Privacy architecture" onClick={() => actions.toggleSettings(true)}>
              <ThemeIcon icon={ShieldCheck} name="shield" size={20} />
            </IconButton>
            <IconButton label="Settings" active={state.settingsOpen} onClick={() => actions.toggleSettings()}>
              <ThemeIcon icon={Settings} name="settings" size={20} />
            </IconButton>
          </nav>
          <Sidebar model={model} searchInputRef={(element) => (searchInput = element)} />
          <div class="workspace">
            <div class="pane-group">
              <For each={state.panes}>
                {(pane, index) => (
                  <>
                    <Show when={index() > 0}><div class="pane-divider" /></Show>
                    <div
                      class={`pane ${pane.id === state.focusedPaneId ? "pane-focused" : ""}`}
                      onPointerDown={() => actions.focusPane(pane.id)}
                      onFocusIn={() => actions.focusPane(pane.id)}
                    >
                      <Show when={pane.activeChatId} fallback={<EmptyConversation />}>
                        <Conversation model={model} chatId={pane.activeChatId} paneId={pane.id} />
                      </Show>
                    </div>
                  </>
                )}
              </For>
              {/* Overlay sheets over the pane group only — not a third grid
                  column — so `MemberPanel` keeps its docked slot below. */}
              <Show when={state.chatInfoOpen}><ChatInfoPanel model={model} /></Show>
              <Show when={state.settingsOpen}><SettingsPanel model={model} /></Show>
            </div>
            <MemberPanel model={model} />
          </div>
        </main>
      </Show>
      <Show when={agentControlVisible()}><AgentControlPanel model={model} onClose={() => setAgentControlOpen(false)} /></Show>
      <ChatSwitcher model={model} />
      <SpotlightSearch model={model} open={spotlightOpen()} onClose={() => setSpotlightOpen(false)} />
      <p class="sr-only" role="status" aria-live="polite" aria-atomic="true">
        {state.tabAnnouncement}
      </p>
      <ImageViewer model={model} />
      <ForwardDialog model={model} />
      <FileSendDialog model={model} />
      <Show when={fileDropActive()}>
        <div class="file-drop-overlay" role="status" aria-live="polite">
          <div class="file-drop-card">
            <Files size={32} />
            <strong>Drop files to review</strong>
            <span>
              Nothing will be sent until you confirm
              {actions.selectedChat()?.title ? ` for ${actions.selectedChat()!.title}` : ""}.
            </span>
          </div>
        </div>
      </Show>
      <LogoutDialog model={model} />
      <Toasts model={model} />
    </>
  );

  function handleGlobalKeyDown(event: KeyboardEvent) {
    if (state.screen !== "chats") return;
    const editing = isEditableTarget(event.target);

    if ((event.ctrlKey || event.metaKey) && event.key.toLocaleLowerCase() === "k") {
      toggleSpotlight();
      event.preventDefault();
      return;
    }
    if (editing) {
      if (event.key === "Escape") {
        (event.target as HTMLElement).blur();
        event.preventDefault();
      }
      return;
    }
    if (spotlightOpen()) {
      if (event.key === "Escape") {
        setSpotlightOpen(false);
        event.preventDefault();
      }
      return;
    }
    if (agentControlOpen()) {
      if (event.key === "Escape") {
        setAgentControlOpen(false);
        event.preventDefault();
      }
      return;
    }

    // G4: first Ctrl+Tab opens the alt-tab-style overlay; further presses
    // while it is open only move the highlight, never switch chats outright.
    if (event.ctrlKey && event.key === "Tab") {
      if (state.switcher) actions.cycleSwitcher(event.shiftKey);
      else actions.openSwitcher(event.shiftKey);
      event.preventDefault();
      return;
    }
    if (event.ctrlKey && event.key === "\\") {
      toggleSplit();
      event.preventDefault();
      return;
    }
    if (!editing) {
      if (vimPendingG && event.key !== "g") resetVimPending();
      const command = resolveVimCommand(event);
      if (command && handleVimCommand(command)) {
        event.preventDefault();
        return;
      }
    }
    if (event.key === "Escape") {
      resetVimPending();
      if (state.switcher) actions.cancelSwitcher();
      else if (state.fileSendConfirmation) actions.cancelFileSend();
      else if (state.forwardDialog) actions.cancelForward();
      else if (state.logoutConfirmation) actions.setLogoutConfirmation(false);
      else if (state.imageViewer) actions.closeImage();
      else if (state.chatInfoOpen) actions.hideChatInfo();
      else if (state.settingsOpen) actions.toggleSettings(false);
      else if (state.searchQuery) actions.clearSearch();
    }
  }

  function handleVimCommand(command: VimCommand): boolean {
    if (command === "pending-g") {
      if (vimPendingG) {
        resetVimPending();
        moveVimVertical(-1, true);
      } else {
        vimPendingG = true;
        vimPendingTimer = window.setTimeout(resetVimPending, 700);
      }
      return true;
    }
    resetVimPending();
    switch (command) {
      case "move-up":
        moveVimVertical(-1, false);
        return true;
      case "move-down":
        moveVimVertical(1, false);
        return true;
      case "move-left":
        moveVimHorizontal(-1);
        return true;
      case "move-right":
        moveVimHorizontal(1);
        return true;
      case "last":
        moveVimVertical(1, true);
        return true;
      case "focus-composer":
        focusComposer();
        return true;
      case "focus-search":
        focusSidebarSearch();
        return true;
      case "toggle-spotlight":
        toggleSpotlight();
        return true;
      case "close-tab":
        if (state.selectedChatId) actions.closeChat();
        return true;
      case "reply":
      case "edit":
      case "forward":
      case "pin":
        return invokeSelectedMessageAction(command);
      case "toggle-members":
        prefActions.update("memberPanelOpen", !preferences.memberPanelOpen);
        return true;
      case "chat-info":
        void actions.showChatInfo();
        return true;
      case "settings":
        actions.toggleSettings();
        return true;
    }
  }

  function moveVimVertical(direction: -1 | 1, boundary: boolean) {
    const active = document.activeElement;
    if (active?.closest(".message-scroller, .message-row")) {
      window.dispatchEvent(new CustomEvent("rust-meow-vim-message", {
        detail: { chatId: state.selectedChatId, direction, boundary },
      }));
      return;
    }
    if (active?.closest(".tab")) {
      moveVimTabs(direction, boundary);
      return;
    }
    navigateVimChats(direction, boundary);
  }

  function moveVimHorizontal(direction: -1 | 1) {
    const active = document.activeElement;
    if (active?.closest(".message-scroller, .message-row")) {
      if (direction < 0) focusSidebarSearch();
      else focusComposer();
      return;
    }
    if (active?.closest(".chat-row")) {
      if (direction > 0) focusMessageSurface();
      else focusSidebarSearch();
      return;
    }
    if (active?.closest(".tab")) {
      moveVimTabs(direction, false);
      return;
    }
    const paneIndex = state.panes.findIndex((pane) => pane.id === state.focusedPaneId);
    const nextPane = state.panes[paneIndex + direction];
    if (nextPane) actions.focusPane(nextPane.id);
    else if (direction > 0) focusMessageSurface();
    else focusSidebarSearch();
  }

  function navigateVimChats(direction: -1 | 1, boundary: boolean) {
    const chats = actions.filteredChats();
    if (chats.length === 0) return;
    const current = chats.findIndex((chat) => chat.id === state.selectedChatId);
    const index = boundary
      ? (direction > 0 ? chats.length - 1 : 0)
      : Math.max(0, Math.min(chats.length - 1, (current < 0 ? (direction > 0 ? -1 : chats.length) : current) + direction));
    const chat = chats[index];
    if (!chat) return;
    void actions.selectChat(chat.id);
    requestAnimationFrame(() => document.querySelector<HTMLButtonElement>(`.chat-row[aria-current="page"]`)?.focus());
  }

  function moveVimTabs(direction: -1 | 1, boundary: boolean) {
    const tabs = [...document.querySelectorAll<HTMLButtonElement>(".pane-focused .tab")];
    if (tabs.length === 0) return;
    const active = document.activeElement?.closest<HTMLButtonElement>(".tab");
    const current = active ? tabs.indexOf(active) : -1;
    const index = boundary
      ? (direction > 0 ? tabs.length - 1 : 0)
      : Math.max(0, Math.min(tabs.length - 1, (current < 0 ? (direction > 0 ? -1 : tabs.length) : current) + direction));
    const next = tabs[index];
    if (next) {
      next.focus();
      next.click();
    }
  }

  function focusComposer() {
    document.querySelector<HTMLTextAreaElement>(".pane-focused .composer-input")?.focus();
  }

  function focusMessageSurface() {
    document.querySelector<HTMLElement>(".pane-focused .message-scroller")?.focus();
  }

  function focusSidebarSearch() {
    if (preferences.sidebarCollapsed) prefActions.update("sidebarCollapsed", false);
    requestAnimationFrame(() => searchInput?.focus());
  }

  function invokeSelectedMessageAction(command: Extract<VimCommand, "reply" | "edit" | "forward" | "pin">): boolean {
    const row = document.activeElement?.closest<HTMLElement>(".message-row");
    const chatId = state.selectedChatId;
    const messageId = row?.dataset.messageId;
    if (!chatId || !messageId) return false;
    const message = state.conversations[chatId]?.messages.find((candidate) => candidate.id === messageId);
    if (!message) return false;
    if (command === "reply") actions.replyTo(messageId, chatId);
    else if (command === "edit") actions.editMessage(messageId, chatId);
    else if (command === "forward") actions.startForward(messageId, chatId);
    else void actions.setMessagePin(
      messageId,
      !(state.pinnedMessages[chatId] ?? []).some((pin) => pin.messageId === messageId),
      chatId,
    );
    return true;
  }
  function resetVimPending() {
    vimPendingG = false;
    if (vimPendingTimer !== undefined) {
      window.clearTimeout(vimPendingTimer);
      vimPendingTimer = undefined;
    }
  }


  /** Releasing Ctrl commits the chat switcher's highlighted row (G4). */
  function handleGlobalKeyUp(event: KeyboardEvent) {
    if (event.key === "Control" && state.switcher) actions.commitSwitcher();
  }

  /** A lost keyup — e.g. the window loses focus mid-gesture — must not
   * strand the switcher open forever, so blur cancels rather than commits. */
  function handleBlur() {
    actions.stopTyping();
    if (state.switcher) actions.cancelSwitcher();
  }

  /** Shared by the title bar's split button and the `Ctrl+\` shortcut. */
  function toggleSplit() {
    if (state.panes.length >= 2) {
      const other = state.panes.find((pane) => pane.id !== state.focusedPaneId);
      if (other) actions.closePane(other.id);
    } else {
      actions.splitPane();
    }
    prefActions.update("splitView", state.panes.length >= 2);
  }

  function toggleSpotlight() {
    if (!spotlightOpen() && (
      state.logoutConfirmation ||
      state.imageViewer ||
      state.forwardDialog ||
      state.fileSendConfirmation
    )) {
      return;
    }
    if (!spotlightOpen()) actions.cancelSwitcher();
    setSpotlightOpen((open) => !open);
  }
}
