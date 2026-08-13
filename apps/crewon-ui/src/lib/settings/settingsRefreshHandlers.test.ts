import type { Thread } from "@crewon-protocol/v2/Thread";
import type { ControlApiClient } from "@crewon/control-client";
import { describe, expect, it, vi } from "vitest";

import type { CapabilityPanel } from "../capability/capabilityPanelTypes";
import {
  createAppSettingsRefreshHandlers,
  createSettingsRefreshHandlers,
  createSettingsSectionRefreshHandlers,
} from "./settingsRefreshHandlers";

type SetCapabilityPanel = Parameters<
  typeof createAppSettingsRefreshHandlers
>[0]["setCapabilityPanel"];

function baseParams(
  overrides: {
    controlClient?: Parameters<
      typeof createAppSettingsRefreshHandlers
    >[0]["controlClient"];
    isConnected?: boolean;
    isDemoPreview?: boolean;
    selectedThreadId?: string | null;
    setCapabilityDockOpen?: (open: boolean) => void;
    setCapabilityPanel?: SetCapabilityPanel;
  } = {},
) {
  return {
    accountStatus: null,
    platformUser: null,
    client: null,
    controlClient: overrides.controlClient,
    connectionHint: "Disconnected",
    connectionState: "demo" as const,
    conversationSummary: null,
    currentCwd: "/repo",
    isConnected: overrides.isConnected ?? false,
    isDemoPreview: overrides.isDemoPreview ?? false,
    locale: "en" as const,
    resolveBackendCwd: async () => "/repo",
    selectedThread: null,
    selectedThreadId: overrides.selectedThreadId ?? null,
    setAccountStatus: () => {},
    setCapabilityDockOpen: overrides.setCapabilityDockOpen ?? (() => {}),
    setCapabilityPanel: overrides.setCapabilityPanel ?? (() => {}),
    setThreads: () => {},
    theme: "dark" as const,
    threadGoal: null,
    threads: [] as Thread[],
  };
}

describe("settings refresh handlers", () => {
  it("refreshes config settings with the current connection hint", async () => {
    let panel: CapabilityPanel | null = null;
    const handlers = createAppSettingsRefreshHandlers(
      baseParams({
        setCapabilityPanel: (nextPanel) => {
          panel =
            typeof nextPanel === "function" ? nextPanel(panel) : nextPanel;
        },
      }),
    );

    await handlers.refreshConfigPanel();

    expect(panel).toMatchObject({
      title: "Config",
      subtitle: "Disconnected",
      error: "Local app-server is not connected",
    });
  });

  it("opens thread settings missing-thread panel without a backend thread", async () => {
    let dockOpen = false;
    let panel: CapabilityPanel | null = null;
    const handlers = createAppSettingsRefreshHandlers(
      baseParams({
        setCapabilityDockOpen: (open) => {
          dockOpen = open;
        },
        setCapabilityPanel: (nextPanel) => {
          panel =
            typeof nextPanel === "function" ? nextPanel(panel) : nextPanel;
        },
      }),
    );

    await handlers.openThreadSettingsPanel();

    expect(dockOpen).toBe(true);
    expect(panel).toMatchObject({
      title: "Session settings",
      error: "Select a session first",
    });
  });

  it("opens thread settings initial panel for a demo preview thread", async () => {
    let panel: CapabilityPanel | null = null;
    const handlers = createAppSettingsRefreshHandlers(
      baseParams({
        isDemoPreview: true,
        selectedThreadId: "demo-thread",
        setCapabilityPanel: (nextPanel) => {
          panel =
            typeof nextPanel === "function" ? nextPanel(panel) : nextPanel;
        },
      }),
    );

    await handlers.openThreadSettingsPanel();

    expect(panel).toMatchObject({
      title: "Session settings",
      subtitle: "Goal",
    });
    expect((panel as CapabilityPanel | null)?.error).toBeUndefined();
  });

  it("passes account refresh through to Control", async () => {
    const getLocalSettings = vi.fn(async () => ({
      settings: {
        locale: "en" as const,
        theme: "dark" as const,
        revision: 1,
        updatedAt: null,
      },
    }));
    const handlers = createAppSettingsRefreshHandlers(
      baseParams({
        controlClient: { getLocalSettings } as unknown as ControlApiClient,
        isConnected: true,
      }),
    );

    await handlers.refreshAccountPanel();

    expect(getLocalSettings).toHaveBeenCalledOnce();
  });

  it("derives section and action refresh adapters from the same handler bundle", async () => {
    const handlers = createAppSettingsRefreshHandlers(baseParams());
    const calls: string[] = [];
    const bundle = {
      ...handlers,
      refreshConfigPanel: async () => {
        calls.push("config");
      },
      refreshMcpSettingsPanel: async () => {
        calls.push("mcp");
      },
    };

    await createSettingsSectionRefreshHandlers(bundle).config();
    createSettingsRefreshHandlers(bundle).mcpSettings();

    expect(calls).toEqual(["config", "mcp"]);
  });
});
