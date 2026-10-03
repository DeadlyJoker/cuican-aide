import type { PluginUiHostServiceAvailabilityPort } from "./plugin-ui-host-service-availability.ts";

// Only an assembled project-generation bridge may extend the UI-only protocol allowlist.
// This is a Host-owned publication marker, never an invocation permission or a Node service.
const assembled = new WeakSet<object>();

export function registerProjectGenerationHostAvailability(
  port: PluginUiHostServiceAvailabilityPort,
): PluginUiHostServiceAvailabilityPort {
  assembled.add(port);
  return port;
}

export function hasProjectGenerationHostAvailability(
  port: PluginUiHostServiceAvailabilityPort | undefined,
): boolean {
  return port !== undefined && assembled.has(port);
}

export function preserveProjectGenerationHostAvailability(
  original: PluginUiHostServiceAvailabilityPort,
  captured: PluginUiHostServiceAvailabilityPort,
): PluginUiHostServiceAvailabilityPort {
  if (assembled.has(original)) assembled.add(captured);
  return captured;
}
