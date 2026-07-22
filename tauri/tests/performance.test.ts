import assert from "node:assert/strict";
import test from "node:test";
import { BoundedSet, boundWindowAround, indexMessages } from "../src/lib/performance.ts";
import type { Message } from "../src/lib/types.ts";

test("BoundedSet evicts the least recently inserted value", () => {
  const values = new BoundedSet<string>(3);
  assert.equal(values.add("a"), undefined);
  values.add("b");
  values.add("c");
  values.add("a");

  assert.equal(values.add("d"), "b");
  assert.equal(values.size, 3);
  assert.equal(values.has("a"), true);
  assert.equal(values.has("b"), false);
});

test("BoundedSet rejects invalid capacities", () => {
  assert.throws(() => new BoundedSet(0), /positive integer/);
  assert.throws(() => new BoundedSet(1.5), /positive integer/);
});

test("message index resolves quotes and reply metadata in one pass", () => {
  const messages = [
    message("root"),
    message("reply-1", "root"),
    message("reply-2", "root"),
    message("nested", "reply-1"),
  ];
  const index = indexMessages(messages);

  assert.equal(index.byId.get("root"), messages[0]);
  assert.equal(index.replyCountById.get("root"), 2);
  assert.equal(index.firstReplyIdById.get("root"), "reply-1");
  assert.equal(index.replyCountById.get("reply-1"), 1);
  assert.equal(index.replyCountById.has("reply-2"), false);
});

test("canonical message windows stay bounded around the requested target", () => {
  const values = Array.from({ length: 10 }, (_, index) => index);
  assert.deepEqual(boundWindowAround(values, 5, 1), {
    items: [0, 1, 2, 3, 4],
    droppedBefore: false,
    droppedAfter: true,
  });
  assert.deepEqual(boundWindowAround(values, 5, 8), {
    items: [5, 6, 7, 8, 9],
    droppedBefore: true,
    droppedAfter: false,
  });
  assert.deepEqual(boundWindowAround(values, 5, 5), {
    items: [3, 4, 5, 6, 7],
    droppedBefore: true,
    droppedAfter: true,
  });
});

function message(id: string, replyToMessageId = ""): Message {
  return {
    id,
    chatId: "chat",
    senderId: "sender",
    senderName: "Sender",
    senderPhoneNumber: "",
    senderAvatarPath: "",
    timestampMs: 1,
    fromMe: false,
    status: 0,
    content: null,
    reactions: [],
    replyToMessageId,
    edited: false,
    revoked: false,
    expiresAtMs: 0,
  };
}
