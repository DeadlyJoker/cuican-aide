import { ApplicationError, type PluginUiActionPort } from "@crewon/application";
import type { CreativeProjectPluginUiRuntime } from "./creative-project-plugin-ui-composition.ts";
import type { ProjectTextPluginUiRuntime } from "./project-text-plugin-ui-composition.ts";
import type { DesktopProjectHistoryPluginRuntime } from "./desktop-project-history-plugin-runtime.ts";
import type { InstalledPluginTaskRuntimeCore } from "./installed-plugin-task-runtime-core.ts";
import { combineSelectionCommittedMetadata } from "./project-generation-selection-plugin-ui-owner.ts";
import type { ProjectConversationControlOwner } from "./project-conversation-control-owner.ts";

/** Metadata namespaces are dispatched before the independent execution owner. */
export function composeDesktopProjectPluginUiDispatch(
  input: Readonly<{
    projects: CreativeProjectPluginUiRuntime | undefined;
    texts: ProjectTextPluginUiRuntime | undefined;
    history: DesktopProjectHistoryPluginRuntime | undefined;
    tasks: InstalledPluginTaskRuntimeCore | undefined;
    conversations?: () => ProjectConversationControlOwner | undefined;
  }>,
) {
  const { projects, texts, history, tasks } = input;
  const actions: PluginUiActionPort = {
    invoke: async (context) => {
      if (
        context.action === "crewon.project-conversations" ||
        context.action.startsWith("crewon.project-conversations.")
      ) {
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
      if (tasks?.projectQueries?.supportsAction(context.action))
        return tasks.projectQueries.actions.invoke(context);
      if (tasks !== undefined) return tasks.owner.actions.invoke(context);
      throw new ApplicationError("conflict", "plugin_ui_actions_unavailable");
    },
  };
  return {
    actions,
    ...committedDesktopProjectMetadata(
      projects,
      history,
      texts,
      input.conversations,
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
