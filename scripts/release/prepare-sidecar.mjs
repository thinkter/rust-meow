import { mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";

const targets = {
  "x86_64-unknown-linux-gnu": { goos: "linux", goarch: "amd64" },
  "aarch64-unknown-linux-gnu": { goos: "linux", goarch: "arm64" },
  "x86_64-apple-darwin": { goos: "darwin", goarch: "amd64" },
  "aarch64-apple-darwin": { goos: "darwin", goarch: "arm64" },
  "x86_64-pc-windows-msvc": { goos: "windows", goarch: "amd64" },
  "aarch64-pc-windows-msvc": { goos: "windows", goarch: "arm64" },
};

const args = process.argv.slice(2);
const targetIndex = args.indexOf("--target");
const target = targetIndex >= 0 ? args[targetIndex + 1] : undefined;

if (!target || !targets[target]) {
  console.error(
    `Usage: node scripts/release/prepare-sidecar.mjs --target <${Object.keys(targets).join("|")}>`,
  );
  process.exit(2);
}

const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const repositoryRoot = resolve(scriptDirectory, "../..");
const backendDirectory = join(repositoryRoot, "backend");
const binariesDirectory = join(repositoryRoot, "tauri", "src-tauri", "binaries");
const extension = targets[target].goos === "windows" ? ".exe" : "";
const output = join(
  binariesDirectory,
  `rust-meow-backend-${target}${extension}`,
);

mkdirSync(binariesDirectory, { recursive: true });

const result = spawnSync(
  "go",
  [
    "build",
    "-trimpath",
    "-ldflags=-s -w",
    "-o",
    output,
    "./cmd/rust-meow-backend",
  ],
  {
    cwd: backendDirectory,
    env: {
      ...process.env,
      CGO_ENABLED: "0",
      GOOS: targets[target].goos,
      GOARCH: targets[target].goarch,
    },
    stdio: "inherit",
  },
);

if (result.error) {
  console.error(`Failed to launch Go: ${result.error.message}`);
  process.exit(1);
}

if (result.status !== 0) {
  process.exit(result.status ?? 1);
}

console.log(`Prepared Tauri sidecar: ${output}`);
