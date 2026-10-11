import { parseProjectConversationsActionRequest } from "@crewon/contracts/project-conversations";
import { ApplicationError } from "./application-error.ts";
import { capturePluginProjectConversationReadScope } from "./plugin-project-read-scope.ts";
import type { ProjectConversationApplicationDependencies } from "./project-conversation-application-service.ts";
import type { ProjectConversationCommitAuthority } from "./project-conversation-store-port.ts";
import type { PluginUiActionContext } from "./plugin-ui-ports.ts";

/** Only a genuine bounded UI action supplies this original Store view; unsupported Stores fail before Thread preparation. */
export function conversationUiProjectReader(
  input: Readonly<{
    context: PluginUiActionContext;
    authority: ProjectConversationCommitAuthority;
    projects: ProjectConversationApplicationDependencies["projects"];
  }>,
) {
  const scope = capturePluginProjectConversationReadScope(
    input.context,
    input.authority,
  );
  if (input.projects.bindProjectReads === undefined)
    throw new ApplicationError(
      "authorization",
      "plugin_project_read_store_unavailable",
    );
  return Object.freeze({
    scope,
    request: parseProjectConversationsActionRequest({
      action: input.context.action,
      input: input.context.input,
    }),
    projects: input.projects.bindProjectReads(scope),
  });
}
