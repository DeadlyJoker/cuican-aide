import type { DatabaseSync } from "node:sqlite";
import type { CreativeProjectReadStore } from "@crewon/application";
import type { CreativeProjectLegacyAccess } from "./creative-project-legacy-access.ts";
import {
  creativeOwnerValues,
  decodeCreativeProject,
  decodeCreativeBrief,
  decodeCreativeAsset,
  decodeCreativeRevision,
} from "./creative-project-store-records.ts";
const projectFilter =
  "p.tenant_id=? AND p.space_id=? AND p.owner_principal_id=?";
const childJoin =
  "JOIN creative_projects p ON p.tenant_id=c.tenant_id AND p.space_id=c.space_id AND p.project_id=c.project_id";
/** Original list recipes. Access predicates apply before sorting, cursor and LIMIT. */
export function listSqliteCreativeProjects(
  database: DatabaseSync,
  query: Parameters<CreativeProjectReadStore["listProjects"]>[0],
  access: CreativeProjectLegacyAccess,
) {
  const conditions = [projectFilter, access.predicate("p")];
  const values: (string | number)[] = [...creativeOwnerValues(query.owner)];
  if (query.state !== "all") {
    conditions.push("p.state=?");
    values.push(query.state);
  }
  if (query.after !== null) {
    conditions.push(
      "(p.updated_at<? OR (p.updated_at=? AND p.project_id COLLATE BINARY < ? COLLATE BINARY))",
    );
    values.push(
      query.after.updatedAt,
      query.after.updatedAt,
      query.after.projectId,
    );
  }
  const rows = database
    .prepare(
      `SELECT p.* FROM creative_projects p WHERE ${conditions.join(" AND ")} ORDER BY p.updated_at DESC,p.project_id COLLATE BINARY DESC LIMIT ?`,
    )
    .all(...values, query.limit + 1);
  const projects = rows.map((row) => {
    const project = decodeCreativeProject(row, query.owner);
    if (project === null) throw new Error("creative_project_record_invalid");
    return project;
  });
  const page = Object.freeze(projects.slice(0, query.limit));
  const last = page.at(-1);
  return Object.freeze({
    projects: page,
    next:
      projects.length > query.limit && last !== undefined
        ? Object.freeze({
            updatedAt: last.updatedAt,
            projectId: last.projectId,
          })
        : null,
  });
}

export function listSqliteCreativeBriefs(
  database: DatabaseSync,
  query: Parameters<CreativeProjectReadStore["listBriefs"]>[0],
  access: CreativeProjectLegacyAccess,
) {
  const rows = database
    .prepare(
      `SELECT c.*,p.owner_principal_id FROM creative_project_briefs c ${childJoin} WHERE ${projectFilter} AND ${access.predicate("p")} AND c.project_id=? AND c.brief_revision>? ORDER BY c.brief_revision ASC LIMIT ?`,
    )
    .all(
      ...creativeOwnerValues(query.owner),
      query.projectId,
      query.afterBriefRevision,
      query.limit,
    );
  return Object.freeze(
    rows.map((row) =>
      requiredRecord(decodeCreativeBrief(row, query.owner, query.projectId)),
    ),
  );
}

export function listSqliteCreativeAssets(
  database: DatabaseSync,
  query: Parameters<CreativeProjectReadStore["listConceptAssets"]>[0],
  access: CreativeProjectLegacyAccess,
) {
  const after =
    query.afterAssetId === null
      ? ""
      : " AND c.asset_id COLLATE BINARY > ? COLLATE BINARY";
  const values: (string | number)[] = [
    ...creativeOwnerValues(query.owner),
    query.projectId,
  ];
  if (query.afterAssetId !== null) values.push(query.afterAssetId);
  const rows = database
    .prepare(
      `SELECT c.*,p.owner_principal_id FROM creative_concept_assets c ${childJoin} WHERE ${projectFilter} AND ${access.predicate("p")} AND c.project_id=?${after} ORDER BY c.asset_id COLLATE BINARY ASC LIMIT ?`,
    )
    .all(...values, query.limit);
  return Object.freeze(
    rows.map((row) =>
      requiredRecord(decodeCreativeAsset(row, query.owner, query.projectId)),
    ),
  );
}

export function listSqliteCreativeRevisions(
  database: DatabaseSync,
  query: Parameters<CreativeProjectReadStore["listConceptRevisions"]>[0],
  access: CreativeProjectLegacyAccess,
) {
  const rows = database
    .prepare(
      `SELECT c.*,p.owner_principal_id FROM creative_concept_revisions c ${childJoin} WHERE ${projectFilter} AND ${access.predicate("p")} AND c.project_id=? AND c.asset_id=? AND c.asset_revision>? ORDER BY c.asset_revision ASC LIMIT ?`,
    )
    .all(
      ...creativeOwnerValues(query.owner),
      query.projectId,
      query.assetId,
      query.afterAssetRevision,
      query.limit,
    );
  return Object.freeze(
    rows.map((row) =>
      requiredRecord(
        decodeCreativeRevision(
          row,
          query.owner,
          query.projectId,
          query.assetId,
        ),
      ),
    ),
  );
}
function requiredRecord<T>(value: T | null): T {
  if (value === null) throw new Error("creative_project_record_invalid");
  return value;
}
