import { ApplicationError } from "@crewon/application";
import type { PluginUiControlService } from "./plugin-control-route.ts";
import type { InstalledPluginRequestOwner } from "./installed-plugin-request-owner.ts";
import type { ProductionCreativeProjectPluginRuntime } from "./production-creative-project-plugin-runtime.ts";
import type { ProductionProjectGenerationReadPluginRuntime } from "./production-project-generation-read-plugin-runtime.ts";
import { parseProjectGenerationUiActionRequest } from "@crewon/contracts/plugins";
import { parseProjectGenerationContextUiActionRequest } from "@crewon/contracts/plugins";
import { parseProjectGenerationQueryUiActionRequest } from "@crewon/contracts/plugins";
import {
  isInstalledPluginProjectQueryOwner,
  type InstalledPluginProjectQueryOwner,
} from "./installed-plugin-project-query-owner.ts";
import {
  isInstalledPluginProjectGenerationOwner,
  type InstalledPluginProjectGenerationOwner,
} from "./installed-plugin-project-generation-owner.ts";

/** Metadata requests stay on their own authority path, including unsupported names. */
export function createProductionPluginUiRequestService({
  ui,
  taskRequests,
  projects,
  projectGenerations,
  projectGenerationReads,
  projectQueries,
}: Readonly<{
  ui: PluginUiControlService;
  taskRequests?: InstalledPluginRequestOwner;
  projects?: ProductionCreativeProjectPluginRuntime;
  projectGenerations?: InstalledPluginProjectGenerationOwner;
  projectGenerationReads?: ProductionProjectGenerationReadPluginRuntime;
  projectQueries?: InstalledPluginProjectQueryOwner;
}>): PluginUiControlService {
  if (
    projectQueries !== undefined &&
    (!isInstalledPluginProjectQueryOwner(projectQueries) ||
      taskRequests === undefined)
  )
    throw new Error("production_plugin_ui_project_query_request_owner_invalid");
  if (
    projectGenerations !== undefined &&
    (!isInstalledPluginProjectGenerationOwner(projectGenerations) ||
      taskRequests === undefined)
  )
    throw new Error("production_plugin_ui_generation_request_owner_invalid");
  if (
    taskRequests === undefined &&
    projects === undefined &&
    projectGenerations === undefined &&
    projectQueries === undefined &&
    projectGenerationReads === undefined
  )
    return ui;
  return Object.freeze({
    ...ui,
    invokeAuthenticatedRequest: (request, actor, command, signal) => {
      const invoke = () => ui.invoke(actor, command);
      if (
        command.action === "crewon.project-generation-queries" ||
        command.action.startsWith("crewon.project-generation-queries.")
      ) {
        if (projectQueries === undefined || taskRequests === undefined)
          throw new ApplicationError(
            "conflict",
            "plugin_ui_actions_unavailable",
          );
        parseProjectGenerationQueryUiActionRequest({
          action: command.action,
          input: command.input,
        });
        return taskRequests.run({ request, actor, signal }, invoke);
      }
      if (
        command.action === "crewon.project-generation-reads" ||
        command.action.startsWith("crewon.project-generation-reads.")
      ) {
        if (projectGenerationReads === undefined)
          throw new ApplicationError(
            "conflict",
            "plugin_ui_actions_unavailable",
          );
        return projectGenerationReads.invokeAuthenticatedRequest(
          request,
          actor,
          command,
          signal,
          invoke,
        );
      }
      if (command.action.startsWith("crewon.project-generations.")) {
        if (projectGenerations === undefined || taskRequests === undefined)
          throw new ApplicationError(
            "conflict",
            "plugin_ui_actions_unavailable",
          );
        parseProjectGenerationUiActionRequest({
          action: command.action,
          input: command.input,
        });
        return taskRequests.run({ request, actor, signal }, invoke);
      }
      if (
        command.action === "crewon.project-generation-contexts" ||
        command.action.startsWith("crewon.project-generation-contexts.")
      ) {
        if (projectGenerations === undefined || taskRequests === undefined)
          throw new ApplicationError(
            "conflict",
            "plugin_ui_actions_unavailable",
          );
        parseProjectGenerationContextUiActionRequest({
          action: command.action,
          input: command.input,
        });
        return taskRequests.run({ request, actor, signal }, async () => {
          await taskRequests.assertCurrent();
          const output = await invoke();
          // A readiness read is ordinary JSON, never a durable paid acknowledgement.
          await taskRequests.assertCurrent();
          return output;
        });
      }
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
