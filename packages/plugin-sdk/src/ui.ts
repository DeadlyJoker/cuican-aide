import {
  definitionFields,
  definitionPluginId,
  fail,
} from "./definition-validation.js";
import type { PluginUiDefinition } from "./ui-types.js";

export { PluginSdkContractError } from "./definition-validation.js";
export type {
  PluginUiDefinition,
  PluginUiInstance,
  PluginUiServices,
  PluginUiInvocationOptions,
} from "./ui-types.js";
export type { PluginUiProps, PluginUiTheme } from "./sdk-types.js";

/** Defines a UI ABI entry. Actual mounting and isolation belong to the host. */
export function defineUiPlugin(
  definition: PluginUiDefinition,
): PluginUiDefinition {
  return parsePluginUiDefinition(definition);
}

export function parsePluginUiDefinition(input: unknown): PluginUiDefinition {
  const value = definitionFields(input, ["apiVersion", "pluginId", "mount"]);
  if (value.apiVersion !== "crewon.plugin-ui.v1")
    fail("plugin_ui_api_unsupported");
  if (typeof value.mount !== "function") fail("plugin_ui_mount_invalid");
  return Object.freeze({
    apiVersion: "crewon.plugin-ui.v1",
    pluginId: definitionPluginId(value.pluginId),
    mount: value.mount as PluginUiDefinition["mount"],
  });
}
