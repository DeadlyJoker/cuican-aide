import {
  definitionFields,
  definitionPluginId,
  fail,
} from "./definition-validation.js";
import type { PluginNodeDefinition } from "./sdk-types.js";

export { PluginSdkContractError } from "./definition-validation.js";
export type {
  PluginDisposable,
  PluginIdentity,
  PluginNodeContext,
  PluginNodeServices,
  PluginNodeSetupResult,
  PluginNodeDefinition,
} from "./sdk-types.js";
export {
  CREWON_TASKS_SERVICE,
  CREWON_TASKS_API_VERSION,
  CREWON_TASKS_V2_API_VERSION,
  type PluginQueryTaskRequest,
  type PluginTaskServiceV2,
  type PluginTaskRequest,
  type PluginTaskReceipt,
  type PluginTaskService,
  type PluginActionDeclaration,
  type PluginActionInvocation,
  type PluginActionsService,
} from "./task-action-types.js";
export * from "./execution-types.js";
export * from "./execution-io-types.js";
export type * from "./tool-runtime-types.js";

/** Defines a Node ABI entry; it neither invokes setup nor resolves declared services. */
export function definePlugin(
  definition: PluginNodeDefinition,
): PluginNodeDefinition {
  return parsePluginNodeDefinition(definition);
}

/** Host-side structural validation for an imported entry before setup is called. */
export function parsePluginNodeDefinition(
  input: unknown,
): PluginNodeDefinition {
  const value = definitionFields(input, ["apiVersion", "pluginId", "setup"]);
  if (value.apiVersion !== "crewon.plugin-host.v1")
    fail("plugin_node_api_unsupported");
  if (typeof value.setup !== "function") fail("plugin_node_setup_invalid");
  return Object.freeze({
    apiVersion: "crewon.plugin-host.v1",
    pluginId: definitionPluginId(value.pluginId),
    setup: value.setup as PluginNodeDefinition["setup"],
  });
}
