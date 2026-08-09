import type { Message, MessageRevision } from "./types";

/** Missing, invalid, and explicitly false stored values all remain opt-out. */
export function isMessageRecoveryEnabled(value: unknown): boolean {
  return value === true;
}

export interface MessageRecoveryView {
  revisions: MessageRevision[];
  preservedMessage?: Message;
  event: "deleted" | "edited" | null;
}

/**
 * Keep the opt-in boundary in one pure function so every recovered-content
 * surface disappears together when the preference is disabled.
 */
export function messageRecoveryView(message: Message, enabled: boolean): MessageRecoveryView {
  if (!enabled) return { revisions: [], event: null };

  const revisions = (message.revisions ?? []).filter(
    (revision): revision is MessageRevision & { snapshot: Message } => Boolean(revision.snapshot),
  );
  return {
    revisions,
    preservedMessage: message.revoked ? revisions.at(-1)?.snapshot : undefined,
    event: message.revoked ? "deleted" : message.edited ? "edited" : null,
  };
}
