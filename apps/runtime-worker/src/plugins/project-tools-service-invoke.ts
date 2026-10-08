import type {
  ActorContext,
  CreativeProjectCommitAuthority,
} from "@crewon/application";
import {
  extensionCanonicalJson,
  structuredProjectTextCanonicalJson,
} from "@crewon/domain";
import {
  readProjectToolOutline,
  readProjectToolRevision,
  listProjectToolRevisions,
  assertLegacyOutlineCandidateCompatible,
} from "./project-tools-outline-reader.ts";
import type { ProjectToolsMethod } from "@crewon/contracts/project-tools";
import type { ProjectToolsRequests } from "./project-tools-service-request.ts";
import type { ProjectToolsServiceOwnerDependencies } from "./project-tools-service-owner.ts";
import {
  projectToolsProject,
  projectToolsBrief,
  projectToolsView,
  projectToolsRevision,
  projectToolsTextMutation,
  projectToolsBriefMutation,
  projectToolsContent,
} from "./project-tools-service-projection.ts";
/** Original authorized application operations. Dispatch and stage qualification stay in the resident owner. */
export async function invokeProjectTool(
  input: Readonly<{
    dependencies: Pick<
      ProjectToolsServiceOwnerDependencies,
      "projects" | "texts" | "outlines"
    >;
    method: ProjectToolsMethod;
    request: ProjectToolsRequests[ProjectToolsMethod];
    actor: ActorContext;
    idempotencyKey: string | undefined;
    authority: CreativeProjectCommitAuthority | undefined;
  }>,
): Promise<unknown> {
  const { dependencies, method, request, actor, idempotencyKey, authority } =
    input;
  const projects = dependencies.projects,
    texts = dependencies.texts;
  const options = { authority };
  // Each branch reuses the original owned Application use case; no raw storage writes.
  switch (method) {
    case "listProjects": {
      const page = await projects.listProjects(
        actor,
        request as ProjectToolsRequests["listProjects"],
      );
      return {
        projects: page.projects.map(projectToolsProject),
        next: page.next,
      };
    }
    case "readProject": {
      const query = request as ProjectToolsRequests["readProject"];
      const project = await projects.getProject(actor, query);
      const brief =
        project.latestBriefRevision === 0
          ? null
          : await projects.getBrief(actor, {
              projectId: project.projectId,
              briefRevision: project.latestBriefRevision,
            });
      return {
        project: projectToolsProject(project),
        brief: brief === null ? null : projectToolsBrief(brief),
      };
    }
    case "createProject":
      return projectToolsBriefMutation(
        await projects.createProject(
          actor,
          {
            ...(request as ProjectToolsRequests["createProject"]),
            idempotencyKey: idempotencyKey!,
          },
          options,
        ),
      );
    case "appendBrief":
      return projectToolsBriefMutation(
        await projects.appendBrief(
          actor,
          {
            ...(request as ProjectToolsRequests["appendBrief"]),
            idempotencyKey: idempotencyKey!,
          },
          options,
        ),
      );
    case "readOutline":
      return {
        view: await readProjectToolOutline(
          dependencies,
          actor,
          request as ProjectToolsRequests["readOutline"],
        ),
      };
    case "readScript":
      return {
        view: projectToolsView(
          await texts.getScript(
            actor,
            request as ProjectToolsRequests["readScript"],
          ),
        ),
      };
    case "readContent": {
      const query = request as ProjectToolsRequests["readContent"];
      if (query.source.kind === "brief") {
        const brief = await projects.getBrief(actor, {
          projectId: query.projectId,
          briefRevision: query.source.briefRevision,
        });
        return projectToolsContent(
          brief.contentDigest,
          "text",
          brief.text,
          query.offset,
        );
      }
      const revision = await readProjectToolRevision(dependencies, actor, {
        projectId: query.projectId,
        artifactId: query.source.artifactId,
        contentRevision: query.source.contentRevision,
      });
      return projectToolsContent(
        revision.contentDigest,
        "canonical-json",
        revision.schemaVersion === "crewon.project-text-revision.v2"
          ? structuredProjectTextCanonicalJson(revision.content)
          : extensionCanonicalJson(revision.content),
        query.offset,
      );
    }
    case "listRevisions": {
      const page = await listProjectToolRevisions(
        dependencies,
        actor,
        request as ProjectToolsRequests["listRevisions"],
      );
      return {
        revisions: page.revisions.map(projectToolsRevision),
        nextContentRevision: page.nextContentRevision,
      };
    }
    case "saveOutlineCandidate":
      await assertLegacyOutlineCandidateCompatible(
        dependencies,
        actor,
        request as ProjectToolsRequests["saveOutlineCandidate"],
      );
      return projectToolsTextMutation(
        await texts.saveOutlineCandidate(
          actor,
          {
            ...(request as ProjectToolsRequests["saveOutlineCandidate"]),
            idempotencyKey: idempotencyKey!,
          },
          options,
        ),
      );
    case "saveScriptCandidate":
      return projectToolsTextMutation(
        await texts.saveScriptCandidate(
          actor,
          {
            ...(request as ProjectToolsRequests["saveScriptCandidate"]),
            idempotencyKey: idempotencyKey!,
          },
          options,
        ),
      );
    case "selectRevision":
      return projectToolsTextMutation(
        await texts.selectRevision(
          actor,
          {
            ...(request as ProjectToolsRequests["selectRevision"]),
            idempotencyKey: idempotencyKey!,
          },
          options,
        ),
      );
    case "setLocked":
      return projectToolsTextMutation(
        await texts.setLocked(
          actor,
          {
            ...(request as ProjectToolsRequests["setLocked"]),
            idempotencyKey: idempotencyKey!,
          },
          options,
        ),
      );
  }
}
