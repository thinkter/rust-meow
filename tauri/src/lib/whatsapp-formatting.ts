/**
 * A small, deliberately non-HTML WhatsApp text-formatting parser.
 *
 * Consumers should render these tokens with Solid elements and `textContent`.
 * Never concatenate token text into `innerHTML`.
 */

export type WhatsAppInlineStyle =
  | "bold"
  | "italic"
  | "strikethrough"
  | "monospace"
  | "inline-code";

interface InlineSegmentBase {
  text: string;
  styles: WhatsAppInlineStyle[];
}

export interface WhatsAppTextSegment extends InlineSegmentBase {
  kind: "text";
}

export interface WhatsAppLinkSegment extends InlineSegmentBase {
  kind: "link";
  href: string;
}

export interface WhatsAppMentionSegment extends InlineSegmentBase {
  kind: "mention";
  /** The mention label without its leading `@`. */
  mention: string;
}

export type WhatsAppInlineSegment =
  | WhatsAppTextSegment
  | WhatsAppLinkSegment
  | WhatsAppMentionSegment;

export interface WhatsAppParagraphBlock {
  kind: "paragraph";
  segments: WhatsAppInlineSegment[];
}

export interface WhatsAppQuoteBlock {
  kind: "quote";
  segments: WhatsAppInlineSegment[];
}

export interface WhatsAppBulletListItemBlock {
  kind: "bullet-list-item";
  segments: WhatsAppInlineSegment[];
}

export interface WhatsAppNumberedListItemBlock {
  kind: "numbered-list-item";
  number: number;
  segments: WhatsAppInlineSegment[];
}

export interface WhatsAppCodeBlock {
  kind: "code-block";
  text: string;
}

export interface WhatsAppBlankLineBlock {
  kind: "blank-line";
}

export type WhatsAppTextBlock =
  | WhatsAppParagraphBlock
  | WhatsAppQuoteBlock
  | WhatsAppBulletListItemBlock
  | WhatsAppNumberedListItemBlock
  | WhatsAppCodeBlock
  | WhatsAppBlankLineBlock;

export interface WhatsAppParseOptions {
  /**
   * Display labels supplied by WhatsApp message metadata. Labels may be passed
   * with or without `@`; longest labels win when names overlap.
   */
  mentions?: readonly string[];
}

interface ParserContext {
  mentions: string[];
}

const delimiterStyles: Readonly<Record<string, WhatsAppInlineStyle>> = {
  "*": "bold",
  _: "italic",
  "~": "strikethrough",
};

/**
 * Parses WhatsApp's plain-text formatting into render-safe blocks and inline
 * segments. No source string is ever treated as markup or executable HTML.
 */
export function parseWhatsAppText(
  source: string,
  options: WhatsAppParseOptions = {},
): WhatsAppTextBlock[] {
  const context: ParserContext = {
    mentions: normalizeMentions(options.mentions ?? []),
  };
  const blocks: WhatsAppTextBlock[] = [];
  let normalStart = 0;
  let searchFrom = 0;

  while (searchFrom < source.length) {
    const opening = source.indexOf("```", searchFrom);
    if (opening < 0) break;
    const closing = source.indexOf("```", opening + 3);
    if (closing < 0) break;
    const content = source.slice(opening + 3, closing);

    if (
      content.includes("\n") &&
      isBlockBoundaryBefore(source, opening) &&
      isBlockBoundaryAfter(source, closing + 3)
    ) {
      appendLineBlocks(blocks, source.slice(normalStart, opening), context, normalStart > 0);
      blocks.push({ kind: "code-block", text: stripFenceNewlines(content) });
      normalStart = closing + 3;
      searchFrom = normalStart;
      continue;
    }

    searchFrom = closing + 3;
  }

  appendLineBlocks(blocks, source.slice(normalStart), context, normalStart > 0);
  return blocks;
}

function appendLineBlocks(
  output: WhatsAppTextBlock[],
  source: string,
  context: ParserContext,
  chunkStartsAfterCodeBlock: boolean,
): void {
  if (source.length === 0) return;

  let lines = source.split("\n");
  if (chunkStartsAfterCodeBlock && lines[0] === "") lines = lines.slice(1);
  if (lines.at(-1) === "" && source.endsWith("\n")) lines = lines.slice(0, -1);

  for (const line of lines) {
    if (line === "") {
      output.push({ kind: "blank-line" });
      continue;
    }

    if (line.startsWith("> ")) {
      output.push({
        kind: "quote",
        segments: parseInline(line.slice(2), context),
      });
      continue;
    }

    if (line.startsWith("- ")) {
      output.push({
        kind: "bullet-list-item",
        segments: parseInline(line.slice(2), context),
      });
      continue;
    }

    const numbered = /^(\d{1,2})\. (.*)$/u.exec(line);
    if (numbered) {
      output.push({
        kind: "numbered-list-item",
        number: Number(numbered[1]),
        segments: parseInline(numbered[2] ?? "", context),
      });
      continue;
    }

    output.push({ kind: "paragraph", segments: parseInline(line, context) });
  }
}

