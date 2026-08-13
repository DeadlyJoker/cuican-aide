import { describe, expect, it, vi } from "vitest";

import type { CapabilityPanel } from "../capability/capabilityPanelTypes";
import { SETTINGS_SECTIONS } from "../settings/settingsCatalog";
import { createAppSettingsCoordinator } from "./appSettingsCoordinator";

type Params = Parameters<typeof createAppSettingsCoordinator>[0];
type Client = Params["client"];

function createHarness(overrides: Partial<Client> = {}) {
  let panel: CapabilityPanel | null = null;
  const setLocale = vi.fn();
  const setTheme = vi.fn();
  const persistLocale = vi.fn();
  const persistTheme = vi.fn();
  const setNotice = vi.fn();
  const client: Client = {
    getAccountSnapshot: vi.fn(async () => ({
      account: {
        identity: {
          actorId: "actor-1",
          principalId: "principal-1",
          spaceId: "space-1",
          tenantId: "tenant-1",
        },
        authentication: {
          authority: "control" as const,
          status: "authenticated" as const,
        },
        rateLimits: {
          reason: "notOwned" as const,
          status: "unavailable" as const,
        },
        usage: {
          reason: "notOwned" as const,
          status: "unavailable" as const,
        },
      },
    })),
    getLocalSettings: vi.fn(async () => ({
      settings: {
        locale: "en" as const,
        revision: 7,
        theme: "dark" as const,
        updatedAt: null,
      },
    })),
    getModelProviderSettings: vi.fn(async () => ({
      settings: {
        activeProviderId: null,
        providers: [],
        revision: 1,
        runtimeAvailability: "unconfigured" as const,
        updatedAt: null,
      },
    })),
    probeModelProvider: vi.fn(),
    putLocalSettings: vi.fn(async (input) => ({
      settings: {
        locale: input.locale,
        revision: input.expectedRevision + 1,
        theme: input.theme,
        updatedAt: null,
      },
    })),
    ...overrides,
  };
  const coordinator = createAppSettingsCoordinator({
    client,
    credentialStore: null,
    getCapabilityPanel: () => panel,
    locale: "en",
    persistLocale,
    persistTheme,
    platformUser: null,
    setCapabilityPanel: (next) => {
      panel = typeof next === "function" ? next(panel) : next;
    },
    setLocale,
    setNotice,
    setTheme,
  });
  return {
    client,
    coordinator,
    panel: () => panel,
    persistLocale,
    persistTheme,
    setLocale,
    setNotice,
    setTheme,
  };
}

describe("Control settings coordinator", () => {
  it("routes only three sections to Control authorities", async () => {
    const harness = createHarness();

    for (const section of SETTINGS_SECTIONS) {
      await harness.coordinator.refreshSection(section);
      if (
        section !== "account" &&
        section !== "appearance" &&
        section !== "model-providers"
      ) {
        expect(harness.panel()).toMatchObject({
          body: "Unavailable: this setting is not owned by the current Control contract.",
        });
      }
    }

    expect(harness.client.getAccountSnapshot).toHaveBeenCalledOnce();
    expect(harness.client.getLocalSettings).toHaveBeenCalledTimes(2);
    expect(harness.client.getModelProviderSettings).toHaveBeenCalledOnce();
  });

  it("renders only locale and theme from the Control snapshot", async () => {
    const harness = createHarness();
    await harness.coordinator.refreshSection("appearance");

    expect(harness.panel()?.fields).toEqual([
      expect.objectContaining({ id: "appearance-locale", value: "en" }),
      expect.objectContaining({ id: "appearance-theme", value: "dark" }),
    ]);
  });

  it("uses revision CAS and applies the returned snapshot only after success", async () => {
    const harness = createHarness();
    await harness.coordinator.commitField("appearance-locale", "zh");

    expect(harness.client.putLocalSettings).toHaveBeenCalledWith({
      expectedRevision: 7,
      locale: "zh",
      theme: "dark",
    });
    expect(harness.setLocale).toHaveBeenCalledWith("zh");
    expect(harness.setTheme).toHaveBeenCalledWith("dark");
    expect(harness.persistLocale).toHaveBeenCalledWith("zh");
    expect(harness.persistTheme).toHaveBeenCalledWith("dark");
  });

  it("does not apply local state when the Control CAS fails", async () => {
    const harness = createHarness({
      putLocalSettings: vi.fn(async () => {
        throw new Error("revision_conflict");
      }),
    });
    await harness.coordinator.commitField("appearance-theme", "light");

    expect(harness.setLocale).not.toHaveBeenCalled();
    expect(harness.setTheme).not.toHaveBeenCalled();
    expect(harness.persistLocale).not.toHaveBeenCalled();
    expect(harness.persistTheme).not.toHaveBeenCalled();
    expect(harness.panel()).toBeNull();
    expect(harness.setNotice).toHaveBeenCalledWith(
      expect.objectContaining({ tone: "warning" }),
    );
  });

  it("fails closed for unsupported fields and does not recognize removed actions", async () => {
    const harness = createHarness();
    await harness.coordinator.commitField("appearance-accent", "#ff0000");

    expect(harness.client.putLocalSettings).not.toHaveBeenCalled();
    expect(harness.coordinator.handleAction("save-config")).toBe(false);
    expect(harness.coordinator.handleAction("save-thread-settings")).toBe(
      false,
    );
    expect(harness.setNotice).toHaveBeenCalledWith(
      expect.objectContaining({ tone: "warning" }),
    );
  });
});
