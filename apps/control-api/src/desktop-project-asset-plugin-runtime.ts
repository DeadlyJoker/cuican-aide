import {
  ApplicationError,
  type PluginUiActionContext,
} from "@crewon/application";
import type { PluginUiHostServiceAvailabilityPort } from "@crewon/plugin-host";
import type { PreparedCreativeProjects } from "./creative-project-composition.ts";
import type { DesktopPluginAuthority } from "./desktop-plugin-authority.ts";
import type { DesktopPluginInstallationRuntime } from "./desktop-plugin-installation-runtime.ts";
import { createProjectAssetPluginUiRuntime } from "./project-asset-plugin-ui-composition.ts";

/** Metadata uses actual profile ownership and has no execution owner or task preparation side effect. */
export function createDesktopProjectAssetPluginRuntime(
  input: Readonly<{
    projects: PreparedCreativeProjects | undefined;
    authority: DesktopPluginAuthority;
    installation(): DesktopPluginInstallationRuntime | null;
    hostUiServices?: PluginUiHostServiceAvailabilityPort;
  }>,
) {
  if (input.projects?.assetUi === undefined) return undefined;
  if (input.projects.assetService === undefined)
    throw new Error("project_asset_plugin_ui_service_required");
  if (
    input.projects.assetRecovery !== undefined &&
    input.projects.assetRecoveryService === undefined
  )
    throw new Error("project_asset_recovery_service_required");
  const authorization = {
    authorize: async (context: PluginUiActionContext) => {
      input.authority.assertScope(context.actor, context.scope);
      const installation = input.installation();
      if (installation === null)
        throw new ApplicationError("conflict", "plugin_ui_actions_unavailable");
      installation.assertProfileOwnership(context.actor);
    },
  };
  return createProjectAssetPluginUiRuntime({
    configuration: input.projects.assetUi,
    assets: input.projects.assetService,
    hostUiServices: input.hostUiServices,
    authorization,
    ...(input.projects.assetRecovery === undefined
      ? {}
      : {
          recovery: {
            configuration: input.projects.assetRecovery,
            service: input.projects.assetRecoveryService!,
            authorization,
          },
        }),
  });
}
