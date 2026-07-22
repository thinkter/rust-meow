import { batch } from "solid-js";
import { createStore, reconcile } from "solid-js/store";
import { bridge, normalizeBridgeError } from "../lib/bridge";
import {
  AttachmentKind,
  ChatKind,
  ConnectionState,
  type Chat,
  type ChatInfo,
  type ChatParticipant,
  type ContactSearchResult,
  type FrontendEvent,
  type Message,
  type MessageSearchResult,
  type Reaction,
  type SearchResults,
} from "../lib/types";
import { pairingStartupDecision } from "./pairing";
import { optimisticUnreadCount, shouldRestoreOptimisticUnread } from "./unread";

export type Screen = "starting" | "pairing" | "chats" | "fatal";
export type ChatFilter = "all" | "unread" | "groups" | "archived";

export interface Mention {
  displayName: string;
  jid: string;
}

export interface Draft {
  text: string;
  replyToMessageId: string;
  mentions: Mention[];
}

export interface TypingPresence {
  senderId: string;
  senderName: string;
  recording: boolean;
  expiresAt: number;
}

export interface Toast {
  id: number;
  message: string;
  kind: "error" | "info";
}

export interface ImageViewerState {
  path: string;
  caption: string;
  sticker: boolean;
}

export interface AppState {
  screen: Screen;
  connection: number;
  connectionDetail: string;
  ownUserId: string;
  backendVersion: string;
  qrCode: string;
  qrExpiresAtMs: number;
  syncChats: number;
  syncMessages: number;
  syncActive: boolean;
  chats: Chat[];
  totalChats: number;
  nextChatCursor: string;
  loadingChats: boolean;
  chatFilter: ChatFilter;
  selectedChatId: string;
  messages: Message[];
  loadingMessages: boolean;
  loadingOlder: boolean;
  loadingNewer: boolean;
  hasOlder: boolean;
  hasNewer: boolean;
  firstUnreadMessageId: string;
  highlightedMessageId: string;
  liveMessageVersion: number;
  drafts: Record<string, Draft>;
  sending: boolean;
  typing: Record<string, Record<string, TypingPresence>>;
  searchQuery: string;
  searchResults: SearchResults | null;
  searchLoading: boolean;
  searchError: string;
  chatInfo: ChatInfo | null;
  chatInfoOpen: boolean;
  chatInfoLoading: boolean;
  chatInfoError: string;
  participantAvatars: Record<string, string>;
  imageFailures: Record<string, string>;
  attachmentFailures: Record<string, string>;
  imageViewer: ImageViewerState | null;
  settingsOpen: boolean;
  theme: "dark" | "light";
  uiScale: number;
  logoutConfirmation: boolean;
  toasts: Toast[];
  fatalError: string;
}

const emptyDraft = (): Draft => ({ text: "", replyToMessageId: "", mentions: [] });
const MAX_ACTIVE_MESSAGES = 2_000;

