import type { CommandWorkspaceHostModule } from "./CommandWorkspaceHostModule";

/** Presentation fencing only. Authenticated project ownership remains with Control. */
export function commandPluginConversationScope(
  input: Readonly<{
    modules: readonly CommandWorkspaceHostModule[];
    activePlugin: CommandWorkspaceHostModule | undefined;
    selectedThreadId: string | null;
    projectId: string | null | undefined;
    creatingProject: boolean;
  }>,
) {
  const { selectedThreadId, activePlugin } = input;
  const owned =
    selectedThreadId !== null &&
    (input.projectId != null ||
      input.modules.some(
        (module) =>
          Boolean(module.pluginId) &&
          module.conversationThreadIds?.includes(selectedThreadId),
      ));
  const missing = activePlugin
    ? input.creatingProject ||
      selectedThreadId === null ||
      !activePlugin.conversationThreadIds?.includes(selectedThreadId) ||
      (activePlugin.conversationProjectId !== undefined &&
        activePlugin.conversationProjectId !== input.projectId)
    : owned;
  return { owned, missing };
}
