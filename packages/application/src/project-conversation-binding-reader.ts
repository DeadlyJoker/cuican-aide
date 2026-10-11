import { ApplicationError } from "./application-error.ts";
import {
  extensionCanonicalJson,
  type ProjectConversationBinding,
} from "@crewon/domain";
import type { ProjectConversationApplicationDependencies } from "./project-conversation-application-service.ts";
import type { ProjectConversationCommitAuthority } from "./project-conversation-store-port.ts";

/** One original binding recipe; the service supplies either its original reader or its genuine per-call owned view. */
export async function readProjectConversationBinding(
  input: Readonly<{
    authority: ProjectConversationCommitAuthority;
    threadId: string;
    conversations: Pick<
      ProjectConversationApplicationDependencies["conversations"],
      "loadBinding" | "hasThreadBinding"
    >;
    readProject(projectId: string): Promise<unknown>;
    readThread(binding: ProjectConversationBinding): Promise<void>;
    assertProjectCurrent(projectId: string): Promise<void>;
  }>,
): Promise<ProjectConversationBinding | null> {
  const q = input.authority;
  const binding = await input.conversations.loadBinding({
    actor: q.actor,
    profileId: q.installation.profileId,
    threadId: input.threadId,
  });
  if (binding === null) {
    if (
      await input.conversations.hasThreadBinding({
        tenantId: q.actor.tenantId,
        spaceId: q.actor.spaceId,
        threadId: input.threadId,
      })
    )
      throw new ApplicationError(
        "authorization",
        "project_conversation_source_mismatch",
      );
    await q.assertCurrent();
    q.assertActive();
    return null;
  }
  if (
    binding.threadId !== input.threadId ||
    extensionCanonicalJson(binding.owner) !== extensionCanonicalJson(q.actor) ||
    binding.profileId !== q.installation.profileId ||
    binding.currentInstallation.pluginId !== q.installation.pluginId ||
    binding.currentInstallation.publisherId !== q.installation.publisherId
  )
    throw new ApplicationError(
      "authorization",
      "project_conversation_source_mismatch",
    );
  await input.readProject(binding.projectId);
  await input.readThread(binding);
  await q.assertCurrent();
  await input.assertProjectCurrent(binding.projectId);
  q.assertActive();
  return binding;
}
