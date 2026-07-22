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
