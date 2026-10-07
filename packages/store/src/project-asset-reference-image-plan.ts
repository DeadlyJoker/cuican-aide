import {
  parseProjectAssetReferenceImageQuery,
  type ActorContext,
  type ProjectAssetReferenceImageQuery,
  type ProjectAssetReferenceImageSource,
  type ProjectGenerationImageResultVerifier,
} from "@crewon/application";
import {
  validateCreativeProjectActor,
  projectAssetInputFields,
  projectAssetDependencyStatus,
  projectAssetReferenceState,
  projectAssetFailure,
  parseExtensionConfiguration,
  assertProjectAssetRevisionIdentity,
  assertProjectAssetReferenceRevisionIdentity,
} from "@crewon/domain";
import { creativeStoreDigester } from "./creative-project-store-records.ts";
import {
  assetOwner,
  assetLock,
  assetProject,
  assetHead,
  assetContent,
  assetReference,
  assetBrief,
  assetSelectedScript,
  assetQuery,
  type AssetDialect,
  type AssetPlan,
} from "./project-asset-store-support.ts";
import { assertProjectAssetCurrentScriptSource } from "./project-asset-script-source.ts";
import { verifyProjectAssetSavedImageSource } from "./project-asset-image-source.ts";

export function captureAssetReferenceImageRead(
  input: unknown,
): Readonly<{ actor: ActorContext; query: ProjectAssetReferenceImageQuery }> {
  const v = projectAssetInputFields(input, ["actor", "query"]);
  return Object.freeze({
    actor: validateCreativeProjectActor(
      projectAssetInputFields(v.actor, [
        "tenantId",
        "spaceId",
        "principalId",
        "actorId",
      ]),
    ),
    query: parseProjectAssetReferenceImageQuery(v.query),
  });
}

/** One owning-project transaction and one parent connection; reprove the saved original result. */
export function* loadAssetReferenceImagePlan(
  d: AssetDialect,
  input: ReturnType<typeof captureAssetReferenceImageRead>,
  verifier: ProjectGenerationImageResultVerifier | undefined,
): AssetPlan<ProjectAssetReferenceImageSource> {
  const { asset, content, reference } =
    yield* loadSelectedAssetReferenceRecords(d, input);
  const { actor } = input;
  const resultLink = yield* verifyProjectAssetSavedImageSource(
    d,
    actor,
    reference,
    verifier,
  );
  const rows = yield* assetQuery(
    d,
    `SELECT * FROM ${d.prefix}extension_configurations WHERE tenant_id=$1 AND space_id=$2 AND plugin_id=$3 AND revision=$4`,
    [
      actor.tenantId,
      actor.spaceId,
      resultLink.pluginId,
      resultLink.configurationRevision,
    ],
  );
  const row = rows[0];
  if (!row) projectAssetFailure("project_asset_reference_proof_missing");
  const configuration = parseExtensionConfiguration(
    typeof row.configuration_json === "string"
      ? JSON.parse(row.configuration_json)
      : row.configuration_json,
    creativeStoreDigester,
  );
  const fields = {
    tenant_id: configuration.tenantId,
    space_id: configuration.spaceId,
    plugin_id: configuration.pluginId,
    revision: configuration.revision,
  };
  if (
    Object.entries(fields).some(([k, v]) => String(row[k]) !== String(v)) ||
    configuration.tenantId !== actor.tenantId ||
    configuration.spaceId !== actor.spaceId ||
    configuration.pluginId !== resultLink.pluginId ||
    configuration.pluginVersion !== resultLink.pluginVersion ||
    configuration.revision !== resultLink.configurationRevision ||
    configuration.contentDigest !== resultLink.configurationDigest
  )
    projectAssetFailure("project_asset_reference_proof_changed");
  return Object.freeze({
    asset,
    content,
    reference,
    resultLink,
    configuration,
  });
}

/** Shared original project/asset validation, before branching on the stored reference version. */
export function* loadSelectedAssetReferenceRecords(
  d: AssetDialect,
  input: ReturnType<typeof captureAssetReferenceImageRead>,
): AssetPlan<
  Pick<ProjectAssetReferenceImageSource, "asset" | "content" | "reference">
> {
  const { actor, query: q } = input,
    owner = assetOwner(actor);
  yield* assetLock(d, [
    "creative-project-project",
    d.schema,
    actor.tenantId,
    actor.spaceId,
    q.projectId,
  ]);
  const project = yield* assetProject(d, owner, q.projectId);
  if (project.state !== "active")
    projectAssetFailure("creative_project_archived");
  const asset = yield* assetHead(d, owner, q.projectId, q.assetId);
  if (asset === null) projectAssetFailure("project_asset_not_found");
  if (
    asset.kind !== q.kind ||
    asset.revision !== q.expectedAssetRevision ||
    asset.selectedContentRevision !== q.contentRevision ||
    asset.selectedReferenceRevision !== q.referenceRevision
  )
    projectAssetFailure("project_asset_reference_image_changed");
  const content = yield* assetContent(
      d,
      owner,
      q.projectId,
      q.assetId,
      q.contentRevision,
    ),
    reference = yield* assetReference(
      d,
      owner,
      q.projectId,
      q.assetId,
      q.referenceRevision,
    );
  if (content === null || reference === null)
    projectAssetFailure("project_asset_reference_proof_missing");
  assertProjectAssetRevisionIdentity(asset, content);
  assertProjectAssetReferenceRevisionIdentity(asset, reference);
  const brief = yield* assetBrief(
      d,
      owner,
      q.projectId,
      project.latestBriefRevision,
    ),
    script = yield* assetSelectedScript(d, owner, q.projectId, content);
  if (
    projectAssetDependencyStatus(content, brief, script).dependencyState !==
      "current" ||
    projectAssetReferenceState(asset, content, reference) !== "current"
  )
    projectAssetFailure("project_asset_source_stale");
  if (script !== null)
    yield* assertProjectAssetCurrentScriptSource(
      d,
      owner,
      q.projectId,
      script,
      brief,
      { failureCode: "project_asset_source_stale" },
    );
  return Object.freeze({ asset, content, reference });
}
