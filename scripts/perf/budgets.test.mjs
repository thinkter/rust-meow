import assert from "node:assert/strict";
import test from "node:test";
import { evaluateBudgets, percentile, rendererMeasurements } from "./budgets.mjs";

test("p95 uses the nearest-rank definition and rejects empty data", () => {
  assert.equal(percentile([1, 2, 3, 4, 100], 95), 100);
  assert.equal(percentile(Array.from({ length: 100 }, (_, index) => index + 1), 95), 95);
  assert.equal(percentile([], 95), null);
});

test("renderer aggregation identifies the exact slow-frame percentage", () => {
  const measurements = rendererMeasurements([{
    coldStartToUsableMs: 500,
    cachedChatSwitchMs: [20, 40],
    eventToVisibleRowMs: [10, 30],
    scrollFrameMs: [16, 20, 40, 10],
    dom: { chatRows: 18, messageRows: 42, rosterRows: 28, rosterAvatarElements: 27 },
  }]);
  assert.equal(measurements.scrollFrameP95Ms, 40);
  assert.equal(measurements.scrollFramesOver33Percent, 25);
  assert.equal(measurements.chatDomRows, 18);
  assert.equal(measurements.rosterDomRows, 28);
});

test("budget failures name every exceeded or missing measurement", () => {
  const evaluated = evaluateBudgets({ coldStartP95Ms: 1_001, idleCpuPercent: 0.5 });
  assert.equal(evaluated.coldStartP95Ms.passed, false);
  assert.equal(evaluated.idleCpuPercent.passed, true);
  assert.equal(evaluated.idleRssBytes.passed, false);
});
