import { describe, expect, it } from "vitest";

import { buildPluginLibraryPanelContent } from "./pluginLibraryPanel";

describe("plugin library panel content", () => {
  it("builds empty plugin library panels", () => {
    expect(buildPluginLibraryPanelContent([], [], "en")).toEqual({
      subtitle: "0 marketplaces · 0 plugins · 0 enabled",
      body: "0 plugins installed. Plugins provide Skills, Hooks, app templates, and MCP connectors for the tools, agents, and office capability pool.",
      actions: [{ id: "reload-plugins", label: "Refresh plugins" }],
      items: [
        {
          title: "No plugins",
          meta: "backend connected",
          description:
            "No plugin marketplace or plugin entry is available for the current workspace.",
          section: true,
        },
      ],
      error: undefined,
    });
  });

  it("maps marketplace and plugin entries into library items", () => {
    const content = buildPluginLibraryPanelContent(
      [
        {
          name: "local-market",
          path: "/repo/.codex/plugins",
          interface: { displayName: "Local Plugins" },
          plugins: [
            {
              name: "demo-plugin",
              localVersion: "1.2.3",
              source: { type: "local", path: "/repo/plugins/demo" },
              installed: true,
              enabled: true,
              keywords: ["browser", "tools", "agents", "extra"],
              shareContext: null,
            },
          ],
        },
      ],
      [],
      "en",
    );

    expect(content.subtitle).toBe("1 marketplaces · 1 plugins · 1 enabled");
    expect(content.body).toBe(
      "1 plugins installed. Plugins provide Skills, Hooks, app templates, and MCP connectors for the tools, agents, and office capability pool.",
    );
    expect(content.actions).toEqual([
      { id: "reload-plugins", label: "Refresh plugins" },
    ]);
    expect(content.items).toEqual([
      {
        title: "Local Plugins",
        meta: "1 plugins",
        description: "Local marketplace: /repo/.codex/plugins",
        section: true,
      },
      {
        title: "demo-plugin",
        meta: "local · v1.2.3 · enabled · installed",
        description: "browser, tools, agents, extra",
        glyph: expect.any(String),
        accent: expect.any(String),
        badge: { label: "installed", tone: "running" },
        tags: ["browser", "tools", "agents"],
        action: {
          type: "plugin",
          pluginName: "demo-plugin",
          marketplacePath: "/repo/.codex/plugins",
          remoteMarketplaceName: null,
        },
      },
    ]);
  });

  it("includes creator fallback descriptions and load errors", () => {
    const content = buildPluginLibraryPanelContent(
      [
        {
          name: "shared",
          path: null,
          interface: null,
          plugins: [
            {
              name: "remote-plugin",
              localVersion: null,
              source: { type: "remote" },
              installed: false,
              enabled: false,
              keywords: [],
              shareContext: { creatorName: "Ada" },
            },
          ],
        },
      ],
      [{ marketplacePath: "/bad/marketplace", message: "invalid manifest" }],
      "zh",
    );

    expect(content.subtitle).toBe("1 个市场 · 1 个插件 · 0 个启用");
    expect(content.items[0]).toEqual({
      title: "shared",
      meta: "1 个插件",
      description: "远程插件市场",
      section: true,
    });
    expect(content.items[1]).toMatchObject({
      title: "remote-plugin",
      meta: "远程 · 停用 · 未安装",
      description: "创建者: Ada",
      badge: { label: "未安装", tone: "idle" },
      action: {
        type: "plugin",
        pluginName: "remote-plugin",
        marketplacePath: null,
        remoteMarketplaceName: "shared",
      },
    });
    expect(content.error).toBe("/bad/marketplace: invalid manifest");
  });
});
