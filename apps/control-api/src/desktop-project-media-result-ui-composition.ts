import type { PluginUiHostServiceAvailabilityPort } from "@crewon/plugin-host";
import type { DesktopPluginConfiguration } from "./desktop-plugin-configuration.ts";
import type { InstalledProjectMediaResultRuntime } from "./installed-project-media-result-runtime.ts";
import { ProjectMediaResultPluginUiOwner } from "./project-media-result-plugin-ui-owner.ts";

/** The existing read declaration is exact-package and exact-contribution. No execution grant is inferred. */
export function composeDesktopProjectMediaResultUi(
  input: Readonly<{
    configuration: DesktopPluginConfiguration;
    runtime: InstalledProjectMediaResultRuntime | undefined;
    fallback: PluginUiHostServiceAvailabilityPort | undefined;
  }>,
) {
  const grant =
    input.configuration.schemaVersion === "crewon.desktop-plugin-bootstrap.v3"
      ? input.configuration.projects.mediaResults
      : undefined;
  if (grant === undefined) return undefined;
  if (input.runtime === undefined)
    throw new Error("desktop_project_media_result_ui_owner_required");
  const owner = new ProjectMediaResultPluginUiOwner({
    runtime: input.runtime,
    configuration: { publications: grant.publications },
  });
  return Object.freeze({
    owner,
    hostUiServices: owner.hostUiServices(input.fallback),
    close: () => owner.close(),
  });
}
