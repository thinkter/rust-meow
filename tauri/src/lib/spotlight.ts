import type { Chat } from "./types";

const STORAGE_KEY = "rust-meow-spotlight-affinity-v1";
const MAX_TRACKED_CHATS = 250;
const MAX_OPEN_COUNT = 10_000;
const DAY_MS = 86_400_000;
const DIRECT_CHAT_KIND = 1;

export interface SpotlightChatUsage {
  opens: number;
  lastOpenedAt: number;
}

export type SpotlightUsage = Record<string, SpotlightChatUsage>;

export interface SpotlightChatMatch {
  chat: Chat;
  score: number;
  usage: SpotlightChatUsage | undefined;
}

/**
 * Rank already-loaded chats for the instant portion of Spotlight.
 *
 * Text relevance dominates while a query is present. Within equally relevant
 * matches, chats the user opens repeatedly rank ahead of merely recent ones.
 * With an empty query the same affinity score becomes the primary ordering, so
 * the launcher opens with useful people instead of an arbitrary alphabetical
 * list.
 */
export function rankSpotlightChats(
  chats: readonly Chat[],
  query: string,
  usage: SpotlightUsage,
  now = Date.now(),
  limit = 12,
): SpotlightChatMatch[] {
  if (!Number.isInteger(limit) || limit <= 0) return [];
  const normalizedQuery = normalize(query.trim());
  const terms = normalizedQuery.split(/\s+/).filter(Boolean);

  return chats
    .filter((chat) => !chat.archived)
    .map((chat): SpotlightChatMatch | null => {
      const textScore = spotlightTextScore(chat, normalizedQuery, terms);
      if (normalizedQuery && textScore < 0) return null;
      const chatUsage: SpotlightChatUsage | undefined = usage[chat.id];
      return {
        chat,
        usage: chatUsage,
        score: textScore * 10_000 + affinityScore(chat, chatUsage, now),
      };
    })
    .filter((match): match is SpotlightChatMatch => match !== null)
    .sort(
      (left, right) =>
        right.score - left.score ||
        right.chat.lastMessageTimestampMs - left.chat.lastMessageTimestampMs ||
        left.chat.id.localeCompare(right.chat.id),
    )
    .slice(0, limit);
}

export function readSpotlightUsage(storage = browserStorage()): SpotlightUsage {
  if (!storage) return {};
  try {
    const parsed: unknown = JSON.parse(storage.getItem(STORAGE_KEY) ?? "{}");
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    const usage: SpotlightUsage = {};
    for (const [chatId, value] of Object.entries(parsed)) {
      if (!chatId || !value || typeof value !== "object" || Array.isArray(value)) continue;
      const candidate = value as Partial<SpotlightChatUsage>;
      if (
        typeof candidate.opens !== "number" ||
        !Number.isFinite(candidate.opens) ||
        typeof candidate.lastOpenedAt !== "number" ||
        !Number.isFinite(candidate.lastOpenedAt)
      ) {
        continue;
      }
      usage[chatId] = {
        opens: Math.max(0, Math.min(MAX_OPEN_COUNT, Math.floor(candidate.opens))),
        lastOpenedAt: Math.max(0, candidate.lastOpenedAt),
      };
    }
    return usage;
  } catch {
    return {};
  }
}

export function recordSpotlightChatUse(
  chatId: string,
  now = Date.now(),
  storage = browserStorage(),
): void {
  if (!chatId || !storage) return;
  const usage = readSpotlightUsage(storage);
  const previous = usage[chatId];
  usage[chatId] = {
    opens: Math.min(MAX_OPEN_COUNT, (previous?.opens ?? 0) + 1),
    lastOpenedAt: now,
  };
  writeSpotlightUsage(trimUsage(usage), storage);
}

export function mergeSpotlightChatUsage(
  oldId: string,
  newId: string,
  storage = browserStorage(),
): void {
  if (!oldId || !newId || oldId === newId || !storage) return;
  const usage = readSpotlightUsage(storage);
  const oldUsage = usage[oldId];
  if (!oldUsage) return;
  const newUsage = usage[newId];
  usage[newId] = {
    opens: Math.min(MAX_OPEN_COUNT, oldUsage.opens + (newUsage?.opens ?? 0)),
    lastOpenedAt: Math.max(oldUsage.lastOpenedAt, newUsage?.lastOpenedAt ?? 0),
  };
  delete usage[oldId];
  writeSpotlightUsage(trimUsage(usage), storage);
}

function spotlightTextScore(chat: Chat, query: string, terms: readonly string[]): number {
  if (!query) return 0;
  const title = normalize(chat.title || chat.phoneNumber);
  const aliases = [chat.contactName, chat.pushName, chat.businessName, chat.phoneNumber]
    .map(normalize)
    .filter(Boolean);
  const fields = [title, ...aliases];
  if (!terms.every((term) => fields.some((field) => field.includes(term)))) return -1;

  if (title === query) return 1_000;
  if (title.startsWith(query)) return 900;
  if (title.split(/\s+/).some((word) => word.startsWith(query))) return 825;
  if (title.includes(query)) return 750;
  if (aliases.some((field) => field === query)) return 700;
  if (aliases.some((field) => field.startsWith(query))) return 650;
  if (aliases.some((field) => field.includes(query))) return 600;
  return 500;
}

function affinityScore(
  chat: Chat,
  usage: SpotlightChatUsage | undefined,
  now: number,
): number {
  const opens = Math.max(0, usage?.opens ?? 0);
  const frequency = Math.min(620, Math.log2(opens + 1) * 175);
  const openedAgeDays = Math.max(0, now - (usage?.lastOpenedAt ?? 0)) / DAY_MS;
  const openedRecency = usage ? Math.max(0, 280 - openedAgeDays * 12) : 0;
  const activityAgeDays = Math.max(0, now - chat.lastMessageTimestampMs) / DAY_MS;
  const activityRecency = chat.lastMessageTimestampMs
    ? Math.max(0, 180 - activityAgeDays * 5)
    : 0;
  const directBonus = chat.kind === DIRECT_CHAT_KIND ? 35 : 0;
  const pinnedBonus = chat.pinned ? 65 : 0;
  return frequency + openedRecency + activityRecency + directBonus + pinnedBonus;
}

function normalize(value: string): string {
  return value
    .normalize("NFKD")
    .replace(/\p{Diacritic}/gu, "")
    .toLocaleLowerCase()
    .trim();
}

function trimUsage(usage: SpotlightUsage): SpotlightUsage {
  return Object.fromEntries(
    Object.entries(usage)
      .sort(([, left], [, right]) => right.lastOpenedAt - left.lastOpenedAt)
      .slice(0, MAX_TRACKED_CHATS),
  );
}

function writeSpotlightUsage(usage: SpotlightUsage, storage: Storage): void {
  try {
    storage.setItem(STORAGE_KEY, JSON.stringify(usage));
  } catch {
    // Affinity is an optional convenience. Private-mode quota failures must
    // never prevent opening a conversation.
  }
}

function browserStorage(): Storage | null {
  try {
    return typeof localStorage === "undefined" ? null : localStorage;
  } catch {
    return null;
  }
}
