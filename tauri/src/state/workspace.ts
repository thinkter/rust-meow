/**
 * Pure pane, tab-strip, and chat-switcher list manipulation.
 *
 * Everything here is a plain function over plain data — no Solid store, no
 * bridge, no timers — so the tricky ordering rules (which neighbour a closed
 * tab activates, where a dragged tab lands, how the switcher picks its first
 * highlight) can be unit tested without booting the app model. `state/app.ts`
 * is the only caller; it owns the Solid store these functions read from and
 * write back into.
 */

export interface Pane {
  /** Stable identifier, currently always "pane-1" or "pane-2". */
  id: string;
  /** Tab order within the pane. */
  tabChatIds: string[];
  /** Which tab is showing; empty when the pane has no tabs. */
  activeChatId: string;
}

export interface Switcher {
  chatIds: string[];
  highlighted: number;
}

/** Session history caps at this many chats, matching the GPUI reference app. */
export const MAX_RECENT_CHATS = 10;

const WORKSPACE_STORAGE_KEY = "rust-meow-workspace";

export function emptyPane(id: string): Pane {
  return { id, tabChatIds: [], activeChatId: "" };
}

/** A chat owns one pane-local viewport. Keeping it unique across panes avoids
 * one exact-message navigation replacing another pane's shared message window. */
export function paneContainingChat(panes: readonly Pane[], chatId: string): Pane | undefined {
  return panes.find((pane) => pane.tabChatIds.includes(chatId));
}

/** Repair legacy or merged workspaces so one chat cannot drive two independent
 * pane viewports through one shared conversation window. First pane wins. */
export function uniqueChatPanes(panes: readonly Pane[]): Pane[] {
  const seenChats = new Set<string>();
  return panes.map((pane) => {
    const tabChatIds = pane.tabChatIds.filter((chatId) => {
      if (seenChats.has(chatId)) return false;
      seenChats.add(chatId);
      return true;
    });
    const activeChatId = tabChatIds.includes(pane.activeChatId)
      ? pane.activeChatId
      : (tabChatIds[0] ?? "");
    return { ...pane, tabChatIds, activeChatId };
  });
}

/**
 * Load a chat into a pane's currently active tab slot. A chat already open
 * somewhere in this pane is merely focused, matching browser tab behaviour;
 * otherwise the active slot is replaced in place so that clicking through a
 * chat list does not pile up tabs the way deliberately opening a new tab
 * (`openTab`) does.
 */
export function selectTab(pane: Pane, chatId: string): Pane {
  if (pane.tabChatIds.includes(chatId)) {
    return { ...pane, activeChatId: chatId };
  }
  const activeIndex = pane.tabChatIds.indexOf(pane.activeChatId);
  if (activeIndex < 0) {
    return { ...pane, tabChatIds: [...pane.tabChatIds, chatId], activeChatId: chatId };
  }
  const tabChatIds = [...pane.tabChatIds];
  tabChatIds[activeIndex] = chatId;
  return { ...pane, tabChatIds, activeChatId: chatId };
}

/** Open a chat as its own tab: focuses an existing tab rather than duplicating it. */
export function openTab(pane: Pane, chatId: string): Pane {
  if (pane.tabChatIds.includes(chatId)) {
    return { ...pane, activeChatId: chatId };
  }
  return { ...pane, tabChatIds: [...pane.tabChatIds, chatId], activeChatId: chatId };
}

/**
 * Close a tab. When the closed tab was active, the neighbour to its right
 * takes over, or failing that the neighbour to its left — ordinary browser
 * tab-strip behaviour. An empty `activeChatId` means the pane now has no tabs.
 */
export function closeTab(pane: Pane, chatId: string): Pane {
  const index = pane.tabChatIds.indexOf(chatId);
  if (index < 0) return pane;
  const tabChatIds = pane.tabChatIds.filter((id) => id !== chatId);
  if (pane.activeChatId !== chatId) return { ...pane, tabChatIds };
  const neighbour = tabChatIds[index] ?? tabChatIds[index - 1] ?? "";
  return { ...pane, tabChatIds, activeChatId: neighbour };
}

/** Insert (or relocate) a tab at a specific index, then activate it. */
function placeTab(pane: Pane, chatId: string, index: number): Pane {
  const withoutChat = pane.tabChatIds.filter((id) => id !== chatId);
  const clamped = Math.max(0, Math.min(index, withoutChat.length));
  withoutChat.splice(clamped, 0, chatId);
  return { ...pane, tabChatIds: withoutChat, activeChatId: chatId };
}

