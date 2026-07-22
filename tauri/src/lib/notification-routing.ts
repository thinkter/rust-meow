export interface NotificationTarget {
  chatId: string;
  messageId: string;
}

export type NotificationTargetAvailability = "available" | "missing-chat" | "missing-message";

export function notificationTargetAvailability(
  chatExists: boolean,
  messageExists: boolean,
): NotificationTargetAvailability {
  if (!chatExists) return "missing-chat";
  return messageExists ? "available" : "missing-message";
}

const MAX_PENDING_ACTIVATIONS = 32;
const MAX_DELIVERED_ACTIVATIONS = 256;

function normalizedTarget(value: unknown): NotificationTarget | undefined {
  if (!value || typeof value !== "object") return undefined;
  const { chatId, messageId } = value as Partial<NotificationTarget>;
  if (typeof chatId !== "string" || typeof messageId !== "string") return undefined;
  const normalized = { chatId: chatId.trim(), messageId: messageId.trim() };
  if (!normalized.chatId || !normalized.messageId) return undefined;
  return normalized;
}

function targetKey(target: NotificationTarget): string {
  return JSON.stringify([target.chatId, target.messageId]);
}

/**
 * Serializes notification activation while app bootstrap is still loading.
 * Platform services can deliver the same activation through both a native
 * event and the cold-start drain, so completed targets are bounded and
 * deduplicated as well.
 */
export class NotificationActivationQueue {
  private ready = false;
  private pending = new Map<string, NotificationTarget>();
  private delivered = new Map<string, true>();
  private aliases = new Map<string, string>();
  private draining: Promise<void> | undefined;
  private readonly route: (target: NotificationTarget) => void | Promise<void>;

  constructor(route: (target: NotificationTarget) => void | Promise<void>) {
    this.route = route;
  }

  enqueue(value: unknown): boolean {
    const parsed = normalizedTarget(value);
    if (!parsed) return false;
    const target = this.canonicalize(parsed);
    const key = targetKey(target);
    if (this.pending.has(key) || this.delivered.has(key)) return false;
    while (this.pending.size >= MAX_PENDING_ACTIVATIONS) {
      const oldest = this.pending.keys().next().value;
      if (oldest === undefined) break;
      this.pending.delete(oldest);
    }
    this.pending.set(key, target);
    this.scheduleDrain();
    return true;
  }

  markReady(): void {
    this.ready = true;
    this.scheduleDrain();
  }

  /** Keep pre-bootstrap clicks valid when WhatsApp reports a JID merge. */
  mergeChatId(oldChatId: string, newChatId: string): void {
    if (!oldChatId || !newChatId || oldChatId === newChatId) return;
    this.aliases.set(oldChatId, this.resolveChatId(newChatId));
    const delivered = new Map<string, true>();
    for (const key of this.delivered.keys()) {
      const parsed = JSON.parse(key) as [string, string];
      delivered.set(targetKey(this.canonicalize({ chatId: parsed[0], messageId: parsed[1] })), true);
    }
    this.delivered = delivered;
    this.rekey(this.pending);
  }

  async flush(): Promise<void> {
    while (this.draining) await this.draining;
    if (this.ready && this.pending.size > 0) {
      this.scheduleDrain();
      if (this.draining) await this.draining;
    }
  }

  private resolveChatId(chatId: string): string {
    const visited = new Set<string>();
    let current = chatId;
    while (this.aliases.has(current) && !visited.has(current)) {
      visited.add(current);
      current = this.aliases.get(current)!;
    }
    return current;
  }

  private canonicalize(target: NotificationTarget): NotificationTarget {
    return { ...target, chatId: this.resolveChatId(target.chatId) };
  }

  private rekey(targets: Map<string, NotificationTarget>): void {
    const remapped = new Map<string, NotificationTarget>();
    for (const target of targets.values()) {
      const canonical = this.canonicalize(target);
      const key = targetKey(canonical);
      if (!this.delivered.has(key)) remapped.set(key, canonical);
    }
    this.pending = remapped;
  }

  private scheduleDrain(): void {
    if (!this.ready || this.draining || this.pending.size === 0) return;
    this.draining = this.drain().finally(() => {
      this.draining = undefined;
      this.scheduleDrain();
    });
  }

  private async drain(): Promise<void> {
    while (this.ready && this.pending.size > 0) {
      const [key, target] = this.pending.entries().next().value as [string, NotificationTarget];
      this.pending.delete(key);
      this.delivered.set(key, true);
      while (this.delivered.size > MAX_DELIVERED_ACTIVATIONS) {
        const oldest = this.delivered.keys().next().value;
        if (oldest === undefined) break;
        this.delivered.delete(oldest);
      }
      try {
        await this.route(target);
      } catch (error) {
        // One stale OS activation must not block later clicks in the queue.
        console.warn("Could not route notification activation", error);
      }
    }
  }
}

/** Cache denial for the session; only an explicit settings action may retry. */
export class NotificationPermissionGate {
  private decision: Promise<boolean> | undefined;

  check(read: () => Promise<boolean>, refresh = false): Promise<boolean> {
    if (refresh) this.decision = undefined;
    this.decision ??= read().catch(() => false);
    return this.decision;
  }
}
