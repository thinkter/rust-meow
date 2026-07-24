export type SendPayload =
  | readonly ["text", string, string, string, readonly string[]]
  | readonly ["image", string, string, string, string]
  | readonly ["sticker", string, string, string]
  | readonly ["attachment", string, number, string, string, string, boolean]
  | readonly ["poll", string, readonly string[], number]
  | readonly ["forward", string, string, string];

interface SendAttempt {
  readonly clientMessageId: string;
  readonly fingerprint: string;
}

/**
 * Retain the client-generated ID of the latest unresolved send in each chat.
 * An exact retry reuses that ID; a changed payload or a send after a confirmed
 * success is a new logical operation and receives a fresh ID.
 */
export class SendIdempotency {
  private readonly pendingByChat = new Map<string, SendAttempt>();
  private readonly createId: () => string;

  constructor(createId: () => string = () => crypto.randomUUID()) {
    this.createId = createId;
  }

  async run<T>(
    chatId: string,
    payload: SendPayload,
    send: (clientMessageId: string) => Promise<T>,
  ): Promise<T> {
    const fingerprint = JSON.stringify(payload);
    const pending = this.pendingByChat.get(chatId);
    const attempt =
      pending?.fingerprint === fingerprint
        ? pending
        : { clientMessageId: this.createId(), fingerprint };

    // Mark the operation before invoking native IPC. This also makes two
    // overlapping calls for the same logical payload share one request ID.
    this.pendingByChat.set(chatId, attempt);
    try {
      const result = await send(attempt.clientMessageId);
      if (this.pendingByChat.get(chatId) === attempt) {
        this.pendingByChat.delete(chatId);
      }
      return result;
    } catch (error) {
      // Keep the attempt only while it is still the latest operation for the
      // chat. A later, changed send must not be replaced by an older failure.
      if (this.pendingByChat.get(chatId) === attempt) {
        this.pendingByChat.set(chatId, attempt);
      }
      throw error;
    }
  }
}
