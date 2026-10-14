import {
  ApplicationError,
  type ActorContext,
  type ProjectConversationCommitAuthority,
  type ProjectConversationStore,
} from "@crewon/application";
import { issuePluginProjectConversationContextReadScope } from "@crewon/application/host-project-workspaces";
import {
  extensionCanonicalJson,
  type ProjectConversationBinding,
} from "@crewon/domain";
import {
  isInstalledPluginRequestOwner,
  type InstalledPluginRequestOwner,
} from "./installed-plugin-request-owner.ts";

const authorities = new WeakSet<object>();
/** Original Control issuance only; copying metadata callbacks cannot acquire the read view. */
export function registerProjectConversationMetadataReadAuthority(
  authority: ProjectConversationCommitAuthority,
): void {
  authorities.add(authority);
}
export async function readBoundProjectConversation<T>(
  input: Readonly<{
    actor: ActorContext;
    threadId: string;
    projectOwnership: "plugin-project-v1" | undefined;
    requests: InstalledPluginRequestOwner;
    binding(): Promise<ProjectConversationBinding | null>;
    hasThreadBinding: ProjectConversationStore["hasThreadBinding"];
    issue(
      binding: ProjectConversationBinding,
    ): Promise<ProjectConversationCommitAuthority>;
    absent: T;
    read(
      authority: ProjectConversationCommitAuthority,
      options: Readonly<{
        projectReadScope?: import("@crewon/application").PluginProjectReadScope;
      }>,
    ): Promise<T>;
  }>,
): Promise<T> {
  const binding = await input.binding();
  if (binding === null) {
    if (
      await input.hasThreadBinding({
        tenantId: input.actor.tenantId,
        spaceId: input.actor.spaceId,
        threadId: input.threadId,
      })
    )
      denied();
    return input.absent;
  }
  const authority = await input.issue(binding);
  if (input.projectOwnership === undefined) return input.read(authority, {});
  if (
    input.projectOwnership !== "plugin-project-v1" ||
    !isInstalledPluginRequestOwner(input.requests) ||
    !authorities.has(authority)
  )
    denied();
  await input.requests.assertCurrent();
  const scope = input.requests.currentScope();
  if (
    extensionCanonicalJson(input.requests.currentActor()) !==
      extensionCanonicalJson(authority.actor) ||
    scope.tenantId !== authority.installation.tenantId ||
    scope.spaceId !== authority.installation.spaceId ||
    scope.profileId !== authority.installation.profileId
  )
    denied();
  await authority.assertCurrent();
  authority.assertActive();
  return input.read(authority, {
    projectReadScope: issuePluginProjectConversationContextReadScope({
      authority,
      projectId: binding.projectId,
      threadId: binding.threadId,
    }),
  });
}
function denied(): never {
  throw new ApplicationError(
    "authorization",
    "project_conversation_authority_changed",
  );
}
