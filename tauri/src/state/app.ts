import { batch } from "solid-js";
import { createStore, reconcile } from "solid-js/store";
import { bridge, normalizeBridgeError, openFile, openUrl, revealMediaPath } from "../lib/bridge";
import { messageText } from "../lib/format";
import { BoundedSet, boundWindowAround } from "../lib/performance";
import { ParticipantAvatarQueue } from "../lib/participant-avatar-queue";
import { clearMergedPollVotes } from "../lib/chat-merge";
import { clonePollContent, optimisticPollVote, preservePendingPollIntent } from "../lib/polls";
import {
  ensureNotificationPermission,
  listenForNotificationActions,
  sendMessageNotification,
} from "../lib/notifications";
import {
  NotificationActivationQueue,
  notificationTargetAvailability,
} from "../lib/notification-routing";
import { isChatActuallyVisible, shouldNotify } from "../lib/notification-policy";
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
  type PinnedMessage,
} from "../lib/types";
import { pairingStartupDecision } from "./pairing";
import {
  activeConversationIds,
  backendLifecycleDecision,
  bootstrapFailureDecision,
  RequestGeneration,
  RestartEpochQueue,
  runBoundedRetry,
} from "./backend-lifecycle";
import { createPreferences } from "./preferences";
import { optimisticUnreadCount, shouldRestoreOptimisticUnread } from "./unread";
import {
  MAX_ACTIVE_MESSAGES,
  cloneDraft,
  draftIsEmpty,
  encodeMentions,
  mediaKey,
  mergeChats,
  mergeMessages,
  readRecentChats,
  rememberRecentChat,
  sortChats,
  sortMessages,
  trimMessages,
  upsertSortedMessage,
  writeRecentChats,
} from "./app-helpers";
import {
  closeTabInWorkspace,
  conversationsToEvict,
  cycleSwitcher as cycleSwitcherHighlight,
  emptyPane,
  moveTabBetweenPanes,
  openSwitcher as buildSwitcher,
  openTab,
  paneContainingChat,
  readWorkspaceSnapshot,
  recentChatCandidates,
  remapPaneChatId,
  selectTab,
  uniqueChatPanes,
  writeWorkspaceSnapshot,
  type Pane,
  type Switcher,
} from "./workspace";

export type { Pane, Switcher } from "./workspace";

export type Screen = "starting" | "pairing" | "chats" | "fatal";
export type ChatFilter = "all" | "unread" | "groups" | "archived";

export interface Mention {
  displayName: string;
  jid: string;
}

export interface Draft {
  text: string;
  replyToMessageId: string;
  replyToChatId: string;
  replyPreviewText: string;
  replySenderName: string;
  editingMessageId: string;
  mentions: Mention[];
}

export interface ForwardDialogState {
  sourceChatId: string;
  messageId: string;
}

export type FileSendMode = "image" | "sticker" | "attachment";

