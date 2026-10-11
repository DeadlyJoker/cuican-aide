import {
  createProjectConversationBinding,
  type ProjectConversationBinding,
} from "@crewon/domain";
import type { ProjectConversationsRequests } from "@crewon/contracts/project-conversations";
import type { ProjectConversationApplicationDependencies } from "./project-conversation-application-service.ts";
import type { ProjectConversationCommitAuthority } from "./project-conversation-store-port.ts";
import type { PluginProjectReadScope } from "./plugin-project-read-scope.ts";
import { ApplicationError } from "./application-error.ts";
import { readConversationProject } from "./project-conversation-project-reader.ts";
import { ownedConversationProjectWriteAuthority } from "./project-conversation-project-authority.ts";
import { projectConversationReceipt } from "./project-conversation-receipt.ts";

/** Original binding mutation recipe; qualified UI calls select a view of the same Store. */
export async function changeProjectConversationBinding(
  input: Readonly<{
    method: "refreshSource" | "setState";
    request: ProjectConversationsRequests["refreshSource" | "setState"];
    authority: ProjectConversationCommitAuthority;
    dependencies: Pick<
      ProjectConversationApplicationDependencies,
      "conversations" | "authorization" | "clock" | "digester"
    >;
    projects: Pick<
      ProjectConversationApplicationDependencies["projects"],
      "loadProject"
    >;
    readScope?: PluginProjectReadScope;
    loadBinding(
      authority: ProjectConversationCommitAuthority,
      projectId: string,
      threadId: string,
    ): Promise<ProjectConversationBinding>;
    assertThread(
      authority: ProjectConversationCommitAuthority,
      binding: ProjectConversationBinding,
    ): Promise<void>;
  }>,
) {
  const { method, request, dependencies: d } = input;
  const q =
    input.readScope === undefined
      ? input.authority
      : ownedConversationProjectWriteAuthority({
          authority: input.authority,
          projectId: request.projectId,
          authorization: d.authorization,
        });
  await readConversationProject({
    authority: q,
    projectId: request.projectId,
    action: "creativeProject:write",
    authorization: d.authorization,
    projects: input.projects,
  });
  const kind = method === "refreshSource" ? "refresh-source" : "set-state";
  const receipt = projectConversationReceipt({
    kind,
    input: request,
    authority: q,
    digester: d.digester,
    ...(input.readScope === undefined ? {} : { readScope: input.readScope }),
  });
  const previous = await d.conversations.loadMutationReceipt({
    actor: q.actor,
    profileId: q.installation.profileId,
    receipt,
  });
  if (previous !== null) {
    await q.assertCurrent();
    q.assertActive();
    return previous;
  }
  const b = await input.loadBinding(q, request.projectId, request.threadId);
  await input.assertThread(q, b);
  if (b.revision !== request.expectedBindingRevision)
    throw new ApplicationError(
      "conflict",
      "project_conversation_revision_conflict",
    );
  if (
    b.currentInstallation.pluginId !== q.installation.pluginId ||
    b.currentInstallation.publisherId !== q.installation.publisherId
  )
    throw new ApplicationError(
      "authorization",
      "project_conversation_source_mismatch",
    );
  const { schemaVersion: _schema, contentDigest: _digest, ...body } = b;
  const binding = createProjectConversationBinding(
    {
      ...body,
      revision: b.revision + 1,
      updatedAt: d.clock.now(),
      currentInstallation:
        method === "refreshSource" ? q.installation : b.currentInstallation,
      state:
        method === "setState"
          ? (request as ProjectConversationsRequests["setState"]).state
          : b.state,
    },
    d.digester,
  );
  return d.conversations.commitBinding(
    { kind, binding, expectedRevision: b.revision, receipt },
    { authority: q },
  );
}
