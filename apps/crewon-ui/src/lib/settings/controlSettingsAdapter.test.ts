import { describe, expect, it, vi } from "vitest";

import {
  controlSettingsAvailability,
  controlSettingsUnavailablePanel,
  createControlSettingsAdapter,
  type ControlSettingsClient,
} from "./controlSettingsAdapter";

describe("Control settings adapter", () => {
  it("exposes only settings backed by a Control authority", () => {
    expect(controlSettingsAvailability("account")).toEqual({
      authority: "account-snapshot",
      status: "available",
    });
    expect(controlSettingsAvailability("appearance")).toEqual({
      authority: "local-settings",
      status: "available",
    });
    expect(controlSettingsAvailability("model-providers")).toEqual({
      authority: "model-provider-settings",
      status: "available",
    });
    expect(controlSettingsAvailability("mcp-servers")).toEqual({
      reason: "not-owned-by-control",
      status: "unavailable",
    });
    expect(controlSettingsAvailability("computer-control")).toEqual({
      reason: "not-owned-by-control",
      status: "unavailable",
    });
    expect(controlSettingsAvailability("worktrees")).toEqual({
      reason: "not-owned-by-control",
      status: "unavailable",
    });
  });

  it("delegates reads, local mutation, and provider probe without fallback", async () => {
    const getLocalSettings = vi.fn(async () => ({ settings: { revision: 4 } }));
    const putLocalSettings = vi.fn(async () => ({ settings: { revision: 5 } }));
    const probeModelProvider = vi.fn(async () => ({ probe: { status: "ok" } }));
    const client = {
      getAccountSnapshot: vi.fn(),
      getLocalSettings,
      getModelProviderSettings: vi.fn(),
      probeModelProvider,
      putLocalSettings,
    } as unknown as ControlSettingsClient;
    const adapter = createControlSettingsAdapter(client);

    await adapter.getLocalSettings();
    await adapter.putLocalSettings({
      expectedRevision: 4,
      locale: "en",
      theme: "dark",
    });
    await adapter.probeModelProvider("settings-probe-1");

    expect(getLocalSettings).toHaveBeenCalledOnce();
    expect(putLocalSettings).toHaveBeenCalledWith({
      expectedRevision: 4,
      locale: "en",
      theme: "dark",
    });
    expect(probeModelProvider).toHaveBeenCalledWith("settings-probe-1");
  });

  it("renders unsupported state without a legacy connection claim", () => {
    expect(controlSettingsUnavailablePanel("mcp-servers", "en")).toEqual({
      title: "MCP servers",
      subtitle: "Control settings",
      body: "Unavailable: this setting is not owned by the current Control contract.",
    });
  });
});
