import type { AppsListResponse } from "@crewon-ui-model/v2/AppsListResponse";
import type { ConfigRequirementsReadResponse } from "@crewon-ui-model/v2/ConfigRequirementsReadResponse";
import type { GetAccountResponse } from "@crewon-ui-model/v2/GetAccountResponse";
import type { GetAuthStatusResponse } from "@crewon-ui-model/GetAuthStatusResponse";
import type { ModelProviderCapabilitiesReadResponse } from "@crewon-ui-model/v2/ModelProviderCapabilitiesReadResponse";
import type { PluginListResponse } from "@crewon-ui-model/v2/PluginListResponse";
import type { WindowsSandboxReadinessResponse } from "@crewon-ui-model/v2/WindowsSandboxReadinessResponse";
import { describe, expect, it } from "vitest";

import type { CapabilityPanel } from "../capability/capabilityPanelTypes";
import {
  refreshAppSnapshotsSettingsPanelAction,
  refreshConnectionsSettingsPanelAction,
  refreshEnvironmentSettingsPanelAction,
  type RefreshConnectionsSettingsPanelParams,
} from "./settingsRuntimeRefreshActions";

type SettingsRuntimeRefreshClient = NonNullable<
  RefreshConnectionsSettingsPanelParams["client"]
>;

function requirements(
  overrides: Partial<
    NonNullable<ConfigRequirementsReadResponse["requirements"]>
  > = {},
): ConfigRequirementsReadResponse {
  return {
    requirements: {
      allowAppshots: true,
      allowedApprovalPolicies: null,
      allowedPermissionProfiles: null,
      allowedSandboxModes: null,
      allowedWebSearchModes: ["live"],
      allowedWindowsSandboxImplementations: ["elevated"],
      allowManagedHooksOnly: null,
      computerUse: null,
      defaultPermissions: null,
      enforceResidency: null,
      featureRequirements: { appshots: true },
      ...overrides,
    },
  };
}

function apps(): AppsListResponse {
  return {
    data: [
      {
        appMetadata: null,
        branding: null,
        description: null,
        distributionChannel: null,
        id: "browser-tools",
        installUrl: null,
        isAccessible: true,
        isEnabled: true,
        labels: null,
        logoUrl: null,
        logoUrlDark: null,
        name: "Browser Tools",
        pluginDisplayNames: [],
      },
    ],
    nextCursor: null,
  };
}

function plugins(): PluginListResponse {
  return {
    featuredPluginIds: [],
    marketplaceLoadErrors: [],
    marketplaces: [
      {
        name: "local",
        path: "/repo/.codex/plugins",
        interface: null,
        plugins: [],
      },
    ],
  };
}

function account(): GetAccountResponse {
  return {
    account: { type: "apiKey" },
    requiresOpenaiAuth: false,
  };
}

function auth(): GetAuthStatusResponse {
  return {
    authMethod: "apikey",
    authToken: null,
    requiresOpenaiAuth: false,
  };
}

function providerCapabilities(): ModelProviderCapabilitiesReadResponse {
  return {
    imageGeneration: true,
    namespaceTools: true,
    webSearch: true,
  };
}

function readiness(): WindowsSandboxReadinessResponse {
  return { status: "ready" };
}

function baseClient(
  overrides: Partial<SettingsRuntimeRefreshClient> = {},
): SettingsRuntimeRefreshClient {
  return {
    async getAccount() {
      return account();
    },
    async getAuthStatus() {
      return auth();
    },
    async getModelProviderCapabilities() {
      return providerCapabilities();
    },
    async listApps() {
      return apps();
    },
    async listPlugins() {
      return plugins();
    },
    async readConfigRequirements() {
      return requirements();
    },
    async readWindowsSandboxReadiness() {
      return readiness();
    },
    ...overrides,
  };
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
  overrides: Partial<RefreshConnectionsSettingsPanelParams> = {},
): RefreshConnectionsSettingsPanelParams {
  const sink = panelSink();
  return {
    client: baseClient(),
    connectionHint: "Disconnected",
    isConnected: true,
    isDemoPreview: false,
    locale: "en",
    resolveBackendCwd: async () => "/repo",
    selectedThreadId: "thread-1",
    setCapabilityPanel: sink.setCapabilityPanel,
    ...overrides,
  };
}

