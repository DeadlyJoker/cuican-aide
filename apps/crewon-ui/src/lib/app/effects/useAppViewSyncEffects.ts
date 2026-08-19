import { useEffect, useRef } from "react";

import type { AppView } from "../appRouting";
import { libraryViewFromSearch } from "../appRouting";
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
  isConnected: boolean;
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
  isConnected,
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
      connectionState === "connecting"
    ) {
      return;
    }

    initialLibraryViewOpenedRef.current = true;
    void openLibrary(initialLibraryView);
  }, [connectionState]);

  useEffect(() => {
    const syncViewFromUrl = () => {
      const search = window.location.search;
      syncViewFromSearchAction({
        isConnected,
        lastSyncedSearch: lastSyncedViewSearchRef.current,
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
  }, [connectionState, isConnected]);

  useEffect(() => {
    syncSettingsViewPanelAction({
      appView,
      isConnected,
      refreshSettingsSection,
      section: settingsSection,
      setCapabilityPanel,
    });
  }, [appView, isConnected, settingsSection]);
}
