import { pluginProjectWorkspaceId } from "./plugin-project-workspace-identity.ts";
import { parsePluginProjectWorkspaceOwner } from "@crewon/domain";
import {
  PROJECT_WORKSPACE_TARGET_ACTION,
  parseProjectWorkspaceTargetRequest,
  parseProjectWorkspaceTargetResponse,
} from "@crewon/contracts/project-workspace-target";
import { ApplicationError } from "./application-error.ts";
import {
  capturePluginProjectConversationReadScope,
  qualifyPluginProjectReadScope,
} from "./plugin-project-read-scope.ts";
import { captureProjectConversationAuthority } from "./project-conversation-authority.ts";
import {
  readConversationProject,
  authorizeConversationProject,
} from "./project-conversation-project-reader.ts";
import type { PluginUiActionContext } from "./plugin-ui-ports.ts";
import type { ProjectConversationCommitAuthority } from "./project-conversation-store-port.ts";
import type { ProjectConversationApplicationDependencies } from "./project-conversation-application-service.ts";

/** Identification through the same original Store. No namespace, directory, Thread or execution is created. */
export async function resolvePluginProjectWorkspaceTarget(
  input: Readonly<{
    digester: ProjectConversationApplicationDependencies["digester"];
    context: PluginUiActionContext;
    authority: ProjectConversationCommitAuthority;
    projects: ProjectConversationApplicationDependencies["projects"];
    authorization: ProjectConversationApplicationDependencies["authorization"];
  }>,
) {
  // Capture genuine live invocation membership before inspecting any caller fields.
  const scope = capturePluginProjectConversationReadScope(
    input.context,
    input.authority,
  );
  const source = qualifyPluginProjectReadScope(scope);
  if (
    input.context.action !== PROJECT_WORKSPACE_TARGET_ACTION ||
    input.projects.bindProjectReads === undefined
  )
    throw new ApplicationError(
      "authorization",
      "plugin_project_workspace_target_unavailable",
    );
  const request = parseProjectWorkspaceTargetRequest(input.context.input);
  const authority = captureProjectConversationAuthority(input.authority);
  const project = await readConversationProject({
    authority,
    projectId: request.projectId,
    action: "creativeProject:read",
    authorization: input.authorization,
    projects: input.projects.bindProjectReads(scope),
  });
  if (project.state !== "active")
    throw new ApplicationError("conflict", "creative_project_archived");
  await source.assertCurrent();
  await authorizeConversationProject({
    authority,
    projectId: request.projectId,
    action: "creativeProject:read",
    authorization: input.authorization,
  });
  source.assertActive();
  const owner = parsePluginProjectWorkspaceOwner({
    ...source.scope,
    projectId: request.projectId,
  });
  return parseProjectWorkspaceTargetResponse(
    {
      projectId: request.projectId,
      workspaceId: pluginProjectWorkspaceId(owner, input.digester),
    },
    request,
  );
}
