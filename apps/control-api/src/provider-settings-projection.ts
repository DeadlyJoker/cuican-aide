import type {
  ModelProviderSettingsView,
  ModelProviderProbeResult,
} from "@crewon/application";
import type {
  ModelProviderSettingsSnapshot,
  ProbeModelProviderResponse,
} from "@crewon/contracts";

export type ProviderRuntimeRouteAvailability = "available" | "unavailable";

/** Redacts coordinator/runtime identity while retaining actionable settings. */
export function projectModelProviderSettings(
  view: ModelProviderSettingsView,
  routeAvailability: ProviderRuntimeRouteAvailability,
): ModelProviderSettingsSnapshot {
  const runtimeAvailability =
    view.pending !== null
      ? "switchPending"
      : view.catalog.activeProviderId === null
        ? "unconfigured"
        : routeAvailability;
  return {
    revision: view.catalog.revision,
    activeProviderId: view.catalog.activeProviderId,
    providers: view.catalog.bindings.map((binding) => ({
      providerId: binding.providerId,
      displayName: binding.displayName,
      endpoint: binding.endpoint,
      credentialKind: binding.credentialKind,
      environmentVariable: binding.environmentVariable,
      isActive: binding.providerId === view.catalog.activeProviderId,
    })),
    runtimeAvailability,
    updatedAt: view.catalog.updatedAt,
  };
}

export function projectModelProviderProbe(
  result: ModelProviderProbeResult,
  disposition: "completed" | "replayed",
): ProbeModelProviderResponse {
  return {
    disposition,
    providerId: result.providerId,
    catalogRevision: result.catalogRevision,
    status: result.status,
    models: result.models === null ? null : [...result.models],
    modelCount: result.modelCount,
    latencyMs: result.latencyMs,
    retryable: result.retryable,
    retryAfterMs: result.retryAfterMs,
  };
}
