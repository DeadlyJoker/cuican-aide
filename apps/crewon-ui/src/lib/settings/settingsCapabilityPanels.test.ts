import type { AppInfo } from "@crewon-protocol/v2/AppInfo";
import type { HookMetadata } from "@crewon-protocol/v2/HookMetadata";
import { describe, expect, it } from "vitest";

import type {
  RemoteControlClient,
  RemoteControlStatusResponse,
} from "../app-server/appServer";
import type { McpInventory } from "../domain/domainCollaborationBackend";
import {
  browserAppsDisconnectedPanel,
  browserAppsErrorPanel,
  browserAppsLoadingPanel,
  browserAppsPanel,
  computerControlDisconnectedPanel,
  computerControlErrorPanel,
  computerControlLoadingPanel,
  computerControlPanel,
  hooksDisconnectedPanel,
  hooksErrorPanel,
  hooksLoadingPanel,
  hooksPanel,
  integrationsDisconnectedPanel,
  integrationsErrorPanel,
  integrationsLoadingPanel,
  integrationsPanel,
  mcpSettingsDisconnectedPanel,
  mcpSettingsErrorPanel,
  mcpSettingsLoadingPanel,
  mcpSettingsPanel,
  mcpReloadFailurePanel,
  mcpReloadFailureMessage,
  mcpReloadProgressBody,
  mcpReloadProgressPanel,
  remoteControlPairingFailureMessage,
  remoteControlPairingFailurePanel,
  remoteControlPairingPanel,
  remoteControlPairingProgressBody,
  remoteControlPairingProgressPanel,
  remoteControlPairingResultPanel,
  remoteControlRevokeFailureMessage,
  remoteControlRevokeFailurePanel,
  remoteControlRevokeMissingClientMessage,
  remoteControlRevokeMissingClientPanel,
  remoteControlRevokeNotice,
  remoteControlRevokeNoticeText,
  remoteControlStatusNotice,
  remoteControlStatusNoticeText,
  remoteControlToggleProgressBody,
  remoteControlToggleProgressPanel,
  remoteControlUpdateFailureMessage,
  remoteControlUpdateFailurePanel,
} from "./settingsCapabilityPanels";

function appInfo(overrides: Partial<AppInfo> = {}): AppInfo {
  return {
    id: "app-1",
    name: "Browser",
    description: null,
    logoUrl: null,
    logoUrlDark: null,
    distributionChannel: null,
    branding: null,
    appMetadata: null,
    labels: null,
    installUrl: null,
    isAccessible: true,
    isEnabled: true,
    pluginDisplayNames: [],
    ...overrides,
  };
}

function hookMetadata(overrides: Partial<HookMetadata> = {}): HookMetadata {
  return {
    key: "hook-1",
    eventName: "preToolUse",
    handlerType: "command",
    matcher: null,
    command: null,
    timeoutSec: 5n,
    statusMessage: null,
    sourcePath: "/repo/.codex/hooks.toml",
    source: "project",
    pluginId: null,
    displayOrder: 0n,
    enabled: true,
    isManaged: false,
    currentHash: "hash",
    trustStatus: "trusted",
    ...overrides,
  };
}

function remoteControlStatus(
  overrides: Partial<RemoteControlStatusResponse> = {},
): RemoteControlStatusResponse {
  return {
    status: "connected",
    serverName: "server",
    installationId: "installation-1",
    environmentId: "env-1",
    ...overrides,
  };
}

function remoteControlClient(
  overrides: Partial<RemoteControlClient> = {},
): RemoteControlClient {
  return {
    clientId: "client-1",
    displayName: "MacBook",
    deviceType: "desktop",
    platform: "macos",
    osVersion: "15.0",
    deviceModel: "Mac",
    appVersion: "1.0.0",
    lastSeenAt: 1_700_000_000,
    ...overrides,
  };
}

