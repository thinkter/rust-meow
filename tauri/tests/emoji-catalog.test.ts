import assert from "node:assert/strict";
import test from "node:test";
import { EMOJI_CATEGORIES, EMOJI_ENTRIES } from "../src/lib/emoji-catalog.ts";

test("emoji catalog includes complete multi-codepoint emoji sequences", () => {
  const entries = new Set(EMOJI_ENTRIES.map(([emoji]) => emoji));
  for (const emoji of ["😀", "👍🏽", "🧑‍🚀", "🇺🇸", "1️⃣"]) {
    assert.ok(entries.has(emoji), `catalog is missing ${emoji}`);
  }
  assert.equal(entries.size, EMOJI_ENTRIES.length, "catalog must not duplicate emoji entries");
  assert.equal(EMOJI_CATEGORIES.length, 9);
});
