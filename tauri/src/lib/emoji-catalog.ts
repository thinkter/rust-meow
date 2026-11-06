import rawEmoji from "emojibase-data/en/compact.json" with { type: "json" };
import rawGithubShortcodes from "emojibase-data/en/shortcodes/github.json" with { type: "json" };

/**
 * One emoji glyph plus its space-separated, lowercase search keywords. This is
 * the shape shared by the picker and composer autocomplete; the glyph is the
 * complete emoji sequence (skin tones, ZWJ sequences, flags, keycaps included).
 */
export type EmojiCatalogEntry = readonly [emoji: string, keywords: string];

export interface EmojiCatalogCategory {
  id: string;
  label: string;
  /** Representative glyph shown on the jump-strip button. */
  icon: string;
  entries: readonly EmojiCatalogEntry[];
}

/**
 * Subset of the emojibase compact schema this module reads. Source: the
 * `emojibase-data` package (MIT), which derives from Unicode's emoji-test data
 * and CLDR names/annotations. Pinned exactly in package.json.
 */
interface RawEmojiVariant {
  hexcode: string;
  label: string;
  unicode: string;
  order?: number;
}

interface RawEmoji extends RawEmojiVariant {
  group?: number;
  tags?: readonly string[];
  skins?: readonly RawEmojiVariant[];
}

interface CategoryDefinition {
  id: string;
  label: string;
  icon: string;
  /**
   * emojibase group numbers merged into this category. Group 2 (components:
   * skin-tone swatches and hair styles) is browsed with People & body, so the
   * category list and jump strip keep their existing shape.
   */
  groups: readonly number[];
}

const CATEGORY_DEFINITIONS: readonly CategoryDefinition[] = [
  { id: "smileys", label: "Smileys & emotion", icon: "😀", groups: [0] },
  { id: "people", label: "People & body", icon: "👋", groups: [1, 2] },
  { id: "animals", label: "Animals & nature", icon: "🐶", groups: [3] },
  { id: "food", label: "Food & drink", icon: "🍕", groups: [4] },
  { id: "travel", label: "Travel & places", icon: "✈️", groups: [5] },
  { id: "activities", label: "Activities", icon: "⚽", groups: [6] },
  { id: "objects", label: "Objects", icon: "💡", groups: [7] },
  { id: "symbols", label: "Symbols", icon: "✅", groups: [8] },
  { id: "flags", label: "Flags", icon: "🏁", groups: [9] },
];

const RAW_EMOJI = rawEmoji as readonly RawEmoji[];

/**
 * GitHub shortcode aliases keyed by base hexcode, e.g. `"1F680": "rocket"` or
 * `"2757": ["exclamation", "heavy_exclamation_mark"]`. Every key is a base
 * hexcode in the compact dataset.
 */
const GITHUB_SHORTCODES = rawGithubShortcodes as Readonly<Record<string, string | readonly string[]>>;

function byOrder<T extends { order?: number }>(left: T, right: T): number {
  return (left.order ?? 0) - (right.order ?? 0);
}

function githubAliasesFor(hexcode: string): readonly string[] {
  const aliases = GITHUB_SHORTCODES[hexcode];
  if (!aliases) return [];
  return typeof aliases === "string" ? [aliases] : aliases;
}

/**
 * Lowercased search tokens: CLDR label words and annotation tags, then GitHub
 * aliases kept whole (underscores included) so `:woman_technologist:` matches
 * as one token.
 */
function keywordTokens(label: string, tags: readonly string[], aliases: readonly string[]): string[] {
  const words = [label, ...tags]
    .join(" ")
    .toLocaleLowerCase()
    .replace(/[:,]/g, " ")
    .split(/\s+/)
    .filter(Boolean);
  return [...words, ...aliases.map((alias) => alias.toLocaleLowerCase())];
}

interface CatalogDraft {
  categoryIndex: number;
  label: string;
  keywords: Set<string>;
}

function buildCategories(): {
  categories: readonly EmojiCatalogCategory[];
  labels: ReadonlyMap<string, string>;
} {
  const categoryIndexByGroup = new Map<number, number>();
  CATEGORY_DEFINITIONS.forEach((definition, categoryIndex) => {
    for (const group of definition.groups) categoryIndexByGroup.set(group, categoryIndex);
  });

  // Keyed by complete glyph: a sequence seen twice is emitted once, with merged keywords.
  const drafts = new Map<string, CatalogDraft>();
  const addGlyph = (glyph: string, categoryIndex: number, label: string, keywords: readonly string[]) => {
    const existing = drafts.get(glyph);
    if (existing) {
      for (const keyword of keywords) existing.keywords.add(keyword);
      return;
    }
    drafts.set(glyph, { categoryIndex, label, keywords: new Set(keywords) });
  };

  for (const base of [...RAW_EMOJI].sort(byOrder)) {
    // Ungrouped entries (the regional indicator letters) are not emoji sequences
    // on their own; a lone letter is not a meaningful picker item, so they stay out.
    const categoryIndex = base.group === undefined ? undefined : categoryIndexByGroup.get(base.group);
    if (categoryIndex === undefined) continue;

    const tags = base.tags ?? [];
    addGlyph(base.unicode, categoryIndex, base.label, keywordTokens(base.label, tags, githubAliasesFor(base.hexcode)));

    // Skin-tone and multi-tone variants sit directly after their base emoji, matching CLDR order.
    // Aliases stay on the base: `:+1:` suggests 👍, not every skin tone of it.
    for (const variant of [...(base.skins ?? [])].sort(byOrder)) {
      addGlyph(variant.unicode, categoryIndex, variant.label, keywordTokens(variant.label, tags, []));
    }
  }

  const labels = new Map<string, string>();
  for (const [glyph, draft] of drafts) labels.set(glyph, draft.label);

  const categories = CATEGORY_DEFINITIONS.map(({ id, label, icon }, categoryIndex) => ({
    id,
    label,
    icon,
    entries: Object.freeze(
      [...drafts]
        .filter(([, draft]) => draft.categoryIndex === categoryIndex)
        .map(([glyph, draft]): EmojiCatalogEntry => [glyph, [...draft.keywords].join(" ")]),
    ),
  }));

  return { categories: Object.freeze(categories), labels };
}

const BUILT = buildCategories();

/** Browsable categories, in picker order. Each entry list is in CLDR order. */
export const EMOJI_CATEGORIES: readonly EmojiCatalogCategory[] = BUILT.categories;

/** Every browsable emoji (including skin-tone and multi-person variants), flattened in category order. */
export const EMOJI_ENTRIES: readonly EmojiCatalogEntry[] = Object.freeze(
  BUILT.categories.flatMap((category) => category.entries),
);

/** Human-readable CLDR name per glyph, used for accessible labels. */
export const EMOJI_LABELS: ReadonlyMap<string, string> = BUILT.labels;
