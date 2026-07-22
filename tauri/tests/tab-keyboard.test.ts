import assert from "node:assert/strict";
import test from "node:test";
import { tabKeyboardCommand } from "../src/state/tab-keyboard.ts";
import type { Pane } from "../src/state/workspace.ts";

const panes: Pane[] = [
  { id: "pane-1", tabChatIds: ["a", "b", "c"], activeChatId: "b" },
  { id: "pane-2", tabChatIds: ["d"], activeChatId: "d" },
];

const gesture = (
  key: string,
  overrides: Partial<{ altKey: boolean; shiftKey: boolean; platformModifier: boolean }> = {},
) => ({ key, altKey: false, shiftKey: false, platformModifier: false, ...overrides });

test("Alt+Shift+Arrow reorders within a pane", () => {
  assert.deepEqual(tabKeyboardCommand(gesture("ArrowLeft", { altKey: true, shiftKey: true }), panes, "pane-1", "b"), {
    kind: "reorder", index: 0, direction: "left",
  });
  assert.deepEqual(tabKeyboardCommand(gesture("ArrowRight", { altKey: true, shiftKey: true }), panes, "pane-1", "b"), {
    kind: "reorder", index: 2, direction: "right",
  });
});

test("reorder reports first and last tab boundaries", () => {
  assert.deepEqual(
    tabKeyboardCommand(gesture("ArrowLeft", { altKey: true, shiftKey: true }), panes, "pane-1", "a"),
    { kind: "boundary", message: "Tab is already first in this pane" },
  );
  assert.deepEqual(
    tabKeyboardCommand(gesture("ArrowRight", { altKey: true, shiftKey: true }), panes, "pane-1", "c"),
    { kind: "boundary", message: "Tab is already last in this pane" },
  );
});

test("Control+Shift+Arrow moves to an adjacent pane at a bounded index", () => {
  assert.deepEqual(tabKeyboardCommand(gesture("ArrowRight", { platformModifier: true, shiftKey: true }), panes, "pane-1", "c"), {
    kind: "move-pane", paneId: "pane-2", index: 1, direction: "right",
  });
  assert.deepEqual(tabKeyboardCommand(gesture("ArrowLeft", { platformModifier: true, shiftKey: true }), panes, "pane-2", "d"), {
    kind: "move-pane", paneId: "pane-1", index: 0, direction: "left",
  });
});

test("cross-pane movement reports both outer boundaries", () => {
  assert.deepEqual(
    tabKeyboardCommand(gesture("ArrowLeft", { platformModifier: true, shiftKey: true }), panes, "pane-1", "a"),
    { kind: "boundary", message: "There is no pane to the left" },
  );
  assert.deepEqual(
    tabKeyboardCommand(gesture("ArrowRight", { platformModifier: true, shiftKey: true }), panes, "pane-2", "d"),
    { kind: "boundary", message: "There is no pane to the right" },
  );
});

test("Delete closes while modified Delete and unrelated keys pass through", () => {
  assert.deepEqual(tabKeyboardCommand(gesture("Delete"), panes, "pane-1", "b"), { kind: "close" });
  assert.equal(tabKeyboardCommand(gesture("Delete", { platformModifier: true }), panes, "pane-1", "b"), undefined);
  assert.equal(tabKeyboardCommand(gesture("Enter"), panes, "pane-1", "b"), undefined);
});
