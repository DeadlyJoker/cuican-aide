import type { Thread } from "@crewon/app-server-protocol/v2/Thread";
import { describe, expect, it, vi } from "vitest";
import type { ControlApiClient } from "@crewon/control-client";

import type { AppServerClient } from "../app-server/appServer";
import type { CapabilityPanel } from "../capability/capabilityPanelTypes";
import { createAppSettingsCoordinator } from "./appSettingsCoordinator";

type SetCapabilityPanel = Parameters<
  typeof createAppSettingsCoordinator
>[0]["setCapabilityPanel"];

function createCoordinator(
  overrides: {
    controlClient?: ControlApiClient;
    client?: AppServerClient;
    setCapabilityDockOpen?: (open: boolean) => void;
    setCapabilityPanel?: SetCapabilityPanel;
  } = {},
) {
  return createAppSettingsCoordinator({
    accountStatus: null,
    platformUser: null,
    capabilityPanel: null,
    client: overrides.client ?? null,
    controlClient: overrides.controlClient,
    connectionHint: "Disconnected",
    connectionState: "demo",
    conversationSummary: null,
    currentCwd: "/repo",
    isConnected: false,
    isDemoPreview: false,
    locale: "en",
    persistLocale: () => {},
    persistTheme: () => {},
    resolveBackendCwd: async () => "/repo",
    selectedThread: null,
    selectedThreadId: null,
    setAccountStatus: () => {},
    setCapabilityDockOpen: overrides.setCapabilityDockOpen ?? (() => {}),
    setCapabilityPanel: overrides.setCapabilityPanel ?? (() => {}),
    setLocale: () => {},
    setTheme: () => {},
    setThreads: () => {},
    theme: "dark",
    threadGoal: null,
    threads: [] as Thread[],
  });
}

describe("app settings coordinator", () => {
  it("does not send Control settings reads to the retired app-server", async () => {
    const readConfig = vi.fn();
    const setCapabilityPanel = vi.fn();
    const coordinator = createCoordinator({
      controlClient: {} as ControlApiClient,
      client: { readConfig } as unknown as AppServerClient,
      setCapabilityPanel,
    });
    for (const section of [
      "config",
      "account",
      "connections",
      "environment",
      "browser",
      "computerControl",
      "mcpServers",
    ] as const) {
      await coordinator.settingsSectionRefreshHandlers[section]();
    }
    expect(readConfig).not.toHaveBeenCalled();
    expect(setCapabilityPanel.mock.calls).toEqual(
      Array.from({ length: 7 }, () => [null]),
    );
  });
  it("builds settings refresh adapters and save handlers together", async () => {
    let dockOpen = false;
    let panel: CapabilityPanel | null = null;
    const coordinator = createCoordinator({
      setCapabilityDockOpen: (open) => {
        dockOpen = open;
      },
      setCapabilityPanel: (nextPanel) => {
        panel = typeof nextPanel === "function" ? nextPanel(panel) : nextPanel;
      },
    });

    coordinator.settingsRefreshHandlers.config();
    expect(panel).toMatchObject({
      title: "Config",
      error: "Local app-server is not connected",
    });

    await coordinator.openThreadSettingsPanel();
    expect(dockOpen).toBe(true);
    expect(panel).toMatchObject({
      title: "Session settings",
      error: "Select a session first",
    });
    expect(coordinator.settingsSaveHandlers.config).toEqual(
      expect.any(Function),
    );
    expect(coordinator.settingsSectionRefreshHandlers.config).toEqual(
      expect.any(Function),
    );
  });
});
