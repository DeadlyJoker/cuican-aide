import type { PluginUiHostServiceAvailabilityPort } from "@crewon/plugin-host";
import type { DesktopPluginConfiguration } from "./desktop-plugin-configuration.ts";
import type { InstalledPluginTaskRuntimeCore } from "./installed-plugin-task-runtime-core.ts";
import { ProjectMediaInputPluginUiOwner } from "./project-media-input-plugin-ui-owner.ts";

/** The UI publication is explicitly separate from the Native metadata read/write declaration. */
export function composeDesktopProjectMediaInputUi(
  input: Readonly<{
    configuration: DesktopPluginConfiguration;
    core: InstalledPluginTaskRuntimeCore | undefined;
    fallback: PluginUiHostServiceAvailabilityPort | undefined;
  }>,
) {
  const grant =
    input.configuration.schemaVersion === "crewon.desktop-plugin-bootstrap.v3"
      ? input.configuration.projects.mediaInputUi
      : undefined;
  if (grant === undefined) return undefined;
  if (input.core?.projectMediaInputs === undefined)
    throw new Error("desktop_project_media_input_ui_owner_required");
  const owner = new ProjectMediaInputPluginUiOwner({
    configuration: grant,
    runtime: input.core.projectMediaInputs,
  });
  return Object.freeze({
    owner,
    hostUiServices: owner.hostUiServices(input.fallback),
    close: () => owner.close(),
  });
}
