/**
 * The theming contract.
 *
 * Most themes are a flat map of design tokens. `visualStyle` is the deliberately
 * small structural escape hatch: it lets a theme opt into the shared
 * skeuomorphic component treatment without allowing imported JSON to inject
 * arbitrary CSS.
 */

export const THEME_TOKENS = [
  "bg-app",
  "bg-panel",
  "bg-elevated",
  "bg-hover",
  "bg-active",
  "bg-input",
  "bg-overlay",
  "border",
  "border-strong",
  "border-focus",
  "fg",
  "fg-muted",
  "fg-subtle",
  "fg-inverted",
  "accent",
  "accent-hover",
  "accent-fg",
  "accent-soft",
  "bubble-in-bg",
  "bubble-in-fg",
  "bubble-out-bg",
  "bubble-out-fg",
  "quote-bar",
  "success",
  "warning",
  "danger",
  "info",
  "shadow-sm",
  "shadow-md",
  "shadow-lg",
] as const;

export type ThemeToken = (typeof THEME_TOKENS)[number];
export type ThemeTokens = Record<ThemeToken, string>;
export type ThemeVisualStyle = "modern" | "skeuomorphic";

export interface Theme {
  id: string;
  name: string;
  /** Drives `color-scheme`, native scrollbars, and form control rendering. */
  appearance: "dark" | "light";
  /** Selects a trusted, bundled structural treatment. */
  visualStyle: ThemeVisualStyle;
  /** Built-in themes cannot be edited or deleted, only duplicated. */
  builtin?: boolean;
  tokens: ThemeTokens;
}

const vercelDark: ThemeTokens = {
  "bg-app": "#000000",
  "bg-panel": "#0a0a0a",
  "bg-elevated": "#111111",
  "bg-hover": "#1a1a1a",
  "bg-active": "#242424",
  "bg-input": "#0a0a0a",
  "bg-overlay": "rgba(0, 0, 0, 0.72)",
  border: "#2e2e2e",
  "border-strong": "#454545",
  "border-focus": "#0072f5",
  fg: "#ededed",
  "fg-muted": "#a1a1a1",
  "fg-subtle": "#707070",
  "fg-inverted": "#0a0a0a",
  accent: "#0072f5",
  "accent-hover": "#3291ff",
  "accent-fg": "#ffffff",
  "accent-soft": "rgba(0, 114, 245, 0.16)",
  "bubble-in-bg": "#161616",
  "bubble-in-fg": "#ededed",
  "bubble-out-bg": "#0059c1",
  "bubble-out-fg": "#ffffff",
  "quote-bar": "#0072f5",
  success: "#45d483",
  warning: "#f7b955",
  danger: "#ff6166",
  info: "#52a8ff",
  "shadow-sm": "0 1px 2px rgba(0, 0, 0, 0.5)",
  "shadow-md": "0 4px 16px rgba(0, 0, 0, 0.55)",
  "shadow-lg": "0 16px 48px rgba(0, 0, 0, 0.65)",
};

const vercelLight: ThemeTokens = {
  "bg-app": "#ffffff",
  "bg-panel": "#fafafa",
  "bg-elevated": "#ffffff",
  "bg-hover": "#f2f2f2",
  "bg-active": "#ebebeb",
  "bg-input": "#ffffff",
  "bg-overlay": "rgba(255, 255, 255, 0.75)",
  border: "#ebebeb",
  "border-strong": "#d4d4d4",
  "border-focus": "#0072f5",
  fg: "#171717",
  "fg-muted": "#666666",
  "fg-subtle": "#8f8f8f",
  "fg-inverted": "#ffffff",
  accent: "#0072f5",
  "accent-hover": "#0761d1",
  "accent-fg": "#ffffff",
  "accent-soft": "rgba(0, 114, 245, 0.1)",
  "bubble-in-bg": "#f2f2f2",
  "bubble-in-fg": "#171717",
  "bubble-out-bg": "#0072f5",
  "bubble-out-fg": "#ffffff",
  "quote-bar": "#0072f5",
  success: "#0f7b3f",
  warning: "#ab5700",
  danger: "#c9282d",
  info: "#0068d6",
  "shadow-sm": "0 1px 2px rgba(0, 0, 0, 0.06)",
  "shadow-md": "0 4px 16px rgba(0, 0, 0, 0.08)",
  "shadow-lg": "0 16px 48px rgba(0, 0, 0, 0.12)",
};

