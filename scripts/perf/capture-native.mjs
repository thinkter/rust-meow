#!/usr/bin/env node
import { spawn } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import process from "node:process";

const root = path.resolve(import.meta.dirname, "../..");
const args = parseArgs(process.argv.slice(2));
const mode = args.mode === "battery" ? "battery" : "normal";
const trials = positiveInteger(args.trials, 5);
const scrollMs = positiveInteger(args["scroll-ms"], 30_000);
const suffix = process.platform === "win32" ? ".exe" : "";
const executable = path.resolve(args.app ?? path.join(root, `tauri/src-tauri/target/release/rust-meow${suffix}`));
const output = path.resolve(args.output ?? path.join(root, "perf-results", `renderer-${mode}.json`));
const runs = [];

for (let trial = 0; trial < trials; trial += 1) {
  const profile = await mkdtemp(path.join(os.tmpdir(), "rust-meow-renderer-perf-"));
  const resultPath = path.join(profile, "result.json");
  try {
    const launchedAtMs = Date.now();
    const result = await captureTrial({
      executable,
      profile,
      resultPath,
      timeoutMs: scrollMs + 90_000,
      env: {
        RUST_MEOW_PERF_OUTPUT: resultPath,
        RUST_MEOW_PERF_FIXTURE: "1",
        RUST_MEOW_PERF_MODE: mode,
        RUST_MEOW_PERF_SCROLL_MS: String(scrollMs),
        RUST_MEOW_PERF_LAUNCHED_AT_MS: String(launchedAtMs),
      },
    });
    validateRendererResult(result, mode);
    runs.push(result);
  } finally {
    await rm(profile, { recursive: true, force: true });
  }
}

await mkdir(path.dirname(output), { recursive: true });
await writeFile(output, `${JSON.stringify({
  schemaVersion: 1,
  capturedAt: new Date().toISOString(),
  mode,
  trials,
  driver: "packaged Tauri native WebView",
  executable: path.relative(root, executable),
  runs,
}, null, 2)}\n`);
console.log(output);

function captureTrial({ executable: app, profile, resultPath, timeoutMs, env }) {
  return new Promise((resolve, reject) => {
    const child = spawn(app, ["--fake-backend"], {
      env: { ...process.env, RUST_MEOW_DATA_DIR: profile, ...env },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let settled = false;
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    const finish = (callback) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      clearInterval(resultPoll);
      if (child.exitCode === null) child.kill("SIGTERM");
      callback();
    };
    const readResult = async () => {
      try {
        const payload = JSON.parse(await readFile(resultPath, "utf8"));
        if (typeof payload.error === "string") throw new Error(payload.error);
        if (!payload.result) throw new Error("native app returned no performance result");
        finish(() => resolve(payload.result));
        return true;
      } catch (error) {
        if (error?.code === "ENOENT") return false;
        finish(() => reject(error));
        return true;
      }
    };
    const resultPoll = setInterval(() => { void readResult(); }, 100);
    const timeout = setTimeout(() => {
      finish(() => reject(new Error(
        `native performance trial timed out after ${timeoutMs}ms\n${stderr || stdout}`,
      )));
    }, timeoutMs);
    child.once("error", (error) => {
      finish(() => reject(error));
    });
    child.once("exit", async (code, signal) => {
      if (await readResult()) return;
      finish(() => reject(new Error(
        `native performance trial exited ${code ?? signal} without a result\n${stderr || stdout}`,
      )));
    });
  });
}

function validateRendererResult(run, expectedMode) {
  const arrayFields = ["cachedChatSwitchMs", "eventToVisibleRowMs", "scrollFrameMs"];
  const domFields = ["chatRows", "messageRows", "rosterRows", "rosterAvatarElements"];
  if (!run || run.schemaVersion !== 1 || run.powerMode !== expectedMode) {
    throw new Error("native WebView returned an invalid performance result envelope");
  }
  if (!Number.isFinite(run.coldStartToUsableMs)
    || arrayFields.some((field) => !Array.isArray(run[field]) || !run[field].every(Number.isFinite))
    || domFields.some((field) => !Number.isFinite(run.dom?.[field]))) {
    throw new Error("native WebView performance result is missing a numeric measurement");
  }
  if (run.fixture?.chats !== 10_000 || run.fixture?.messages !== 2_000 || run.fixture?.participants !== 1_000) {
    throw new Error("native WebView performance result used the wrong deterministic fixture");
  }
}

function parseArgs(values) {
  const parsed = {};
  for (let index = 0; index < values.length; index += 1) {
    const key = values[index];
    if (!key?.startsWith("--")) continue;
    parsed[key.slice(2)] = values[index + 1];
    index += 1;
  }
  return parsed;
}

function positiveInteger(value, fallback) {
  const parsed = Number.parseInt(value ?? "", 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}
