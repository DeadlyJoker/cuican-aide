import {
  parseProjectTextArtifact,
  parseProjectTextArtifactRevision,
  projectAssetFailure,
  projectTextDependencyStatus,
  type ProjectBriefRevision,
  type ProjectOutlineRevision,
  type ProjectScriptRevision,
} from "@crewon/domain";
import type { CreativeProjectOwnerScope } from "@crewon/application";
import { creativeStoreDigester } from "./creative-project-store-records.ts";
import {
  assetFilter,
  assetJoin,
  assetOwnerValues,
  assetQuery,
  assetLegacyProject,
  type AssetDialect,
  type AssetPlan,
} from "./project-asset-store-support.ts";

const json = (value: unknown) =>
  typeof value === "string" ? JSON.parse(value) : value;

/** Check actual adopted script and outline under the owning project transaction. */
export function* assertProjectAssetCurrentScriptSource(
  d: AssetDialect,
  owner: CreativeProjectOwnerScope,
  projectId: string,
  script: ProjectScriptRevision,
  brief: ProjectBriefRevision,
  options: Readonly<{
    failureCode:
      | "project_asset_stage_sources_stale"
      | "project_asset_source_stale"
      | "project_media_input_stage_sources_stale";
  }>,
): AssetPlan<void> {
  yield* assetLegacyProject(owner, projectId);
  function stale(): never {
    return projectAssetFailure(options.failureCode);
  }
  const heads = yield* assetQuery(
    d,
    `SELECT c.*,p.owner_principal_id FROM ${d.prefix}project_text_artifacts c ${assetJoin(d)} WHERE ${assetFilter} AND c.artifact_id=$5${d.postgres ? " FOR SHARE" : ""}`,
    [...assetOwnerValues(owner), projectId, script.artifactId],
  );
  if (!heads[0]) stale();
  const head = parseProjectTextArtifact(json(heads[0].record_json));
  if (
    head.kind !== "script" ||
    head.tenantId !== owner.tenantId ||
    head.spaceId !== owner.spaceId ||
    head.projectId !== projectId ||
    head.ownerPrincipalId !== owner.principalId ||
    head.artifactId !== script.artifactId ||
    head.episodeId !== script.episodeId ||
    head.selectedContentRevision !== script.contentRevision ||
    String(heads[0].selected_content_revision) !==
      String(head.selectedContentRevision)
  )
    stale();
  const outlines = yield* assetQuery(
    d,
    `SELECT c.*,p.owner_principal_id FROM ${d.prefix}project_text_artifacts c ${assetJoin(d)} WHERE ${assetFilter} AND c.kind='outline'${d.postgres ? " FOR SHARE" : ""}`,
    [...assetOwnerValues(owner), projectId],
  );
  if (outlines.length > 1) stale();
  let selectedOutline: ProjectOutlineRevision | null = null;
  if (outlines[0]) {
    const outline = parseProjectTextArtifact(json(outlines[0].record_json));
    if (
      outline.kind !== "outline" ||
      outline.tenantId !== owner.tenantId ||
      outline.spaceId !== owner.spaceId ||
      outline.projectId !== projectId ||
      outline.ownerPrincipalId !== owner.principalId ||
      String(outlines[0].selected_content_revision) !==
        String(outline.selectedContentRevision)
    )
      stale();
    if (outline.selectedContentRevision !== null) {
      const revisions = yield* assetQuery(
        d,
        `SELECT c.*,p.owner_principal_id FROM ${d.prefix}project_text_revisions c ${assetJoin(d)} WHERE ${assetFilter} AND c.artifact_id=$5 AND c.content_revision=$6`,
        [
          ...assetOwnerValues(owner),
          projectId,
          outline.artifactId,
          outline.selectedContentRevision,
        ],
      );
      if (!revisions[0]) stale();
      const revision = parseProjectTextArtifactRevision(
        json(revisions[0].record_json),
        creativeStoreDigester,
      );
      if (
        revision.kind !== "outline" ||
        revision.tenantId !== owner.tenantId ||
        revision.spaceId !== owner.spaceId ||
        revision.projectId !== projectId ||
        revision.artifactId !== outline.artifactId ||
        revision.contentRevision !== outline.selectedContentRevision ||
        revisions[0].content_digest !== revision.contentDigest ||
        revisions[0].owner_principal_id !== owner.principalId
      )
        stale();
      selectedOutline = revision;
    }
  }
  if (
    projectTextDependencyStatus(script, brief, selectedOutline)
      .dependencyState !== "current"
  )
    stale();
}
