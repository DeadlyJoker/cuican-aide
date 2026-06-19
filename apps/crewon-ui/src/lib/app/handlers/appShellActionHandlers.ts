import type { AppServerClient } from "../../app-server/appServer";
import type { AppView } from "../appRouting";
import {
  changeLocalePreferenceAction,
  syncDesktopPreferenceAction,
  toggleThemePreferenceAction,
} from "../appPreferenceActions";
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
import type { Theme } from "../../theme";

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
  client: AppServerClient | null;
  getLocale: () => Locale;
  isConnected: boolean;
  isDemo: boolean;
  locale: Locale;
  persistLocale: (locale: Locale) => void;
  persistTheme: (theme: Theme) => void;
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
  setLocale: (locale: Locale) => void;
  setNotice: (notice: NoticeState | null) => void;
  setSettingsSection: (section: SettingsSection) => void;
  setTheme: (themeOrUpdater: Theme | ((theme: Theme) => Theme)) => void;
  shouldAutoCloseInspector: (
    sidebarOpen: boolean,
    capabilityDockOpen: boolean,
  ) => boolean;
  sidebarOpen: boolean;
};

export function createAppShellActionHandlers(
  params: AppShellActionHandlersParams,
): AppShellActionHandlers {
  const syncDesktopPreference = (keyPath: string, value: string) => {
    syncDesktopPreferenceAction({
      client: params.client,
      isConnected: params.isConnected,
      keyPath,
      locale: params.getLocale(),
      setNotice: params.setNotice,
      value,
    });
  };

  const refreshSettingsSection = (section: SettingsSection) =>
    refreshSettingsSectionAction(section, params.refreshSettingsHandlers);

  return {
    changeLocale: (nextLocale) => {
      changeLocalePreferenceAction({
        nextLocale,
        persistLocale: params.persistLocale,
        setLocale: params.setLocale,
        syncDesktopPreference,
      });
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
        refreshAccountPanel: params.refreshSettingsHandlers.account,
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
      toggleThemePreferenceAction({
        persistTheme: params.persistTheme,
        setTheme: params.setTheme,
        syncDesktopPreference,
      });
    },
  };
}
