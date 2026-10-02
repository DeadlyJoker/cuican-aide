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
