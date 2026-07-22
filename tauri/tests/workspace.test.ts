import assert from "node:assert/strict";
import test from "node:test";
import {
  closeTabInWorkspace,
  conversationsToEvict,
  cycleSwitcher,
  moveTabBetweenPanes,
  normalizeWorkspaceSnapshot,
  openSwitcher,
  openTab,
  recentChatCandidates,
  remapPaneChatId,
  selectTab,
  type Pane,
} from "../src/state/workspace.ts";

function pane(id: string, tabChatIds: string[], activeChatId = tabChatIds[0] ?? ""): Pane {
  return { id, tabChatIds, activeChatId };
}

test("opening a tab that is already open focuses it instead of duplicating it", () => {
  const first = openTab(pane("pane-1", ["a"], "a"), "b");
  assert.deepEqual(first, { id: "pane-1", tabChatIds: ["a", "b"], activeChatId: "b" });
  const second = openTab(first, "a");
  assert.deepEqual(second, { id: "pane-1", tabChatIds: ["a", "b"], activeChatId: "a" });
});

test("selecting an already-open tab focuses it without touching the tab list", () => {
  const result = selectTab(pane("pane-1", ["a", "b"], "a"), "b");
  assert.deepEqual(result.tabChatIds, ["a", "b"]);
  assert.equal(result.activeChatId, "b");
});

test("selecting a new chat replaces the active tab in place, not appending", () => {
  const result = selectTab(pane("pane-1", ["a", "b"], "a"), "c");
  assert.deepEqual(result.tabChatIds, ["c", "b"]);
  assert.equal(result.activeChatId, "c");
});

test("closing the active tab activates the right-hand neighbour", () => {
  const result = closeTabInWorkspace([pane("pane-1", ["a", "b", "c"], "b")], "b", "pane-1");
  assert.equal(result.removedPaneId, null);
  assert.deepEqual(result.panes[0]!.tabChatIds, ["a", "c"]);
  assert.equal(result.panes[0]!.activeChatId, "c");
});

test("closing the last tab in a strip falls back to the left-hand neighbour", () => {
  const result = closeTabInWorkspace([pane("pane-1", ["a", "b", "c"], "c")], "c", "pane-1");
  assert.deepEqual(result.panes[0]!.tabChatIds, ["a", "b"]);
  assert.equal(result.panes[0]!.activeChatId, "b");
});

test("closing an inactive tab leaves the active tab untouched", () => {
  const result = closeTabInWorkspace([pane("pane-1", ["a", "b", "c"], "b")], "a", "pane-1");
  assert.deepEqual(result.panes[0]!.tabChatIds, ["b", "c"]);
  assert.equal(result.panes[0]!.activeChatId, "b");
});

test("closing the last tab of the second pane removes that pane", () => {
  const panes = [pane("pane-1", ["a"], "a"), pane("pane-2", ["b"], "b")];
  const result = closeTabInWorkspace(panes, "b", "pane-2");
  assert.equal(result.removedPaneId, "pane-2");
  assert.equal(result.panes.length, 1);
  assert.equal(result.panes[0]!.id, "pane-1");
});

test("closing the last tab of the only pane leaves an empty pane, not zero panes", () => {
  const result = closeTabInWorkspace([pane("pane-1", ["a"], "a")], "a", "pane-1");
  assert.equal(result.removedPaneId, null);
  assert.equal(result.panes.length, 1);
  assert.deepEqual(result.panes[0], { id: "pane-1", tabChatIds: [], activeChatId: "" });
});

test("moving a tab to another pane removes it from the source and appends it to the destination", () => {
  const panes = [pane("pane-1", ["a", "b"], "a"), pane("pane-2", ["c"], "c")];
  const moved = moveTabBetweenPanes(panes, "b", "pane-1", "pane-2", 1);
  const source = moved.find((candidate) => candidate.id === "pane-1")!;
  const destination = moved.find((candidate) => candidate.id === "pane-2")!;
  assert.deepEqual(source.tabChatIds, ["a"]);
  assert.deepEqual(destination.tabChatIds, ["c", "b"]);
  assert.equal(destination.activeChatId, "b");
});

test("moving a tab within the same pane reorders it to the requested index", () => {
  const panes = [pane("pane-1", ["a", "b", "c"], "a")];
  const moved = moveTabBetweenPanes(panes, "c", "pane-1", "pane-1", 0);
  assert.deepEqual(moved[0]!.tabChatIds, ["c", "a", "b"]);
  assert.equal(moved[0]!.activeChatId, "c");
});

test("remapping a chat id updates a pane's tabs and active chat", () => {
  const result = remapPaneChatId(pane("pane-1", ["old", "b"], "old"), "old", "new");
  assert.deepEqual(result.tabChatIds, ["new", "b"]);
  assert.equal(result.activeChatId, "new");
});

test("remapping onto a chat id already open drops the duplicate instead of colliding", () => {
  const result = remapPaneChatId(pane("pane-1", ["old", "new"], "old"), "old", "new");
  assert.deepEqual(result.tabChatIds, ["new"]);
  assert.equal(result.activeChatId, "new");
});

