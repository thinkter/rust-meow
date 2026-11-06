import assert from "node:assert/strict";
import test from "node:test";
import rawEmoji from "emojibase-data/en/compact.json" with { type: "json" };
import rawGithubShortcodes from "emojibase-data/en/shortcodes/github.json" with { type: "json" };
import { EMOJI_CATEGORIES, EMOJI_ENTRIES, EMOJI_LABELS } from "../src/lib/emoji-catalog.ts";
import { getEmojiAutocomplete, rankEmojiSuggestions } from "../src/lib/emoji-autocomplete.ts";

interface SourceVariant {
  hexcode: string;
  unicode: string;
  label: string;
}

interface SourceEmoji extends SourceVariant {
  group?: number;
  tags?: readonly string[];
  skins?: readonly SourceVariant[];
}

const sourceEmoji = rawEmoji as readonly SourceEmoji[];
const githubShortcodes = rawGithubShortcodes as Readonly<Record<string, string | readonly string[]>>;
const keywordsByGlyph = new Map(
  EMOJI_ENTRIES.map(([emoji, keywords]): [string, readonly string[]] => [emoji, keywords.split(" ")]),
);

/** Builds a glyph from emojibase hexcode notation, e.g. "1F1FA-1F1F8" is the US flag. */
function glyphFromHex(hexcode: string): string {
  return String.fromCodePoint(...hexcode.split("-").map((part) => Number.parseInt(part, 16)));
}

function topSuggestion(query: string): string | undefined {
  return rankEmojiSuggestions(query, EMOJI_ENTRIES, 1)[0]?.emoji;
}

test("emoji catalog includes complete multi-codepoint emoji sequences", () => {
  const entries = new Set(EMOJI_ENTRIES.map(([emoji]) => emoji));
  for (const emoji of ["😀", "👍🏽", "🧑‍🚀", "🇺🇸", "1️⃣"]) {
    assert.ok(entries.has(emoji), `catalog is missing ${emoji}`);
  }
  assert.equal(entries.size, EMOJI_ENTRIES.length, "catalog must not duplicate emoji entries");
  assert.equal(EMOJI_CATEGORIES.length, 9);
});

test("catalog holds every grouped emojibase sequence exactly once", () => {
  const expected = new Set<string>();
  for (const base of sourceEmoji) {
    if (base.group === undefined) continue;
    expected.add(base.unicode);
    for (const skin of base.skins ?? []) expected.add(skin.unicode);
  }

  const glyphs = EMOJI_ENTRIES.map(([emoji]) => emoji);
  assert.equal(new Set(glyphs).size, glyphs.length, "catalog must not repeat a glyph");
  assert.deepEqual(new Set(glyphs), expected);
});

test("categories keep their picker order", () => {
  assert.deepEqual(
    EMOJI_CATEGORIES.map(({ id }) => id),
    ["smileys", "people", "animals", "food", "travel", "activities", "objects", "symbols", "flags"],
  );
});

test("standalone skin-tone and hair components are browsable under People & body", () => {
  const people = EMOJI_CATEGORIES.find(({ id }) => id === "people");
  assert.ok(people);
  const glyphs = people.entries.map(([emoji]) => emoji);
  for (const component of ["🏻", "🏼", "🏽", "🏾", "🏿", "🦰", "🦱", "🦳", "🦲"]) {
    assert.ok(glyphs.includes(component), `People & body is missing component ${component}`);
  }
  assert.equal(EMOJI_LABELS.get(glyphFromHex("1F3FB")), "light skin tone");
  assert.equal(EMOJI_LABELS.get(glyphFromHex("1F9B0")), "red hair");
});

test("lone regional indicator letters stay out of the picker", () => {
  assert.equal(keywordsByGlyph.has(glyphFromHex("1F1E6")), false);
});

test("catalog includes skin tone, ZWJ, flag, keycap, and multi-tone sequences", () => {
  for (const hexcode of [
    "1F44D-1F3FD",
    "1F9D1-200D-1F680",
    "1F468-200D-1F469-200D-1F467",
    "1F3F3-FE0F-200D-1F308",
    "1F1FA-1F1F8",
    "1FAF1-1F3FB-200D-1FAF2-1F3FC",
  ]) {
    const glyph = glyphFromHex(hexcode);
    assert.ok(keywordsByGlyph.has(glyph), `catalog is missing ${glyph} (${hexcode})`);
  }
  assert.ok(keywordsByGlyph.has("1️⃣"), "catalog is missing the keycap 1️⃣");
  assert.equal(EMOJI_LABELS.get(glyphFromHex("1F44D-1F3FD")), "thumbs up: medium skin tone");
  assert.equal(EMOJI_LABELS.get(glyphFromHex("1F9D1-200D-1F680")), "astronaut");
});

test("every GitHub shortcode alias is a searchable keyword of its emoji", () => {
  const baseByHex = new Map(sourceEmoji.map((base): [string, SourceEmoji] => [base.hexcode, base]));
  for (const [hexcode, aliases] of Object.entries(githubShortcodes)) {
    const base = baseByHex.get(hexcode);
    assert.ok(base, `GitHub alias ${hexcode} has no emojibase entry`);
    const keywords = keywordsByGlyph.get(base.unicode);
    assert.ok(keywords, `catalog is missing ${base.unicode}`);
    for (const alias of typeof aliases === "string" ? [aliases] : aliases) {
      assert.ok(keywords.includes(alias), `${base.unicode} is missing :${alias}:`);
    }
  }
});

test("shortcode suggestions resolve GitHub aliases and CLDR names", () => {
  assert.equal(topSuggestion("rocket"), glyphFromHex("1F680"));
  assert.equal(topSuggestion("thumbsup"), glyphFromHex("1F44D"));
  assert.equal(topSuggestion("+1"), glyphFromHex("1F44D"));
  assert.equal(topSuggestion("heavy_exclamation_mark"), glyphFromHex("2757"));
  assert.equal(topSuggestion("woman_technologist"), glyphFromHex("1F469-200D-1F4BB"));

  const result = getEmojiAutocomplete("Launch :rocket", 14, EMOJI_ENTRIES);
  assert.equal(result?.match.token, ":rocket");
  assert.equal(result?.suggestions[0]?.emoji, glyphFromHex("1F680"));
  assert.equal(result?.suggestions[0]?.label, "rocket");
});
