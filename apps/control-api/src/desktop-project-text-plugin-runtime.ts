import {
  ApplicationError,
  type PluginUiActionContext,
} from "@crewon/application";
import type { PluginUiHostServiceAvailabilityPort } from "@crewon/plugin-host";
import type { PreparedCreativeProjects } from "./creative-project-composition.ts";
import type { DesktopPluginAuthority } from "./desktop-plugin-authority.ts";
import type { DesktopPluginInstallationRuntime } from "./desktop-plugin-installation-runtime.ts";
import { createProjectTextPluginUiRuntime } from "./project-text-plugin-ui-composition.ts";

/** Native metadata uses the existing profile owner and never prepares a Node execution lane. */
export function createDesktopProjectTextPluginRuntime(
  input: Readonly<{
    projects: PreparedCreativeProjects | undefined;
    authority: DesktopPluginAuthority;
    installation(): DesktopPluginInstallationRuntime | null;
    hostUiServices?: PluginUiHostServiceAvailabilityPort;
  }>,
) {
  const projects = input.projects;
  if (projects?.textUi === undefined) return undefined;
  if (projects.textService === undefined)
    throw new Error("project_text_plugin_ui_service_required");
  if (
    projects.textRecovery !== undefined &&
    projects.textRecoveryService === undefined
  )
    throw new Error("project_text_recovery_service_required");
  const authorization = {
    authorize: async (context: PluginUiActionContext) => {
      input.authority.assertScope(context.actor, context.scope);
      const installation = input.installation();
      if (installation === null)
        throw new ApplicationError("conflict", "plugin_ui_actions_unavailable");
      installation.assertProfileOwnership(context.actor);
    },
  };
  return createProjectTextPluginUiRuntime({
    configuration: projects.textUi,
    texts: projects.textService,
    ...(projects.structuredOutlineService === undefined
      ? {}
      : { outlines: projects.structuredOutlineService }),
    authorization,
    ...(input.hostUiServices === undefined
      ? {}
      : { hostUiServices: input.hostUiServices }),
    ...(projects.textRecovery === undefined
      ? {}
      : {
          recovery: {
            configuration: projects.textRecovery,
            service: projects.textRecoveryService!,
            authorization,
          },
        }),
  });
}
