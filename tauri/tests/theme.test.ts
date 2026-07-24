import assert from "node:assert/strict";
import test from "node:test";
import {
  BUILTIN_THEMES,
  applyTheme,
  cloneTheme,
  defaultTheme,
  exportTheme,
  normalizeTheme,
} from "../src/lib/theme.ts";

test("ships dark and light skeuomorphic themes without changing the default", () => {
  assert.equal(defaultTheme().id, "vercel-dark");
  assert.equal(BUILTIN_THEMES[0]?.id, "throwback-graphite");
  assert.equal(BUILTIN_THEMES[0]?.visualStyle, "skeuomorphic");
  assert.equal(BUILTIN_THEMES[0]?.appearance, "dark");
  assert.equal(BUILTIN_THEMES[1]?.id, "classic-messages");
  assert.equal(BUILTIN_THEMES[1]?.appearance, "light");
});

test("legacy and invalid theme styles normalize to modern", () => {
  const legacy = normalizeTheme({
    id: "legacy",
    name: "Legacy",
    appearance: "light",
    tokens: {},
  });
  const invalid = normalizeTheme({
    id: "invalid",
    name: "Invalid",
    visualStyle: "url(https://example.com/theme.css)",
    tokens: {},
  });

  assert.equal(legacy?.visualStyle, "modern");
  assert.equal(invalid?.visualStyle, "modern");
});

test("clone and export retain the trusted structural style", () => {
  const source = BUILTIN_THEMES[0]!;
  const copy = cloneTheme(source, "Graphite copy");
  const exported = JSON.parse(exportTheme(copy)) as Record<string, unknown>;

  assert.equal(copy.visualStyle, "skeuomorphic");
  assert.equal(exported.visualStyle, "skeuomorphic");
});

test("theme application exposes appearance and structural style on the root", () => {
  const properties = new Map<string, string>();
  const root = {
    dataset: {} as Record<string, string>,
    style: {
      colorScheme: "",
      setProperty(name: string, value: string) {
        properties.set(name, value);
      },
    },
  };

  applyTheme(BUILTIN_THEMES[0]!, root as unknown as HTMLElement);

  assert.equal(root.dataset.appearance, "dark");
  assert.equal(root.dataset.themeStyle, "skeuomorphic");
  assert.equal(root.style.colorScheme, "dark");
  assert.equal(properties.get("--accent"), "#a2d422");
});
