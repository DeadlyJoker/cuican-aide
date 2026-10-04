import type { PluginUiHostServiceAvailabilityPort } from "./plugin-ui-host-service-availability.ts";
import { hasDeferredPluginUiHostServiceAvailabilityBrand } from "./plugin-ui-deferred-host-service-availability.ts";

// Host-owned assembly marker only. It grants neither invocation nor generation authority.
const assembled = new WeakSet<object>();
const preserved = new WeakMap<object, PluginUiHostServiceAvailabilityPort>();

export function registerProjectGenerationContextHostAvailability(
  port: PluginUiHostServiceAvailabilityPort,
): PluginUiHostServiceAvailabilityPort {
  assembled.add(port);
  return port;
}

export function hasProjectGenerationContextHostAvailability(
  port: PluginUiHostServiceAvailabilityPort | undefined,
): boolean {
  return hasDeferredPluginUiHostServiceAvailabilityBrand(
    port,
    assembled,
    preserved,
  );
}

export function preserveProjectGenerationContextHostAvailability(
  original: PluginUiHostServiceAvailabilityPort,
  captured: PluginUiHostServiceAvailabilityPort,
): PluginUiHostServiceAvailabilityPort {
  if (assembled.has(original)) assembled.add(captured);
  else preserved.set(captured, original);
  return captured;
}
