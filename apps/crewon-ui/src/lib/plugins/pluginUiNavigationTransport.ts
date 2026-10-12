import {
  PLUGIN_UI_NAVIGATION_SERVICE,
  PLUGIN_UI_NAVIGATION_API_VERSION,
  parsePluginUiNavigationRequest,
  type PluginUiNavigationRequest,
  type PluginUiLease,
  type PluginUiJsonValue,
} from "@crewon/contracts/plugins";
import { PluginUiLoaderError } from "./pluginUiValidation";
export type PluginUiNavigationHandler = (
  lease: PluginUiLease,
  request: PluginUiNavigationRequest,
  signal: AbortSignal,
) => Promise<PluginUiJsonValue>;
/** Called inside the original authenticated lease lifecycle. A UI hint never supplies identity. */
export function invokePluginUiNavigation(
  lease: PluginUiLease,
  input: Readonly<{
    action: string;
    input: PluginUiJsonValue;
    signal: AbortSignal;
  }>,
  handler: PluginUiNavigationHandler | undefined,
): Promise<PluginUiJsonValue> {
  input.signal.throwIfAborted();
  if (
    !handler ||
    !lease.descriptor.requires.some(
      (requirement) =>
        requirement.service === PLUGIN_UI_NAVIGATION_SERVICE &&
        requirement.apiVersion === PLUGIN_UI_NAVIGATION_API_VERSION,
    )
  )
    throw new PluginUiLoaderError("plugin_ui_navigation_unavailable");
  return handler(
    lease,
    parsePluginUiNavigationRequest(input.action, input.input),
    input.signal,
  );
}
