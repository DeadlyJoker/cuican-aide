import type { PluginReadResponse } from "@crewon-ui-model/v2/PluginReadResponse";
import { describe, expect, it } from "vitest";

import {
  buildPluginDetailPanelContent,
  pluginDetailContentPanel,
  pluginDetailContentPatch,
  pluginDetailFailurePanel,
  pluginDetailFailurePatch,
  pluginDetailLoadingPanel,
  pluginDetailLoadingPatch,
} from "./pluginDetailPanel";

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
        keywords: ["browser"],
        ...summaryOverrides,
      },
      description: "Demo plugin",
      skills: [],
      hooks: [],
      apps: [],
      appTemplates: [],
      mcpServers: [],
    },
  };
}

describe("plugin detail panel content", () => {
  it("builds plugin detail lifecycle patches", () => {
    expect(pluginDetailLoadingPatch("en")).toEqual({
      body: "Reading plugin details...",
      error: undefined,
    });
    expect(
      pluginDetailContentPatch({
        title: "demo-plugin",
        subtitle: "Plugin details",
        body: "Demo plugin",
        actions: [
          {
            id: "install-plugin",
            label: "Install",
            pluginName: "demo-plugin",
          },
        ],
      }),
    ).toEqual({
      title: "demo-plugin",
      subtitle: "Plugin details",
      body: "Demo plugin",
      actions: [
        {
          id: "install-plugin",
          label: "Install",
          pluginName: "demo-plugin",
        },
      ],
    });
    expect(pluginDetailFailurePatch(null, "zh")).toEqual({
      error: "读取插件失败",
    });
    expect(pluginDetailFailurePatch(new Error("denied"), "en")).toEqual({
      error: "denied",
    });
    expect(
      pluginDetailLoadingPanel(
        {
          kind: "plugins",
          title: "Plugins",
          subtitle: "Library",
          body: "Existing",
          items: [],
          error: "old error",
        },
        "en",
      ),
    ).toEqual({
      kind: "plugins",
      title: "Plugins",
      subtitle: "Library",
      body: "Reading plugin details...",
      items: [],
      error: undefined,
    });
    expect(
      pluginDetailContentPanel(
        {
          kind: "plugins",
          title: "Plugins",
          subtitle: "Library",
          body: "Existing",
          items: [],
        },
        {
          title: "demo-plugin",
          subtitle: "Plugin details",
          body: "Demo plugin",
          actions: undefined,
        },
      ),
    ).toEqual({
      kind: "plugins",
      title: "demo-plugin",
      subtitle: "Plugin details",
      body: "Demo plugin",
      items: [],
      actions: undefined,
    });
    expect(pluginDetailFailurePanel(null, null, "en")).toBeNull();
  });

  it("builds install actions for available plugins", () => {
    expect(
      buildPluginDetailPanelContent(
        pluginResponse({}),
        {
          marketplacePath: "/repo/.codex/plugins",
          pluginName: "demo-plugin",
          remoteMarketplaceName: "shared",
        },
        "en",
      ),
    ).toMatchObject({
      title: "demo-plugin",
      subtitle: "Plugin details",
      body: expect.stringContaining("Demo plugin"),
      actions: [
        {
          id: "install-plugin",
          label: "Install plugin",
          marketplacePath: "/repo/.codex/plugins",
          pluginName: "demo-plugin",
          remoteMarketplaceName: "shared",
          tone: "primary",
        },
      ],
    });
  });

  it("builds local source and uninstall actions for installed plugins", () => {
    expect(
      buildPluginDetailPanelContent(
        pluginResponse({
          source: { type: "local", path: "/repo/plugins/demo" },
          installed: true,
        }),
        { pluginName: "demo-plugin" },
        "zh",
      ).actions,
    ).toEqual([
      {
        id: "open-path",
        label: "右栏打开插件目录",
        pathToOpen: "/repo/plugins/demo",
        pathKind: "directory",
      },
      {
        id: "uninstall-plugin",
        label: "卸载插件",
        pluginId: "plugin-id",
        tone: "danger",
      },
    ]);
  });

  it("omits actions for unavailable remote plugins", () => {
    expect(
      buildPluginDetailPanelContent(
        pluginResponse({ availability: "DISABLED_BY_ADMIN" }),
        { pluginName: "demo-plugin" },
        "en",
      ).actions,
    ).toBeUndefined();
  });
});
