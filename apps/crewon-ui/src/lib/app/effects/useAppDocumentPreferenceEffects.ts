import { useEffect, type MutableRefObject } from "react";
import type { Thread } from "@crewon/app-server-protocol/v2/Thread";

import type { AppServerClient } from "../../app-server/appServer";
import { appDocumentTitle } from "../appDocumentActions";
import { applyDesktopPreferencesAction } from "../appPreferenceActions";
import { parseAppearancePreferences } from "../../appearance/appearanceSerialization";
import { setAppliedAppearance } from "../../appearance/appearanceRuntime";
import { systemPrefersDark } from "../../appearance/applyAppearance";
import { persistLocale, type Locale } from "../../i18n";
import { persistTheme, type Theme } from "../../theme";

export type AppDocumentPreferenceEffectsParams = {
  client: AppServerClient | null;
  composerValue: string;
  cwd: string;
  isConnected: boolean;
  locale: Locale;
  localeRef: MutableRefObject<Locale>;
  setLocale: (locale: Locale) => void;
  setTheme: (theme: Theme) => void;
  theme: Theme;
  thread: Thread | null;
  untitledThreadLabel: string;
};

export function useAppDocumentPreferenceEffects({
  client,
  composerValue,
  cwd,
  isConnected,
  locale,
  localeRef,
  setLocale,
  setTheme,
  theme,
  thread,
  untitledThreadLabel,
}: AppDocumentPreferenceEffectsParams) {
  useEffect(() => {
    localeRef.current = locale;
    document.documentElement.lang = locale === "zh" ? "zh-CN" : "en";
  }, [locale, localeRef]);

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
  }, [theme]);

  useEffect(() => {
    document.title = appDocumentTitle({
      composerValue,
      thread,
      untitledThreadLabel,
    });
  }, [composerValue, thread, untitledThreadLabel]);

  useEffect(() => {
    if (!isConnected) {
      return;
    }

    let cancelled = false;
    void client
      ?.readConfig(cwd)
      .then((configRead) => {
        if (cancelled) {
          return;
        }

        const themeOverride = new URLSearchParams(window.location.search).get(
          "theme",
        );

        const desktopConfig = configRead.config.desktop as Record<
          string,
          unknown
        > | null;

        applyDesktopPreferencesAction({
          desktopConfig,
          persistLocale,
          persistTheme,
          prefersDark: systemPrefersDark(),
          setLocale,
          setTheme,
          themeOverride,
        });

        // Colors, fonts, and behavior flags land on the document root here so
        // the stylesheets can read them independently of the theme.
        setAppliedAppearance(parseAppearancePreferences(desktopConfig));
      })
      .catch(() => {
        // Desktop preferences are best-effort; config/settings panels surface detailed errors.
      });

    return () => {
      cancelled = true;
    };
  }, [client, cwd, isConnected, setLocale, setTheme]);
}
