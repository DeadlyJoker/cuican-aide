import type {
  CreativeProjectUiAction,
  CreativeProjectUiInputMap,
  CreativeProjectUiResponseMap,
} from "./contracts.js";
import type { PluginUiInvocationOptions } from "./ui-types.js";

/** Metadata requests use the host's existing UI invocation and authorization lifecycle. */
export type PluginCreativeProjectClient = Readonly<{
  [Action in CreativeProjectUiAction as Action extends `crewon.creative-projects.v1.${infer Method}`
    ? Method
    : never]: (
    input: CreativeProjectUiInputMap[Action],
    options?: PluginUiInvocationOptions,
  ) => Promise<CreativeProjectUiResponseMap[Action]>;
}>;