describe("settings runtime refresh actions", () => {
  it("shows environment disconnected panel without reading cwd", async () => {
    const sink = panelSink();
    let resolvedCwd = false;

    await refreshEnvironmentSettingsPanelAction({
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
      title: "Environment",
    });
  });

  it("loads environment requirements and readiness", async () => {
    const sink = panelSink();

    await refreshEnvironmentSettingsPanelAction({
      ...baseParams({
        setCapabilityPanel: sink.setCapabilityPanel,
      }),
    });

    expect(sink.panels[0]).toEqual({
      body: "Reading environment capabilities...",
      subtitle: "/repo",
      title: "Environment",
    });
    expect(sink.panel).toMatchObject({
      actions: [
        { id: "refresh-environment", label: "Refresh environment" },
        {
          id: "setup-windows-sandbox-elevated",
          label: "Set up Windows sandbox: elevated",
        },
      ],
      subtitle: "/repo",
      title: "Environment",
    });
    expect(sink.panel?.body).toContain("Windows sandbox status: ready");
  });

  it("shows app snapshot errors", async () => {
    const sink = panelSink();

    await refreshAppSnapshotsSettingsPanelAction({
      ...baseParams({
        client: baseClient({
          async readConfigRequirements() {
            throw new Error("policy failed");
          },
        }),
        setCapabilityPanel: sink.setCapabilityPanel,
      }),
    });

    expect(sink.panels[0]).toEqual({
      body: "Reading app snapshot policy...",
      subtitle: "Policy and status",
      title: "App snapshots",
    });
    expect(sink.panel).toEqual({
      error: "policy failed",
      subtitle: "Policy and status",
      title: "App snapshots",
    });
  });

  it("loads connections data for the selected thread", async () => {
    const sink = panelSink();
    const calls: string[] = [];

    await refreshConnectionsSettingsPanelAction({
      ...baseParams({
        client: baseClient({
          async listApps(threadId) {
            calls.push(`apps:${threadId}`);
            return apps();
          },
          async listPlugins(cwd) {
            calls.push(`plugins:${cwd}`);
            return plugins();
          },
        }),
        setCapabilityPanel: sink.setCapabilityPanel,
      }),
    });

    expect(calls.sort()).toEqual(["apps:thread-1", "plugins:/repo"]);
    expect(sink.panels[0]).toEqual({
      body: "Reading connection status...",
      subtitle: "/repo",
      title: "Connections",
    });
    expect(sink.panel).toMatchObject({
      actions: [{ id: "refresh-connections", label: "Refresh connections" }],
      subtitle: "1 apps · 1 marketplaces · apikey",
      title: "Connections",
    });
    expect(sink.panel?.body).toContain("App connectors: 1 · enabled: 1");
  });

  it("uses global apps for demo preview connections", async () => {
    const sink = panelSink();
    const threadIds: Array<string | undefined> = [];

    await refreshConnectionsSettingsPanelAction({
      ...baseParams({
        client: baseClient({
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

  it("shows disconnected connections panel when the client is missing", async () => {
    const sink = panelSink();

    await refreshConnectionsSettingsPanelAction({
      ...baseParams({
        client: null,
        setCapabilityPanel: sink.setCapabilityPanel,
      }),
    });

    expect(sink.panels).toEqual([
      {
        body: "Reading connection status...",
        subtitle: "/repo",
        title: "Connections",
      },
      {
        error: "Local app-server is not connected",
        subtitle: "Disconnected",
        title: "Connections",
      },
    ]);
  });
});