/** Vercel's monochrome look: the outgoing bubble is an inverted primary. */
const vercelMono: ThemeTokens = {
  ...vercelDark,
  accent: "#ededed",
  "accent-hover": "#ffffff",
  "accent-fg": "#0a0a0a",
  "accent-soft": "rgba(237, 237, 237, 0.12)",
  "border-focus": "#ededed",
  "bubble-out-bg": "#ededed",
  "bubble-out-fg": "#0a0a0a",
  "quote-bar": "#ededed",
};

const midnight: ThemeTokens = {
  ...vercelDark,
  "bg-app": "#0b0f17",
  "bg-panel": "#101623",
  "bg-elevated": "#151d2c",
  "bg-hover": "#1b2436",
  "bg-active": "#232f45",
  "bg-input": "#101623",
  border: "#1f293b",
  "border-strong": "#31405b",
  fg: "#e6ebf4",
  "fg-muted": "#9aa7bd",
  "fg-subtle": "#6d7c94",
  accent: "#7c8cff",
  "accent-hover": "#96a3ff",
  "accent-soft": "rgba(124, 140, 255, 0.16)",
  "border-focus": "#7c8cff",
  "bubble-in-bg": "#182236",
  "bubble-out-bg": "#3b46a8",
  "quote-bar": "#7c8cff",
};

const emerald: ThemeTokens = {
  ...vercelDark,
  accent: "#00b884",
  "accent-hover": "#22d6a0",
  "accent-soft": "rgba(0, 184, 132, 0.16)",
  "border-focus": "#00b884",
  "bubble-out-bg": "#00684f",
  "quote-bar": "#00b884",
};

const throwbackGraphite: ThemeTokens = {
  "bg-app": "#292929",
  "bg-panel": "#3b3b3b",
  "bg-elevated": "#474747",
  "bg-hover": "#555555",
  "bg-active": "#626262",
  "bg-input": "#151515",
  "bg-overlay": "rgba(8, 8, 8, 0.78)",
  border: "#202020",
  "border-strong": "#777777",
  "border-focus": "#a2d422",
  fg: "#f2f2f2",
  "fg-muted": "#c7c7c7",
  "fg-subtle": "#969696",
  "fg-inverted": "#151515",
  accent: "#a2d422",
  "accent-hover": "#b6e53c",
  "accent-fg": "#172000",
  "accent-soft": "rgba(162, 212, 34, 0.20)",
  "bubble-in-bg": "#505050",
  "bubble-in-fg": "#f4f4f4",
  "bubble-out-bg": "#7da914",
  "bubble-out-fg": "#101600",
  "quote-bar": "#a2d422",
  success: "#a2d422",
  warning: "#efb43c",
  danger: "#e85d54",
  info: "#82b9e6",
  "shadow-sm": "0 1px 2px rgba(0, 0, 0, 0.62)",
  "shadow-md": "0 5px 16px rgba(0, 0, 0, 0.64)",
  "shadow-lg": "0 18px 50px rgba(0, 0, 0, 0.72)",
};

const classicMessages: ThemeTokens = {
  "bg-app": "#ccd3df",
  "bg-panel": "#e8edf4",
  "bg-elevated": "#f6f7f9",
  "bg-hover": "#d8e0ec",
  "bg-active": "#b8c9df",
  "bg-input": "#ffffff",
  "bg-overlay": "rgba(45, 54, 68, 0.58)",
  border: "#9aa6b7",
  "border-strong": "#687789",
  "border-focus": "#315e96",
  fg: "#17202b",
  "fg-muted": "#4d5867",
  "fg-subtle": "#707b8a",
  "fg-inverted": "#ffffff",
  accent: "#2d67a3",
  "accent-hover": "#3e7ebf",
  "accent-fg": "#ffffff",
  "accent-soft": "rgba(55, 105, 164, 0.20)",
  "bubble-in-bg": "#f4f4f1",
  "bubble-in-fg": "#202020",
  "bubble-out-bg": "#7fb1e6",
  "bubble-out-fg": "#10243b",
  "quote-bar": "#356da8",
  success: "#4f8a22",
  warning: "#a56600",
  danger: "#b73131",
  info: "#2d67a3",
  "shadow-sm": "0 1px 2px rgba(35, 48, 65, 0.28)",
  "shadow-md": "0 5px 16px rgba(35, 48, 65, 0.30)",
  "shadow-lg": "0 18px 48px rgba(35, 48, 65, 0.38)",
};

