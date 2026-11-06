import assert from "node:assert/strict";
import test from "node:test";
import {
  isEditableTarget,
  resolveVimCommand,
  resolveVimCursorIndex,
  resolveVimMessageIndex,
  resolveVisibleIndexRange,
} from "../src/lib/vim-navigation.ts";

test("normal mode maps navigation and app actions", () => {
  assert.equal(resolveVimCommand({ key: "j" }), "move-down");
  assert.equal(resolveVimCommand({ key: "k" }), "move-up");
  assert.equal(resolveVimCommand({ key: "G" }), "last");
  assert.equal(resolveVimCommand({ key: "g" }), "pending-g");
  assert.equal(resolveVimCommand({ key: "i" }), "focus-composer");
  assert.equal(resolveVimCommand({ key: "r" }), "reply");
  assert.equal(resolveVimCommand({ key: "?" }), "toggle-shortcuts");
  assert.equal(resolveVimCommand({ key: "x" }), "close-tab");
});

test("modified keys pass through and null is a safe non-DOM input", () => {
  assert.equal(resolveVimCommand({ key: "j", ctrlKey: true }), null);
  assert.equal(resolveVimCommand({ key: "k", altKey: true }), null);
  assert.equal(isEditableTarget(null), false);
});

test("virtual cursor steps and clamps at both ends", () => {
  const base = { count: 5, visible: null };
  assert.equal(resolveVimMessageIndex({ ...base, current: 2, command: { kind: "step", direction: 1 } }), 3);
  assert.equal(resolveVimMessageIndex({ ...base, current: 2, command: { kind: "step", direction: -1 } }), 1);
  assert.equal(resolveVimMessageIndex({ ...base, current: 4, command: { kind: "step", direction: 1 } }), 4);
  assert.equal(resolveVimMessageIndex({ ...base, current: 0, command: { kind: "step", direction: -1 } }), 0);
});

test("repeated steps advance one index per command without a mounted row", () => {
  let cursor: number | null = 10;
  for (let press = 0; press < 3; press += 1) {
    cursor = resolveVimMessageIndex({ count: 100, current: cursor, command: { kind: "step", direction: 1 }, visible: null });
  }
  assert.equal(cursor, 13);
});

test("edges select first and last loaded message regardless of cursor", () => {
  assert.equal(resolveVimMessageIndex({ count: 7, current: 3, command: { kind: "edge", edge: "first" }, visible: null }), 0);
  assert.equal(resolveVimMessageIndex({ count: 7, current: 3, command: { kind: "edge", edge: "last" }, visible: null }), 6);
  assert.equal(resolveVimMessageIndex({ count: 0, current: null, command: { kind: "edge", edge: "last" }, visible: null }), null);
});

test("without a cursor, steps land on the visible edge in their direction", () => {
  const visible = { first: 40, last: 52 };
  assert.equal(resolveVimMessageIndex({ count: 100, current: null, command: { kind: "step", direction: 1 }, visible }), 40);
  assert.equal(resolveVimMessageIndex({ count: 100, current: null, command: { kind: "step", direction: -1 }, visible }), 52);
  assert.equal(resolveVimMessageIndex({ count: 100, current: null, command: { kind: "step", direction: 1 }, visible: null }), 0);
  assert.equal(resolveVimMessageIndex({ count: 100, current: null, command: { kind: "step", direction: -1 }, visible: null }), 99);
});

test("cursor resolves by id across prepends and trims, then clamps", () => {
  const cursor = { id: "m5", index: 5 };
  assert.equal(resolveVimCursorIndex(["m3", "m4", "m5", "m6"], cursor), 2);
  assert.equal(resolveVimCursorIndex(["m5", "m6"], cursor), 0);
  assert.equal(resolveVimCursorIndex(["a", "b", "c"], { id: "gone", index: 9 }), 2);
  assert.equal(resolveVimCursorIndex(["a", "b"], null), null);
  assert.equal(resolveVimCursorIndex([], cursor), null);
});

test("visible range covers items intersecting the viewport only", () => {
  const items = [
    { index: 0, start: 0, end: 50 },
    { index: 1, start: 50, end: 100 },
    { index: 2, start: 100, end: 150 },
    { index: 3, start: 150, end: 200 },
  ];
  assert.deepEqual(resolveVisibleIndexRange(items, 60, 120), { first: 1, last: 2 });
  assert.equal(resolveVisibleIndexRange(items, 500, 600), null);
});
