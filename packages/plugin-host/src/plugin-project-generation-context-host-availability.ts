import type { PluginUiHostServiceAvailabilityPort } from "./plugin-ui-host-service-availability.ts";

// Host-owned assembly marker only. It grants neither invocation nor generation authority.
const assembled = new WeakSet<object>();

export function registerProjectGenerationContextHostAvailability(
  port: PluginUiHostServiceAvailabilityPort,
): PluginUiHostServiceAvailabilityPort {
  assembled.add(port);
  return port;
}

export function hasProjectGenerationContextHostAvailability(
  port: PluginUiHostServiceAvailabilityPort | undefined,
): boolean {
  return port !== undefined && assembled.has(port);
}

export function preserveProjectGenerationContextHostAvailability(
  original: PluginUiHostServiceAvailabilityPort,
  captured: PluginUiHostServiceAvailabilityPort,
): PluginUiHostServiceAvailabilityPort {
  if (assembled.has(original)) assembled.add(captured);
  return captured;
}