test("switcher initial highlight: reverse always lands on the last candidate", () => {
  const switcher = openSwitcher(["a", "b", "c"], true, true);
  assert.equal(switcher?.highlighted, 2);
});

test("switcher initial highlight: forward with the active chat leading skips to index 1", () => {
  const switcher = openSwitcher(["a", "b", "c"], false, true);
  assert.equal(switcher?.highlighted, 1);
});

test("switcher initial highlight: forward with the active chat not leading starts at index 0", () => {
  const switcher = openSwitcher(["a", "b", "c"], false, false);
  assert.equal(switcher?.highlighted, 0);
});

test("the switcher does not open with fewer than two candidates", () => {
  assert.equal(openSwitcher(["a"], false, true), undefined);
  assert.equal(openSwitcher([], true, false), undefined);
});

test("cycling the switcher only moves the highlight, wrapping in both directions", () => {
  const switcher = { chatIds: ["a", "b", "c"], highlighted: 0 };
  assert.equal(cycleSwitcher(switcher, false).highlighted, 1);
  assert.equal(cycleSwitcher(switcher, true).highlighted, 2);
  assert.equal(cycleSwitcher({ chatIds: ["a", "b", "c"], highlighted: 2 }, false).highlighted, 0);
});

test("candidate seeding falls back to the visible chat list until session history has two entries", () => {
  const candidates = recentChatCandidates([], () => true, ["v1", "v2", "v3"], "");
  assert.deepEqual(candidates, ["v1", "v2", "v3"]);
});

test("candidate seeding stops once session history already has two or more entries", () => {
  const candidates = recentChatCandidates(["r1", "r2"], () => true, ["v1", "v2", "v3"], "");
  assert.deepEqual(candidates, ["r1", "r2"]);
});

test("candidate seeding drops history entries for chats that no longer exist", () => {
  const candidates = recentChatCandidates(
    ["gone", "r1"],
    (chatId) => chatId !== "gone",
    ["v1", "v2"],
    "",
  );
  assert.deepEqual(candidates, ["r1", "v1", "v2"]);
});

test("the active chat is swapped to the front of the candidate list when already present", () => {
  const candidates = recentChatCandidates(["r1", "r2", "r3"], () => true, [], "r3");
  assert.deepEqual(candidates, ["r3", "r2", "r1"]);
});

test("the active chat is inserted at the front when it is not yet in session history", () => {
  const candidates = recentChatCandidates(["r1", "r2"], () => true, [], "active");
  assert.deepEqual(candidates, ["active", "r1", "r2"]);
});

test("conversations no longer open in any pane are evicted first", () => {
  const evicted = conversationsToEvict(["a", "b", "c"], new Set(["a", "c"]), new Map(), 8);
  assert.deepEqual(evicted, ["b"]);
});

test("once every hydrated chat is still open, the cap evicts the least recently focused", () => {
  const lastFocusedAt = new Map([
    ["a", 100],
    ["b", 300],
    ["c", 200],
  ]);
  const evicted = conversationsToEvict(["a", "b", "c"], new Set(["a", "b", "c"]), lastFocusedAt, 2);
  assert.deepEqual(evicted, ["a"]);
});

test("conversation eviction never drops a chat currently visible in a pane", () => {
  const lastFocusedAt = new Map([
    ["visible", 1],
    ["inactive-old", 2],
    ["inactive-new", 3],
  ]);
  const evicted = conversationsToEvict(
    ["visible", "inactive-old", "inactive-new"],
    new Set(["visible", "inactive-old", "inactive-new"]),
    lastFocusedAt,
    2,
    new Set(["visible"]),
  );
  assert.deepEqual(evicted, ["inactive-old"]);
});

test("normalizing a workspace snapshot rejects untrusted shapes", () => {
  assert.equal(normalizeWorkspaceSnapshot(null), undefined);
  assert.equal(normalizeWorkspaceSnapshot({}), undefined);
  assert.equal(normalizeWorkspaceSnapshot({ panes: [] }), undefined);
  assert.equal(normalizeWorkspaceSnapshot({ panes: [{}, {}, {}] }), undefined);
  assert.equal(
    normalizeWorkspaceSnapshot({ panes: [{ id: "pane-1", tabChatIds: "not-an-array" }] }),
    undefined,
  );
  assert.equal(
    normalizeWorkspaceSnapshot({ panes: [{ id: "x" }, { id: "x" }] }),
    undefined,
  );
});

test("normalizing a workspace snapshot accepts a well-formed payload and repairs a dangling active id", () => {
  const snapshot = normalizeWorkspaceSnapshot({
    panes: [{ id: "pane-1", tabChatIds: ["a", "b"], activeChatId: "not-in-list" }],
    focusedPaneId: "pane-1",
  });
  assert.deepEqual(snapshot?.panes[0], { id: "pane-1", tabChatIds: ["a", "b"], activeChatId: "a" });
  assert.equal(snapshot?.focusedPaneId, "pane-1");
});
