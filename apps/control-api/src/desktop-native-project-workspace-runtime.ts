import type { PluginProjectWorkspacePreparation } from "@crewon/application";
import type { DesktopPluginConfiguration } from "./desktop-plugin-configuration.ts";
import {
  assertDesktopNativePluginControlComposition,
  assertDesktopNativePluginControlConfigCurrent,
  type DesktopNativePluginControlConfig,
} from "./desktop-native-plugin-control-environment.ts";
import { DesktopNativeProjectWorkspaceClient } from "./desktop-native-project-workspace-client.ts";

/** Explicit original Native/owned configuration only. Legacy, remote and non-plugin startup do not acquire IPC ownership. */
export function createDesktopNativeProjectWorkspaceRuntime(
  input: Readonly<{
    configuration: DesktopPluginConfiguration;
    nativeControl: DesktopNativePluginControlConfig | undefined;
  }>,
) {
  if (
    input.configuration.schemaVersion ===
      "crewon.desktop-plugin-bootstrap.v1" ||
    input.configuration.projects.conversations?.projectOwnership !==
      "plugin-project-v1"
  )
    return undefined;
  if (input.nativeControl === undefined) return undefined;
  const nativeControl = input.nativeControl;
  assertDesktopNativePluginControlComposition({
    configuration: input.configuration,
    nativeControl,
  });
  const lifetime = new AbortController();
  const client = new DesktopNativeProjectWorkspaceClient({
    signal: lifetime.signal,
  });
  let closing: Promise<void> | undefined;
  return Object.freeze({
    async observe(preparation: PluginProjectWorkspacePreparation) {
      assertDesktopNativePluginControlConfigCurrent(nativeControl);
      lifetime.signal.throwIfAborted();
      const observation = await client.observePreparedProject(
        preparation,
        lifetime.signal,
      );
      assertDesktopNativePluginControlConfigCurrent(nativeControl);
      lifetime.signal.throwIfAborted();
      return observation;
    },
    close(): Promise<void> {
      lifetime.abort();
      return (closing ??= client.close());
    },
  });
}
