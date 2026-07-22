import { For, onCleanup, onMount, Show } from "solid-js";
import {
  Archive,
  MessageCircle,
  Settings,
  ShieldCheck,
} from "lucide-solid";
import { createAppModel } from "./state/app";
import { Sidebar } from "./components/Sidebar";
import { Conversation } from "./components/Conversation";
import { TitleBar } from "./components/TitleBar";
import { Tabs } from "./components/Tabs";
import { MemberPanel } from "./components/MemberPanel";
import { ChatSwitcher } from "./components/ChatSwitcher";
import { ChatInfoPanel, SettingsPanel } from "./components/Panels";
import {
  EmptyConversation,
  FatalScreen,
  ImageViewer,
  LogoutDialog,
  PairingScreen,
  StartupScreen,
  Toasts,
} from "./components/Screens";
import { IconButton } from "./components/Primitives";

export default function App() {
  const model = createAppModel();
  const { state, actions, preferences, prefActions } = model;
  let searchInput: HTMLInputElement | undefined;

  onMount(() => {
    void actions.bootstrap();
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
  });
  onCleanup(() => {
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
          class="app-shell"
          inert={Boolean(state.logoutConfirmation || state.imageViewer)}
          aria-hidden={state.logoutConfirmation || state.imageViewer ? "true" : undefined}
        >
          <TitleBar model={model} />
          <nav class="nav-rail" aria-label="Primary navigation">
            <div class="brand-mark" aria-label="Rust Meow"><span style={{ "font-weight": 900 }}>M</span></div>
            <IconButton
              label="Chats"
              active={state.chatFilter !== "archived"}
              onClick={() => actions.setFilter("all")}
            >
              <MessageCircle size={21} />
            </IconButton>
            <IconButton
              label="Archived chats"
              active={state.chatFilter === "archived"}
              onClick={() => actions.setFilter("archived")}
            >
              <Archive size={20} />
            </IconButton>
            <div class="nav-spacer" />
            <IconButton label="Privacy architecture" onClick={() => actions.toggleSettings(true)}>
              <ShieldCheck size={20} />
            </IconButton>
            <IconButton label="Settings" active={state.settingsOpen} onClick={() => actions.toggleSettings()}>
              <Settings size={20} />
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
                      <Tabs model={model} pane={pane} />
                      <Show when={pane.activeChatId} fallback={<EmptyConversation />}>
                        <Conversation model={model} chatId={pane.activeChatId} />
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
      <ChatSwitcher model={model} />
      <ImageViewer model={model} />
      <LogoutDialog model={model} />
      <Toasts model={model} />
    </>
  );

  function handleGlobalKeyDown(event: KeyboardEvent) {
    if (state.screen !== "chats") return;
    const target = event.target as HTMLElement | null;
    const editing = target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement || target?.isContentEditable;

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
    if ((event.ctrlKey || event.metaKey) && event.key.toLocaleLowerCase() === "k") {
      searchInput?.focus();
      searchInput?.select();
      event.preventDefault();
      return;
    }
    if (!editing && event.key === "/") {
      searchInput?.focus();
      event.preventDefault();
      return;
    }
    if (event.key === "Escape") {
      if (state.switcher) actions.cancelSwitcher();
      else if (state.logoutConfirmation) actions.setLogoutConfirmation(false);
      else if (state.imageViewer) actions.closeImage();
      else if (state.chatInfoOpen) actions.hideChatInfo();
      else if (state.settingsOpen) actions.toggleSettings(false);
      else if (state.searchQuery) actions.clearSearch();
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
}
