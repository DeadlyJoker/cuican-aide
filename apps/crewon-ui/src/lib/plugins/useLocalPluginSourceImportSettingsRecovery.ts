import { useEffect, useRef } from "react";
import type { DesktopLocalPluginSourceImportAccess } from "../desktop/desktopLocalPluginSourceImportProtocol";
import type { SettingsSection } from "../settings/settingsCatalog";
import { registerLocalPluginSourceImportShell } from "./localPluginSourceImportRecovery";

/** Return only an explicitly submitted import to its original Settings route after
 * a real App remount. This does not preserve or supply local management access. */
export function useLocalPluginSourceImportSettingsRecovery(
  access: DesktopLocalPluginSourceImportAccess | null,
  openSection: (section: SettingsSection) => void,
): void {
  const shell = useRef(Symbol("plugin-source-import-shell"));
  const open = useRef(openSection);
  open.current = openSection;
  useEffect(() => {
    if (access && registerLocalPluginSourceImportShell(access, shell.current))
      open.current("mcp-servers");
  }, [access?.client, access?.ownerKey]);
}
