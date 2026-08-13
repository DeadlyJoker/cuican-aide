import { describe, expect, it } from "vitest";

import type { CapabilityPanel } from "../capability/capabilityPanelTypes";
import { createSettingsSaveHandlers } from "./settingsSaveActions";
import type { ConfigEdit } from "./settingsSavePayloads";
import type { Locale } from "../i18n";
import type { Theme } from "../theme";

async function flushAsyncSave() {
  await Promise.resolve();
  await Promise.resolve();
}

describe("settings save actions", () => {
  it("saves config edits and refreshes the config panel", async () => {
    let panel: CapabilityPanel | null = {
      title: "Config",
      subtitle: "Current path",
      body: "Ready",
    };
    const writes: ConfigEdit[][] = [];
    let refreshes = 0;
    const handlers = createSettingsSaveHandlers({
      client: {
        async writeConfigBatch(edits) {
          writes.push(edits);
          return { filePath: "/repo/config.toml", status: "ok", version: 9 };
        },
      },
      fieldValue: (fieldId) =>
        fieldId === "config-model"
          ? "gpt-5"
          : fieldId === "config-sandbox-mode"
            ? "workspace-write"
            : "",
      isConnected: true,
      locale: "en",
      persistLocale: () => {},
      persistTheme: () => {},
      refreshAppearanceSettingsPanel: () => {},
      refreshConfigPanel: () => {
        refreshes += 1;
      },
      refreshPersonalizationSettingsPanel: () => {},
      setCapabilityPanel: (updater) => {
        panel = updater(panel);
      },
      setLocale: () => {},
      setTheme: () => {},
      theme: "dark",
    });

    handlers.config();
    expect(panel).toMatchObject({
      body: "Saving config...",
      error: undefined,
    });

    await flushAsyncSave();

    expect(writes).toEqual([
      [
        { keyPath: "model", value: "gpt-5" },
        { keyPath: "sandbox_mode", value: "workspace-write" },
      ],
    ]);
    expect(refreshes).toBe(1);
    expect(panel).toEqual({
      title: "Config",
      subtitle: "/repo/config.toml",
      body: "Config saved and hot-reloaded\nversion: 9\nstatus: ok",
      error: undefined,
    });
  });

  it("shows validation errors when config has no values to save", () => {
    let panel: CapabilityPanel | null = {
      title: "Config",
      body: "Ready",
    };
    let writes = 0;
    const handlers = createSettingsSaveHandlers({
      client: {
        async writeConfigBatch() {
          writes += 1;
          return null;
        },
      },
      fieldValue: () => "",
      isConnected: true,
      locale: "zh",
      persistLocale: () => {},
      persistTheme: () => {},
      refreshAppearanceSettingsPanel: () => {},
      refreshConfigPanel: () => {},
      refreshPersonalizationSettingsPanel: () => {},
      setCapabilityPanel: (updater) => {
        panel = updater(panel);
      },
      setLocale: () => {},
      setTheme: () => {},
      theme: "dark",
    });

    handlers.config();

    expect(writes).toBe(0);
    expect(panel).toEqual({
      title: "Config",
      body: "Ready",
      error: "没有可保存的配置项",
    });
  });

  it("saves appearance changes and persists local preferences", async () => {
    let panel: CapabilityPanel | null = {
      title: "Appearance",
      body: "Ready",
    };
    let locale: Locale = "en";
    let theme: Theme = "light";
    const persistedLocales: Locale[] = [];
    const persistedThemes: Theme[] = [];
    let refreshes = 0;
    const handlers = createSettingsSaveHandlers({
      controlClient: {
        async getLocalSettings() {
          return {
            settings: {
              locale: "en" as const,
              theme: "light" as const,
              revision: 1,
              updatedAt: null,
            },
          };
        },
        async putLocalSettings(input) {
          return {
            settings: {
              locale: input.locale,
              theme: input.theme,
              revision: 2,
              updatedAt: null,
            },
          };
        },
      },
      client: {
        async writeConfigBatch() {
          return { status: "ok", version: 2 };
        },
      },
      fieldValue: (fieldId) =>
        fieldId === "appearance-locale"
          ? "zh"
          : fieldId === "appearance-theme"
            ? "dark"
            : "",
      isConnected: true,
      locale,
      persistLocale: (nextLocale) => persistedLocales.push(nextLocale),
      persistTheme: (nextTheme) => persistedThemes.push(nextTheme),
      refreshAppearanceSettingsPanel: () => {
        refreshes += 1;
      },
      refreshConfigPanel: () => {},
      refreshPersonalizationSettingsPanel: () => {},
      setCapabilityPanel: (updater) => {
        panel = updater(panel);
      },
      setLocale: (nextLocale) => {
        locale = nextLocale;
      },
      setTheme: (nextTheme) => {
        theme = nextTheme;
      },
      theme,
    });

    handlers.appearance();
    await flushAsyncSave();

    expect(locale).toBe("zh");
    expect(theme).toBe("dark");
    expect(persistedLocales).toEqual(["zh"]);
    expect(persistedThemes).toEqual(["dark"]);
    expect(refreshes).toBe(1);
    expect(panel).toMatchObject({
      body: "Appearance saved\nversion: -\nstatus: ok",
      error: undefined,
    });
  });
});
