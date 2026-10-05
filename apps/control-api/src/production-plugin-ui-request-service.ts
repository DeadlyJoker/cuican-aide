import type { ProjectConversationControlOwner } from "./project-conversation-control-owner.ts";
import { ApplicationError } from "@crewon/application";
import type { PluginUiControlService } from "./plugin-control-route.ts";
import type { InstalledPluginRequestOwner } from "./installed-plugin-request-owner.ts";
import type { ProductionProjectTextPluginRuntime } from "./production-project-text-plugin-runtime.ts";
import type { ProductionCreativeProjectPluginRuntime } from "./production-creative-project-plugin-runtime.ts";
import type { ProductionProjectGenerationReadPluginRuntime } from "./production-project-generation-read-plugin-runtime.ts";
import type { ProductionProjectGenerationSelectionPluginRuntime } from "./production-project-generation-selection-plugin-runtime.ts";
import { parseProjectGenerationUiActionRequest } from "@crewon/contracts/plugins";
import { parseProjectGenerationContextUiActionRequest } from "@crewon/contracts/plugins";
import { parseProjectGenerationQueryUiActionRequest } from "@crewon/contracts/plugins";
import type { ProductionPluginUiRecoveryRuntime } from "./plugin-ui-recovery-composition.ts";
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
  texts,
  projectGenerations,
  projectGenerationReads,
  projectQueries,
  projectSelections,
  recovery,
  conversations,
}: Readonly<{
  ui: PluginUiControlService;
  taskRequests?: InstalledPluginRequestOwner;
  projects?: ProductionCreativeProjectPluginRuntime;
  texts?: ProductionProjectTextPluginRuntime;
  projectGenerations?: InstalledPluginProjectGenerationOwner;
  projectGenerationReads?: ProductionProjectGenerationReadPluginRuntime;
  projectQueries?: InstalledPluginProjectQueryOwner;
  projectSelections?: ProductionProjectGenerationSelectionPluginRuntime;
  recovery?: ProductionPluginUiRecoveryRuntime;
  conversations?: ProjectConversationControlOwner;
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
    texts === undefined &&
    projectGenerations === undefined &&
    projectQueries === undefined &&
    projectGenerationReads === undefined &&
    projectSelections === undefined &&
    recovery === undefined &&
    conversations === undefined
  )
    return ui;
  return Object.freeze({
    ...ui,
    ...(recovery === undefined
      ? {}
      : { recoveryAuthenticatedRequest: recovery.run }),
    invokeAuthenticatedRequest: (request, actor, command, signal) => {
      const invoke = () =>
        recovery === undefined
          ? ui.invoke(actor, command)
          : recovery.run(request, actor, signal, () =>
              ui.invoke(actor, command),
            );
      if (
        command.action === "crewon.project-conversations" ||
        command.action.startsWith("crewon.project-conversations.")
      ) {
        if (
          conversations === undefined ||
          !conversations.supportsAction(command.action)
        )
          throw new ApplicationError(
            "conflict",
            "project_conversation_unavailable",
          );
        return conversations.runAuthenticatedRequest(
          request,
          actor,
          command.action,
          signal,
          invoke,
        );
      }
      if (
        command.action === "crewon.project-texts" ||
        command.action.startsWith("crewon.project-texts.") ||
        command.action === "crewon.project-text-recovery" ||
        command.action.startsWith("crewon.project-text-recovery.")
      ) {
        if (texts === undefined)
          throw new ApplicationError(
            "conflict",
            "plugin_ui_actions_unavailable",
          );
        return texts.invokeAuthenticatedRequest(
          request,
          actor,
          command,
          signal,
          invoke,
        );
      }
      if (
        command.action === "crewon.project-generation-selections" ||
        command.action.startsWith("crewon.project-generation-selections.")
      ) {
        if (projectSelections === undefined)
          throw new ApplicationError(
            "conflict",
            "plugin_ui_actions_unavailable",
          );
        return projectSelections.invokeAuthenticatedRequest(
          request,
          actor,
          command,
          signal,
          invoke,
        );
      }
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
