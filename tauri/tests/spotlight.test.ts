import assert from "node:assert/strict";
import test from "node:test";
import {
  rankSpotlightChats,
  type SpotlightUsage,
} from "../src/lib/spotlight.ts";
import { ChatKind, type Chat } from "../src/lib/types.ts";

const NOW = Date.UTC(2026, 6, 24, 12);

function chat(input: Partial<Chat> & Pick<Chat, "id" | "title">): Chat {
  return {
    id: input.id,
    kind: input.kind ?? ChatKind.Direct,
    title: input.title,
    avatarPath: "",
    lastMessagePreview: "",
    lastMessageTimestampMs: input.lastMessageTimestampMs ?? NOW - 30 * 86_400_000,
    unreadCount: 0,
    muted: false,
    pinned: input.pinned ?? false,
    archived: input.archived ?? false,
    phoneNumber: input.phoneNumber ?? "",
    contactName: input.contactName ?? "",
    pushName: input.pushName ?? "",
    businessName: input.businessName ?? "",
  };
}

test("empty Spotlight puts frequently opened chats ahead of merely recent ones", () => {
  const chats = [
    chat({ id: "recent", title: "Recent", lastMessageTimestampMs: NOW - 60_000 }),
    chat({ id: "frequent", title: "Frequent" }),
  ];
  const usage: SpotlightUsage = {
    frequent: { opens: 20, lastOpenedAt: NOW - 86_400_000 },
  };

  assert.deepEqual(
    rankSpotlightChats(chats, "", usage, NOW).map((match) => match.chat.id),
    ["frequent", "recent"],
  );
});

test("text relevance dominates affinity while frequency breaks equal matches", () => {
  const chats = [
    chat({ id: "exact", title: "Maya" }),
    chat({ id: "prefix", title: "Maya Thomas" }),
    chat({ id: "other", title: "Amaya", contactName: "Maya" }),
  ];
  const usage: SpotlightUsage = {
    prefix: { opens: 50, lastOpenedAt: NOW },
    other: { opens: 100, lastOpenedAt: NOW },
  };

  assert.deepEqual(
    rankSpotlightChats(chats, "maya", usage, NOW).map((match) => match.chat.id),
    ["exact", "prefix", "other"],
  );
});

test("aliases, phone numbers, multiple terms, and accents are searchable", () => {
  const chats = [
    chat({
      id: "joao",
      title: "João Silva",
      phoneNumber: "+91 98765 43210",
      businessName: "North Star",
    }),
    chat({ id: "other", title: "Someone Else" }),
  ];

  assert.equal(rankSpotlightChats(chats, "joao", {}, NOW)[0]?.chat.id, "joao");
  assert.equal(rankSpotlightChats(chats, "north star", {}, NOW)[0]?.chat.id, "joao");
  assert.equal(rankSpotlightChats(chats, "98765", {}, NOW)[0]?.chat.id, "joao");
});

test("archived chats stay out of instant Spotlight results", () => {
  const chats = [
    chat({ id: "visible", title: "Visible" }),
    chat({ id: "archived", title: "Archived", archived: true }),
  ];
  assert.deepEqual(
    rankSpotlightChats(chats, "", {}, NOW).map((match) => match.chat.id),
    ["visible"],
  );
});
