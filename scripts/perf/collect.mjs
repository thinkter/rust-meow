#!/usr/bin/env node
import { execFileSync, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, readdir, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { gzipSync } from "node:zlib";
import { evaluateBudgets, percentile, rendererMeasurements } from "./budgets.mjs";
import { detectPowerState } from "./power.mjs";

const root = path.resolve(import.meta.dirname, "../..");
const args = parseArgs(process.argv.slice(2));
const rendererPath = requiredPath(args.renderer, "--renderer");
const executableSuffix = process.platform === "win32" ? ".exe" : "";
const appPath = path.resolve(args.app ?? path.join(root, `tauri/src-tauri/target/release/rust-meow${executableSuffix}`));
const sidecarPath = path.resolve(args.sidecar ?? path.join(root, `build/rust-meow-backend${executableSuffix}`));
const frontendPath = path.resolve(args.frontend ?? path.join(root, "tauri/dist"));
const outputPath = path.resolve(args.output ?? path.join(root, "perf-results", `budget-${args.mode ?? "normal"}.json`));
const renderer = JSON.parse(await readFile(rendererPath, "utf8"));
if (!Array.isArray(renderer.runs) || renderer.runs.length < 3) {
  throw new Error("renderer capture must contain at least three repeated trials");
}
const mode = args.mode ?? renderer.mode;
if (!(["normal", "battery"].includes(mode)) || renderer.mode !== mode) {
  throw new Error("renderer and requested power modes must match");
}
const power = await detectPowerState();
if (mode === "battery" && power.onBattery !== true) {
  throw new Error(`battery capture requires a discharging battery host (${power.reason})`);
}

const [appArtifact, sidecarArtifact, frontendArtifact] = await Promise.all([
  inspectFile(appPath),
  inspectFile(sidecarPath),
  inspectFrontend(frontendPath),
]);
const native = appArtifact
  ? await sampleNative(appPath, positiveInteger(args["quiescent-seconds"], 30), mode)
  : { idleCpuPercent: null, idleRssBytes: null, samples: [], reason: "native sampling requires a built app" };
const measurements = {
  tauriExecutableBytes: appArtifact?.bytes ?? null,
  sidecarBytes: sidecarArtifact?.bytes ?? null,
  combinedExecutableBytes: appArtifact && sidecarArtifact
    ? appArtifact.bytes + sidecarArtifact.bytes
    : null,
  frontendGzipBytes: frontendArtifact?.gzipBytes ?? null,
  ...rendererMeasurements(renderer.runs),
  idleCpuPercent: native.idleCpuPercent,
  idleRssBytes: native.idleRssBytes,
};
const budgets = evaluateBudgets(measurements);
const report = {
  schemaVersion: 1,
  capturedAt: new Date().toISOString(),
  mode,
  commit: git("rev-parse", "HEAD"),
  dirty: Boolean(git("status", "--porcelain")),
  artifactHash: appArtifact?.sha256 ?? null,
  machine: {
    hostname: os.hostname(),
    platform: os.platform(),
    release: os.release(),
    architecture: os.arch(),
    cpu: os.cpus()[0]?.model ?? "unknown",
    logicalCpus: os.cpus().length,
    totalMemoryBytes: os.totalmem(),
    webview: detectWebViewVersion(),
    power,
    display: renderer.runs[0]?.display ?? null,
  },
  fixture: { chats: 10_000, messages: 2_000, participants: 1_000 },
  trials: renderer.runs.length,
  artifacts: { app: appArtifact, sidecar: sidecarArtifact, frontend: frontendArtifact },
  native,
  renderer: { source: path.relative(root, rendererPath), runs: renderer.runs },
  measurements,
  budgets,
  passed: Object.values(budgets).every((budget) => budget.passed),
  failures: Object.entries(budgets)
    .filter(([, budget]) => !budget.passed)
    .map(([name, budget]) => ({ name, ...budget })),
};
await mkdir(path.dirname(outputPath), { recursive: true });
await writeFile(outputPath, `${JSON.stringify(report, null, 2)}\n`);
console.log(outputPath);
if (!report.passed) {
  console.error(`Performance budgets failed: ${report.failures.map((failure) => failure.name).join(", ")}`);
  process.exitCode = 1;
}

async function sampleNative(executable, quiescentSeconds, powerMode) {
  const profile = await mkdtemp(path.join(tmpdir(), "rust-meow-perf-"));
  const readyPath = path.join(profile, "idle-ready");
  const errorPath = path.join(profile, "idle-error.json");
  const child = spawn(executable, ["--fake-backend"], {
    env: {
      ...process.env,
      RUST_MEOW_DATA_DIR: profile,
      RUST_MEOW_FAKE_LIVE_EVENTS: "0",
      RUST_MEOW_PERF_FIXTURE: "1",
      RUST_MEOW_PERF_IDLE_READY: readyPath,
      RUST_MEOW_PERF_OUTPUT: errorPath,
      RUST_MEOW_PERF_MODE: powerMode,
      RUST_MEOW_PERF_LAUNCHED_AT_MS: String(Date.now()),
      RUST_MEOW_PERF_ISOLATED: "1",
    },
    stdio: "ignore",
  });
  try {
    await waitForFile(readyPath, child, 60_000);
    await delay(quiescentSeconds * 1_000);
    if (child.exitCode !== null) throw new Error(`native app exited before sampling (${child.exitCode})`);
    const samples = [];
    let previous = await processTree(child.pid);
    const first = previous;
    for (let index = 0; index < 10; index += 1) {
      await delay(500);
      const current = await processTree(child.pid);
      const elapsedSeconds = (current.atMs - previous.atMs) / 1_000;
      samples.push({
        rssBytes: current.rssBytes,
        cpuPercent: current.cpuPercent
          ?? ((current.cpuSeconds - previous.cpuSeconds) / elapsedSeconds) * 100,
      });
      previous = current;
    }
    const elapsedSeconds = (previous.atMs - first.atMs) / 1_000;
    return {
      idleCpuPercent: ((previous.cpuSeconds - first.cpuSeconds) / elapsedSeconds) * 100,
      idleCpuP95Percent: percentile(samples.map((sample) => sample.cpuPercent), 95),
      idleRssBytes: percentile(samples.map((sample) => sample.rssBytes), 95),
      quiescentSeconds,
      samples,
    };
  } finally {
    child.kill("SIGTERM");
    await Promise.race([new Promise((resolve) => child.once("exit", resolve)), delay(3_000)]);
    if (child.exitCode === null) child.kill("SIGKILL");
    await rm(profile, { recursive: true, force: true });
  }
}

async function waitForFile(file, child, timeoutMs) {
  const deadline = performance.now() + timeoutMs;
  while (performance.now() < deadline) {
    try {
      await readFile(file);
      return;
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
    if (child.exitCode !== null) {
      let detail = "";
      try { detail = await readFile(file.replace("idle-ready", "idle-error.json"), "utf8"); } catch {}
      throw new Error(`native app exited before hydrating the idle fixture (${child.exitCode}) ${detail}`);
    }
    await delay(100);
  }
  throw new Error(`native app did not hydrate the idle fixture within ${timeoutMs}ms`);
}

async function linuxProcessTree(rootPid) {
  const queue = [rootPid];
  const seen = new Set();
  let cpuTicks = 0;
  let rssBytes = 0;
  while (queue.length) {
    const pid = queue.pop();
    if (!pid || seen.has(pid)) continue;
    seen.add(pid);
    try {
      const [statLine, statm, children] = await Promise.all([
        readFile(`/proc/${pid}/stat`, "utf8"),
        readFile(`/proc/${pid}/statm`, "utf8"),
        readFile(`/proc/${pid}/task/${pid}/children`, "utf8"),
      ]);
      const fields = statLine.slice(statLine.lastIndexOf(")") + 2).trim().split(/\s+/);
      cpuTicks += Number(fields[11]) + Number(fields[12]);
      rssBytes += Number(statm.trim().split(/\s+/)[1]) * linuxPageSize();
      queue.push(...children.trim().split(/\s+/).filter(Boolean).map(Number));
    } catch {
      // A short-lived helper exited between process-tree snapshots.
    }
  }
  const ticksPerSecond = Number(execFileSync("getconf", ["CLK_TCK"], { encoding: "utf8" }).trim());
  return { atMs: performance.now(), cpuSeconds: cpuTicks / ticksPerSecond, rssBytes, processCount: seen.size };
}

let cachedLinuxPageSize;
function linuxPageSize() {
  if (!cachedLinuxPageSize) {
    cachedLinuxPageSize = Number(execFileSync("getconf", ["PAGESIZE"], { encoding: "utf8" }).trim());
  }
  return cachedLinuxPageSize;
}

async function processTree(rootPid) {
  if (process.platform === "linux") return linuxProcessTree(rootPid);
  const rows = process.platform === "darwin" ? macProcesses() : windowsProcesses();
  const selected = descendants(rows, rootPid);
  return {
    atMs: performance.now(),
    cpuSeconds: selected.reduce((sum, row) => sum + row.cpuSeconds, 0),
    cpuPercent: selected.some((row) => Number.isFinite(row.cpuPercent))
      ? selected.reduce((sum, row) => sum + (row.cpuPercent ?? 0), 0)
      : null,
    rssBytes: selected.reduce((sum, row) => sum + row.rssBytes, 0),
    processCount: selected.length,
  };
}

function macProcesses() {
  const output = execFileSync("ps", ["-axo", "pid=,ppid=,rss=,time=,%cpu="], { encoding: "utf8" });
  return output.trim().split("\n").map((line) => {
    const [pid, parentPid, rssKiB, cpuTime, cpuPercent] = line.trim().split(/\s+/);
    return { pid: Number(pid), parentPid: Number(parentPid), rssBytes: Number(rssKiB) * 1_024, cpuSeconds: parseCpuTime(cpuTime), cpuPercent: Number(cpuPercent) };
  });
}

function windowsProcesses() {
  const script = [
    "$ErrorActionPreference='SilentlyContinue'",
    "Get-CimInstance Win32_Process | ForEach-Object {",
    "$p=Get-Process -Id $_.ProcessId",
    "if($p){[PSCustomObject]@{pid=$_.ProcessId;parentPid=$_.ParentProcessId;rssBytes=$p.WorkingSet64;cpuSeconds=$p.CPU}}",
    "} | ConvertTo-Json -Compress",
  ].join(";");
  const raw = execFileSync("powershell.exe", ["-NoProfile", "-Command", script], { encoding: "utf8" });
  const parsed = JSON.parse(raw || "[]");
  return (Array.isArray(parsed) ? parsed : [parsed]).map((row) => ({
    pid: Number(row.pid), parentPid: Number(row.parentPid), rssBytes: Number(row.rssBytes), cpuSeconds: Number(row.cpuSeconds ?? 0),
  }));
}

function descendants(rows, rootPid) {
  const pids = new Set([rootPid]);
  let changed = true;
  while (changed) {
    changed = false;
    for (const row of rows) {
      if (pids.has(row.parentPid) && !pids.has(row.pid)) {
        pids.add(row.pid);
        changed = true;
      }
    }
  }
  return rows.filter((row) => pids.has(row.pid));
}

function parseCpuTime(value = "0:00") {
  const [dayPart, clockPart] = value.includes("-") ? value.split("-") : ["0", value];
  const parts = clockPart.split(":").map(Number);
  const seconds = parts.pop() ?? 0;
  const minutes = parts.pop() ?? 0;
  const hours = parts.pop() ?? 0;
  return Number(dayPart) * 86_400 + hours * 3_600 + minutes * 60 + seconds;
}

async function inspectFile(file) {
  try {
    const data = await readFile(file);
    return { path: path.relative(root, file), bytes: data.length, sha256: sha256(data) };
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
}

async function inspectFrontend(directory) {
  try {
    const files = (await walk(directory)).filter((file) => /\.(?:js|css)$/.test(file));
    const entries = await Promise.all(files.map(async (file) => {
      const data = await readFile(file);
      return { path: path.relative(root, file), bytes: data.length, gzipBytes: gzipSync(data, { level: 9 }).length, sha256: sha256(data) };
    }));
    return {
      files: entries,
      bytes: entries.reduce((sum, entry) => sum + entry.bytes, 0),
      gzipBytes: entries.reduce((sum, entry) => sum + entry.gzipBytes, 0),
    };
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
}

async function walk(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  return (await Promise.all(entries.map((entry) => {
    const target = path.join(directory, entry.name);
    return entry.isDirectory() ? walk(target) : [target];
  }))).flat();
}

function sha256(data) { return createHash("sha256").update(data).digest("hex"); }
function git(...command) { return execFileSync("git", command, { cwd: root, encoding: "utf8" }).trim(); }
function detectWebViewVersion() {
  if (process.env.RUST_MEOW_WEBVIEW_VERSION) return process.env.RUST_MEOW_WEBVIEW_VERSION;
  if (process.platform === "linux") {
    try {
      const version = execFileSync("pkg-config", ["--modversion", "webkit2gtk-4.1"], { encoding: "utf8" }).trim();
      return `WebKitGTK ${version}`;
    } catch {
      return "unreported";
    }
  }
  return "unreported (set RUST_MEOW_WEBVIEW_VERSION on this runner)";
}
function delay(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }
function requiredPath(value, flag) { if (!value) throw new Error(`${flag} is required`); return path.resolve(value); }
function positiveInteger(value, fallback) { const parsed = Number.parseInt(value ?? "", 10); return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback; }
function parseArgs(values) {
  const parsed = {};
  for (let index = 0; index < values.length; index += 1) {
    const key = values[index];
    if (!key?.startsWith("--")) continue;
    parsed[key.slice(2)] = values[++index];
  }
  return parsed;
}
