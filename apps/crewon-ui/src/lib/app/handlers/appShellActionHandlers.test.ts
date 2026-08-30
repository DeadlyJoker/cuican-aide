import { describe, expect, it, vi } from "vitest";

import type { AppServerClient } from "../../app-server/appServer";
import type {
  AppShellActionHandlersParams,
} from "./appShellActionHandlers";
import { createAppShellActionHandlers } from "./appShellActionHandlers";
import type { AppView } from "../appRouting";
import {
  DESKTOP_LOCALE_KEY_PATH,
  DESKTOP_THEME_KEY_PATH,
  type NoticeState,
} from "../appRuntimeState";
import type { CapabilityPanel } from "../../capability/capabilityPanelTypes";
import type { LibraryPanel } from "../../domain/crewonDomain";
import type { Locale } from "../../i18n";
import type { SettingsSectionRefreshHandlers } from "../../settings/settingsActions";
import type { SettingsSection } from "../../settings/settingsCatalog";
import type { Theme } from "../../theme";

async function flushAsyncWork() {
  await Promise.resolve();
  await Promise.resolve();
}

function panel(title = "Panel"): CapabilityPanel {
  return {
    actions: [],
    items: [],
    subtitle: "Details",
    title,
  } as CapabilityPanel;
}

function libraryPanel(): LibraryPanel {
  return {
    items: [],
    kind: "agents",
    subtitle: "Library",
    title: "Agents",
  };
}

function refreshHandlers(
  overrides: Partial<SettingsSectionRefreshHandlers> = {},
): SettingsSectionRefreshHandlers {
  return {
    account: vi.fn(),
    appearance: vi.fn(),
    appSnapshots: vi.fn(),
    browser: vi.fn(),
    computerControl: vi.fn(),
    config: vi.fn(),
    connections: vi.fn(),
    environment: vi.fn(),
    git: vi.fn(),
    hooks: vi.fn(),
    keyboard: vi.fn(),
    mcpServers: vi.fn(),
    modelProviders: vi.fn(),
    personalization: vi.fn(),
    worktrees: vi.fn(),
    ...overrides,
  };
}

function createParams(
  overrides: Partial<AppShellActionHandlersParams> = {},
): AppShellActionHandlersParams {
  let appView: AppView = "chat";
  let capabilityDockOpen = true;
  let capabilityPanel: CapabilityPanel | null = null;
  let inspectorOpen = true;
  let libraryState: LibraryPanel | null = libraryPanel();
  let locale: Locale = "en";
  let settingsSection: SettingsSection = "account";
  let theme: Theme = "light";

  return {
    appView,
    capabilityDockOpen,
    capabilityPanel,
    client: null,
    getLocale: () => locale,
    isConnected: true,
    isDemo: false,
    locale,
    persistLocale: vi.fn(),
    persistTheme: vi.fn(),
    refreshSettingsHandlers: refreshHandlers(),
    setAppView: (nextView) => {
      appView = nextView;
    },
    setCapabilityDockOpen: (nextOpenOrUpdater) => {
      capabilityDockOpen =
        typeof nextOpenOrUpdater === "function"
          ? nextOpenOrUpdater(capabilityDockOpen)
          : nextOpenOrUpdater;
    },
    setCapabilityPanel: (nextPanelOrUpdater) => {
      capabilityPanel =
        typeof nextPanelOrUpdater === "function"
          ? nextPanelOrUpdater(capabilityPanel)
          : nextPanelOrUpdater;
    },
    setInspectorOpen: (nextOpenOrUpdater) => {
      inspectorOpen =
        typeof nextOpenOrUpdater === "function"
          ? nextOpenOrUpdater(inspectorOpen)
          : nextOpenOrUpdater;
    },
    setLibraryPanel: (nextPanelOrUpdater) => {
      libraryState =
        typeof nextPanelOrUpdater === "function"
          ? nextPanelOrUpdater(libraryState)
          : nextPanelOrUpdater;
    },
    setLocale: (nextLocale) => {
      locale = nextLocale;
    },
    setNotice: vi.fn(),
    setSettingsSection: (nextSection) => {
      settingsSection = nextSection;
    },
    setTheme: (nextThemeOrUpdater) => {
      theme =
        typeof nextThemeOrUpdater === "function"
          ? nextThemeOrUpdater(theme)
          : nextThemeOrUpdater;
    },
    shouldAutoCloseInspector: () => true,
    sidebarOpen: false,
    ...overrides,
  };
}

