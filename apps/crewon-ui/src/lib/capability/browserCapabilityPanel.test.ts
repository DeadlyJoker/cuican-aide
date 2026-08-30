import { describe, expect, it } from "vitest";

import {
  browserCapabilityErrorPanel,
  browserCapabilityLoadingPanel,
  browserCapabilityPanel,
  buildBrowserCapabilityPanelContent,
} from "./browserCapabilityPanel";

describe("browser capability panel content", () => {
  it("builds browser capability wrapper panels", () => {
    expect(browserCapabilityLoadingPanel("en")).toEqual({
      title: "Apps & Plugins",
      subtitle: "Apps, plugins, and hooks",
      body: "Loading...",
    });
    expect(
      browserCapabilityPanel({
        apps: [],
        hookEntries: [],
        marketplaces: [],
        locale: "zh",
      }),
    ).toMatchObject({
      title: "应用与插件",
      subtitle: "0 应用 · 0 插件 · 0 Hook",
    });
    expect(browserCapabilityErrorPanel(null, "en")).toEqual({
      title: "Apps & Plugins",
      subtitle: "Apps, plugins, and hooks",
      error: "Unable to load apps",
    });
    expect(browserCapabilityErrorPanel(new Error("denied"), "zh")).toEqual({
      title: "应用与插件",
      subtitle: "应用、插件与 Hook",
      error: "denied",
    });
  });

  it("builds localized empty states", () => {
    expect(
      buildBrowserCapabilityPanelContent({
        apps: [],
        hookEntries: [],
        marketplaces: [],
        locale: "en",
      }),
    ).toEqual({
      subtitle: "0 apps · 0 plugins · 0 hooks",
      body: undefined,
      items: [
        { label: "No apps available" },
        { label: "No enabled plugins" },
        { label: "No hooks" },
      ],
    });

    expect(
      buildBrowserCapabilityPanelContent({
        apps: [],
        hookEntries: [],
        marketplaces: [],
        locale: "zh",
      }).items,
    ).toEqual([{ label: "暂无可用应用" }, { label: "暂无已启用插件" }, { label: "暂无 Hook" }]);
  });

  it("maps apps, installed plugins, and hooks into panel items", () => {
    const content = buildBrowserCapabilityPanelContent({
      apps: [
        {
          id: "app-1",
          name: "Browser Agent",
          isAccessible: false,
          isEnabled: true,
          pluginDisplayNames: ["Plugin A"],
        },
      ],
      hookEntries: [
        {
          hooks: [
            {
              eventName: "preToolUse",
              handlerType: "command",
              enabled: false,
            },
          ],
        },
      ],
      marketplaces: [
        {
          name: "local",
          path: "/repo/.codex/plugins",
          plugins: [
            {
              name: "enabled-plugin",
              source: { type: "local", path: "/repo/plugins/enabled" },
              installed: false,
              enabled: true,
            },
            {
              name: "hidden-plugin",
              source: { type: "remote" },
              installed: false,
              enabled: false,
            },
          ],
        },
      ],
      locale: "en",
    });

    expect(content).toEqual({
      subtitle: "1 apps · 1 plugins · 1 hooks",
      body: undefined,
      items: [
        {
          label: "App · Browser Agent · needs auth · enabled · Plugin A",
          action: {
            type: "app",
            appId: "app-1",
            appName: "Browser Agent",
          },
        },
        {
          label: "Plugin · enabled-plugin · local · enabled",
          action: {
            type: "plugin",
            pluginName: "enabled-plugin",
            marketplacePath: "/repo/.codex/plugins",
            remoteMarketplaceName: null,
          },
        },
        { label: "Hook · preToolUse · command · disabled" },
      ],
    });
  });

  it("surfaces plugin-only browser capabilities", () => {
    const content = buildBrowserCapabilityPanelContent({
      apps: [],
      hookEntries: [],
      marketplaces: [
        {
          name: "shared",
          path: null,
          plugins: [
            {
              name: "remote-plugin",
              source: { type: "remote" },
              installed: true,
              enabled: false,
            },
          ],
        },
      ],
      locale: "zh",
    });

    expect(content.subtitle).toBe("0 应用 · 1 插件 · 0 Hook");
    expect(content.body).toBe(
      "当前没有暴露 App，但已从插件市场读取到可用插件能力。点击插件可查看详情、打开本地目录或执行安装状态操作。",
    );
    expect(content.items[1]).toEqual({
      label: "插件 · remote-plugin · 远程 · 停用",
      action: {
        type: "plugin",
        pluginName: "remote-plugin",
        marketplacePath: null,
        remoteMarketplaceName: "shared",
      },
    });
  });
});
