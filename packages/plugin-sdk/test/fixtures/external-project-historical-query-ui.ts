import {
  createPluginProjectHistoricalQueryClient,
  parseProjectHistoricalQueryUiActionRequest,
  parseProjectHistoricalQueryUiActionResponse,
  type PluginProjectHistoricalQueryClient,
  type ProjectHistoricalQueryAbortSignal,
  type ProjectHistoricalQueryUiInput,
} from "@crewon/plugin-sdk/contracts";
import type { PluginUiServices } from "@crewon/plugin-sdk/ui";

// The actual SDK UI service still accepts the client without an adapter or cast.
export const createNativeHistoricalQueryClient = (
  services: PluginUiServices,
): PluginProjectHistoricalQueryClient =>
  createPluginProjectHistoricalQueryClient(services, {
    parseRequest: parseProjectHistoricalQueryUiActionRequest,
    parseResponse: parseProjectHistoricalQueryUiActionResponse,
  });

export function checkNativeSignalTypes(
  client: PluginProjectHistoricalQueryClient,
  input: ProjectHistoricalQueryUiInput,
): ProjectHistoricalQueryAbortSignal {
  const signal = new AbortController().signal;
  void client.queryConceptGeneration(input, { signal });
  return signal;
}
