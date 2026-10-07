import { CREWON_PROJECT_MEDIA_GENERATIONS_SERVICE } from "@crewon/contracts/project-media-generations";
import {
  capturePluginUiHostServiceAvailability,
  type PluginUiHostServiceAvailabilityPort,
} from "./plugin-ui-host-service-availability.ts";
import { preserveProjectGenerationHostAvailability } from "./plugin-project-generation-host-availability.ts";
import { preserveProjectGenerationContextHostAvailability } from "./plugin-project-generation-context-host-availability.ts";
import { preserveProjectGenerationQueryHostAvailability } from "./plugin-project-generation-query-host-availability.ts";
import { preserveProjectHistoricalQueryHostAvailability } from "./plugin-project-historical-query-host-availability.ts";
import { preserveDeferredPluginUiHostServiceAvailability } from "./plugin-ui-deferred-host-service-availability.ts";

/** Availability is limited to the independently approved generation publication. */
export function appendProjectMediaGenerationUiServiceAvailability(
  input: Readonly<{
    mediaGenerations: PluginUiHostServiceAvailabilityPort;
    fallback?: PluginUiHostServiceAvailabilityPort;
  }>,
): PluginUiHostServiceAvailabilityPort {
  const mediaGenerations = capturePluginUiHostServiceAvailability(
      input.mediaGenerations,
    )!,
    fallback = capturePluginUiHostServiceAvailability(input.fallback);
  let result: PluginUiHostServiceAvailabilityPort = Object.freeze({
    isAvailable: (request) =>
      request.requirement.service === CREWON_PROJECT_MEDIA_GENERATIONS_SERVICE
        ? (request.requirement.apiVersion === "1" ||
            request.requirement.apiVersion === "2") &&
          mediaGenerations.isAvailable(request)
        : fallback?.isAvailable(request) === true,
  });
  if (fallback !== undefined) {
    result = preserveProjectGenerationHostAvailability(fallback, result);
    result = preserveProjectGenerationContextHostAvailability(fallback, result);
    result = preserveProjectGenerationQueryHostAvailability(fallback, result);
    result = preserveProjectHistoricalQueryHostAvailability(fallback, result);
    result = preserveDeferredPluginUiHostServiceAvailability(fallback, result);
  }
  return result;
}