export function createAppModel() {
  const savedTheme = localStorage.getItem("rust-meow-theme");
  const savedScale = Number.parseFloat(localStorage.getItem("rust-meow-scale") ?? "1");
  const [state, setState] = createStore<AppState>({
    screen: "starting",
    connection: ConnectionState.Starting,
    connectionDetail: "",
    ownUserId: "",
    backendVersion: "",
    qrCode: "",
    qrExpiresAtMs: 0,
    syncChats: 0,
    syncMessages: 0,
    syncActive: false,
    chats: [],
    totalChats: 0,
    nextChatCursor: "",
    loadingChats: false,
    chatFilter: "all",
    selectedChatId: "",
    messages: [],
    loadingMessages: false,
    loadingOlder: false,
    loadingNewer: false,
    hasOlder: false,
    hasNewer: false,
    firstUnreadMessageId: "",
    highlightedMessageId: "",
    liveMessageVersion: 0,
    drafts: {},
    sending: false,
    typing: {},
    searchQuery: "",
    searchResults: null,
    searchLoading: false,
    searchError: "",
    chatInfo: null,
    chatInfoOpen: false,
    chatInfoLoading: false,
    chatInfoError: "",
    participantAvatars: {},
    imageFailures: {},
    attachmentFailures: {},
    imageViewer: null,
    settingsOpen: false,
    theme: savedTheme === "light" ? "light" : "dark",
    uiScale: Number.isFinite(savedScale) ? Math.min(1.5, Math.max(1, savedScale)) : 1,
    logoutConfirmation: false,
    toasts: [],
    fatalError: "",
  });

  let selectionGeneration = 0;
  let searchGeneration = 0;
  let searchTimer: number | undefined;
  let syncRefreshTimer: number | undefined;
  let typingTimer: number | undefined;
  let typingChatId = "";
  let resyncing = false;
  let toastId = 0;
  const pendingImages = new Set<string>();
  const pendingAttachments = new Set<string>();
  const pendingAvatars = new Set<string>();
  const attemptedAvatars = new Set<string>();
  const attemptedParticipantAvatars = new Set<string>();
  const backendChatRevisions = new Map<string, number>();

  function applyAppearance() {
    document.documentElement.dataset.theme = state.theme;
    document.documentElement.style.setProperty("--scale", state.uiScale.toString());
  }

  async function bootstrap() {
    applyAppearance();
    try {
      await bridge.subscribeBackend(handleEvent);
      const hello = await bridge.hello();
      const auth = await bridge.getAuthState();
      batch(() => {
        setState("backendVersion", hello.backendVersion);
        setState("connection", auth.connectionState);
        setState("ownUserId", auth.ownUserId);
      });
      const pairing = pairingStartupDecision(auth);
      setState("screen", pairing.screen);
      if (pairing.startPairing) {
        await bridge.startPairing();
        return;
      }
      await loadChats(true);
    } catch (error) {
      fatal(normalizeBridgeError(error).message);
    }
  }

  async function refreshPairing() {
    try {
      const response = await bridge.startPairing();
      if (response.started) return;
      const auth = await bridge.getAuthState();
      if (auth.paired) {
        batch(() => {
          setState("connection", auth.connectionState);
          setState("ownUserId", auth.ownUserId);
          setState("screen", "chats");
          setState("qrCode", "");
          setState("qrExpiresAtMs", 0);
        });
        await loadChats(true);
        return;
      }
      toast("Pairing is already active. A fresh QR code will appear automatically.", "info");
    } catch (error) {
      toast(normalizeBridgeError(error).message);
    }
  }

  async function loadChats(reset = false) {
    if (state.loadingChats) return;
    if (!reset && !state.nextChatCursor) return;
    setState("loadingChats", true);
    try {
      const cursor = reset ? "" : state.nextChatCursor;
      const response = await bridge.listChats(cursor, 100);
      // Merge into the current snapshot even on a first-page refresh: a live
      // upsert or already-loaded tail page may have arrived while this request
      // was in flight.
      const merged = mergeChats(state.chats, response.chats);
      batch(() => {
        setState("chats", reconcile(sortChats(merged), { key: "id" }));
        setState("totalChats", response.totalCount);
        setState("nextChatCursor", response.nextCursor);
      });
    } catch (error) {
      toast(normalizeBridgeError(error).message);
    } finally {
      setState("loadingChats", false);
    }
  }

  async function selectChat(chatId: string, aroundMessageId = "") {
    stopTyping();
    const generation = ++selectionGeneration;
    batch(() => {
      setState("selectedChatId", chatId);
      setState("messages", []);
      setState("loadingMessages", true);
      setState("hasOlder", false);
      setState("hasNewer", false);
      setState("firstUnreadMessageId", "");
      setState("highlightedMessageId", "");
      setState("chatInfoOpen", false);
      setState("chatInfo", null);
      setState("settingsOpen", false);
      setState("searchQuery", "");
      setState("searchResults", null);
    });
    ensureDraft(chatId);
    rememberRecentChat(chatId);

    try {
      if (aroundMessageId) {
        const response = await bridge.listMessagesAround(chatId, aroundMessageId);
        if (generation !== selectionGeneration) return;
        batch(() => {
          setState(
            "messages",
            reconcile(sortMessages(mergeMessages(state.messages, response.messages)), { key: "id" }),
          );
          setState("hasOlder", response.hasOlder);
          setState("hasNewer", response.hasNewer);
          setState("highlightedMessageId", response.anchorMessageId || aroundMessageId);
        });
        window.setTimeout(() => {
          if (state.highlightedMessageId === (response.anchorMessageId || aroundMessageId)) {
            setState("highlightedMessageId", "");
          }
        }, 3_000);
      } else {
        const response = await bridge.openMessageWindow(chatId);
        if (generation !== selectionGeneration) return;
        batch(() => {
          setState(
            "messages",
            reconcile(sortMessages(mergeMessages(state.messages, response.messages)), { key: "id" }),
          );
          setState("hasOlder", response.hasOlder);
          setState("hasNewer", response.hasNewer);
          setState("firstUnreadMessageId", response.firstUnreadMessageId);
        });
      }
      void markSelectedRead();
      void loadAvatar(chatId);
      void bridge.repairRecentReactions(chatId).catch(() => undefined);
    } catch (error) {
      if (generation === selectionGeneration) toast(normalizeBridgeError(error).message);
    } finally {
      if (generation === selectionGeneration) setState("loadingMessages", false);
    }
  }

  function closeChat() {
    stopTyping();
    selectionGeneration += 1;
    batch(() => {
      setState("selectedChatId", "");
      setState("messages", []);
      setState("chatInfoOpen", false);
    });
  }

  async function loadOlder() {
    const first = state.messages[0];
    if (!first || !state.hasOlder || state.loadingOlder) return;
    const chatId = state.selectedChatId;
    setState("loadingOlder", true);
    try {
      const response = await bridge.listMessages(
        chatId,
        first.timestampMs,
        first.id,
        50,
      );
      if (chatId !== state.selectedChatId) return;
      const merged = mergeMessages(response.messages, state.messages);
      const trimmed = merged.length > MAX_ACTIVE_MESSAGES;
      setState("messages", reconcile(trimMessages(merged, "newer"), { key: "id" }));
      setState("hasOlder", response.hasMore);
      if (trimmed) setState("hasNewer", true);
    } catch (error) {
      toast(normalizeBridgeError(error).message);
    } finally {
      setState("loadingOlder", false);
    }
  }

  async function loadNewer() {
    const last = state.messages.at(-1);
    if (!last || !state.hasNewer || state.loadingNewer) return;
    const chatId = state.selectedChatId;
    setState("loadingNewer", true);
    try {
      const response = await bridge.listMessagesAfter(chatId, last.timestampMs, last.id, 50);
      if (chatId !== state.selectedChatId) return;
      const merged = mergeMessages(state.messages, response.messages);
      const trimmed = merged.length > MAX_ACTIVE_MESSAGES;
      setState("messages", reconcile(trimMessages(merged, "older"), { key: "id" }));
      setState("hasNewer", response.hasMore);
      if (trimmed) setState("hasOlder", true);
    } catch (error) {
      toast(normalizeBridgeError(error).message);
    } finally {
      setState("loadingNewer", false);
    }
  }

  async function jumpToLatest() {
    if (!state.selectedChatId) return;
    await selectChat(state.selectedChatId);
  }

  function updateSearch(query: string) {
    setState("searchQuery", query);
    setState("searchError", "");
    if (searchTimer !== undefined) window.clearTimeout(searchTimer);
    const generation = ++searchGeneration;
    const trimmed = query.trim();
    if (trimmed.length < 2) {
      batch(() => {
        setState("searchResults", null);
        setState("searchLoading", false);
      });
      return;
    }
    setState("searchLoading", true);
    searchTimer = window.setTimeout(async () => {
      try {
        const results = await bridge.searchLocal(trimmed);
        if (generation !== searchGeneration) return;
        setState("searchResults", results);
      } catch (error) {
        if (generation !== searchGeneration) return;
        setState("searchError", normalizeBridgeError(error).message);
      } finally {
        if (generation === searchGeneration) setState("searchLoading", false);
      }
    }, 150);
  }

  function clearSearch() {
    searchGeneration += 1;
    if (searchTimer !== undefined) window.clearTimeout(searchTimer);
    batch(() => {
      setState("searchQuery", "");
      setState("searchResults", null);
      setState("searchLoading", false);
      setState("searchError", "");
    });
  }

  async function openContact(result: ContactSearchResult) {
    if (result.chatId) {
      await selectChat(result.chatId);
      return;
    }
    try {
      const response = await bridge.openContact(result.contactJid);
      if (!response.chat) throw new Error("The contact did not produce a chat");
      upsertChat(response.chat);
      await selectChat(response.chat.id);
    } catch (error) {
      toast(normalizeBridgeError(error).message);
    }
  }

  async function openMessageResult(result: MessageSearchResult) {
    if (result.chat) upsertChat(result.chat);
    setState("chatFilter", result.archived ? "archived" : "all");
    await selectChat(result.chatId, result.messageId);
  }

  function setDraftText(text: string) {
    const chatId = state.selectedChatId;
    if (!chatId) return;
    ensureDraft(chatId);
    setState("drafts", chatId, "text", text);
    scheduleTyping(text.trim().length > 0);
  }

  function replyTo(messageId: string) {
    const chatId = state.selectedChatId;
    if (!chatId) return;
    ensureDraft(chatId);
    setState("drafts", chatId, "replyToMessageId", messageId);
  }

  function cancelReply() {
    const chatId = state.selectedChatId;
    if (chatId && state.drafts[chatId]) setState("drafts", chatId, "replyToMessageId", "");
  }

  function addMention(participant: ChatParticipant, tokenStart: number, tokenEnd: number) {
    const chatId = state.selectedChatId;
    const draft = state.drafts[chatId];
    if (!chatId || !draft) return;
    const displayName = participant.displayName || participant.phoneNumber;
    const next = `${draft.text.slice(0, tokenStart)}@${displayName} ${draft.text.slice(tokenEnd)}`;
    batch(() => {
      setState("drafts", chatId, "text", next);
      setState("drafts", chatId, "mentions", (mentions) => [
        ...mentions.filter((mention) => mention.jid !== participant.participantId),
        { displayName, jid: participant.participantId },
      ]);
    });
  }

  async function sendCurrentText() {
    const chatId = state.selectedChatId;
    const draft = state.drafts[chatId];
    if (!chatId || !draft || state.sending) return;
    const text = draft.text.trim();
    if (!text) return;
    if (new TextEncoder().encode(text).length > 65_536) {
      toast("Messages can be at most 65,536 bytes");
      return;
    }
    const previous = cloneDraft(draft);
    const encoded = encodeMentions(text, previous.mentions);
    batch(() => {
      setState("sending", true);
      setState("drafts", chatId, emptyDraft());
    });
    scheduleTyping(false);
    try {
      const response = await bridge.sendText(
        chatId,
        encoded.text,
        previous.replyToMessageId,
        encoded.jids,
      );
      if (response.message) upsertMessage(response.message, true);
    } catch (error) {
      if (draftIsEmpty(state.drafts[chatId])) setState("drafts", chatId, previous);
      toast(normalizeBridgeError(error).message);
    } finally {
      setState("sending", false);
    }
  }

  async function sendImage(path: string) {
    await sendFile(path, "image");
  }

  async function sendSticker(path: string) {
    await sendFile(path, "sticker");
  }

  async function sendAttachment(
    path: string,
    kind: AttachmentKind,
    voiceNote = false,
  ) {
    await sendFile(path, "attachment", kind, voiceNote);
  }

  async function sendFile(
    path: string,
    mode: "image" | "sticker" | "attachment",
    attachmentKind: AttachmentKind = AttachmentKind.Document,
    voiceNote = false,
  ) {
    const chatId = state.selectedChatId;
    const draft = state.drafts[chatId] ?? emptyDraft();
    if (!chatId || state.sending) return;
    const previous = cloneDraft(draft);
    batch(() => {
      setState("sending", true);
      setState("drafts", chatId, emptyDraft());
    });
    scheduleTyping(false);
    try {
      const response =
        mode === "image"
          ? await bridge.sendImage(chatId, path, previous.text.trim(), previous.replyToMessageId)
          : mode === "sticker"
            ? await bridge.sendSticker(chatId, path, previous.replyToMessageId)
            : await bridge.sendAttachment(
                chatId,
                path,
                attachmentKind,
                attachmentKind === AttachmentKind.Audio ? "" : previous.text.trim(),
                previous.replyToMessageId,
                voiceNote,
              );
      if (response.message) upsertMessage(response.message, true);
    } catch (error) {
      if (draftIsEmpty(state.drafts[chatId])) setState("drafts", chatId, previous);
      toast(normalizeBridgeError(error).message);
    } finally {
      setState("sending", false);
    }
  }

  async function hydrateImage(message: Message, retry = false, requireFull = false) {
    if (!(message.content && "image" in message.content)) return;
    const image = message.content.image;
    if (image.localPath) return image.localPath;
    if (image.thumbnailPath && !requireFull) return image.thumbnailPath;
    if (!image.downloadable) return image.thumbnailPath || undefined;
    const key = mediaKey(message.chatId, message.id);
    if (pendingImages.has(key) || pendingImages.size >= 4) return;
    if (state.imageFailures[key] && !retry) return;
    pendingImages.add(key);
    if (retry) setState("imageFailures", key, undefined!);
    try {
      const response = await bridge.getMessageImage(message.chatId, message.id);
      updateMessage(message.id, (current) => {
        if (!(current.content && "image" in current.content)) return current;
        return {
          ...current,
          content: {
            image: {
              ...current.content.image,
              localPath: response.imagePath,
              thumbnailPath: response.thumbnailPath,
            },
          },
        };
      });
      return response.imagePath || response.thumbnailPath || undefined;
    } catch (error) {
      setState("imageFailures", key, normalizeBridgeError(error).message);
    } finally {
      pendingImages.delete(key);
    }
  }

  async function hydrateAttachment(message: Message, retry = false) {
    if (!(message.content && "attachment" in message.content)) return;
    const attachment = message.content.attachment;
    if (attachment.localPath) return attachment.localPath;
    if (!attachment.downloadable) return;
    const key = mediaKey(message.chatId, message.id);
    if (pendingAttachments.has(key) || pendingAttachments.size >= 3) return;
    if (state.attachmentFailures[key] && !retry) return;
    pendingAttachments.add(key);
    if (retry) setState("attachmentFailures", key, undefined!);
    try {
      const response = await bridge.getMessageAttachment(message.chatId, message.id);
      updateMessage(message.id, (current) => {
        if (!(current.content && "attachment" in current.content)) return current;
        return {
          ...current,
          content: {
            attachment: { ...current.content.attachment, localPath: response.localPath },
          },
        };
      });
      return response.localPath || undefined;
    } catch (error) {
      setState("attachmentFailures", key, normalizeBridgeError(error).message);
    } finally {
      pendingAttachments.delete(key);
    }
  }

  async function loadAvatar(chatId: string) {
    const chat = state.chats.find((candidate) => candidate.id === chatId);
    if (
      !chat ||
      chat.avatarPath ||
      pendingAvatars.has(chatId) ||
      attemptedAvatars.has(chatId) ||
      pendingAvatars.size >= 4
    ) return;
    pendingAvatars.add(chatId);
    attemptedAvatars.add(chatId);
    try {
      const response = await bridge.getChatAvatar(chatId);
      if (response.avatarPath) {
        setState("chats", (candidate) => candidate.id === chatId, "avatarPath", response.avatarPath);
      }
    } catch {
      // Avatar privacy/availability failures do not interrupt messaging.
    } finally {
      pendingAvatars.delete(chatId);
    }
  }

  async function loadParticipantAvatar(participantId: string) {
    if (
      !participantId ||
      state.participantAvatars[participantId] ||
      attemptedParticipantAvatars.has(participantId)
    ) return;
    attemptedParticipantAvatars.add(participantId);
    try {
      const response = await bridge.getParticipantAvatar(participantId);
      if (response.avatarPath) {
        setState("participantAvatars", participantId, response.avatarPath);
      }
    } catch {
      // Optional presentation data.
    }
  }

  async function showChatInfo() {
    const chatId = state.selectedChatId;
    if (!chatId) return;
    batch(() => {
      setState("chatInfoOpen", true);
      setState("chatInfoLoading", true);
      setState("chatInfoError", "");
      setState("settingsOpen", false);
    });
    try {
      const info = await bridge.getChatInfo(chatId);
      if (state.selectedChatId !== chatId) return;
      setState("chatInfo", info);
      if (info.chat) upsertChat(info.chat);
    } catch (error) {
      setState("chatInfoError", normalizeBridgeError(error).message);
    } finally {
      if (state.selectedChatId === chatId) setState("chatInfoLoading", false);
    }
  }

  async function ensureMentionDirectory() {
    const chatId = state.selectedChatId;
    if (!chatId || state.chatInfo?.chat?.id === chatId || state.chatInfoLoading) return;
    setState("chatInfoLoading", true);
    try {
      const info = await bridge.getChatInfo(chatId);
      if (state.selectedChatId === chatId) setState("chatInfo", info);
    } catch {
      // Mention suggestions are optional; the main chat-info panel exposes retry UI.
    } finally {
      if (state.selectedChatId === chatId) setState("chatInfoLoading", false);
    }
  }

  function hideChatInfo() {
    setState("chatInfoOpen", false);
  }

  async function react(messageId: string, emoji: string) {
    const message = state.messages.find((candidate) => candidate.id === messageId);
    if (!message) return;
    try {
      const response = await bridge.sendReaction(message.chatId, message.id, emoji);
      if (response.reaction) applyReaction(response.reaction, response.removed);
    } catch (error) {
      toast(normalizeBridgeError(error).message);
    }
  }

  function openImage(path: string, caption: string, sticker: boolean) {
    setState("imageViewer", { path, caption, sticker });
  }

  function closeImage() {
    setState("imageViewer", null);
  }

  function setFilter(filter: ChatFilter) {
    setState("chatFilter", filter);
    if (filter !== "all") void loadRemainingChats();
  }

  async function loadRemainingChats() {
    // The wire cursor currently pages the unified chat list. Hydrate the rest
    // in the background so a local filter cannot claim to be empty merely
    // because all of its matches are beyond the first page.
    let previousCursor = "";
    for (let page = 0; page < 100 && state.nextChatCursor; page += 1) {
      const cursor = state.nextChatCursor;
      if (cursor === previousCursor) return;
      previousCursor = cursor;
      await loadChats(false);
    }
  }

  function setTheme(theme: "dark" | "light") {
    setState("theme", theme);
    localStorage.setItem("rust-meow-theme", theme);
    applyAppearance();
  }

  function setScale(scale: number) {
    const normalized = Math.round(Math.min(1.5, Math.max(1, scale)) * 10) / 10;
    setState("uiScale", normalized);
    localStorage.setItem("rust-meow-scale", normalized.toString());
    applyAppearance();
  }

  function toggleSettings(open = !state.settingsOpen) {
    batch(() => {
      setState("settingsOpen", open);
      if (open) setState("chatInfoOpen", false);
    });
  }

  async function logout() {
    try {
      stopTyping();
      await bridge.logout();
      batch(() => {
        setState("logoutConfirmation", false);
        setState("screen", "pairing");
        setState("chats", []);
        setState("messages", []);
        setState("selectedChatId", "");
        setState("drafts", {});
      });
      await bridge.startPairing();
    } catch (error) {
      fatal(`Logout could not be completed safely: ${normalizeBridgeError(error).message}`);
    }
  }

  function cycleRecentChat(reverse: boolean) {
    const recent = readRecentChats().filter((id) => state.chats.some((chat) => chat.id === id));
    if (recent.length < 2) return;
    const current = recent.indexOf(state.selectedChatId);
    const next = reverse
      ? (current - 1 + recent.length) % recent.length
      : (current + 1) % recent.length;
    void selectChat(recent[next] ?? recent[0]!);
  }

  function handleEvent(event: FrontendEvent) {
    switch (event.type) {
      case "connectionChanged":
        batch(() => {
          setState("connection", event.payload.state);
          setState("connectionDetail", event.payload.detail);
          if (event.payload.state === ConnectionState.LoggedOut) {
            setState("screen", "pairing");
            setState("qrCode", "");
            setState("qrExpiresAtMs", 0);
          } else if (event.payload.state === ConnectionState.Connected) {
            setState("screen", "chats");
            setState("qrCode", "");
            setState("qrExpiresAtMs", 0);
          }
        });
        if (event.payload.state === ConnectionState.Connected) void loadChats(true);
        break;
      case "pairingQr":
        batch(() => {
          setState("qrCode", event.payload.code);
          setState("qrExpiresAtMs", event.payload.expiresAtMs);
          setState("screen", "pairing");
        });
        break;
      case "syncProgress":
        batch(() => {
          setState("syncChats", (value) => value + event.payload.chatsProcessed);
          setState("syncMessages", (value) => value + event.payload.messagesProcessed);
          setState("syncActive", !event.payload.complete);
        });
        if (event.payload.complete) {
          if (syncRefreshTimer !== undefined) window.clearTimeout(syncRefreshTimer);
          syncRefreshTimer = undefined;
          void loadChats(true);
        } else if (syncRefreshTimer === undefined) {
          syncRefreshTimer = window.setTimeout(() => {
            syncRefreshTimer = undefined;
            void loadChats(true);
          }, 500);
        }
        break;
      case "chatUpserted":
        if (event.payload.chat) {
          const chat = event.payload.chat;
          backendChatRevisions.set(chat.id, (backendChatRevisions.get(chat.id) ?? 0) + 1);
          upsertChat(chat);
        }
        break;
      case "messageUpserted":
        if (event.payload.message) {
          upsertMessage(event.payload.message, true);
          clearTypingForMessage(event.payload.message);
        }
        break;
      case "receiptUpdated":
        {
          const index = state.messages.findIndex(
            (message) =>
              message.id === event.payload.messageId &&
              message.chatId === event.payload.chatId,
          );
          if (index >= 0) {
            setState("messages", index, "status", event.payload.status);
          }
        }
        break;
      case "reactionUpdated":
        if (event.payload.reaction) applyReaction(event.payload.reaction, event.payload.removed);
        break;
      case "chatMerged":
        mergeChatId(event.payload.oldChatId, event.payload.newChatId);
        break;
      case "typingChanged":
        updateTyping(event.payload);
        break;
      case "problem":
        if (event.payload.fatal) fatal(event.payload.message);
        else {
          toast(event.payload.message);
          if (
            event.payload.code === "event_sequence_gap" ||
            event.payload.code === "event_sequence_invalid"
          ) {
            void resyncAfterEventGap();
          }
        }
        break;
      case "bridgeExited":
        fatal(`The WhatsApp backend stopped: ${event.payload.message}`);
        break;
      case "recentReactionsRepaired":
        if (event.payload.recoveredReactions > 0 && state.selectedChatId === event.payload.chatId) {
          void selectChat(event.payload.chatId);
        }
        break;
    }
  }

  function upsertChat(chat: Chat) {
    setState("chats", reconcile(sortChats(mergeChats(state.chats, [chat])), { key: "id" }));
  }

  async function resyncAfterEventGap() {
    if (resyncing) return;
    resyncing = true;
    const chatId = state.selectedChatId;
    const generation = selectionGeneration;
    try {
      const [messages] = await Promise.all([
        chatId ? bridge.openMessageWindow(chatId) : Promise.resolve(null),
        loadChats(true),
      ]);
      if (messages && generation === selectionGeneration && chatId === state.selectedChatId) {
        batch(() => {
          setState("messages", reconcile(sortMessages(messages.messages), { key: "id" }));
          setState("hasOlder", messages.hasOlder);
          setState("hasNewer", messages.hasNewer);
          setState("firstUnreadMessageId", messages.firstUnreadMessageId);
        });
        void markSelectedRead();
      }
      toast("Chat state refreshed after a missed backend event", "info");
    } catch (error) {
      toast(`Could not refresh after the event gap: ${normalizeBridgeError(error).message}`);
    } finally {
      resyncing = false;
    }
  }

  function upsertMessage(message: Message, live: boolean) {
    if (message.chatId !== state.selectedChatId) return;
    const isNew = !state.messages.some((candidate) => candidate.id === message.id);
    const merged = mergeMessages(state.messages, [preserveLocalMedia(message, state.messages)]);
    const trimmed = merged.length > MAX_ACTIVE_MESSAGES;
    setState("messages", reconcile(trimMessages(merged, "older"), { key: "id" }));
    if (trimmed) setState("hasOlder", true);
    if (live && isNew) {
      setState("liveMessageVersion", (version) => version + 1);
      if (!message.fromMe && document.visibilityState === "visible") {
        queueMicrotask(() => void markSelectedRead());
      }
    }
  }

  function updateMessage(id: string, update: (message: Message) => Message) {
    const index = state.messages.findIndex((message) => message.id === id);
    if (index >= 0) setState("messages", index, update(state.messages[index]!));
  }

  function applyReaction(reaction: Reaction, removed: boolean) {
    updateMessage(reaction.messageId, (message) => {
      const reactions = message.reactions.filter((item) => item.senderId !== reaction.senderId);
      if (!removed && reaction.emoji) reactions.push(reaction);
      reactions.sort((left, right) => left.timestampMs - right.timestampMs);
      return { ...message, reactions };
    });
  }

  function mergeChatId(oldId: string, newId: string) {
    const oldDraft = state.drafts[oldId];
    const oldChat = state.chats.find((chat) => chat.id === oldId);
    const newChat = state.chats.find((chat) => chat.id === newId);
    const chats = state.chats.filter((chat) => chat.id !== oldId && chat.id !== newId);
    if (oldChat || newChat) {
      chats.push({ ...oldChat, ...newChat, id: newId } as Chat);
    }
    const messages = state.messages.map((message) =>
      message.chatId === oldId ? { ...message, chatId: newId } : message,
    );
    const oldTyping = state.typing[oldId];
    const currentTyping = state.typing[newId];
    batch(() => {
      setState("chats", reconcile(sortChats(chats), { key: "id" }));
      setState("messages", reconcile(messages, { key: "id" }));
      if (oldDraft && !state.drafts[newId]) setState("drafts", newId, oldDraft);
      setState("drafts", oldId, undefined!);
      if (oldTyping) setState("typing", newId, { ...oldTyping, ...currentTyping });
      setState("typing", oldId, undefined!);
      if (state.chatInfo?.chat?.id === oldId) {
        setState("chatInfo", "chat", "id", newId);
      }
      if (state.selectedChatId === oldId) setState("selectedChatId", newId);
    });
    if (typingChatId === oldId) typingChatId = newId;
    const recent = readRecentChats().map((id) => (id === oldId ? newId : id));
    writeRecentChats([...new Set(recent)]);
  }

  function updateTyping(payload: {
    chatId: string;
    senderId: string;
    senderName: string;
    typing: boolean;
    recording: boolean;
  }) {
    if (!payload.typing) {
      if (state.typing[payload.chatId]?.[payload.senderId]) {
        setState("typing", payload.chatId, payload.senderId, undefined!);
      }
      return;
    }
    if (!state.typing[payload.chatId]) setState("typing", payload.chatId, {});
    setState("typing", payload.chatId, payload.senderId, {
      senderId: payload.senderId,
      senderName: payload.senderName,
      recording: payload.recording,
      expiresAt: Date.now() + 10_000,
    });
    window.setTimeout(() => {
      const current = state.typing[payload.chatId]?.[payload.senderId];
      if (current && current.expiresAt <= Date.now()) {
        setState("typing", payload.chatId, payload.senderId, undefined!);
      }
    }, 10_100);
  }

  function clearTypingForMessage(message: Message) {
    if (message.fromMe) return;
    const chatTyping = state.typing[message.chatId];
    if (!chatTyping) return;
    if (chatTyping[message.senderId]) setState("typing", message.chatId, message.senderId, undefined!);
  }

  function typingLabel(chatId: string): string {
    const active = Object.values(state.typing[chatId] ?? {}).filter(
      (presence) => presence && presence.expiresAt > Date.now(),
    );
    if (active.length === 0) return "";
    if (active.length === 1) {
      const presence = active[0]!;
      const action = presence.recording ? "recording audio…" : "typing…";
      return presence.senderName ? `${presence.senderName} is ${action}` : action;
    }
    const names = active
      .slice(0, 2)
      .map((presence) => presence.senderName)
      .filter(Boolean);
    return names.length > 0 ? `${names.join(" and ")} are typing…` : `${active.length} people are typing…`;
  }

  function scheduleTyping(composing: boolean) {
    if (typingTimer !== undefined) window.clearTimeout(typingTimer);
    const chatId = state.selectedChatId;
    if (!chatId) return;
    if (typingChatId && typingChatId !== chatId) {
      void bridge.setTyping(typingChatId, false).catch(() => undefined);
    }
    typingChatId = composing ? chatId : "";
    void bridge.setTyping(chatId, composing).catch(() => undefined);
    if (composing) {
      typingTimer = window.setTimeout(() => {
        if (typingChatId === chatId && state.selectedChatId === chatId) scheduleTyping(true);
      }, 8_000);
    }
  }

  function stopTyping() {
    if (typingTimer !== undefined) {
      window.clearTimeout(typingTimer);
      typingTimer = undefined;
    }
    const chatId = typingChatId;
    typingChatId = "";
    if (chatId) void bridge.setTyping(chatId, false).catch(() => undefined);
  }

  async function markSelectedRead() {
    const lastIncoming = [...state.messages].reverse().find((message) => !message.fromMe);
    const chatId = state.selectedChatId;
    if (!chatId || !lastIncoming) return;
    const previous = state.chats.find((chat) => chat.id === chatId)?.unreadCount ?? 0;
    const optimistic = optimisticUnreadCount(previous, state.hasNewer);
    const backendRevision = backendChatRevisions.get(chatId) ?? 0;
    if (optimistic !== previous) {
      setState("chats", (chat) => chat.id === chatId, "unreadCount", optimistic);
    }
    try {
      await bridge.markRead(chatId, lastIncoming.id);
    } catch {
      // A backend chat upsert can arrive before a rejected RPC when one receipt
      // group persisted and a later group failed, or when a successful response
      // was lost. Do not overwrite that authoritative count with stale state.
      const current = state.chats.find((chat) => chat.id === chatId)?.unreadCount;
      if (
        shouldRestoreOptimisticUnread(
          current,
          optimistic,
          backendRevision,
          backendChatRevisions.get(chatId) ?? 0,
        )
      ) {
        setState("chats", (chat) => chat.id === chatId, "unreadCount", previous);
      }
    }
  }

  function ensureDraft(chatId: string) {
    if (!state.drafts[chatId]) setState("drafts", chatId, emptyDraft());
  }

  function toast(message: string, kind: Toast["kind"] = "error") {
    const id = ++toastId;
    setState("toasts", (toasts) => [...toasts.slice(-3), { id, message, kind }]);
    window.setTimeout(() => dismissToast(id), 6_000);
  }

  function dismissToast(id: number) {
    setState("toasts", (toasts) => toasts.filter((toast) => toast.id !== id));
  }

  function fatal(message: string) {
    batch(() => {
      setState("screen", "fatal");
      setState("fatalError", message);
    });
  }

  function filteredChats(): Chat[] {
    return state.chats.filter((chat) => {
      if (state.chatFilter === "archived") return chat.archived;
      if (chat.archived) return false;
      if (state.chatFilter === "unread") return chat.unreadCount > 0;
      if (state.chatFilter === "groups") return chat.kind === ChatKind.Group;
      return true;
    });
  }

  function selectedChat(): Chat | undefined {
    return state.chats.find((chat) => chat.id === state.selectedChatId);
  }

  function activeDraft(): Draft {
    return state.drafts[state.selectedChatId] ?? emptyDraft();
  }

  return {
    state,
    actions: {
      bootstrap,
      refreshPairing,
      loadChats,
      selectChat,
      closeChat,
      loadOlder,
      loadNewer,
      jumpToLatest,
      updateSearch,
      clearSearch,
      openContact,
      openMessageResult,
      setDraftText,
      replyTo,
      cancelReply,
      addMention,
      sendCurrentText,
      sendImage,
      sendSticker,
      sendAttachment,
      hydrateImage,
      hydrateAttachment,
      loadAvatar,
      loadParticipantAvatar,
      showChatInfo,
      ensureMentionDirectory,
      hideChatInfo,
      react,
      openImage,
      closeImage,
      setFilter,
      setTheme,
      setScale,
      toggleSettings,
      logout,
      cycleRecentChat,
      stopTyping,
      typingLabel,
      filteredChats,
      selectedChat,
      activeDraft,
      dismissToast,
      setLogoutConfirmation: (value: boolean) => setState("logoutConfirmation", value),
    },
  };
}

