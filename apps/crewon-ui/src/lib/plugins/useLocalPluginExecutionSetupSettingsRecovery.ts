import { useEffect, useRef } from "react";
import type { DesktopLocalPluginExecutionSetupAccess } from "../desktop/desktopLocalPluginExecutionSetupProtocol";
import { registerLocalPluginExecutionSetupShell } from "./localPluginExecutionSetupRecovery";

/** Return an explicitly submitted setup to Settings after its own physical restart. */
export function useLocalPluginExecutionSetupSettingsRecovery(
  access: DesktopLocalPluginExecutionSetupAccess | null,
  openSettings: () => void,
): void {
  const shell = useRef(Symbol("plugin-execution-setup-shell"));
  const open = useRef(openSettings);
  open.current = openSettings;
  useEffect(() => {
    if (access && registerLocalPluginExecutionSetupShell(access, shell.current))
      open.current();
  }, [access?.client, access?.ownerKey]);
}
