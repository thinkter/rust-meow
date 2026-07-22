import assert from "node:assert/strict";
import test from "node:test";
import {
  SendIdempotency,
  type SendPayload,
} from "../src/lib/send-idempotency.ts";

const payloads: SendPayload[] = [
  ["text", "hello", "reply-1", ["person@s.whatsapp.net"]],
  ["image", "/tmp/photo.jpg", "caption", "reply-1"],
  ["sticker", "/tmp/sticker.webp", "reply-1"],
  ["attachment", "/tmp/notes.pdf", 1, "caption", "reply-1", false],
  ["poll", "Lunch?", ["Pizza", "Sushi"], 1],
];

test("every send kind reuses its ID for a failed logical retry", async () => {
  for (const payload of payloads) {
    let sequence = 0;
    const ids = new SendIdempotency(() => `request-${++sequence}`);
    const observed: string[] = [];

    await assert.rejects(
      ids.run("chat-1", payload, async (clientMessageId) => {
        observed.push(clientMessageId);
        throw new Error("response lost");
      }),
      /response lost/,
    );
    await ids.run("chat-1", payload, async (clientMessageId) => {
      observed.push(clientMessageId);
    });

    assert.equal(observed[0], observed[1], `retry ID changed for ${payload[0]}`);
  }
});

test("a confirmed send followed by the same payload is a new send", async () => {
  let sequence = 0;
  const ids = new SendIdempotency(() => `request-${++sequence}`);
  const observed: string[] = [];
  const payload = payloads[0];

  await ids.run("chat-1", payload, async (clientMessageId) => {
    observed.push(clientMessageId);
  });
  await ids.run("chat-1", payload, async (clientMessageId) => {
    observed.push(clientMessageId);
  });

  assert.notEqual(observed[0], observed[1]);
});

test("changing any logical payload selects a fresh ID after failure", async () => {
  const cases: Array<{ base: SendPayload; variants: SendPayload[] }> = [
    {
      base: payloads[0],
      variants: [
        ["text", "edited", "reply-1", ["person@s.whatsapp.net"]],
        ["text", "hello", "reply-2", ["person@s.whatsapp.net"]],
        ["text", "hello", "reply-1", ["other@s.whatsapp.net"]],
      ],
    },
    {
      base: payloads[1],
      variants: [
        ["image", "/tmp/other-photo.jpg", "caption", "reply-1"],
        ["image", "/tmp/photo.jpg", "edited caption", "reply-1"],
        ["image", "/tmp/photo.jpg", "caption", "reply-2"],
      ],
    },
    {
      base: payloads[2],
      variants: [
        ["sticker", "/tmp/other-sticker.webp", "reply-1"],
        ["sticker", "/tmp/sticker.webp", "reply-2"],
      ],
    },
    {
      base: payloads[3],
      variants: [
        ["attachment", "/tmp/other.pdf", 1, "caption", "reply-1", false],
        ["attachment", "/tmp/notes.pdf", 2, "caption", "reply-1", false],
        ["attachment", "/tmp/notes.pdf", 1, "edited caption", "reply-1", false],
        ["attachment", "/tmp/notes.pdf", 1, "caption", "reply-2", false],
        ["attachment", "/tmp/notes.pdf", 1, "caption", "reply-1", true],
      ],
    },
  ];

  for (const { base, variants } of cases) {
    for (const variant of variants) {
      let sequence = 0;
      const ids = new SendIdempotency(() => `request-${++sequence}`);
      let failedId = "";
      let changedId = "";

      await assert.rejects(
        ids.run("chat-1", base, async (clientMessageId) => {
          failedId = clientMessageId;
          throw new Error("response lost");
        }),
      );
      await ids.run("chat-1", variant, async (clientMessageId) => {
        changedId = clientMessageId;
      });

      assert.notEqual(failedId, changedId, `changed ${base[0]} reused its prior ID`);
    }
  }
});
