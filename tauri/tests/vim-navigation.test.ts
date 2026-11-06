import assert from "node:assert/strict";
import test from "node:test";
import { isEditableTarget, resolveVimCommand } from "../src/lib/vim-navigation.ts";

test("normal mode maps navigation and app actions", () => {
  assert.equal(resolveVimCommand({ key: "j" }), "move-down");
  assert.equal(resolveVimCommand({ key: "k" }), "move-up");
  assert.equal(resolveVimCommand({ key: "G" }), "last");
  assert.equal(resolveVimCommand({ key: "g" }), "pending-g");
  assert.equal(resolveVimCommand({ key: "i" }), "focus-composer");
  assert.equal(resolveVimCommand({ key: "r" }), "reply");
  assert.equal(resolveVimCommand({ key: "x" }), "close-tab");
});

test("modified keys pass through and null is a safe non-DOM input", () => {
  assert.equal(resolveVimCommand({ key: "j", ctrlKey: true }), null);
  assert.equal(resolveVimCommand({ key: "k", altKey: true }), null);
  assert.equal(isEditableTarget(null), false);
});
