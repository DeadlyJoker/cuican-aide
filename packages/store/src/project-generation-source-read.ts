import type { ProjectGenerationSourceLocator } from "@crewon/application";
import type { DatabaseSync } from "node:sqlite";
import type { PoolClient } from "pg";
import { parsePluginUiJsonValue } from "@crewon/contracts/plugins";
import {
  creativeProjectOpaqueId,
  creativeProjectRevision,
  extensionCanonicalJson,
  type ProjectGenerationLink,
} from "@crewon/domain";
import {
  creativeStoreRecord,
  decodeCreativeProject,
} from "./creative-project-store-records.ts";
import { decodeProjectGeneration } from "./project-generation-store-support.ts";
import { parseExtensionTurnReceipt } from "./extension-store-records.ts";
import {
  assertSqliteProjectGenerationSchema,
  assertPostgresProjectGenerationSchema,
} from "./project-generation-schema.ts";

export function assertSqliteProjectGenerationReadSchema(db: DatabaseSync) {
  assertSqliteProjectGenerationSchema(db);
  assertProjectGenerationReadExtensionVersion(
    db.prepare(projectGenerationReadExtensionVersionSql()).all(),
  );
}
export async function assertPostgresProjectGenerationReadSchema(
  client: PoolClient,
  schemaName: string,
  prefix: string,
) {
  await assertPostgresProjectGenerationSchema(client, schemaName);
  assertProjectGenerationReadExtensionVersion(
    (await client.query(projectGenerationReadExtensionVersionSql(prefix))).rows,
  );
}

export function projectGenerationReadExtensionVersionSql(prefix = "") {
  return `SELECT id,version FROM ${prefix}extension_schema_version LIMIT 2`;
}
export function assertProjectGenerationReadExtensionVersion(
  rows: readonly Record<string, unknown>[],
) {
  if (rows.length !== 1 || rows[0]?.id !== 1 || rows[0].version !== 1)
    throw new Error(
      "project_generation_read_extension_schema_version_unsupported",
    );
}

/** Capture the owner and exact saved revision before borrowing a database connection. */
export function projectGenerationSourceLocator(
  input: ProjectGenerationSourceLocator,
): ProjectGenerationSourceLocator {
  const value = creativeStoreRecord(input, [
    "owner",
    "projectId",
    "assetId",
    "assetRevision",
  ]);
  const owner = creativeStoreRecord(value.owner, [
    "tenantId",
    "spaceId",
    "principalId",
  ]);
  return Object.freeze({
    owner: Object.freeze({
      tenantId: creativeProjectOpaqueId(owner.tenantId),
      spaceId: creativeProjectOpaqueId(owner.spaceId),
      principalId: creativeProjectOpaqueId(owner.principalId),
    }),
    projectId: creativeProjectOpaqueId(value.projectId),
    assetId: creativeProjectOpaqueId(value.assetId),
    assetRevision: creativeProjectRevision(value.assetRevision),
  });
}

export function projectGenerationSourceValues(
  input: ProjectGenerationSourceLocator,
) {
  return [
    input.owner.tenantId,
    input.owner.spaceId,
    input.owner.principalId,
    input.projectId,
    input.assetId,
    input.assetRevision,
  ];
}

/** LEFT JOIN preserves broken provenance as an error; LIMIT 2 also rejects an ambiguous slot. */
export function projectGenerationSourceReadSql(prefix = "", pg = false) {
  const arg = (index: number) => (pg ? `$${index}` : "?");
  return `SELECT l.*,b.binding_json,r.request_digest AS stored_request_digest,r.result_json AS stored_result_json,
    p.record_json AS project_record_json,p.revision AS project_revision,p.latest_brief_revision AS project_latest_brief_revision,p.state AS project_state,p.updated_at AS project_updated_at
    FROM ${prefix}creative_project_generation_links l
    LEFT JOIN ${prefix}extension_run_bindings b ON b.tenant_id=l.tenant_id AND b.run_id=l.run_id
    LEFT JOIN ${prefix}extension_mutation_receipts r ON r.tenant_id=l.tenant_id AND r.space_id=l.space_id AND r.plugin_id=l.plugin_id AND r.kind=l.receipt_kind AND r.actor_id=l.actor_id AND r.idempotency_key=l.idempotency_key
    LEFT JOIN ${prefix}creative_projects p ON p.tenant_id=l.tenant_id AND p.space_id=l.space_id AND p.project_id=l.project_id AND p.owner_principal_id=l.owner_principal_id
    WHERE l.tenant_id=${arg(1)} AND l.space_id=${arg(2)} AND l.owner_principal_id=${arg(3)} AND l.project_id=${arg(4)} AND l.asset_id=${arg(5)} AND l.asset_revision=${arg(6)} LIMIT 2`;
}

export function decodeProjectGenerationSource(
  rows: readonly Record<string, unknown>[],
  locator: ProjectGenerationSourceLocator,
): ProjectGenerationLink | null {
  if (rows.length > 1) throw new Error("project_generation_source_ambiguous");
  const row = rows[0];
  if (row === undefined) return null;
  const link = decodeProjectGeneration(row, {
    tenantId: locator.owner.tenantId,
    spaceId: locator.owner.spaceId,
    runId: String(row.run_id),
  });
  if (
    link === null ||
    link.ownerPrincipalId !== locator.owner.principalId ||
    link.projectId !== locator.projectId ||
    link.reference.assetId !== locator.assetId ||
    link.reference.assetRevision !== locator.assetRevision
  )
    throw new Error("project_generation_record_identity_mismatch");
  decodeCreativeProject(
    {
      tenant_id: row.tenant_id,
      space_id: row.space_id,
      project_id: row.project_id,
      owner_principal_id: row.owner_principal_id,
      record_json: row.project_record_json,
      revision: row.project_revision,
      latest_brief_revision: row.project_latest_brief_revision,
      state: row.project_state,
      updated_at: row.project_updated_at,
    },
    locator.owner,
    locator.projectId,
  );
  const raw =
    typeof row.stored_result_json === "string"
      ? JSON.parse(row.stored_result_json)
      : row.stored_result_json;
  const receipt = parseExtensionTurnReceipt(
    parsePluginUiJsonValue(raw),
    link.binding,
    link.receipt,
  );
  if (
    extensionCanonicalJson(receipt.binding) !==
      extensionCanonicalJson(link.binding) ||
    receipt.creditAdmission === undefined ||
    receipt.creditAdmission.reservation.scope.principalId !==
      locator.owner.principalId ||
    receipt.creditAdmission.reservation.scope.tenantId !==
      locator.owner.tenantId
  )
    throw new Error("project_generation_receipt_identity_mismatch");
  return link;
}
