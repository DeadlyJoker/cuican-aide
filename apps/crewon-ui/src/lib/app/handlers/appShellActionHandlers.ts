import type { AppView } from "../appRouting";
import type { NoticeState } from "../appRuntimeState";
import {
  closeLibraryAction,
  closeSettingsAction,
  openSettingsAction,
  openSettingsSectionAction,
  toggleCapabilityDockAction,
  toggleInspectorAction,
} from "../appViewActions";
import type { CapabilityPanel } from "../../capability/capabilityPanelTypes";
import type { LibraryPanel } from "../../domain/crewonDomain";
import { defaultCapabilityPanel } from "../../capability/capabilityPanelText";
import { demoSettingsPanel } from "../../demo/demoContent";
import type { Locale } from "../../i18n";
import {
  refreshSettingsSectionAction,
  type SettingsSectionRefreshHandlers,
} from "../../settings/settingsActions";
import type { SettingsSection } from "../../settings/settingsCatalog";

type CapabilityPanelSetter = (
  panelOrUpdater:
    | CapabilityPanel
    | null
    | ((panel: CapabilityPanel | null) => CapabilityPanel | null),
) => void;

export type AppShellActionHandlers = {
  changeLocale: (nextLocale: Locale) => void;
  closeLibrary: () => void;
  closeSettings: () => void;
  openSettings: () => void;
  openSettingsSection: (section: SettingsSection) => void;
  refreshSettingsSection: (section: SettingsSection) => Promise<void>;
  toggleCapabilityDock: () => void;
  toggleInspector: () => void;
  toggleTheme: () => void;
};

export type AppShellActionHandlersParams = {
  appView: AppView;
  capabilityDockOpen: boolean;
  capabilityPanel: CapabilityPanel | null;
  commitLocale: (locale: Locale) => void;
  commitThemeToggle: () => void;
  isDemo: boolean;
  locale: Locale;
  refreshSettingsHandlers: SettingsSectionRefreshHandlers;
  setAppView: (view: AppView) => void;
  setCapabilityDockOpen: (
    openOrUpdater: boolean | ((open: boolean) => boolean),
  ) => void;
  setCapabilityPanel: CapabilityPanelSetter;
  setInspectorOpen: (
    openOrUpdater: boolean | ((open: boolean) => boolean),
  ) => void;
  setLibraryPanel: (
    panelOrUpdater:
      | LibraryPanel
      | null
      | ((panel: LibraryPanel | null) => LibraryPanel | null),
  ) => void;
  setNotice: (notice: NoticeState | null) => void;
  setSettingsSection: (section: SettingsSection) => void;
  shouldAutoCloseInspector: (
    sidebarOpen: boolean,
    capabilityDockOpen: boolean,
  ) => boolean;
  sidebarOpen: boolean;
};

export function createAppShellActionHandlers(
  params: AppShellActionHandlersParams,
): AppShellActionHandlers {
  const refreshSettingsSection = (section: SettingsSection) =>
    refreshSettingsSectionAction(section, params.refreshSettingsHandlers);

  return {
    changeLocale: (nextLocale) => {
      params.commitLocale(nextLocale);
    },
    closeLibrary: () => {
      closeLibraryAction({
        setAppView: params.setAppView,
        setLibraryPanel: params.setLibraryPanel,
      });
    },
    closeSettings: () => {
      closeSettingsAction({
        setAppView: params.setAppView,
        setCapabilityPanel: params.setCapabilityPanel,
      });
    },
    openSettings: () => {
      openSettingsAction({
        demoSettingsPanel,
        isDemo: params.isDemo,
        locale: params.locale,
        refreshDefaultSettingsPanel: params.refreshSettingsHandlers.appearance,
        setAppView: params.setAppView,
        setCapabilityDockOpen: params.setCapabilityDockOpen,
        setCapabilityPanel: params.setCapabilityPanel,
        setInspectorOpen: params.setInspectorOpen,
        setSettingsSection: params.setSettingsSection,
      });
    },
    openSettingsSection: (section) => {
      openSettingsSectionAction({
        demoSettingsPanel,
        isDemo: params.isDemo,
        locale: params.locale,
        refreshSettingsSection,
        section,
        setCapabilityPanel: params.setCapabilityPanel,
        setSettingsSection: params.setSettingsSection,
      });
    },
    refreshSettingsSection,
    toggleCapabilityDock: () => {
      toggleCapabilityDockAction({
        appView: params.appView,
        capabilityDockOpen: params.capabilityDockOpen,
        capabilityPanel: params.capabilityPanel,
        defaultCapabilityPanel,
        locale: params.locale,
        setAppView: params.setAppView,
        setCapabilityDockOpen: params.setCapabilityDockOpen,
        setCapabilityPanel: params.setCapabilityPanel,
      });
    },
    toggleInspector: () => {
      toggleInspectorAction({
        capabilityDockOpen: params.capabilityDockOpen,
        setInspectorOpen: params.setInspectorOpen,
        shouldAutoCloseInspector: params.shouldAutoCloseInspector,
        sidebarOpen: params.sidebarOpen,
      });
    },
    toggleTheme: () => {
      params.commitThemeToggle();
    },
  };
}
