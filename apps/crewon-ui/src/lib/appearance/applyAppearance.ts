import {
  DEFAULT_APPEARANCE,
  supportsFontSmoothing,
  type AppearancePreferences,
  type AppearanceThemeMode,
} from "./appearancePreferences";
import type { OperatingSystem, RuntimeSurface } from "../platform";
import type { Theme } from "../theme";

/** Resolves "system" against the OS preference so callers get a concrete theme. */
export function resolveThemeMode(
  mode: AppearanceThemeMode,
  prefersDark: boolean,
): Theme {
  if (mode === "system") {
    return prefersDark ? "dark" : "light";
  }
  return mode;
}

export function systemPrefersDark(): boolean {
  return (
    typeof window.matchMedia === "function" &&
    window.matchMedia("(prefers-color-scheme: dark)").matches
  );
}

export function systemPrefersReducedMotion(): boolean {
  return (
    typeof window.matchMedia === "function" &&
    window.matchMedia("(prefers-reduced-motion: reduce)").matches
  );
}

/** Variables that are conditionally emitted, so they also need clearing. */
const OPTIONAL_VARIABLES = [
  "--user-accent",
  "--user-background",
  "--user-foreground",
] as const;

/**
 * Emits a variable only when the user moved off the default, leaving the
 * stylesheet's per-theme value in charge otherwise.
 */
function themeOwnedColor(
  name: string,
  value: string,
  fallback: string,
): Record<string, string> {
  return value === fallback ? {} : { [name]: value };
}

export type AppearanceRootState = {
  attributes: Record<string, string>;
  variables: Record<string, string>;
};

/**
 * Pure translation from preferences to the CSS variables and data attributes
 * the stylesheets consume. Kept separate from the DOM write so the mapping is
 * testable without a browser environment.
 */
export function appearanceRootState(params: {
  os: OperatingSystem;
  preferences: AppearancePreferences;
  prefersReducedMotion: boolean;
  surface: RuntimeSurface;
}): AppearanceRootState {
  const { os, preferences, prefersReducedMotion, surface } = params;
  const reduceMotion =
    preferences.reduceMotion === "system"
      ? prefersReducedMotion
      : preferences.reduceMotion === "on";

  return {
    attributes: {
      "data-diff-markers": preferences.diffMarkers,
      // Only advertise smoothing where it has a rendering effect.
      "data-font-smoothing": String(
        supportsFontSmoothing(os) && preferences.fontSmoothing,
      ),
      "data-os": os,
      "data-reduce-motion": String(reduceMotion),
      "data-surface": surface,
      // A translucent sidebar needs a desktop window to blur against.
      "data-translucent-sidebar": String(
        surface === "desktop" && preferences.translucentSidebar,
      ),
    },
    variables: {
      /*
       * The accent is omitted while untouched too, because its default differs
       * per theme: near-black on light, near-white on dark. Pinning the light
       * value would make dark-mode toggles darker than the cards behind them.
       */
      ...themeOwnedColor(
        "--user-accent",
        preferences.accent,
        DEFAULT_APPEARANCE.accent,
      ),
      /*
       * Background and foreground are omitted while untouched so the per-theme
       * fallbacks in appearance.css stay reachable. Pinning the light default
       * here would override dark mode's own background.
       */
      ...themeOwnedColor(
        "--user-background",
        preferences.background,
        DEFAULT_APPEARANCE.background,
      ),
      ...themeOwnedColor(
        "--user-foreground",
        preferences.foreground,
        DEFAULT_APPEARANCE.foreground,
      ),
      "--user-code-font": preferences.codeFontFamily,
      "--user-code-font-size": `${preferences.codeFontSize}px`,
      // Contrast is a 0..1 ratio so stylesheets can mix without doing math.
      "--user-contrast": String(preferences.contrast / 100),
      "--user-ui-font": preferences.uiFontFamily,
      "--user-ui-font-size": `${preferences.uiFontSize}px`,
      /*
       * The shell sizes text in px, and every one of those declarations adds
       * this delta. Expressing the preference as an offset from the default
       * keeps the relative type hierarchy intact and, unlike a zoom, leaves
       * layout dimensions untouched.
       */
      "--user-ui-font-delta": `${preferences.uiFontSize - DEFAULT_APPEARANCE.uiFontSize}px`,
    },
  };
}

/**
 * Writes appearance preferences onto the document root, giving stylesheets a
 * single source for user-tunable appearance.
 */
export function applyAppearanceToDocument(params: {
  os: OperatingSystem;
  preferences: AppearancePreferences;
  root?: HTMLElement;
  surface: RuntimeSurface;
}): void {
  const root = params.root ?? document.documentElement;
  const state = appearanceRootState({
    os: params.os,
    preferences: params.preferences,
    prefersReducedMotion: systemPrefersReducedMotion(),
    surface: params.surface,
  });

  // Variables the state omits must be cleared, or returning a color to its
  // default would leave the previous inline value stuck on the root.
  for (const name of OPTIONAL_VARIABLES) {
    if (!(name in state.variables)) {
      root.style.removeProperty(name);
    }
  }
  for (const [name, value] of Object.entries(state.variables)) {
    root.style.setProperty(name, value);
  }
  for (const [name, value] of Object.entries(state.attributes)) {
    root.setAttribute(name, value);
  }
}
