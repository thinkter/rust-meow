import assert from "node:assert/strict";
import test from "node:test";
import {
  applyEmojiSuggestion,
  findActiveEmojiShortcode,
  getEmojiAutocomplete,
  rankEmojiSuggestions,
  type EmojiCatalogEntry,
} from "../src/lib/emoji-autocomplete.ts";

const catalog: readonly EmojiCatalogEntry[] = [
  ["😄", "grinning smiling eyes happy"],
  ["🙂", "slightly smiling happy"],
  ["❤️", "red heart love"],
  ["💛", "yellow heart"],
  ["💔", "broken heartbreak sad"],
  ["🔥", "fire hot lit"],
  ["😄", "duplicate should not appear"],
];

test("finds an active shortcode at the start or a sensible token boundary", () => {
  assert.deepEqual(findActiveEmojiShortcode(":smile", 6), {
    start: 0,
    end: 6,
    caret: 6,
    query: "smile",
    token: ":smile",
  });

  const text = "hello (:HEART world";
  assert.deepEqual(findActiveEmojiShortcode(text, 13), {
    start: 7,
    end: 13,
    caret: 13,
    query: "heart",
    token: ":HEART",
  });
});

test("a bare colon activates autocomplete", () => {
  assert.deepEqual(findActiveEmojiShortcode("hello :", 7), {
    start: 6,
    end: 7,
    caret: 7,
    query: "",
    token: ":",
  });
});

test("ignores URLs, times, and colons embedded in words", () => {
  assert.equal(findActiveEmojiShortcode("https://example.com", 6), null);
  assert.equal(findActiveEmojiShortcode("meet at 12:30", 13), null);
  assert.equal(findActiveEmojiShortcode("namespace:value", 15), null);
  assert.equal(findActiveEmojiShortcode("word.:heart", 11), null);
});

test("rejects unsupported shortcode characters and invalid carets", () => {
  assert.equal(findActiveEmojiShortcode("hello :two words", 16), null);
  assert.equal(findActiveEmojiShortcode("hello :smile", -1), null);
  assert.equal(findActiveEmojiShortcode("hello :smile", 99), null);
  assert.equal(findActiveEmojiShortcode(`:${"a".repeat(49)}`, 50), null);
});

test("detects and replaces the whole token when editing in its middle", () => {
  const text = "before :smiley after";
  const match = findActiveEmojiShortcode(text, 11);
  assert.ok(match);
  assert.equal(match.query, "smi");
  assert.equal(match.token, ":smiley");

  assert.deepEqual(applyEmojiSuggestion(text, match, "😄"), {
    text: "before 😄 after",
    caret: 9,
  });
});

test("replacement preserves all surrounding text and reports a UTF-16 caret", () => {
  const text = "one :heart two";
  const match = findActiveEmojiShortcode(text, 10);
  assert.ok(match);
  assert.deepEqual(applyEmojiSuggestion(text, match, "❤️"), {
    text: "one ❤️ two",
    caret: 6,
  });
});

test("replacement refuses a stale match rather than overwriting changed text", () => {
  const match = findActiveEmojiShortcode("say :heart", 10);
  assert.ok(match);
  assert.deepEqual(applyEmojiSuggestion("say :smile", match, "❤️"), {
    text: "say :smile",
    caret: 10,
  });
});

test("ranks exact keyword, prefix, then substring matches stably", () => {
  assert.deepEqual(
    rankEmojiSuggestions("heart", catalog).map(({ emoji, label }) => [emoji, label]),
    [
      ["❤️", "heart"],
      ["💛", "heart"],
      ["💔", "heartbreak"],
    ],
  );

  assert.deepEqual(
    rankEmojiSuggestions("light", catalog).map(({ emoji, label }) => [emoji, label]),
    [["🙂", "slightly"]],
  );
});

test("deduplicates glyphs, honors the result limit, and handles a bare query", () => {
  assert.deepEqual(
    rankEmojiSuggestions("", catalog, 2).map(({ emoji }) => emoji),
    ["😄", "🙂"],
  );
  assert.deepEqual(
    rankEmojiSuggestions("smil", catalog).map(({ emoji }) => emoji),
    ["😄", "🙂"],
  );
  assert.deepEqual(rankEmojiSuggestions("heart", catalog, 0), []);
});

test("integration helper returns the active match with ranked suggestions", () => {
  const result = getEmojiAutocomplete("Love :hea today", 9, catalog, 3);
  assert.ok(result);
  assert.equal(result.match.token, ":hea");
  assert.deepEqual(result.suggestions.map(({ emoji }) => emoji), ["❤️", "💛", "💔"]);
  assert.equal(getEmojiAutocomplete("https://", 6, catalog), null);
});
