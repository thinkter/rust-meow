import assert from "node:assert/strict";
import test from "node:test";

import {
  parseWhatsAppText,
  type WhatsAppInlineSegment,
  type WhatsAppTextBlock,
} from "../src/lib/whatsapp-formatting.ts";

function segments(block: WhatsAppTextBlock): WhatsAppInlineSegment[] {
  assert.ok("segments" in block);
  return block.segments;
}

test("parses WhatsApp inline emphasis and nested formatting", () => {
  const [block] = parseWhatsAppText(
    "*bold* _italic_ ~gone~ ```mono``` `inline` *_both_*",
  );

  assert.deepEqual(segments(block!), [
    { kind: "text", text: "bold", styles: ["bold"] },
    { kind: "text", text: " ", styles: [] },
    { kind: "text", text: "italic", styles: ["italic"] },
    { kind: "text", text: " ", styles: [] },
    { kind: "text", text: "gone", styles: ["strikethrough"] },
    { kind: "text", text: " ", styles: [] },
    { kind: "text", text: "mono", styles: ["monospace"] },
    { kind: "text", text: " ", styles: [] },
    { kind: "text", text: "inline", styles: ["inline-code"] },
    { kind: "text", text: " ", styles: [] },
    { kind: "text", text: "both", styles: ["bold", "italic"] },
  ]);
});

test("parses quotes, bullet items, and one or two digit numbered items", () => {
  const blocks = parseWhatsAppText(
    "> *Important*\n- first\n1. one\n12. twelve\n123. not a list",
  );

  assert.deepEqual(blocks.map((block) => block.kind), [
    "quote",
    "bullet-list-item",
    "numbered-list-item",
    "numbered-list-item",
    "paragraph",
  ]);
  assert.deepEqual(blocks[0], {
    kind: "quote",
    segments: [{ kind: "text", text: "Important", styles: ["bold"] }],
  });
  assert.equal(blocks[2]?.kind === "numbered-list-item" ? blocks[2].number : -1, 1);
  assert.equal(blocks[3]?.kind === "numbered-list-item" ? blocks[3].number : -1, 12);
});

test("parses a multiline triple-backtick region as a code block", () => {
  assert.deepEqual(parseWhatsAppText("before\n```\nconst x = '<b>safe</b>';\n```\nafter"), [
    {
      kind: "paragraph",
      segments: [{ kind: "text", text: "before", styles: [] }],
    },
    { kind: "code-block", text: "const x = '<b>safe</b>';" },
    {
      kind: "paragraph",
      segments: [{ kind: "text", text: "after", styles: [] }],
    },
  ]);
});

test("keeps malformed and in-word delimiters as literal text", () => {
  const [block] = parseWhatsAppText(
    "*open _ spaced _ foo_bar_baz mid*word*here ~open",
  );

  assert.deepEqual(segments(block!), [
    {
      kind: "text",
      text: "*open _ spaced _ foo_bar_baz mid*word*here ~open",
      styles: [],
    },
  ]);
});

test("preserves URL syntax and trims sentence punctuation from the link", () => {
  const [block] = parseWhatsAppText(
    "*See https://example.com/a_path?q=~raw~*, then https://example.com/a_(b).",
  );

  assert.deepEqual(segments(block!), [
    { kind: "text", text: "See ", styles: ["bold"] },
    {
      kind: "link",
      text: "https://example.com/a_path?q=~raw~",
      href: "https://example.com/a_path?q=~raw~",
      styles: ["bold"],
    },
    { kind: "text", text: ", then ", styles: [] },
    {
      kind: "link",
      text: "https://example.com/a_(b)",
      href: "https://example.com/a_(b)",
      styles: [],
    },
    { kind: "text", text: ".", styles: [] },
  ]);
});

test("mentions are atomic, can inherit formatting, and do not match inside code or email", () => {
  const [block] = parseWhatsAppText(
    "*@Ann Lee* @Annabelle `@Ann` x@Ann",
    { mentions: ["Ann", "@Ann Lee"] },
  );

  assert.deepEqual(segments(block!), [
    {
      kind: "mention",
      text: "@Ann Lee",
      mention: "Ann Lee",
      styles: ["bold"],
    },
    { kind: "text", text: " @Annabelle ", styles: [] },
    { kind: "text", text: "@Ann", styles: ["inline-code"] },
    { kind: "text", text: " x@Ann", styles: [] },
  ]);
});

test("HTML-looking input is returned only as inert text tokens", () => {
  assert.deepEqual(parseWhatsAppText("<img src=x onerror=alert(1)> *<script>x</script>*"), [
    {
      kind: "paragraph",
      segments: [
        { kind: "text", text: "<img src=x onerror=alert(1)> ", styles: [] },
        { kind: "text", text: "<script>x</script>", styles: ["bold"] },
      ],
    },
  ]);
});
