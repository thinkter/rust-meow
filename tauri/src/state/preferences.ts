import { createStore } from "solid-js/store";
import {
  BUILTIN_THEMES,
  DEFAULT_THEME_ID,
  applyTheme,
  cloneTheme,
  defaultTheme,
  normalizeTheme,
  type Theme,
} from "../lib/theme";

const STORAGE_KEY = "rust-meow-preferences";

export type Density = "comfortable" | "compact";

export interface Preferences {
  themeId: string;
  customThemes: Theme[];
  uiScale: number;
  /** `compact` is the experimental condensed message view. */
  density: Density;
  /** Discord-style always-on member list beside group conversations. */
  memberPanelOpen: boolean;
  /** Persisted so the sidebar remembers a collapsed workspace. */
  sidebarCollapsed: boolean;
  /** Absolute directory used by "Save to…"; empty means ask every time. */
  downloadDir: string;
  showTabBar: boolean;
  splitView: boolean;
  /** Send a plain Enter instead of inserting a newline. */
  enterToSend: boolean;
  /** Reduce animation and off-screen rendering work on constrained devices. */
  batterySaver: boolean;
}

const defaults: Preferences = {
  themeId: DEFAULT_THEME_ID,
  customThemes: [],
  uiScale: 1,
  density: "comfortable",
  memberPanelOpen: true,
  sidebarCollapsed: false,
  downloadDir: "",
  showTabBar: true,
  splitView: false,
  enterToSend: true,
  batterySaver: false,
};

function readStored(): Partial<Preferences> {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return legacyPreferences();
    const parsed: unknown = JSON.parse(raw);
    return typeof parsed === "object" && parsed !== null ? (parsed as Partial<Preferences>) : {};
  } catch {
    return {};
  }
}

/** Carry the old single-key theme/scale settings forward on first launch. */
function legacyPreferences(): Partial<Preferences> {
  const theme = localStorage.getItem("rust-meow-theme");
  const scale = Number.parseFloat(localStorage.getItem("rust-meow-scale") ?? "");
  const migrated: Partial<Preferences> = {};
  if (theme === "light") migrated.themeId = "vercel-light";
  if (Number.isFinite(scale)) migrated.uiScale = scale;
  return migrated;
}

function sanitize(stored: Partial<Preferences>): Preferences {
  const customThemes = Array.isArray(stored.customThemes)
    ? stored.customThemes
        .map((theme) => normalizeTheme(theme))
        .filter((theme): theme is Theme => Boolean(theme))
        .slice(0, 40)
    : [];
  const scale = Number(stored.uiScale);
  return {
    themeId: typeof stored.themeId === "string" ? stored.themeId : defaults.themeId,
    customThemes,
    uiScale: Number.isFinite(scale) ? Math.min(1.6, Math.max(0.8, scale)) : defaults.uiScale,
    density: stored.density === "compact" ? "compact" : defaults.density,
    memberPanelOpen: stored.memberPanelOpen ?? defaults.memberPanelOpen,
    sidebarCollapsed: stored.sidebarCollapsed ?? defaults.sidebarCollapsed,
    downloadDir: typeof stored.downloadDir === "string" ? stored.downloadDir : defaults.downloadDir,
    showTabBar: stored.showTabBar ?? defaults.showTabBar,
    splitView: stored.splitView ?? defaults.splitView,
    enterToSend: stored.enterToSend ?? defaults.enterToSend,
    batterySaver: stored.batterySaver ?? defaults.batterySaver,
  };
}

export function createPreferences() {
  const [preferences, setPreferences] = createStore<Preferences>(sanitize(readStored()));

  function persist() {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(preferences));
    } catch {
      // A full or disabled local store must not break the running session.
    }
  }

  function availableThemes(): Theme[] {
    return [...BUILTIN_THEMES, ...preferences.customThemes];
  }

  function activeTheme(): Theme {
    return availableThemes().find((theme) => theme.id === preferences.themeId) ?? defaultTheme();
  }

  function apply() {
    applyTheme(activeTheme());
    const root = document.documentElement;
    root.style.setProperty("--scale", preferences.uiScale.toString());
    root.dataset.density = preferences.density;
    root.dataset.batterySaver = preferences.batterySaver ? "true" : "false";
  }

  function update<K extends keyof Preferences>(key: K, value: Preferences[K]) {
    setPreferences(key, value);
    persist();
    apply();
  }

  function selectTheme(themeId: string) {
    update("themeId", themeId);
  }

  /**
   * Sanitise on the way in as well as on the way out. The editor feeds raw
   * field values straight through, and an imported theme is untrusted by
   * definition, so this is the one choke point where every stored theme is
   * guaranteed to hold only plain CSS token values.
   */
  function saveCustomTheme(theme: Theme) {
    const safe = normalizeTheme(theme);
    if (!safe) return;
    // `normalizeTheme` invents an id when one is missing; an edit must keep
    // addressing the same stored theme.
    const stored: Theme = { ...safe, id: theme.id || safe.id };
    const index = preferences.customThemes.findIndex((candidate) => candidate.id === stored.id);
    const next =
      index >= 0
        ? preferences.customThemes.map((candidate) =>
            candidate.id === stored.id ? stored : candidate,
          )
        : [...preferences.customThemes, stored].slice(0, 40);
    setPreferences("customThemes", next);
    persist();
    if (preferences.themeId === stored.id) apply();
  }

  function duplicateTheme(source: Theme, name: string): Theme {
    const copy = cloneTheme(source, name);
    saveCustomTheme(copy);
    return copy;
  }

  function deleteCustomTheme(themeId: string) {
    setPreferences(
      "customThemes",
      preferences.customThemes.filter((theme) => theme.id !== themeId),
    );
    if (preferences.themeId === themeId) setPreferences("themeId", DEFAULT_THEME_ID);
    persist();
    apply();
  }

  /** Returns the imported theme, or undefined when the payload is unusable. */
  function importTheme(json: string): Theme | undefined {
    try {
      const theme = normalizeTheme(JSON.parse(json));
      if (!theme) return undefined;
      saveCustomTheme(theme);
      return theme;
    } catch {
      return undefined;
    }
  }

  apply();

  return {
    preferences,
    prefActions: {
      update,
      apply,
      availableThemes,
      activeTheme,
      selectTheme,
      saveCustomTheme,
      duplicateTheme,
      deleteCustomTheme,
      importTheme,
    },
  };
}

export type PreferencesModel = ReturnType<typeof createPreferences>;
