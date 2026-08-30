import type { PluginReadResponse } from "@crewon/app-server-protocol/v2/PluginReadResponse";
import { describe, expect, it } from "vitest";

import type { CapabilityPanel } from "../capability/capabilityPanelTypes";
import { decodeCapabilityActionPayload } from "../server-request/serverRequestPresentation";
import {
  handlePluginPanelAction,
  pluginCapabilityDetailPanel,
  pluginCapabilityErrorPanel,
  pluginCapabilityLoadingPanel,
  pluginCapabilityItemAction,
  pluginCapabilityPanelActions,
  pluginEnabledLabel,
  pluginInstallFailureMessage,
  pluginInstallFailurePanel,
  pluginInstalledLabel,
  pluginInstallProgressBody,
  pluginInstallProgressPanel,
  pluginInstallSuccessBody,
  pluginInstallSuccessPanel,
  pluginPanelActionForActionId,
  pluginSourceLabel,
  pluginUninstallFailureMessage,
  pluginUninstallFailurePanel,
  pluginUninstallNotice,
  pluginUninstallNoticeText,
  pluginUninstallProgressBody,
  pluginUninstallProgressPanel,
} from "./pluginPanelActions";

async function flushAsyncAction() {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

function pluginResponse(
  summaryOverrides: Partial<PluginReadResponse["plugin"]["summary"]>,
): PluginReadResponse {
  return {
    plugin: {
      marketplaceName: "local",
      marketplacePath: "/repo/.codex/plugins",
      summary: {
        id: "plugin-id",
        remotePluginId: null,
        localVersion: null,
        name: "demo-plugin",
        shareContext: null,
        source: { type: "remote" },
        installed: false,
        enabled: false,
        installPolicy: "AVAILABLE",
        authPolicy: "ON_USE",
        availability: "AVAILABLE",
        interface: null,
        keywords: [],
        ...summaryOverrides,
      },
      description: null,
      skills: [],
      hooks: [],
      apps: [],
      appTemplates: [],
      mcpServers: [],
    },
  };
}

describe("plugin panel actions", () => {
  it("formats shared plugin labels", () => {
    expect(pluginSourceLabel({ type: "local", path: "/plugins/demo" }, "en")).toBe(
      "local",
    );
    expect(pluginSourceLabel({ type: "git", url: "https://example.com", path: null, refName: null, sha: null }, "zh")).toBe(
      "Git",
    );
    expect(pluginSourceLabel({ type: "remote" }, "zh")).toBe("远程");
    expect(pluginEnabledLabel(true, "zh")).toBe("启用");
    expect(pluginEnabledLabel(false, "en")).toBe("disabled");
    expect(pluginInstalledLabel(true, "en")).toBe("installed");
    expect(pluginInstalledLabel(false, "zh")).toBe("未安装");
  });

  it("builds shared plugin item actions from marketplace data", () => {
    expect(
      pluginCapabilityItemAction(
        { name: "remote-market", path: null },
        { name: "demo-plugin" },
      ),
    ).toEqual({
      type: "plugin",
      pluginName: "demo-plugin",
      marketplacePath: null,
      remoteMarketplaceName: "remote-market",
    });

    expect(
      pluginCapabilityItemAction(
        { name: "local-market", path: "/repo/.codex/plugins" },
        { name: "demo-plugin" },
      ),
    ).toEqual({
      type: "plugin",
      pluginName: "demo-plugin",
      marketplacePath: "/repo/.codex/plugins",
      remoteMarketplaceName: null,
    });
  });

  it("creates install actions for available plugins", () => {
    const [action] = pluginCapabilityPanelActions(
      pluginResponse({}),
      {
        marketplacePath: "/repo/.codex/plugins",
        pluginName: "demo-plugin",
        remoteMarketplaceName: "shared",
      },
      "en",
    );

    expect(action?.label).toBe("Install plugin");
    expect(action?.tone).toBe("primary");
    expect(action?.id.startsWith("install-plugin:")).toBe(true);
    expect(
      decodeCapabilityActionPayload(action?.id.slice("install-plugin:".length)),
    ).toEqual({
      marketplacePath: "/repo/.codex/plugins",
      pluginName: "demo-plugin",
      remoteMarketplaceName: "shared",
    });
  });

  it("creates local open and uninstall actions for installed plugins", () => {
    const actions = pluginCapabilityPanelActions(
      pluginResponse({
        source: { type: "local", path: "/repo/plugins/demo" },
        installed: true,
      }),
      { pluginName: "demo-plugin" },
      "zh",
    );

    expect(actions.map((action) => action.label)).toEqual([
      "右栏打开插件目录",
      "卸载插件",
    ]);
    expect(
      decodeCapabilityActionPayload(
        actions[0].id.slice("open-plugin-path:".length),
      ),
    ).toEqual({ path: "/repo/plugins/demo" });
    expect(actions[1].tone).toBe("danger");
  });

  it("does not create install actions for unavailable plugins", () => {
    expect(
      pluginCapabilityPanelActions(
        pluginResponse({ availability: "DISABLED_BY_ADMIN" }),
        { pluginName: "demo-plugin" },
        "en",
      ),
    ).toEqual([]);
  });

  it("builds capability plugin panels", () => {
    expect(pluginCapabilityLoadingPanel("demo-plugin", "en")).toEqual({
      title: "demo-plugin",
      subtitle: "Plugin details",
      body: "Reading...",
    });
    expect(
      pluginCapabilityDetailPanel(
        pluginResponse({}),
        {
          marketplacePath: "/repo/.codex/plugins",
          pluginName: "demo-plugin",
          remoteMarketplaceName: "shared",
        },
        "zh",
      ),
    ).toMatchObject({
      title: "demo-plugin",
      subtitle: "插件详情",
      body: expect.stringContaining("demo-plugin"),
      actions: [
        expect.objectContaining({
          id: expect.stringMatching(/^install-plugin:/),
          label: "安装插件",
          tone: "primary",
        }),
        { id: "refresh-connectors", label: "返回连接器" },
      ],
    });
    expect(
      pluginCapabilityErrorPanel({
        error: null,
        locale: "en",
        pluginName: "demo-plugin",
      }),
    ).toEqual({
      title: "demo-plugin",
      subtitle: "Plugin details",
      error: "Unable to read plugin",
      actions: [{ id: "refresh-connectors", label: "Back to connectors" }],
    });
    expect(
      pluginCapabilityErrorPanel({
        error: new Error("denied"),
        locale: "zh",
        pluginName: "demo-plugin",
      }),
    ).toEqual({
      title: "demo-plugin",
      subtitle: "插件详情",
      error: "denied",
      actions: [{ id: "refresh-connectors", label: "返回连接器" }],
    });
  });

  it("builds plugin install and uninstall status text", () => {
    expect(pluginInstallProgressBody("demo-plugin", "en")).toBe(
      "Installing plugin: demo-plugin",
    );
    expect(
      pluginInstallProgressPanel(
        { title: "Plugin", body: "Ready", error: "old error" },
        "demo-plugin",
        "zh",
      ),
    ).toEqual({
      title: "Plugin",
      body: "正在安装插件：demo-plugin",
      error: undefined,
    });
    expect(
      pluginInstallSuccessBody(
        {
          authPolicy: "on-request",
          appsNeedingAuth: ["browser", "docs"],
        },
        "en",
      ),
    ).toBe("Plugin installed\nAuth policy: on-request\nApps needing auth: 2");
    expect(pluginInstallFailureMessage(null, "zh")).toBe("安装插件失败");
    expect(pluginInstallFailureMessage(new Error("denied"), "en")).toBe(
      "denied",
    );
    expect(
      pluginInstallSuccessPanel(
        { title: "Plugin", body: "Installing", error: "old error" },
        {
          authPolicy: "on-request",
          appsNeedingAuth: ["browser"],
        },
        "en",
      ),
    ).toEqual({
      title: "Plugin",
      body: "Plugin installed\nAuth policy: on-request\nApps needing auth: 1",
      error: undefined,
    });
    expect(
      pluginInstallFailurePanel(
        { title: "Plugin", body: "Installing" },
        null,
        "zh",
      ),
    ).toEqual({
      title: "Plugin",
      body: "Installing",
      error: "安装插件失败",
    });
    expect(pluginInstallProgressPanel(null, "demo-plugin", "en")).toBeNull();
    expect(pluginInstallSuccessPanel(null, undefined, "en")).toBeNull();
    expect(pluginInstallFailurePanel(null, null, "en")).toBeNull();
    expect(pluginUninstallProgressBody("en")).toBe("Uninstalling plugin...");
    expect(
      pluginUninstallProgressPanel(
        { title: "Plugin", body: "Installed", error: "old error" },
        "zh",
      ),
    ).toEqual({
      title: "Plugin",
      body: "正在卸载插件...",
      error: undefined,
    });
    expect(pluginUninstallNoticeText("zh")).toBe("插件已卸载");
    expect(pluginUninstallNotice("en")).toEqual({
      text: "Plugin uninstalled",
      tone: "success",
    });
    expect(pluginUninstallFailureMessage(null, "en")).toBe(
      "Unable to uninstall plugin",
    );
    expect(pluginUninstallFailureMessage(new Error("missing"), "zh")).toBe(
      "missing",
    );
    expect(
      pluginUninstallFailurePanel(
        { title: "Plugin", body: "Uninstalling" },
        null,
        "en",
      ),
    ).toEqual({
      title: "Plugin",
      body: "Uninstalling",
      error: "Unable to uninstall plugin",
    });
    expect(pluginUninstallProgressPanel(null, "en")).toBeNull();
    expect(pluginUninstallFailurePanel(null, null, "zh")).toBeNull();
  });

  it("parses capability plugin action ids", () => {
    const installAction = pluginCapabilityPanelActions(
      pluginResponse({}),
      {
        marketplacePath: "/repo/.codex/plugins",
        pluginName: "demo-plugin",
        remoteMarketplaceName: "shared",
      },
      "en",
    )[0];
    const [openAction, uninstallAction] = pluginCapabilityPanelActions(
      pluginResponse({
        source: { type: "local", path: "/repo/plugins/demo" },
        installed: true,
      }),
      { pluginName: "demo-plugin" },
      "en",
    );

    expect(pluginPanelActionForActionId("refresh-connectors")).toEqual({
      type: "refreshConnectors",
    });
    expect(pluginPanelActionForActionId(openAction.id)).toEqual({
      type: "openPath",
      path: "/repo/plugins/demo",
    });
    expect(pluginPanelActionForActionId(installAction.id)).toEqual({
      type: "install",
      marketplacePath: "/repo/.codex/plugins",
      pluginName: "demo-plugin",
      remoteMarketplaceName: "shared",
    });
    expect(pluginPanelActionForActionId(uninstallAction.id)).toEqual({
      type: "uninstall",
      pluginId: "plugin-id",
    });
    expect(pluginPanelActionForActionId("install-plugin:not-json")).toBeNull();
  });

  it("handles refresh and open path actions", () => {
    const opened: string[] = [];
    let refreshed = false;
    handlePluginPanelAction(
      {
        client: null,
        loadBrowserApps: () => {
          refreshed = true;
        },
        locale: "en",
        openPluginPath: (path) => opened.push(path),
        setCapabilityPanel: () => {},
        setNotice: () => {},
      },
      { type: "refreshConnectors" },
    );
    handlePluginPanelAction(
      {
        client: null,
        loadBrowserApps: () => {},
        locale: "en",
        openPluginPath: (path) => opened.push(path),
        setCapabilityPanel: () => {},
        setNotice: () => {},
      },
      { type: "openPath", path: "/repo/plugins/demo" },
    );

    expect(refreshed).toBe(true);
    expect(opened).toEqual(["/repo/plugins/demo"]);
  });

  it("handles install plugin actions", async () => {
    let panel: CapabilityPanel = { title: "Plugin", body: "Ready" };
    let refreshed = false;
    const installs: Array<{
      marketplacePath?: string | null;
      pluginName: string;
      remoteMarketplaceName?: string | null;
    }> = [];

    handlePluginPanelAction(
      {
        client: {
          async installPlugin(pluginName, marketplacePath, remoteMarketplaceName) {
            installs.push({ marketplacePath, pluginName, remoteMarketplaceName });
            return {
              authPolicy: "ON_USE",
              appsNeedingAuth: [],
            };
          },
          async uninstallPlugin() {},
        },
        loadBrowserApps: () => {
          refreshed = true;
        },
        locale: "en",
        openPluginPath: () => {},
        setCapabilityPanel: (updater) => {
          panel = updater(panel) ?? panel;
        },
        setNotice: () => {},
      },
      {
        type: "install",
        marketplacePath: "/repo/.codex/plugins",
        pluginName: "demo-plugin",
        remoteMarketplaceName: null,
      },
    );

    expect(panel).toMatchObject({ body: "Installing plugin: demo-plugin" });
    await flushAsyncAction();

    expect(installs).toEqual([
      {
        marketplacePath: "/repo/.codex/plugins",
        pluginName: "demo-plugin",
        remoteMarketplaceName: null,
      },
    ]);
    expect(panel).toMatchObject({
      body: "Plugin installed\nAuth policy: ON_USE\nApps needing auth: 0",
    });
    expect(refreshed).toBe(true);
  });

  it("handles uninstall plugin actions", async () => {
    let panel: CapabilityPanel = { title: "Plugin", body: "Ready" };
    let refreshed = false;
    const uninstalled: string[] = [];
    const notices: unknown[] = [];

    handlePluginPanelAction(
      {
        client: {
          async installPlugin() {
            return { authPolicy: "ON_USE", appsNeedingAuth: [] };
          },
          async uninstallPlugin(pluginId) {
            uninstalled.push(pluginId);
          },
        },
        loadBrowserApps: () => {
          refreshed = true;
        },
        locale: "en",
        openPluginPath: () => {},
        setCapabilityPanel: (updater) => {
          panel = updater(panel) ?? panel;
        },
        setNotice: (notice) => notices.push(notice),
      },
      { type: "uninstall", pluginId: "plugin-id" },
    );

    expect(panel).toMatchObject({ body: "Uninstalling plugin..." });
    await flushAsyncAction();

    expect(uninstalled).toEqual(["plugin-id"]);
    expect(notices).toEqual([{ text: "Plugin uninstalled", tone: "success" }]);
    expect(refreshed).toBe(true);
  });
});
