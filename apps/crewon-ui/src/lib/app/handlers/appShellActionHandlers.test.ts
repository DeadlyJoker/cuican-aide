import { describe, expect, it, vi } from "vitest";

import type {
  AppShellActionHandlersParams,
} from "./appShellActionHandlers";
import { createAppShellActionHandlers } from "./appShellActionHandlers";
import type { AppView } from "../appRouting";
import type { NoticeState } from "../appRuntimeState";
import type { CapabilityPanel } from "../../capability/capabilityPanelTypes";
import type { LibraryPanel } from "../../domain/crewonDomain";
import type { Locale } from "../../i18n";
import type { SettingsSectionRefreshHandlers } from "../../settings/settingsActions";
import type { SettingsSection } from "../../settings/settingsCatalog";

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

  return {
    appView,
    capabilityDockOpen,
    capabilityPanel,
    commitLocale: (nextLocale) => {
      locale = nextLocale;
    },
    commitThemeToggle: vi.fn(),
    isDemo: false,
    locale,
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
    setNotice: vi.fn(),
    setSettingsSection: (nextSection) => {
      settingsSection = nextSection;
    },
    shouldAutoCloseInspector: () => true,
    sidebarOpen: false,
    ...overrides,
  };
}

describe("app shell action handlers", () => {
  it("routes locale changes through the Control commit", () => {
    const commitLocale = vi.fn();
    const params = createParams({
      commitLocale,
    });

    createAppShellActionHandlers(params).changeLocale("zh");

    expect(commitLocale).toHaveBeenCalledWith("zh");
  });

  it("routes theme changes through the Control commit", () => {
    const commitThemeToggle = vi.fn();
    const params = createParams({
      commitThemeToggle,
    });

    createAppShellActionHandlers(params).toggleTheme();

    expect(commitThemeToggle).toHaveBeenCalledOnce();
  });

  it("opens settings on the appearance panel and refreshes Control preferences", () => {
    const appearance = vi.fn();
    const calls: unknown[] = [];

    const handlers = createAppShellActionHandlers(
      createParams({
        refreshSettingsHandlers: refreshHandlers({ appearance }),
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

    expect(appearance).toHaveBeenCalledTimes(1);
    expect(calls).toEqual([
      { method: "setSettingsSection", section: "appearance" },
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
