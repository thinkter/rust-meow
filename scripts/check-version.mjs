import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const read = (path) => readFileSync(resolve(root, path), "utf8");
const canonical = read("VERSION").trim();

if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(canonical)) {
  throw new Error(`VERSION is not a valid semantic version: ${canonical}`);
}

function jsonVersion(path) {
  return JSON.parse(read(path)).version;
}

function cargoVersion(path) {
  return read(path).match(/^version = "([^"]+)"/m)?.[1];
}

function cargoLockVersion(path, packageName) {
  const escaped = packageName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return read(path).match(
    new RegExp(`\\[\\[package\\]\\]\\nname = "${escaped}"\\nversion = "([^"]+)"`),
  )?.[1];
}

function goVersion(path) {
  return read(path).match(/^const Version = "([^"]+)"/m)?.[1];
}

const surfaces = [
  ["tauri/package.json", jsonVersion("tauri/package.json")],
  ["tauri/src-tauri/tauri.conf.json", jsonVersion("tauri/src-tauri/tauri.conf.json")],
  ["tauri/src-tauri/Cargo.toml", cargoVersion("tauri/src-tauri/Cargo.toml")],
  ["tauri/src-tauri/Cargo.lock", cargoLockVersion("tauri/src-tauri/Cargo.lock", "rust-meow-tauri")],
  ["desktop/Cargo.toml", cargoVersion("desktop/Cargo.toml")],
  ["desktop/Cargo.lock", cargoLockVersion("desktop/Cargo.lock", "rust-meow-desktop")],
  ["backend/internal/productversion/version.go", goVersion("backend/internal/productversion/version.go")],
];

const mismatches = surfaces.filter(([, version]) => version !== canonical);
if (mismatches.length > 0) {
  for (const [path, version] of mismatches) {
    console.error(`${path}: expected ${canonical}, found ${version ?? "no version"}`);
  }
  process.exitCode = 1;
} else {
  console.log(`Rust Meow product version ${canonical} is consistent across ${surfaces.length} surfaces.`);
}
