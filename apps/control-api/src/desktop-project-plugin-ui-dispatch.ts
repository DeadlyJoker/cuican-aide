import { ApplicationError, type PluginUiActionPort } from "@crewon/application";
import type { CreativeProjectPluginUiRuntime } from "./creative-project-plugin-ui-composition.ts";
import type { ProjectTextPluginUiRuntime } from "./project-text-plugin-ui-composition.ts";
import type { DesktopProjectHistoryPluginRuntime } from "./desktop-project-history-plugin-runtime.ts";
import type { InstalledPluginTaskRuntimeCore } from "./installed-plugin-task-runtime-core.ts";
import { combineSelectionCommittedMetadata } from "./project-generation-selection-plugin-ui-owner.ts";

/** Metadata namespaces are dispatched before the independent execution owner. */
export function composeDesktopProjectPluginUiDispatch(
  input: Readonly<{
    projects: CreativeProjectPluginUiRuntime | undefined;
    texts: ProjectTextPluginUiRuntime | undefined;
    history: DesktopProjectHistoryPluginRuntime | undefined;
    tasks: InstalledPluginTaskRuntimeCore | undefined;
  }>,
) {
  const { projects, texts, history, tasks } = input;
  const actions: PluginUiActionPort = {
    invoke: async (context) => {
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
    ...committedDesktopProjectMetadata(projects, history, texts),
  };
}

function committedDesktopProjectMetadata(
  projects: CreativeProjectPluginUiRuntime | undefined,
  history: DesktopProjectHistoryPluginRuntime | undefined,
  texts: ProjectTextPluginUiRuntime | undefined,
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
          texts.owner.committedMetadata,
          original,
        );
  return combined === undefined ? {} : { committedMetadata: combined };
}