describe("settings panel text helpers", () => {
  it("builds computer control panels", () => {
    expect(computerControlDisconnectedPanel("Disconnected", "en")).toEqual({
      title: "Computer control",
      subtitle: "Disconnected",
      error: "Local app-server is not connected",
    });
    expect(computerControlLoadingPanel("zh")).toEqual({
      title: "电脑操控",
      subtitle: "远程控制与配对设备",
      body: "正在读取电脑操控状态...",
    });
    expect(
      computerControlPanel({
        clientError: null,
        clients: [remoteControlClient()],
        locale: "en",
        status: remoteControlStatus(),
      }),
    ).toMatchObject({
      title: "Computer control",
      subtitle: "connected · 1 clients",
      body: expect.stringContaining("Computer control"),
      fields: [
        {
          id: "remote-control-revoke-client",
          label: "Client ID to revoke",
          value: "client-1",
        },
      ],
      actions: [
        { id: "refresh-computer-control", label: "Refresh computer control" },
        {
          id: "disable-remote-control",
          label: "Disable remote control",
          tone: "danger",
        },
        { id: "start-remote-pairing", label: "Start pairing" },
        { id: "revoke-remote-client", label: "Revoke client", tone: "danger" },
      ],
    });
    expect(
      computerControlPanel({
        clientError: "client list failed",
        clients: [],
        locale: "en",
        status: remoteControlStatus({
          status: "disabled",
          environmentId: null,
        }),
      }).actions?.[1],
    ).toEqual({
      id: "enable-remote-control",
      label: "Enable remote control",
      tone: "primary",
    });
    expect(computerControlErrorPanel(null, "en")).toEqual({
      title: "Computer control",
      subtitle: "Remote control and paired clients",
      error: "Unable to read computer control",
    });
    expect(computerControlErrorPanel(new Error("denied"), "zh")).toEqual({
      title: "电脑操控",
      subtitle: "远程控制与配对设备",
      error: "denied",
    });
  });

  it("builds remote control action feedback", () => {
    expect(remoteControlToggleProgressBody("enable", "en")).toBe(
      "Enabling remote control...",
    );
    expect(remoteControlToggleProgressBody("disable", "zh")).toBe(
      "正在停用远程控制...",
    );
    expect(
      remoteControlToggleProgressPanel(
        { title: "Computer control", body: "Ready", error: "old error" },
        "enable",
        "en",
      ),
    ).toEqual({
      title: "Computer control",
      body: "Enabling remote control...",
      error: undefined,
    });
    expect(remoteControlStatusNoticeText("connected", "en")).toBe(
      "Remote control: connected",
    );
    expect(remoteControlStatusNotice("errored", "en")).toEqual({
      text: "Remote control: errored",
      tone: "warning",
    });
    expect(remoteControlStatusNotice(null, "zh")).toEqual({
      text: "远程控制状态：unknown",
      tone: "success",
    });
    expect(remoteControlUpdateFailureMessage(null, "zh")).toBe(
      "更新远程控制状态失败",
    );
    expect(
      remoteControlUpdateFailurePanel(
        { title: "Computer control", body: "Updating" },
        null,
        "zh",
      ),
    ).toEqual({
      title: "Computer control",
      body: "Updating",
      error: "更新远程控制状态失败",
    });
    expect(remoteControlPairingProgressBody("en")).toBe(
      "Creating pairing code...",
    );
    expect(
      remoteControlPairingProgressPanel(
        { title: "Computer control", body: "Ready", error: "old error" },
        "en",
      ),
    ).toEqual({
      title: "Computer control",
      body: "Creating pairing code...",
      error: undefined,
    });
    expect(
      remoteControlPairingPanel({
        locale: "en",
        response: null,
        status: null,
      }),
    ).toEqual({
      title: "Computer control",
      subtitle: "Pairing code created",
      body: [
        "Remote control pairing",
        "Pairing code: ",
        "Environment ID: ",
        "Claimed: no",
      ].join("\n"),
      actions: [
        {
          id: "refresh-computer-control",
          label: "Back to computer control",
        },
      ],
      fields: undefined,
      error: undefined,
    });
    expect(
      remoteControlPairingResultPanel(
        { title: "Existing", body: "Old", error: "old error" },
        { locale: "en", response: null, status: null },
      ),
    ).toEqual({
      title: "Computer control",
      subtitle: "Pairing code created",
      body: [
        "Remote control pairing",
        "Pairing code: ",
        "Environment ID: ",
        "Claimed: no",
      ].join("\n"),
      actions: [
        {
          id: "refresh-computer-control",
          label: "Back to computer control",
        },
      ],
      fields: undefined,
      error: undefined,
    });
    expect(remoteControlPairingFailureMessage(null, "zh")).toBe(
      "创建配对码失败",
    );
    expect(
      remoteControlPairingFailurePanel(
        { title: "Computer control", body: "Creating" },
        null,
        "zh",
      ),
    ).toEqual({
      title: "Computer control",
      body: "Creating",
      error: "创建配对码失败",
    });
    expect(remoteControlRevokeMissingClientMessage("en")).toBe(
      "Missing environment ID or client ID",
    );
    expect(
      remoteControlRevokeMissingClientPanel(
        { title: "Computer control", body: "Ready" },
        "en",
      ),
    ).toEqual({
      title: "Computer control",
      body: "Ready",
      error: "Missing environment ID or client ID",
    });
    expect(remoteControlRevokeNoticeText("client-1", "zh")).toBe(
      "已撤销设备：client-1",
    );
    expect(remoteControlRevokeNotice("client-1", "en")).toEqual({
      text: "Revoked client: client-1",
      tone: "success",
    });
    expect(remoteControlRevokeFailureMessage(new Error("denied"), "en")).toBe(
      "denied",
    );
    expect(
      remoteControlRevokeFailurePanel(
        { title: "Computer control", body: "Ready" },
        null,
        "en",
      ),
    ).toEqual({
      title: "Computer control",
      body: "Ready",
      error: "Unable to revoke client",
    });
    expect(remoteControlToggleProgressPanel(null, "disable", "en")).toBeNull();
    expect(remoteControlUpdateFailurePanel(null, null, "en")).toBeNull();
    expect(remoteControlPairingProgressPanel(null, "en")).toBeNull();
    expect(
      remoteControlPairingResultPanel(null, {
        locale: "en",
        response: null,
        status: null,
      }),
    ).toBeNull();
    expect(remoteControlPairingFailurePanel(null, null, "en")).toBeNull();
    expect(remoteControlRevokeMissingClientPanel(null, "en")).toBeNull();
    expect(remoteControlRevokeFailurePanel(null, null, "en")).toBeNull();
  });

  it("builds MCP settings panels", () => {
    const emptyInventory: McpInventory = {
      configs: [],
      servers: [],
      statuses: [],
    };

    expect(mcpSettingsDisconnectedPanel("Disconnected", "en")).toEqual({
      title: "MCP servers",
      subtitle: "Disconnected",
      error: "Local app-server is not connected",
    });
    expect(mcpSettingsLoadingPanel("zh")).toEqual({
      title: "MCP 服务器",
      subtitle: "运行态连接器",
      body: "正在读取 MCP 服务器...",
    });
    expect(mcpSettingsPanel(emptyInventory, "en")).toEqual({
      title: "MCP servers",
      subtitle: "0 servers · 0 configs · 0 unloaded",
      body: [
        "MCP servers: 0 · tools: 0 · resources: 0\nNo MCP servers. Create an MCP draft from Tools, or add mcp_servers in config.",
        "Persisted config (0)",
        "No persisted MCP configs.",
        "Runtime tools: 0 · resources: 0",
      ].join("\n"),
      actions: [
        { id: "refresh-mcp-settings", label: "Refresh MCP" },
        { id: "reload-tools", label: "Reload MCP config" },
      ],
    });
    expect(mcpSettingsErrorPanel(null, "en")).toEqual({
      title: "MCP servers",
      subtitle: "Runtime connectors",
      error: "Unable to read MCP servers",
    });
    expect(mcpSettingsErrorPanel(new Error("denied"), "zh")).toEqual({
      title: "MCP 服务器",
      subtitle: "运行态连接器",
      error: "denied",
    });
    expect(mcpReloadProgressBody("en")).toBe("Reloading MCP config...");
    expect(
      mcpReloadProgressPanel(
        {
          title: "MCP servers",
          body: "Old body",
          error: "old error",
        },
        "en",
      ),
    ).toEqual({
      title: "MCP servers",
      body: "Reloading MCP config...",
      error: undefined,
    });
    expect(mcpReloadFailureMessage(null, "zh")).toBe("重载 MCP 配置失败");
    expect(mcpReloadFailureMessage(new Error("denied"), "en")).toBe("denied");
    expect(
      mcpReloadFailurePanel(
        {
          title: "MCP servers",
          body: "Old body",
        },
        null,
        "en",
      ),
    ).toEqual({
      title: "MCP servers",
      body: "Old body",
      error: "Unable to reload MCP config",
    });
    expect(mcpReloadProgressPanel(null, "en")).toBeNull();
  });

  it("builds hooks panels", () => {
    expect(hooksDisconnectedPanel("Disconnected", "en")).toEqual({
      title: "Hooks",
      subtitle: "Disconnected",
      error: "Local app-server is not connected",
    });
    expect(hooksLoadingPanel(null, "en")).toEqual({
      title: "Hooks",
      subtitle: "Global config",
      body: "Reading hooks...",
    });
    expect(
      hooksPanel(
        {
          data: [
            {
              cwd: "/repo",
              hooks: [hookMetadata({ enabled: false })],
              warnings: ["deprecated matcher"],
              errors: [],
            },
          ],
        },
        "en",
      ),
    ).toEqual({
      title: "Hooks",
      subtitle: "1 hooks · 1 warnings · 0 errors",
      body: [
        "Hooks: 1 · enabled: 0 · managed: 0",
        "- preToolUse · command · disabled\n  source: project\n  path: /repo/.codex/hooks.toml",
        "\nWarnings\n- /repo: deprecated matcher",
      ].join("\n"),
      actions: [{ id: "refresh-hooks", label: "Refresh hooks" }],
    });
    expect(
      hooksErrorPanel({
        cwd: "/repo",
        error: null,
        locale: "en",
      }),
    ).toEqual({
      title: "Hooks",
      subtitle: "/repo",
      error: "Unable to read hooks",
    });
    expect(
      hooksErrorPanel({
        cwd: null,
        error: new Error("denied"),
        locale: "zh",
      }),
    ).toEqual({
      title: "钩子",
      subtitle: "全局配置",
      error: "denied",
    });
  });

  it("builds browser apps panels", () => {
    expect(browserAppsDisconnectedPanel("Disconnected", "en")).toEqual({
      title: "Browser",
      subtitle: "Disconnected",
      error: "Local app-server is not connected",
    });
    expect(browserAppsLoadingPanel("zh")).toEqual({
      title: "浏览器",
      subtitle: "应用连接器",
      body: "正在读取应用...",
    });
    expect(
      browserAppsPanel(
        {
          data: [
            appInfo({ pluginDisplayNames: ["Browser plugin"] }),
            appInfo({
              id: "app-2",
              name: "Docs",
              isAccessible: false,
              isEnabled: false,
            }),
          ],
          nextCursor: null,
        },
        "en",
      ),
    ).toEqual({
      title: "Browser",
      subtitle: "2 apps · 1 enabled · 1 accessible",
      body: [
        "Apps: 2 · enabled: 1 · accessible: 1",
        "Plugin sources: Browser plugin",
        "- Browser · accessible · enabled\n  id: app-1\n  plugins: Browser plugin\n\n- Docs · needs auth · disabled\n  id: app-2\n  plugins: built-in/unknown",
      ].join("\n"),
      actions: [{ id: "refresh-browser-apps", label: "Refresh apps" }],
    });
    expect(browserAppsErrorPanel(null, "en")).toEqual({
      title: "Browser",
      subtitle: "App connectors",
      error: "Unable to read apps",
    });
    expect(browserAppsErrorPanel(new Error("denied"), "zh")).toEqual({
      title: "浏览器",
      subtitle: "应用连接器",
      error: "denied",
    });
  });

  it("builds integrations loading and error panels", () => {
    expect(integrationsDisconnectedPanel("Disconnected", "en")).toEqual({
      title: "Integrations",
      subtitle: "Disconnected",
      error: "Local app-server is not connected",
    });
    expect(integrationsLoadingPanel("zh")).toEqual({
      title: "集成",
      subtitle: "应用与 Hook",
      body: "正在读取集成...",
    });
    expect(integrationsErrorPanel(null, "en")).toEqual({
      title: "Integrations",
      subtitle: "Apps and hooks",
      error: "Unable to read integrations",
    });
    expect(integrationsErrorPanel(new Error("denied"), "zh")).toEqual({
      title: "集成",
      subtitle: "应用与 Hook",
      error: "denied",
    });
  });

  it("builds integrations summary panels", () => {
    expect(
      integrationsPanel({
        apps: [
          appInfo(),
          appInfo({
            id: "app-2",
            name: "Docs",
            isAccessible: false,
            isEnabled: false,
          }),
        ],
        errors: ["hooks failed"],
        hooks: [hookMetadata({ enabled: false })],
        locale: "en",
      }),
    ).toEqual({
      title: "Integrations",
      subtitle: "2 apps · 1 hooks",
      body: [
        "Apps",
        "- Browser: accessible · enabled\n- Docs: needs auth · disabled",
        "Hooks",
        "- preToolUse: command · disabled",
        "Some integration reads failed\nhooks failed",
      ].join("\n"),
      actions: [{ id: "refresh-integrations", label: "Refresh integrations" }],
    });
    expect(
      integrationsPanel({
        apps: [],
        errors: [],
        hooks: [],
        locale: "zh",
      }),
    ).toEqual({
      title: "集成",
      subtitle: "0 应用 · 0 Hook",
      body: "应用\n暂无应用\nHooks\n暂无 Hook",
      actions: [{ id: "refresh-integrations", label: "刷新集成" }],
    });
  });


});
