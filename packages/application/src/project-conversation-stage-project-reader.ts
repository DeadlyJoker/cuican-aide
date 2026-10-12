import { extensionCanonicalJson } from "@crewon/domain";
import {
  PROJECT_CONVERSATIONS_METHOD_ACTIONS,
  type ProjectConversationsRequests,
} from "@crewon/contracts/project-conversations";
import { ApplicationError } from "./application-error.ts";
import {
  qualifyPluginProjectReadScope,
  type PluginProjectReadScope,
} from "./plugin-project-read-scope.ts";
import type { ProjectConversationCommitAuthority } from "./project-conversation-store-port.ts";
import type { ProjectConversationApplicationDependencies } from "./project-conversation-application-service.ts";
/** Reuse the original per-call Store view, with exact request and installation correlation; no ambient context or UI impersonation. */
export async function conversationStageProjectReader(
  input: Readonly<{
    scope: PluginProjectReadScope;
    authority: ProjectConversationCommitAuthority;
    request: ProjectConversationsRequests["startStage"];
    projects: ProjectConversationApplicationDependencies["projects"];
  }>,
) {
  const source = qualifyPluginProjectReadScope(input.scope);
  if (
    source.purpose !== "read" ||
    source.request.action !== PROJECT_CONVERSATIONS_METHOD_ACTIONS.startStage ||
    extensionCanonicalJson(source.request.input) !==
      extensionCanonicalJson(input.request) ||
    extensionCanonicalJson(source.snapshot.pin) !==
      extensionCanonicalJson(input.authority.pin) ||
    extensionCanonicalJson(source.snapshot.context.selection) !==
      extensionCanonicalJson(input.authority.selection) ||
    extensionCanonicalJson(source.snapshot.context.package) !==
      extensionCanonicalJson(input.authority.package) ||
    input.projects.bindProjectReads === undefined
  )
    throw new ApplicationError(
      "authorization",
      "project_conversation_stage_read_scope_mismatch",
    );
  await source.assertCurrent();
  source.assertActive();
  return input.projects.bindProjectReads(input.scope);
}
