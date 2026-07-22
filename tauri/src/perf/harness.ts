export interface RendererPerformanceResult {
  schemaVersion: 1;
  powerMode: "normal" | "battery";
  fixture: { chats: 10_000; messages: 2_000; participants: 1_000 };
  coldStartToUsableMs: number;
  cachedChatSwitchMs: number[];
  eventToVisibleRowMs: number[];
  scrollFrameMs: number[];
  dom: {
    chatRows: number;
    messageRows: number;
    rosterRows: number;
    rosterAvatarElements: number;
  };
  display: { width: number; height: number; deviceScaleFactor: number };
}

interface PerformanceCaptureConfig {
  powerMode: "normal" | "battery";
  captureKind: "renderer" | "idle";
  scrollMs: number;
  launchedAtMs: number;
}

interface PerformanceHarness {
  prepare(): Promise<void>;
  run(): Promise<RendererPerformanceResult>;
}

interface PerformanceInspector {
  chatCount(): number;
  messageCount(): number;
  participantCount(): number;
}

declare global {
  interface Window {
    __RUST_MEOW_PERF_CONFIG__?: PerformanceCaptureConfig;
    __RUST_MEOW_PERF_EVENT_RECEIVED__?: (messageId: string, receivedAt: number) => void;
    __RUST_MEOW_PERF_INSPECT__?: PerformanceInspector;
  }
}

/**
 * Install before Solid renders. The packaged Tauri app injects the capture
 * config as an initialization script only for an explicitly requested perf
 * process, so ordinary launches pay no observer or benchmark cost.
 */
export function installPerformanceHarness(): PerformanceHarness | undefined {
  const config = window.__RUST_MEOW_PERF_CONFIG__;
  if (!config) return undefined;
  const stored = JSON.parse(localStorage.getItem("rust-meow-preferences") ?? "{}");
  localStorage.setItem(
    "rust-meow-preferences",
    JSON.stringify({
      ...stored,
      batterySaver: config.powerMode === "battery",
      memberPanelOpen: true,
      notificationsEnabled: false,
    }),
  );

  let usableAt = 0;
  let usableAtEpochMs = 0;
  const incoming: Array<{ messageId: string; receivedAt: number }> = [];
  const observer = new MutationObserver(() => {
    if (!usableAt && document.querySelector(".chat-row")) {
      usableAt = performance.now();
      usableAtEpochMs = Date.now();
      observer.disconnect();
    }
  });
  observer.observe(document.documentElement, { childList: true, subtree: true });
  window.__RUST_MEOW_PERF_EVENT_RECEIVED__ = (messageId, receivedAt) => {
    incoming.push({ messageId, receivedAt });
  };

  let prepared: Promise<void> | undefined;
  const prepare = () => prepared ??= (async () => {
    await waitFor(() => usableAt > 0 && Boolean(window.__RUST_MEOW_PERF_INSPECT__));
    await hydrateFixture();
  })();

  return {
    prepare,
    async run() {
      await prepare();
      const cachedChatSwitchMs = await measureChatSwitches(7);
      const eventToVisibleRowMs = await measureIncomingRows(incoming, 7);
      const scrollFrameMs = await measureScrollFrames(config.scrollMs);
      return {
        schemaVersion: 1,
        powerMode: config.powerMode,
        fixture: { chats: 10_000, messages: 2_000, participants: 1_000 },
        coldStartToUsableMs: config.launchedAtMs > 0
          ? usableAtEpochMs - config.launchedAtMs
          : usableAt,
        cachedChatSwitchMs,
        eventToVisibleRowMs,
        scrollFrameMs,
        dom: {
          chatRows: document.querySelectorAll(".chat-list .chat-row").length,
          messageRows: document.querySelectorAll(".message-scroller .message-row").length,
          rosterRows: document.querySelectorAll(".member-panel .participant-row").length,
          rosterAvatarElements: document.querySelectorAll(".member-panel .participant-row .avatar").length,
        },
        display: {
          width: window.innerWidth,
          height: window.innerHeight,
          deviceScaleFactor: window.devicePixelRatio,
        },
      };
    },
  };
}

