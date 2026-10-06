import { isProjectMediaInputUiNamespaceAction } from "@crewon/contracts/project-media-inputs-ui";
import type { ProjectMediaInputPluginUiOwner } from "./project-media-input-plugin-ui-owner.ts";
import { isProjectConversationUiNamespaceAction } from "@crewon/contracts/project-conversation-association";
import type { ProjectAssetStageControlOwner } from "./project-asset-stage-control-owner.ts";
import { isProjectAssetStagesNamespaceAction } from "@crewon/contracts/project-asset-stages";
import { isProjectAssetRecoveryNamespaceAction } from "@crewon/contracts/project-asset-recovery";
import { ApplicationError, type PluginUiActionPort } from "@crewon/application";
import type { CreativeProjectPluginUiRuntime } from "./creative-project-plugin-ui-composition.ts";
import type { ProjectTextPluginUiRuntime } from "./project-text-plugin-ui-composition.ts";
import type { DesktopProjectHistoryPluginRuntime } from "./desktop-project-history-plugin-runtime.ts";
import type { InstalledPluginTaskRuntimeCore } from "./installed-plugin-task-runtime-core.ts";
import { combineSelectionCommittedMetadata } from "./project-generation-selection-plugin-ui-owner.ts";
import type { ProjectConversationControlOwner } from "./project-conversation-control-owner.ts";
import type { ProjectTextPlanPluginUiRuntime } from "./project-text-plan-plugin-ui-composition.ts";
import type { ProjectAssetPluginUiRuntime } from "./project-asset-plugin-ui-composition.ts";
import { isProjectAssetUiNamespaceAction } from "@crewon/contracts/project-assets";

