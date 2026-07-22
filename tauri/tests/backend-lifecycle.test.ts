import assert from "node:assert/strict";
import test from "node:test";
import {
  activeConversationIds,
  backendLifecycleDecision,
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