/**
 * Move a tab between panes (or reorder it within the same pane) to a target
 * index. Operates over the whole pane list because a cross-pane move touches
 * two panes at once; panes not involved pass through unchanged.
 */
export function moveTabBetweenPanes(
  panes: readonly Pane[],
  chatId: string,
  fromPaneId: string,
  toPaneId: string,
  index: number,
): Pane[] {
  if (fromPaneId === toPaneId) {
    return panes.map((pane) => (pane.id === fromPaneId ? placeTab(pane, chatId, index) : pane));
  }
  return panes.map((pane) => {
    if (pane.id === fromPaneId) return closeTab(pane, chatId);
    if (pane.id === toPaneId) return placeTab(pane, chatId, index);
    return pane;
  });
}

/** Convert a DOM drop boundary into the insertion index after removing the dragged tab. */
export function samePaneDropIndex(
  tabChatIds: readonly string[],
  chatId: string,
  dropBoundary: number,
): number {
  const sourceIndex = tabChatIds.indexOf(chatId);
  return sourceIndex >= 0 && sourceIndex < dropBoundary ? dropBoundary - 1 : dropBoundary;
}

export interface CloseTabResult {
  panes: Pane[];
  /** Set when closing the tab emptied its pane and that pane was removed. */
  removedPaneId: string | null;
}

/**
 * Close a tab within a specific pane and, per the redesign contract, drop
 * that pane entirely when it was the last tab and another pane still exists —
 * a lone empty pane is kept (it renders the empty-conversation screen)
 * because the workspace must never drop to zero panes.
 */
export function closeTabInWorkspace(panes: readonly Pane[], chatId: string, paneId: string): CloseTabResult {
  const paneIndex = panes.findIndex((pane) => pane.id === paneId);
  if (paneIndex < 0) return { panes: [...panes], removedPaneId: null };
  const pane = panes[paneIndex]!;
  if (!pane.tabChatIds.includes(chatId)) return { panes: [...panes], removedPaneId: null };
  const closed = closeTab(pane, chatId);
  if (closed.tabChatIds.length === 0 && panes.length > 1) {
    return { panes: panes.filter((candidate) => candidate.id !== paneId), removedPaneId: paneId };
  }
  return {
    panes: panes.map((candidate) => (candidate.id === paneId ? closed : candidate)),
    removedPaneId: null,
  };
}

/** Remap a chat id inside one pane's tabs, used when the backend merges two chat ids. */
export function remapPaneChatId(pane: Pane, oldId: string, newId: string): Pane {
  if (!pane.tabChatIds.includes(oldId)) return pane;
  const hasNew = pane.tabChatIds.includes(newId);
  const tabChatIds = hasNew
    ? pane.tabChatIds.filter((id) => id !== oldId)
    : pane.tabChatIds.map((id) => (id === oldId ? newId : id));
  const activeChatId = pane.activeChatId === oldId ? newId : pane.activeChatId;
  return { ...pane, tabChatIds, activeChatId };
}

/**
 * Session-recency candidates for the Ctrl+Tab switcher, matching the GPUI
 * desktop app's `recent_chat_candidates`: seed from the visible (already
 * recency-ordered) chat list until enough session history has accumulated,
 * then guarantee the active chat leads the list.
 */
export function recentChatCandidates(
  recentChatIds: readonly string[],
  chatExists: (chatId: string) => boolean,
  visibleChatIds: readonly string[],
  selectedChatId: string,
): string[] {
  let candidates = recentChatIds.filter((id) => chatExists(id));
  if (candidates.length < 2) {
    for (const chatId of visibleChatIds) {
      if (!candidates.includes(chatId)) candidates.push(chatId);
      if (candidates.length >= MAX_RECENT_CHATS) break;
    }
  }
  if (selectedChatId) {
    const index = candidates.indexOf(selectedChatId);
    if (index >= 0) {
      // Swap into the lead position (rather than remove-and-reinsert) to
      // match the GPUI reference implementation exactly.
      const swapped = [...candidates];
      [swapped[0], swapped[index]] = [swapped[index]!, swapped[0]!];
      candidates = swapped;
    } else if (chatExists(selectedChatId)) {
      candidates = [selectedChatId, ...candidates];
    }
  }
  return candidates.slice(0, MAX_RECENT_CHATS);
}

/**
 * Build the switcher's initial state, or `undefined` when there is nothing to
 * switch to. Initial highlight: reverse selects the last candidate; forward
 * selects index 1 when the active chat already leads the list (skipping past
 * it), otherwise index 0.
 */
