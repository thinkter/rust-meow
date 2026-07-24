export type EmojiCatalogEntry = readonly [emoji: string, keywords: string];

export interface ActiveEmojiShortcode {
  /** Inclusive offset of the leading colon. */
  start: number;
  /** Exclusive offset of the complete token, including text after the caret. */
  end: number;
  /** Caret offset used to derive the query. */
  caret: number;
  /** Text between the leading colon and the caret, normalized to lowercase. */
  query: string;
  /** Complete token that will be replaced when a suggestion is accepted. */
  token: string;
}

export interface EmojiSuggestion {
  emoji: string;
  /** Best matching keyword, useful as the human-readable suggestion label. */
  label: string;
  keywords: readonly string[];
}

export interface EmojiAutocomplete {
  match: ActiveEmojiShortcode;
  suggestions: EmojiSuggestion[];
}

export interface EmojiAutocompleteReplacement {
  text: string;
  /** Collapsed selection position immediately after the inserted emoji. */
  caret: number;
}

const MAX_QUERY_LENGTH = 48;
const SHORTCODE_CHARACTER = /[A-Za-z0-9_+-]/;
const TOKEN_BOUNDARY = /[\s([{'"\u2018\u201c]/;

/**
 * Finds the colon shortcode currently being edited at `caret`.
 *
 * A shortcode must begin at the start of the draft or after whitespace/opening
 * punctuation. Its body is deliberately ASCII-compatible with familiar emoji
 * shortcodes. These constraints prevent false positives in URLs, times, and
 * words such as `https://`, `12:30`, and `namespace:value`.
 */
export function findActiveEmojiShortcode(
  text: string,
  caret: number,
): ActiveEmojiShortcode | null {
  if (!Number.isInteger(caret) || caret < 0 || caret > text.length) return null;

  let start = caret - 1;
  while (start >= 0 && SHORTCODE_CHARACTER.test(text[start])) start -= 1;
  if (start < 0 || text[start] !== ":") return null;

  const boundary = start === 0 ? "" : text[start - 1];
  if (start > 0 && !TOKEN_BOUNDARY.test(boundary)) return null;

  const query = text.slice(start + 1, caret);
  if (query.length > MAX_QUERY_LENGTH) return null;

  let end = caret;
  while (end < text.length && SHORTCODE_CHARACTER.test(text[end])) end += 1;

  return {
    start,
    end,
    caret,
    query: query.toLocaleLowerCase(),
    token: text.slice(start, end),
  };
}

/**
 * Ranks the picker catalog for a shortcode query.
 *
 * Exact keyword matches come first, followed by word-prefix matches and then
 * substring matches. Catalog order breaks ties, so results remain stable.
 */
export function rankEmojiSuggestions(
  query: string,
  entries: readonly EmojiCatalogEntry[],
  limit = 8,
): EmojiSuggestion[] {
  if (!Number.isInteger(limit) || limit <= 0) return [];

  const normalizedQuery = query.trim().toLocaleLowerCase();
  const ranked: Array<EmojiSuggestion & { score: number; order: number }> = [];
  const seen = new Set<string>();

  for (const [emoji, keywordText] of entries) {
    if (seen.has(emoji)) continue;

    const keywords = keywordText
      .toLocaleLowerCase()
      .split(/\s+/)
      .filter(Boolean);
    const match = bestKeywordMatch(normalizedQuery, keywords);
    if (!match) continue;

    seen.add(emoji);
    ranked.push({
      emoji,
      label: match.keyword,
      keywords,
      score: match.score,
      order: ranked.length,
    });
  }

  return ranked
    .sort((left, right) => left.score - right.score || left.order - right.order)
    .slice(0, limit)
    .map(({ emoji, label, keywords }) => ({ emoji, label, keywords }));
}

/** Resolves the active token and ranked suggestions in one integration call. */
export function getEmojiAutocomplete(
  text: string,
  caret: number,
  entries: readonly EmojiCatalogEntry[],
  limit = 8,
): EmojiAutocomplete | null {
  const match = findActiveEmojiShortcode(text, caret);
  if (!match) return null;
  return {
    match,
    suggestions: rankEmojiSuggestions(match.query, entries, limit),
  };
}

/**
 * Replaces exactly the matched token, including any token characters after the
 * caret, and returns the draft plus the collapsed caret position to restore.
 */
export function applyEmojiSuggestion(
  text: string,
  match: ActiveEmojiShortcode,
  emoji: string,
): EmojiAutocompleteReplacement {
  if (
    !emoji
    || match.start < 0
    || match.end < match.start
    || match.end > text.length
    || text.slice(match.start, match.end) !== match.token
  ) {
    return { text, caret: Math.max(0, Math.min(match.caret, text.length)) };
  }

  return {
    text: `${text.slice(0, match.start)}${emoji}${text.slice(match.end)}`,
    caret: match.start + emoji.length,
  };
}

function bestKeywordMatch(
  query: string,
  keywords: readonly string[],
): { keyword: string; score: number } | null {
  if (keywords.length === 0) return null;
  if (!query) return { keyword: keywords[0], score: 3 };

  const exact = keywords.find((keyword) => keyword === query);
  if (exact) return { keyword: exact, score: 0 };

  const prefix = keywords.find((keyword) => keyword.startsWith(query));
  if (prefix) return { keyword: prefix, score: 1 };

  const substring = keywords.find((keyword) => keyword.includes(query));
  if (substring) return { keyword: substring, score: 2 };

  return null;
}
