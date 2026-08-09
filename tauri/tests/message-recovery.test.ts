import assert from "node:assert/strict";
import test from "node:test";

import { messageRecoveryView } from "../src/lib/message-recovery.ts";
import type { Message } from "../src/lib/types.ts";

function message(overrides: Partial<Message> = {}): Message {
  return {
    id: "message-1",
    chatId: "chat-1",
    senderId: "alice",
    senderName: "Alice",
    fromMe: false,
    timestampMs: 1,
    status: 3,
    edited: false,
    revoked: false,
    expiresAtMs: 0,
    senderPhoneNumber: "",
    senderAvatarPath: "",
    reactions: [],
    replyToMessageId: "",
    replyToChatId: "",
    forwardingScore: 0,
    mentionTexts: [],
    revisions: [],
    content: { text: { text: "Current", linkPreview: null } },
    ...overrides,
  } as Message;
}

const original = message({
  content: { text: { text: "Original", linkPreview: null } },
});

test("recovered content and indicators are completely hidden by default", () => {
  const view = messageRecoveryView(message({
    revoked: true,
    revisions: [{ replacedAtMs: 2, reason: "deleted", snapshot: original }],
  }), false);

  assert.equal(view.event, null);
  assert.equal(view.preservedMessage, undefined);
  assert.deepEqual(view.revisions, []);
});

test("enabled recovery distinguishes deletions and exposes the retained message", () => {
  const view = messageRecoveryView(message({
    revoked: true,
    revisions: [{ replacedAtMs: 2, reason: "deleted", snapshot: original }],
  }), true);

  assert.equal(view.event, "deleted");
  assert.equal(view.preservedMessage?.content && "text" in view.preservedMessage.content
    ? view.preservedMessage.content.text.text
    : "", "Original");
  assert.equal(view.revisions.length, 1);
});

test("enabled recovery distinguishes edits even when no earlier snapshot is available", () => {
  assert.equal(messageRecoveryView(message({ edited: true }), true).event, "edited");
});
