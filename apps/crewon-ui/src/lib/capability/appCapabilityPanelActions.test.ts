import { describe, expect, it, vi } from "vitest";

import type { CapabilityPanel, CapabilityPanelItem } from "./capabilityPanelTypes";
import {
  createAppSettingsSaveHandlers,
  createSettingsRefreshHandlers,
  openPluginPathFromPanelAction,
  updateCapabilityPanelFieldAction,
} from "./appCapabilityPanelActions";
import type { LibraryPanel } from "../domain/crewonDomain";
import type { SettingsRefreshAction } from "../settings/settingsActions";
import type { AppSettingsRefreshHandlers } from "../settings/settingsRefreshHandlers";
import type { ConfigEdit } from "../settings/settingsSavePayloads";

async function flushAsyncSave() {
  await Promise.resolve();
  await Promise.resolve();
}

function refreshHandlers(overrides: Partial<Record<SettingsRefreshAction, () => void>> = {}) {
  const calls: SettingsRefreshAction[] = [];
  const handler = (action: SettingsRefreshAction) => () => {
    calls.push(action);
    overrides[action]?.();
    return Promise.resolve();
  };
  const appHandlers = {
    openThreadSettingsPanel: () => Promise.resolve(),
    refreshAccountPanel: () => Promise.resolve(),
    refreshAppearanceSettingsPanel: handler("appearance"),
    refreshAppSnapshotsSettingsPanel: handler("appSnapshots"),
    refreshBrowserSettingsPanel: handler("browserApps"),
    refreshComputerControlSettingsPanel: handler("computerControl"),
    refreshConfigPanel: handler("config"),
    refreshConnectionsSettingsPanel: handler("connections"),
    refreshEnvironmentSettingsPanel: handler("environment"),
    refreshGitSettingsPanel: handler("git"),
    refreshHooksPanel: handler("hooks"),
    refreshIntegrationsPanel: handler("integrations"),
    refreshKeyboardSettingsPanel: handler("keyboard"),
    refreshMcpSettingsPanel: handler("mcpSettings"),
    refreshModelProvidersPanel: handler("modelProviders"),
    refreshPersonalizationSettingsPanel: handler("personalization"),
    refreshWorktreesSettingsPanel: handler("worktrees"),
  } satisfies AppSettingsRefreshHandlers;
  return {
    calls,
    handlers: createSettingsRefreshHandlers(appHandlers),
  };
}

describe("app capability panel actions", () => {
  it("opens plugin paths as directory capability panel items", () => {
    const openedItems: CapabilityPanelItem[] = [];

    openPluginPathFromPanelAction({
      openCapabilityPanelItem: (item) => {
        openedItems.push(item);
      },
      path: "/repo/plugins/github",
    });

    expect(openedItems).toEqual([
      {
        label: "github",
        path: "/repo/plugins/github",
        kind: "directory",
      },
    ]);
  });

  it("creates settings refresh handlers for every refresh action", () => {
    const { calls, handlers } = refreshHandlers();

    handlers.config();
    handlers.browserApps();
    handlers.mcpSettings();
    handlers.worktrees();

    expect(calls).toEqual([
      "config",
      "browserApps",
      "mcpSettings",
      "worktrees",
    ]);
  });

  it("does not await async refresh handlers", () => {
    const refreshConfigPanel = vi.fn(async () => undefined);
    const { handlers } = refreshHandlers({ config: refreshConfigPanel });

    handlers.config();

    expect(refreshConfigPanel).toHaveBeenCalledOnce();
  });

  it("creates settings save handlers that read trimmed values from the current panel", async () => {
    const writes: ConfigEdit[][] = [];
    let refreshes = 0;
    let panel: CapabilityPanel | null = {
      title: "Config",
      fields: [
        { id: "config-model", label: "Model", value: " gpt-5 " },
        { id: "config-approval-policy", label: "Approvals", value: "" },
        {
          id: "config-sandbox-mode",
          label: "Sandbox",
          value: " workspace-write ",
        },
      ],
    };

    const handlers = createAppSettingsSaveHandlers({
      capabilityPanel: panel,
      client: {
        async writeConfigBatch(edits) {
          writes.push(edits);
          return { filePath: "/repo/config.toml", status: "ok", version: 1 };
        },
      },
      isConnected: true,
      locale: "en",
      persistLocale: () => {},
      persistTheme: () => {},
      refreshAppearanceSettingsPanel: () => {},
      refreshConfigPanel: () => {
        refreshes += 1;
      },
      refreshPersonalizationSettingsPanel: () => {},
      setCapabilityPanel: (updater) => {
        panel = updater(panel);
      },
      setLocale: () => {},
      setTheme: () => {},
      theme: "dark",
    });

    handlers.config();
    await flushAsyncSave();

    expect(writes).toEqual([
      [
        { keyPath: "model", value: "gpt-5" },
        { keyPath: "sandbox_mode", value: "workspace-write" },
      ],
    ]);
    expect(refreshes).toBe(1);
  });

  it("updates matching fields in capability and library panels", () => {
    let capabilityPanel: CapabilityPanel | null = {
      title: "Capability",
      fields: [
        { id: "shared", label: "Shared", value: "old" },
        { id: "other", label: "Other", value: "kept" },
      ],
    };
    let libraryPanel: LibraryPanel | null = {
      kind: "tools",
      title: "Tools",
      subtitle: "Library",
      items: [],
      fields: [{ id: "shared", label: "Shared", value: "old" }],
    };

    updateCapabilityPanelFieldAction({
      fieldId: "shared",
      setCapabilityPanel: (updater) => {
        capabilityPanel = updater(capabilityPanel);
      },
      setLibraryPanel: (updater) => {
        libraryPanel = updater(libraryPanel);
      },
      value: "new",
    });

    expect(capabilityPanel?.fields).toEqual([
      { id: "shared", label: "Shared", value: "new" },
      { id: "other", label: "Other", value: "kept" },
    ]);
    expect(libraryPanel?.fields).toEqual([
      { id: "shared", label: "Shared", value: "new" },
    ]);
  });
});
