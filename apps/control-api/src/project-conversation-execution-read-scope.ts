import { issuePluginProjectConversationStageReadScope } from "@crewon/application/host-project-workspaces";
import {
  ApplicationError,
  type ProjectConversationCommitAuthority,
} from "@crewon/application";
import { extensionCanonicalJson } from "@crewon/domain";
import type { ProjectConversationsRequests } from "@crewon/contracts/project-conversations";
import { PROJECT_CONVERSATIONS_METHOD_ACTIONS } from "@crewon/contracts/project-conversations";
import {
  isInstalledPluginRequestOwner,
  type InstalledPluginRequestOwner,
} from "./installed-plugin-request-owner.ts";
const executionAuthorities = new WeakSet<object>();
/** Only called by original Control issuance after verified Node action and submit authorization. Never serialized or exposed through a service. */
export function registerProjectConversationExecutionAuthority(
  authority: ProjectConversationCommitAuthority,
): void {
  executionAuthorities.add(authority);
}
export function bindDerivedProjectConversationExecutionAuthority(
  parent: ProjectConversationCommitAuthority,
  derived: ProjectConversationCommitAuthority,
): void {
  if (
    !executionAuthorities.has(parent) ||
    extensionCanonicalJson(parent.pin) !==
      extensionCanonicalJson(derived.pin) ||
    extensionCanonicalJson(parent.selection) !==
      extensionCanonicalJson(derived.selection) ||
    extensionCanonicalJson(parent.package) !==
      extensionCanonicalJson(derived.package)
  )
    denied();
  executionAuthorities.add(derived);
}
/** Original live request owner and exact admitted authority are both required. Copies and metadata-only issuance cannot acquire the view. */
export async function projectConversationExecutionReadScope(
  input: Readonly<{
    requests: InstalledPluginRequestOwner;
    authority: ProjectConversationCommitAuthority;
    request: ProjectConversationsRequests["startStage"];
  }>,
) {
  if (
    !isInstalledPluginRequestOwner(input.requests) ||
    !executionAuthorities.has(input.authority)
  )
    denied();
  await input.requests.assertCurrent();
  const actor = input.requests.currentActor(),
    scope = input.requests.currentScope(),
    q = input.authority;
  if (
    extensionCanonicalJson(actor) !== extensionCanonicalJson(q.actor) ||
    scope.tenantId !== q.installation.tenantId ||
    scope.spaceId !== q.installation.spaceId ||
    scope.profileId !== q.installation.profileId
  )
    denied();
  await q.assertCurrent();
  q.assertActive();
  return issuePluginProjectConversationStageReadScope({
    authority: q,
    request: {
      action: PROJECT_CONVERSATIONS_METHOD_ACTIONS.startStage,
      input: input.request,
    },
  });
}
function denied(): never {
  throw new ApplicationError(
    "authorization",
    "project_conversation_execution_read_scope_unavailable",
  );
}

export async function projectConversationStageReadOptions(
  input: Readonly<{
    projectOwnership: "plugin-project-v1" | undefined;
    requests: InstalledPluginRequestOwner;
    authority: ProjectConversationCommitAuthority;
    request: ProjectConversationsRequests["startStage"];
  }>,
) {
  if (input.projectOwnership === undefined) return {};
  if (input.projectOwnership !== "plugin-project-v1") denied();
  return {
    projectReadScope: await projectConversationExecutionReadScope(input),
  };
}
