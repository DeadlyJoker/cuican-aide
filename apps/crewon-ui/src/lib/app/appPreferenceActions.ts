import {
  DESKTOP_LOCALE_KEY_PATH,
  DESKTOP_THEME_KEY_PATH,
} from "./appRuntimeState";
import { desktopPreferenceSyncFailureNotice } from "./appNotificationPresentation";
import { parseAppearancePreferences } from "../appearance/appearanceSerialization";
import { resolveThemeMode } from "../appearance/applyAppearance";
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

type ControlPreferenceClient = {
  getLocalSettings(): Promise<{
    settings: { locale: Locale; theme: "dark" | "light" };
  }>;
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
  setNotice: (
    notice: ReturnType<typeof desktopPreferenceSyncFailureNotice>,
  ) => void;
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
      params.setNotice(
        desktopPreferenceSyncFailureNotice(error, params.locale),
      );
    });
}

export function applyDesktopPreferencesAction(params: {
  desktopConfig: Record<string, unknown> | null | undefined;
  persistLocale: LocalePersistence;
  persistTheme: ThemePersistence;
  /** Supplied by the caller so this action stays free of platform lookups. */
  prefersDark?: boolean;
  setLocale: LocaleSetter;
  setTheme: (theme: Theme) => void;
  themeOverride: string | null;
}): void {
  const configuredLocale = params.desktopConfig?.uiLocale;
  const preferences = parseAppearancePreferences(params.desktopConfig);

  if (configuredLocale === "zh" || configuredLocale === "en") {
    params.setLocale(configuredLocale);
    params.persistLocale(configuredLocale);
  }

  if (params.themeOverride === "light" || params.themeOverride === "dark") {
    return;
  }

  const resolvedTheme = resolveThemeMode(
    preferences.themeMode,
    params.prefersDark ?? false,
  );
  params.setTheme(resolvedTheme);
  params.persistTheme(resolvedTheme);
}

export async function hydrateControlPreferencesAction(params: {
  client: ControlPreferenceClient;
  locale: Locale;
  persistLocale: LocalePersistence;
  persistTheme: ThemePersistence;
  setAppliedAppearance: (desktopConfig: Record<string, unknown>) => void;
  setLocale: LocaleSetter;
  setNotice: (
    notice: ReturnType<typeof desktopPreferenceSyncFailureNotice>,
  ) => void;
  setTheme: (theme: Theme) => void;
}): Promise<void> {
  try {
    const { settings } = await params.client.getLocalSettings();
    const desktopConfig = {
      uiLocale: settings.locale,
      appearanceTheme: settings.theme,
    };
    params.setLocale(settings.locale);
    params.setTheme(settings.theme);
    params.persistLocale(settings.locale);
    params.persistTheme(settings.theme);
    params.setAppliedAppearance(desktopConfig);
  } catch (error) {
    params.setNotice(desktopPreferenceSyncFailureNotice(error, params.locale));
  }
}