export const BUILTIN_THEMES: readonly Theme[] = [
  { id: "throwback-graphite", name: "Throwback Graphite", appearance: "dark", visualStyle: "skeuomorphic", builtin: true, tokens: throwbackGraphite },
  { id: "classic-messages", name: "Classic Messages", appearance: "light", visualStyle: "skeuomorphic", builtin: true, tokens: classicMessages },
  { id: "vercel-dark", name: "Vercel Dark", appearance: "dark", visualStyle: "modern", builtin: true, tokens: vercelDark },
  { id: "vercel-light", name: "Vercel Light", appearance: "light", visualStyle: "modern", builtin: true, tokens: vercelLight },
  { id: "vercel-mono", name: "Vercel Mono", appearance: "dark", visualStyle: "modern", builtin: true, tokens: vercelMono },
  { id: "midnight", name: "Midnight", appearance: "dark", visualStyle: "modern", builtin: true, tokens: midnight },
  { id: "emerald", name: "Emerald", appearance: "dark", visualStyle: "modern", builtin: true, tokens: emerald },
];

export const DEFAULT_THEME_ID = "vercel-dark";

export function defaultTheme(): Theme {
  return BUILTIN_THEMES.find((theme) => theme.id === DEFAULT_THEME_ID) ?? BUILTIN_THEMES[0]!;
}

/** Write a theme's tokens onto the document so every stylesheet rule sees them. */
export function applyTheme(theme: Theme, root: HTMLElement = document.documentElement) {
  for (const token of THEME_TOKENS) {
    root.style.setProperty(`--${token}`, theme.tokens[token]);
  }
  root.dataset.appearance = theme.appearance;
  root.dataset.themeStyle = theme.visualStyle;
  root.style.colorScheme = theme.appearance;
}

/**
 * Accept a user-authored theme without trusting it. Unknown keys are dropped,
 * missing keys fall back to the base theme, and every value must look like a
 * plain CSS token so a theme file cannot inject `url(...)` or close a rule.
 */
export function normalizeTheme(value: unknown, base: Theme = defaultTheme()): Theme | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const candidate = value as Record<string, unknown>;
  const rawTokens =
    typeof candidate.tokens === "object" && candidate.tokens !== null
      ? (candidate.tokens as Record<string, unknown>)
      : {};

  const tokens = {} as ThemeTokens;
  for (const token of THEME_TOKENS) {
    const raw = rawTokens[token];
    tokens[token] = typeof raw === "string" && isSafeTokenValue(raw) ? raw.trim() : base.tokens[token];
  }

  const id = typeof candidate.id === "string" && candidate.id.trim() ? candidate.id.trim() : `custom-${hash(JSON.stringify(tokens))}`;
  const name = typeof candidate.name === "string" && candidate.name.trim() ? candidate.name.trim().slice(0, 60) : "Custom theme";
  return {
    id: id.slice(0, 80),
    name,
    appearance: candidate.appearance === "light" ? "light" : "dark",
    visualStyle: candidate.visualStyle === "skeuomorphic" ? "skeuomorphic" : "modern",
    tokens,
  };
}

/**
 * Colours, lengths, and shadow lists only. Rejecting `(`, `;`, `{`, `}` and
 * quotes keeps a downloaded theme from smuggling `url()` requests or extra
 * declarations through `setProperty`, while still allowing `rgba(...)` via the
 * explicit allowance below.
 */
function isSafeTokenValue(value: string): boolean {
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > 200) return false;
  if (/[;{}"'\\<>]/.test(trimmed)) return false;
  if (/url|expression|image|@import|var\s*\(/i.test(trimmed)) return false;
  return /^[#a-z0-9\s.,%()-]+$/i.test(trimmed);
}

function hash(value: string): string {
  let result = 2_166_136_261;
  for (let index = 0; index < value.length; index += 1) {
    result ^= value.charCodeAt(index);
    result = Math.imul(result, 16_777_619);
  }
  return (result >>> 0).toString(36);
}

export function cloneTheme(theme: Theme, name: string): Theme {
  return {
    id: `custom-${hash(`${name}${JSON.stringify(theme.tokens)}${name.length}`)}`,
    name: name.slice(0, 60),
    appearance: theme.appearance,
    visualStyle: theme.visualStyle,
    tokens: { ...theme.tokens },
  };
}

export function exportTheme(theme: Theme): string {
  return JSON.stringify(
    {
      id: theme.id,
      name: theme.name,
      appearance: theme.appearance,
      visualStyle: theme.visualStyle,
      tokens: theme.tokens,
    },
    null,
    2,
  );
}
