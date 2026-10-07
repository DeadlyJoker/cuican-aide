import {
  capturePluginUiHostServiceAvailability,
  type PluginUiHostServiceAvailabilityPort,
} from "./plugin-ui-host-service-availability.ts";
import { preserveProjectGenerationHostAvailability } from "./plugin-project-generation-host-availability.ts";
import { preserveProjectGenerationContextHostAvailability } from "./plugin-project-generation-context-host-availability.ts";
import { preserveProjectGenerationQueryHostAvailability } from "./plugin-project-generation-query-host-availability.ts";
import { preserveProjectHistoricalQueryHostAvailability } from "./plugin-project-historical-query-host-availability.ts";
import { preserveDeferredPluginUiHostServiceAvailability } from "./plugin-ui-deferred-host-service-availability.ts";

type Input = Readonly<{
  assets: PluginUiHostServiceAvailabilityPort;
  fallback?: PluginUiHostServiceAvailabilityPort;
}>;
export function appendProjectAssetUiServiceAvailability(
  input: Input,
): PluginUiHostServiceAvailabilityPort {
  return append("crewon.project-assets", input);
}
export function appendProjectAssetV2UiServiceAvailability(
  input: Input,
): PluginUiHostServiceAvailabilityPort {
  return append("crewon.project-assets", input, "2");
}
export function appendProjectAssetRecoveryUiServiceAvailability(
  input: Input,
): PluginUiHostServiceAvailabilityPort {
  return append("crewon.project-asset-recovery", input);
}
export function appendProjectAssetRecoveryV2UiServiceAvailability(
  input: Input,
): PluginUiHostServiceAvailabilityPort {
  return append("crewon.project-asset-recovery", input, "2");
}
export function appendProjectAssetStageUiServiceAvailability(
  input: Input,
): PluginUiHostServiceAvailabilityPort {
  return append("crewon.project-asset-stages", input);
}
/** Availability describes an explicit metadata owner; it conveys no Node or execution permission. */
function append(
  service:
    | "crewon.project-assets"
    | "crewon.project-asset-recovery"
    | "crewon.project-asset-stages",
  input: Input,
  apiVersion: "1" | "2" = "1",
) {
  const assets = capturePluginUiHostServiceAvailability(input.assets)!,
    fallback = capturePluginUiHostServiceAvailability(input.fallback);
  let result: PluginUiHostServiceAvailabilityPort = Object.freeze({
    isAvailable: (request) =>
      request.requirement.service === service
        ? request.requirement.apiVersion === apiVersion
          ? assets.isAvailable(request)
          : (service === "crewon.project-assets" ||
              service === "crewon.project-asset-recovery") &&
            ["1", "2"].includes(request.requirement.apiVersion) &&
            fallback?.isAvailable(request) === true
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
