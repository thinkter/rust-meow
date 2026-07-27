import assert from "node:assert/strict";
import test from "node:test";
import { SyncPhase, type SyncStatus } from "../src/lib/types.ts";
import {
  emptyConversationSyncMessage,
  shouldApplySyncStatus,
  syncStatusActive,
  syncStatusLabel,
} from "../src/state/sync.ts";

const status = (phase: SyncStatus["phase"], revision = 1): SyncStatus => ({
  phase,
  revision,
  chatsProcessed: 12,
  messagesProcessed: 345,
  whatsAppProgress: 64,
  startedAtMs: 1,
  completedAtMs: 0,
  detail: "",
});

test("only active transfer phases render as syncing", () => {
  for (const phase of [SyncPhase.Connecting, SyncPhase.InitialHistory, SyncPhase.AppState, SyncPhase.CatchingUp]) {
    assert.equal(syncStatusActive(status(phase)), true);
  }
  for (const phase of [SyncPhase.NotStarted, SyncPhase.Complete, SyncPhase.Partial, SyncPhase.Failed, SyncPhase.Offline]) {
    assert.equal(syncStatusActive(status(phase)), false);
  }
});

test("stale snapshots cannot overwrite newer sync events", () => {
  assert.equal(shouldApplySyncStatus(status(SyncPhase.Partial, 5), status(SyncPhase.Connecting, 4)), false);
  assert.equal(shouldApplySyncStatus(status(SyncPhase.Partial, 5), status(SyncPhase.Complete, 6)), true);
});

test("partial and failed states remain visible and actionable", () => {
  const partial = status(SyncPhase.Partial);
  partial.detail = "WhatsApp has not finished sending initial chat history";
  partial.messagesProcessed = 10;
  assert.equal(syncStatusLabel(partial), `Sync incomplete · ${partial.detail}`);
  assert.equal(syncStatusLabel(status(SyncPhase.Failed)), "Sync failed");
  assert.equal(syncStatusLabel(status(SyncPhase.Offline)), "Offline · sync will resume when connected");
});

test("an empty conversation explains incomplete account history", () => {
  assert.match(
    emptyConversationSyncMessage(status(SyncPhase.InitialHistory)) ?? "",
    /still syncing/,
  );
  const partial = status(SyncPhase.Partial);
  partial.detail = "WhatsApp has not finished sending initial chat history";
  partial.messagesProcessed = 0;
  partial.whatsAppProgress = 0;
  assert.match(emptyConversationSyncMessage(partial) ?? "", /was not received/);
  assert.match(syncStatusLabel(partial), /relink this device/);
  assert.equal(emptyConversationSyncMessage(status(SyncPhase.Complete)), null);
});
