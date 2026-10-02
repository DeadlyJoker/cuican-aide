// The package descriptor keeps its authoritative source in the intentional contracts entrypoint.
export * from "@crewon/contracts/plugins";
export type {
  PluginJsonValue,
  PluginDisposable,
  PluginIdentity,
  PluginNodeServices,
  PluginNodeContext,
  PluginNodeSetupResult,
  PluginNodeDefinition,
  PluginUiTheme,
  PluginUiProps,
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
