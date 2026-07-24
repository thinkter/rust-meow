import type { Chat, Message } from "../lib/types";
import type { Draft, Mention } from "./app";

export const MAX_ACTIVE_MESSAGES = 2_000;

export function sortChats(chats: Chat[]): Chat[] {
  return [...chats].sort(
    (left, right) =>
      Number(right.pinned) - Number(left.pinned) ||
      right.lastMessageTimestampMs - left.lastMessageTimestampMs ||
      left.id.localeCompare(right.id),
  );
}

export function mergeChats(existing: readonly Chat[], incoming: readonly Chat[]): Chat[] {
  const byId = new Map(existing.map((chat) => [chat.id, chat]));
  for (const chat of incoming) byId.set(chat.id, { ...byId.get(chat.id), ...chat });
  return [...byId.values()];
}

export function sortMessages(messages: readonly Message[]): Message[] {
  return [...messages].sort(compareMessages);
}

export function cloneDraft(draft: Draft): Draft {
  return {
    text: draft.text,
    replyToMessageId: draft.replyToMessageId,
    replyToChatId: draft.replyToChatId,
    replyPreviewText: draft.replyPreviewText,
    replySenderName: draft.replySenderName,
    editingMessageId: draft.editingMessageId,
    mentions: draft.mentions.map((mention) => ({ ...mention })),
  };
}

export function draftIsEmpty(draft: Draft | undefined): boolean {
  return Boolean(
    draft &&
      draft.text === "" &&
      draft.replyToMessageId === "" &&
      draft.replyToChatId === "" &&
      draft.replyPreviewText === "" &&
      draft.replySenderName === "" &&
      draft.editingMessageId === "" &&
      draft.mentions.length === 0,
  );
}

export function mergeMessages(
  existing: readonly Message[],
  incoming: readonly Message[],
): Message[] {
  const byId = new Map(existing.map((message) => [message.id, message]));
  for (const message of incoming) {
    byId.set(message.id, preserveLocalMedia(message, byId.get(message.id)));
  }
  return sortMessages([...byId.values()]);
}

function preserveLocalMedia(message: Message, previous: Message | undefined): Message {
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

/** Fast path for the common one-message live event: O(n) copy/insertion and
 * no temporary n-entry Map or O(n log n) full-window sort. */
export function upsertSortedMessage(
  existing: readonly Message[],
  incoming: Message,
  existingIndex = existing.findIndex((message) => message.id === incoming.id),
): Message[] {
  const message = preserveLocalMedia(
    incoming,
    existingIndex >= 0 ? existing[existingIndex] : undefined,
  );
  if (existingIndex >= 0) {
    const next = [...existing];
    next[existingIndex] = message;
    const previous = next[existingIndex - 1];
    const following = next[existingIndex + 1];
    if (
      (previous && compareMessages(previous, message) > 0) ||
      (following && compareMessages(message, following) > 0)
    ) {
      next.sort(compareMessages);
    }
    return next;
  }

  if (existing.length === 0 || compareMessages(existing[existing.length - 1]!, message) <= 0) {
    return [...existing, message];
  }

  let low = 0;
  let high = existing.length;
  while (low < high) {
    const middle = (low + high) >>> 1;
    if (compareMessages(existing[middle]!, message) <= 0) low = middle + 1;
    else high = middle;
  }
  return [...existing.slice(0, low), message, ...existing.slice(low)];
}

function compareMessages(left: Message, right: Message): number {
  return left.timestampMs - right.timestampMs || left.id.localeCompare(right.id);
}

export function trimMessages(messages: Message[], drop: "older" | "newer"): Message[] {
  if (messages.length <= MAX_ACTIVE_MESSAGES) return messages;
  return drop === "older"
    ? messages.slice(messages.length - MAX_ACTIVE_MESSAGES)
    : messages.slice(0, MAX_ACTIVE_MESSAGES);
}

export function encodeMentions(text: string, mentions: readonly Mention[]) {
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

export function mediaKey(chatId: string, messageId: string): string {
  return `${chatId}\u0000${messageId}`;
}

export function rememberRecentChat(chatId: string) {
  writeRecentChats([chatId, ...readRecentChats().filter((id) => id !== chatId)].slice(0, 10));
}

export function readRecentChats(): string[] {
  try {
    const value: unknown = JSON.parse(sessionStorage.getItem("rust-meow-recent") ?? "[]");
    return Array.isArray(value) ? value.filter((id): id is string => typeof id === "string") : [];
  } catch {
    return [];
  }
}

export function writeRecentChats(ids: string[]) {
  sessionStorage.setItem("rust-meow-recent", JSON.stringify(ids));
}
