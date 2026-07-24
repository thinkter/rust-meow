import type { Message } from "./types";

/**
 * Insertion-ordered set with a hard size ceiling. Re-adding a key refreshes
 * its recency, and the evicted key is returned so callers can prune any
 * parallel reactive state at the same time.
 */
export class BoundedSet<T> {
  private readonly values = new Set<T>();
  readonly capacity: number;

  constructor(capacity: number) {
    if (!Number.isInteger(capacity) || capacity < 1) {
      throw new RangeError("BoundedSet capacity must be a positive integer");
    }
    this.capacity = capacity;
  }

  get size(): number {
    return this.values.size;
  }

  has(value: T): boolean {
    return this.values.has(value);
  }

  add(value: T): T | undefined {
    this.values.delete(value);
    this.values.add(value);
    if (this.values.size <= this.capacity) return undefined;
    const oldest = this.values.values().next().value as T;
    this.values.delete(oldest);
    return oldest;
  }

  delete(value: T): boolean {
    return this.values.delete(value);
  }

  clear(): void {
    this.values.clear();
  }
}

export interface MessageIndex {
  readonly byId: ReadonlyMap<string, Message>;
  readonly replyCountById: ReadonlyMap<string, number>;
  readonly firstReplyIdById: ReadonlyMap<string, string>;
}

export interface BoundedWindow<T> {
  readonly items: T[];
  readonly droppedBefore: boolean;
  readonly droppedAfter: boolean;
}

/**
 * Keep a bounded slice around an important row. Canonical conversation
 * refetches use this instead of blindly retaining every previously visited
 * search/pin window, while still guaranteeing that the requested anchor is
 * present after trimming.
 */
export function boundWindowAround<T>(
  items: readonly T[],
  capacity: number,
  anchorIndex: number,
): BoundedWindow<T> {
  if (!Number.isInteger(capacity) || capacity < 1) {
    throw new RangeError("window capacity must be a positive integer");
  }
  if (items.length <= capacity) {
    return { items: [...items], droppedBefore: false, droppedAfter: false };
  }

  const anchor = Math.max(0, Math.min(anchorIndex, items.length - 1));
  const preferredStart = anchor - Math.floor(capacity / 2);
  const start = Math.max(0, Math.min(preferredStart, items.length - capacity));
  const end = start + capacity;
  return {
    items: items.slice(start, end),
    droppedBefore: start > 0,
    droppedAfter: end < items.length,
  };
}

/**
 * Build all reply/quote lookups in one linear pass per message-window update.
 * Visible bubbles can then render in O(1) instead of each scanning as many as
 * 2,000 loaded messages for a quote, a reply count, and a first reply.
 */
export function indexMessages(messages: readonly Message[]): MessageIndex {
  const byId = new Map<string, Message>();
  const replyCountById = new Map<string, number>();
  const firstReplyIdById = new Map<string, string>();

  for (const message of messages) {
    byId.set(message.id, message);
    if (!message.replyToMessageId) continue;
    // A private reply quotes a message from its source group, not another
    // message in the direct conversation currently being indexed.
    if (message.replyToChatId && message.replyToChatId !== message.chatId) continue;
    replyCountById.set(
      message.replyToMessageId,
      (replyCountById.get(message.replyToMessageId) ?? 0) + 1,
    );
    if (!firstReplyIdById.has(message.replyToMessageId)) {
      firstReplyIdById.set(message.replyToMessageId, message.id);
    }
  }

  return { byId, replyCountById, firstReplyIdById };
}
