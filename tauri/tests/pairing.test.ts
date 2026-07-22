import assert from "node:assert/strict";
import test from "node:test";
import { pairingStartupDecision, qrPresentation } from "../src/state/pairing.ts";

test("only an unpaired startup begins pairing", () => {
  assert.deepEqual(pairingStartupDecision({ paired: false, loggedIn: false }), {
    screen: "pairing",
    startPairing: true,
  });
  assert.deepEqual(pairingStartupDecision({ paired: true, loggedIn: false }), {
    screen: "chats",
    startPairing: false,
  });
  assert.deepEqual(pairingStartupDecision({ paired: true, loggedIn: true }), {
    screen: "chats",
    startPairing: false,
  });
});

test("QR lifecycle distinguishes waiting, active, and expired codes", () => {
  assert.deepEqual(qrPresentation("", 20_000, 10_000), {
    phase: "waiting",
    secondsRemaining: 0,
  });
  assert.deepEqual(qrPresentation("code", 12_001, 10_000), {
    phase: "active",
    secondsRemaining: 3,
  });
  assert.deepEqual(qrPresentation("code", 10_000, 10_000), {
    phase: "expired",
    secondsRemaining: 0,
  });
});

test("QR codes without a backend expiry remain usable", () => {
  assert.deepEqual(qrPresentation("code", 0, 10_000), {
    phase: "active",
    secondsRemaining: 0,
  });
});
