import { describe, expect, it, vi } from "vitest";

import { commitSettingsFieldAction } from "./settingsFieldCommitActions";

describe("commitSettingsFieldAction", () => {
  it("applies and persists appearance preferences before syncing config", async () => {
    const calls: string[] = [];
    const client = {
      writeConfigBatch: vi.fn(async () => {
        calls.push("sync");
      }),
    };

    await commitSettingsFieldAction({
      client,
      fieldId: "appearance-theme",
      isConnected: true,
      persistLocale: vi.fn(),
      persistTheme: (theme) => calls.push(`persist:${theme}`),
      setLocale: vi.fn(),
      setTheme: (theme) => calls.push(`apply:${theme}`),
      value: "dark",
    });

    expect(calls).toEqual(["apply:dark", "persist:dark", "sync"]);
    expect(client.writeConfigBatch).toHaveBeenCalledWith([
      {
        keyPath: "desktop.appearanceTheme",
        mergeStrategy: "upsert",
        value: "dark",
      },
    ]);
  });

  it("writes config fields directly without waiting for a group save", async () => {
    const writeConfigBatch = vi.fn(async () => {});

    await commitSettingsFieldAction({
      client: { writeConfigBatch },
      fieldId: "config-model",
      isConnected: true,
      persistLocale: vi.fn(),
      persistTheme: vi.fn(),
      setLocale: vi.fn(),
      setTheme: vi.fn(),
      value: "gpt-5.6",
    });

    expect(writeConfigBatch).toHaveBeenCalledWith([
      { keyPath: "model", mergeStrategy: "upsert", value: "gpt-5.6" },
    ]);
  });
});
