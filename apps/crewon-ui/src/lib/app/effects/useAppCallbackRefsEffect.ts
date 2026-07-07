import { useEffect, type MutableRefObject } from "react";

import type { LibraryKind } from "../../domain/crewonDomain";
import type { SettingsSection } from "../../settings/settingsCatalog";

export type AppCallbackRefsEffectParams = {
  openLibrary: (kind: LibraryKind) => Promise<void>;
  openLibraryRef: MutableRefObject<(kind: LibraryKind) => Promise<void>>;
  openThreadSettingsPanel: () => Promise<void>;
  openThreadSettingsPanelRef: MutableRefObject<() => Promise<void>>;
  refreshSettingsSection: (section: SettingsSection) => Promise<void>;
  refreshSettingsSectionRef: MutableRefObject<
    (section: SettingsSection) => Promise<void>
  >;
};

export function useAppCallbackRefsEffect({
  openLibrary,
  openLibraryRef,
  openThreadSettingsPanel,
  openThreadSettingsPanelRef,
  refreshSettingsSection,
  refreshSettingsSectionRef,
}: AppCallbackRefsEffectParams) {
  useEffect(() => {
    openLibraryRef.current = openLibrary;
    refreshSettingsSectionRef.current = refreshSettingsSection;
    openThreadSettingsPanelRef.current = openThreadSettingsPanel;
  });
}
