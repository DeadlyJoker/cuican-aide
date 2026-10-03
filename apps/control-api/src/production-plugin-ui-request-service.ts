import { ApplicationError } from "@crewon/application";
import type { PluginUiControlService } from "./plugin-control-route.ts";
import type { InstalledPluginRequestOwner } from "./installed-plugin-request-owner.ts";
import type { ProductionCreativeProjectPluginRuntime } from "./production-creative-project-plugin-runtime.ts";

/** Metadata requests stay on their own authority path, including unsupported names. */
export function createProductionPluginUiRequestService({
  ui,
  taskRequests,
  projects,
}: Readonly<{
  ui: PluginUiControlService;
  taskRequests?: InstalledPluginRequestOwner;
  projects?: ProductionCreativeProjectPluginRuntime;
}>): PluginUiControlService {
  if (taskRequests === undefined && projects === undefined) return ui;
  return Object.freeze({
    ...ui,
    invokeAuthenticatedRequest: (request, actor, command, signal) => {
      const invoke = () => ui.invoke(actor, command);
      if (command.action.startsWith("crewon.creative-projects.")) {
        if (projects === undefined)
          throw new ApplicationError(
            "conflict",
            "plugin_ui_actions_unavailable",
          );
        return projects.invokeAuthenticatedRequest(
          request,
          actor,
          command,
          signal,
          invoke,
        );
      }
      return taskRequests === undefined
        ? invoke()
        : taskRequests.run({ request, actor, signal }, invoke);
    },
  });
}
