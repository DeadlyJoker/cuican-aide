import { useEffect, useRef } from "react";

import type { AppView } from "../appRouting";
import {
  legacyOfficeCommandShellUrl,
  libraryViewFromSearch,
} from "../appRouting";
import {
  syncSettingsViewPanelAction,
  syncViewFromSearchAction,
} from "../appViewActions";
import type { CapabilityPanel } from "../../capability/capabilityPanelTypes";
import type { LibraryKind } from "../../domain/crewonDomain";
import type { Locale } from "../../i18n";
import type { ConnectionState } from "../../shared/connectionState";
import type { SettingsSection } from "../../settings/settingsCatalog";

export type AppViewSyncEffectsParams = {
  appView: AppView;
  connectionState: ConnectionState;
  demoSettingsPanel: (
    section: SettingsSection,
    locale: Locale,
  ) => CapabilityPanel;
  isConnected: boolean;
  isDemo: boolean;
  isDemoPreview: boolean;
  locale: Locale;
  openLibrary: (kind: LibraryKind) => void | Promise<void>;
  refreshSettingsSection: (section: SettingsSection) => void | Promise<void>;
  settingsSection: SettingsSection;
  setAppView: (view: AppView) => void;
  setCapabilityPanel: (panel: CapabilityPanel | null) => void;
  setSettingsSection: (section: SettingsSection) => void;
};

export function useAppViewSyncEffects({
  appView,
  connectionState,
  demoSettingsPanel,
  isConnected,
  isDemo,
  isDemoPreview,
  locale,
  openLibrary,
  refreshSettingsSection,
  settingsSection,
  setAppView,
  setCapabilityPanel,
  setSettingsSection,
}: AppViewSyncEffectsParams) {
  const initialLibraryViewRef = useRef<LibraryKind | null>(
    libraryViewFromSearch(window.location.search),
  );
  const initialLibraryViewOpenedRef = useRef(false);
  const lastSyncedViewSearchRef = useRef("");

  useEffect(() => {
    const initialLibraryView = initialLibraryViewRef.current;
    if (
      !initialLibraryView ||
      initialLibraryViewOpenedRef.current ||
      (connectionState === "connecting" && !isDemoPreview)
    ) {
      return;
    }

    initialLibraryViewOpenedRef.current = true;
    void openLibrary(initialLibraryView);
  }, [connectionState, isDemoPreview]);

  useEffect(() => {
    const syncViewFromUrl = () => {
      const legacyOfficeUrl = legacyOfficeCommandShellUrl(window.location.href);
      if (legacyOfficeUrl) {
        window.history.replaceState(null, "", legacyOfficeUrl);
        window.dispatchEvent(new Event("hashchange"));
      }
      const search = window.location.search;
      syncViewFromSearchAction({
        demoSettingsPanel,
        isConnected,
        isDemo,
        lastSyncedSearch: lastSyncedViewSearchRef.current,
        locale,
        openLibrary,
        refreshSettingsSection,
        search,
        setAppView,
        setCapabilityPanel,
        setLastSyncedSearch: (nextSearch) => {
          lastSyncedViewSearchRef.current = nextSearch;
        },
        setSettingsSection,
      });
    };

    syncViewFromUrl();
    const intervalId = window.setInterval(syncViewFromUrl, 500);
    window.addEventListener("popstate", syncViewFromUrl);
    return () => {
      window.clearInterval(intervalId);
      window.removeEventListener("popstate", syncViewFromUrl);
    };
  }, [connectionState, isConnected, isDemo, locale]);

  useEffect(() => {
    syncSettingsViewPanelAction({
      appView,
      demoSettingsPanel,
      isConnected,
      isDemo,
      locale,
      refreshSettingsSection,
      section: settingsSection,
      setCapabilityPanel,
    });
  }, [appView, isConnected, isDemo, locale, settingsSection]);
}
