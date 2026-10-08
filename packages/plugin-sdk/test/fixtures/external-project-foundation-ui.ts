import {
  createPluginProjectFoundationClient,
  type PluginProjectFoundationClient,
  type ProjectFoundationUiInputMap,
  type ProjectFoundationUiResponseMap,
} from "@crewon/plugin-sdk/project-foundation-ui";
import type { PluginUiServices } from "@crewon/plugin-sdk/ui";

// The existing actual UI services and native signal must work without a wrapper or transport.
export const createNativeFoundationClient = (
  services: PluginUiServices,
): PluginProjectFoundationClient =>
  createPluginProjectFoundationClient(services);
export const readFoundationWithNativeSignal = (
  client: PluginProjectFoundationClient,
  input: ProjectFoundationUiInputMap["getFoundation"],
  signal: AbortSignal,
): Promise<ProjectFoundationUiResponseMap["getFoundation"]> =>
  client.getFoundation(input, { signal });
