import {
  checkedProjectAssetMutationResult,
  parseProjectAssetMutationCommand,
  projectAssetMutationReceipt,
  assertProjectAssetUiMutationCommand,
  assertProjectAssetRunMutationCommand,
  type ActorContext,
  type CreativeProjectOwnerScope,
  type CommitProjectAssetMutationInput,
  type ProjectAssetMutationIdentity,
  type ProjectAssetMutationResult,
  type ProjectAssetStore,
  type ProjectAssetCommitAuthority,
} from "@crewon/application";
import {
  extensionCanonicalJson,
  validateCreativeProjectActor,
  projectAssetId,
  projectAssetKind,
  projectAssetRecord,
  projectAssetRevision,
  projectAssetTimestamp,
  projectAssetFailure,
  parseProjectAsset,
  parseProjectAssetRevision,
  parseProjectAssetReferenceRevision,
  parseProjectTextArtifactRevision,
  parseProjectTextArtifact,
  type ProjectAsset,
  type ProjectAssetRevision,
  type ProjectAssetReferenceRevision,
  type ProjectScriptRevision,
} from "@crewon/domain";
import {
  creativeStoreDigester as digester,
  creativeStoreRecord,
  decodeCreativeProject,
  decodeCreativeBrief,
} from "./creative-project-store-records.ts";

export type AssetSql = Readonly<{
  sql: string;
  values: readonly (string | number | null)[];
}>;
export type AssetRows = readonly Record<string, unknown>[];
export type AssetPlan<T> = Generator<AssetSql, T, AssetRows>;
export type AssetDialect = Readonly<{
  postgres: boolean;
  schema: string;
  prefix: string;
}>;
export type AssetInput<K extends keyof ProjectAssetStore> = Parameters<
  Extract<ProjectAssetStore[K], (...args: never[]) => unknown>
>[0];
export const assetJson = (value: unknown) => extensionCanonicalJson(value);
const json = (value: unknown) =>
  creativeStoreRecord(typeof value === "string" ? JSON.parse(value) : value);
export const assetOwner = (actor: ActorContext): CreativeProjectOwnerScope =>
  Object.freeze({
    tenantId: actor.tenantId,
    spaceId: actor.spaceId,
    principalId: actor.principalId,
  });
