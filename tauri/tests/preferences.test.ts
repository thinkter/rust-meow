import assert from "node:assert/strict";
import test from "node:test";

import { isMessageRecoveryEnabled } from "../src/lib/message-recovery.ts";
import {
  disableAgentControlIfNeeded,
  isAgentControlExperimentEnabled,
} from "../src/lib/agent-control-gate.ts";

test("message recovery is opt-in for new and migrated preferences", () => {
  assert.equal(isMessageRecoveryEnabled(undefined), false);
  assert.equal(isMessageRecoveryEnabled(false), false);
  assert.equal(isMessageRecoveryEnabled("true"), false);
  assert.equal(isMessageRecoveryEnabled(true), true);
});

test("Agent Control experiment is strictly opt-in", () => {
  assert.equal(isAgentControlExperimentEnabled(undefined), false);
  assert.equal(isAgentControlExperimentEnabled(false), false);
  assert.equal(isAgentControlExperimentEnabled("true"), false);
  assert.equal(isAgentControlExperimentEnabled(true), true);
});

test("hiding Agent Control disables an active backend and preserves configuration", async () => {
  const calls: unknown[][] = [];
  const changed = await disableAgentControlIfNeeded({
    async getAgentControlState() {
      return {
        state: {
          settings: {
            enabled: true,
            alias: "work",
            codexPath: "/opt/codex",
            codexRunning: true,
          },
          workspaces: [],
          controlChatIds: [],
          grants: [],
          runs: [],
          approvals: [],
          audit: [],
        },
      };
    },
    async saveAgentSettings(...args) {
      calls.push(args);
      return { state: null };
    },
  });

  assert.equal(changed, true);
  assert.deepEqual(calls, [[false, "work", "/opt/codex"]]);
});

test("hiding Agent Control leaves an inactive backend untouched", async () => {
  let saves = 0;
  const changed = await disableAgentControlIfNeeded({
    async getAgentControlState() {
      return { state: null };
    },
    async saveAgentSettings() {
      saves += 1;
      return { state: null };
    },
  });

  assert.equal(changed, false);
  assert.equal(saves, 0);
});
