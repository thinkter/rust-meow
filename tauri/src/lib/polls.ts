import type { Message, PollContent } from "./types";

/** Apply one complete local vote intent. The caller owns request sequencing;
 * this pure reducer makes optimistic updates and rollback deterministic. */
export function optimisticPollVote(poll: PollContent, selectedOptions: string[]): PollContent {
  const previous = new Set(poll.options.filter((option) => option.selectedByMe).map((option) => option.name));
  const next = new Set(selectedOptions);
  return {
    ...poll,
    totalVoters: Math.max(0, poll.totalVoters + (previous.size === 0 && next.size > 0 ? 1 : previous.size > 0 && next.size === 0 ? -1 : 0)),
    options: poll.options.map((option) => ({
      ...option,
      voteCount: Math.max(0, option.voteCount + (previous.has(option.name) && !next.has(option.name) ? -1 : !previous.has(option.name) && next.has(option.name) ? 1 : 0)),
      selectedByMe: next.has(option.name),
    })),
  };
}

/** Ignore an unsolicited/stale poll snapshot while a newer local full-state
 * vote is pending. Non-poll metadata still converges immediately. */
export function preservePendingPollIntent(current: Message, incoming: Message, pending: boolean): Message {
  if (!pending || !current.content || !("poll" in current.content) || !incoming.content || !("poll" in incoming.content)) return incoming;
  return { ...incoming, content: current.content };
}
