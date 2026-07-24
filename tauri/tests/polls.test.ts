import assert from "node:assert/strict";
import test from "node:test";
import { clonePollContent, optimisticPollVote, preservePendingPollIntent } from "../src/lib/polls.ts";
import type { Message, PollContent } from "../src/lib/types.ts";

const poll = (): PollContent => ({ question: "Lunch?", selectableOptionsCount: 2, totalVoters: 1, options: [
  { name: "Pizza", voteCount: 1, selectedByMe: true, voters: [{ userId: "me", displayName: "You", avatarPath: "", fromMe: true }] },
  { name: "Sushi", voteCount: 0, selectedByMe: false, voters: [] },
] });

test("poll reducer changes a vote without duplicating the voter", () => {
  const changed = optimisticPollVote(poll(), ["Sushi"]);
  assert.equal(changed.totalVoters, 1);
  assert.deepEqual(changed.options.map((option) => [option.name, option.voteCount, option.selectedByMe]), [["Pizza", 0, false], ["Sushi", 1, true]]);
});

test("poll reducer retracts and restores a complete vote intent", () => {
  const retracted = optimisticPollVote(poll(), []);
  assert.equal(retracted.totalVoters, 0);
  assert.equal(retracted.options[0]?.voteCount, 0);
  assert.deepEqual(optimisticPollVote(retracted, ["Pizza", "Sushi"]).options.map((option) => option.voteCount), [1, 1]);
});

test("an older backend update cannot overwrite a newer pending intent", () => {
  const message = (content: PollContent): Message => ({ id: "poll", chatId: "chat", senderId: "owner", senderName: "Owner", fromMe: false, timestampMs: 1, status: 3, edited: false, revoked: false, expiresAtMs: 0, senderPhoneNumber: "", senderAvatarPath: "", reactions: [], replyToMessageId: "", replyToChatId: "", content: { poll: content } });
  const current = message(optimisticPollVote(poll(), ["Sushi"]));
  const stale = message(poll());
  const merged = preservePendingPollIntent(current, stale, true);
  assert.deepEqual(merged.content, current.content);
  assert.deepEqual(preservePendingPollIntent(current, stale, false).content, stale.content);
});

test("poll snapshots can be copied from reactive proxy values", () => {
  const reactive = new Proxy(poll(), {});
  const snapshot = clonePollContent(reactive);
  assert.deepEqual(snapshot, poll());
  assert.notEqual(snapshot, reactive);
  assert.notEqual(snapshot.options, reactive.options);
  assert.notEqual(snapshot.options[0]?.voters, reactive.options[0]?.voters);
});
