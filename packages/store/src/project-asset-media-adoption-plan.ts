import {
  ApplicationError,
  projectAssetMediaAdoptionQualification,
  projectAssetMediaReferenceResultRequest,
  projectAssetMediaAdoptionRequestDigest,
  parseProjectAssetMediaAdoptionReceipt,
  createProjectAssetMediaAdoptionReceipt,
  parseProjectAssetMediaAdoptionResult,
  projectAssetMediaImageSourceFromResult,
  mediaInputSame,
  type ProjectAssetMediaAdoptionWrite,
  type ProjectAssetMediaAdoptionResult,
} from "@crewon/application";
import {
  adoptProjectAssetMediaReference,
  projectAssetReferenceOriginDigest,
} from "@crewon/domain";
import { assetMediaAdoptionTable as table } from "./project-asset-media-adoption-schema.ts";
import { qualifyAssetMediaReferencePlan } from "./project-asset-media-reference-plan.ts";
import { loadProjectMediaGenerationContextPlan } from "./project-media-generation-read.ts";
import {
  mediaResultLoadPlan,
  type MediaResultPlan,
} from "./project-media-result-plan.ts";
import { creativeStoreDigester } from "./creative-project-store-records.ts";
import {
  assetQuery,
  assetLock,
  assetOwner,
  assetOwnerValues,
  assetProject,
  assetReference,
  assetJson,
  type AssetDialect,
} from "./project-asset-store-support.ts";

/** One original project transaction: reference + head CAS + immutable receipt, with no media I/O. */
export function* adoptAssetMediaReferencePlan(
  d: AssetDialect,
  input: ProjectAssetMediaAdoptionWrite,
): MediaResultPlan<ProjectAssetMediaAdoptionResult> {
  const r = input.request,
    { actor, query: q } = r,
    owner = assetOwner(actor),
    qualification = projectAssetMediaAdoptionQualification(r),
    requestDigest = projectAssetMediaAdoptionRequestDigest(r),
    receiptKey = [...assetOwnerValues(owner), actor.actorId, q.idempotencyKey];
  yield* assetLock(d, [
    "asset-media-adoption-receipt",
    d.schema,
    ...receiptKey,
  ]);
  yield* assetLock(d, [
    "creative-project-project",
    d.schema,
    actor.tenantId,
    actor.spaceId,
    q.projectId,
  ]);
  const project = yield* assetProject(d, owner, q.projectId);
  const rows = yield* assetQuery(
    d,
    `SELECT * FROM ${d.prefix}${table} WHERE tenant_id=$1 AND space_id=$2 AND owner_principal_id=$3 AND actor_id=$4 AND idempotency_key=$5`,
    receiptKey,
  );
  if (rows.length) {
    if (rows.length !== 1) invalid("receipt_invalid");
    const row = rows[0]!,
      receipt = parseProjectAssetMediaAdoptionReceipt(
        typeof row.record_json === "string"
          ? JSON.parse(row.record_json)
          : row.record_json,
      ),
      expected = {
        tenant_id: actor.tenantId,
        space_id: actor.spaceId,
        owner_principal_id: actor.principalId,
        actor_id: actor.actorId,
        idempotency_key: q.idempotencyKey,
        request_digest: receipt.requestDigest,
        project_id: receipt.request.query.projectId,
        asset_id: receipt.request.query.assetId,
        reference_revision: receipt.result.referenceRevision.referenceRevision,
      };
    if (
      Object.entries(expected).some(
        ([key, value]) => String(row[key]) !== String(value),
      )
    )
      invalid("receipt_invalid");
    if (
      receipt.requestDigest !== requestDigest ||
      !mediaInputSame(receipt.request, r)
    )
      invalid("receipt_conflict");
    const result = receipt.result,
      reference = yield* assetReference(
        d,
        owner,
        q.projectId,
        q.assetId,
        result.referenceRevision.referenceRevision,
      ),
      candidate = yield* mediaResultLoadPlan(
        d,
        projectAssetMediaReferenceResultRequest(qualification),
      ),
      history = yield* loadProjectMediaGenerationContextPlan(d, {
        tenantId: actor.tenantId,
        spaceId: actor.spaceId,
        runId: q.runId,
      });
    if (
      !reference ||
      !mediaInputSame(reference, result.referenceRevision) ||
      !candidate ||
      !history ||
      !mediaInputSame(
        projectAssetMediaImageSourceFromResult(candidate, history.input),
        reference.source,
      )
    )
      invalid("history_changed");
    // Recovery returns the original immutable result after archive/lock/content changes, without selecting it again.
    return parseProjectAssetMediaAdoptionResult(r, {
      ...result,
      disposition: "replayed",
    });
  }
  const qualified = yield* qualifyAssetMediaReferencePlan(d, qualification),
    mutation = adoptProjectAssetMediaReference(
      {
        project,
        actor,
        asset: qualified.asset,
        expectedAssetRevision: q.expectedAssetRevision,
        contentRevision: qualified.content,
        source: qualified.source,
        at: input.at,
      },
      creativeStoreDigester,
    ),
    result = parseProjectAssetMediaAdoptionResult(r, {
      disposition: "committed",
      ...mutation,
    }),
    x = result.referenceRevision,
    a = result.asset;
  yield* assetQuery(
    d,
    `INSERT INTO ${d.prefix}project_asset_reference_revisions(tenant_id,space_id,project_id,asset_id,reference_revision,content_digest,asset_content_revision,asset_content_digest,result_link_digest,record_json) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
    [
      x.tenantId,
      x.spaceId,
      x.projectId,
      x.assetId,
      x.referenceRevision,
      x.contentDigest,
      x.assetContentRevision,
      x.assetContentDigest,
      projectAssetReferenceOriginDigest(x),
      assetJson(x),
    ],
  );
  const updated = yield* assetQuery(
    d,
    `UPDATE ${d.prefix}project_assets SET revision=$6,latest_reference_revision=$7,selected_reference_revision=$7,record_json=$8 WHERE tenant_id=$1 AND space_id=$2 AND project_id=$3 AND asset_id=$4 AND owner_principal_id=$5 AND revision=$9 AND selected_content_revision=$10 AND locked=0 RETURNING revision`,
    [
      a.tenantId,
      a.spaceId,
      a.projectId,
      a.assetId,
      a.ownerPrincipalId,
      a.revision,
      a.latestReferenceRevision,
      assetJson(a),
      q.expectedAssetRevision,
      q.assetContentRevision,
    ],
  );
  if (updated.length !== 1) invalid("revision_conflict");
  const receipt = createProjectAssetMediaAdoptionReceipt(r, result);
  yield* assetQuery(
    d,
    `INSERT INTO ${d.prefix}${table}(tenant_id,space_id,owner_principal_id,actor_id,idempotency_key,request_digest,project_id,asset_id,reference_revision,record_json) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
    [
      ...receiptKey,
      requestDigest,
      q.projectId,
      q.assetId,
      x.referenceRevision,
      assetJson(receipt),
    ],
  );
  return result;
}
function invalid(code: string): never {
  throw new ApplicationError(
    "conflict",
    `project_asset_media_adoption_${code}`,
  );
}