export type AppModel = ReturnType<typeof createAppModel>;

function sortChats(chats: Chat[]): Chat[] {
  return [...chats].sort(
    (left, right) =>
      Number(right.pinned) - Number(left.pinned) ||
      right.lastMessageTimestampMs - left.lastMessageTimestampMs ||
      left.id.localeCompare(right.id),
  );
}

function mergeChats(existing: readonly Chat[], incoming: readonly Chat[]): Chat[] {
  const byId = new Map(existing.map((chat) => [chat.id, chat]));
  for (const chat of incoming) byId.set(chat.id, { ...byId.get(chat.id), ...chat });
  return [...byId.values()];
}

function sortMessages(messages: readonly Message[]): Message[] {
  return [...messages].sort(
    (left, right) => left.timestampMs - right.timestampMs || left.id.localeCompare(right.id),
  );
}

function cloneDraft(draft: Draft): Draft {
  return {
    text: draft.text,
    replyToMessageId: draft.replyToMessageId,
    mentions: draft.mentions.map((mention) => ({ ...mention })),
  };
}

function draftIsEmpty(draft: Draft | undefined): boolean {
  return Boolean(
    draft &&
    draft.text === "" &&
    draft.replyToMessageId === "" &&
    draft.mentions.length === 0,
  );
}

