import {
  CREWON_PROJECT_FOUNDATION_SERVICE,
  CREWON_PROJECT_FOUNDATION_API_VERSION,
} from "@crewon/contracts/project-foundation";
import {
  CREWON_PROJECT_SOURCE_UPLOAD_SERVICE,
  CREWON_PROJECT_SOURCE_UPLOAD_API_VERSION,
} from "@crewon/contracts/project-source-uploads";
import {
  capturePluginUiHostServiceAvailability,
  type PluginUiHostServiceAvailabilityPort,
} from "./plugin-ui-host-service-availability.ts";
import { preserveProjectGenerationHostAvailability } from "./plugin-project-generation-host-availability.ts";
import { preserveProjectGenerationContextHostAvailability } from "./plugin-project-generation-context-host-availability.ts";
import { preserveProjectGenerationQueryHostAvailability } from "./plugin-project-generation-query-host-availability.ts";
import { preserveProjectHistoricalQueryHostAvailability } from "./plugin-project-historical-query-host-availability.ts";

/** Publishing project metadata neither grants an invocation nor creates a Node execution service. */
export function appendProjectFoundationUiServiceAvailability(
  input: Readonly<{
    foundations: PluginUiHostServiceAvailabilityPort;
    fallback?: PluginUiHostServiceAvailabilityPort;
  }>,
): PluginUiHostServiceAvailabilityPort {
  return appendMetadataAvailability(
    CREWON_PROJECT_FOUNDATION_SERVICE,
    CREWON_PROJECT_FOUNDATION_API_VERSION,
    input.foundations,
    input.fallback,
  );
}

export function appendProjectSourceUploadUiServiceAvailability(
  input: Readonly<{
    uploads: PluginUiHostServiceAvailabilityPort;
    fallback?: PluginUiHostServiceAvailabilityPort;
  }>,
): PluginUiHostServiceAvailabilityPort {
  return appendMetadataAvailability(
    CREWON_PROJECT_SOURCE_UPLOAD_SERVICE,
    CREWON_PROJECT_SOURCE_UPLOAD_API_VERSION,
    input.uploads,
    input.fallback,
  );
}

function appendMetadataAvailability(
  service: string,
  apiVersion: string,
  actual: PluginUiHostServiceAvailabilityPort,
  previous?: PluginUiHostServiceAvailabilityPort,
): PluginUiHostServiceAvailabilityPort {
  const current = capturePluginUiHostServiceAvailability(actual)!;
  const fallback = capturePluginUiHostServiceAvailability(previous);
  let port: PluginUiHostServiceAvailabilityPort = Object.freeze({
    isAvailable: (request) =>
      request.requirement.service === service
        ? request.requirement.apiVersion === apiVersion &&
          current.isAvailable(request)
        : fallback?.isAvailable(request) === true,
  });
  if (fallback !== undefined) {
    port = preserveProjectGenerationHostAvailability(fallback, port);
    port = preserveProjectGenerationContextHostAvailability(fallback, port);
    port = preserveProjectGenerationQueryHostAvailability(fallback, port);
    port = preserveProjectHistoricalQueryHostAvailability(fallback, port);
  }
  return port;
}
