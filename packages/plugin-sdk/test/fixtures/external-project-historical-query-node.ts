import {
  createPluginProjectHistoricalQueryClient,
  parseProjectHistoricalQueryUiActionRequest,
  parseProjectHistoricalQueryUiActionResponse,
  type PluginProjectHistoricalQueryClient,
  type ProjectHistoricalQueryAbortSignal,
  type ProjectHistoricalQueryUiInput,
  type ProjectHistoricalQueryUiServices,
} from "@crewon/plugin-sdk/contracts";
import type { PluginAbortSignal } from "@crewon/plugin-sdk/node";

// This entire public declaration closure must compile with ES2022 and types: [].
export const createHistoricalQueryClient = (
  services: ProjectHistoricalQueryUiServices,
): PluginProjectHistoricalQueryClient =>
  createPluginProjectHistoricalQueryClient(services, {
    parseRequest: parseProjectHistoricalQueryUiActionRequest,
    parseResponse: parseProjectHistoricalQueryUiActionResponse,
  });

export function checkPortableTypes(
  client: PluginProjectHistoricalQueryClient,
  input: ProjectHistoricalQueryUiInput,
  signal: PluginAbortSignal,
): ProjectHistoricalQueryAbortSignal {
  void client.queryConceptGeneration(input, { signal });
  // @ts-expect-error A caller cannot select a historical execution target.
  void client.queryConceptGeneration({ ...input, target: "other" });
  return signal;
}
