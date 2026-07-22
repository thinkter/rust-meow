import assert from "node:assert/strict";
import test from "node:test";

import {
  isChatActuallyVisible,
  notificationBody,
  notificationTitle,
  shouldNotify,
} from "../src/lib/notification-policy.ts";
import type { Chat, Message } from "../src/lib/types.ts";

const message = {
  id: "message-1",
  chatId: "chat-1",
  senderName: "Alice",
  fromMe: false,
  revoked: false,
  content: { text: { text: "Hello\nfrom   Alice", linkPreview: null } },
} as Message;

test("notification policy suppresses foreground, muted, outgoing, and disabled messages", () => {
  assert.equal(shouldNotify({ enabled: true, visible: false, chatVisible: false, muted: false, incoming: true }), true);
  assert.equal(shouldNotify({ enabled: true, visible: true, chatVisible: true, muted: false, incoming: true }), false);
  assert.equal(shouldNotify({ enabled: true, visible: false, chatVisible: false, muted: true, incoming: true }), false);
  assert.equal(shouldNotify({ enabled: true, visible: false, chatVisible: false, muted: false, incoming: false }), false);
  assert.equal(shouldNotify({ enabled: false, visible: false, chatVisible: false, muted: false, incoming: true }), false);
});

test("responsive split panes only expose the focused conversation", () => {
  const panes = [
    { id: "pane-1", tabChatIds: ["alpha"], activeChatId: "alpha" },
    { id: "pane-2", tabChatIds: ["beta"], activeChatId: "beta" },
  ];
  assert.equal(isChatActuallyVisible(panes, "pane-1", "beta", false), true);
  assert.equal(isChatActuallyVisible(panes, "pane-1", "alpha", true), true);
  assert.equal(isChatActuallyVisible(panes, "pane-1", "beta", true), false);
});

test("notification text obeys the privacy preview preference", () => {
  assert.equal(notificationBody(message, true), "Hello from Alice");
  assert.equal(notificationBody(message, false), "New message");
  assert.equal(notificationTitle(undefined, message), "Alice");
  assert.equal(notificationTitle({ title: "Project room" } as Chat, message), "Project room");
});
