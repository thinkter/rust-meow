import type { BridgeLifecycle } from "../lib/types";

export type BackendLifecycleDecision =
  | { phase: "reconnecting"; detail: string }
  | { phase: "resync"; epoch: number }
  | { phase: "fatal"; message: string };

/** Keep lifecycle presentation deterministic and exhaustive across platforms. */
export function backendLifecycleDecision(
  lifecycle: BridgeLifecycle,
): BackendLifecycleDecision {
  switch (lifecycle.state) {
    case "reconnecting":
      return {
        phase: "reconnecting",
        detail: `Backend restart ${lifecycle.attempt}/${lifecycle.maxAttempts}`,
      };
    case "reconnected":
      return { phase: "resync", epoch: lifecycle.epoch };
    case "retryExhausted":
      return {
        phase: "fatal",
        message: `The WhatsApp backend repeatedly stopped: ${lifecycle.message}`,
      };
    case "fatal":
      return {
        phase: "fatal",
        message: `The WhatsApp backend cannot start safely: ${lifecycle.message}`,
      };
  }
}

export function activeConversationIds(
  panes: ReadonlyArray<{ activeChatId: string }>,
): string[] {
  return [...new Set(panes.map((pane) => pane.activeChatId).filter(Boolean))];
}

export function bootstrapFailureDecision(error: {
  retryable: boolean;
}): "reconnecting" | "fatal" {
  return error.retryable ? "reconnecting" : "fatal";
}

/** Coalesce overlapping lifecycle events without ever dropping the newest epoch. */
export class RestartEpochQueue {
  private pendingEpoch = 0;

  push(epoch: number): void {
    this.pendingEpoch = Math.max(this.pendingEpoch, epoch);
  }

  take(): number | undefined {
    if (!this.pendingEpoch) return undefined;
    const epoch = this.pendingEpoch;
    this.pendingEpoch = 0;
    return epoch;
  }
}

/** Tokens stale in-flight reads so only the newest epoch may update shared state. */
export class RequestGeneration {
  private current = 0;

  begin(): number {
    this.current += 1;
    return this.current;
  }

  invalidate(): void {
    this.current += 1;
  }

  isCurrent(generation: number): boolean {
    return generation === this.current;
  }
}
