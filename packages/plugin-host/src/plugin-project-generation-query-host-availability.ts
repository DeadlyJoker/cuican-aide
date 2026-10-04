import type { PluginUiHostServiceAvailabilityPort } from "./plugin-ui-host-service-availability.ts";
import { hasDeferredPluginUiHostServiceAvailabilityBrand } from "./plugin-ui-deferred-host-service-availability.ts";

// Only an assembled project-generation query bridge may extend the UI-only protocol allowlist.
// This is a Host-owned publication marker, never an invocation permission or a Node service.
const assembled = new WeakSet<object>();
const preserved = new WeakMap<object, PluginUiHostServiceAvailabilityPort>();

export function registerProjectGenerationQueryHostAvailability(
  port: PluginUiHostServiceAvailabilityPort,
): PluginUiHostServiceAvailabilityPort {
  assembled.add(port);
  return port;
}

export function hasProjectGenerationQueryHostAvailability(
  port: PluginUiHostServiceAvailabilityPort | undefined,
): boolean {
  return hasDeferredPluginUiHostServiceAvailabilityBrand(
    port,
    assembled,
    preserved,
  );
}

export function preserveProjectGenerationQueryHostAvailability(
  original: PluginUiHostServiceAvailabilityPort,
  captured: PluginUiHostServiceAvailabilityPort,
): PluginUiHostServiceAvailabilityPort {
  if (assembled.has(original)) assembled.add(captured);
  else preserved.set(captured, original);
  return captured;
}
