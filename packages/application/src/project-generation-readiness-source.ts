import {
  validateProjectGenerationSource,
  type ProjectGenerationReference,
} from "@crewon/domain";
import { ApplicationError } from "./application-error.ts";
import type { ActorContext } from "./authorization-port.ts";
import type { ContentDigester } from "./application-runtime-ports.ts";
import type { ProjectGenerationApplicationPorts } from "./project-generation-application-support.ts";
import {
  checkedCreativeAsset,
  checkedCreativeAssetRevision,
  checkedCreativeBrief,
  checkedCreativeProject,
  creativeOwner,
  creativeProjectUseCase,
} from "./creative-project-application-support.ts";

/** Exact saved source only. Store integrity and authorization errors are never a readiness status. */
export async function readProjectGenerationReadinessSource(
  input: Readonly<{
    actor: ActorContext;
    reference: ProjectGenerationReference;
    projects: ProjectGenerationApplicationPorts;
    digester: ContentDigester;
  }>,
) {
  return creativeProjectUseCase(async () => {
    const { actor, reference, projects, digester } = input;
    const owner = creativeOwner(actor);
    const rawProject = await projects.store.loadProject({
      owner,
      projectId: reference.projectId,
    });
    if (rawProject === null)
      throw new ApplicationError("notFound", "creative_project_not_found");
    const project = checkedCreativeProject(
      rawProject,
      owner,
      reference.projectId,
    );
    const locator = {
      owner,
      projectId: reference.projectId,
      assetId: reference.assetId,
    };
    const rawAsset = await projects.store.loadConceptAsset(locator);
    if (rawAsset === null)
      throw new ApplicationError(
        "notFound",
        "creative_project_asset_not_found",
      );
    const asset = checkedCreativeAsset(rawAsset, project, reference.assetId);
    const rawRevision = await projects.store.loadConceptRevision({
      ...locator,
      assetRevision: reference.assetRevision,
    });
    if (rawRevision === null)
      throw new ApplicationError(
        "notFound",
        "creative_project_asset_revision_not_found",
      );
    const assetRevision = checkedCreativeAssetRevision(
      rawRevision,
      project,
      digester,
      reference.assetId,
      {
        assetRevision: reference.assetRevision,
        latestAssetRevision: asset.latestAssetRevision,
      },
    );
    const rawBrief = await projects.store.loadBrief({
      owner,
      projectId: reference.projectId,
      briefRevision: assetRevision.briefRevision,
    });
    if (rawBrief === null)
      throw new ApplicationError(
        "notFound",
        "creative_project_brief_not_found",
      );
    const brief = checkedCreativeBrief(
      rawBrief,
      project,
      digester,
      assetRevision.briefRevision,
    );
    return validateProjectGenerationSource(
      { actor, reference, project, asset, assetRevision, brief },
      digester,
    );
  });
}

export function isProjectGenerationReadinessInputUnavailable(
  error: unknown,
): boolean {
  return (
    error instanceof ApplicationError &&
    [
      "creative_project_not_found",
      "creative_project_asset_not_found",
      "creative_project_asset_revision_not_found",
      "creative_project_brief_not_found",
      "creative_project_revision_conflict",
      "creative_project_asset_revision_conflict",
      "creative_project_archived",
      "creative_project_brief_reference_invalid",
    ].includes(error.code)
  );
}
