import type { PluginReadResponse } from "@crewon/app-server-protocol/v2/PluginReadResponse";
import { describe, expect, it } from "vitest";

import type { LibraryPanel } from "../domain/crewonDomain";
import { openPluginDetailAction } from "./pluginDetailActions";

function panel(): LibraryPanel {
  return {
    kind: "plugins",
    title: "Plugins",
    subtitle: "Library",
    body: "Existing",
    items: [],
  };
}

function pluginResponse(
  summaryOverrides: Partial<PluginReadResponse["plugin"]["summary"]> = {},
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

describe("plugin detail actions", () => {
  it("loads plugin detail content", async () => {
    let currentPanel: LibraryPanel | null = panel();
    const reads: Array<{
      marketplacePath?: string | null;
      pluginName: string;
      remoteMarketplaceName?: string | null;
    }> = [];

    const handled = await openPluginDetailAction({
      action: {
        type: "plugin",
        pluginName: "demo-plugin",
        marketplacePath: "/repo/.codex/plugins",
        remoteMarketplaceName: "shared",
      },
      locale: "en",
      readPlugin: async (pluginName, marketplacePath, remoteMarketplaceName) => {
        reads.push({ pluginName, marketplacePath, remoteMarketplaceName });
        return pluginResponse();
      },
      setLibraryPanel: (updater) => {
        currentPanel = updater(currentPanel);
      },
    });

    expect(handled).toBe(true);
    expect(reads).toEqual([
      {
        pluginName: "demo-plugin",
        marketplacePath: "/repo/.codex/plugins",
        remoteMarketplaceName: "shared",
      },
    ]);
    expect(currentPanel).toMatchObject({
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
        },
      ],
    });
  });

  it("leaves the loading panel when no plugin response is returned", async () => {
    let currentPanel: LibraryPanel | null = panel();

    const handled = await openPluginDetailAction({
      action: {
        type: "plugin",
        pluginName: "missing-plugin",
      },
      locale: "en",
      readPlugin: async () => null,
      setLibraryPanel: (updater) => {
        currentPanel = updater(currentPanel);
      },
    });

    expect(handled).toBe(true);
    expect(currentPanel).toMatchObject({
      body: "Reading plugin details...",
      error: undefined,
    });
  });

  it("shows plugin detail failures", async () => {
    let currentPanel: LibraryPanel | null = panel();

    const handled = await openPluginDetailAction({
      action: {
        type: "plugin",
        pluginName: "demo-plugin",
      },
      locale: "en",
      readPlugin: async () => {
        throw new Error("plugin failed");
      },
      setLibraryPanel: (updater) => {
        currentPanel = updater(currentPanel);
      },
    });

    expect(handled).toBe(true);
    expect(currentPanel).toMatchObject({
      body: "Reading plugin details...",
      error: "plugin failed",
    });
  });
});
