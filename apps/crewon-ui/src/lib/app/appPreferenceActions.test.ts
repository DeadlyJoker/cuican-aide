import { describe, expect, it, vi } from "vitest";

import {
  DESKTOP_LOCALE_KEY_PATH,
  DESKTOP_THEME_KEY_PATH,
} from "./appRuntimeState";
import {
  applyDesktopPreferencesAction,
  changeLocalePreferenceAction,
  syncDesktopPreferenceAction,
  toggleThemePreferenceAction,
} from "./appPreferenceActions";
import type { NoticeState } from "./appRuntimeState";
import type { Locale } from "../i18n";
import type { Theme } from "../theme";

async function flushAsyncWork() {
  await Promise.resolve();
  await Promise.resolve();
}

describe("app preference actions", () => {
  it("changes locale across state, local persistence, and desktop config", () => {
    let locale: Locale = "en";
    const persistLocale = vi.fn();
    const syncDesktopPreference = vi.fn();

    changeLocalePreferenceAction({
      nextLocale: "zh",
      persistLocale,
      setLocale: (nextLocale) => {
        locale = nextLocale;
      },
      syncDesktopPreference,
    });

    expect(locale).toBe("zh");
    expect(persistLocale).toHaveBeenCalledWith("zh");
    expect(syncDesktopPreference).toHaveBeenCalledWith(
      DESKTOP_LOCALE_KEY_PATH,
      "zh",
    );
  });

  it("toggles theme across state, local persistence, and desktop config", () => {
    let theme: Theme = "light";
    const persistTheme = vi.fn();
    const syncDesktopPreference = vi.fn();

    toggleThemePreferenceAction({
      persistTheme,
      setTheme: (updater) => {
        theme = updater(theme);
      },
      syncDesktopPreference,
    });

    expect(theme).toBe("dark");
    expect(persistTheme).toHaveBeenCalledWith("dark");
    expect(syncDesktopPreference).toHaveBeenCalledWith(
      DESKTOP_THEME_KEY_PATH,
      "dark",
    );
  });

  it("skips desktop preference sync while disconnected", () => {
    const writeConfigBatch = vi.fn();

    syncDesktopPreferenceAction({
      client: { writeConfigBatch },
      isConnected: false,
      keyPath: DESKTOP_LOCALE_KEY_PATH,
      locale: "en",
      setNotice: vi.fn(),
      value: "zh",
    });

    expect(writeConfigBatch).not.toHaveBeenCalled();
  });

  it("syncs desktop preferences through config upsert edits", async () => {
    const writeConfigBatch = vi.fn(async () => undefined);

    syncDesktopPreferenceAction({
      client: { writeConfigBatch },
      isConnected: true,
      keyPath: DESKTOP_THEME_KEY_PATH,
      locale: "en",
      setNotice: vi.fn(),
      value: "dark",
    });
    await flushAsyncWork();

    expect(writeConfigBatch).toHaveBeenCalledWith([
      {
        keyPath: DESKTOP_THEME_KEY_PATH,
        value: "dark",
        mergeStrategy: "upsert",
      },
    ]);
  });

  it("surfaces desktop preference sync failures", async () => {
    const notices: NoticeState[] = [];

    syncDesktopPreferenceAction({
      client: {
        async writeConfigBatch() {
          throw new Error("config denied");
        },
      },
      isConnected: true,
      keyPath: DESKTOP_LOCALE_KEY_PATH,
      locale: "en",
      setNotice: (notice) => {
        notices.push(notice);
      },
      value: "zh",
    });
    await flushAsyncWork();

    expect(notices).toEqual([
      {
        text: "config denied",
        tone: "warning",
      },
    ]);
  });

  it("applies desktop locale and theme preferences", () => {
    let locale: Locale = "en";
    let theme: Theme = "dark";
    const persistedLocales: Locale[] = [];
    const persistedThemes: Theme[] = [];

    applyDesktopPreferencesAction({
      desktopConfig: {
        uiLocale: "zh",
        appearanceTheme: "light",
      },
      persistLocale: (nextLocale) => {
        persistedLocales.push(nextLocale);
      },
      persistTheme: (nextTheme) => {
        persistedThemes.push(nextTheme);
      },
      setLocale: (nextLocale) => {
        locale = nextLocale;
      },
      setTheme: (nextTheme) => {
        theme = nextTheme;
      },
      themeOverride: null,
    });

    expect(locale).toBe("zh");
    expect(theme).toBe("light");
    expect(persistedLocales).toEqual(["zh"]);
    expect(persistedThemes).toEqual(["light"]);
  });

  it("does not apply invalid desktop values or override an explicit theme", () => {
    let locale: Locale = "en";
    let theme: Theme = "dark";
    const persistLocale = vi.fn();
    const persistTheme = vi.fn();

    applyDesktopPreferencesAction({
      desktopConfig: {
        uiLocale: "fr",
        appearanceTheme: "light",
      },
      persistLocale,
      persistTheme,
      setLocale: (nextLocale) => {
        locale = nextLocale;
      },
      setTheme: (nextTheme) => {
        theme = nextTheme;
      },
      themeOverride: "dark",
    });

    expect(locale).toBe("en");
    expect(theme).toBe("dark");
    expect(persistLocale).not.toHaveBeenCalled();
    expect(persistTheme).not.toHaveBeenCalled();
  });
});
