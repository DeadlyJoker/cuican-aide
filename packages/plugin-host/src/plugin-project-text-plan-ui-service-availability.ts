import {
  CREWON_PROJECT_TEXT_PLANS_SERVICE,
  CREWON_PROJECT_TEXT_PLANS_API_VERSION,
} from "@crewon/contracts/project-text-plans";
import {
  capturePluginUiHostServiceAvailability,
  type PluginUiHostServiceAvailabilityPort,
} from "./plugin-ui-host-service-availability.ts";
import { preserveProjectGenerationHostAvailability } from "./plugin-project-generation-host-availability.ts";
import { preserveProjectGenerationContextHostAvailability } from "./plugin-project-generation-context-host-availability.ts";
import { preserveProjectGenerationQueryHostAvailability } from "./plugin-project-generation-query-host-availability.ts";

/** Availability declares only this UI protocol; it does not authorize a background Run. */
export function appendProjectTextPlanUiServiceAvailability(
  input: Readonly<{
    plans: PluginUiHostServiceAvailabilityPort;
    fallback?: PluginUiHostServiceAvailabilityPort;
  }>,
): PluginUiHostServiceAvailabilityPort {
  const plans = capturePluginUiHostServiceAvailability(input.plans)!;
  const fallback = capturePluginUiHostServiceAvailability(input.fallback);
  let port: PluginUiHostServiceAvailabilityPort = Object.freeze({
    isAvailable: (request) =>
      request.requirement.service === CREWON_PROJECT_TEXT_PLANS_SERVICE
        ? request.requirement.apiVersion ===
            CREWON_PROJECT_TEXT_PLANS_API_VERSION && plans.isAvailable(request)
        : fallback?.isAvailable(request) === true,
  });
  if (fallback !== undefined) {
    port = preserveProjectGenerationHostAvailability(fallback, port);
    port = preserveProjectGenerationContextHostAvailability(fallback, port);
    port = preserveProjectGenerationQueryHostAvailability(fallback, port);
  }
  return port;
}
