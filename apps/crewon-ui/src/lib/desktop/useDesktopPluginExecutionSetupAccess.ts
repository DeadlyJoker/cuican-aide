import { useEffect, useState } from "react";
import { getDesktopBridge } from "./desktopBridge";
import {
  DESKTOP_LOCAL_PLUGIN_EXECUTION_SETUP_VERSION,
  type DesktopLocalPluginExecutionSetupAccess,
  type DesktopLocalPluginExecutionSetupClient,
} from "./desktopLocalPluginExecutionSetupProtocol";

type OwnerEpoch = {
  generation: number;
  listeners: Set<() => void>;
  release: (() => void) | null;
};
// Public owner identity survives an App remount. No execution capability or preview is cached here.
const epochs = new WeakMap<
  DesktopLocalPluginExecutionSetupClient,
  OwnerEpoch
>();
function epoch(client: DesktopLocalPluginExecutionSetupClient): OwnerEpoch {
  let value = epochs.get(client);
  if (!value) {
    value = { generation: 0, listeners: new Set(), release: null };
    epochs.set(client, value);
  }
  return value;
}

/** Execution setup is available only through the actual versioned Native client. */
export function useDesktopPluginExecutionSetupAccess(
  accountKey: string,
): DesktopLocalPluginExecutionSetupAccess | null {
  const client = getDesktopBridge()?.pluginExecutionSetup;
  const [, refresh] = useState(0);
  useEffect(() => {
    if (client?.version !== DESKTOP_LOCAL_PLUGIN_EXECUTION_SETUP_VERSION)
      return;
    const current = epoch(client);
    let active = true;
    const notify = () => {
      if (active) refresh((value) => value + 1);
    };
    current.listeners.add(notify);
    if (current.release === null) {
      let listening = true;
      const release = client.subscribeOwnerChanged(() => {
        if (!listening) return;
        current.generation++;
        for (const listener of current.listeners) listener();
      });
      current.release = () => {
        listening = false;
        release();
      };
    }
    return () => {
      active = false;
      current.listeners.delete(notify);
      if (current.listeners.size === 0) {
        const release = current.release;
        current.release = null;
        release?.();
      }
    };
  }, [client]);
  if (client?.version !== DESKTOP_LOCAL_PLUGIN_EXECUTION_SETUP_VERSION)
    return null;
  return { client, ownerKey: `${accountKey}:${epoch(client).generation}` };
}
