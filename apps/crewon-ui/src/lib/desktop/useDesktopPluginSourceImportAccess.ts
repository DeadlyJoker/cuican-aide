import { useEffect, useState } from "react";
import { getDesktopBridge } from "./desktopBridge";
import {
  DESKTOP_LOCAL_PLUGIN_SOURCE_IMPORT_VERSION,
  type DesktopLocalPluginSourceImportAccess,
} from "./desktopLocalPluginSourceImportProtocol";

/** A query parameter cannot provide the actual isolated Native capability. */
export function useDesktopPluginSourceImportAccess(
  accountKey: string,
): DesktopLocalPluginSourceImportAccess | null {
  const client = getDesktopBridge()?.pluginSourceImports;
  const [generation, setGeneration] = useState(0);
  useEffect(() => {
    if (client?.version !== DESKTOP_LOCAL_PLUGIN_SOURCE_IMPORT_VERSION) return;
    return client.subscribeOwnerChanged(() =>
      setGeneration((value) => value + 1),
    );
  }, [client]);
  if (client?.version !== DESKTOP_LOCAL_PLUGIN_SOURCE_IMPORT_VERSION)
    return null;
  return { client, ownerKey: `${accountKey}:${generation}` };
}
