import assert from "node:assert/strict";
import test from "node:test";

import { isMessageRecoveryEnabled } from "../src/lib/message-recovery.ts";

test("message recovery is opt-in for new and migrated preferences", () => {
  assert.equal(isMessageRecoveryEnabled(undefined), false);
  assert.equal(isMessageRecoveryEnabled(false), false);
  assert.equal(isMessageRecoveryEnabled("true"), false);
  assert.equal(isMessageRecoveryEnabled(true), true);
});