export const assetOwnerValues = (owner: CreativeProjectOwnerScope) => [
  owner.tenantId,
  owner.spaceId,
  owner.principalId,
];
const same = (
  row: Record<string, unknown>,
  fields: Record<string, unknown>,
) => {
  if (
    Object.entries(fields).some(([k, v]) =>
      v === null ? row[k] !== null : String(row[k]) !== String(v),
    )
  )
    projectAssetFailure("project_asset_record_index_mismatch");
};
const scopeFields = (r: {
  tenantId: string;
  spaceId: string;
  projectId: string;
  assetId: string;
}) => ({
  tenant_id: r.tenantId,
  space_id: r.spaceId,
  project_id: r.projectId,
  asset_id: r.assetId,
});
export function* assetQuery(
  d: AssetDialect,
  sql: string,
  values: readonly (string | number | null)[] = [],
): AssetPlan<AssetRows> {
  if (d.postgres) return yield { sql, values };
  const ordered: (string | number | null)[] = [];
  return yield {
    sql: sql.replaceAll(/\$([0-9]+)/gu, (_m, index: string) => {
      const value = values[Number(index) - 1];
      if (value === undefined) throw new Error("project_asset_sql_invalid");
      ordered.push(value);
      return "?";
    }),
    values: ordered,
  };
}
export function* assetLock(
  d: AssetDialect,
  key: readonly unknown[],
): AssetPlan<void> {
  if (d.postgres)
    yield* assetQuery(
      d,
      "SELECT pg_advisory_xact_lock(hashtextextended($1,0))",
      [JSON.stringify(key)],
    );
}
export function decodeAsset(
  row: Record<string, unknown> | undefined,
  owner: CreativeProjectOwnerScope,
  projectId: string,
): ProjectAsset | null {
  if (!row) return null;
  const a = parseProjectAsset(json(row.record_json));
  same(row, {
    ...scopeFields(a),
    owner_principal_id: a.ownerPrincipalId,
    kind: a.kind,
    revision: a.revision,
    latest_content_revision: a.latestContentRevision,
    selected_content_revision: a.selectedContentRevision,
    latest_reference_revision: a.latestReferenceRevision,
    selected_reference_revision: a.selectedReferenceRevision,
    locked: a.locked ? 1 : 0,
  });
  if (
    a.tenantId !== owner.tenantId ||
    a.spaceId !== owner.spaceId ||
    a.ownerPrincipalId !== owner.principalId ||
    a.projectId !== projectId
  )
    projectAssetFailure("project_asset_owner_mismatch");
  return a;
}
export function decodeAssetRevision(
  row: Record<string, unknown> | undefined,
  owner: CreativeProjectOwnerScope,
  projectId: string,
  assetId: string,
): ProjectAssetRevision | null {
  if (!row) return null;
  const r = parseProjectAssetRevision(json(row.record_json), digester);
  same(row, {
    ...scopeFields(r),
    content_revision: r.contentRevision,
    content_digest: r.contentDigest,
    brief_revision: r.brief.briefRevision,
    brief_content_digest: r.brief.contentDigest,
    script_artifact_id: r.script?.artifactId ?? null,
    script_content_revision: r.script?.contentRevision ?? null,
    script_content_digest: r.script?.contentDigest ?? null,
  });
  if (
    row.owner_principal_id !== owner.principalId ||
    r.tenantId !== owner.tenantId ||
    r.spaceId !== owner.spaceId ||
    r.projectId !== projectId ||
    r.assetId !== assetId
  )
    projectAssetFailure("project_asset_owner_mismatch");
  return r;
}
export function decodeAssetReference(
  row: Record<string, unknown> | undefined,
  owner: CreativeProjectOwnerScope,
  projectId: string,
  assetId: string,
): ProjectAssetReferenceRevision | null {
  if (!row) return null;
  const r = parseProjectAssetReferenceRevision(json(row.record_json), digester);
  same(row, {
    ...scopeFields(r),
    reference_revision: r.referenceRevision,
    content_digest: r.contentDigest,
    asset_content_revision: r.assetContentRevision,
    asset_content_digest: r.assetContentDigest,
    result_link_digest: r.source.resultLinkDigest,
  });
  if (
    r.ownerPrincipalId !== owner.principalId ||
    r.tenantId !== owner.tenantId ||
    r.spaceId !== owner.spaceId ||
    r.projectId !== projectId ||
    r.assetId !== assetId
  )
    projectAssetFailure("project_asset_owner_mismatch");
  return r;
}
export const assetFilter =
  "p.tenant_id=$1 AND p.space_id=$2 AND p.owner_principal_id=$3 AND p.project_id=$4";
export const assetJoin = (d: AssetDialect) =>
  `JOIN ${d.prefix}creative_projects p ON p.tenant_id=c.tenant_id AND p.space_id=c.space_id AND p.project_id=c.project_id`;
