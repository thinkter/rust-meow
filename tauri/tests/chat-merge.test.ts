import assert from "node:assert/strict";
import test from "node:test";
import { clearMergedPollVotes } from "../src/lib/chat-merge.ts";

test("chat merge cancels old poll intents without losing canonical work", () => {
  assert.deepEqual(clearMergedPollVotes({ "old:a": true, "new:a": false, "new:b": true }, "old"), {
    "new:a": false,
    "new:b": true,
  });
});