function parseInline(
  source: string,
  context: ParserContext,
  styles: WhatsAppInlineStyle[] = [],
): WhatsAppInlineSegment[] {
  const output: WhatsAppInlineSegment[] = [];
  let plainStart = 0;
  let index = 0;

  const flushPlain = (end: number) => {
    if (end <= plainStart) return;
    appendLexicalSegments(output, source.slice(plainStart, end), styles, context);
  };

  while (index < source.length) {
    if (source.startsWith("http://", index) || source.startsWith("https://", index)) {
      const link = readHttpUrl(source, index);
      if (link) {
        flushPlain(index);
        pushSegment(output, {
          kind: "link",
          text: link.text,
          href: link.href,
          styles: [...styles],
        });
        index = link.end;
        plainStart = index;
        continue;
      }
    }

    const codeDelimiter = source.startsWith("```", index) ? "```" : source[index] === "`" ? "`" : "";
    if (codeDelimiter && isOpeningDelimiter(source, index, codeDelimiter.length)) {
      const closing = findClosingCodeDelimiter(source, index + codeDelimiter.length, codeDelimiter);
      if (closing >= 0) {
        flushPlain(index);
        const content = source.slice(index + codeDelimiter.length, closing);
        pushSegment(output, {
          kind: "text",
          text: content,
          styles: [
            ...styles,
            codeDelimiter === "```" ? "monospace" : "inline-code",
          ],
        });
        index = closing + codeDelimiter.length;
        plainStart = index;
        continue;
      }
    }

    const delimiter = source[index] ?? "";
    const style = delimiterStyles[delimiter];
    if (style && isOpeningDelimiter(source, index, 1)) {
      const closing = findClosingStyleDelimiter(source, index + 1, delimiter);
      if (closing >= 0) {
        flushPlain(index);
        const inner = source.slice(index + 1, closing);
        const nestedStyles = styles.includes(style) ? styles : [...styles, style];
        for (const segment of parseInline(inner, context, nestedStyles)) {
          pushSegment(output, segment);
        }
        index = closing + 1;
        plainStart = index;
        continue;
      }
    }

    index += 1;
  }

  flushPlain(source.length);
  return output;
}

function appendLexicalSegments(
  output: WhatsAppInlineSegment[],
  source: string,
  styles: WhatsAppInlineStyle[],
  context: ParserContext,
): void {
  let plainStart = 0;
  let index = 0;

  const flushText = (end: number) => {
    if (end <= plainStart) return;
    pushSegment(output, {
      kind: "text",
      text: source.slice(plainStart, end),
      styles: [...styles],
    });
  };

  while (index < source.length) {
    if (source.startsWith("http://", index) || source.startsWith("https://", index)) {
      const link = readHttpUrl(source, index);
      if (link) {
        flushText(index);
        pushSegment(output, {
          kind: "link",
          text: link.text,
          href: link.href,
          styles: [...styles],
        });
        index = link.end;
        plainStart = index;
        continue;
      }
    }

    const mention = readMention(source, index, context.mentions);
    if (mention) {
      flushText(index);
      pushSegment(output, {
        kind: "mention",
        text: mention.text,
        mention: mention.name,
        styles: [...styles],
      });
      index = mention.end;
      plainStart = index;
      continue;
    }

    index += 1;
  }

  flushText(source.length);
}

function findClosingStyleDelimiter(source: string, start: number, delimiter: string): number {
  let index = start;
  while (index < source.length) {
    if (source.startsWith("http://", index) || source.startsWith("https://", index)) {
      const link = readHttpUrl(source, index);
      if (link) {
        const possibleClosing = link.end - delimiter.length;
        if (
          link.text.endsWith(delimiter) &&
          isClosingDelimiter(source, possibleClosing, delimiter.length)
        ) {
          return possibleClosing;
        }
        index = link.end;
        continue;
      }
    }
    if (source[index] === delimiter && isClosingDelimiter(source, index, 1)) return index;
    index += 1;
  }
  return -1;
}

