import type { CreativeProjectOwnerScope } from "@crewon/application";
import {
  projectAssetId,
  projectAssetKind,
  projectAssetRecord,
  projectAssetRevision,
  projectAssetFailure,
} from "@crewon/domain";
import {
  assetQuery,
  assetOwnerValues,
  assetFilter,
  assetJoin,
  decodeAsset,
  decodeAssetRevision,
  decodeAssetReference,
  type AssetDialect,
  type AssetPlan,
} from "./project-asset-store-support.ts";

export function captureAssetRead(input: unknown, extra: readonly string[]) {
  const v = projectAssetRecord(input, ["owner", "projectId", ...extra]),
    o = projectAssetRecord(v.owner, ["tenantId", "spaceId", "principalId"]);
  const owner: CreativeProjectOwnerScope = Object.freeze({
    tenantId: projectAssetId(o.tenantId),
    spaceId: projectAssetId(o.spaceId),
    principalId: projectAssetId(o.principalId),
  });
  const result: {
    owner: CreativeProjectOwnerScope;
    projectId: string;
    assetId?: string;
    contentRevision?: number;
    referenceRevision?: number;
    kind?: "character" | "scene" | "prop" | null;
    afterAssetId?: string | null;
    afterContentRevision?: number;
    afterReferenceRevision?: number;
    limit?: number;
  } = { owner, projectId: projectAssetId(v.projectId) };
  for (const key of extra) {
    if (key === "assetId") result.assetId = projectAssetId(v[key]);
    else if (key === "contentRevision")
      result.contentRevision = projectAssetRevision(v[key]);
    else if (key === "referenceRevision")
      result.referenceRevision = projectAssetRevision(v[key]);
    else if (key === "kind")
      result.kind = v[key] === null ? null : projectAssetKind(v[key]);
    else if (key === "afterAssetId")
      result.afterAssetId = v[key] === null ? null : projectAssetId(v[key]);
    else if (key === "afterContentRevision")
      result.afterContentRevision = projectAssetRevision(v[key], 0);
    else if (key === "afterReferenceRevision")
      result.afterReferenceRevision = projectAssetRevision(v[key], 0);
    else if (key === "limit") {
      if (
        typeof v[key] !== "number" ||
        !Number.isInteger(v[key]) ||
        v[key] < 1 ||
        v[key] > 16
      )
        projectAssetFailure("project_asset_limit_invalid");
      result.limit = v[key];
    } else projectAssetFailure("project_asset_command_invalid");
  }
  return Object.freeze(result);
}
export function* assetPage(
  d: AssetDialect,
  q: ReturnType<typeof captureAssetRead>,
): AssetPlan<
  Readonly<{
    assets: readonly NonNullable<ReturnType<typeof decodeAsset>>[];
    nextAssetId: string | null;
  }>
> {
  const values: (string | number)[] = [
    ...assetOwnerValues(q.owner),
    q.projectId,
  ];
  let where = "";
  if (q.kind !== null) {
    values.push(q.kind!);
    where += ` AND c.kind=$${values.length}`;
  }
  const ordinal = d.postgres ? ' COLLATE "C"' : " COLLATE BINARY";
  if (q.afterAssetId !== null) {
    values.push(q.afterAssetId!);
    where += ` AND c.asset_id${ordinal}>$${values.length}${ordinal}`;
  }
  values.push(q.limit! + 1);
  const rows = yield* assetQuery(
    d,
    `SELECT c.* FROM ${d.prefix}project_assets c ${assetJoin(d)} WHERE ${assetFilter}${where} ORDER BY c.asset_id${ordinal} ASC LIMIT $${values.length}`,
    values,
  );
  const all = rows.map((row) => {
    const a = decodeAsset(row, q.owner, q.projectId);
    if (!a) projectAssetFailure("project_asset_record_invalid");
    return a;
  });
  const assets = Object.freeze(all.slice(0, q.limit!));
  return Object.freeze({
    assets,
    nextAssetId: all.length > q.limit! ? assets.at(-1)!.assetId : null,
  });
}
export function* assetContentPage(
  d: AssetDialect,
  q: ReturnType<typeof captureAssetRead>,
) {
  const rows = yield* assetQuery(
    d,
    `SELECT c.*,p.owner_principal_id FROM ${d.prefix}project_asset_revisions c ${assetJoin(d)} WHERE ${assetFilter} AND c.asset_id=$5 AND c.content_revision>$6 ORDER BY c.content_revision ASC LIMIT $7`,
    [
      ...assetOwnerValues(q.owner),
      q.projectId,
      q.assetId!,
      q.afterContentRevision!,
      q.limit! + 1,
    ],
  );
  const all = rows.map((row) => {
      const r = decodeAssetRevision(row, q.owner, q.projectId, q.assetId!);
      if (!r) projectAssetFailure("project_asset_record_invalid");
      return r;
    }),
    revisions = Object.freeze(all.slice(0, q.limit!));
  return Object.freeze({
    revisions,
    nextContentRevision:
      all.length > q.limit! ? revisions.at(-1)!.contentRevision : null,
  });
}
export function* assetReferencePage(
  d: AssetDialect,
  q: ReturnType<typeof captureAssetRead>,
) {
  const rows = yield* assetQuery(
    d,
    `SELECT c.*,p.owner_principal_id FROM ${d.prefix}project_asset_reference_revisions c ${assetJoin(d)} WHERE ${assetFilter} AND c.asset_id=$5 AND c.reference_revision>$6 ORDER BY c.reference_revision ASC LIMIT $7`,
    [
      ...assetOwnerValues(q.owner),
      q.projectId,
      q.assetId!,
      q.afterReferenceRevision!,
      q.limit! + 1,
    ],
  );
  const all = rows.map((row) => {
      const r = decodeAssetReference(row, q.owner, q.projectId, q.assetId!);
      if (!r) projectAssetFailure("project_asset_record_invalid");
      return r;
    }),
    references = Object.freeze(all.slice(0, q.limit!));
  return Object.freeze({
    references,
    nextReferenceRevision:
      all.length > q.limit! ? references.at(-1)!.referenceRevision : null,
  });
}
