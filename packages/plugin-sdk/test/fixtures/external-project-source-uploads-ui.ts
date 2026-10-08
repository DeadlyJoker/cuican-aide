import {
  createPluginProjectSourceUploadsClient,
  type PluginProjectSourceUploadsClient,
  type PluginProjectSourceUploadRawPort,
  type ProjectSourceUploadPartLocator,
  type ProjectSourceUploadMutationResponse,
} from "@crewon/plugin-sdk/project-source-uploads";
import type { PluginUiServices } from "@crewon/plugin-sdk/ui";

// The original UI services are assigned directly, without a second JSON dispatcher.
export const createNativeSourceUploadClient = (
  services: PluginUiServices,
  raw?: PluginProjectSourceUploadRawPort,
): PluginProjectSourceUploadsClient =>
  createPluginProjectSourceUploadsClient(services, {
    raw: raw ?? services.projectSourceUploads,
  });

export const writeSourcePartWithNativeSignal = (
  client: PluginProjectSourceUploadsClient,
  locator: ProjectSourceUploadPartLocator,
  bytes: Uint8Array,
  signal: AbortSignal,
): Promise<ProjectSourceUploadMutationResponse> =>
  client.writePart(locator, bytes, { signal });
