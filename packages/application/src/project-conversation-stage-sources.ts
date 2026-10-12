import {
  parseProjectBriefRevision,
  parseProjectTextArtifact,
  type ProjectStageSources,
} from "@crewon/domain";
import type { ProjectConversationsRequests } from "@crewon/contracts/project-conversations";
import type { ProjectConversationCommitAuthority } from "./project-conversation-store-port.ts";
import type { ProjectConversationApplicationDependencies } from "./project-conversation-application-service.ts";
import { ApplicationError } from "./application-error.ts";
import { creativeOwner } from "./creative-project-application-support.ts";
import { readConversationProject } from "./project-conversation-project-reader.ts";
import { readProjectOutlineSourceRevision } from "./project-outline-source-reader.ts";
import type { PluginProjectReadScope } from "./plugin-project-read-scope.ts";
/** Original source recipe; callers lend the exact current project reader. */
export async function projectConversationStageSources(
  input: Readonly<{
    authority: ProjectConversationCommitAuthority;
    request: ProjectConversationsRequests["startStage"];
    projects: Pick<
      ProjectConversationApplicationDependencies["projects"],
      "loadProject" | "loadBrief"
    >;
    texts: ProjectConversationApplicationDependencies["texts"];
    projectReadScope?: PluginProjectReadScope;
    authorization: ProjectConversationApplicationDependencies["authorization"];
    digester: ProjectConversationApplicationDependencies["digester"];
  }>,
): Promise<ProjectStageSources> {
  const { authority: q, request, projects } = input;
  const owner = creativeOwner(q.actor),
    project = await readConversationProject({
      authority: q,
      projectId: request.projectId,
      action: "creativeProject:read",
      projects,
      authorization: input.authorization,
    }),
    stage = request.stage,
    briefRevision =
      stage.kind === "discussion"
        ? project.latestBriefRevision
        : stage.briefRevision;
  const raw =
      briefRevision === 0
        ? null
        : await projects.loadBrief({
            owner,
            projectId: request.projectId,
            briefRevision,
          }),
    brief =
      raw === null ? null : parseProjectBriefRevision(raw, input.digester);
  if (stage.kind !== "discussion" && brief === null)
    throw new ApplicationError("notFound", "creative_project_brief_not_found");
  let outline: ProjectStageSources["outline"] = null;
  if (stage.kind === "script" && stage.outline !== null) {
    if (
      input.projectReadScope !== undefined &&
      input.texts.bindProjectReads === undefined
    )
      throw new ApplicationError(
        "authorization",
        "project_conversation_text_read_binding_unavailable",
      );
    const texts =
      input.projectReadScope === undefined
        ? input.texts
        : input.texts.bindProjectReads!(input.projectReadScope);
    const rawHead = await texts.loadOutline({
      owner,
      projectId: request.projectId,
    });
    if (rawHead === null)
      throw new ApplicationError("notFound", "project_text_artifact_not_found");
    const head = parseProjectTextArtifact(rawHead);
    if (head.artifactId !== stage.outline.artifactId)
      throw new ApplicationError("conflict", "project_text_dependencies_stale");
    const revision = await readProjectOutlineSourceRevision({
      store: texts,
      scope: { owner, projectId: request.projectId },
      project,
      artifact: head,
      contentRevision: stage.outline.contentRevision,
      digester: input.digester,
    });
    if (
      revision.kind !== "outline" ||
      !revision.content.episodes.some((e) => e.episodeId === stage.episodeId) ||
      revision.brief.briefRevision !== stage.briefRevision
    )
      throw new ApplicationError("conflict", "project_text_dependencies_stale");
    outline = { ...stage.outline, contentDigest: revision.contentDigest };
  }
  return Object.freeze({
    brief:
      brief === null
        ? null
        : Object.freeze({
            briefRevision: brief.briefRevision,
            contentDigest: brief.contentDigest,
          }),
    outline,
  });
}
