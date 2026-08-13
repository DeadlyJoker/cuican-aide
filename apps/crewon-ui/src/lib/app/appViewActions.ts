import {
  libraryViewFromSearch,
  settingsSectionFromSearch,
  type AppView,
} from "./appRouting";
import type { CapabilityPanel } from "../capability/capabilityPanelTypes";
import type { Locale } from "../i18n";
import type { LibraryKind, LibraryPanel } from "../domain/crewonDomain";
import type { SettingsSection } from "../settings/settingsCatalog";

export type AppViewSetter = (view: AppView) => void;
export type BooleanSetter = (value: boolean) => void;
export type BooleanUpdaterSetter = (
  updater: (currentValue: boolean) => boolean,
) => void;
export type CapabilityPanelSetter = (panel: CapabilityPanel | null) => void;
export type LibraryPanelSetter = (panel: LibraryPanel | null) => void;
export type SettingsSectionSetter = (section: SettingsSection) => void;

type ClosestTarget = {
  closest: (selector: string) => unknown;
};

function hasClosestTarget(target: EventTarget | null): target is EventTarget &
  ClosestTarget {
  return Boolean(
    target &&
      "closest" in target &&
      typeof (target as Partial<ClosestTarget>).closest === "function",
  );
}

function hasViewParam(search: string): boolean {
  return new URLSearchParams(search).has("view");
}

export function openSettingsAction(params: {
  demoSettingsPanel: (section: SettingsSection, locale: Locale) => CapabilityPanel;
  isDemo: boolean;
  locale: Locale;
  refreshDefaultSettingsPanel: () => void | Promise<void>;
  setAppView: AppViewSetter;
  setCapabilityDockOpen: BooleanSetter;
  setCapabilityPanel: CapabilityPanelSetter;
  setInspectorOpen: BooleanSetter;
  setSettingsSection: SettingsSectionSetter;
}): void {
  params.setSettingsSection("appearance");
  params.setAppView("settings");
  params.setCapabilityDockOpen(false);
  params.setInspectorOpen(false);
  if (params.isDemo) {
    params.setCapabilityPanel(
      params.demoSettingsPanel("appearance", params.locale),
    );
    return;
  }
  void params.refreshDefaultSettingsPanel();
}

export function openSettingsSectionAction(params: {
  demoSettingsPanel: (section: SettingsSection, locale: Locale) => CapabilityPanel;
  isDemo: boolean;
  locale: Locale;
  refreshSettingsSection: (section: SettingsSection) => void | Promise<void>;
  section: SettingsSection;
  setCapabilityPanel: CapabilityPanelSetter;
  setSettingsSection: SettingsSectionSetter;
}): void {
  params.setSettingsSection(params.section);
  if (params.isDemo) {
    params.setCapabilityPanel(
      params.demoSettingsPanel(params.section, params.locale),
    );
    return;
  }
  void params.refreshSettingsSection(params.section);
}

export function closeSettingsAction(params: {
  setAppView: AppViewSetter;
  setCapabilityPanel: CapabilityPanelSetter;
}): void {
  params.setAppView("chat");
  params.setCapabilityPanel(null);
}

export function closeLibraryAction(params: {
  setAppView: AppViewSetter;
  setLibraryPanel: LibraryPanelSetter;
}): void {
  params.setAppView("chat");
  params.setLibraryPanel(null);
}

export function toggleInspectorAction(params: {
  capabilityDockOpen: boolean;
  setInspectorOpen: BooleanUpdaterSetter;
  shouldAutoCloseInspector: (
    sidebarOpen: boolean,
    capabilityDockOpen: boolean,
  ) => boolean;
  sidebarOpen: boolean;
}): void {
  params.setInspectorOpen((open) =>
    !open &&
    params.shouldAutoCloseInspector(params.sidebarOpen, params.capabilityDockOpen)
      ? false
      : !open,
  );
}

