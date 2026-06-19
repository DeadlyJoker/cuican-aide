import type { AppsListResponse } from "@crewon-protocol/v2/AppsListResponse";
import type { HooksListResponse } from "@crewon-protocol/v2/HooksListResponse";
import { describe, expect, it } from "vitest";

import type {
  RemoteControlClient,
  RemoteControlStatusResponse,
} from "../app-server/appServer";
import type { CapabilityPanel } from "../capability/capabilityPanelTypes";
import type { McpInventory } from "../domain/domainCollaborationBackend";
import {
  refreshBrowserSettingsPanelAction,
  refreshComputerControlSettingsPanelAction,
  refreshHooksSettingsPanelAction,
  refreshIntegrationsPanelAction,
  refreshMcpSettingsPanelAction,
  type RefreshBrowserSettingsPanelParams,
  type SettingsCapabilityRefreshClient,
} from "./settingsCapabilityRefreshActions";

type ClientOverrides = Partial<SettingsCapabilityRefreshClient>;

function apps(): AppsListResponse {
  return {
    data: [
      {
        appMetadata: null,
        branding: null,
        description: "Browser automation tools",
        distributionChannel: null,
        id: "browser-tools",
        installUrl: null,
        isAccessible: true,
        isEnabled: true,
        labels: null,
        logoUrl: null,
        logoUrlDark: null,
        name: "Browser Tools",
        pluginDisplayNames: ["browser-plugin"],
      },
    ],
    nextCursor: null,
  };
}

function hooks(): HooksListResponse {
  return {
    data: [
      {
        cwd: "/repo",
        errors: [],
        hooks: [
          {
            command: "echo ok",
            currentHash: "hash",
            displayOrder: 0n,
            enabled: true,
            eventName: "sessionStart",
            handlerType: "command",
            isManaged: false,
            key: "hook-1",
            matcher: null,
            pluginId: null,
            source: "project",
            sourcePath: "/repo/.codex/hooks.json",
            statusMessage: null,
            timeoutSec: 10n,
            trustStatus: "trusted",
          },
        ],
        warnings: [],
      },
    ],
  };
}

function mcpInventory(): McpInventory {
  return {
    configs: [{ name: "filesystem", config: {} }],
    servers: [
      {
        config: { name: "filesystem", config: {} },
        name: "filesystem",
      },
    ],
    statuses: [],
  };
}

function remoteStatus(
  overrides: Partial<RemoteControlStatusResponse> = {},
): RemoteControlStatusResponse {
  return {
    environmentId: "env-1",
    installationId: "install-1",
    serverName: "desktop",
    status: "connected",
    ...overrides,
  };
}

function remoteClient(): RemoteControlClient {
  return {
    appVersion: "1.0.0",
    clientId: "client-1",
    deviceModel: "MacBook",
    deviceType: "desktop",
    displayName: "Work Mac",
    lastSeenAt: 1_700_000_000,
    osVersion: "14",
    platform: "macos",
  };
}

function fakeClient(overrides: ClientOverrides = {}): SettingsCapabilityRefreshClient {
  return {
    async listApps() {
      return apps();
    },
    async listHooks() {
      return hooks();
    },
    async listRemoteControlClients() {
      return { data: [remoteClient()], nextCursor: null };
    },
    async readRemoteControlStatus() {
      return remoteStatus();
    },
    ...overrides,
  } as unknown as SettingsCapabilityRefreshClient;
}

function panelSink() {
  let panel: CapabilityPanel | null = null;
  const panels: Array<CapabilityPanel | null> = [];
  return {
    get panel() {
      return panel;
    },
    get panels() {
      return panels;
    },
    setCapabilityPanel: (
      panelOrUpdater:
        | CapabilityPanel
        | null
        | ((currentPanel: CapabilityPanel | null) => CapabilityPanel | null),
    ) => {
      panel =
        typeof panelOrUpdater === "function"
          ? panelOrUpdater(panel)
          : panelOrUpdater;
      panels.push(panel);
    },
  };
}

function baseParams(
  overrides: Partial<RefreshBrowserSettingsPanelParams> = {},
): RefreshBrowserSettingsPanelParams {
  const sink = panelSink();
  return {
    client: fakeClient(),
    connectionHint: "Disconnected",
    isConnected: true,
    isDemoPreview: false,
    locale: "en",
    selectedThreadId: "thread-1",
    setCapabilityPanel: sink.setCapabilityPanel,
    ...overrides,
  };
}

