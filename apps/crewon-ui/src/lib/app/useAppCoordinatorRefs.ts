import { useRef } from "react";

import type { LibraryKind } from "../domain/crewonDomain";
import type { SettingsSection } from "../settings/settingsCatalog";

export function useAppCoordinatorRefs() {
  const libraryLoadRequestRef = useRef(0);
  const openLibraryRef = useRef<(kind: LibraryKind) => Promise<void>>(
    async () => undefined,
  );
  const refreshSettingsSectionRef = useRef<
    (section: SettingsSection) => Promise<void>
  >(async () => undefined);
  return {
    libraryLoadRequestRef,
    openLibraryRef,
    refreshSettingsSectionRef,
  };
}
