import type { ProductionProjectSourceUploadPluginRuntime } from "./production-project-source-upload-plugin-runtime.ts";
import { isProjectConversationUiNamespaceAction } from "@crewon/contracts/project-conversation-association";
import type { ProjectAssetStageControlOwner } from "./project-asset-stage-control-owner.ts";
import type { ProductionProjectAssetPluginRuntime } from "./production-project-asset-plugin-runtime.ts";
import { parseProjectHistoricalQueryUiActionRequest } from "@crewon/contracts/plugins";
import {
  isInstalledPluginProjectHistoricalQueryOwner,
  type InstalledPluginProjectHistoricalQueryOwner,
} from "./installed-plugin-project-historical-query-owner.ts";
import type { ProjectConversationControlOwner } from "./project-conversation-control-owner.ts";
import type { ProjectTextPlanPluginUiRuntime } from "./project-text-plan-plugin-ui-composition.ts";
import { ApplicationError } from "@crewon/application";
import type { PluginUiControlService } from "./plugin-control-route.ts";
import type { InstalledPluginRequestOwner } from "./installed-plugin-request-owner.ts";
import type { ProductionProjectTextPluginRuntime } from "./production-project-text-plugin-runtime.ts";
import type { ProductionCreativeProjectPluginRuntime } from "./production-creative-project-plugin-runtime.ts";
import type { ProductionProjectFoundationPluginRuntime } from "./production-project-foundation-plugin-runtime.ts";
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
  foundations,
  sourceUploads,
  texts,
  assets,
  assetStages,
  projectGenerations,
  projectGenerationReads,
  projectQueries,
  historicalQueries,
  projectSelections,
  recovery,
  conversations,
  plans,
}: Readonly<{
  ui: PluginUiControlService;
  taskRequests?: InstalledPluginRequestOwner;
  projects?: ProductionCreativeProjectPluginRuntime;
  foundations?: ProductionProjectFoundationPluginRuntime;
  sourceUploads?: ProductionProjectSourceUploadPluginRuntime;
  texts?: ProductionProjectTextPluginRuntime;
  assets?: ProductionProjectAssetPluginRuntime;
  assetStages?: ProjectAssetStageControlOwner;
  projectGenerations?: InstalledPluginProjectGenerationOwner;
  projectGenerationReads?: ProductionProjectGenerationReadPluginRuntime;
  projectQueries?: InstalledPluginProjectQueryOwner;
  historicalQueries?: InstalledPluginProjectHistoricalQueryOwner;
  projectSelections?: ProductionProjectGenerationSelectionPluginRuntime;
  recovery?: ProductionPluginUiRecoveryRuntime;
  conversations?: ProjectConversationControlOwner;
  plans?: ProjectTextPlanPluginUiRuntime;
}>): PluginUiControlService {
  if (
    historicalQueries !== undefined &&
    (!isInstalledPluginProjectHistoricalQueryOwner(historicalQueries) ||
      taskRequests === undefined)
  )
    throw new Error(
      "production_plugin_ui_historical_query_request_owner_invalid",
    );
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
    foundations === undefined &&
    sourceUploads === undefined &&
    texts === undefined &&
    assets === undefined &&
    assetStages === undefined &&
    projectGenerations === undefined &&
    projectQueries === undefined &&
    historicalQueries === undefined &&
    projectGenerationReads === undefined &&
    projectSelections === undefined &&
    recovery === undefined &&
    conversations === undefined &&
    plans === undefined
  )
    return ui;
  return Object.freeze({
    ...ui,
    ...(sourceUploads === undefined ||
    ui.invokeProjectSourceUploadPart === undefined
      ? {}
      : {
          invokeProjectSourceUploadPartAuthenticatedRequest: (
            request: Parameters<
              NonNullable<
                PluginUiControlService["invokeProjectSourceUploadPartAuthenticatedRequest"]
              >
            >[0],
            actor: Parameters<
              NonNullable<
                PluginUiControlService["invokeProjectSourceUploadPartAuthenticatedRequest"]
              >
            >[1],
            command: Parameters<
              NonNullable<
                PluginUiControlService["invokeProjectSourceUploadPartAuthenticatedRequest"]
              >
            >[2],
            bytes: Uint8Array,
            signal: AbortSignal,
          ) =>
            sourceUploads.invokeAuthenticatedPartRequest(
              request,
              actor,
              command.locator,
              signal,
              () =>
                ui.invokeProjectSourceUploadPart!(actor, command, bytes, {
                  signal,
                }),
            ),
        }),
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
        command.action === "crewon.project-source-uploads" ||
        command.action.startsWith("crewon.project-source-uploads.")
      ) {
        if (sourceUploads === undefined)
          throw new ApplicationError(
            "conflict",
            "project_source_upload_unavailable",
          );
        return sourceUploads.invokeAuthenticatedRequest(
          request,
          actor,
          command,
          signal,
          invoke,
        );
      }
      if (
        command.action === "crewon.project-foundation" ||
        command.action.startsWith("crewon.project-foundation.")
      ) {
        if (foundations === undefined)
          throw new ApplicationError(
            "conflict",
            "project_foundation_unavailable",
          );
        return foundations.invokeAuthenticatedRequest(
          request,
          actor,
          command,
          signal,
          invoke,
        );
      }
      if (
        command.action === "crewon.project-asset-stages" ||
        command.action.startsWith("crewon.project-asset-stages.")
      ) {
        if (
          assetStages === undefined ||
          !assetStages.supportsAction(command.action)
        )
          throw new ApplicationError(
            "conflict",
            "project_asset_stage_unavailable",
          );
        return assetStages.runAuthenticatedRequest(
          request,
          actor,
          command.action,
          signal,
          invoke,
        );
      }
      if (
        command.action === "crewon.project-assets" ||
        command.action.startsWith("crewon.project-assets.") ||
        command.action === "crewon.project-asset-recovery" ||
        command.action.startsWith("crewon.project-asset-recovery.")
      ) {
        if (assets === undefined)
          throw new ApplicationError(
            "conflict",
            "plugin_ui_actions_unavailable",
          );
        return assets.invokeAuthenticatedRequest(
          request,
          actor,
          command,
          signal,
          invoke,
        );
      }
      if (
        command.action === "crewon.project-text-plans" ||
        command.action.startsWith("crewon.project-text-plans.")
      ) {
        if (plans === undefined)
          throw new ApplicationError(
            "conflict",
            "project_text_plan_unavailable",
          );
        return plans.invokeAuthenticatedRequest(
          request,
          actor,
          command,
          signal,
          invoke,
        );
      }
      if (isProjectConversationUiNamespaceAction(command.action)) {
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
        command.action === "crewon.project-historical-queries" ||
        command.action.startsWith("crewon.project-historical-queries.")
      ) {
        if (historicalQueries === undefined || taskRequests === undefined)
          throw new ApplicationError(
            "conflict",
            "plugin_ui_actions_unavailable",
          );
        parseProjectHistoricalQueryUiActionRequest({
          action: command.action,
          input: command.input,
        });
        return taskRequests.run({ request, actor, signal }, invoke);
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
