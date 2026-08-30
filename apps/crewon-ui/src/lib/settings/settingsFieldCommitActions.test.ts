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

  it("applies css-only appearance fields to the live document", async () => {
    const applied: Array<[string, string]> = [];

    await commitSettingsFieldAction({
      applyAppearanceField: (field, value) => applied.push([field, value]),
      client: { writeConfigBatch: vi.fn(async () => {}) },
      fieldId: "appearance-accent",
      isConnected: true,
      persistLocale: vi.fn(),
      persistTheme: vi.fn(),
      setLocale: vi.fn(),
      setTheme: vi.fn(),
      value: "#3355ff",
    });

    expect(applied).toEqual([["accent", "#3355ff"]]);
  });

  it("reports no normalization for a valid value, so no panel re-read happens", async () => {
    const outcome = await commitSettingsFieldAction({
      client: { writeConfigBatch: vi.fn(async () => {}) },
      fieldId: "appearance-ui-font-size",
      isConnected: true,
      persistLocale: vi.fn(),
      persistTheme: vi.fn(),
      setLocale: vi.fn(),
      setTheme: vi.fn(),
      value: "14",
    });

    expect(outcome).toEqual({ normalized: false });
  });

  it("persists the clamped value so the panel cannot show an inert number", async () => {
    const edits: unknown[] = [];
    const applied: Array<[string, string]> = [];

    const outcome = await commitSettingsFieldAction({
      applyAppearanceField: (field, value) => applied.push([field, value]),
      client: {
        writeConfigBatch: async (batch) => {
          edits.push(...batch);
        },
      },
      fieldId: "appearance-ui-font-size",
      isConnected: true,
      persistLocale: vi.fn(),
      persistTheme: vi.fn(),
      setLocale: vi.fn(),
      setTheme: vi.fn(),
      value: "999",
    });

    // 999 is outside the 10..18 range, so 18 is what gets stored and applied.
    expect({ applied, edits, outcome }).toEqual({
      outcome: { normalized: true },
      applied: [["uiFontSize", "18"]],
      edits: [
        {
          keyPath: "desktop.uiFontSize",
          mergeStrategy: "upsert",
          value: "18",
        },
      ],
    });
  });

  it("falls back to the default when a committed color is malformed", async () => {
    const edits: unknown[] = [];

    await commitSettingsFieldAction({
      client: {
        writeConfigBatch: async (batch) => {
          edits.push(...batch);
        },
      },
      fieldId: "appearance-accent",
      isConnected: true,
      persistLocale: vi.fn(),
      persistTheme: vi.fn(),
      setLocale: vi.fn(),
      setTheme: vi.fn(),
      value: "not-a-color",
    });

    expect(edits).toEqual([
      {
        keyPath: "desktop.appearanceAccent",
        mergeStrategy: "upsert",
        value: "#1f1f1f",
      },
    ]);
  });

  it("leaves non-appearance fields out of the appearance apply path", async () => {
    const applyAppearanceField = vi.fn();

    await commitSettingsFieldAction({
      applyAppearanceField,
      client: { writeConfigBatch: vi.fn(async () => {}) },
      fieldId: "config-model",
      isConnected: true,
      persistLocale: vi.fn(),
      persistTheme: vi.fn(),
      setLocale: vi.fn(),
      setTheme: vi.fn(),
      value: "gpt-5.6",
    });

    expect(applyAppearanceField).not.toHaveBeenCalled();
  });
});
