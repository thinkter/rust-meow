import assert from "node:assert/strict";
import test from "node:test";
import {
  activeConversationIds,
  backendLifecycleDecision,
  bootstrapFailureDecision,
  RequestGeneration,
  RestartEpochQueue,
} from "../src/state/backend-lifecycle.ts";

test("restart lifecycle exposes bounded progress and a fresh resync epoch", () => {
  assert.deepEqual(
    backendLifecycleDecision({
      epoch: 4,
      state: "reconnecting",
      attempt: 2,
      maxAttempts: 5,
      message: "signal 9",
    }),
    { phase: "reconnecting", detail: "Backend restart 2/5" },
  );
  assert.deepEqual(
    backendLifecycleDecision({
      epoch: 5,
      state: "reconnected",
      attempt: 2,
      maxAttempts: 5,
      message: "",
    }),
    { phase: "resync", epoch: 5 },
  );
});

test("a restart queued during another resync is retained and coalesced to the latest epoch", () => {
  const queue = new RestartEpochQueue();
  queue.push(2);
  assert.equal(queue.take(), 2);
  queue.push(3);
  queue.push(5);
  queue.push(4);
  assert.equal(queue.take(), 5);
  assert.equal(queue.take(), undefined);
});

test("a superseding list refresh invalidates old-epoch completion and cleanup", () => {
  const generation = new RequestGeneration();
  const oldEpoch = generation.begin();
  const freshEpoch = generation.begin();
  assert.equal(generation.isCurrent(oldEpoch), false);
  assert.equal(generation.isCurrent(freshEpoch), true);
  generation.invalidate();
  assert.equal(generation.isCurrent(freshEpoch), false);
});

test("transient bootstrap failures wait for lifecycle recovery while terminal failures stay fatal", () => {
  assert.equal(bootstrapFailureDecision({ retryable: true }), "reconnecting");
  assert.equal(bootstrapFailureDecision({ retryable: false }), "fatal");
});

test("terminal and exhausted failures are actionable and never resync", () => {
  for (const [state, prefix] of [
    ["fatal", "cannot start safely"],
    ["retryExhausted", "repeatedly stopped"],
  ] as const) {
    const decision = backendLifecycleDecision({
      epoch: 3,
      state,
      attempt: 5,
      maxAttempts: 5,
      message: "profile error",
    });
    assert.equal(decision.phase, "fatal");
    assert.match(decision.message, new RegExp(prefix));
    assert.match(decision.message, /profile error/);
  }
});

test("epoch resync refetches every distinct active pane conversation", () => {
  assert.deepEqual(
    activeConversationIds([
      { activeChatId: "family" },
      { activeChatId: "work" },
      { activeChatId: "family" },
      { activeChatId: "" },
    ]),
    ["family", "work"],
  );
});