export function toggleCapabilityDockAction(params: {
  appView: AppView;
  capabilityDockOpen: boolean;
  capabilityPanel: CapabilityPanel | null;
  defaultCapabilityPanel: (locale: Locale) => CapabilityPanel;
  locale: Locale;
  setAppView: AppViewSetter;
  setCapabilityDockOpen: BooleanUpdaterSetter;
  setCapabilityPanel: CapabilityPanelSetter;
}): void {
  if (params.appView === "settings" || params.appView === "library") {
    params.setAppView("chat");
  }
  if (params.capabilityDockOpen && !params.capabilityPanel) {
    params.setCapabilityPanel(params.defaultCapabilityPanel(params.locale));
    return;
  }
  if (!params.capabilityDockOpen && !params.capabilityPanel) {
    params.setCapabilityPanel(params.defaultCapabilityPanel(params.locale));
  }
  params.setCapabilityDockOpen((open) => !open);
}

export function closeChromeOnEscapeAction(params: {
  event: { key: string };
  setInspectorOpen: BooleanSetter;
  setSidebarOpen: BooleanSetter;
}): boolean {
  if (params.event.key !== "Escape") {
    return false;
  }
  params.setSidebarOpen(false);
  params.setInspectorOpen(false);
  return true;
}

export function closeInspectorFromOutsideTargetAction(params: {
  protectedSelectors?: string[];
  setInspectorOpen: BooleanSetter;
  target: EventTarget | null;
}): boolean {
  const target = params.target;
  if (!hasClosestTarget(target)) {
    return false;
  }

  const protectedSelectors = params.protectedSelectors ?? [
    ".inspector",
    ".titlebar-env-toggle",
  ];
  if (protectedSelectors.some((selector) => target.closest(selector))) {
    return false;
  }

  params.setInspectorOpen(false);
  return true;
}

export function closeCrampedInspectorAction(params: {
  capabilityDockOpen: boolean;
  setInspectorOpen: BooleanSetter;
  shouldAutoCloseInspector: (
    sidebarOpen: boolean,
    capabilityDockOpen: boolean,
  ) => boolean;
  sidebarOpen: boolean;
}): boolean {
  if (
    !params.shouldAutoCloseInspector(params.sidebarOpen, params.capabilityDockOpen)
  ) {
    return false;
  }
  params.setInspectorOpen(false);
  return true;
}

export function syncViewFromSearchAction(params: {
  demoSettingsPanel: (section: SettingsSection, locale: Locale) => CapabilityPanel;
  isConnected: boolean;
  isDemo: boolean;
  lastSyncedSearch: string;
  locale: Locale;
  openLibrary: (kind: LibraryKind) => void | Promise<void>;
  refreshSettingsSection: (section: SettingsSection) => void | Promise<void>;
  search: string;
  setAppView: AppViewSetter;
  setCapabilityPanel: CapabilityPanelSetter;
  setLastSyncedSearch: (search: string) => void;
  setSettingsSection: SettingsSectionSetter;
}): boolean {
  if (params.lastSyncedSearch === params.search) {
    return false;
  }

  params.setLastSyncedSearch(params.search);
  const view = new URLSearchParams(params.search).get("view");
  if (!view) {
    if (hasViewParam(params.lastSyncedSearch)) {
      params.setAppView("chat");
      return true;
    }
    return false;
  }

  if (view === "settings") {
    const settingsViewSection = settingsSectionFromSearch(params.search);
    params.setAppView("settings");
    params.setSettingsSection(settingsViewSection);
    if (params.isConnected) {
      void params.refreshSettingsSection(settingsViewSection);
    } else if (params.isDemo) {
      params.setCapabilityPanel(
        params.demoSettingsPanel(settingsViewSection, params.locale),
      );
    }
    return true;
  }

  const libraryView = libraryViewFromSearch(params.search);
  if (libraryView) {
    void params.openLibrary(libraryView);
    return true;
  }

  params.setAppView("chat");
  return true;
}

export function syncSettingsViewPanelAction(params: {
  appView: AppView;
  demoSettingsPanel: (section: SettingsSection, locale: Locale) => CapabilityPanel;
  isConnected: boolean;
  isDemo: boolean;
  locale: Locale;
  refreshSettingsSection: (section: SettingsSection) => void | Promise<void>;
  section: SettingsSection;
  setCapabilityPanel: CapabilityPanelSetter;
}): boolean {
  if (params.appView !== "settings") {
    return false;
  }

  if (params.isConnected) {
    void params.refreshSettingsSection(params.section);
    return true;
  }

  if (params.isDemo) {
    params.setCapabilityPanel(
      params.demoSettingsPanel(params.section, params.locale),
    );
    return true;
  }

  return false;
}
