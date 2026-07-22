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

test("activation routing pauses across a backend restart until the fresh epoch is ready", async () => {
  const routed: string[] = [];
  const queue = new NotificationActivationQueue(({ chatId, messageId }) => {
    routed.push(`${chatId}/${messageId}`);
  });
  queue.markReady();
  queue.markNotReady();
  queue.enqueue({ chatId: "chat-2", messageId: "message-2" });
  await queue.flush();
  assert.deepEqual(routed, []);
  queue.markReady();
  await queue.flush();
  assert.deepEqual(routed, ["chat-2/message-2"]);
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

test("a chat merge deduplicates a canonical target queued during routing", async () => {
  const routed: string[] = [];
  let releaseFirst!: () => void;
  const firstRoute = new Promise<void>((resolve) => {
    releaseFirst = resolve;
  });
  const queue = new NotificationActivationQueue(async ({ chatId, messageId }) => {
    routed.push(`${chatId}/${messageId}`);
    await firstRoute;
  });
  queue.markReady();
  queue.enqueue({ chatId: "old", messageId: "message" });
  queue.enqueue({ chatId: "new", messageId: "message" });
  queue.mergeChatId("old", "new");
  releaseFirst();
  await queue.flush();
  assert.deepEqual(routed, ["old/message"]);
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