/** Metadata namespaces are dispatched before the independent execution owner. */
export function composeDesktopProjectPluginUiDispatch(
  input: Readonly<{
    mediaInputs?: ProjectMediaInputPluginUiOwner;
    projects: CreativeProjectPluginUiRuntime | undefined;
    texts: ProjectTextPluginUiRuntime | undefined;
    assets?: ProjectAssetPluginUiRuntime;
    assetStages?: () => ProjectAssetStageControlOwner | undefined;
    history: DesktopProjectHistoryPluginRuntime | undefined;
    tasks: InstalledPluginTaskRuntimeCore | undefined;
    conversations?: () => ProjectConversationControlOwner | undefined;
    plans?: () => ProjectTextPlanPluginUiRuntime | undefined;
  }>,
) {
  const { projects, texts, history, tasks } = input;
  const actions: PluginUiActionPort = {
    invoke: async (context) => {
      if (isProjectMediaInputUiNamespaceAction(context.action)) {
        if (
          input.mediaInputs === undefined ||
          !input.mediaInputs.supportsAction(context.action)
        )
          throw new ApplicationError(
            "conflict",
            "project_media_input_ui_unavailable",
          );
        return input.mediaInputs.actions.invoke(context);
      }
      if (isProjectAssetStagesNamespaceAction(context.action)) {
        const owner = input.assetStages?.();
        if (owner === undefined || !owner.supportsAction(context.action))
          throw new ApplicationError(
            "conflict",
            "project_asset_stage_unavailable",
          );
        return owner.actions.invoke(context);
      }
      if (isProjectAssetRecoveryNamespaceAction(context.action)) {
        const owner = input.assets?.recoveryOwner;
        if (owner === undefined || !owner.supportsAction(context.action))
          throw new ApplicationError(
            "conflict",
            "project_asset_recovery_unavailable",
          );
        return owner.actions.invoke(context);
      }
      if (isProjectAssetUiNamespaceAction(context.action)) {
        if (
          input.assets === undefined ||
          !input.assets.owner.supportsAction(context.action)
        )
          throw new ApplicationError("conflict", "project_asset_unavailable");
        return input.assets.owner.actions.invoke(context);
      }
      if (
        context.action === "crewon.project-text-plans" ||
        context.action.startsWith("crewon.project-text-plans.")
      ) {
        const owner = input.plans?.()?.owner;
        if (owner === undefined || !owner.supportsAction(context.action))
          throw new ApplicationError(
            "conflict",
            "project_text_plan_unavailable",
          );
        return owner.actions.invoke(context);
      }
      if (isProjectConversationUiNamespaceAction(context.action)) {
        const owner = input.conversations?.();
        if (owner === undefined || !owner.supportsAction(context.action))
          throw new ApplicationError(
            "conflict",
            "plugin_ui_actions_unavailable",
          );
        return owner.actions.invoke(context);
      }
      if (
        context.action === "crewon.project-text-recovery" ||
        context.action.startsWith("crewon.project-text-recovery.")
      ) {
        if (
          texts?.recoveryOwner === undefined ||
          !texts.recoveryOwner.supportsAction(context.action)
        )
          throw new ApplicationError(
            "conflict",
            "plugin_ui_actions_unavailable",
          );
        return texts.recoveryOwner.actions.invoke(context);
      }
      if (
        context.action === "crewon.project-texts" ||
        context.action.startsWith("crewon.project-texts.")
      ) {
        if (texts === undefined || !texts.owner.supportsAction(context.action))
          throw new ApplicationError(
            "conflict",
            "plugin_ui_actions_unavailable",
          );
        return texts.owner.actions.invoke(context);
      }
      if (projects?.owner.supportsAction(context.action))
        return projects.owner.actions.invoke(context);
      if (history?.selectionRuntime?.owner.supportsAction(context.action))
        return history.selectionRuntime.owner.actions.invoke(context);
      if (tasks?.projectGenerations?.supportsAction(context.action))
        return tasks.projectGenerations.actions.invoke(context);
      if (
        context.action === "crewon.project-historical-queries" ||
        context.action.startsWith("crewon.project-historical-queries.")
      ) {
        if (
          tasks?.historicalQueries === undefined ||
          !tasks.historicalQueries.supportsAction(context.action)
        )
          throw new ApplicationError(
            "conflict",
            "project_historical_query_unavailable",
          );
        return tasks.historicalQueries.actions.invoke(context);
      }
      if (tasks?.projectQueries?.supportsAction(context.action))
        return tasks.projectQueries.actions.invoke(context);
      if (tasks !== undefined) return tasks.owner.actions.invoke(context);
      throw new ApplicationError("conflict", "plugin_ui_actions_unavailable");
    },
  };
  const metadata = committedDesktopProjectMetadata(
    projects,
    history,
    texts,
    input.conversations,
  );
  const assetMetadata =
    input.assets === undefined
      ? metadata
      : {
          committedMetadata: combineSelectionCommittedMetadata(
            input.assets.recoveryOwner === undefined
              ? input.assets.owner.committedMetadata
              : combineSelectionCommittedMetadata(
                  input.assets.recoveryOwner.committedMetadata,
                  input.assets.owner.committedMetadata,
                ),
            metadata.committedMetadata,
          ),
        };
  const stageMetadata =
    input.assetStages === undefined
      ? assetMetadata
      : {
          committedMetadata: combineSelectionCommittedMetadata(
            {
              isOutcome: (
                value,
              ): value is import("@crewon/application").PluginUiCommittedMetadataOutcome =>
                input.assetStages?.()?.committedMetadata.isOutcome(value) ===
                true,
              verify: (context, value) => {
                const owner = input.assetStages?.();
                if (owner === undefined)
                  throw new ApplicationError(
                    "authorization",
                    "project_asset_stage_unavailable",
                  );
                return owner.committedMetadata.verify(context, value);
              },
            },
            assetMetadata.committedMetadata,
          ),
        };
  const dispatch = {
    actions,
    ...(input.plans === undefined
      ? stageMetadata
      : {
          committedMetadata: combineSelectionCommittedMetadata(
            {
              isOutcome: (
                value,
              ): value is import("@crewon/application").PluginUiCommittedMetadataOutcome =>
                input.plans?.()?.owner.committedMetadata.isOutcome(value) ===
                true,
              verify: (context, value) => {
                const owner = input.plans?.()?.owner;
                if (owner === undefined)
                  throw new ApplicationError(
                    "authorization",
                    "project_text_plan_unavailable",
                  );
                return owner.committedMetadata.verify(context, value);
              },
            },
            stageMetadata.committedMetadata,
          ),
        }),
  };
  return input.mediaInputs === undefined
    ? dispatch
    : {
        ...dispatch,
        committedMetadata: combineSelectionCommittedMetadata(
          input.mediaInputs.committedMetadata,
          dispatch.committedMetadata,
        ),
      };
}

function committedDesktopProjectMetadata(
  projects: CreativeProjectPluginUiRuntime | undefined,
  history: DesktopProjectHistoryPluginRuntime | undefined,
  texts: ProjectTextPluginUiRuntime | undefined,
  conversations:
    | (() => ProjectConversationControlOwner | undefined)
    | undefined,
) {
  const original =
    history?.selectionRuntime === undefined
      ? projects?.owner.committedMetadata
      : combineSelectionCommittedMetadata(
          history.selectionRuntime.owner.committedMetadata,
          projects?.owner.committedMetadata,
        );
  const combined =
    texts === undefined
      ? original
      : combineSelectionCommittedMetadata(
          texts.recoveryOwner === undefined
            ? texts.owner.committedMetadata
            : combineSelectionCommittedMetadata(
                texts.recoveryOwner.committedMetadata,
                texts.owner.committedMetadata,
              ),
          original,
        );
  if (conversations === undefined)
    return combined === undefined ? {} : { committedMetadata: combined };
  return {
    committedMetadata: combineSelectionCommittedMetadata(
      {
        isOutcome: (
          value,
        ): value is import("@crewon/application").PluginUiCommittedMetadataOutcome =>
          conversations()?.committedMetadata.isOutcome(value) === true,
        verify: (context, value) => {
          const owner = conversations();
          if (owner === undefined)
            throw new ApplicationError(
              "authorization",
              "plugin_ui_actions_unavailable",
            );
          return owner.committedMetadata.verify(context, value);
        },
      },
      combined,
    ),
  };
}
