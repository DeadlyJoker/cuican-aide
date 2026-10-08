import type { ActorContext } from "@crewon/application";
import type { ProjectToolsRequests } from "./project-tools-service-request.ts";
import type { ProjectToolsServiceOwnerDependencies } from "./project-tools-service-owner.ts";
import {
  projectToolsArtifact,
  projectToolsRevision,
  projectToolsView,
} from "./project-tools-service-projection.ts";

type Readers = Pick<ProjectToolsServiceOwnerDependencies, "texts" | "outlines">;

/** Keep the original Node v1 envelope and its dispatch authority. Only the immutable content
 * behind the original outline slot gains mixed v1/v2 support; no structured write port is exposed. */
export async function readProjectToolOutline(
  readers: Readers,
  actor: ActorContext,
  query: ProjectToolsRequests["readOutline"],
) {
  if (!readers.outlines)
    return projectToolsView(await readers.texts.getOutline(actor, query));
  const view = await readers.outlines.getOutline(actor, query);
  if (view === null) return null;
  // The v1 envelope cannot describe this new dependency. Fail explicitly rather than claim
  // that an adopted outline is current or label a Foundation change as a Brief change.
  if (view.staleReasons.includes("foundation-changed"))
    throw new Error("plugin_project_tools_outline_foundation_stale");
  return {
    artifact: projectToolsArtifact(view.artifact),
    selectedRevision:
      view.selectedRevision === null
        ? null
        : projectToolsRevision(view.selectedRevision),
    dependencyState:
      view.selectedRevision === null
        ? ("unselected" as const)
        : view.staleReasons.length
          ? ("stale" as const)
          : ("current" as const),
    staleReasons: view.staleReasons.filter(
      (reason): reason is "brief-changed" => reason === "brief-changed",
    ),
  };
}

export async function readProjectToolRevision(
  readers: Readers,
  actor: ActorContext,
  query: Parameters<Readers["texts"]["getRevision"]>[1],
) {
  if (readers.outlines) {
    const view = await readers.outlines.getOutline(actor, {
      projectId: query.projectId,
    });
    if (view?.artifact.artifactId === query.artifactId)
      return readers.outlines.getRevision(actor, query);
  }
  return readers.texts.getRevision(actor, query);
}

export async function listProjectToolRevisions(
  readers: Readers,
  actor: ActorContext,
  query: ProjectToolsRequests["listRevisions"],
) {
  if (readers.outlines) {
    const view = await readers.outlines.getOutline(actor, {
      projectId: query.projectId,
    });
    if (view?.artifact.artifactId === query.artifactId)
      return readers.outlines.listRevisions(actor, query);
  }
  return readers.texts.listRevisions(actor, query);
}

/** A new legacy save must not replace a structured head with a smaller v1 document.
 * Older CAS commands still reach the original receipt replay path; no receipt is rewritten. */
export async function assertLegacyOutlineCandidateCompatible(
  readers: Readers,
  actor: ActorContext,
  request: ProjectToolsRequests["saveOutlineCandidate"],
) {
  if (!readers.outlines) return;
  const view = await readers.outlines.getOutline(actor, {
    projectId: request.projectId,
  });
  if (
    view?.latestRevision.schemaVersion === "crewon.project-text-revision.v2" &&
    request.expectedArtifactRevision >= view.artifact.revision
  )
    throw new Error(
      "plugin_project_tools_structured_outline_write_unsupported",
    );
}
