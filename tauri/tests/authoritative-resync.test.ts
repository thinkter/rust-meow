import assert from "node:assert/strict";
import test from "node:test";
import { reconcileAuthoritativeChats } from "../src/state/app-helpers.ts";
import { ChatKind, type Chat } from "../src/lib/types.ts";

test("authoritative chat resync deletes stale rows while preserving racing live upserts", () => {
  const stale = chat("stale", 10, "stale");
  const unchanged = chat("unchanged", 20, "old");
  const raced = chat("raced", 30, "live");
  const result = reconcileAuthoritativeChats(
    [chat("unchanged", 40, "authoritative")],
    [stale, unchanged, raced],
    new Map([["stale", 1], ["unchanged", 2], ["raced", 3]]),
    new Map([["stale", 1], ["unchanged", 2], ["raced", 4]]),
  );

  assert.deepEqual(result.map((item) => item.id), ["unchanged", "raced"]);
  assert.equal(result.find((item) => item.id === "unchanged")?.lastMessagePreview, "authoritative");
  assert.equal(result.find((item) => item.id === "raced")?.lastMessagePreview, "live");
});

function chat(id: string, timestamp: number, preview: string): Chat {
  return {
    id,
    kind: ChatKind.Direct,
    title: id,
    avatarPath: "",
    lastMessagePreview: preview,
    lastMessageTimestampMs: timestamp,
    unreadCount: 0,
    muted: false,
    pinned: false,
    archived: false,
    phoneNumber: "",
    contactName: "",
    pushName: "",
    businessName: "",
  };
}