describe("settings capability refresh actions", () => {
  it("shows hooks disconnected panel without resolving cwd", async () => {
    const sink = panelSink();
    let resolvedCwd = false;

    await refreshHooksSettingsPanelAction({
      ...baseParams({
        isConnected: false,
        setCapabilityPanel: sink.setCapabilityPanel,
      }),
      resolveBackendCwd: async () => {
        resolvedCwd = true;
        return "/repo";
      },
    });

    expect(resolvedCwd).toBe(false);
    expect(sink.panel).toEqual({
      error: "Local app-server is not connected",
      subtitle: "Disconnected",
      title: "Hooks",
    });
  });

  it("loads hooks from the backend cwd", async () => {
    const sink = panelSink();
    const calls: string[] = [];

    await refreshHooksSettingsPanelAction({
      ...baseParams({
        client: fakeClient({
          async listHooks(cwd) {
            calls.push(`hooks:${cwd}`);
            return hooks();
          },
        }),
        setCapabilityPanel: sink.setCapabilityPanel,
      }),
      resolveBackendCwd: async () => "/repo",
    });

    expect(calls).toEqual(["hooks:/repo"]);
    expect(sink.panels[0]).toEqual({
      body: "Reading hooks...",
      subtitle: "/repo",
      title: "Hooks",
    });
    expect(sink.panel).toMatchObject({
      subtitle: "1 hooks · 0 warnings · 0 errors",
      title: "Hooks",
    });
    expect(sink.panel?.body).toContain("Hooks: 1 · enabled: 1");
  });

  it("loads MCP settings with an injected inventory loader", async () => {
    const sink = panelSink();
    const loaderCalls: Array<{
      cwd: string | null | undefined;
      threadId: string | undefined;
    }> = [];

    await refreshMcpSettingsPanelAction({
      ...baseParams({
        setCapabilityPanel: sink.setCapabilityPanel,
      }),
      mcpInventoryLoader: async (_client, threadId, cwd) => {
        loaderCalls.push({ cwd, threadId });
        return mcpInventory();
      },
      resolveBackendCwd: async () => "/repo",
    });

    expect(loaderCalls).toEqual([{ cwd: "/repo", threadId: "thread-1" }]);
    expect(sink.panels[0]).toEqual({
      body: "Reading MCP servers...",
      subtitle: "Runtime connectors",
      title: "MCP servers",
    });
    expect(sink.panel).toMatchObject({
      subtitle: "1 servers · 1 configs · 1 unloaded",
      title: "MCP servers",
    });
  });

  it("loads browser apps for the selected thread", async () => {
    const sink = panelSink();
    const threadIds: Array<string | undefined> = [];

    await refreshBrowserSettingsPanelAction({
      ...baseParams({
        client: fakeClient({
          async listApps(threadId) {
            threadIds.push(threadId);
            return apps();
          },
        }),
        setCapabilityPanel: sink.setCapabilityPanel,
      }),
    });

    expect(threadIds).toEqual(["thread-1"]);
    expect(sink.panel).toMatchObject({
      subtitle: "1 apps · 1 enabled · 1 accessible",
      title: "Browser",
    });
    expect(sink.panel?.body).toContain("Apps: 1 · enabled: 1 · accessible: 1");
  });

  it("uses global apps in browser demo preview", async () => {
    const sink = panelSink();
    const threadIds: Array<string | undefined> = [];

    await refreshBrowserSettingsPanelAction({
      ...baseParams({
        client: fakeClient({
          async listApps(threadId) {
            threadIds.push(threadId);
            return apps();
          },
        }),
        isDemoPreview: true,
        setCapabilityPanel: sink.setCapabilityPanel,
      }),
    });

    expect(threadIds).toEqual([undefined]);
  });

  it("loads computer control status and paired clients", async () => {
    const sink = panelSink();
    const environments: string[] = [];

    await refreshComputerControlSettingsPanelAction({
      ...baseParams({
        client: fakeClient({
          async listRemoteControlClients(environmentId) {
            environments.push(environmentId);
            return { data: [remoteClient()], nextCursor: null };
          },
        }),
        setCapabilityPanel: sink.setCapabilityPanel,
      }),
    });

    expect(environments).toEqual(["env-1"]);
    expect(sink.panel).toMatchObject({
      subtitle: "connected · 1 clients",
      title: "Computer control",
    });
    expect(sink.panel?.body).toContain("Paired clients: 1");
  });

  it("keeps computer control panel usable when paired clients fail", async () => {
    const sink = panelSink();

    await refreshComputerControlSettingsPanelAction({
      ...baseParams({
        client: fakeClient({
          async listRemoteControlClients() {
            throw new Error("clients failed");
          },
        }),
        setCapabilityPanel: sink.setCapabilityPanel,
      }),
    });

    expect(sink.panel).toMatchObject({
      subtitle: "connected · 0 clients",
      title: "Computer control",
    });
    expect(sink.panel?.body).toContain("Client list error: clients failed");
  });

  it("loads integrations from apps and hooks", async () => {
    const sink = panelSink();
    const calls: string[] = [];

    await refreshIntegrationsPanelAction({
      ...baseParams({
        client: fakeClient({
          async listApps(threadId) {
            calls.push(`apps:${threadId}`);
            return apps();
          },
          async listHooks(cwd) {
            calls.push(`hooks:${cwd}`);
            return hooks();
          },
        }),
        setCapabilityPanel: sink.setCapabilityPanel,
      }),
      resolveBackendCwd: async () => "/repo",
    });

    expect(calls.sort()).toEqual(["apps:thread-1", "hooks:/repo"]);
    expect(sink.panels[0]).toEqual({
      body: "Reading integrations...",
      subtitle: "Apps and hooks",
      title: "Integrations",
    });
    expect(sink.panel).toMatchObject({
      subtitle: "1 apps · 1 hooks",
      title: "Integrations",
    });
    expect(sink.panel?.body).toContain("- Browser Tools: accessible · enabled");
    expect(sink.panel?.body).toContain("- sessionStart: command · enabled");
  });

  it("shows integration error when connected but client is missing", async () => {
    const sink = panelSink();

    await refreshIntegrationsPanelAction({
      ...baseParams({
        client: null,
        setCapabilityPanel: sink.setCapabilityPanel,
      }),
      resolveBackendCwd: async () => "/repo",
    });

    expect(sink.panel).toEqual({
      error: "Local app-server is not connected",
      subtitle: "Apps and hooks",
      title: "Integrations",
    });
  });
});
