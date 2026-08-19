import { describe, expect, it, vi } from "vitest";

import type { AppView } from "./appRouting";
import type { CapabilityPanel } from "../capability/capabilityPanelTypes";
import type { LibraryPanel } from "../domain/crewonDomain";
import type { SettingsSection } from "../settings/settingsCatalog";
import {
  closeChromeOnEscapeAction,
  closeCrampedInspectorAction,
  closeInspectorFromOutsideTargetAction,
  closeLibraryAction,
  closeSettingsAction,
  openSettingsAction,
  openSettingsSectionAction,
  syncSettingsViewPanelAction,
  syncViewFromSearchAction,
  toggleCapabilityDockAction,
  toggleInspectorAction,
} from "./appViewActions";

function defaultPanel(locale: "en" | "zh"): CapabilityPanel {
  return {
    title: `Demo ${locale}`,
  };
}

describe("app view actions", () => {
  it("opens connected settings and refreshes the general panel", () => {
    const state = {
      appView: "chat" as AppView,
      capabilityDockOpen: true,
      capabilityPanel: null as CapabilityPanel | null,
      inspectorOpen: true,
      settingsSection: "config" as SettingsSection,
    };
    const refreshDefaultSettingsPanel = vi.fn();

    openSettingsAction({
      refreshDefaultSettingsPanel,
      setAppView: (view) => {
        state.appView = view;
      },
      setCapabilityDockOpen: (open) => {
        state.capabilityDockOpen = open;
      },
      setCapabilityPanel: (panel) => {
        state.capabilityPanel = panel;
      },
      setInspectorOpen: (open) => {
        state.inspectorOpen = open;
      },
      setSettingsSection: (section) => {
        state.settingsSection = section;
      },
    });

    expect(state).toEqual({
      appView: "settings",
      capabilityDockOpen: false,
      capabilityPanel: null,
      inspectorOpen: false,
      settingsSection: "appearance",
    });
    expect(refreshDefaultSettingsPanel).toHaveBeenCalledOnce();
  });

  it("opens a settings section through its Control refresh", () => {
    let settingsSection: SettingsSection = "account";
    let capabilityPanel: CapabilityPanel | null = null;
    const refreshSettingsSection = vi.fn();

    openSettingsSectionAction({
      refreshSettingsSection,
      section: "git",
      setCapabilityPanel: (panel) => {
        capabilityPanel = panel;
      },
      setSettingsSection: (section) => {
        settingsSection = section;
      },
    });
    expect(settingsSection).toBe("git");
    expect(capabilityPanel).toBeNull();
    expect(refreshSettingsSection).toHaveBeenCalledWith("git");
  });

  it("closes settings and library views", () => {
    let appView: AppView = "settings";
    let capabilityPanel: CapabilityPanel | null = { title: "Settings" };
    let libraryPanel: LibraryPanel | null = {
      kind: "tools",
      title: "Tools",
      subtitle: "Library",
      items: [],
    };

    closeSettingsAction({
      setAppView: (view) => {
        appView = view;
      },
      setCapabilityPanel: (panel) => {
        capabilityPanel = panel;
      },
    });
    expect(appView).toBe("chat");
    expect(capabilityPanel).toBeNull();

    appView = "library";
    closeLibraryAction({
      setAppView: (view) => {
        appView = view;
      },
      setLibraryPanel: (panel) => {
        libraryPanel = panel;
      },
    });
    expect(appView).toBe("chat");
    expect(libraryPanel).toBeNull();
  });

  it("toggles inspector unless cramped layout would immediately close it", () => {
    let inspectorOpen = false;

    toggleInspectorAction({
      capabilityDockOpen: true,
      setInspectorOpen: (updater) => {
        inspectorOpen = updater(inspectorOpen);
      },
      shouldAutoCloseInspector: () => true,
      sidebarOpen: true,
    });
    expect(inspectorOpen).toBe(false);

    toggleInspectorAction({
      capabilityDockOpen: false,
      setInspectorOpen: (updater) => {
        inspectorOpen = updater(inspectorOpen);
      },
      shouldAutoCloseInspector: () => false,
      sidebarOpen: false,
    });
    expect(inspectorOpen).toBe(true);
  });

  it("toggles the capability dock and exits focused app views", () => {
    let appView: AppView = "library";
    let capabilityDockOpen = false;
    let capabilityPanel: CapabilityPanel | null = null;

    toggleCapabilityDockAction({
      appView,
      capabilityDockOpen,
      capabilityPanel,
      defaultCapabilityPanel: defaultPanel,
      locale: "en",
      setAppView: (view) => {
        appView = view;
      },
      setCapabilityDockOpen: (updater) => {
        capabilityDockOpen = updater(capabilityDockOpen);
      },
      setCapabilityPanel: (panel) => {
        capabilityPanel = panel;
      },
    });

    expect(appView).toBe("chat");
    expect(capabilityDockOpen).toBe(true);
    expect(capabilityPanel).toEqual({ title: "Demo en" });
  });

  it("opens an empty dock by restoring the default panel without closing it", () => {
    let capabilityDockOpen = true;
    let capabilityPanel: CapabilityPanel | null = null;

    toggleCapabilityDockAction({
      appView: "chat",
      capabilityDockOpen,
      capabilityPanel,
      defaultCapabilityPanel: defaultPanel,
      locale: "zh",
      setAppView: () => {},
      setCapabilityDockOpen: (updater) => {
        capabilityDockOpen = updater(capabilityDockOpen);
      },
      setCapabilityPanel: (panel) => {
        capabilityPanel = panel;
      },
    });

    expect(capabilityDockOpen).toBe(true);
    expect(capabilityPanel).toEqual({ title: "Demo zh" });
  });

  it("closes sidebar and inspector on escape", () => {
    let sidebarOpen = true;
    let inspectorOpen = true;

    expect(
      closeChromeOnEscapeAction({
        event: { key: "a" },
        setInspectorOpen: (open) => {
          inspectorOpen = open;
        },
        setSidebarOpen: (open) => {
          sidebarOpen = open;
        },
      }),
    ).toBe(false);
    expect(sidebarOpen).toBe(true);
    expect(inspectorOpen).toBe(true);

    expect(
      closeChromeOnEscapeAction({
        event: { key: "Escape" },
        setInspectorOpen: (open) => {
          inspectorOpen = open;
        },
        setSidebarOpen: (open) => {
          sidebarOpen = open;
        },
      }),
    ).toBe(true);
    expect(sidebarOpen).toBe(false);
    expect(inspectorOpen).toBe(false);
  });

  it("closes inspector only for outside click targets", () => {
    let inspectorOpen = true;
    const target = {
      closest: (selector: string) => (selector === ".inspector" ? {} : null),
    } as unknown as EventTarget;

    expect(
      closeInspectorFromOutsideTargetAction({
        setInspectorOpen: (open) => {
          inspectorOpen = open;
        },
        target,
      }),
    ).toBe(false);
    expect(inspectorOpen).toBe(true);

    expect(
      closeInspectorFromOutsideTargetAction({
        setInspectorOpen: (open) => {
          inspectorOpen = open;
        },
        target: {
          closest: () => null,
        } as unknown as EventTarget,
      }),
    ).toBe(true);
    expect(inspectorOpen).toBe(false);
  });

  it("closes cramped inspector layouts", () => {
    let inspectorOpen = true;

    expect(
      closeCrampedInspectorAction({
        capabilityDockOpen: false,
        setInspectorOpen: (open) => {
          inspectorOpen = open;
        },
        shouldAutoCloseInspector: () => false,
        sidebarOpen: false,
      }),
    ).toBe(false);
    expect(inspectorOpen).toBe(true);

    expect(
      closeCrampedInspectorAction({
        capabilityDockOpen: true,
        setInspectorOpen: (open) => {
          inspectorOpen = open;
        },
        shouldAutoCloseInspector: () => true,
        sidebarOpen: true,
      }),
    ).toBe(true);
    expect(inspectorOpen).toBe(false);
  });

  it("syncs settings views from URL search", () => {
    let appView: AppView = "chat";
    let settingsSection: SettingsSection = "account";
    let lastSyncedSearch = "";
    let refreshedSection: SettingsSection | null = null;
    let capabilityPanel: CapabilityPanel | null = null;

    expect(
      syncViewFromSearchAction({
        isConnected: true,
        lastSyncedSearch,
        openLibrary: () => {},
        refreshSettingsSection: (section) => {
          refreshedSection = section;
        },
        search: "?view=settings&section=appearance",
        setAppView: (view) => {
          appView = view;
        },
        setCapabilityPanel: (panel) => {
          capabilityPanel = panel;
        },
        setLastSyncedSearch: (search) => {
          lastSyncedSearch = search;
        },
        setSettingsSection: (section) => {
          settingsSection = section;
        },
      }),
    ).toBe(true);

    expect(appView).toBe("settings");
    expect(settingsSection).toBe("appearance");
    expect(refreshedSection).toBe("appearance");
    expect(capabilityPanel).toBeNull();
    expect(lastSyncedSearch).toBe("?view=settings&section=appearance");
  });

  it("does not synthesize settings while disconnected and still opens real libraries", () => {
    let capabilityPanel: CapabilityPanel | null = null;
    const openedLibraries: string[] = [];

    syncViewFromSearchAction({
      isConnected: false,
      lastSyncedSearch: "",
      openLibrary: (kind) => {
        openedLibraries.push(kind);
      },
      refreshSettingsSection: () => {},
      search: "?view=settings&section=git",
      setAppView: () => {},
      setCapabilityPanel: (panel) => {
        capabilityPanel = panel;
      },
      setLastSyncedSearch: () => {},
      setSettingsSection: () => {},
    });
    expect(capabilityPanel).toBeNull();

    syncViewFromSearchAction({
      isConnected: false,
      lastSyncedSearch: "?view=settings&section=git",
      openLibrary: (kind) => {
        openedLibraries.push(kind);
      },
      refreshSettingsSection: () => {},
      search: "?view=tools",
      setAppView: () => {},
      setCapabilityPanel: () => {},
      setLastSyncedSearch: () => {},
      setSettingsSection: () => {},
    });

    expect(openedLibraries).toEqual(["tools"]);
  });

  it("ignores repeated URL search syncs and falls back to chat", () => {
    let appView: AppView = "settings";
    let lastSyncedSearch = "?view=tools";

    expect(
      syncViewFromSearchAction({
        isConnected: false,
        lastSyncedSearch,
        openLibrary: () => {},
        refreshSettingsSection: () => {},
        search: "?view=tools",
        setAppView: (view) => {
          appView = view;
        },
        setCapabilityPanel: () => {},
        setLastSyncedSearch: (search) => {
          lastSyncedSearch = search;
        },
        setSettingsSection: () => {},
      }),
    ).toBe(false);
    expect(appView).toBe("settings");

    expect(
      syncViewFromSearchAction({
        isConnected: false,
        lastSyncedSearch,
        openLibrary: () => {},
        refreshSettingsSection: () => {},
        search: "",
        setAppView: (view) => {
          appView = view;
        },
        setCapabilityPanel: () => {},
        setLastSyncedSearch: (search) => {
          lastSyncedSearch = search;
        },
        setSettingsSection: () => {},
      }),
    ).toBe(true);
    expect(appView).toBe("chat");
    expect(lastSyncedSearch).toBe("");
  });

  it("does not close focused app views for unrelated URL params", () => {
    let appView: AppView = "library";
    let lastSyncedSearch = "";

    expect(
      syncViewFromSearchAction({
        isConnected: false,
        lastSyncedSearch,
        openLibrary: () => {},
        refreshSettingsSection: () => {},
        search: "?platform=mac",
        setAppView: (view) => {
          appView = view;
        },
        setCapabilityPanel: () => {},
        setLastSyncedSearch: (search) => {
          lastSyncedSearch = search;
        },
        setSettingsSection: () => {},
      }),
    ).toBe(false);
    expect(appView).toBe("library");
    expect(lastSyncedSearch).toBe("?platform=mac");
  });

  it("syncs the visible settings panel only from Control", () => {
    let refreshedSection: SettingsSection | null = null;
    let capabilityPanel: CapabilityPanel | null = null;

    expect(
      syncSettingsViewPanelAction({
        appView: "chat",
        isConnected: true,
        refreshSettingsSection: (section) => {
          refreshedSection = section;
        },
        section: "config",
        setCapabilityPanel: (panel) => {
          capabilityPanel = panel;
        },
      }),
    ).toBe(false);
    expect(refreshedSection).toBeNull();

    expect(
      syncSettingsViewPanelAction({
        appView: "settings",
        isConnected: true,
        refreshSettingsSection: (section) => {
          refreshedSection = section;
        },
        section: "config",
        setCapabilityPanel: (panel) => {
          capabilityPanel = panel;
        },
      }),
    ).toBe(true);
    expect(refreshedSection).toBe("config");
    expect(capabilityPanel).toBeNull();

    expect(
      syncSettingsViewPanelAction({
        appView: "settings",
        isConnected: false,
        refreshSettingsSection: () => {},
        section: "browser",
        setCapabilityPanel: (panel) => {
          capabilityPanel = panel;
        },
      }),
    ).toBe(false);
    expect(capabilityPanel).toBeNull();
  });
});
