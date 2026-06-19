import { useRef, useState } from "react";

import type { AppView } from "../shared/appView";
import type { CapabilityPanel } from "../capability/capabilityPanelTypes";
import type { LibraryPanel } from "../domain/crewonDomain";
import type { SettingsSection } from "../settings/settingsCatalog";
import { getInitialAppView, getInitialSettingsSection } from "./appUiState";

export function useAppPanelState() {
  const [appView, setAppView] = useState<AppView>(getInitialAppView);
  const appViewRef = useRef<AppView>(appView);
  const [settingsSection, setSettingsSection] = useState<SettingsSection>(
    getInitialSettingsSection,
  );
  const settingsSectionRef = useRef<SettingsSection>(settingsSection);
  const [libraryPanel, setLibraryPanel] = useState<LibraryPanel | null>(null);
  const libraryPanelRef = useRef<LibraryPanel | null>(libraryPanel);
  const [capabilityPanel, setCapabilityPanel] =
    useState<CapabilityPanel | null>(null);
  const capabilityPanelRef = useRef<CapabilityPanel | null>(capabilityPanel);

  return {
    appView,
    appViewRef,
    capabilityPanel,
    capabilityPanelRef,
    libraryPanel,
    libraryPanelRef,
    setAppView,
    setCapabilityPanel,
    setLibraryPanel,
    setSettingsSection,
    settingsSection,
    settingsSectionRef,
  };
}
