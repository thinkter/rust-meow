import assert from "node:assert/strict";
import test from "node:test";
import {
  captureScrollSnapshot,
  resolveScrollRestore,
} from "../src/state/scroll-restoration.ts";

test("captures a stable first-visible message anchor instead of a raw scroll offset", () => {
  const snapshot = captureScrollSnapshot(
    ["a", "b", "c"],
    [
      { index: 0, start: 0, end: 80 },
      { index: 1, start: 80, end: 180 },
      { index: 2, start: 180, end: 260 },
    ],
    115,
    600,
    200,
  );
  assert.deepEqual(snapshot, { anchorMessageId: "b", anchorOffset: -35, atLatest: false });
});

test("marks a viewport near the bottom as following latest", () => {
  const snapshot = captureScrollSnapshot(
    ["a"],
    [{ index: 0, start: 500, end: 600 }],
    350,
    600,
    200,
  );
  assert.equal(snapshot?.atLatest, true);
});

test("restores an existing anchor and preserves its viewport offset", () => {
  assert.deepEqual(
    resolveScrollRestore(["older", "a", "b", "c"], {
      anchorMessageId: "b",
      anchorOffset: -24,
      atLatest: false,
    }, ""),
    { kind: "anchor", index: 2, offset: -24 },
  );
});

test("a viewport that followed latest returns to the newest message", () => {
  assert.deepEqual(
    resolveScrollRestore(["a", "b"], { anchorMessageId: "a", anchorOffset: 0, atLatest: true }, "a"),
    { kind: "latest", index: 1 },
  );
});

test("a first visit prefers the unread boundary and otherwise uses latest", () => {
  assert.deepEqual(resolveScrollRestore(["a", "b", "c"], undefined, "b"), {
    kind: "unread",
    index: 1,
  });
  assert.deepEqual(resolveScrollRestore(["a", "b", "c"], undefined, "missing"), {
    kind: "latest",
    index: 2,
  });
});

test("a trimmed-away anchor falls back to the unread boundary", () => {
  assert.deepEqual(
    resolveScrollRestore(
      ["b", "c"],
      { anchorMessageId: "trimmed", anchorOffset: -10, atLatest: false },
      "b",
    ),
    { kind: "unread", index: 0 },
  );
});

