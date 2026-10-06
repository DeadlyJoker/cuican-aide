import type {
  ActorContext,
  CreativeProjectOwnerScope,
  ProjectGenerationImageResultVerifier,
} from "@crewon/application";
import {
  extensionCanonicalJson,
  parseOperationResultLink,
  projectAssetFailure,
  type ProjectAssetReferenceRevision,
  type OperationResultLink,
} from "@crewon/domain";
import {
  creativeStoreDigester,
  creativeStoreRecord,
} from "./creative-project-store-records.ts";
import {
  loadConceptSelectionPointerPlan,
  loadConceptSelectionResultPlan,
  verifyConceptSelectionSourcePlan,
  type SelectionDialect,
  type SelectionPlan,
} from "./concept-selection-store-support.ts";

const ownerFor = (a: ActorContext): CreativeProjectOwnerScope => ({
  tenantId: a.tenantId,
  spaceId: a.spaceId,
  principalId: a.principalId,
});
function verifierRequired(
  verifier: ProjectGenerationImageResultVerifier | undefined,
): ProjectGenerationImageResultVerifier {
  if (verifier === undefined)
    projectAssetFailure("project_asset_reference_verifier_unavailable");
  return verifier;
}
export function* loadProjectAssetCurrentImageSource(
  d: SelectionDialect,
  actor: ActorContext,
  input: {
    projectId: string;
    conceptAssetId: string;
    selectionRevision: number;
  },
  verifier: ProjectGenerationImageResultVerifier | undefined,
) {
  const adapter = verifierRequired(verifier),
    owner = ownerFor(actor);
  const selection = yield* loadConceptSelectionPointerPlan(
    d,
    owner,
    input.projectId,
    input.conceptAssetId,
  );
  if (!selection || selection.selectionRevision !== input.selectionRevision)
    projectAssetFailure("project_asset_concept_selection_changed");
  const link = yield* loadConceptSelectionResultPlan(d, owner, selection);
  yield* proveLink(d, actor, link, adapter);
  return { conceptSelection: selection, resultLink: link };
}
function* proveLink(
  d: SelectionDialect,
  actor: ActorContext,
  link: OperationResultLink,
  verifier: ProjectGenerationImageResultVerifier,
): SelectionPlan<void> {
  const actual = yield* verifyConceptSelectionSourcePlan(
    d,
    actor,
    link.reference,
    link.operationId,
    link.operationRevision,
    verifier,
    link.image.resultIndex,
  );
  if (extensionCanonicalJson(actual) !== extensionCanonicalJson(link))
    projectAssetFailure("project_asset_reference_proof_changed");
}
/** Replays prove the frozen original result, never the newly selected concept image. */
export function* verifyProjectAssetSavedImageSource(
  d: SelectionDialect,
  actor: ActorContext,
  reference: ProjectAssetReferenceRevision,
  verifier: ProjectGenerationImageResultVerifier | undefined,
): SelectionPlan<OperationResultLink> {
  const adapter = verifierRequired(verifier),
    s = reference.source;
  const values = [
    actor.tenantId,
    actor.spaceId,
    actor.principalId,
    reference.projectId,
    s.conceptAssetId,
    s.resultLinkDigest,
  ];
  const sql = `SELECT * FROM ${d.prefix}creative_operation_result_links WHERE tenant_id=$1 AND space_id=$2 AND owner_principal_id=$3 AND project_id=$4 AND asset_id=$5 AND content_digest=$6`;
  const rows = yield {
    sql: d.postgres ? sql : sql.replaceAll(/\$[1-6]/gu, "?"),
    values,
  };
  const row = rows[0];
  if (!row) projectAssetFailure("project_asset_reference_proof_missing");
  const link = parseOperationResultLink(
    creativeStoreRecord(
      typeof row.record_json === "string"
        ? JSON.parse(row.record_json)
        : row.record_json,
    ),
    creativeStoreDigester,
  );
  const fields = {
    tenant_id: link.tenantId,
    space_id: link.spaceId,
    owner_principal_id: link.ownerPrincipalId,
    project_id: link.projectId,
    asset_id: link.reference.assetId,
    asset_revision: link.reference.assetRevision,
    source_run_id: link.sourceRunId,
    source_binding_digest: link.sourceBindingDigest,
    operation_id: link.operationId,
    operation_revision: link.operationRevision,
    result_index: link.image.resultIndex,
    content_digest: link.contentDigest,
  };
  if (
    Object.entries(fields).some(([k, v]) => String(row[k]) !== String(v)) ||
    link.projectId !== reference.projectId ||
    link.tenantId !== actor.tenantId ||
    link.spaceId !== actor.spaceId ||
    link.ownerPrincipalId !== actor.principalId
  )
    projectAssetFailure("project_asset_reference_proof_changed");
  const expected = {
    conceptAssetId: link.reference.assetId,
    conceptAssetRevision: link.reference.assetRevision,
    resultLinkDigest: link.contentDigest,
    generationLinkDigest: link.generationLinkDigest,
    sourceRunId: link.sourceRunId,
    sourceBindingDigest: link.sourceBindingDigest,
    pluginId: link.pluginId,
    pluginVersion: link.pluginVersion,
    packageDigest: link.packageDigest,
    configurationRevision: link.configurationRevision,
    configurationDigest: link.configurationDigest,
    operationId: link.operationId,
    operationRevision: link.operationRevision,
    operationDigest: link.operationDigest,
    rawResultDigest: link.rawResultDigest,
    resultIndex: link.image.resultIndex,
  };
  if (Object.entries(expected).some(([k, v]) => s[k as keyof typeof s] !== v))
    projectAssetFailure("project_asset_reference_proof_changed");
  yield* proveLink(d, actor, link, adapter);
  return link;
}
