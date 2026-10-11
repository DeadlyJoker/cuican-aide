import { validateCreativeProject } from "@crewon/domain";
import { ApplicationError } from "./application-error.ts";
import { creativeOwner } from "./creative-project-application-support.ts";
import type { ProjectConversationApplicationDependencies } from "./project-conversation-application-service.ts";
import type { ProjectConversationCommitAuthority } from "./project-conversation-store-port.ts";

/** The original preparation recipe, with an explicit per-call reader; never an ambient request context. */
export async function readConversationProject(
  input: Readonly<{
    authority: ProjectConversationCommitAuthority;
    projectId: string;
    action: "creativeProject:read" | "creativeProject:write";
    authorization: ProjectConversationApplicationDependencies["authorization"];
    projects: Pick<
      ProjectConversationApplicationDependencies["projects"],
      "loadProject"
    >;
  }>,
) {
  const { authority: q, projectId, action } = input;
  await authorizeConversationProject(input);
  const raw = await input.projects.loadProject({
    owner: creativeOwner(q.actor),
    projectId,
  });
  if (raw === null)
    throw new ApplicationError("notFound", "creative_project_not_found");
  const p = validateCreativeProject(raw);
  if (
    p.tenantId !== q.actor.tenantId ||
    p.spaceId !== q.actor.spaceId ||
    p.ownerPrincipalId !== q.actor.principalId ||
    p.projectId !== projectId
  )
    throw new ApplicationError(
      "authorization",
      "creative_project_access_denied",
    );
  if (p.state !== "active" && action === "creativeProject:write")
    throw new ApplicationError("conflict", "creative_project_archived");
  return p;
}

export async function authorizeConversationProject(
  input: Readonly<{
    authority: ProjectConversationCommitAuthority;
    projectId: string;
    action: "creativeProject:read" | "creativeProject:write";
    authorization: ProjectConversationApplicationDependencies["authorization"];
  }>,
) {
  const { authority: q, projectId, action } = input;
  if (
    (
      await input.authorization.authorize({
        actor: q.actor,
        action,
        resource: {
          kind: "creativeProject",
          tenantId: q.actor.tenantId,
          spaceId: q.actor.spaceId,
          projectId,
        },
      })
    ).outcome !== "allow"
  )
    throw new ApplicationError(
      "authorization",
      "creative_project_access_denied",
    );
}
