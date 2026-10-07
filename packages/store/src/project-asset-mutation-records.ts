import type {
  CommitProjectAssetMutationInput,
  ProjectAssetMutationResult,
} from "@crewon/application";
import {
  saveProjectAssetCandidate,
  selectProjectAssetRevision,
  setProjectAssetLocked,
  saveProjectAssetReferenceCandidate,
  selectProjectAssetReferenceRevision,
  projectAssetDependencyStatus,
  projectAssetFailure,
  projectAssetReferenceOriginDigest,
  type ProjectAssetUiIntent,
} from "@crewon/domain";
import { creativeStoreDigester as digester } from "./creative-project-store-records.ts";
import {
  assetJson,
  assetOwner,
  assetOwnerValues,
  assetQuery,
  assetProject,
  assetHead,
  assetBrief,
  assetScript,
  assetContent,
  assetReference,
  assetSelectedScript,
  type AssetDialect,
  type AssetPlan,
} from "./project-asset-store-support.ts";
import { assertProjectAssetCurrentScriptSource } from "./project-asset-script-source.ts";
export function* prepareAssetMutation(
  d: AssetDialect,
  i: CommitProjectAssetMutationInput,
  source?: Readonly<{
    conceptSelection: Parameters<
      typeof saveProjectAssetReferenceCandidate
    >[0]["conceptSelection"];
    resultLink: Parameters<
      typeof saveProjectAssetReferenceCandidate
    >[0]["resultLink"];
  }>,
): AssetPlan<ProjectAssetMutationResult> {
  const c = i.command,
    owner = assetOwner(i.actor),
    p = yield* assetProject(d, owner, c.projectId),
    id = c.assetId ?? i.createdAssetId!;
  const head = yield* assetHead(d, owner, c.projectId, id),
    common = {
      project: p,
      actor: i.actor,
      asset: head,
      expectedAssetRevision: c.expectedAssetRevision,
      at: i.at,
    };
  if (i.kind !== "save-content" && head === null)
    projectAssetFailure("project_asset_not_found");
  if (i.kind === "save-content" && "content" in c) {
    const brief = yield* assetBrief(d, owner, p.projectId, c.briefRevision),
      script =
        c.script === null
          ? null
          : yield* assetScript(
              d,
              owner,
              p.projectId,
              c.script.artifactId,
              c.script.contentRevision,
            );
    const result = saveProjectAssetCandidate(
      {
        ...common,
        assetId: id,
        kind: c.kind,
        brief,
        script,
        content: c.content,
      },
      digester,
    );
    return Object.freeze({
      kind: i.kind,
      disposition: "committed",
      ...result,
      referenceRevision: null,
    });
  }
  if (i.kind === "set-lock" && "locked" in c) {
    const result = setProjectAssetLocked({
      ...common,
      asset: head!,
      locked: c.locked,
    });
    return Object.freeze({
      kind: i.kind,
      disposition: "committed",
      ...result,
      contentRevision: null,
      referenceRevision: null,
    });
  }
  if (i.kind === "select-content" && "contentRevision" in c) {
    const revision = yield* assetContent(
      d,
      owner,
      p.projectId,
      id,
      c.contentRevision,
    );
    if (revision === null)
      projectAssetFailure("project_asset_revision_not_found");
    const latestBrief = yield* assetBrief(
        d,
        owner,
        p.projectId,
        p.latestBriefRevision,
      ),
      selectedScript = yield* assetSelectedScript(
        d,
        owner,
        p.projectId,
        revision,
      );
    if (selectedScript !== null)
      yield* assertProjectAssetCurrentScriptSource(
        d,
        owner,
        p.projectId,
        selectedScript,
        latestBrief,
        { failureCode: "project_asset_source_stale" },
      );
    const result = selectProjectAssetRevision(
      {
        ...common,
        asset: head!,
        contentRevision: revision,
        latestBrief,
        selectedScript,
      },
      digester,
    );
    return Object.freeze({
      kind: i.kind,
      disposition: "committed",
      ...result,
      referenceRevision: null,
    });
  }
  if (i.kind === "save-reference" && "assetContentRevision" in c) {
    if (!source) projectAssetFailure("project_asset_reference_proof_missing");
    const contentRevision = yield* assetContent(
      d,
      owner,
      p.projectId,
      id,
      c.assetContentRevision,
    );
    if (contentRevision === null)
      projectAssetFailure("project_asset_revision_not_found");
    const result = saveProjectAssetReferenceCandidate(
      {
        ...common,
        asset: head!,
        contentRevision,
        ...source,
        expectedConceptSelectionRevision: c.selectionRevision,
      },
      digester,
    );
    return Object.freeze({
      kind: i.kind,
      disposition: "committed",
      ...result,
      contentRevision: null,
    });
  }
  if (i.kind === "select-reference" && "referenceRevision" in c) {
    if (head!.selectedContentRevision === null)
      projectAssetFailure("project_asset_selection_required");
    const selectedContentRevision = yield* assetContent(
      d,
      owner,
      p.projectId,
      id,
      head!.selectedContentRevision,
    );
    if (!selectedContentRevision)
      projectAssetFailure("project_asset_revision_not_found");
    const latestBrief = yield* assetBrief(
        d,
        owner,
        p.projectId,
        p.latestBriefRevision,
      ),
      selectedScript = yield* assetSelectedScript(
        d,
        owner,
        p.projectId,
        selectedContentRevision,
      );
    if (selectedScript !== null)
      yield* assertProjectAssetCurrentScriptSource(
        d,
        owner,
        p.projectId,
        selectedScript,
        latestBrief,
        { failureCode: "project_asset_source_stale" },
      );
    if (
      projectAssetDependencyStatus(
        selectedContentRevision,
        latestBrief,
        selectedScript,
      ).dependencyState !== "current"
    )
      projectAssetFailure("project_asset_source_stale");
    const referenceRevision = yield* assetReference(
      d,
      owner,
      p.projectId,
      id,
      c.referenceRevision,
    );
    if (!referenceRevision)
      projectAssetFailure("project_asset_reference_not_found");
    const result = selectProjectAssetReferenceRevision(
      { ...common, asset: head!, selectedContentRevision, referenceRevision },
      digester,
    );
    return Object.freeze({
      kind: i.kind,
      disposition: "committed",
      ...result,
      contentRevision: null,
    });
  }
  return projectAssetFailure("project_asset_command_invalid");
}
export function* persistAssetMutation(
  d: AssetDialect,
  i: CommitProjectAssetMutationInput,
  r: ProjectAssetMutationResult,
  intent: ProjectAssetUiIntent | null = null,
): AssetPlan<void> {
  const a = r.asset,
    head = [
      a.tenantId,
      a.spaceId,
      a.projectId,
      a.assetId,
      a.ownerPrincipalId,
      a.kind,
      a.revision,
      a.latestContentRevision,
      a.selectedContentRevision,
      a.latestReferenceRevision,
      a.selectedReferenceRevision,
      a.locked ? 1 : 0,
      assetJson(a),
    ];
  if (i.command.expectedAssetRevision === 0)
    yield* assetQuery(
      d,
      `INSERT INTO ${d.prefix}project_assets(tenant_id,space_id,project_id,asset_id,owner_principal_id,kind,revision,latest_content_revision,selected_content_revision,latest_reference_revision,selected_reference_revision,locked,record_json) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
      head,
    );
  else {
    const rows = yield* assetQuery(
      d,
      `UPDATE ${d.prefix}project_assets SET revision=$7,latest_content_revision=$8,selected_content_revision=$9,latest_reference_revision=$10,selected_reference_revision=$11,locked=$12,record_json=$13 WHERE tenant_id=$1 AND space_id=$2 AND project_id=$3 AND asset_id=$4 AND owner_principal_id=$5 AND kind=$6 AND revision=$14 RETURNING revision`,
      [...head, i.command.expectedAssetRevision],
    );
    if (rows.length !== 1)
      projectAssetFailure("project_asset_revision_conflict");
  }
  if (i.kind === "save-content") {
    const c = r.contentRevision!;
    yield* assetQuery(
      d,
      `INSERT INTO ${d.prefix}project_asset_revisions(tenant_id,space_id,project_id,asset_id,content_revision,content_digest,brief_revision,brief_content_digest,script_artifact_id,script_content_revision,script_content_digest,record_json) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
      [
        c.tenantId,
        c.spaceId,
        c.projectId,
        c.assetId,
        c.contentRevision,
        c.contentDigest,
        c.brief.briefRevision,
        c.brief.contentDigest,
        c.script?.artifactId ?? null,
        c.script?.contentRevision ?? null,
        c.script?.contentDigest ?? null,
        assetJson(c),
      ],
    );
  }
  if (i.kind === "save-reference") {
    const x = r.referenceRevision!;
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
  }
  const body = {
      schemaVersion: "crewon.project-asset-receipt.v1",
      actor: i.actor,
      kind: i.kind,
      receipt: i.receipt,
      command: i.command,
      result: r,
    },
    record = { ...body, contentDigest: digester.sha256(assetJson(body)) };
  yield* assetQuery(
    d,
    `INSERT INTO ${d.prefix}project_asset_mutation_receipts(tenant_id,space_id,principal_id,actor_id,kind,idempotency_key,request_digest,project_id,ui_intent_id,ui_intent_scope_digest,result_json) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
    [
      ...assetOwnerValues(assetOwner(i.actor)),
      i.actor.actorId,
      i.kind,
      i.receipt.idempotencyKey,
      i.receipt.requestDigest,
      a.projectId,
      intent?.intentId ?? null,
      intent === null ? null : digester.sha256(assetJson(intent.scope)),
      assetJson(record),
    ],
  );
}