function mergeMessages(existing: readonly Message[], incoming: readonly Message[]): Message[] {
  const byId = new Map(existing.map((message) => [message.id, message]));
  for (const message of incoming) byId.set(message.id, preserveLocalMedia(message, existing));
  return sortMessages([...byId.values()]);
}

function preserveLocalMedia(message: Message, existing: readonly Message[]): Message {
  const previous = existing.find((candidate) => candidate.id === message.id);
  if (!previous?.content || !message.content) return message;
  if ("image" in previous.content && "image" in message.content) {
    return {
      ...message,
      content: {
        image: {
          ...message.content.image,
          localPath: message.content.image.localPath || previous.content.image.localPath,
          thumbnailPath:
            message.content.image.thumbnailPath || previous.content.image.thumbnailPath,
        },
      },
    };
  }
  if ("attachment" in previous.content && "attachment" in message.content) {
    return {
      ...message,
      content: {
        attachment: {
          ...message.content.attachment,
          localPath: message.content.attachment.localPath || previous.content.attachment.localPath,
        },
      },
    };
  }
  return message;
}

function trimMessages(messages: Message[], drop: "older" | "newer"): Message[] {
  if (messages.length <= MAX_ACTIVE_MESSAGES) return messages;
  return drop === "older"
    ? messages.slice(messages.length - MAX_ACTIVE_MESSAGES)
    : messages.slice(0, MAX_ACTIVE_MESSAGES);
}

function encodeMentions(text: string, mentions: readonly Mention[]) {
  let encoded = text;
  const jids: string[] = [];
  for (const mention of mentions) {
    const visible = `@${mention.displayName}`;
    if (!encoded.includes(visible)) continue;
    const user = mention.jid.split("@")[0] ?? mention.jid;
    encoded = encoded.split(visible).join(`@${user}`);
    jids.push(mention.jid);
  }
  return { text: encoded, jids };
}

function mediaKey(chatId: string, messageId: string): string {
  return `${chatId}\u0000${messageId}`;
}

function rememberRecentChat(chatId: string) {
  writeRecentChats([chatId, ...readRecentChats().filter((id) => id !== chatId)].slice(0, 10));
}

function readRecentChats(): string[] {
  try {
    const value: unknown = JSON.parse(sessionStorage.getItem("rust-meow-recent") ?? "[]");
    return Array.isArray(value) ? value.filter((id): id is string => typeof id === "string") : [];
  } catch {
    return [];
  }
}

function writeRecentChats(ids: string[]) {
  sessionStorage.setItem("rust-meow-recent", JSON.stringify(ids));
}
