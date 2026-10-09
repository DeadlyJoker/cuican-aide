import { ContractValidationError } from "./contract-validation-error.ts";
import { pluginControlRecord } from "./plugin-control-contract-support.ts";
import { parsePluginUiJsonValue } from "./plugin-ui-json.ts";
import {
  DESKTOP_PROJECT_FOUNDATION_TOOLS_VERSION,
  parseDesktopProjectFoundationToolsConfiguration,
  type DesktopProjectFoundationToolsPublication,
} from "./desktop-project-foundation-tools.ts";

export const DESKTOP_PROJECT_OUTLINE_TOOLS_VERSION =
  "crewon.project-outline-tools.v2";
export type DesktopProjectOutlineToolsPublication =
  DesktopProjectFoundationToolsPublication;
/** Independent installation declaration, not a Foundation, UI or Run permission. */
export type DesktopProjectOutlineToolsConfiguration = Readonly<{
  version: typeof DESKTOP_PROJECT_OUTLINE_TOOLS_VERSION;
  publications: readonly DesktopProjectOutlineToolsPublication[];
}>;
export function parseDesktopProjectOutlineToolsConfiguration(
  input: unknown,
  options: Parameters<
    typeof parseDesktopProjectFoundationToolsConfiguration
  >[1],
): DesktopProjectOutlineToolsConfiguration {
  try {
    const value = pluginControlRecord(
      parsePluginUiJsonValue(input, { maxBytes: 24 * 1024 }),
      ["version", "publications"],
    );
    if (value.version !== DESKTOP_PROJECT_OUTLINE_TOOLS_VERSION)
      throw new Error("outline_declaration_version");
    // Reuse only the exact source/metadata tuple validation. No old declaration is accepted or published.
    const checked = parseDesktopProjectFoundationToolsConfiguration(
      {
        version: DESKTOP_PROJECT_FOUNDATION_TOOLS_VERSION,
        publications: value.publications,
      },
      options,
    );
    return Object.freeze({
      version: DESKTOP_PROJECT_OUTLINE_TOOLS_VERSION,
      publications: checked.publications,
    });
  } catch {
    throw new ContractValidationError(
      "desktop_project_outline_tools_configuration_invalid",
    );
  }
}
