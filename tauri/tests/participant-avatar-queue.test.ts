import assert from "node:assert/strict";
import test from "node:test";
import { isRetryableAvatarError, ParticipantAvatarQueue } from "../src/lib/participant-avatar-queue.ts";

interface Deferred {
  promise: Promise<string>;
  resolve: (path: string) => void;
  reject: (error: unknown) => void;
}

function deferred(): Deferred {
  let resolve!: (path: string) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<string>((onResolve, onReject) => {
    resolve = onResolve;
    reject = onReject;
  });
  return { promise, resolve, reject };
}

async function flush() {
  await Promise.resolve();
  await Promise.resolve();
}

async function waitFor(predicate: () => boolean, timeoutMs = 100) {
  const deadline = Date.now() + timeoutMs;
  while (!predicate() && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
}

test("avatar hydration bounds concurrency and deduplicates subscribers", async () => {
  const pending = new Map<string, Deferred>();
  const calls: string[] = [];
  const hydrated: string[] = [];
  const queue = new ParticipantAvatarQueue({
    concurrency: 2,
    fetchAvatar: (participantId) => {
      calls.push(participantId);
      const request = deferred();
      pending.set(participantId, request);
      return request.promise;
    },
    onHydrated: (participantId) => hydrated.push(participantId),
  });

  queue.subscribe("a", "group");
  queue.subscribe("a", "group");
  queue.subscribe("b", "group");
  queue.subscribe("c", "group");
  assert.deepEqual(calls, ["a", "b"]);
  assert.deepEqual(queue.stats(), { running: 2, queued: 1, backoff: 0, tracked: 3, terminalFailures: 0 });

  pending.get("a")!.resolve("/a.jpg");
  await flush();
  assert.deepEqual(calls, ["a", "b", "c"]);
  assert.deepEqual(hydrated, ["a"]);
  queue.clear();
});

test("unsubscribing drops queued work and ignores a late running result", async () => {
  const first = deferred();
  const calls: string[] = [];
  const hydrated: string[] = [];
  const queue = new ParticipantAvatarQueue({
    concurrency: 1,
    fetchAvatar: (participantId) => {
      calls.push(participantId);
      return participantId === "running" ? first.promise : Promise.resolve(`/${participantId}.jpg`);
    },
    onHydrated: (participantId) => hydrated.push(participantId),
  });
  const cancelRunning = queue.subscribe("running", "old-group");
  const cancelQueued = queue.subscribe("queued", "old-group");
  cancelQueued();
  cancelRunning();
  first.resolve("/late.jpg");
  await flush();

  assert.deepEqual(calls, ["running"]);
  assert.deepEqual(hydrated, []);
  assert.equal(queue.stats().tracked, 0);
});

test("cancelScope removes only the switched group's subscribers", async () => {
  const request = deferred();
  const hydrated: string[] = [];
  const queue = new ParticipantAvatarQueue({
    concurrency: 1,
    fetchAvatar: () => request.promise,
    onHydrated: (participantId) => hydrated.push(participantId),
  });
  queue.subscribe("same-person", "old-group");
  queue.subscribe("same-person", "visible-group");
  queue.cancelScope("old-group");
  request.resolve("/avatar.jpg");
  await flush();
  assert.deepEqual(hydrated, ["same-person"]);
});

test("queued, running, and backoff work share one hard admission bound", () => {
  const never = new Promise<string>(() => undefined);
  const queue = new ParticipantAvatarQueue({
    concurrency: 2,
    maxQueued: 3,
    fetchAvatar: () => never,
    onHydrated: () => undefined,
  });
  for (let index = 0; index < 20; index += 1) queue.subscribe(`member-${index}`, "group");
  assert.deepEqual(queue.stats(), {
    running: 2,
    queued: 3,
    backoff: 0,
    tracked: 5,
    terminalFailures: 0,
  });
  queue.clear();
});

test("busy and timeout errors retry with backoff while privacy failures are terminal", async () => {
  let attempts = 0;
  const hydrated: string[] = [];
  const queue = new ParticipantAvatarQueue({
    concurrency: 1,
    maxAttempts: 3,
    retryBaseMs: 1,
    fetchAvatar: async () => {
      attempts += 1;
      if (attempts === 1) throw { code: "busy", message: "media pool busy", retryable: true };
      if (attempts === 2) throw { code: "transport", message: "backend request timed out", retryable: true };
      return "/eventual.jpg";
    },
    onHydrated: (_participantId, path) => hydrated.push(path),
  });
  queue.subscribe("eventual", "group");
  await waitFor(() => attempts === 3);
  assert.equal(attempts, 3);
  assert.deepEqual(hydrated, ["/eventual.jpg"]);

  let privacyCalls = 0;
  const privacyQueue = new ParticipantAvatarQueue({
    retryBaseMs: 1,
    fetchAvatar: async () => {
      privacyCalls += 1;
      throw { code: "privacy", message: "avatar hidden", retryable: false };
    },
    onHydrated: () => assert.fail("privacy failure must not hydrate"),
  });
  privacyQueue.subscribe("private", "group");
  await flush();
  privacyQueue.subscribe("private", "group");
  await flush();
  assert.equal(privacyCalls, 1);
  assert.equal(privacyQueue.stats().terminalFailures, 1);
});

test("retry classification is restricted to retryable busy and timeout failures", () => {
  assert.equal(isRetryableAvatarError({ code: "busy", message: "busy", retryable: true }), true);
  assert.equal(isRetryableAvatarError({ code: "timeout", message: "timeout", retryable: true }), true);
  assert.equal(isRetryableAvatarError({ code: "transport", message: "request timed out", retryable: true }), true);
  assert.equal(isRetryableAvatarError({ code: "transport", message: "backend stopped", retryable: true }), false);
  assert.equal(isRetryableAvatarError({ code: "privacy", message: "hidden", retryable: false }), false);
});

test("exhausted transient retries are not session-cached as privacy failures", async () => {
  let calls = 0;
  const queue = new ParticipantAvatarQueue({
    concurrency: 1,
    maxAttempts: 1,
    retryBaseMs: 0,
    fetchAvatar: async () => {
      calls += 1;
      throw { code: "busy", message: "busy", retryable: true };
    },
    onHydrated: () => undefined,
  });
  queue.subscribe("retry-later", "group");
  await flush();
  queue.subscribe("retry-later", "group");
  await flush();
  assert.equal(calls, 2);
  assert.equal(queue.stats().terminalFailures, 0);
});
