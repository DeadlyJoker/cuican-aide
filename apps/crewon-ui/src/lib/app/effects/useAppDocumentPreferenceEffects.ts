import { useEffect, type MutableRefObject } from "react";
import type { Thread } from "@crewon-protocol/v2/Thread";
import type { ControlApiClient } from "@crewon/control-client";

import { appDocumentTitle } from "../appDocumentActions";
import { hydrateControlPreferencesAction } from "../appPreferenceActions";
import { parseAppearancePreferences } from "../../appearance/appearanceSerialization";
import { setAppliedAppearance } from "../../appearance/appearanceRuntime";
import { persistLocale, type Locale } from "../../i18n";
import { persistTheme, type Theme } from "../../theme";
import type { NoticeState } from "../appRuntimeState";

export type AppDocumentPreferenceEffectsParams = {
  client: Pick<ControlApiClient, "getLocalSettings">;
  composerValue: string;
  controlRuntimeConnected: boolean;
  locale: Locale;
  localeRef: MutableRefObject<Locale>;
  setLocale: (locale: Locale) => void;
  setNotice: (notice: NoticeState | null) => void;
  setTheme: (theme: Theme) => void;
  theme: Theme;
  thread: Thread | null;
  untitledThreadLabel: string;
};

export function useAppDocumentPreferenceEffects({
  client,
  composerValue,
  controlRuntimeConnected,
  locale,
  localeRef,
  setLocale,
  setNotice,
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
    if (!controlRuntimeConnected) {
      return;
    }

    let cancelled = false;
    void hydrateControlPreferencesAction({
      client,
      locale,
      persistLocale: (nextLocale) => {
        if (!cancelled) persistLocale(nextLocale);
      },
      persistTheme: (nextTheme) => {
        if (!cancelled) persistTheme(nextTheme);
      },
      setAppliedAppearance: (desktopConfig) => {
        if (!cancelled) {
          setAppliedAppearance(parseAppearancePreferences(desktopConfig));
        }
      },
      setLocale: (nextLocale) => {
        if (!cancelled) setLocale(nextLocale);
      },
      setNotice: (nextNotice) => {
        if (!cancelled) setNotice(nextNotice);
      },
      setTheme: (nextTheme) => {
        if (!cancelled) setTheme(nextTheme);
      },
    });

    return () => {
      cancelled = true;
    };
  }, [client, controlRuntimeConnected, locale, setLocale, setNotice, setTheme]);
}
