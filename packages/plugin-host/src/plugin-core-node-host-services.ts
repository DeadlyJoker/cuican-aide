import {
  CREWON_TASKS_SERVICE,
  CREWON_TASKS_API_VERSION,
  CREWON_TASKS_V2_API_VERSION,
} from "@crewon/plugin-sdk/node";
import type { PluginCompositionHostService } from "@crewon/contracts/plugins";
import { PluginExecutionRegistry } from "./plugin-execution-registry.ts";
import { PLUGIN_EXECUTION_REGISTRY_COMPOSITION_SERVICE } from "./plugin-execution-composition.ts";
import { PluginTaskActionBridge } from "./plugin-task-action-bridge.ts";
import {
  capturePluginNodeHostServiceCatalog,
  PluginNodeHostServiceCatalogError,
  type PluginNodeHostServiceRegistration,
} from "./plugin-node-host-service-catalog.ts";

/** These identities describe the actual task action bridge, not UI availability. */
export const PLUGIN_TASK_ACTION_BRIDGE_COMPOSITION_SERVICES: readonly PluginCompositionHostService[] =
  Object.freeze(
    [CREWON_TASKS_API_VERSION, CREWON_TASKS_V2_API_VERSION].map((apiVersion) =>
      Object.freeze({
        service: CREWON_TASKS_SERVICE,
        apiVersion,
        implementationId: "crewon.task-action-bridge.v1",
        implementationRevision: 1,
      }),
    ),
  );

/** The registry owner remains responsible for closing itself after the NodeHost. */
export function createPluginExecutionHostServiceRegistration(
  registry: PluginExecutionRegistry,
): PluginNodeHostServiceRegistration {
  if (!PluginExecutionRegistry.isOwner(registry))
    throw new PluginNodeHostServiceCatalogError(
      "plugin_execution_host_service_owner_invalid",
    );
  return capturePluginNodeHostServiceCatalog([
    {
      metadata: PLUGIN_EXECUTION_REGISTRY_COMPOSITION_SERVICE,
      implementation:
        PluginExecutionRegistry.prototype.hostService.call(registry),
    },
  ]).registrations[0]!;
}

/**
 * Both versions use the same real per-instance bridge owner. A catalog entry
 * grants neither an invocation reference nor permission to create/query tasks.
 */
export function createPluginTaskHostServiceRegistrations(
  bridge: PluginTaskActionBridge,
): readonly PluginNodeHostServiceRegistration[] {
  if (!PluginTaskActionBridge.isOwner(bridge))
    throw new PluginNodeHostServiceCatalogError(
      "plugin_tasks_host_service_owner_invalid",
    );
  return capturePluginNodeHostServiceCatalog([
    {
      metadata: PLUGIN_TASK_ACTION_BRIDGE_COMPOSITION_SERVICES[0]!,
      implementation: PluginTaskActionBridge.prototype.hostService.call(bridge),
    },
    {
      metadata: PLUGIN_TASK_ACTION_BRIDGE_COMPOSITION_SERVICES[1]!,
      implementation:
        PluginTaskActionBridge.prototype.hostServiceV2.call(bridge),
    },
  ]).registrations;
}
