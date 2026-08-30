import { describe, expect, it } from "vitest";

import type { LibraryKind, LibraryPanel, LibraryPanelAction } from "../domain/crewonDomain";
import { handleLibraryPluginAction } from "./libraryPluginActions";

type CapturedPluginState = {
  installed: Array<{
    marketplacePath?: string | null;
    pluginName: string;
    remoteMarketplaceName?: string | null;
  }>;
  librariesOpened: LibraryKind[];
  panel: LibraryPanel | null;
  uninstalled: string[];
};

function panel(): LibraryPanel {
  return {
    kind: "plugins",
    title: "Plugins",
    subtitle: "Marketplace",
    body: "Existing",
    items: [],
  };
}

async function handleAction(
  action: LibraryPanelAction,
): Promise<{ handled: boolean; state: CapturedPluginState }> {
  const state: CapturedPluginState = {
    installed: [],
    librariesOpened: [],
    panel: panel(),
    uninstalled: [],
  };

  const handled = await handleLibraryPluginAction({
    action,
    installPlugin: async (pluginName, marketplacePath, remoteMarketplaceName) => {
      state.installed.push({
        marketplacePath,
        pluginName,
        remoteMarketplaceName,
      });
      return {
        appsNeedingAuth: [],
        authPolicy: "ON_INSTALL",
      };
    },
    locale: "en",
    openLibrary: async (kind) => {
      state.librariesOpened.push(kind);
    },
    setLibraryPanel: (updater) => {
      state.panel = updater(state.panel);
    },
    uninstallPlugin: async (pluginId) => {
      state.uninstalled.push(pluginId);
    },
  });

  return { handled, state };
}

describe("library plugin actions", () => {
  it("installs plugins and refreshes plugin library", async () => {
    const { handled, state } = await handleAction({
      id: "install-plugin",
      label: "Install",
      marketplacePath: "/marketplace",
      pluginName: "demo-plugin",
      remoteMarketplaceName: "remote",
    });

    expect(handled).toBe(true);
    expect(state.installed).toEqual([
      {
        marketplacePath: "/marketplace",
        pluginName: "demo-plugin",
        remoteMarketplaceName: "remote",
      },
    ]);
    expect(state.panel?.body).toContain("Plugin installed");
    expect(state.librariesOpened).toEqual(["plugins"]);
  });

  it("handles install actions without plugin names", async () => {
    const { handled, state } = await handleAction({
      id: "install-plugin",
      label: "Install",
    });

    expect(handled).toBe(true);
    expect(state.installed).toEqual([]);
    expect(state.librariesOpened).toEqual([]);
  });

  it("uninstalls plugins and refreshes plugin library", async () => {
    const { handled, state } = await handleAction({
      id: "uninstall-plugin",
      label: "Uninstall",
      pluginId: "plugin-id",
    });

    expect(handled).toBe(true);
    expect(state.uninstalled).toEqual(["plugin-id"]);
    expect(state.librariesOpened).toEqual(["plugins"]);
  });

  it("leaves unrelated actions for the app handler", async () => {
    const { handled } = await handleAction({
      id: "reload-tools",
      label: "Reload",
    });

    expect(handled).toBe(false);
  });
});
