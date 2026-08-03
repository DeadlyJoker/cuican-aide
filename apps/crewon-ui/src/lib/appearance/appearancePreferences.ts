import type { OperatingSystem } from "../platform";

export type AppearanceThemeMode = "dark" | "light" | "system";
export type DiffMarkerStyle = "color" | "sign";
export type ReduceMotionMode = "off" | "on" | "system";

/**
 * User-tunable appearance. Every field here must actually change what the user
 * sees; nothing in this type is decorative.
 */
export type AppearancePreferences = {
  accent: string;
  background: string;
  codeFontFamily: string;
  codeFontSize: number;
  contrast: number;
  diffMarkers: DiffMarkerStyle;
  foreground: string;
  fontSmoothing: boolean;
  reduceMotion: ReduceMotionMode;
  themeMode: AppearanceThemeMode;
  translucentSidebar: boolean;
  uiFontFamily: string;
  uiFontSize: number;
};

export const UI_FONT_SIZE_RANGE = { max: 18, min: 10 } as const;
export const CODE_FONT_SIZE_RANGE = { max: 20, min: 10 } as const;
export const CONTRAST_RANGE = { max: 100, min: 0 } as const;

export const DEFAULT_UI_FONT_STACK =
  '-apple-system, BlinkMacSystemFont, "SF Pro Text", "PingFang SC", "Segoe UI", system-ui, sans-serif';
export const DEFAULT_CODE_FONT_STACK =
  'ui-monospace, "SFMono-Regular", "JetBrains Mono", Menlo, Consolas, monospace';

/*
 * Defaults must equal what the stylesheets already paint, otherwise merely
 * opening the panel would appear to change the theme. The accent is the shell's
 * near-black (one emphasis color, matching the send button) rather than a blue.
 */
export const DEFAULT_APPEARANCE: AppearancePreferences = {
  accent: "#1f1f1f",
  background: "#f7f7f8",
  codeFontFamily: DEFAULT_CODE_FONT_STACK,
  codeFontSize: 12,
  contrast: 45,
  diffMarkers: "color",
  foreground: "#1b1b1b",
  fontSmoothing: true,
  reduceMotion: "system",
  themeMode: "system",
  translucentSidebar: true,
  uiFontFamily: DEFAULT_UI_FONT_STACK,
  uiFontSize: 12,
};

/**
 * Font smoothing maps to `-webkit-font-smoothing: antialiased`, which is a
 * macOS-only rendering path. Exposing it elsewhere would be a control that
 * does nothing.
 */
export function supportsFontSmoothing(os: OperatingSystem): boolean {
  return os === "mac";
}
