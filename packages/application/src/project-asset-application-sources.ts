import {
  parseProjectTextArtifact,
  parseProjectTextArtifactRevision,
  projectTextDependencyStatus,
  type CreativeProject,
  type ProjectBriefRevision,
  type ProjectOutlineRevision,
  type ProjectScriptRevision,
} from "@crewon/domain";
import { ApplicationError } from "./application-error.ts";
import type { ActorContext } from "./authorization-port.ts";
import type { ContentDigester } from "./application-runtime-ports.ts";
import type { ProjectTextStore } from "./project-text-store-port.ts";
import { creativeOwner } from "./creative-project-application-support.ts";

/** A selected script can itself become stale after the adopted outline changes. */
export async function projectAssetScriptSourceIsCurrent(
  texts: Pick<ProjectTextStore, "loadArtifact" | "loadRevision">,
  digester: ContentDigester,
  actor: ActorContext,
  project: CreativeProject,
  brief: ProjectBriefRevision,
  script: ProjectScriptRevision,
): Promise<boolean> {
  let selectedOutline: ProjectOutlineRevision | null = null;
  if (script.outline !== null) {
    const query = {
      owner: creativeOwner(actor),
      projectId: project.projectId,
      artifactId: script.outline.artifactId,
    };
    const raw = await texts.loadArtifact(query);
    if (raw !== null) {
      const head = parseProjectTextArtifact(raw);
      if (
        head.kind !== "outline" ||
        head.tenantId !== project.tenantId ||
        head.spaceId !== project.spaceId ||
        head.projectId !== project.projectId ||
        head.ownerPrincipalId !== actor.principalId ||
        head.artifactId !== query.artifactId
      )
        invalid();
      if (head.selectedContentRevision !== null) {
        const actual = await texts.loadRevision({
          ...query,
          contentRevision: head.selectedContentRevision,
        });
        if (actual === null) invalid();
        const revision = parseProjectTextArtifactRevision(actual, digester);
        if (
          revision.kind !== "outline" ||
          revision.tenantId !== project.tenantId ||
          revision.spaceId !== project.spaceId ||
          revision.projectId !== project.projectId ||
          revision.artifactId !== head.artifactId ||
          revision.contentRevision !== head.selectedContentRevision
        )
          invalid();
        selectedOutline = revision;
      }
    }
  }
  return (
    projectTextDependencyStatus(script, brief, selectedOutline)
      .dependencyState === "current"
  );
}
function invalid(): never {
  throw new ApplicationError("internal", "project_asset_store_result_invalid");
}
