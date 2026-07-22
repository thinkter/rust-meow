import assert from "node:assert/strict";
import test from "node:test";

import {
  NotificationActivationQueue,
  NotificationPermissionGate,
  notificationTargetAvailability,
} from "../src/lib/notification-routing.ts";

test("activation waits for bootstrap and duplicate native deliveries route once", async () => {
  const routed: string[] = [];
  const queue = new NotificationActivationQueue(({ chatId, messageId }) => {
    routed.push(`${chatId}/${messageId}`);
  });
  assert.equal(queue.enqueue({ chatId: "chat-1", messageId: "message-1" }), true);
  assert.equal(queue.enqueue({ chatId: "chat-1", messageId: "message-1" }), false);
  await queue.flush();
  assert.deepEqual(routed, []);
  queue.markReady();
  await queue.flush();
  assert.deepEqual(routed, ["chat-1/message-1"]);
  assert.equal(queue.enqueue({ chatId: "chat-1", messageId: "message-1" }), false);
});

test("queued activation follows a chat merge and remains ordered", async () => {
  const routed: string[] = [];
  const queue = new NotificationActivationQueue(async ({ chatId, messageId }) => {
    routed.push(`${chatId}/${messageId}`);
  });
  queue.enqueue({ chatId: "old", messageId: "first" });
  queue.enqueue({ chatId: "new", messageId: "second" });
  queue.mergeChatId("old", "new");
  queue.markReady();
  await queue.flush();
  assert.deepEqual(routed, ["new/first", "new/second"]);
});

test("invalid activation payloads are ignored", () => {
  const queue = new NotificationActivationQueue(() => undefined);
  assert.equal(queue.enqueue(null), false);
  assert.equal(queue.enqueue({ chatId: "", messageId: "message" }), false);
  assert.equal(queue.enqueue({ chatId: "chat" }), false);
});

test("missing chats and deleted messages have explicit fallback outcomes", () => {
  assert.equal(notificationTargetAvailability(false, false), "missing-chat");
  assert.equal(notificationTargetAvailability(true, false), "missing-message");
  assert.equal(notificationTargetAvailability(true, true), "available");
});

test("permission denial is cached until the user explicitly retries", async () => {
  const gate = new NotificationPermissionGate();
  let attempts = 0;
  const denied = async () => {
    attempts += 1;
    return false;
  };
  assert.equal(await gate.check(denied), false);
  assert.equal(await gate.check(denied), false);
  assert.equal(attempts, 1);
  assert.equal(await gate.check(async () => true, true), true);
  assert.equal(attempts, 1);
});