export function openSwitcher(
  candidateChatIds: readonly string[],
  reverse: boolean,
  selectedIsFirst: boolean,
): Switcher | undefined {
  if (candidateChatIds.length < 2) return undefined;
  const highlighted = reverse ? candidateChatIds.length - 1 : selectedIsFirst ? 1 : 0;
  return { chatIds: [...candidateChatIds], highlighted };
}

/** Move the switcher's highlight only; it never changes which chat is open. */
export function cycleSwitcher(switcher: Switcher, reverse: boolean): Switcher {
  const length = switcher.chatIds.length;
  if (length === 0) return switcher;
  const highlighted = reverse
    ? (switcher.highlighted - 1 + length) % length
    : (switcher.highlighted + 1) % length;
  return { ...switcher, highlighted };
}

/**
 * Choose which hydrated conversations to drop after a pane/tab mutation:
 * first anything no longer open in any pane's tab list, then — once the
 * survivors still exceed the cap — the least recently focused of the rest.
 */
export function conversationsToEvict(
  hydratedChatIds: readonly string[],
  openChatIds: ReadonlySet<string>,
  lastFocusedAt: ReadonlyMap<string, number>,
  maxHydrated: number,
  protectedChatIds: ReadonlySet<string> = new Set(),
): string[] {
  const evicted: string[] = [];
  const survivors: string[] = [];
  for (const chatId of hydratedChatIds) {
    if (openChatIds.has(chatId)) survivors.push(chatId);
    else evicted.push(chatId);
  }
  if (survivors.length > maxHydrated) {
    const ordered = survivors.filter((chatId) => !protectedChatIds.has(chatId)).sort(
      (left, right) => (lastFocusedAt.get(left) ?? 0) - (lastFocusedAt.get(right) ?? 0),
    );
    evicted.push(...ordered.slice(0, Math.max(0, survivors.length - maxHydrated)));
  }
  return evicted;
}

export interface WorkspaceSnapshot {
  panes: Pane[];
  focusedPaneId: string;
}

function normalizePane(value: unknown): Pane | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const candidate = value as { id?: unknown; tabChatIds?: unknown; activeChatId?: unknown };
  if (typeof candidate.id !== "string" || !candidate.id) return undefined;
  if (!Array.isArray(candidate.tabChatIds)) return undefined;
  const tabChatIds = [
    ...new Set(candidate.tabChatIds.filter((id): id is string => typeof id === "string" && id.length > 0)),
  ];
  const activeChatId =
    typeof candidate.activeChatId === "string" && tabChatIds.includes(candidate.activeChatId)
      ? candidate.activeChatId
      : (tabChatIds[0] ?? "");
  return { id: candidate.id, tabChatIds, activeChatId };
}

/**
 * Validate an untrusted parsed value read back from `sessionStorage` into a
 * usable workspace snapshot, or `undefined` when it cannot be trusted. Never
 * assume the shape survived a hand edit, an old app version, or storage
 * shared between tabs.
 */
export function normalizeWorkspaceSnapshot(value: unknown): WorkspaceSnapshot | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const candidate = value as { panes?: unknown; focusedPaneId?: unknown };
  if (!Array.isArray(candidate.panes) || candidate.panes.length === 0 || candidate.panes.length > 2) {
    return undefined;
  }
  const panes: Pane[] = [];
  const seenIds = new Set<string>();
  for (const rawPane of candidate.panes) {
    const pane = normalizePane(rawPane);
    if (!pane || seenIds.has(pane.id)) return undefined;
    seenIds.add(pane.id);
    panes.push(pane);
  }
  const uniquePanes = uniqueChatPanes(panes);
  const focusedPaneId =
    typeof candidate.focusedPaneId === "string" && uniquePanes.some((pane) => pane.id === candidate.focusedPaneId)
      ? candidate.focusedPaneId
      : uniquePanes[0]!.id;
  return { panes: uniquePanes, focusedPaneId };
}

export function readWorkspaceSnapshot(): WorkspaceSnapshot | undefined {
  try {
    const raw = sessionStorage.getItem(WORKSPACE_STORAGE_KEY);
    if (!raw) return undefined;
    const parsed: unknown = JSON.parse(raw);
    return normalizeWorkspaceSnapshot(parsed);
  } catch {
    return undefined;
  }
}

export function writeWorkspaceSnapshot(snapshot: WorkspaceSnapshot) {
  try {
    sessionStorage.setItem(WORKSPACE_STORAGE_KEY, JSON.stringify(snapshot));
  } catch {
    // A full or disabled session store must not break the running session.
  }
}