export interface FileSendConfirmationState {
  chatId: string;
  paths: string[];
  mode: FileSendMode;
  attachmentKind: AttachmentKind;
  voiceNote: boolean;
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

/** One conversation's message window, keyed by chat id so two panes can each hold one. */
export interface ConversationState {
  chatId: string;
  messages: Message[];
  loading: boolean;
  loadingOlder: boolean;
  loadingNewer: boolean;
  hasOlder: boolean;
  hasNewer: boolean;
  firstUnreadMessageId: string;
  highlightedMessageId: string;
  liveMessageVersion: number;
}

/**
 * Placeholder sticker-pack shape so composer/tray work can begin before the
 * STICKERS agent lands the real type in `lib/types.ts`. See `loadStickers`
 * for the corresponding defensive bridge call.
 */
export interface StickerPack {
  id: string;
  name: string;
  stickerIds: string[];
}

export interface StickersState {
  packs: StickerPack[];
  loading: boolean;
  error: string;
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
  /** Derived from, and kept in sync with, the focused pane's `activeChatId`. */
  selectedChatId: string;
  conversations: Record<string, ConversationState>;
  panes: Pane[];
  focusedPaneId: string;
  switcher: Switcher | null;
  drafts: Record<string, Draft>;
  sending: boolean;
  typing: Record<string, Record<string, TypingPresence>>;
  pinnedMessages: Record<string, PinnedMessage[]>;
  pendingPollVotes: Record<string, boolean>;
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
  forwardDialog: ForwardDialogState | null;
  fileSendConfirmation: FileSendConfirmationState | null;
  settingsOpen: boolean;
  stickers: StickersState;
  logoutConfirmation: boolean;
  tabAnnouncement: string;
  toasts: Toast[];
  fatalError: string;
}

const emptyDraft = (): Draft => ({
  text: "",
  replyToMessageId: "",
  replyToChatId: "",
  replyPreviewText: "",
  replySenderName: "",
  editingMessageId: "",
  mentions: [],
});
/** Cap on simultaneously hydrated conversations; least-recently-focused ones are evicted. */
const MAX_HYDRATED_CONVERSATIONS = 8;
const MAX_AVATAR_ATTEMPTS = 4_096;
const MAX_PARTICIPANT_AVATARS = 512;
const MAX_MEDIA_FAILURES = 512;

function emptyConversation(chatId: string): ConversationState {
  return {
    chatId,
    messages: [],
    loading: false,
    loadingOlder: false,
    loadingNewer: false,
    hasOlder: false,
    hasNewer: false,
    firstUnreadMessageId: "",
    highlightedMessageId: "",
    liveMessageVersion: 0,
  };
}

export interface AppModelLifecycleHooks {
  /** Release queued deep links/notification activations once backend state is hydrated. */
  backendReady?(): void;
}

export function createAppModel(lifecycleHooks: AppModelLifecycleHooks = {}) {
  const { preferences, prefActions } = createPreferences();
  const restoredWorkspace = readWorkspaceSnapshot();
  const initialPanes = restoredWorkspace?.panes ?? [emptyPane("pane-1")];
  const initialFocusedPaneId = restoredWorkspace?.focusedPaneId ?? initialPanes[0]!.id;
  const initialSelectedChatId =
    initialPanes.find((pane) => pane.id === initialFocusedPaneId)?.activeChatId ?? "";

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
    selectedChatId: initialSelectedChatId,
    conversations: {},
    panes: initialPanes,
    focusedPaneId: initialFocusedPaneId,
    switcher: null,
    drafts: {},
    sending: false,
    typing: {},
    pinnedMessages: {},
    pendingPollVotes: {},
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
    forwardDialog: null,
    fileSendConfirmation: null,
    settingsOpen: false,
    stickers: { packs: [], loading: false, error: "" },
    logoutConfirmation: false,
    tabAnnouncement: "",
    toasts: [],
    fatalError: "",
  });

  let searchGeneration = 0;
  let searchTimer: number | undefined;
  let syncRefreshTimer: number | undefined;
  let typingTimer: number | undefined;
  let typingChatId = "";
  let eventGapResyncing = false;
  let restartResyncing = false;
  const restartEpochs = new RestartEpochQueue();
  const chatListGeneration = new RequestGeneration();
  const chatInfoGeneration = new RequestGeneration();
  let disposed = false;
  let toastId = 0;
  const pendingImages = new Set<string>();
  const pollVoteGenerations = new Map<string, number>();
  const pinGenerations = new Map<string, number>();
  const pendingAttachments = new Set<string>();
  const pendingAvatars = new Set<string>();
  const attemptedAvatars = new BoundedSet<string>(MAX_AVATAR_ATTEMPTS);
  const participantAvatarKeys = new BoundedSet<string>(MAX_PARTICIPANT_AVATARS);
  const failedImageKeys = new BoundedSet<string>(MAX_MEDIA_FAILURES);
  const failedAttachmentKeys = new BoundedSet<string>(MAX_MEDIA_FAILURES);
  const backendChatRevisions = new Map<string, number>();
  /** Per-chat load generations so a stale in-flight fetch cannot clobber a fresher one. */
  const conversationGenerations = new Map<string, number>();
  /** Monotonic across evictions so a reopened chat can never reuse an in-flight token. */
  let conversationGenerationSequence = 0;
  /** Drives LRU eviction once more than `MAX_HYDRATED_CONVERSATIONS` chats are hydrated. */
  const conversationLastFocusedAt = new Map<string, number>();
  /** A brand-new conversation emits its message immediately before its chat row. */
  const pendingNotifications = new Map<string, Message>();
  const notifiedMessages = new Set<string>();
  let fileSendQueue: Promise<void> = Promise.resolve();
  let disposeNotificationActions: (() => void) | undefined;
  const notificationActivations = new NotificationActivationQueue(openNotificationTarget);
  const participantAvatarQueue = new ParticipantAvatarQueue({
    fetchAvatar: async (participantId) => (await bridge.getParticipantAvatar(participantId)).avatarPath,
    onHydrated: (participantId, avatarPath) => {
      const evicted = participantAvatarKeys.add(participantId);
      batch(() => {
        if (evicted) setState("participantAvatars", evicted, undefined!);
        setState("participantAvatars", participantId, avatarPath);
      });
    },
  });

  function markBackendReady() {
    notificationActivations.markReady();
    lifecycleHooks.backendReady?.();
  }

  async function bootstrap() {
    try {
      try {
        const dispose = await listenForNotificationActions((target) => {
          notificationActivations.enqueue(target);
        });
        if (disposed) dispose();
        else disposeNotificationActions = dispose;
      } catch (error) {
        // Notifications are optional desktop integration. A missing or broken
        // platform service must not prevent the messaging bridge from starting.
        console.warn("Could not register notification actions", error);
      }
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
      if (preferences.notificationsEnabled) {
        void ensureNotificationPermission().catch((error) => {
          console.warn("Could not initialize notifications", error);
        });
      }
      await loadChats(true);
      await restoreWorkspaceConversations();
      markBackendReady();
    } catch (error) {
      const bridgeError = normalizeBridgeError(error);
      if (bootstrapFailureDecision(bridgeError) === "reconnecting") {
        batch(() => {
          setState("connection", ConnectionState.Reconnecting);
          setState("connectionDetail", "Waiting for the WhatsApp backend to restart");
        });
      } else {
        fatal(bridgeError.message);
      }
    }
  }

  /** Hydrate whichever chats the restored (or freshly created) panes are showing. */
  async function restoreWorkspaceConversations() {
    const chatIds = [...new Set(state.panes.map((pane) => pane.activeChatId).filter(Boolean))];
    await Promise.all(
      chatIds.map((chatId) => {
        touchConversationFocus(chatId);
        return Promise.all([loadConversation(chatId), loadPinnedMessages(chatId)]).catch(() => undefined);
      }),
    );
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

  async function loadChats(reset = false, supersede = false, throwOnError = false) {
    if (state.loadingChats && !supersede) return;
    if (!reset && !state.nextChatCursor) return;
    const generation = chatListGeneration.begin();
    setState("loadingChats", true);
    try {
      const cursor = reset ? "" : state.nextChatCursor;
      const response = await bridge.listChats(cursor, 100);
      if (!chatListGeneration.isCurrent(generation)) return;
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
      if (chatListGeneration.isCurrent(generation)) {
        if (throwOnError) throw error;
        toast(normalizeBridgeError(error).message);
      }
    } finally {
      if (chatListGeneration.isCurrent(generation)) setState("loadingChats", false);
    }
  }

  // ---------------------------------------------------------------------
  // Conversations
  // ---------------------------------------------------------------------

  /** Never returns undefined so components can render before a chat has loaded. */
  function conversation(chatId: string): ConversationState {
    return state.conversations[chatId] ?? Object.freeze(emptyConversation(chatId));
  }

  function ensureConversation(chatId: string) {
    if (!state.conversations[chatId]) setState("conversations", chatId, emptyConversation(chatId));
  }

  function bumpConversationGeneration(chatId: string): number {
    const next = ++conversationGenerationSequence;
    conversationGenerations.set(chatId, next);
    return next;
  }

  function isCurrentGeneration(chatId: string, generation: number): boolean {
    return conversationGenerations.get(chatId) === generation;
  }

  function touchConversationFocus(chatId: string) {
    if (!chatId) return;
    conversationLastFocusedAt.set(chatId, Date.now());
  }

  function isChatVisible(chatId: string): boolean {
    const compactSplit = window.matchMedia?.("(max-width: 900px)").matches ?? false;
    return isChatActuallyVisible(state.panes, state.focusedPaneId, chatId, compactSplit);
  }

  /** Evict conversations that are no longer open anywhere, then trim to the LRU cap. */
  function pruneConversations() {
    const openChatIds = new Set(state.panes.flatMap((pane) => pane.tabChatIds));
    const visibleChatIds = new Set(state.panes.map((pane) => pane.activeChatId).filter(Boolean));
    const evicted = conversationsToEvict(
      Object.keys(state.conversations),
      openChatIds,
      conversationLastFocusedAt,
      MAX_HYDRATED_CONVERSATIONS,
      visibleChatIds,
    );
    if (evicted.length === 0) return;
    batch(() => {
      for (const chatId of evicted) {
        setState("conversations", chatId, undefined!);
        conversationGenerations.delete(chatId);
        conversationLastFocusedAt.delete(chatId);
      }
    });
  }

  /** Fetch (or refetch) a chat's message window and write it into `state.conversations`. */
  async function loadConversation(chatId: string, aroundMessageId = "", throwOnError = false) {
    if (!chatId) return;
    ensureConversation(chatId);
    const generation = bumpConversationGeneration(chatId);
    batch(() => {
      setState("conversations", chatId, "loading", true);
      // A new canonical/around window supersedes pagination already in flight.
      setState("conversations", chatId, "loadingOlder", false);
      setState("conversations", chatId, "loadingNewer", false);
    });
    try {
      if (aroundMessageId) {
        const response = await bridge.listMessagesAround(chatId, aroundMessageId);
        if (!isCurrentGeneration(chatId, generation)) return;
        const highlightId = response.anchorMessageId || aroundMessageId;
        const merged = sortMessages(
          mergeMessages(state.conversations[chatId]?.messages ?? [], response.messages),
        );
        const requestedAnchorIndex = merged.findIndex((message) => message.id === highlightId);
        const anchorIndex = requestedAnchorIndex >= 0 ? requestedAnchorIndex : merged.length - 1;
        const bounded = boundWindowAround(merged, MAX_ACTIVE_MESSAGES, anchorIndex);
        batch(() => {
          setState(
            "conversations",
            chatId,
            "messages",
            reconcile(bounded.items, { key: "id" }),
          );
          setState("conversations", chatId, "hasOlder", response.hasOlder || bounded.droppedBefore);
          setState("conversations", chatId, "hasNewer", response.hasNewer || bounded.droppedAfter);
          setState(
            "conversations",
            chatId,
            "highlightedMessageId",
            requestedAnchorIndex >= 0 ? highlightId : "",
          );
        });
        window.setTimeout(() => {
          if (state.conversations[chatId]?.highlightedMessageId === highlightId) {
            setState("conversations", chatId, "highlightedMessageId", "");
          }
        }, 3_000);
      } else {
        const response = await bridge.openMessageWindow(chatId);
        if (!isCurrentGeneration(chatId, generation)) return;
        const merged = sortMessages(
          mergeMessages(state.conversations[chatId]?.messages ?? [], response.messages),
        );
        const bounded = boundWindowAround(merged, MAX_ACTIVE_MESSAGES, merged.length - 1);
        batch(() => {
          setState(
            "conversations",
            chatId,
            "messages",
            reconcile(bounded.items, { key: "id" }),
          );
          setState("conversations", chatId, "hasOlder", response.hasOlder || bounded.droppedBefore);
          setState("conversations", chatId, "hasNewer", response.hasNewer || bounded.droppedAfter);
          setState("conversations", chatId, "firstUnreadMessageId", response.firstUnreadMessageId);
        });
      }
      void markChatRead(chatId);
      void loadAvatar(chatId);
      void bridge.repairRecentReactions(chatId).catch(() => undefined);
    } catch (error) {
      if (isCurrentGeneration(chatId, generation)) {
        if (throwOnError) throw error;
        toast(normalizeBridgeError(error).message);
      }
    } finally {
      if (isCurrentGeneration(chatId, generation)) setState("conversations", chatId, "loading", false);
    }
  }

  async function loadOlder(chatId = state.selectedChatId) {
    const current = state.conversations[chatId];
    const first = current?.messages[0];
    if (!current || !first || !current.hasOlder || current.loadingOlder) return;
    const generation = conversationGenerations.get(chatId);
    setState("conversations", chatId, "loadingOlder", true);
    try {
      const response = await bridge.listMessages(chatId, first.timestampMs, first.id, 50);
      if (!state.conversations[chatId] || conversationGenerations.get(chatId) !== generation) return;
      const merged = mergeMessages(response.messages, state.conversations[chatId]!.messages);
      const trimmed = merged.length > MAX_ACTIVE_MESSAGES;
      batch(() => {
        setState("conversations", chatId, "messages", reconcile(trimMessages(merged, "newer"), { key: "id" }));
        setState("conversations", chatId, "hasOlder", response.hasMore);
        if (trimmed) setState("conversations", chatId, "hasNewer", true);
      });
    } catch (error) {
      if (conversationGenerations.get(chatId) === generation) {
        toast(normalizeBridgeError(error).message);
      }
    } finally {
      if (state.conversations[chatId] && conversationGenerations.get(chatId) === generation) {
        setState("conversations", chatId, "loadingOlder", false);
      }
    }
  }

  async function loadNewer(chatId = state.selectedChatId) {
    const current = state.conversations[chatId];
    const last = current?.messages.at(-1);
    if (!current || !last || !current.hasNewer || current.loadingNewer) return;
    const generation = conversationGenerations.get(chatId);
    setState("conversations", chatId, "loadingNewer", true);
    try {
      const response = await bridge.listMessagesAfter(chatId, last.timestampMs, last.id, 50);
      if (!state.conversations[chatId] || conversationGenerations.get(chatId) !== generation) return;
      const merged = mergeMessages(state.conversations[chatId]!.messages, response.messages);
      const trimmed = merged.length > MAX_ACTIVE_MESSAGES;
      batch(() => {
        setState("conversations", chatId, "messages", reconcile(trimMessages(merged, "older"), { key: "id" }));
        setState("conversations", chatId, "hasNewer", response.hasMore);
        if (trimmed) setState("conversations", chatId, "hasOlder", true);
      });
    } catch (error) {
      if (conversationGenerations.get(chatId) === generation) {
        toast(normalizeBridgeError(error).message);
      }
    } finally {
      if (state.conversations[chatId] && conversationGenerations.get(chatId) === generation) {
        setState("conversations", chatId, "loadingNewer", false);
      }
    }
  }

  async function jumpToLatest(chatId = state.selectedChatId) {
    if (!chatId) return;
    await loadConversation(chatId);
  }

  // ---------------------------------------------------------------------
  // Panes and tabs
  // ---------------------------------------------------------------------

  function syncSelectedChatId() {
    const pane = state.panes.find((candidate) => candidate.id === state.focusedPaneId);
    const selectedChatId = pane?.activeChatId ?? "";
    if (state.selectedChatId && state.selectedChatId !== selectedChatId) {
      participantAvatarQueue.cancelScope(state.selectedChatId);
    }
    if (state.selectedChatId !== selectedChatId) {
      chatInfoGeneration.invalidate();
      setState("chatInfoLoading", false);
      setState("chatInfoError", "");
    }
    setState("selectedChatId", selectedChatId);
  }

  function writePane(paneId: string, pane: Pane) {
    setState("panes", (candidate) => candidate.id === paneId, {
      tabChatIds: pane.tabChatIds,
      activeChatId: pane.activeChatId,
    });
  }

  function persistWorkspace() {
    writeWorkspaceSnapshot({
      panes: state.panes.map((pane) => ({ ...pane, tabChatIds: [...pane.tabChatIds] })),
      focusedPaneId: state.focusedPaneId,
    });
  }

  /**
   * Load a chat into a pane's active tab and focus that pane. Selecting a
   * chat already open somewhere in the pane just focuses it; otherwise it
   * replaces the active slot so sidebar clicks do not pile up tabs — use
   * `openInNewTab` to open deliberately alongside the current tab.
   */
  async function selectChat(chatId: string, aroundMessageId = "", paneId = state.focusedPaneId) {
    // Message windows are chat-scoped while scroll restoration is pane-scoped.
    // Focus an existing owner pane instead of duplicating a chat and letting an
    // exact pin/search target replace both panes' shared window.
    const ownerPane = paneContainingChat(state.panes, chatId);
    const targetPaneId = ownerPane?.id ?? paneId;
    const pane = state.panes.find((candidate) => candidate.id === targetPaneId);
    if (!chatId || !pane) return;
    const alreadyHydrated = Boolean(state.conversations[chatId]);
    stopTyping();
    batch(() => {
      writePane(targetPaneId, selectTab(pane, chatId));
      setState("focusedPaneId", targetPaneId);
      syncSelectedChatId();
      setState("chatInfoOpen", false);
      setState("chatInfo", null);
      setState("settingsOpen", false);
      setState("searchQuery", "");
      setState("searchResults", null);
    });
    ensureDraft(chatId);
    rememberRecentChat(chatId);
    touchConversationFocus(chatId);
    pruneConversations();
    persistWorkspace();
    if (aroundMessageId || !alreadyHydrated) {
      await loadConversation(chatId, aroundMessageId);
    } else {
      // Open tabs receive live upserts even while inactive. Reuse that bounded
      // window instead of flashing a loading state and doing an avoidable RPC
      // every time the user cycles through tabs.
      void markChatRead(chatId);
      void loadAvatar(chatId);
    }
    void loadPinnedMessages(chatId);
  }

  async function loadPinnedMessages(chatId: string, throwOnError = false) {
    try {
      const response = await bridge.listPinnedMessages(chatId);
      setState("pinnedMessages", chatId, response.pins);
    } catch (error) {
      if (throwOnError) throw error;
      toast(normalizeBridgeError(error).message);
    }
  }

  /** Close the focused pane's active tab, if any — a convenience over `closeTab`. */
  function closeChat(paneId = state.focusedPaneId) {
    const pane = state.panes.find((candidate) => candidate.id === paneId);
    if (pane?.activeChatId) closeTab(pane.activeChatId, paneId);
  }

  async function openInNewTab(chatId: string, paneId = state.focusedPaneId) {
    const ownerPane = paneContainingChat(state.panes, chatId);
    const targetPaneId = ownerPane?.id ?? paneId;
    const pane = state.panes.find((candidate) => candidate.id === targetPaneId);
    if (!chatId || !pane) return;
    const alreadyHydrated = Boolean(state.conversations[chatId]);
    batch(() => {
      writePane(targetPaneId, openTab(pane, chatId));
      setState("focusedPaneId", targetPaneId);
      syncSelectedChatId();
    });
    ensureDraft(chatId);
    rememberRecentChat(chatId);
    touchConversationFocus(chatId);
    pruneConversations();
    persistWorkspace();
    if (!alreadyHydrated) await loadConversation(chatId);
  }

  function closeTab(chatId: string, paneId = state.focusedPaneId) {
    const result = closeTabInWorkspace(state.panes, chatId, paneId);
    batch(() => {
      setState("panes", reconcile(result.panes, { key: "id" }));
      if (result.removedPaneId && state.focusedPaneId === result.removedPaneId) {
        setState("focusedPaneId", state.panes[0]?.id ?? "");
      }
      syncSelectedChatId();
    });
    if (typingChatId === chatId) stopTyping();
    pruneConversations();
    persistWorkspace();
  }

  function moveTab(chatId: string, fromPaneId: string, toPaneId: string, index: number) {
    const fromPane = state.panes.find((candidate) => candidate.id === fromPaneId);
    const toPane = state.panes.find((candidate) => candidate.id === toPaneId);
    if (!fromPane || !toPane || !fromPane.tabChatIds.includes(chatId)) return;
    const moved = moveTabBetweenPanes(state.panes, chatId, fromPaneId, toPaneId, index);
    batch(() => {
      setState("panes", reconcile(moved, { key: "id" }));
      setState("focusedPaneId", toPaneId);
      syncSelectedChatId();
    });
    touchConversationFocus(chatId);
    pruneConversations();
    persistWorkspace();
  }

  function announceTabAction(message: string) {
    setState("tabAnnouncement", "");
    queueMicrotask(() => setState("tabAnnouncement", message));
  }

  function focusPane(paneId: string) {
    if (state.focusedPaneId === paneId || !state.panes.some((pane) => pane.id === paneId)) return;
    setState("focusedPaneId", paneId);
    syncSelectedChatId();
    const active = state.panes.find((pane) => pane.id === paneId)?.activeChatId;
    if (active) touchConversationFocus(active);
    persistWorkspace();
  }

  /** Create the second pane, or simply focus it when the workspace is already split. */
  function splitPane() {
    if (state.panes.length >= 2) {
      const other = state.panes.find((pane) => pane.id !== state.focusedPaneId);
      if (other) focusPane(other.id);
      return;
    }
    const newPaneId = state.panes.some((pane) => pane.id === "pane-1") ? "pane-2" : "pane-1";
    batch(() => {
      setState("panes", (panes) => [...panes, emptyPane(newPaneId)]);
      setState("focusedPaneId", newPaneId);
      syncSelectedChatId();
    });
    persistWorkspace();
  }

  /** The workspace always keeps at least one pane; closing the only pane is a no-op. */
  function closePane(paneId: string) {
    if (state.panes.length <= 1 || !state.panes.some((pane) => pane.id === paneId)) return;
    const remaining = state.panes.filter((pane) => pane.id !== paneId);
    batch(() => {
      setState("panes", remaining);
      if (state.focusedPaneId === paneId) setState("focusedPaneId", remaining[0]!.id);
      syncSelectedChatId();
    });
    pruneConversations();
    persistWorkspace();
  }

  // ---------------------------------------------------------------------
  // Chat switcher (Ctrl+Tab, goal G4)
  // ---------------------------------------------------------------------

  function openSwitcher(reverse: boolean) {
    const candidates = recentChatCandidates(
      readRecentChats(),
      (chatId) => state.chats.some((chat) => chat.id === chatId),
      state.chats.map((chat) => chat.id),
      state.selectedChatId,
    );
    const selectedIsFirst = Boolean(state.selectedChatId) && candidates[0] === state.selectedChatId;
    const switcher = buildSwitcher(candidates, reverse, selectedIsFirst);
    if (!switcher) return;
    batch(() => {
      setState("chatInfoOpen", false);
      setState("chatInfo", null);
      setState("settingsOpen", false);
      setState("imageViewer", null);
      setState("switcher", switcher);
    });
  }

  function cycleSwitcher(reverse: boolean) {
    if (!state.switcher) return;
    setState("switcher", cycleSwitcherHighlight(state.switcher, reverse));
  }

  function commitSwitcher() {
    const switcher = state.switcher;
    setState("switcher", null);
    const chatId = switcher?.chatIds[switcher.highlighted];
    if (chatId) void selectChat(chatId);
  }

  function cancelSwitcher() {
    setState("switcher", null);
  }

  // ---------------------------------------------------------------------
  // Search
  // ---------------------------------------------------------------------

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

  // ---------------------------------------------------------------------
  // Composer / drafts
  // ---------------------------------------------------------------------

  function setDraftText(text: string, chatId = state.selectedChatId) {
    if (!chatId) return;
    ensureDraft(chatId);
    setState("drafts", chatId, "text", text);
    scheduleTyping(chatId, text.trim().length > 0);
  }

  function replyTo(messageId: string, chatId = state.selectedChatId) {
    if (!chatId) return;
    const message = state.conversations[chatId]?.messages.find((candidate) => candidate.id === messageId);
    ensureDraft(chatId);
    batch(() => {
      setState("drafts", chatId, "replyToMessageId", messageId);
      setState("drafts", chatId, "replyToChatId", chatId);
      setState("drafts", chatId, "replyPreviewText", message ? messageText(message) : "");
      setState("drafts", chatId, "replySenderName", message?.fromMe ? "You" : message?.senderName || "");
    });
  }

  function cancelReply(chatId = state.selectedChatId) {
    if (chatId && state.drafts[chatId]) {
      batch(() => {
        setState("drafts", chatId, "replyToMessageId", "");
        setState("drafts", chatId, "replyToChatId", "");
        setState("drafts", chatId, "replyPreviewText", "");
        setState("drafts", chatId, "replySenderName", "");
      });
    }
  }

  async function replyPrivately(message: Message, sourceChatId = message.chatId) {
    const sourceChat = state.chats.find((chat) => chat.id === sourceChatId);
    if (
      sourceChat?.kind !== ChatKind.Group ||
      message.fromMe ||
      message.revoked ||
      !message.senderId
    ) return;
    try {
      const response = await bridge.openContact(message.senderId);
      if (!response.chat) throw new Error("The sender did not produce a direct chat");
      const target = {
        ...response.chat,
        title: message.senderName || response.chat.title || message.senderPhoneNumber,
      };
      upsertChat(target);
      ensureDraft(target.id);
      batch(() => {
        setState("drafts", target.id, "replyToMessageId", message.id);
        setState("drafts", target.id, "replyToChatId", sourceChatId);
        setState("drafts", target.id, "replyPreviewText", messageText(message));
        setState("drafts", target.id, "replySenderName", message.senderName || message.senderPhoneNumber);
        setState("drafts", target.id, "editingMessageId", "");
        setState("drafts", target.id, "mentions", []);
      });
      await selectChat(target.id);
    } catch (error) {
      toast(normalizeBridgeError(error).message);
    }
  }

  function editMessage(messageId: string, chatId = state.selectedChatId) {
    if (!chatId) return;
    const message = state.conversations[chatId]?.messages.find((candidate) => candidate.id === messageId);
    if (!message?.fromMe || message.revoked || !message.content || !("text" in message.content)) return;
    const text = message.content.text.text;
    ensureDraft(chatId);
    batch(() => {
      setState("drafts", chatId, "text", text);
      setState("drafts", chatId, "replyToMessageId", "");
      setState("drafts", chatId, "replyToChatId", "");
      setState("drafts", chatId, "replyPreviewText", "");
      setState("drafts", chatId, "replySenderName", "");
      setState("drafts", chatId, "editingMessageId", messageId);
      setState("drafts", chatId, "mentions", []);
    });
  }

  function cancelEdit(chatId = state.selectedChatId) {
    if (!chatId || !state.drafts[chatId]) return;
    setState("drafts", chatId, emptyDraft());
    scheduleTyping(chatId, false);
  }

  function startForward(messageId: string, sourceChatId = state.selectedChatId) {
    if (!sourceChatId) return;
    setState("forwardDialog", { sourceChatId, messageId });
  }

  function cancelForward() {
    setState("forwardDialog", null);
  }

  async function forwardMessage(targetChatIds: string[]) {
    const source = state.forwardDialog;
    const targets = [...new Set(targetChatIds.filter(Boolean))];
    if (!source || targets.length === 0) return;
    const results = await Promise.allSettled(
      targets.map((targetChatId) =>
        bridge.forwardMessage(source.sourceChatId, source.messageId, targetChatId),
      ),
    );
    let forwarded = 0;
    for (const result of results) {
      if (result.status === "fulfilled") {
        forwarded++;
        if (result.value.message) upsertMessage(result.value.message, true);
      }
    }
    if (forwarded > 0) {
      setState("forwardDialog", null);
      toast(`Forwarded to ${forwarded} ${forwarded === 1 ? "chat" : "chats"}`, "info");
    }
    const failed = results.find((result): result is PromiseRejectedResult => result.status === "rejected");
    if (failed) toast(normalizeBridgeError(failed.reason).message);
  }

  function addMention(
    participant: ChatParticipant,
    tokenStart: number,
    tokenEnd: number,
    chatId = state.selectedChatId,
  ) {
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

  async function sendCurrentText(chatId = state.selectedChatId) {
    const draft = state.drafts[chatId];
    if (!chatId || !draft || state.sending) return;
    const text = draft.text.trim();
    if (!text) return;
    if (new TextEncoder().encode(text).length > 65_536) {
      toast("Messages can be at most 65,536 bytes");
      return;
    }
    const previous = cloneDraft(draft);
    const editingMessageId = previous.editingMessageId;
    const encoded = encodeMentions(text, previous.mentions);
    batch(() => {
      setState("sending", true);
      setState("drafts", chatId, emptyDraft());
    });
    scheduleTyping(chatId, false);
    try {
      const response = editingMessageId
        ? await bridge.editMessage(chatId, editingMessageId, text)
        : await bridge.sendText(
            chatId,
            encoded.text,
            previous.replyToMessageId,
            encoded.jids,
            previous.replyToChatId,
          );
      if (response.message) upsertMessage(response.message, true);
    } catch (error) {
      if (draftIsEmpty(state.drafts[chatId])) setState("drafts", chatId, previous);
      toast(normalizeBridgeError(error).message);
    } finally {
      setState("sending", false);
    }
  }

  async function createPoll(question: string, options: string[], selectableOptionsCount: number, chatId = state.selectedChatId) {
    if (!chatId) return;
    try {
      const response = await bridge.createPoll(chatId, question, options, selectableOptionsCount);
      if (response.message) upsertMessage(response.message, true);
    } catch (error) {
      toast(normalizeBridgeError(error).message);
    }
  }

  async function votePoll(message: Message, selectedOptions: string[], chatId = message.chatId) {
    if (!message.content || !("poll" in message.content)) return;
    const key = mediaKey(chatId, message.id);
    const generation = (pollVoteGenerations.get(key) ?? 0) + 1;
    pollVoteGenerations.set(key, generation);
    const stateKey = `${chatId}:${message.id}`;
    const previous = clonePollContent(message.content.poll);
    const optimistic = optimisticPollVote(previous, selectedOptions);
    setState("conversations", chatId, "messages", (candidate) => candidate.id === message.id, "content", { poll: optimistic });
    setState("pendingPollVotes", stateKey, true);
    const isCurrent = () => pollVoteGenerations.get(key) === generation;
    try {
      const response = await bridge.votePoll(chatId, message.id, selectedOptions);
      if (isCurrent() && response.message) {
        setState("pendingPollVotes", stateKey, undefined!);
        upsertMessage(response.message, true);
      }
    } catch (error) {
      if (isCurrent()) {
        setState("conversations", chatId, "messages", (candidate) => candidate.id === message.id, "content", { poll: previous });
        toast(normalizeBridgeError(error).message);
      }
    } finally {
      if (isCurrent()) setState("pendingPollVotes", stateKey, undefined!);
    }
  }

  async function setMessagePin(messageId: string, pinned: boolean, chatId = state.selectedChatId) {
    if (!chatId) return;
    const key = mediaKey(chatId, messageId);
    const generation = (pinGenerations.get(key) ?? 0) + 1;
    pinGenerations.set(key, generation);
    try {
      await bridge.setMessagePin(chatId, messageId, pinned);
      if (pinGenerations.get(key) === generation) await loadPinnedMessages(chatId);
    } catch (error) {
      if (pinGenerations.get(key) === generation) toast(normalizeBridgeError(error).message);
    }
  }

  async function sendImage(path: string, chatId = state.selectedChatId) {
    await enqueueFileSend(chatId, path, "image");
  }

  async function sendSticker(path: string, chatId = state.selectedChatId) {
    await enqueueFileSend(chatId, path, "sticker");
  }

  async function sendAttachment(
    path: string,
    kind: AttachmentKind,
    voiceNote = false,
    chatId = state.selectedChatId,
  ) {
    await enqueueFileSend(chatId, path, "attachment", kind, voiceNote);
  }

  function requestFileSend(
    paths: string[],
    mode: FileSendMode,
    attachmentKind: AttachmentKind = AttachmentKind.Document,
    voiceNote = false,
    chatId = state.selectedChatId,
  ) {
    const selectedPaths = paths.filter(Boolean);
    if (!chatId || selectedPaths.length === 0 || state.sending) return;
    setState("fileSendConfirmation", {
      chatId,
      paths: selectedPaths,
      mode,
      attachmentKind,
      voiceNote,
    });
  }

  function cancelFileSend() {
    setState("fileSendConfirmation", null);
  }

  async function confirmFileSend() {
    const request = state.fileSendConfirmation;
    if (!request) return;
    setState("fileSendConfirmation", null);
    await enqueueFileBatch(request);
  }

  function enqueueFileSend(
    chatId: string,
    path: string,
    mode: FileSendMode,
    attachmentKind: AttachmentKind = AttachmentKind.Document,
    voiceNote = false,
  ): Promise<void> {
    return enqueueFileBatch({
      chatId,
      paths: [path],
      mode,
      attachmentKind,
      voiceNote,
    });
  }

  function enqueueFileBatch(request: FileSendConfirmationState): Promise<void> {
    const operation = fileSendQueue.then(async () => {
      while (state.sending) {
        await new Promise<void>((resolve) => window.setTimeout(resolve, 16));
      }
      await sendFileBatch(request);
    });
    fileSendQueue = operation.catch(() => undefined);
    return operation;
  }

  async function sendFileBatch(request: FileSendConfirmationState) {
    const { chatId, paths, mode, attachmentKind, voiceNote } = request;
    const draft = state.drafts[chatId] ?? emptyDraft();
    if (!chatId || paths.length === 0 || state.sending) return;
    const previous = cloneDraft(draft);
    const supportsCaption =
      mode === "image" ||
      (mode === "attachment" && attachmentKind !== AttachmentKind.Audio);
    const retainedDraft = supportsCaption
      ? emptyDraft()
      : {
          ...cloneDraft(previous),
          replyToMessageId: "",
          replyToChatId: "",
          replyPreviewText: "",
          replySenderName: "",
        };
    batch(() => {
      setState("sending", true);
      setState("drafts", chatId, retainedDraft);
    });
    scheduleTyping(chatId, false);
    const failures: Array<{ path: string; error: unknown }> = [];
    let sent = 0;
    try {
      for (let index = 0; index < paths.length; index++) {
        const path = paths[index]!;
        // WhatsApp sends each selected file as its own message. Apply the
        // current caption/reply only to the first one, matching album-style
        // multi-file sending without duplicating the caption on every item.
        const context = index === 0 ? previous : emptyDraft();
        try {
          const response =
            mode === "image"
              ? await bridge.sendImage(chatId, path, context.text.trim(), context.replyToMessageId, context.replyToChatId)
              : mode === "sticker"
                ? await bridge.sendSticker(chatId, path, context.replyToMessageId, context.replyToChatId)
                : await bridge.sendAttachment(
                    chatId,
                    path,
                    attachmentKind,
                    attachmentKind === AttachmentKind.Audio ? "" : context.text.trim(),
                    context.replyToMessageId,
                    voiceNote,
                    context.replyToChatId,
                  );
          if (response.message) upsertMessage(response.message, true);
          sent++;
        } catch (error) {
          failures.push({ path, error });
        }
      }
      if (failures.length === 0 && paths.length > 1) {
        toast(`Sent ${sent} files`, "info");
      } else if (failures.length > 0) {
        const currentDraft = state.drafts[chatId];
        const draftWasUntouched =
          supportsCaption
            ? draftIsEmpty(currentDraft)
            : currentDraft?.text === retainedDraft.text &&
              currentDraft?.editingMessageId === retainedDraft.editingMessageId &&
              currentDraft?.replyToMessageId === retainedDraft.replyToMessageId;
        if (failures[0]?.path === paths[0] && draftWasUntouched) {
          setState("drafts", chatId, previous);
        }
        const firstError = normalizeBridgeError(failures[0]!.error).message;
        toast(
          paths.length === 1
            ? firstError
            : `Sent ${sent} of ${paths.length} files. ${failures.length} failed: ${firstError}`,
        );
      }
    } finally {
      setState("sending", false);
    }
  }

  // ---------------------------------------------------------------------
  // Media hydration
  // ---------------------------------------------------------------------

  async function hydrateImage(
    message: Message,
    retry = false,
    requireFull = false,
    chatId = message.chatId,
  ) {
    if (!(message.content && "image" in message.content)) return;
    const image = message.content.image;
    if (image.localPath) return image.localPath;
    if (image.thumbnailPath && !requireFull) return image.thumbnailPath;
    if (!image.downloadable) return image.thumbnailPath || undefined;
    const key = mediaKey(chatId, message.id);
    if (pendingImages.has(key) || pendingImages.size >= 4) return;
    if (state.imageFailures[key] && !retry) return;
    pendingImages.add(key);
    if (retry) {
      failedImageKeys.delete(key);
      setState("imageFailures", key, undefined!);
    }
    try {
      const response = await bridge.getMessageImage(chatId, message.id);
      updateMessage(chatId, message.id, (current) => {
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
      const evicted = failedImageKeys.add(key);
      batch(() => {
        if (evicted) setState("imageFailures", evicted, undefined!);
        setState("imageFailures", key, normalizeBridgeError(error).message);
      });
    } finally {
      pendingImages.delete(key);
    }
  }

  async function hydrateAttachment(message: Message, retry = false, chatId = message.chatId) {
    if (!(message.content && "attachment" in message.content)) return;
    const attachment = message.content.attachment;
    if (attachment.localPath) return attachment.localPath;
    if (!attachment.downloadable) return;
    const key = mediaKey(chatId, message.id);
    if (pendingAttachments.has(key) || pendingAttachments.size >= 3) return;
    if (state.attachmentFailures[key] && !retry) return;
    pendingAttachments.add(key);
    if (retry) {
      failedAttachmentKeys.delete(key);
      setState("attachmentFailures", key, undefined!);
    }
    try {
      const response = await bridge.getMessageAttachment(chatId, message.id);
      updateMessage(chatId, message.id, (current) => {
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
      const evicted = failedAttachmentKeys.add(key);
      batch(() => {
        if (evicted) setState("attachmentFailures", evicted, undefined!);
        setState("attachmentFailures", key, normalizeBridgeError(error).message);
      });
    } finally {
      pendingAttachments.delete(key);
    }
  }

  /**
   * Open a downloaded document in the platform default application. A stale
   * cache path is cleared and fetched once more before surfacing the failure;
   * this covers users cleaning the cache between history load and click.
   */
  async function openAttachment(message: Message, chatId = message.chatId) {
    if (!(message.content && "attachment" in message.content)) return;
    const originalAttachment = message.content.attachment;
    let current = message;
    let path: string | undefined = originalAttachment.localPath || undefined;
    if (path) {
      try {
        await bridge.openMediaPath(path);
        return;
      } catch {
        updateMessage(chatId, message.id, (stored) => {
          if (!(stored.content && "attachment" in stored.content)) return stored;
          return {
            ...stored,
            content: { attachment: { ...stored.content.attachment, localPath: "" } },
          };
        });
        current = {
          ...message,
          content: {
            attachment: { ...originalAttachment, localPath: "" },
          },
        };
      }
    }
    path = await hydrateAttachment(current, true, chatId);
    if (!path) {
      const failure = state.attachmentFailures[mediaKey(chatId, message.id)];
      if (failure) toast(failure);
      return;
    }
    try {
      await bridge.openMediaPath(path);
    } catch (error) {
      toast(normalizeBridgeError(error).message);
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

  function loadParticipantAvatar(participantId: string, rosterId: string) {
    if (!participantId || !rosterId || state.participantAvatars[participantId]) return () => undefined;
    return participantAvatarQueue.subscribe(participantId, rosterId);
  }

  // ---------------------------------------------------------------------
  // Chat info / settings overlays (single instance over the pane group)
  // ---------------------------------------------------------------------

  async function showChatInfo() {
    const chatId = state.selectedChatId;
    if (!chatId) return;
    const generation = chatInfoGeneration.begin();
    batch(() => {
      setState("chatInfoOpen", true);
      setState("chatInfoLoading", true);
      setState("chatInfoError", "");
      setState("settingsOpen", false);
    });
    try {
      const info = await bridge.getChatInfo(chatId);
      if (state.selectedChatId !== chatId || !chatInfoGeneration.isCurrent(generation)) return;
      setState("chatInfo", info);
      if (info.chat) upsertChat(info.chat);
    } catch (error) {
      if (chatInfoGeneration.isCurrent(generation)) {
        setState("chatInfoError", normalizeBridgeError(error).message);
      }
    } finally {
      if (chatInfoGeneration.isCurrent(generation)) setState("chatInfoLoading", false);
    }
  }

  async function ensureMentionDirectory() {
    const chatId = state.selectedChatId;
    if (!chatId || state.chatInfo?.chat?.id === chatId || state.chatInfoLoading) return;
    const generation = chatInfoGeneration.begin();
    setState("chatInfoLoading", true);
    try {
      const info = await bridge.getChatInfo(chatId);
      if (state.selectedChatId === chatId && chatInfoGeneration.isCurrent(generation)) {
        setState("chatInfo", info);
      }
    } catch {
      // Mention suggestions are optional; the main chat-info panel exposes retry UI.
    } finally {
      if (chatInfoGeneration.isCurrent(generation)) setState("chatInfoLoading", false);
    }
  }

  function hideChatInfo() {
    setState("chatInfoOpen", false);
  }

  async function react(messageId: string, emoji: string, chatId = state.selectedChatId) {
    const message = state.conversations[chatId]?.messages.find((candidate) => candidate.id === messageId);
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
      // The virtualizer may already be fetching the next page when a filter is
      // selected. Wait for that owner instead of treating its temporary
      // loading guard as a repeated cursor and abandoning the full hydrate.
      while (state.loadingChats) {
        await new Promise<void>((resolve) => window.setTimeout(resolve, 0));
      }
      const cursor = state.nextChatCursor;
      if (cursor === previousCursor) return;
      previousCursor = cursor;
      await loadChats(false);
    }
  }

  function toggleSettings(open = !state.settingsOpen) {
    batch(() => {
      setState("settingsOpen", open);
      if (open) setState("chatInfoOpen", false);
    });
  }

  // ---------------------------------------------------------------------
  // Stickers (placeholder pending the STICKERS agent's bridge/type work)
  // ---------------------------------------------------------------------

  /**
   * `bridge` does not yet declare `listStickers`; the STICKERS agent is
   * adding it (and the real `StickerPack` type) to `lib/bridge.ts` and
   * `lib/types.ts`. Call it defensively so this compiles and degrades to a
   * reported error in the meantime.
   */
  async function loadStickers() {
    const listStickers = (bridge as Partial<{ listStickers: () => Promise<{ packs: StickerPack[] }> }>)
      .listStickers;
    if (!listStickers) {
      setState("stickers", "error", "Sticker sync is not available in this build yet");
      return;
    }
    setState("stickers", "loading", true);
    try {
      const response = await listStickers();
      batch(() => {
        setState("stickers", "packs", response.packs);
        setState("stickers", "error", "");
      });
    } catch (error) {
      setState("stickers", "error", normalizeBridgeError(error).message);
    } finally {
      setState("stickers", "loading", false);
    }
  }

  async function sendStickerFromPack(stickerId: string, chatId = state.selectedChatId) {
    const sendStickerById = (
      bridge as Partial<{
        sendStickerById: (chatId: string, stickerId: string) => Promise<{ message: Message | null }>;
      }>
    ).sendStickerById;
    if (!chatId) return;
    if (!sendStickerById) {
      toast("Sticker sync is not available in this build yet");
      return;
    }
    try {
      const response = await sendStickerById(chatId, stickerId);
      if (response.message) upsertMessage(response.message, true);
    } catch (error) {
      toast(normalizeBridgeError(error).message);
    }
  }

  // ---------------------------------------------------------------------
  // Downloads (goal G7)
  // ---------------------------------------------------------------------

  /**
   * Copy one cached media file out to the user's save location. With no
   * configured directory the picker stands in, which is what the settings
   * panel means by "Ask every time".
   */
  async function saveMediaAs(sourcePath: string, suggestedName: string) {
    if (!sourcePath) {
      toast("That file has not been downloaded yet");
      return;
    }
    try {
      let destinationDir = preferences.downloadDir;
      if (!destinationDir) {
        const chosen = await openFile({
          directory: true,
          title: "Choose where to save this file",
        });
        if (!chosen) return;
        destinationDir = chosen;
      }
      const savedPath = await bridge.saveMediaAs(sourcePath, destinationDir, suggestedName);
      toast(`Saved to ${savedPath}`, "info");
    } catch (error) {
      toast(normalizeBridgeError(error).message);
    }
  }

  async function revealMedia(sourcePath: string) {
    if (!sourcePath) {
      toast("That file has not been downloaded yet");
      return;
    }
    try {
      await revealMediaPath(sourcePath, preferences.linuxFileManagerApp);
    } catch (error) {
      toast(normalizeBridgeError(error).message);
    }
  }

  async function openExternalLink(url: string) {
    try {
      await openUrl(url, preferences.linuxBrowserApp);
    } catch (error) {
      toast(normalizeBridgeError(error).message);
    }
  }

  async function setNotificationsEnabled(enabled: boolean) {
    if (!enabled) {
      prefActions.update("notificationsEnabled", false);
      return;
    }
    try {
      if (await ensureNotificationPermission(true)) {
        prefActions.update("notificationsEnabled", true);
      } else {
        prefActions.update("notificationsEnabled", false);
        toast("Notifications were not enabled by the operating system");
      }
    } catch (error) {
      prefActions.update("notificationsEnabled", false);
      toast(`Could not enable notifications: ${normalizeBridgeError(error).message}`);
    }
  }

  function dispose() {
    disposed = true;
    disposeNotificationActions?.();
    disposeNotificationActions = undefined;
    participantAvatarQueue.clear();
  }

  async function logout() {
    try {
      stopTyping();
      await bridge.logout();
      chatListGeneration.invalidate();
      chatInfoGeneration.invalidate();
      batch(() => {
        setState("logoutConfirmation", false);
        setState("screen", "pairing");
        setState("chats", []);
        setState("loadingChats", false);
        setState("conversations", {});
        setState("pinnedMessages", {});
        setState("pendingPollVotes", {});
        setState("panes", [emptyPane("pane-1")]);
        setState("focusedPaneId", "pane-1");
        setState("selectedChatId", "");
        setState("drafts", {});
        setState("participantAvatars", {});
        setState("imageFailures", {});
        setState("attachmentFailures", {});
      });
      conversationGenerations.clear();
      conversationLastFocusedAt.clear();
      attemptedAvatars.clear();
      participantAvatarQueue.clear();
      participantAvatarKeys.clear();
      pollVoteGenerations.clear();
      pinGenerations.clear();
      failedImageKeys.clear();
      failedAttachmentKeys.clear();
      persistWorkspace();
      await bridge.startPairing();
    } catch (error) {
      fatal(`Logout could not be completed safely: ${normalizeBridgeError(error).message}`);
    }
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
        if (event.payload.state === ConnectionState.Connected) {
          void loadChats(true).then(async () => {
            await restoreWorkspaceConversations();
            markBackendReady();
          });
        }
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
          const pending = pendingNotifications.get(chat.id);
          if (pending) {
            pendingNotifications.delete(chat.id);
            void notifyForMessage(pending, chat);
          }
        }
        break;
      case "messageUpserted":
        if (event.payload.message) {
          const message = event.payload.message;
          window.__RUST_MEOW_PERF_EVENT_RECEIVED__?.(message.id, performance.now());
          const chat = state.chats.find((candidate) => candidate.id === message.chatId);
          if (chat) void notifyForMessage(message, chat);
          else if (!message.fromMe) pendingNotifications.set(message.chatId, message);
          upsertMessage(message, true);
          clearTypingForMessage(message);
        }
        break;
      case "receiptUpdated":
        {
          const conversation = state.conversations[event.payload.chatId];
          const index = conversation?.messages.findIndex((message) => message.id === event.payload.messageId);
          if (conversation && index !== undefined && index >= 0) {
            setState("conversations", event.payload.chatId, "messages", index, "status", event.payload.status);
          }
        }
        break;
      case "reactionUpdated":
        if (event.payload.reaction) applyReaction(event.payload.reaction, event.payload.removed);
        break;
      case "chatMerged":
        notificationActivations.mergeChatId(event.payload.oldChatId, event.payload.newChatId);
        mergeChatId(event.payload.oldChatId, event.payload.newChatId);
        break;
      case "typingChanged":
        updateTyping(event.payload);
        break;
      case "pinnedMessagesChanged":
        void loadPinnedMessages(event.payload.chatId);
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
      case "bridgeLifecycle":
        {
          const decision = backendLifecycleDecision(event.payload);
          if (decision.phase === "reconnecting") {
            notificationActivations.markNotReady();
            batch(() => {
              setState("connection", ConnectionState.Reconnecting);
              setState("connectionDetail", decision.detail);
            });
          } else if (decision.phase === "resync") {
            batch(() => {
              setState("connection", ConnectionState.Reconnecting);
              setState("connectionDetail", "Refreshing chats after backend restart");
            });
            void resyncAfterBackendRestart(decision.epoch);
          } else {
            fatal(decision.message);
          }
        }
        break;
      case "recentReactionsRepaired":
        if (event.payload.recoveredReactions > 0 && state.conversations[event.payload.chatId]) {
          void loadConversation(event.payload.chatId);
        }
        break;
    }
  }

  function upsertChat(chat: Chat) {
    setState("chats", reconcile(sortChats(mergeChats(state.chats, [chat])), { key: "id" }));
  }

  async function notifyForMessage(message: Message, chat: Chat) {
    const key = mediaKey(message.chatId, message.id);
    if (notifiedMessages.has(key)) return;
    if (
      !shouldNotify({
        enabled: preferences.notificationsEnabled,
        visible: document.visibilityState === "visible",
        chatVisible: isChatVisible(message.chatId),
        muted: chat.muted,
        incoming: !message.fromMe && !message.edited && !message.revoked,
      })
    ) return;
    notifiedMessages.add(key);
    if (notifiedMessages.size > 1_000) {
      const oldest = notifiedMessages.values().next().value;
      if (oldest) notifiedMessages.delete(oldest);
    }
    try {
      await sendMessageNotification(chat, message, preferences.notificationPreviews);
    } catch (error) {
      // A desktop notification failure must never interrupt event reduction.
      console.warn("Could not show incoming message notification", error);
    }
  }

  async function openNotificationTarget({ chatId, messageId }: { chatId: string; messageId: string }) {
    const chat = state.chats.find((candidate) => candidate.id === chatId);
    if (notificationTargetAvailability(Boolean(chat), false) === "missing-chat") {
      toast("This conversation is no longer available");
      return;
    }
    await selectChat(chatId, messageId);
    const available = notificationTargetAvailability(
      true,
      Boolean(state.conversations[chatId]?.messages.some((message) => message.id === messageId)),
    );
    if (available === "available") return;
    toast("That message is no longer available. Showing the latest messages instead.", "info");
    await loadConversation(chatId);
  }

  async function resyncAfterEventGap() {
    if (eventGapResyncing) return;
    eventGapResyncing = true;
    try {
      const openChatIds = activeConversationIds(state.panes);
      await Promise.all([
        ...openChatIds.flatMap((chatId) => [loadConversation(chatId).catch(() => undefined), loadPinnedMessages(chatId).catch(() => undefined)]),
        loadChats(true),
      ]);
      toast("Chat state refreshed after a missed backend event", "info");
    } catch (error) {
      toast(`Could not refresh after the event gap: ${normalizeBridgeError(error).message}`);
    } finally {
      eventGapResyncing = false;
    }
  }

  function resyncAfterBackendRestart(epoch: number) {
    restartEpochs.push(epoch);
    if (restartResyncing) return;
    restartResyncing = true;
    void (async () => {
      try {
        for (let pendingEpoch = restartEpochs.take(); pendingEpoch; pendingEpoch = restartEpochs.take()) {
          try {
            await runBoundedRetry(async (attempt) => {
              setState("connectionDetail", `Refreshing state (${attempt}/3)`);
              // Hello is the protocol gate for every fresh process epoch. No
              // other RPC may race it on a newly restarted bridge.
              const hello = await bridge.hello();
              const auth = await bridge.getAuthState();
              const openChatIds = activeConversationIds(state.panes);
              // Finish every read from this attempt before retrying. This
              // prevents a slow, older pin response from overwriting a newer
              // attempt after Promise.all rejects early.
              const refreshes = await Promise.allSettled([
                loadChats(true, true, true),
                ...openChatIds.flatMap((chatId) => [
                  loadConversation(chatId, "", true),
                  loadPinnedMessages(chatId, true),
                ]),
              ]);
              const failed = refreshes.find(
                (result): result is PromiseRejectedResult => result.status === "rejected",
              );
              if (failed) throw failed.reason;
              batch(() => {
                setState("backendVersion", hello.backendVersion);
                setState("connection", auth.connectionState);
                setState("ownUserId", auth.ownUserId);
                setState("screen", pairingStartupDecision(auth).screen);
              });
            }, 3);
            batch(() => {
              setState("connectionDetail", "");
              setState("fatalError", "");
            });
            markBackendReady();
            toast(`Backend reconnected and refreshed (epoch ${pendingEpoch})`, "info");
          } catch (error) {
            const bridgeError = normalizeBridgeError(error);
            if (bridgeError.code !== "backend_epoch_changed") {
              batch(() => {
                setState("connection", ConnectionState.Reconnecting);
                setState("connectionDetail", "State refresh failed after 3 attempts");
              });
              toast(`Backend reconnected but refresh failed: ${bridgeError.message}`);
            }
          }
        }
      } finally {
        restartResyncing = false;
        // An epoch can be queued by a handler resumed in the same microtask as
        // the loop exits. Re-enter once so that edge cannot strand it.
        const trailingEpoch = restartEpochs.take();
        if (trailingEpoch) resyncAfterBackendRestart(trailingEpoch);
      }
    })();
  }

  function upsertMessage(message: Message, live: boolean) {
    const chatId = message.chatId;
    const conversationState = state.conversations[chatId];
    if (!conversationState) return; // The chat is not open in any pane.
    const existingIndex = conversationState.messages.findIndex((candidate) => candidate.id === message.id);
    const isNew = existingIndex < 0;
    // A full-state vote request may cross an older response/event in flight.
    // Keep the newest optimistic intent visible until its own command settles;
    // that command's generation guard then accepts only its authoritative DTO.
    if (existingIndex >= 0) message = preservePendingPollIntent(conversationState.messages[existingIndex]!, message, state.pendingPollVotes[`${chatId}:${message.id}`] ?? false);
    const merged = upsertSortedMessage(conversationState.messages, message, existingIndex);
    const trimmed = merged.length > MAX_ACTIVE_MESSAGES;
    setState("conversations", chatId, "messages", reconcile(trimMessages(merged, "older"), { key: "id" }));
    if (trimmed) setState("conversations", chatId, "hasOlder", true);
    if (live && isNew) {
      setState("conversations", chatId, "liveMessageVersion", (version) => version + 1);
      if (!message.fromMe && document.visibilityState === "visible" && isChatVisible(chatId)) {
        queueMicrotask(() => void markChatRead(chatId));
      }
    }
  }

  function updateMessage(chatId: string, id: string, update: (message: Message) => Message) {
    const messages = state.conversations[chatId]?.messages;
    if (!messages) return;
    const index = messages.findIndex((message) => message.id === id);
    if (index >= 0) setState("conversations", chatId, "messages", index, update(messages[index]!));
  }

  function applyReaction(reaction: Reaction, removed: boolean) {
    updateMessage(reaction.chatId, reaction.messageId, (message) => {
      const reactions = message.reactions.filter((item) => item.senderId !== reaction.senderId);
      if (!removed && reaction.emoji) reactions.push(reaction);
      reactions.sort((left, right) => left.timestampMs - right.timestampMs);
      return { ...message, reactions };
    });
  }

  function remapMessagesChatId(messages: readonly Message[], newId: string): Message[] {
    return messages.map((message) => (message.chatId === newId ? message : { ...message, chatId: newId }));
  }

  function mergeConversationsForChatMerge(
    oldConversation: ConversationState | undefined,
    newConversation: ConversationState | undefined,
    newId: string,
  ): ConversationState | undefined {
    if (!oldConversation && !newConversation) return undefined;
    const base = newConversation ?? emptyConversation(newId);
    const oldMessages = oldConversation ? remapMessagesChatId(oldConversation.messages, newId) : [];
    const messages = sortMessages(mergeMessages(base.messages, oldMessages));
    return { ...base, chatId: newId, messages };
  }

  function mergeChatId(oldId: string, newId: string) {
    const oldDraft = state.drafts[oldId];
    const oldChat = state.chats.find((chat) => chat.id === oldId);
    const newChat = state.chats.find((chat) => chat.id === newId);
    const chats = state.chats.filter((chat) => chat.id !== oldId && chat.id !== newId);
    if (oldChat || newChat) chats.push({ ...oldChat, ...newChat, id: newId } as Chat);

    const mergedConversation = mergeConversationsForChatMerge(
      state.conversations[oldId],
      state.conversations[newId],
      newId,
    );
    const remappedPanes = uniqueChatPanes(
      state.panes.map((pane) => remapPaneChatId(pane, oldId, newId)),
    );
    const oldTyping = state.typing[oldId];
    const currentTyping = state.typing[newId];
    const canonicalPins = (state.pinnedMessages[newId] ?? []).map((pin) => ({
      ...pin,
      message: pin.message ? { ...pin.message, chatId: newId } : null,
    }));
    const remainingPendingPollVotes = clearMergedPollVotes(state.pendingPollVotes, oldId);

    batch(() => {
      setState("chats", reconcile(sortChats(chats), { key: "id" }));
      if (mergedConversation) setState("conversations", newId, mergedConversation);
      setState("conversations", oldId, undefined!);
      setState("panes", reconcile(remappedPanes, { key: "id" }));
      if (oldDraft && !state.drafts[newId]) setState("drafts", newId, oldDraft);
      setState("drafts", oldId, undefined!);
      if (oldTyping) setState("typing", newId, { ...oldTyping, ...currentTyping });
      setState("typing", oldId, undefined!);
      setState("pinnedMessages", newId, canonicalPins);
      setState("pinnedMessages", oldId, undefined!);
      setState("pendingPollVotes", remainingPendingPollVotes);
      if (state.chatInfo?.chat?.id === oldId) setState("chatInfo", "chat", "id", newId);
      syncSelectedChatId();
    });

    conversationLastFocusedAt.set(
      newId,
      Math.max(conversationLastFocusedAt.get(oldId) ?? 0, conversationLastFocusedAt.get(newId) ?? 0),
    );
    conversationLastFocusedAt.delete(oldId);
    conversationGenerations.delete(oldId);
    for (const generations of [pollVoteGenerations, pinGenerations]) {
      for (const key of generations.keys()) {
        if (key.startsWith(`${oldId}\u0000`)) generations.delete(key);
      }
    }
    if (typingChatId === oldId) typingChatId = newId;
    const recent = readRecentChats().map((id) => (id === oldId ? newId : id));
    writeRecentChats([...new Set(recent)]);
    persistWorkspace();
    // Active pin lists omit unpin tombstones, so old and canonical lists must
    // never be merged locally. Hydrate the authoritative canonical set.
    void loadPinnedMessages(newId);
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

  function scheduleTyping(chatId: string, composing: boolean) {
    if (typingTimer !== undefined) window.clearTimeout(typingTimer);
    if (!chatId) return;
    if (typingChatId && typingChatId !== chatId) {
      void bridge.setTyping(typingChatId, false).catch(() => undefined);
    }
    typingChatId = composing ? chatId : "";
    void bridge.setTyping(chatId, composing).catch(() => undefined);
    if (composing) {
      typingTimer = window.setTimeout(() => {
        if (typingChatId === chatId) scheduleTyping(chatId, true);
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

  async function markChatRead(chatId: string) {
    const conversationState = state.conversations[chatId];
    const lastIncoming = conversationState ? [...conversationState.messages].reverse().find((message) => !message.fromMe) : undefined;
    if (!chatId || !lastIncoming) return;
    const previous = state.chats.find((chat) => chat.id === chatId)?.unreadCount ?? 0;
    const optimistic = optimisticUnreadCount(previous, conversationState!.hasNewer);
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

  function notifyError(error: unknown) {
    toast(normalizeBridgeError(error).message);
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

  function activeDraft(chatId = state.selectedChatId): Draft {
    return state.drafts[chatId] ?? emptyDraft();
  }

  return {
    state,
    preferences,
    prefActions,
    actions: {
      bootstrap,
      refreshPairing,
      loadChats,
      conversation,
      selectChat,
      closeChat,
      openInNewTab,
      closeTab,
      moveTab,
      announceTabAction,
      focusPane,
      splitPane,
      closePane,
      loadOlder,
      loadNewer,
      jumpToLatest,
      openSwitcher,
      cycleSwitcher,
      commitSwitcher,
      cancelSwitcher,
      updateSearch,
      clearSearch,
      openContact,
      openMessageResult,
      setDraftText,
      replyTo,
      replyPrivately,
      cancelReply,
      editMessage,
      cancelEdit,
      startForward,
      cancelForward,
      forwardMessage,
      addMention,
      sendCurrentText,
      createPoll,
      votePoll,
      setMessagePin,
      loadPinnedMessages,
      sendImage,
      sendSticker,
      sendAttachment,
      requestFileSend,
      confirmFileSend,
      cancelFileSend,
      hydrateImage,
      hydrateAttachment,
      openAttachment,
      loadAvatar,
      loadParticipantAvatar,
      loadStickers,
      sendStickerFromPack,
      saveMediaAs,
      revealMedia,
      openExternalLink,
      setNotificationsEnabled,
      showChatInfo,
      ensureMentionDirectory,
      hideChatInfo,
      react,
      openImage,
      closeImage,
      setFilter,
      toggleSettings,
      logout,
      stopTyping,
      typingLabel,
      filteredChats,
      selectedChat,
      notifyError,
      activeDraft,
      dismissToast,
      dispose,
      setLogoutConfirmation: (value: boolean) => setState("logoutConfirmation", value),
    },
  };
}

export type AppModel = ReturnType<typeof createAppModel>;
