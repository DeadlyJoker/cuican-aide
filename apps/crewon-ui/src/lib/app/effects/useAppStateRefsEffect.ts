import { useEffect, type MutableRefObject } from "react";
import type { Thread } from "@crewon-protocol/v2/Thread";

import type { AppView } from "../appRouting";
import type { CapabilityPanel } from "../../capability/capabilityPanelTypes";
import type { LibraryPanel } from "../../domain/crewonDomain";
import type { SettingsSection } from "../../settings/settingsCatalog";

export type AppStateRefsEffectParams = {
  appView: AppView;
  appViewRef: MutableRefObject<AppView>;
  capabilityPanel: CapabilityPanel | null;
  capabilityPanelRef: MutableRefObject<CapabilityPanel | null>;
  libraryPanel: LibraryPanel | null;
  libraryPanelRef: MutableRefObject<LibraryPanel | null>;
  selectedThreadId: string | null;
  selectedThreadIdRef: MutableRefObject<string | null>;
  settingsSection: SettingsSection;
  settingsSectionRef: MutableRefObject<SettingsSection>;
  threads: Thread[];
  threadsRef: MutableRefObject<Thread[]>;
};

export function useAppStateRefsEffect({
  appView,
  appViewRef,
  capabilityPanel,
  capabilityPanelRef,
  libraryPanel,
  libraryPanelRef,
  selectedThreadId,
  selectedThreadIdRef,
  settingsSection,
  settingsSectionRef,
  threads,
  threadsRef,
}: AppStateRefsEffectParams) {
  useEffect(() => {
    threadsRef.current = threads;
  }, [threads, threadsRef]);

  useEffect(() => {
    appViewRef.current = appView;
    settingsSectionRef.current = settingsSection;
    libraryPanelRef.current = libraryPanel;
    capabilityPanelRef.current = capabilityPanel;
  }, [
    appView,
    appViewRef,
    capabilityPanel,
    capabilityPanelRef,
    libraryPanel,
    libraryPanelRef,
    settingsSection,
    settingsSectionRef,
  ]);

  useEffect(() => {
    selectedThreadIdRef.current = selectedThreadId;
  }, [selectedThreadId, selectedThreadIdRef]);
}