describe("app shell action handlers", () => {
  it("changes locale and syncs the desktop preference through the current client", async () => {
    const writeConfigBatch = vi.fn(async () => undefined);
    const persistLocale = vi.fn();
    const params = createParams({
      client: { writeConfigBatch } as unknown as AppServerClient,
      persistLocale,
    });

    createAppShellActionHandlers(params).changeLocale("zh");
    await flushAsyncWork();

    expect(persistLocale).toHaveBeenCalledWith("zh");
    expect(writeConfigBatch).toHaveBeenCalledWith([
      {
        keyPath: DESKTOP_LOCALE_KEY_PATH,
        mergeStrategy: "upsert",
        value: "zh",
      },
    ]);
  });

  it("toggles theme and syncs the desktop preference", async () => {
    const writeConfigBatch = vi.fn(async () => undefined);
    const persistTheme = vi.fn();
    const params = createParams({
      client: { writeConfigBatch } as unknown as AppServerClient,
      persistTheme,
    });

    createAppShellActionHandlers(params).toggleTheme();
    await flushAsyncWork();

    expect(persistTheme).toHaveBeenCalledWith("dark");
    expect(writeConfigBatch).toHaveBeenCalledWith([
      {
        keyPath: DESKTOP_THEME_KEY_PATH,
        mergeStrategy: "upsert",
        value: "dark",
      },
    ]);
  });

  it("opens settings on the general panel and refreshes live config", () => {
    const config = vi.fn();
    const calls: unknown[] = [];

    const handlers = createAppShellActionHandlers(
      createParams({
        refreshSettingsHandlers: refreshHandlers({ config }),
        setAppView: (view) => calls.push({ method: "setAppView", view }),
        setCapabilityDockOpen: (open) =>
          calls.push({ method: "setCapabilityDockOpen", open }),
        setInspectorOpen: (open) =>
          calls.push({ method: "setInspectorOpen", open }),
        setSettingsSection: (section) =>
          calls.push({ method: "setSettingsSection", section }),
      }),
    );

    handlers.openSettings();

    expect(config).toHaveBeenCalledTimes(1);
    expect(calls).toEqual([
      { method: "setSettingsSection", section: "config" },
      { method: "setAppView", view: "settings" },
      { method: "setCapabilityDockOpen", open: false },
      { method: "setInspectorOpen", open: false },
    ]);
  });

  it("opens a settings section through the section refresh dispatcher", () => {
    const keyboard = vi.fn();
    const sections: SettingsSection[] = [];
    const handlers = createAppShellActionHandlers(
      createParams({
        refreshSettingsHandlers: refreshHandlers({ keyboard }),
        setSettingsSection: (section) => {
          sections.push(section);
        },
      }),
    );

    handlers.openSettingsSection("keyboard");

    expect(sections).toEqual(["keyboard"]);
    expect(keyboard).toHaveBeenCalledTimes(1);
  });

  it("dispatches explicit settings refreshes by section", async () => {
    const mcpServers = vi.fn(async () => undefined);
    const handlers = createAppShellActionHandlers(
      createParams({
        refreshSettingsHandlers: refreshHandlers({ mcpServers }),
      }),
    );

    await handlers.refreshSettingsSection("mcp-servers");

    expect(mcpServers).toHaveBeenCalledTimes(1);
  });

  it("closes settings and library through their state setters", () => {
    const calls: unknown[] = [];
    const handlers = createAppShellActionHandlers(
      createParams({
        setAppView: (view) => calls.push({ method: "setAppView", view }),
        setCapabilityPanel: (nextPanel) =>
          calls.push({ method: "setCapabilityPanel", nextPanel }),
        setLibraryPanel: (nextPanel) =>
          calls.push({ method: "setLibraryPanel", nextPanel }),
      }),
    );

    handlers.closeSettings();
    handlers.closeLibrary();

    expect(calls).toEqual([
      { method: "setAppView", view: "chat" },
      { method: "setCapabilityPanel", nextPanel: null },
      { method: "setAppView", view: "chat" },
      { method: "setLibraryPanel", nextPanel: null },
    ]);
  });

  it("toggles dock and inspector chrome state", () => {
    const calls: unknown[] = [];
    const handlers = createAppShellActionHandlers(
      createParams({
        appView: "library",
        capabilityDockOpen: false,
        capabilityPanel: panel("Existing"),
        setAppView: (view) => calls.push({ method: "setAppView", view }),
        setCapabilityDockOpen: (updater) =>
          calls.push({
            method: "setCapabilityDockOpen",
            open: typeof updater === "function" ? updater(false) : updater,
          }),
        setInspectorOpen: (updater) =>
          calls.push({
            method: "setInspectorOpen",
            open: typeof updater === "function" ? updater(false) : updater,
          }),
      }),
    );

    handlers.toggleCapabilityDock();
    handlers.toggleInspector();

    expect(calls).toEqual([
      { method: "setAppView", view: "chat" },
      { method: "setCapabilityDockOpen", open: true },
      { method: "setInspectorOpen", open: false },
    ]);
  });
});