function findClosingCodeDelimiter(source: string, start: number, delimiter: string): number {
  let index = source.indexOf(delimiter, start);
  while (index >= 0) {
    if (isClosingDelimiter(source, index, delimiter.length)) return index;
    index = source.indexOf(delimiter, index + delimiter.length);
  }
  return -1;
}

function isOpeningDelimiter(source: string, index: number, length: number): boolean {
  const before = source[index - 1];
  const after = source[index + length];
  return (
    after !== undefined &&
    !isWhitespace(after) &&
    (before === undefined || !isWordCharacter(before))
  );
}

function isClosingDelimiter(source: string, index: number, length: number): boolean {
  const before = source[index - 1];
  const after = source[index + length];
  return (
    before !== undefined &&
    !isWhitespace(before) &&
    (after === undefined || !isWordCharacter(after))
  );
}

function isWhitespace(value: string): boolean {
  return /\s/u.test(value);
}

function isWordCharacter(value: string): boolean {
  return /[\p{L}\p{N}]/u.test(value);
}

function readHttpUrl(
  source: string,
  index: number,
): { text: string; href: string; end: number } | undefined {
  const before = source[index - 1];
  if (before !== undefined && (isWordCharacter(before) || before === "@" || before === "_")) {
    return undefined;
  }

  const match = /^https?:\/\/[^\s]+/iu.exec(source.slice(index));
  if (!match) return undefined;
  const raw = trimUrlPunctuation(match[0]);
  if (raw.length === 0) return undefined;

  try {
    const url = new URL(raw);
    if (url.protocol !== "http:" && url.protocol !== "https:") return undefined;
    return { text: raw, href: url.href, end: index + raw.length };
  } catch {
    return undefined;
  }
}

function trimUrlPunctuation(value: string): string {
  let result = value.replace(/[.,!?;:]+$/u, "");
  const pairs: ReadonlyArray<readonly [string, string]> = [
    ["(", ")"],
    ["[", "]"],
    ["{", "}"],
  ];
  let changed = true;
  while (changed) {
    changed = false;
    for (const [opening, closing] of pairs) {
      if (
        result.endsWith(closing) &&
        countCharacter(result, closing) > countCharacter(result, opening)
      ) {
        result = result.slice(0, -1);
        changed = true;
      }
    }
  }
  return result;
}

function countCharacter(value: string, character: string): number {
  let count = 0;
  for (const current of value) {
    if (current === character) count += 1;
  }
  return count;
}

function readMention(
  source: string,
  index: number,
  mentions: readonly string[],
): { text: string; name: string; end: number } | undefined {
  if (source[index] !== "@") return undefined;
  const before = source[index - 1];
  if (before !== undefined && isWordCharacter(before)) return undefined;

  for (const name of mentions) {
    const text = `@${name}`;
    if (!source.startsWith(text, index)) continue;
    const after = source[index + text.length];
    if (after !== undefined && isWordCharacter(after)) continue;
    return { text, name, end: index + text.length };
  }
  return undefined;
}

function normalizeMentions(mentions: readonly string[]): string[] {
  return [
    ...new Set(
      mentions
        .map((mention) => mention.trim().replace(/^@/u, ""))
        .filter((mention) => mention.length > 0),
    ),
  ].sort((left, right) => right.length - left.length);
}

function isBlockBoundaryBefore(source: string, index: number): boolean {
  return index === 0 || source[index - 1] === "\n";
}

function isBlockBoundaryAfter(source: string, index: number): boolean {
  return index === source.length || source[index] === "\n";
}

function stripFenceNewlines(value: string): string {
  const withoutLeading = value.startsWith("\n") ? value.slice(1) : value;
  return withoutLeading.endsWith("\n") ? withoutLeading.slice(0, -1) : withoutLeading;
}

function pushSegment(
  output: WhatsAppInlineSegment[],
  segment: WhatsAppInlineSegment,
): void {
  if (segment.text.length === 0) return;
  const previous = output.at(-1);
  if (
    previous?.kind === "text" &&
    segment.kind === "text" &&
    sameStyles(previous.styles, segment.styles)
  ) {
    previous.text += segment.text;
    return;
  }
  output.push(segment);
}

function sameStyles(
  left: readonly WhatsAppInlineStyle[],
  right: readonly WhatsAppInlineStyle[],
): boolean {
  return left.length === right.length && left.every((style, index) => style === right[index]);
}
