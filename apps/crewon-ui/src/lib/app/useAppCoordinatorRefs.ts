import { useRef } from "react";

import type { AppServerClient } from "../app-server/appServer";
import type { LibraryKind } from "../domain/crewonDomain";
import type { SettingsSection } from "../settings/settingsCatalog";

export function useAppCoordinatorRefs() {
  const clientRef = useRef<AppServerClient | null>(null);
  const libraryLoadRequestRef = useRef(0);
  const openLibraryRef = useRef<(kind: LibraryKind) => Promise<void>>(
    async () => undefined,
  );
  const refreshSettingsSectionRef = useRef<
    (section: SettingsSection) => Promise<void>
  >(async () => undefined);
  const openThreadSettingsPanelRef = useRef<() => Promise<void>>(
    async () => undefined,
  );

  return {
    clientRef,
    libraryLoadRequestRef,
    openLibraryRef,
    openThreadSettingsPanelRef,
    refreshSettingsSectionRef,
  };
}
