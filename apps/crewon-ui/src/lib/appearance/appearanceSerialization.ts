import {
  CODE_FONT_SIZE_RANGE,
  CONTRAST_RANGE,
  DEFAULT_APPEARANCE,
  UI_FONT_SIZE_RANGE,
  type AppearancePreferences,
  type AppearanceThemeMode,
  type DiffMarkerStyle,
  type ReduceMotionMode,
} from "./appearancePreferences";

/** Config keys under `desktop.*`, kept flat so writeConfigBatch can upsert them. */
export const APPEARANCE_KEY_PATHS = {
  accent: "desktop.appearanceAccent",
  background: "desktop.appearanceBackground",
  codeFontFamily: "desktop.codeFontFamily",
  codeFontSize: "desktop.codeFontSize",
  contrast: "desktop.appearanceContrast",
  diffMarkers: "desktop.diffMarkers",
  fontSmoothing: "desktop.fontSmoothing",
  foreground: "desktop.appearanceForeground",
  reduceMotion: "desktop.reduceMotion",
  themeMode: "desktop.appearanceTheme",
  translucentSidebar: "desktop.translucentSidebar",
  uiFontFamily: "desktop.uiFontFamily",
  uiFontSize: "desktop.uiFontSize",
} as const satisfies Record<keyof AppearancePreferences, string>;

const HEX_COLOR = /^#[0-9a-f]{6}$/i;

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function readColor(raw: unknown, fallback: string): string {
  return typeof raw === "string" && HEX_COLOR.test(raw.trim())
    ? raw.trim().toLowerCase()
    : fallback;
}

function readNumber(
  raw: unknown,
  fallback: number,
  range: { max: number; min: number },
): number {
  const parsed =
    typeof raw === "number" ? raw : Number.parseFloat(String(raw ?? ""));
  return Number.isFinite(parsed)
    ? Math.round(clamp(parsed, range.min, range.max))
    : fallback;
}

function readBoolean(raw: unknown, fallback: boolean): boolean {
  if (typeof raw === "boolean") return raw;
  if (raw === "true") return true;
  if (raw === "false") return false;
  return fallback;
}

function readFontStack(raw: unknown, fallback: string): string {
  return typeof raw === "string" && raw.trim() ? raw.trim() : fallback;
}

function readThemeMode(raw: unknown): AppearanceThemeMode {
  return raw === "dark" || raw === "light" || raw === "system"
    ? raw
    : DEFAULT_APPEARANCE.themeMode;
}

function readReduceMotion(raw: unknown): ReduceMotionMode {
  return raw === "off" || raw === "on" || raw === "system"
    ? raw
    : DEFAULT_APPEARANCE.reduceMotion;
}

function readDiffMarkers(raw: unknown): DiffMarkerStyle {
  return raw === "color" || raw === "sign"
    ? raw
    : DEFAULT_APPEARANCE.diffMarkers;
}

/** Reads appearance out of the `desktop` config table, falling back per field. */
export function parseAppearancePreferences(
  desktopConfig: Record<string, unknown> | null | undefined,
): AppearancePreferences {
  const config = desktopConfig ?? {};
  return {
    accent: readColor(config.appearanceAccent, DEFAULT_APPEARANCE.accent),
    background: readColor(
      config.appearanceBackground,
      DEFAULT_APPEARANCE.background,
    ),
    codeFontFamily: readFontStack(
      config.codeFontFamily,
      DEFAULT_APPEARANCE.codeFontFamily,
    ),
    codeFontSize: readNumber(
      config.codeFontSize,
      DEFAULT_APPEARANCE.codeFontSize,
      CODE_FONT_SIZE_RANGE,
    ),
    contrast: readNumber(
      config.appearanceContrast,
      DEFAULT_APPEARANCE.contrast,
      CONTRAST_RANGE,
    ),
    diffMarkers: readDiffMarkers(config.diffMarkers),
    fontSmoothing: readBoolean(
      config.fontSmoothing,
      DEFAULT_APPEARANCE.fontSmoothing,
    ),
    foreground: readColor(
      config.appearanceForeground,
      DEFAULT_APPEARANCE.foreground,
    ),
    reduceMotion: readReduceMotion(config.reduceMotion),
    themeMode: readThemeMode(config.appearanceTheme),
    translucentSidebar: readBoolean(
      config.translucentSidebar,
      DEFAULT_APPEARANCE.translucentSidebar,
    ),
    uiFontFamily: readFontStack(
      config.uiFontFamily,
      DEFAULT_APPEARANCE.uiFontFamily,
    ),
    uiFontSize: readNumber(
      config.uiFontSize,
      DEFAULT_APPEARANCE.uiFontSize,
      UI_FONT_SIZE_RANGE,
    ),
  };
}

/**
 * Applies one committed field to preferences by round-tripping through the
 * config shape, so a value typed into the panel is validated by exactly the
 * same rules that read it back from disk.
 */
export function appearanceWithField(
  preferences: AppearancePreferences,
  field: keyof AppearancePreferences,
  value: string,
): AppearancePreferences {
  const configKey = APPEARANCE_KEY_PATHS[field].replace("desktop.", "");
  return parseAppearancePreferences({
    ...appearanceToDesktopConfig(preferences),
    [configKey]: value,
  });
}

/** Inverse of parseAppearancePreferences, used to re-validate a single edit. */
function appearanceToDesktopConfig(
  preferences: AppearancePreferences,
): Record<string, unknown> {
  const config: Record<string, unknown> = {};
  for (const [field, keyPath] of Object.entries(APPEARANCE_KEY_PATHS)) {
    config[keyPath.replace("desktop.", "")] =
      preferences[field as keyof AppearancePreferences];
  }
  return config;
}

export type AppearanceConfigEdit = {
  keyPath: string;
  mergeStrategy: "upsert";
  value: string;
};

/** Serializes one appearance field into a config edit for writeConfigBatch. */
export function appearanceConfigEdit<Field extends keyof AppearancePreferences>(
  field: Field,
  value: AppearancePreferences[Field],
): AppearanceConfigEdit {
  return {
    keyPath: APPEARANCE_KEY_PATHS[field],
    mergeStrategy: "upsert",
    value: String(value),
  };
}
