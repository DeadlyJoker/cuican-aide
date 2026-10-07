import {
  CREWON_PROJECT_MEDIA_RESULTS_SERVICE,
  CREWON_PROJECT_MEDIA_RESULT_ACTIONS_SERVICE,
  CREWON_PROJECT_MEDIA_RESULTS_API_VERSION,
} from "@crewon/contracts/project-media-results-ui";
import {
  capturePluginUiHostServiceAvailability,
  type PluginUiHostServiceAvailabilityPort,
} from "./plugin-ui-host-service-availability.ts";
import { preserveProjectGenerationHostAvailability } from "./plugin-project-generation-host-availability.ts";
import { preserveProjectGenerationContextHostAvailability } from "./plugin-project-generation-context-host-availability.ts";
import { preserveProjectGenerationQueryHostAvailability } from "./plugin-project-generation-query-host-availability.ts";
import { preserveProjectHistoricalQueryHostAvailability } from "./plugin-project-historical-query-host-availability.ts";
import { preserveDeferredPluginUiHostServiceAvailability } from "./plugin-ui-deferred-host-service-availability.ts";

/** Protocol availability describes this result owner only, never an Agent/Run permission. */
export function appendProjectMediaResultUiServiceAvailability(
  input: Readonly<{
    mediaResults: PluginUiHostServiceAvailabilityPort;
    fallback?: PluginUiHostServiceAvailabilityPort;
  }>,
): PluginUiHostServiceAvailabilityPort {
  const mediaResults = capturePluginUiHostServiceAvailability(
      input.mediaResults,
    )!,
    fallback = capturePluginUiHostServiceAvailability(input.fallback);
  let result: PluginUiHostServiceAvailabilityPort = Object.freeze({
    isAvailable: (request) =>
      [
        CREWON_PROJECT_MEDIA_RESULTS_SERVICE,
        CREWON_PROJECT_MEDIA_RESULT_ACTIONS_SERVICE,
      ].includes(request.requirement.service)
        ? request.requirement.apiVersion ===
            CREWON_PROJECT_MEDIA_RESULTS_API_VERSION &&
          mediaResults.isAvailable(request)
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
