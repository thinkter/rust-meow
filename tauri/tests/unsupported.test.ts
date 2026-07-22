import assert from "node:assert/strict";
import test from "node:test";

import { parsePollFallback } from "../src/lib/unsupported.ts";

test("poll fallback preserves title and every option", () => {
  assert.deepEqual(parsePollFallback("📊 Poll: Lunch\n• Pizza\n• Sushi"), {
    title: "Lunch",
    options: ["Pizza", "Sushi"],
    results: false,
  });
});

test("poll result snapshots remain distinguishable", () => {
  assert.deepEqual(parsePollFallback("📊 Poll results: Lunch"), {
    title: "Lunch",
    options: [],
    results: true,
  });
});
