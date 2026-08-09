import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const tauriConfig = JSON.parse(
  readFileSync(new URL("../src-tauri/tauri.conf.json", import.meta.url), "utf8"),
) as { app: { security: { csp: string } } };

function directiveSources(csp: string, directive: string): Set<string> {
  const entry = csp
    .split(";")
    .map((part) => part.trim().split(/\s+/))
    .find(([name]) => name === directive);
  return new Set(entry?.slice(1) ?? []);
}

test("native media elements may load trusted local attachment URLs", () => {
  const mediaSources = directiveSources(tauriConfig.app.security.csp, "media-src");
  for (const source of ["'self'", "asset:", "http://asset.localhost", "blob:", "data:"]) {
    assert.ok(mediaSources.has(source), `media-src must allow ${source}`);
  }
});
