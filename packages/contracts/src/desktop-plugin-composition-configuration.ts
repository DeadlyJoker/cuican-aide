import { ContractValidationError } from "./contract-validation-error.ts";
import { pluginControlRecord } from "./plugin-control-contract-support.ts";

export const DESKTOP_PLUGIN_COMPOSITION_VERSION =
  "crewon.desktop-plugin-composition.v1";

/** Main's byte-pinned deployment opt-in; it grants no package or execution permission. */
export type DesktopPluginCompositionConfiguration = Readonly<{
  version: typeof DESKTOP_PLUGIN_COMPOSITION_VERSION;
}>;

export function parseDesktopPluginCompositionConfiguration(
  input: unknown,
): DesktopPluginCompositionConfiguration {
  try {
    const value = pluginControlRecord(input, ["version"]);
    if (value.version !== DESKTOP_PLUGIN_COMPOSITION_VERSION) throw new Error();
    return Object.freeze({ version: DESKTOP_PLUGIN_COMPOSITION_VERSION });
  } catch {
    throw new ContractValidationError("desktop_plugin_composition_invalid");
  }
}
