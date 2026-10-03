import type { PluginUiHostServiceAvailabilityPort } from "./plugin-ui-host-service-availability.ts";

// Only an assembled project-generation query bridge may extend the UI-only protocol allowlist.
// This is a Host-owned publication marker, never an invocation permission or a Node service.
const assembled = new WeakSet<object>();

export function registerProjectGenerationQueryHostAvailability(
  port: PluginUiHostServiceAvailabilityPort,
): PluginUiHostServiceAvailabilityPort {
  assembled.add(port);
  return port;
}

export function hasProjectGenerationQueryHostAvailability(
  port: PluginUiHostServiceAvailabilityPort | undefined,
): boolean {
  return port !== undefined && assembled.has(port);
}

export function preserveProjectGenerationQueryHostAvailability(
  original: PluginUiHostServiceAvailabilityPort,
  captured: PluginUiHostServiceAvailabilityPort,
): PluginUiHostServiceAvailabilityPort {
  if (assembled.has(original)) assembled.add(captured);
  return captured;
}
