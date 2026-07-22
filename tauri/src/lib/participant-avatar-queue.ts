type QueueStatus = "queued" | "running" | "backoff";

interface QueueEntry {
  participantId: string;
  status: QueueStatus;
  attempts: number;
  subscribers: Map<number, string>;
  retryTimer?: ReturnType<typeof setTimeout>;
}

export interface ParticipantAvatarQueueOptions {
  fetchAvatar: (participantId: string) => Promise<string>;
  onHydrated: (participantId: string, avatarPath: string) => void;
  concurrency?: number;
  maxQueued?: number;
  maxAttempts?: number;
  retryBaseMs?: number;
}

export function isRetryableAvatarError(error: unknown): boolean {
  const normalized = avatarErrorShape(error);
  if (!normalized?.retryable) return false;
  if (normalized.code === "busy" || normalized.code === "timeout") return true;
  return normalized.code === "transport" && /timed?\s*out|timeout/i.test(normalized.message);
}

/**
 * Visibility-driven, bounded scheduler shared by every participant roster.
 * Running Tauri invokes cannot be aborted, but cancellation removes their
 * subscribers so late results and retries are ignored.
 */
export class ParticipantAvatarQueue {
  readonly #fetchAvatar: ParticipantAvatarQueueOptions["fetchAvatar"];
  readonly #onHydrated: ParticipantAvatarQueueOptions["onHydrated"];
  readonly #concurrency: number;
  readonly #maxQueued: number;
  readonly #maxAttempts: number;
  readonly #retryBaseMs: number;
  readonly #entries = new Map<string, QueueEntry>();
  readonly #queued: QueueEntry[] = [];
  readonly #terminalFailures = new Set<string>();
  #nextSubscriberId = 1;
  #running = 0;

  constructor(options: ParticipantAvatarQueueOptions) {
    this.#fetchAvatar = options.fetchAvatar;
    this.#onHydrated = options.onHydrated;
    this.#concurrency = positiveInteger(options.concurrency ?? 4, "concurrency");
    this.#maxQueued = positiveInteger(options.maxQueued ?? 128, "maxQueued");
    this.#maxAttempts = positiveInteger(options.maxAttempts ?? 4, "maxAttempts");
    this.#retryBaseMs = Math.max(0, options.retryBaseMs ?? 250);
  }

  subscribe(participantId: string, scopeId: string): () => void {
    if (!participantId || !scopeId || this.#terminalFailures.has(participantId)) return () => undefined;
    let entry = this.#entries.get(participantId);
    if (!entry) {
      if (this.#entries.size >= this.#maxQueued + this.#concurrency) return () => undefined;
      entry = { participantId, status: "queued", attempts: 0, subscribers: new Map() };
      this.#entries.set(participantId, entry);
      this.#queued.push(entry);
    }
    const subscriberId = this.#nextSubscriberId++;
    entry.subscribers.set(subscriberId, scopeId);
    this.#pump();
    return () => this.#unsubscribe(participantId, subscriberId);
  }

  cancelScope(scopeId: string) {
    for (const entry of this.#entries.values()) {
      for (const [subscriberId, subscribedScope] of entry.subscribers) {
        if (subscribedScope === scopeId) entry.subscribers.delete(subscriberId);
      }
      this.#discardIfUnobserved(entry);
    }
  }

  clear() {
    for (const entry of this.#entries.values()) {
      if (entry.retryTimer) clearTimeout(entry.retryTimer);
      entry.subscribers.clear();
    }
    this.#entries.clear();
    this.#queued.length = 0;
    this.#terminalFailures.clear();
  }

  stats() {
    let backoff = 0;
    for (const entry of this.#entries.values()) if (entry.status === "backoff") backoff += 1;
    return {
      running: this.#running,
      queued: this.#queued.filter((entry) => this.#entries.get(entry.participantId) === entry).length,
      backoff,
      tracked: this.#entries.size,
      terminalFailures: this.#terminalFailures.size,
    };
  }

  #unsubscribe(participantId: string, subscriberId: number) {
    const entry = this.#entries.get(participantId);
    if (!entry) return;
    entry.subscribers.delete(subscriberId);
    this.#discardIfUnobserved(entry);
  }

  #discardIfUnobserved(entry: QueueEntry) {
    if (entry.subscribers.size > 0 || entry.status === "running") return;
    if (entry.retryTimer) clearTimeout(entry.retryTimer);
    this.#entries.delete(entry.participantId);
    const queuedIndex = this.#queued.indexOf(entry);
    if (queuedIndex >= 0) this.#queued.splice(queuedIndex, 1);
  }

  #pump() {
    while (this.#running < this.#concurrency && this.#queued.length > 0) {
      const entry = this.#queued.shift()!;
      if (this.#entries.get(entry.participantId) !== entry || entry.subscribers.size === 0) continue;
      entry.status = "running";
      entry.attempts += 1;
      this.#running += 1;
      void this.#run(entry);
    }
  }

  async #run(entry: QueueEntry) {
    try {
      const avatarPath = await this.#fetchAvatar(entry.participantId);
      if (this.#entries.get(entry.participantId) !== entry || entry.subscribers.size === 0) return;
      this.#entries.delete(entry.participantId);
      if (avatarPath) this.#onHydrated(entry.participantId, avatarPath);
      else this.#terminalFailures.add(entry.participantId);
    } catch (error) {
      if (this.#entries.get(entry.participantId) !== entry || entry.subscribers.size === 0) return;
      const retryable = isRetryableAvatarError(error);
      if (retryable && entry.attempts < this.#maxAttempts) {
        entry.status = "backoff";
        const delay = this.#retryBaseMs * 2 ** (entry.attempts - 1);
        entry.retryTimer = setTimeout(() => {
          entry.retryTimer = undefined;
          if (this.#entries.get(entry.participantId) !== entry || entry.subscribers.size === 0) {
            this.#discardIfUnobserved(entry);
            return;
          }
          entry.status = "queued";
          this.#queued.push(entry);
          this.#pump();
        }, delay);
      } else {
        this.#entries.delete(entry.participantId);
        if (!retryable) this.#terminalFailures.add(entry.participantId);
      }
    } finally {
      this.#running -= 1;
      if (this.#entries.get(entry.participantId) === entry && entry.subscribers.size === 0) {
        if (entry.retryTimer) clearTimeout(entry.retryTimer);
        this.#entries.delete(entry.participantId);
      }
      this.#pump();
    }
  }
}

function positiveInteger(value: number, name: string) {
  if (!Number.isInteger(value) || value <= 0) throw new Error(`${name} must be a positive integer`);
  return value;
}

function avatarErrorShape(error: unknown): { code: string; message: string; retryable: boolean } | undefined {
  if (typeof error === "string") {
    try {
      return avatarErrorShape(JSON.parse(error));
    } catch {
      return undefined;
    }
  }
  if (typeof error !== "object" || error === null) return undefined;
  const candidate = error as { code?: unknown; message?: unknown; retryable?: unknown };
  return typeof candidate.code === "string"
    && typeof candidate.message === "string"
    && typeof candidate.retryable === "boolean"
    ? { code: candidate.code, message: candidate.message, retryable: candidate.retryable }
    : undefined;
}
