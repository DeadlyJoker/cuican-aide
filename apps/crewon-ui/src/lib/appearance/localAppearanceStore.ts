import type { AppearancePreferences } from "./appearancePreferences";
import {
  APPEARANCE_KEY_PATHS,
  parseAppearancePreferences,
} from "./appearanceSerialization";
import { THEME_STORAGE_KEY } from "../theme";

export const LOCAL_APPEARANCE_KEY = "crewon:appearance:v1";
type AppearanceStorage = Pick<Storage, "getItem" | "setItem">;

function browserStorage(): AppearanceStorage | null {
  try {
    return typeof window === "undefined" ? null : window.localStorage;
  } catch {
    return null;
  }
}

export function readLocalAppearance(
  storage = browserStorage(),
): AppearancePreferences | null {
  try {
    const raw = storage?.getItem(LOCAL_APPEARANCE_KEY);
    if (!raw) return null;
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
      return null;
    return parseAppearancePreferences(parsed as Record<string, unknown>);
  } catch {
    return null;
  }
}

/** Local UI preferences only. Never stores credentials or execution policy. */
export function persistLocalAppearanceField(
  field: keyof AppearancePreferences,
  value: string,
  storage = browserStorage(),
): void {
  if (!storage) throw new Error("appearance_storage_unavailable");
  const current =
    readLocalAppearance(storage) ??
    parseAppearancePreferences({
      appearanceTheme: storage.getItem(THEME_STORAGE_KEY),
    });
  const config: Record<string, unknown> = {};
  if (current) {
    for (const [key, path] of Object.entries(APPEARANCE_KEY_PATHS)) {
      config[path.slice("desktop.".length)] =
        current[key as keyof AppearancePreferences];
    }
  }
  config[APPEARANCE_KEY_PATHS[field].slice("desktop.".length)] = value;
  try {
    storage.setItem(LOCAL_APPEARANCE_KEY, JSON.stringify(config));
  } catch {
    throw new Error("appearance_storage_unavailable");
  }
}
