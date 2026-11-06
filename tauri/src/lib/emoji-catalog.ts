import rawEmoji from "emojibase-data/en/compact.json" with { type: "json" };

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
  /** emojibase group number; group 2 (components: skin tones, hair) and ungrouped regional indicators are not browsable. */
  group: number;
}

const CATEGORY_DEFINITIONS: readonly CategoryDefinition[] = [
  { id: "smileys", label: "Smileys & emotion", icon: "😀", group: 0 },
  { id: "people", label: "People & body", icon: "👋", group: 1 },
  { id: "animals", label: "Animals & nature", icon: "🐶", group: 3 },
  { id: "food", label: "Food & drink", icon: "🍕", group: 4 },
  { id: "travel", label: "Travel & places", icon: "✈️", group: 5 },
  { id: "activities", label: "Activities", icon: "⚽", group: 6 },
  { id: "objects", label: "Objects", icon: "💡", group: 7 },
  { id: "symbols", label: "Symbols", icon: "✅", group: 8 },
  { id: "flags", label: "Flags", icon: "🏁", group: 9 },
];

const RAW_EMOJI = rawEmoji as readonly RawEmoji[];

function byOrder<T extends { order?: number }>(left: T, right: T): number {
  return (left.order ?? 0) - (right.order ?? 0);
}

/** Lowercased, punctuation-free keyword text: CLDR label words plus annotation tags. */
function keywordsFor(label: string, tags: readonly string[]): string {
  return [label, ...tags]
    .join(" ")
    .toLocaleLowerCase()
    .replace(/[:,]/g, " ")
    .split(/\s+/)
    .filter(Boolean)
    .join(" ");
}

function buildCategories(): {
  categories: readonly EmojiCatalogCategory[];
  labels: ReadonlyMap<string, string>;
} {
  const labels = new Map<string, string>();
  const buckets = new Map<number, EmojiCatalogEntry[]>(
    CATEGORY_DEFINITIONS.map((definition) => [definition.group, []]),
  );

  for (const base of [...RAW_EMOJI].sort(byOrder)) {
    const bucket = base.group === undefined ? undefined : buckets.get(base.group);
    if (!bucket) continue;

    const tags = base.tags ?? [];
    bucket.push([base.unicode, keywordsFor(base.label, tags)]);
    labels.set(base.unicode, base.label);

    // Skin-tone variants sit directly after their base emoji, matching CLDR order.
    for (const variant of [...(base.skins ?? [])].sort(byOrder)) {
      bucket.push([variant.unicode, keywordsFor(variant.label, tags)]);
      labels.set(variant.unicode, variant.label);
    }
  }

  const categories = CATEGORY_DEFINITIONS.map(({ id, label, icon, group }) => ({
    id,
    label,
    icon,
    entries: Object.freeze(buckets.get(group) ?? []),
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