async function hydrateFixture(): Promise<void> {
  const unread = [...document.querySelectorAll<HTMLButtonElement>(".chat-filters button")]
    .find((button) => button.textContent?.trim() === "Unread");
  unread?.click();
  await waitFor(() => window.__RUST_MEOW_PERF_INSPECT__?.chatCount() === 10_000, 60_000);
  const all = [...document.querySelectorAll<HTMLButtonElement>(".chat-filters button")]
    .find((button) => button.textContent?.trim() === "All");
  all?.click();
  await selectChat("Weekend plans 0");
  await waitFor(() => document.querySelectorAll(".message-row").length > 0);
  await waitFor(() => window.__RUST_MEOW_PERF_INSPECT__?.participantCount() === 1_000);
  const scroller = requiredElement<HTMLElement>(".message-scroller");
  // Forty 50-row pages cover the complete 2,000-message fixture. A few extra
  // iterations prove that top-edge loading becomes idempotent at exhaustion.
  for (let page = 0; page < 44; page += 1) {
    scroller.scrollTop = 0;
    scroller.dispatchEvent(new Event("scroll"));
    await delay(50);
  }
  await waitFor(() => window.__RUST_MEOW_PERF_INSPECT__?.messageCount() === 2_000, 30_000);
}

async function measureChatSwitches(trials: number): Promise<number[]> {
  const titles = ["Weekend plans 0", "Meow friend 1"];
  for (const title of titles) await selectChat(title);
  const samples: number[] = [];
  for (let index = 0; index < trials; index += 1) {
    const title = titles[index % titles.length]!;
    const started = performance.now();
    await selectChat(title);
    await nextPaint();
    samples.push(performance.now() - started);
  }
  return samples;
}

async function measureIncomingRows(
  incoming: Array<{ messageId: string; receivedAt: number }>,
  trials: number,
): Promise<number[]> {
  await selectChat("Weekend plans 0");
  const scroller = requiredElement<HTMLElement>(".message-scroller");
  scroller.scrollTop = scroller.scrollHeight;
  scroller.dispatchEvent(new Event("scroll"));
  await nextPaint();
  incoming.length = 0;
  const samples: number[] = [];
  while (samples.length < trials) {
    const event = await takeIncoming(incoming);
    await waitFor(() => Boolean(document.querySelector(`[data-message-id="${event.messageId}"]`)), 10_000);
    await nextPaint();
    samples.push(performance.now() - event.receivedAt);
  }
  return samples;
}

async function takeIncoming(
  incoming: Array<{ messageId: string; receivedAt: number }>,
): Promise<{ messageId: string; receivedAt: number }> {
  await waitFor(() => incoming.length > 0, 10_000);
  return incoming.shift()!;
}

async function selectChat(title: string): Promise<void> {
  const row = [...document.querySelectorAll<HTMLButtonElement>(".chat-row")]
    .find((candidate) => candidate.querySelector(".chat-title")?.textContent?.trim() === title);
  if (!row) throw new Error(`performance fixture did not render ${title}`);
  row.click();
  await waitFor(
    () => document.querySelector(".conversation-heading")?.textContent?.trim().startsWith(title) ?? false,
  );
}

async function measureScrollFrames(durationMs: number): Promise<number[]> {
  const scroller = requiredElement<HTMLElement>(".message-scroller");
  const samples: number[] = [];
  const started = performance.now();
  let previous = started;
  let direction = -1;
  return new Promise((resolve) => {
    const frame = (now: number) => {
      samples.push(now - previous);
      previous = now;
      if (scroller.scrollTop <= 0) direction = 1;
      if (scroller.scrollTop >= scroller.scrollHeight - scroller.clientHeight - 1) direction = -1;
      scroller.scrollTop += direction * Math.max(12, scroller.clientHeight / 8);
      if (now - started >= durationMs) resolve(samples.slice(1));
      else requestAnimationFrame(frame);
    };
    requestAnimationFrame(frame);
  });
}

function requiredElement<T extends Element>(selector: string): T {
  const element = document.querySelector<T>(selector);
  if (!element) throw new Error(`performance harness missing ${selector}`);
  return element;
}

async function waitFor(predicate: () => boolean, timeoutMs = 30_000): Promise<void> {
  const deadline = performance.now() + timeoutMs;
  while (!predicate()) {
    if (performance.now() >= deadline) throw new Error("performance harness timed out");
    await delay(16);
  }
}

function nextPaint(): Promise<void> {
  return new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => window.setTimeout(resolve, ms));
}
