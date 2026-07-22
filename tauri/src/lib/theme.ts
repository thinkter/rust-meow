/**
 * The theming contract.
 *
 * A theme is nothing but a flat map of design tokens to CSS colour/length
 * values. Applying one writes `--<token>` custom properties onto the document
 * element, so every rule in `styles.css` reads from the same source and a user
 * theme needs no code — only JSON.
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

export interface Theme {
  id: string;
  name: string;
  /** Drives `color-scheme`, native scrollbars, and form control rendering. */
  appearance: "dark" | "light";
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

export const BUILTIN_THEMES: readonly Theme[] = [
  { id: "vercel-dark", name: "Vercel Dark", appearance: "dark", builtin: true, tokens: vercelDark },
  { id: "vercel-light", name: "Vercel Light", appearance: "light", builtin: true, tokens: vercelLight },
  { id: "vercel-mono", name: "Vercel Mono", appearance: "dark", builtin: true, tokens: vercelMono },
  { id: "midnight", name: "Midnight", appearance: "dark", builtin: true, tokens: midnight },
  { id: "emerald", name: "Emerald", appearance: "dark", builtin: true, tokens: emerald },
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
    tokens: { ...theme.tokens },
  };
}

export function exportTheme(theme: Theme): string {
  return JSON.stringify(
    { id: theme.id, name: theme.name, appearance: theme.appearance, tokens: theme.tokens },
    null,
    2,
  );
}
