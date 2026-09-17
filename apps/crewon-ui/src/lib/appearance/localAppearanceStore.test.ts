import { describe, expect, it, vi } from "vitest";
import {
  LOCAL_APPEARANCE_KEY,
  persistLocalAppearanceField,
  readLocalAppearance,
} from "./localAppearanceStore";
import { THEME_STORAGE_KEY } from "../theme";
import { commitSettingsFieldAction } from "../settings/settingsFieldCommitActions";

function storage() {
  const values = new Map<string, string>();
  return {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => {
      values.set(key, value);
    },
  };
}

describe("local appearance persistence", () => {
  it("migrates the existing theme on first edit and merges later preferences", () => {
    const store = storage();
    store.setItem(THEME_STORAGE_KEY, "dark");
    persistLocalAppearanceField("uiFontSize", "14", store);
    persistLocalAppearanceField("reduceMotion", "on", store);
    expect(readLocalAppearance(store)).toMatchObject({
      themeMode: "dark",
      uiFontSize: 14,
      reduceMotion: "on",
    });
    persistLocalAppearanceField("themeMode", "system", store);
    expect(readLocalAppearance(store)?.themeMode).toBe("system");
  });

  it("ignores corrupt storage and normalizes bounded fields", () => {
    const store = storage();
    for (const raw of ["{broken", "null", "[]", "5"]) {
      store.setItem(LOCAL_APPEARANCE_KEY, raw);
      expect(readLocalAppearance(store)).toBeNull();
    }
    store.setItem(
      LOCAL_APPEARANCE_KEY,
      '{"uiFontSize":999,"appearanceAccent":"invalid"}',
    );
    expect(readLocalAppearance(store)).toMatchObject({
      uiFontSize: 18,
      accent: "#1f1f1f",
    });
  });

  it("commits a normalized local preference without an app-server", async () => {
    const store = storage();
    const apply = vi.fn();
    const result = await commitSettingsFieldAction({
      client: null,
      isConnected: false,
      fieldId: "appearance-ui-font-size",
      value: "999",
      setLocale: vi.fn(),
      persistLocale: vi.fn(),
      setTheme: vi.fn(),
      persistTheme: vi.fn(),
      applyAppearanceField: apply,
      persistLocalAppearanceField: (field, value) =>
        persistLocalAppearanceField(field, value, store),
    });
    expect(result.normalized).toBe(true);
    expect(readLocalAppearance(store)?.uiFontSize).toBe(18);
    expect(apply).toHaveBeenCalledWith("uiFontSize", "18");
  });

  it("does not paint unsaved changes when local storage rejects a write", async () => {
    const apply = vi.fn();
    const store = {
      getItem: () => null,
      setItem: () => {
        throw new Error("quota");
      },
    };
    await expect(
      commitSettingsFieldAction({
        client: null,
        isConnected: false,
        fieldId: "appearance-ui-font-size",
        value: "14",
        setLocale: vi.fn(),
        persistLocale: vi.fn(),
        setTheme: vi.fn(),
        persistTheme: vi.fn(),
        applyAppearanceField: apply,
        persistLocalAppearanceField: (field, value) =>
          persistLocalAppearanceField(field, value, store),
      }),
    ).rejects.toThrow("appearance_storage_unavailable");
    expect(apply).not.toHaveBeenCalled();
  });

  it("never treats local appearance storage as execution-policy persistence", async () => {
    const persistLocal = vi.fn();
    await expect(
      commitSettingsFieldAction({
        client: null,
        isConnected: false,
        fieldId: "config-sandbox-mode",
        value: "danger-full-access",
        setLocale: vi.fn(),
        persistLocale: vi.fn(),
        setTheme: vi.fn(),
        persistTheme: vi.fn(),
        persistLocalAppearanceField: persistLocal,
      }),
    ).rejects.toThrow("not connected");
    expect(persistLocal).not.toHaveBeenCalled();
  });
});
