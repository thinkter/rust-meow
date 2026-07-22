import { onCleanup, onMount, Show } from "solid-js";
import {
  Archive,
  MessageCircle,
  Settings,
  ShieldCheck,
} from "lucide-solid";
import { createAppModel } from "./state/app";
import { Sidebar } from "./components/Sidebar";
import { Conversation } from "./components/Conversation";
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
  const { state, actions } = model;
  let searchInput: HTMLInputElement | undefined;

  onMount(() => {
    void actions.bootstrap();
    window.addEventListener("keydown", handleGlobalKeyDown, true);
    window.addEventListener("blur", stopTyping);
  });
  onCleanup(() => {
    window.removeEventListener("keydown", handleGlobalKeyDown, true);
    window.removeEventListener("blur", stopTyping);
  });

  return (
    <>
      <Show when={state.screen === "starting"}><StartupScreen /></Show>
      <Show when={state.screen === "pairing"}><PairingScreen model={model} /></Show>
      <Show when={state.screen === "fatal"}><FatalScreen model={model} /></Show>
      <Show when={state.screen === "chats"}>
        <main
          class={`app-shell ${state.selectedChatId ? "chat-open" : ""}`}
          inert={Boolean(state.logoutConfirmation || state.imageViewer)}
          aria-hidden={state.logoutConfirmation || state.imageViewer ? "true" : undefined}
        >
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
            <Show when={state.selectedChatId} fallback={<EmptyConversation />}>
              <Conversation model={model} />
            </Show>
            <Show when={state.chatInfoOpen}><ChatInfoPanel model={model} /></Show>
            <Show when={state.settingsOpen}><SettingsPanel model={model} /></Show>
          </div>
        </main>
      </Show>
      <ImageViewer model={model} />
      <LogoutDialog model={model} />
      <Toasts model={model} />
    </>
  );

  function handleGlobalKeyDown(event: KeyboardEvent) {
    if (state.screen !== "chats") return;
    const target = event.target as HTMLElement | null;
    const editing = target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement || target?.isContentEditable;
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
    if (event.ctrlKey && event.key === "Tab") {
      actions.cycleRecentChat(event.shiftKey);
      event.preventDefault();
      return;
    }
    if (event.key === "Escape") {
      if (state.logoutConfirmation) actions.setLogoutConfirmation(false);
      else if (state.imageViewer) actions.closeImage();
      else if (state.chatInfoOpen) actions.hideChatInfo();
      else if (state.settingsOpen) actions.toggleSettings(false);
      else if (state.searchQuery) actions.clearSearch();
    }
  }

  function stopTyping() {
    actions.stopTyping();
  }
}