export function* assetProject(
  d: AssetDialect,
  owner: CreativeProjectOwnerScope,
  id: string,
) {
  const rows = yield* assetQuery(
    d,
    `SELECT p.* FROM ${d.prefix}creative_projects p WHERE ${assetFilter}`,
    [...assetOwnerValues(owner), id],
  );
  const p = decodeCreativeProject(rows[0], owner, id);
  if (p === null) projectAssetFailure("creative_project_not_found");
  return p;
}
export function* assetHead(
  d: AssetDialect,
  owner: CreativeProjectOwnerScope,
  id: string,
  assetId: string,
) {
  const rows = yield* assetQuery(
    d,
    `SELECT c.* FROM ${d.prefix}project_assets c ${assetJoin(d)} WHERE ${assetFilter} AND c.asset_id=$5`,
    [...assetOwnerValues(owner), id, assetId],
  );
  return decodeAsset(rows[0], owner, id);
}
export function* assetContent(
  d: AssetDialect,
  owner: CreativeProjectOwnerScope,
  id: string,
  assetId: string,
  n: number,
) {
  const rows = yield* assetQuery(
    d,
    `SELECT c.*,p.owner_principal_id FROM ${d.prefix}project_asset_revisions c ${assetJoin(d)} WHERE ${assetFilter} AND c.asset_id=$5 AND c.content_revision=$6`,
    [...assetOwnerValues(owner), id, assetId, n],
  );
  return decodeAssetRevision(rows[0], owner, id, assetId);
}
export function* assetReference(
  d: AssetDialect,
  owner: CreativeProjectOwnerScope,
  id: string,
  assetId: string,
  n: number,
) {
  const rows = yield* assetQuery(
    d,
    `SELECT c.*,p.owner_principal_id FROM ${d.prefix}project_asset_reference_revisions c ${assetJoin(d)} WHERE ${assetFilter} AND c.asset_id=$5 AND c.reference_revision=$6`,
    [...assetOwnerValues(owner), id, assetId, n],
  );
  return decodeAssetReference(rows[0], owner, id, assetId);
}
export function* assetBrief(
  d: AssetDialect,
  owner: CreativeProjectOwnerScope,
  id: string,
  n: number,
) {
  const rows = yield* assetQuery(
    d,
    `SELECT c.*,p.owner_principal_id FROM ${d.prefix}creative_project_briefs c ${assetJoin(d)} WHERE ${assetFilter} AND c.brief_revision=$5`,
    [...assetOwnerValues(owner), id, n],
  );
  const b = decodeCreativeBrief(rows[0], owner, id);
  if (b === null) projectAssetFailure("creative_project_brief_not_found");
  return b;
}
export function* assetScript(
  d: AssetDialect,
  owner: CreativeProjectOwnerScope,
  id: string,
  artifactId: string,
  n: number,
): AssetPlan<ProjectScriptRevision> {
  const rows = yield* assetQuery(
    d,
    `SELECT c.*,p.owner_principal_id FROM ${d.prefix}project_text_revisions c ${assetJoin(d)} WHERE ${assetFilter} AND c.artifact_id=$5 AND c.content_revision=$6`,
    [...assetOwnerValues(owner), id, artifactId, n],
  );
  const row = rows[0];
  if (!row) projectAssetFailure("project_asset_script_not_found");
  const r = parseProjectTextArtifactRevision(
    typeof row.record_json === "string"
      ? JSON.parse(row.record_json)
      : row.record_json,
    digester,
  );
  if (
    r.kind !== "script" ||
    row.owner_principal_id !== owner.principalId ||
    r.tenantId !== owner.tenantId ||
    r.spaceId !== owner.spaceId ||
    r.projectId !== id ||
    r.artifactId !== artifactId ||
    r.contentRevision !== n ||
    String(row.content_revision) !== String(n) ||
    row.content_digest !== r.contentDigest
  )
    projectAssetFailure("project_asset_script_source_invalid");
  return r;
}
export function* assetSelectedScript(
  d: AssetDialect,
  owner: CreativeProjectOwnerScope,
  id: string,
  r: ProjectAssetRevision,
): AssetPlan<ProjectScriptRevision | null> {
  if (r.script === null) return null;
  const rows = yield* assetQuery(
    d,
    `SELECT c.*,p.owner_principal_id FROM ${d.prefix}project_text_artifacts c ${assetJoin(d)} WHERE ${assetFilter} AND c.artifact_id=$5`,
    [...assetOwnerValues(owner), id, r.script.artifactId],
  );
  if (!rows[0]) projectAssetFailure("project_asset_script_not_found");
  const h = parseProjectTextArtifact(json(rows[0].record_json));
  if (
    h.kind !== "script" ||
    h.ownerPrincipalId !== owner.principalId ||
    h.tenantId !== owner.tenantId ||
    h.spaceId !== owner.spaceId ||
    h.projectId !== id ||
    h.artifactId !== r.script.artifactId ||
    String(rows[0].selected_content_revision) !==
      String(h.selectedContentRevision)
  )
    projectAssetFailure("project_asset_script_source_invalid");
  return h.selectedContentRevision === null
    ? null
    : yield* assetScript(d, owner, id, h.artifactId, h.selectedContentRevision);
}
export function captureAssetIdentity(
  input: ProjectAssetMutationIdentity,
): ProjectAssetMutationIdentity {
  const v = projectAssetRecord(input, ["actor", "kind", "receipt"]),
    actor = validateCreativeProjectActor(v.actor),
    receipt = projectAssetRecord(v.receipt, [
      "idempotencyKey",
      "requestDigest",
    ]);
  if (
    ![
      "save-content",
      "select-content",
      "set-lock",
      "save-reference",
      "select-reference",
    ].includes(String(v.kind))
  )
    projectAssetFailure("project_asset_command_invalid");
  return Object.freeze({
    actor,
    kind: v.kind as ProjectAssetMutationIdentity["kind"],
    receipt: Object.freeze({
      idempotencyKey: projectAssetId(receipt.idempotencyKey),
      requestDigest:
        typeof receipt.requestDigest === "string"
          ? receipt.requestDigest
          : projectAssetFailure("project_asset_receipt_conflict"),
    }),
  });
}
export function captureAssetCommit(
  input: CommitProjectAssetMutationInput,
): CommitProjectAssetMutationInput {
  const v = projectAssetRecord(input, [
      "actor",
      "kind",
      "receipt",
      "command",
      "at",
      "createdAssetId",
    ]),
    identity = captureAssetIdentity({
      actor: v.actor,
      kind: v.kind,
      receipt: v.receipt,
    } as ProjectAssetMutationIdentity),
    command = parseProjectAssetMutationCommand(identity.kind, v.command);
  const expected = projectAssetMutationReceipt(
    identity.actor,
    identity.kind,
    command,
    digester,
  );
  if (assetJson(expected) !== assetJson(identity.receipt))
    projectAssetFailure("project_asset_receipt_conflict");
  const createdAssetId =
    v.createdAssetId === null ? null : projectAssetId(v.createdAssetId);
  if (
    (createdAssetId !== null) !==
    (identity.kind === "save-content" && command.assetId === null)
  )
    projectAssetFailure("project_asset_creation_invalid");
  return Object.freeze({
    ...identity,
    command,
    at: projectAssetTimestamp(v.at),
    createdAssetId,
  });
}
export function assertAssetCommand(
  authority: ProjectAssetCommitAuthority | undefined,
  input: CommitProjectAssetMutationInput,
): void {
  assertProjectAssetUiMutationCommand(
    authority,
    input.actor,
    input.kind,
    input.command,
    digester,
  );
  assertProjectAssetRunMutationCommand(
    authority,
    input.actor,
    input.kind,
    input.command,
    digester,
  );
}
export function* assetReceipt(
  d: AssetDialect,
  identity: ProjectAssetMutationIdentity,
): AssetPlan<ProjectAssetMutationResult | null> {
  const a = identity.actor,
    rows = yield* assetQuery(
      d,
      `SELECT * FROM ${d.prefix}project_asset_mutation_receipts WHERE tenant_id=$1 AND space_id=$2 AND principal_id=$3 AND actor_id=$4 AND kind=$5 AND idempotency_key=$6`,
      [
        a.tenantId,
        a.spaceId,
        a.principalId,
        a.actorId,
        identity.kind,
        identity.receipt.idempotencyKey,
      ],
    );
  const row = rows[0];
  if (!row) return null;
  const e = creativeStoreRecord(json(row.result_json), [
      "schemaVersion",
      "actor",
      "kind",
      "receipt",
      "command",
      "result",
      "contentDigest",
    ]),
    { contentDigest, ...body } = e;
  if (
    e.schemaVersion !== "crewon.project-asset-receipt.v1" ||
    digester.sha256(assetJson(body)) !== contentDigest ||
    assetJson(e.actor) !== assetJson(a) ||
    e.kind !== identity.kind ||
    assetJson(e.receipt) !== assetJson(identity.receipt)
  )
    projectAssetFailure("project_asset_receipt_conflict");
  const command = parseProjectAssetMutationCommand(identity.kind, e.command),
    receipt = projectAssetMutationReceipt(a, identity.kind, command, digester);
  if (assetJson(receipt) !== assetJson(identity.receipt))
    projectAssetFailure("project_asset_receipt_conflict");
  same(row, {
    tenant_id: a.tenantId,
    space_id: a.spaceId,
    principal_id: a.principalId,
    actor_id: a.actorId,
    kind: identity.kind,
    idempotency_key: receipt.idempotencyKey,
    request_digest: receipt.requestDigest,
    project_id: command.projectId,
  });
  const project = yield* assetProject(d, assetOwner(a), command.projectId);
  return Object.freeze({
    ...checkedProjectAssetMutationResult(
      e.result,
      a,
      project,
      identity.kind,
      command,
      digester,
    ),
    disposition: "replayed",
  });
}
