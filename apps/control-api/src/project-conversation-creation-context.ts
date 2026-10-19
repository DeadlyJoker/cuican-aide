import {
  ApplicationError,
  assertPluginUiInvocationCurrent,
  type PluginUiActionContext,
  type ProjectConversationCommitAuthority,
} from "@crewon/application";
import {
  PROJECT_CREATION_CONTEXT_SCHEMA,
  parseProjectCreationContextRequest,
  parseProjectCreationContextResponse,
} from "@crewon/contracts/project-workspace-target";

/** Original invocation and installation checks precede composition-only disclosure. */
export async function readProjectConversationCreationContext(
  input: Readonly<{
    context: PluginUiActionContext;
    issue(): Promise<ProjectConversationCommitAuthority>;
    projectOwnership: "plugin-project-v1" | undefined;
    nativeWorkspaceAvailable: boolean;
  }>,
) {
  parseProjectCreationContextRequest(input.context.input);
  const authority = await input.issue();
  await assertPluginUiInvocationCurrent(input.context);
  await authority.assertCurrent();
  if (
    input.projectOwnership === "plugin-project-v1" &&
    !input.nativeWorkspaceAvailable
  )
    throw new ApplicationError("conflict", "project_conversation_unavailable");
  const result = parseProjectCreationContextResponse({
    schemaVersion: PROJECT_CREATION_CONTEXT_SCHEMA,
    workspaceMode:
      input.projectOwnership === "plugin-project-v1"
        ? "plugin-owned-explicit"
        : "legacy-nullable",
  });
  await authority.assertCurrent();
  await assertPluginUiInvocationCurrent(input.context);
  return result;
}
