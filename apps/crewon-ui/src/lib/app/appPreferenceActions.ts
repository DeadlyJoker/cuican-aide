import {
  DESKTOP_LOCALE_KEY_PATH,
  DESKTOP_THEME_KEY_PATH,
} from "./appRuntimeState";
import { desktopPreferenceSyncFailureNotice } from "./appNotificationPresentation";
import type { Locale } from "../i18n";
import type { Theme } from "../theme";

type DesktopPreferenceClient = {
  writeConfigBatch(
    edits: Array<{
      keyPath: string;
      value: string;
      mergeStrategy?: "upsert";
    }>,
  ): Promise<unknown>;
};

export type DesktopPreferenceSync = (keyPath: string, value: string) => void;
export type LocaleSetter = (locale: Locale) => void;
export type LocalePersistence = (locale: Locale) => void;
export type ThemePersistence = (theme: Theme) => void;
export type ThemeUpdaterSetter = (
  updater: (currentTheme: Theme) => Theme,
) => void;

export function changeLocalePreferenceAction(params: {
  nextLocale: Locale;
  persistLocale: LocalePersistence;
  setLocale: LocaleSetter;
  syncDesktopPreference: DesktopPreferenceSync;
}): void {
  params.setLocale(params.nextLocale);
  params.persistLocale(params.nextLocale);
  params.syncDesktopPreference(DESKTOP_LOCALE_KEY_PATH, params.nextLocale);
}

export function toggleThemePreferenceAction(params: {
  persistTheme: ThemePersistence;
  setTheme: ThemeUpdaterSetter;
  syncDesktopPreference: DesktopPreferenceSync;
}): void {
  params.setTheme((currentTheme) => {
    const nextTheme = currentTheme === "light" ? "dark" : "light";
    params.persistTheme(nextTheme);
    params.syncDesktopPreference(DESKTOP_THEME_KEY_PATH, nextTheme);
    return nextTheme;
  });
}

export function syncDesktopPreferenceAction(params: {
  client: DesktopPreferenceClient | null | undefined;
  isConnected: boolean;
  keyPath: string;
  locale: Locale;
  setNotice: (notice: ReturnType<typeof desktopPreferenceSyncFailureNotice>) => void;
  value: string;
}): void {
  if (!params.isConnected) {
    return;
  }

  void params.client
    ?.writeConfigBatch([
      {
        keyPath: params.keyPath,
        value: params.value,
        mergeStrategy: "upsert",
      },
    ])
    .catch((error) => {
      params.setNotice(desktopPreferenceSyncFailureNotice(error, params.locale));
    });
}

export function applyDesktopPreferencesAction(params: {
  desktopConfig: Record<string, unknown> | null | undefined;
  persistLocale: LocalePersistence;
  persistTheme: ThemePersistence;
  setLocale: LocaleSetter;
  setTheme: (theme: Theme) => void;
  themeOverride: string | null;
}): void {
  const configuredLocale = params.desktopConfig?.uiLocale;
  const configuredTheme = params.desktopConfig?.appearanceTheme;

  if (configuredLocale === "zh" || configuredLocale === "en") {
    params.setLocale(configuredLocale);
    params.persistLocale(configuredLocale);
  }

  if (
    params.themeOverride !== "light" &&
    params.themeOverride !== "dark" &&
    (configuredTheme === "light" || configuredTheme === "dark")
  ) {
    params.setTheme(configuredTheme);
    params.persistTheme(configuredTheme);
  }
}
