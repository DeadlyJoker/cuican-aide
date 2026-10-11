import type { QueryResult } from "pg";
import type { CreativeProjectReadStore } from "@crewon/application";
import type { PostgresCreativeProjectLegacyAccess } from "./creative-project-legacy-access.ts";
import {
  creativeOwnerValues,
  decodeCreativeProject,
  decodeCreativeAsset,
  decodeCreativeRevision,
} from "./creative-project-store-records.ts";
export type PostgresCreativeProjectPageReadPorts = Readonly<{
  prefix: string;
  mode: "legacy" | "protected";
  access: PostgresCreativeProjectLegacyAccess;
  query(
    sql: string,
    values: unknown[],
  ): Promise<QueryResult<Record<string, unknown>>>;
  childSelect(
    table:
      | "creative_project_briefs"
      | "creative_concept_assets"
      | "creative_concept_revisions",
    alias: string,
  ): string;
  required<T>(value: T | null): T;
}>;
// Original SQL queries and decoders on the caller-owned connection; no pool, migration or authority issuance.
export async function readPostgresListProjects(
  query: Parameters<CreativeProjectReadStore["listProjects"]>[0],
  ports: PostgresCreativeProjectPageReadPorts,
) {
  const rows = await ports.query(
    `SELECT p.* FROM ${ports.prefix}creative_projects p
       WHERE tenant_id=$1 AND space_id=$2 AND owner_principal_id=$3 AND ${ports.access.predicate("p")}
       AND ($4::text='all' OR state=$4)
       AND ($5::text IS NULL OR updated_at<$5 OR
         (updated_at=$5 AND project_id COLLATE "C"<$6 COLLATE "C"))
       ORDER BY updated_at DESC,project_id COLLATE "C" DESC LIMIT $7`,
    [
      ...creativeOwnerValues(query.owner),
      query.state,
      query.after?.updatedAt ?? null,
      query.after?.projectId ?? null,
      query.limit + 1,
    ],
  );
  if (ports.mode === "protected")
    for (const row of rows.rows) {
      const project = ports.required(decodeCreativeProject(row, query.owner));
      await ports.access.assertProject(project);
    }
  const projects = Object.freeze(
    rows.rows
      .slice(0, query.limit)
      .map((row) => ports.required(decodeCreativeProject(row, query.owner))),
  );
  const last = projects.at(-1);
  return Object.freeze({
    projects,
    next:
      rows.rows.length > query.limit && last !== undefined
        ? Object.freeze({
            updatedAt: last.updatedAt,
            projectId: last.projectId,
          })
        : null,
  });
}
export async function readPostgresListConceptAssets(
  query: Parameters<CreativeProjectReadStore["listConceptAssets"]>[0],
  ports: PostgresCreativeProjectPageReadPorts,
) {
  const rows = await ports.query(
    `${ports.childSelect("creative_concept_assets", "a")}
       WHERE p.tenant_id=$1 AND p.space_id=$2 AND p.owner_principal_id=$3
       AND p.project_id=$4 AND ${ports.access.predicate("p")}
       AND ($5::text IS NULL OR a.asset_id COLLATE "C">$5 COLLATE "C")
       ORDER BY a.asset_id COLLATE "C" LIMIT $6`,
    [
      ...creativeOwnerValues(query.owner),
      query.projectId,
      query.afterAssetId,
      query.limit,
    ],
  );
  return Object.freeze(
    rows.rows.map((row) =>
      ports.required(decodeCreativeAsset(row, query.owner, query.projectId)),
    ),
  );
}
export async function readPostgresLoadConceptRevision(
  query: Parameters<CreativeProjectReadStore["loadConceptRevision"]>[0],
  ports: PostgresCreativeProjectPageReadPorts,
) {
  const rows = await ports.query(
    `${ports.childSelect("creative_concept_revisions", "r")}
       WHERE p.tenant_id=$1 AND p.space_id=$2 AND p.owner_principal_id=$3
       AND p.project_id=$4 AND ${ports.access.predicate("p")} AND r.asset_id=$5 AND r.asset_revision=$6`,
    [
      ...creativeOwnerValues(query.owner),
      query.projectId,
      query.assetId,
      query.assetRevision,
    ],
  );
  return decodeCreativeRevision(
    rows.rows[0],
    query.owner,
    query.projectId,
    query.assetId,
  );
}
export async function readPostgresListConceptRevisions(
  query: Parameters<CreativeProjectReadStore["listConceptRevisions"]>[0],
  ports: PostgresCreativeProjectPageReadPorts,
) {
  const rows = await ports.query(
    `${ports.childSelect("creative_concept_revisions", "r")}
       WHERE p.tenant_id=$1 AND p.space_id=$2 AND p.owner_principal_id=$3
       AND p.project_id=$4 AND ${ports.access.predicate("p")} AND r.asset_id=$5 AND r.asset_revision>$6
       ORDER BY r.asset_revision LIMIT $7`,
    [
      ...creativeOwnerValues(query.owner),
      query.projectId,
      query.assetId,
      query.afterAssetRevision,
      query.limit,
    ],
  );
  return Object.freeze(
    rows.rows.map((row) =>
      ports.required(
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
