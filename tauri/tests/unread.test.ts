import assert from "node:assert/strict";
import test from "node:test";
import {
  optimisticUnreadCount,
  shouldRestoreOptimisticUnread,
} from "../src/state/unread.ts";

test("partial message windows retain the backend unread count", () => {
  assert.equal(optimisticUnreadCount(7, true), 7);
});

test("a read through the newest message can clear the badge optimistically", () => {
  assert.equal(optimisticUnreadCount(7, false), 0);
});

test("a matching authoritative upsert prevents rollback after a lost response", () => {
  assert.equal(shouldRestoreOptimisticUnread(0, 0, 4, 5), false);
  assert.equal(shouldRestoreOptimisticUnread(0, 0, 4, 4), true);
  assert.equal(shouldRestoreOptimisticUnread(2, 0, 4, 4), false);
});
